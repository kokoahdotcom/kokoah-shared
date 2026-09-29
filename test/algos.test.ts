import { describe, expect, it } from "vitest";
import { algoCloid, algoParentTag, compileAction, deriveCloid, generateCloid, isAlgoChild, isCloid, parseCloid } from "../src/actions/index.js";
import {
  CHASE_MAX_REJECTIONS,
  CHASE_MIN_REPRICE_MS,
  chaseLimitPrice,
  chaseTargetPrice,
  evaluateEngineRule,
  evaluateTwapRule,
  isAlgoRule,
  nextChaseStep,
  nextTwapSlice,
  parseEngineRule,
  parseTwapRule,
  planScale,
  planTwap,
  SCALE_MAX_LEGS,
  scaleWeights,
  splitLots,
  stopAtLeastAsTight,
  trailProblems,
  trailStopPrice,
  twapConfigProblems,
  twapRuleProgress,
  TWAP_MIN_INTERVAL_MS,
  unitHash,
  type ChaseConfig,
  type ChaseState,
  type TwapConfig,
  type TwapRule,
} from "../src/algos/index.js";
import { GuardianRuleValidationError, type GuardianPosition, type MarketState, type PositionState } from "../src/guardians/index.js";
import { createGuardianPolicy, evaluatePolicy } from "../src/policy/index.js";
import { mainnetRegistry } from "./helpers.js";

const NOW = 1_790_000_000_000;

describe("algo cloids", () => {
  it("tags kind, parent and slice deterministically and parses them back", () => {
    const c = algoCloid({ kind: "twap", parent: "rule-1", slice: 12 }, "guardian");
    expect(isCloid(c)).toBe(true);
    expect(c).toBe(algoCloid({ kind: "twap", parent: "rule-1", slice: 12 }, "guardian"));
    expect(c).not.toBe(algoCloid({ kind: "twap", parent: "rule-1", slice: 13 }, "guardian"));
    expect(c).not.toBe(algoCloid({ kind: "twap", parent: "rule-1", slice: 12, attempt: 1 }, "guardian"));
    expect(c.slice(2, 10)).toBe("6b6f0202");
    expect(parseCloid(c)).toEqual({
      kokoah: true,
      origin: "guardian",
      tag: "6b6f0202",
      algo: { kind: "twap", parentTag: algoParentTag("rule-1"), slice: 12, attempt: 0 },
    });
    const chase = algoCloid({ kind: "chase", parent: "a", slice: 65_535, attempt: 255 });
    expect(parseCloid(chase)?.algo).toEqual({ kind: "chase", parentTag: algoParentTag("a"), slice: 65_535, attempt: 255 });
    expect(parseCloid(chase)?.origin).toBe("manual");
  });
  it("matches children to their parent", () => {
    const c = algoCloid({ kind: "scale", parent: "ladder-7", slice: 3 });
    expect(isAlgoChild(c, "ladder-7")).toBe(true);
    expect(isAlgoChild(c, "ladder-7", "scale")).toBe(true);
    expect(isAlgoChild(c, "ladder-7", "chase")).toBe(false);
    expect(isAlgoChild(c, "ladder-8")).toBe(false);
    expect(isAlgoChild(deriveCloid("ladder-7", "manual"), "ladder-7")).toBe(false);
    expect(isAlgoChild(null, "ladder-7")).toBe(false);
  });
  it("keeps version-1 cloids as they were and rejects a bad check", () => {
    const manual = generateCloid("manual");
    expect(parseCloid(manual)).toEqual({ kokoah: true, origin: "manual", tag: manual.slice(2, 10) });
    const c = algoCloid({ kind: "twap", parent: "x", slice: 1 });
    const tampered = `${c.slice(0, -1)}${c.endsWith("0") ? "1" : "0"}`;
    expect(parseCloid(tampered)).toEqual({ kokoah: false, tag: tampered.slice(2, 10) });
  });
  it("refuses out-of-range fields", () => {
    expect(() => algoCloid({ kind: "twap", parent: "x", slice: 65_536 })).toThrow(RangeError);
    expect(() => algoCloid({ kind: "twap", parent: "x", slice: -1 })).toThrow(RangeError);
    expect(() => algoCloid({ kind: "twap", parent: "x", slice: 1, attempt: 256 })).toThrow(RangeError);
    expect(() => algoCloid({ kind: "nope" as "twap", parent: "x", slice: 1 })).toThrow(RangeError);
    for (const key of ["constructor", "toString", "__proto__"]) {
      expect(() => algoCloid({ kind: key as "twap", parent: "x", slice: 1 })).toThrow("Unknown algo kind");
      expect(() => algoCloid({ kind: "twap", parent: "x", slice: 1 }, key as "manual")).toThrow("Unknown cloid origin tag");
    }
  });
});

describe("planScale", () => {
  const base = { side: "buy" as const, startPrice: 100, endPrice: 90, legs: 5, totalSize: 10, distribution: { kind: "even" as const }, szDecimals: 2, mark: 101, bestBid: 100.9, bestAsk: 101.1 };
  it("spaces prices from start to end and splits the size evenly", () => {
    const plan = planScale(base);
    expect(plan.problems).toEqual([]);
    expect(plan.legs.map((l) => l.price)).toEqual(["100", "97.5", "95", "92.5", "90"]);
    expect(plan.legs.map((l) => l.size)).toEqual(["2", "2", "2", "2", "2"]);
    expect(plan.totalSize).toBe("10");
    expect(plan.averagePrice).toBeCloseTo(95);
    expect(plan.flagged).toBe(0);
    expect(plan.blocking).toBe(0);
  });
  it("weights more near the start or the end", () => {
    const start = planScale({ ...base, distribution: { kind: "start" } });
    const sizes = start.legs.map((l) => Number(l.size));
    expect(sizes[0]).toBeGreaterThan(sizes[4]!);
    expect(sizes[0]! / sizes[4]!).toBeCloseTo(3, 0);
    expect(start.totalSize).toBe("10");
    const end = planScale({ ...base, distribution: { kind: "end", skew: 2 } });
    expect(Number(end.legs[4]!.size)).toBeGreaterThan(Number(end.legs[0]!.size));
    expect(end.averagePrice).toBeLessThan(95);
  });
  it("uses custom percentages that add up to 100", () => {
    const plan = planScale({ ...base, legs: 3, distribution: { kind: "custom", percents: [50, 30, 20] } });
    expect(plan.legs.map((l) => l.size)).toEqual(["5", "3", "2"]);
    expect(planScale({ ...base, legs: 3, distribution: { kind: "custom", percents: [50, 30, 10] } }).problems[0]).toMatch(/add up to 90%/);
    expect(planScale({ ...base, legs: 3, distribution: { kind: "custom", percents: [50, 50] } }).problems[0]).toMatch(/one percentage per leg/);
  });
  it("never sends more than the total and splits whole lots exactly", () => {
    expect(splitLots(10, [1 / 3, 1 / 3, 1 / 3])).toEqual([4, 3, 3]);
    const plan = planScale({ ...base, legs: 3, totalSize: 0.1, szDecimals: 2 });
    expect(plan.legs.map((l) => l.size)).toEqual(["0.04", "0.03", "0.03"]);
    expect(plan.totalSize).toBe("0.1");
    const weights = scaleWeights({ kind: "start", skew: 5 }, 7).weights;
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
  it("flags legs under $10, legs that fill at once and legs outside the band", () => {
    const small = planScale({ ...base, totalSize: 0.4 });
    expect(small.legs.every((l) => l.belowMinimum && l.blocking)).toBe(true);
    const crossing = planScale({ ...base, startPrice: 102, endPrice: 98 });
    expect(crossing.legs[0]!.fillsNow).toBe(true);
    expect(crossing.legs[0]!.blocking).toBe(false);
    expect(crossing.legs[4]!.fillsNow).toBe(false);
    const far = planScale({ ...base, startPrice: 60, endPrice: 40 });
    expect(far.legs.at(-1)!.outsideBand).toBe(true);
    expect(far.blocking).toBeGreaterThan(0);
    // Sells fill at once at or below the bid.
    const sell = planScale({ ...base, side: "sell", startPrice: 100, endPrice: 110 });
    expect(sell.legs[0]!.fillsNow).toBe(true);
    expect(sell.legs[1]!.fillsNow).toBe(false);
  });
  it("rounds prices to the tick and reports shared prices", () => {
    const plan = planScale({ ...base, startPrice: 100.001, endPrice: 100.004, legs: 4 });
    expect(plan.problems.some((p) => /share a price/.test(p))).toBe(true);
  });
  it("refuses bad inputs without throwing", () => {
    expect(planScale({ ...base, legs: 1 }).problems[0]).toMatch(/2 to 50/);
    expect(planScale({ ...base, legs: SCALE_MAX_LEGS + 1 }).problems[0]).toMatch(/2 to 50/);
    expect(planScale({ ...base, endPrice: 100 }).problems[0]).toMatch(/differ/);
    expect(planScale({ ...base, totalSize: 0 }).problems[0]).toMatch(/size/);
    expect(planScale({ ...base, totalSize: 0.03 }).problems[0]).toMatch(/too small/);
  });
});

describe("nextChaseStep", () => {
  const config: ChaseConfig = { side: "buy", size: 1, szDecimals: 2 };
  const fresh = (extra: Partial<ChaseState> = {}): ChaseState => ({ startedAt: NOW, filled: 0, reprices: 0, rejections: 0, ...extra });
  const book = (bestBid: number, bestAsk: number, now = NOW) => ({ bestBid, bestAsk, now });
  it("places one tick inside the best price, post-only", () => {
    expect(chaseTargetPrice("buy", 100, 101, 2)).toBe("100.01");
    expect(chaseTargetPrice("sell", 100, 101, 2)).toBe("100.99");
    // One-tick spread: join the best price instead of crossing.
    expect(chaseTargetPrice("buy", 100, 100.01, 2)).toBe("100");
    expect(chaseTargetPrice("sell", 100, 100.01, 2)).toBe("100.01");
    expect(nextChaseStep(config, fresh(), book(100, 101))).toEqual({ kind: "place", price: "100.01", size: "1" });
  });
  it("waits while it is the best price and re-prices when outbid, at most every 2 s", () => {
    const order = { price: "100.01", size: "1", placedAt: NOW };
    expect(nextChaseStep(config, fresh({ order }), book(100.01, 101, NOW + 5000)).kind).toBe("wait");
    expect(nextChaseStep(config, fresh({ order, lastActionAt: NOW }), book(100.5, 101, NOW + 1000))).toEqual({ kind: "wait", reason: "Pacing re-prices.", until: NOW + CHASE_MIN_REPRICE_MS });
    expect(nextChaseStep(config, fresh({ order, lastActionAt: NOW }), book(100.5, 101, NOW + 2000))).toEqual({ kind: "reprice", price: "100.51", size: "1" });
  });
  it("chases only what is left", () => {
    const order = { price: "100.01", size: "1", placedAt: NOW };
    expect(nextChaseStep(config, fresh({ order, filled: 0.4 }), book(100.5, 101, NOW + 3000))).toEqual({ kind: "reprice", price: "100.51", size: "0.6" });
    expect(nextChaseStep(config, fresh({ order, filled: 1 }), book(100.5, 101, NOW + 3000))).toEqual({ kind: "finish", reason: "filled", cancel: true });
  });
  it("rests or cancels at the chase limit", () => {
    const limited: ChaseConfig = { ...config, limit: { kind: "price", price: 100.3 } };
    const order = { price: "100.01", size: "1", placedAt: NOW };
    expect(nextChaseStep(limited, fresh({ order }), book(100.5, 101, NOW + 3000))).toEqual({ kind: "reprice", price: "100.3", size: "1" });
    expect(nextChaseStep(limited, fresh({ order: { ...order, price: "100.3" } }), book(100.5, 101, NOW + 3000))).toEqual({ kind: "finish", reason: "limitRest", cancel: false });
    expect(nextChaseStep({ ...limited, atLimit: "cancel" }, fresh({ order }), book(100.5, 101, NOW + 3000))).toEqual({ kind: "finish", reason: "limitCancel", cancel: true });
    // A percentage limit counts from the start price.
    expect(chaseLimitPrice({ side: "buy", limit: { kind: "pct", pct: 1 } }, 100)).toBeCloseTo(101);
    expect(chaseLimitPrice({ side: "sell", limit: { kind: "pct", pct: 1 } }, 100)).toBeCloseTo(99);
  });
  it("sends an IOC when the time limit is up, and stops after 5 rejections", () => {
    const timed: ChaseConfig = { ...config, timeLimitMs: 60_000, limit: { kind: "price", price: 101.5 } };
    expect(nextChaseStep(timed, fresh({ filled: 0.25 }), book(100, 101, NOW + 60_000))).toEqual({ kind: "ioc", price: "101", size: "0.75" });
    expect(nextChaseStep({ ...timed, limit: { kind: "price", price: 100.5 } }, fresh(), book(100, 101, NOW + 60_000))).toEqual({ kind: "finish", reason: "timeUp", cancel: false });
    expect(nextChaseStep(config, fresh({ rejections: CHASE_MAX_REJECTIONS }), book(100, 101))).toEqual({ kind: "finish", reason: "rejections", cancel: false });
  });
  it("sells chase the ask down", () => {
    const sell: ChaseConfig = { side: "sell", size: 2, szDecimals: 2 };
    const order = { price: "100.99", size: "2", placedAt: NOW };
    expect(nextChaseStep(sell, fresh({ order }), book(100, 100.99, NOW + 3000)).kind).toBe("wait");
    expect(nextChaseStep(sell, fresh({ order }), book(100, 100.5, NOW + 3000))).toEqual({ kind: "reprice", price: "100.49", size: "2" });
  });
  it("waits without a two-sided book", () => {
    expect(nextChaseStep(config, fresh(), book(0, 101)).kind).toBe("wait");
    expect(nextChaseStep(config, fresh(), book(101, 100)).kind).toBe("wait");
  });
});

describe("nextTwapSlice", () => {
  const config: TwapConfig = { id: "t1", side: "sell", totalSize: 10, szDecimals: 2, durationMs: 10 * 60_000, intervalMs: 60_000 };
  it("slices evenly at the interval", () => {
    expect(planTwap(config)).toMatchObject({ slices: 10, sliceSize: 1 });
    const first = nextTwapSlice(config, { startedAt: NOW, executed: 0, slicesSent: 0 }, { now: NOW, price: 100 });
    expect(first).toEqual({ kind: "slice", index: 0, size: "1", nextAt: NOW + 60_000 });
    expect(nextTwapSlice(config, { startedAt: NOW, executed: 1, slicesSent: 1, nextAt: NOW + 60_000 }, { now: NOW + 30_000, price: 100 })).toEqual({ kind: "wait", until: NOW + 60_000 });
  });
  it("randomizes size and timing deterministically, never under 30 s", () => {
    const r = { ...config, randomize: true };
    const a = nextTwapSlice(r, { startedAt: NOW, executed: 0, slicesSent: 3 }, { now: NOW + 180_000, price: 100 });
    const b = nextTwapSlice(r, { startedAt: NOW, executed: 0, slicesSent: 3 }, { now: NOW + 180_000, price: 100 });
    expect(a).toEqual(b);
    if (a.kind !== "slice") throw new Error("expected a slice");
    expect(a.nextAt - (NOW + 180_000)).toBeGreaterThanOrEqual(TWAP_MIN_INTERVAL_MS);
    expect(a.nextAt - (NOW + 180_000)).toBeLessThanOrEqual(72_000);
    expect(unitHash("x")).toBe(unitHash("x"));
    expect(unitHash("x")).not.toBe(unitHash("y"));
  });
  it("pauses beyond the price limit instead of ending", () => {
    const limited = { ...config, priceLimit: 95 };
    expect(nextTwapSlice(limited, { startedAt: NOW, executed: 0, slicesSent: 0 }, { now: NOW, price: 94 })).toEqual({ kind: "paused", reason: "priceLimit" });
    expect(nextTwapSlice(limited, { startedAt: NOW, executed: 0, slicesSent: 0 }, { now: NOW, price: 96 }).kind).toBe("slice");
    expect(nextTwapSlice({ ...limited, side: "buy" }, { startedAt: NOW, executed: 0, slicesSent: 0 }, { now: NOW, price: 96 }).kind).toBe("paused");
  });
  it("catches up after a pause at most 3× the normal slice, and keeps going after the end", () => {
    const late = nextTwapSlice(config, { startedAt: NOW, executed: 0, slicesSent: 1 }, { now: NOW + 8 * 60_000, price: 100 });
    expect(late).toMatchObject({ kind: "slice", size: "3" });
    const after = nextTwapSlice(config, { startedAt: NOW, executed: 6, slicesSent: 5 }, { now: NOW + 20 * 60_000, price: 100 });
    expect(after).toMatchObject({ kind: "slice", size: "3" });
  });
  it("keeps slices above $10 and ends with the remainder", () => {
    const small = nextTwapSlice({ ...config, totalSize: 0.5 }, { startedAt: NOW, executed: 0, slicesSent: 0 }, { now: NOW, price: 100 });
    expect(small).toMatchObject({ kind: "slice", size: "0.1" });
    // 0.15 left: a 0.1 slice would strand 0.05 ($5), so it takes all of it.
    expect(nextTwapSlice({ ...config, totalSize: 0.5 }, { startedAt: NOW, executed: 0.35, slicesSent: 3 }, { now: NOW + 180_000, price: 100 })).toMatchObject({ size: "0.15" });
    expect(nextTwapSlice(config, { startedAt: NOW, executed: 9.95, slicesSent: 9 }, { now: NOW + 540_000, price: 100 })).toEqual({ kind: "done", reason: "belowMinimum" });
    expect(nextTwapSlice({ ...config, smallFinalSlice: true }, { startedAt: NOW, executed: 9.95, slicesSent: 9 }, { now: NOW + 540_000, price: 100 })).toMatchObject({ kind: "slice", size: "0.05" });
    expect(nextTwapSlice(config, { startedAt: NOW, executed: 10, slicesSent: 10 }, { now: NOW, price: 100 })).toEqual({ kind: "done", reason: "complete" });
  });
  it("checks settings", () => {
    expect(twapConfigProblems({ totalSize: 1, durationMs: 60_000, intervalMs: 30_000 })[0]).toMatch(/5 minutes/);
    expect(twapConfigProblems({ totalSize: 1, durationMs: 600_000, intervalMs: 10_000 })[0]).toMatch(/30 seconds/);
    expect(twapConfigProblems({ totalSize: 0.1, durationMs: 600_000, intervalMs: 30_000, price: 100 })[0]).toMatch(/\$10/);
    expect(twapConfigProblems({ totalSize: 10, durationMs: 600_000, intervalMs: 60_000, price: 100 })).toEqual([]);
  });
});

describe("twap guardian rule", () => {
  const long = (size: number): GuardianPosition => ({ side: "long", size, entryPrice: 100, liquidationPrice: null, marginMode: "cross" });
  const ps = (positions: Record<string, GuardianPosition>): PositionState => ({ account: { equityUsd: 10_000 }, positions, orders: [] });
  const market = (markPrice: number): MarketState => ({ ETH: { markPrice, szDecimals: 2 } });
  const rule = (extra: Partial<TwapRule> = {}): TwapRule =>
    parseTwapRule({ id: "tw-1", type: "twap", coin: "ETH", createdAt: NOW, action: { kind: "close" }, durationMs: 10 * 60_000, intervalMs: 60_000, randomize: false, ...extra });
  it("validates, with defaults and limits", () => {
    const r = rule();
    expect(r.status).toBe("armed");
    expect(r.randomize).toBe(false);
    expect(parseTwapRule({ id: "a", type: "twap", coin: "ETH", createdAt: NOW, action: { kind: "close" }, durationMs: 600_000 }).intervalMs).toBe(60_000);
    expect(() => parseTwapRule({ ...r, durationMs: 60_000 })).toThrow(GuardianRuleValidationError);
    expect(() => parseTwapRule({ ...r, intervalMs: 10_000 })).toThrow(GuardianRuleValidationError);
    expect(() => parseTwapRule({ ...r, slippageBps: 800 })).toThrow(GuardianRuleValidationError);
    expect(() => parseTwapRule({ ...r, action: { kind: "reduce", pct: 100 } })).toThrow(GuardianRuleValidationError);
    expect(isAlgoRule(r)).toBe(true);
    expect(parseEngineRule({ ...r }).type).toBe("twap");
    expect(() => parseEngineRule({ type: "nope" })).toThrow(GuardianRuleValidationError);
  });
  it("closes a position in reduce-only market slices with algo cloids", () => {
    const first = evaluateTwapRule(rule(), market(100), ps({ ETH: long(10) }), NOW);
    expect(first.status).toBe("triggered");
    expect(first.intents).toHaveLength(1);
    const o = first.intents[0]!;
    if (o.kind !== "order") throw new Error("expected an order");
    expect(o).toMatchObject({ side: "sell", orderType: "market", size: "1", reduceOnly: true, slippageBps: 100, origin: "guardian" });
    expect(isAlgoChild(o.cloid, "tw-1", "twap")).toBe(true);
    expect(parseCloid(o.cloid!)?.algo?.slice).toBe(0);
    expect(first.nextState).toMatchObject({ startedAt: NOW, side: "long", startSize: "10", targetSize: "0", slicesSent: 1, nextAt: NOW + 60_000 });
    const advanced = { ...rule(), state: first.nextState, status: first.status } as TwapRule;
    // Waits until the next slice time, then slices again from the position size.
    expect(evaluateTwapRule(advanced, market(100), ps({ ETH: long(9) }), NOW + 30_000).intents).toHaveLength(0);
    const second = evaluateTwapRule(advanced, market(100), ps({ ETH: long(9) }), NOW + 60_000);
    expect(second.intents[0]).toMatchObject({ size: "1" });
    expect(parseCloid((second.intents[0] as { cloid: string }).cloid)?.algo?.slice).toBe(1);
    // Same inputs, same slice (idempotent retries).
    expect(evaluateTwapRule(advanced, market(100), ps({ ETH: long(9) }), NOW + 60_000)).toEqual(second);
  });
  it("reduces by a percentage and completes at the target", () => {
    const r = rule({ action: { kind: "reduce", pct: 50 } });
    const first = evaluateTwapRule(r, market(100), ps({ ETH: long(10) }), NOW);
    expect(first.nextState.targetSize).toBe("5");
    const done = evaluateTwapRule({ ...r, state: first.nextState, status: "triggered" }, market(100), ps({ ETH: long(5) }), NOW + 120_000);
    expect(done.status).toBe("completed");
    expect(twapRuleProgress({ state: first.nextState }, 7.5).share).toBeCloseTo(0.5);
  });
  it("pauses on the price limit, completes when the position is gone or flips", () => {
    const r = rule({ priceLimit: "95" });
    const paused = evaluateTwapRule(r, market(94), ps({ ETH: long(10) }), NOW);
    expect(paused.intents).toHaveLength(0);
    expect(paused.status).toBe("triggered");
    expect(paused.nextState.pausedByLimit).toBe(true);
    const started = { ...r, state: paused.nextState, status: "triggered" } as TwapRule;
    expect(evaluateTwapRule(started, market(96), ps({ ETH: long(10) }), NOW + 1000).intents).toHaveLength(1);
    expect(evaluateTwapRule(started, market(96), ps({}), NOW + 1000).status).toBe("completed");
    expect(evaluateTwapRule(started, market(96), ps({ ETH: { ...long(3), side: "short" } }), NOW + 1000).status).toBe("completed");
    expect(evaluateTwapRule(rule(), market(96), ps({}), NOW).status).toBe("completed");
    expect(evaluateTwapRule({ ...rule(), status: "paused" }, market(96), ps({ ETH: long(1) }), NOW).intents).toHaveLength(0);
    expect(evaluateTwapRule({ ...rule(), expiresAt: NOW }, market(96), ps({ ETH: long(1) }), NOW).status).toBe("expired");
  });
  it("closes the last bit even under $10", () => {
    const r = rule();
    const st = { seq: 9, startedAt: NOW, side: "long" as const, startSize: "10", targetSize: "0", slicesSent: 9, nextAt: NOW + 540_000, pausedByLimit: false };
    const last = evaluateTwapRule({ ...r, state: st, status: "triggered" }, market(100), ps({ ETH: long(0.05) }), NOW + 540_000);
    expect(last.intents[0]).toMatchObject({ size: "0.05", reduceOnly: true });
  });
  it("passes the guardian policy (reduce-only market orders with the builder)", () => {
    const registry = mainnetRegistry();
    const builder = { address: "0x1111111111111111111111111111111111111111" as const, feeTenthsBps: 25 };
    const policy = createGuardianPolicy({ builder: { b: builder.address, f: 25 }, allowedCoins: ["ETH"], maxOrderNotionalUsd: 1, maxDailyNotionalUsd: 10 });
    const r = parseTwapRule({ id: "tw-2", type: "twap", coin: "ETH", createdAt: NOW, action: { kind: "close" }, durationMs: 600_000, randomize: false });
    const eth = registry.require("ETH");
    const ev = evaluateEngineRule(r, { ETH: { markPrice: 3000, szDecimals: eth.szDecimals } }, ps({ ETH: long(1) }), NOW);
    expect(ev.intents).toHaveLength(1);
    const compiled = compileAction(ev.intents[0]!, { registry, builder, getMidPrice: () => 3000 });
    const decision = evaluatePolicy(
      { kind: "compiled", compiled, expiresAfter: NOW + 10_000 },
      { policy, now: NOW, markPrices: { ETH: 3000 }, dailyNotionalUsedUsd: 0, ordersInLastMinute: 0, registry },
    );
    // Reduce-only slices are exempt from the notional caps (the guardian default caps entries at $1).
    expect(decision.violations).toEqual([]);
  });
});

describe("trailing helpers", () => {
  it("puts the stop behind the price, never tighter than asked", () => {
    expect(trailStopPrice("long", 100, { kind: "pct", value: 3 }, 2)).toBe("97");
    expect(trailStopPrice("short", 100, { kind: "pct", value: 3 }, 2)).toBe("103");
    expect(trailStopPrice("long", 100.07, { kind: "price", value: 2.5555 }, 2)).toBe("97.514");
    expect(trailStopPrice("long", 1, { kind: "price", value: 2 }, 2)).toBeUndefined();
    expect(stopAtLeastAsTight("long", 98, 97)).toBe(true);
    expect(stopAtLeastAsTight("short", 104, 103)).toBe(false);
  });
  it("checks distance and activation", () => {
    expect(trailProblems({ side: "long", mark: 100, distance: { kind: "pct", value: 0 } })[0]).toMatch(/distance/);
    expect(trailProblems({ side: "long", mark: 100, distance: { kind: "pct", value: 3 }, activationPrice: 99 })[0]).toMatch(/above the mark/);
    expect(trailProblems({ side: "short", mark: 100, distance: { kind: "pct", value: 3 }, activationPrice: 99 })).toEqual([]);
  });
});

describe("trailing stop guardian (server execution)", () => {
  const pos = (side: "long" | "short", size = 2): GuardianPosition => ({ side, size, entryPrice: 100, liquidationPrice: null, marginMode: "cross" });
  const ps = (positions: Record<string, GuardianPosition>, orders: PositionState["orders"] = []): PositionState => ({ account: { equityUsd: 10_000 }, positions, orders });
  const mk = (markPrice: number): MarketState => ({ SOL: { markPrice, szDecimals: 2 } });
  const trail = (extra: Record<string, unknown> = {}) =>
    parseEngineRule({ id: "tr-1", type: "trailingStop", createdAt: NOW, coin: "SOL", trail: { kind: "pct", value: 3 }, ...extra }) as Extract<ReturnType<typeof parseEngineRule>, { type: "trailingStop" }>;
  const step = (rule: ReturnType<typeof trail>, mark: number, orders: PositionState["orders"] = [], positions = { SOL: pos("long") }) => {
    const ev = evaluateEngineRule(rule, mk(mark), ps(positions, orders), NOW);
    return { ev, next: { ...rule, state: ev.nextState, status: ev.status } as ReturnType<typeof trail> };
  };
  it("places the first stop a % behind the mark", () => {
    const { ev } = step(trail(), 100);
    expect(ev.intents).toHaveLength(1);
    expect(ev.intents[0]).toMatchObject({ kind: "order", orderType: "stopMarket", side: "sell", triggerPrice: "97", reduceOnly: true, positionTpsl: true });
    expect(ev.requires).toEqual({});
    expect(ev.cleanup).toEqual([]);
  });
  it("uses a $ distance and waits for the activation price", () => {
    const usd = trail({ trail: { kind: "price", value: "2.5" }, activationPrice: "105" });
    expect(step(usd, 100).ev.intents).toHaveLength(0);
    expect(step(usd, 100).ev.reason).toMatch(/activation/);
    const { ev } = step(usd, 106);
    expect(ev.intents[0]).toMatchObject({ triggerPrice: "103.5" });
  });
  it("moves the stop by placing the new one, then canceling the old one, and never loosens", () => {
    const first = step(trail(), 100);
    const ownCloid = (first.ev.intents[0] as { cloid: string }).cloid;
    const open = [{ coin: "SOL", cloid: ownCloid, side: "sell" as const, status: "open" as const, origSize: 2, filledSize: 0, triggerPrice: 97 }];
    // The price falls: the stop stays.
    expect(step(first.next, 98, open).ev.intents).toHaveLength(0);
    // The price rises: a new stop, then the cancel of the old one, which depends on it and may fail harmlessly.
    const up = step(first.next, 110, open);
    expect(up.ev.intents.map((i) => i.kind)).toEqual(["order", "cancel"]);
    expect(up.ev.intents[0]).toMatchObject({ orderType: "stopMarket", triggerPrice: "106.7", positionTpsl: true, reduceOnly: true });
    expect(up.ev.intents[1]).toMatchObject({ cancels: [{ coin: "SOL", cloid: ownCloid }] });
    expect(up.ev.requires).toEqual({ "1": 0 });
    expect(up.ev.cleanup).toEqual([1]);
    expect(up.ev.intents.some((i) => i.kind === "modify")).toBe(false);
    // Back down: never loosens.
    const newCloid = (up.ev.intents[0] as { cloid: string }).cloid;
    expect(step(up.next, 104, [{ ...open[0]!, cloid: newCloid, triggerPrice: 106.7 }]).ev.intents).toHaveLength(0);
  });
  it("manages an existing exchange stop without loosening it", () => {
    const external = [{ coin: "SOL", oid: 42, side: "sell" as const, status: "open" as const, origSize: 2, filledSize: 0, triggerPrice: 98 }];
    const rule = trail({ stopOrder: { oid: 42 } });
    // 3% behind 100 is 97, looser than the 98 stop: nothing moves.
    expect(step(rule, 100, external).ev.intents).toHaveLength(0);
    const up = step(rule, 105, external);
    expect(up.ev.intents.map((i) => i.kind)).toEqual(["order", "cancel"]);
    expect(up.ev.intents[1]).toMatchObject({ cancels: [{ coin: "SOL", oid: 42 }] });
  });
  it("puts a canceled stop back, never looser than before", () => {
    const first = step(trail(), 110);
    const ownCloid = (first.ev.intents[0] as { cloid: string }).cloid;
    const canceled = [{ coin: "SOL", cloid: ownCloid, side: "sell" as const, status: "canceled" as const, origSize: 2, filledSize: 0, triggerPrice: 106.7 }];
    const restored = step(first.next, 108, canceled);
    expect(restored.ev.intents).toHaveLength(1);
    expect(restored.ev.intents[0]).toMatchObject({ kind: "order", triggerPrice: "106.7" });
    expect(restored.ev.reason).toMatch(/was canceled/);
    expect((restored.ev.intents[0] as { cloid: string }).cloid).not.toBe(ownCloid);
    // A filled or triggered stop is not replaced.
    expect(step(first.next, 108, [{ ...canceled[0]!, status: "triggered" }]).ev.intents).toHaveLength(0);
  });
  it("shorts trail above the price", () => {
    const { ev } = step(trail(), 100, [], { SOL: pos("short") });
    expect(ev.intents[0]).toMatchObject({ side: "buy", triggerPrice: "103" });
  });
});
