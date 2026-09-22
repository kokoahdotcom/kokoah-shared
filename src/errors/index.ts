/**
 * Hyperliquid error strings and order statuses → stable codes and plain-English messages
 * (FRONTEND_SPEC §9.10 table plus research A §7).
 *
 * Sources for the exact strings:
 * - Error responses table: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses
 * - Signing: "User or API Wallet 0x… does not exist." / "Must deposit before performing actions."
 *   (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing)
 * - Rate limit: "Too many cumulative requests sent (…)" (ccxt error map, research A §6); 1 request / 10 s when limited.
 * - "Order price cannot be more than 80% away from the reference price" (ccxt error map).
 * - "Invalid nonce" and "Multi-sig required" substrings (MetaMask perps controller).
 * - "Action already expired" (HL support FAQ).
 * - Order statuses: `orderStatus` / `orderUpdates` (`OrderProcessingStatus` in @nktkas/hyperliquid).
 *
 * @module
 */

/** Stable error codes. */
export type HlErrorCode =
  | "TICK_SIZE"
  | "MIN_TRADE_NOTIONAL"
  | "MIN_TRADE_SPOT_NOTIONAL"
  | "INSUFFICIENT_MARGIN"
  | "REDUCE_ONLY"
  | "POST_ONLY_WOULD_MATCH"
  | "IOC_NO_MATCH"
  | "BAD_TRIGGER_PRICE"
  | "NO_LIQUIDITY"
  | "OPEN_INTEREST_CAP"
  | "OPEN_INTEREST_INCREASE_TOO_FAST"
  | "INSUFFICIENT_SPOT_BALANCE"
  | "ORACLE_PRICE_BAND"
  | "REFERENCE_PRICE_BAND"
  | "MAX_POSITION"
  | "TOO_MANY_OPEN_ORDERS"
  | "INVALID_SIZE"
  | "ORDER_NOT_FOUND"
  | "SIBLING_FILLED"
  | "LIQUIDATED"
  | "SCHEDULED_CANCEL"
  | "SELF_TRADE"
  | "MARGIN_CANCELED"
  | "DELISTED"
  | "VAULT_WITHDRAWAL_CANCELED"
  | "OUTCOME_SETTLED"
  | "INTERNAL_CANCEL"
  | "USER_CANCELED"
  | "RATE_LIMITED"
  | "UNKNOWN_SIGNER"
  | "ACCOUNT_NOT_ACTIVATED"
  | "INVALID_NONCE"
  | "ACTION_EXPIRED"
  | "MULTI_SIG_REQUIRED"
  | "MALFORMED_REQUEST"
  | "UNKNOWN";

/** Plain-English description of an error code. */
export interface HlErrorInfo {
  code: HlErrorCode;
  /** Short title for toasts. */
  title: string;
  /** User-facing explanation (FRONTEND_SPEC §9.10 wording where it exists). */
  message: string;
  /** Whether retrying the same request unchanged may succeed. */
  retryable: boolean;
  category: "order" | "cancel" | "account" | "signing" | "rate_limit" | "request" | "unknown";
}

/** A mapped error: catalog entry plus the raw text and extracted details. */
export interface MappedHlError extends HlErrorInfo {
  raw: string;
  /** HL's error type name when known (e.g. "Tick", "MinTradeNtl"). */
  hlType?: string;
  details?: {
    /** Address in "User or API Wallet 0x… does not exist". If it differs on every attempt, suspect a signing bug. */
    address?: string;
    /** Suggested wait before the next action (rate limit). */
    waitSeconds?: number;
    /** Best bid/offer quoted in a BadAloPx error. */
    bbo?: string;
    /** Index of the order in a batch ("Order 2: …"). */
    orderIndex?: number;
  };
}

const I = (code: HlErrorCode, title: string, message: string, retryable: boolean, category: HlErrorInfo["category"]): HlErrorInfo => ({
  code,
  title,
  message,
  retryable,
  category,
});

/** Catalog of every code with its plain-English message. */
export const HL_ERROR_CATALOG: Readonly<Record<HlErrorCode, HlErrorInfo>> = Object.freeze({
  TICK_SIZE: I("TICK_SIZE", "Invalid price", "Price has too many digits for this market. Use the rounded price shown.", false, "order"),
  MIN_TRADE_NOTIONAL: I("MIN_TRADE_NOTIONAL", "Order too small", "Order value is below the $10 minimum.", false, "order"),
  MIN_TRADE_SPOT_NOTIONAL: I("MIN_TRADE_SPOT_NOTIONAL", "Order too small", "Order value is below the minimum of 10 units of the quote token.", false, "order"),
  INSUFFICIENT_MARGIN: I("INSUFFICIENT_MARGIN", "Not enough margin", "Not enough margin for this order.", false, "order"),
  REDUCE_ONLY: I("REDUCE_ONLY", "Reduce-only rejected", "Reduce-only order would increase or flip the position.", false, "order"),
  POST_ONLY_WOULD_MATCH: I("POST_ONLY_WOULD_MATCH", "Post-only rejected", "Post-only order would have executed immediately, so it was rejected.", false, "order"),
  IOC_NO_MATCH: I("IOC_NO_MATCH", "Not filled", "Market/IOC order found no liquidity within the slippage limit.", false, "order"),
  BAD_TRIGGER_PRICE: I("BAD_TRIGGER_PRICE", "Invalid trigger", "The take-profit or stop-loss trigger price is invalid.", false, "order"),
  NO_LIQUIDITY: I("NO_LIQUIDITY", "No liquidity", "No liquidity in this market right now.", false, "order"),
  OPEN_INTEREST_CAP: I("OPEN_INTEREST_CAP", "Market at capacity", "This market isn't accepting new positions right now (open-interest cap).", false, "order"),
  OPEN_INTEREST_INCREASE_TOO_FAST: I("OPEN_INTEREST_INCREASE_TOO_FAST", "Market busy", "This market isn't accepting new positions this quickly right now. Try again shortly.", true, "order"),
  INSUFFICIENT_SPOT_BALANCE: I("INSUFFICIENT_SPOT_BALANCE", "Not enough balance", "Not enough spot balance for this order.", false, "order"),
  ORACLE_PRICE_BAND: I("ORACLE_PRICE_BAND", "Price too far", "Price too far from the market's oracle price.", false, "order"),
  REFERENCE_PRICE_BAND: I("REFERENCE_PRICE_BAND", "Price too far", "Price is more than 80% away from the reference price.", false, "order"),
  MAX_POSITION: I("MAX_POSITION", "Position too large", "This order would make the position larger than allowed at the current leverage.", false, "order"),
  TOO_MANY_OPEN_ORDERS: I("TOO_MANY_OPEN_ORDERS", "Too many orders", "You have too many open orders. Cancel some and try again.", false, "order"),
  INVALID_SIZE: I("INVALID_SIZE", "Invalid size", "The order size is invalid for this market.", false, "order"),
  ORDER_NOT_FOUND: I("ORDER_NOT_FOUND", "Order not found", "The order was never placed, was already cancelled, or has filled.", false, "cancel"),
  SIBLING_FILLED: I("SIBLING_FILLED", "Cancelled", "Cancelled because the other side of the TP/SL pair filled.", false, "order"),
  LIQUIDATED: I("LIQUIDATED", "Cancelled", "Cancelled because the position was liquidated.", false, "order"),
  SCHEDULED_CANCEL: I("SCHEDULED_CANCEL", "Cancelled", "Cancelled by the safety timer (dead-man's switch).", false, "order"),
  SELF_TRADE: I("SELF_TRADE", "Cancelled", "Cancelled to prevent trading against yourself.", false, "order"),
  MARGIN_CANCELED: I("MARGIN_CANCELED", "Cancelled", "Cancelled because there was not enough margin.", false, "order"),
  DELISTED: I("DELISTED", "Cancelled", "Cancelled because the market was delisted.", false, "order"),
  VAULT_WITHDRAWAL_CANCELED: I("VAULT_WITHDRAWAL_CANCELED", "Cancelled", "Cancelled because of a vault withdrawal.", false, "order"),
  OUTCOME_SETTLED: I("OUTCOME_SETTLED", "Cancelled", "Cancelled because the outcome market settled.", false, "order"),
  INTERNAL_CANCEL: I("INTERNAL_CANCEL", "Cancelled", "Cancelled by the exchange.", false, "order"),
  USER_CANCELED: I("USER_CANCELED", "Cancelled", "Cancelled.", false, "order"),
  RATE_LIMITED: I("RATE_LIMITED", "Too many requests", "Too many requests for this account's trading volume. Wait about 10 seconds before the next action.", true, "rate_limit"),
  UNKNOWN_SIGNER: I("UNKNOWN_SIGNER", "Trading key not recognised", "Trading key is missing or expired; re-enable trading.", false, "signing"),
  ACCOUNT_NOT_ACTIVATED: I("ACCOUNT_NOT_ACTIVATED", "Account not activated", "This Hyperliquid account has no deposit yet. Deposit first, then try again.", false, "account"),
  INVALID_NONCE: I("INVALID_NONCE", "Signing conflict", "Temporary signing conflict (for example several open tabs); retry safely.", true, "signing"),
  ACTION_EXPIRED: I("ACTION_EXPIRED", "Expired", "The order took too long to reach the exchange and wasn't placed.", true, "request"),
  MULTI_SIG_REQUIRED: I("MULTI_SIG_REQUIRED", "Multi-sig account", "This account is a multi-sig account; actions need its multi-sig signers.", false, "account"),
  MALFORMED_REQUEST: I("MALFORMED_REQUEST", "Request rejected", "The exchange could not read the request.", false, "request"),
  UNKNOWN: I("UNKNOWN", "Rejected", "The exchange rejected the request.", false, "unknown"),
});

interface Rule {
  re: RegExp;
  code: HlErrorCode;
  hlType?: string;
}

// Order matters: first match wins.
const RULES: ReadonlyArray<Rule> = [
  { re: /price must be divisible by tick size/i, code: "TICK_SIZE", hlType: "Tick" },
  { re: /order must have minimum value of \$10/i, code: "MIN_TRADE_NOTIONAL", hlType: "MinTradeNtl" },
  { re: /order must have minimum value of 10 /i, code: "MIN_TRADE_SPOT_NOTIONAL", hlType: "MinTradeSpotNtl" },
  { re: /\bMinTradeNtl\b/, code: "MIN_TRADE_NOTIONAL", hlType: "MinTradeNtl" },
  { re: /\bMinTradeSpotNtl\b/, code: "MIN_TRADE_SPOT_NOTIONAL", hlType: "MinTradeSpotNtl" },
  { re: /insufficient margin to place order|\bPerpMargin\b/i, code: "INSUFFICIENT_MARGIN", hlType: "PerpMargin" },
  { re: /reduce only order would increase position|\bReduceOnly\b/i, code: "REDUCE_ONLY", hlType: "ReduceOnly" },
  { re: /post only order would have immediately matched|\bBadAloPx\b/i, code: "POST_ONLY_WOULD_MATCH", hlType: "BadAloPx" },
  { re: /could not immediately match against any resting orders|\bIocCancel\b/i, code: "IOC_NO_MATCH", hlType: "IocCancel" },
  { re: /invalid tp\/sl price|\bBadTriggerPx\b/i, code: "BAD_TRIGGER_PRICE", hlType: "BadTriggerPx" },
  { re: /no liquidity available for market order|\bMarketOrderNoLiquidity\b/i, code: "NO_LIQUIDITY", hlType: "MarketOrderNoLiquidity" },
  { re: /price more aggressive than oracle while at open interest cap|\bTooAggressiveAtOpenInterestCap\b/i, code: "OPEN_INTEREST_CAP", hlType: "TooAggressiveAtOpenInterestCap" },
  // Same text for PositionIncreaseAtOpenInterestCap and PositionFlipAtOpenInterestCap, so no hlType from the text.
  { re: /would increase open interest while open interest is capped/i, code: "OPEN_INTEREST_CAP" },
  { re: /\bPositionIncreaseAtOpenInterestCap\b/, code: "OPEN_INTEREST_CAP", hlType: "PositionIncreaseAtOpenInterestCap" },
  { re: /\bPositionFlipAtOpenInterestCap\b/, code: "OPEN_INTEREST_CAP", hlType: "PositionFlipAtOpenInterestCap" },
  { re: /would increase open interest too quickly|\bOpenInterestIncrease\b/i, code: "OPEN_INTEREST_INCREASE_TOO_FAST", hlType: "OpenInterestIncrease" },
  { re: /insufficient spot balance|\bInsufficientSpotBalance\b/i, code: "INSUFFICIENT_SPOT_BALANCE", hlType: "InsufficientSpotBalance" },
  { re: /price too far from oracle|^Oracle$/i, code: "ORACLE_PRICE_BAND", hlType: "Oracle" },
  { re: /more than 80% away from the reference price/i, code: "REFERENCE_PRICE_BAND" },
  { re: /exceed margin tier limit|\bPerpMaxPosition\b/i, code: "MAX_POSITION", hlType: "PerpMaxPosition" },
  { re: /too many open orders/i, code: "TOO_MANY_OPEN_ORDERS" },
  { re: /order has (invalid|zero) size/i, code: "INVALID_SIZE" },
  { re: /never placed, already canceled, or filled|\bMissingOrder\b|order not found/i, code: "ORDER_NOT_FOUND", hlType: "MissingOrder" },
  { re: /too many cumulative requests|rate limit/i, code: "RATE_LIMITED" },
  { re: /user or api wallet .* does not exist/i, code: "UNKNOWN_SIGNER" },
  { re: /must deposit before performing actions/i, code: "ACCOUNT_NOT_ACTIVATED" },
  { re: /invalid nonce|nonce too (low|high)|nonce.*(already used|duplicate)/i, code: "INVALID_NONCE" },
  { re: /already expired|action expired/i, code: "ACTION_EXPIRED" },
  { re: /multi-sig required/i, code: "MULTI_SIG_REQUIRED" },
  { re: /failed to deserialize|invalid json|unknown variant/i, code: "MALFORMED_REQUEST" },
];

/** Maps any HL error text (order status error, top-level `response`, or thrown message) to a stable code. */
export function mapHlError(raw: string): MappedHlError {
  const text = String(raw ?? "");
  const details: NonNullable<MappedHlError["details"]> = {};
  const idx = /^(?:order|cancel|modify)\s+(\d+):\s*/i.exec(text);
  if (idx) details.orderIndex = Number(idx[1]);
  const rule = RULES.find((r) => r.re.test(text));
  const code = rule?.code ?? "UNKNOWN";
  const addr = /user or api wallet (0x[0-9a-fA-F]{40})/i.exec(text) ?? /User: (0x[0-9a-fA-F]{40})/.exec(text);
  if (addr?.[1] && (code === "UNKNOWN_SIGNER" || code === "ACCOUNT_NOT_ACTIVATED")) details.address = addr[1].toLowerCase();
  if (code === "RATE_LIMITED") details.waitSeconds = 10;
  const bbo = /bbo was (.+?)\.?$/i.exec(text);
  if (bbo?.[1] && code === "POST_ONLY_WOULD_MATCH") details.bbo = bbo[1];
  const info = HL_ERROR_CATALOG[code];
  return {
    ...info,
    raw: text,
    ...(rule?.hlType !== undefined ? { hlType: rule.hlType } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Order statuses (orderStatus / orderUpdates / historicalOrders)
// ---------------------------------------------------------------------------------------------

/** Lifecycle bucket of an order status. */
export type OrderStatusKind = "open" | "filled" | "canceled" | "rejected" | "triggered" | "unknown";

/** Mapped order status. */
export interface OrderStatusInfo {
  status: string;
  kind: OrderStatusKind;
  /** True when the order will not change any more. */
  terminal: boolean;
  /** Error code for cancel/reject reasons; undefined for open/filled/triggered. */
  code?: HlErrorCode;
  message: string;
}

const STATUS_TABLE: Readonly<Record<string, { kind: OrderStatusKind; code?: HlErrorCode; message?: string }>> = {
  open: { kind: "open", message: "Order is resting on the book." },
  filled: { kind: "filled", message: "Order filled." },
  triggered: { kind: "triggered", message: "Trigger price reached; order sent." },
  canceled: { kind: "canceled", code: "USER_CANCELED" },
  rejected: { kind: "rejected", code: "UNKNOWN" },
  marginCanceled: { kind: "canceled", code: "MARGIN_CANCELED" },
  vaultWithdrawalCanceled: { kind: "canceled", code: "VAULT_WITHDRAWAL_CANCELED" },
  openInterestCapCanceled: { kind: "canceled", code: "OPEN_INTEREST_CAP" },
  selfTradeCanceled: { kind: "canceled", code: "SELF_TRADE" },
  reduceOnlyCanceled: { kind: "canceled", code: "REDUCE_ONLY" },
  siblingFilledCanceled: { kind: "canceled", code: "SIBLING_FILLED" },
  delistedCanceled: { kind: "canceled", code: "DELISTED" },
  liquidatedCanceled: { kind: "canceled", code: "LIQUIDATED" },
  outcomeSettledCanceled: { kind: "canceled", code: "OUTCOME_SETTLED" },
  scheduledCancel: { kind: "canceled", code: "SCHEDULED_CANCEL" },
  internalCancel: { kind: "canceled", code: "INTERNAL_CANCEL" },
  tickRejected: { kind: "rejected", code: "TICK_SIZE" },
  minTradeNtlRejected: { kind: "rejected", code: "MIN_TRADE_NOTIONAL" },
  perpMarginRejected: { kind: "rejected", code: "INSUFFICIENT_MARGIN" },
  reduceOnlyRejected: { kind: "rejected", code: "REDUCE_ONLY" },
  badAloPxRejected: { kind: "rejected", code: "POST_ONLY_WOULD_MATCH" },
  iocCancelRejected: { kind: "rejected", code: "IOC_NO_MATCH" },
  badTriggerPxRejected: { kind: "rejected", code: "BAD_TRIGGER_PRICE" },
  marketOrderNoLiquidityRejected: { kind: "rejected", code: "NO_LIQUIDITY" },
  positionIncreaseAtOpenInterestCapRejected: { kind: "rejected", code: "OPEN_INTEREST_CAP" },
  positionFlipAtOpenInterestCapRejected: { kind: "rejected", code: "OPEN_INTEREST_CAP" },
  tooAggressiveAtOpenInterestCapRejected: { kind: "rejected", code: "OPEN_INTEREST_CAP" },
  openInterestIncreaseRejected: { kind: "rejected", code: "OPEN_INTEREST_INCREASE_TOO_FAST" },
  insufficientSpotBalanceRejected: { kind: "rejected", code: "INSUFFICIENT_SPOT_BALANCE" },
  oracleRejected: { kind: "rejected", code: "ORACLE_PRICE_BAND" },
  perpMaxPositionRejected: { kind: "rejected", code: "MAX_POSITION" },
  tooManyOpenOrdersRejected: { kind: "rejected", code: "TOO_MANY_OPEN_ORDERS" },
};

/** Maps an HL order status string (e.g. "siblingFilledCanceled") to its bucket, code and message. */
export function mapOrderStatus(status: string): OrderStatusInfo {
  const row = STATUS_TABLE[status];
  if (!row) {
    const kind: OrderStatusKind = /Rejected$/.test(status) ? "rejected" : /Cancel(ed)?$/i.test(status) ? "canceled" : "unknown";
    return { status, kind, terminal: kind !== "unknown", ...(kind !== "unknown" ? { code: "UNKNOWN" as const } : {}), message: `Order status: ${status}` };
  }
  const message = row.message ?? (row.code ? HL_ERROR_CATALOG[row.code].message : status);
  return {
    status,
    kind: row.kind,
    terminal: row.kind !== "open" && row.kind !== "triggered",
    ...(row.code !== undefined ? { code: row.code } : {}),
    message,
  };
}

// ---------------------------------------------------------------------------------------------
// /exchange responses
// ---------------------------------------------------------------------------------------------

/** Per-order outcome from an order/modify response. */
export type OrderOutcome =
  | { kind: "resting"; oid: number; cloid?: string }
  | { kind: "filled"; oid: number; cloid?: string; totalSz: string; avgPx: string }
  | { kind: "waitingForFill" }
  | { kind: "waitingForTrigger" }
  | { kind: "success" }
  | { kind: "error"; error: MappedHlError };

/** Parsed `/exchange` response. */
export type ExchangeOutcome =
  | { ok: true; type: string; statuses: OrderOutcome[] }
  | { ok: false; error: MappedHlError };

/**
 * Parses an `/exchange` JSON body into per-order outcomes or a top-level error. Handles:
 * - `{"status":"err","response":"<text>"}` (unknown signer, rate limit, nonce, …);
 * - `{"status":"ok","response":{"type":…, "data":{"statuses":[…]}}}` with per-item `{error}`;
 * - pre-validation failures that return a single error for an n-order batch (the error is repeated for every
 *   expected order when `expectedCount` is given);
 * - `{"response":{"data":{"status":{"error":…}}}}` single-status shape.
 */
export function parseExchangeResponse(body: unknown, expectedCount?: number): ExchangeOutcome {
  if (typeof body === "string") return { ok: false, error: mapHlError(body) };
  if (typeof body !== "object" || body === null) return { ok: false, error: mapHlError("Empty response") };
  const b = body as { status?: unknown; response?: unknown };
  if (b.status === "err") return { ok: false, error: mapHlError(typeof b.response === "string" ? b.response : JSON.stringify(b.response)) };
  const resp = b.response as { type?: unknown; data?: { statuses?: unknown[]; status?: unknown } } | undefined;
  const type = typeof resp?.type === "string" ? resp.type : "default";
  const single = resp?.data?.status as { error?: unknown } | undefined;
  if (single && typeof single === "object" && typeof single.error === "string") return { ok: false, error: mapHlError(single.error) };
  const raw = Array.isArray(resp?.data?.statuses) ? resp.data.statuses : [];
  let statuses = raw.map(parseStatusItem);
  if (expectedCount !== undefined && expectedCount > 1 && statuses.length === 1 && statuses[0]?.kind === "error") {
    statuses = Array.from({ length: expectedCount }, () => statuses[0] as OrderOutcome);
  }
  return { ok: true, type, statuses };
}

function parseStatusItem(item: unknown): OrderOutcome {
  if (item === "waitingForFill") return { kind: "waitingForFill" };
  if (item === "waitingForTrigger") return { kind: "waitingForTrigger" };
  if (item === "success") return { kind: "success" };
  if (typeof item === "object" && item !== null) {
    const o = item as Record<string, Record<string, unknown> | string | undefined>;
    if (typeof o.error === "string") return { kind: "error", error: mapHlError(o.error) };
    const resting = o.resting as { oid?: number; cloid?: string } | undefined;
    if (resting && typeof resting.oid === "number") return { kind: "resting", oid: resting.oid, ...(resting.cloid ? { cloid: resting.cloid } : {}) };
    const filled = o.filled as { oid?: number; cloid?: string; totalSz?: string; avgPx?: string } | undefined;
    if (filled && typeof filled.oid === "number") {
      return { kind: "filled", oid: filled.oid, ...(filled.cloid ? { cloid: filled.cloid } : {}), totalSz: String(filled.totalSz), avgPx: String(filled.avgPx) };
    }
  }
  return { kind: "error", error: mapHlError(`Unrecognised status: ${JSON.stringify(item)}`) };
}
