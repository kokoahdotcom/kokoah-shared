/**
 * Intent → Hyperliquid wire action compiler.
 *
 * Every action is validated and key-ordered with **the SDK's own valibot schemas** (`@nktkas/hyperliquid/api/exchange`)
 * and `canonicalize` (`@nktkas/hyperliquid/signing`), so the msgpack bytes we hash are exactly what the SDK would sign:
 * order wires in `a, b, p, s, r, t, c` order, then `type, orders, grouping, builder`; lowercase hex; decimal strings
 * without trailing zeros; optional flags omitted rather than `false`.
 *
 * Rules (sources: HL exchange endpoint docs, TP/SL docs, research A §3.5):
 * - Market orders are IOC limit orders at mid ± slippage, rounded to a valid tick toward the mid so the price never
 *   exceeds the slippage tolerance (if that would not be marketable, one tick further).
 * - Market-type triggers (stopMarket, takeProfitMarket and market TP/SL legs) carry `isMarket: true` and a limit price
 *   at the trigger ± 10%, HL's documented market TP/SL slippage tolerance, or ± what `marketTriggerSlippageBps` gives
 *   (signers pass the policy's band, policy `marketTriggerSlippageFor`), rounded the same way (one tick further when
 *   rounding toward the trigger would land on it).
 * - Attached TP/SL legs use grouping `normalTpsl`: children are reduce-only, opposite side, same size as the parent.
 * - Sizes and prices must already be valid for the market (the UI shows the rounded values); the compiler rejects
 *   anything it would have to round, instead of silently signing a different number.
 * - The builder goes on every order action except a spot buy: Hyperliquid charges builder fees on spot sells only.
 *
 * @module
 */
import {
  CancelByCloidRequest,
  CancelRequest,
  ModifyRequest,
  NoopRequest,
  OrderRequest,
  ScheduleCancelRequest,
  UpdateIsolatedMarginRequest,
  UpdateLeverageRequest,
} from "@nktkas/hyperliquid/api/exchange";
import { canonicalize } from "@nktkas/hyperliquid/signing";
import * as v from "valibot";
import {
  type ActionIntent,
  type ActionIntentInput,
  DEFAULT_MARKET_SLIPPAGE_BPS,
  type IntentOrigin,
  type OrderIntent,
  parseActionIntent,
  type TpslLeg,
} from "../intents/index.js";
import type { MarketInfo, MarketRegistry } from "../markets/registry.js";
import { decAdd, decCompare, decMul, decToString, parseDec, type RoundingDirection } from "../precision/decimal.js";
import { checkPrice, formatSize, isValidSize, type PriceKind, roundPriceToTick } from "../precision/index.js";
import { MAX_PERP_BUILDER_FEE_TENTHS_BPS, MAX_SPOT_BUILDER_FEE_TENTHS_BPS } from "../risk/formulas.js";
import { type Cloid, generateCloid } from "./cloid.js";

// ---------------------------------------------------------------------------------------------
// Wire types (derived from the SDK schemas)
// ---------------------------------------------------------------------------------------------

export type HlOrderAction = v.InferOutput<typeof OrderRequest>["action"];
export type HlOrderWire = HlOrderAction["orders"][number];
export type HlCancelAction = v.InferOutput<typeof CancelRequest>["action"];
export type HlCancelByCloidAction = v.InferOutput<typeof CancelByCloidRequest>["action"];
export type HlModifyAction = v.InferOutput<typeof ModifyRequest>["action"];
export type HlUpdateLeverageAction = v.InferOutput<typeof UpdateLeverageRequest>["action"];
export type HlUpdateIsolatedMarginAction = v.InferOutput<typeof UpdateIsolatedMarginRequest>["action"];
export type HlScheduleCancelAction = v.InferOutput<typeof ScheduleCancelRequest>["action"];
export type HlNoopAction = v.InferOutput<typeof NoopRequest>["action"];

/** Every wire action the compiler can produce. */
export type HlAction =
  | HlOrderAction
  | HlCancelAction
  | HlCancelByCloidAction
  | HlModifyAction
  | HlUpdateLeverageAction
  | HlUpdateIsolatedMarginAction
  | HlScheduleCancelAction
  | HlNoopAction;

/** Builder code attached to every order action: `builder: {b, f}` with `f` in tenths of a basis point. */
export interface BuilderConfig {
  /** Builder address (lowercased on compile). */
  address: `0x${string}`;
  /** Fee in tenths of a bp (25 = 2.5 bps). Max 100 on perps, 1000 on spot. */
  feeTenthsBps: number;
}

/** Options for {@link compileAction}. */
export interface CompileOptions {
  registry: MarketRegistry;
  /** Builder attached to order actions. `null`/omitted means no builder field. */
  builder?: BuilderConfig | null;
  /** Mid price for market orders (e.g. from `allMids`). Required when compiling a market order. */
  getMidPrice?: (coin: string) => number | string | undefined;
  /** Cloid factory for orders without a cloid. Default: {@link generateCloid} tagged with the intent's origin. */
  newCloid?: (origin: IntentOrigin) => Cloid;
  /** Current time in ms; enables the `scheduleCancel` ≥ 5 s check. */
  now?: number;
  /**
   * The limit slippage (bps, an integer from 0 to {@link MARKET_TRIGGER_SLIPPAGE_BPS}) of each market-type trigger leg:
   * the parent of a stopMarket / takeProfitMarket order or modify, and market TP/SL legs. Default: 1000 (10%) for every
   * leg. Signers pass the slippage their policy allows (policy `marketTriggerSlippageFor`), so a trigger near the mark,
   * or one that isn't reduce-only, is limited to the policy's price band.
   */
  marketTriggerSlippageBps?: (leg: MarketTriggerLeg) => number;
}

/** A market-type trigger leg, as {@link CompileOptions.marketTriggerSlippageBps} sees it. */
export interface MarketTriggerLeg {
  coin: string;
  isBuy: boolean;
  reduceOnly: boolean;
  tpsl: "tp" | "sl";
  /** The trigger price as it will be signed. */
  triggerPrice: string;
}

/** A compiled action plus the metadata needed to sign, send and reconcile it. */
export interface CompiledAction<A extends HlAction = HlAction> {
  /** The wire action, in canonical key order. Sign this exact object. */
  action: A;
  /** `vaultAddress` for the request envelope (sub-account/vault), when the intent names one. */
  vaultAddress?: `0x${string}`;
  /** Cloids of the orders in the action, in wire order (parent first). */
  cloids: Cloid[];
  /** Market orders: the reference mid and the IOC limit price that was computed. */
  marketOrder?: { midPrice: string; limitPrice: string; slippageBps: number };
  /** The validated, normalized intent. */
  intent: ActionIntent;
}

/** Stable compile error codes. */
export type CompileErrorCode =
  | "INVALID_INTENT"
  | "UNKNOWN_MARKET"
  | "DELISTED_MARKET"
  | "SIZE_PRECISION"
  | "PRICE_PRECISION"
  | "MISSING_MID_PRICE"
  | "LEVERAGE_ABOVE_MAX"
  | "CROSS_NOT_ALLOWED"
  | "INVALID_BUILDER"
  | "MARGIN_PRECISION"
  | "SCHEDULE_TOO_SOON"
  | "SCHEDULE_TOO_FAR"
  | "UNSUPPORTED";

/** Thrown when an intent cannot be compiled. */
export class CompileError extends Error {
  readonly code: CompileErrorCode;
  constructor(code: CompileErrorCode, message: string) {
    super(message);
    this.name = "CompileError";
    this.code = code;
  }
}

/** HL's slippage tolerance for market TP/SL orders (10%), used as the limit price of market-type triggers. */
export const MARKET_TRIGGER_SLIPPAGE_BPS = 1000;
/** `scheduleCancel.time` must be at least 5 s in the future. */
export const SCHEDULE_CANCEL_MIN_LEAD_MS = 5000;
/**
 * …and at most 1 h: it cancels every open order, the user's own stop-losses included, so a far-off one signed by a
 * compromised app would go off long after anyone noticed.
 */
export const SCHEDULE_CANCEL_MAX_LEAD_MS = 3_600_000;

/**
 * Compiles an intent into the exact HL wire action.
 *
 * @throws {CompileError}
 */
export function compileAction(intentInput: ActionIntent | ActionIntentInput, options: CompileOptions): CompiledAction {
  let intent: ActionIntent;
  try {
    intent = parseActionIntent(intentInput);
  } catch (e) {
    throw new CompileError("INVALID_INTENT", e instanceof Error ? e.message : String(e));
  }
  const vault = intent.vaultAddress !== undefined ? { vaultAddress: intent.vaultAddress } : {};
  switch (intent.kind) {
    case "order":
      return { ...compileOrder(intent, options), ...vault, intent };
    case "cancel": {
      const byCloid = intent.cancels.every((c) => "cloid" in c);
      if (byCloid) {
        const raw = {
          type: "cancelByCloid" as const,
          cancels: intent.cancels.map((c) => ({ asset: marketFor(options.registry, c.coin, true).assetId, cloid: (c as { cloid: Cloid }).cloid })),
        };
        return { action: canonical(CancelByCloidRequest.entries.action, raw), cloids: [], ...vault, intent };
      }
      const raw = {
        type: "cancel" as const,
        cancels: intent.cancels.map((c) => ({ a: marketFor(options.registry, c.coin, true).assetId, o: (c as { oid: number }).oid })),
      };
      return { action: canonical(CancelRequest.entries.action, raw), cloids: [], ...vault, intent };
    }
    case "modify": {
      const o = intent.order;
      const market = marketFor(options.registry, o.coin, false);
      const wire = buildOrderWire({
        market,
        isBuy: o.side === "buy",
        size: o.size,
        orderType: o.orderType,
        price: o.price,
        triggerPrice: o.triggerPrice,
        tif: o.tif,
        reduceOnly: o.reduceOnly,
        cloid: o.cloid,
        slippage: options.marketTriggerSlippageBps,
      });
      const oid = "oid" in intent.target ? intent.target.oid : intent.target.cloid;
      const raw = { type: "modify" as const, oid, order: wire };
      return { action: canonical(ModifyRequest.entries.action, raw), cloids: o.cloid ? [o.cloid] : [], ...vault, intent };
    }
    case "updateLeverage": {
      const market = marketFor(options.registry, intent.coin, false);
      if (intent.leverage > market.maxLeverage) {
        throw new CompileError("LEVERAGE_ABOVE_MAX", `Leverage ${intent.leverage}x exceeds ${market.coin}'s maximum of ${market.maxLeverage}x`);
      }
      if (intent.marginMode === "cross" && market.onlyIsolated) {
        throw new CompileError("CROSS_NOT_ALLOWED", `${market.coin} is isolated-margin only`);
      }
      const raw = { type: "updateLeverage" as const, asset: market.assetId, isCross: intent.marginMode === "cross", leverage: intent.leverage };
      return { action: canonical(UpdateLeverageRequest.entries.action, raw), cloids: [], ...vault, intent };
    }
    case "updateIsolatedMargin": {
      const market = marketFor(options.registry, intent.coin, false);
      const micro = decMul(parseDec(intent.amountUsd), parseDec(1_000_000));
      if (micro.s !== 0) throw new CompileError("MARGIN_PRECISION", "Isolated margin amounts support at most 6 decimals");
      const ntli = Number(micro.m);
      if (!Number.isSafeInteger(ntli)) throw new CompileError("MARGIN_PRECISION", "Isolated margin amount is out of range");
      // `isBuy` has no effect ("until hedge mode"); the Python SDK always sends true.
      const raw = { type: "updateIsolatedMargin" as const, asset: market.assetId, isBuy: true, ntli };
      return { action: canonical(UpdateIsolatedMarginRequest.entries.action, raw), cloids: [], ...vault, intent };
    }
    case "scheduleCancel": {
      if (intent.time !== undefined && options.now !== undefined && intent.time < options.now + SCHEDULE_CANCEL_MIN_LEAD_MS) {
        throw new CompileError("SCHEDULE_TOO_SOON", "scheduleCancel time must be at least 5 seconds in the future");
      }
      if (intent.time !== undefined && options.now !== undefined && intent.time > options.now + SCHEDULE_CANCEL_MAX_LEAD_MS) {
        throw new CompileError("SCHEDULE_TOO_FAR", "scheduleCancel time must be at most 1 hour in the future");
      }
      const raw = intent.time === undefined ? { type: "scheduleCancel" as const } : { type: "scheduleCancel" as const, time: intent.time };
      return { action: canonical(ScheduleCancelRequest.entries.action, raw), cloids: [], ...vault, intent };
    }
    case "noop":
      return { action: canonical(NoopRequest.entries.action, { type: "noop" as const }), cloids: [], ...vault, intent };
  }
}

// ---------------------------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------------------------

function compileOrder(intent: OrderIntent, options: CompileOptions): Omit<CompiledAction<HlOrderAction>, "intent" | "vaultAddress"> {
  const market = marketFor(options.registry, intent.coin, false);
  const newCloid = options.newCloid ?? ((origin: IntentOrigin) => generateCloid(origin));
  const isBuy = intent.side === "buy";
  const parentCloid = intent.cloid ?? newCloid(intent.origin);
  let marketOrder: CompiledAction["marketOrder"];

  let parent: RawOrderWire;
  if (intent.orderType === "market") {
    const midRaw = options.getMidPrice?.(intent.coin);
    if (midRaw === undefined) throw new CompileError("MISSING_MID_PRICE", `No mid price for ${intent.coin}; market orders need one`);
    const slippageBps = intent.slippageBps ?? DEFAULT_MARKET_SLIPPAGE_BPS;
    const limitPrice = marketOrderLimitPrice({ midPrice: midRaw, isBuy, slippageBps, szDecimals: market.szDecimals, priceKind: market.priceKind });
    marketOrder = { midPrice: decToString(parseDec(midRaw)), limitPrice, slippageBps };
    parent = {
      a: market.assetId,
      b: isBuy,
      p: limitPrice,
      s: requireSize(intent.size, market),
      r: intent.reduceOnly,
      t: { limit: { tif: "Ioc" } },
      c: parentCloid,
    };
  } else {
    parent = buildOrderWire({
      market,
      isBuy,
      size: intent.size,
      orderType: intent.orderType,
      price: intent.price,
      triggerPrice: intent.triggerPrice,
      tif: intent.tif,
      reduceOnly: intent.reduceOnly,
      cloid: parentCloid,
      slippage: options.marketTriggerSlippageBps,
    });
  }

  const orders: RawOrderWire[] = [parent];
  const cloids: Cloid[] = [parentCloid];
  const legs: Array<[TpslLeg | undefined, "tp" | "sl"]> = [
    [intent.takeProfit, "tp"],
    [intent.stopLoss, "sl"],
  ];
  for (const [leg, tpsl] of legs) {
    if (!leg) continue;
    const legCloid = leg.cloid ?? newCloid(intent.origin);
    orders.push(
      buildOrderWire({
        market,
        isBuy: !isBuy,
        size: intent.size,
        orderType: leg.orderType === "limit" ? (tpsl === "tp" ? "takeProfitLimit" : "stopLimit") : tpsl === "tp" ? "takeProfitMarket" : "stopMarket",
        price: leg.limitPrice,
        triggerPrice: leg.triggerPrice,
        tif: undefined,
        reduceOnly: true,
        cloid: legCloid,
        slippage: options.marketTriggerSlippageBps,
      }),
    );
    cloids.push(legCloid);
  }
  const grouping = orders.length > 1 ? "normalTpsl" : intent.positionTpsl ? "positionTpsl" : "na";
  // Hyperliquid charges builder fees on spot sells only, so a spot buy carries no builder field.
  const builder = market.kind === "spot" && isBuy ? undefined : resolveBuilder(options.builder, market);
  const raw = { type: "order" as const, orders, grouping, ...(builder ? { builder } : {}) };
  const action = canonical(OrderRequest.entries.action, raw);
  return marketOrder ? { action, cloids, marketOrder } : { action, cloids };
}

interface RawOrderWire {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: "Gtc" | "Ioc" | "Alo" } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } };
  c?: Cloid;
}

/** Builds one non-market order wire (limit or trigger). */
function buildOrderWire(o: {
  market: MarketInfo;
  isBuy: boolean;
  size: string;
  orderType: "limit" | "stopMarket" | "stopLimit" | "takeProfitMarket" | "takeProfitLimit" | "market";
  price: string | undefined;
  triggerPrice: string | undefined;
  tif: "Gtc" | "Ioc" | "Alo" | undefined;
  reduceOnly: boolean;
  cloid: Cloid | undefined;
  /** The market trigger's limit slippage (see {@link CompileOptions.marketTriggerSlippageBps}). */
  slippage?: ((leg: MarketTriggerLeg) => number) | undefined;
}): RawOrderWire {
  const { market } = o;
  const s = requireSize(o.size, market);
  let p: string;
  let t: RawOrderWire["t"];
  switch (o.orderType) {
    case "limit":
      p = requirePrice(o.price, market, "price");
      t = { limit: { tif: o.tif ?? "Gtc" } };
      break;
    case "stopMarket":
    case "takeProfitMarket": {
      const triggerPx = requirePrice(o.triggerPrice, market, "triggerPrice");
      const tpsl = o.orderType === "stopMarket" ? "sl" : "tp";
      const slippageBps = o.slippage ? o.slippage({ coin: market.coin, isBuy: o.isBuy, reduceOnly: o.reduceOnly, tpsl, triggerPrice: triggerPx }) : MARKET_TRIGGER_SLIPPAGE_BPS;
      p = marketTriggerLimitPrice({ triggerPrice: triggerPx, isBuy: o.isBuy, szDecimals: market.szDecimals, priceKind: market.priceKind, slippageBps });
      t = { trigger: { isMarket: true, triggerPx, tpsl } };
      break;
    }
    case "stopLimit":
    case "takeProfitLimit": {
      const triggerPx = requirePrice(o.triggerPrice, market, "triggerPrice");
      p = requirePrice(o.price, market, "price");
      t = { trigger: { isMarket: false, triggerPx, tpsl: o.orderType === "stopLimit" ? "sl" : "tp" } };
      break;
    }
    case "market":
      throw new CompileError("UNSUPPORTED", "Market orders cannot be used here (modify requires a limit or trigger order)");
  }
  const wire: RawOrderWire = { a: market.assetId, b: o.isBuy, p, s, r: o.reduceOnly, t };
  if (o.cloid !== undefined) wire.c = o.cloid;
  return wire;
}

/**
 * IOC limit price for a market order: `mid × (1 ± slippage)`, rounded to a valid tick toward the mid (buy: down,
 * sell: up) so the order never exceeds the tolerance; if that rounding would make the price no better than mid, the
 * other direction is used so the order stays marketable. Exact decimal arithmetic.
 */
export function marketOrderLimitPrice(input: {
  midPrice: number | string;
  isBuy: boolean;
  slippageBps: number;
  szDecimals: number;
  priceKind?: PriceKind;
}): string {
  const kind = input.priceKind ?? "perp";
  const mid = parseDec(input.midPrice);
  if (mid.m <= 0n) throw new CompileError("MISSING_MID_PRICE", "Mid price must be positive");
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > 10_000) {
    throw new RangeError("slippageBps must be an integer between 0 and 10000");
  }
  const factor = parseDec(`${10_000 + (input.isBuy ? input.slippageBps : -input.slippageBps)}e-4`);
  const raw = decToString(decMul(mid, factor));
  const toward: RoundingDirection = input.isBuy ? "down" : "up";
  const away: RoundingDirection = input.isBuy ? "up" : "down";
  try {
    let px = roundPriceToTick(raw, input.szDecimals, kind, toward);
    const cmp = decCompare(parseDec(px), mid);
    // When the tick is coarser than the tolerance, rounding toward mid lands on (or past) mid; use one tick away so
    // the IOC stays marketable. This can exceed the tolerance by up to one tick.
    if (input.slippageBps > 0 && (input.isBuy ? cmp <= 0 : cmp >= 0)) px = roundPriceToTick(raw, input.szDecimals, kind, away);
    return px;
  } catch (e) {
    throw new CompileError("PRICE_PRECISION", `Cannot derive a market order price from mid ${String(input.midPrice)}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Limit price for a market-type trigger: trigger ± `slippageBps` (default 1000, HL's 10% market TP/SL tolerance),
 * rounded to a valid tick toward the trigger (buy: down, sell: up). Same rule as {@link marketOrderLimitPrice}: when the
 * tick is coarser than the tolerance, so that rounding toward the trigger lands on (or past) it, the price is rounded
 * one tick away instead, so the order keeps room to fill. This can exceed the tolerance by up to one tick (a policy
 * that allows less refuses it). A sell already at the smallest positive tick has no lower price and keeps it.
 */
export function marketTriggerLimitPrice(input: { triggerPrice: number | string; isBuy: boolean; szDecimals: number; priceKind?: PriceKind; slippageBps?: number }): string {
  const kind = input.priceKind ?? "perp";
  const slippageBps = input.slippageBps ?? MARKET_TRIGGER_SLIPPAGE_BPS;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MARKET_TRIGGER_SLIPPAGE_BPS) {
    throw new RangeError(`slippageBps must be an integer between 0 and ${MARKET_TRIGGER_SLIPPAGE_BPS}`);
  }
  const trig = parseDec(input.triggerPrice);
  const delta = decMul(trig, parseDec(`${slippageBps}e-4`));
  const raw = decToString(input.isBuy ? decAdd(trig, delta) : decAdd(trig, { m: -delta.m, s: delta.s }));
  const px = roundPriceToTick(raw, input.szDecimals, kind, input.isBuy ? "down" : "up");
  const cmp = decCompare(parseDec(px), trig);
  if (input.isBuy ? cmp > 0 : cmp < 0) return px;
  try {
    return roundPriceToTick(raw, input.szDecimals, kind, input.isBuy ? "up" : "down");
  } catch {
    // A sell whose price rounds down to zero: the smallest positive tick is already the lowest price there is.
    return px;
  }
}

function requireSize(size: string, market: MarketInfo): string {
  if (!isValidSize(size, market.szDecimals)) {
    const rounded = formatSize(size, market.szDecimals, "down");
    throw new CompileError(
      "SIZE_PRECISION",
      `Size ${size} is not valid for ${market.coin} (szDecimals=${market.szDecimals})${rounded !== "0" ? `; use ${rounded}` : "; it is smaller than one lot"}`,
    );
  }
  return size;
}

function requirePrice(price: string | undefined, market: MarketInfo, field: string): string {
  if (price === undefined) throw new CompileError("PRICE_PRECISION", `Missing ${field}`);
  const check = checkPrice(price, market.szDecimals, market.priceKind);
  if (!check.valid) {
    throw new CompileError(
      "PRICE_PRECISION",
      `${field} ${price} is not a valid ${market.coin} price (${check.reason})${check.suggestion !== undefined ? `; nearest valid price is ${check.suggestion}` : ""}`,
    );
  }
  return check.normalized;
}

function marketFor(registry: MarketRegistry, coin: string, allowDelisted: boolean): MarketInfo {
  const v = registry.validateCoin(coin);
  if (v.ok) return v.market;
  if (v.reason === "delisted" && v.market) {
    if (allowDelisted) return v.market;
    throw new CompileError("DELISTED_MARKET", `${coin} is delisted`);
  }
  throw new CompileError("UNKNOWN_MARKET", v.message);
}

function resolveBuilder(builder: BuilderConfig | null | undefined, market: MarketInfo): { b: `0x${string}`; f: number } | undefined {
  if (!builder) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(builder.address)) throw new CompileError("INVALID_BUILDER", "Builder address must be a 20-byte hex address");
  const max = market.kind === "spot" ? MAX_SPOT_BUILDER_FEE_TENTHS_BPS : MAX_PERP_BUILDER_FEE_TENTHS_BPS;
  if (!Number.isInteger(builder.feeTenthsBps) || builder.feeTenthsBps < 0 || builder.feeTenthsBps > max) {
    throw new CompileError("INVALID_BUILDER", `Builder fee must be an integer between 0 and ${max} tenths of a bp`);
  }
  return { b: builder.address.toLowerCase() as `0x${string}`, f: builder.feeTenthsBps };
}

/** Parse with the SDK schema (normalizes decimals, lowercases hex, applies defaults) and reorder keys canonically. */
function canonical<S extends v.GenericSchema>(schema: S, raw: unknown): v.InferOutput<S> {
  const parsed = v.parse(schema, raw);
  return canonicalize(schema, parsed);
}
