/**
 * The `twap` guardian rule: a reduce or close TWAP that runs on Kokoah's servers under the user's automation key and
 * signed guardian policy, so it keeps going with the browser closed. Every slice is a reduce-only market order (IOC
 * within `slippageBps`) with the Kokoah builder and an algo cloid (`algoCloid({ kind: "twap", parent: rule.id, slice })`).
 *
 * The target is measured on the position, not on fills: `close` works the position down to zero, `reduce` down to
 * `startSize × (1 − pct/100)`. A position that is closed or flips side completes the rule. Pause and resume are the
 * guardian's own pause and resume; a price limit pauses slices without ending the rule.
 *
 * {@link evaluateTwapRule} is pure and deterministic, like `evaluateRule` for the other guardian types.
 *
 * @module
 */
import * as v from "valibot";
import { algoCloid } from "../actions/cloid.js";
import { GUARDIAN_STATUSES, GuardianRuleValidationError, type GuardianStatus } from "../guardians/schemas.js";
import type { MarketState, PositionState } from "../guardians/evaluate.js";
import { type ActionIntent, type ActionIntentInput, AddressSchema, CloidSchema, CoinSchema, parseActionIntent, PositiveDecimalSchema } from "../intents/index.js";
import { formatSize, normalizeDecimal } from "../precision/index.js";
import type { ExchangeWindow } from "./exchangeWindow.js";
import { StartTriggerSchema, startTriggerHit } from "./trigger.js";
import { nextTwapSlice, TWAP_MAX_DURATION_MS, TWAP_MIN_DURATION_MS, TWAP_MIN_INTERVAL_MS } from "./twap.js";

/** Largest per-slice slippage a server TWAP may use (the guardian policy bands orders at 5% of mark). */
export const SERVER_TWAP_MAX_SLIPPAGE_BPS = 500;
/** Default per-slice slippage. */
export const DEFAULT_TWAP_SLIPPAGE_BPS = 100;
/** Default time between slices. */
export const DEFAULT_TWAP_INTERVAL_MS = 60_000;

const Ms = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

export const TwapRuleSchema = v.pipe(
  v.strictObject({
    id: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
    status: v.optional(v.picklist(GUARDIAN_STATUSES), "armed"),
    createdBy: v.optional(v.picklist(["manual", "ai_assisted"]), "manual"),
    createdAt: Ms,
    expiresAt: v.optional(Ms),
    vaultAddress: v.optional(AddressSchema),
    /** Per-slice slippage cap in bps (market IOC). Default 100, at most 500. */
    slippageBps: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(SERVER_TWAP_MAX_SLIPPAGE_BPS))),
    type: v.literal("twap"),
    coin: CoinSchema,
    /** Close the whole position, or reduce it by `pct` percent of its size when the TWAP starts. */
    action: v.variant("kind", [
      v.strictObject({ kind: v.literal("close") }),
      v.strictObject({ kind: v.literal("reduce"), pct: v.pipe(v.number(), v.gtValue(0), v.ltValue(100)) }),
    ]),
    durationMs: v.pipe(Ms, v.minValue(TWAP_MIN_DURATION_MS), v.maxValue(TWAP_MAX_DURATION_MS)),
    intervalMs: v.optional(v.pipe(Ms, v.minValue(TWAP_MIN_INTERVAL_MS)), DEFAULT_TWAP_INTERVAL_MS),
    /** Random size and timing (±20%). Default on. */
    randomize: v.optional(v.boolean(), true),
    /** Pause slices while the mark is beyond this price (a sell below it, a buy above it). */
    priceLimit: v.optional(PositiveDecimalSchema),
    /** Start only once the mark crosses this price. */
    startTrigger: v.optional(StartTriggerSchema),
    state: v.optional(
      v.object({
        seq: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
        startedAt: v.optional(Ms),
        /** Side of the position when the TWAP started; a flip completes the rule. */
        side: v.optional(v.picklist(["long", "short"])),
        startSize: v.optional(v.string()),
        /** Position size the TWAP works down to. */
        targetSize: v.optional(v.string()),
        slicesSent: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
        nextAt: v.optional(Ms),
        lastSliceAt: v.optional(Ms),
        lastSliceCloid: v.optional(CloidSchema),
        /** True while the price limit holds slices back. */
        pausedByLimit: v.optional(v.boolean(), false),
        /** True while Hyperliquid's maintenance or post-only window holds slices back. */
        pausedByWindow: v.optional(v.boolean()),
      }),
    ),
  }),
  v.check((r) => (r.intervalMs ?? DEFAULT_TWAP_INTERVAL_MS) <= r.durationMs, "The slice interval is longer than the whole TWAP"),
);

export type TwapRule = v.InferOutput<typeof TwapRuleSchema>;
export type TwapRuleInput = v.InferInput<typeof TwapRuleSchema>;
export type TwapRuleState = NonNullable<TwapRule["state"]>;

/** Validates a `twap` rule; throws `GuardianRuleValidationError` like `parseGuardianRule`. */
export function parseTwapRule(input: unknown): TwapRule {
  const r = v.safeParse(TwapRuleSchema, input);
  if (!r.success) throw new GuardianRuleValidationError(`Invalid twap rule: ${v.summarize(r.issues)}`);
  return r.output;
}

/** Result of {@link evaluateTwapRule} (same shape as a guardian evaluation). */
export interface TwapEvaluation {
  fire: boolean;
  intents: ActionIntent[];
  alerts: [];
  nextState: TwapRuleState;
  status: GuardianStatus;
  reason: string;
}

function done(state: TwapRuleState, status: GuardianStatus, reason: string): TwapEvaluation {
  return { fire: false, intents: [], alerts: [], nextState: state, status, reason };
}

/** What the engine knows about the exchange beyond prices (optional). */
export interface AlgoEnv {
  /** Hyperliquid's maintenance or post-only window: IOC slices would not fill, so TWAPs pause. */
  exchange?: ExchangeWindow;
}

/** Evaluates a `twap` rule (see the module notes). */
export function evaluateTwapRule(rule: TwapRule, market: MarketState, ps: PositionState, now: number, env: AlgoEnv = {}): TwapEvaluation {
  const status = rule.status ?? "armed";
  const st: TwapRuleState = { seq: 0, slicesSent: 0, pausedByLimit: false, ...rule.state };
  if (status === "paused" || status === "completed" || status === "failed" || status === "expired") return done(st, status, `Rule is ${status}`);
  if (rule.expiresAt !== undefined && now >= rule.expiresAt) return done(st, "expired", "Rule expired");
  const pos = ps.positions[rule.coin];
  const m = market[rule.coin];
  const started = st.startedAt !== undefined;
  if (!pos || !(pos.size > 0)) return done(st, "completed", started ? "Position closed" : "No open position to reduce");
  if (started && st.side !== undefined && st.side !== pos.side) return done(st, "completed", "The position changed side; the TWAP stopped");
  if (!m) return done(st, started ? "triggered" : "armed", "No market data");
  let next: TwapRuleState = st;
  if (!started && rule.startTrigger && !startTriggerHit(rule.startTrigger, m.markPrice)) return done(st, "armed", `Waiting for the mark to reach ${rule.startTrigger.price}`);
  if (env.exchange?.active) {
    const why = env.exchange.reason === "maintenance" ? "maintenance" : "post-only window";
    return done({ ...st, pausedByWindow: true }, started ? "triggered" : "armed", `Paused: Hyperliquid's ${why}; slices would not fill`);
  }
  if (!started) {
    const startSize = formatSize(pos.size, m.szDecimals, "down");
    const reduceBy = rule.action.kind === "close" ? Number(startSize) : Number(formatSize((pos.size * rule.action.pct) / 100, m.szDecimals, "down"));
    const target = rule.action.kind === "close" ? "0" : normalizeDecimal(formatSize(Math.max(0, Number(startSize) - reduceBy), m.szDecimals, "up"));
    next = { ...st, startedAt: now, side: pos.side, startSize, targetSize: target, slicesSent: 0, nextAt: now };
  }
  const startSize = Number(next.startSize);
  const target = Number(next.targetSize ?? "0");
  const total = Math.max(0, startSize - target);
  const executed = Math.min(total, Math.max(0, startSize - pos.size));
  const decision = nextTwapSlice(
    {
      id: rule.id,
      side: pos.side === "long" ? "sell" : "buy",
      totalSize: total,
      szDecimals: m.szDecimals,
      durationMs: rule.durationMs,
      intervalMs: rule.intervalMs ?? 60_000,
      randomize: rule.randomize ?? true,
      ...(rule.priceLimit !== undefined ? { priceLimit: Number(rule.priceLimit) } : {}),
      // Closing: the last slice closes the whole position, which Hyperliquid exempts from its $10 minimum.
      smallFinalSlice: target === 0,
    },
    { startedAt: next.startedAt!, executed, slicesSent: next.slicesSent ?? 0, ...(next.nextAt !== undefined ? { nextAt: next.nextAt } : {}) },
    { now, price: m.markPrice },
  );
  if (decision.kind === "done") {
    return done(next, "completed", decision.reason === "complete" ? "TWAP complete" : "The rest is under Hyperliquid's $10 minimum; the TWAP stopped");
  }
  if (decision.kind === "paused") {
    return done({ ...next, pausedByLimit: true }, "triggered", `Paused: the mark ${m.markPrice} is beyond the price limit ${rule.priceLimit}`);
  }
  if (decision.kind === "wait") return done({ ...next, pausedByLimit: false, pausedByWindow: false }, "triggered", "Waiting for the next slice");
  const closeSide = pos.side === "long" ? "sell" : "buy";
  // The slice never exceeds the position (a close TWAP's last slice is the whole position).
  const size = formatSize(Math.min(Number(decision.size), pos.size), m.szDecimals, "down");
  if (!(Number(size) > 0)) return done(next, "completed", "TWAP complete");
  const cloid = algoCloid({ kind: "twap", parent: rule.id, slice: Math.min(decision.index, 0xffff) }, "guardian");
  const input: Record<string, unknown> = {
    kind: "order",
    origin: "guardian",
    coin: rule.coin,
    side: closeSide,
    orderType: "market",
    size,
    reduceOnly: true,
    slippageBps: rule.slippageBps ?? DEFAULT_TWAP_SLIPPAGE_BPS,
    cloid,
  };
  if (rule.vaultAddress !== undefined) input.vaultAddress = rule.vaultAddress;
  const intent = parseActionIntent(input as ActionIntentInput);
  return {
    fire: true,
    intents: [intent],
    alerts: [],
    nextState: {
      ...next,
      seq: (next.seq ?? 0) + 1,
      slicesSent: decision.index + 1,
      nextAt: decision.nextAt,
      lastSliceAt: now,
      lastSliceCloid: cloid,
      pausedByLimit: false,
      pausedByWindow: false,
    },
    status: "triggered",
    reason: `TWAP slice ${decision.index + 1}: ${closeSide} ${size} ${rule.coin}`,
  };
}

/** Progress of a `twap` rule for display: executed share (0–1) and slices sent. */
export function twapRuleProgress(rule: Pick<TwapRule, "state">, currentSize: number | undefined): { share: number; slicesSent: number; pausedByLimit: boolean } {
  const st = rule.state;
  const start = Number(st?.startSize ?? NaN);
  const target = Number(st?.targetSize ?? 0);
  const total = start - target;
  const executed = currentSize === undefined ? 0 : Math.min(total, Math.max(0, start - currentSize));
  return { share: total > 0 && Number.isFinite(executed) ? executed / total : 0, slicesSent: st?.slicesSent ?? 0, pausedByLimit: st?.pausedByLimit ?? false };
}
