/**
 * Grid bot planner (perps). N price lines between a lower and an upper price, arithmetic (equal $ steps) or geometric
 * (equal % steps). At start the line nearest the mark stays empty; buys rest on every line below it and sells on
 * every line above it. When an order fills, the opposite order goes one line away: a filled buy at line i places a
 * sell at line i + 1, a filled sell at line i places a buy at line i − 1. Each fill of such an answering order
 * completes one grid (bought low, sold one line higher, or the other way round).
 *
 * Every order has the same size in coins (the per-grid value at the lower price), so a buy and the sell above it
 * cancel out. Modes: `neutral` starts flat (sells above the start open shorts); `long` first buys the size of every
 * sell above the start (in market chunks of one grid each), so the sells close it; `short` mirrors that.
 *
 * Orders further than {@link GRID_PLACE_BAND_PCT} from the mark wait until the price comes closer (the signing
 * policy refuses resting orders more than 50% away). Stop conditions: stop-loss price, take-profit price, and the
 * mark leaving the range.
 *
 * @module
 */
import { formatSize, MIN_ORDER_NOTIONAL_USD } from "../precision/index.js";
import type { GridBotConfig } from "./schema.js";
import { type BotOrderView, type PlannedOrder, type PlannerStep, tickPrice } from "./orders.js";

/** Resting grid orders are placed only within this distance of the mark (percent). */
export const GRID_PLACE_BAND_PCT = 45;
/** A grid line the price already passed is still placed (it fills at once) when it is at most this far off (percent). */
export const GRID_MARKETABLE_BAND_PCT = 2;
/** A line whose order was canceled or rejected this many times is given up. */
export const GRID_MAX_LEVEL_FAILURES = 3;

/** Hyperliquid's base fee rates (tier 0) as fractions. */
export const HL_BASE_FEES = Object.freeze({ makerRate: 0.00015, takerRate: 0.00045 });

export interface FeeRates {
  /** Hyperliquid maker fee (fraction). */
  makerRate: number;
  /** Kokoah builder fee (fraction: builder `f` / 100 000). */
  builderRate: number;
}

type GridShape = Pick<GridBotConfig, "lower" | "upper" | "levels" | "spacing">;

/** The raw price lines, ascending (not yet rounded to the tick). */
export function gridPrices(c: GridShape): number[] {
  const out: number[] = [];
  const n = c.levels;
  for (let i = 0; i < n; i++) {
    if (i === 0) out.push(c.lower);
    else if (i === n - 1) out.push(c.upper);
    else if (c.spacing === "geometric") out.push(c.lower * Math.pow(c.upper / c.lower, i / (n - 1)));
    else out.push(c.lower + ((c.upper - c.lower) * i) / (n - 1));
  }
  return out;
}

/**
 * Price lines rounded to the market's tick (wire strings, ascending). Throws when two lines round to the same price
 * (the grid is too fine for the market's tick).
 */
export function gridLevels(c: GridShape, szDecimals: number): string[] {
  const out = gridPrices(c).map((p) => tickPrice(p, szDecimals));
  for (let i = 1; i < out.length; i++) {
    if (!(Number(out[i]) > Number(out[i - 1]))) throw new RangeError("The grid is finer than the market's price tick: use fewer levels or a wider range.");
  }
  return out;
}

/** Size in coins of every grid order: the per-grid value at the lower price, rounded up to the size decimals. */
export function gridOrderSize(c: Pick<GridBotConfig, "orderSizeUsd" | "lower">, szDecimals: number): string {
  return formatSize(c.orderSizeUsd / c.lower, szDecimals, "up");
}

/** Estimate shown before starting a grid. Profits are after fees, for a completed grid (buy and sell one line apart). */
export interface GridEstimate {
  grids: number;
  /** Size of every order in coins (before rounding to the market's size decimals). */
  sizeCoins: number;
  /** Profit of one completed grid, lowest and highest over the range (USD, after maker and Kokoah fees on both legs). */
  profitPerGridUsd: { min: number; max: number };
  /** The same as a percent of the order value. */
  profitPerGridPct: { min: number; max: number };
  /** Fees of one completed grid (USD), lowest and highest. */
  feesPerGridUsd: { min: number; max: number };
  /** Value of all grid orders at their prices (what the account carries if every buy fills). */
  totalOrderValueUsd: number;
  /** Value of the largest order (at the upper price). */
  maxOrderUsd: number;
  /** True when a completed grid loses money after fees. */
  unprofitable: boolean;
}

export function gridEstimate(c: Pick<GridBotConfig, "lower" | "upper" | "levels" | "spacing" | "orderSizeUsd">, fees: FeeRates): GridEstimate {
  const prices = gridPrices(c);
  const size = c.orderSizeUsd / c.lower;
  const rate = fees.makerRate + fees.builderRate;
  let minUsd = Infinity;
  let maxUsd = -Infinity;
  let minPct = Infinity;
  let maxPct = -Infinity;
  let minFee = Infinity;
  let maxFee = -Infinity;
  for (let i = 0; i + 1 < prices.length; i++) {
    const lo = prices[i]!;
    const hi = prices[i + 1]!;
    const fee = size * (lo + hi) * rate;
    const net = size * (hi - lo) - fee;
    const pct = (net / (size * lo)) * 100;
    minUsd = Math.min(minUsd, net);
    maxUsd = Math.max(maxUsd, net);
    minPct = Math.min(minPct, pct);
    maxPct = Math.max(maxPct, pct);
    minFee = Math.min(minFee, fee);
    maxFee = Math.max(maxFee, fee);
  }
  const total = prices.reduce((sum, p) => sum + size * p, 0);
  return {
    grids: prices.length - 1,
    sizeCoins: size,
    profitPerGridUsd: { min: minUsd, max: maxUsd },
    profitPerGridPct: { min: minPct, max: maxPct },
    feesPerGridUsd: { min: minFee, max: maxFee },
    totalOrderValueUsd: total,
    maxOrderUsd: size * c.upper,
    unprofitable: minUsd <= 0,
  };
}

/** A stop condition hit by the mark, or null. */
export function gridStopCondition(c: Pick<GridBotConfig, "lower" | "upper" | "stopLossPrice" | "takeProfitPrice" | "stopOutOfRange">, mark: number): string | null {
  const hit = (target: number | undefined) =>
    target !== undefined && (target < c.lower ? mark <= target : mark >= target);
  if (hit(c.stopLossPrice)) return `Stop-loss: the price reached ${c.stopLossPrice}.`;
  if (hit(c.takeProfitPrice)) return `Take-profit: the price reached ${c.takeProfitPrice}.`;
  if (c.stopOutOfRange && (mark < c.lower || mark > c.upper)) return `The price (${mark}) left the range ${c.lower}–${c.upper}.`;
  return null;
}

/** One line's order. */
export interface GridSlot {
  side: "buy" | "sell";
  /** The order's cloid once placed. */
  cloid?: string;
  /** This order answers a fill one line away: its fill completes a grid. */
  counter: boolean;
  /** Times this line's order was canceled or rejected. */
  failures: number;
}

export interface GridState {
  /** waiting: the price was outside the range at start; building: long/short start position; running. */
  phase: "waiting" | "building" | "running";
  /** Order size in coins. */
  size: string;
  /** Price lines (wire strings). */
  prices: string[];
  /** Line → wanted order. */
  slots: Record<string, GridSlot>;
  /** Market chunks still to buy (long) or sell (short) before the grid starts. */
  buildLeft: number;
  /** Cloids of start-position chunks in flight. */
  building: string[];
  buildFailures: number;
  completedGrids: number;
  /** Next cloid sequence number. */
  seq: number;
}

export interface GridStepInput {
  config: GridBotConfig;
  state: GridState | null;
  mark: number;
  szDecimals: number;
  /** The bot's orders by cloid (lowercase). */
  orders: Readonly<Record<string, BotOrderView>>;
  /** Cloid of the bot's n-th order ({@link botCloid}). */
  cloid: (seq: number) => `0x${string}`;
  /** New orders this step may place (the runner paces the automation key's order rate). */
  maxNewOrders: number;
}

const isFilled = (o: BotOrderView | undefined) => !!o && o.status === "filled" && o.filledSize >= o.size * 0.999;
const isGone = (o: BotOrderView | undefined) => !!o && (o.status === "canceled" || o.status === "rejected") && !isFilled(o);

/** Sets the grid up around the mark (the nearest line stays empty). */
export function gridSetup(config: Pick<GridBotConfig, "mode">, prices: string[], mark: number): Pick<GridState, "slots" | "buildLeft" | "phase"> {
  let gap = 0;
  for (let i = 1; i < prices.length; i++) if (Math.abs(Number(prices[i]) - mark) < Math.abs(Number(prices[gap]) - mark)) gap = i;
  const slots: Record<string, GridSlot> = {};
  for (let i = 0; i < prices.length; i++) {
    if (i === gap) continue;
    slots[String(i)] = { side: i < gap ? "buy" : "sell", counter: false, failures: 0 };
  }
  const sells = prices.length - 1 - gap;
  const buys = gap;
  const buildLeft = config.mode === "long" ? sells : config.mode === "short" ? buys : 0;
  return { slots, buildLeft, phase: buildLeft > 0 ? "building" : "running" };
}

/** One step of a grid bot. */
export function gridStep(input: GridStepInput): PlannerStep<GridState> {
  const { config: c, mark, szDecimals } = input;
  const notes: string[] = [];
  const place: PlannedOrder[] = [];
  let budget = Math.max(0, input.maxNewOrders);

  let state: GridState;
  if (input.state) {
    state = structuredClone(input.state);
  } else {
    let prices: string[];
    try {
      prices = gridLevels(c, szDecimals);
    } catch (e) {
      return { state: emptyState(), place, cancel: [], notes, stop: { reason: (e as Error).message, closePosition: false } };
    }
    const size = gridOrderSize(c, szDecimals);
    if (Number(size) * c.lower < MIN_ORDER_NOTIONAL_USD - 1e-9) {
      return { state: emptyState(), place, cancel: [], notes, stop: { reason: `Each grid order must be worth at least $${MIN_ORDER_NOTIONAL_USD}.`, closePosition: false } };
    }
    state = { ...emptyState(), phase: "waiting", size, prices };
  }

  const stop = gridStopCondition(c, mark);
  if (stop) return { state, place, cancel: [], notes, stop: { reason: stop, closePosition: c.closeOnStop } };

  if (state.phase === "waiting") {
    if (mark < c.lower || mark > c.upper) return { state, place, cancel: [], notes, stop: undefined };
    Object.assign(state, gridSetup(c, state.prices, mark));
    notes.push(`Grid set up around ${mark}: ${Object.values(state.slots).filter((s) => s.side === "buy").length} buys and ${Object.values(state.slots).filter((s) => s.side === "sell").length} sells.`);
  }

  if (state.phase === "building") {
    // Settle chunks in flight.
    const still: string[] = [];
    for (const cloid of state.building) {
      const o = input.orders[cloid];
      if (isFilled(o)) state.buildLeft = Math.max(0, state.buildLeft - 1);
      else if (isGone(o)) state.buildFailures += 1;
      else still.push(cloid);
    }
    state.building = still;
    if (state.buildFailures >= GRID_MAX_LEVEL_FAILURES && state.building.length === 0) {
      notes.push("The start position could not be completed; the grid starts with what was filled.");
      state.buildLeft = 0;
    }
    const side = c.mode === "short" ? "sell" : "buy";
    while (state.buildLeft - state.building.length > 0 && budget > 0) {
      const cloid = input.cloid(state.seq++);
      place.push({ cloid, coin: c.coin, side, size: state.size, type: "market", reduceOnly: false, label: c.mode === "short" ? "Start position (sell)" : "Start position (buy)" });
      state.building.push(cloid);
      budget -= 1;
    }
    if (state.buildLeft === 0 && state.building.length === 0) {
      state.phase = "running";
      notes.push("Start position built; grid orders are being placed.");
    } else {
      return { state, place, cancel: [], notes };
    }
  }

  // Running: answer fills, re-place lost orders, place waiting ones.
  const n = state.prices.length;
  for (const key of Object.keys(state.slots).sort((a, b) => Number(a) - Number(b))) {
    const slot = state.slots[key]!;
    if (!slot.cloid) continue;
    const o = input.orders[slot.cloid];
    const level = Number(key);
    if (isFilled(o)) {
      delete state.slots[key];
      if (slot.counter) state.completedGrids += 1;
      const next = slot.side === "buy" ? level + 1 : level - 1;
      if (next >= 0 && next < n) {
        if (state.slots[String(next)]) notes.push(`Line ${next + 1} already has an order; the answer to the fill at ${state.prices[level]} was skipped.`);
        else state.slots[String(next)] = { side: slot.side === "buy" ? "sell" : "buy", counter: true, failures: 0 };
      }
    } else if (isGone(o)) {
      slot.failures += 1;
      delete slot.cloid;
      if (slot.failures >= GRID_MAX_LEVEL_FAILURES) {
        delete state.slots[key];
        notes.push(`The ${slot.side} at ${state.prices[level]} was canceled or rejected ${slot.failures} times; that line is left empty.`);
      }
    }
  }
  for (const key of Object.keys(state.slots).sort((a, b) => Math.abs(Number(state.prices[Number(a)]) - mark) - Math.abs(Number(state.prices[Number(b)]) - mark))) {
    if (budget <= 0) break;
    const slot = state.slots[key]!;
    if (slot.cloid) continue;
    const price = Number(state.prices[Number(key)]);
    const off = (Math.abs(price - mark) / mark) * 100;
    const resting = slot.side === "buy" ? price < mark : price > mark;
    if (resting ? off > GRID_PLACE_BAND_PCT : off > GRID_MARKETABLE_BAND_PCT) continue;
    const cloid = input.cloid(state.seq++);
    slot.cloid = cloid;
    place.push({
      cloid,
      coin: c.coin,
      side: slot.side,
      size: state.size,
      type: "limit",
      price: state.prices[Number(key)]!,
      reduceOnly: false,
      label: `Grid ${slot.side} at line ${Number(key) + 1}`,
      level: Number(key),
    });
    budget -= 1;
  }
  return { state, place, cancel: [], notes };
}

function emptyState(): GridState {
  return { phase: "waiting", size: "0", prices: [], slots: {}, buildLeft: 0, building: [], buildFailures: 0, completedGrids: 0, seq: 0 };
}

/** Cloids of the grid's resting orders (to cancel when it stops). */
export function gridOpenCloids(state: GridState | null): string[] {
  if (!state) return [];
  return Object.values(state.slots)
    .map((s) => s.cloid)
    .filter((x): x is string => typeof x === "string");
}
