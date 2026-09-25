/**
 * The `chase` server rule: the server side of a chase that runs in a browser tab. The tab keeps checking in (a
 * heartbeat: it edits the rule, and the engine uses the time the server received the edit, not the tab's clock).
 * While the heartbeat is fresh the rule does nothing. When the tab has been quiet for
 * {@link CHASE_HEARTBEAT_TIMEOUT_MS} (it closed, crashed or lost its connection), the rule acts as the user chose:
 * - `onTabClose: "cancel"`: cancels the chase order the tab left resting, and ends;
 * - `onTabClose: "server"`: takes the chase over and keeps re-pricing it from Kokoah's servers, more slowly than the
 *   tab ({@link SERVER_CHASE_REPRICE_MS}), with the same shared `nextChaseStep` (limit, rest or cancel at the limit,
 *   time limit then IOC, stop after 5 post-only rejections). A re-price is a cancel, then, once Hyperliquid shows the
 *   order is gone and its final fill is known, a new post-only `order` with the Kokoah builder, so the chase never
 *   fills more than its size.
 *
 * The tab's orders are algo children of the chase (`algoCloid({ kind: "chase", parent: algoId, slice })`); the tab
 * reports its newest slice in each heartbeat, and the rule looks up that slice and the next
 * {@link CHASE_PROBE_SLICES} to find the order it left resting. It takes over only an order it can see resting: its
 * remaining size is exactly what is left to fill (every chase order is sized to what remains). With no resting order
 * after the chase started it ends without placing anything, since fills after the last heartbeat are not known.
 *
 * A chase with a start trigger that has not fired in the tab (`triggered` false) has placed nothing, so the server
 * may run all of it: it waits for the mark to cross the start price, then chases.
 *
 * The server has the mid price (not the book), so it prices one tick inside a spread assumed around the mid
 * ({@link serverChaseBook}); post-only orders never cross, and a rejection counts toward the five.
 *
 * @module
 */
import * as v from "valibot";
import { algoCloid, isAlgoChild, type Cloid } from "../actions/cloid.js";
import type { GuardianOrder, MarketState, PositionState } from "../guardians/evaluate.js";
import { GUARDIAN_STATUSES, GuardianRuleValidationError, type GuardianStatus } from "../guardians/schemas.js";
import { type ActionIntent, type ActionIntentInput, AddressSchema, CloidSchema, CoinSchema, parseActionIntent, PositiveDecimalSchema } from "../intents/index.js";
import { formatSize, normalizeDecimal, priceTickAt, type PriceKind } from "../precision/index.js";
import { nextChaseStep, type ChaseBook } from "./chase.js";
import type { ExecutionPlan } from "./trailing.js";
import { StartTriggerSchema, startTriggerHit } from "./trigger.js";

/** The server takes over (or cancels) once the tab has been quiet this long. */
export const CHASE_HEARTBEAT_TIMEOUT_MS = 90_000;
/** How often the tab checks in (well inside the timeout, so a slow tab is not taken over). */
export const CHASE_HEARTBEAT_MS = 15_000;
/** The server re-prices at most this often (the tab: every 2 s). */
export const SERVER_CHASE_REPRICE_MS = 15_000;
/** Slices after the tab's last reported one that are looked up at takeover. */
export const CHASE_PROBE_SLICES = 12;
/** Server child orders use slice numbers from here up, apart from the tab's. */
export const SERVER_CHASE_SLICE_BASE = 0x8000;
/** An order the server lost track of (not found on Hyperliquid) this long ends the chase. */
const MISSING_ORDER_MS = 120_000;

const Ms = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

export const ChaseRuleSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  status: v.optional(v.picklist(GUARDIAN_STATUSES), "armed"),
  createdBy: v.optional(v.picklist(["manual", "ai_assisted"]), "manual"),
  createdAt: Ms,
  expiresAt: v.optional(Ms),
  vaultAddress: v.optional(AddressSchema),
  slippageBps: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))),
  type: v.literal("chase"),
  coin: CoinSchema,
  /** The browser chase's id: its orders are algo children of it. */
  algoId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  side: v.picklist(["buy", "sell"]),
  /** Total size of the chase (coin). */
  size: PositiveDecimalSchema,
  reduceOnly: v.optional(v.boolean(), false),
  /** "Chase to": the worst price it follows to, or a percentage from the start price (the mid when it starts). */
  limitPrice: v.optional(PositiveDecimalSchema),
  limitPct: v.optional(v.pipe(v.number(), v.gtValue(0), v.ltValue(50))),
  atLimit: v.optional(v.picklist(["rest", "cancel"]), "rest"),
  /** When the chase started in the tab (absent while its start trigger waits). */
  startedAt: v.optional(Ms),
  /** After this long from the start, whatever is left goes as IOC. */
  timeLimitMs: v.optional(v.pipe(Ms, v.minValue(1000))),
  /** What happens when the tab goes quiet. */
  onTabClose: v.picklist(["server", "cancel"]),
  /** The tab's last check-in; the engine replaces it with the time the server received it. */
  heartbeatAt: Ms,
  /** The tab's newest child slice number. */
  slice: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(SERVER_CHASE_SLICE_BASE - 1)), 0),
  /** Start when the mark crosses this price; `triggered` says the tab already started. */
  startTrigger: v.optional(StartTriggerSchema),
  triggered: v.optional(v.boolean(), false),
  state: v.optional(
    v.object({
      seq: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
      takenOverAt: v.optional(Ms),
      /** Filled by orders that are no longer resting (coin). */
      filled: v.optional(v.string(), "0"),
      orderCloid: v.optional(CloidSchema),
      orderPrice: v.optional(v.string()),
      orderSize: v.optional(v.string()),
      placedAt: v.optional(Ms),
      /** The order was canceled for a re-price or the time limit; the next step waits for it to be gone. */
      canceling: v.optional(v.boolean(), false),
      ioc: v.optional(v.boolean(), false),
      missingSince: v.optional(Ms),
      reprices: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
      rejections: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
      lastActionAt: v.optional(Ms),
      /** When the server started a chase whose trigger fired on the server, and the mid then. */
      startedAt: v.optional(Ms),
      startPrice: v.optional(v.number()),
    }),
  ),
});

export type ChaseRule = v.InferOutput<typeof ChaseRuleSchema>;
export type ChaseRuleInput = v.InferInput<typeof ChaseRuleSchema>;
export type ChaseRuleState = NonNullable<ChaseRule["state"]>;

/** Validates a `chase` rule; throws `GuardianRuleValidationError` like `parseGuardianRule`. */
export function parseChaseRule(input: unknown): ChaseRule {
  const r = v.safeParse(ChaseRuleSchema, input);
  if (!r.success) throw new GuardianRuleValidationError(`Invalid chase rule: ${v.summarize(r.issues)}`);
  return r.output;
}

/** Result of {@link evaluateChaseRule}. `nextState` is left undefined while the tab runs, so nothing is written. */
export interface ChaseEvaluation extends ExecutionPlan {
  fire: boolean;
  alerts: [];
  nextState: ChaseRuleState | undefined;
  status: GuardianStatus;
  reason: string;
}

/** True while the tab's heartbeat is fresh (the rule leaves the chase to the tab). */
export function chaseTabAlive(rule: Pick<ChaseRule, "heartbeatAt" | "state">, now: number): boolean {
  return rule.state?.takenOverAt === undefined && now - rule.heartbeatAt < CHASE_HEARTBEAT_TIMEOUT_MS;
}

/** Cloid of the tab's chase order `slice` (the browser uses the same). */
export const tabChaseCloid = (algoId: string, slice: number): Cloid => algoCloid({ kind: "chase", parent: algoId, slice }, "manual");

/**
 * Orders the engine looks up for a chase: nothing while the tab runs it; at takeover the tab's newest slice and the
 * next {@link CHASE_PROBE_SLICES}; once taken over, the rule's own order.
 */
export function chaseOrderRefs(rule: ChaseRule, now: number): { cloid: string }[] {
  const st = rule.state;
  if (st?.takenOverAt !== undefined) return st.orderCloid ? [{ cloid: st.orderCloid }] : [];
  if (chaseTabAlive(rule, now)) return [];
  const from = rule.slice ?? 0;
  return Array.from({ length: CHASE_PROBE_SLICES + 1 }, (_, i) => ({ cloid: tabChaseCloid(rule.algoId, from + i) }));
}

/**
 * A book for `nextChaseStep` from the mid price alone: a spread of one tick around the mid. A buy then goes one tick
 * above the assumed bid (at or below the mid), a sell one tick below the assumed ask.
 */
export function serverChaseBook(mid: number, szDecimals: number, kind: PriceKind, now: number): ChaseBook {
  const tick = Number(priceTickAt(mid, szDecimals, kind));
  return { bestBid: mid - tick / 2, bestAsk: mid + tick / 2, now };
}

/**
 * The state after the rule's order was refused by Hyperliquid (e.g. a post-only order that would have matched): the
 * order is forgotten and the refusal counts toward the five, so the next evaluation tries again after the pacing
 * instead of failing the rule. The engine applies it when the rule's only failure is that refusal.
 */
export function chaseStateAfterRefusal(state: ChaseRuleState | undefined, now: number): ChaseRuleState {
  const st: ChaseRuleState = { seq: 0, filled: "0", canceling: false, ioc: false, reprices: 0, rejections: 0, ...state };
  return { ...st, orderCloid: undefined, orderPrice: undefined, orderSize: undefined, placedAt: undefined, canceling: false, ioc: false, missingSince: undefined, rejections: (st.rejections ?? 0) + 1, lastActionAt: now };
}

/** Evaluates a `chase` rule (see the module notes). */
export function evaluateChaseRule(rule: ChaseRule, market: MarketState, ps: PositionState, now: number): ChaseEvaluation {
  const status = rule.status ?? "armed";
  const intents: ActionIntent[] = [];
  const requires: Record<string, number> = {};
  const cleanup: number[] = [];
  const st0: ChaseRuleState = { seq: 0, filled: "0", canceling: false, ioc: false, reprices: 0, rejections: 0, ...rule.state };
  let seq = st0.seq ?? 0;
  const emit = (input: Record<string, unknown>, isCleanup = false) => {
    const full: Record<string, unknown> = { ...input, origin: "guardian" };
    if (rule.vaultAddress !== undefined) full.vaultAddress = rule.vaultAddress;
    if (isCleanup) cleanup.push(intents.length);
    intents.push(parseActionIntent(full as ActionIntentInput));
  };
  const out = (nextState: ChaseRuleState | undefined, next: GuardianStatus, reason: string): ChaseEvaluation => ({
    fire: intents.length > 0,
    intents,
    requires,
    cleanup,
    alerts: [],
    nextState: nextState === undefined ? undefined : { ...nextState, seq },
    status: next,
    reason,
  });
  if (status === "paused" || status === "completed" || status === "failed" || status === "expired") return out(rule.state, status, `Rule is ${status}`);
  if (rule.expiresAt !== undefined && now >= rule.expiresAt) return out(rule.state, "expired", "Rule expired");
  // The tab runs the chase: nothing to do, nothing to write.
  if (chaseTabAlive(rule, now)) return out(rule.state, status, "The tab is running the chase");
  const m = market[rule.coin];
  if (!m) return out(rule.state, status, "No market data");
  const kind = m.priceKind ?? "perp";
  const find = (cloid: string | undefined): GuardianOrder | undefined => (cloid ? ps.orders.find((o) => o.cloid?.toLowerCase() === cloid.toLowerCase()) : undefined);
  const size = Number(rule.size);

  let st = st0;
  if (st.takenOverAt === undefined) {
    const resting = ps.orders.filter((o) => o.status === "open" && isAlgoChild(o.cloid, rule.algoId, "chase"));
    if (rule.onTabClose === "cancel") {
      if (resting.length) emit({ kind: "cancel", cancels: resting.map((o) => ({ coin: rule.coin, cloid: o.cloid })) }, true);
      return out(st, "completed", resting.length ? "The tab closed: the chase order was canceled" : "The tab closed; no chase order was resting");
    }
    const adopt = resting.sort((a, b) => b.origSize - a.origSize)[0];
    if (adopt) {
      // Everything before this order is filled; this order holds the rest (partly filled, maybe).
      const before = Math.max(0, size - adopt.origSize);
      st = {
        ...st,
        takenOverAt: now,
        filled: normalizeDecimal(formatSize(before, m.szDecimals, "down")),
        orderCloid: adopt.cloid!.toLowerCase() as Cloid,
        ...(adopt.limitPrice !== undefined && adopt.limitPrice > 0 ? { orderPrice: normalizeDecimal(String(adopt.limitPrice)) } : {}),
        orderSize: String(adopt.origSize),
        placedAt: now,
        lastActionAt: now,
      };
      // It is re-priced from the next allowed time, like any order off its target.
    } else if (rule.startTrigger && !rule.triggered) {
      st = { ...st, takenOverAt: now };
    } else {
      return out(st, "completed", "The tab closed with no chase order resting; nothing more was placed");
    }
  }

  // The rule's own order: fold in its fills.
  let open = false;
  let orderFilled = 0;
  if (st.orderCloid) {
    const o = find(st.orderCloid);
    if (!o) {
      const since = st.missingSince ?? now;
      if (now - since > MISSING_ORDER_MS) return out({ ...st, missingSince: since }, "completed", "The chase order could not be found on Hyperliquid; the chase stopped");
      return out({ ...st, missingSince: since }, "triggered", "Waiting for Hyperliquid to show the chase order");
    }
    if (o.status === "open" || o.status === "triggered") {
      open = true;
      orderFilled = o.filledSize;
      st = { ...st, missingSince: undefined };
    } else {
      const final = o.status === "filled" ? o.origSize : o.filledSize;
      // An order Hyperliquid canceled (not us) counts like a post-only rejection.
      const rejected = !st.canceling && o.status !== "filled";
      st = {
        ...st,
        filled: normalizeDecimal(formatSize(Number(st.filled ?? "0") + final, m.szDecimals, "down")),
        orderCloid: undefined,
        orderPrice: undefined,
        orderSize: undefined,
        placedAt: undefined,
        canceling: false,
        missingSince: undefined,
        rejections: (st.rejections ?? 0) + (rejected ? 1 : 0),
        lastActionAt: st.lastActionAt ?? now,
      };
      if (st.ioc) return out({ ...st, ioc: false }, "completed", `Time limit reached: the rest went as IOC; filled ${formatSize(Number(st.filled), m.szDecimals, "down")} ${rule.coin} in all`);
    }
  }
  if (open && st.canceling) return out(st, "triggered", "Waiting for the canceled chase order to be gone");

  // A start trigger that fired neither in the tab nor here yet.
  if (rule.startTrigger && !rule.triggered && st.startedAt === undefined) {
    if (!startTriggerHit(rule.startTrigger, m.markPrice)) return out(st, "triggered", `Waiting for the mark to reach ${rule.startTrigger.price}`);
    st = { ...st, startedAt: now, startPrice: m.midPrice ?? m.markPrice };
  }

  const mid = m.midPrice ?? m.markPrice;
  const limit =
    rule.limitPrice !== undefined
      ? { kind: "price" as const, price: Number(rule.limitPrice) }
      : rule.limitPct !== undefined
        ? { kind: "pct" as const, pct: rule.limitPct }
        : undefined;
  const filled = Number(st.filled ?? "0") + orderFilled;
  const startedAt = st.startedAt ?? rule.startedAt ?? rule.createdAt;
  const step = nextChaseStep(
    {
      side: rule.side,
      size,
      szDecimals: m.szDecimals,
      priceKind: kind,
      ...(limit ? { limit } : {}),
      atLimit: rule.atLimit ?? "rest",
      ...(rule.timeLimitMs !== undefined ? { timeLimitMs: rule.timeLimitMs } : {}),
      minRepriceMs: SERVER_CHASE_REPRICE_MS,
    },
    {
      startedAt,
      ...(st.startPrice !== undefined ? { startPrice: st.startPrice } : {}),
      filled,
      reprices: st.reprices ?? 0,
      rejections: st.rejections ?? 0,
      ...(st.lastActionAt !== undefined ? { lastActionAt: st.lastActionAt } : {}),
      // An adopted order's price is unknown: treat it as off target so it is re-priced when pacing allows.
      ...(open ? { order: { price: st.orderPrice ?? "0", size: st.orderSize ?? "0", placedAt: st.placedAt ?? now } } : {}),
    },
    serverChaseBook(mid, m.szDecimals, kind, now),
  );
  const cancelOwn = (isCleanup: boolean) => emit({ kind: "cancel", cancels: [{ coin: rule.coin, cloid: st.orderCloid }] }, isCleanup);
  switch (step.kind) {
    case "wait":
      return out(st, "triggered", open ? `Chasing at ${st.orderPrice ?? "the adopted price"} on Kokoah's servers` : step.reason);
    case "finish":
      if (step.cancel && open) cancelOwn(true);
      return out(st, "completed", step.reason === "filled" ? "Filled" : step.reason === "limitRest" ? "Reached the chase limit: the order rests there" : step.reason === "limitCancel" ? "Reached the chase limit: canceled" : step.reason === "rejections" ? "Stopped after 5 post-only rejections" : "Time limit reached");
    case "reprice":
    case "ioc":
      if (open) {
        // Cancel first; the new order goes out once the old one is gone and its fills are counted.
        cancelOwn(false);
        return out({ ...st, canceling: true, lastActionAt: now, reprices: (st.reprices ?? 0) + (step.kind === "reprice" ? 1 : 0) }, "triggered", step.kind === "ioc" ? "Time limit reached: canceling before the final IOC" : "Re-pricing the chase");
      }
      break;
    case "place":
      break;
  }
  const ioc = step.kind === "ioc";
  const cloid = algoCloid({ kind: "chase", parent: rule.algoId, slice: Math.min(SERVER_CHASE_SLICE_BASE + seq, 0xffff) }, "guardian");
  seq++;
  emit({ kind: "order", coin: rule.coin, side: rule.side, orderType: "limit", tif: ioc ? "Ioc" : "Alo", price: step.price, size: step.size, reduceOnly: rule.reduceOnly ?? false, cloid });
  return out(
    { ...st, orderCloid: cloid, orderPrice: step.price, orderSize: step.size, placedAt: now, lastActionAt: now, canceling: false, ioc },
    "triggered",
    ioc ? `Time limit reached: sending the rest as IOC at ${step.price}` : `Chasing at ${step.price} on Kokoah's servers`,
  );
}
