/**
 * The `bracket` server rule: protects what a set of entry orders fills with one stop and up to three take profits,
 * each a reduce-only trigger `order` resting on Hyperliquid (grouping `positionTpsl`, with the Kokoah builder), and
 * optionally:
 * - moves the stop to the entry price once the mark reaches `breakevenAt` (the first take profit);
 * - cancels the other entries as soon as one of them fills (`oco`, one-cancels-other entries);
 * - adopts a stop that already rests for the entry (`stopOrder`, e.g. attached to a market entry), so the position
 *   is never without a stop while the rule takes over.
 *
 * The entries are the user's own orders, placed by the app with the device key; the rule itself only places
 * reduce-only exits and cancels, which the default automation policy allows. It serves:
 * - a limit or stop entry with split take profits and/or a breakeven move (one entry);
 * - one-cancels-other entries (two entries, `oco`);
 * - a scale ladder's single position stop (up to 50 entries, a stop only).
 *
 * Sizes follow the fills: whenever the filled size grows, the stop is replaced (placed, then the old one canceled)
 * at the new size, and so are the take profits until one of them has executed. Legs under Hyperliquid's minimum are
 * folded into the next level (`sizeTakeProfits`). When the protected position closes the rule cancels its leftover
 * exits; it completes once every entry is done, and keeps protecting new fills otherwise.
 *
 * {@link evaluateBracketRule} is pure and deterministic: cloids come from the rule id and a sequence number, like the
 * guardian rules.
 *
 * @module
 */
import * as v from "valibot";
import { deriveCloid, type Cloid } from "../actions/cloid.js";
import type { GuardianOrder, MarketState, PositionState } from "../guardians/evaluate.js";
import { GUARDIAN_STATUSES, GuardianRuleValidationError, RuleLegSchema, type GuardianStatus } from "../guardians/schemas.js";
import { type ActionIntent, type ActionIntentInput, AddressSchema, CloidSchema, CoinSchema, parseActionIntent, PositiveDecimalSchema } from "../intents/index.js";
import { formatSize, normalizeDecimal, roundPriceToTick } from "../precision/index.js";
import { BRACKET_MAX_TAKE_PROFITS, sizeTakeProfits } from "./bracket.js";
import type { ExecutionPlan } from "./trailing.js";

/** Most entries one bracket watches (a scale ladder). */
export const BRACKET_MAX_ENTRIES = 50;

const Ms = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const OrderRefSchema = v.pipe(
  v.strictObject({ oid: v.optional(Ms), cloid: v.optional(CloidSchema) }),
  v.check((r) => r.oid !== undefined || r.cloid !== undefined, "Give an oid or a cloid"),
);

const TakeProfitLegSchema = v.pipe(
  v.strictObject({
    triggerPrice: PositiveDecimalSchema,
    orderType: v.optional(v.picklist(["market", "limit"]), "market"),
    limitPrice: v.optional(PositiveDecimalSchema),
    /** Share of the filled size this level closes, percent. */
    pct: v.pipe(v.number(), v.gtValue(0), v.maxValue(100)),
  }),
  v.check((l) => (l.orderType === "limit") === (l.limitPrice !== undefined), "A limit leg needs limitPrice; a market leg must not have one"),
);

export const BracketRuleSchema = v.pipe(
  v.strictObject({
    id: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
    status: v.optional(v.picklist(GUARDIAN_STATUSES), "armed"),
    createdBy: v.optional(v.picklist(["manual", "ai_assisted"]), "manual"),
    createdAt: Ms,
    expiresAt: v.optional(Ms),
    vaultAddress: v.optional(AddressSchema),
    slippageBps: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))),
    type: v.literal("bracket"),
    coin: CoinSchema,
    /** Side of the entries. */
    side: v.picklist(["buy", "sell"]),
    /** The entry orders to protect; their fills add up. */
    entries: v.pipe(v.array(OrderRefSchema), v.minLength(1), v.maxLength(BRACKET_MAX_ENTRIES)),
    /** One-cancels-other: the first entry that fills cancels the others. */
    oco: v.optional(v.boolean(), false),
    stopLoss: v.optional(RuleLegSchema),
    /** A stop already resting for the entries, of `size`: adopted while it matches the filled size. */
    stopOrder: v.optional(v.strictObject({ cloid: CloidSchema, size: PositiveDecimalSchema })),
    takeProfits: v.optional(v.pipe(v.array(TakeProfitLegSchema), v.maxLength(BRACKET_MAX_TAKE_PROFITS)), []),
    /** Move the stop to the position's entry price once the mark reaches this price. */
    breakevenAt: v.optional(PositiveDecimalSchema),
    /** Offset beyond the entry in bps for the breakeven stop (positive locks in a little profit). Default 0. */
    breakevenOffsetBps: v.optional(v.pipe(v.number(), v.integer(), v.minValue(-1000), v.maxValue(1000)), 0),
    state: v.optional(
      v.object({
        seq: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
        /** Filled size the exits currently cover. */
        protectedSize: v.optional(v.string(), "0"),
        stopCloid: v.optional(CloidSchema),
        stopPrice: v.optional(v.string()),
        tpCloids: v.optional(v.array(CloidSchema)),
        /** Final filled size of entries that are no longer open, by entry index. */
        entryFinal: v.optional(v.record(v.string(), v.string())),
        othersCanceled: v.optional(v.boolean(), false),
        /** A take profit executed: the take profits are no longer resized. */
        tpExecuted: v.optional(v.boolean(), false),
        breakevenDone: v.optional(v.boolean(), false),
      }),
    ),
  }),
  v.check((r) => (r.takeProfits ?? []).reduce((s, t) => s + t.pct, 0) <= 100 + 1e-9, "Take profits must close at most 100% in total"),
  v.check((r) => r.stopOrder === undefined || r.stopLoss !== undefined, "stopOrder needs stopLoss (its trigger price)"),
  v.check((r) => r.breakevenAt === undefined || r.stopLoss !== undefined, "breakevenAt needs a stop loss"),
  v.check((r) => r.stopLoss !== undefined || (r.takeProfits?.length ?? 0) > 0 || r.oco === true, "A bracket needs a stop, a take profit or one-cancels-other entries"),
);

export type BracketRule = v.InferOutput<typeof BracketRuleSchema>;
export type BracketRuleInput = v.InferInput<typeof BracketRuleSchema>;
export type BracketRuleState = NonNullable<BracketRule["state"]>;

/** Validates a `bracket` rule; throws `GuardianRuleValidationError` like `parseGuardianRule`. */
export function parseBracketRule(input: unknown): BracketRule {
  const r = v.safeParse(BracketRuleSchema, input);
  if (!r.success) throw new GuardianRuleValidationError(`Invalid bracket rule: ${v.summarize(r.issues)}`);
  return r.output;
}

/** Result of {@link evaluateBracketRule}: a guardian-style evaluation plus how to send the intents. */
export interface BracketEvaluation extends ExecutionPlan {
  fire: boolean;
  alerts: [];
  nextState: BracketRuleState;
  status: GuardianStatus;
  reason: string;
}

type Ref = { oid?: number | undefined; cloid?: string | undefined };
function findOrder(orders: ReadonlyArray<GuardianOrder>, ref: Ref): GuardianOrder | undefined {
  const cloid = ref.cloid?.toLowerCase();
  return orders.find((o) => (cloid !== undefined && o.cloid?.toLowerCase() === cloid) || (ref.oid !== undefined && o.oid === ref.oid));
}

/**
 * Orders the engine must look up for a bracket (by `orderStatus` when they are not open): the entries that are not
 * known to be done yet, the rule's own stop and take profits, and a stop it may adopt.
 */
export function bracketOrderRefs(rule: BracketRule): Ref[] {
  const st = rule.state;
  const refs: Ref[] = rule.entries.filter((_, i) => st?.entryFinal?.[String(i)] === undefined).map((e) => ({ ...(e.oid !== undefined ? { oid: e.oid } : {}), ...(e.cloid !== undefined ? { cloid: e.cloid } : {}) }));
  if (st?.stopCloid) refs.push({ cloid: st.stopCloid });
  else if (rule.stopOrder) refs.push({ cloid: rule.stopOrder.cloid });
  for (const c of st?.tpCloids ?? []) refs.push({ cloid: c });
  return refs;
}

/** Evaluates a `bracket` rule (see the module notes). */
export function evaluateBracketRule(rule: BracketRule, market: MarketState, ps: PositionState, now: number): BracketEvaluation {
  const status = rule.status ?? "armed";
  const st: BracketRuleState = { seq: 0, protectedSize: "0", othersCanceled: false, tpExecuted: false, breakevenDone: false, ...rule.state };
  const intents: ActionIntent[] = [];
  const requires: Record<string, number> = {};
  const cleanup: number[] = [];
  let seq = st.seq ?? 0;
  const cloid = (): Cloid => deriveCloid(`${rule.id}:${seq++}`, "guardian");
  const emit = (input: Record<string, unknown>, opts: { after?: number; cleanup?: boolean } = {}) => {
    const full: Record<string, unknown> = { ...input, origin: "guardian" };
    if (rule.vaultAddress !== undefined) full.vaultAddress = rule.vaultAddress;
    const i = intents.length;
    intents.push(parseActionIntent(full as ActionIntentInput));
    if (opts.after !== undefined) requires[String(i)] = opts.after;
    if (opts.cleanup) cleanup.push(i);
    return i;
  };
  const result = (nextState: BracketRuleState, next: GuardianStatus, reason: string): BracketEvaluation => ({
    fire: intents.length > 0,
    intents,
    requires,
    cleanup,
    alerts: [],
    nextState: intents.length > 0 || seq !== (st.seq ?? 0) ? { ...nextState, seq } : nextState,
    status: next,
    reason,
  });
  if (status === "paused" || status === "completed" || status === "failed" || status === "expired") return result(st, status, `Rule is ${status}`);
  if (rule.expiresAt !== undefined && now >= rule.expiresAt) return result(st, "expired", "Rule expired");
  const m = market[rule.coin];
  if (!m) return result(st, status, "No market data");
  const lot = 10 ** -m.szDecimals;
  const closeSide = rule.side === "buy" ? "sell" : "buy";
  const want = rule.side === "buy" ? "long" : "short";
  const s = rule.side === "buy" ? 1 : -1;
  const cancel = (refs: Ref[], after?: number) => {
    const byCloid = refs.filter((r) => r.cloid !== undefined);
    const byOid = refs.filter((r) => r.cloid === undefined && r.oid !== undefined);
    if (byCloid.length) emit({ kind: "cancel", cancels: byCloid.map((r) => ({ coin: rule.coin, cloid: r.cloid })) }, { cleanup: true, ...(after !== undefined ? { after } : {}) });
    if (byOid.length) emit({ kind: "cancel", cancels: byOid.map((r) => ({ coin: rule.coin, oid: r.oid })) }, { cleanup: true, ...(after !== undefined ? { after } : {}) });
  };

  // Entries: fills so far, and which are done.
  const entryFinal: Record<string, string> = { ...st.entryFinal };
  const entries = rule.entries.map((ref, i) => {
    const known = entryFinal[String(i)];
    if (known !== undefined) return { ref, filled: Number(known), final: true, open: false };
    const o = findOrder(ps.orders, ref);
    if (!o) return { ref, filled: 0, final: false, open: false };
    if (o.status === "open" || o.status === "triggered") return { ref, filled: o.filledSize, final: false, open: true };
    const filled = o.status === "filled" ? o.origSize : o.filledSize;
    entryFinal[String(i)] = normalizeDecimal(formatSize(filled, m.szDecimals, "down"));
    return { ref, filled, final: true, open: false };
  });
  const totalFilled = entries.reduce((a, e) => a + e.filled, 0);
  const allFinal = entries.every((e) => e.final);
  let next: BracketRuleState = { ...st, entryFinal };

  // One-cancels-other: the first fill cancels the other entries.
  if (rule.oco && !st.othersCanceled && entries.some((e) => e.filled > 0)) {
    const others = entries.filter((e) => !(e.filled > 0) && !e.final).map((e) => e.ref);
    if (others.length) cancel(others);
    next = { ...next, othersCanceled: true };
  }

  const pos = ps.positions[rule.coin];
  const posSize = pos && pos.side === want ? pos.size : 0;
  const protectedSize = Number(st.protectedSize ?? "0");
  const ownOpen = () => [...(st.stopCloid ? [st.stopCloid] : []), ...(st.tpCloids ?? [])].filter((c) => findOrder(ps.orders, { cloid: c })?.status === "open").map((c) => ({ cloid: c }));

  if (allFinal && !(totalFilled > lot / 2) && !(protectedSize > 0)) return result(next, "completed", "The entries ended without a fill");
  if (protectedSize > 0 && !(posSize > 0)) {
    const leftovers = ownOpen();
    if (leftovers.length) cancel(leftovers);
    if (allFinal) return result(next, "completed", "Position closed");
    // Some entries still rest: protect whatever fills next as a new position.
    return result({ ...next, protectedSize: "0", stopCloid: undefined, stopPrice: undefined, tpCloids: [], tpExecuted: false, breakevenDone: false }, "armed", "Position closed; waiting for the remaining entries");
  }
  if (allFinal && !(protectedSize > 0) && !(posSize > 0)) return result(next, "completed", "The entries filled but left no position to protect");

  const protect = Number(formatSize(Math.min(totalFilled, posSize), m.szDecimals, "down"));
  const grew = protect > protectedSize + lot / 2;
  const tps = rule.takeProfits ?? [];
  const tpExecuted = st.tpExecuted || (st.tpCloids ?? []).some((c) => {
    const o = findOrder(ps.orders, { cloid: c });
    return o !== undefined && (o.status === "filled" || o.status === "triggered");
  });
  next = { ...next, tpExecuted };

  // The stop: its price (moved to breakeven once the mark reaches TP1) and its size (the protected size).
  let stopPrice = st.stopPrice ?? rule.stopLoss?.triggerPrice;
  let stopSize: number | undefined;
  let breakevenNow = false;
  if (rule.stopLoss && rule.breakevenAt && !st.breakevenDone && pos && pos.side === want && protect > 0 && s * (m.markPrice - Number(rule.breakevenAt)) >= 0) {
    const raw = pos.entryPrice * (1 + (s * (rule.breakevenOffsetBps ?? 0)) / 10_000);
    const be = roundPriceToTick(raw, m.szDecimals, m.priceKind ?? "perp", s === 1 ? "up" : "down");
    // Only once the mark is past the breakeven price (otherwise the stop would fire at once).
    if (s * (m.markPrice - Number(be)) > 0) {
      breakevenNow = true;
      next = { ...next, breakevenDone: true };
      if (stopPrice === undefined || s * (Number(be) - Number(stopPrice)) > 0) {
        stopPrice = be;
        stopSize = Number(formatSize(Math.min(pos.size, Math.max(protect, protectedSize)), m.szDecimals, "down"));
      }
    }
  }
  if (grew && rule.stopLoss) stopSize = Math.max(protect, stopSize ?? 0);

  if (stopSize !== undefined && stopSize > 0 && rule.stopLoss && stopPrice !== undefined) {
    const adoptable =
      st.stopCloid === undefined &&
      rule.stopOrder !== undefined &&
      !breakevenNow &&
      Number(rule.stopOrder.size) >= stopSize - lot / 2 &&
      findOrder(ps.orders, { cloid: rule.stopOrder.cloid })?.status === "open";
    if (adoptable) {
      next = { ...next, stopCloid: rule.stopOrder!.cloid, stopPrice: rule.stopLoss.triggerPrice };
    } else {
      const c = cloid();
      const placed = emit({
        kind: "order",
        coin: rule.coin,
        side: closeSide,
        orderType: rule.stopLoss.orderType === "limit" && !breakevenNow ? "stopLimit" : "stopMarket",
        size: formatSize(stopSize, m.szDecimals, "down"),
        triggerPrice: stopPrice,
        ...(rule.stopLoss.orderType === "limit" && !breakevenNow && rule.stopLoss.limitPrice !== undefined ? { price: rule.stopLoss.limitPrice } : {}),
        reduceOnly: true,
        positionTpsl: true,
        cloid: c,
      });
      const old = st.stopCloid ?? (rule.stopOrder && findOrder(ps.orders, { cloid: rule.stopOrder.cloid })?.status === "open" ? rule.stopOrder.cloid : undefined);
      if (old) cancel([{ cloid: old }], placed);
      next = { ...next, stopCloid: c, stopPrice };
    }
  }

  // Take profits: sized to the protected size until one of them executes.
  if (grew && tps.length > 0 && !tpExecuted) {
    const legs = sizeTakeProfits({ size: protect, levels: tps.map((t) => ({ price: Number(t.triggerPrice), pct: t.pct })), szDecimals: m.szDecimals });
    if (legs.length > 0) {
      const cloids: Cloid[] = [];
      let firstPlaced: number | undefined;
      for (const leg of legs) {
        const t = tps[leg.index]!;
        const c = cloid();
        cloids.push(c);
        const i = emit({
          kind: "order",
          coin: rule.coin,
          side: closeSide,
          orderType: t.orderType === "limit" ? "takeProfitLimit" : "takeProfitMarket",
          size: leg.size,
          triggerPrice: t.triggerPrice,
          ...(t.orderType === "limit" && t.limitPrice !== undefined ? { price: t.limitPrice } : {}),
          reduceOnly: true,
          positionTpsl: true,
          cloid: c,
        });
        firstPlaced ??= i;
      }
      const old = (st.tpCloids ?? []).map((c) => ({ cloid: c }));
      if (old.length) cancel(old, firstPlaced);
      next = { ...next, tpCloids: cloids };
    }
  }
  if (grew) next = { ...next, protectedSize: normalizeDecimal(formatSize(protect, m.szDecimals, "down")) };

  const covered = Number(next.protectedSize ?? "0") > 0;
  const reason = breakevenNow
    ? `Stop moved to breakeven at ${stopPrice}`
    : grew
      ? `Protecting ${formatSize(protect, m.szDecimals, "down")} ${rule.coin} filled`
      : intents.length > 0
        ? "An entry filled: the other entries are canceled"
        : covered
          ? "Protected; watching"
          : "Waiting for an entry to fill";
  return result(next, covered ? "triggered" : "armed", reason);
}
