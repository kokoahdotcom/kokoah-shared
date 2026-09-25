/**
 * Pure, deterministic guardian evaluation. Given a rule (with its persisted `state`), market data, account/position
 * state and the current time, {@link evaluateRule} returns the intents to send, alerts to raise, the next state and the
 * rule status. It never performs I/O and never uses randomness: cloids are derived from `rule.id` and a sequence
 * number kept in the state, so re-evaluating the same inputs yields the same cloids (idempotent retries).
 *
 * The backend engine is responsible for: sending intents through the signer (policy + compile + sign), persisting
 * `nextState` only after the intents were accepted (or deciding how to handle failures), and keeping an exchange-
 * resident stop in place (FRONTEND_SPEC §14.3).
 *
 * @module
 */
import { deriveCloid, type Cloid } from "../actions/cloid.js";
import { type ActionIntent, type ActionIntentInput, parseActionIntent } from "../intents/index.js";
import { formatSize, normalizeDecimal, type PriceKind, roundPriceToTick } from "../precision/index.js";
import type {
  BreakevenRule,
  CandleInterval,
  Condition,
  ConditionalRule,
  DailyLossLockRule,
  GuardianRule,
  GuardianStatus,
  LiquidationGuardRule,
  OcoEntriesRule,
  ProtectPartialFillsRule,
  RuleLeg,
  TakeProfitLadderRule,
  TimeExitRule,
  TrailingStopRule,
} from "./schemas.js";

// ---------------------------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------------------------

/** Market data for one coin. */
export interface CoinMarketState {
  markPrice: number;
  midPrice?: number;
  oraclePrice?: number;
  /** Current hourly funding rate (fraction). */
  fundingRateHourly?: number;
  szDecimals: number;
  priceKind?: PriceKind;
  /** Most recent **closed** candle per interval. */
  lastClosedCandles?: Partial<Record<CandleInterval, { closeTime: number; close: number }>>;
}

/** Market data by coin. */
export type MarketState = Readonly<Record<string, CoinMarketState>>;

/** An open position as the guardian engine sees it. */
export interface GuardianPosition {
  side: "long" | "short";
  /** Absolute size in coin units. */
  size: number;
  entryPrice: number;
  liquidationPrice: number | null;
  marginMode: "cross" | "isolated";
}

/** An order as the guardian engine sees it (from `orderUpdates` / `frontendOpenOrders` / fills). */
export interface GuardianOrder {
  coin: string;
  oid?: number;
  cloid?: string;
  side: "buy" | "sell";
  status: "open" | "filled" | "canceled" | "rejected" | "triggered";
  origSize: number;
  filledSize: number;
  /** Trigger price of trigger (stop / take-profit) orders. Needed so rules never loosen an existing stop. */
  triggerPrice?: number;
  /** Limit price, when known (a chase taken over by the server keeps its price). */
  limitPrice?: number;
}

/** Account, positions and orders. */
export interface PositionState {
  account: {
    equityUsd: number;
    /** Realized PnL since the last daily reset (negative = loss). */
    realizedPnlTodayUsd?: number;
    /** Equity at the last daily reset, for percentage loss limits. */
    dayStartEquityUsd?: number;
  };
  positions: Readonly<Record<string, GuardianPosition>>;
  orders: ReadonlyArray<GuardianOrder>;
}

/** Alert produced by a rule (in-app/push/Telegram is the backend's job). */
export interface GuardianAlert {
  ruleId: string;
  ruleType: GuardianRule["type"];
  code: string;
  severity: "info" | "warning" | "critical";
  message: string;
  coin?: string;
  data?: Record<string, number | string | boolean | null>;
}

/** Result of {@link evaluateRule}. */
export interface GuardianEvaluation<R extends GuardianRule = GuardianRule> {
  /** True when the rule produced intents or alerts. */
  fire: boolean;
  intents: ActionIntent[];
  alerts: GuardianAlert[];
  /** State to persist on the rule (as `rule.state`) for the next evaluation. */
  nextState: NonNullable<R["state"]>;
  status: GuardianStatus;
  /** Short explanation for the activity log. */
  reason: string;
}

/** Default market-order slippage for guardian orders (bps). */
export const DEFAULT_GUARDIAN_SLIPPAGE_BPS = 100;

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

/**
 * Evaluates one rule. Paused, completed, failed and expired rules return `fire: false` with their state unchanged;
 * a rule whose `expiresAt` has passed becomes "expired".
 */
export function evaluateRule(rule: GuardianRule, marketState: MarketState, positionState: PositionState, now: number): GuardianEvaluation {
  const status = rule.status ?? "armed";
  const state = (rule.state ?? {}) as NonNullable<GuardianRule["state"]>;
  if (status === "paused" || status === "completed" || status === "failed" || status === "expired") {
    return { fire: false, intents: [], alerts: [], nextState: state, status, reason: `Rule is ${status}` };
  }
  if (rule.expiresAt !== undefined && now >= rule.expiresAt) {
    return { fire: false, intents: [], alerts: [], nextState: state, status: "expired", reason: "Rule expired" };
  }
  switch (rule.type) {
    case "protectPartialFills":
      return evalProtectPartialFills(rule, marketState, positionState);
    case "breakeven":
      return evalBreakeven(rule, marketState, positionState);
    case "takeProfitLadder":
      return evalTakeProfitLadder(rule, marketState, positionState);
    case "trailingStop":
      return evalTrailingStop(rule, marketState, positionState);
    case "timeExit":
      return evalTimeExit(rule, marketState, positionState, now);
    case "ocoEntries":
      return evalOcoEntries(rule, marketState, positionState);
    case "conditional":
      return evalConditional(rule, marketState, positionState, now);
    case "liquidationGuard":
      return evalLiquidationGuard(rule, marketState, positionState, now);
    case "dailyLossLock":
      return evalDailyLossLock(rule, positionState, now);
  }
}

/** True while a daily loss lock rule is holding new entries back. Pass the result to `PolicyContext.lossLockActive`. */
export function isLossLockActive(rule: GuardianRule, now: number): boolean {
  return rule.type === "dailyLossLock" && rule.status !== "paused" && rule.state?.lockedUntil !== undefined && now < rule.state.lockedUntil;
}

/** Next daily reset strictly after `now`, at `resetMinuteUtc` minutes after 00:00 UTC. */
export function nextDailyResetAfter(now: number, resetMinuteUtc = 0): number {
  const day = 86_400_000;
  const todayReset = Math.floor(now / day) * day + resetMinuteUtc * 60_000;
  return todayReset > now ? todayReset : todayReset + day;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

type Side = "buy" | "sell";

class Emitter {
  seq: number;
  readonly intents: ActionIntent[] = [];
  readonly alerts: GuardianAlert[] = [];
  constructor(
    private readonly rule: GuardianRule,
    seq: number | undefined,
  ) {
    this.seq = seq ?? 0;
  }
  cloid(): Cloid {
    const c = deriveCloid(`${this.rule.id}:${this.seq}`, "guardian");
    this.seq += 1;
    return c;
  }
  intent(input: Record<string, unknown>): void {
    const full: Record<string, unknown> = { ...input, origin: "guardian" };
    if (this.rule.vaultAddress !== undefined) full.vaultAddress = this.rule.vaultAddress;
    this.intents.push(parseActionIntent(full as ActionIntentInput));
  }
  alert(code: string, severity: GuardianAlert["severity"], message: string, coin?: string, data?: GuardianAlert["data"]): void {
    this.alerts.push({
      ruleId: this.rule.id,
      ruleType: this.rule.type,
      code,
      severity,
      message,
      ...(coin !== undefined ? { coin } : {}),
      ...(data !== undefined ? { data } : {}),
    });
  }
  get fired(): boolean {
    return this.intents.length > 0 || this.alerts.length > 0;
  }
  get slippageBps(): number {
    return this.rule.slippageBps ?? DEFAULT_GUARDIAN_SLIPPAGE_BPS;
  }
}

function result<R extends GuardianRule>(e: Emitter, nextState: NonNullable<R["state"]>, status: GuardianStatus, reason: string): GuardianEvaluation<R> {
  return { fire: e.fired, intents: e.intents, alerts: e.alerts, nextState, status, reason };
}

function closingSide(position: GuardianPosition): Side {
  return position.side === "long" ? "sell" : "buy";
}

function sign(position: GuardianPosition): 1 | -1 {
  return position.side === "long" ? 1 : -1;
}

function size(value: number, m: CoinMarketState): string {
  return value > 0 ? formatSize(value, m.szDecimals, "down") : "0";
}

function findOrder(orders: ReadonlyArray<GuardianOrder>, ref: { oid?: number | undefined; cloid?: string | undefined }): GuardianOrder | undefined {
  const cloid = ref.cloid?.toLowerCase();
  return orders.find((o) => (cloid !== undefined && o.cloid?.toLowerCase() === cloid) || (ref.oid !== undefined && o.oid === ref.oid));
}

/**
 * Resolves an existing stop the rule should manage. Returns the target plus its trigger price when known, or
 * `undefined` when there is no open order to modify (the rule then places its own stop).
 */
function existingStop(
  ps: PositionState,
  ownCloid: string | undefined,
  external: { oid?: number | undefined; cloid?: string | undefined } | undefined,
): { target: { oid?: number | undefined; cloid?: string | undefined }; triggerPrice: number | undefined } | undefined {
  if (ownCloid !== undefined) {
    const own = findOrder(ps.orders, { cloid: ownCloid });
    return { target: { cloid: ownCloid }, triggerPrice: own?.triggerPrice };
  }
  if (!external) return undefined;
  const o = findOrder(ps.orders, external);
  if (!o || o.status !== "open") return undefined;
  return { target: external, triggerPrice: o.triggerPrice };
}

/** Reduce-only market order closing `sz` of the position. */
function reduceMarket(e: Emitter, coin: string, position: GuardianPosition, sz: string): void {
  e.intent({ kind: "order", coin, side: closingSide(position), orderType: "market", size: sz, reduceOnly: true, slippageBps: e.slippageBps, cloid: e.cloid() });
}

/** New position stop-loss / take-profit (reduce-only trigger, grouping positionTpsl, fixed size). */
function placeProtection(e: Emitter, coin: string, closeSide: Side, sz: string, kind: "sl" | "tp", leg: RuleLeg | { triggerPrice: string }, cloid: Cloid): void {
  const orderType = "orderType" in leg && leg.orderType === "limit" ? (kind === "sl" ? "stopLimit" : "takeProfitLimit") : kind === "sl" ? "stopMarket" : "takeProfitMarket";
  e.intent({
    kind: "order",
    coin,
    side: closeSide,
    orderType,
    size: sz,
    triggerPrice: leg.triggerPrice,
    ...("limitPrice" in leg && leg.limitPrice !== undefined ? { price: leg.limitPrice } : {}),
    reduceOnly: true,
    positionTpsl: true,
    cloid,
  });
}

/** Modify an existing protective trigger order (new cloid for the replacement order). */
function modifyProtection(
  e: Emitter,
  target: { oid?: number | undefined; cloid?: string | undefined },
  coin: string,
  closeSide: Side,
  sz: string,
  kind: "sl" | "tp",
  leg: RuleLeg | { triggerPrice: string },
  cloid: Cloid,
): void {
  const orderType = "orderType" in leg && leg.orderType === "limit" ? (kind === "sl" ? "stopLimit" : "takeProfitLimit") : kind === "sl" ? "stopMarket" : "takeProfitMarket";
  e.intent({
    kind: "modify",
    target: target.cloid !== undefined ? { cloid: target.cloid } : { oid: target.oid },
    order: {
      coin,
      side: closeSide,
      orderType,
      size: sz,
      triggerPrice: leg.triggerPrice,
      ...("limitPrice" in leg && leg.limitPrice !== undefined ? { price: leg.limitPrice } : {}),
      reduceOnly: true,
      cloid,
    },
  });
}

// ---------------------------------------------------------------------------------------------
// 1. Protect partial fills
// ---------------------------------------------------------------------------------------------

function evalProtectPartialFills(rule: ProtectPartialFillsRule, market: MarketState, ps: PositionState): GuardianEvaluation {
  const st = { seq: 0, protectedSize: "0", ...rule.state };
  const e = new Emitter(rule, st.seq);
  const m = market[rule.coin];
  const status: GuardianStatus = Number(st.protectedSize) > 0 ? "triggered" : "armed";
  if (!m) return result(e, st, status, "No market data");
  const order = findOrder(ps.orders, rule.entry);
  if (!order) return result(e, st, status, "Entry order not seen yet");
  const entryDone = order.status !== "open";
  const filled = size(order.filledSize, m);
  if (Number(filled) > Number(st.protectedSize)) {
    const closeSide: Side = rule.side === "buy" ? "sell" : "buy";
    const next = { ...st };
    const stopCloid = e.cloid();
    if (st.stopCloid === undefined) placeProtection(e, rule.coin, closeSide, filled, "sl", rule.stopLoss, stopCloid);
    else modifyProtection(e, { cloid: st.stopCloid }, rule.coin, closeSide, filled, "sl", rule.stopLoss, stopCloid);
    next.stopCloid = stopCloid;
    if (rule.takeProfit) {
      const tpCloid = e.cloid();
      if (st.takeProfitCloid === undefined) placeProtection(e, rule.coin, closeSide, filled, "tp", rule.takeProfit, tpCloid);
      else modifyProtection(e, { cloid: st.takeProfitCloid }, rule.coin, closeSide, filled, "tp", rule.takeProfit, tpCloid);
      next.takeProfitCloid = tpCloid;
    }
    next.protectedSize = filled;
    next.seq = e.seq;
    return result(e, next, entryDone ? "completed" : "triggered", `Protecting ${filled} filled of ${order.origSize}`);
  }
  if (entryDone) return result(e, st, "completed", "Entry order finished and the filled size is protected");
  return result(e, st, status, "No new fills");
}

// ---------------------------------------------------------------------------------------------
// 2. Breakeven
// ---------------------------------------------------------------------------------------------

function evalBreakeven(rule: BreakevenRule, market: MarketState, ps: PositionState): GuardianEvaluation {
  const st = { seq: 0, moved: false, ...rule.state };
  const e = new Emitter(rule, st.seq);
  if (st.moved) return result(e, st, "completed", "Stop already moved to breakeven");
  const pos = ps.positions[rule.coin];
  const m = market[rule.coin];
  if (!pos || pos.size <= 0) return result(e, st, "armed", "No position");
  if (st.side !== undefined && st.side !== pos.side) return result(e, st, "completed", "The position changed side; the rule no longer applies");
  const pinned = { ...st, side: pos.side };
  if (!m) return result(e, pinned, "armed", "No market data");
  const s = sign(pos);
  const mark = m.markPrice;
  let reached: boolean;
  if (rule.trigger.kind === "price") {
    reached = s * (mark - Number(rule.trigger.price)) >= 0;
  } else {
    const risk = Math.abs(pos.entryPrice - Number(rule.initialStopPrice));
    reached = risk > 0 && s * (mark - pos.entryPrice) >= rule.trigger.r * risk;
  }
  if (!reached) return result(e, pinned, "armed", "Trigger not reached");
  const raw = pos.entryPrice * (1 + (s * (rule.offsetBps ?? 0)) / 10_000);
  // Long: round up (never below breakeven + offset); short: round down.
  const stopPx = roundPriceToTick(raw, m.szDecimals, m.priceKind ?? "perp", s === 1 ? "up" : "down");
  if (s * (mark - Number(stopPx)) <= 0) return result(e, pinned, "armed", "Mark is not beyond the breakeven stop yet");
  const sz = size(pos.size, m);
  if (Number(sz) <= 0) return result(e, pinned, "armed", "Position is smaller than one lot");
  const existing = existingStop(ps, st.stopCloid, rule.stopOrder);
  if (existing) {
    if (existing.triggerPrice === undefined) return result(e, pinned, "armed", "Existing stop's trigger price is unknown; not modifying it");
    if (s * (Number(stopPx) - existing.triggerPrice) <= 0) {
      return result(e, { ...pinned, moved: true }, "completed", `Existing stop at ${existing.triggerPrice} is already at or beyond breakeven`);
    }
  }
  const cloid = e.cloid();
  if (existing) modifyProtection(e, existing.target, rule.coin, closingSide(pos), sz, "sl", { triggerPrice: stopPx }, cloid);
  else placeProtection(e, rule.coin, closingSide(pos), sz, "sl", { triggerPrice: stopPx }, cloid);
  return result(e, { ...pinned, moved: true, stopCloid: cloid, seq: e.seq }, "completed", `Stop moved to ${stopPx}`);
}

// ---------------------------------------------------------------------------------------------
// 3. Take-profit ladder
// ---------------------------------------------------------------------------------------------

function evalTakeProfitLadder(rule: TakeProfitLadderRule, market: MarketState, ps: PositionState): GuardianEvaluation {
  const executed = rule.levels.map((_, i) => rule.state?.executed?.[i] === true);
  const st = { seq: 0, closedSize: "0", ...rule.state, executed };
  const e = new Emitter(rule, st.seq);
  const pos = ps.positions[rule.coin];
  const m = market[rule.coin];
  if (!pos || pos.size <= 0) {
    return st.initialSize !== undefined ? result(e, st, "completed", "Position closed") : result(e, st, "armed", "Waiting for a position");
  }
  if (st.side !== undefined && st.side !== pos.side) return result(e, st, "completed", "The position changed side; the ladder no longer applies");
  if (!m) return result(e, st, "armed", "No market data");
  const initialSize = st.initialSize ?? size(pos.size, m);
  const initial = Number(initialSize);
  const s = sign(pos);
  let closed = Number(st.closedSize);
  let positionLeft = pos.size;
  let cumPct = rule.levels.reduce((acc, l, i) => (executed[i] ? acc + l.closePct : acc), 0);
  const nextExecuted = [...executed];
  for (let i = 0; i < rule.levels.length; i++) {
    const level = rule.levels[i]!;
    if (nextExecuted[i]) continue;
    if (s * (m.markPrice - Number(level.price)) < 0) continue;
    nextExecuted[i] = true;
    cumPct += level.closePct;
    // Cumulative target never exceeds the initial size (≤ 100% in total), nor what is left of the position.
    const targetClosed = cumPct >= 100 - 1e-9 ? initial : (initial * cumPct) / 100;
    const want = Math.min(targetClosed - closed, initial - closed, positionLeft);
    const sz = size(want, m);
    if (Number(sz) <= 0) continue;
    reduceMarket(e, rule.coin, pos, sz);
    closed += Number(sz);
    positionLeft -= Number(sz);
    e.alert("TP_LEVEL_HIT", "info", `Take-profit level ${i + 1} at ${level.price} reached: closing ${sz}.`, rule.coin, { level: i + 1, size: sz });
  }
  const next = { ...st, initialSize, side: pos.side, executed: nextExecuted, closedSize: normalizeDecimal(closed.toPrecision(15)), seq: e.seq };
  const done = nextExecuted.every(Boolean);
  return result(e, next, done ? "completed" : e.fired || closed > 0 ? "triggered" : "armed", e.fired ? "Ladder level(s) reached" : "No level reached");
}

// ---------------------------------------------------------------------------------------------
// 4. Trailing stop
// ---------------------------------------------------------------------------------------------

function evalTrailingStop(rule: TrailingStopRule, market: MarketState, ps: PositionState): GuardianEvaluation {
  const st = { seq: 0, activated: false, ...rule.state };
  const e = new Emitter(rule, st.seq);
  const pos = ps.positions[rule.coin];
  const m = market[rule.coin];
  if (!pos || pos.size <= 0) {
    return st.activated || rule.closeWithPosition
      ? result(e, st, "completed", "Position closed")
      : result(e, st, "armed", "Waiting for a position");
  }
  if (st.activated && st.side !== undefined && st.side !== pos.side) return result(e, st, "completed", "The position changed side; the trail no longer applies");
  if (!m) return result(e, st, st.activated ? "triggered" : "armed", "No market data");
  const s = sign(pos);
  const mark = m.markPrice;
  const next = { ...st };
  const existing = existingStop(ps, st.stopCloid, rule.stopOrder);
  // An external stop we don't know the price of must not be modified (it could be tighter than our trail).
  if (existing && st.stopCloid === undefined && existing.triggerPrice === undefined) {
    return result(e, st, st.activated ? "triggered" : "armed", "Existing stop's trigger price is unknown; not modifying it");
  }
  if (!st.activated) {
    if (rule.activationPrice !== undefined && s * (mark - Number(rule.activationPrice)) < 0) return result(e, st, "armed", "Waiting for activation price");
    next.activated = true;
    next.side = pos.side;
    next.extreme = mark;
  } else {
    const prevExtreme = st.extreme ?? mark;
    next.extreme = s === 1 ? Math.max(prevExtreme, mark) : Math.min(prevExtreme, mark);
  }
  const extreme = next.extreme as number;
  const dist = rule.trail.kind === "pct" ? (extreme * rule.trail.value) / 100 : Number(rule.trail.value);
  const raw = extreme - s * dist;
  if (!(raw > 0)) return result(e, next, "triggered", "Trail distance is larger than the price");
  // Long stops round down, short stops round up: never tighter than configured.
  const candidate = roundPriceToTick(raw, m.szDecimals, m.priceKind ?? "perp", s === 1 ? "down" : "up");
  // Ratchet from our last stop, or from an existing exchange stop we were asked to manage.
  const prevStop = st.stopPrice !== undefined ? Number(st.stopPrice) : existing?.triggerPrice;
  if (prevStop !== undefined) {
    const prev = prevStop;
    const improvement = s * (Number(candidate) - prev);
    if (improvement <= 0) return result(e, next, "triggered", "Stop unchanged (it only moves in the favorable direction)");
    if ((improvement / prev) * 10_000 < (rule.minUpdateBps ?? 10)) return result(e, next, "triggered", "Improvement below minUpdateBps");
  }
  if (s * (mark - Number(candidate)) <= 0) return result(e, next, "triggered", "Stop would trigger immediately");
  const sz = size(pos.size, m);
  if (Number(sz) <= 0) return result(e, next, "triggered", "Position is smaller than one lot");
  const cloid = e.cloid();
  if (existing) modifyProtection(e, existing.target, rule.coin, closingSide(pos), sz, "sl", { triggerPrice: candidate }, cloid);
  else placeProtection(e, rule.coin, closingSide(pos), sz, "sl", { triggerPrice: candidate }, cloid);
  return result(e, { ...next, stopPrice: candidate, stopCloid: cloid, seq: e.seq }, "triggered", `Trailing stop set to ${candidate}`);
}

// ---------------------------------------------------------------------------------------------
// 5. Time exit
// ---------------------------------------------------------------------------------------------

function evalTimeExit(rule: TimeExitRule, market: MarketState, ps: PositionState, now: number): GuardianEvaluation {
  const st = { seq: 0, done: false, ...rule.state };
  const e = new Emitter(rule, st.seq);
  if (st.done) return result(e, st, "completed", "Already exited");
  const at = rule.at ?? rule.createdAt + (rule.afterMs ?? 0);
  if (now < at) return result(e, st, "armed", "Exit time not reached");
  const pos = ps.positions[rule.coin];
  const m = market[rule.coin];
  if (!pos || pos.size <= 0) return result(e, { ...st, done: true }, "completed", "No position at exit time");
  if (!m) return result(e, st, "armed", "No market data");
  const sz = rule.action.kind === "close" ? size(pos.size, m) : size((pos.size * rule.action.pct) / 100, m);
  if (Number(sz) > 0) reduceMarket(e, rule.coin, pos, sz);
  return result(e, { ...st, done: true, seq: e.seq }, "completed", rule.action.kind === "close" ? "Time exit: closing position" : `Time exit: reducing by ${sz}`);
}

// ---------------------------------------------------------------------------------------------
// 6. One-cancels-other entries
// ---------------------------------------------------------------------------------------------

function evalOcoEntries(rule: OcoEntriesRule, market: MarketState, ps: PositionState): GuardianEvaluation {
  const st = { seq: 0, placed: false, otherCanceled: false, bracketPlaced: false, ...rule.state };
  const e = new Emitter(rule, st.seq);
  const m = market[rule.coin];
  if (!st.placed) {
    const cloids: [Cloid, Cloid] = [e.cloid(), e.cloid()];
    rule.entries.forEach((entry, i) => {
      e.intent({
        kind: "order",
        coin: rule.coin,
        side: entry.side,
        orderType: entry.orderType,
        size: entry.size,
        ...(entry.price !== undefined ? { price: entry.price } : {}),
        ...(entry.triggerPrice !== undefined ? { triggerPrice: entry.triggerPrice } : {}),
        ...(entry.tif !== undefined ? { tif: entry.tif } : {}),
        reduceOnly: false,
        cloid: cloids[i],
      });
    });
    return result(e, { ...st, placed: true, entryCloids: cloids, seq: e.seq }, "armed", "Both entries placed");
  }
  const cloids = st.entryCloids;
  if (!cloids) return result(e, st, "failed", "Missing entry cloids in state");
  const orders = [findOrder(ps.orders, { cloid: cloids[0] }), findOrder(ps.orders, { cloid: cloids[1] })] as const;
  const next = { ...st };
  if (next.filledIndex === undefined) {
    const idx = orders.findIndex((o) => o !== undefined && o.filledSize > 0);
    if (idx === 0 || idx === 1) {
      next.filledIndex = idx;
      const other = orders[idx === 0 ? 1 : 0];
      if (!other || other.status === "open") {
        e.intent({ kind: "cancel", cancels: [{ coin: rule.coin, cloid: cloids[idx === 0 ? 1 : 0] }] });
        next.otherCanceled = true;
      }
      e.alert("OCO_ENTRY_FILLED", "info", `Entry ${idx + 1} filled; the other entry is cancelled.`, rule.coin, { entry: idx + 1 });
    } else if (orders.every((o) => o !== undefined && o.status !== "open")) {
      return result(e, next, "completed", "Both entries ended without a fill");
    } else {
      return result(e, next, "armed", "Waiting for an entry to fill");
    }
  }
  const idx = next.filledIndex as 0 | 1;
  const filled = orders[idx];
  if (rule.bracket && !next.bracketPlaced && filled && filled.status !== "open" && m) {
    const sz = size(filled.filledSize, m);
    if (Number(sz) > 0) {
      const closeSide: Side = rule.entries[idx].side === "buy" ? "sell" : "buy";
      if (rule.bracket.stopLoss) placeProtection(e, rule.coin, closeSide, sz, "sl", rule.bracket.stopLoss, e.cloid());
      if (rule.bracket.takeProfit) placeProtection(e, rule.coin, closeSide, sz, "tp", rule.bracket.takeProfit, e.cloid());
    }
    next.bracketPlaced = true;
  }
  next.seq = e.seq;
  const done = !rule.bracket || next.bracketPlaced;
  return result(e, next, done ? "completed" : "triggered", done ? "OCO resolved" : "Waiting for the filled entry to finish before placing the bracket");
}

// ---------------------------------------------------------------------------------------------
// 7. Conditional
// ---------------------------------------------------------------------------------------------

function evalConditional(rule: ConditionalRule, market: MarketState, ps: PositionState, now: number): GuardianEvaluation {
  const st = { seq: 0, fired: false, lastPrices: {} as Record<string, number>, lastCandleCloseTimes: {} as Record<string, number>, ...rule.state };
  const e = new Emitter(rule, st.seq);
  if (st.fired && rule.repeatCooldownMs === undefined) return result(e, st, "completed", "Already fired");
  const lastPrices = { ...st.lastPrices };
  const lastCandles = { ...st.lastCandleCloseTimes };
  const results = rule.conditions.map((c, i) => evalCondition(c, String(i), market, now, lastPrices, lastCandles, rule.createdAt));
  const met = rule.combinator === "OR" ? results.some(Boolean) : results.every(Boolean);
  const next = { ...st, lastPrices, lastCandleCloseTimes: lastCandles };
  const coolingDown = st.fired && st.lastFiredAt !== undefined && rule.repeatCooldownMs !== undefined && now - st.lastFiredAt < rule.repeatCooldownMs;
  if (!met || coolingDown) return result(e, next, "armed", coolingDown ? "Cooling down" : "Conditions not met");

  const a = rule.action;
  switch (a.kind) {
    case "alert":
      e.alert("CONDITION_MET", "info", a.message);
      break;
    case "placeOrder": {
      const o = a.order;
      e.intent({
        kind: "order",
        coin: o.coin,
        side: o.side,
        orderType: o.orderType,
        size: o.size,
        ...(o.price !== undefined ? { price: o.price } : {}),
        ...(o.triggerPrice !== undefined ? { triggerPrice: o.triggerPrice } : {}),
        ...(o.tif !== undefined ? { tif: o.tif } : {}),
        reduceOnly: o.reduceOnly,
        ...(o.orderType === "market" ? { slippageBps: e.slippageBps } : {}),
        ...(o.takeProfit ? { takeProfit: { ...o.takeProfit, cloid: e.cloid() } } : {}),
        ...(o.stopLoss ? { stopLoss: { ...o.stopLoss, cloid: e.cloid() } } : {}),
        cloid: e.cloid(),
      });
      break;
    }
    case "close":
    case "reduce": {
      const pos = ps.positions[a.coin];
      const m = market[a.coin];
      if (!pos || pos.size <= 0 || !m) {
        e.alert("NOTHING_TO_CLOSE", "info", `Condition met but there is no ${a.coin} position to ${a.kind}.`, a.coin);
        break;
      }
      const sz = a.kind === "close" ? size(pos.size, m) : size((pos.size * a.pct) / 100, m);
      if (Number(sz) > 0) reduceMarket(e, a.coin, pos, sz);
      break;
    }
  }
  const repeat = rule.repeatCooldownMs !== undefined;
  return result(e, { ...next, fired: true, lastFiredAt: now, seq: e.seq }, repeat ? "armed" : "completed", `Conditions met: ${a.kind}`);
}

function evalCondition(
  c: Condition,
  key: string,
  market: MarketState,
  now: number,
  lastPrices: Record<string, number>,
  lastCandles: Record<string, number>,
  createdAt: number,
): boolean {
  switch (c.kind) {
    case "priceCross": {
      const m = market[c.coin];
      const px = m ? (c.source === "mid" ? m.midPrice : c.source === "oracle" ? m.oraclePrice : m.markPrice) : undefined;
      if (px === undefined) return false;
      const prev = lastPrices[key];
      lastPrices[key] = px;
      if (prev === undefined) return false; // a cross needs a previous observation on the other side
      const level = Number(c.price);
      return c.direction === "above" ? prev < level && px >= level : prev > level && px <= level;
    }
    case "candleClose": {
      const candle = market[c.coin]?.lastClosedCandles?.[c.interval];
      if (!candle) return false;
      const seen = lastCandles[key] ?? createdAt;
      if (candle.closeTime <= seen) return false; // only candles that close after the rule (or the last seen one) count
      lastCandles[key] = candle.closeTime;
      const level = Number(c.price);
      return c.direction === "above" ? candle.close > level : candle.close < level;
    }
    case "fundingThreshold": {
      const rate = market[c.coin]?.fundingRateHourly;
      if (rate === undefined) return false;
      return c.direction === "above" ? rate > c.hourlyRate : rate < c.hourlyRate;
    }
    case "timeWindow": {
      if (c.startMs !== undefined && now < c.startMs) return false;
      if (c.endMs !== undefined && now >= c.endMs) return false;
      const d = new Date(now);
      if (c.daysOfWeek !== undefined && !c.daysOfWeek.includes(d.getUTCDay())) return false;
      if (c.utcStartMinute !== undefined || c.utcEndMinute !== undefined) {
        const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
        const start = c.utcStartMinute ?? 0;
        const end = c.utcEndMinute ?? 1440;
        const inside = start <= end ? minute >= start && minute < end : minute >= start || minute < end;
        if (!inside) return false;
      }
      return true;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 8. Liquidation guard
// ---------------------------------------------------------------------------------------------

function evalLiquidationGuard(rule: LiquidationGuardRule, market: MarketState, ps: PositionState, now: number): GuardianEvaluation {
  const st = { seq: 0, alerted: false, reduced: false, marginAddedUsd: "0", ...rule.state };
  const e = new Emitter(rule, st.seq);
  const pos = ps.positions[rule.coin];
  const m = market[rule.coin];
  if (!pos || pos.size <= 0) {
    const reset = { seq: st.seq, alerted: false, reduced: false, marginAddedUsd: "0" };
    return result(e, reset, "armed", "No position");
  }
  if (!m || pos.liquidationPrice === null) return result(e, st, "armed", "No liquidation price");
  const mark = m.markPrice;
  const distancePct = (Math.abs(mark - pos.liquidationPrice) / mark) * 100;
  const h = rule.rearmHysteresisPct ?? 1;
  const next = { ...st };
  const data = { distancePct: Number(distancePct.toFixed(4)), liquidationPrice: pos.liquidationPrice, markPrice: mark };

  if (rule.alert?.enabled) {
    if (distancePct < rule.alert.distancePct && !st.alerted) {
      e.alert("LIQUIDATION_NEAR", "warning", `${rule.coin} is ${distancePct.toFixed(2)}% from liquidation (${pos.liquidationPrice}).`, rule.coin, data);
      next.alerted = true;
    } else if (distancePct >= rule.alert.distancePct + h) {
      next.alerted = false;
    }
  }
  if (rule.reduce?.enabled) {
    if (distancePct < rule.reduce.distancePct && !st.reduced) {
      const sz = size((pos.size * rule.reduce.reducePct) / 100, m);
      if (Number(sz) > 0) {
        reduceMarket(e, rule.coin, pos, sz);
        e.alert("LIQUIDATION_GUARD_REDUCE", "critical", `Reducing ${rule.coin} by ${sz} (${rule.reduce.reducePct}%) to move away from liquidation.`, rule.coin, data);
      }
      next.reduced = true;
    } else if (distancePct >= rule.reduce.distancePct + h) {
      next.reduced = false;
    }
  }
  if (rule.addMargin?.enabled && pos.marginMode === "isolated" && distancePct < rule.addMargin.distancePct) {
    const added = Number(st.marginAddedUsd);
    const remaining = Number(rule.addMargin.maxTotalUsd) - added;
    const cooledDown = st.lastMarginAddAt === undefined || now - st.lastMarginAddAt >= (rule.addMargin.cooldownMs ?? 30_000);
    if (remaining > 0 && cooledDown) {
      const amount = Math.min(Number(rule.addMargin.stepUsd), remaining);
      const amountStr = normalizeDecimal((Math.floor(amount * 1e6) / 1e6).toFixed(6));
      if (Number(amountStr) > 0) {
        e.intent({ kind: "updateIsolatedMargin", coin: rule.coin, amountUsd: amountStr });
        e.alert("LIQUIDATION_GUARD_ADD_MARGIN", "warning", `Adding $${amountStr} isolated margin to ${rule.coin}.`, rule.coin, data);
        next.marginAddedUsd = normalizeDecimal((added + Number(amountStr)).toPrecision(15));
        next.lastMarginAddAt = now;
      }
    }
  }
  next.seq = e.seq;
  return result(e, next, e.fired ? "triggered" : "armed", e.fired ? `Distance to liquidation ${distancePct.toFixed(2)}%` : "Distance to liquidation is safe");
}

// ---------------------------------------------------------------------------------------------
// 9. Daily loss lock
// ---------------------------------------------------------------------------------------------

function evalDailyLossLock(rule: DailyLossLockRule, ps: PositionState, now: number): GuardianEvaluation {
  const st = { ...rule.state };
  const e = new Emitter(rule, 0);
  if (st.lockedUntil !== undefined) {
    if (now < st.lockedUntil) return result(e, st, "triggered", "Locked until the daily reset");
    e.alert("LOSS_LOCK_LIFTED", "info", "The daily loss lock has been lifted.");
    return result(e, {}, "armed", "Daily reset: lock lifted");
  }
  const lossUsd = Math.max(0, -(ps.account.realizedPnlTodayUsd ?? 0));
  const base = ps.account.dayStartEquityUsd ?? ps.account.equityUsd;
  const byUsd = rule.maxLossUsd !== undefined && lossUsd >= rule.maxLossUsd;
  const byPct = rule.maxLossPctOfEquity !== undefined && base > 0 && (lossUsd / base) * 100 >= rule.maxLossPctOfEquity;
  if (!byUsd && !byPct) return result(e, st, "armed", "Loss within limits");
  const lockedUntil = nextDailyResetAfter(now, rule.resetMinuteUtc ?? 0);
  e.alert("DAILY_LOSS_LOCKED", "critical", `Daily loss of $${lossUsd.toFixed(2)} reached your limit: new Kokoah orders are blocked until the daily reset. Closing and reducing stay allowed.`, undefined, {
    lossUsd,
    lockedUntil,
  });
  return result(e, { lockedUntil }, "triggered", "Daily loss limit reached");
}
