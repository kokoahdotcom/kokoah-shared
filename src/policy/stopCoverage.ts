/**
 * Stop coverage. With `requireStopLossForNewEntries` an entry needs a stop-loss when it opens; this keeps it there: a
 * cancel or modify must not take stop-loss cover away from a position, and an entry must leave the whole position it
 * adds to covered. The signer reads the traded account's positions and resting orders on Hyperliquid itself (never
 * from the caller), and {@link stopCoverageProblems} and {@link positionAfterEntriesProblem} replay the action on them.
 *
 * A stop-loss counts toward a position's cover when it is a trigger with `tpsl` "sl" on the closing side, reduce-only
 * or a position TP/SL, that can fill when it fires ({@link stopCanFill}: a market trigger, or a limit at or beyond its
 * trigger), each within `maxStopLossDistancePct` of the entry price on the losing side when the policy sets it (a stop
 * at or past the entry, locking in profit, always counts). The cover is the size those stops close, at most the
 * position's. Only positions an action touches are compared, and only cover it takes away is refused: a position
 * without a stop before stays allowed to cancel and change its other orders.
 *
 * @module
 */
import type { MarketRegistry } from "../markets/registry.js";

/** A resting order of the account, as the signer read it (Hyperliquid `frontendOpenOrders`). */
export interface AccountOrder {
  coin: string;
  oid: number;
  /** Lowercase. */
  cloid?: string;
  isBuy: boolean;
  /** Remaining size (a position TP/SL may show 0: it closes the whole position). */
  size: number;
  isTrigger: boolean;
  triggerPrice?: number;
  tpsl?: "tp" | "sl";
  reduceOnly: boolean;
  /** A position TP/SL: closes the whole position, whatever its size. */
  positionTpsl: boolean;
  /** A market trigger (Hyperliquid "Stop Market", wire `isMarket`): it executes at market when it fires. */
  isMarket?: boolean;
  /** Limit price (Hyperliquid `limitPx`, wire `p`): what a limit trigger executes at once it fires. */
  limitPrice?: number;
}

/** An open position of the account (Hyperliquid `clearinghouseState`). */
export interface AccountPosition {
  coin: string;
  /** Signed: positive long, negative short. */
  size: number;
  entryPrice: number;
}

/** The account's positions and resting orders on the markets an action touches. */
export interface AccountBook {
  positions: readonly AccountPosition[];
  orders: readonly AccountOrder[];
  /**
   * Orders the action names that the signer found closed on Hyperliquid (filled, canceled or never placed), by oid or
   * lowercase cloid: naming one takes nothing away. Every other order a cancel or modify names must be in `orders`.
   */
  closed?: ReadonlyArray<number | string>;
}

/** Action types {@link stopCoverageProblems} checks: the ones that can take a resting stop away. */
export const STOP_COVERAGE_ACTION_TYPES: readonly string[] = Object.freeze(["cancel", "cancelByCloid", "modify", "batchModify"]);

type WireOrder = { a?: unknown; b?: unknown; p?: unknown; s?: unknown; r?: unknown; t?: { trigger?: { isMarket?: unknown; triggerPx?: unknown; tpsl?: unknown } } };

const sameCloid = (a: string | undefined, b: unknown): boolean => a !== undefined && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/** The open order a cancel or modify names: by oid (a number) or cloid, whatever asset the action names (stricter). */
function target(orders: readonly AccountOrder[], ref: unknown): number[] {
  const out: number[] = [];
  orders.forEach((o, i) => {
    if (typeof ref === "number" ? o.oid === ref : sameCloid(o.cloid, ref)) out.push(i);
  });
  return out;
}

/**
 * True when a stop order can fill once it fires: a market trigger, or a limit at or beyond its trigger on the closing
 * side (a sell at or below it, a buy at or above it). A sell stop at 90 with a limit of 99 rests unfilled above a
 * falling market, so it protects nothing.
 */
export function stopCanFill(o: { isBuy: boolean; triggerPrice?: number | undefined; isMarket?: boolean | undefined; limitPrice?: number | undefined }): boolean {
  if (o.isMarket === true) return true;
  const t = o.triggerPrice;
  const l = o.limitPrice;
  if (t === undefined || l === undefined || !(t > 0) || !(l > 0)) return false;
  return o.isBuy ? l >= t : l <= t;
}

/** True when `o` is a stop-loss that counts toward the cover of `p` (see the module notes). */
function countsFor(p: AccountPosition, o: AccountOrder, maxDistancePct: number | undefined): boolean {
  const long = p.size > 0;
  if (o.coin !== p.coin || !o.isTrigger || o.tpsl !== "sl" || o.isBuy === long || !(o.reduceOnly || o.positionTpsl)) return false;
  const t = o.triggerPrice;
  if (t === undefined || !(t > 0) || !stopCanFill(o)) return false;
  if (maxDistancePct !== undefined) {
    if (!(p.entryPrice > 0)) return false;
    const lossPct = ((long ? p.entryPrice - t : t - p.entryPrice) / p.entryPrice) * 100;
    if (lossPct > maxDistancePct + 1e-9) return false;
  }
  return true;
}

/** How much of `p` (in coins, at most its size) the stop-losses among `orders` cover (see the module notes). */
export function coveredSize(p: AccountPosition, orders: readonly AccountOrder[], maxDistancePct: number | undefined): number {
  const need = Math.abs(p.size);
  if (!(need > 0)) return 0;
  let have = 0;
  for (const o of orders) {
    if (!countsFor(p, o, maxDistancePct)) continue;
    if (o.positionTpsl) return need;
    if (o.size > 0) have += o.size;
  }
  return Math.min(have, need);
}

/** True when the stop-losses among `orders` cover the whole of `p` (see the module notes). */
export function positionCovered(p: AccountPosition, orders: readonly AccountOrder[], maxDistancePct: number | undefined): boolean {
  const need = Math.abs(p.size);
  if (!(need > 0)) return true;
  return coveredSize(p, orders, maxDistancePct) >= need * (1 - 1e-9);
}

const within = (pct: number | undefined): string => (pct !== undefined ? ` within ${pct}% of its entry` : "");

/**
 * Why a cancel or modify (the exact wire action) would take stop-loss cover away from a position of `book`, one
 * message per position, or names an order that isn't in it; empty when it doesn't. A position fully covered before
 * must stay fully covered, and one partly covered must not lose any of its cover. Orders `exempt` accepts (by cloid:
 * a bot's own orders, where the policy lets bots trade without stops) may be cancelled or changed whatever cover they
 * give. Other action types have nothing to check.
 */
export function stopCoverageProblems(input: {
  action: { type: string } & Record<string, unknown>;
  book: AccountBook;
  registry: MarketRegistry;
  maxStopLossDistancePct?: number | undefined;
  exempt?: ((cloid: string | undefined) => boolean) | undefined;
}): string[] {
  const { action, book } = input;
  if (!STOP_COVERAGE_ACTION_TYPES.includes(action.type)) return [];
  const removed = new Set<number>();
  const replaced = new Map<number, AccountOrder>();
  const touched = new Set<string>();
  // Targets the caller may change freely, and named orders the book doesn't have.
  const free = new Set<number>();
  const closed = new Set((book.closed ?? []).map((r) => (typeof r === "string" ? r.toLowerCase() : r)));
  const missing: string[] = [];
  const coinOf = (asset: unknown): string | undefined => (typeof asset === "number" ? input.registry.getByAssetId(asset)?.coin : undefined);
  const named = (ref: unknown): number[] => {
    const hits = target(book.orders, ref);
    for (const i of hits) if (input.exempt?.(book.orders[i]!.cloid) === true) free.add(i);
    if (hits.length === 0) {
      const key = typeof ref === "string" ? ref.toLowerCase() : ref;
      const exempt = typeof key === "string" && input.exempt?.(key) === true;
      if ((typeof key === "number" || typeof key === "string") && !closed.has(key) && !exempt) missing.push(String(key));
    }
    return hits;
  };
  const cancels = (action.type === "cancel" || action.type === "cancelByCloid") && Array.isArray(action.cancels) ? (action.cancels as Array<Record<string, unknown>>) : [];
  for (const c of cancels) {
    const coin = coinOf(c.a ?? c.asset);
    if (coin !== undefined) touched.add(coin);
    for (const i of named(action.type === "cancel" ? c.o : c.cloid)) {
      removed.add(i);
      touched.add(book.orders[i]!.coin);
    }
  }
  const modifies =
    action.type === "modify" ? [{ oid: action.oid, order: action.order }] : action.type === "batchModify" && Array.isArray(action.modifies) ? (action.modifies as Array<{ oid?: unknown; order?: unknown }>) : [];
  for (const m of modifies) {
    const w = (typeof m.order === "object" && m.order !== null ? m.order : {}) as WireOrder;
    const coin = coinOf(w.a);
    if (coin !== undefined) touched.add(coin);
    const trigger = typeof w.t === "object" && w.t !== null ? w.t.trigger : undefined;
    for (const i of named(m.oid)) {
      const old = book.orders[i]!;
      touched.add(old.coin);
      const isBuy = w.b === true;
      const tpsl = trigger?.tpsl === "tp" || trigger?.tpsl === "sl" ? trigger.tpsl : undefined;
      const triggerPrice = trigger !== undefined ? Number(trigger.triggerPx) : undefined;
      const order: AccountOrder = {
        coin: coin ?? "",
        oid: old.oid,
        ...(old.cloid !== undefined ? { cloid: old.cloid } : {}),
        isBuy,
        size: Number(w.s),
        isTrigger: trigger !== undefined,
        ...(triggerPrice !== undefined ? { triggerPrice } : {}),
        ...(tpsl !== undefined ? { tpsl } : {}),
        reduceOnly: w.r === true,
        // A position TP/SL changed into another stop-loss on the same side stays one; anything else counts by its size.
        positionTpsl: old.positionTpsl && trigger !== undefined && tpsl === "sl" && w.r === true && isBuy === old.isBuy && coin === old.coin,
        isMarket: trigger?.isMarket === true,
        limitPrice: Number(w.p),
      };
      replaced.set(i, order);
    }
  }
  // Changes to free targets count as already made, so only the others are compared.
  const apply = (only?: ReadonlySet<number>) => book.orders.flatMap((o, i) => (only !== undefined && !only.has(i) ? [o] : removed.has(i) ? [] : [replaced.get(i) ?? o]));
  const before = apply(free);
  const after = apply();
  const problems: string[] = [];
  if (missing.length > 0) {
    const shown = missing.slice(0, 5).join(", ");
    problems.push(
      `${missing.length === 1 ? `Order ${shown} isn't` : `Orders ${shown}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""} aren't`} among the account's open orders on the markets this names, so the required stop-losses can't be checked; nothing is cancelled or changed.`,
    );
  }
  const max = input.maxStopLossDistancePct;
  for (const p of book.positions) {
    if (!touched.has(p.coin) || p.size === 0) continue;
    const had = coveredSize(p, before, max);
    const left = coveredSize(p, after, max);
    if (!(left < had - Math.abs(p.size) * 1e-9)) continue;
    problems.push(
      positionCovered(p, before, max)
        ? `This would leave the open ${p.coin} position without a stop-loss${max !== undefined ? ` within ${max}% of its entry` : ""}; place the new stop first.`
        : `This would leave less of the open ${p.coin} position covered by stop-losses${within(max)} than now; place the new stop first.`,
    );
  }
  return problems;
}

/** An order leg of an action, as {@link positionAfterEntriesProblem} reads it. */
export interface CoverageLeg {
  coin: string | undefined;
  isBuy: boolean;
  size: number;
  /** Limit price (undefined for market intents). */
  price: number | undefined;
  triggerPrice: number | undefined;
  isTrigger: boolean;
  tpsl?: "tp" | "sl";
  reduceOnly: boolean;
  isMarket?: boolean;
}

/**
 * Why the entries of an order action on `coin` would leave the position they add to only partly covered, or null when
 * they don't. The position is replayed as if every entry filled (at its limit or trigger, a market order at `mark`),
 * and must then be covered by the account's resting stop-losses together with the stop-losses the action places
 * itself. So an entry can't add to a position whose stops no longer cover it (an earlier stop left behind by a move of
 * the average entry, say), and two entries can't share one stop sized for one of them.
 */
export function positionAfterEntriesProblem(input: { coin: string; legs: readonly CoverageLeg[]; book: AccountBook; mark?: number | undefined; maxStopLossDistancePct?: number | undefined }): string | null {
  const { coin } = input;
  const pos = input.book.positions.find((p) => p.coin === coin);
  let size = pos?.size ?? 0;
  let entry = pos?.entryPrice ?? 0;
  for (const l of input.legs) {
    if (l.coin !== coin || l.reduceOnly) continue;
    const px = l.isTrigger ? l.triggerPrice : (l.price ?? input.mark);
    if (px === undefined || !(px > 0) || !(l.size > 0)) return `Cannot check the stop-losses of the ${coin} position without a price for this order.`;
    const delta = l.isBuy ? l.size : -l.size;
    const next = size + delta;
    if (size === 0 || Math.sign(size) === Math.sign(delta)) entry = (Math.abs(size) * entry + l.size * px) / Math.abs(next);
    else if (Math.sign(next) !== Math.sign(size)) entry = px;
    size = next;
  }
  const result: AccountPosition = { coin, size, entryPrice: entry };
  if (!(Math.abs(size) > 1e-12)) return null;
  const placed: AccountOrder[] = [];
  for (const l of input.legs) {
    if (l.coin !== coin || !l.reduceOnly || !l.isTrigger || l.tpsl !== "sl") continue;
    placed.push({
      coin,
      oid: -1 - placed.length,
      isBuy: l.isBuy,
      size: l.size,
      isTrigger: true,
      ...(l.triggerPrice !== undefined ? { triggerPrice: l.triggerPrice } : {}),
      tpsl: "sl",
      reduceOnly: true,
      positionTpsl: false,
      ...(l.isMarket !== undefined ? { isMarket: l.isMarket } : {}),
      ...(l.price !== undefined ? { limitPrice: l.price } : {}),
    });
  }
  const orders = [...input.book.orders, ...placed];
  if (positionCovered(result, orders, input.maxStopLossDistancePct)) return null;
  const fmt = (x: number) => String(Math.round(x * 1e8) / 1e8);
  return `Once this fills, the ${coin} position of ${fmt(Math.abs(size))} needs stop-losses${within(input.maxStopLossDistancePct)} for all of it; this order's stop and the resting ones cover ${fmt(coveredSize(result, orders, input.maxStopLossDistancePct))}. Place a stop for the rest first.`;
}
