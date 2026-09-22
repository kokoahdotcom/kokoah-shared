/**
 * Nonce management.
 *
 * HL rules (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets): the 100 highest
 * nonces are stored per signer; a new nonce must be larger than the smallest of them, never reused, and within
 * `(T − 2 days, T + 1 day)` of block time. The standard strategy is `nonce = max(now, last + 1)` per signer.
 *
 * Multi-tab browsers must serialize signing (Web Locks) and persist `last`; servers keep an atomic counter per agent.
 * This module provides the interface and a simple in-memory implementation.
 *
 * @module
 */

/** Issues strictly increasing nonces per signer key (e.g. the agent address). */
export interface NonceManager {
  /** Next nonce for `key` (default key when omitted). Must be strictly greater than any nonce issued before. */
  next(key?: string): number;
  /** Records a nonce used elsewhere (e.g. restored from storage), so later nonces stay above it. */
  observe?(nonce: number, key?: string): void;
}

/** Options for {@link MonotonicNonceManager}. */
export interface MonotonicNonceManagerOptions {
  /** Clock in ms. Default `Date.now`. */
  now?: () => number;
  /** Offset added to the clock (e.g. server time − local time) to correct device clock skew. Default 0. */
  clockOffsetMs?: number;
}

const DEFAULT_KEY = "default";

/** In-memory `max(now, last + 1)` nonce manager. Not shared across processes or tabs. */
export class MonotonicNonceManager implements NonceManager {
  private readonly last = new Map<string, number>();
  private readonly clock: () => number;
  private offset: number;

  constructor(options: MonotonicNonceManagerOptions = {}) {
    this.clock = options.now ?? (() => Date.now());
    this.offset = options.clockOffsetMs ?? 0;
  }

  next(key: string = DEFAULT_KEY): number {
    const k = key.toLowerCase();
    const now = Math.floor(this.clock() + this.offset);
    const prev = this.last.get(k);
    const nonce = prev === undefined ? now : Math.max(now, prev + 1);
    this.last.set(k, nonce);
    return nonce;
  }

  observe(nonce: number, key: string = DEFAULT_KEY): void {
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new RangeError("nonce must be a non-negative safe integer");
    // A nonce beyond HL's window would push every later nonce out of the window and stop all signing.
    if (nonce >= Math.floor(this.clock() + this.offset) + NONCE_MAX_FUTURE_MS) throw new RangeError("nonce is more than 1 day ahead of the clock");
    const k = key.toLowerCase();
    const prev = this.last.get(k);
    if (prev === undefined || nonce > prev) this.last.set(k, nonce);
  }

  /** Last issued/observed nonce for a key, if any. */
  peek(key: string = DEFAULT_KEY): number | undefined {
    return this.last.get(key.toLowerCase());
  }

  /** Updates the clock offset (server time − local time), e.g. from `exchangeStatus` or `webData3.serverTime`. */
  setClockOffset(offsetMs: number): void {
    this.offset = offsetMs;
  }
}

/** Nonce window accepted by HL relative to block time: more than 2 days in the past or 1 day in the future is rejected. */
export const NONCE_MAX_PAST_MS = 2 * 24 * 60 * 60 * 1000;
export const NONCE_MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

/** True if `nonce` falls inside HL's accepted window around `now`. */
export function isNonceInWindow(nonce: number, now: number): boolean {
  return nonce > now - NONCE_MAX_PAST_MS && nonce < now + NONCE_MAX_FUTURE_MS;
}
