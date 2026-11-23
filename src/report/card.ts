/**
 * The trading report card's numbers: one address's perps over a window (the last 30 days, or a calendar month), after
 * costs, with the count of rows behind every figure (the app shows them as receipts and sample sizes). Pure functions
 * over what the caller read: the app reads it in the visitor's browser, and the backend can compute the same card from
 * the same reads. The fixed numbers are in `rules.ts`.
 *
 * Data (read by the caller, {@link ReportInput})
 * - Fills: the address's fills (Kokoah's history store, and Hyperliquid's `userFillsByTime` for the times the store
 *   may lack), with the times in the window no read covered (`unfilledGaps`): with any, the card is not complete.
 * - Funding: Hyperliquid's `userFunding` (one list for every perp dex, HIP-3 included), whole from `from` through
 *   `through`. When it doesn't reach over the window, the card's funding is not complete, and its coverage says how
 *   far it reaches.
 * - Hyperliquid's own PnL: `portfolio`'s `perpMonth` (perps on every dex). Open positions: `clearinghouseState` for
 *   each perp dex. Both only for a window that reaches now.
 * - Orders, only when the address was liquidated in the window: `frontendOpenOrders` for each perp dex a liquidation
 *   was on (at most {@link MAX_ORDER_DEXES}), then one `historicalOrders` (every dex at once, at most
 *   {@link HL_ORDER_HISTORY} statuses). A failed read leaves the stop-loss check unread; the card goes on without it.
 *
 * Window and scope: by default the 30 days before `now` (rolling, inclusive), like Hyperliquid's own month; or the
 * window the caller gives (`input.window`; {@link monthWindow}: a calendar month in UTC), its end stopped at `now`
 * ({@link reportWindow}). Positions open now and Hyperliquid's 30-day figure describe now, so only a window that reaches
 * `now` (`live`: the last 30 days, or a month still under way) reads them; a window that ended earlier leaves both out.
 * Perps only: the main dex and HIP-3 dexes (`dex:COIN`); spot fills (`@107`, `PURR/USDC`) are counted in the coverage
 * line and left out. A HIP-3 dex's amounts are in its collateral token, a dollar stablecoin, and count as dollars.
 *
 * Money: totals are exact. Hyperliquid writes amounts as decimal strings with at most 8 decimals; they are summed in
 * integer units of 1e-8 (a `Sum`'s `usd` is a decimal string, as the API writes money). Trip figures (win rate,
 * averages, medians, buckets) come from the round-trip builder (`journal`), which works in numbers.
 *
 * Checked against Hyperliquid (mainnet, 2026-11-21; two accounts, one trading main-dex perps only, one trading
 * mostly HIP-3 markets with 22 liquidations; a dozen single read-only requests):
 * - `closedPnl` leaves fees out. The first account was flat at both ends of Hyperliquid's week: Σ closedPnl − Σ fee +
 *   Σ funding = −7,729.50 against the `perpWeek` PnL change of −7,729.34, with 1,144.69 of fees in the week (had
 *   `closedPnl` held the fees, the gap would be that). That account is a unified one (its perps balance reads 0, the
 *   money sits in spot): Hyperliquid's perp PnL holds for those too. On 52 trips from flat to flat, Σ closedPnl
 *   equals the price change (sells' notional − buys') within $0.29 on trips that paid $1.06 to $256 in fees.
 * - Funding: `usdc` above zero is received and below zero paid; it is added as it is (result = closedPnl − fee +
 *   usdc). 1,753 of 1,754 hourly entries have the sign of −size × rate; the other is a HIP-3 hour whose averaged rate
 *   was about zero (−0.00000013). The sign is never derived from the rate.
 * - `fee` is the whole fee: it holds the builder fee (`builderFee` ≤ `fee` on all 428 fills that paid one) and a HIP-3
 *   dex's deployer share. Exchange fees are `fee − builderFee`.
 * - Volume (Σ px × sz) matches `perpMonth.vlm` within $2.40 on $949k and $6.0M: Hyperliquid's perp windows include
 *   HIP-3 dexes.
 * - Liquidations: the address's own fills carry `liquidation.liquidatedUser` equal to the address. A market
 *   liquidation's fills look like any close (`dir` "Close Long", `crossed`, the usual fee); a backstop one reads
 *   "Liquidated Isolated Long", not crossed, fee 0. The second account had 60 such fills in 22 orders: −17,469.52 of
 *   `closedPnl` and 34.14 of fees.
 * - Hyperliquid's month starts at its first sample, about 30.6 days back, not 30. The card takes Hyperliquid's figure
 *   from the last sample at or before the window start (`hyperliquid.from` says when). Positions already open at the
 *   window start make the two differ by their unrealized PnL then, which no API gives: the second account, with 17
 *   markets open at the start, differed by −8,714.73. With nothing open at the start, what the positions open now
 *   don't explain is put down to the graph's timing (it is sampled, so its ends fall a little off the window) only
 *   when the history is complete and it is at most {@link TIMING_LIMIT_USD} or {@link TIMING_LIMIT_SHARE} of the
 *   result, whichever is larger (`difference.timing`).
 * - The history store matched Hyperliquid field by field on 924 fills; the 24 fills only Hyperliquid had all lay in
 *   one of the store's reported gaps.
 * - Orders (mainnet, 2026-11-23; one account liquidated 257 times in the window, one `historicalOrders` and one
 *   `frontendOpenOrders` per dex): `historicalOrders` takes no dex and holds every dex's orders, HIP-3 too. It is
 *   2,000 statuses, newest `statusTimestamp` first; an order that rested has two, "open" at its placement and its
 *   last status later, so one still open shows only "open" (and is in no answer once its placement is older than the
 *   oldest status). A liquidation's own order is there too (`tif` "LiquidationMarket", filled, never a trigger). The
 *   orders resting at a liquidation are cancelled at its very millisecond as "liquidatedCanceled": the account's
 *   earlier liquidations left whole-position stop markets ("Price below 72", `isPositionTpsl`) and trailing stops
 *   ("Activation above 0.3, retracement 5%") cancelled that way. `triggerCondition` names the direction of a stop or
 *   take profit ("Price below …" / "Price above …") until it triggers: its "triggered" and "filled" entries read
 *   "Triggered", with `isTrigger` false and the stop's `orderType` kept. Every liquidation order of the first fills
 *   page (21) was in the history under the fill's `oid` and `coin` (HIP-3 prefix included).
 *
 * Rules (fixed, the same for every address)
 * - Round trips: flat to flat per market (`buildRoundTrips`: flips split, one order's many fills and a TWAP's slices
 *   are one trade, HIP-3 markets included, spot skipped). Trip figures count only trips opened and closed inside the
 *   window. A trip already open at the window start (`carriedIn`: its market's first fill in the window starts from a
 *   position), one still open at the end (`open`) and any other one the history breaks (`gaps`) are counted apart and
 *   left out: their opening fills or fees are not in the window. The money totals count every fill in the window,
 *   those trips' too.
 * - Win rate: wins (net after fees and funding > 0) ÷ closed trips, with the average win and average loss; null below
 *   {@link MIN_TRIPS} trips.
 * - Where the money went: lines that don't overlap and add up to the result after costs. The price result, exchange
 *   fees and builder fees of the fills that aren't the address's own liquidations; funding paid and received; and its
 *   own liquidation fills apart (their price result and their whole fees).
 * - Biggest cost: the largest of four disjoint costs, each counted only when above zero: `fees` (exchange and builder
 *   fees of the fills that aren't its own liquidations), `liquidations` (−closedPnl + fees of its own liquidation
 *   fills), `funding` (paid − received) and `price` (−closedPnl of the other fills). Ties go in that order. Null when
 *   nothing cost money.
 * - Taker share: volume of `crossed` fills ÷ all volume.
 * - Liquidations: orders, not fills (one order's fills are one liquidation). Distance to liquidation for an open
 *   position: |mark − liquidationPx| ÷ mark, the mark being positionValue ÷ |size|.
 * - Stop-loss at a liquidation ({@link stopsAtLiquidations}), per liquidated position ({@link liquidatedPositions}:
 *   own liquidation orders on one market while one position stayed open, until it went flat or turned), judged at its
 *   first liquidation's first fill: a trigger order (any of its entries says so, or its type) on the same market and
 *   the side the liquidation closed, placed before then, whose trigger is a move against the position
 *   (`triggerCondition` "Price below" for a long, "Price above" for a short, as placed; without one, a stop market or
 *   stop limit). It counts when it was still open or last changed at or after then, or when it ended earlier while
 *   this position was already held (one pass over the market's fills tells since when: {@link marketTimeline}) and it
 *   had fired (a "triggered" entry, "Triggered", or filled; then rejected too, as in a thin market) or a liquidation
 *   cancelled it ("liquidatedCanceled"). One the trader cancelled ("canceled") before it fired doesn't count, nor one
 *   rejected when placed; one that rested and was rejected without firing makes the check unclear. An unread gap in the
 *   fills (`unfilledGaps`) hides when a position opened: a stop that ended before it can't be tied. A take profit doesn't
 *   count; another trigger (a trailing stop), an order whose kind nothing tells, a stop that ended another way, or one
 *   that can't be tied to the position (it ended before the window while the position was carried in, or the fills
 *   lack a start position) makes the check unclear. It is claimed only when the orders prove it for every position:
 *   the open orders (at most {@link MAX_ORDER_DEXES} dexes; more: skipped) and the history were read, and the history
 *   holds each position's own liquidation order (same order id and market), its oldest status is before the
 *   position's first liquidation, and a full answer ({@link HL_ORDER_HISTORY}) came newest first. Any order resting
 *   then is still open or changed status at or after it, so it is in one of the two.
 * - Size after a loss: median entry notional (all opening and adding fills) of trips opened within
 *   {@link AFTER_LOSS_HOURS} h after a losing trip closed (any market), against the other trips; each group needs
 *   {@link MIN_TRIPS} trips.
 * - Hold time: median of losers against winners; each group needs {@link MIN_TRIPS} trips.
 * - Hour and weekday: trips by the UTC hour and weekday (0 = Sunday) they opened, net summed; a bucket counts with
 *   {@link MIN_BUCKET_TRIPS} trips; the worst is the lowest net below zero of at least two counted buckets.
 * - Losing days: days by realized results. A trip that closed in the window counts on the UTC day it closed, with its
 *   fees and funding; a day's net is that of the trips that closed on it. A trip a gap broke is left out (one open at
 *   the window start that a gap later cut too): its close isn't known. Opening fills or funding alone make no day.
 * - Findings, in this order: `liquidated` (any; with how many had a stop-loss set, when that is proven),
 *   `nearLiquidation` (an open position within {@link NEAR_LIQUIDATION} of its liquidation price), the habits
 *   `sizeUpAfterLoss` (ratio ≥ {@link SIZE_UP_RATIO}) and `holdLosersLonger` (ratio ≥ {@link HOLD_RATIO}),
 *   `manyLosingDays` (≥ {@link MANY_LOSING_DAYS} losing days and at least half the active days), and the fee ones
 *   last: `feesBiggestCost` (biggest cost is fees; its share of the gains is of the price result outside
 *   liquidations) and `highTakerShare` (≥ {@link HIGH_TAKER_SHARE} over ≥ {@link MIN_TAKER_FILLS} fills). Each
 *   carries the numbers its sentence needs and the app's tool it relates to; none names a market or a position.
 */
import {
  buildRoundTrips,
  inFillOrder,
  netPnl,
  type FundingPoint,
  type JournalFill,
  type RoundTrip,
} from "../journal/index.js";
import {
  AFTER_LOSS_HOURS,
  HIGH_TAKER_SHARE,
  HL_ORDER_HISTORY,
  HOLD_RATIO,
  MANY_LOSING_DAYS,
  MAX_ORDER_DEXES,
  MIN_BUCKET_TRIPS,
  MIN_TAKER_FILLS,
  MIN_TRIPS,
  NEAR_LIQUIDATION,
  SIZE_UP_RATIO,
  TIMING_LIMIT_SHARE,
  TIMING_LIMIT_USD,
  WINDOW_DAYS,
} from "./rules.js";

// ------------------------------------------------------------------------------------------------------ window

const DAY = 86_400_000;
const HOUR = 3_600_000;
export const WINDOW_MS = WINDOW_DAYS * DAY;

/** A card's window: from its start through its end (ms, both included). */
export interface ReportWindow {
  from: number;
  to: number;
}

/** The card's default window: the {@link WINDOW_DAYS} days before `now` (rolling, inclusive). */
export const lastDaysWindow = (now: number): ReportWindow => ({ from: now - WINDOW_MS, to: now });

const MONTH_KEY = /^([1-9]\d{3})-(0[1-9]|1[0-2])$/;
/** Whether `key` names a calendar month as `YYYY-MM` ("2026-11"). */
export const isMonthKey = (key: string): boolean => MONTH_KEY.test(key);
/** The calendar month (UTC) a time is in, as `YYYY-MM`. */
export function monthKey(t: number): string {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
/**
 * A calendar month in UTC (`YYYY-MM`): from its first millisecond through its last. A month still under way ends after
 * now; the card stops it at `now` ({@link reportWindow}). A RangeError for anything but `YYYY-MM`.
 */
export function monthWindow(key: string): ReportWindow {
  const m = MONTH_KEY.exec(key);
  if (!m) throw new RangeError("Not a month: YYYY-MM expected");
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  return { from: Date.UTC(year, month, 1), to: Date.UTC(year, month + 1, 1) - 1 };
}
/**
 * The window a card covers: `window` (default {@link lastDaysWindow}) with its end stopped at `now`. `live`: it holds
 * `now`, so the positions open now and Hyperliquid's 30-day graph belong to it; a window that ended earlier, or one
 * that hasn't started (empty), is not live, and the card leaves both out.
 */
export function reportWindow(now: number, window?: ReportWindow): ReportWindow & { live: boolean } {
  const w = window ?? lastDaysWindow(now);
  return { from: w.from, to: Math.min(w.to, now), live: w.from <= now && w.to >= now };
}

// ------------------------------------------------------------------------------------------------------ types

/** A fill as Hyperliquid and Kokoah's history store write it (the app's fill type, with `twapId` and `liquidation`). */
export interface ReportFill {
  tid: number | string;
  time: number;
  coin: string;
  side: "B" | "A";
  px: string;
  sz: string;
  dir?: string;
  /** The whole fee, the builder fee included. */
  fee: string;
  builderFee?: string;
  feeToken?: string;
  closedPnl: string;
  /** The signed position before this fill (round trips chain fills by it). */
  startPosition?: string;
  crossed?: boolean;
  oid: number;
  cloid?: string | null;
  hash?: string;
  twapId?: number | null;
  liquidation?: { liquidatedUser?: string; markPx: string; method: string } | null;
}
/** One market's funding for one hour: a `userFunding` entry as the app keeps it. `usdc`: received above zero. */
export interface ReportFundingRow {
  time: number;
  coin: string;
  szi: string;
  fundingRate: string;
  usdc: string;
  hash: string | null;
}
/** An open position as `clearinghouseState` writes it: the fields the card reads. */
export interface ReportPosition {
  coin: string;
  szi: string;
  positionValue: string;
  unrealizedPnl: string;
  liquidationPx: string | null;
}
/** One perp dex's `clearinghouseState`: the fields the card reads. */
export interface ReportClearinghouse {
  assetPositions: { position: ReportPosition }[];
}
/** Hyperliquid's `portfolio` answer, one entry per window: the card reads `perpMonth`'s PnL graph. */
export type ReportPortfolio = [string, { pnlHistory: [number, string][] }][];
/** A sum of money and the rows behind it (rows with a non-zero amount). `usd`: exact, as a decimal string. */
export interface Sum {
  usd: string;
  rows: number;
}
export type CostKey = "fees" | "liquidations" | "funding" | "price";
export type Tool = "limitOrders" | "guardians" | "lossLock";

export interface ReportInput {
  address: string;
  /** When the card is made (ms): the default window's end, and the latest time any window reaches. */
  now: number;
  /**
   * The window (default: the {@link WINDOW_DAYS} days before `now`), its end stopped at `now`. One that ended before
   * `now` leaves `states` and `portfolio` out: they describe now ({@link reportWindow}).
   */
  window?: ReportWindow;
  /** The address's fills (any order; spot and fills outside the window are left out here). */
  fills: readonly ReportFill[];
  /** Times in the window the fills may lack (no read covered them). */
  unfilledGaps?: readonly (readonly [number, number])[];
  /** Funding as it was read: entries whole from `from` through `through`. */
  funding: { rows: readonly ReportFundingRow[]; from: number; through: number; complete: boolean };
  /** Hyperliquid's `portfolio` answer; a live window only. */
  portfolio?: ReportPortfolio | null;
  /** `clearinghouseState` for every perp dex (an entry null or undefined: that dex wasn't read); a live window only. */
  states?: readonly (ReportClearinghouse | null | undefined)[] | null;
  /** The orders for the stop-loss check (read only after liquidations); without them it is unread. */
  orders?: ReportOrders | null;
}

/** An order as Hyperliquid's `historicalOrders` and `frontendOpenOrders` write it: the fields the card reads. */
export interface ReportOrder {
  coin: string;
  side: "B" | "A";
  oid: number;
  /** When it was placed. */
  timestamp: number;
  isTrigger?: boolean;
  orderType?: string;
  triggerPx?: string;
  /** "Price below 72", "Price above 6.83"; other words for other triggers, "N/A" for none. */
  triggerCondition?: string;
  reduceOnly?: boolean;
  tif?: string | null;
}
/** One status an order took (`historicalOrders`: one that rested has "open" at its placement, then its last one). */
export interface ReportOrderStatus {
  order: ReportOrder;
  status: string;
  statusTimestamp: number;
}
/** What the stop-loss check reads. */
export interface ReportOrders {
  /** `historicalOrders` as it answered (newest status first); null when the read failed. */
  history: readonly ReportOrderStatus[] | null;
  /** `frontendOpenOrders` per perp dex a liquidation was on ('' is the main dex), read first; null: it failed. */
  open: Readonly<Record<string, readonly ReportOrder[] | null>>;
  /** Not read on purpose: the liquidations were on more dexes than {@link MAX_ORDER_DEXES}. */
  skipped?: boolean;
}

/**
 * Since when the position open before a fill was held: opened by the fill at `at`; `carried` from before the window
 * start; `unknown` after a fill whose start position is missing, at `after` (held since then, before it can't be told);
 * `flat` when there is none.
 */
export type Opening =
  { kind: "at"; at: number } | { kind: "carried" } | { kind: "unknown"; after: number } | { kind: "flat" };

/**
 * One liquidated position: the address's own liquidation orders on one market while one position stayed open (see
 * {@link liquidatedPositions}), judged at its first.
 */
export interface LiquidatedPosition {
  coin: string;
  /** The side its liquidation fills took: "A" (sell) closed a long, "B" a short. */
  side: "B" | "A";
  /** Its first liquidation's first fill. */
  time: number;
  /** Its liquidation orders, oldest first. */
  oids: number[];
  /** Since when the position was held, at its first liquidation. */
  opened: Opening;
}

/**
 * Whether the liquidated positions had a stop-loss set. `checked`: the orders prove it for every liquidated position,
 * and `withStop` says how many had one; `unread`: a read failed; `skipped`: the liquidations were on more dexes than
 * {@link MAX_ORDER_DEXES}, so nothing was read; `incomplete`: the order history doesn't cover one of them; `unclear`:
 * an order can't be told to be a stop-loss or not (a trailing stop), or a stop that ended earlier can't be told to
 * have been this position's and set then.
 */
export interface StopCheck {
  state: "checked" | "unread" | "skipped" | "incomplete" | "unclear";
  /** Null unless `state` is `checked`. */
  withStop: number | null;
  /** Liquidated positions (fewer than liquidations when one was liquidated in steps). */
  positions: number;
  /** The perp dexes they were on. */
  dexes: number;
}

export interface Coverage {
  from: number;
  to: number;
  /** Perp fills in the window. */
  fills: number;
  /** Spot fills in the window, left out. */
  spotLeftOut: number;
  /** No unfilled gap in the window. */
  fillsComplete: boolean;
  unfilledGaps: [number, number][];
  /**
   * Funding entries read in the window, whole from `from` through `through` (the time it reaches; before `from` when
   * nothing could be read); `complete`: they cover the whole window.
   */
  funding: { rows: number; from: number; through: number; complete: boolean };
  /** Fills and funding both cover the whole window. */
  complete: boolean;
}

export interface HyperliquidPnl {
  /** The sample the change starts from (at or before the window start, else Hyperliquid's first). */
  from: number;
  to: number;
  pnl: string;
  /** Samples from `from` to `to`. */
  points: number;
  /** `from` is at or before the window start (else the account's graph starts inside the window). */
  beforeWindow: boolean;
}

export interface Result {
  /** Σ closedPnl (closing fills). */
  price: Sum;
  /** Σ fee, builder fees included. */
  fees: Sum;
  /** Σ funding: received above zero, paid below. */
  funding: Sum;
  /** price − fees + funding; rows: every fill and funding entry in the window. */
  net: Sum;
  hyperliquid: HyperliquidPnl | null;
  /** Hyperliquid's figure minus ours, and what explains it. Null without Hyperliquid's figure. */
  difference: {
    usd: string;
    /** Unrealized PnL of the positions open now (rows: positions); null when not every dex was read. */
    openNow: Sum | null;
    /** Markets already open at the window start (their unrealized PnL then is unknown). */
    carriedIn: string[];
    /** The part the positions open now explain: their unrealized PnL, when nothing was open at the start. */
    explained: string | null;
    unexplained: string | null;
    /**
     * The unexplained part is small enough to put down to the timing of Hyperliquid's graph: the history is complete
     * and it is at most the larger of {@link TIMING_LIMIT_USD} and {@link TIMING_LIMIT_SHARE} of the result. Null when
     * nothing is explained.
     */
    timing: boolean | null;
  } | null;
}

/**
 * Where the money went, in lines that don't overlap: price − exchangeFees − builderFees + fundingReceived −
 * fundingPaid − liquidations.cost = the result after costs. The price and fee lines leave the address's own
 * liquidation fills out; those are the liquidations line.
 */
export interface Costs {
  /** Σ closedPnl of the fills that aren't the address's own liquidations. */
  price: Sum;
  /** fee − builderFee outside its own liquidations: Hyperliquid's (and a HIP-3 deployer's) part. */
  exchangeFees: Sum;
  /** Front-end (builder) fees outside its own liquidations, this app's included. */
  builderFees: Sum;
  /** Paid, as a positive amount. */
  fundingPaid: Sum;
  fundingReceived: Sum;
  /** Its own liquidation fills: their price result, their whole fees, and the cost (fees − price). */
  liquidations: { price: Sum; fees: Sum; cost: string };
  /** The cost per key as the biggest-cost rule counts it (0 when it cost nothing). */
  amounts: Record<CostKey, string>;
  biggest: CostKey | null;
}

export interface Taker {
  volume: number;
  takerVolume: number;
  /** takerVolume ÷ volume; null without volume. */
  share: number | null;
  fills: number;
  takerFills: number;
  takerFees: Sum;
  makerFees: Sum;
}

export interface OpenPosition {
  coin: string;
  side: "long" | "short";
  size: number;
  value: number;
  mark: number;
  liquidationPx: number | null;
  /** |mark − liquidationPx| ÷ mark; null without a liquidation price. */
  distance: number | null;
  unrealizedPnl: string;
}

export interface Liquidations {
  /** Liquidation orders (one order's fills are one). */
  count: number;
  /** Of which backstop liquidations (the position handed to the liquidator vault). */
  backstop: number;
  fills: number;
  price: Sum;
  fees: Sum;
  /** −price + fees. */
  cost: string;
  /** Whether they had a stop-loss set; null without liquidations. */
  stops: StopCheck | null;
  /** Open positions now, nearest to liquidation first (no liquidation price last); none in a past window. */
  open: OpenPosition[];
  /** Every dex's positions were read (never in a past window: see {@link ReportCard.live}). */
  positionsRead: boolean;
  nearest: number | null;
}

export interface Trips {
  /** Trips opened and closed in the window. */
  closed: number;
  wins: number;
  losses: number;
  /** Null below {@link MIN_TRIPS} closed trips, as are the averages. */
  winRate: number | null;
  avgWin: number | null;
  /** Negative. */
  avgLoss: number | null;
  /** Σ net of the closed trips. */
  net: number;
  enough: boolean;
  leftOut: { carriedIn: number; open: number; gaps: number };
}

export interface Group {
  trips: number;
  median: number | null;
}
export interface Bucket {
  /** UTC hour (0–23) or weekday (0 = Sunday). */
  key: number;
  trips: number;
  net: number;
}
export interface Habits {
  sizeAfterLoss: { enough: boolean; hours: number; afterLoss: Group; other: Group; ratio: number | null };
  /** Medians in ms. */
  holdTime: { enough: boolean; winners: Group; losers: Group; ratio: number | null };
  timing: { hours: Bucket[]; weekdays: Bucket[]; worstHour: Bucket | null; worstWeekday: Bucket | null };
}

export interface Day {
  /** UTC midnight. */
  day: number;
  /** Σ net (after fees and funding) of the trips that closed that day. */
  net: number;
  trips: number;
}
export interface Days {
  /** Days a trip closed on (opening fills and funding alone make no day). */
  active: number;
  losing: number;
  winning: number;
  worst: Day | null;
  list: Day[];
}

export type Finding =
  | {
      key: "liquidated";
      tool: "guardians";
      /**
       * `count`: liquidation orders; `positions`: the positions they liquidated; `withStop`: how many of those had a
       * stop-loss set, only when the orders prove it for every one ({@link StopCheck}).
       */
      values: { count: number; fills: number; cost: number; positions: number; withStop: number | null };
    }
  | { key: "nearLiquidation"; tool: "guardians"; values: { positions: number; nearest: number } }
  | {
      key: "sizeUpAfterLoss";
      tool: "lossLock";
      values: {
        ratio: number;
        hours: number;
        afterLossTrips: number;
        otherTrips: number;
        afterLossMedian: number;
        otherMedian: number;
      };
    }
  | {
      key: "holdLosersLonger";
      tool: "guardians";
      values: { ratio: number; losers: number; winners: number; losersMedianMs: number; winnersMedianMs: number };
    }
  | { key: "manyLosingDays"; tool: "lossLock"; values: { losingDays: number; activeDays: number; worstDay: number } }
  | {
      key: "feesBiggestCost";
      tool: "limitOrders";
      values: { fees: number; price: number; net: number; shareOfGains: number | null };
    }
  | {
      key: "highTakerShare";
      tool: "limitOrders";
      values: { share: number; takerVolume: number; volume: number; takerFees: number };
    };
export type FindingKey = Finding["key"];
/** The findings about fees: told plainly and last, never as the card's headline. */
export const FEE_FINDINGS: ReadonlySet<FindingKey> = new Set<FindingKey>(["feesBiggestCost", "highTakerShare"]);

/**
 * The rows the figures were made of, for the page's receipts ({@link receiptsOf} for the money figures; the trip
 * lists for the trip figures, habits and days).
 */
export interface ReportRows {
  /** The address, lowercase (its own liquidations are told apart by it). */
  address: string;
  /** Perp fills in the window, once each, oldest first. */
  fills: ReportFill[];
  /** Perp funding entries in the window. */
  funding: ReportFundingRow[];
  /** Trips opened and closed in the window (the trip figures and habits), in the order they closed. */
  closed: RoundTrip[];
  /** Of `closed`: the trips opened within {@link AFTER_LOSS_HOURS} h after a losing trip closed. */
  afterLoss: RoundTrip[];
  /** Trips that count in the days: every trip a fill closed in the window (one open at the start too). */
  dayTrips: RoundTrip[];
  /** Trips the trip figures leave out (whether a gap trip's opening is known: {@link openingKnown}). */
  leftOut: { carriedIn: RoundTrip[]; open: RoundTrip[]; gaps: RoundTrip[] };
}

export interface ReportCard {
  /**
   * The window holds now (the last 30 days, or a month still under way): the positions open now and Hyperliquid's own
   * figure are part of the card. False for a window that ended earlier or hasn't started: no positions
   * (`liquidations.positionsRead` false, `open` empty) and no Hyperliquid figure (`result.hyperliquid` null).
   */
  live: boolean;
  coverage: Coverage;
  result: Result;
  costs: Costs;
  taker: Taker;
  liquidations: Liquidations;
  trips: Trips;
  habits: Habits;
  days: Days;
  findings: Finding[];
  rows: ReportRows;
}

// ------------------------------------------------------------------------------------------------------ money

const SCALE = 8;
const UNIT = 10n ** BigInt(SCALE);
const DECIMAL = /^([+-])?(\d*)(?:\.(\d*))?$/;

/** A Hyperliquid amount in units of 1e-8: exact to 8 decimals, more rounded half away from zero; 0 when unreadable. */
export function units(x: string | number | null | undefined): bigint {
  if (x === null || x === undefined) return 0n;
  let text = typeof x === "number" ? x.toFixed(SCALE) : x.trim();
  let m = DECIMAL.exec(text);
  if (!m && Number.isFinite(Number(text))) m = DECIMAL.exec((text = Number(text).toFixed(SCALE)));
  if (!m || (!m[2] && !m[3])) return 0n;
  const [, sign, whole = "", frac = ""] = m;
  let v = BigInt((whole || "0") + frac.slice(0, SCALE).padEnd(SCALE, "0"));
  if (frac.length > SCALE && frac[SCALE]! >= "5") v += 1n;
  return sign === "-" ? -v : v;
}

/** Units of 1e-8 as a decimal string ("-790.190179", "0"). */
export function usd(u: bigint): string {
  const neg = u < 0n;
  const a = neg ? -u : u;
  const frac = (a % UNIT).toString().padStart(SCALE, "0").replace(/0+$/, "");
  const text = frac ? `${a / UNIT}.${frac}` : `${a / UNIT}`;
  return neg ? `-${text}` : text;
}

class Acc {
  u = 0n;
  rows = 0;
  add(x: bigint) {
    if (x === 0n) return;
    this.u += x;
    this.rows++;
  }
  get sum(): Sum {
    return { usd: usd(this.u), rows: this.rows };
  }
}
const sumOf = (u: bigint, rows: number): Sum => ({ usd: usd(u), rows });

// ------------------------------------------------------------------------------------------------------ helpers

/** Perps on the main dex (`BTC`) and HIP-3 dexes (`xyz:TSLA`); spot coins (`@107`, `PURR/USDC`) have no positions. */
export const isPerpCoin = (coin: string) => !coin.startsWith("@") && !coin.includes("/");

/** The address's own liquidation: a fill whose `liquidation` names it (without a name: a backstop, "Liquidated …"). */
export function isOwnLiquidation(f: ReportFill, address: string) {
  const l = f.liquidation;
  if (!l) return false;
  if (l.liquidatedUser) return l.liquidatedUser.toLowerCase() === address.toLowerCase();
  return (f.dir ?? "").startsWith("Liquidated");
}

/**
 * Whether the window's history holds a trip's opening. The round-trip builder opens a trip from a position it didn't
 * see open (at the window start, or after a gap) as `<tid>r`; any other trip opened from flat or by a flip. A trip
 * opened in the window that a gap later cut (`incomplete`) keeps its opening: only its end is unknown.
 */
export const openingKnown = (trip: RoundTrip) => !trip.id.endsWith("r");

/** In the window: from its start through its end, both included. */
export const inWindow = (t: number, from: number, to: number) => t >= from && t <= to;

/** A fill once: by trade id, order and side (as the app keys fills). */
const fillKey = (f: ReportFill) => `${f.tid}:${f.oid}:${f.side}`;

/** Fills as the round-trip builder takes them, in time order (as the app's trader page converts them). */
function journalFills(fills: readonly ReportFill[]): JournalFill[] {
  return fills
    .map((f) => ({
      tid: Number(f.tid),
      time: f.time,
      coin: f.coin,
      side: f.side,
      px: Number(f.px),
      sz: Number(f.sz),
      startPosition: Number(f.startPosition ?? 0),
      closedPnl: Number(f.closedPnl),
      fee: Number(f.fee),
      builderFee: Number(f.builderFee ?? 0),
      origin: "external",
    }))
    .sort((a, b) => a.time - b.time || a.tid - b.tid);
}

function median(list: readonly number[]): number | null {
  if (list.length === 0) return null;
  const s = [...list].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Gaps clipped to [from, to], merged where they touch or overlap, oldest first. */
export function mergeGaps(gaps: readonly (readonly [number, number])[], from: number, to: number): [number, number][] {
  const clipped = gaps
    .map(([a, b]) => [Math.max(a, from), Math.min(b, to)] as [number, number])
    .filter(([a, b]) => a <= b)
    .sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const g of clipped) {
    const last = out.at(-1);
    if (last && g[0] <= last[1] + 1) last[1] = Math.max(last[1], g[1]);
    else out.push([g[0], g[1]]);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------ the card

export function buildReportCard(input: ReportInput): ReportCard {
  const { from, to, live } = reportWindow(input.now, input.window);
  const address = input.address.toLowerCase();

  // Fills in the window, once each, oldest first; spot counted and left out.
  const seen = new Set<string>();
  const perp: ReportFill[] = [];
  let spotLeftOut = 0;
  for (const f of input.fills) {
    if (!inWindow(f.time, from, to) || seen.has(fillKey(f))) continue;
    seen.add(fillKey(f));
    if (!isPerpCoin(f.coin)) spotLeftOut++;
    else if (Number(f.sz) > 0) perp.push(f);
  }
  perp.sort((a, b) => a.time - b.time || Number(a.tid) - Number(b.tid));
  const funding = input.funding.rows.filter((r) => inWindow(r.time, from, to) && isPerpCoin(r.coin));

  const coverage = coverageOf(input, from, to, perp.length, spotLeftOut, funding.length);

  // Sums over fills and funding: the totals, and the same money in lines that don't overlap (own liquidations apart).
  const price = new Acc();
  const fees = new Acc();
  const otherPrice = new Acc();
  const builder = new Acc();
  const exchange = new Acc();
  const takerFees = new Acc();
  const makerFees = new Acc();
  const liqPrice = new Acc();
  const liqFees = new Acc();
  let volume = 0;
  let takerVolume = 0;
  let takerFills = 0;
  let liqFills = 0;
  const liqOrders = new Map<string, string>();
  for (const f of perp) {
    const pnl = units(f.closedPnl);
    const fee = units(f.fee);
    const b = units(f.builderFee);
    price.add(pnl);
    fees.add(fee);
    const notional = Number(f.px) * Number(f.sz);
    volume += notional;
    if (f.crossed) {
      takerVolume += notional;
      takerFills++;
      takerFees.add(fee);
    } else makerFees.add(fee);
    if (isOwnLiquidation(f, address)) {
      liqFills++;
      liqPrice.add(pnl);
      liqFees.add(fee);
      liqOrders.set(`${f.coin}:${f.oid}`, f.liquidation?.method ?? "");
    } else {
      otherPrice.add(pnl);
      builder.add(b);
      exchange.add(fee - b);
    }
  }
  const otherFees = exchange.u + builder.u;
  const fund = new Acc();
  const paid = new Acc();
  const received = new Acc();
  for (const r of funding) {
    const u = units(r.usdc);
    fund.add(u);
    if (u < 0n) paid.add(-u);
    else received.add(u);
  }
  const netUnits = price.u - fees.u + fund.u;

  // Open positions now: only in a window that reaches now (a past one ended before them).
  const states = live ? (input.states ?? null) : null;
  const positionsRead = !!states && states.length > 0 && states.every((s) => !!s);
  const open: OpenPosition[] = [];
  let unrealized = 0n;
  for (const s of states ?? []) {
    for (const a of s?.assetPositions ?? []) {
      const p = a.position;
      const size = Number(p.szi);
      if (!size) continue;
      const value = Math.abs(Number(p.positionValue));
      const mark = value / Math.abs(size);
      const liq = p.liquidationPx === null || p.liquidationPx === undefined ? null : Number(p.liquidationPx);
      const liquidationPx = liq !== null && Number.isFinite(liq) && liq > 0 ? liq : null;
      unrealized += units(p.unrealizedPnl);
      open.push({
        coin: p.coin,
        side: size > 0 ? "long" : "short",
        size: Math.abs(size),
        value,
        mark,
        liquidationPx,
        distance: liquidationPx !== null && mark > 0 ? Math.abs(mark - liquidationPx) / mark : null,
        unrealizedPnl: usd(units(p.unrealizedPnl)),
      });
    }
  }
  open.sort((a, b) =>
    a.distance === null || b.distance === null
      ? Number(a.distance === null) - Number(b.distance === null)
      : a.distance - b.distance,
  );

  // Round trips.
  const points: FundingPoint[] = funding.map((r) => ({ time: r.time, coin: r.coin, usdc: Number(r.usdc) }));
  const journal = journalFills(perp);
  const trips = buildRoundTrips(journal, points);
  // A market was open at the window start when its first fill in the window (in fill order) starts from a position;
  // the round-trip builder opens that trip as `<tid>r`. Any other incomplete trip was broken by a gap.
  const byCoin = new Map<string, JournalFill[]>();
  for (const f of journal) {
    const list = byCoin.get(f.coin);
    if (list) list.push(f);
    else byCoin.set(f.coin, [f]);
  }
  const carriedIn = new Set<string>();
  const carriedIds = new Set<string>();
  // Carried-in trips that a fill closed (flat or flipped), not a gap.
  const carriedClean = new Set<string>();
  for (const [coin, list] of byCoin) {
    const ordered = inFillOrder(list);
    const first = ordered[0];
    if (first && first.startPosition !== 0) {
      carriedIn.add(coin);
      carriedIds.add(`${first.tid}r`);
      if (closesCleanly(ordered)) carriedClean.add(`${first.tid}r`);
    }
  }
  // A position open now that no fill in the window touched was open all along.
  for (const p of open) if (!byCoin.has(p.coin)) carriedIn.add(p.coin);
  const closed = trips.filter((t) => t.closedAt !== null && !t.incomplete).sort((a, b) => a.closedAt! - b.closedAt!);
  const stillOpenTrips = trips.filter((t) => t.closedAt === null && !t.incomplete);
  const carriedTripList = trips.filter((t) => t.incomplete && carriedIds.has(t.id));
  const gapTripList = trips.filter((t) => t.incomplete && !carriedIds.has(t.id));
  const stillOpen = stillOpenTrips.length;
  const carriedTrips = carriedTripList.length;
  const brokenByGaps = gapTripList.length;

  // Hyperliquid's own figure and the difference.
  // Hyperliquid's graph covers the last 30 days up to now: only a window that reaches now can be compared with it.
  const hyperliquid = live ? hyperliquidPnl(input.portfolio, from) : null;
  let difference: Result["difference"] = null;
  if (hyperliquid) {
    const diff = units(hyperliquid.pnl) - netUnits;
    const explained = positionsRead && carriedIn.size === 0 ? unrealized : null;
    difference = {
      usd: usd(diff),
      openNow: positionsRead ? sumOf(unrealized, open.length) : null,
      carriedIn: [...carriedIn].sort(),
      explained: explained === null ? null : usd(explained),
      unexplained: explained === null ? null : usd(diff - explained),
      // Missing fills or funding could be the cause instead: then it isn't put down to timing.
      timing:
        explained === null
          ? null
          : coverage.complete &&
            Math.abs(Number(usd(diff - explained))) <=
              Math.max(TIMING_LIMIT_USD, TIMING_LIMIT_SHARE * Math.abs(Number(usd(netUnits)))),
    };
  }

  // Where the money went: four disjoint costs.
  const liqCost = liqFees.u - liqPrice.u;
  const amounts: Record<CostKey, bigint> = {
    fees: otherFees,
    liquidations: liqCost,
    funding: paid.u - received.u,
    price: -otherPrice.u,
  };
  let biggest: CostKey | null = null;
  for (const k of ["fees", "liquidations", "funding", "price"] as const)
    if (amounts[k] > 0n && (biggest === null || amounts[k] > amounts[biggest])) biggest = k;

  const result: Result = {
    price: price.sum,
    fees: fees.sum,
    funding: fund.sum,
    net: sumOf(netUnits, perp.length + funding.length),
    hyperliquid,
    difference,
  };
  const costs: Costs = {
    price: otherPrice.sum,
    exchangeFees: exchange.sum,
    builderFees: builder.sum,
    fundingPaid: paid.sum,
    fundingReceived: received.sum,
    liquidations: { price: liqPrice.sum, fees: liqFees.sum, cost: usd(liqCost) },
    amounts: {
      fees: usd(amounts.fees > 0n ? amounts.fees : 0n),
      liquidations: usd(amounts.liquidations > 0n ? amounts.liquidations : 0n),
      funding: usd(amounts.funding > 0n ? amounts.funding : 0n),
      price: usd(amounts.price > 0n ? amounts.price : 0n),
    },
    biggest,
  };
  const taker: Taker = {
    volume,
    takerVolume,
    share: volume > 0 ? takerVolume / volume : null,
    fills: perp.length,
    takerFills,
    takerFees: takerFees.sum,
    makerFees: makerFees.sum,
  };
  const liquidations: Liquidations = {
    count: liqOrders.size,
    backstop: [...liqOrders.values()].filter((m) => m === "backstop").length,
    fills: liqFills,
    price: liqPrice.sum,
    fees: liqFees.sum,
    cost: usd(liqCost),
    stops: stopsAtLiquidations(perp, address, from, input.orders, coverage.unfilledGaps),
    open,
    positionsRead,
    nearest: open[0]?.distance ?? null,
  };
  const tripSummary = summarizeTrips(closed, {
    carriedIn: carriedTrips,
    open: stillOpen,
    gaps: brokenByGaps,
  });
  const { habits, afterLoss } = habitsOf(closed);
  // A trip broken by a gap has no reliable close: its part before the gap would land on the next fill's day. That
  // holds for a trip open at the window start that a gap later cuts too: only trips a fill closed count.
  const dayTrips = trips
    .filter((t) => t.closedAt !== null && (!t.incomplete || carriedClean.has(t.id)))
    .sort((a, b) => a.closedAt! - b.closedAt!);
  const days = daysOf(dayTrips);
  const card = { live, coverage, result, costs, taker, liquidations, trips: tripSummary, habits, days };
  const rows: ReportRows = {
    address,
    fills: perp,
    funding,
    closed,
    afterLoss,
    dayTrips,
    leftOut: { carriedIn: carriedTripList, open: stillOpenTrips, gaps: gapTripList },
  };
  return { ...card, findings: findingsOf(card), rows };
}

const EPS = 1e-9;
const near0 = (x: number, scale = 1) => Math.abs(x) <= EPS * Math.max(1, Math.abs(scale));
const signedSize = (f: JournalFill) => (f.side === "B" ? f.sz : -f.sz);

/**
 * Whether a market's trip open at the window start (its fills in fill order, the first starting from a position) was
 * closed by a fill, flat or flipped, as the round-trip builder closes it: false when a later fill's start disagrees
 * with the position first (a gap cut it) or it is still open.
 */
function closesCleanly(ordered: readonly JournalFill[]): boolean {
  const first = ordered[0];
  if (!first) return false;
  let pos = first.startPosition;
  const side = Math.sign(pos);
  for (const f of ordered) {
    if (f !== first && !near0(pos - f.startPosition, f.startPosition)) return false;
    pos += signedSize(f);
    if (near0(pos, f.sz) || Math.sign(pos) !== side) return true;
  }
  return false;
}

function coverageOf(
  input: ReportInput,
  from: number,
  to: number,
  fills: number,
  spotLeftOut: number,
  fundingRows: number,
): Coverage {
  const unfilledGaps = mergeGaps(input.unfilledGaps ?? [], from, to);
  const fundingFrom = Math.max(input.funding.from, from);
  const fundingThrough = Math.min(input.funding.through, to);
  const fundingComplete = input.funding.complete && input.funding.from <= from && input.funding.through >= to;
  return {
    from,
    to,
    fills,
    spotLeftOut,
    fillsComplete: unfilledGaps.length === 0,
    unfilledGaps,
    funding: { rows: fundingRows, from: fundingFrom, through: fundingThrough, complete: fundingComplete },
    complete: unfilledGaps.length === 0 && fundingComplete,
  };
}

/** `perpMonth`'s PnL change from the last sample at or before `from` (else its first) to its last. */
function hyperliquidPnl(portfolio: ReportPortfolio | null | undefined, from: number): HyperliquidPnl | null {
  const history = portfolio?.find(([k]) => k === "perpMonth")?.[1]?.pnlHistory;
  if (!Array.isArray(history)) return null;
  const list = history.filter((p) => Array.isArray(p) && Number.isFinite(p[0])).sort((a, b) => a[0] - b[0]);
  if (list.length < 2) return null;
  let base = 0;
  for (let i = 0; i < list.length; i++) if (list[i]![0] <= from) base = i;
  const start = list[base]!;
  const end = list.at(-1)!;
  if (end[0] <= start[0]) return null;
  return {
    from: start[0],
    to: end[0],
    pnl: usd(units(end[1]) - units(start[1])),
    points: list.length - base,
    beforeWindow: start[0] <= from,
  };
}

function summarizeTrips(closed: readonly RoundTrip[], leftOut: Trips["leftOut"]): Trips {
  const nets = closed.map(netPnl);
  const wins = nets.filter((n) => n > 0);
  const losses = nets.filter((n) => n < 0);
  const enough = closed.length >= MIN_TRIPS;
  const mean = (l: number[]) => (l.length ? l.reduce((s, x) => s + x, 0) / l.length : null);
  return {
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: enough ? wins.length / closed.length : null,
    avgWin: enough ? mean(wins) : null,
    avgLoss: enough ? mean(losses) : null,
    net: nets.reduce((s, x) => s + x, 0),
    enough,
    leftOut,
  };
}

const group = (values: number[]): Group => ({ trips: values.length, median: median(values) });
const ratio = (a: number | null, b: number | null) => (a !== null && b !== null && b > 0 ? a / b : null);

function habitsOf(closed: readonly RoundTrip[]): { habits: Habits; afterLoss: RoundTrip[] } {
  // Size after a loss: trips opened within AFTER_LOSS_HOURS after another trip closed at a loss (any market).
  const losers = closed.filter((t) => netPnl(t) < 0); // in the order they closed
  const afterLoss: number[] = [];
  const afterLossTrips: RoundTrip[] = [];
  const other: number[] = [];
  for (const t of closed) {
    // The latest losing close at or before this trip opened.
    let lo = 0;
    let hi = losers.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (losers[mid]!.closedAt! <= t.openedAt) lo = mid + 1;
      else hi = mid;
    }
    let i = lo - 1;
    if (i >= 0 && losers[i] === t) i--;
    const last = i >= 0 ? losers[i]!.closedAt! : null;
    if (last !== null && t.openedAt - last <= AFTER_LOSS_HOURS * HOUR) {
      afterLoss.push(t.entryNotional);
      afterLossTrips.push(t);
    } else other.push(t.entryNotional);
  }
  const a = group(afterLoss);
  const o = group(other);

  const winnersHeld = group(closed.filter((t) => netPnl(t) > 0).map((t) => t.closedAt! - t.openedAt));
  const losersHeld = group(losers.map((t) => t.closedAt! - t.openedAt));

  const hours = Array.from({ length: 24 }, (_, key): Bucket => ({ key, trips: 0, net: 0 }));
  const weekdays = Array.from({ length: 7 }, (_, key): Bucket => ({ key, trips: 0, net: 0 }));
  for (const t of closed) {
    const d = new Date(t.openedAt);
    for (const b of [hours[d.getUTCHours()]!, weekdays[d.getUTCDay()]!]) {
      b.trips++;
      b.net += netPnl(t);
    }
  }
  const habits: Habits = {
    sizeAfterLoss: {
      enough: a.trips >= MIN_TRIPS && o.trips >= MIN_TRIPS,
      hours: AFTER_LOSS_HOURS,
      afterLoss: a,
      other: o,
      ratio: ratio(a.median, o.median),
    },
    holdTime: {
      enough: winnersHeld.trips >= MIN_TRIPS && losersHeld.trips >= MIN_TRIPS,
      winners: winnersHeld,
      losers: losersHeld,
      ratio: ratio(losersHeld.median, winnersHeld.median),
    },
    timing: { hours, weekdays, worstHour: worstOf(hours), worstWeekday: worstOf(weekdays) },
  };
  return { habits, afterLoss: afterLossTrips };
}

/** The bucket with the lowest net below zero, of at least two buckets with enough trips. */
function worstOf(buckets: readonly Bucket[]): Bucket | null {
  const counted = buckets.filter((b) => b.trips >= MIN_BUCKET_TRIPS);
  if (counted.length < 2) return null;
  const worst = counted.reduce((w, b) => (b.net < w.net ? b : w));
  return worst.net < 0 ? { ...worst } : null;
}

/**
 * Days by realized results: each trip that closed in the window counts on the UTC day it closed, with its fees and
 * funding (trips open at the window start too, when a fill closed them: what they realized in it; the caller leaves
 * out every trip a gap broke). A day with only opening fills or only funding is no day.
 */
function daysOf(trips: readonly RoundTrip[]): Days {
  const by = new Map<number, Day>();
  for (const t of trips) {
    if (t.closedAt === null) continue;
    const day = Math.floor(t.closedAt / DAY) * DAY;
    const d = by.get(day) ?? { day, net: 0, trips: 0 };
    d.net += netPnl(t);
    d.trips++;
    by.set(day, d);
  }
  const list = [...by.values()].sort((a, b) => a.day - b.day);
  const worst = list.reduce<Day | null>((w, d) => (d.net < 0 && (!w || d.net < w.net) ? d : w), null);
  return {
    active: list.length,
    losing: list.filter((d) => d.net < 0).length,
    winning: list.filter((d) => d.net > 0).length,
    worst: worst ? { ...worst } : null,
    list,
  };
}

function findingsOf(card: Omit<ReportCard, "findings" | "rows">): Finding[] {
  const out: Finding[] = [];
  const { costs, taker, liquidations, habits, days, result } = card;
  // Liquidations first, then the habits and days, and the fee findings last.
  if (liquidations.count > 0)
    out.push({
      key: "liquidated",
      tool: "guardians",
      values: {
        count: liquidations.count,
        fills: liquidations.fills,
        cost: Number(liquidations.cost),
        positions: liquidations.stops?.positions ?? liquidations.count,
        withStop: liquidations.stops?.state === "checked" ? liquidations.stops.withStop : null,
      },
    });
  const near = liquidations.open.filter((p) => p.distance !== null && p.distance < NEAR_LIQUIDATION);
  if (near.length > 0)
    out.push({
      key: "nearLiquidation",
      tool: "guardians",
      values: { positions: near.length, nearest: near[0]!.distance! },
    });
  const s = habits.sizeAfterLoss;
  if (s.enough && s.ratio !== null && s.ratio >= SIZE_UP_RATIO)
    out.push({
      key: "sizeUpAfterLoss",
      tool: "lossLock",
      values: {
        ratio: s.ratio,
        hours: s.hours,
        afterLossTrips: s.afterLoss.trips,
        otherTrips: s.other.trips,
        afterLossMedian: s.afterLoss.median!,
        otherMedian: s.other.median!,
      },
    });
  const h = habits.holdTime;
  if (h.enough && h.ratio !== null && h.ratio >= HOLD_RATIO)
    out.push({
      key: "holdLosersLonger",
      tool: "guardians",
      values: {
        ratio: h.ratio,
        losers: h.losers.trips,
        winners: h.winners.trips,
        losersMedianMs: h.losers.median!,
        winnersMedianMs: h.winners.median!,
      },
    });
  if (days.losing >= MANY_LOSING_DAYS && days.losing * 2 >= days.active)
    out.push({
      key: "manyLosingDays",
      tool: "lossLock",
      values: { losingDays: days.losing, activeDays: days.active, worstDay: days.worst!.net },
    });
  if (costs.biggest === "fees") {
    // Both outside the address's own liquidations: the share of the gains the other trading made.
    const price = Number(costs.price.usd);
    const fees = Number(costs.amounts.fees);
    out.push({
      key: "feesBiggestCost",
      tool: "limitOrders",
      values: { fees, price, net: Number(result.net.usd), shareOfGains: price > 0 ? fees / price : null },
    });
  }
  if (taker.share !== null && taker.fills >= MIN_TAKER_FILLS && taker.share >= HIGH_TAKER_SHARE)
    out.push({
      key: "highTakerShare",
      tool: "limitOrders",
      values: {
        share: taker.share,
        takerVolume: taker.takerVolume,
        volume: taker.volume,
        takerFees: Number(taker.takerFees.usd),
      },
    });
  return out;
}

// ------------------------------------------------------------------------------------------------------ stop-losses

/** The perp dex a market is on: "xyz" for `xyz:TSLA`, "" for the main dex. */
export const dexOf = (coin: string) => (coin.includes(":") ? coin.slice(0, coin.indexOf(":")) : "");

/** A fill's signed size: a buy adds, a sell takes away. */
const signedSz = (f: ReportFill) => (f.side === "B" ? 1 : -1) * Number(f.sz);
/** The position before a fill, when Hyperliquid wrote it. */
const startOf = (f: ReportFill) => {
  const x = f.startPosition === undefined || f.startPosition === null ? NaN : Number(f.startPosition);
  return Number.isFinite(x) ? x : null;
};

type Gaps = readonly (readonly [number, number])[];
/** The latest time in `gaps` strictly between `a` and `b` (a gap's end, or just before `b`); null without one. */
function gapBetween(gaps: Gaps, a: number, b: number): number | null {
  let end: number | null = null;
  for (const [g0, g1] of gaps) if (g0 < b && g1 > a) end = Math.max(end ?? -Infinity, Math.min(g1, b - 1));
  return end;
}

interface TimelineEntry {
  fill: ReportFill;
  /** The opening of the position held just before the fill. */
  before: Opening;
  /** The position it leaves; null when its start position is missing. */
  after: number | null;
  /** History the window couldn't read lies between the previous fill on the market (or the window start) and it. */
  gapBefore: boolean;
}

/**
 * One market's fills in fill order, each with the opening of the position held just before it (see {@link Opening}),
 * in one pass: a position opens at the fill that takes it from flat or turns it, ends at the fill that leaves it
 * flat. A fill without its start position, one whose start isn't where the previous fill left it, or an unread gap
 * in the fills before it (`gaps`: the position may have closed and opened again there) leaves the times before it
 * unknown.
 */
function marketTimeline(list: readonly ReportFill[], gaps: Gaps, from: number): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let pos: number | null = null;
  let opening: Opening | null = null;
  let prev = from - 1;
  for (const f of list) {
    const start = startOf(f);
    const gap = gapBetween(gaps, prev, f.time);
    if (opening === null)
      // The first fill in the window: what was open before it was carried in, unless a gap hides when it opened.
      opening =
        start === null
          ? { kind: "unknown", after: f.time }
          : near0(start, Number(f.sz))
            ? { kind: "flat" }
            : gap !== null
              ? { kind: "unknown", after: gap }
              : { kind: "carried" };
    else if (start === null || (pos !== null && !near0(pos - start, start)))
      opening = { kind: "unknown", after: f.time };
    else if (near0(start, Number(f.sz))) opening = { kind: "flat" };
    else if (gap !== null) opening = { kind: "unknown", after: gap };
    out.push({ fill: f, before: opening, after: start === null ? null : start + signedSz(f), gapBefore: gap !== null });
    prev = f.time;
    if (start === null) {
      pos = null;
      continue;
    }
    const after = start + signedSz(f);
    if (near0(after, Number(f.sz))) opening = { kind: "flat" };
    else if (near0(start, Number(f.sz)) || Math.sign(after) !== Math.sign(start)) opening = { kind: "at", at: f.time };
    pos = after;
  }
  return out;
}

/** Perp fills by market, each market's in fill order. */
function byMarket(fills: readonly ReportFill[]) {
  const byCoin = new Map<string, ReportFill[]>();
  for (const f of [...fills].sort((x, y) => x.time - y.time || Number(x.tid) - Number(y.tid))) {
    if (!isPerpCoin(f.coin)) continue;
    const list = byCoin.get(f.coin);
    if (list) list.push(f);
    else byCoin.set(f.coin, [f]);
  }
  return byCoin;
}

/**
 * The address's liquidated positions among `fills` (perps), oldest first: its own liquidation orders on one market
 * while one position stayed open (Hyperliquid liquidates a large position in steps, or by a market order and then the
 * backstop; a fill in between that adds or trims keeps it the same position) are one. A position ends when it goes
 * flat or turns, at a fill whose start position is missing, or at an unread gap in the fills (`gaps`).
 */
export function liquidatedPositions(
  fills: readonly ReportFill[],
  address: string,
  gaps: Gaps = [],
  from = -Infinity,
): LiquidatedPosition[] {
  const out: LiquidatedPosition[] = [];
  for (const [coin, list] of byMarket(fills)) {
    let current: LiquidatedPosition | null = null;
    for (const { fill: f, before, after, gapBefore } of marketTimeline(list, gaps, from)) {
      if (gapBefore) current = null;
      if (isOwnLiquidation(f, address)) {
        if (!current) {
          current = { coin, side: f.side, time: f.time, oids: [f.oid], opened: before };
          out.push(current);
        } else if (!current.oids.includes(f.oid)) current.oids.push(f.oid);
      }
      // Flat, turned, or not known: the position ends here.
      if (
        current &&
        (after === null || near0(after, Number(f.sz)) || Math.sign(after) !== (current.side === "A" ? 1 : -1))
      )
        current = null;
    }
  }
  return out.sort((x, y) => x.time - y.time);
}

/**
 * Whether a trigger order on the side that closes a position would fire on a move against it: "stop" (a stop-loss),
 * "profit" (a take profit, on a move its way) or null (another trigger, such as a trailing stop: it can't be told).
 * Hyperliquid names the direction in `triggerCondition` until the order triggers ("Triggered" after); without it,
 * its stop and take-profit types decide.
 */
export function triggerKind(o: ReportOrder): "stop" | "profit" | null {
  const condition = (o.triggerCondition ?? "").trim().toLowerCase();
  const below = condition.startsWith("price below");
  const above = condition.startsWith("price above");
  // A sell closes a long, which a fall hurts; a buy closes a short, which a rise hurts.
  if (below || above) return (o.side === "A") === below ? "stop" : "profit";
  const type = o.orderType ?? "";
  if (type === "Stop Market" || type === "Stop Limit") return "stop";
  if (type === "Take Profit Market" || type === "Take Profit Limit") return "profit";
  return null;
}

/** Order types of trigger orders, whatever an entry's `isTrigger` says (it reads false once one has triggered). */
const TRIGGER_TYPE = /^(Stop|Take Profit|Trailing Stop) /;
/** Order types that are never triggers. */
const PLAIN_TYPE = /^(Limit|Market)$/;

/** One order as the history and the open orders show it. */
interface OrderSeen {
  /** As placed (its "open" entry), else its newest entry. */
  order: ReportOrder;
  entries: ReportOrder[];
  /** Every status the history shows for it. */
  statuses: string[];
  /** Its newest status other than "open", and when; null while it rests (or rested until the open orders' read). */
  last: { status: string; at: number } | null;
}

/** A trigger order: any of its entries says so, or its type does; null when nothing tells (no flag, no known type). */
function isTriggerOrder(o: OrderSeen): boolean | null {
  if (o.entries.some((e) => e.isTrigger === true || TRIGGER_TYPE.test(e.orderType ?? ""))) return true;
  if (o.entries.some((e) => e.isTrigger === false && PLAIN_TYPE.test(e.orderType ?? ""))) return false;
  return null;
}

/**
 * Whether the position judged was already held at `t`: true when it was, false when it opened after (or nothing was
 * open), null when the window's fills can't tell (carried in from before the window, or a fill without its start).
 */
function heldAt(opened: Opening, t: number, from: number): boolean | null {
  switch (opened.kind) {
    case "at":
      // At the very millisecond it opened, the order may have closed the one before.
      return t > opened.at ? true : t === opened.at ? null : false;
    case "carried":
      return t >= from ? true : null;
    case "unknown":
      return t > opened.after ? true : null;
    case "flat":
      return false;
  }
}

/** A trigger order that fired: an entry says it triggered, or a trigger type filled. */
const fired = (o: OrderSeen) =>
  o.entries.some((e) => (e.triggerCondition ?? "").trim().toLowerCase() === "triggered") ||
  o.statuses.includes("triggered") ||
  o.last?.status === "filled";

/**
 * Whether the address's liquidated positions had a stop-loss set, each judged at its first liquidation: a trigger
 * order on its market and its closing side, placed before then, that {@link triggerKind} calls a stop, and that either
 * rested then (still open, or last changed at or after it), or ended earlier while this position was already held
 * and had fired (it triggered: set, and it went off, though it didn't close everything) or was cancelled by a
 * liquidation ("liquidatedCanceled"). One the trader cancelled before it fired doesn't count; one that ended any other
 * way, or that can't be tied to this position, makes the check unclear. Proven only when the open orders of every dex
 * a liquidation was on were read, and the history reaches back past each position: it holds the position's own
 * liquidation order (same order and market), its oldest status is from before it, and a full answer came newest
 * first (see the module's rules). One pass over the fills, then a lookup per order. Null without liquidations.
 */
export function stopsAtLiquidations(
  fills: readonly ReportFill[],
  address: string,
  from: number,
  orders: ReportOrders | null | undefined,
  gaps: Gaps = [],
): StopCheck | null {
  const positions = liquidatedPositions(fills, address, gaps, from);
  if (positions.length === 0) return null;
  const dexes = [...new Set(positions.map((p) => dexOf(p.coin)))];
  const none = (state: StopCheck["state"]): StopCheck => ({
    state,
    withStop: null,
    positions: positions.length,
    dexes: dexes.length,
  });
  if (orders?.skipped) return none("skipped");
  const history = orders?.history;
  const openLists = dexes.map((dex) => orders?.open[dex]);
  if (!Array.isArray(history) || openLists.some((list) => !Array.isArray(list))) return none("unread");
  // Newest status first, as Hyperliquid answers: a full answer holds every status after its oldest one.
  let oldest = Infinity;
  let newestFirst = true;
  const own = new Set<string>();
  history.forEach((h, i) => {
    oldest = Math.min(oldest, h.statusTimestamp);
    if (i > 0 && h.statusTimestamp > history[i - 1]!.statusTimestamp) newestFirst = false;
    own.add(`${h.order.coin}:${h.order.oid}`);
  });
  const full = history.length >= HL_ORDER_HISTORY;
  const anchored = (p: LiquidatedPosition) => own.has(`${p.coin}:${p.oids[0]}`);
  if (!positions.every((p) => oldest < p.time && (!full || newestFirst) && anchored(p))) return none("incomplete");

  // Each order once, by market.
  const seen = new Map<number, OrderSeen>();
  for (const h of history) {
    const o: OrderSeen = seen.get(h.order.oid) ?? { order: h.order, entries: [], statuses: [], last: null };
    o.entries.push(h.order);
    o.statuses.push(h.status);
    if (h.status === "open") o.order = h.order;
    else if (!o.last || h.statusTimestamp > o.last.at) o.last = { status: h.status, at: h.statusTimestamp };
    seen.set(h.order.oid, o);
  }
  for (const list of openLists)
    for (const order of list!) {
      const o = seen.get(order.oid);
      // Open at the read, after every liquidation: whatever the history says, it rested through them.
      if (o) {
        o.entries.push(order);
        o.last = null;
      } else seen.set(order.oid, { order, entries: [order], statuses: ["open"], last: null });
    }
  const byCoin = new Map<string, OrderSeen[]>();
  for (const o of seen.values()) {
    const list = byCoin.get(o.order.coin);
    if (list) list.push(o);
    else byCoin.set(o.order.coin, [o]);
  }

  let withStop = 0;
  for (const p of positions) {
    let stop = false;
    let unclear = false;
    for (const o of byCoin.get(p.coin) ?? []) {
      const order = o.order;
      if (order.side !== p.side || order.timestamp >= p.time || p.oids.includes(order.oid)) continue;
      const trigger = isTriggerOrder(o);
      if (trigger === false) continue;
      const kind = trigger === null ? null : triggerKind(order);
      if (kind === "profit") continue;
      let counts: boolean | null;
      if (!o.last || o.last.at >= p.time) counts = true;
      else if (/rejected$/i.test(o.last.status)) {
        // Rejected when placed: it never rested.
        const rested = o.statuses.includes("open") || o.statuses.includes("triggered");
        if (!rested && o.last.at <= order.timestamp) continue;
        const held = heldAt(p.opened, o.last.at, from);
        if (held === false) continue;
        // Fired and then rejected (a thin market, margin): set, and it went off. Rested and rejected: can't tell.
        counts = fired(o) ? held : null;
      } else {
        const held = heldAt(p.opened, o.last.at, from);
        if (held === false) continue;
        if (fired(o)) counts = held;
        // The trader took it away before it fired.
        else if (o.last.status === "canceled") continue;
        else if (o.last.status === "liquidatedCanceled") counts = held;
        // Cancelled by the exchange for another reason: it can't be told what this position had.
        else counts = null;
      }
      if (kind === "stop" && counts === true) stop = true;
      // Another trigger, one whose kind nothing tells, or a stop that can't be tied to this position.
      else unclear = true;
    }
    if (stop) withStop++;
    else if (unclear) return none("unclear");
  }
  return { state: "checked", withStop, positions: positions.length, dexes: dexes.length };
}

// ------------------------------------------------------------------------------------------------------ receipts

/** The money figures whose rows {@link receiptsOf} lists. */
export type FigureKey =
  /** `result.net`: every fill (closedPnl − fee) and funding entry. */
  | "net"
  /** `result.price`, `result.fees`, `result.funding`. */
  | "price"
  | "fees"
  | "funding"
  /** `costs.price`, `costs.exchangeFees`, `costs.builderFees`, `costs.fundingPaid`, `costs.fundingReceived`. */
  | "costPrice"
  | "exchangeFees"
  | "builderFees"
  | "fundingPaid"
  | "fundingReceived"
  /** The address's own liquidation fills (`liquidations.fills`), each with its cost (fee − closedPnl). */
  | "liquidations"
  /** Fills that crossed the book (`taker.takerFills`), each with its fee. */
  | "taker";

/** One row behind a figure and its part of it (`usd`, exact; the parts add up to the figure). */
export type Receipt =
  { kind: "fill"; fill: ReportFill; usd: string } | { kind: "funding"; funding: ReportFundingRow; usd: string };

/**
 * The rows behind a money figure, as the card counted them: the same rows (a figure's `rows`; zero amounts are no
 * row, except in `net`, which counts every fill and funding entry, and `liquidations` and `taker`, which count their
 * fills), each with its part, oldest first.
 */
export function receiptsOf(card: Pick<ReportCard, "rows">, key: FigureKey): Receipt[] {
  const { address, fills, funding } = card.rows;
  const own = (f: ReportFill) => isOwnLiquidation(f, address);
  const fill = (f: ReportFill, u: bigint): Receipt => ({ kind: "fill", fill: f, usd: usd(u) });
  const pay = (r: ReportFundingRow, u: bigint): Receipt => ({ kind: "funding", funding: r, usd: usd(u) });
  const fillRows = (part: (f: ReportFill) => bigint | null, keepZero = false) =>
    fills.flatMap((f) => {
      const u = part(f);
      return u === null || (u === 0n && !keepZero) ? [] : [fill(f, u)];
    });
  const fundingRows = (part: (u: bigint) => bigint | null) =>
    funding.flatMap((r) => {
      const u = part(units(r.usdc));
      return u === null || u === 0n ? [] : [pay(r, u)];
    });
  const byTime = (list: Receipt[]) =>
    list.sort(
      (a, b) => (a.kind === "fill" ? a.fill.time : a.funding.time) - (b.kind === "fill" ? b.fill.time : b.funding.time),
    );
  switch (key) {
    case "net":
      return byTime([
        ...fillRows((f) => units(f.closedPnl) - units(f.fee), true),
        ...funding.map((r) => pay(r, units(r.usdc))),
      ]);
    case "price":
      return fillRows((f) => units(f.closedPnl));
    case "fees":
      return fillRows((f) => units(f.fee));
    case "funding":
      return fundingRows((u) => u);
    case "costPrice":
      return fillRows((f) => (own(f) ? null : units(f.closedPnl)));
    case "exchangeFees":
      return fillRows((f) => (own(f) ? null : units(f.fee) - units(f.builderFee)));
    case "builderFees":
      return fillRows((f) => (own(f) ? null : units(f.builderFee)));
    case "fundingPaid":
      return fundingRows((u) => (u < 0n ? -u : null));
    case "fundingReceived":
      return fundingRows((u) => (u > 0n ? u : null));
    case "liquidations":
      return fillRows((f) => (own(f) ? units(f.fee) - units(f.closedPnl) : null), true);
    case "taker":
      return fillRows((f) => (f.crossed ? units(f.fee) : null), true);
  }
}
