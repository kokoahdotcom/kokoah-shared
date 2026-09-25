import { describe, expect, it } from "vitest";
import { compileAction } from "../src/actions/index.js";
import { type ActionIntentInput, parseActionIntent } from "../src/intents/index.js";
import type { SpotMetaLike } from "../src/markets/index.js";
import {
  canonicalPolicyJson,
  createGuardianPolicy,
  createManualTradingPolicy,
  evaluatePolicy,
  hashPolicy,
  type Policy,
  type PolicyContext,
  STABLECOIN_PAIRS,
  stablecoinPairCoins,
  verifiedStablecoinPairs,
} from "../src/policy/index.js";
import { fixture, mainnetRegistry } from "./helpers.js";

const registry = mainnetRegistry();
const NOW = 1_790_000_000_000;
const BUILDER = { b: "0x1111111111111111111111111111111111111111" as const, f: 25 };
// Mainnet fixture: @166 is USDT0/USDC, @150 USDE/USDC, @107 HYPE/USDC.
const PAIR = "@166";

const policy = (over: Partial<Policy> = {}) => createManualTradingPolicy({ builder: BUILDER, overrides: { allowedSpotCoins: [PAIR, "@150"], ...over } });
const ctx = (p: Policy = policy(), over: Partial<PolicyContext> = {}): PolicyContext => ({
  policy: p,
  now: NOW,
  markPrices: { [PAIR]: 0.9998, "@150": 0.9991, "@107": 40, BTC: 100_000 },
  midPrices: { [PAIR]: 0.99985, "@150": 0.9992, "@107": 40 },
  dailyNotionalUsedUsd: 0,
  ordersInLastMinute: 0,
  registry,
  expiresAfter: NOW + 15_000,
  ...over,
});
const convert = (o: Partial<Record<string, unknown>> = {}): ActionIntentInput =>
  ({ kind: "order", coin: PAIR, side: "buy", orderType: "market", size: "25", slippageBps: 50, origin: "manual", ...o }) as ActionIntentInput;
const compiled = (i: ActionIntentInput) =>
  compileAction(i, { registry, builder: { address: BUILDER.b, feeTenthsBps: BUILDER.f }, getMidPrice: (c) => ctx().midPrices?.[c] });
const both = (i: ActionIntentInput, c: PolicyContext = ctx()) => {
  const comp = compiled(i);
  return {
    comp,
    onCompiled: evaluatePolicy({ kind: "compiled", compiled: comp, expiresAfter: NOW + 15_000 }, c),
    onWire: evaluatePolicy({ kind: "wire", action: comp.action as never, origin: "manual", expiresAfter: NOW + 15_000 }, c),
  };
};
const codes = (d: ReturnType<typeof evaluatePolicy>) => d.violations.map((v) => v.code);

describe("spot conversions", () => {
  it("compile a spot buy without a builder and a spot sell with it", () => {
    const buy = compiled(convert());
    expect(buy.action.type).toBe("order");
    expect("builder" in buy.action).toBe(false);
    expect((buy.action as { orders: Array<{ a: number; t: unknown }> }).orders[0]).toMatchObject({ a: 10166, t: { limit: { tif: "Ioc" } } });
    const sell = compiled(convert({ side: "sell" }));
    expect((sell.action as { builder?: unknown }).builder).toEqual({ b: BUILDER.b, f: BUILDER.f });
    // Perps are unchanged: buys keep the builder.
    const perp = compileAction(
      { kind: "order", coin: "BTC", side: "buy", orderType: "limit", size: "0.001", price: "100000", origin: "manual" },
      { registry, builder: { address: BUILDER.b, feeTenthsBps: BUILDER.f } },
    );
    expect((perp.action as { builder?: unknown }).builder).toEqual({ b: BUILDER.b, f: BUILDER.f });
  });

  it("allow a market buy and sell on a listed stablecoin pair", () => {
    for (const side of ["buy", "sell"]) {
      const r = both(convert({ side }));
      expect(r.onCompiled).toEqual({ allowed: true, violations: [], actionType: "order" });
      expect(r.onWire).toEqual({ allowed: true, violations: [], actionType: "order" });
      expect(evaluatePolicy(parseActionIntent(convert({ side })), ctx()).allowed).toBe(true);
    }
  });

  it("deny every spot pair that is not listed, and all spot when nothing is listed", () => {
    const hype = both(convert({ coin: "@107", size: "1" }));
    expect(codes(hype.onWire)).toEqual(["SPOT_NOT_ALLOWED"]);
    expect(codes(hype.onCompiled)).toEqual(["SPOT_NOT_ALLOWED"]);
    const none = createManualTradingPolicy({ builder: BUILDER });
    expect(codes(both(convert(), ctx(none)).onWire)).toEqual(["SPOT_NOT_ALLOWED"]);
    expect(codes(evaluatePolicy(parseActionIntent(convert()), ctx(none)))).toEqual(["SPOT_NOT_ALLOWED"]);
    expect(codes(evaluatePolicy(parseActionIntent(convert({ coin: "PURR/USDC", size: "100" })), ctx(none, { markPrices: { "PURR/USDC": 0.2 } })))).toEqual([
      "SPOT_NOT_ALLOWED",
    ]);
  });

  it("deny resting, trigger and reduce-only spot orders", () => {
    expect(codes(both(convert({ orderType: "limit", price: "1", tif: "Gtc", slippageBps: undefined })).onWire)).toEqual(["SPOT_NOT_ALLOWED"]);
    expect(codes(both(convert({ orderType: "limit", price: "1", tif: "Alo", slippageBps: undefined })).onWire)).toEqual(["SPOT_NOT_ALLOWED"]);
    expect(both(convert({ orderType: "limit", price: "1.001", tif: "Ioc", slippageBps: undefined })).onWire.allowed).toBe(true);
    const stop = { kind: "order", coin: PAIR, side: "sell", orderType: "stopMarket", triggerPrice: "0.99", size: "25", origin: "manual" } as ActionIntentInput;
    expect(codes(evaluatePolicy(parseActionIntent(stop), ctx()))).toContain("SPOT_NOT_ALLOWED");
    expect(codes(evaluatePolicy(parseActionIntent(convert({ side: "sell", reduceOnly: true })), ctx()))).toContain("SPOT_NOT_ALLOWED");
  });

  it("deny spot modifies, several orders and TP/SL grouping on the wire", () => {
    const one = compiled(convert({ side: "sell" })).action as unknown as { orders: Array<Record<string, unknown>>; builder: unknown };
    const order = one.orders[0]!;
    const two = { type: "order", orders: [order, { ...order, c: "0x6b6f0101000000000000000000000009" }], grouping: "na", builder: one.builder };
    expect(codes(evaluatePolicy({ kind: "wire", action: two, origin: "manual", expiresAfter: NOW + 15_000 }, ctx()))).toEqual(["SPOT_NOT_ALLOWED"]);
    const grouped = { type: "order", orders: [order], grouping: "positionTpsl", builder: one.builder };
    expect(codes(evaluatePolicy({ kind: "wire", action: grouped, origin: "manual", expiresAfter: NOW + 15_000 }, ctx()))).toEqual(["SPOT_NOT_ALLOWED"]);
    const modify = { type: "modify", oid: 1, order: { ...order, t: { limit: { tif: "Gtc" } } } };
    expect(codes(evaluatePolicy({ kind: "wire", action: modify, origin: "manual", expiresAfter: NOW + 15_000 }, ctx()))).toContain("SPOT_NOT_ALLOWED");
  });

  it("require the exact builder on sells and none on buys", () => {
    const sell = compiled(convert({ side: "sell" })).action as unknown as Record<string, unknown>;
    const { builder: _drop, ...sellNoBuilder } = sell;
    expect(codes(evaluatePolicy({ kind: "wire", action: sellNoBuilder as never, origin: "manual", expiresAfter: NOW + 15_000 }, ctx()))).toEqual(["BUILDER_REQUIRED"]);
    const sellOther = { ...sell, builder: { b: BUILDER.b, f: 1000 } };
    expect(codes(evaluatePolicy({ kind: "wire", action: sellOther as never, origin: "manual", expiresAfter: NOW + 15_000 }, ctx()))).toEqual(["BUILDER_MISMATCH"]);
    const buy = compiled(convert()).action as unknown as Record<string, unknown>;
    for (const builder of [BUILDER, { b: "0x9999999999999999999999999999999999999999", f: 1000 }]) {
      const d = evaluatePolicy({ kind: "wire", action: { ...buy, builder } as never, origin: "manual", expiresAfter: NOW + 15_000 }, ctx());
      expect(codes(d)).toEqual(["BUILDER_MISMATCH"]);
    }
  });

  it("keep notional, daily and price-band limits, and skip perp-only rules", () => {
    expect(codes(both(convert({ size: "2000" }), ctx(policy({ maxOrderNotionalUsd: 1000 }))).onWire)).toEqual(["ORDER_NOTIONAL_EXCEEDED"]);
    expect(codes(both(convert(), ctx(policy(), { dailyNotionalUsedUsd: 25_000_000 })).onWire)).toEqual(["DAILY_NOTIONAL_EXCEEDED"]);
    expect(codes(both(convert(), ctx(policy(), { markPrices: { [PAIR]: 1.5 } })).onWire)).toEqual(["PRICE_OUTSIDE_BAND"]);
    // A stop-loss requirement, a leverage cap and the loss lock are about perp exposure: a conversion is not.
    const strict = policy({ requireStopLossForNewEntries: true, maxLeverage: 2 });
    expect(both(convert(), ctx(strict, { leverageByCoin: { [PAIR]: 20 }, lossLockActive: true })).onWire.allowed).toBe(true);
  });

  it("respect a markets list and never reach guardian policies", () => {
    expect(codes(both(convert(), ctx(policy({ allowedCoins: ["BTC"] }))).onWire)).toEqual(["COIN_NOT_ALLOWED"]);
    const guardian = createGuardianPolicy({ builder: BUILDER, allowedCoins: "*", maxOrderNotionalUsd: 1000, maxDailyNotionalUsd: 5000 });
    const d = evaluatePolicy({ ...parseActionIntent(convert()), origin: "guardian" } as never, ctx(guardian));
    expect(codes(d)).toContain("SPOT_NOT_ALLOWED");
  });

  it("put the spot list in the signed policy hash (order-insensitive)", () => {
    expect(hashPolicy(policy({ allowedSpotCoins: ["@150", PAIR] }))).toBe(hashPolicy(policy({ allowedSpotCoins: [PAIR, "@150"] })));
    expect(hashPolicy(policy())).not.toBe(hashPolicy(createManualTradingPolicy({ builder: BUILDER })));
    expect(canonicalPolicyJson(createManualTradingPolicy({ builder: BUILDER }))).not.toContain("allowedSpotCoins");
  });
});

describe("pinned stablecoin pairs", () => {
  const meta = () => structuredClone(fixture<SpotMetaLike>("mainnet-spotMeta.json")) as unknown as { universe: Array<{ name: string; index: number; tokens: number[] }>; tokens: Array<{ name: string; index: number; tokenId?: string }> };

  it("are all confirmed by the captured mainnet spotMeta and are stablecoins against USDC", () => {
    expect(verifiedStablecoinPairs("mainnet", meta() as never).map((p) => p.coin)).toEqual(stablecoinPairCoins("mainnet"));
    for (const p of STABLECOIN_PAIRS.mainnet) {
      expect(p.quote.name).toBe("USDC");
      expect(registry.get(p.coin)).toMatchObject({ kind: "spot", baseToken: p.base.name, quoteToken: "USDC", assetId: 10_000 + p.index });
    }
  });

  it("drop a pair whose tokens, names, order or token ids differ (fail closed)", () => {
    const swapped = meta();
    swapped.universe.find((u) => u.index === 166)!.tokens.reverse();
    expect(verifiedStablecoinPairs("mainnet", swapped as never).map((p) => p.coin)).not.toContain("@166");
    const renamed = meta();
    renamed.tokens.find((t) => t.index === 268)!.name = "USDT";
    expect(verifiedStablecoinPairs("mainnet", renamed as never).map((p) => p.coin)).not.toContain("@166");
    const lookalike = meta();
    lookalike.tokens.find((t) => t.index === 268)!.tokenId = "0x00000000000000000000000000000001";
    expect(verifiedStablecoinPairs("mainnet", lookalike as never).map((p) => p.coin)).not.toContain("@166");
    const moved = meta();
    moved.universe.find((u) => u.index === 166)!.name = "@999";
    expect(verifiedStablecoinPairs("mainnet", moved as never).map((p) => p.coin)).not.toContain("@166");
    expect(verifiedStablecoinPairs("mainnet", null)).toEqual([]);
    expect(verifiedStablecoinPairs("mainnet", { universe: "x", tokens: [] } as never)).toEqual([]);
  });
});
