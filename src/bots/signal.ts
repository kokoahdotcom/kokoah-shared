/**
 * TradingView signal bot: one webhook alert → at most one order, within the bot's caps. The server checks the token
 * (and the HMAC when required), logs every alert, answers a repeated alert id from the log, and hands accepted alerts
 * to this planner.
 *
 * - `buy` / `long`, `sell` / `short`: an order in that direction. Size from `size` (coins), else `sizeUsd`, else the
 *   bot's `orderSizeUsd`; capped per order and so that the bot's position stays within `maxPositionUsd` and the
 *   account within `maxLeverage × equity`. A long-only bot's sells (a short-only bot's buys) only reduce.
 * - `close` / `flat`: closes the bot's position (reduce-only market).
 * - `reduceOnly: true`: the order may only reduce the bot's position.
 * - `orderType: "limit"` with `price` rests as GTC; otherwise a market (IOC) order.
 *
 * @module
 */
import { formatSize, MIN_ORDER_NOTIONAL_USD } from "../precision/index.js";
import type { SignalAlert, SignalBotConfig } from "./schema.js";
import { meetsMinimum, type PlannedOrder, tickPrice } from "./orders.js";

/** The JSON message to paste into a TradingView alert (placeholders are TradingView's). */
export function signalAlertTemplate(c: Pick<SignalBotConfig, "coin" | "orderSizeUsd">): string {
  return JSON.stringify(
    {
      id: "{{strategy.order.id}}-{{timenow}}",
      action: "{{strategy.order.action}}",
      coin: c.coin,
      sizeUsd: c.orderSizeUsd,
      orderType: "market",
    },
    null,
    2,
  );
}

/** True when an alert's `coin` names the bot's market (`BTC`, `BTCUSDT.P`, `BINANCE:BTCUSDT.P`, `BTC-PERP`…). */
export function signalCoinMatches(botCoin: string, alertCoin: string | undefined): boolean {
  if (alertCoin === undefined || alertCoin === "") return true;
  if (alertCoin === botCoin) return true;
  const base = (x: string) => {
    let t = x.trim().toUpperCase();
    // TradingView prefixes the exchange ("BINANCE:BTCUSDT.P"); HIP-3 coins keep their DEX when the bot's coin has one.
    const colon = t.lastIndexOf(":");
    if (colon >= 0 && !botCoin.includes(":")) t = t.slice(colon + 1);
    return t
      .replace(/\.P$/, "")
      .replace(/[-_/]?PERP$/, "")
      .replace(/[-_/]?(USDT|USDC|USD)$/, "");
  };
  return base(alertCoin) === base(botCoin);
}

export type SignalPlan = { ok: true; order: PlannedOrder; note: string } | { ok: false; reason: string };

export interface SignalPlanInput {
  config: SignalBotConfig;
  alert: SignalAlert;
  mark: number;
  szDecimals: number;
  /** The bot's position (signed size in coins). */
  position: number;
  /** The account's signed size in the bot's coin (all activity). */
  accountPosition: number;
  account: { equityUsd: number; totalNotionalUsd: number };
  cloid: `0x${string}`;
}

export function planSignal(input: SignalPlanInput): SignalPlan {
  const { config: c, alert, mark, szDecimals, position } = input;
  if (!signalCoinMatches(c.coin, alert.coin)) return { ok: false, reason: `The alert names ${alert.coin}, but this bot trades ${c.coin}.` };
  if (!(mark > 0)) return { ok: false, reason: `No price for ${c.coin} right now.` };
  const action = alert.action === "long" ? "buy" : alert.action === "short" ? "sell" : alert.action === "flat" ? "close" : alert.action;
  const base = { cloid: input.cloid, coin: c.coin };

  const closeAll = (label: string): SignalPlan => {
    if (position === 0) return { ok: false, reason: "Nothing to close: the bot has no position." };
    if (input.accountPosition === 0 || Math.sign(input.accountPosition) !== Math.sign(position)) {
      return { ok: false, reason: `The account's ${c.coin} position no longer matches the bot's.` };
    }
    const size = formatSize(Math.min(Math.abs(position), Math.abs(input.accountPosition)), szDecimals, "nearest");
    return {
      ok: true,
      order: { ...base, side: position > 0 ? "sell" : "buy", size, type: "market", reduceOnly: true, label },
      note: `Closing the bot's ${c.coin} ${position > 0 ? "long" : "short"}.`,
    };
  };
  if (action === "close") return closeAll("Signal close");

  const side = action as "buy" | "sell";
  const dir = side === "buy" ? 1 : -1;
  if (alert.orderType === "limit" && alert.price === undefined) return { ok: false, reason: "A limit alert needs a price." };
  let price: string | undefined;
  if (alert.orderType === "limit") {
    try {
      price = tickPrice(alert.price!, szDecimals, side === "buy" ? "down" : "up");
    } catch {
      return { ok: false, reason: "The alert's price is not valid for this market." };
    }
  }
  const px = price !== undefined ? Number(price) : mark;
  let wanted = alert.size !== undefined ? alert.size : (alert.sizeUsd ?? c.orderSizeUsd) / px;

  // Orders against the bot's position reduce it; a one-direction bot's orders against its direction only reduce.
  const reducing = position !== 0 && Math.sign(position) !== dir;
  const onlyReduce = alert.reduceOnly || (c.direction === "long" && side === "sell") || (c.direction === "short" && side === "buy");
  if (onlyReduce) {
    if (!reducing) {
      return { ok: false, reason: c.direction !== "both" && !alert.reduceOnly ? `This bot is ${c.direction}-only: nothing to reduce.` : "Reduce-only: the bot has nothing to reduce on this side." };
    }
    wanted = Math.min(wanted, Math.abs(position));
    if (wanted >= Math.abs(position) - 1e-12) return closeAll("Signal close");
    const size = formatSize(wanted, szDecimals, "down");
    if (!meetsMinimum(size, px)) return { ok: false, reason: `The order is below Hyperliquid's $${MIN_ORDER_NOTIONAL_USD} minimum (only a full close may be smaller).` };
    return {
      ok: true,
      order: { ...base, side, size, type: price ? "limit" : "market", ...(price ? { price } : {}), reduceOnly: true, label: "Signal reduce" },
      note: `Reducing the bot's ${c.coin} position by ${size}.`,
    };
  }

  // Caps: per order, the bot's position value, the account's leverage.
  const after = (s: number) => Math.abs(position + dir * s) * px;
  let size = Math.min(wanted, c.maxOrderUsd / px);
  if (after(size) > c.maxPositionUsd) {
    const room = c.maxPositionUsd / px - (reducing ? -Math.abs(position) : Math.abs(position));
    size = Math.max(0, Math.min(size, room));
  }
  const addedExposure = Math.max(0, Math.abs(position + dir * size) - Math.abs(position)) * px;
  const leverageRoom = c.maxLeverage * input.account.equityUsd - input.account.totalNotionalUsd;
  if (addedExposure > leverageRoom) {
    const reduced = reducing ? Math.abs(position) : 0;
    size = Math.max(0, Math.min(size, reduced + Math.max(0, leverageRoom) / px));
  }
  const text = formatSize(size, szDecimals, "down");
  if (!(Number(text) > 0) || !meetsMinimum(text, px)) {
    return { ok: false, reason: `After the bot's caps (per order, position ${fmt(c.maxPositionUsd)}, leverage ${c.maxLeverage}×) the order is below Hyperliquid's $${MIN_ORDER_NOTIONAL_USD} minimum.` };
  }
  // Capped by the caps, not by rounding to the market's size decimals.
  const capped = size < wanted * (1 - 1e-9);
  return {
    ok: true,
    order: { ...base, side, size: text, type: price ? "limit" : "market", ...(price ? { price } : {}), reduceOnly: false, label: `Signal ${side}` },
    note: `${side === "buy" ? "Buying" : "Selling"} ${text} ${c.coin}${price ? ` at ${price}` : ""}${capped ? " (capped by the bot's limits)" : ""}.`,
  };
}

function fmt(usd: number): string {
  return `$${usd.toLocaleString("en-US")}`;
}
