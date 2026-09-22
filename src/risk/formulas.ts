/**
 * Pure risk formulas. Naming convention: `…Usd` = USD amounts, `…Rate` = fractions (0.00045 = 4.5 bps),
 * `…Bps` = basis points, `…Pct` = percentages (9.2 = 9.2%).
 *
 * Sources are cited on each function. Spec: FRONTEND_SPEC §23; research A §1.4–1.6.
 *
 * @module
 */
import { type MarginTier, maintenanceSchedule, tierForNotional } from "./margin.js";

/** Position direction. */
export type PositionSide = "long" | "short";

/** `1` for long, `-1` for short (the `side` term in HL's liquidation formula). */
export function sideSign(side: PositionSide): 1 | -1 {
  return side === "long" ? 1 : -1;
}

/** Opposite side. */
export function oppositeSide(side: PositionSide): PositionSide {
  return side === "long" ? "short" : "long";
}

// ---------------------------------------------------------------------------------------------
// Liquidation price
// ---------------------------------------------------------------------------------------------

/**
 * HL's documented liquidation formula, verbatim:
 * `liq_price = price − side × margin_available / position_size / (1 − l × side)`, with `l = 1 / maintenance_leverage`.
 *
 * Source: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/liquidations ("Computing Liquidation Price").
 * `margin_available` is `account_value − maintenance_margin_required` for cross and
 * `isolated_margin − maintenance_margin_required` for isolated, both measured at `price`.
 */
export function liquidationPriceFromMarginAvailable(input: {
  side: PositionSide;
  size: number;
  price: number;
  marginAvailable: number;
  maintenanceLeverage: number;
}): number {
  const s = sideSign(input.side);
  const size = Math.abs(input.size);
  if (!(size > 0)) throw new RangeError("size must be non-zero");
  const l = 1 / input.maintenanceLeverage;
  return input.price - (s * input.marginAvailable) / size / (1 - l * s);
}

/** Input for {@link liquidationPrice}. */
export interface LiquidationInput {
  side: PositionSide;
  /** Position size in coin units (sign ignored). */
  size: number;
  /** Reference price at which `collateralUsd` is measured (entry price for a new position, or current mark). */
  price: number;
  /**
   * Equity backing the position, measured at `price`:
   * - cross: account value (including unrealized PnL of all cross positions at their current prices);
   * - isolated: the position's isolated margin (plus its unrealized PnL at `price`, which is 0 when `price` is the entry).
   */
  collateralUsd: number;
  /** Margin tiers of the market. */
  tiers: ReadonlyArray<MarginTier>;
  /** Cross only: maintenance margin of the other cross positions, held constant. Default 0. */
  otherMaintenanceMarginUsd?: number;
}

/**
 * Tier-aware liquidation price using HL's formula. For each tier the formula is evaluated with that tier's
 * `l` and deduction; the answer is the tier whose notional range contains `size × liq_price`
 * ("maintenance leverage depends on the unique margin tier corresponding to the position value at the
 * liquidation price", HL liquidations docs). Returns `null` when a long cannot be liquidated (liq ≤ 0).
 *
 * If `collateralUsd` already sits below maintenance margin, the returned price is on the wrong side of `price`
 * (the position is liquidatable now).
 */
export function liquidationPrice(input: LiquidationInput): number | null {
  const s = sideSign(input.side);
  const size = Math.abs(input.size);
  if (!(size > 0)) throw new RangeError("size must be non-zero");
  if (!(input.price > 0)) throw new RangeError("price must be positive");
  const schedule = maintenanceSchedule(input.tiers);
  const other = input.otherMaintenanceMarginUsd ?? 0;
  // Exactly one tier is self-consistent (equity − MM is monotonic in price). Floating-point noise can push the answer
  // just outside its tier's range at a boundary, so pick the candidate closest to its own range.
  let best: { liq: number; distance: number } | undefined;
  for (let i = 0; i < schedule.length; i++) {
    const t = schedule[i]!;
    const next = schedule[i + 1];
    const l = t.maintenanceMarginRate;
    // Maintenance margin of this position at `price`, using tier t's line (continuous across tiers).
    const mmAtPrice = size * input.price * l - t.maintenanceDeduction;
    const marginAvailable = input.collateralUsd - other - mmAtPrice;
    const liq = input.price - (s * marginAvailable) / size / (1 - l * s);
    const liqNotional = size * liq;
    const below = t.lowerBound - liqNotional;
    const above = next === undefined ? -Infinity : liqNotional - next.lowerBound;
    const distance = Math.max(below, above, 0);
    if (best === undefined || distance < best.distance) best = { liq, distance };
    if (distance === 0) break;
  }
  // A long whose liquidation price is ≤ 0 cannot be liquidated.
  return best !== undefined && best.liq > 0 ? best.liq : null;
}

/** Percentage distance between a liquidation price and a reference price: `|ref − liq| / ref × 100`. */
export function liquidationDistancePct(liqPrice: number | null, referencePrice: number): number | null {
  if (liqPrice === null || !(referencePrice > 0)) return null;
  return (Math.abs(referencePrice - liqPrice) / referencePrice) * 100;
}

// ---------------------------------------------------------------------------------------------
// PnL
// ---------------------------------------------------------------------------------------------

/**
 * Unrealized PnL: `side × size × (mark − entry)`.
 * Source: FRONTEND_SPEC §23; HL "Entry price and PnL" (https://hyperliquid.gitbook.io/hyperliquid-docs/trading/entry-price-and-pnl).
 */
export function unrealizedPnl(input: { side: PositionSide; size: number; entryPrice: number; markPrice: number }): number {
  return sideSign(input.side) * Math.abs(input.size) * (input.markPrice - input.entryPrice);
}

/**
 * Return on equity in percent: `unrealized PnL ÷ initial margin × 100`, with initial margin = `size × entry / leverage`.
 * Source: FRONTEND_SPEC §23 ("ROE = unrealized PnL ÷ initial margin").
 */
export function roePct(input: { pnlUsd: number; size: number; entryPrice: number; leverage: number }): number {
  const im = (Math.abs(input.size) * input.entryPrice) / input.leverage;
  if (!(im > 0)) throw new RangeError("initial margin must be positive");
  return (input.pnlUsd / im) * 100;
}

// ---------------------------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------------------------

/** Builder fee `f` is in tenths of a basis point: f = 10 → 1 bp. Max 100 on perps (0.1%), 1000 on spot. */
export const MAX_PERP_BUILDER_FEE_TENTHS_BPS = 100;
/** Max builder fee on spot (sell side only). */
export const MAX_SPOT_BUILDER_FEE_TENTHS_BPS = 1000;

/** Converts a builder fee in tenths of a bp to a fraction: `f / 100 000` (f=25 → 0.00025). */
export function builderFeeRate(feeTenthsBps: number): number {
  return feeTenthsBps / 100_000;
}

/**
 * Formats a builder fee in tenths of a bp as the percent string HL's `approveBuilderFee.maxFeeRate` expects,
 * without trailing zeros: 25 → "0.025%", 100 → "0.1%", 10 → "0.01%".
 */
export function tenthsBpsToPercentString(feeTenthsBps: number): string {
  if (!Number.isInteger(feeTenthsBps) || feeTenthsBps < 0) throw new RangeError("fee must be a non-negative integer");
  // percent = f / 1000
  const whole = Math.floor(feeTenthsBps / 1000);
  const frac = String(feeTenthsBps % 1000).padStart(3, "0").replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}%` : `${whole}%`;
}

/** Itemized fee estimate for one fill. */
export interface FeeBreakdown {
  notionalUsd: number;
  /** Hyperliquid fee rate used (fraction). */
  hlFeeRate: number;
  hlFeeUsd: number;
  hlFeeBps: number;
  /** Builder (Kokoah) fee in tenths of a bp, as sent in `builder.f`. */
  builderFeeTenthsBps: number;
  builderFeeUsd: number;
  builderFeeBps: number;
  totalUsd: number;
  totalBps: number;
}

/**
 * Fee estimate itemizing the HL fee and the builder fee.
 * - HL fee = notional × the user's taker or maker rate (from `userFees`, after discounts; HIP-3 growth-mode markets
 *   have their own, lower, rates — pass the market's actual rate).
 * - Builder fee = notional × f / 100 000 (https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes).
 * Source: FRONTEND_SPEC §23 "Fee estimate".
 */
export function estimateFees(input: { notionalUsd: number; hlFeeRate: number; builderFeeTenthsBps?: number }): FeeBreakdown {
  const notionalUsd = Math.abs(input.notionalUsd);
  const f = input.builderFeeTenthsBps ?? 0;
  const hlFeeUsd = notionalUsd * input.hlFeeRate;
  const builderFeeUsd = notionalUsd * builderFeeRate(f);
  const totalUsd = hlFeeUsd + builderFeeUsd;
  return {
    notionalUsd,
    hlFeeRate: input.hlFeeRate,
    hlFeeUsd,
    hlFeeBps: input.hlFeeRate * 10_000,
    builderFeeTenthsBps: f,
    builderFeeUsd,
    builderFeeBps: f / 10,
    totalUsd,
    totalBps: input.hlFeeRate * 10_000 + f / 10,
  };
}

// ---------------------------------------------------------------------------------------------
// Funding
// ---------------------------------------------------------------------------------------------

/** Funding cost estimate for a position. Positive USD values are paid by the user, negative are received. */
export interface FundingCost {
  /** USD per hour; positive = you pay, negative = you receive. */
  hourlyUsd: number;
  /** USD per day (24 hourly payments at the current rate). */
  dailyUsd: number;
  /** Hourly rate as given (fraction). */
  hourlyRate: number;
  /** Annualized rate in percent: hourly × 24 × 365 × 100. */
  annualizedRatePct: number;
  direction: "pay" | "receive" | "none";
}

/**
 * Funding per hour = `size × oracle price × hourly funding rate`. A positive rate means longs pay shorts.
 * Sources: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding (paid hourly, computed on the oracle
 * price, not mark); FRONTEND_SPEC §23.
 */
export function fundingCost(input: { side: PositionSide; size: number; oraclePrice: number; hourlyRate: number }): FundingCost {
  const hourlyUsd = sideSign(input.side) * Math.abs(input.size) * input.oraclePrice * input.hourlyRate;
  return {
    hourlyUsd,
    dailyUsd: hourlyUsd * 24,
    hourlyRate: input.hourlyRate,
    annualizedRatePct: input.hourlyRate * 24 * 365 * 100,
    direction: hourlyUsd > 0 ? "pay" : hourlyUsd < 0 ? "receive" : "none",
  };
}

// ---------------------------------------------------------------------------------------------
// Stops and R-multiples
// ---------------------------------------------------------------------------------------------

/** HL applies up to 10% slippage tolerance to market TP/SL orders. */
export const MARKET_TRIGGER_MAX_SLIPPAGE_PCT = 10;

/** Result of {@link maxLossAtStop}. */
export interface StopLossEstimate {
  /** Assumed worst exit price (stop price adjusted by the slippage allowance for market stops). */
  exitPrice: number;
  /** `side × size × (entry − stop)`: the loss from price movement to the stop, before slippage and fees. */
  priceLossUsd: number;
  /** Extra loss from the slippage allowance (market stops only). */
  slippageUsd: number;
  /** Estimated exit fee (HL + builder) on the exit notional. */
  exitFeeUsd: number;
  /** priceLoss + slippage + exit fee. */
  totalUsd: number;
  /** True when the stop is not on the losing side of entry (long: stop ≥ entry; short: stop ≤ entry). */
  stopOnWrongSide: boolean;
}

/**
 * Max loss at stop ≈ `size × |entry − stop|` + estimated exit fee (+ slippage allowance for market stops, capped at
 * HL's 10% market TP/SL tolerance). Source: FRONTEND_SPEC §23; HL TP/SL docs (10% slippage for market TP/SL).
 */
export function maxLossAtStop(input: {
  side: PositionSide;
  size: number;
  entryPrice: number;
  stopPrice: number;
  stopOrderType?: "market" | "limit";
  /** Slippage allowance for market stops, in percent (0–10). Default 0. Ignored for limit stops. */
  slippagePct?: number;
  /** Taker fee rate for the exit (fraction). Default 0. */
  exitFeeRate?: number;
  builderFeeTenthsBps?: number;
}): StopLossEstimate {
  const s = sideSign(input.side);
  const size = Math.abs(input.size);
  const slipPct =
    (input.stopOrderType ?? "market") === "market"
      ? Math.min(Math.max(input.slippagePct ?? 0, 0), MARKET_TRIGGER_MAX_SLIPPAGE_PCT)
      : 0;
  const exitPrice = input.stopPrice * (1 - (s * slipPct) / 100);
  const priceLossUsd = s * size * (input.entryPrice - input.stopPrice);
  const slippageUsd = s * size * (input.stopPrice - exitPrice);
  const exitFeeUsd = estimateFees({
    notionalUsd: size * exitPrice,
    hlFeeRate: input.exitFeeRate ?? 0,
    builderFeeTenthsBps: input.builderFeeTenthsBps ?? 0,
  }).totalUsd;
  return {
    exitPrice,
    priceLossUsd,
    slippageUsd,
    exitFeeUsd,
    totalUsd: priceLossUsd + slippageUsd + exitFeeUsd,
    stopOnWrongSide: s * (input.entryPrice - input.stopPrice) <= 0,
  };
}

/**
 * R-multiple = realized PnL ÷ initial risk, where initial risk = `|entry − stop| × size`.
 * Returns null when the initial risk is zero. Source: FRONTEND_SPEC §23.
 */
export function rMultiple(input: { pnlUsd: number; entryPrice: number; stopPrice: number; size: number }): number | null {
  const risk = Math.abs(input.entryPrice - input.stopPrice) * Math.abs(input.size);
  return risk > 0 ? input.pnlUsd / risk : null;
}

// ---------------------------------------------------------------------------------------------
// Order book
// ---------------------------------------------------------------------------------------------

/** One book level (HL `l2Book` levels are `{px, sz, n}` strings; convert to numbers first). */
export interface BookLevel {
  px: number;
  sz: number;
}

/** Result of {@link estimateMarketImpact}. */
export interface MarketImpact {
  filledSize: number;
  unfilledSize: number;
  /** Volume-weighted average fill price, or null when nothing fills. */
  avgPrice: number | null;
  /** Price of the last level touched. */
  worstPrice: number | null;
  /** Average price vs reference (mid, or the best level when no mid) in percent, always ≥ 0. */
  impactPct: number | null;
  notionalUsd: number;
}

/**
 * Walks the book to estimate the average fill of a market order. `levels` is the side the order consumes
 * (asks for a buy, bids for a sell), best price first. HL returns at most 20 levels per side, so a large order may
 * show `unfilledSize > 0` even when deeper liquidity exists.
 */
export function estimateMarketImpact(input: { levels: ReadonlyArray<BookLevel>; size: number; midPrice?: number }): MarketImpact {
  let remaining = Math.abs(input.size);
  let filled = 0;
  let cost = 0;
  let worst: number | null = null;
  for (const lvl of input.levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lvl.sz);
    if (take <= 0) continue;
    filled += take;
    cost += take * lvl.px;
    remaining -= take;
    worst = lvl.px;
  }
  const avgPrice = filled > 0 ? cost / filled : null;
  const ref = input.midPrice ?? input.levels[0]?.px;
  const impactPct = avgPrice !== null && ref !== undefined && ref > 0 ? (Math.abs(avgPrice - ref) / ref) * 100 : null;
  return { filledSize: filled, unfilledSize: Math.max(remaining, 0), avgPrice, worstPrice: worst, impactPct, notionalUsd: cost };
}

/** Visible depth in USD within ±`withinPct` of the mid price on the given side. */
export function visibleDepthUsd(input: { levels: ReadonlyArray<BookLevel>; midPrice: number; withinPct: number }): number {
  const lo = input.midPrice * (1 - input.withinPct / 100);
  const hi = input.midPrice * (1 + input.withinPct / 100);
  let total = 0;
  for (const l of input.levels) if (l.px >= lo && l.px <= hi) total += l.px * l.sz;
  return total;
}

// ---------------------------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------------------------

/** Maximum leverage allowed at a notional given the tiers (re-exported convenience). */
export function maxLeverageAt(tiers: ReadonlyArray<MarginTier>, notionalUsd: number): number {
  return tierForNotional(tiers, notionalUsd).maxLeverage;
}
