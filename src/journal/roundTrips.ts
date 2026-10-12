/**
 * (Moved from kokoah-backend so the app can build round trips for any address in the browser.)
 *
 * Groups fills into round trips (open → flat) per coin (FRONTEND_SPEC §16.1).
 *
 * - Fills are processed per coin in time order with the signed position they start from (HL `startPosition`); fills
 *   with the same time (one order's fills, which share it) are chained by that position ({@link inFillOrder}).
 * - Adds increase the trip; reductions record exits; a fill that crosses zero (a flip) is split: the closing part ends
 *   the trip and the remainder opens a new one. Fees are pro-rated by size across the split; HL's `closedPnl` belongs
 *   to the closing part.
 * - Realized PnL is HL's `closedPnl` (gross of fees). Net PnL = realized − HL fees − builder fees + funding received
 *   (funding is signed: negative when paid).
 * - If the tracked position disagrees with a fill's `startPosition` (missing history, e.g. beyond HL's 10,000-fill
 *   window), the open trip is closed as `incomplete` and tracking resynchronizes. A trip whose opening fills are
 *   missing derives its entry price from HL's closedPnl (entry = px − closedPnl / (sign × size)).
 * - Spot fills (`@107`, `PURR/USDC`) are ignored.
 */
/** Spot coins (`@107`, `PURR/USDC`): no positions, so no round trips. */
const isSpotCoin = (coin: string) => coin.startsWith("@") || coin.includes("/");

export interface JournalFill {
  tid: number;
  time: number;
  coin: string;
  side: "B" | "A";
  px: number;
  sz: number;
  startPosition: number;
  closedPnl: number;
  fee: number;
  builderFee: number;
  origin: string;
}

export interface FundingPoint {
  time: number;
  coin: string;
  usdc: number;
}

export interface RoundTrip {
  id: string;
  coin: string;
  side: "long" | "short";
  openedAt: number;
  closedAt: number | null;
  entryQty: number;
  entryNotional: number;
  exitQty: number;
  exitNotional: number;
  maxSize: number;
  realizedPnl: number;
  feesHl: number;
  feesBuilder: number;
  funding: number;
  fillCount: number;
  origin: string;
  incomplete: boolean;
  /** Time of the first reducing fill (for stop-order lookup). */
  firstExitAt: number | null;
  /** Entry price implied by HL closedPnl on exits (used when opening fills are missing). */
  impliedEntryNotional: number;
  impliedEntryQty: number;
}

const EPS = 1e-9;
const near0 = (x: number, scale = 1) => Math.abs(x) <= EPS * Math.max(1, Math.abs(scale));

export function entryAvg(t: RoundTrip): number | null {
  if (t.entryQty > 0) return t.entryNotional / t.entryQty;
  if (t.impliedEntryQty > 0) return t.impliedEntryNotional / t.impliedEntryQty;
  return null;
}

export function exitAvg(t: RoundTrip): number | null {
  return t.exitQty > 0 ? t.exitNotional / t.exitQty : null;
}

export function netPnl(t: RoundTrip): number {
  return t.realizedPnl - t.feesHl - t.feesBuilder + t.funding;
}

function newTrip(id: string, coin: string, side: "long" | "short", time: number, origin: string, incomplete: boolean): RoundTrip {
  return {
    id,
    coin,
    side,
    openedAt: time,
    closedAt: null,
    entryQty: 0,
    entryNotional: 0,
    exitQty: 0,
    exitNotional: 0,
    maxSize: 0,
    realizedPnl: 0,
    feesHl: 0,
    feesBuilder: 0,
    funding: 0,
    fillCount: 0,
    origin,
    incomplete,
    firstExitAt: null,
    impliedEntryNotional: 0,
    impliedEntryQty: 0,
  };
}

const signed = (f: JournalFill) => (f.side === "B" ? f.sz : -f.sz);

/**
 * Fills in the order they happened. Hyperliquid gives the fills of one order (and of orders matched in the same
 * block) the same time, and trade ids are not in fill order, so fills with the same time are chained: each one starts
 * from the position the previous one ended at (`startPosition`). The first of a coin's history starts where no other
 * fill of its time ends.
 */
export function inFillOrder(list: readonly JournalFill[]): JournalFill[] {
  const sorted = [...list].sort((a, b) => a.time - b.time || a.tid - b.tid);
  const out: JournalFill[] = [];
  let running: number | null = null;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && sorted[j]!.time === sorted[i]!.time) j++;
    const group = sorted.slice(i, j);
    while (group.length > 0) {
      let k = 0;
      if (running !== null) {
        let best = Infinity;
        group.forEach((f, idx) => {
          const d = Math.abs(f.startPosition - running!);
          if (d < best - EPS) [best, k] = [d, idx];
        });
      } else {
        const first = group.findIndex((f) => !group.some((g) => g !== f && near0(g.startPosition + signed(g) - f.startPosition, f.startPosition)));
        k = first < 0 ? 0 : first;
      }
      const f = group.splice(k, 1)[0]!;
      out.push(f);
      running = f.startPosition + signed(f);
    }
    i = j;
  }
  return out;
}

/** Builds round trips from fills (any order) and attributes funding payments to the trip open at that time. */
export function buildRoundTrips(fills: readonly JournalFill[], funding: readonly FundingPoint[] = []): RoundTrip[] {
  const byCoin = new Map<string, JournalFill[]>();
  for (const f of fills) {
    if (isSpotCoin(f.coin) || !(f.sz > 0)) continue;
    const list = byCoin.get(f.coin) ?? [];
    list.push(f);
    byCoin.set(f.coin, list);
  }
  const trips: RoundTrip[] = [];
  for (const [coin, unordered] of byCoin) {
    const list = inFillOrder(unordered);
    let pos = 0;
    let trip: RoundTrip | null = null;
    const close = (time: number, incomplete = false) => {
      if (!trip) return;
      trip.closedAt = time;
      if (incomplete) trip.incomplete = true;
      trips.push(trip);
      trip = null;
    };
    for (const f of list) {
      // Resynchronize when history has a gap.
      if (!near0(pos - f.startPosition, f.startPosition)) {
        if (trip) close(f.time, true);
        pos = f.startPosition;
        if (!near0(pos)) {
          trip = newTrip(`${f.tid}r`, coin, pos > 0 ? "long" : "short", f.time, f.origin, true);
          trip.maxSize = Math.abs(pos);
        }
      }
      const delta = f.side === "B" ? f.sz : -f.sz;
      const hlFee = f.fee - f.builderFee;
      if (near0(pos)) {
        pos = 0;
        trip = newTrip(String(f.tid), coin, delta > 0 ? "long" : "short", f.time, f.origin, false);
      }
      const t = trip!;
      if (Math.sign(delta) === Math.sign(pos) || pos === 0) {
        // Open or add.
        t.entryQty += f.sz;
        t.entryNotional += f.sz * f.px;
        t.feesHl += hlFee;
        t.feesBuilder += f.builderFee;
        t.realizedPnl += f.closedPnl;
        t.fillCount += 1;
        pos += delta;
        t.maxSize = Math.max(t.maxSize, Math.abs(pos));
        continue;
      }
      // Reduce, close or flip.
      const closeQty = Math.min(f.sz, Math.abs(pos));
      const share = closeQty / f.sz;
      t.exitQty += closeQty;
      t.exitNotional += closeQty * f.px;
      t.feesHl += hlFee * share;
      t.feesBuilder += f.builderFee * share;
      t.realizedPnl += f.closedPnl;
      t.fillCount += 1;
      t.firstExitAt ??= f.time;
      if (closeQty > 0) {
        const sign = t.side === "long" ? 1 : -1;
        t.impliedEntryNotional += closeQty * (f.px - f.closedPnl / (sign * closeQty));
        t.impliedEntryQty += closeQty;
      }
      pos += delta;
      if (near0(pos, f.sz) || Math.sign(pos) !== (t.side === "long" ? 1 : -1)) {
        const remainder = f.sz - closeQty;
        close(f.time);
        if (remainder > EPS * Math.max(1, f.sz)) {
          const nt = newTrip(`${f.tid}f`, coin, delta > 0 ? "long" : "short", f.time, f.origin, false);
          nt.entryQty = remainder;
          nt.entryNotional = remainder * f.px;
          nt.feesHl = hlFee * (1 - share);
          nt.feesBuilder = f.builderFee * (1 - share);
          nt.fillCount = 1;
          nt.maxSize = remainder;
          trip = nt;
          pos = delta > 0 ? remainder : -remainder;
        } else {
          pos = 0;
        }
      }
    }
    if (trip) trips.push(trip);
  }
  attributeFunding(trips, funding);
  return trips;
}

function attributeFunding(trips: RoundTrip[], funding: readonly FundingPoint[]): void {
  if (funding.length === 0) return;
  const byCoin = new Map<string, RoundTrip[]>();
  for (const t of trips) {
    const list = byCoin.get(t.coin) ?? [];
    list.push(t);
    byCoin.set(t.coin, list);
  }
  for (const list of byCoin.values()) list.sort((a, b) => a.openedAt - b.openedAt);
  for (const p of funding) {
    const list = byCoin.get(p.coin);
    if (!list) continue;
    // Funding at time T belongs to the trip open at T (opened before, closed at/after).
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i]!;
      if (t.openedAt < p.time && (t.closedAt === null || t.closedAt >= p.time)) {
        t.funding += p.usdc;
        break;
      }
    }
  }
}
