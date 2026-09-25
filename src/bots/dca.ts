/**
 * DCA bot planner. A market order of `orderSizeUsd` every `intervalMinutes` (buy: accumulate a long; sell: a short).
 * A cycle starts with its first recurring order; its price anchors the optional safety orders: resting limits every
 * `stepPct` further against the position (below for buys, above for sells), each `sizeMultiplier` times the previous
 * one, until `count` orders or `maxTotalUsd` of safety orders. With `takeProfitPct`, the whole position is closed
 * (reduce-only market) once the mark is that far beyond the average entry; open safety orders are canceled and the next
 * recurring order starts a new cycle.
 *
 * A paused or late bot never catches up with a burst: the next order is one interval after the late one. After
 * `maxOrders` recurring orders the bot finishes (with a take-profit: once that cycle is closed); open safety orders
 * are canceled and the position is kept.
 *
 * @module
 */
import { formatSize, MIN_ORDER_NOTIONAL_USD } from "../precision/index.js";
import type { DcaBotConfig, DcaSafetyConfig } from "./schema.js";
import { type BotOrderView, meetsMinimum, type PlannedOrder, type PlannerStep, sizeForUsd, tickPrice } from "./orders.js";

/** One planned safety order of a cycle. */
export interface DcaSafetyOrder {
  /** 1-based. */
  index: number;
  price: number;
  /** Value at its price (USD). */
  usd: number;
}

/**
 * Safety orders for a cycle anchored at `anchor`: order k sits k × stepPct from the anchor and is worth
 * `baseUsd × sizeMultiplier^k`; orders that would take the total above `maxTotalUsd` are dropped (and all after them).
 */
export function dcaSafetyLadder(safety: DcaSafetyConfig, anchor: number, side: "buy" | "sell", baseUsd: number): DcaSafetyOrder[] {
  const out: DcaSafetyOrder[] = [];
  let total = 0;
  for (let k = 1; k <= safety.count; k++) {
    const offset = (safety.stepPct * k) / 100;
    if (side === "buy" && offset >= 1) break;
    const price = side === "buy" ? anchor * (1 - offset) : anchor * (1 + offset);
    const usd = baseUsd * Math.pow(safety.sizeMultiplier, k);
    if (total + usd > safety.maxTotalUsd + 1e-9) break;
    total += usd;
    out.push({ index: k, price, usd });
  }
  return out;
}

/** The take-profit price for an average entry, or undefined without a take-profit. */
export function dcaTakeProfitPrice(c: Pick<DcaBotConfig, "side" | "takeProfitPct">, averageEntry: number): number | undefined {
  if (c.takeProfitPct === undefined || !(averageEntry > 0)) return undefined;
  return c.side === "buy" ? averageEntry * (1 + c.takeProfitPct / 100) : averageEntry * (1 - c.takeProfitPct / 100);
}

export interface DcaState {
  cycle: number;
  /** Recurring orders placed so far (all cycles). */
  ordersPlaced: number;
  /** When the next recurring order is due (ms). */
  nextAt: number;
  /** The cycle's first recurring order price (mark when placed); set once the cycle started. */
  anchor?: number;
  /** Cloids of this cycle's safety orders once placed, by index. */
  safety: Record<string, string>;
  /** Safety orders are planned for this cycle (placed or waiting for the order budget). */
  safetyPlanned: boolean;
  /** The last recurring order (to wait for it before the next). */
  lastCloid?: string;
  /** A take-profit close in flight. */
  closeCloid?: string;
  /** Take-profit closes that did not fill. */
  closeFailures: number;
  seq: number;
}

export interface DcaStepInput {
  config: DcaBotConfig;
  state: DcaState | null;
  now: number;
  mark: number;
  szDecimals: number;
  /** The bot's position: signed size in coins and its average entry. */
  position: { size: number; entryPrice: number };
  orders: Readonly<Record<string, BotOrderView>>;
  cloid: (seq: number) => `0x${string}`;
  maxNewOrders: number;
  /**
   * Position value the account may still add under the bot's leverage cap (`maxLeverage × equity − total position
   * value`). A recurring order above it is skipped for this interval; safety orders above it wait.
   */
  entryRoomUsd?: number;
}

const terminal = (o: BotOrderView | undefined) => !!o && o.status !== "pending" && o.status !== "open";
const openOrPending = (o: BotOrderView | undefined) => !o || o.status === "pending" || o.status === "open";

export function dcaStep(input: DcaStepInput): PlannerStep<DcaState> {
  const { config: c, now, mark, szDecimals } = input;
  const notes: string[] = [];
  const place: PlannedOrder[] = [];
  const cancel: string[] = [];
  let budget = Math.max(0, input.maxNewOrders);
  const state: DcaState = input.state
    ? structuredClone(input.state)
    : { cycle: 1, ordersPlaced: 0, nextAt: now, safety: {}, safetyPlanned: false, closeFailures: 0, seq: 0 };
  const intervalMs = c.intervalMinutes * 60_000;
  const dir = c.side === "buy" ? 1 : -1;
  const held = input.position.size * dir;
  const openSafety = () => Object.values(state.safety).filter((cl) => openOrPending(input.orders[cl]));
  const endCycle = () => {
    cancel.push(...openSafety());
    state.cycle += 1;
    delete state.anchor;
    state.safety = {};
    state.safetyPlanned = false;
    delete state.closeCloid;
    state.closeFailures = 0;
  };
  const exhausted = c.maxOrders !== undefined && state.ordersPlaced >= c.maxOrders;

  // A take-profit close in flight: wait for it, then start the next cycle.
  if (state.closeCloid) {
    const o = input.orders[state.closeCloid];
    if (!terminal(o)) return { state, place, cancel, notes };
    if (o!.status === "filled" || held <= 0) {
      notes.push(`Cycle ${state.cycle} closed at the take-profit.`);
      endCycle();
      if (exhausted) return { state, place, cancel, notes, stop: { reason: "All orders were placed and the last cycle was closed.", closePosition: false, finished: true } };
    } else {
      state.closeFailures += 1;
      delete state.closeCloid;
      notes.push("The take-profit close did not fill; it will be tried again.");
    }
  }

  // Take-profit on the average entry.
  const tp = held > 0 ? dcaTakeProfitPrice(c, input.position.entryPrice) : undefined;
  if (tp !== undefined && (c.side === "buy" ? mark >= tp : mark <= tp) && budget > 0 && state.closeFailures < 5) {
    const cloid = input.cloid(state.seq++);
    state.closeCloid = cloid;
    place.push({
      cloid,
      coin: c.coin,
      side: c.side === "buy" ? "sell" : "buy",
      size: formatSize(Math.abs(input.position.size), szDecimals, "nearest"),
      type: "market",
      reduceOnly: true,
      label: "Take-profit close",
    });
    cancel.push(...openSafety());
    notes.push(`Take-profit: the price ${mark} is ${c.takeProfitPct}% beyond the average entry ${round(input.position.entryPrice)}.`);
    return { state, place, cancel, notes };
  }

  // Finished without a take-profit: once the last order is done.
  if (exhausted && c.takeProfitPct === undefined) {
    if (state.lastCloid && !terminal(input.orders[state.lastCloid])) return { state, place, cancel, notes };
    cancel.push(...openSafety());
    return { state, place, cancel, notes, stop: { reason: `All ${c.maxOrders} orders were placed.`, closePosition: false, finished: true } };
  }

  // The recurring order.
  let room = input.entryRoomUsd ?? Infinity;
  const lastDone = !state.lastCloid || terminal(input.orders[state.lastCloid]);
  if (!exhausted && now >= state.nextAt && lastDone && budget > 0) {
    const size = sizeForUsd(c.orderSizeUsd, mark, szDecimals, "down");
    const usable = meetsMinimum(size, mark) ? size : sizeForUsd(MIN_ORDER_NOTIONAL_USD * 1.001, mark, szDecimals, "up");
    if (Number(usable) * mark > room) {
      state.nextAt = state.nextAt + intervalMs > now ? state.nextAt + intervalMs : now + intervalMs;
      notes.push(`Skipped this interval's order: it would take the account above ${c.maxLeverage}× leverage.`);
      return { state, place, cancel, notes };
    }
    room -= Number(usable) * mark;
    const cloid = input.cloid(state.seq++);
    state.lastCloid = cloid;
    state.ordersPlaced += 1;
    // On time: keep the schedule. Late by more than an interval (paused, outage): the next one is an interval from now.
    state.nextAt = state.nextAt + intervalMs > now ? state.nextAt + intervalMs : now + intervalMs;
    if (state.anchor === undefined) state.anchor = mark;
    place.push({
      cloid,
      coin: c.coin,
      side: c.side,
      size: usable,
      type: "market",
      reduceOnly: false,
      label: `Order ${state.ordersPlaced}${c.maxOrders ? ` of ${c.maxOrders}` : ""}`,
    });
    budget -= 1;
  }

  // Safety orders for this cycle.
  if (c.safety && state.anchor !== undefined && !state.safetyPlanned) {
    const ladder = dcaSafetyLadder(c.safety, state.anchor, c.side, c.orderSizeUsd);
    for (const s of ladder) {
      if (state.safety[String(s.index)]) continue;
      if (budget <= 0) break;
      const price = tickPrice(s.price, szDecimals, c.side === "buy" ? "down" : "up");
      const size = sizeForUsd(s.usd, Number(price), szDecimals, "down");
      if (!meetsMinimum(size, Number(price))) continue;
      // A safety order that would break the leverage cap if it filled waits (and the rest after it).
      if (Number(size) * Number(price) > room) break;
      room -= Number(size) * Number(price);
      const cloid = input.cloid(state.seq++);
      state.safety[String(s.index)] = cloid;
      place.push({ cloid, coin: c.coin, side: c.side, size, type: "limit", price, reduceOnly: false, label: `Safety order ${s.index}`, level: s.index });
      budget -= 1;
    }
    if (ladder.every((s) => state.safety[String(s.index)] || !meetsMinimum(sizeForUsd(s.usd, s.price, szDecimals), s.price))) state.safetyPlanned = true;
  }
  return { state, place, cancel, notes };
}

function round(x: number): string {
  return String(Math.round(x * 1e6) / 1e6);
}

/** Cloids of a DCA's resting safety orders (to cancel when it stops). */
export function dcaOpenCloids(state: DcaState | null): string[] {
  return state ? Object.values(state.safety) : [];
}
