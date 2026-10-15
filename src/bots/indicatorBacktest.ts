/**
 * Indicator bot backtest: where its rules would have fired over past candles and, for a bot that trades, what its
 * orders would have made. The rules are read with the server's code ({@link indicatorDecision}) and the orders are
 * sized with the signal bot's planner ({@link planSignal}: order size, caps, leverage, direction), so the test follows
 * the bot's real rules.
 *
 * - The rules are read at every close; what they decide is done at the next candle's open, as a market order moved
 *   {@link BACKTEST_MARKET_SLIPPAGE_BPS} against it, with the taker fee (the server reads a close within about a minute
 *   of it and trades at the price then).
 * - Candles before `from` only warm the indicators up; nothing fires on them.
 * - Funding is paid or received at every funding time in the data; the account holds only this bot and is liquidated
 *   when its value falls to the maintenance margin (half the margin at the market's maximum leverage), as in the grid
 *   and DCA test ({@link backtestBot}).
 *
 * @module
 */
import { BACKTEST_CURVE_POINTS, BACKTEST_MARKET_SLIPPAGE_BPS, BACKTEST_MAX_FILLS, type BacktestCandle, type BacktestFill, type BacktestPoint } from "./backtest.js";
import { indicatorBars, indicatorDecision, IndicatorReader, type IndicatorAction } from "./indicatorRules.js";
import { applyFill, emptyBook, type BotCoinBook } from "./ledger.js";
import { indicatorSignalConfig, type IndicatorBotConfig } from "./schema.js";
import { planSignal } from "./signal.js";

/** Rule hits kept for the result (the latest ones). */
export const BACKTEST_MAX_SIGNALS = 300;

export interface IndicatorBacktestInput {
  config: IndicatorBotConfig;
  /** Closed candles with their volume, oldest first, one interval apart. */
  candles: readonly (BacktestCandle & { v: number })[];
  /** The test's first candle (open time, ms): earlier candles only warm the indicators up. */
  from: number;
  /** Candle length (ms). */
  intervalMs: number;
  /** Funding rates per funding time (fraction; positive: longs pay shorts). */
  funding?: readonly { t: number; rate: number }[];
  szDecimals: number;
  /** The market's maximum leverage (sets the maintenance margin). */
  marketMaxLeverage: number;
  /** Fee rates as fractions: Hyperliquid's taker fee and Kokoah's builder fee (on every fill). */
  fees: { takerRate: number; builderRate: number };
  /** Value of the account the bot trades in at the start (USD). */
  equityUsd: number;
}

export interface IndicatorSignalHit {
  /** The close the rules fired at (ms). */
  t: number;
  /** The price at that close. */
  price: number;
  /** The rules that fired, by index. */
  rules: number[];
  actions: IndicatorAction[];
  /** A buy and a sell rule fired together: neither acts. */
  conflict: boolean;
  /** A bot that trades: what it did at the next open, or why it did nothing (plain words, English). */
  outcome?: string;
}

export interface IndicatorBacktestResult {
  from: number;
  to: number;
  /** Candles tested (warm-up ones not counted). */
  candles: number;
  startPrice: number;
  endPrice: number;
  priceChangePct: number;
  lowPrice: number;
  highPrice: number;
  equityUsd: number;
  /** After fees and funding: realized + unrealized − fees + funding (0 for a bot that only alerts). */
  pnlUsd: number;
  realizedUsd: number;
  unrealizedUsd: number;
  feesUsd: number;
  fundingUsd: number;
  returnPct: number;
  fills: number;
  buys: number;
  sells: number;
  volumeUsd: number;
  /** Positions opened and closed again (or flipped), and how many of them made money after fees. */
  roundTrips: number;
  wins: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  maxPositionUsd: number;
  maxLeverage: number;
  endPosition: { size: number; entryPrice: number; valueUsd: number };
  end: "end" | "liquidated";
  endedAt: number | null;
  /** Closes where a rule fired, and the latest {@link BACKTEST_MAX_SIGNALS} of them. */
  signals: number;
  signalList: IndicatorSignalHit[];
  curve: BacktestPoint[];
  fillList: BacktestFill[];
}

/** Runs an indicator bot over the candles. Throws a RangeError when no candle is at or after `from`. */
export function backtestIndicatorBot(input: IndicatorBacktestInput): IndicatorBacktestResult {
  const { config: c, candles, fees, szDecimals, intervalMs } = input;
  const first = candles.findIndex((k) => k.t >= input.from);
  if (first < 0) throw new RangeError("No candles to test on.");
  const reader = new IndicatorReader(indicatorBars(candles, intervalMs));
  const signalConfig = indicatorSignalConfig(c);
  const funding = [...(input.funding ?? [])].sort((a, b) => a.t - b.t);
  const slip = BACKTEST_MARKET_SLIPPAGE_BPS / 10_000;
  const mmRate = 1 / (2 * Math.max(1, input.marketMaxLeverage));

  let book: BotCoinBook = emptyBook();
  let fundingUsd = 0;
  let liquidationLossUsd = 0;
  let buys = 0;
  let sells = 0;
  let roundTrips = 0;
  let wins = 0;
  /** Realized PnL, fees and funding when the open position was opened (its round trip's result is measured from it). */
  let tripStart = 0;
  const fillList: BacktestFill[] = [];
  const signalList: IndicatorSignalHit[] = [];
  let signals = 0;
  let end: IndicatorBacktestResult["end"] = "end";
  let endedAt: number | null = null;
  let endedPrice = 0;
  let peakPnl = 0;
  let maxDrawdownUsd = 0;
  let maxDrawdownPct = 0;
  let maxPositionUsd = 0;
  let maxLeverage = 0;
  let fundingIdx = 0;
  let seq = 0;
  const curve: BacktestPoint[] = [];

  const resultSoFar = () => book.realizedUsd - book.feesUsd + fundingUsd - liquidationLossUsd;
  const pnlAt = (price: number) => resultSoFar() + (book.size !== 0 ? book.size * (price - book.entryPrice) : 0);

  const fill = (t: number, side: "buy" | "sell", size: number, price: number) => {
    const before = book.size;
    const resultBefore = resultSoFar();
    book = applyFill(book, { side, price, size, feeUsd: size * price * (fees.takerRate + fees.builderRate) });
    if (side === "buy") buys += 1;
    else sells += 1;
    fillList.push({ t, side, price, size, maker: false });
    if (fillList.length > BACKTEST_MAX_FILLS * 2) fillList.splice(0, fillList.length - BACKTEST_MAX_FILLS);
    // A position closed or flipped ends a round trip; one opened from flat (its fee counted) or by the flip starts one.
    if (before !== 0 && (book.size === 0 || Math.sign(book.size) !== Math.sign(before))) {
      roundTrips += 1;
      if (resultSoFar() > tripStart) wins += 1;
    }
    if (book.size !== 0 && before === 0) tripStart = resultBefore;
    else if (book.size !== 0 && Math.sign(book.size) !== Math.sign(before)) tripStart = resultSoFar();
  };

  /** Does what the rules decided at the open `p` of the candle at `t`; returns what happened. */
  const act = (actions: readonly IndicatorAction[], t: number, p: number): string => {
    if (!signalConfig) return "";
    const notes: string[] = [];
    for (const action of actions) {
      const plan = planSignal({
        config: signalConfig,
        alert: { id: "backtest", action, reduceOnly: false, orderType: "market" },
        mark: p,
        szDecimals,
        position: book.size,
        accountPosition: book.size,
        account: { equityUsd: Math.max(0, input.equityUsd + pnlAt(p)), totalNotionalUsd: Math.abs(book.size) * p },
        cloid: `0x${(seq++).toString(16).padStart(32, "0")}`,
      });
      if (!plan.ok) {
        notes.push(plan.reason);
        continue;
      }
      const o = plan.order;
      fill(t, o.side, Number(o.size), o.side === "buy" ? p * (1 + slip) : p * (1 - slip));
      notes.push(plan.note);
    }
    return notes.join(" ");
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
    // Liquidation: the account holds only the bot; its position is closed and the margin left is lost too.
    if (book.size !== 0 && equity <= value * mmRate) {
      const kept = Math.max(0, equity);
      fill(t, book.size > 0 ? "sell" : "buy", Math.abs(book.size), p);
      liquidationLossUsd += Math.min(kept, value * mmRate);
      end = "liquidated";
      endedAt = t;
      endedPrice = p;
    }
  };

  const payFunding = (until: number, priceAt: (t: number) => number) => {
    while (fundingIdx < funding.length && funding[fundingIdx]!.t <= until) {
      const f = funding[fundingIdx++]!;
      if (book.size === 0) continue;
      fundingUsd -= book.size * priceAt(f.t) * f.rate;
    }
  };

  // Funding before the test doesn't count.
  while (fundingIdx < funding.length && funding[fundingIdx]!.t < candles[first]!.t) fundingIdx += 1;
  let due: { actions: IndicatorAction[]; hit: IndicatorSignalHit } | null = null;
  for (let i = first; i < candles.length && end === "end"; i++) {
    const k = candles[i]!;
    if (due) {
      due.hit.outcome = act(due.actions, k.t, k.o);
      due = null;
    }
    const path = k.c >= k.o ? [k.o, k.l, k.h, k.c] : [k.o, k.h, k.l, k.c];
    const third = intervalMs / 3;
    for (let j = 1; j < path.length && end === "end"; j++) {
      const ta = k.t + third * (j - 1);
      const tb = j === path.length - 1 ? k.t + intervalMs - 1 : k.t + third * j;
      const [pa, pb] = [path[j - 1]!, path[j]!];
      payFunding(tb, (t) => pa + ((pb - pa) * (t - ta)) / Math.max(1, tb - ta));
      track(tb, pb);
    }
    if (end !== "end") {
      curve.push({ t: endedAt!, price: endedPrice, pnlUsd: pnlAt(endedPrice) });
      break;
    }
    const d = indicatorDecision(c.rules, reader, i);
    if (d.fired.length > 0) {
      signals += 1;
      const hit: IndicatorSignalHit = { t: k.t + intervalMs, price: k.c, rules: d.fired, actions: d.actions, conflict: d.conflict };
      if (signalConfig) {
        if (d.conflict && d.actions.length === 0) hit.outcome = "A buy and a sell rule fired together: nothing done.";
        else if (i === candles.length - 1) hit.outcome = "After the test's last candle.";
        else due = { actions: d.actions, hit };
      }
      signalList.push(hit);
      if (signalList.length > BACKTEST_MAX_SIGNALS * 2) signalList.splice(0, signalList.length - BACKTEST_MAX_SIGNALS);
    }
    curve.push({ t: k.t + intervalMs, price: k.c, pnlUsd: pnlAt(k.c) });
  }

  const tested = candles.slice(first);
  const last = tested[tested.length - 1]!;
  const markEnd = endedAt !== null ? endedPrice : last.c;
  const pnlUsd = pnlAt(markEnd);
  return {
    from: tested[0]!.t,
    to: last.t + intervalMs,
    candles: tested.length,
    startPrice: tested[0]!.o,
    endPrice: last.c,
    priceChangePct: ((last.c - tested[0]!.o) / tested[0]!.o) * 100,
    lowPrice: tested.reduce((m, k) => Math.min(m, k.l), Infinity),
    highPrice: tested.reduce((m, k) => Math.max(m, k.h), -Infinity),
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
    roundTrips,
    wins,
    maxDrawdownUsd,
    maxDrawdownPct,
    maxPositionUsd,
    maxLeverage,
    endPosition: { size: book.size, entryPrice: book.entryPrice, valueUsd: Math.abs(book.size) * markEnd },
    end,
    endedAt,
    signals,
    signalList: signalList.slice(-BACKTEST_MAX_SIGNALS),
    curve: thin(curve, BACKTEST_CURVE_POINTS),
    fillList: fillList.slice(-BACKTEST_MAX_FILLS),
  };
}

/** At most `n` points, evenly picked, the first and the last kept. */
function thin<T>(list: readonly T[], n: number): T[] {
  if (list.length <= n) return [...list];
  const out: T[] = [];
  const step = (list.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(list[Math.round(i * step)]!);
  return out;
}
