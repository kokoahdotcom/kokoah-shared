/**
 * Chase: a post-only (ALO) limit order kept one tick inside the best price on its side until it fills. Each re-price
 * is a cancel, then a new ALO `order` (never `modify`), so every fill carries the Kokoah builder.
 *
 * {@link nextChaseStep} is pure: given the chase settings, what happened so far and the book, it says what to do
 * next. The runner (the browser tab) does it and calls again. Pacing lives here too: at most one re-price every
 * {@link CHASE_MIN_REPRICE_MS}, and the chase stops after {@link CHASE_MAX_REJECTIONS} post-only rejections.
 *
 * Direction: a buy chases the bid up and a sell chases the ask down. When the book moves in the order's favour the
 * order stays where it is (it is then the best price and fills first).
 *
 * @module
 */
import { formatSize, priceTickAt, roundPriceToTick, type PriceKind } from "../precision/index.js";

/** Minimum time between two re-prices of one chase. */
export const CHASE_MIN_REPRICE_MS = 2_000;
/** A chase stops after this many post-only rejections. */
export const CHASE_MAX_REJECTIONS = 5;
/** Most chases running at once per account (the runner enforces it). */
export const CHASE_MAX_RUNNING = 5;

/** How far a chase may follow the price: an absolute price, or a percentage from the start price. */
export type ChaseLimit = { kind: "price"; price: number } | { kind: "pct"; pct: number };

/** Settings of one chase. */
export interface ChaseConfig {
  side: "buy" | "sell";
  /** Total size in coin units. */
  size: number;
  szDecimals: number;
  priceKind?: PriceKind;
  /** "Chase to": the worst price the chase will follow to. */
  limit?: ChaseLimit;
  /** What happens when the price runs past the limit: the order rests at the limit, or is canceled. Default "rest". */
  atLimit?: "rest" | "cancel";
  /** After this long, whatever is left is sent as an IOC at the limit (or at the best opposite price). */
  timeLimitMs?: number;
  /** Minimum time between re-prices; default {@link CHASE_MIN_REPRICE_MS} (the server re-prices more slowly). */
  minRepriceMs?: number;
}

/** What happened so far (kept by the runner). */
export interface ChaseState {
  startedAt: number;
  /** Best price on the chase's side when it started (reference for a percentage limit). */
  startPrice?: number;
  /** The resting order, when there is one. */
  order?: { price: string; size: string; placedAt: number };
  /** Filled so far, in coin units. */
  filled: number;
  reprices: number;
  /** Post-only rejections so far. */
  rejections: number;
  /** Last time an order was placed, canceled or rejected. */
  lastActionAt?: number;
}

/** The book as the runner sees it. */
export interface ChaseBook {
  bestBid: number;
  bestAsk: number;
  now: number;
}

export type ChaseFinishReason = "filled" | "limitRest" | "limitCancel" | "rejections" | "timeUp";

/** What to do next. */
export type ChaseStep =
  /** No order yet: place an ALO at `price`. */
  | { kind: "place"; price: string; size: string }
  /** Cancel the resting order, then place an ALO for what is left at `price`. */
  | { kind: "reprice"; price: string; size: string }
  /** Nothing to do now; ask again later (`until` when known). */
  | { kind: "wait"; reason: string; until?: number }
  /** Time is up: cancel the resting order (if any), then send an IOC for what is left at `price`. */
  | { kind: "ioc"; price: string; size: string }
  /** The chase is over. `cancel`: cancel the resting order first. */
  | { kind: "finish"; reason: ChaseFinishReason; cancel: boolean };

/** The chase limit as a price, or undefined when there is none. */
export function chaseLimitPrice(config: Pick<ChaseConfig, "side" | "limit">, startPrice: number | undefined): number | undefined {
  const l = config.limit;
  if (!l) return undefined;
  if (l.kind === "price") return l.price > 0 ? l.price : undefined;
  if (!(startPrice && startPrice > 0) || !(l.pct > 0)) return undefined;
  return config.side === "buy" ? startPrice * (1 + l.pct / 100) : startPrice * (1 - l.pct / 100);
}

/**
 * The post-only price one tick inside the best price on the order's side: a buy one tick above the best bid (but below
 * the ask), a sell one tick below the best ask (but above the bid). When the spread is one tick it joins the best price.
 */
export function chaseTargetPrice(side: "buy" | "sell", bestBid: number, bestAsk: number, szDecimals: number, kind: PriceKind = "perp"): string {
  if (side === "buy") {
    const tick = Number(priceTickAt(bestBid, szDecimals, kind));
    const inside = Number(roundPriceToTick(bestBid + tick, szDecimals, kind, "down"));
    return roundPriceToTick(inside < bestAsk ? inside : bestBid, szDecimals, kind, "down");
  }
  const tick = Number(priceTickAt(bestAsk, szDecimals, kind));
  const inside = bestAsk - tick > 0 ? Number(roundPriceToTick(bestAsk - tick, szDecimals, kind, "up")) : bestAsk;
  return roundPriceToTick(inside > bestBid ? inside : bestAsk, szDecimals, kind, "up");
}

/** Next step of a chase (see the module notes). */
export function nextChaseStep(config: ChaseConfig, state: ChaseState, book: ChaseBook): ChaseStep {
  const kind = config.priceKind ?? "perp";
  const buy = config.side === "buy";
  const open = state.order;
  const remaining = formatSize(Math.max(0, config.size - state.filled), config.szDecimals, "down");
  if (!(Number(remaining) > 0)) return { kind: "finish", reason: "filled", cancel: !!open };
  if (state.rejections >= CHASE_MAX_REJECTIONS) return { kind: "finish", reason: "rejections", cancel: !!open };
  const { bestBid, bestAsk, now } = book;
  if (!(bestBid > 0) || !(bestAsk > 0) || bestBid >= bestAsk) return { kind: "wait", reason: "No two-sided book right now." };
  const limit = chaseLimitPrice(config, state.startPrice ?? (buy ? bestBid : bestAsk));
  const limitPx = limit !== undefined ? roundPriceToTick(limit, config.szDecimals, kind, buy ? "down" : "up") : undefined;
  const since = state.lastActionAt ?? open?.placedAt;
  const pace = Math.max(CHASE_MIN_REPRICE_MS, config.minRepriceMs ?? CHASE_MIN_REPRICE_MS);
  const paced = since !== undefined && now - since < pace ? since + pace : undefined;

  if (config.timeLimitMs !== undefined && now - state.startedAt >= config.timeLimitMs) {
    // Take what the limit allows: at the limit, or the best opposite price when there is no limit.
    const touch = buy ? bestAsk : bestBid;
    const px = limitPx !== undefined ? (buy ? Math.min(Number(limitPx), touch) : Math.max(Number(limitPx), touch)) : touch;
    // The limit is behind the book: an IOC could not fill, so end without one.
    if (limitPx !== undefined && (buy ? Number(limitPx) < bestAsk : Number(limitPx) > bestBid)) return { kind: "finish", reason: "timeUp", cancel: !!open };
    return { kind: "ioc", price: roundPriceToTick(px, config.szDecimals, kind, buy ? "down" : "up"), size: remaining };
  }

  let target = chaseTargetPrice(config.side, bestBid, bestAsk, config.szDecimals, kind);
  const beyond = limitPx !== undefined && (buy ? Number(target) > Number(limitPx) : Number(target) < Number(limitPx));
  if (beyond) {
    if ((config.atLimit ?? "rest") === "cancel") return { kind: "finish", reason: "limitCancel", cancel: !!open };
    if (open && Number(open.price) === Number(limitPx)) return { kind: "finish", reason: "limitRest", cancel: false };
    target = limitPx!;
  }
  if (!open) {
    if (paced !== undefined) return { kind: "wait", reason: "Pacing re-prices.", until: paced };
    return { kind: "place", price: target, size: remaining };
  }
  // Still the best price on its side (or better): let it work.
  const best = buy ? Number(open.price) >= bestBid : Number(open.price) <= bestAsk;
  if (best && !beyond) return { kind: "wait", reason: "The order is the best price." };
  if (Number(open.price) === Number(target)) return { kind: "wait", reason: "The order is at its target." };
  if (paced !== undefined) return { kind: "wait", reason: "Pacing re-prices.", until: paced };
  return { kind: "reprice", price: target, size: remaining };
}

/** "40%" style share filled, 0–1. */
export function chaseFilledShare(config: Pick<ChaseConfig, "size">, state: Pick<ChaseState, "filled">): number {
  return config.size > 0 ? Math.min(1, Math.max(0, state.filled / config.size)) : 0;
}
