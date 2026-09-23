/**
 * Price bands: how far from the mark an order may be priced, depending on whether it executes now or rests.
 *
 * - **Executes now** (market orders, IOC, and marketable limits: a buy at or above the reference, a sell at or below
 *   it): the policy's `priceBandPct` (10% for the manual baseline; users may only tighten it).
 * - **Rests** (GTC or ALO limits that are not marketable): up to {@link RESTING_PRICE_BAND_PCT} from mark, or the
 *   policy band when that is wider. A resting order only fills if the market comes to it, so "buy 20% below" is a
 *   legitimate order; 50% still stops fat-finger typos such as 8500 for 85000 (90% off).
 * - **Triggers** (stop / take profit): the trigger price is where the order fires and the limit price is what it
 *   executes at. A trigger that has not fired yet rests: its trigger may sit up to the resting band from mark. Its
 *   limit must stay within max(`priceBandPct`, 10%) of its own trigger, since that is the execution slippage when it
 *   fires. A trigger that is already past its trigger fires at once and is banded like an order that executes now:
 *   its limit must be within `priceBandPct` of mark.
 *
 * "Marketable" is judged against the mark and, when the caller has it (the signer frame fetches it from Hyperliquid
 * itself), the book mid: a buy is marketable at or above min(mark, mid), a sell at or below max(mark, mid). The mid
 * sits inside the spread, so this errs toward the tighter band. Never pass prices supplied by an untrusted party.
 *
 * @module
 */
import { MARKET_TRIGGER_MAX_SLIPPAGE_PCT } from "../risk/formulas.js";

/** Baseline band (percent from mark) for resting, non-marketable GTC/ALO limits and for untriggered triggers. */
export const RESTING_PRICE_BAND_PCT = 50;

/** Limit time-in-force as it appears on intents and wire actions. */
export type LimitTif = "Gtc" | "Ioc" | "Alo" | "FrontendMarket";

/** Band that applies to a resting order when the immediate band is `bandPct`. Never narrower than `bandPct`. */
export function restingPriceBandPct(bandPct: number): number {
  return Math.max(bandPct, RESTING_PRICE_BAND_PCT);
}

function validRef(x: number | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

/**
 * True when a limit at `price` would match immediately: a buy at or above min(mark, mid), a sell at or below
 * max(mark, mid). `mid` is optional.
 */
export function isMarketableLimit(input: { isBuy: boolean; price: number; mark: number; mid?: number | undefined }): boolean {
  const refs = [input.mark, input.mid].filter(validRef);
  if (refs.length === 0) return true;
  return input.isBuy ? input.price >= Math.min(...refs) : input.price <= Math.max(...refs);
}

/** Result of {@link checkLimitPriceBand}. */
export interface LimitBandCheck {
  ok: boolean;
  /** Whether the order counts as executing now or resting. */
  execution: "immediate" | "resting";
  /** Distance from mark, percent. */
  offPct: number;
  /** The band that applied. */
  maxPct: number;
  /** Plain-English problem; empty when ok. */
  message: string;
}

const EPS = 1e-9;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function pct(x: number): string {
  return (Math.round(x * 100) / 100).toString();
}

/**
 * Checks a non-trigger limit price against the band that applies to it. IOC and `FrontendMarket` always count as
 * executing now; GTC and ALO (default GTC) count as resting unless marketable.
 */
export function checkLimitPriceBand(input: {
  isBuy: boolean;
  price: number;
  mark: number;
  mid?: number | undefined;
  tif?: LimitTif | undefined;
  bandPct: number;
  /** Prefix for messages, e.g. the coin. */
  label?: string;
}): LimitBandCheck {
  const { price, mark, bandPct } = input;
  const offPct = (Math.abs(price - mark) / mark) * 100;
  const immediate = input.tif === "Ioc" || input.tif === "FrontendMarket" || isMarketableLimit(input);
  const resting = restingPriceBandPct(bandPct);
  const maxPct = immediate ? bandPct : resting;
  const ok = offPct <= maxPct + EPS;
  const who = input.label ? `${input.label} ` : "";
  const side = input.isBuy ? "buy" : "sell";
  let message = "";
  if (!ok) {
    message = immediate
      ? `${who}${side} at ${price} is ${pct(offPct)}% from the mark price ${mark} and would fill immediately; orders that execute now must be within ${pct(bandPct)}% of the mark${resting > bandPct && input.tif !== "Ioc" && input.tif !== "FrontendMarket" ? ` (a resting limit can be up to ${pct(resting)}% away)` : ""}.`
      : `${who}resting ${side} limit at ${price} is ${pct(offPct)}% from the mark price ${mark}; resting limits must be within ${pct(resting)}% of the mark.`;
    if (!input.label) message = capitalize(message);
  }
  return { ok, execution: immediate ? "immediate" : "resting", offPct, maxPct, message };
}

/** True when a trigger order would fire at the current mark (HL: stop-buy ≥, stop-sell ≤, tp-buy ≤, tp-sell ≥). */
export function isTriggerCrossed(input: { isBuy: boolean; tpsl: "tp" | "sl"; triggerPrice: number; mark: number }): boolean {
  const t = input.triggerPrice;
  if (input.tpsl === "sl") return input.isBuy ? input.mark >= t : input.mark <= t;
  return input.isBuy ? input.mark <= t : input.mark >= t;
}

/** Result of {@link checkTriggerPriceBand}. */
export interface TriggerBandCheck {
  ok: boolean;
  /** The trigger is already past the mark: the order fires at once. */
  crossed: boolean;
  /** Plain-English problems; empty when ok. */
  problems: string[];
}

/**
 * The part of the trigger check that needs no mark: the limit must be within max(`bandPct`, 10%) of the trigger.
 * Returns the problem or "".
 */
export function triggerLimitBandProblem(input: { triggerPrice: number; limitPrice?: number | undefined; bandPct: number; label?: string }): string {
  const trigger = input.triggerPrice;
  const limit = input.limitPrice ?? trigger;
  const triggerBand = Math.max(input.bandPct, MARKET_TRIGGER_MAX_SLIPPAGE_PCT);
  const off = (Math.abs(limit - trigger) / trigger) * 100;
  if (off <= triggerBand + EPS) return "";
  return `${input.label ? `${input.label} ` : ""}trigger limit price is ${pct(off)}% from its trigger (max ${pct(triggerBand)}%).`;
}

/**
 * Checks a trigger order (see the module notes): limit within max(`bandPct`, 10%) of the trigger; untriggered
 * trigger within the resting band of mark; already-crossed trigger's limit within `bandPct` of mark.
 * `limitPrice` defaults to the trigger (market triggers).
 */
export function checkTriggerPriceBand(input: {
  isBuy: boolean;
  tpsl: "tp" | "sl";
  triggerPrice: number;
  limitPrice?: number | undefined;
  mark: number;
  bandPct: number;
  label?: string;
}): TriggerBandCheck {
  const { triggerPrice: trigger, mark, bandPct } = input;
  const limit = input.limitPrice ?? trigger;
  const who = input.label ? `${input.label} ` : "";
  const problems: string[] = [];
  const limitProblem = triggerLimitBandProblem(input);
  if (limitProblem) problems.push(limitProblem);
  const crossed = isTriggerCrossed({ isBuy: input.isBuy, tpsl: input.tpsl, triggerPrice: trigger, mark });
  if (crossed) {
    const off = (Math.abs(limit - mark) / mark) * 100;
    if (!(off <= bandPct + EPS)) {
      problems.push(`${who}trigger at ${trigger} would fire immediately at mark ${mark}; its limit ${limit} is ${pct(off)}% from mark (band ${pct(bandPct)}%).`);
    }
  } else {
    const resting = restingPriceBandPct(bandPct);
    const off = (Math.abs(trigger - mark) / mark) * 100;
    if (!(off <= resting + EPS)) problems.push(`${who}trigger at ${trigger} is ${pct(off)}% from the mark price ${mark}; triggers must be within ${pct(resting)}% of the mark.`);
  }
  return { ok: problems.length === 0, crossed, problems: input.label ? problems : problems.map(capitalize) };
}
