/**
 * Copy-trading backtest: what copying a trader with these settings would have done over a past period, with the
 * server's own planner ({@link copyStep}), so the test follows the copy's real rules (copying only changes after the
 * start, the caps per order and in total, the leverage cap, allowed and denied markets, drawdown and daily loss stops).
 *
 * The trader's positions are rebuilt from their fills (each carries the position before it). The follow poller sees
 * them every {@link CopyBacktestInput.pollMs}, so changes inside one poll are seen as one (a quick in-and-out between
 * two polls is not copied, as live). Prices: the trader's fills, and hourly closes between them. Copy orders fill at
 * the latest price moved {@link COPY_BACKTEST_SLIPPAGE_BPS} against them (the copy trades after the trader), with the
 * taker fee. Funding is paid or received at the rates the trader's own funding shows for each market and hour. The
 * account holds only the copy: it is liquidated when its value falls to the maintenance margin.
 *
 * @module
 */
import { applyFill, emptyBook, type BotCoinBook } from "./ledger.js";
import { copyStep, type CopyState } from "./copy.js";
import type { PlannedOrder } from "./orders.js";
import type { CopyBotConfig } from "./schema.js";
import { BACKTEST_CURVE_POINTS } from "./backtest.js";

/** Copy orders fill this far from the latest price, against them (basis points): the copy trades after the trader. */
export const COPY_BACKTEST_SLIPPAGE_BPS = 10;
/** The follow poller's interval (the server's FOLLOW_POLL_MIN_INTERVAL_MS). */
export const COPY_BACKTEST_POLL_MS = 30_000;
const HOUR = 3_600_000;

/** One of the trader's fills. */
export interface CopyBacktestFill {
  t: number;
  coin: string;
  side: "B" | "A";
  sz: number;
  px: number;
  /** The trader's position in the coin before this fill (signed). */
  startPosition: number;
  /** The trader's realized PnL of this fill, after its fee (for the comparison), when known. */
  pnlUsd?: number;
}

export interface CopyBacktestInput {
  config: CopyBotConfig;
  /** The trader's fills inside [from, to), oldest first. */
  fills: readonly CopyBacktestFill[];
  from: number;
  to: number;
  /** Hourly closes per coin, oldest first (prices between the trader's fills). */
  closes?: Readonly<Record<string, readonly { t: number; c: number }[]>>;
  /** Funding rates per coin and hour, from the trader's funding (fraction; positive: longs pay). */
  funding?: Readonly<Record<string, readonly { t: number; rate: number }[]>>;
  /** Each coin's size decimals and maximum leverage (coins without are skipped, as live without a price). */
  markets: Readonly<Record<string, { szDecimals: number; maxLeverage: number }>>;
  fees: { takerRate: number; builderRate: number };
  equityUsd: number;
  pollMs?: number;
  /** The trader's realized PnL over the period after fees, when known as a whole (else summed from the fills). */
  traderPnlUsd?: number | null;
  /** How many fills the trader made in the period, when `fills` are {@link copyChanges} (else counted). */
  traderFillCount?: number;
}

export type CopyBacktestEnd = "end" | "drawdown" | "dailyLoss" | "liquidated";

export interface CopyBacktestResult {
  from: number;
  to: number;
  equityUsd: number;
  pnlUsd: number;
  realizedUsd: number;
  unrealizedUsd: number;
  feesUsd: number;
  fundingUsd: number;
  returnPct: number;
  /** The trader's own realized PnL over the period (after fees), when the fills carry it. */
  traderPnlUsd: number | null;
  traderFills: number;
  /** Position changes the copy acted on, and those it skipped, by reason. */
  copied: number;
  skipped: { total: number; caps: number; minimum: number; markets: number; other: number };
  fills: number;
  volumeUsd: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  /** Largest total value of the copied positions, and that as a multiple of the account value at the time. */
  maxPositionUsd: number;
  maxLeverage: number;
  /** Per market, largest result first (at most 12). */
  byCoin: { coin: string; pnlUsd: number; fills: number; volumeUsd: number }[];
  openPositions: { coin: string; size: number; valueUsd: number }[];
  end: CopyBacktestEnd;
  endedAt: number | null;
  curve: { t: number; pnlUsd: number }[];
}

const cloidOf = (seq: number) => `0x${seq.toString(16).padStart(32, "0")}` as `0x${string}`;

/** Runs the copy over the trader's fills. */
export function backtestCopy(input: CopyBacktestInput): CopyBacktestResult {
  const { config: c, from, to, fees } = input;
  const pollMs = Math.max(1000, input.pollMs ?? COPY_BACKTEST_POLL_MS);
  const slip = COPY_BACKTEST_SLIPPAGE_BPS / 10_000;
  // Main-dex perps only: the follow poller reads the trader's main-dex positions (no spot, no HIP-3), as live.
  const fills = input.fills.filter((f) => f.t >= from && f.t < to && isMainPerp(f.coin)).sort((a, b) => a.t - b.t);

  // The trader's positions at the start: each coin's position before its first fill in the period.
  const leader: Record<string, number> = {};
  for (const f of fills) if (!(f.coin in leader)) leader[f.coin] = f.startPosition;
  for (const k of Object.keys(leader)) if (leader[k] === 0) delete leader[k];

  const books: Record<string, BotCoinBook> = {};
  const px: Record<string, number> = {};
  let fundingUsd = 0;
  let liquidationLossUsd = 0;
  let state: CopyState | null = null;
  let seq = 0;
  let copied = 0;
  const skipped = { total: 0, caps: 0, minimum: 0, markets: 0, other: 0 };
  const coinFunding: Record<string, number> = {};
  let end: CopyBacktestEnd = "end";
  let endedAt: number | null = null;
  let peakPnl = 0;
  let maxDrawdownUsd = 0;
  let maxDrawdownPct = 0;
  let maxPositionUsd = 0;
  let maxLeverage = 0;
  const curve: { t: number; pnlUsd: number }[] = [];
  let traderPnl: number | null = input.traderPnlUsd ?? null;
  const sumTraderPnl = input.traderPnlUsd === undefined;

  const positions = () => {
    const out: Record<string, number> = {};
    for (const [coin, b] of Object.entries(books)) if (b.size !== 0) out[coin] = b.size;
    return out;
  };
  const totals = () => {
    let realized = 0;
    let fee = 0;
    let unrealized = 0;
    let notional = 0;
    let maintenance = 0;
    for (const [coin, b] of Object.entries(books)) {
      realized += b.realizedUsd;
      fee += b.feesUsd;
      if (b.size !== 0) {
        const p = px[coin] ?? b.entryPrice;
        unrealized += b.size * (p - b.entryPrice);
        notional += Math.abs(b.size) * p;
        maintenance += (Math.abs(b.size) * p) / (2 * Math.max(1, input.markets[coin]?.maxLeverage ?? 1));
      }
    }
    const pnl = realized - fee + fundingUsd - liquidationLossUsd + unrealized;
    return { realized, fee, unrealized, notional, maintenance, pnl };
  };

  const fill = (order: PlannedOrder) => {
    const p = px[order.coin];
    if (p === undefined) return;
    const book = books[order.coin] ?? emptyBook();
    let size = Number(order.size);
    if (order.reduceOnly) {
      const reducing = order.side === "buy" ? book.size < 0 : book.size > 0;
      size = reducing ? Math.min(size, Math.abs(book.size)) : 0;
      if (size <= 0) return;
    }
    const price = order.side === "buy" ? p * (1 + slip) : p * (1 - slip);
    books[order.coin] = applyFill(book, { side: order.side, price, size, feeUsd: size * price * (fees.takerRate + fees.builderRate) });
  };

  const closeAll = () => {
    for (const [coin, b] of Object.entries(books)) {
      if (b.size === 0) continue;
      fill({ cloid: cloidOf(1e9 + seq++), coin, side: b.size > 0 ? "sell" : "buy", size: String(Math.abs(b.size)), type: "market", reduceOnly: true, label: "Close" });
    }
  };

  const stopWith = (kind: CopyBacktestEnd, t: number, closePosition: boolean) => {
    if (closePosition) closeAll();
    end = kind;
    endedAt = t;
  };

  const track = (t: number) => {
    const x = totals();
    const equity = input.equityUsd + x.pnl;
    if (x.notional > maxPositionUsd) maxPositionUsd = x.notional;
    if (equity > 0 && x.notional / equity > maxLeverage) maxLeverage = x.notional / equity;
    if (x.pnl > peakPnl) peakPnl = x.pnl;
    const dd = peakPnl - x.pnl;
    if (dd > maxDrawdownUsd) {
      maxDrawdownUsd = dd;
      maxDrawdownPct = (dd / (input.equityUsd + peakPnl)) * 100;
    }
    if (x.notional > 0 && equity <= x.maintenance) {
      const kept = Math.max(0, equity);
      stopWith("liquidated", t, true);
      liquidationLossUsd += Math.min(kept, x.maintenance);
    }
  };

  /** One planner step at time `t`; `changed`: a new poll of the trader's positions. */
  const step = (t: number, changed: boolean) => {
    const x = totals();
    const marks: Record<string, number> = {};
    const szDecimals: Record<string, number> = {};
    for (const [coin, m] of Object.entries(input.markets)) {
      if (px[coin] !== undefined) marks[coin] = px[coin]!;
      szDecimals[coin] = m.szDecimals;
    }
    if (changed) seq += 1;
    const own = positions();
    const r = copyStep({
      config: c,
      state,
      leader: { seq, positions: { ...leader }, polledAt: t },
      now: t,
      marks,
      szDecimals,
      positions: own,
      account: { equityUsd: input.equityUsd + x.pnl, totalNotionalUsd: x.notional, positions: own },
      claimed: new Set(),
      pnl: { realizedUsd: x.realized - x.fee + fundingUsd - liquidationLossUsd, unrealizedUsd: x.unrealized },
      cloid: cloidOf,
    });
    state = r.state;
    if (changed) {
      for (const n of r.notes) {
        if (!n.startsWith("Skipped")) continue;
        skipped.total += 1;
        if (/leverage cap|total cap|cap per order/.test(n)) skipped.caps += 1;
        else if (/minimum|copy ratio/.test(n)) skipped.minimum += 1;
        else if (/allowed|denied|HIP-3|another of your bots/.test(n)) skipped.markets += 1;
        else skipped.other += 1;
      }
    }
    if (r.stop) {
      stopWith(r.stop.reason.startsWith("Drawdown") ? "drawdown" : "dailyLoss", t, r.stop.closePosition);
      return;
    }
    if (r.place.length) copied += 1;
    for (const order of r.place) fill(order);
  };

  // Funding and hourly closes as one list of hourly events.
  const hourly: { t: number; coin: string; close?: number; rate?: number }[] = [];
  for (const [coin, list] of Object.entries(input.closes ?? {})) for (const k of list) if (k.t >= from && k.t < to) hourly.push({ t: k.t, coin, close: k.c });
  for (const [coin, list] of Object.entries(input.funding ?? {})) for (const f of list) if (f.t >= from && f.t < to) hourly.push({ t: f.t, coin, rate: f.rate });
  hourly.sort((a, b) => a.t - b.t);
  // A price for every coin from the start: its first close, else its first fill.
  for (const [coin, list] of Object.entries(input.closes ?? {})) {
    const first = list.find((k) => k.t >= from - HOUR) ?? list[0];
    if (first) px[coin] = first.c;
  }
  for (const f of fills) if (px[f.coin] === undefined) px[f.coin] = f.px;

  // The baseline poll at the start (positions held then are not copied).
  step(from, true);
  let fi = 0;
  let hi = 0;
  let nextCurve = from + HOUR;
  for (let poll = from + pollMs; poll <= to && end === "end"; ) {
    // Jump to the next poll that sees a fill, or the next hourly event, whichever comes first.
    const nextFill = fi < fills.length ? fills[fi]!.t : Infinity;
    const nextHour = hi < hourly.length ? hourly[hi]!.t : Infinity;
    const fillPoll = nextFill === Infinity ? Infinity : from + Math.ceil((nextFill - from) / pollMs) * pollMs;
    const at = Math.min(fillPoll, nextHour, nextCurve, to);
    if (at === Infinity) break;
    poll = at;
    // Hourly events up to now: prices and funding on the copy's positions.
    while (hi < hourly.length && hourly[hi]!.t <= at) {
      const h = hourly[hi++]!;
      if (h.close !== undefined) px[h.coin] = h.close;
      if (h.rate !== undefined) {
        const size = books[h.coin]?.size ?? 0;
        const p = px[h.coin];
        if (size !== 0 && p !== undefined) {
          const paid = size * p * h.rate;
          fundingUsd -= paid;
          coinFunding[h.coin] = (coinFunding[h.coin] ?? 0) - paid;
        }
      }
    }
    // The trader's fills seen by this poll.
    let changed = false;
    while (fi < fills.length && fills[fi]!.t <= at) {
      const f = fills[fi++]!;
      const signed = f.side === "B" ? f.sz : -f.sz;
      const after = Math.round((f.startPosition + signed) * 1e8) / 1e8;
      if (after === 0) delete leader[f.coin];
      else leader[f.coin] = after;
      px[f.coin] = f.px;
      if (sumTraderPnl && f.pnlUsd !== undefined) traderPnl = (traderPnl ?? 0) + f.pnlUsd;
      changed = true;
    }
    track(at);
    if (end !== "end") break;
    if (changed || at === nextCurve) step(at, changed);
    if (end !== "end") break;
    if (at >= nextCurve) {
      curve.push({ t: at, pnlUsd: totals().pnl });
      nextCurve += HOUR;
    }
    if (at >= to) break;
  }

  const x = totals();
  const last = endedAt ?? to;
  curve.push({ t: last, pnlUsd: x.pnl });
  const byCoin = Object.entries(books)
    .map(([coin, b]) => {
      const p = px[coin] ?? b.entryPrice;
      return {
        coin,
        pnlUsd: b.realizedUsd - b.feesUsd + (coinFunding[coin] ?? 0) + (b.size !== 0 ? b.size * (p - b.entryPrice) : 0),
        fills: b.fills,
        volumeUsd: b.volumeUsd,
      };
    })
    .filter((r) => r.fills > 0)
    .sort((a, b) => b.pnlUsd - a.pnlUsd);
  let fillsCount = 0;
  let volume = 0;
  for (const b of Object.values(books)) {
    fillsCount += b.fills;
    volume += b.volumeUsd;
  }
  return {
    from,
    to,
    equityUsd: input.equityUsd,
    pnlUsd: x.pnl,
    realizedUsd: x.realized,
    unrealizedUsd: x.unrealized,
    feesUsd: x.fee,
    fundingUsd,
    returnPct: (x.pnl / input.equityUsd) * 100,
    traderPnlUsd: traderPnl,
    traderFills: input.traderFillCount ?? fills.length,
    copied,
    skipped,
    fills: fillsCount,
    volumeUsd: volume,
    maxDrawdownUsd,
    maxDrawdownPct,
    maxPositionUsd,
    maxLeverage,
    byCoin: byCoin.slice(0, 12),
    openPositions: Object.entries(books)
      .filter(([, b]) => b.size !== 0)
      .map(([coin, b]) => ({ coin, size: b.size, valueUsd: Math.abs(b.size) * (px[coin] ?? b.entryPrice) })),
    end,
    endedAt,
    curve: thin(curve, BACKTEST_CURVE_POINTS),
  };
}

/**
 * The trader's position changes as the follow poller would see them, from their fills (oldest first): each coin's
 * position at the end of every `pollMs` slot it changed in, with the slot's last price, as {@link CopyBacktestFill}s
 * (one per changed slot), and the first one per coin starting from its position before the period. Much smaller than
 * the fills of an active trader, and the same copy.
 */
export function copyChanges(fills: readonly CopyBacktestFill[], from: number, pollMs = COPY_BACKTEST_POLL_MS): CopyBacktestFill[] {
  const out: CopyBacktestFill[] = [];
  const pos: Record<string, number> = {};
  const open = new Map<string, CopyBacktestFill>();
  let slot = -1;
  const flush = () => {
    for (const f of open.values()) if (f.sz > 0) out.push(f);
    open.clear();
  };
  for (const f of [...fills].sort((a, b) => a.t - b.t)) {
    if (f.t < from || !isMainPerp(f.coin)) continue;
    const s = Math.ceil((f.t - from) / pollMs);
    if (s !== slot) {
      flush();
      slot = s;
    }
    const before = pos[f.coin] ?? f.startPosition;
    const after = Math.round((f.startPosition + (f.side === "B" ? f.sz : -f.sz)) * 1e8) / 1e8;
    pos[f.coin] = after;
    const prev = open.get(f.coin);
    const start = prev ? prev.startPosition : before;
    const delta = after - start;
    open.set(f.coin, { t: from + s * pollMs, coin: f.coin, side: delta >= 0 ? "B" : "A", sz: Math.abs(delta), px: f.px, startPosition: start });
  }
  flush();
  return out;
}

/** A main-dex perp ("BTC"), not a spot pair ("@107", "PURR/USDC") or a HIP-3 market ("xyz:SP500"). */
export const isMainPerp = (coin: string) => !coin.startsWith("@") && !coin.includes("/") && !coin.includes(":");

function thin<T>(list: readonly T[], n: number): T[] {
  if (list.length <= n) return [...list];
  const out: T[] = [];
  const step = (list.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(list[Math.round(i * step)]!);
  return out;
}
