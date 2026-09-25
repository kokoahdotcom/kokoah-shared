/**
 * A bot's own book: its position per coin and its PnL, from its own fills only (average-cost), so a bot's numbers
 * stay its own even when the account trades the same market otherwise. Fees include Hyperliquid's and Kokoah's.
 *
 * @module
 */

export interface BotCoinBook {
  /** Signed size in coins. */
  size: number;
  /** Average entry of the open size (0 when flat). */
  entryPrice: number;
  /** Realized PnL before fees (USD). */
  realizedUsd: number;
  feesUsd: number;
  volumeUsd: number;
  fills: number;
}

export type BotLedger = Record<string, BotCoinBook>;

export interface BotFill {
  coin: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  /** Total fee of the fill (Hyperliquid's, including the builder fee), USD. */
  feeUsd: number;
}

const EPS = 1e-12;

export function emptyBook(): BotCoinBook {
  return { size: 0, entryPrice: 0, realizedUsd: 0, feesUsd: 0, volumeUsd: 0, fills: 0 };
}

/** Applies one fill (average-cost: adds move the entry, reductions realize PnL, a flip opens the rest at the fill price). */
export function applyFill(book: BotCoinBook, fill: Omit<BotFill, "coin">): BotCoinBook {
  const signed = fill.side === "buy" ? fill.size : -fill.size;
  const next: BotCoinBook = {
    ...book,
    feesUsd: book.feesUsd + fill.feeUsd,
    volumeUsd: book.volumeUsd + fill.size * fill.price,
    fills: book.fills + 1,
  };
  if (book.size === 0 || Math.sign(book.size) === Math.sign(signed)) {
    const size = book.size + signed;
    next.entryPrice = Math.abs(size) > EPS ? (Math.abs(book.size) * book.entryPrice + fill.size * fill.price) / Math.abs(size) : 0;
    next.size = clean(size);
    return next;
  }
  const closed = Math.min(Math.abs(book.size), fill.size);
  next.realizedUsd = book.realizedUsd + closed * (fill.price - book.entryPrice) * Math.sign(book.size);
  const size = clean(book.size + signed);
  next.size = size;
  next.entryPrice = size === 0 ? 0 : Math.sign(size) === Math.sign(book.size) ? book.entryPrice : fill.price;
  return next;
}

/** Applies fills to a ledger (returns a new ledger). */
export function applyFills(ledger: BotLedger, fills: readonly BotFill[]): BotLedger {
  const out: BotLedger = { ...ledger };
  for (const f of fills) out[f.coin] = applyFill(out[f.coin] ?? emptyBook(), f);
  return out;
}

export interface BotPnl {
  realizedUsd: number;
  unrealizedUsd: number;
  feesUsd: number;
  /** realized − fees + unrealized. */
  totalUsd: number;
  volumeUsd: number;
  fills: number;
  /** Value of the open positions at the mark. */
  openValueUsd: number;
}

/** The ledger's PnL at the given marks (coins without a mark count no unrealized PnL). */
export function ledgerPnl(ledger: BotLedger, marks: Readonly<Record<string, number>>): BotPnl {
  const out: BotPnl = { realizedUsd: 0, unrealizedUsd: 0, feesUsd: 0, totalUsd: 0, volumeUsd: 0, fills: 0, openValueUsd: 0 };
  for (const [coin, b] of Object.entries(ledger)) {
    out.realizedUsd += b.realizedUsd;
    out.feesUsd += b.feesUsd;
    out.volumeUsd += b.volumeUsd;
    out.fills += b.fills;
    const mark = marks[coin];
    if (b.size !== 0 && mark !== undefined && mark > 0) {
      out.unrealizedUsd += b.size * (mark - b.entryPrice);
      out.openValueUsd += Math.abs(b.size) * mark;
    }
  }
  out.totalUsd = out.realizedUsd - out.feesUsd + out.unrealizedUsd;
  return out;
}

/** Signed sizes by coin (non-zero only). */
export function ledgerPositions(ledger: BotLedger): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [coin, b] of Object.entries(ledger)) if (b.size !== 0) out[coin] = b.size;
  return out;
}

/** Rounds away float noise (sizes have at most 8 decimals on Hyperliquid). */
function clean(x: number): number {
  const r = Math.round(x * 1e8) / 1e8;
  return Math.abs(r) < EPS ? 0 : r;
}
