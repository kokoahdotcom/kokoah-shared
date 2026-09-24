/**
 * Kokoah TWAP: a parent size worked as IOC slices at least {@link TWAP_MIN_INTERVAL_MS} apart, each a normal `order`
 * action with the Kokoah builder (never HL's native `twapOrder`, which carries no builder fee).
 *
 * {@link nextTwapSlice} is pure and deterministic: the optional random size (±20%) and timing (±20%) come from a hash
 * of the TWAP id and the slice number, so the browser runner and the server guardian produce the same plan and a
 * retried evaluation the same slice. A price limit pauses the TWAP (it resumes when the price comes back) instead of
 * ending it; after a pause, slices catch up to at most {@link TWAP_MAX_CATCH_UP}× the normal size.
 *
 * @module
 */
import { formatSize, MIN_ORDER_NOTIONAL_USD } from "../precision/index.js";

/** Slices are at least this far apart. */
export const TWAP_MIN_INTERVAL_MS = 30_000;
/** Shortest TWAP. */
export const TWAP_MIN_DURATION_MS = 5 * 60_000;
/** Longest TWAP. */
export const TWAP_MAX_DURATION_MS = 7 * 86_400_000;
/** Random size and timing spread (fraction) when `randomize` is on. */
export const TWAP_RANDOM_SPREAD = 0.2;
/** A catch-up slice is at most this many times the normal slice. */
export const TWAP_MAX_CATCH_UP = 3;

/** Settings of one TWAP. */
export interface TwapConfig {
  /** Seed for the random size and timing (the TWAP's id). */
  id: string;
  side: "buy" | "sell";
  /** Total size in coin units. */
  totalSize: number;
  szDecimals: number;
  durationMs: number;
  /** Time between slices; at least {@link TWAP_MIN_INTERVAL_MS}. */
  intervalMs: number;
  randomize?: boolean;
  /** Buys pause while the price is above it, sells while it is below it. */
  priceLimit?: number;
  /** Hyperliquid's minimum order value. Default $10. */
  minNotionalUsd?: number;
  /**
   * The last slice may be smaller than the minimum (a reduce-only order closing the whole position is exempt from it).
   * Otherwise a remainder under the minimum ends the TWAP.
   */
  smallFinalSlice?: boolean;
}

/** Progress so far (kept by the runner or the guardian state). */
export interface TwapProgress {
  startedAt: number;
  /** Executed so far, coin units. */
  executed: number;
  /** Slices sent so far (the next slice's index). */
  slicesSent: number;
  /** Earliest time of the next slice; now when absent. */
  nextAt?: number;
}

/** Price and time the decision is made at. */
export interface TwapMarket {
  now: number;
  /** Reference price: mark or mid. */
  price: number;
}

/** What to do next. */
export type TwapDecision =
  | { kind: "slice"; index: number; size: string; nextAt: number }
  | { kind: "wait"; until: number }
  | { kind: "paused"; reason: "priceLimit" }
  | { kind: "done"; reason: "complete" | "belowMinimum" };

/** Numbers of the plan: slices at the normal pace, the normal slice size and the planned end. */
export function planTwap(config: Pick<TwapConfig, "totalSize" | "durationMs" | "intervalMs">, startedAt = 0) {
  const interval = Math.max(TWAP_MIN_INTERVAL_MS, config.intervalMs);
  const slices = Math.max(1, Math.floor(config.durationMs / interval));
  return { slices, interval, sliceSize: config.totalSize / slices, endAt: startedAt + config.durationMs };
}

/** Problems with TWAP settings (plain English); empty when valid. */
export function twapConfigProblems(config: Pick<TwapConfig, "totalSize" | "durationMs" | "intervalMs"> & { price?: number; minNotionalUsd?: number }): string[] {
  const p: string[] = [];
  if (!(config.totalSize > 0)) p.push("Enter a size.");
  if (!(config.durationMs >= TWAP_MIN_DURATION_MS && config.durationMs <= TWAP_MAX_DURATION_MS)) p.push("A TWAP runs from 5 minutes to 7 days.");
  if (!(config.intervalMs >= TWAP_MIN_INTERVAL_MS)) p.push("Slices must be at least 30 seconds apart.");
  else if (config.intervalMs > config.durationMs) p.push("The slice interval is longer than the whole TWAP.");
  const minimum = config.minNotionalUsd ?? MIN_ORDER_NOTIONAL_USD;
  if (p.length === 0 && config.price && config.price > 0) {
    const { sliceSize } = planTwap(config);
    if (sliceSize * config.price < minimum) p.push(`Each slice would be under the $${minimum} minimum: use fewer slices or a larger size.`);
  }
  return p;
}

/** A deterministic number in [0, 1) from a string (FNV-1a, 32 bit). */
export function unitHash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 4294967296;
}

function jitter(seed: string, on: boolean | undefined): number {
  return on ? 1 + (unitHash(seed) * 2 - 1) * TWAP_RANDOM_SPREAD : 1;
}

/** Next step of a TWAP (see the module notes). */
export function nextTwapSlice(config: TwapConfig, progress: TwapProgress, market: TwapMarket): TwapDecision {
  const lot = 10 ** -config.szDecimals;
  const remaining = config.totalSize - progress.executed;
  if (!(remaining >= lot - 1e-12)) return { kind: "done", reason: "complete" };
  const { now, price } = market;
  if (progress.nextAt !== undefined && now < progress.nextAt) return { kind: "wait", until: progress.nextAt };
  if (config.priceLimit !== undefined && price > 0) {
    const blocked = config.side === "buy" ? price > config.priceLimit : price < config.priceLimit;
    if (blocked) return { kind: "paused", reason: "priceLimit" };
  }
  const plan = planTwap(config, progress.startedAt);
  const minimum = config.minNotionalUsd ?? MIN_ORDER_NOTIONAL_USD;
  const index = progress.slicesSent;
  const slicesLeft = Math.max(1, Math.ceil((plan.endAt - now) / plan.interval));
  const cap = plan.sliceSize * TWAP_MAX_CATCH_UP;
  let size = Math.min(remaining / slicesLeft, cap);
  if (slicesLeft > 1) size *= jitter(`${config.id}:size:${index}`, config.randomize);
  // Keep every slice above the minimum; the last one takes the rest.
  if (price > 0 && size * price < minimum) size = minimum / price;
  let wire = formatSize(Math.min(size, remaining), config.szDecimals, "up");
  if (Number(wire) > remaining + 1e-12) wire = formatSize(remaining, config.szDecimals, "down");
  // A remainder under the minimum after this slice would be stranded: take it now.
  const after = remaining - Number(wire);
  if (price > 0 && after > 1e-12 && after * price < minimum) wire = formatSize(remaining, config.szDecimals, "down");
  if (!(Number(wire) > 0)) return { kind: "done", reason: "complete" };
  if (price > 0 && Number(wire) * price < minimum - 1e-9 && !config.smallFinalSlice) return { kind: "done", reason: "belowMinimum" };
  const gap = Math.max(TWAP_MIN_INTERVAL_MS, plan.interval * jitter(`${config.id}:time:${index}`, config.randomize));
  return { kind: "slice", index, size: wire, nextAt: now + Math.round(gap) };
}

/** Slices left at the normal pace (for "TWAP 12/120"). */
export function twapSliceCount(config: Pick<TwapConfig, "totalSize" | "durationMs" | "intervalMs">): number {
  return planTwap(config).slices;
}
