/**
 * Brackets: an entry protected by one stop and up to {@link BRACKET_MAX_TAKE_PROFITS} take-profit levels, each closing
 * a share of the filled size, optionally moving the stop to the entry price once the first take profit is reached,
 * and optionally with a second entry that is canceled when the first one fills (one-cancels-other).
 *
 * Every leg is a normal reduce-only trigger `order` with the Kokoah builder, resting on Hyperliquid. Hyperliquid can
 * attach only one take profit and one stop to an entry, so split take profits are placed as separate reduce-only
 * orders once the entry has filled: by the browser right after a market entry, or by the server `bracket` rule
 * (`bracketRule.ts`) for resting entries, breakeven moves and one-cancels-other entries.
 *
 * {@link planBracket} checks what the ticket shows; {@link sizeTakeProfits} splits a filled size over the levels and is
 * shared by the ticket and the server rule, so both size the legs the same way.
 *
 * @module
 */
import { restingPriceBandPct } from "../policy/band.js";
import { MIN_ORDER_NOTIONAL_USD, roundPriceToTick, type PriceKind } from "../precision/index.js";
import { splitLots } from "./scale.js";

/** Most take-profit levels in one bracket. */
export const BRACKET_MAX_TAKE_PROFITS = 3;

/** A take-profit level: its trigger price and the share of the filled size it closes (percent). */
export interface BracketLevel {
  price: number;
  pct: number;
}

/** One take-profit leg as sent: the level it belongs to and its wire size. */
export interface SizedTakeProfit {
  /** Index of the level (0 = TP1). */
  index: number;
  size: string;
  /** Levels folded into this leg because they alone were under Hyperliquid's minimum. */
  merged: number[];
}

/** Whole lots → wire size string. */
export function lotsToSize(lots: number, szDecimals: number): string {
  if (lots <= 0) return "0";
  if (szDecimals === 0) return String(lots);
  const s = String(lots).padStart(szDecimals + 1, "0");
  const whole = s.slice(0, -szDecimals);
  const frac = s.slice(-szDecimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Splits `size` (coin) over the levels by their shares: the legs add up to exactly `size × Σpct / 100` in whole lots
 * (largest remainder), and a leg under the minimum order value at its own price is folded into the next level (the
 * last one into the one before it), so every leg can be placed. Legs of zero size are left out.
 */
export function sizeTakeProfits(input: { size: number; levels: readonly BracketLevel[]; szDecimals: number; minNotionalUsd?: number }): SizedTakeProfit[] {
  const { levels, szDecimals } = input;
  const total = levels.reduce((a, l) => a + (l.pct > 0 ? l.pct : 0), 0);
  if (!(input.size > 0) || !(total > 0) || levels.length === 0) return [];
  const scale = 10 ** szDecimals;
  const share = Math.min(total, 100) / 100;
  const totalLots = Math.floor(input.size * share * scale + 1e-6);
  const lots = splitLots(
    totalLots,
    levels.map((l) => (l.pct > 0 ? l.pct : 0) / total),
  );
  const minimum = input.minNotionalUsd ?? MIN_ORDER_NOTIONAL_USD;
  const legs = lots.map((n, index) => ({ index, lots: n, merged: [] as number[] }));
  const small = (leg: { index: number; lots: number }) => leg.lots > 0 && (leg.lots / scale) * levels[leg.index]!.price < minimum - 1e-9;
  // Forward: a small leg joins the next level.
  for (let i = 0; i < legs.length - 1; i++) {
    const leg = legs[i]!;
    if (!small(leg)) continue;
    const next = legs[i + 1]!;
    next.lots += leg.lots;
    next.merged.push(leg.index, ...leg.merged);
    leg.lots = 0;
    leg.merged = [];
  }
  // The last leg, if still small, joins the nearest kept one before it.
  const last = legs[legs.length - 1]!;
  if (small(last)) {
    const keep = [...legs.slice(0, -1)].reverse().find((l) => l.lots > 0);
    if (keep) {
      keep.lots += last.lots;
      keep.merged.push(last.index, ...last.merged);
      last.lots = 0;
      last.merged = [];
    }
  }
  return legs.filter((l) => l.lots > 0).map((l) => ({ index: l.index, size: lotsToSize(l.lots, szDecimals), merged: l.merged.sort((a, b) => a - b) }));
}

/** Inputs of {@link planBracket}. */
export interface BracketPlanInput {
  /** Entry side. */
  side: "buy" | "sell";
  /** Expected entry price, and the second entry's for one-cancels-other entries: every leg must suit each of them. */
  entryPrices: readonly number[];
  /** Entry size in coin units. */
  size: number;
  szDecimals: number;
  priceKind?: PriceKind;
  takeProfits: readonly BracketLevel[];
  stopPrice?: number;
  /** Move the stop to the entry price once the mark reaches TP1. */
  breakeven?: boolean;
  /** The signer's immediate band in percent; legs may rest up to the resting band (50%) from the entry. Default 10. */
  bandPct?: number;
  minNotionalUsd?: number;
}

/** One exit leg of a bracket plan. */
export interface BracketPlanLeg {
  kind: "tp" | "sl";
  /** "TP1", "TP2", "Stop loss". */
  label: string;
  /** Trigger price (valid tick). */
  price: string;
  /** Wire size ("0" for a take profit folded into another). */
  size: string;
  /** Share of the entry size, percent. */
  pct: number;
  notionalUsd: number;
  /** Profit (take profit) or loss (stop, negative) against the first entry price, before fees. */
  pnlUsd: number;
  /** Take-profit levels folded into this one (under the minimum on their own). */
  merged: number[];
}

/** Result of {@link planBracket}. */
export interface BracketPlan {
  takeProfits: BracketPlanLeg[];
  stop?: BracketPlanLeg;
  /** Share of the entry size the take profits close, percent. */
  coveredPct: number;
  /** Problems that block the bracket (plain English). */
  problems: string[];
  /** Things to know that don't block it ("TP1 is under the $10 minimum and joins TP2"). */
  notes: string[];
}

const pctText = (x: number) => `${Math.round(x * 100) / 100}%`;

/** Checks and sizes a bracket (see the module notes). Never throws. */
export function planBracket(input: BracketPlanInput): BracketPlan {
  const problems: string[] = [];
  const notes: string[] = [];
  const kind = input.priceKind ?? "perp";
  const buy = input.side === "buy";
  const entries = input.entryPrices.filter((p) => p > 0);
  const first = entries[0] ?? 0;
  const levels = input.takeProfits;
  const round = (p: number) => {
    try {
      return roundPriceToTick(p, input.szDecimals, kind);
    } catch {
      return undefined;
    }
  };
  if (levels.length > BRACKET_MAX_TAKE_PROFITS) problems.push(`Use at most ${BRACKET_MAX_TAKE_PROFITS} take profits.`);
  levels.forEach((l, i) => {
    if (!(l.price > 0)) problems.push(`Enter the TP${i + 1} price.`);
    if (!(l.pct > 0)) problems.push(`Give TP${i + 1} a share above 0%.`);
  });
  const total = levels.reduce((a, l) => a + (l.pct > 0 ? l.pct : 0), 0);
  if (total > 100 + 1e-6) problems.push(`The take profits close ${pctText(total)} of the size: keep it at 100% or less.`);
  const resting = restingPriceBandPct(input.bandPct ?? 10);
  for (const e of entries) {
    levels.forEach((l, i) => {
      if (!(l.price > 0)) return;
      if (buy ? l.price <= e : l.price >= e) problems.push(`TP${i + 1} must be ${buy ? "above" : "below"} the entry (${e}).`);
      else if ((Math.abs(l.price - e) / e) * 100 > resting) problems.push(`TP${i + 1} is more than ${resting}% from the entry.`);
    });
    if (input.stopPrice !== undefined && input.stopPrice > 0) {
      if (buy ? input.stopPrice >= e : input.stopPrice <= e) problems.push(`The stop must be ${buy ? "below" : "above"} the entry (${e}).`);
      else if ((Math.abs(input.stopPrice - e) / e) * 100 > resting) problems.push(`The stop is more than ${resting}% from the entry.`);
    }
  }
  for (let i = 1; i < levels.length; i++) {
    const a = levels[i - 1]!.price;
    const b = levels[i]!.price;
    if (a > 0 && b > 0 && (buy ? b <= a : b >= a)) problems.push(`TP${i + 1} must be beyond TP${i}.`);
  }
  if (input.breakeven) {
    if (!(input.stopPrice! > 0)) problems.push("Moving the stop to breakeven needs a stop loss.");
    if (levels.length === 0) problems.push("Moving the stop to breakeven after TP1 needs a take profit.");
  }
  const sign = buy ? 1 : -1;
  const sized = input.size > 0 && levels.every((l) => l.price > 0 && l.pct > 0) ? sizeTakeProfits({ size: input.size, levels, szDecimals: input.szDecimals, ...(input.minNotionalUsd !== undefined ? { minNotionalUsd: input.minNotionalUsd } : {}) }) : [];
  const takeProfits: BracketPlanLeg[] = levels.map((l, i) => {
    const leg = sized.find((s) => s.index === i);
    const price = l.price > 0 ? (round(l.price) ?? "0") : "0";
    const size = leg?.size ?? "0";
    const coins = Number(size);
    return {
      kind: "tp",
      label: `TP${i + 1}`,
      price,
      size,
      pct: l.pct,
      notionalUsd: coins * Number(price),
      pnlUsd: first > 0 ? sign * (Number(price) - first) * coins : 0,
      merged: leg?.merged ?? [],
    };
  });
  for (const leg of sized) {
    for (const m of leg.merged) notes.push(`TP${m + 1} alone is under Hyperliquid's $${input.minNotionalUsd ?? MIN_ORDER_NOTIONAL_USD} minimum, so it joins TP${leg.index + 1}.`);
  }
  if (input.size > 0 && sized.length === 0 && levels.length > 0 && levels.every((l) => l.price > 0 && l.pct > 0)) problems.push("The take profits are too small to place: use a larger size.");
  let stop: BracketPlanLeg | undefined;
  if (input.stopPrice !== undefined && input.stopPrice > 0) {
    const price = round(input.stopPrice) ?? "0";
    stop = {
      kind: "sl",
      label: "Stop loss",
      price,
      size: String(input.size),
      pct: 100,
      notionalUsd: input.size * Number(price),
      pnlUsd: first > 0 ? sign * (Number(price) - first) * input.size : 0,
      merged: [],
    };
  }
  if (total > 0 && total < 100 - 1e-6 && problems.length === 0) notes.push(`${pctText(100 - total)} of the size has no take profit and stays open until the stop or your own exit.`);
  return { takeProfits, ...(stop ? { stop } : {}), coveredPct: Math.min(total, 100), problems: [...new Set(problems)], notes: [...new Set(notes)] };
}

/** Even shares for `n` take profits that add up to 100 (the last takes the rounding): 100 · 50/50 · 33/33/34. */
export function evenShares(n: number): number[] {
  if (!(n >= 1)) return [];
  const each = Math.floor(100 / n);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? 100 - each * (n - 1) : each));
}
