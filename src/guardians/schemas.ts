/**
 * Guardian rule definitions (FRONTEND_SPEC §14.2). Types and valibot schemas only; the backend runs the engine and
 * persists `state` between evaluations. Pure evaluation lives in `evaluate.ts`.
 *
 * @module
 */
import * as v from "valibot";
import { AddressSchema, CloidSchema, CoinSchema, orderIntentProblems, PositiveDecimalSchema, TIFS } from "../intents/index.js";

/** Guardian rule types. */
export const GUARDIAN_RULE_TYPES = [
  "protectPartialFills",
  "breakeven",
  "takeProfitLadder",
  "trailingStop",
  "timeExit",
  "ocoEntries",
  "conditional",
  "liquidationGuard",
  "dailyLossLock",
] as const;
export type GuardianRuleType = (typeof GUARDIAN_RULE_TYPES)[number];

/** Rule status shown in the guardian list (FRONTEND_SPEC §14.1). */
export const GUARDIAN_STATUSES = ["armed", "triggered", "completed", "paused", "failed", "expired"] as const;
export type GuardianStatus = (typeof GUARDIAN_STATUSES)[number];

/** Candle intervals supported by HL `candleSnapshot` / `candle`. */
export const CANDLE_INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M"] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

const Pct = v.pipe(v.number(), v.gtValue(0), v.maxValue(100));
const Bps = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1000));
const Ms = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const Side = v.picklist(["buy", "sell"]);
const PositionSideSchema = v.picklist(["long", "short"]);

/** Fields shared by every rule. */
const base = {
  /** Stable id (used to derive deterministic cloids). */
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  status: v.optional(v.picklist(GUARDIAN_STATUSES), "armed"),
  /** Who authored the rule (FRONTEND_SPEC §14.1 "created by (manual or AI-assisted)"). */
  createdBy: v.optional(v.picklist(["manual", "ai_assisted"]), "manual"),
  createdAt: Ms,
  /** Rule stops acting (status "expired") at this time. */
  expiresAt: v.optional(Ms),
  /** Sub-account/vault the rule trades for. */
  vaultAddress: v.optional(AddressSchema),
  /** Market-order slippage for orders the rule sends, in bps. Default 100. */
  slippageBps: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))),
};

/** Stop or take-profit leg a rule places. */
export const RuleLegSchema = v.pipe(
  v.strictObject({
    triggerPrice: PositiveDecimalSchema,
    orderType: v.optional(v.picklist(["market", "limit"]), "market"),
    limitPrice: v.optional(PositiveDecimalSchema),
  }),
  v.check((l) => (l.orderType === "limit") === (l.limitPrice !== undefined), "A limit leg needs limitPrice; a market leg must not have one"),
);
export type RuleLeg = v.InferOutput<typeof RuleLegSchema>;

const OrderRef = v.pipe(
  v.strictObject({ oid: v.optional(Ms), cloid: v.optional(CloidSchema) }),
  v.check((r) => r.oid !== undefined || r.cloid !== undefined, "Give an oid or a cloid"),
);

const SeqState = { seq: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0) };

// ---------------------------------------------------------------------------------------------
// 1. Protect partial fills
// ---------------------------------------------------------------------------------------------

export const ProtectPartialFillsRuleSchema = v.strictObject({
  ...base,
  type: v.literal("protectPartialFills"),
  coin: CoinSchema,
  /** The resting limit entry to watch. */
  entry: OrderRef,
  /** Entry side. */
  side: Side,
  stopLoss: RuleLegSchema,
  takeProfit: v.optional(RuleLegSchema),
  state: v.optional(
    v.object({
      ...SeqState,
      protectedSize: v.optional(v.string(), "0"),
      stopCloid: v.optional(CloidSchema),
      takeProfitCloid: v.optional(CloidSchema),
    }),
  ),
});

// ---------------------------------------------------------------------------------------------
// 2. Breakeven
// ---------------------------------------------------------------------------------------------

export const BreakevenRuleSchema = v.pipe(
  v.strictObject({
    ...base,
    type: v.literal("breakeven"),
    coin: CoinSchema,
    trigger: v.variant("kind", [
      v.strictObject({ kind: v.literal("price"), price: PositiveDecimalSchema }),
      v.strictObject({ kind: v.literal("rMultiple"), r: v.pipe(v.number(), v.gtValue(0)) }),
    ]),
    /** Initial stop price: the 1R reference for `rMultiple` triggers. */
    initialStopPrice: v.optional(PositiveDecimalSchema),
    /** Offset beyond entry in bps (positive locks in a little profit to cover fees). Default 0. */
    offsetBps: v.optional(v.pipe(v.number(), v.integer(), v.minValue(-1000), v.maxValue(1000)), 0),
    /**
     * Existing exchange stop order to move. It is only modified when it is open and the new stop is tighter (its
     * `triggerPrice` must be present in `PositionState.orders`); if it is not open, a new position stop is placed.
     */
    stopOrder: v.optional(OrderRef),
    state: v.optional(v.object({ ...SeqState, moved: v.optional(v.boolean(), false), stopCloid: v.optional(CloidSchema), side: v.optional(PositionSideSchema) })),
  }),
  v.check((r) => r.trigger.kind !== "rMultiple" || r.initialStopPrice !== undefined, "rMultiple triggers need initialStopPrice"),
);

// ---------------------------------------------------------------------------------------------
// 3. Take-profit ladder
// ---------------------------------------------------------------------------------------------

export const MAX_LADDER_LEVELS = 10;

export const TakeProfitLadderRuleSchema = v.pipe(
  v.strictObject({
    ...base,
    type: v.literal("takeProfitLadder"),
    coin: CoinSchema,
    /** Each level closes `closePct` of the position size measured when the rule first sees the position. */
    levels: v.pipe(
      v.array(v.strictObject({ price: PositiveDecimalSchema, closePct: Pct })),
      v.minLength(1),
      v.maxLength(MAX_LADDER_LEVELS),
    ),
    state: v.optional(
      v.object({
        ...SeqState,
        initialSize: v.optional(v.string()),
        /** Side of the position the ladder was armed on; a flipped position completes the rule. */
        side: v.optional(PositionSideSchema),
        executed: v.optional(v.array(v.boolean())),
        closedSize: v.optional(v.string(), "0"),
      }),
    ),
  }),
  v.check((r) => r.levels.reduce((s, l) => s + l.closePct, 0) <= 100 + 1e-9, "Ladder levels must close at most 100% in total"),
);

// ---------------------------------------------------------------------------------------------
// 4. Trailing stop
// ---------------------------------------------------------------------------------------------

export const TrailingStopRuleSchema = v.strictObject({
  ...base,
  type: v.literal("trailingStop"),
  coin: CoinSchema,
  trail: v.variant("kind", [
    v.strictObject({ kind: v.literal("pct"), value: v.pipe(v.number(), v.gtValue(0), v.ltValue(100)) }),
    v.strictObject({ kind: v.literal("price"), value: PositiveDecimalSchema }),
  ]),
  /** Start trailing once mark reaches this price (long: at or above; short: at or below). */
  activationPrice: v.optional(PositiveDecimalSchema),
  /** Minimum improvement (bps of the current stop) before modifying the exchange stop. Default 10. */
  minUpdateBps: v.optional(Bps, 10),
  /**
   * Attached to the position that exists when the rule is created: the rule completes when that position closes,
   * even before it activated, so it never acts on a later position. Without it, the rule waits for a position.
   */
  closeWithPosition: v.optional(v.boolean(), false),
  /**
   * Existing exchange stop to manage. The trail starts from its trigger price and never loosens it (its
   * `triggerPrice` must be present in `PositionState.orders`). When absent or not open, the rule places its own stop.
   */
  stopOrder: v.optional(OrderRef),
  state: v.optional(
    v.object({
      ...SeqState,
      activated: v.optional(v.boolean(), false),
      /** Side of the position when the trail activated; a flipped position completes the rule. */
      side: v.optional(PositionSideSchema),
      extreme: v.optional(v.number()),
      stopPrice: v.optional(v.string()),
      stopCloid: v.optional(CloidSchema),
    }),
  ),
});

// ---------------------------------------------------------------------------------------------
// 5. Time exit
// ---------------------------------------------------------------------------------------------

export const TimeExitRuleSchema = v.pipe(
  v.strictObject({
    ...base,
    type: v.literal("timeExit"),
    coin: CoinSchema,
    /** Absolute exit time (ms). */
    at: v.optional(Ms),
    /** Or a duration after `createdAt` (ms). */
    afterMs: v.optional(v.pipe(Ms, v.minValue(1))),
    action: v.variant("kind", [v.strictObject({ kind: v.literal("close") }), v.strictObject({ kind: v.literal("reduce"), pct: Pct })]),
    state: v.optional(v.object({ ...SeqState, done: v.optional(v.boolean(), false) })),
  }),
  v.check((r) => (r.at !== undefined) !== (r.afterMs !== undefined), "Give exactly one of at or afterMs"),
);

// ---------------------------------------------------------------------------------------------
// 6. One-cancels-other entries
// ---------------------------------------------------------------------------------------------

const EntrySpecSchema = v.strictObject({
  side: Side,
  orderType: v.picklist(["limit", "stopMarket", "stopLimit", "takeProfitMarket", "takeProfitLimit"]),
  size: PositiveDecimalSchema,
  price: v.optional(PositiveDecimalSchema),
  triggerPrice: v.optional(PositiveDecimalSchema),
  tif: v.optional(v.picklist(TIFS)),
});
export type EntrySpec = v.InferOutput<typeof EntrySpecSchema>;

export const OcoEntriesRuleSchema = v.pipe(
  v.strictObject({
  ...base,
  type: v.literal("ocoEntries"),
  coin: CoinSchema,
  entries: v.tuple([EntrySpecSchema, EntrySpecSchema]),
  /** Optional bracket placed on whichever entry fills, sized to the filled amount. */
  bracket: v.optional(v.strictObject({ takeProfit: v.optional(RuleLegSchema), stopLoss: v.optional(RuleLegSchema) })),
  state: v.optional(
    v.object({
      ...SeqState,
      placed: v.optional(v.boolean(), false),
      entryCloids: v.optional(v.tuple([CloidSchema, CloidSchema])),
      filledIndex: v.optional(v.picklist([0, 1])),
      otherCanceled: v.optional(v.boolean(), false),
      bracketPlaced: v.optional(v.boolean(), false),
    }),
  ),
  }),
  v.rawCheck(({ dataset, addIssue }) => {
    if (!dataset.typed) return;
    const r = dataset.value;
    r.entries.forEach((entry, i) => {
      const problems = orderIntentProblems({ ...entry, kind: "order", coin: r.coin, reduceOnly: false, positionTpsl: false, origin: "guardian" });
      for (const message of problems) addIssue({ message: `Entry ${i + 1}: ${message}` });
    });
  }),
);

// ---------------------------------------------------------------------------------------------
// 7. Conditional ("if X then Y")
// ---------------------------------------------------------------------------------------------

export const ConditionSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("priceCross"),
    coin: CoinSchema,
    direction: v.picklist(["above", "below"]),
    price: PositiveDecimalSchema,
    source: v.optional(v.picklist(["mark", "mid", "oracle"]), "mark"),
  }),
  v.strictObject({
    kind: v.literal("candleClose"),
    coin: CoinSchema,
    interval: v.picklist(CANDLE_INTERVALS),
    direction: v.picklist(["above", "below"]),
    price: PositiveDecimalSchema,
  }),
  v.strictObject({
    kind: v.literal("fundingThreshold"),
    coin: CoinSchema,
    direction: v.picklist(["above", "below"]),
    /** Hourly funding rate (fraction), e.g. 0.0001 = 0.01%/h. */
    hourlyRate: v.number(),
  }),
  v.strictObject({
    kind: v.literal("timeWindow"),
    startMs: v.optional(Ms),
    endMs: v.optional(Ms),
    /** Daily UTC window in minutes after midnight (may wrap past midnight). */
    utcStartMinute: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1439))),
    utcEndMinute: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1440))),
    /** UTC days of week (0 = Sunday). */
    daysOfWeek: v.optional(v.array(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(6)))),
  }),
]);
export type Condition = v.InferOutput<typeof ConditionSchema>;

const ConditionalOrderSchema = v.strictObject({
  coin: CoinSchema,
  side: Side,
  orderType: v.picklist(["market", "limit", "stopMarket", "stopLimit", "takeProfitMarket", "takeProfitLimit"]),
  size: PositiveDecimalSchema,
  price: v.optional(PositiveDecimalSchema),
  triggerPrice: v.optional(PositiveDecimalSchema),
  tif: v.optional(v.picklist(TIFS)),
  reduceOnly: v.optional(v.boolean(), false),
  takeProfit: v.optional(RuleLegSchema),
  stopLoss: v.optional(RuleLegSchema),
});

export const ConditionalActionSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("placeOrder"), order: ConditionalOrderSchema }),
  v.strictObject({ kind: v.literal("close"), coin: CoinSchema }),
  v.strictObject({ kind: v.literal("reduce"), coin: CoinSchema, pct: Pct }),
  v.strictObject({ kind: v.literal("alert"), message: v.pipe(v.string(), v.minLength(1), v.maxLength(500)) }),
]);
export type ConditionalAction = v.InferOutput<typeof ConditionalActionSchema>;

export const MAX_CONDITIONS = 5;

export const ConditionalRuleSchema = v.pipe(
  v.strictObject({
  ...base,
  type: v.literal("conditional"),
  conditions: v.pipe(v.array(ConditionSchema), v.minLength(1), v.maxLength(MAX_CONDITIONS)),
  combinator: v.optional(v.picklist(["AND", "OR"]), "AND"),
  action: ConditionalActionSchema,
  /** Fire again after this cooldown. Omit to fire once. */
  repeatCooldownMs: v.optional(v.pipe(Ms, v.minValue(1000))),
  state: v.optional(
    v.object({
      ...SeqState,
      fired: v.optional(v.boolean(), false),
      lastFiredAt: v.optional(Ms),
      lastPrices: v.optional(v.record(v.string(), v.number())),
      lastCandleCloseTimes: v.optional(v.record(v.string(), v.number())),
    }),
  ),
  }),
  v.rawCheck(({ dataset, addIssue }) => {
    if (!dataset.typed || dataset.value.action.kind !== "placeOrder") return;
    const o = dataset.value.action.order;
    const problems = orderIntentProblems({ ...o, kind: "order", positionTpsl: false, origin: "guardian" });
    for (const message of problems) addIssue({ message: `Order: ${message}` });
  }),
);

// ---------------------------------------------------------------------------------------------
// 8. Liquidation guard
// ---------------------------------------------------------------------------------------------

export const LiquidationGuardRuleSchema = v.pipe(
  v.strictObject({
    ...base,
    type: v.literal("liquidationGuard"),
    coin: CoinSchema,
    alert: v.optional(v.strictObject({ enabled: v.boolean(), distancePct: Pct })),
    reduce: v.optional(v.strictObject({ enabled: v.boolean(), distancePct: Pct, reducePct: Pct })),
    /** Isolated positions only. */
    addMargin: v.optional(
      v.strictObject({
        enabled: v.boolean(),
        distancePct: Pct,
        stepUsd: PositiveDecimalSchema,
        maxTotalUsd: PositiveDecimalSchema,
        cooldownMs: v.optional(Ms, 30_000),
      }),
    ),
    /** A stage re-arms once the distance recovers above its threshold by this many percentage points. Default 1. */
    rearmHysteresisPct: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(50)), 1),
    state: v.optional(
      v.object({
        ...SeqState,
        alerted: v.optional(v.boolean(), false),
        reduced: v.optional(v.boolean(), false),
        marginAddedUsd: v.optional(v.string(), "0"),
        lastMarginAddAt: v.optional(Ms),
      }),
    ),
  }),
  v.check((r) => Boolean(r.alert?.enabled || r.reduce?.enabled || r.addMargin?.enabled), "Enable at least one stage"),
);

// ---------------------------------------------------------------------------------------------
// 9. Daily loss lock
// ---------------------------------------------------------------------------------------------

export const DailyLossLockRuleSchema = v.pipe(
  v.strictObject({
    ...base,
    type: v.literal("dailyLossLock"),
    maxLossUsd: v.optional(v.pipe(v.number(), v.gtValue(0))),
    maxLossPctOfEquity: v.optional(Pct),
    /** Daily reset, minutes after 00:00 UTC. Default 0. */
    resetMinuteUtc: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1439)), 0),
    state: v.optional(v.object({ lockedUntil: v.optional(Ms) })),
  }),
  v.check((r) => r.maxLossUsd !== undefined || r.maxLossPctOfEquity !== undefined, "Set maxLossUsd and/or maxLossPctOfEquity"),
);

// ---------------------------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------------------------

/** Any guardian rule (validated). Cross-field checks run per type. */
export const GuardianRuleSchema = v.union([
  ProtectPartialFillsRuleSchema,
  BreakevenRuleSchema,
  TakeProfitLadderRuleSchema,
  TrailingStopRuleSchema,
  TimeExitRuleSchema,
  OcoEntriesRuleSchema,
  ConditionalRuleSchema,
  LiquidationGuardRuleSchema,
  DailyLossLockRuleSchema,
]);

export type ProtectPartialFillsRule = v.InferOutput<typeof ProtectPartialFillsRuleSchema>;
export type BreakevenRule = v.InferOutput<typeof BreakevenRuleSchema>;
export type TakeProfitLadderRule = v.InferOutput<typeof TakeProfitLadderRuleSchema>;
export type TrailingStopRule = v.InferOutput<typeof TrailingStopRuleSchema>;
export type TimeExitRule = v.InferOutput<typeof TimeExitRuleSchema>;
export type OcoEntriesRule = v.InferOutput<typeof OcoEntriesRuleSchema>;
export type ConditionalRule = v.InferOutput<typeof ConditionalRuleSchema>;
export type LiquidationGuardRule = v.InferOutput<typeof LiquidationGuardRuleSchema>;
export type DailyLossLockRule = v.InferOutput<typeof DailyLossLockRuleSchema>;

/** Discriminated union of every guardian rule (discriminator: `type`). */
export type GuardianRule =
  | ProtectPartialFillsRule
  | BreakevenRule
  | TakeProfitLadderRule
  | TrailingStopRule
  | TimeExitRule
  | OcoEntriesRule
  | ConditionalRule
  | LiquidationGuardRule
  | DailyLossLockRule;

/** Input form (numbers allowed for decimals, defaults optional). */
export type GuardianRuleInput = v.InferInput<typeof GuardianRuleSchema>;

/** Per-type state (as persisted by the engine). */
export type GuardianRuleState<R extends GuardianRule = GuardianRule> = NonNullable<R["state"]>;

const SCHEMA_BY_TYPE: Readonly<Record<GuardianRuleType, v.GenericSchema>> = {
  protectPartialFills: ProtectPartialFillsRuleSchema,
  breakeven: BreakevenRuleSchema,
  takeProfitLadder: TakeProfitLadderRuleSchema,
  trailingStop: TrailingStopRuleSchema,
  timeExit: TimeExitRuleSchema,
  ocoEntries: OcoEntriesRuleSchema,
  conditional: ConditionalRuleSchema,
  liquidationGuard: LiquidationGuardRuleSchema,
  dailyLossLock: DailyLossLockRuleSchema,
};

/** Thrown by {@link parseGuardianRule}. */
export class GuardianRuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardianRuleValidationError";
  }
}

/** Validates a rule using the schema for its `type` (clear errors instead of a union mismatch). */
export function parseGuardianRule(input: unknown): GuardianRule {
  const type = (input as { type?: unknown } | null)?.type;
  const schema = typeof type === "string" ? SCHEMA_BY_TYPE[type as GuardianRuleType] : undefined;
  if (!schema) throw new GuardianRuleValidationError(`Unknown guardian rule type: ${String(type)}`);
  const r = v.safeParse(schema, input);
  if (!r.success) throw new GuardianRuleValidationError(`Invalid ${String(type)} rule: ${v.summarize(r.issues)}`);
  return r.output as GuardianRule;
}
