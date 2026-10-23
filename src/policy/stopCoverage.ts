/**
 * Stop coverage. With `requireStopLossForNewEntries` an entry needs a stop-loss when it opens; this keeps it there: a
 * cancel or modify must not leave a position that had a stop-loss without one. The signer reads the traded account's
 * positions and resting orders on Hyperliquid itself (never from the caller), and {@link stopCoverageProblems} replays
 * the action on them.
 *
 * A position is covered when its stop-loss orders (triggers with `tpsl` "sl" on the closing side, reduce-only or a
 * position TP/SL) cover its whole size, each within `maxStopLossDistancePct` of the entry price on the losing side
 * when the policy sets it (a stop at or past the entry, locking in profit, always counts). Only positions an action
 * touches are compared, and only coverage it takes away is refused: a position without a stop before stays allowed to
 * cancel and change its other orders.
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
}

/** Action types {@link stopCoverageProblems} checks: the ones that can take a resting stop away. */
export const STOP_COVERAGE_ACTION_TYPES: readonly string[] = Object.freeze(["cancel", "cancelByCloid", "modify", "batchModify"]);

type WireOrder = { a?: unknown; b?: unknown; s?: unknown; r?: unknown; t?: { trigger?: { triggerPx?: unknown; tpsl?: unknown } } };

const sameCloid = (a: string | undefined, b: unknown): boolean => a !== undefined && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/** The open order a cancel or modify names: by oid (a number) or cloid, whatever asset the action names (stricter). */
function target(orders: readonly AccountOrder[], ref: unknown): number[] {
  const out: number[] = [];
  orders.forEach((o, i) => {
    if (typeof ref === "number" ? o.oid === ref : sameCloid(o.cloid, ref)) out.push(i);
  });
  return out;
}

/** True when the stop-losses among `orders` cover `p` (see the module notes). */
export function positionCovered(p: AccountPosition, orders: readonly AccountOrder[], maxDistancePct: number | undefined): boolean {
  const long = p.size > 0;
  const need = Math.abs(p.size);
  if (!(need > 0)) return true;
  let have = 0;
  for (const o of orders) {
    if (o.coin !== p.coin || !o.isTrigger || o.tpsl !== "sl" || o.isBuy === long || !(o.reduceOnly || o.positionTpsl)) continue;
    const t = o.triggerPrice;
    if (t === undefined || !(t > 0)) continue;
    if (maxDistancePct !== undefined) {
      if (!(p.entryPrice > 0)) continue;
      const lossPct = ((long ? p.entryPrice - t : t - p.entryPrice) / p.entryPrice) * 100;
      if (lossPct > maxDistancePct + 1e-9) continue;
    }
    if (o.positionTpsl) return true;
    if (o.size > 0) have += o.size;
  }
  return have >= need * (1 - 1e-9);
}

/**
 * Why a cancel or modify (the exact wire action) would leave a position of `book` that had a stop-loss without one, one
 * message per position; empty when it doesn't. Other action types have nothing to check.
 */
export function stopCoverageProblems(input: { action: { type: string } & Record<string, unknown>; book: AccountBook; registry: MarketRegistry; maxStopLossDistancePct?: number | undefined }): string[] {
  const { action, book } = input;
  if (!STOP_COVERAGE_ACTION_TYPES.includes(action.type)) return [];
  const removed = new Set<number>();
  const replaced = new Map<number, AccountOrder>();
  const touched = new Set<string>();
  const coinOf = (asset: unknown): string | undefined => (typeof asset === "number" ? input.registry.getByAssetId(asset)?.coin : undefined);
  const cancels = (action.type === "cancel" || action.type === "cancelByCloid") && Array.isArray(action.cancels) ? (action.cancels as Array<Record<string, unknown>>) : [];
  for (const c of cancels) {
    const coin = coinOf(c.a ?? c.asset);
    if (coin !== undefined) touched.add(coin);
    for (const i of target(book.orders, action.type === "cancel" ? c.o : c.cloid)) {
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
    for (const i of target(book.orders, m.oid)) {
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
      };
      replaced.set(i, order);
    }
  }
  const after = book.orders.flatMap((o, i) => (removed.has(i) ? [] : [replaced.get(i) ?? o]));
  const problems: string[] = [];
  for (const p of book.positions) {
    if (!touched.has(p.coin) || p.size === 0) continue;
    if (positionCovered(p, book.orders, input.maxStopLossDistancePct) && !positionCovered(p, after, input.maxStopLossDistancePct)) {
      problems.push(
        input.maxStopLossDistancePct !== undefined
          ? `This would leave the open ${p.coin} position without a stop-loss within ${input.maxStopLossDistancePct}% of its entry; place the new stop first.`
          : `This would leave the open ${p.coin} position without a stop-loss; place the new stop first.`,
      );
    }
  }
  return problems;
}
