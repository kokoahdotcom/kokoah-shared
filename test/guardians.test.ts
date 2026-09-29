import { describe, expect, it } from "vitest";
import { compileAction } from "../src/actions/index.js";
import type { ActionIntent } from "../src/intents/index.js";
import {
  evaluateRule,
  type GuardianEvaluation,
  type GuardianOrder,
  type GuardianPosition,
  type GuardianRule,
  GuardianRuleValidationError,
  isLossLockActive,
  type MarketState,
  nextDailyResetAfter,
  parseGuardianRule,
  type PositionState,
} from "../src/guardians/index.js";
import { createGuardianPolicy, evaluatePolicy } from "../src/policy/index.js";
import { mainnetRegistry, prng } from "./helpers.js";

const NOW = 1_790_000_000_000;
const C = (n: number) => `0x${n.toString(16).padStart(32, "0")}` as `0x${string}`;

const market = (coin: string, markPrice: number, szDecimals = 2, extra: Partial<MarketState[string]> = {}): MarketState => ({ [coin]: { markPrice, szDecimals, ...extra } });
const long = (size: number, entryPrice: number, extra: Partial<GuardianPosition> = {}): GuardianPosition => ({ side: "long", size, entryPrice, liquidationPrice: null, marginMode: "cross", ...extra });
const short = (size: number, entryPrice: number, extra: Partial<GuardianPosition> = {}): GuardianPosition => ({ side: "short", size, entryPrice, liquidationPrice: null, marginMode: "cross", ...extra });
const state = (positions: Record<string, GuardianPosition> = {}, orders: GuardianOrder[] = [], account: PositionState["account"] = { equityUsd: 10_000 }): PositionState => ({
  account,
  positions,
  orders,
});

/** Applies an evaluation to the rule, as the engine would after the intents were accepted. */
function advance(rule: GuardianRule, r: GuardianEvaluation): GuardianRule {
  return { ...rule, state: r.nextState, status: r.status } as GuardianRule;
}

function orderOf(i: ActionIntent | undefined) {
  if (!i || i.kind !== "order") throw new Error(`expected order intent, got ${i?.kind}`);
  return i;
}
function modifyOf(i: ActionIntent | undefined) {
  if (!i || i.kind !== "modify") throw new Error(`expected modify intent, got ${i?.kind}`);
  return i;
}

describe("guardian rule schemas", () => {
  it("parses valid rules with defaults", () => {
    const r = parseGuardianRule({ type: "trailingStop", id: "t1", createdAt: NOW, coin: "BTC", trail: { kind: "pct", value: 2 } });
    expect(r).toMatchObject({ status: "armed", createdBy: "manual", minUpdateBps: 10 });
  });
  it.each([
    [{ type: "takeProfitLadder", id: "x", createdAt: NOW, coin: "BTC", levels: [{ price: "1", closePct: 60 }, { price: "2", closePct: 50 }] }, "at most 100%"],
    [{ type: "breakeven", id: "x", createdAt: NOW, coin: "BTC", trigger: { kind: "rMultiple", r: 1 } }, "initialStopPrice"],
    [{ type: "timeExit", id: "x", createdAt: NOW, coin: "BTC", action: { kind: "close" } }, "exactly one of at or afterMs"],
    [{ type: "liquidationGuard", id: "x", createdAt: NOW, coin: "BTC", alert: { enabled: false, distancePct: 5 } }, "at least one stage"],
    [{ type: "dailyLossLock", id: "x", createdAt: NOW }, "maxLossUsd"],
    [{ type: "conditional", id: "x", createdAt: NOW, conditions: [], action: { kind: "alert", message: "hi" } }, "Invalid"],
    [{ type: "conditional", id: "x", createdAt: NOW, conditions: [{ kind: "fundingThreshold", coin: "BTC", direction: "above", hourlyRate: 0.001 }], action: { kind: "placeOrder", order: { coin: "BTC", side: "buy", orderType: "limit", size: "1" } } }, "need a price"],
    [{ type: "ocoEntries", id: "x", createdAt: NOW, coin: "BTC", entries: [{ side: "buy", orderType: "stopMarket", size: "1" }, { side: "buy", orderType: "limit", size: "1", price: "1" }] }, "Entry 1"],
    [{ type: "nope", id: "x", createdAt: NOW }, "Unknown guardian rule type"],
    [{ type: "trailingStop", id: "x", createdAt: NOW, coin: "BTC", trail: { kind: "pct", value: 2 }, extra: 1 }, "Invalid"],
  ])("rejects %#", (input, message) => {
    expect(() => parseGuardianRule(input)).toThrow(GuardianRuleValidationError);
    expect(() => parseGuardianRule(input)).toThrow(message);
  });
  it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])("treats the Object.prototype key %s as an unknown type", (type) => {
    const input = { type, id: "x", createdAt: NOW };
    expect(() => parseGuardianRule(input)).toThrow(GuardianRuleValidationError);
    expect(() => parseGuardianRule(input)).toThrow("Unknown guardian rule type");
  });
});

describe("breakeven", () => {
  const rule = parseGuardianRule({ type: "breakeven", id: "be1", createdAt: NOW, coin: "ETH", trigger: { kind: "price", price: "3100" }, offsetBps: 10, stopOrder: { cloid: C(1) } });

  it("moves the stop exactly once", () => {
    const existing: GuardianOrder = { coin: "ETH", cloid: C(1), side: "sell", status: "open", origSize: 1, filledSize: 0, triggerPrice: 2900 };
    const ps = state({ ETH: long(1, 3000) }, [existing]);
    const before = evaluateRule(rule, market("ETH", 3050, 4), ps, NOW);
    expect(before.fire).toBe(false);
    expect(before.status).toBe("armed");

    const hit = evaluateRule(rule, market("ETH", 3150, 4), ps, NOW);
    expect(hit.fire).toBe(true);
    expect(hit.status).toBe("completed");
    expect(hit.intents).toHaveLength(1);
    const m = modifyOf(hit.intents[0]);
    expect(m.target).toEqual({ cloid: C(1) });
    expect(m.order).toMatchObject({ coin: "ETH", side: "sell", orderType: "stopMarket", size: "1", triggerPrice: "3003", reduceOnly: true });
    expect(m.origin).toBe("guardian");

    // Engine persists the result; later evaluations never move it again, even on new highs.
    const after = advance(rule, hit);
    for (const px of [3200, 3500, 2900, 4000]) {
      const r = evaluateRule(after, market("ETH", px, 4), ps, NOW);
      expect(r.fire).toBe(false);
      expect(r.intents).toEqual([]);
    }
    // Even if the status were left "armed", the state says it already moved.
    const r = evaluateRule({ ...after, status: "armed" } as GuardianRule, market("ETH", 3300, 4), ps, NOW);
    expect(r.fire).toBe(false);
  });

  it("never loosens an existing stop and refuses to modify a stop of unknown price", () => {
    const tighter: GuardianOrder = { coin: "ETH", cloid: C(1), side: "sell", status: "open", origSize: 1, filledSize: 0, triggerPrice: 3050 };
    const out = evaluateRule(rule, market("ETH", 3150, 4), state({ ETH: long(1, 3000) }, [tighter]), NOW);
    expect(out).toMatchObject({ fire: false, status: "completed", intents: [] });
    const unknown: GuardianOrder = { ...tighter, triggerPrice: undefined };
    expect(evaluateRule(rule, market("ETH", 3150, 4), state({ ETH: long(1, 3000) }, [unknown]), NOW)).toMatchObject({ fire: false, intents: [] });
    // The referenced stop is gone: place a new one instead of modifying nothing.
    const placed = evaluateRule(rule, market("ETH", 3150, 4), state({ ETH: long(1, 3000) }, []), NOW);
    expect(orderOf(placed.intents[0])).toMatchObject({ orderType: "stopMarket", triggerPrice: "3003", positionTpsl: true });
  });

  it("completes instead of acting when the position flipped", () => {
    const r1 = advance(rule, evaluateRule(rule, market("ETH", 3050, 4), state({ ETH: long(1, 3000) }), NOW));
    expect(evaluateRule(r1, market("ETH", 2800, 4), state({ ETH: short(1, 2900) }), NOW)).toMatchObject({ fire: false, status: "completed" });
  });

  it("supports R-multiple triggers and short positions", () => {
    const r1 = parseGuardianRule({ type: "breakeven", id: "be2", createdAt: NOW, coin: "SOL", trigger: { kind: "rMultiple", r: 1 }, initialStopPrice: "95" });
    expect(evaluateRule(r1, market("SOL", 104.9), state({ SOL: long(2, 100) }), NOW).fire).toBe(false);
    const hit = evaluateRule(r1, market("SOL", 105), state({ SOL: long(2, 100) }), NOW);
    const o = orderOf(hit.intents[0]); // no existing stop: a new position stop is placed
    expect(o).toMatchObject({ orderType: "stopMarket", side: "sell", triggerPrice: "100", size: "2", reduceOnly: true, positionTpsl: true });

    const r2 = parseGuardianRule({ type: "breakeven", id: "be3", createdAt: NOW, coin: "SOL", trigger: { kind: "price", price: "90" }, offsetBps: 10 });
    const s = evaluateRule(r2, market("SOL", 89), state({ SOL: short(3, 100) }), NOW);
    expect(orderOf(s.intents[0])).toMatchObject({ side: "buy", triggerPrice: "99.9", size: "3" });
  });

  it("does not place a stop that would trigger immediately", () => {
    const r = parseGuardianRule({ type: "breakeven", id: "be4", createdAt: NOW, coin: "SOL", trigger: { kind: "price", price: "101" }, offsetBps: 1000 });
    expect(evaluateRule(r, market("SOL", 105), state({ SOL: long(1, 100) }), NOW).fire).toBe(false);
  });
});

describe("trailing stop", () => {
  const rule = parseGuardianRule({ type: "trailingStop", id: "ts1", createdAt: NOW, coin: "SOL", trail: { kind: "pct", value: 5 } });

  it("places, then ratchets only in the favorable direction", () => {
    let r: GuardianRule = rule;
    const ps = state({ SOL: long(1, 100) });
    const step = (px: number) => {
      const out = evaluateRule(r, market("SOL", px), ps, NOW);
      r = advance(r, out);
      return out;
    };
    const first = step(100);
    const placed = orderOf(first.intents[0]);
    expect(placed).toMatchObject({ orderType: "stopMarket", side: "sell", triggerPrice: "95", size: "1", reduceOnly: true, positionTpsl: true });
    const up = step(105);
    const m1 = modifyOf(up.intents[0]);
    expect(m1.target).toEqual({ cloid: placed.cloid });
    expect(m1.order.triggerPrice).toBe("99.75");
    expect(step(103).fire).toBe(false); // price fell: stop stays
    const m2 = modifyOf(step(110).intents[0]);
    expect(m2.order.triggerPrice).toBe("104.5");
    expect(m2.target).toEqual({ cloid: m1.order.cloid });
    expect(step(95).fire).toBe(false);
    expect(r.state).toMatchObject({ stopPrice: "104.5", extreme: 110 });
  });

  it("completes when its position closes before it activated, if attached to that position", () => {
    const base = { type: "trailingStop", createdAt: NOW, coin: "SOL", trail: { kind: "pct", value: 3 }, activationPrice: "150" } as const;
    const attached = parseGuardianRule({ ...base, id: "ts-att", closeWithPosition: true });
    const waiting = parseGuardianRule({ ...base, id: "ts-wait" });
    // Not activated yet (mark below the activation price) while the position is open.
    expect(evaluateRule(attached, market("SOL", 100), state({ SOL: long(1, 100) }), NOW).status).toBe("armed");
    // The position closed: an attached trail ends; a free-standing one keeps waiting for a position.
    expect(evaluateRule(attached, market("SOL", 100), state({}), NOW)).toMatchObject({ status: "completed", fire: false });
    expect(evaluateRule(waiting, market("SOL", 100), state({}), NOW).status).toBe("armed");
  });

  it("never loosens the stop on a random walk (long and short)", () => {
    for (const side of ["long", "short"] as const) {
      const rnd = prng(side === "long" ? 1 : 2);
      let r: GuardianRule = parseGuardianRule({ type: "trailingStop", id: `ts-${side}`, createdAt: NOW, coin: "BTC", trail: { kind: "pct", value: 1.5 }, minUpdateBps: 0 });
      const ps = state({ BTC: side === "long" ? long(0.5, 100_000) : short(0.5, 100_000) });
      let px = 100_000;
      let last: number | undefined;
      let updates = 0;
      for (let i = 0; i < 600; i++) {
        px *= 1 + (rnd() - 0.5) * 0.01;
        const out = evaluateRule(r, market("BTC", px, 5), ps, NOW + i);
        r = advance(r, out);
        for (const it of out.intents) {
          const trigger = Number(it.kind === "modify" ? it.order.triggerPrice : orderOf(it).triggerPrice);
          if (last !== undefined) {
            if (side === "long") expect(trigger).toBeGreaterThan(last);
            else expect(trigger).toBeLessThan(last);
          }
          // Always on the protective side of the mark when set.
          if (side === "long") expect(trigger).toBeLessThan(px);
          else expect(trigger).toBeGreaterThan(px);
          last = trigger;
          updates++;
        }
      }
      expect(updates).toBeGreaterThan(3);
    }
  });

  it("starts from an existing exchange stop and never loosens it", () => {
    const r = parseGuardianRule({ type: "trailingStop", id: "ts3", createdAt: NOW, coin: "SOL", trail: { kind: "pct", value: 10 }, stopOrder: { oid: 42 } });
    const stop = (triggerPrice?: number): GuardianOrder => ({ coin: "SOL", oid: 42, side: "sell", status: "open", origSize: 1, filledSize: 0, ...(triggerPrice !== undefined ? { triggerPrice } : {}) });
    const first = evaluateRule(r, market("SOL", 100), state({ SOL: long(1, 100) }, [stop(95)]), NOW);
    expect(first.intents).toEqual([]); // 90 would be looser than the existing 95
    const r2 = advance(r, first);
    const up = evaluateRule(r2, market("SOL", 110), state({ SOL: long(1, 100) }, [stop(95)]), NOW);
    const m = modifyOf(up.intents[0]);
    expect(m.target).toEqual({ oid: 42 });
    expect(m.order.triggerPrice).toBe("99");
    expect(evaluateRule(r, market("SOL", 120), state({ SOL: long(1, 100) }, [stop()]), NOW).intents).toEqual([]); // unknown price
  });

  it("completes when the position flips", () => {
    const r = advance(rule, evaluateRule(rule, market("SOL", 100), state({ SOL: long(1, 100) }), NOW));
    expect(evaluateRule(r, market("SOL", 90), state({ SOL: short(1, 95) }), NOW)).toMatchObject({ fire: false, status: "completed", intents: [] });
  });

  it("waits for the activation price and respects minUpdateBps", () => {
    const r = parseGuardianRule({ type: "trailingStop", id: "ts2", createdAt: NOW, coin: "SOL", trail: { kind: "price", value: "2" }, activationPrice: "110", minUpdateBps: 50 });
    const ps = state({ SOL: long(1, 100) });
    expect(evaluateRule(r, market("SOL", 109), ps, NOW).fire).toBe(false);
    const a = evaluateRule(r, market("SOL", 111), ps, NOW);
    expect(orderOf(a.intents[0]).triggerPrice).toBe("109");
    const r2 = advance(r, a);
    expect(evaluateRule(r2, market("SOL", 111.3), ps, NOW).fire).toBe(false); // +0.3 < 50 bps of 109
    expect(evaluateRule(r2, market("SOL", 112), ps, NOW).fire).toBe(true);
  });

  it("completes when the position is gone", () => {
    const r = advance(rule, evaluateRule(rule, market("SOL", 100), state({ SOL: long(1, 100) }), NOW));
    expect(evaluateRule(r, market("SOL", 100), state({}), NOW).status).toBe("completed");
  });
});

describe("take-profit ladder", () => {
  const ladder = (levels: Array<[string, number]>, id = "tp1") => parseGuardianRule({ type: "takeProfitLadder", id, createdAt: NOW, coin: "ETH", levels: levels.map(([price, closePct]) => ({ price, closePct })) });

  it("closes each level once", () => {
    let r = ladder([
      ["110", 30],
      ["120", 30],
      ["130", 40],
    ]);
    const ps = state({ ETH: long(1, 100) });
    const sizes: string[] = [];
    for (const px of [105, 115, 116, 125, 135, 140]) {
      const out = evaluateRule(r, market("ETH", px, 3), ps, NOW);
      r = advance(r, out);
      for (const i of out.intents) sizes.push(orderOf(i).size);
      for (const i of out.intents) expect(orderOf(i)).toMatchObject({ orderType: "market", side: "sell", reduceOnly: true });
    }
    expect(sizes).toEqual(["0.3", "0.3", "0.4"]);
    expect(r.status).toBe("completed");
  });

  it("does not fire on a flipped position", () => {
    let r = ladder([
      ["3300", 50],
      ["3600", 50],
    ]);
    r = advance(r, evaluateRule(r, market("ETH", 3100, 3), state({ ETH: long(1, 3000) }), NOW));
    const out = evaluateRule(r, market("ETH", 3050, 3), state({ ETH: short(1, 3100) }), NOW);
    expect(out).toMatchObject({ fire: false, status: "completed", intents: [] });
  });

  it("handles gaps through several levels and lot rounding without exceeding 100%", () => {
    const r = ladder([
      ["110", 50],
      ["120", 50],
    ]);
    const out = evaluateRule(r, market("ETH", 150, 3), state({ ETH: long(0.007, 100) }), NOW);
    expect(out.intents.map((i) => orderOf(i).size)).toEqual(["0.003", "0.004"]);
  });

  it("caps at what is left of the position", () => {
    let r = ladder([
      ["110", 30],
      ["120", 70],
    ]);
    r = advance(r, evaluateRule(r, market("ETH", 111, 3), state({ ETH: long(1, 100) }), NOW));
    const out = evaluateRule(r, market("ETH", 121, 3), state({ ETH: long(0.2, 100) }), NOW); // user closed most of it
    expect(out.intents.map((i) => orderOf(i).size)).toEqual(["0.2"]);
  });

  it("never closes more than 100% of the initial size (randomized)", () => {
    const rnd = prng(99);
    for (let n = 0; n < 300; n++) {
      const count = 1 + Math.floor(rnd() * 10);
      let remaining = 100;
      const levels: Array<[string, number]> = [];
      for (let i = 0; i < count; i++) {
        const pct = Math.max(0.01, Number((rnd() * Math.min(remaining, 60)).toFixed(2)));
        if (remaining - pct < 0) break;
        remaining -= pct;
        levels.push([String(101 + i * (1 + Math.floor(rnd() * 5))), pct]);
      }
      if (levels.length === 0) continue;
      if (rnd() < 0.5) levels[levels.length - 1]![1] += Number(remaining.toFixed(2)) - 0.001 > 0 ? Number((remaining - 0.001).toFixed(3)) : 0;
      let r: GuardianRule;
      try {
        r = ladder(levels, `p${n}`);
      } catch {
        continue;
      }
      const szDecimals = Math.floor(rnd() * 5);
      const initial = Number((0.5 + rnd() * 20).toFixed(szDecimals));
      if (initial <= 0) continue;
      let total = 0;
      let px = 100;
      for (let step = 0; step < 40; step++) {
        px += (rnd() - 0.3) * 6;
        const out = evaluateRule(r, market("ETH", px, szDecimals), state({ ETH: long(initial, 100) }), NOW);
        r = advance(r, out);
        for (const i of out.intents) total += Number(orderOf(i).size);
      }
      expect(total).toBeLessThanOrEqual(initial + 1e-9);
    }
  });
});

describe("protect partial fills", () => {
  const rule = parseGuardianRule({ type: "protectPartialFills", id: "pp1", createdAt: NOW, coin: "SOL", entry: { cloid: C(9) }, side: "buy", stopLoss: { triggerPrice: "95" }, takeProfit: { triggerPrice: "120" } });
  const entry = (filledSize: number, status: GuardianOrder["status"] = "open"): GuardianOrder => ({ coin: "SOL", cloid: C(9), side: "buy", status, origSize: 10, filledSize });

  it("protects the filled size and resizes as more fills arrive", () => {
    let r: GuardianRule = rule;
    const mk = market("SOL", 100);
    expect(evaluateRule(r, mk, state({}, [entry(0)]), NOW).fire).toBe(false);
    const first = evaluateRule(r, mk, state({}, [entry(3)]), NOW);
    expect(first.intents.map((i) => orderOf(i))).toMatchObject([
      { orderType: "stopMarket", side: "sell", size: "3", triggerPrice: "95", reduceOnly: true, positionTpsl: true },
      { orderType: "takeProfitMarket", side: "sell", size: "3", triggerPrice: "120", reduceOnly: true },
    ]);
    expect(first.status).toBe("triggered");
    r = advance(r, first);
    expect(evaluateRule(r, mk, state({}, [entry(3)]), NOW).fire).toBe(false); // no new fills
    const second = evaluateRule(r, mk, state({}, [entry(7)]), NOW);
    const [slMod, tpMod] = second.intents.map(modifyOf);
    expect(slMod!.target).toEqual({ cloid: orderOf(first.intents[0]).cloid });
    expect(tpMod!.target).toEqual({ cloid: orderOf(first.intents[1]).cloid });
    expect(slMod!.order.size).toBe("7");
    r = advance(r, second);
    const done = evaluateRule(r, mk, state({}, [entry(10, "filled")]), NOW);
    expect(done.status).toBe("completed");
    expect(modifyOf(done.intents[0]).order.size).toBe("10");
    r = advance(r, done);
    expect(evaluateRule(r, mk, state({}, [entry(10, "filled")]), NOW).fire).toBe(false);
  });

  it("completes when the entry is cancelled after being protected", () => {
    const r = advance(rule, evaluateRule(rule, market("SOL", 100), state({}, [entry(4)]), NOW));
    const out = evaluateRule(r, market("SOL", 100), state({}, [entry(4, "canceled")]), NOW);
    expect(out).toMatchObject({ fire: false, status: "completed" });
  });
});

describe("time exit", () => {
  it("closes at the configured time", () => {
    const r = parseGuardianRule({ type: "timeExit", id: "te1", createdAt: NOW, coin: "SOL", afterMs: 60_000, action: { kind: "close" } });
    const ps = state({ SOL: long(2.5, 100) });
    expect(evaluateRule(r, market("SOL", 100), ps, NOW + 59_999).fire).toBe(false);
    const out = evaluateRule(r, market("SOL", 100), ps, NOW + 60_000);
    expect(orderOf(out.intents[0])).toMatchObject({ orderType: "market", side: "sell", size: "2.5", reduceOnly: true, slippageBps: 100 });
    expect(out.status).toBe("completed");
    expect(evaluateRule(advance(r, out), market("SOL", 100), ps, NOW + 120_000).fire).toBe(false);
  });
  it("reduces by a percentage and handles a missing position", () => {
    const r = parseGuardianRule({ type: "timeExit", id: "te2", createdAt: NOW, coin: "SOL", at: NOW + 1, action: { kind: "reduce", pct: 50 }, slippageBps: 30 });
    expect(orderOf(evaluateRule(r, market("SOL", 100), state({ SOL: short(3, 100) }), NOW + 5).intents[0])).toMatchObject({ side: "buy", size: "1.5", slippageBps: 30 });
    expect(evaluateRule(r, market("SOL", 100), state({}), NOW + 5)).toMatchObject({ fire: false, status: "completed" });
  });
});

describe("one-cancels-other entries", () => {
  const rule = parseGuardianRule({
    type: "ocoEntries",
    id: "oco1",
    createdAt: NOW,
    coin: "SOL",
    entries: [
      { side: "buy", orderType: "stopMarket", size: "1", triggerPrice: "110" },
      { side: "buy", orderType: "limit", size: "1", price: "90" },
    ],
    bracket: { stopLoss: { triggerPrice: "85" }, takeProfit: { triggerPrice: "120" } },
  });

  it("places both, cancels the other on a fill and brackets the filled entry", () => {
    const mk = market("SOL", 100);
    const placed = evaluateRule(rule, mk, state(), NOW);
    expect(placed.intents).toHaveLength(2);
    const [a, b] = placed.intents.map(orderOf);
    expect(a).toMatchObject({ orderType: "stopMarket", triggerPrice: "110", reduceOnly: false });
    expect(b).toMatchObject({ orderType: "limit", price: "90" });
    let r = advance(rule, placed);
    const open = (cloid: string, filledSize = 0, status: GuardianOrder["status"] = "open"): GuardianOrder => ({ coin: "SOL", cloid, side: "buy", status, origSize: 1, filledSize });
    expect(evaluateRule(r, mk, state({}, [open(a!.cloid!), open(b!.cloid!)]), NOW).fire).toBe(false);

    const partial = evaluateRule(r, mk, state({}, [open(a!.cloid!), open(b!.cloid!, 0.4)]), NOW);
    expect(partial.intents).toEqual([expect.objectContaining({ kind: "cancel", cancels: [{ coin: "SOL", cloid: a!.cloid }] })]);
    expect(partial.status).toBe("triggered"); // bracket waits for the entry to finish
    r = advance(r, partial);

    const filled = evaluateRule(r, mk, state({}, [open(a!.cloid!, 0, "canceled"), open(b!.cloid!, 1, "filled")]), NOW);
    expect(filled.intents.map((i) => orderOf(i))).toMatchObject([
      { orderType: "stopMarket", side: "sell", size: "1", triggerPrice: "85", positionTpsl: true },
      { orderType: "takeProfitMarket", side: "sell", size: "1", triggerPrice: "120", positionTpsl: true },
    ]);
    expect(filled.status).toBe("completed");
  });

  it("completes when both entries end without a fill", () => {
    const r = advance(rule, evaluateRule(rule, market("SOL", 100), state(), NOW));
    const [c0, c1] = (r.state as { entryCloids: string[] }).entryCloids;
    const out = evaluateRule(r, market("SOL", 100), state({}, [
      { coin: "SOL", cloid: c0!, side: "buy", status: "canceled", origSize: 1, filledSize: 0 },
      { coin: "SOL", cloid: c1!, side: "buy", status: "rejected", origSize: 1, filledSize: 0 },
    ]), NOW);
    expect(out).toMatchObject({ fire: false, status: "completed" });
  });
});

describe("conditional", () => {
  const alertRule = (conditions: unknown[], combinator: "AND" | "OR" = "AND", extra: Record<string, unknown> = {}) =>
    parseGuardianRule({ type: "conditional", id: "c1", createdAt: NOW, conditions, combinator, action: { kind: "alert", message: "BTC crossed" }, ...extra });

  it("price cross needs an observation on the other side first", () => {
    let r = alertRule([{ kind: "priceCross", coin: "BTC", direction: "above", price: "100000" }]);
    const first = evaluateRule(r, market("BTC", 101_000, 5), state(), NOW);
    expect(first.fire).toBe(false); // no previous observation
    r = advance(r, first);
    const below = evaluateRule(r, market("BTC", 99_000, 5), state(), NOW);
    expect(below.fire).toBe(false);
    r = advance(r, below);
    const cross = evaluateRule(r, market("BTC", 100_000, 5), state(), NOW);
    expect(cross.fire).toBe(true);
    expect(cross.alerts[0]).toMatchObject({ code: "CONDITION_MET", message: "BTC crossed", ruleId: "c1" });
    expect(cross.status).toBe("completed");
    expect(evaluateRule(advance(r, cross), market("BTC", 99_000, 5), state(), NOW).fire).toBe(false);
  });

  it("combines conditions with AND / OR", () => {
    const funding = { kind: "fundingThreshold", coin: "BTC", direction: "above", hourlyRate: 0.0001 };
    const window = { kind: "timeWindow", startMs: NOW + 1000 };
    const mk = market("BTC", 100_000, 5, { fundingRateHourly: 0.0002 });
    expect(evaluateRule(alertRule([funding, window], "AND"), mk, state(), NOW).fire).toBe(false);
    expect(evaluateRule(alertRule([funding, window], "OR"), mk, state(), NOW).fire).toBe(true);
    expect(evaluateRule(alertRule([funding, window], "AND"), mk, state(), NOW + 1000).fire).toBe(true);
    expect(evaluateRule(alertRule([{ ...funding, direction: "below" }]), mk, state(), NOW).fire).toBe(false);
    expect(evaluateRule(alertRule([funding]), market("BTC", 1, 5), state(), NOW).fire).toBe(false); // no funding data
  });

  it("candle close counts only newly closed candles after creation", () => {
    let r = alertRule([{ kind: "candleClose", coin: "ETH", interval: "1h", direction: "above", price: "3000" }]);
    const candle = (closeTime: number, close: number) => market("ETH", close, 4, { lastClosedCandles: { "1h": { closeTime, close } } });
    expect(evaluateRule(r, candle(NOW - 1, 3100), state(), NOW).fire).toBe(false); // closed before the rule existed
    const below = evaluateRule(r, candle(NOW + 3_600_000, 2990), state(), NOW + 3_600_001);
    expect(below.fire).toBe(false);
    r = advance(r, below);
    expect(evaluateRule(r, candle(NOW + 3_600_000, 3100), state(), NOW + 3_600_002).fire).toBe(false); // same candle
    expect(evaluateRule(r, candle(NOW + 7_200_000, 3100), state(), NOW + 7_200_001).fire).toBe(true);
  });

  it("time windows can wrap past midnight and filter weekdays", () => {
    const day = Date.UTC(2026, 8, 21); // Monday
    const w = { kind: "timeWindow", utcStartMinute: 22 * 60, utcEndMinute: 2 * 60 };
    expect(evaluateRule(alertRule([w]), {}, state(), day + 23 * 3_600_000).fire).toBe(true);
    expect(evaluateRule(alertRule([w]), {}, state(), day + 1 * 3_600_000).fire).toBe(true);
    expect(evaluateRule(alertRule([w]), {}, state(), day + 12 * 3_600_000).fire).toBe(false);
    expect(evaluateRule(alertRule([{ kind: "timeWindow", daysOfWeek: [0, 6] }]), {}, state(), day).fire).toBe(false);
    expect(evaluateRule(alertRule([{ kind: "timeWindow", daysOfWeek: [1] }]), {}, state(), day).fire).toBe(true);
  });

  it("close / reduce / placeOrder actions and repeat cooldown", () => {
    const funding = { kind: "fundingThreshold", coin: "SOL", direction: "above", hourlyRate: 0.0001 };
    const mk = market("SOL", 100, 2, { fundingRateHourly: 0.001 });
    const close = parseGuardianRule({ type: "conditional", id: "c2", createdAt: NOW, conditions: [funding], action: { kind: "close", coin: "SOL" } });
    expect(orderOf(evaluateRule(close, mk, state({ SOL: long(4, 90) }), NOW).intents[0])).toMatchObject({ side: "sell", size: "4", reduceOnly: true });
    const none = evaluateRule(close, mk, state(), NOW);
    expect(none.alerts[0]?.code).toBe("NOTHING_TO_CLOSE");
    const reduce = parseGuardianRule({ type: "conditional", id: "c3", createdAt: NOW, conditions: [funding], action: { kind: "reduce", coin: "SOL", pct: 25 } });
    expect(orderOf(evaluateRule(reduce, mk, state({ SOL: long(4, 90) }), NOW).intents[0]).size).toBe("1");
    const place = parseGuardianRule({
      type: "conditional",
      id: "c4",
      createdAt: NOW,
      conditions: [funding],
      action: { kind: "placeOrder", order: { coin: "SOL", side: "sell", orderType: "limit", size: "1", price: "101", stopLoss: { triggerPrice: "105" } } },
    });
    const placed = orderOf(evaluateRule(place, mk, state(), NOW).intents[0]);
    expect(placed).toMatchObject({ orderType: "limit", price: "101", stopLoss: { triggerPrice: "105" }, origin: "guardian" });
    const repeat = parseGuardianRule({ type: "conditional", id: "c5", createdAt: NOW, conditions: [funding], action: { kind: "alert", message: "funding" }, repeatCooldownMs: 60_000 });
    let r = repeat;
    const a = evaluateRule(r, mk, state(), NOW);
    expect(a).toMatchObject({ fire: true, status: "armed" });
    r = advance(r, a);
    expect(evaluateRule(r, mk, state(), NOW + 30_000).fire).toBe(false);
    expect(evaluateRule(r, mk, state(), NOW + 60_000).fire).toBe(true);
  });
});

describe("liquidation guard", () => {
  const rule = parseGuardianRule({
    type: "liquidationGuard",
    id: "lg1",
    createdAt: NOW,
    coin: "SOL",
    alert: { enabled: true, distancePct: 10 },
    reduce: { enabled: true, distancePct: 5, reducePct: 50 },
    addMargin: { enabled: true, distancePct: 7, stepUsd: "10", maxTotalUsd: "25", cooldownMs: 30_000 },
  });
  const iso = (liq: number) => state({ SOL: long(1, 100, { liquidationPrice: liq, marginMode: "isolated" }) });

  it("runs each stage once, respects the margin budget and cooldown, and re-arms with hysteresis", () => {
    let r: GuardianRule = rule;
    let t = NOW;
    const step = (mark: number, ps = iso(90), dt = 1000) => {
      t += dt;
      const out = evaluateRule(r, market("SOL", mark), ps, t);
      r = advance(r, out);
      return out;
    };
    expect(step(100).fire).toBe(false); // 10% away: not below the threshold
    const alert = step(99); // 9.09%
    expect(alert.alerts.map((a) => a.code)).toEqual(["LIQUIDATION_NEAR"]);
    expect(step(98.5).fire).toBe(false); // alert only once
    const add1 = step(96); // 6.25%: add margin
    expect(add1.intents).toEqual([expect.objectContaining({ kind: "updateIsolatedMargin", coin: "SOL", amountUsd: "10" })]);
    expect(step(95.9).intents).toEqual([]); // cooldown
    expect(step(95.9, iso(90), 31_000).intents).toEqual([expect.objectContaining({ amountUsd: "10" })]);
    expect(step(95.9, iso(90), 31_000).intents).toEqual([expect.objectContaining({ amountUsd: "5" })]); // budget cap 25
    expect(step(95.9, iso(90), 31_000).intents).toEqual([]);
    const reduce = step(94); // 4.26%
    expect(orderOf(reduce.intents[0])).toMatchObject({ side: "sell", size: "0.5", reduceOnly: true });
    expect(step(93.9).intents.filter((i) => i.kind === "order")).toEqual([]); // reduce once
    step(101); // 10.9% < 10 + 1 hysteresis: still not re-armed
    expect(step(99).alerts).toEqual([]);
    step(102); // 11.8% ≥ 11: alert and reduce re-arm
    expect(step(99).alerts.map((a) => a.code)).toEqual(["LIQUIDATION_NEAR"]);
  });

  it("never adds margin to cross positions and resets without a position", () => {
    const cross = state({ SOL: long(1, 100, { liquidationPrice: 90 }) });
    const out = evaluateRule(rule, market("SOL", 96), cross, NOW);
    expect(out.intents.some((i) => i.kind === "updateIsolatedMargin")).toBe(false);
    expect(evaluateRule(advance(rule, out), market("SOL", 96), state(), NOW).nextState).toMatchObject({ alerted: false, reduced: false, marginAddedUsd: "0" });
  });
});

describe("daily loss lock", () => {
  it("locks after the loss limit until the next reset", () => {
    const rule = parseGuardianRule({ type: "dailyLossLock", id: "dl1", createdAt: NOW, maxLossUsd: 500, resetMinuteUtc: 0 });
    expect(evaluateRule(rule, {}, state({}, [], { equityUsd: 10_000, realizedPnlTodayUsd: -400 }), NOW).fire).toBe(false);
    const hit = evaluateRule(rule, {}, state({}, [], { equityUsd: 10_000, realizedPnlTodayUsd: -600 }), NOW);
    expect(hit).toMatchObject({ fire: true, status: "triggered", intents: [] });
    expect(hit.alerts[0]?.severity).toBe("critical");
    const locked = advance(rule, hit);
    const reset = nextDailyResetAfter(NOW);
    expect(locked.state).toEqual({ lockedUntil: reset });
    expect(isLossLockActive(locked, NOW + 1)).toBe(true);
    expect(isLossLockActive(locked, reset)).toBe(false);
    expect(evaluateRule(locked, {}, state(), reset - 1)).toMatchObject({ fire: false, status: "triggered" });
    const lifted = evaluateRule(locked, {}, state(), reset);
    expect(lifted).toMatchObject({ fire: true, status: "armed", nextState: {} });
  });
  it("supports a percentage of day-start equity", () => {
    const rule = parseGuardianRule({ type: "dailyLossLock", id: "dl2", createdAt: NOW, maxLossPctOfEquity: 5 });
    expect(evaluateRule(rule, {}, state({}, [], { equityUsd: 9_000, dayStartEquityUsd: 10_000, realizedPnlTodayUsd: -499 }), NOW).fire).toBe(false);
    expect(evaluateRule(rule, {}, state({}, [], { equityUsd: 9_000, dayStartEquityUsd: 10_000, realizedPnlTodayUsd: -500 }), NOW).fire).toBe(true);
  });
  it("computes the next reset", () => {
    const midnight = Date.UTC(2026, 8, 21);
    expect(nextDailyResetAfter(midnight)).toBe(midnight + 86_400_000);
    expect(nextDailyResetAfter(midnight + 1)).toBe(midnight + 86_400_000);
    expect(nextDailyResetAfter(midnight + 1, 60)).toBe(midnight + 3_600_000);
  });
});

describe("dust positions", () => {
  it("never emits zero-size orders", () => {
    const dust = state({ BTC: long(0.000001, 100_000, { liquidationPrice: 99_000, marginMode: "isolated" }) });
    const mk = market("BTC", 110_000, 5);
    const rules = [
      parseGuardianRule({ type: "breakeven", id: "d1", createdAt: NOW, coin: "BTC", trigger: { kind: "price", price: "105000" } }),
      parseGuardianRule({ type: "trailingStop", id: "d2", createdAt: NOW, coin: "BTC", trail: { kind: "pct", value: 1 } }),
      parseGuardianRule({ type: "takeProfitLadder", id: "d3", createdAt: NOW, coin: "BTC", levels: [{ price: "105000", closePct: 100 }] }),
      parseGuardianRule({ type: "timeExit", id: "d4", createdAt: NOW, coin: "BTC", at: NOW, action: { kind: "close" } }),
      parseGuardianRule({ type: "liquidationGuard", id: "d5", createdAt: NOW, coin: "BTC", reduce: { enabled: true, distancePct: 50, reducePct: 50 } }),
    ];
    for (const r of rules) expect(evaluateRule(r, mk, dust, NOW).intents).toEqual([]);
  });
});

describe("rule lifecycle and determinism", () => {
  const rule = parseGuardianRule({ type: "trailingStop", id: "life", createdAt: NOW, coin: "SOL", trail: { kind: "pct", value: 5 } });
  const ps = state({ SOL: long(1, 100) });

  it("paused, completed, failed and expired rules do nothing", () => {
    for (const status of ["paused", "completed", "failed", "expired"] as const) {
      expect(evaluateRule({ ...rule, status } as GuardianRule, market("SOL", 100), ps, NOW)).toMatchObject({ fire: false, status });
    }
    expect(evaluateRule({ ...rule, expiresAt: NOW } as GuardianRule, market("SOL", 100), ps, NOW)).toMatchObject({ fire: false, status: "expired" });
  });

  it("is pure: same inputs, same intents and cloids", () => {
    const a = evaluateRule(rule, market("SOL", 100), ps, NOW);
    const b = evaluateRule(rule, market("SOL", 100), ps, NOW);
    expect(a).toEqual(b);
    expect(orderOf(a.intents[0]).cloid).toMatch(/^0x6b6f0201/);
  });
});

describe("integration: guardian intents compile and pass the guardian policy", () => {
  it("trailing stop, ladder and liquidation guard on real markets", () => {
    const registry = mainnetRegistry();
    const policy = createGuardianPolicy({ builder: { b: "0x1111111111111111111111111111111111111111", f: 25 }, allowedCoins: ["BTC", "SOL"], maxOrderNotionalUsd: 100_000, maxDailyNotionalUsd: 1_000_000 });
    const btc = registry.require("BTC");
    const mk: MarketState = { BTC: { markPrice: 101_234.5, szDecimals: btc.szDecimals }, SOL: { markPrice: 151.2345, szDecimals: registry.require("SOL").szDecimals } };
    const ps = state({ BTC: long(0.37, 95_000, { liquidationPrice: 97_000, marginMode: "isolated" }), SOL: long(12.34, 140) });
    const rules = [
      parseGuardianRule({ type: "trailingStop", id: "i1", createdAt: NOW, coin: "BTC", trail: { kind: "pct", value: 1.7 } }),
      parseGuardianRule({ type: "takeProfitLadder", id: "i2", createdAt: NOW, coin: "SOL", levels: [{ price: "150", closePct: 33 }, { price: "151", closePct: 33 }] }),
      parseGuardianRule({ type: "liquidationGuard", id: "i3", createdAt: NOW, coin: "BTC", reduce: { enabled: true, distancePct: 5, reducePct: 33 }, addMargin: { enabled: true, distancePct: 5, stepUsd: "100.5", maxTotalUsd: "500" } }),
    ];
    let checked = 0;
    for (const rule of rules) {
      for (const intent of evaluateRule(rule, mk, ps, NOW).intents) {
        const compiled = compileAction(intent, {
          registry,
          builder: { address: "0x1111111111111111111111111111111111111111", feeTenthsBps: 25 },
          getMidPrice: (coin) => mk[coin]?.markPrice,
        });
        const decision = evaluatePolicy({ kind: "compiled", compiled, expiresAfter: NOW + 10_000 }, { policy, now: NOW, markPrices: { BTC: 101_234.5, SOL: 151.2345 }, dailyNotionalUsedUsd: 0, ordersInLastMinute: 0, registry });
        expect(decision.violations).toEqual([]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });
});
