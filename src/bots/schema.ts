/**
 * Bot configurations (valibot). Bots run on the server through the `kokoah-bot` automation key, inside the limits the
 * user signed (`policy/bots.ts` says which limits a bot needs). Every order still goes through the signer service's
 * policy check and carries the Kokoah builder fee.
 *
 * Four kinds:
 * - `grid`: limit orders on N price levels between a lower and an upper price; a filled order is answered by the
 *   opposite order one level away.
 * - `dca`: recurring market orders at an interval, optional safety orders on adverse moves and an optional take-profit
 *   on the average entry.
 * - `copy`: mirrors a leaderboard trader's position changes (seen by the follow poller) into the user's account.
 * - `signal`: turns TradingView (or other) webhook alerts into orders.
 * - `indicator`: reads the chart's indicators at every candle close (`indicatorRules.ts`) and alerts the user, trades
 *   like a signal bot, or both.
 *
 * All schemas are strict (unknown keys are rejected) except the webhook alert, which ignores extra fields so alert
 * templates may carry notes.
 *
 * @module
 */
import * as v from "valibot";
import { AddressSchema, CoinSchema } from "../intents/index.js";
import { MIN_ORDER_NOTIONAL_USD } from "../precision/index.js";
import { INDICATOR_TIMEFRAMES, indicatorRuleProblems, RulesSchema } from "./indicatorRules.js";

export const BOT_KINDS = ["grid", "dca", "copy", "signal", "indicator"] as const;
export type BotKind = (typeof BOT_KINDS)[number];

/** Bounds shared by the forms, the API and the planners. */
export const BOT_LIMITS = Object.freeze({
  gridMinLevels: 2,
  gridMaxLevels: 100,
  /** The upper price may be at most this multiple of the lower one. */
  gridMaxRangeRatio: 10,
  /** Each grid must be at least this wide (percent of its lower price). */
  gridMinStepPct: 0.1,
  maxLeverage: 50,
  maxOrderUsd: 1_000_000,
  maxTotalUsd: 10_000_000,
  dcaMinIntervalMinutes: 5,
  dcaMaxIntervalMinutes: 43_200,
  dcaMaxOrders: 10_000,
  dcaMaxSafetyOrders: 25,
  copyMinRatio: 0.0001,
  copyMaxRatio: 10,
  copyMaxCoins: 50,
  signalAlertIdMax: 100,
  /** Max slippage of the bots' market orders, percent (matches the default automation price band with room). */
  marketSlippagePct: 1,
});

const finite = v.pipe(v.number(), v.finite());
const Price = v.pipe(finite, v.gtValue(0, "Must be greater than zero"));
const Usd = (max: number) => v.pipe(finite, v.minValue(MIN_ORDER_NOTIONAL_USD, `Must be at least $${MIN_ORDER_NOTIONAL_USD}`), v.maxValue(max));
const Leverage = v.pipe(v.number(), v.integer("Must be a whole number"), v.minValue(1), v.maxValue(BOT_LIMITS.maxLeverage));
const CoinList = v.pipe(
  v.array(CoinSchema),
  v.maxLength(BOT_LIMITS.copyMaxCoins),
  v.check((a) => new Set(a).size === a.length, "Markets must be unique"),
);

// ---------------------------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------------------------

export const GRID_SPACINGS = ["arithmetic", "geometric"] as const;
export type GridSpacing = (typeof GRID_SPACINGS)[number];
/** neutral: starts flat (buys below, sells above open positions); long / short: first builds a position the grid sells / buys back. */
export const GRID_MODES = ["neutral", "long", "short"] as const;
export type GridMode = (typeof GRID_MODES)[number];

const GridObject = v.strictObject({
  kind: v.literal("grid"),
  coin: CoinSchema,
  lower: Price,
  upper: Price,
  /** Price lines, including the lower and upper price (levels − 1 grids). */
  levels: v.pipe(v.number(), v.integer(), v.minValue(BOT_LIMITS.gridMinLevels), v.maxValue(BOT_LIMITS.gridMaxLevels)),
  spacing: v.picklist(GRID_SPACINGS),
  mode: v.optional(v.picklist(GRID_MODES), "neutral"),
  /** Value of each grid order at the lower price (USD); every order has the same size in coins. */
  orderSizeUsd: Usd(BOT_LIMITS.maxOrderUsd),
  /** The bot places no entry that would take the account's exposure above this multiple of its equity. */
  maxLeverage: Leverage,
  /** Stop when the mark price reaches this price (outside the range). */
  stopLossPrice: v.optional(Price),
  /** Stop when the mark price reaches this price (outside the range, on the other side from the stop-loss). */
  takeProfitPrice: v.optional(Price),
  /** Stop when the mark price leaves the range. */
  stopOutOfRange: v.optional(v.boolean(), false),
  /** When a stop condition fires: close the bot's position (true) or keep it. Resting grid orders are always canceled. */
  closeOnStop: v.optional(v.boolean(), true),
});
export type GridBotConfig = v.InferOutput<typeof GridObject>;

/** Cross-field problems of a grid config (empty when valid). */
export function gridConfigProblems(c: Pick<GridBotConfig, "lower" | "upper" | "levels" | "spacing" | "stopLossPrice" | "takeProfitPrice">): string[] {
  const p: string[] = [];
  if (!(c.upper > c.lower)) {
    p.push("The upper price must be above the lower price.");
    return p;
  }
  if (c.upper / c.lower > BOT_LIMITS.gridMaxRangeRatio) p.push(`The upper price can be at most ${BOT_LIMITS.gridMaxRangeRatio}× the lower price.`);
  const stepPct = gridMinStepPct(c);
  if (stepPct < BOT_LIMITS.gridMinStepPct) p.push(`Each grid must be at least ${BOT_LIMITS.gridMinStepPct}% wide: use fewer levels or a wider range.`);
  const outside = (x: number) => x < c.lower || x > c.upper;
  if (c.stopLossPrice !== undefined && !outside(c.stopLossPrice)) p.push("The stop-loss price must be outside the range.");
  if (c.takeProfitPrice !== undefined && !outside(c.takeProfitPrice)) p.push("The take-profit price must be outside the range.");
  if (c.stopLossPrice !== undefined && c.takeProfitPrice !== undefined && c.stopLossPrice < c.lower === c.takeProfitPrice < c.lower) {
    p.push("The stop-loss and take-profit prices must be on opposite sides of the range.");
  }
  return p;
}

/** Width of the narrowest grid in percent of its lower price. */
export function gridMinStepPct(c: Pick<GridBotConfig, "lower" | "upper" | "levels" | "spacing">): number {
  if (!(c.upper > c.lower) || c.levels < 2) return 0;
  if (c.spacing === "geometric") return (Math.pow(c.upper / c.lower, 1 / (c.levels - 1)) - 1) * 100;
  const step = (c.upper - c.lower) / (c.levels - 1);
  return (step / (c.upper - step)) * 100;
}

export const GridBotConfigSchema = v.pipe(
  GridObject,
  v.rawCheck(({ dataset, addIssue }) => {
    if (dataset.typed) for (const message of gridConfigProblems(dataset.value)) addIssue({ message });
  }),
);

// ---------------------------------------------------------------------------------------------
// DCA
// ---------------------------------------------------------------------------------------------

const SafetyObject = v.strictObject({
  /** Number of safety orders. */
  count: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(BOT_LIMITS.dcaMaxSafetyOrders)),
  /** Distance between safety orders, percent of the cycle's first entry price. */
  stepPct: v.pipe(finite, v.minValue(0.1), v.maxValue(50)),
  /** Each safety order is this multiple of the previous one (the first is the recurring order size). */
  sizeMultiplier: v.pipe(finite, v.minValue(1), v.maxValue(5)),
  /** Cap on the value of all safety orders of a cycle together (USD); orders beyond it are not placed. */
  maxTotalUsd: Usd(BOT_LIMITS.maxTotalUsd),
});
export type DcaSafetyConfig = v.InferOutput<typeof SafetyObject>;

const DcaObject = v.strictObject({
  kind: v.literal("dca"),
  coin: CoinSchema,
  /** buy: accumulate a long; sell: accumulate a short. */
  side: v.picklist(["buy", "sell"]),
  orderSizeUsd: Usd(BOT_LIMITS.maxOrderUsd),
  intervalMinutes: v.pipe(v.number(), v.integer(), v.minValue(BOT_LIMITS.dcaMinIntervalMinutes), v.maxValue(BOT_LIMITS.dcaMaxIntervalMinutes)),
  /** Stop after this many recurring orders (safety orders not counted). Unlimited when omitted. */
  maxOrders: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(BOT_LIMITS.dcaMaxOrders))),
  maxLeverage: Leverage,
  safety: v.optional(SafetyObject),
  /** Close the cycle's position when the mark is this percent beyond the average entry. */
  takeProfitPct: v.optional(v.pipe(finite, v.minValue(0.1), v.maxValue(1000))),
});
export type DcaBotConfig = v.InferOutput<typeof DcaObject>;
export const DcaBotConfigSchema = DcaObject;

// ---------------------------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------------------------

export const CopySizingSchema = v.variant("mode", [
  /** Copy a fixed share of the trader's size changes (0.01 = 1%). */
  v.strictObject({ mode: v.literal("ratio"), ratio: v.pipe(finite, v.minValue(BOT_LIMITS.copyMinRatio), v.maxValue(BOT_LIMITS.copyMaxRatio)) }),
  /** Every open or add is copied with this value (USD); reduces and closes follow the trader proportionally. */
  v.strictObject({ mode: v.literal("fixed"), amountUsd: Usd(BOT_LIMITS.maxOrderUsd) }),
]);
export type CopySizing = v.InferOutput<typeof CopySizingSchema>;

const CopyObject = v.strictObject({
  kind: v.literal("copy"),
  /** The leaderboard trader to copy. */
  leader: AddressSchema,
  sizing: CopySizingSchema,
  /** Cap per copied order (USD). */
  maxOrderUsd: Usd(BOT_LIMITS.maxOrderUsd),
  /** Cap on the value of all copied positions together (USD); also the budget drawdowns are measured against. */
  maxTotalUsd: Usd(BOT_LIMITS.maxTotalUsd),
  maxLeverage: Leverage,
  /** Only these markets (all when omitted or empty). */
  allowCoins: v.optional(CoinList),
  /** Never these markets. */
  denyCoins: v.optional(CoinList),
  /** Stop copying when the copy's value falls this percent below its peak. */
  maxDrawdownPct: v.optional(v.pipe(finite, v.minValue(1), v.maxValue(100))),
  /** Stop copying when the copy loses this much in a UTC day (realized and unrealized, USD). */
  dailyLossLimitUsd: v.optional(v.pipe(finite, v.minValue(1), v.maxValue(BOT_LIMITS.maxTotalUsd))),
  /** When a loss limit stops the copy: close the copied positions (true) or keep them. */
  closeOnStop: v.optional(v.boolean(), true),
});
export type CopyBotConfig = v.InferOutput<typeof CopyObject>;

export function copyConfigProblems(c: Pick<CopyBotConfig, "maxOrderUsd" | "maxTotalUsd" | "allowCoins" | "denyCoins">): string[] {
  const p: string[] = [];
  if (c.maxTotalUsd < c.maxOrderUsd) p.push("The total cap must be at least the cap per order.");
  const both = (c.allowCoins ?? []).filter((x) => (c.denyCoins ?? []).includes(x));
  if (both.length) p.push(`A market can't be both allowed and denied: ${both.join(", ")}.`);
  return p;
}

export const CopyBotConfigSchema = v.pipe(
  CopyObject,
  v.rawCheck(({ dataset, addIssue }) => {
    if (dataset.typed) for (const message of copyConfigProblems(dataset.value)) addIssue({ message });
  }),
);

// ---------------------------------------------------------------------------------------------
// Signal (TradingView webhook)
// ---------------------------------------------------------------------------------------------

export const SIGNAL_DIRECTIONS = ["both", "long", "short"] as const;
export type SignalDirection = (typeof SIGNAL_DIRECTIONS)[number];

const SignalObject = v.strictObject({
  kind: v.literal("signal"),
  coin: CoinSchema,
  /** Value of an alert's order when the alert gives no size (USD). */
  orderSizeUsd: Usd(BOT_LIMITS.maxOrderUsd),
  /** Cap per order (USD). */
  maxOrderUsd: Usd(BOT_LIMITS.maxOrderUsd),
  /** Cap on the bot's position value (USD). */
  maxPositionUsd: Usd(BOT_LIMITS.maxTotalUsd),
  maxLeverage: Leverage,
  /** long: sells only reduce; short: buys only reduce. */
  direction: v.optional(v.picklist(SIGNAL_DIRECTIONS), "both"),
  /** Refuse alerts without a valid `X-Kokoah-Signature` (HMAC-SHA256 of the body with the bot's secret). */
  requireHmac: v.optional(v.boolean(), false),
});
export type SignalBotConfig = v.InferOutput<typeof SignalObject>;

export function signalConfigProblems(c: Pick<SignalBotConfig, "orderSizeUsd" | "maxOrderUsd" | "maxPositionUsd">): string[] {
  const p: string[] = [];
  if (c.orderSizeUsd > c.maxOrderUsd) p.push("The default order size can't be above the cap per order.");
  if (c.maxPositionUsd < c.maxOrderUsd) p.push("The position cap must be at least the cap per order.");
  return p;
}

export const SignalBotConfigSchema = v.pipe(
  SignalObject,
  v.rawCheck(({ dataset, addIssue }) => {
    if (dataset.typed) for (const message of signalConfigProblems(dataset.value)) addIssue({ message });
  }),
);

/** Actions an alert may ask for. long/short/flat are TradingView's `{{strategy.market_position}}` words. */
export const SIGNAL_ACTIONS = ["buy", "sell", "close", "long", "short", "flat"] as const;
export type SignalAction = (typeof SIGNAL_ACTIONS)[number];

const positive = v.pipe(v.union([finite, v.pipe(v.string(), v.trim(), v.regex(/^\d+(\.\d+)?$/, "Must be a number"), v.transform(Number))]), v.gtValue(0, "Must be greater than zero"));

/** One webhook alert. Extra fields are ignored. */
export const SignalAlertSchema = v.object({
  /** Unique per alert: a repeated id is answered from the log and never trades twice. */
  id: v.pipe(v.union([v.string(), v.pipe(finite, v.transform(String))]), v.trim(), v.minLength(1), v.maxLength(BOT_LIMITS.signalAlertIdMax)),
  action: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.picklist(SIGNAL_ACTIONS, "action must be buy, sell or close")),
  /** Order value in USD. */
  sizeUsd: v.optional(positive),
  /** Order size in coins (e.g. `{{strategy.order.contracts}}`); wins over sizeUsd. */
  size: v.optional(positive),
  orderType: v.optional(v.picklist(["market", "limit"]), "market"),
  /** Limit price (limit orders). */
  price: v.optional(positive),
  /** Only reduce the bot's position. */
  reduceOnly: v.optional(v.boolean(), false),
  /** When given it must name the bot's market (`BTC`, `BTCUSDT`, `BTCUSDT.P`, `BINANCE:BTCUSDT.P` all match BTC). */
  coin: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(80))),
});
export type SignalAlert = v.InferOutput<typeof SignalAlertSchema>;

// ---------------------------------------------------------------------------------------------
// Indicator signals (read at every candle close)
// ---------------------------------------------------------------------------------------------

/** `alert`: tells the user, trades nothing; `trade`: trades like a signal bot; `both`: trades and tells the user. */
export const INDICATOR_MODES = ["alert", "trade", "both"] as const;
export type IndicatorMode = (typeof INDICATOR_MODES)[number];

const IndicatorObject = v.strictObject({
  kind: v.literal("indicator"),
  coin: CoinSchema,
  timeframe: v.picklist(INDICATOR_TIMEFRAMES),
  mode: v.picklist(INDICATOR_MODES),
  rules: RulesSchema,
  /** Trading (mode `trade` or `both`), as a signal bot: the value of each order (USD). */
  orderSizeUsd: v.optional(Usd(BOT_LIMITS.maxOrderUsd)),
  maxOrderUsd: v.optional(Usd(BOT_LIMITS.maxOrderUsd)),
  maxPositionUsd: v.optional(Usd(BOT_LIMITS.maxTotalUsd)),
  maxLeverage: v.optional(Leverage),
  direction: v.optional(v.picklist(SIGNAL_DIRECTIONS), "both"),
});
export type IndicatorBotConfig = v.InferOutput<typeof IndicatorObject>;

/** Whether a bot trades (everything but an indicator bot that only alerts). */
export const botTrades = (c: BotConfig): boolean => c.kind !== "indicator" || c.mode !== "alert";

/** The signal-bot settings an indicator bot trades with (null when it only alerts or misses one). */
export function indicatorSignalConfig(c: IndicatorBotConfig): SignalBotConfig | null {
  if (c.mode === "alert" || c.orderSizeUsd === undefined || c.maxOrderUsd === undefined || c.maxPositionUsd === undefined || c.maxLeverage === undefined) return null;
  return { kind: "signal", coin: c.coin, orderSizeUsd: c.orderSizeUsd, maxOrderUsd: c.maxOrderUsd, maxPositionUsd: c.maxPositionUsd, maxLeverage: c.maxLeverage, direction: c.direction, requireHmac: false };
}

export function indicatorConfigProblems(c: IndicatorBotConfig): string[] {
  const p = indicatorRuleProblems(c.rules, c.timeframe);
  if (c.mode === "alert") return p;
  const missing = (["orderSizeUsd", "maxOrderUsd", "maxPositionUsd", "maxLeverage"] as const).filter((k) => c[k] === undefined);
  if (missing.length) p.push(`A bot that trades needs ${missing.join(", ")}.`);
  else p.push(...signalConfigProblems({ orderSizeUsd: c.orderSizeUsd!, maxOrderUsd: c.maxOrderUsd!, maxPositionUsd: c.maxPositionUsd! }));
  return p;
}

export const IndicatorBotConfigSchema = v.pipe(
  IndicatorObject,
  v.rawCheck(({ dataset, addIssue }) => {
    if (dataset.typed) for (const message of indicatorConfigProblems(dataset.value)) addIssue({ message });
  }),
);

// ---------------------------------------------------------------------------------------------
// Any bot
// ---------------------------------------------------------------------------------------------

export const BotConfigSchema = v.variant("kind", [GridBotConfigSchema, DcaBotConfigSchema, CopyBotConfigSchema, SignalBotConfigSchema, IndicatorBotConfigSchema]);
export type BotConfig = GridBotConfig | DcaBotConfig | CopyBotConfig | SignalBotConfig | IndicatorBotConfig;
export type BotConfigInput = v.InferInput<typeof BotConfigSchema>;

/** Thrown by {@link parseBotConfig}. */
export class BotConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(issues.join(" "));
    this.name = "BotConfigError";
    this.issues = issues;
  }
}

/** Validates a bot configuration; throws {@link BotConfigError} with plain-language issues. */
export function parseBotConfig(input: unknown): BotConfig {
  const r = v.safeParse(BotConfigSchema, input);
  if (!r.success) throw new BotConfigError(r.issues.map((i) => (v.getDotPath(i) ? `${v.getDotPath(i)}: ${i.message}` : i.message)));
  return r.output as BotConfig;
}

/** The markets a bot trades: its one coin, or a copy bot's allow list ("*" when it may copy any market); none for alerts. */
export function botCoins(c: BotConfig): "*" | string[] {
  if (c.kind === "copy") return c.allowCoins && c.allowCoins.length > 0 ? [...c.allowCoins] : "*";
  if (!botTrades(c)) return [];
  return [c.coin];
}
