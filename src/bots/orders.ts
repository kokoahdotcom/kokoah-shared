/**
 * What bot planners return and how their orders become intents. Planners are pure: they get the bot's state, market
 * data and a view of the bot's own orders, and return new orders (with deterministic cloids), cancels, log notes and
 * an optional stop. The server's runner freezes the result, sends it through the signer service and records it.
 *
 * @module
 */
import { deriveCloid, type Cloid } from "../actions/cloid.js";
import type { ActionIntent } from "../intents/index.js";
import { formatSize, MIN_ORDER_NOTIONAL_USD, roundPriceToTick } from "../precision/index.js";
import { BOT_LIMITS } from "./schema.js";

/** An order a planner wants placed. */
export interface PlannedOrder {
  cloid: Cloid;
  coin: string;
  side: "buy" | "sell";
  /** Size in coins (wire string). */
  size: string;
  /** `limit` rests as GTC at `price`; `market` is an IOC within the bots' slippage. */
  type: "limit" | "market";
  price?: string;
  reduceOnly: boolean;
  /** What the order is for, as shown in the bot's order list ("Grid buy", "Safety order 2", "Copy open"). */
  label: string;
  /** Grid level, safety order number or the like. */
  level?: number;
}

/** The runner's view of one of the bot's orders. */
export interface BotOrderView {
  status: "pending" | "open" | "filled" | "canceled" | "rejected";
  size: number;
  filledSize: number;
}

/** Why a planner stopped the bot. */
export interface PlannerStop {
  reason: string;
  /** Close the bot's position (reduce-only) while stopping. Resting orders are always canceled. */
  closePosition: boolean;
  /** A normal end (a DCA that placed all its orders), not a stop condition. */
  finished?: boolean;
}

/** One planner step. */
export interface PlannerStep<S> {
  state: S;
  place: PlannedOrder[];
  /** Cloids of the bot's resting orders to cancel. */
  cancel: string[];
  /** Log lines (plain language). */
  notes: string[];
  stop?: PlannerStop;
}

/** Deterministic cloid of a bot's n-th order: retries of the same order are recognised by Hyperliquid. */
export function botCloid(botId: string, seq: number): Cloid {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new RangeError("seq must be a non-negative integer");
  return deriveCloid(`kokoah-bot:${botId}:${seq}`, "guardian");
}

/** Slippage of the bots' market orders in basis points. */
export const BOT_MARKET_SLIPPAGE_BPS = Math.round(BOT_LIMITS.marketSlippagePct * 100);

/** The intent the signer service checks and signs for a planned order (origin `guardian`: the automation key). */
export function plannedOrderIntent(order: PlannedOrder, vaultAddress?: string): ActionIntent {
  const base = {
    kind: "order" as const,
    origin: "guardian" as const,
    coin: order.coin,
    side: order.side,
    size: order.size,
    reduceOnly: order.reduceOnly,
    positionTpsl: false,
    cloid: order.cloid,
    ...(vaultAddress ? { vaultAddress: vaultAddress.toLowerCase() as `0x${string}` } : {}),
  };
  if (order.type === "limit") {
    if (order.price === undefined) throw new Error("A limit order needs a price");
    return { ...base, orderType: "limit", price: order.price, tif: "Gtc" };
  }
  return { ...base, orderType: "market", slippageBps: BOT_MARKET_SLIPPAGE_BPS };
}

/** A cancel-by-cloid intent for the bot's resting orders on one coin. */
export function botCancelIntent(coin: string, cloids: readonly string[], vaultAddress?: string): ActionIntent {
  return {
    kind: "cancel",
    origin: "guardian",
    cancels: cloids.map((cloid) => ({ coin, cloid: cloid.toLowerCase() as `0x${string}` })),
    ...(vaultAddress ? { vaultAddress: vaultAddress.toLowerCase() as `0x${string}` } : {}),
  };
}

/** Size in coins for a USD value at a price, rounded down to the market's size decimals ("0" when too small). */
export function sizeForUsd(usd: number, price: number, szDecimals: number, direction: "down" | "up" = "down"): string {
  if (!(usd > 0) || !(price > 0)) return "0";
  return formatSize(usd / price, szDecimals, direction);
}

/** True when `size × price` reaches Hyperliquid's minimum order value. */
export function meetsMinimum(size: string | number, price: number): boolean {
  return Number(size) * price >= MIN_ORDER_NOTIONAL_USD - 1e-9;
}

/** A price rounded to the market's tick (nearest, or in a direction). */
export function tickPrice(price: number, szDecimals: number, direction: "nearest" | "up" | "down" = "nearest"): string {
  return roundPriceToTick(price, szDecimals, "perp", direction);
}
