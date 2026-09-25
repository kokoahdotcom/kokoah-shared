import { describe, expect, it } from "vitest";
import { algoCloid, compileAction, isAlgoChild, parseCloid } from "../src/actions/index.js";
import {
  ALGO_RULE_TYPES,
  algoOrderRefs,
  bracketOrderRefs,
  CHASE_HEARTBEAT_TIMEOUT_MS,
  CHASE_PROBE_SLICES,
  chaseOrderRefs,
  chaseStateAfterRefusal,
  chaseTabAlive,
  evaluateBracketRule,
  evaluateChaseRule,
  evaluateEngineRule,
  evaluateTwapRule,
  evenShares,
  exchangeWindow,
  hasSpecialStatus,
  isAlgoRule,
  parseBracketRule,
  parseChaseRule,
  parseEngineRule,
  parseTwapRule,
  planBracket,
  POST_ONLY_WINDOW_MS,
  SERVER_CHASE_REPRICE_MS,
  SERVER_CHASE_SLICE_BASE,
  serverChaseBook,
  sizeTakeProfits,
  startTriggerFor,
  startTriggerHit,
  startTriggerProblem,
  tabChaseCloid,
  type BracketRule,
  type BracketRuleInput,
  type ChaseRule,
  type ChaseRuleInput,
} from "../src/algos/index.js";
import { GuardianRuleValidationError, type GuardianOrder, type GuardianPosition, type MarketState, type PositionState } from "../src/guardians/index.js";
import type { ActionIntent } from "../src/intents/index.js";
import { createGuardianPolicy, evaluatePolicy } from "../src/policy/index.js";
import { mainnetRegistry } from "./helpers.js";

const NOW = 1_790_000_000_000;
const A = `0x${"a".repeat(32)}` as const;
const B = `0x${"b".repeat(32)}` as const;
const SL = `0x${"5".repeat(32)}` as const;

const long = (size: number, entryPrice = 100): GuardianPosition => ({ side: "long", size, entryPrice, liquidationPrice: null, marginMode: "cross" });
const order = (cloid: string, status: GuardianOrder["status"], origSize: number, filledSize: number, extra: Partial<GuardianOrder> = {}): GuardianOrder => ({
  coin: "ETH",
  cloid,
  side: "buy",
  status,
  origSize,
  filledSize,
  ...extra,
});
const ps = (positions: Record<string, GuardianPosition>, orders: GuardianOrder[] = []): PositionState => ({ account: { equityUsd: 10_000 }, positions, orders });
const market = (markPrice: number, midPrice = markPrice): MarketState => ({ ETH: { markPrice, midPrice, szDecimals: 2 } });
const orders = (ev: { intents: ActionIntent[] }) => ev.intents.filter((i) => i.kind === "order") as Extract<ActionIntent, { kind: "order" }>[];
const cancels = (ev: { intents: ActionIntent[] }) => ev.intents.filter((i) => i.kind === "cancel") as Extract<ActionIntent, { kind: "cancel" }>[];

describe("start triggers", () => {
  it("fix the direction from the mark and fire when crossed", () => {
    expect(startTriggerFor(110, 100)).toEqual({ price: 110, direction: "above" });
    expect(startTriggerFor(90, 100)).toEqual({ price: 90, direction: "below" });
    expect(startTriggerFor(0, 100)).toBeUndefined();
    expect(startTriggerHit({ price: 110, direction: "above" }, 109.9)).toBe(false);
    expect(startTriggerHit({ price: "110", direction: "above" }, 110)).toBe(true);
    expect(startTriggerHit({ price: 90, direction: "below" }, 89)).toBe(true);
    expect(startTriggerProblem(0, 100)).toMatch(/Enter/);
    expect(startTriggerProblem(100, 100)).toMatch(/start now/);
    expect(startTriggerProblem(101, 100)).toBe("");
  });
});

describe("exchange window", () => {
  const m = { scheduledFor: NOW, scheduledUntil: NOW + 10 * 60_000 };
  it("covers the maintenance and the post-only period after it", () => {
    expect(exchangeWindow({ now: NOW - 1, maintenance: [m] }).active).toBe(false);
    expect(exchangeWindow({ now: NOW + 1, maintenance: [m] })).toEqual({ active: true, reason: "maintenance", until: m.scheduledUntil + POST_ONLY_WINDOW_MS });
    expect(exchangeWindow({ now: m.scheduledUntil + 1, maintenance: [m] }).reason).toBe("postOnly");
    expect(exchangeWindow({ now: m.scheduledUntil + POST_ONLY_WINDOW_MS, maintenance: [m] }).active).toBe(false);
  });
  it("treats any special status from exchangeStatus as a window", () => {
    expect(hasSpecialStatus(null)).toBe(false);
    expect(hasSpecialStatus([])).toBe(false);
    expect(hasSpecialStatus({})).toBe(false);
    expect(hasSpecialStatus([["postOnly", 1]])).toBe(true);
    expect(exchangeWindow({ now: NOW, specialStatuses: { postOnly: true } })).toEqual({ active: true, reason: "special" });
  });
});

describe("take-profit sizing", () => {
  it("splits the size by shares in whole lots and folds small legs into the next", () => {
    expect(sizeTakeProfits({ size: 1, levels: [{ price: 110, pct: 50 }, { price: 120, pct: 50 }], szDecimals: 2 })).toEqual([
      { index: 0, size: "0.5", merged: [] },
      { index: 1, size: "0.5", merged: [] },
    ]);
    // 33/33/34 of 1.00: the lots add up exactly.
    const three = sizeTakeProfits({ size: 1, levels: [{ price: 110, pct: 33 }, { price: 120, pct: 33 }, { price: 130, pct: 34 }], szDecimals: 2 });
    expect(three.reduce((a, l) => a + Number(l.size), 0)).toBeCloseTo(1);
    // Only part of the size: 60% of 1 = 0.6.
    expect(sizeTakeProfits({ size: 1, levels: [{ price: 110, pct: 30 }, { price: 120, pct: 30 }], szDecimals: 2 }).reduce((a, l) => a + Number(l.size), 0)).toBeCloseTo(0.6);
    // 0.1 × $110 = $11 alone is fine; 0.05 × $110 = $5.5 is not, so TP1 joins TP2.
    expect(sizeTakeProfits({ size: 0.1, levels: [{ price: 110, pct: 50 }, { price: 120, pct: 50 }], szDecimals: 2 })).toEqual([{ index: 1, size: "0.1", merged: [0] }]);
    // The last leg, if small, joins the one before it.
    expect(sizeTakeProfits({ size: 0.2, levels: [{ price: 110, pct: 80 }, { price: 120, pct: 20 }], szDecimals: 2 })).toEqual([{ index: 0, size: "0.2", merged: [1] }]);
    expect(sizeTakeProfits({ size: 0, levels: [{ price: 110, pct: 100 }], szDecimals: 2 })).toEqual([]);
    expect(evenShares(3)).toEqual([33, 33, 34]);
    expect(evenShares(2)).toEqual([50, 50]);
  });
});

describe("planBracket", () => {
  const base = { side: "buy" as const, entryPrices: [100], size: 2, szDecimals: 2 };
  it("sizes the legs and prices profit and loss against the entry", () => {
    const plan = planBracket({ ...base, takeProfits: [{ price: 110, pct: 50 }, { price: 120, pct: 50 }], stopPrice: 95 });
    expect(plan.problems).toEqual([]);
    expect(plan.takeProfits.map((l) => [l.label, l.size, l.pnlUsd])).toEqual([
      ["TP1", "1", 10],
      ["TP2", "1", 20],
    ]);
    expect(plan.stop).toMatchObject({ price: "95", size: "2", pnlUsd: -10 });
    expect(plan.coveredPct).toBe(100);
  });
  it("flags wrong sides, order, shares and breakeven without a stop", () => {
    const p = planBracket({ ...base, takeProfits: [{ price: 120, pct: 60 }, { price: 110, pct: 60 }], stopPrice: 101, breakeven: true });
    expect(p.problems).toEqual(
      expect.arrayContaining([expect.stringMatching(/close 120%/), expect.stringMatching(/stop must be below/), expect.stringMatching(/TP2 must be beyond TP1/)]),
    );
    expect(planBracket({ ...base, side: "sell", takeProfits: [{ price: 105, pct: 100 }] }).problems[0]).toMatch(/below the entry/);
    expect(planBracket({ ...base, takeProfits: [{ price: 110, pct: 100 }], breakeven: true }).problems).toContain("Moving the stop to breakeven needs a stop loss.");
    // One-cancels-other: every leg must suit both entries.
    expect(planBracket({ ...base, entryPrices: [100, 112], takeProfits: [{ price: 110, pct: 100 }], stopPrice: 95 }).problems[0]).toMatch(/TP1 must be above the entry \(112\)/);
  });
  it("notes folded legs and an uncovered rest", () => {
    const p = planBracket({ ...base, size: 0.1, takeProfits: [{ price: 110, pct: 50 }, { price: 120, pct: 50 }] });
    expect(p.notes[0]).toMatch(/TP1 alone is under/);
    expect(p.takeProfits[0]!.size).toBe("0");
    expect(planBracket({ ...base, takeProfits: [{ price: 110, pct: 50 }] }).notes[0]).toMatch(/50% of the size has no take profit/);
  });
});

describe("bracket rule", () => {
  const rule = (extra: Partial<BracketRuleInput> = {}): BracketRule =>
    parseBracketRule({
      id: "br-1",
      type: "bracket",
      coin: "ETH",
      createdAt: NOW,
      side: "buy",
      entries: [{ cloid: A }],
      stopLoss: { triggerPrice: "95" },
      takeProfits: [
        { triggerPrice: "110", pct: 50 },
        { triggerPrice: "120", pct: 50 },
      ],
      ...extra,
    });
  const step = (r: BracketRule, ev: { nextState: BracketRule["state"]; status: BracketRule["status"] }): BracketRule => ({ ...r, state: ev.nextState, status: ev.status });

  it("validates", () => {
    expect(isAlgoRule(rule())).toBe(true);
    expect(ALGO_RULE_TYPES).toContain("bracket");
    expect(parseEngineRule({ ...rule() }).type).toBe("bracket");
    expect(() => parseBracketRule({ ...rule(), takeProfits: [{ triggerPrice: "110", pct: 80 }, { triggerPrice: "120", pct: 30 }] })).toThrow(GuardianRuleValidationError);
    expect(() => parseBracketRule({ ...rule(), stopLoss: undefined, breakevenAt: "110" })).toThrow(GuardianRuleValidationError);
    expect(() => parseBracketRule({ ...rule(), stopLoss: undefined, takeProfits: [] })).toThrow(GuardianRuleValidationError);
    expect(() => parseBracketRule({ ...rule(), entries: [] })).toThrow(GuardianRuleValidationError);
  });

  it("waits for a fill, then places the stop and the take profits sized to it", () => {
    const r = rule();
    const waiting = evaluateBracketRule(r, market(100), ps({}, [order(A, "open", 2, 0)]), NOW);
    expect(waiting.intents).toEqual([]);
    expect(waiting.status).toBe("armed");
    const first = evaluateBracketRule(r, market(100), ps({ ETH: long(1) }, [order(A, "open", 2, 1)]), NOW);
    expect(first.status).toBe("triggered");
    const [stop, tp1, tp2] = orders(first);
    expect(stop).toMatchObject({ side: "sell", orderType: "stopMarket", size: "1", triggerPrice: "95", reduceOnly: true, positionTpsl: true, origin: "guardian" });
    expect(tp1).toMatchObject({ orderType: "takeProfitMarket", size: "0.5", triggerPrice: "110", reduceOnly: true, positionTpsl: true });
    expect(tp2).toMatchObject({ size: "0.5", triggerPrice: "120" });
    expect(first.nextState).toMatchObject({ protectedSize: "1", stopCloid: stop!.cloid, tpCloids: [tp1!.cloid, tp2!.cloid] });
    // Same inputs, same intents (idempotent retries).
    expect(evaluateBracketRule(r, market(100), ps({ ETH: long(1) }, [order(A, "open", 2, 1)]), NOW)).toEqual(first);

    // The entry fills completely: new legs are placed first, the old ones canceled after (clean-up).
    const r2 = step(r, first);
    const own = [order(stop!.cloid!, "open", 1, 0), order(tp1!.cloid!, "open", 0.5, 0), order(tp2!.cloid!, "open", 0.5, 0)];
    const second = evaluateBracketRule(r2, market(101), ps({ ETH: long(2) }, [order(A, "filled", 2, 2), ...own]), NOW + 5000);
    const placed = orders(second);
    expect(placed.map((o) => o.size)).toEqual(["2", "1", "1"]);
    const c = cancels(second);
    expect(c).toHaveLength(2);
    expect(c[0]!.cancels).toEqual([{ coin: "ETH", cloid: stop!.cloid }]);
    expect(second.cleanup).toHaveLength(2);
    // Each cancel waits for its replacement.
    expect(Object.values(second.requires)).toEqual([0, 2]);
    expect(second.nextState.entryFinal).toEqual({ "0": "2" });
    expect(bracketOrderRefs(step(r2, second)).map((x) => x.cloid)).not.toContain(A);
  });

  it("moves the stop to breakeven once the mark reaches TP1, and freezes the take profits after one executes", () => {
    const r = rule({ breakevenAt: "110" });
    const first = evaluateBracketRule(r, market(100), ps({ ETH: long(2) }, [order(A, "filled", 2, 2)]), NOW);
    const [stop, tp1, tp2] = orders(first);
    const r2 = step(r, first);
    const own = [order(stop!.cloid!, "open", 2, 0), order(tp1!.cloid!, "filled", 1, 1), order(tp2!.cloid!, "open", 1, 0)];
    const be = evaluateBracketRule(r2, market(110.5), ps({ ETH: long(1) }, own), NOW + 5000);
    const [moved] = orders(be);
    expect(moved).toMatchObject({ orderType: "stopMarket", triggerPrice: "100", size: "1" });
    expect(cancels(be)[0]!.cancels).toEqual([{ coin: "ETH", cloid: stop!.cloid }]);
    expect(be.nextState).toMatchObject({ breakevenDone: true, stopPrice: "100", tpExecuted: true });
    expect(be.reason).toMatch(/breakeven/);
    // Nothing more to do while the position rides.
    expect(evaluateBracketRule(step(r2, be), market(111), ps({ ETH: long(1) }, own), NOW + 10_000).intents).toEqual([]);
  });

  it("adopts a stop that already rests for a market entry", () => {
    const r = rule({ stopOrder: { cloid: SL, size: "2" }, takeProfits: [], breakevenAt: "110" });
    const ev = evaluateBracketRule(r, market(100), ps({ ETH: long(2) }, [order(A, "filled", 2, 2), order(SL, "open", 2, 0)]), NOW);
    expect(ev.intents).toEqual([]);
    expect(ev.nextState).toMatchObject({ stopCloid: SL, protectedSize: "2" });
  });

  it("cancels the other entry when one fills (one-cancels-other)", () => {
    const r = rule({ entries: [{ cloid: A }, { cloid: B }], oco: true, takeProfits: [] });
    const ev = evaluateBracketRule(r, market(100), ps({ ETH: long(1) }, [order(A, "open", 2, 1), order(B, "open", 2, 0)]), NOW);
    const c = cancels(ev);
    expect(c[0]!.cancels).toEqual([{ coin: "ETH", cloid: B }]);
    expect(ev.cleanup).toContain(ev.intents.indexOf(c[0]!));
    expect(orders(ev)[0]).toMatchObject({ orderType: "stopMarket", size: "1" });
    expect(ev.nextState.othersCanceled).toBe(true);
  });

  it("keeps one stop across a scale ladder and completes when every entry is done and the position closed", () => {
    const legs = [A, B, `0x${"c".repeat(32)}`];
    const r = rule({ entries: legs.map((cloid) => ({ cloid })), takeProfits: [] });
    const first = evaluateBracketRule(r, market(100), ps({ ETH: long(0.5) }, [order(A, "filled", 0.5, 0.5), order(B, "open", 0.5, 0), order(legs[2]!, "open", 0.5, 0)]), NOW);
    expect(orders(first)[0]).toMatchObject({ size: "0.5" });
    const stop = orders(first)[0]!.cloid!;
    // Stopped out while two legs still rest: exits cleaned up, and the next fills are protected again.
    const r2 = step(r, first);
    const out = evaluateBracketRule(r2, market(94), ps({}, [order(stop, "filled", 0.5, 0.5), order(B, "open", 0.5, 0), order(legs[2]!, "open", 0.5, 0)]), NOW + 5000);
    expect(out.status).toBe("armed");
    expect(out.nextState.protectedSize).toBe("0");
    const again = evaluateBracketRule(step(r2, out), market(94), ps({ ETH: long(0.5) }, [order(B, "filled", 0.5, 0.5), order(legs[2]!, "canceled", 0.5, 0)]), NOW + 10_000);
    expect(orders(again)[0]).toMatchObject({ size: "0.5" });
    const done = evaluateBracketRule(step(step(r2, out), again), market(94), ps({}, []), NOW + 15_000);
    expect(done.status).toBe("completed");
    expect(done.reason).toBe("Position closed");
  });

  it("completes when the entries end without a fill", () => {
    const ev = evaluateBracketRule(rule(), market(100), ps({}, [order(A, "canceled", 2, 0)]), NOW);
    expect(ev.status).toBe("completed");
    expect(evaluateBracketRule({ ...rule(), expiresAt: NOW }, market(100), ps({}), NOW).status).toBe("expired");
  });

  it("passes the guardian policy (reduce-only exits and cancels with the builder)", () => {
    const registry = mainnetRegistry();
    const builder = { address: "0x1111111111111111111111111111111111111111" as const, feeTenthsBps: 25 };
    const policy = createGuardianPolicy({ builder: { b: builder.address, f: 25 }, allowedCoins: ["ETH"], maxOrderNotionalUsd: 1, maxDailyNotionalUsd: 10 });
    const eth = registry.require("ETH");
    const r = parseBracketRule({
      id: "br-2",
      type: "bracket",
      coin: "ETH",
      createdAt: NOW,
      side: "buy",
      entries: [{ cloid: A }],
      stopLoss: { triggerPrice: "2900" },
      takeProfits: [{ triggerPrice: "3100", pct: 100 }],
    });
    const ev = evaluateEngineRule(r, { ETH: { markPrice: 3000, szDecimals: eth.szDecimals } }, ps({ ETH: long(1, 3000) }, [order(A, "filled", 1, 1)]), NOW);
    expect(ev.intents).toHaveLength(2);
    for (const intent of ev.intents) {
      const compiled = compileAction(intent, { registry, builder, getMidPrice: () => 3000 });
      const decision = evaluatePolicy(
        { kind: "compiled", compiled, expiresAfter: NOW + 10_000 },
        { policy, now: NOW, markPrices: { ETH: 3000 }, dailyNotionalUsedUsd: 0, ordersInLastMinute: 0, registry },
      );
      expect(decision.violations).toEqual([]);
    }
  });
});

describe("chase rule", () => {
  const ALGO = "chase-algo-1";
  const rule = (extra: Partial<ChaseRuleInput> = {}): ChaseRule =>
    parseChaseRule({
      id: "cr-1",
      type: "chase",
      coin: "ETH",
      createdAt: NOW,
      algoId: ALGO,
      side: "sell",
      size: "2",
      reduceOnly: true,
      onTabClose: "server",
      heartbeatAt: NOW,
      startedAt: NOW,
      slice: 3,
      triggered: true,
      ...extra,
    });
  const later = NOW + CHASE_HEARTBEAT_TIMEOUT_MS + 1;
  const step = (r: ChaseRule, ev: { nextState: ChaseRule["state"]; status: ChaseRule["status"] }): ChaseRule => ({ ...r, state: ev.nextState, status: ev.status });
  const tabOrder = (slice: number, origSize: number, filledSize = 0, status: GuardianOrder["status"] = "open") =>
    order(tabChaseCloid(ALGO, slice), status, origSize, filledSize, { side: "sell", limitPrice: 100.5 });

  it("does nothing, and writes nothing, while the tab checks in", () => {
    const r = rule();
    expect(chaseTabAlive(r, NOW + 1000)).toBe(true);
    const ev = evaluateChaseRule(r, market(100), ps({}, [tabOrder(3, 2)]), NOW + 1000);
    expect(ev.intents).toEqual([]);
    expect(ev.nextState).toBeUndefined();
    expect(chaseOrderRefs(r, NOW + 1000)).toEqual([]);
    const probe = chaseOrderRefs(r, later);
    expect(probe).toHaveLength(CHASE_PROBE_SLICES + 1);
    expect(probe[0]!.cloid).toBe(tabChaseCloid(ALGO, 3));
    expect(algoOrderRefs(r, later)).toEqual(probe);
    expect(isAlgoRule(r)).toBe(true);
  });

  it("cancels the order the tab left when the user chose that", () => {
    const ev = evaluateChaseRule(rule({ onTabClose: "cancel" }), market(100), ps({}, [tabOrder(4, 1.5)]), later);
    expect(cancels(ev)[0]!.cancels).toEqual([{ coin: "ETH", cloid: tabChaseCloid(ALGO, 4) }]);
    expect(ev.status).toBe("completed");
    expect(evaluateChaseRule(rule({ onTabClose: "cancel" }), market(100), ps({}), later).reason).toMatch(/no chase order was resting/);
  });

  it("takes over the resting order and re-prices it slowly: cancel, then place for what is left", () => {
    const r = rule();
    const take = evaluateChaseRule(r, market(100, 100.02), ps({}, [tabOrder(4, 1.5, 0.5)]), later);
    expect(take.intents).toEqual([]);
    expect(take.nextState).toMatchObject({ takenOverAt: later, filled: "0.5", orderCloid: tabChaseCloid(ALGO, 4), orderPrice: "100.5" });
    const r2 = step(r, take);
    // Pacing: nothing before the server's re-price interval.
    expect(evaluateChaseRule(r2, market(99, 99.02), ps({}, [tabOrder(4, 1.5, 0.5)]), later + 5000).intents).toEqual([]);
    const cancel = evaluateChaseRule(r2, market(99, 99.02), ps({}, [tabOrder(4, 1.5, 0.5)]), later + SERVER_CHASE_REPRICE_MS);
    expect(cancels(cancel)[0]!.cancels).toEqual([{ coin: "ETH", cloid: tabChaseCloid(ALGO, 4) }]);
    expect(cancel.nextState).toMatchObject({ canceling: true, reprices: 1 });
    const r3 = step(r2, cancel);
    // Still resting: wait for the cancel.
    expect(evaluateChaseRule(r3, market(99), ps({}, [tabOrder(4, 1.5, 0.6)]), later + 20_000).intents).toEqual([]);
    // Gone, with 0.7 filled in all: the new post-only order is for the rest.
    // Right after the cancel (no pacing between a cancel and its replacement).
    const place = evaluateChaseRule(r3, market(99, 99.02), ps({}, [tabOrder(4, 1.5, 0.7, "canceled")]), later + 21_000);
    const [o] = orders(place);
    expect(o).toMatchObject({ side: "sell", orderType: "limit", tif: "Alo", size: "0.8", reduceOnly: true, origin: "guardian" });
    expect(Number(o!.price)).toBeGreaterThanOrEqual(99.02);
    expect(isAlgoChild(o!.cloid, ALGO, "chase")).toBe(true);
    expect(parseCloid(o!.cloid!)?.algo?.slice).toBe(SERVER_CHASE_SLICE_BASE);
    expect(place.nextState).toMatchObject({ filled: "1.2", orderSize: "0.8" });
    // Filled: done.
    const r4 = step(r3, place);
    const done = evaluateChaseRule(r4, market(99), ps({}, [order(o!.cloid!, "filled", 0.8, 0.8, { side: "sell" })]), later + 40_000);
    expect(done.status).toBe("completed");
  });

  it("ends without placing when no order rests after the chase started", () => {
    const ev = evaluateChaseRule(rule(), market(100), ps({}), later);
    expect(ev.intents).toEqual([]);
    expect(ev.status).toBe("completed");
    expect(ev.reason).toMatch(/nothing more was placed/);
  });

  it("runs a chase whose start trigger has not fired yet, from the trigger", () => {
    const r = rule({ triggered: false, startedAt: undefined, startTrigger: { price: "105", direction: "above" }, reduceOnly: false, side: "buy" });
    const take = evaluateChaseRule(r, market(100), ps({}), later);
    expect(take.intents).toEqual([]);
    expect(take.reason).toMatch(/reach 105/);
    const go = evaluateChaseRule(step(r, take), market(105, 105.01), ps({}), later + 5000);
    expect(orders(go)[0]).toMatchObject({ side: "buy", tif: "Alo", size: "2" });
    expect(go.nextState).toMatchObject({ startedAt: later + 5000, startPrice: 105.01 });
  });

  it("counts a refused order like a post-only rejection", () => {
    const st = chaseStateAfterRefusal({ seq: 2, filled: "0.5", orderCloid: A, orderPrice: "100", canceling: false, ioc: false, reprices: 1, rejections: 1 }, NOW);
    expect(st).toMatchObject({ orderCloid: undefined, rejections: 2, lastActionAt: NOW, filled: "0.5" });
  });

  it("prices around the mid on the server", () => {
    const book = serverChaseBook(100, 2, "perp", NOW);
    expect(book.bestAsk - book.bestBid).toBeCloseTo(0.01);
    expect(tabChaseCloid(ALGO, 1)).toBe(algoCloid({ kind: "chase", parent: ALGO, slice: 1 }, "manual"));
  });
});

describe("twap rule: start trigger and post-only window", () => {
  const r = parseTwapRule({ id: "tw-3", type: "twap", coin: "ETH", createdAt: NOW, action: { kind: "close" }, durationMs: 600_000, randomize: false, startTrigger: { price: "105", direction: "above" } });
  it("waits for the mark to cross the start price", () => {
    const wait = evaluateTwapRule(r, market(100), ps({ ETH: long(1) }), NOW);
    expect(wait.intents).toEqual([]);
    expect(wait.reason).toMatch(/reach 105/);
    expect(evaluateTwapRule(r, market(105), ps({ ETH: long(1) }), NOW).intents).toHaveLength(1);
  });
  it("pauses slices during Hyperliquid's post-only window", () => {
    const window = exchangeWindow({ now: NOW, maintenance: [{ scheduledFor: NOW - 60_000, scheduledUntil: NOW - 1000 }] });
    const paused = evaluateEngineRule(r, market(106), ps({ ETH: long(1) }), NOW, { exchange: window });
    expect(paused.intents).toEqual([]);
    expect(paused.reason).toMatch(/post-only window/);
    expect((paused.nextState as { pausedByWindow?: boolean }).pausedByWindow).toBe(true);
  });
});
