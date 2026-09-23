/**
 * Hyperliquid price and size precision rules.
 *
 * Source: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size
 * - Prices: at most 5 significant figures and at most `MAX_DECIMALS - szDecimals` decimal places,
 *   where MAX_DECIMALS is 6 for perps (HIP-3 included) and 8 for spot. Integer prices are always allowed.
 * - Sizes: rounded to the asset's `szDecimals`.
 * - Trailing zeros must be removed before signing (signing docs), so every formatter here returns
 *   a normalized string ("1000", never "1000.0").
 * - Minimum order value is $10 for perps (error `MinTradeNtl`). The only exception is a reduce-only order that closes
 *   the entire position (HL docs, error responses; confirmed on testnet: a reduce-only *partial* close worth $8.55 was
 *   rejected).
 *
 * @module
 */
import {
  type Dec,
  decAdd,
  decCompare,
  decDecimals,
  decExponent,
  decIsInteger,
  decMul,
  decRound,
  decSign,
  decSignificantDigits,
  decStep,
  decToNumber,
  decToString,
  parseDec,
  PrecisionError,
  type RoundingDirection,
} from "./decimal.js";

export { PrecisionError, type RoundingDirection };

/** Market kind for the price-decimals rule. HIP-3 markets are perps. */
export type PriceKind = "perp" | "spot";

/** Maximum significant figures for a non-integer price. */
export const MAX_PRICE_SIGNIFICANT_FIGURES = 5;
/** `MAX_DECIMALS` for perps (validator perps and HIP-3). */
export const PERP_MAX_DECIMALS = 6;
/** `MAX_DECIMALS` for spot. */
export const SPOT_MAX_DECIMALS = 8;
/** Minimum order notional in USD for perps (`MinTradeNtl`). Spot uses 10 units of the quote token. */
export const MIN_ORDER_NOTIONAL_USD = 10;

/** Maximum number of price decimals for a market: `max(0, (6 | 8) - szDecimals)`. */
export function maxPriceDecimals(szDecimals: number, kind: PriceKind = "perp"): number {
  assertSzDecimals(szDecimals);
  return Math.max(0, (kind === "spot" ? SPOT_MAX_DECIMALS : PERP_MAX_DECIMALS) - szDecimals);
}

/**
 * Number of decimals a price of this magnitude may carry: the smaller of the market's decimal limit
 * and what 5 significant figures allow (`4 - floor(log10(price))`, never below 0).
 */
export function allowedPriceDecimalsAt(price: number | string, szDecimals: number, kind: PriceKind = "perp"): number {
  const d = parsePositive(price, "price");
  return allowedDecimalsFor(d, szDecimals, kind);
}

function allowedDecimalsFor(d: Dec, szDecimals: number, kind: PriceKind): number {
  const bySigFigs = Math.max(0, MAX_PRICE_SIGNIFICANT_FIGURES - 1 - decExponent(d));
  return Math.min(maxPriceDecimals(szDecimals, kind), bySigFigs);
}

/**
 * Rounds a price to the nearest valid tick in the given direction and returns the wire string.
 *
 * `down` rounds toward zero (lower price), `up` away from zero (higher price), `nearest` half-up.
 * The result always passes {@link isValidPrice}.
 *
 * @throws {PrecisionError} if the input is not a positive finite number or rounds to zero.
 */
export function roundPriceToTick(
  price: number | string,
  szDecimals: number,
  kind: PriceKind = "perp",
  direction: RoundingDirection = "nearest",
): string {
  const d = parsePositive(price, "price");
  const decimals = allowedDecimalsFor(d, szDecimals, kind);
  let rounded = decRound(d, decimals, direction);
  if (decSign(rounded) <= 0) {
    if (direction === "up") rounded = decStep(maxPriceDecimals(szDecimals, kind));
    else throw new PrecisionError(`Price ${String(price)} rounds to zero for szDecimals=${szDecimals} (${kind})`);
  }
  // Rounding up can move into the next power of ten (e.g. 9.99996 -> 10.0000); the result is still valid
  // because it has fewer significant figures. Re-check defensively.
  if (!isValidDec(rounded, szDecimals, kind)) {
    rounded = decRound(rounded, allowedDecimalsFor(rounded, szDecimals, kind), direction);
  }
  return decToString(rounded);
}

/**
 * Formats a price for the wire and for display: nearest valid tick, no trailing zeros.
 *
 * @throws {PrecisionError} if the input is not a positive finite number or rounds to zero.
 */
export function formatPrice(price: number | string, szDecimals: number, kind: PriceKind = "perp"): string {
  return roundPriceToTick(price, szDecimals, kind, "nearest");
}

/** Result of {@link checkPrice}. */
export type PriceCheck =
  | { valid: true; normalized: string }
  | {
      valid: false;
      reason: "not_a_number" | "not_positive" | "too_many_significant_figures" | "too_many_decimals";
      /** Nearest valid price, when one exists. */
      suggestion?: string;
    };

/** Validates a price against the tick rules and explains why it is invalid, with a rounded suggestion. */
export function checkPrice(price: number | string, szDecimals: number, kind: PriceKind = "perp"): PriceCheck {
  let d: Dec;
  try {
    d = parseDec(price);
  } catch {
    return { valid: false, reason: "not_a_number" };
  }
  if (decSign(d) <= 0) return { valid: false, reason: "not_positive" };
  if (isValidDec(d, szDecimals, kind)) return { valid: true, normalized: decToString(d) };
  const reason = decDecimals(d) > maxPriceDecimals(szDecimals, kind) ? "too_many_decimals" : "too_many_significant_figures";
  let suggestion: string | undefined;
  try {
    suggestion = roundPriceToTick(decToString(d), szDecimals, kind, "nearest");
  } catch {
    suggestion = undefined;
  }
  return suggestion === undefined ? { valid: false, reason } : { valid: false, reason, suggestion };
}

/** True if the price is positive and satisfies the 5-significant-figure and decimals rules (integers always pass). */
export function isValidPrice(price: number | string, szDecimals: number, kind: PriceKind = "perp"): boolean {
  return checkPrice(price, szDecimals, kind).valid;
}

/** The price step (tick) at the given price level, e.g. "0.1" for BTC-like prices around 1234.5. */
export function priceTickAt(price: number | string, szDecimals: number, kind: PriceKind = "perp"): string {
  const d = parsePositive(price, "price");
  return decToString(decStep(allowedDecimalsFor(d, szDecimals, kind)));
}

/**
 * Rounds a size to `szDecimals` and returns the wire string. Default direction is `down` (toward zero),
 * so a rounded size never exceeds what the user asked for. May return "0" when the size is smaller than one lot.
 *
 * @throws {PrecisionError} if the input is not a finite number.
 */
export function formatSize(size: number | string, szDecimals: number, direction: RoundingDirection = "down"): string {
  assertSzDecimals(szDecimals);
  return decToString(decRound(parseDec(size), szDecimals, direction));
}

/** True if the size is positive and has at most `szDecimals` decimals. */
export function isValidSize(size: number | string, szDecimals: number): boolean {
  assertSzDecimals(szDecimals);
  try {
    const d = parseDec(size);
    return decSign(d) > 0 && decDecimals(d) <= szDecimals;
  } catch {
    return false;
  }
}

/** One lot (the smallest size step) for a market: `10^-szDecimals`. */
export function sizeStep(szDecimals: number): string {
  assertSzDecimals(szDecimals);
  return decToString(decStep(szDecimals));
}

/** Result of {@link validateOrderNotional}. */
export interface NotionalCheck {
  ok: boolean;
  /** size × price in USD (quote units). */
  notionalUsd: number;
  minNotionalUsd: number;
  /** How much notional is missing to reach the minimum (0 when ok). */
  shortfallUsd: number;
}

/**
 * Checks that `size × price` meets the exchange minimum ($10 for perps; `MinTradeNtl`).
 * The multiplication is exact on the decimal strings before converting to a number.
 */
export function validateOrderNotional(
  size: number | string,
  price: number | string,
  minNotionalUsd: number = MIN_ORDER_NOTIONAL_USD,
): NotionalCheck {
  const notional = decMul(absDec(parseDec(size)), absDec(parseDec(price)));
  const min = parseDec(minNotionalUsd);
  const ok = decCompare(notional, min) >= 0;
  const notionalUsd = decToNumber(notional);
  return { ok, notionalUsd, minNotionalUsd, shortfallUsd: ok ? 0 : minNotionalUsd - notionalUsd };
}

/**
 * Smallest size (at `szDecimals`) whose value at `price` reaches `minNotionalUsd`.
 *
 * @throws {PrecisionError} on malformed input.
 */
export function minOrderSize(price: number | string, szDecimals: number, minNotionalUsd: number = MIN_ORDER_NOTIONAL_USD): string {
  assertSzDecimals(szDecimals);
  const px = absDec(parseDec(price));
  if (decSign(px) === 0) throw new PrecisionError("Price must be positive");
  const min = parseDec(minNotionalUsd);
  const step = decStep(szDecimals);
  let size = parseDec(formatSize(minNotionalUsd / decToNumber(px), szDecimals, "up"));
  if (decSign(size) === 0) size = step;
  while (decCompare(decMul(size, px), min) < 0) size = decAdd(size, step);
  return decToString(size);
}

/** Result of {@link checkMinOrderNotional}. */
export interface MinNotionalCheck {
  /** The order meets the minimum or is exempt. */
  ok: boolean;
  /** A reduce-only order that closes the whole position: HL accepts it below the minimum. */
  exempt: boolean;
  notionalUsd: number;
  minNotionalUsd: number;
  /** Smallest valid size at this price. */
  minSize: string;
  /** Plain-English problem with the valid size to use; empty when ok. */
  message: string;
}

/**
 * Hyperliquid's minimum order value, as the exchange applies it: `size × price` must be at least $10, except for a
 * reduce-only order that closes the entire position (`size` ≥ the position size). Partial closes are not exempt.
 * `price` should be the order's price (limit, or a market order's worst-case price).
 */
export function checkMinOrderNotional(input: {
  size: number | string;
  price: number | string;
  szDecimals: number;
  reduceOnly?: boolean;
  /** Absolute size of the position a reduce-only order reduces. */
  positionSize?: number | string;
  /** For messages, e.g. "BTC". */
  symbol?: string;
  minNotionalUsd?: number;
}): MinNotionalCheck {
  const minNotionalUsd = input.minNotionalUsd ?? MIN_ORDER_NOTIONAL_USD;
  const check = validateOrderNotional(input.size, input.price, minNotionalUsd);
  const minSize = minOrderSize(input.price, input.szDecimals, minNotionalUsd);
  const position = input.positionSize !== undefined ? absDec(parseDec(input.positionSize)) : undefined;
  const closesAll = input.reduceOnly === true && position !== undefined && decSign(position) > 0 && decCompare(absDec(parseDec(input.size)), position) >= 0;
  const exempt = !check.ok && closesAll;
  const ok = check.ok || exempt;
  let message = "";
  if (!ok) {
    const unit = input.symbol ? ` ${input.symbol}` : "";
    const minValue = decToNumber(decMul(parseDec(minSize), absDec(parseDec(input.price))));
    const head = `Order value $${round2(check.notionalUsd)} is below Hyperliquid's $${minNotionalUsd} minimum.`;
    if (input.reduceOnly && position !== undefined && decSign(position) > 0) {
      message =
        decCompare(parseDec(minSize), position) >= 0
          ? `${head} Close the whole position (${decToString(position)}${unit}) instead; only a full close may be smaller.`
          : `${head} Use at least ${minSize}${unit} (about $${round2(minValue)}), or close the whole position.`;
    } else {
      message = `${head} Use at least ${minSize}${unit} (about $${round2(minValue)}).`;
    }
  }
  return { ok, exempt, notionalUsd: check.notionalUsd, minNotionalUsd, minSize, message };
}

function round2(x: number): string {
  return (Math.round(x * 100) / 100).toFixed(2);
}

/**
 * Normalizes a decimal number or string: no exponent, no trailing zeros, no leading "+", "-0" becomes "0".
 *
 * @throws {PrecisionError} on malformed input.
 */
export function normalizeDecimal(value: number | string): string {
  return decToString(parseDec(value));
}

/** True if the value parses as a finite decimal. */
export function isDecimal(value: unknown): value is number | string {
  if (typeof value !== "number" && typeof value !== "string") return false;
  try {
    parseDec(value);
    return true;
  } catch {
    return false;
  }
}

/** Parses a decimal string or number to a JS number (throws PrecisionError on malformed input). */
export function toNumber(value: number | string): number {
  return decToNumber(parseDec(value));
}

// ---------------------------------------------------------------------------------------------

function isValidDec(d: Dec, szDecimals: number, kind: PriceKind): boolean {
  if (decSign(d) <= 0) return false;
  if (decIsInteger(d)) return true;
  return decDecimals(d) <= maxPriceDecimals(szDecimals, kind) && decSignificantDigits(d) <= MAX_PRICE_SIGNIFICANT_FIGURES;
}

function parsePositive(value: number | string, what: string): Dec {
  const d = parseDec(value);
  if (decSign(d) <= 0) throw new PrecisionError(`${what} must be positive, got ${String(value)}`);
  return d;
}

function absDec(d: Dec): Dec {
  return d.m < 0n ? { m: -d.m, s: d.s } : d;
}

function assertSzDecimals(szDecimals: number): void {
  if (!Number.isInteger(szDecimals) || szDecimals < 0 || szDecimals > 18) {
    throw new PrecisionError(`szDecimals must be an integer between 0 and 18, got ${String(szDecimals)}`);
  }
}
