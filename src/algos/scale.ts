/**
 * Scale orders: a ladder of 2–50 resting limit orders between a start and an end price, one `order` action per leg
 * (each carries the Kokoah builder). {@link planScale} is pure: it spaces the prices, splits the size by a
 * distribution preset or custom percentages, rounds every leg to the market's tick and lot, and flags legs Hyperliquid
 * or the signer would refuse (under $10, fills at once, outside the price band).
 *
 * The 50-leg cap keeps one ladder inside the signer frame's 60 orders a minute.
 *
 * @module
 */
import { checkLimitPriceBand } from "../policy/band.js";
import { formatSize, MIN_ORDER_NOTIONAL_USD, roundPriceToTick, type PriceKind } from "../precision/index.js";

/** Fewest legs in a ladder. */
export const SCALE_MIN_LEGS = 2;
/** Most legs in a ladder (one ladder stays within the frame's 60 orders per minute). */
export const SCALE_MAX_LEGS = 50;
/** Size ratio between the heaviest and the lightest leg for the "more near start / end" presets. */
export const SCALE_DEFAULT_SKEW = 3;

/**
 * How the total size is spread over the legs, from the start price (leg 0) to the end price:
 * - `even`: every leg the same size;
 * - `start`: more near the start price, falling linearly to 1/`skew` of the first leg at the end;
 * - `end`: more near the end price;
 * - `custom`: one percentage per leg, summing to 100.
 */
export type ScaleDistribution =
  | { kind: "even" }
  | { kind: "start"; skew?: number }
  | { kind: "end"; skew?: number }
  | { kind: "custom"; percents: readonly number[] };

/** Inputs of {@link planScale}. */
export interface ScaleInput {
  side: "buy" | "sell";
  startPrice: number;
  endPrice: number;
  legs: number;
  /** Total size in coin units. */
  totalSize: number;
  distribution: ScaleDistribution;
  szDecimals: number;
  priceKind?: PriceKind;
  /** Mark price, for the band check and "fills at once" without a book. */
  mark?: number;
  /** Best bid and ask: a buy leg at or above the ask (a sell at or below the bid) fills at once. */
  bestBid?: number;
  bestAsk?: number;
  /** The signer's immediate-execution band in percent (resting legs may sit up to 50% away). Default 10. */
  bandPct?: number;
  /** Hyperliquid's minimum order value. Default $10. */
  minNotionalUsd?: number;
}

/** One leg of a ladder. */
export interface ScaleLeg {
  index: number;
  /** Wire price (valid tick). */
  price: string;
  /** Wire size (valid lot); "0" when the leg rounds away. */
  size: string;
  notionalUsd: number;
  /** Share of the total size, percent. */
  percent: number;
  /** Below Hyperliquid's $10 minimum: Hyperliquid rejects it. */
  belowMinimum: boolean;
  /** Crosses the book: it fills at once as a taker instead of resting. */
  fillsNow: boolean;
  /** Outside the signer's price band: the signer refuses it. */
  outsideBand: boolean;
  /** Plain-English flags of this leg ("under the $10 minimum", "fills at once"); empty when it is clean. */
  problems: string[];
  /** The leg can't be sent (zero size, under the minimum, outside the band). "Fills at once" alone is a warning. */
  blocking: boolean;
}

/** Result of {@link planScale}. */
export interface ScalePlan {
  legs: ScaleLeg[];
  /** Sum of the leg sizes (wire string). */
  totalSize: string;
  totalNotionalUsd: number;
  /** Size-weighted average price of the ladder, 0 when empty. */
  averagePrice: number;
  /** Problems with the whole ladder (inputs, rounding); empty when the ladder can be sent. */
  problems: string[];
  /** Legs with at least one flag. */
  flagged: number;
  /** Legs that can't be sent. */
  blocking: number;
}

/** Normalized weights (summing to 1) for `legs` legs, or the reason they can't be built. */
export function scaleWeights(distribution: ScaleDistribution, legs: number): { weights: number[]; problem?: string } {
  const n = Math.floor(legs);
  if (!(n >= 1)) return { weights: [], problem: "Choose at least one leg." };
  let raw: number[];
  if (distribution.kind === "custom") {
    const p = distribution.percents;
    if (p.length !== n) return { weights: [], problem: `Give one percentage per leg (${n}).` };
    if (p.some((x) => !(Number.isFinite(x) && x > 0))) return { weights: [], problem: "Every leg's percentage must be above 0." };
    const sum = p.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 100) > 0.01) return { weights: [], problem: `The percentages add up to ${round2(sum)}%, not 100%.` };
    raw = [...p];
  } else if (distribution.kind === "even" || n === 1) {
    raw = Array.from({ length: n }, () => 1);
  } else {
    const skew = distribution.skew ?? SCALE_DEFAULT_SKEW;
    if (!(Number.isFinite(skew) && skew >= 1 && skew <= 100)) return { weights: [], problem: "The size skew must be from 1 to 100." };
    // Linear from `skew` (heavy end) to 1 (light end).
    raw = Array.from({ length: n }, (_, i) => 1 + ((skew - 1) * (n - 1 - i)) / (n - 1));
    if (distribution.kind === "end") raw.reverse();
  }
  const total = raw.reduce((a, b) => a + b, 0);
  return { weights: raw.map((w) => w / total) };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Splits `totalLots` whole lots by `weights` with the largest-remainder method: the parts are whole, never exceed the
 * total and add up to it exactly.
 */
export function splitLots(totalLots: number, weights: readonly number[]): number[] {
  const exact = weights.map((w) => w * totalLots);
  const parts = exact.map((x) => Math.floor(x + 1e-9));
  let left = totalLots - parts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x + 1e-9) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) parts[order[k]!.i]! += 1;
  return parts;
}

function lotsToSize(lots: number, szDecimals: number): string {
  if (lots <= 0) return "0";
  if (szDecimals === 0) return String(lots);
  const s = String(lots).padStart(szDecimals + 1, "0");
  const whole = s.slice(0, -szDecimals);
  const frac = s.slice(-szDecimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Plans a scale ladder (see the module notes). Never throws: problems are returned. */
export function planScale(input: ScaleInput): ScalePlan {
  const problems: string[] = [];
  const empty = (): ScalePlan => ({ legs: [], totalSize: "0", totalNotionalUsd: 0, averagePrice: 0, problems, flagged: 0, blocking: 0 });
  const n = input.legs;
  if (!Number.isInteger(n) || n < SCALE_MIN_LEGS || n > SCALE_MAX_LEGS) {
    problems.push(`Choose ${SCALE_MIN_LEGS} to ${SCALE_MAX_LEGS} orders.`);
    return empty();
  }
  if (!(input.startPrice > 0) || !(input.endPrice > 0)) {
    problems.push("Enter a start and an end price.");
    return empty();
  }
  if (input.startPrice === input.endPrice) {
    problems.push("The start and end prices must differ.");
    return empty();
  }
  if (!(input.totalSize > 0)) {
    problems.push("Enter a size.");
    return empty();
  }
  const { weights, problem } = scaleWeights(input.distribution, n);
  if (problem) {
    problems.push(problem);
    return empty();
  }
  const kind = input.priceKind ?? "perp";
  const lotScale = 10 ** input.szDecimals;
  const totalLots = Math.round(Number(formatSize(input.totalSize, input.szDecimals, "down")) * lotScale);
  if (totalLots < n) problems.push(`The size is too small for ${n} orders: each order needs at least one lot.`);
  const lots = splitLots(totalLots, weights);
  const minimum = input.minNotionalUsd ?? MIN_ORDER_NOTIONAL_USD;
  const bandPct = input.bandPct ?? 10;
  const isBuy = input.side === "buy";
  const mid = input.bestBid && input.bestAsk && input.bestBid < input.bestAsk ? (input.bestBid + input.bestAsk) / 2 : undefined;
  const legs: ScaleLeg[] = [];
  for (let i = 0; i < n; i++) {
    const raw = input.startPrice + ((input.endPrice - input.startPrice) * i) / (n - 1);
    let price: string;
    try {
      // Buys round down and sells up: a leg never pays more than its step of the ladder.
      price = roundPriceToTick(raw, input.szDecimals, kind, isBuy ? "down" : "up");
    } catch {
      problems.push(`Order ${i + 1}: the price rounds to zero.`);
      return empty();
    }
    const size = lotsToSize(lots[i]!, input.szDecimals);
    const px = Number(price);
    const notionalUsd = px * Number(size);
    const legProblems: string[] = [];
    if (Number(size) <= 0) legProblems.push("rounds to zero size");
    const belowMinimum = Number(size) > 0 && notionalUsd < minimum - 1e-9;
    if (belowMinimum) legProblems.push(`under the $${minimum} minimum`);
    const fillsNow = isBuy
      ? input.bestAsk !== undefined && input.bestAsk > 0
        ? px >= input.bestAsk
        : input.mark !== undefined && input.mark > 0 && px >= input.mark
      : input.bestBid !== undefined && input.bestBid > 0
        ? px <= input.bestBid
        : input.mark !== undefined && input.mark > 0 && px <= input.mark;
    if (fillsNow) legProblems.push("fills at once");
    let outsideBand = false;
    if (input.mark !== undefined && input.mark > 0) {
      const band = checkLimitPriceBand({ isBuy, price: px, mark: input.mark, mid, tif: "Gtc", bandPct });
      outsideBand = !band.ok;
      if (outsideBand) legProblems.push(`${round2(band.offPct)}% from the mark (max ${round2(band.maxPct)}%)`);
    }
    const blocking = Number(size) <= 0 || belowMinimum || outsideBand;
    legs.push({ index: i, price, size, notionalUsd, percent: weights[i]! * 100, belowMinimum, fillsNow, outsideBand, problems: legProblems, blocking });
  }
  const prices = new Set(legs.map((l) => l.price));
  if (prices.size < legs.length) problems.push("Some orders share a price after rounding to the tick: widen the range or use fewer orders.");
  const sizeSum = lots.reduce((a, b) => a + b, 0);
  const totalNotionalUsd = legs.reduce((a, l) => a + l.notionalUsd, 0);
  const totalCoins = sizeSum / lotScale;
  return {
    legs,
    totalSize: lotsToSize(sizeSum, input.szDecimals),
    totalNotionalUsd,
    averagePrice: totalCoins > 0 ? totalNotionalUsd / totalCoins : 0,
    problems,
    flagged: legs.filter((l) => l.problems.length > 0).length,
    blocking: legs.filter((l) => l.blocking).length,
  };
}
