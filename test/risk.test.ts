import { describe, expect, it } from "vitest";
import {
  activeBuilderFeePromo,
  assessOrderRisk,
  builderFeeAt,
  builderFeeRate,
  builderFeeScheduleProblem,
  estimateFees,
  estimateMarketImpact,
  fundingCost,
  initialMargin,
  liquidationDistancePct,
  liquidationPrice,
  liquidationPriceFromMarginAvailable,
  maintenanceMargin,
  minStopDistancePct,
  maintenanceMarginRate,
  maintenanceSchedule,
  marginTiersFromTable,
  maxLeverageForNotional,
  maxLossAtStop,
  notional,
  type OrderRiskInput,
  resolveMarginTiers,
  rMultiple,
  roePct,
  singleTier,
  tenthsBpsToPercentString,
  tierForNotional,
  unrealizedPnl,
  visibleDepthUsd,
  type MarginTier,
} from "../src/risk/index.js";
import { fixture, mainnetRegistry, prng } from "./helpers.js";

const BTC_TIERS: MarginTier[] = [
  { lowerBound: 0, maxLeverage: 40 },
  { lowerBound: 150_000_000, maxLeverage: 20 },
];

describe("margin tiers (HL margin-tiers docs)", () => {
  it("derives maintenance rate = IM rate at max leverage / 2 and a continuous deduction", () => {
    const s = maintenanceSchedule(BTC_TIERS);
    expect(s[0]).toMatchObject({ maintenanceMarginRate: 1 / 80, maintenanceDeduction: 0, maintenanceLeverage: 80 });
    expect(s[1]!.maintenanceMarginRate).toBeCloseTo(0.025, 12);
    expect(s[1]!.maintenanceDeduction).toBeCloseTo(150_000_000 * (0.025 - 0.0125), 6); // 1,875,000
    // Continuity at the boundary.
    const below = maintenanceMargin(BTC_TIERS, 150_000_000 - 1e-6);
    const at = maintenanceMargin(BTC_TIERS, 150_000_000);
    expect(at).toBeCloseTo(below, 3);
    expect(maintenanceMargin(BTC_TIERS, 100_000)).toBeCloseTo(1250, 9);
    expect(maintenanceMarginRate(BTC_TIERS, 200_000_000)).toBeCloseTo(0.025, 12);
    expect(maxLeverageForNotional(BTC_TIERS, 200_000_000)).toBe(20);
    expect(tierForNotional(BTC_TIERS, 1).maxLeverage).toBe(40);
  });

  it("matches the documented range 1.25% (40x) to 16.7% (3x)", () => {
    expect(maintenanceMarginRate(singleTier(40))).toBeCloseTo(0.0125, 12);
    expect(maintenanceMarginRate(singleTier(3))).toBeCloseTo(1 / 6, 12);
  });

  it("handles three-tier testnet tables and implicit ids < 50", () => {
    const meta = fixture<{ marginTables: Array<[number, { marginTiers: Array<{ lowerBound: string; maxLeverage: number }> }]> }>("testnet-meta.json");
    const tiers = resolveMarginTiers(53, meta.marginTables);
    expect(tiers).toEqual([
      { lowerBound: 0, maxLeverage: 25 },
      { lowerBound: 20000, maxLeverage: 10 },
      { lowerBound: 50000, maxLeverage: 5 },
    ]);
    const s = maintenanceSchedule(tiers);
    // d1 = 20000*(0.05-0.02) = 600; d2 = 600 + 50000*(0.1-0.05) = 3100
    expect(s[1]!.maintenanceDeduction).toBeCloseTo(600, 9);
    expect(s[2]!.maintenanceDeduction).toBeCloseTo(3100, 9);
    expect(resolveMarginTiers(20, [])).toEqual([{ lowerBound: 0, maxLeverage: 20 }]);
    expect(resolveMarginTiers(999, [], 7)).toEqual([{ lowerBound: 0, maxLeverage: 7 }]);
    expect(() => resolveMarginTiers(999, [])).toThrow(RangeError);
    expect(marginTiersFromTable({ marginTiers: [{ lowerBound: "3000000.0", maxLeverage: 5 }, { lowerBound: "0.0", maxLeverage: 10 }] })[0]!.maxLeverage).toBe(10);
  });

  it("initial margin and notional", () => {
    expect(notional(-2, 100)).toBe(200);
    expect(initialMargin(10_000, 10)).toBe(1000);
    expect(() => initialMargin(1, 0)).toThrow(RangeError);
  });

  it("every market in the fixture has consistent tiers", () => {
    for (const m of mainnetRegistry().list({ includeDelisted: true })) {
      if (m.kind === "spot") continue;
      expect(m.marginTiers[0]!.lowerBound).toBe(0);
      expect(m.marginTiers[0]!.maxLeverage).toBe(m.maxLeverage);
    }
  });
});

describe("liquidation price (HL formula)", () => {
  it("isolated long and short, hand-computed", () => {
    // 1 unit at 100, 10x → 10 USD margin; 20x max → mm rate 2.5%.
    const tiers = singleTier(20);
    const long = liquidationPrice({ side: "long", size: 1, price: 100, collateralUsd: 10, tiers });
    expect(long).toBeCloseTo(90 / 0.975, 9); // 92.3077
    const short = liquidationPrice({ side: "short", size: 1, price: 100, collateralUsd: 10, tiers });
    expect(short).toBeCloseTo(110 / 1.025, 9); // 107.317
    // Literal formula with margin_available = 10 - 2.5.
    expect(liquidationPriceFromMarginAvailable({ side: "long", size: 1, price: 100, marginAvailable: 7.5, maintenanceLeverage: 40 })).toBeCloseTo(long as number, 9);
    expect(liquidationPriceFromMarginAvailable({ side: "short", size: 1, price: 100, marginAvailable: 7.5, maintenanceLeverage: 40 })).toBeCloseTo(short as number, 9);
    expect(liquidationDistancePct(long, 100)).toBeCloseTo(7.6923, 3);
  });

  it("picks the right tier when the answer sits on a tier boundary", () => {
    const tiers: MarginTier[] = [
      { lowerBound: 0, maxLeverage: 25 },
      { lowerBound: 20_000, maxLeverage: 10 },
      { lowerBound: 50_000, maxLeverage: 5 },
    ];
    const input = { side: "short" as const, size: 404.25, price: 50.59, collateralUsd: 31_448.94, tiers };
    const liq = liquidationPrice(input) as number;
    const equity = input.collateralUsd - input.size * (liq - input.price);
    expect(Math.abs(equity - maintenanceMargin(tiers, input.size * liq))).toBeLessThan(1e-6);
    expect(liq).toBeCloseTo(123.69, 1);
  });

  it("returns null when a long cannot be liquidated", () => {
    expect(liquidationPrice({ side: "long", size: 1, price: 100, collateralUsd: 1000, tiers: singleTier(20) })).toBeNull();
    expect(liquidationDistancePct(null, 100)).toBeNull();
  });

  it("cross margin does not depend on the leverage setting (only on collateral)", () => {
    const a = liquidationPrice({ side: "long", size: 2, price: 50_000, collateralUsd: 20_000, tiers: BTC_TIERS });
    const b = liquidationPrice({ side: "long", size: 2, price: 50_000, collateralUsd: 20_000, tiers: BTC_TIERS });
    expect(a).toBe(b);
    // other positions' maintenance margin reduces the buffer
    const c = liquidationPrice({ side: "long", size: 2, price: 50_000, collateralUsd: 20_000, tiers: BTC_TIERS, otherMaintenanceMarginUsd: 5_000 });
    expect(c as number).toBeGreaterThan(a as number);
  });

  it("picks the tier that applies at the liquidation price and satisfies equity = maintenance margin (randomized)", () => {
    const rnd = prng(7);
    const tiers: MarginTier[] = [
      { lowerBound: 0, maxLeverage: 25 },
      { lowerBound: 20_000, maxLeverage: 10 },
      { lowerBound: 50_000, maxLeverage: 5 },
    ];
    for (let i = 0; i < 2000; i++) {
      const side = rnd() < 0.5 ? "long" : "short";
      const size = 0.01 + rnd() * 50;
      const price = 10 + rnd() * 3000;
      const collateral = (size * price) * (0.02 + rnd() * 0.6);
      const other = rnd() < 0.3 ? rnd() * collateral * 0.2 : 0;
      const liq = liquidationPrice({ side, size, price, collateralUsd: collateral, tiers, otherMaintenanceMarginUsd: other });
      if (liq === null) continue;
      const s = side === "long" ? 1 : -1;
      const equityAtLiq = collateral + s * size * (liq - price);
      const mmAtLiq = other + maintenanceMargin(tiers, size * liq);
      expect(Math.abs(equityAtLiq - mmAtLiq)).toBeLessThan(1e-6 * Math.max(1, size * price));
    }
  });
});

describe("PnL, ROE, fees, funding, stops", () => {
  it("unrealized PnL and ROE", () => {
    expect(unrealizedPnl({ side: "long", size: 2, entryPrice: 100, markPrice: 110 })).toBe(20);
    expect(unrealizedPnl({ side: "short", size: 2, entryPrice: 100, markPrice: 110 })).toBe(-20);
    expect(roePct({ pnlUsd: 20, size: 2, entryPrice: 100, leverage: 10 })).toBeCloseTo(100, 9);
    expect(() => roePct({ pnlUsd: 1, size: 0, entryPrice: 100, leverage: 10 })).toThrow(RangeError);
  });

  it("itemizes HL and builder fees", () => {
    const f = estimateFees({ notionalUsd: 10_000, hlFeeRate: 0.00045, builderFeeTenthsBps: 25 });
    expect(f.hlFeeUsd).toBeCloseTo(4.5, 9);
    expect(f.builderFeeUsd).toBeCloseTo(2.5, 9);
    expect(f.totalUsd).toBeCloseTo(7, 9);
    expect(f.hlFeeBps).toBeCloseTo(4.5, 9);
    expect(f.builderFeeBps).toBe(2.5);
    expect(f.totalBps).toBeCloseTo(7, 9);
    expect(builderFeeRate(10)).toBeCloseTo(0.0001, 12);
  });

  it.each([
    [100, "0.1%"],
    [25, "0.025%"],
    [10, "0.01%"],
    [5, "0.005%"],
    [1, "0.001%"],
    [0, "0%"],
    [1000, "1%"],
    [1250, "1.25%"],
  ])("tenthsBpsToPercentString(%i) = %s", (f, s) => {
    expect(tenthsBpsToPercentString(f)).toBe(s);
  });

  it("charges a promotion's builder fee until it ends, then the standard fee", () => {
    const until = Date.UTC(2026, 11, 1);
    const schedule = { feeTenthsBps: 25, promo: { feeTenthsBps: 0, until } };
    expect(builderFeeAt(schedule, until - 1)).toBe(0);
    expect(activeBuilderFeePromo(schedule, until - 1)).toEqual({ feeTenthsBps: 0, until });
    expect(builderFeeAt(schedule, until)).toBe(25);
    expect(activeBuilderFeePromo(schedule, until)).toBeNull();
    expect(builderFeeAt({ feeTenthsBps: 25 }, until - 1)).toBe(25);
    expect(builderFeeAt({ feeTenthsBps: 25, promo: null })).toBe(25);
    expect(builderFeeScheduleProblem(schedule)).toBeNull();
    expect(builderFeeScheduleProblem({ feeTenthsBps: 25, promo: { feeTenthsBps: 30, until } })).toMatch(/must not exceed/);
    expect(builderFeeScheduleProblem({ feeTenthsBps: 101 })).toMatch(/0 to 100/);
    expect(builderFeeScheduleProblem({ feeTenthsBps: 25, promo: { feeTenthsBps: 0, until: Number.NaN } })).toMatch(/time/);
  });

  it("funding: positive rate means longs pay", () => {
    const long = fundingCost({ side: "long", size: 2, oraclePrice: 100, hourlyRate: 0.0001 });
    expect(long.hourlyUsd).toBeCloseTo(0.02, 12);
    expect(long.dailyUsd).toBeCloseTo(0.48, 12);
    expect(long.direction).toBe("pay");
    expect(long.annualizedRatePct).toBeCloseTo(87.6, 9);
    const short = fundingCost({ side: "short", size: 2, oraclePrice: 100, hourlyRate: 0.0001 });
    expect(short.hourlyUsd).toBeCloseTo(-0.02, 12);
    expect(short.direction).toBe("receive");
    expect(fundingCost({ side: "short", size: 2, oraclePrice: 100, hourlyRate: -0.0001 }).direction).toBe("pay");
    expect(fundingCost({ side: "long", size: 2, oraclePrice: 100, hourlyRate: 0 }).direction).toBe("none");
  });

  it("max loss at stop includes slippage (market stops, capped at 10%) and exit fees", () => {
    const e = maxLossAtStop({ side: "long", size: 1, entryPrice: 100, stopPrice: 95, stopOrderType: "market", slippagePct: 1, exitFeeRate: 0.00045 });
    expect(e.exitPrice).toBeCloseTo(94.05, 9);
    expect(e.priceLossUsd).toBeCloseTo(5, 9);
    expect(e.slippageUsd).toBeCloseTo(0.95, 9);
    expect(e.exitFeeUsd).toBeCloseTo(94.05 * 0.00045, 9);
    expect(e.totalUsd).toBeCloseTo(5 + 0.95 + 94.05 * 0.00045, 9);
    expect(e.stopOnWrongSide).toBe(false);
    const capped = maxLossAtStop({ side: "short", size: 1, entryPrice: 100, stopPrice: 110, slippagePct: 50 });
    expect(capped.exitPrice).toBeCloseTo(121, 9); // 10% cap
    const limit = maxLossAtStop({ side: "long", size: 1, entryPrice: 100, stopPrice: 95, stopOrderType: "limit", slippagePct: 5 });
    expect(limit.slippageUsd).toBe(0);
    expect(maxLossAtStop({ side: "long", size: 1, entryPrice: 100, stopPrice: 101 }).stopOnWrongSide).toBe(true);
  });

  it("R-multiple", () => {
    expect(rMultiple({ pnlUsd: 10, entryPrice: 100, stopPrice: 95, size: 1 })).toBe(2);
    expect(rMultiple({ pnlUsd: -5, entryPrice: 100, stopPrice: 95, size: 1 })).toBe(-1);
    expect(rMultiple({ pnlUsd: 10, entryPrice: 100, stopPrice: 100, size: 1 })).toBeNull();
  });

  it("book impact and depth", () => {
    const asks = [
      { px: 100, sz: 1 },
      { px: 101, sz: 1 },
      { px: 102, sz: 5 },
    ];
    const i = estimateMarketImpact({ levels: asks, size: 2.5, midPrice: 99.5 });
    expect(i.avgPrice).toBeCloseTo(252 / 2.5, 9);
    expect(i.worstPrice).toBe(102);
    expect(i.unfilledSize).toBe(0);
    expect(i.impactPct).toBeCloseTo(((100.8 - 99.5) / 99.5) * 100, 9);
    expect(estimateMarketImpact({ levels: asks, size: 10 }).unfilledSize).toBeCloseTo(3, 12);
    expect(estimateMarketImpact({ levels: [], size: 1 }).avgPrice).toBeNull();
    expect(visibleDepthUsd({ levels: asks, midPrice: 100, withinPct: 1 })).toBeCloseTo(100 + 101, 9);
  });
});

describe("assessOrderRisk", () => {
  const base: OrderRiskInput = {
    market: { coin: "BTC", maxLeverage: 40, marginTiers: BTC_TIERS },
    side: "buy",
    size: 0.1,
    orderType: "market",
    markPrice: 100_000,
    leverage: 5,
    marginMode: "cross",
    account: { equityUsd: 10_000 },
    fees: { takerRate: 0.00045, makerRate: 0.00015, builderFeeTenthsBps: 25 },
    stopLoss: { triggerPrice: 98_000, orderType: "market" },
  };
  const codes = (r: ReturnType<typeof assessOrderRisk>) => r.warnings.map((w) => w.code);

  it("computes the co-pilot numbers for a plain long", () => {
    const r = assessOrderRisk({ ...base, fundingRateHourly: 0.0000125 });
    expect(r.orderNotionalUsd).toBeCloseTo(10_000, 9);
    expect(r.marginRequiredUsd).toBeCloseTo(2_000, 9);
    expect(r.resultingAction).toBe("open");
    expect(r.positionAfter).toMatchObject({ side: "long", size: 0.1, entryPrice: 100_000 });
    expect(r.positionAfter.pctOfEquity).toBeCloseTo(100, 9);
    expect(r.effectiveAccountLeverage).toBeCloseTo(1, 9);
    expect(r.fees.entry.hlFeeUsd).toBeCloseTo(4.5, 9);
    expect(r.fees.entry.builderFeeUsd).toBeCloseTo(2.5, 9);
    expect(r.fees.roundTripUsd).toBeCloseTo(14, 9);
    expect(r.funding?.hourlyUsd).toBeCloseTo(0.125, 9);
    expect(r.stopLoss?.priceLossUsd).toBeCloseTo(200, 9);
    expect(r.stopLoss?.totalUsd).toBeGreaterThan(200);
    // Cross liquidation: equity after entry fee, at mark, 1.25% maintenance.
    const expectedLiq = (100_000 - (10_000 - 7) / 0.1) / (1 - 0.0125);
    expect(r.liquidationPrice).toBeCloseTo(expectedLiq, 6);
    expect(r.liquidationDistanceFromMarkPct).toBeCloseTo(((100_000 - expectedLiq) / 100_000) * 100, 6);
    expect(r.blocking).toBe(false);
    expect(codes(r)).toEqual([]);
  });

  it("isolated liquidation matches the hand-computed value", () => {
    const r = assessOrderRisk({
      ...base,
      market: { coin: "X", maxLeverage: 20 },
      size: 1,
      orderType: "limit",
      limitPrice: 100,
      markPrice: 100,
      leverage: 10,
      marginMode: "isolated",
      stopLoss: undefined,
    });
    expect(r.marginRequiredUsd).toBeCloseTo(10, 9);
    expect(r.liquidationPrice).toBeCloseTo(90 / 0.975, 9);
    expect(codes(r)).toEqual(expect.arrayContaining(["HIGH_LEVERAGE", "NO_STOP_LOSS"]));
    expect(r.noStopLoss).toBe(true);
    expect(r.stopLoss).toBeNull();
  });

  it("flags a stop beyond liquidation", () => {
    const r = assessOrderRisk({ ...base, leverage: 20, marginMode: "isolated", stopLoss: { triggerPrice: 90_000 } });
    expect(r.liquidationPrice as number).toBeGreaterThan(90_000);
    expect(codes(r)).toContain("STOP_BEYOND_LIQUIDATION");
    expect(codes(r)).toContain("HIGH_LEVERAGE");
  });

  it("flags stops and take-profits on the wrong side", () => {
    const r = assessOrderRisk({ ...base, stopLoss: { triggerPrice: 101_000 }, takeProfit: { triggerPrice: 99_000 } });
    expect(codes(r)).toEqual(expect.arrayContaining(["STOP_WRONG_SIDE", "TAKE_PROFIT_WRONG_SIDE"]));
  });

  it("blocks orders below the $10 minimum, except a reduce-only close of the whole position", () => {
    const r = assessOrderRisk({ ...base, size: 0.00005 });
    expect(codes(r)).toContain("BELOW_MIN_NOTIONAL");
    expect(r.blocking).toBe(true);
    // Reduce-only partial close below $10: Hyperliquid rejects it (seen on testnet), so it blocks.
    const partial = assessOrderRisk({ ...base, side: "sell", size: 0.00005, reduceOnly: true, stopLoss: undefined, existingPosition: { side: "long", size: 0.0001, entryPrice: 90_000 } });
    expect(partial.warnings.find((w) => w.code === "BELOW_MIN_NOTIONAL")?.blocking).toBe(true);
    // Closing the whole (small) position is exempt.
    const full = assessOrderRisk({ ...base, side: "sell", size: 0.00008, reduceOnly: true, stopLoss: undefined, existingPosition: { side: "long", size: 0.00008, entryPrice: 90_000 } });
    expect(full.warnings.find((w) => w.code === "BELOW_MIN_NOTIONAL")).toMatchObject({ blocking: false, severity: "info" });
    expect(full.blocking).toBe(false);
  });

  it("warns about a thin book and a shallow book for market orders", () => {
    const r = assessOrderRisk({
      ...base,
      size: 1,
      book: {
        midPrice: 100_000,
        levels: [
          { px: 100_001, sz: 0.2 },
          { px: 100_500, sz: 0.3 },
          { px: 103_000, sz: 0.2 },
        ],
      },
      account: { equityUsd: 1_000_000 },
    });
    expect(codes(r)).toEqual(expect.arrayContaining(["THIN_BOOK", "BOOK_TOO_SHALLOW"]));
    expect(r.marketImpact?.filledSize).toBeCloseTo(0.7, 12);
    expect(r.expectedFillPrice).toBeGreaterThan(100_000);
  });

  it("warns about extreme funding only when paying", () => {
    expect(codes(assessOrderRisk({ ...base, fundingRateHourly: 0.0005 }))).toContain("EXTREME_FUNDING");
    expect(codes(assessOrderRisk({ ...base, side: "sell", stopLoss: undefined, fundingRateHourly: 0.0005 }))).not.toContain("EXTREME_FUNDING");
  });

  it("reduce-only that would not reduce is blocking", () => {
    const r = assessOrderRisk({ ...base, reduceOnly: true });
    expect(codes(r)).toContain("REDUCE_ONLY_WOULD_NOT_REDUCE");
    expect(r.resultingAction).toBe("none");
    expect(r.blocking).toBe(true);
    const same = assessOrderRisk({ ...base, reduceOnly: true, existingPosition: { side: "long", size: 1, entryPrice: 90_000 } });
    expect(codes(same)).toContain("REDUCE_ONLY_WOULD_NOT_REDUCE");
  });

  it("keeps the existing isolated margin when a reduce-only order cannot reduce", () => {
    const r = assessOrderRisk({ ...base, marginMode: "isolated", reduceOnly: true, existingPosition: { side: "long", size: 0.1, entryPrice: 100_000, isolatedMarginUsd: 2_000 } });
    expect(r.resultingAction).toBe("none");
    const expected = liquidationPrice({ side: "long", size: 0.1, price: 100_000, collateralUsd: 2_000, tiers: BTC_TIERS });
    expect(r.liquidationPrice).toBeCloseTo(expected as number, 9);
  });

  it("reduce-only larger than the position closes it", () => {
    const r = assessOrderRisk({ ...base, side: "sell", size: 2, reduceOnly: true, stopLoss: undefined, existingPosition: { side: "long", size: 1, entryPrice: 90_000 } });
    expect(r.resultingAction).toBe("close");
    expect(r.positionAfter.side).toBeNull();
    expect(codes(r)).toContain("REDUCE_ONLY_EXCEEDS_POSITION");
    expect(r.marginRequiredUsd).toBe(0);
  });

  it("insufficient margin, leverage above max, cross on isolated-only, OI cap, weekend pass-through", () => {
    expect(codes(assessOrderRisk({ ...base, account: { equityUsd: 10_000, availableMarginUsd: 100 } }))).toContain("INSUFFICIENT_MARGIN");
    expect(codes(assessOrderRisk({ ...base, leverage: 50 }))).toContain("LEVERAGE_ABOVE_MAX");
    expect(codes(assessOrderRisk({ ...base, market: { ...base.market, onlyIsolated: true } }))).toContain("CROSS_NOT_ALLOWED");
    const oi = assessOrderRisk({ ...base, atOpenInterestCap: true, weekendOrOffHoursPricing: true });
    expect(codes(oi)).toEqual(expect.arrayContaining(["AT_OPEN_INTEREST_CAP", "WEEKEND_PRICING"]));
    expect(oi.blocking).toBe(true);
    const closing = assessOrderRisk({ ...base, side: "sell", reduceOnly: true, stopLoss: undefined, atOpenInterestCap: true, existingPosition: { side: "long", size: 1, entryPrice: 90_000 } });
    expect(codes(closing)).not.toContain("AT_OPEN_INTEREST_CAP");
  });

  it("uses tier max leverage for large positions", () => {
    const r = assessOrderRisk({ ...base, size: 2000, leverage: 30, account: { equityUsd: 1e9 }, stopLoss: undefined });
    expect(r.orderNotionalUsd).toBeCloseTo(2e8, 0);
    expect(codes(r)).toContain("LEVERAGE_ABOVE_MAX"); // 200M notional is in the 20x tier
  });

  it("detects increase and flip", () => {
    const inc = assessOrderRisk({ ...base, orderType: "limit", limitPrice: 110_000, markPrice: 110_000, size: 1, existingPosition: { side: "long", size: 1, entryPrice: 100_000 }, account: { equityUsd: 1e6 } });
    expect(inc.resultingAction).toBe("increase");
    expect(inc.positionAfter.entryPrice).toBeCloseTo(105_000, 9);
    expect(codes(inc)).toContain("POSITION_INCREASE");
    const flip = assessOrderRisk({ ...base, side: "sell", size: 3, stopLoss: undefined, existingPosition: { side: "long", size: 1, entryPrice: 100_000 }, account: { equityUsd: 1e6 } });
    expect(flip.resultingAction).toBe("flip");
    expect(flip.positionAfter).toMatchObject({ side: "short", size: 2 });
    expect(codes(flip)).toContain("POSITION_FLIP");
  });

  it("warns when a limit price is far from mark", () => {
    const r = assessOrderRisk({ ...base, orderType: "limit", limitPrice: 80_000, stopLoss: { triggerPrice: 78_000 } });
    expect(codes(r)).toContain("PRICE_FAR_FROM_MARK");
  });

  it("warns when liquidation is near and when the stop loses a large share of equity", () => {
    const r = assessOrderRisk({ ...base, leverage: 40, marginMode: "isolated", stopLoss: { triggerPrice: 99_000 }, account: { equityUsd: 1000 } });
    expect(codes(r)).toEqual(expect.arrayContaining(["LIQUIDATION_NEAR", "LARGE_LOSS_AT_STOP"]));
  });

  it("validates inputs", () => {
    expect(() => assessOrderRisk({ ...base, size: 0 })).toThrow(RangeError);
    expect(() => assessOrderRisk({ ...base, markPrice: 0 })).toThrow(RangeError);
    expect(() => assessOrderRisk({ ...base, leverage: 0 })).toThrow(RangeError);
  });
});

describe("minStopDistancePct", () => {
  it("is tighter on deeper markets, by Hyperliquid's top leverage", () => {
    expect([50, 40, 25, 20, 10, 5, 3].map(minStopDistancePct)).toEqual([0.1, 0.1, 0.2, 0.2, 0.3, 0.5, 0.5]);
    expect(minStopDistancePct(Number.NaN)).toBe(0.5);
    expect(minStopDistancePct(0)).toBe(0.5);
  });
});
