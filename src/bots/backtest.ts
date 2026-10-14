/**
 * Bot backtest: what a grid or DCA bot would have done over past candles, with the same planners the server runs
 * ({@link gridStep}, {@link dcaStep}), so the test follows the bot's real rules (setup, answers to fills, safety orders,
 * take-profits, stop conditions, the leverage cap, the order pace).
 *
 * The price inside a candle is taken to move open → low → high → close for a rising candle and open → high → low →
 * close for a falling one, in straight lines. Along that path:
 * - a resting limit order fills only when the price trades **through** its price (touching it is not enough), at its
 *   price, with the maker fee; a limit placed beyond the price fills at once at the price, with the taker fee;
 * - a market order fills at the price moved by {@link BACKTEST_MARKET_SLIPPAGE_BPS} against it, with the taker fee;
 * - funding is paid or received at every funding time in the data, on the position at the price of that moment;
 * - the planner runs at every turn of the path, at every due DCA order and after every fill;
 * - the account holds only this bot: it is liquidated when its value falls to the maintenance margin (half the margin
 *   at the market's maximum leverage), and its remaining margin is then counted as lost.
 *
 * Simplifications, all on the cautious side for a grid: one up-and-down per candle (more bounces inside a candle are
 * not seen), no partial fills, no queue at a price.
 *
 * @module
 */
import { applyFill, emptyBook, type BotCoinBook } from "./ledger.js";
import { dcaStep, type DcaState } from "./dca.js";
import { gridOrderSize, gridPrices, gridStep, gridStopCondition, type GridState } from "./grid.js";
import type { BotOrderView, PlannedOrder, PlannerStep } from "./orders.js";
import type { DcaBotConfig, GridBotConfig } from "./schema.js";

/** A market order fills this far from the price, against it (basis points). */
export const BACKTEST_MARKET_SLIPPAGE_BPS = 3;
/** New orders the planner may place per minute (the server's default `BOTS_ORDERS_PER_MINUTE`). */
export const BACKTEST_ORDERS_PER_MINUTE = 10;
/** Points kept for the chart. */
export const BACKTEST_CURVE_POINTS = 240;
/** Fills kept for the chart (the latest ones). */
export const BACKTEST_MAX_FILLS = 600;

export interface BacktestCandle {
  /** Open time (ms). */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface BacktestInput {
  config: GridBotConfig | DcaBotConfig;
  /** Closed candles, oldest first, all of one interval. */
  candles: readonly BacktestCandle[];
  /** Candle length (ms). */
  intervalMs: number;
  /** Funding rates per funding time (fraction; positive: longs pay shorts). */
  funding?: readonly { t: number; rate: number }[];
  szDecimals: number;
  /** The market's maximum leverage (sets the maintenance margin). */
  marketMaxLeverage: number;
  /** Fee rates as fractions: Hyperliquid's maker and taker fee, and Kokoah's builder fee (on every fill). */
  fees: { makerRate: number; takerRate: number; builderRate: number };
  /** Value of the account the bot trades in at the start (USD). */
  equityUsd: number;
}

export type BacktestEnd =
  /** It ran to the end of the data. */
  | "end"
  /** A DCA placed all its orders. */
  | "finished"
  | "stopLoss"
  | "takeProfit"
  | "outOfRange"
  /** The grid could hold more than the leverage cap allows for this account value. */
  | "leverage"
  /** The grid is finer than the market's tick, or its orders are under the minimum. */
  | "invalid"
  | "liquidated";

export interface BacktestFill {
  t: number;
  side: "buy" | "sell";
  price: number;
  size: number;
  /** Filled as a resting limit (maker) or at once (taker). */
  maker: boolean;
}

export interface BacktestPoint {
  t: number;
  price: number;
  /** The bot's result so far (USD): realized and unrealized, after fees and funding. */
  pnlUsd: number;
}

export interface BacktestResult {
  from: number;
  to: number;
  candles: number;
  startPrice: number;
  endPrice: number;
  /** Price change over the period (percent). */
  priceChangePct: number;
  /** Lowest and highest price of the period. */
  lowPrice: number;
  highPrice: number;
  equityUsd: number;
  /** After fees and funding: realized + unrealized − fees + funding. */
  pnlUsd: number;
  realizedUsd: number;
  unrealizedUsd: number;
  feesUsd: number;
  /** Funding received (positive) or paid (negative). */
  fundingUsd: number;
  /** pnlUsd as a percent of the starting account value. */
  returnPct: number;
  fills: number;
  buys: number;
  sells: number;
  volumeUsd: number;
  /** Grids completed (a buy and the sell one line above it, or the other way round). */
  completedGrids: number;
  /** DCA: recurring orders placed, orders skipped by the leverage cap, cycles closed at the take-profit. */
  ordersPlaced: number;
  ordersSkipped: number;
  cyclesClosed: number;
  /** Largest fall of the bot's result from its peak (USD, and percent of the account value at that peak). */
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  /** Largest value of the bot's position, and that as a multiple of the account value at the time. */
  maxPositionUsd: number;
  maxLeverage: number;
  /** Grid: share of candles that closed inside the range (percent). */
  inRangePct: number | null;
  /** The position left at the end (signed size in coins) and its average entry. */
  endPosition: { size: number; entryPrice: number; valueUsd: number };
  end: BacktestEnd;
  /** When the bot stopped (null: it ran to the end). */
  endedAt: number | null;
  curve: BacktestPoint[];
  /** The latest {@link BACKTEST_MAX_FILLS} fills. */
  fillList: BacktestFill[];
}

interface SimOrder {
  order: PlannedOrder;
  view: BotOrderView;
  price: number;
}

const cloidOf = (seq: number) => `0x${seq.toString(16).padStart(32, "0")}` as `0x${string}`;

/** Runs a grid or DCA bot over the candles. Throws a RangeError when there are no candles. */
export function backtestBot(input: BacktestInput): BacktestResult {
  const { config: c, candles, fees, szDecimals } = input;
  if (candles.length === 0) throw new RangeError("No candles to test on.");
  const funding = [...(input.funding ?? [])].sort((a, b) => a.t - b.t);
  const slip = BACKTEST_MARKET_SLIPPAGE_BPS / 10_000;
  const mmRate = 1 / (2 * Math.max(1, input.marketMaxLeverage));

  let book: BotCoinBook = emptyBook();
  let fundingUsd = 0;
  let liquidationLossUsd = 0;
  const orders = new Map<string, SimOrder>();
  /** Limit orders resting on the book. */
  const resting = new Set<SimOrder>();
  const views: Record<string, BotOrderView> = {};
  let gridState: GridState | null = null;
  let dcaState: DcaState | null = null;
  let completedGrids = 0;
  let ordersSkipped = 0;
  let cyclesClosed = 0;
  let buys = 0;
  let sells = 0;
  const fillList: BacktestFill[] = [];
  let fillsSinceStep = 0;
  let lastStepAt = -Infinity;
  let end: BacktestEnd = "end";
  let endedAt: number | null = null;
  let endedPrice = 0;
  let peakPnl = 0;
  let maxDrawdownUsd = 0;
  let maxDrawdownPct = 0;
  let maxPositionUsd = 0;
  let maxLeverage = 0;
  let fundingIdx = 0;
  const curve: BacktestPoint[] = [];

  const pnlAt = (price: number) =>
    book.realizedUsd - book.feesUsd + fundingUsd - liquidationLossUsd + (book.size !== 0 ? book.size * (price - book.entryPrice) : 0);

  const fill = (o: SimOrder, t: number, price: number, maker: boolean) => {
    let size = Number(o.order.size);
    if (o.order.reduceOnly) {
      const reducing = o.order.side === "buy" ? book.size < 0 : book.size > 0;
      size = reducing ? Math.min(size, Math.abs(book.size)) : 0;
      if (size <= 0) {
        o.view.status = "rejected";
        return;
      }
    }
    resting.delete(o);
    const feeUsd = size * price * ((maker ? fees.makerRate : fees.takerRate) + fees.builderRate);
    book = applyFill(book, { side: o.order.side, price, size, feeUsd });
    o.view.status = "filled";
    o.view.filledSize = size;
    if (o.order.side === "buy") buys += 1;
    else sells += 1;
    fillList.push({ t, side: o.order.side, price, size, maker });
    if (fillList.length > BACKTEST_MAX_FILLS * 2) fillList.splice(0, fillList.length - BACKTEST_MAX_FILLS);
    fillsSinceStep += 1;
  };

  /** Places a planner's orders at the price `p`: markets and limits beyond the price fill at once. */
  const place = (list: readonly PlannedOrder[], t: number, p: number) => {
    for (const order of list) {
      const view: BotOrderView = { status: "open", size: Number(order.size), filledSize: 0 };
      const price = order.price !== undefined ? Number(order.price) : p;
      const o: SimOrder = { order, view, price };
      const key = order.cloid.toLowerCase();
      orders.set(key, o);
      views[key] = view;
      if (order.type === "market") fill(o, t, order.side === "buy" ? p * (1 + slip) : p * (1 - slip), false);
      else if (order.side === "buy" ? price >= p : price <= p) fill(o, t, p, false);
      else resting.add(o);
    }
  };

  const cancel = (o: SimOrder | undefined) => {
    if (o && o.view.status === "open") {
      o.view.status = "canceled";
      resting.delete(o);
    }
  };
  const cancelAll = (keys?: readonly string[]) => {
    if (keys) for (const key of keys) cancel(orders.get(key.toLowerCase()));
    else for (const o of [...resting]) cancel(o);
  };

  /** Resting limits the move from `a` to `b` trades through, in the order the price meets them. */
  const fillAlong = (a: number, b: number, t: number) => {
    if (a === b) return;
    const down = b < a;
    const hit: SimOrder[] = [];
    for (const o of resting) {
      if (down ? o.order.side === "buy" && o.price < a && b < o.price : o.order.side === "sell" && o.price > a && b > o.price) hit.push(o);
    }
    hit.sort((x, y) => (down ? y.price - x.price : x.price - y.price));
    for (const o of hit) fill(o, t, o.price, true);
  };

  const stopWith = (kind: BacktestEnd, t: number, p: number, closePosition: boolean) => {
    cancelAll();
    if (closePosition && book.size !== 0) {
      const side = book.size > 0 ? "sell" : "buy";
      const order: PlannedOrder = { cloid: cloidOf(1e9 + 1), coin: c.coin, side, size: String(Math.abs(book.size)), type: "market", reduceOnly: true, label: "Close" };
      place([order], t, p);
    }
    end = kind;
    endedAt = t;
    endedPrice = p;
  };

  const gridEnd = (p: number): BacktestEnd => {
    const g = c as GridBotConfig;
    const reason = gridStopCondition(g, p);
    if (reason?.startsWith("Stop-loss")) return "stopLoss";
    if (reason?.startsWith("Take-profit")) return "takeProfit";
    if (reason) return "outOfRange";
    return "invalid";
  };

  /** One planner step at time `t` and price `p`. */
  const step = (t: number, p: number) => {
    const minutes = Number.isFinite(lastStepAt) ? (t - lastStepAt) / 60_000 : 1;
    const budget = Math.max(BACKTEST_ORDERS_PER_MINUTE, Math.floor(BACKTEST_ORDERS_PER_MINUTE * minutes));
    lastStepAt = t;
    fillsSinceStep = 0;
    let result: PlannerStep<unknown>;
    if (c.kind === "grid") {
      if (!gridState || gridState.phase === "waiting") {
        if (p >= c.lower && p <= c.upper && gridWorstPositionUsd(c, p, szDecimals) > c.maxLeverage * input.equityUsd) {
          stopWith("leverage", t, p, false);
          return;
        }
      }
      const r = gridStep({ config: c, state: gridState, mark: p, szDecimals, orders: views, cloid: cloidOf, maxNewOrders: budget });
      completedGrids = r.state.completedGrids;
      gridState = r.state;
      result = r;
    } else {
      const room = c.maxLeverage * Math.max(0, input.equityUsd + pnlAt(p)) - Math.abs(book.size) * p;
      const before = dcaState;
      const r = dcaStep({
        config: c,
        state: dcaState,
        now: t,
        mark: p,
        szDecimals,
        position: { size: book.size, entryPrice: book.entryPrice },
        orders: views,
        cloid: cloidOf,
        maxNewOrders: budget,
        entryRoomUsd: Math.max(0, room),
      });
      if (r.notes.some((n) => n.startsWith("Skipped this interval"))) ordersSkipped += 1;
      if (before && r.state.cycle > before.cycle) cyclesClosed += r.state.cycle - before.cycle;
      dcaState = r.state;
      result = r;
    }
    cancelAll(result.cancel);
    if (result.stop) {
      const kind: BacktestEnd = c.kind === "grid" ? gridEnd(p) : result.stop.finished ? "finished" : "invalid";
      stopWith(kind, t, p, result.stop.closePosition);
      return;
    }
    place(result.place, t, p);
  };

  const track = (t: number, p: number) => {
    const pnl = pnlAt(p);
    const equity = input.equityUsd + pnl;
    const value = Math.abs(book.size) * p;
    if (value > maxPositionUsd) maxPositionUsd = value;
    if (equity > 0 && value / equity > maxLeverage) maxLeverage = value / equity;
    if (pnl > peakPnl) peakPnl = pnl;
    const dd = peakPnl - pnl;
    if (dd > maxDrawdownUsd) {
      maxDrawdownUsd = dd;
      maxDrawdownPct = (dd / (input.equityUsd + peakPnl)) * 100;
    }
    // Liquidation: the account holds only the bot.
    if (book.size !== 0 && equity <= value * mmRate) {
      const kept = Math.max(0, equity);
      stopWith("liquidated", t, p, true);
      // The margin left at liquidation is lost too.
      liquidationLossUsd += Math.min(kept, value * mmRate);
    }
  };

  const payFunding = (until: number, priceAt: (t: number) => number) => {
    while (fundingIdx < funding.length && funding[fundingIdx]!.t <= until) {
      const f = funding[fundingIdx++]!;
      if (f.t < candles[0]!.t || book.size === 0) continue;
      fundingUsd -= book.size * priceAt(f.t) * f.rate;
    }
  };

  /** The DCA's next due order inside [from, to], or null. */
  const dueIn = (from: number, to: number) => {
    if (c.kind !== "dca" || !dcaState) return null;
    if (c.maxOrders !== undefined && dcaState.ordersPlaced >= c.maxOrders) return null;
    return dcaState.nextAt >= from && dcaState.nextAt <= to ? dcaState.nextAt : null;
  };

  // Funding before the first candle doesn't count.
  while (fundingIdx < funding.length && funding[fundingIdx]!.t < candles[0]!.t) fundingIdx += 1;
  step(candles[0]!.t, candles[0]!.o);

  const inRange = { yes: 0, all: 0 };
  for (const k of candles) {
    if (end !== "end") break;
    const path = k.c >= k.o ? [k.o, k.l, k.h, k.c] : [k.o, k.h, k.l, k.c];
    const third = input.intervalMs / 3;
    for (let i = 1; i < path.length && end === "end"; i++) {
      let ta = k.t + third * (i - 1);
      let pa = path[i - 1]!;
      const tb = i === path.length - 1 ? k.t + input.intervalMs - 1 : k.t + third * i;
      const pb = path[i]!;
      const priceAt = (t: number) => (tb === ta ? pb : pa + ((pb - pa) * (t - ta)) / (tb - ta));
      // Due DCA orders inside the segment run at their own time and price.
      for (let guard = 0; guard < 10_000 && end === "end"; guard++) {
        const due = dueIn(ta, tb);
        if (due === null) break;
        const pm = priceAt(due);
        fillAlong(pa, pm, due);
        payFunding(due, priceAt);
        track(due, pm);
        if (end !== "end") break;
        step(due, pm);
        ta = due;
        pa = pm;
        // No progress (nothing could be placed): the vertex step tries again.
        if ((dcaState as DcaState | null)?.nextAt === due) break;
      }
      if (end !== "end") break;
      fillAlong(pa, pb, tb);
      payFunding(tb, priceAt);
      track(tb, pb);
      if (end !== "end") break;
      step(tb, pb);
      // Orders placed at once can fill others' answers: step again while fills keep coming.
      for (let guard = 0; guard < 20 && fillsSinceStep > 0 && end === "end"; guard++) step(tb, pb);
    }
    if (c.kind === "grid") {
      inRange.all += 1;
      if (k.c >= c.lower && k.c <= c.upper) inRange.yes += 1;
    }
    if (endedAt !== null) curve.push({ t: endedAt, price: endedPrice, pnlUsd: pnlAt(endedPrice) });
    else curve.push({ t: k.t + input.intervalMs, price: k.c, pnlUsd: pnlAt(k.c) });
  }

  const last = candles[candles.length - 1]!;
  // A stopped bot is measured at its stop (a position it kept is the account's from then on).
  const markEnd = endedAt !== null ? endedPrice : last.c;
  const pnlUsd = pnlAt(markEnd);
  const first = candles[0]!;
  return {
    from: first.t,
    to: last.t + input.intervalMs,
    candles: candles.length,
    startPrice: first.o,
    endPrice: last.c,
    priceChangePct: ((last.c - first.o) / first.o) * 100,
    lowPrice: candles.reduce((m, k) => Math.min(m, k.l), Infinity),
    highPrice: candles.reduce((m, k) => Math.max(m, k.h), -Infinity),
    equityUsd: input.equityUsd,
    pnlUsd,
    realizedUsd: book.realizedUsd,
    unrealizedUsd: book.size !== 0 ? book.size * (markEnd - book.entryPrice) : 0,
    feesUsd: book.feesUsd,
    fundingUsd,
    returnPct: (pnlUsd / input.equityUsd) * 100,
    fills: book.fills,
    buys,
    sells,
    volumeUsd: book.volumeUsd,
    completedGrids,
    ordersPlaced: (dcaState as DcaState | null)?.ordersPlaced ?? 0,
    ordersSkipped,
    cyclesClosed,
    maxDrawdownUsd,
    maxDrawdownPct,
    maxPositionUsd,
    maxLeverage,
    inRangePct: c.kind === "grid" && inRange.all > 0 ? (inRange.yes / inRange.all) * 100 : null,
    endPosition: { size: book.size, entryPrice: book.entryPrice, valueUsd: Math.abs(book.size) * markEnd },
    end,
    endedAt,
    curve: thin(curve, BACKTEST_CURVE_POINTS),
    fillList: fillList.slice(-BACKTEST_MAX_FILLS),
  };
}

/** The largest position a grid can hold from the price `mark`: every buy below it filled, or every sell above it. */
export function gridWorstPositionUsd(c: Pick<GridBotConfig, "lower" | "upper" | "levels" | "spacing" | "orderSizeUsd">, mark: number, szDecimals: number): number {
  const size = Number(gridOrderSize(c, szDecimals));
  const prices = gridPrices(c);
  const below = prices.filter((p) => p < mark).reduce((s, p) => s + size * p, 0);
  const above = prices.filter((p) => p > mark).reduce((s, p) => s + size * p, 0);
  return Math.max(below, above);
}

/** At most `n` points, evenly picked, the first and the last kept. */
function thin<T>(list: readonly T[], n: number): T[] {
  if (list.length <= n) return [...list];
  const out: T[] = [];
  const step = (list.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(list[Math.round(i * step)]!);
  return out;
}

/** The candle interval to test a period on: fine enough for grids, within Hyperliquid's 5,000 latest candles. */
export function backtestInterval(days: number): { interval: "5m" | "15m" | "1h"; ms: number } {
  if (days <= 14) return { interval: "5m", ms: 5 * 60_000 };
  if (days <= 45) return { interval: "15m", ms: 15 * 60_000 };
  return { interval: "1h", ms: 60 * 60_000 };
}
