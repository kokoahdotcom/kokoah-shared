/**
 * Stablecoin pairs for Kokoah's Convert: spot pairs of a stablecoin against USDC, pinned per network from
 * Hyperliquid's `spotMeta` (pair index, both token indices, names and token ids). Signers allow spot orders only on
 * these pairs (policy `allowedSpotCoins`) and check the live `spotMeta` they fetch themselves against this list, so a
 * renamed, re-listed or look-alike token is never traded.
 *
 * Pinned from `spotMeta` on 2026-09-25. Mainnet: USDT0 and USDE, stablecoins Hyperliquid treats as quote assets
 * (their pairs get the 80% lower stable-pair fees). USDH, which Hyperliquid's own swap also offers, is left out: it
 * was retired in June 2026 and trades thinly off its peg. Testnet: the two pairs Hyperliquid's testnet swap offers
 * (TZERO, shown there as "USDT", and USDZZ); testnet prices are far from $1. Adding a pair is a deliberate change here
 * (and a signer release).
 *
 * @module
 */
import type { SpotMetaLike } from "../markets/registry.js";

/** One token of a pinned pair. */
export interface PinnedSpotToken {
  readonly name: string;
  /** `spotMeta.tokens[].index`. */
  readonly index: number;
  /** `spotMeta.tokens[].tokenId`: unique and fixed for the token's life. */
  readonly tokenId: `0x${string}`;
}

/** A stablecoin/USDC spot pair. */
export interface StablecoinPair {
  /** HL coin name of the pair (`@166`), used in orders, books and mids. */
  readonly coin: string;
  /** `spotMeta.universe[].index` (the order asset id is 10000 + index). */
  readonly index: number;
  /** The stablecoin (base). */
  readonly base: PinnedSpotToken;
  /** USDC (quote). */
  readonly quote: PinnedSpotToken;
}

const USDC_MAINNET: PinnedSpotToken = { name: "USDC", index: 0, tokenId: "0x6d1e7cde53ba9467b783cb7c530ce054" };
const USDC_TESTNET: PinnedSpotToken = { name: "USDC", index: 0, tokenId: "0xeb62eee3685fc4c43992febcd9e75443" };

/** USDC, the quote token of every pinned pair, by network. */
export const USDC_TOKEN: Readonly<Record<"mainnet" | "testnet", PinnedSpotToken>> = Object.freeze({ mainnet: USDC_MAINNET, testnet: USDC_TESTNET });

/** Pinned stablecoin pairs by network. */
export const STABLECOIN_PAIRS: Readonly<Record<"mainnet" | "testnet", readonly StablecoinPair[]>> = Object.freeze({
  mainnet: Object.freeze<StablecoinPair[]>([
    { coin: "@166", index: 166, base: { name: "USDT0", index: 268, tokenId: "0x25faedc3f054130dbb4e4203aca63567" }, quote: USDC_MAINNET },
    { coin: "@150", index: 150, base: { name: "USDE", index: 235, tokenId: "0x2e6d84f2d7ca82e6581e03523e4389f7" }, quote: USDC_MAINNET },
  ]),
  testnet: Object.freeze<StablecoinPair[]>([
    { coin: "@1115", index: 1115, base: { name: "TZERO", index: 1204, tokenId: "0x7d25dbd93e357dc3e423706e826e6994" }, quote: USDC_TESTNET },
    { coin: "@1200", index: 1200, base: { name: "USDZZ", index: 1328, tokenId: "0x7bc98b970531175951be66e5307ce3bc" }, quote: USDC_TESTNET },
  ]),
});

/** Coin names of the pinned pairs of `network` (policy `allowedSpotCoins`). */
export function stablecoinPairCoins(network: "mainnet" | "testnet"): string[] {
  return STABLECOIN_PAIRS[network].map((p) => p.coin);
}

type LiveToken = SpotMetaLike["tokens"][number];

function tokenMatches(pinned: PinnedSpotToken, live: LiveToken | undefined): boolean {
  if (!live || live.name !== pinned.name || live.index !== pinned.index) return false;
  const tokenId = (live as { tokenId?: unknown }).tokenId;
  return typeof tokenId === "string" && tokenId.toLowerCase() === pinned.tokenId;
}

/**
 * True when the live `spotMeta` confirms `pair` exactly: the same pair index and name, tokens `[base, quote]` in that
 * order, and each token with the pinned index, name and token id.
 */
export function spotPairMatches(pair: StablecoinPair, spotMeta: SpotMetaLike | null | undefined): boolean {
  if (!spotMeta || !Array.isArray(spotMeta.universe) || !Array.isArray(spotMeta.tokens)) return false;
  const live = spotMeta.universe.find((u) => u.index === pair.index);
  if (!live || live.name !== pair.coin || !Array.isArray(live.tokens) || live.tokens.length !== 2) return false;
  if (live.tokens[0] !== pair.base.index || live.tokens[1] !== pair.quote.index) return false;
  const tokens = new Map(spotMeta.tokens.map((t) => [t.index, t] as const));
  return tokenMatches(pair.base, tokens.get(pair.base.index)) && tokenMatches(pair.quote, tokens.get(pair.quote.index));
}

/**
 * The pinned pairs of `network` that the live `spotMeta` confirms exactly: same pair index and name, tokens
 * `[base, quote]` in that order, and each token with the pinned index, name and token id. Anything that differs is left
 * out (fail closed). Pass only a `spotMeta` the caller fetched from Hyperliquid itself.
 */
export function verifiedStablecoinPairs(network: "mainnet" | "testnet", spotMeta: SpotMetaLike | null | undefined): StablecoinPair[] {
  return STABLECOIN_PAIRS[network].filter((pair) => spotPairMatches(pair, spotMeta));
}
