/**
 * Pre-trade risk assessment (the co-pilot numbers of FRONTEND_SPEC §9.8). Deterministic: the same input always yields
 * the same numbers and warnings, so frontend, signer frame and backend agree.
 *
 * @module
 */
import { MIN_ORDER_NOTIONAL_USD } from "../precision/index.js";
import {
  type BookLevel,
  estimateFees,
  estimateMarketImpact,
  type FeeBreakdown,
  type FundingCost,
  fundingCost,
  liquidationDistancePct,
  liquidationPrice,
  type MarketImpact,
  maxLossAtStop,
  type PositionSide,
  sideSign,
  type StopLossEstimate,
  visibleDepthUsd,
} from "./formulas.js";
import { type MarginTier, maintenanceMargin, maxLeverageForNotional, singleTier } from "./margin.js";

/** Order types understood by the assessment (same names as `OrderIntent.orderType`). */
export type RiskOrderType = "market" | "limit" | "stopMarket" | "stopLimit" | "takeProfitMarket" | "takeProfitLimit";

/** Tunable warning thresholds. All optional; defaults in {@link DEFAULT_RISK_THRESHOLDS}. */
export interface RiskThresholds {
  /** Warn when leverage ≥ this. */
  highLeverage: number;
  /** Warn when the order notional exceeds this % of visible depth within `thinBookWithinPct` of mid. */
  thinBookPctOfDepth: number;
  /** Depth window around mid, in percent. */
  thinBookWithinPct: number;
  /** Warn when the position would pay funding at |hourly rate| ≥ this (fraction; 0.0001 = 0.01%/h ≈ 88% APR). */
  extremeFundingHourlyRate: number;
  /** Warn when a limit price is further than this % from mark. */
  priceBandPct: number;
  /** Slippage allowance (percent) applied to market stops in the max-loss estimate (capped at HL's 10%). */
  stopSlippageAllowancePct: number;
  /** Warn when the loss at the stop exceeds this % of equity. */
  maxLossPctOfEquity: number;
  /** Warn when the liquidation price is within this % of the mark price. */
  liquidationNearPct: number;
}

/** Default thresholds. Product can tune these; they are not exchange rules. */
export const DEFAULT_RISK_THRESHOLDS: Readonly<RiskThresholds> = Object.freeze({
  highLeverage: 10,
  thinBookPctOfDepth: 25,
  thinBookWithinPct: 1,
  extremeFundingHourlyRate: 0.0001,
  priceBandPct: 5,
  stopSlippageAllowancePct: 0.5,
  maxLossPctOfEquity: 10,
  liquidationNearPct: 5,
});

/** Input for {@link assessOrderRisk}. Prices and sizes are plain numbers (convert HL strings first). */
export interface OrderRiskInput {
  market: {
    coin: string;
    maxLeverage: number;
    /** Margin tiers; default: a single tier at `maxLeverage`. */
    marginTiers?: ReadonlyArray<MarginTier>;
    /** True for isolated-only markets (`strictIsolated` / `noCross`). */
    onlyIsolated?: boolean;
  };
  side: "buy" | "sell";
  /** Order size in coin units (> 0). */
  size: number;
  orderType: RiskOrderType;
  /**
   * Expected average fill price. Defaults: limit orders → `limitPrice`; market orders → book walk average when
   * `book` is given, otherwise `markPrice`; trigger orders → `limitPrice` or `triggerPrice`.
   */
  expectedFillPrice?: number;
  limitPrice?: number;
  triggerPrice?: number;
  markPrice: number;
  /** Oracle price for funding (defaults to mark). */
  oraclePrice?: number;
  leverage: number;
  marginMode: "cross" | "isolated";
  reduceOnly?: boolean;
  /** Post-only (ALO) orders pay the maker fee. */
  postOnly?: boolean;
  stopLoss?: { triggerPrice: number; orderType?: "market" | "limit" };
  takeProfit?: { triggerPrice: number };
  account: {
    /** Account value (cross collateral), USD. */
    equityUsd: number;
    /** Collateral free for new margin. Default: `equityUsd`. */
    availableMarginUsd?: number;
    /** Cross: maintenance margin of positions in other markets (held constant). Default 0. */
    otherPositionsMaintenanceMarginUsd?: number;
    /** Notional of positions in other markets, for effective account leverage. Default 0. */
    otherPositionsNotionalUsd?: number;
  };
  existingPosition?: {
    side: PositionSide;
    size: number;
    entryPrice: number;
    /** Isolated positions: current isolated margin (USD). */
    isolatedMarginUsd?: number;
  };
  fees: {
    /** Effective taker rate (fraction) from `userFees.userCrossRate`, or the HIP-3 market's own rate. */
    takerRate: number;
    /** Effective maker rate (fraction) from `userFees.userAddRate`. */
    makerRate: number;
    builderFeeTenthsBps?: number;
  };
  /** Current hourly funding rate (fraction), e.g. from `activeAssetCtx.funding`. */
  fundingRateHourly?: number;
  /** Book side this order consumes (asks for buys, bids for sells), best first; plus mid. */
  book?: { levels: ReadonlyArray<BookLevel>; midPrice: number };
  /** Pass-through flag: HIP-3 weekend/off-hours pricing. */
  weekendOrOffHoursPricing?: boolean;
  /** Pass-through flag: market is at its open-interest cap (`perpsAtOpenInterestCap`). */
  atOpenInterestCap?: boolean;
  thresholds?: Partial<RiskThresholds>;
}

/** Stable warning codes. */
export type RiskWarningCode =
  | "BELOW_MIN_NOTIONAL"
  | "INSUFFICIENT_MARGIN"
  | "LEVERAGE_ABOVE_MAX"
  | "CROSS_NOT_ALLOWED"
  | "REDUCE_ONLY_WOULD_NOT_REDUCE"
  | "REDUCE_ONLY_EXCEEDS_POSITION"
  | "AT_OPEN_INTEREST_CAP"
  | "STOP_BEYOND_LIQUIDATION"
  | "STOP_WRONG_SIDE"
  | "TAKE_PROFIT_WRONG_SIDE"
  | "NO_STOP_LOSS"
  | "LARGE_LOSS_AT_STOP"
  | "LIQUIDATION_NEAR"
  | "HIGH_LEVERAGE"
  | "THIN_BOOK"
  | "BOOK_TOO_SHALLOW"
  | "EXTREME_FUNDING"
  | "PRICE_FAR_FROM_MARK"
  | "WEEKEND_PRICING"
  | "POSITION_INCREASE"
  | "POSITION_FLIP";

/** A typed warning. `blocking` warnings describe orders the exchange would reject (or must not be sent). */
export interface RiskWarning {
  code: RiskWarningCode;
  severity: "info" | "warning" | "danger";
  blocking: boolean;
  message: string;
  data?: Record<string, number | string | boolean | null>;
}

/** What the order does to the position. `none` when a reduce-only order cannot reduce anything. */
export type ResultingAction = "open" | "increase" | "reduce" | "close" | "flip" | "none";

/** Output of {@link assessOrderRisk}. */
export interface OrderRiskAssessment {
  coin: string;
  expectedFillPrice: number;
  orderNotionalUsd: number;
  /** Additional margin this order uses (0 for reducing orders). */
  marginRequiredUsd: number;
  resultingAction: ResultingAction;
  positionAfter: { side: PositionSide | null; size: number; entryPrice: number | null; notionalUsd: number; pctOfEquity: number | null };
  /** (other notional + position notional after) / equity. */
  effectiveAccountLeverage: number | null;
  liquidationPrice: number | null;
  liquidationDistanceFromEntryPct: number | null;
  liquidationDistanceFromMarkPct: number | null;
  /** Estimate at the stop, or null when no stop is set (then the margin is at risk). */
  stopLoss: (StopLossEstimate & { pctOfEquity: number | null }) | null;
  noStopLoss: boolean;
  fees: { entry: FeeBreakdown; exit: FeeBreakdown; roundTripUsd: number; roundTripBps: number };
  funding: FundingCost | null;
  marketImpact: MarketImpact | null;
  warnings: RiskWarning[];
  /** True if any warning is blocking. */
  blocking: boolean;
}

/**
 * Computes every pre-trade number in FRONTEND_SPEC §9.8 plus a list of typed warnings.
 * Formulas and sources: see `formulas.ts` and `margin.ts`.
 */
export function assessOrderRisk(input: OrderRiskInput): OrderRiskAssessment {
  const th: RiskThresholds = { ...DEFAULT_RISK_THRESHOLDS, ...input.thresholds };
  if (!(input.size > 0)) throw new RangeError("size must be positive");
  if (!(input.markPrice > 0)) throw new RangeError("markPrice must be positive");
  if (!(input.leverage > 0)) throw new RangeError("leverage must be positive");

  const warnings: RiskWarning[] = [];
  const warn = (w: RiskWarning): void => {
    warnings.push(w);
  };
  const tiers = input.market.marginTiers && input.market.marginTiers.length > 0 ? input.market.marginTiers : singleTier(input.market.maxLeverage);
  const isMarket = input.orderType === "market";
  const isTrigger = input.orderType !== "market" && input.orderType !== "limit";
  const orderSign = input.side === "buy" ? 1 : -1;

  // --- Expected fill -----------------------------------------------------------------------
  let marketImpact: MarketImpact | null = null;
  if (input.book) marketImpact = estimateMarketImpact({ levels: input.book.levels, size: input.size, midPrice: input.book.midPrice });
  const expectedFillPrice =
    input.expectedFillPrice ??
    (isMarket
      ? (marketImpact?.avgPrice ?? input.markPrice)
      : isTrigger
        ? (input.limitPrice ?? input.triggerPrice ?? input.markPrice)
        : (input.limitPrice ?? input.markPrice));
  const orderNotionalUsd = input.size * expectedFillPrice;

  // --- Resulting position -------------------------------------------------------------------
  const existing = input.existingPosition && input.existingPosition.size !== 0 ? input.existingPosition : undefined;
  const existingSigned = existing ? sideSign(existing.side) * Math.abs(existing.size) : 0;
  let delta = orderSign * input.size;
  if (input.reduceOnly) {
    const reduces = existingSigned !== 0 && Math.sign(existingSigned) !== Math.sign(delta);
    if (!reduces) {
      warn({
        code: "REDUCE_ONLY_WOULD_NOT_REDUCE",
        severity: "danger",
        blocking: true,
        message: existing ? "Reduce-only order is on the same side as the position, so it would not reduce it." : "Reduce-only order with no open position would not reduce anything.",
      });
      delta = 0;
    } else if (Math.abs(delta) > Math.abs(existingSigned)) {
      warn({
        code: "REDUCE_ONLY_EXCEEDS_POSITION",
        severity: "info",
        blocking: false,
        message: "Reduce-only order is larger than the position; at most the position will be closed.",
        data: { positionSize: Math.abs(existingSigned), orderSize: input.size },
      });
      delta = -existingSigned;
    }
  }
  let newSigned = existingSigned + delta;
  if (Math.abs(newSigned) <= 1e-12 * Math.max(Math.abs(existingSigned), 1)) newSigned = 0;
  const resultingAction: ResultingAction =
    delta === 0
      ? "none"
      : existingSigned === 0
        ? "open"
        : Math.sign(existingSigned) === Math.sign(delta)
          ? "increase"
          : Math.abs(Math.abs(delta) - Math.abs(existingSigned)) <= 1e-12 * Math.abs(existingSigned)
            ? "close"
            : Math.abs(delta) < Math.abs(existingSigned)
              ? "reduce"
              : "flip";

  let newEntry: number | null = null;
  if (newSigned !== 0) {
    if (resultingAction === "increase" && existing) {
      newEntry = (Math.abs(existingSigned) * existing.entryPrice + Math.abs(delta) * expectedFillPrice) / Math.abs(newSigned);
    } else if ((resultingAction === "reduce" || resultingAction === "none") && existing) {
      newEntry = existing.entryPrice;
    } else {
      newEntry = expectedFillPrice; // open or flip
    }
  }
  const newSide: PositionSide | null = newSigned > 0 ? "long" : newSigned < 0 ? "short" : null;
  const newSize = Math.abs(newSigned);
  const positionNotionalAfter = newSize * input.markPrice;
  const equity = input.account.equityUsd;

  // --- Margin --------------------------------------------------------------------------------
  const addedExposure =
    resultingAction === "open" || resultingAction === "increase"
      ? Math.abs(delta)
      : resultingAction === "flip"
        ? newSize
        : 0;
  const marginRequiredUsd = (addedExposure * expectedFillPrice) / input.leverage;
  const available = input.account.availableMarginUsd ?? equity;
  if (marginRequiredUsd > available + 1e-9) {
    warn({
      code: "INSUFFICIENT_MARGIN",
      severity: "danger",
      blocking: true,
      message: `This order needs about $${round2(marginRequiredUsd)} of margin but only $${round2(available)} is available.`,
      data: { requiredUsd: marginRequiredUsd, availableUsd: available },
    });
  }
  if (newSide !== null && addedExposure > 0) {
    const maxLev = maxLeverageForNotional(tiers, newSize * expectedFillPrice);
    if (input.leverage > maxLev) {
      warn({
        code: "LEVERAGE_ABOVE_MAX",
        severity: "danger",
        blocking: true,
        message: `Leverage ${input.leverage}x is above the ${maxLev}x maximum for a position of this size.`,
        data: { leverage: input.leverage, maxLeverage: maxLev },
      });
    }
  }
  if (input.market.onlyIsolated && input.marginMode === "cross" && addedExposure > 0) {
    warn({
      code: "CROSS_NOT_ALLOWED",
      severity: "danger",
      blocking: true,
      message: "This market is isolated-margin only; cross margin is not available.",
    });
  }

  // --- Minimum notional ------------------------------------------------------------------------
  // HL exempts only a reduce-only order that closes the whole position; a reduce-only partial close is rejected.
  if (orderNotionalUsd < MIN_ORDER_NOTIONAL_USD) {
    const closesWholePosition = input.reduceOnly === true && existingSigned !== 0 && Math.sign(existingSigned) !== orderSign && input.size >= Math.abs(existingSigned);
    warn({
      code: "BELOW_MIN_NOTIONAL",
      severity: closesWholePosition ? "info" : "danger",
      blocking: !closesWholePosition,
      message: closesWholePosition
        ? `Order value $${round2(orderNotionalUsd)} is below the $${MIN_ORDER_NOTIONAL_USD} minimum, which Hyperliquid allows for closing a whole position.`
        : `Order value $${round2(orderNotionalUsd)} is below the $${MIN_ORDER_NOTIONAL_USD} minimum${input.reduceOnly ? "; only a close of the whole position may be smaller" : ""}.`,
      data: { notionalUsd: orderNotionalUsd, minNotionalUsd: MIN_ORDER_NOTIONAL_USD, closesWholePosition },
    });
  }

  // --- Fees --------------------------------------------------------------------------------------
  const entryRate = input.postOnly ? input.fees.makerRate : input.fees.takerRate;
  const builderF = input.fees.builderFeeTenthsBps ?? 0;
  const entryFees = estimateFees({ notionalUsd: orderNotionalUsd, hlFeeRate: entryRate, builderFeeTenthsBps: builderF });
  const exitFees = estimateFees({ notionalUsd: orderNotionalUsd, hlFeeRate: input.fees.takerRate, builderFeeTenthsBps: builderF });

  // --- Liquidation -----------------------------------------------------------------------------
  let liq: number | null = null;
  if (newSide !== null && newEntry !== null) {
    if (input.marginMode === "isolated") {
      const existingIso =
        existing && (resultingAction === "increase" || resultingAction === "reduce" || resultingAction === "none")
          ? (existing.isolatedMarginUsd ?? (Math.abs(existingSigned) * existing.entryPrice) / input.leverage)
          : 0;
      const keptFraction = resultingAction === "reduce" && existing ? newSize / Math.abs(existingSigned) : 1;
      const collateral = existingIso * keptFraction + marginRequiredUsd;
      liq = liquidationPrice({ side: newSide, size: newSize, price: newEntry, collateralUsd: collateral, tiers });
    } else {
      // Cross: account value after the fill, measured at mark, less other positions' maintenance margin.
      const fillPnlAtMark = orderSign * Math.abs(delta) * (input.markPrice - expectedFillPrice);
      const collateral = equity - entryFees.totalUsd + fillPnlAtMark;
      liq = liquidationPrice({
        side: newSide,
        size: newSize,
        price: input.markPrice,
        collateralUsd: collateral,
        tiers,
        otherMaintenanceMarginUsd: input.account.otherPositionsMaintenanceMarginUsd ?? 0,
      });
    }
  }
  const liqFromEntry = newEntry !== null ? liquidationDistancePct(liq, newEntry) : null;
  const liqFromMark = liquidationDistancePct(liq, input.markPrice);
  if (liqFromMark !== null && liqFromMark < th.liquidationNearPct) {
    warn({
      code: "LIQUIDATION_NEAR",
      severity: "danger",
      blocking: false,
      message: `Liquidation would be only ${round2(liqFromMark)}% away from the mark price.`,
      data: { liquidationPrice: liq, distancePct: liqFromMark },
    });
  }

  // --- Stop loss / take profit -------------------------------------------------------------
  let stopLoss: OrderRiskAssessment["stopLoss"] = null;
  if (input.stopLoss && newSide !== null && newEntry !== null) {
    const est = maxLossAtStop({
      side: newSide,
      size: newSize,
      entryPrice: newEntry,
      stopPrice: input.stopLoss.triggerPrice,
      stopOrderType: input.stopLoss.orderType ?? "market",
      slippagePct: th.stopSlippageAllowancePct,
      exitFeeRate: input.fees.takerRate,
      builderFeeTenthsBps: builderF,
    });
    stopLoss = { ...est, pctOfEquity: equity > 0 ? (est.totalUsd / equity) * 100 : null };
    if (est.stopOnWrongSide) {
      warn({
        code: "STOP_WRONG_SIDE",
        severity: "danger",
        blocking: false,
        message: `The stop-loss at ${input.stopLoss.triggerPrice} is on the wrong side of the entry (${round6(newEntry)}) for a ${newSide}.`,
      });
    }
    if (liq !== null && (newSide === "long" ? input.stopLoss.triggerPrice <= liq : input.stopLoss.triggerPrice >= liq)) {
      warn({
        code: "STOP_BEYOND_LIQUIDATION",
        severity: "danger",
        blocking: false,
        message: `The stop-loss at ${input.stopLoss.triggerPrice} is beyond the liquidation price (${round6(liq)}), so it would never trigger before liquidation.`,
        data: { stopPrice: input.stopLoss.triggerPrice, liquidationPrice: liq },
      });
    }
    if (stopLoss.pctOfEquity !== null && stopLoss.pctOfEquity > th.maxLossPctOfEquity) {
      warn({
        code: "LARGE_LOSS_AT_STOP",
        severity: "warning",
        blocking: false,
        message: `The loss at the stop would be about ${round2(stopLoss.pctOfEquity)}% of account equity.`,
        data: { lossUsd: est.totalUsd, pctOfEquity: stopLoss.pctOfEquity },
      });
    }
  }
  const noStopLoss = newSide !== null && !input.stopLoss && addedExposure > 0;
  if (noStopLoss) {
    warn({
      code: "NO_STOP_LOSS",
      severity: "info",
      blocking: false,
      message: input.marginMode === "isolated" ? "No stop set: the maximum loss is this position's margin." : "No stop set: with cross margin the loss can reach your account equity.",
    });
  }
  if (input.takeProfit && newSide !== null && newEntry !== null) {
    const wrong = newSide === "long" ? input.takeProfit.triggerPrice <= newEntry : input.takeProfit.triggerPrice >= newEntry;
    if (wrong) {
      warn({
        code: "TAKE_PROFIT_WRONG_SIDE",
        severity: "warning",
        blocking: false,
        message: `The take-profit at ${input.takeProfit.triggerPrice} is on the wrong side of the entry (${round6(newEntry)}) for a ${newSide}.`,
      });
    }
  }

  // --- Leverage, book, funding, price band, pass-through flags --------------------------------
  if (addedExposure > 0 && input.leverage >= th.highLeverage) {
    warn({
      code: "HIGH_LEVERAGE",
      severity: "warning",
      blocking: false,
      message: `High leverage (${input.leverage}x): a ${round2(100 / input.leverage)}% move against you costs the whole initial margin.`,
      data: { leverage: input.leverage },
    });
  }
  if (input.book && isMarket) {
    const depth = visibleDepthUsd({ levels: input.book.levels, midPrice: input.book.midPrice, withinPct: th.thinBookWithinPct });
    const pctOfDepth = depth > 0 ? (orderNotionalUsd / depth) * 100 : Number.POSITIVE_INFINITY;
    if (pctOfDepth > th.thinBookPctOfDepth) {
      warn({
        code: "THIN_BOOK",
        severity: "warning",
        blocking: false,
        message: `This order is ${Number.isFinite(pctOfDepth) ? `${round2(pctOfDepth)}%` : "more than all"} of the visible depth within ${th.thinBookWithinPct}% of mid; expect price impact.`,
        data: { depthUsd: depth, pctOfDepth: Number.isFinite(pctOfDepth) ? pctOfDepth : null },
      });
    }
    if (marketImpact && marketImpact.unfilledSize > 0) {
      warn({
        code: "BOOK_TOO_SHALLOW",
        severity: "warning",
        blocking: false,
        message: "The visible order book is not deep enough to fill this whole order.",
        data: { unfilledSize: marketImpact.unfilledSize },
      });
    }
  }
  let funding: FundingCost | null = null;
  if (input.fundingRateHourly !== undefined && newSide !== null) {
    funding = fundingCost({ side: newSide, size: newSize, oraclePrice: input.oraclePrice ?? input.markPrice, hourlyRate: input.fundingRateHourly });
    if (funding.direction === "pay" && Math.abs(input.fundingRateHourly) >= th.extremeFundingHourlyRate) {
      warn({
        code: "EXTREME_FUNDING",
        severity: "warning",
        blocking: false,
        message: `Funding is ${round4(input.fundingRateHourly * 100)}%/h (about ${round2(funding.annualizedRatePct)}% a year); this position would pay about $${round2(funding.dailyUsd)} a day.`,
        data: { hourlyRate: input.fundingRateHourly, dailyUsd: funding.dailyUsd },
      });
    }
  }
  const pricedOrder = input.orderType === "limit" || input.orderType === "stopLimit" || input.orderType === "takeProfitLimit";
  if (pricedOrder && input.limitPrice !== undefined) {
    const offPct = (Math.abs(input.limitPrice - input.markPrice) / input.markPrice) * 100;
    if (offPct > th.priceBandPct && !isTrigger) {
      warn({
        code: "PRICE_FAR_FROM_MARK",
        severity: "warning",
        blocking: false,
        message: `The limit price is ${round2(offPct)}% from the mark price; the exchange rejects prices too far from the oracle.`,
        data: { offPct },
      });
    }
  }
  if (input.weekendOrOffHoursPricing) {
    warn({
      code: "WEEKEND_PRICING",
      severity: "warning",
      blocking: false,
      message: "The underlying market is closed; prices may gap when it reopens.",
    });
  }
  if (input.atOpenInterestCap && addedExposure > 0) {
    warn({
      code: "AT_OPEN_INTEREST_CAP",
      severity: "danger",
      blocking: true,
      message: "This market is at its open-interest cap and isn't accepting new positions right now.",
    });
  }
  if (resultingAction === "increase") {
    warn({ code: "POSITION_INCREASE", severity: "info", blocking: false, message: "This order increases your existing position." });
  }
  if (resultingAction === "flip") {
    warn({
      code: "POSITION_FLIP",
      severity: "warning",
      blocking: false,
      message: `This order closes your ${existing?.side ?? ""} position and opens a ${newSide ?? ""} one.`.replace(/\s+/g, " "),
    });
  }

  const otherNotional = input.account.otherPositionsNotionalUsd ?? 0;
  return {
    coin: input.market.coin,
    expectedFillPrice,
    orderNotionalUsd,
    marginRequiredUsd,
    resultingAction,
    positionAfter: {
      side: newSide,
      size: newSize,
      entryPrice: newEntry,
      notionalUsd: positionNotionalAfter,
      pctOfEquity: equity > 0 ? (positionNotionalAfter / equity) * 100 : null,
    },
    effectiveAccountLeverage: equity > 0 ? (otherNotional + positionNotionalAfter) / equity : null,
    liquidationPrice: liq,
    liquidationDistanceFromEntryPct: liqFromEntry,
    liquidationDistanceFromMarkPct: liqFromMark,
    stopLoss,
    noStopLoss,
    fees: {
      entry: entryFees,
      exit: exitFees,
      roundTripUsd: entryFees.totalUsd + exitFees.totalUsd,
      roundTripBps: entryFees.totalBps + exitFees.totalBps,
    },
    funding,
    marketImpact,
    warnings,
    blocking: warnings.some((w) => w.blocking),
  };
}

/** Maintenance margin of a position (convenience re-export for callers computing cross collateral). */
export function positionMaintenanceMargin(tiers: ReadonlyArray<MarginTier>, size: number, markPrice: number): number {
  return maintenanceMargin(tiers, Math.abs(size) * markPrice);
}

function round2(x: number): string {
  return (Math.round(x * 100) / 100).toString();
}
function round4(x: number): string {
  return (Math.round(x * 10_000) / 10_000).toString();
}
function round6(x: number): string {
  return Number(x.toPrecision(6)).toString();
}
