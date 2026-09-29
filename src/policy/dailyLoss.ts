/**
 * The realized loss that `Policy.maxDailyLossUsd` limits: closed trades minus fees since 00:00 UTC, from Hyperliquid
 * fills (`userFillsByTime`). One definition for everyone who measures it.
 *
 * @module
 */

/** The fields of a Hyperliquid fill this needs (HL sends them as decimal strings). */
export interface DailyLossFill {
  coin: string;
  closedPnl: string;
  fee: string;
  time: number;
}

/** 00:00 UTC of the day `now` falls in (unix ms): when the daily loss limit resets. */
export function utcDayStart(now: number): number {
  return Math.floor(now / 86_400_000) * 86_400_000;
}

/** Perp fills only (HIP-3 `dex:COIN` included): spot pairs (`@107`, `PURR/USDC`) pay fees in the bought token. */
export function isPerpFill(coin: string): boolean {
  return !coin.startsWith("@") && !coin.includes("/");
}

/**
 * Realized PnL of `fills` at or after `since`: Σ (closedPnl − fee) over perp fills, in USD (perp collateral is a USD
 * stablecoin). Negative is a loss. A value that isn't a finite number throws: the caller must not guess.
 */
export function realizedPnlUsd(fills: readonly DailyLossFill[], since: number): number {
  let sum = 0;
  for (const f of fills) {
    if (f.time < since || !isPerpFill(f.coin)) continue;
    const pnl = Number(f.closedPnl);
    const fee = Number(f.fee);
    if (!Number.isFinite(pnl) || !Number.isFinite(fee)) throw new RangeError(`fill ${f.coin} at ${f.time} has an unreadable closedPnl or fee`);
    sum += pnl - fee;
  }
  return sum;
}

/** Today's realized loss (≥ 0) from a realized PnL: what `PolicyContext.dailyLossUsd` expects. */
export function dailyRealizedLossUsd(realizedPnl: number): number {
  return Math.max(0, -realizedPnl);
}
