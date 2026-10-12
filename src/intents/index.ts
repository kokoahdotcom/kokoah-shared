/**
 * Action intents: the structured, human-meaningful description of a trading action, before it is compiled into a
 * Hyperliquid wire action. Frontend tickets, guardians and AI proposals all produce intents; the signer frame and
 * signer service validate them, check policy, compile and sign.
 *
 * All schemas are strict (unknown keys are rejected). Decimal fields accept numbers or strings and are normalized
 * to decimal strings without trailing zeros. Hex fields (cloid, addresses) are lowercased.
 *
 * @module
 */
import * as v from "valibot";
import { isDecimal, normalizeDecimal } from "../precision/index.js";

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

/**
 * Where an intent came from:
 * - `manual`: the user's own ticket (browser key);
 * - `guardian`: a guardian rule on the server (automation key);
 * - `ai_ticket`: an AI-drafted order the user confirmed;
 * - `bot`: a grid, DCA, copy or signal bot on the server (automation key);
 * - `telegram`: an order the user confirmed in Telegram (automation key);
 * - `agent`: a trading agent the user connected under a signed per-agent mandate (policy format 3). The automation key
 *   signs its orders in the `each`/`envelope` modes; `each_in_app` orders are signed by the browser key.
 * New origins are appended, never reordered, so stored values and cloid tags keep their meaning.
 */
export const INTENT_ORIGINS = ["manual", "guardian", "ai_ticket", "bot", "telegram", "agent"] as const;
export type IntentOrigin = (typeof INTENT_ORIGINS)[number];

/** Order types supported by the ticket (FRONTEND_SPEC §9.1). */
export const ORDER_TYPES = ["market", "limit", "stopMarket", "stopLimit", "takeProfitMarket", "takeProfitLimit"] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

/** Limit time-in-force. */
export const TIFS = ["Gtc", "Ioc", "Alo"] as const;
export type Tif = (typeof TIFS)[number];

/** Maximum slippage for market orders in bps (10%). */
export const MAX_MARKET_SLIPPAGE_BPS = 1000;
/** Default slippage for market orders when an intent does not specify one: 1% (100 bps). */
export const DEFAULT_MARKET_SLIPPAGE_BPS = 100;

const decimalInput = v.union([v.string(), v.number()]);

/** Positive decimal (number or string in, normalized string out). */
export const PositiveDecimalSchema = v.pipe(
  decimalInput,
  v.check((x) => isDecimal(x), "Must be a decimal number"),
  v.transform((x) => normalizeDecimal(x)),
  v.check((x) => Number(x) > 0, "Must be greater than zero"),
);

/** Signed, non-zero decimal (number or string in, normalized string out). */
export const NonZeroDecimalSchema = v.pipe(
  decimalInput,
  v.check((x) => isDecimal(x), "Must be a decimal number"),
  v.transform((x) => normalizeDecimal(x)),
  v.check((x) => Number(x) !== 0, "Must not be zero"),
);

/** Client order id: `0x` + 32 hex characters, lowercased. */
export const CloidSchema = v.pipe(
  v.string(),
  v.regex(/^0x[0-9a-fA-F]{32}$/, "Cloid must be 0x followed by 32 hex characters"),
  v.transform((x) => x.toLowerCase() as `0x${string}`),
);

/** EVM address, lowercased. */
export const AddressSchema = v.pipe(
  v.string(),
  v.regex(/^0x[0-9a-fA-F]{40}$/, "Must be a 0x-prefixed 20-byte hex address"),
  v.transform((x) => x.toLowerCase() as `0x${string}`),
);

/** Coin name as used on HL (`BTC`, `xyz:SP500`, `@107`). Existence is checked against the registry at compile time. */
export const CoinSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(80), v.regex(/^\S+$/, "Coin must not contain whitespace"));

const OriginSchema = v.picklist(INTENT_ORIGINS);
const OidSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

/** Fields shared by every intent. */
const commonEntries = {
  origin: OriginSchema,
  /** Sub-account or vault to act for (`vaultAddress` on the request). Omit to act for the signer's master account. */
  vaultAddress: v.optional(AddressSchema),
};

// ---------------------------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------------------------

const TpslLegObject = v.strictObject({
  triggerPrice: PositiveDecimalSchema,
  /** Market TP/SL executes with HL's 10% slippage tolerance; limit uses `limitPrice`. */
  orderType: v.optional(v.picklist(["market", "limit"]), "market"),
  limitPrice: v.optional(PositiveDecimalSchema),
  cloid: v.optional(CloidSchema),
});

/** An attached take-profit or stop-loss leg. */
export const TpslLegSchema = v.pipe(
  TpslLegObject,
  v.check((leg) => (leg.orderType === "limit") === (leg.limitPrice !== undefined), "A limit TP/SL leg needs limitPrice; a market leg must not have one"),
);
export type TpslLeg = v.InferOutput<typeof TpslLegSchema>;

const OrderIntentObject = v.strictObject({
  kind: v.literal("order"),
  coin: CoinSchema,
  side: v.picklist(["buy", "sell"]),
  orderType: v.picklist(ORDER_TYPES),
  /** Size in coin units. */
  size: PositiveDecimalSchema,
  /** Limit price (limit, stopLimit, takeProfitLimit). */
  price: v.optional(PositiveDecimalSchema),
  /** Trigger price on mark (stop*, takeProfit*). */
  triggerPrice: v.optional(PositiveDecimalSchema),
  /** Limit orders only. Default "Gtc". */
  tif: v.optional(v.picklist(TIFS)),
  reduceOnly: v.optional(v.boolean(), false),
  /** Market orders only: max slippage from mid in bps (1–1000). Default {@link DEFAULT_MARKET_SLIPPAGE_BPS}. */
  slippageBps: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_MARKET_SLIPPAGE_BPS))),
  /** Attached take-profit (entry orders only; grouping `normalTpsl`, sized to this order, active after a full fill). */
  takeProfit: v.optional(TpslLegSchema),
  /** Attached stop-loss (entry orders only; grouping `normalTpsl`). */
  stopLoss: v.optional(TpslLegSchema),
  /** Trigger orders only: attach to the whole position (grouping `positionTpsl`). Requires reduceOnly. */
  positionTpsl: v.optional(v.boolean(), false),
  cloid: v.optional(CloidSchema),
  ...commonEntries,
});

type OrderIntentShape = v.InferOutput<typeof OrderIntentObject>;

/** Cross-field rules for orders. Returns a list of problems (empty when valid). */
export function orderIntentProblems(o: OrderIntentShape): string[] {
  const p: string[] = [];
  const isTrigger = o.orderType !== "market" && o.orderType !== "limit";
  const needsPrice = o.orderType === "limit" || o.orderType === "stopLimit" || o.orderType === "takeProfitLimit";
  if (needsPrice && o.price === undefined) p.push(`${o.orderType} orders need a price`);
  if (!needsPrice && o.price !== undefined) p.push(`${o.orderType} orders must not have a price`);
  if (isTrigger && o.triggerPrice === undefined) p.push(`${o.orderType} orders need a triggerPrice`);
  if (!isTrigger && o.triggerPrice !== undefined) p.push(`${o.orderType} orders must not have a triggerPrice`);
  if (o.tif !== undefined && o.orderType !== "limit") p.push("tif is only valid for limit orders");
  if (o.slippageBps !== undefined && o.orderType !== "market") p.push("slippageBps is only valid for market orders");
  const hasAttached = o.takeProfit !== undefined || o.stopLoss !== undefined;
  if (hasAttached && isTrigger) p.push("Attached TP/SL is only valid on market or limit entry orders");
  if (hasAttached && o.reduceOnly) p.push("Attached TP/SL is not valid on reduce-only orders");
  if (o.positionTpsl && (!isTrigger || !o.reduceOnly)) p.push("positionTpsl requires a reduce-only trigger order");
  const s = o.side === "buy" ? 1 : -1;
  if (o.stopLoss && o.orderType === "limit" && o.price !== undefined && s * (Number(o.price) - Number(o.stopLoss.triggerPrice)) <= 0) {
    p.push("Stop-loss trigger must be below the entry for a buy and above it for a sell");
  }
  if (o.takeProfit && o.orderType === "limit" && o.price !== undefined && s * (Number(o.takeProfit.triggerPrice) - Number(o.price)) <= 0) {
    p.push("Take-profit trigger must be above the entry for a buy and below it for a sell");
  }
  const cloids = [o.cloid, o.takeProfit?.cloid, o.stopLoss?.cloid].filter((c): c is `0x${string}` => c !== undefined);
  if (new Set(cloids).size !== cloids.length) p.push("cloids of the order and its TP/SL legs must be distinct");
  return p;
}

/** Order intent schema (market, limit, stop and take-profit orders, optional attached TP/SL). */
export const OrderIntentSchema = v.pipe(
  OrderIntentObject,
  v.rawCheck(({ dataset, addIssue }) => {
    if (dataset.typed) for (const message of orderIntentProblems(dataset.value)) addIssue({ message });
  }),
);
export type OrderIntent = v.InferOutput<typeof OrderIntentSchema>;
export type OrderIntentInput = v.InferInput<typeof OrderIntentSchema>;

// ---------------------------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------------------------

const CancelTargetSchema = v.union([
  v.strictObject({ coin: CoinSchema, oid: OidSchema }),
  v.strictObject({ coin: CoinSchema, cloid: CloidSchema }),
]);
export type CancelTarget = v.InferOutput<typeof CancelTargetSchema>;

const CancelIntentObject = v.strictObject({
  kind: v.literal("cancel"),
  /** Orders to cancel: all by `oid` or all by `cloid` (one wire action each). */
  cancels: v.pipe(v.array(CancelTargetSchema), v.minLength(1), v.maxLength(1000)),
  ...commonEntries,
});

function cancelProblems(c: v.InferOutput<typeof CancelIntentObject>): string[] {
  const byOid = c.cancels.filter((t) => "oid" in t).length;
  return byOid !== 0 && byOid !== c.cancels.length ? ["Cancel targets must all use oid or all use cloid"] : [];
}

/** Cancel by oid or by cloid. */
export const CancelIntentSchema = v.pipe(
  CancelIntentObject,
  v.rawCheck(({ dataset, addIssue }) => {
    if (dataset.typed) for (const message of cancelProblems(dataset.value)) addIssue({ message });
  }),
);
export type CancelIntent = v.InferOutput<typeof CancelIntentSchema>;
export type CancelIntentInput = v.InferInput<typeof CancelIntentSchema>;

// ---------------------------------------------------------------------------------------------
// Modify
// ---------------------------------------------------------------------------------------------

const ModifyOrderObject = v.strictObject({
  coin: CoinSchema,
  side: v.picklist(["buy", "sell"]),
  orderType: v.picklist(["limit", "stopMarket", "stopLimit", "takeProfitMarket", "takeProfitLimit"]),
  size: PositiveDecimalSchema,
  price: v.optional(PositiveDecimalSchema),
  triggerPrice: v.optional(PositiveDecimalSchema),
  tif: v.optional(v.picklist(TIFS)),
  reduceOnly: v.optional(v.boolean(), false),
  /** Cloid of the replacement order (set it to the original cloid to keep tracking the order by cloid). */
  cloid: v.optional(CloidSchema),
});

const ModifyIntentObject = v.strictObject({
  kind: v.literal("modify"),
  /** The resting order to modify. */
  target: v.union([v.strictObject({ oid: OidSchema }), v.strictObject({ cloid: CloidSchema })]),
  /** The full replacement order. */
  order: ModifyOrderObject,
  ...commonEntries,
});

/** Modify one resting order (compiled to HL `modify`). */
export const ModifyIntentSchema = v.pipe(
  ModifyIntentObject,
  v.rawCheck(({ dataset, addIssue }) => {
    if (!dataset.typed) return;
    const o = dataset.value.order;
    const problems = orderIntentProblems({ ...o, kind: "order", reduceOnly: o.reduceOnly, positionTpsl: false, origin: dataset.value.origin });
    for (const message of problems) addIssue({ message });
  }),
);
export type ModifyIntent = v.InferOutput<typeof ModifyIntentSchema>;
export type ModifyIntentInput = v.InferInput<typeof ModifyIntentSchema>;

// ---------------------------------------------------------------------------------------------
// Leverage, isolated margin, schedule cancel, noop
// ---------------------------------------------------------------------------------------------

/** Set leverage and margin mode for a market (the market's max is checked at compile time). */
export const UpdateLeverageIntentSchema = v.strictObject({
  kind: v.literal("updateLeverage"),
  coin: CoinSchema,
  leverage: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
  marginMode: v.picklist(["cross", "isolated"]),
  ...commonEntries,
});
export type UpdateLeverageIntent = v.InferOutput<typeof UpdateLeverageIntentSchema>;

/** Add (positive) or remove (negative) isolated margin, in USD (compiled to `ntli` = amount × 1e6). */
export const UpdateIsolatedMarginIntentSchema = v.strictObject({
  kind: v.literal("updateIsolatedMargin"),
  coin: CoinSchema,
  amountUsd: NonZeroDecimalSchema,
  ...commonEntries,
});
export type UpdateIsolatedMarginIntent = v.InferOutput<typeof UpdateIsolatedMarginIntentSchema>;

/** Dead-man's switch: cancel all open orders at `time` (ms, ≥ 5 s in the future). Omit `time` to clear it. */
export const ScheduleCancelIntentSchema = v.strictObject({
  kind: v.literal("scheduleCancel"),
  time: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  ...commonEntries,
});
export type ScheduleCancelIntent = v.InferOutput<typeof ScheduleCancelIntentSchema>;

/** No-op: burns a nonce (the documented way to invalidate an in-flight signed action). */
export const NoopIntentSchema = v.strictObject({
  kind: v.literal("noop"),
  ...commonEntries,
});
export type NoopIntent = v.InferOutput<typeof NoopIntentSchema>;

// ---------------------------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------------------------

const ActionIntentVariant = v.variant("kind", [
  OrderIntentObject,
  CancelIntentObject,
  ModifyIntentObject,
  UpdateLeverageIntentSchema,
  UpdateIsolatedMarginIntentSchema,
  ScheduleCancelIntentSchema,
  NoopIntentSchema,
]);

/** Discriminated union of every intent, with all cross-field rules applied. */
export const ActionIntentSchema = v.pipe(
  ActionIntentVariant,
  v.rawCheck(({ dataset, addIssue }) => {
    if (!dataset.typed) return;
    const x = dataset.value;
    let problems: string[] = [];
    if (x.kind === "order") problems = orderIntentProblems(x);
    else if (x.kind === "cancel") problems = cancelProblems(x);
    else if (x.kind === "modify") {
      problems = orderIntentProblems({ ...x.order, kind: "order", positionTpsl: false, origin: x.origin });
    }
    for (const message of problems) addIssue({ message });
  }),
);

/** Any validated intent. */
export type ActionIntent = v.InferOutput<typeof ActionIntentSchema>;
/** Input accepted by {@link parseActionIntent} (numbers allowed for decimals, defaults optional). */
export type ActionIntentInput = v.InferInput<typeof ActionIntentSchema>;
/** Intent discriminator values. */
export type ActionIntentKind = ActionIntent["kind"];

/** Thrown by {@link parseActionIntent} with a readable summary of all issues. */
export class IntentValidationError extends Error {
  readonly issues: ReadonlyArray<{ message: string; path?: string }>;
  constructor(issues: ReadonlyArray<{ message: string; path?: string }>) {
    super(`Invalid intent: ${issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ")}`);
    this.name = "IntentValidationError";
    this.issues = issues;
  }
}

/** Result of {@link safeParseActionIntent}. */
export type IntentParseResult =
  | { success: true; intent: ActionIntent }
  | { success: false; issues: Array<{ message: string; path?: string }> };

/** Validates and normalizes an intent without throwing. */
export function safeParseActionIntent(input: unknown): IntentParseResult {
  const r = v.safeParse(ActionIntentSchema, input);
  if (r.success) return { success: true, intent: r.output };
  return {
    success: false,
    issues: r.issues.map((i) => {
      const path = v.getDotPath(i);
      return path ? { message: i.message, path } : { message: i.message };
    }),
  };
}

/** Validates and normalizes an intent; throws {@link IntentValidationError}. */
export function parseActionIntent(input: unknown): ActionIntent {
  const r = safeParseActionIntent(input);
  if (!r.success) throw new IntentValidationError(r.issues);
  return r.intent;
}

/** True if the intent is a new entry that increases exposure (not reduce-only, not a cancel/modify). */
export function isEntryIntent(intent: ActionIntent): boolean {
  return intent.kind === "order" && !intent.reduceOnly;
}
