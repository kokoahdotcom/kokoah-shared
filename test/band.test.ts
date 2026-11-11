import { describe, expect, it } from "vitest";
import { compileAction, marketTriggerLimitPrice, type MarketTriggerLeg } from "../src/actions/index.js";
import { type ActionIntentInput, parseActionIntent } from "../src/intents/index.js";
import {
  checkLimitPriceBand,
  checkTriggerPriceBand,
  createGuardianPolicy,
  createManualTradingPolicy,
  evaluatePolicy,
  isMarketableLimit,
  isTriggerCrossed,
  marketTriggerSlippageFor,
  type PolicyContext,
  RESTING_PRICE_BAND_PCT,
  restingPriceBandPct,
  triggerLimitAllowancePct,
  triggerLimitBandProblem,
} from "../src/policy/index.js";
import { mainnetRegistry } from "./helpers.js";

const registry = mainnetRegistry();
const NOW = 1_790_000_000_000;
const BUILDER = { b: "0x1111111111111111111111111111111111111111" as const, f: 25 };
const MARK = 85_000;

describe("band helpers", () => {
  it("has a 50% resting baseline that never narrows a wider policy band", () => {
    expect(RESTING_PRICE_BAND_PCT).toBe(50);
    expect(restingPriceBandPct(10)).toBe(50);
    expect(restingPriceBandPct(2)).toBe(50);
    expect(restingPriceBandPct(70)).toBe(70);
  });

  it("classifies marketable limits against mark and (optionally) mid", () => {
    expect(isMarketableLimit({ isBuy: true, price: 85_000, mark: MARK })).toBe(true); // at mark
    expect(isMarketableLimit({ isBuy: true, price: 84_999, mark: MARK })).toBe(false);
    expect(isMarketableLimit({ isBuy: false, price: 85_000, mark: MARK })).toBe(true);
    expect(isMarketableLimit({ isBuy: false, price: 85_001, mark: MARK })).toBe(false);
    // Book mid below mark: a buy between them already crosses the book.
    expect(isMarketableLimit({ isBuy: true, price: 84_900, mark: MARK, mid: 84_800 })).toBe(true);
    expect(isMarketableLimit({ isBuy: false, price: 85_100, mark: MARK, mid: 85_200 })).toBe(true);
    // No usable reference: treated as marketable (tighter band).
    expect(isMarketableLimit({ isBuy: true, price: 1, mark: Number.NaN })).toBe(true);
  });

  it("bands orders that execute now at the policy band and resting limits at 50%", () => {
    const base = { mark: MARK, bandPct: 10 };
    // Resting buy 20% below: fine. 60% below: typo.
    expect(checkLimitPriceBand({ ...base, isBuy: true, price: 68_000 })).toMatchObject({ ok: true, execution: "resting", maxPct: 50 });
    expect(checkLimitPriceBand({ ...base, isBuy: true, price: 68_000, tif: "Alo" })).toMatchObject({ ok: true, execution: "resting" });
    const typo = checkLimitPriceBand({ ...base, isBuy: true, price: 8_500 });
    expect(typo).toMatchObject({ ok: false, execution: "resting" });
    expect(typo.message).toBe("Resting buy limit at 8500 is 90% from the mark price 85000; resting limits must be within 50% of the mark.");
    // Marketable buy 20% above: executes now, 10% band.
    const above = checkLimitPriceBand({ ...base, isBuy: true, price: 102_000 });
    expect(above).toMatchObject({ ok: false, execution: "immediate", maxPct: 10 });
    expect(above.message).toContain("would fill immediately");
    expect(above.message).toContain("a resting limit can be up to 50% away");
    // Resting sell 20% above: fine; marketable sell 20% below: refused.
    expect(checkLimitPriceBand({ ...base, isBuy: false, price: 102_000 }).ok).toBe(true);
    expect(checkLimitPriceBand({ ...base, isBuy: false, price: 68_000 })).toMatchObject({ ok: false, execution: "immediate" });
    // IOC always executes now, even far below the market.
    const ioc = checkLimitPriceBand({ ...base, isBuy: true, price: 68_000, tif: "Ioc" });
    expect(ioc).toMatchObject({ ok: false, execution: "immediate" });
    expect(ioc.message).not.toContain("resting limit");
    // At the edges.
    expect(checkLimitPriceBand({ ...base, isBuy: true, price: 93_500 }).ok).toBe(true); // +10%
    expect(checkLimitPriceBand({ ...base, isBuy: true, price: 42_500 }).ok).toBe(true); // -50%
    expect(checkLimitPriceBand({ ...base, isBuy: true, price: 42_499 }).ok).toBe(false);
  });

  it("bands triggers: limit vs trigger, untriggered trigger vs mark (resting), crossed trigger vs mark (now)", () => {
    const base = { mark: MARK, bandPct: 10 };
    // Long's stop 20% below: rests, fine. 60% below: typo.
    expect(checkTriggerPriceBand({ ...base, isBuy: false, tpsl: "sl", triggerPrice: 68_000 })).toMatchObject({ ok: true, crossed: false });
    const far = checkTriggerPriceBand({ ...base, isBuy: false, tpsl: "sl", triggerPrice: 30_000 });
    expect(far.ok).toBe(false);
    expect(far.problems[0]).toContain("triggers must be within 50% of the mark");
    // Long's take profit 40% above: fine.
    expect(checkTriggerPriceBand({ ...base, isBuy: false, tpsl: "tp", triggerPrice: 119_000 }).ok).toBe(true);
    // Limit too far from its own trigger.
    const loose = checkTriggerPriceBand({ ...base, isBuy: false, tpsl: "sl", triggerPrice: 80_000, limitPrice: 60_000 });
    expect(loose.problems).toEqual(["Trigger limit price is 25% from its trigger (max 10%)."]);
    // Already crossed (a sell stop above the mark): fires now; its limit must be within 10% of mark.
    expect(isTriggerCrossed({ isBuy: false, tpsl: "sl", triggerPrice: 100_000, mark: MARK })).toBe(true);
    const crossed = checkTriggerPriceBand({ ...base, isBuy: false, tpsl: "sl", triggerPrice: 100_000, limitPrice: 99_000 });
    expect(crossed).toMatchObject({ ok: false, crossed: true });
    expect(crossed.problems[0]).toContain("would fire immediately");
    expect(checkTriggerPriceBand({ ...base, isBuy: false, tpsl: "sl", triggerPrice: 86_000, limitPrice: 85_000 })).toMatchObject({ ok: true, crossed: true });
  });
});

describe("evaluatePolicy with the manual baseline (10%)", () => {
  const policy = createManualTradingPolicy({ builder: BUILDER });
  const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
    policy,
    now: NOW,
    markPrices: { BTC: MARK },
    dailyNotionalUsedUsd: 0,
    ordersInLastMinute: 0,
    registry,
    expiresAfter: NOW + 15_000,
    ...over,
  });
  const limit = (price: string, extra: Record<string, unknown> = {}): ActionIntentInput =>
    ({ kind: "order", coin: "BTC", side: "buy", orderType: "limit", size: "0.0002", price, origin: "manual", ...extra }) as ActionIntentInput;
  const compiled = (i: ActionIntentInput) => compileAction(i, { registry, builder: { address: BUILDER.b, feeTenthsBps: BUILDER.f } });
  const both = (i: ActionIntentInput, c: PolicyContext = ctx()) => {
    const comp = compiled(i);
    const onCompiled = evaluatePolicy({ kind: "compiled", compiled: comp, expiresAfter: NOW + 15_000 }, c);
    const onWire = evaluatePolicy({ kind: "wire", action: comp.action as never, expiresAfter: NOW + 15_000, origin: "manual" }, c);
    expect(onWire.allowed).toBe(onCompiled.allowed);
    return onCompiled;
  };

  it("accepts a resting buy 20% below mark (GTC and ALO)", () => {
    expect(both(limit("68000")).allowed).toBe(true);
    expect(both(limit("68000", { tif: "Alo" })).allowed).toBe(true);
  });

  it("refuses a marketable buy 20% above mark and an IOC 20% below", () => {
    const above = both(limit("102000"));
    expect(above.violations.map((v) => v.code)).toEqual(["PRICE_OUTSIDE_BAND"]);
    expect(above.violations[0]!.message).toContain("would fill immediately");
    expect(both(limit("68000", { tif: "Ioc" })).allowed).toBe(false);
  });

  it("refuses fat-finger resting prices (8500 for 85000)", () => {
    const d = both(limit("8500"));
    expect(d.allowed).toBe(false);
    expect(d.violations[0]!.message).toContain("resting limits must be within 50%");
  });

  it("uses the evaluator's own mid to classify marketable limits", () => {
    // Book mid 1% under the mark: a buy just under the mark crosses the book, still inside 10% — fine either way.
    expect(both(limit("84500"), ctx({ midPrices: { BTC: 84_000 } })).allowed).toBe(true);
    // A thin book whose mid is 30% under the mark: a buy 20% under the mark crosses it and executes now.
    expect(both(limit("68000"), ctx({ midPrices: { BTC: 59_500 } })).allowed).toBe(false);
  });

  it("a user-tightened band narrows orders that execute now but keeps the resting band", () => {
    const tight = { ...policy, priceBandPct: 2 };
    expect(both(limit("87550"), ctx({ policy: tight })).allowed).toBe(false); // +3%, marketable
    expect(both(limit("68000"), ctx({ policy: tight })).allowed).toBe(true); // resting
  });

  it("modify: a resting replacement may move to 20% below mark", () => {
    const m = { kind: "modify", target: { oid: 1 }, order: { coin: "BTC", side: "buy", orderType: "limit", size: "0.0002", price: "68000" }, origin: "manual" } as ActionIntentInput;
    expect(both(m).allowed).toBe(true);
    const bad = { ...m, order: { ...(m as { order: object }).order, price: "102000" } } as ActionIntentInput;
    expect(both(bad).allowed).toBe(false);
  });

  it("triggers: resting stops up to 50% away, crossed triggers at the 10% band", () => {
    const stop = (trigger: string) =>
      ({ kind: "order", coin: "BTC", side: "sell", orderType: "stopMarket", size: "0.0002", triggerPrice: trigger, reduceOnly: true, origin: "manual" }) as ActionIntentInput;
    expect(both(stop("68000")).allowed).toBe(true);
    expect(both(stop("30000")).allowed).toBe(false);
    // A sell stop above the mark fires now; a market stop's limit is trigger − 10%, i.e. ~6% from mark here: fine.
    expect(both(stop("88000")).allowed).toBe(true);
    // Far above: fires now at a limit far from mark.
    expect(both(stop("120000")).allowed).toBe(false);
  });
});

describe("guardian policy (5%)", () => {
  it("keeps entries that execute now at 5% and allows resting guardian limits within 50%", () => {
    const policy = createGuardianPolicy({ builder: BUILDER, allowedCoins: ["BTC"], maxOrderNotionalUsd: 1_000, maxDailyNotionalUsd: 5_000 });
    const c: PolicyContext = { policy, now: NOW, markPrices: { BTC: MARK }, dailyNotionalUsedUsd: 0, ordersInLastMinute: 0, registry, expiresAfter: NOW + 10_000 };
    const entry = (price: string, sl: string) =>
      ({ kind: "order", coin: "BTC", side: "buy", orderType: "limit", size: "0.001", price, origin: "guardian", stopLoss: { triggerPrice: sl } }) as ActionIntentInput;
    expect(evaluatePolicy(parseActionIntent(entry("76500", "72000")), c).allowed).toBe(true); // resting 10% below
    expect(evaluatePolicy(parseActionIntent(entry("90000", "85000")), c).allowed).toBe(false); // marketable, ~5.9% above
    const market = { kind: "order", coin: "BTC", side: "buy", orderType: "market", size: "0.001", slippageBps: 600, origin: "guardian", stopLoss: { triggerPrice: "80000" } } as ActionIntentInput;
    expect(evaluatePolicy(parseActionIntent(market), c).violations.map((v) => v.code)).toContain("PRICE_OUTSIDE_BAND");
  });
});

describe("trigger limits near the mark or not reduce-only use the policy band", () => {
  it("allows max(band, 10%) only for a reduce-only trigger away from the mark", () => {
    const sell = { isBuy: false, tpsl: "sl" as const, bandPct: 5, mark: 100_000 };
    // Reduce-only, 20% away: Hyperliquid's 10% market TP/SL tolerance.
    expect(triggerLimitAllowancePct({ ...sell, reduceOnly: true, triggerPrice: 80_000 })).toBe(10);
    // Reduce-only within the band of the mark (at the edge too), crossed, or with no mark: the band.
    expect(triggerLimitAllowancePct({ ...sell, reduceOnly: true, triggerPrice: 99_000 })).toBe(5);
    expect(triggerLimitAllowancePct({ ...sell, reduceOnly: true, triggerPrice: 95_000 })).toBe(5);
    expect(triggerLimitAllowancePct({ ...sell, reduceOnly: true, triggerPrice: 101_000 })).toBe(5);
    expect(triggerLimitAllowancePct({ ...sell, reduceOnly: true, triggerPrice: 80_000, mark: undefined })).toBe(5);
    // Not reduce-only (an entry), however far: the band.
    expect(triggerLimitAllowancePct({ ...sell, isBuy: true, reduceOnly: false, triggerPrice: 130_000 })).toBe(5);
    // A band wider than 10% stays the limit everywhere.
    expect(triggerLimitAllowancePct({ ...sell, bandPct: 20, reduceOnly: true, triggerPrice: 99_000 })).toBe(20);
    expect(triggerLimitAllowancePct({ ...sell, bandPct: 20, reduceOnly: true, triggerPrice: 70_000 })).toBe(20);
    // Callers that don't say whether it is reduce-only keep the earlier rule.
    expect(triggerLimitAllowancePct({ ...sell, triggerPrice: 99_000 })).toBe(10);
  });

  it("checks a trigger's limit against that allowance", () => {
    const base = { mark: 100_000, bandPct: 5 };
    const stop = (triggerPrice: number, limitPrice: number, reduceOnly?: boolean) => checkTriggerPriceBand({ ...base, isBuy: false, tpsl: "sl", triggerPrice, limitPrice, ...(reduceOnly !== undefined ? { reduceOnly } : {}) });
    // A reduce-only stop 1% below the mark fires about at once: a 10% limit is refused, a 5% one is fine.
    expect(stop(99_000, 89_100, true).problems).toEqual(["Trigger limit price is 10% from its trigger (max 5%)."]);
    expect(stop(99_000, 94_050, true).ok).toBe(true);
    // 20% below: a protective stop, 10% allowed.
    expect(stop(80_000, 72_000, true).ok).toBe(true);
    // An entry trigger (a stop buy above the market): the band.
    const entry = checkTriggerPriceBand({ ...base, isBuy: true, tpsl: "sl", triggerPrice: 120_000, limitPrice: 132_000, reduceOnly: false });
    expect(entry.problems).toEqual(["Trigger limit price is 10% from its trigger (max 5%)."]);
    expect(checkTriggerPriceBand({ ...base, isBuy: true, tpsl: "sl", triggerPrice: 120_000, limitPrice: 126_000, reduceOnly: false }).ok).toBe(true);
    // Without reduceOnly (a preview that doesn't say): as before.
    expect(stop(99_000, 89_100).ok).toBe(true);
    // The mark-free part: with reduceOnly given and no mark, near.
    expect(triggerLimitBandProblem({ triggerPrice: 80_000, limitPrice: 72_000, bandPct: 5, reduceOnly: true })).toBe("trigger limit price is 10% from its trigger (max 5%).");
    expect(triggerLimitBandProblem({ triggerPrice: 80_000, limitPrice: 72_000, bandPct: 5, reduceOnly: true, isBuy: false, tpsl: "sl", mark: 100_000 })).toBe("");
    expect(triggerLimitBandProblem({ triggerPrice: 80_000, limitPrice: 72_000, bandPct: 5 })).toBe("");
  });

  it("gives signers the slippage to compile market triggers with", () => {
    const slip = marketTriggerSlippageFor({ priceBandPct: 5 }, { BTC: 100_000 });
    const leg = (o: Partial<MarketTriggerLeg>): MarketTriggerLeg => ({ coin: "BTC", isBuy: false, reduceOnly: true, tpsl: "sl", triggerPrice: "80000", ...o });
    expect(slip(leg({}))).toBe(1000);
    expect(slip(leg({ triggerPrice: "99000" }))).toBe(500);
    expect(slip(leg({ reduceOnly: false, isBuy: true, triggerPrice: "120000" }))).toBe(500);
    expect(slip(leg({ coin: "ETH" }))).toBe(500); // no mark: near
    expect(marketTriggerSlippageFor({ priceBandPct: 2.3 }, { BTC: 100_000 })(leg({ triggerPrice: "99000" }))).toBe(230);
    // A band of 0: only a trigger at (or past) the mark is near it.
    expect(marketTriggerSlippageFor({ priceBandPct: 0 }, { BTC: 100_000 })(leg({ triggerPrice: "100000" }))).toBe(0);
    expect(marketTriggerSlippageFor({ priceBandPct: 0 }, { BTC: 100_000 })(leg({ triggerPrice: "99000" }))).toBe(1000);
    // Never past Hyperliquid's 10%.
    expect(marketTriggerSlippageFor({ priceBandPct: 30 }, { BTC: 100_000 })(leg({}))).toBe(1000);
  });

  it("compiles market triggers within that slippage", () => {
    expect(marketTriggerLimitPrice({ triggerPrice: "99000", isBuy: false, szDecimals: 5 })).toBe("89100");
    expect(marketTriggerLimitPrice({ triggerPrice: "99000", isBuy: false, szDecimals: 5, slippageBps: 500 })).toBe("94050");
    expect(marketTriggerLimitPrice({ triggerPrice: "120000", isBuy: true, szDecimals: 5, slippageBps: 500 })).toBe("126000");
    expect(() => marketTriggerLimitPrice({ triggerPrice: "99000", isBuy: false, szDecimals: 5, slippageBps: 1001 })).toThrow(RangeError);
    expect(() => marketTriggerLimitPrice({ triggerPrice: "99000", isBuy: false, szDecimals: 5, slippageBps: 2.5 })).toThrow(RangeError);
    const legs: MarketTriggerLeg[] = [];
    const slippage = (leg: MarketTriggerLeg) => {
      legs.push(leg);
      return leg.reduceOnly ? 300 : 200;
    };
    const entry = compileAction({ kind: "order", coin: "BTC", side: "buy", orderType: "stopMarket", size: "0.001", triggerPrice: "120000", origin: "guardian" } as ActionIntentInput, {
      registry,
      marketTriggerSlippageBps: slippage,
    });
    const withLegs = compileAction(
      { kind: "order", coin: "BTC", side: "buy", orderType: "limit", price: "100000", size: "0.001", origin: "guardian", stopLoss: { triggerPrice: "99000" }, takeProfit: { triggerPrice: "130000" } } as ActionIntentInput,
      { registry, marketTriggerSlippageBps: slippage },
    );
    const moved = compileAction(
      { kind: "modify", target: { oid: 1 }, order: { coin: "BTC", side: "sell", orderType: "stopMarket", size: "0.001", triggerPrice: "98000", reduceOnly: true }, origin: "guardian" } as ActionIntentInput,
      { registry, marketTriggerSlippageBps: slippage },
    );
    expect(legs).toEqual([
      { coin: "BTC", isBuy: true, reduceOnly: false, tpsl: "sl", triggerPrice: "120000" },
      { coin: "BTC", isBuy: false, reduceOnly: true, tpsl: "tp", triggerPrice: "130000" },
      { coin: "BTC", isBuy: false, reduceOnly: true, tpsl: "sl", triggerPrice: "99000" },
      { coin: "BTC", isBuy: false, reduceOnly: true, tpsl: "sl", triggerPrice: "98000" },
    ]);
    expect((entry.action as { orders: Array<{ p: string }> }).orders.map((o) => o.p)).toEqual(["122400"]);
    expect((withLegs.action as { orders: Array<{ p: string }> }).orders.map((o) => o.p)).toEqual(["100000", "126100", "96030"]);
    expect((moved.action as { order: { p: string } }).order.p).toBe("95060");
    // A slippage function that returns nonsense is a programming error, never a wider limit.
    expect(() => compileAction(entry.intent, { registry, marketTriggerSlippageBps: () => 5000 })).toThrow(RangeError);
  });

  it("refuses under the guardian band what the default 10% compiles near the mark, and passes it compiled within the band", () => {
    const policy = createGuardianPolicy({ builder: BUILDER, allowedCoins: ["BTC"], maxOrderNotionalUsd: 100_000, maxDailyNotionalUsd: 500_000 });
    const c: PolicyContext = { policy, now: NOW, markPrices: { BTC: 100_000 }, dailyNotionalUsedUsd: 0, ordersInLastMinute: 0, registry, expiresAfter: NOW + 10_000 };
    const builder = { address: BUILDER.b, feeTenthsBps: BUILDER.f };
    const evalCompiled = (i: ActionIntentInput, banded: boolean) => {
      const comp = compileAction(i, { registry, builder, ...(banded ? { marketTriggerSlippageBps: marketTriggerSlippageFor(policy, c.markPrices) } : {}) });
      return evaluatePolicy({ kind: "compiled", compiled: comp, expiresAfter: NOW + 10_000 }, c);
    };
    // A protective stop 1% under the mark: it fires about as soon as a market order, so 10% is twice the band.
    const nearStop = { kind: "order", coin: "BTC", side: "sell", orderType: "stopMarket", size: "0.001", triggerPrice: "99000", reduceOnly: true, origin: "guardian" } as ActionIntentInput;
    expect(evalCompiled(nearStop, false).violations.map((v) => v.code)).toEqual(["PRICE_OUTSIDE_BAND"]);
    expect(evalCompiled(nearStop, true).allowed).toBe(true);
    // 20% under: a protective stop keeps Hyperliquid's 10% (the band would leave it unfilled in a fast fall).
    const farStop = { ...nearStop, triggerPrice: "80000" } as ActionIntentInput;
    expect(evalCompiled(farStop, false).allowed).toBe(true);
    expect((compileAction(farStop, { registry, builder, marketTriggerSlippageBps: marketTriggerSlippageFor(policy, c.markPrices) }).action as { orders: Array<{ p: string }> }).orders[0]!.p).toBe("72000");
    // An entry that buys when the market rises past 102,000: at most the band past its trigger.
    const entry = { kind: "order", coin: "BTC", side: "buy", orderType: "stopMarket", size: "0.001", triggerPrice: "102000", reduceOnly: false, origin: "guardian" } as ActionIntentInput;
    const withStop = { hasStopLoss: () => true };
    expect(evaluatePolicy({ kind: "compiled", compiled: compileAction(entry, { registry, builder }), expiresAfter: NOW + 10_000 }, { ...c, ...withStop }).violations.map((v) => v.code)).toEqual([
      "PRICE_OUTSIDE_BAND",
    ]);
    const banded = compileAction(entry, { registry, builder, marketTriggerSlippageBps: marketTriggerSlippageFor(policy, c.markPrices) });
    expect(evaluatePolicy({ kind: "compiled", compiled: banded, expiresAfter: NOW + 10_000 }, { ...c, ...withStop }).allowed).toBe(true);
    // A limit entry's attached market stop near the mark: the same.
    const limitEntry = { kind: "order", coin: "BTC", side: "buy", orderType: "limit", price: "99000", size: "0.001", origin: "guardian", stopLoss: { triggerPrice: "97000" } } as ActionIntentInput;
    expect(evalCompiled(limitEntry, false).violations.map((v) => v.code)).toEqual(["PRICE_OUTSIDE_BAND"]);
    expect(evalCompiled(limitEntry, true).allowed).toBe(true);
    // A raw wire action can't widen it either.
    const wire = { type: "order", orders: [{ a: 0, b: false, p: "89100", s: "0.001", r: true, t: { trigger: { isMarket: true, triggerPx: "99000", tpsl: "sl" } } }], grouping: "na", builder: { b: BUILDER.b, f: 25 } };
    expect(evaluatePolicy({ kind: "wire", action: wire, expiresAfter: NOW + 10_000, origin: "guardian" }, c).violations.map((v) => v.code)).toEqual(["PRICE_OUTSIDE_BAND"]);
  });

  it("changes nothing under the manual baseline's 10% band", () => {
    const policy = createManualTradingPolicy({ builder: BUILDER });
    const c: PolicyContext = { policy, now: NOW, markPrices: { BTC: 100_000 }, dailyNotionalUsedUsd: 0, ordersInLastMinute: 0, registry, expiresAfter: NOW + 10_000 };
    const comp = compileAction({ kind: "order", coin: "BTC", side: "sell", orderType: "stopMarket", size: "0.001", triggerPrice: "99000", reduceOnly: true, origin: "manual" } as ActionIntentInput, {
      registry,
      builder: { address: BUILDER.b, feeTenthsBps: BUILDER.f },
    });
    expect(evaluatePolicy({ kind: "compiled", compiled: comp, expiresAfter: NOW + 10_000 }, c).allowed).toBe(true);
    expect(marketTriggerSlippageFor(policy, c.markPrices)({ coin: "BTC", isBuy: false, reduceOnly: true, tpsl: "sl", triggerPrice: "99000" })).toBe(1000);
  });
});
