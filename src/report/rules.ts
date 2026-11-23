/**
 * The trading report card's fixed rules (`card.ts` applies them): the window, the samples a figure needs and the
 * thresholds of its findings, and how much it reads. A module of its own so the app's method page (docs) states the
 * same numbers without loading the calculation.
 */

/** The default window: the 30 days before now (a calendar month is the other: `monthWindow`). */
export const WINDOW_DAYS = 30;
/** Trips a figure needs (win rate; each group of a habit). */
export const MIN_TRIPS = 10;
/** Trips an hour or weekday bucket needs. */
export const MIN_BUCKET_TRIPS = 5;
/** A trip opened this long after a losing trip closed is "after a loss". */
export const AFTER_LOSS_HOURS = 4;
/** After-loss trips this much bigger (median entry) than the others are a finding. */
export const SIZE_UP_RATIO = 1.5;
/** Losers held this much longer (median) than winners are a finding. */
export const HOLD_RATIO = 1.5;
/** Taker share from which it is a finding, and the fills it needs. */
export const HIGH_TAKER_SHARE = 0.7;
export const MIN_TAKER_FILLS = 20;
/** An open position closer than this to its liquidation price (a fraction of the mark) is a finding. */
export const NEAR_LIQUIDATION = 0.1;
/** Losing days from which they are a finding (when they are also at least half the active days). */
export const MANY_LOSING_DAYS = 5;
/**
 * What is left of the gap to Hyperliquid's figure after the open positions is put down to the timing of its graph
 * (it is sampled, and starts at its last point at or before the window) only when the history is complete and only up
 * to the larger of these dollars and this share of the result after costs; otherwise the card says it isn't explained.
 */
export const TIMING_LIMIT_USD = 1;
export const TIMING_LIMIT_SHARE = 0.01;
/** History store pages read at most (2,000 fills each); older times in the window are left to Hyperliquid. */
export const MAX_STORE_PAGES = 50;
/** Hyperliquid requests one card may make for its gaps (weight 20 plus 1 per 20 fills each). */
export const MAX_HL_REQUESTS = 12;
/** Funding answers one card may read: 500 entries each (weight 20 plus 25). */
export const MAX_FUNDING_REQUESTS = 30;
/**
 * Hyperliquid's `historicalOrders` answers at most this many order statuses, the newest first (one read per card,
 * only when it has liquidations: weight 20 plus 1 per 20). A full answer vouches only for the times after its oldest.
 */
export const HL_ORDER_HISTORY = 2000;
/** Perp dexes whose open orders the stop-loss check reads at most (weight 20 each); more: it reads nothing. */
export const MAX_ORDER_DEXES = 6;
