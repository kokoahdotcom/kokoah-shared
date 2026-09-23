import { describe, expect, it } from "vitest";
import { compileAction } from "../src/actions/index.js";
import { type ActionIntentInput, parseActionIntent } from "../src/intents/index.js";
import {
  checkLimitPriceBand,
  checkTriggerPriceBand,
  createGuardianPolicy,
  createManualTradingPolicy,
  evaluatePolicy,
  isMarketableLimit,
  isTriggerCrossed,
  type PolicyContext,
  RESTING_PRICE_BAND_PCT,
  restingPriceBandPct,
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
