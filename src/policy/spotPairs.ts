/**
 * Spot pairs a Kokoah key may trade (PHASE3 SPOT): the stablecoin pairs of Convert (`STABLECOIN_PAIRS`) plus the
 * **verified** tokens against USDC: Hyperliquid's own "Strict" list, pinned per network from `spotMeta` (pair index,
 * both token indices, names and token ids). Signers trade spot only on these pairs, and only when the live `spotMeta`
 * they fetch themselves confirms a pair exactly (`verifiedSpotPairs`), so a renamed, re-listed or look-alike token is
 * never traded. Every other spot token (a HIP-1 token anyone can deploy) is "unverified": apps may show it with a
 * warning, signers refuse it.
 *
 * Why a pinned list and not a rule such as "24 h volume above $X": a spot token's mark price comes from its own order
 * book, so whoever controls a thin book controls the mark, the price band and the volume figure (wash trades are
 * cheap). A key driven by a compromised app could then buy a worthless token at any price from the attacker's own
 * asks. On mainnet, signers also cap one order at a share of the pair's 24 h volume
 * ({@link SPOT_ORDER_MAX_SHARE_OF_DAY_VOLUME}). Adding a token is a deliberate change here (and a signer release).
 *
 * @module
 */
import type { SpotMetaLike } from "../markets/registry.js";
import { type PinnedSpotToken, spotPairMatches, STABLECOIN_PAIRS, type StablecoinPair, USDC_TOKEN } from "./stablecoins.js";

/** A spot network. */
export type SpotNetwork = "mainnet" | "testnet";

/** How far Kokoah trusts a spot token: Convert's stablecoins, the verified list, or anything else. */
export type SpotTrust = "stablecoin" | "verified" | "unverified";

/** A pinned token/USDC pair (the same shape as a stablecoin pair). */
export type SpotPairPin = StablecoinPair;

/** A pinned pair the live `spotMeta` confirmed. */
export interface VerifiedSpotPair extends SpotPairPin {
  readonly trust: "stablecoin" | "verified";
}

const M = USDC_TOKEN.mainnet;
const T = USDC_TOKEN.testnet;
const pin = (coin: string, index: number, name: string, tokenIndex: number, tokenId: `0x${string}`, quote: PinnedSpotToken): SpotPairPin => ({
  coin,
  index,
  base: { name, index: tokenIndex, tokenId },
  quote,
});

/**
 * Verified token/USDC pairs by network: the tokens of Hyperliquid's own "Strict" spot list (the base-token ids its web
 * app hard-codes and shows by default; `series-DoSu52JX.js`, read 2026-09-25) that have a USDC pair, pinned from
 * `spotMeta` on 2026-09-25 (every pin still matched mainnet `spotMeta` on 2026-10-05). Stablecoins of Convert
 * (`STABLECOIN_PAIRS`) are not repeated here. Left out: AXL on mainnet and UAVAX on testnet (no USDC pair). One
 * addition outside that list: HTAO on mainnet. Many of these trade thinly; signers add a per-order volume cap on
 * mainnet ({@link spotOrderVolumeProblem}).
 */
export const VERIFIED_SPOT_PAIRS: Readonly<Record<SpotNetwork, readonly SpotPairPin[]>> = Object.freeze({
  mainnet: Object.freeze<SpotPairPin[]>([
    pin("PURR/USDC", 0, "PURR", 1, "0xc1fb593aeffbeb02f85e0308e9956a90", M),
    pin("@1", 1, "HFUN", 2, "0xbaf265ef389da684513d98d68edf4eae", M),
    pin("@8", 8, "POINTS", 9, "0xbb03842e1f71ed27ed8fa012b29affd4", M),
    pin("@4", 4, "JEFF", 5, "0xfcf28885456bf7e7cbe5b7a25407c5bc", M),
    pin("@59", 59, "CATBAL", 76, "0x38348c17e1a18559bbda232d22007695", M),
    pin("@107", 107, "HYPE", 150, "0x0d01dc56dcaaca66ad901c959b4011ec", M),
    pin("@85", 85, "PIP", 127, "0xe85f43e1f91e3c8cdf3acbd7e0855b8e", M),
    pin("@51", 51, "ATEHUN", 64, "0xbebb35d03b83a302a2aa06dbaa67dd9f", M),
    pin("@136", 136, "SOLV", 157, "0xcf548188e24a0ce3dc3b281242baafd9", M),
    pin("@142", 142, "UBTC", 197, "0x8f254b963e8468305d409b33aa137c67", M),
    pin("@151", 151, "UETH", 221, "0xe1edd30daaf5caac3fe63569e24748da", M),
    pin("@153", 153, "FEUSD", 241, "0x88102bea0bbad5f301f6e9e4dacdf979", M),
    pin("@160", 160, "BUDDY", 222, "0x84ecb2340931f6b153ff10bcfafb6726", M),
    pin("@156", 156, "USOL", 254, "0x49b67c39f5566535de22b29b0e51e685", M),
    pin("@162", 162, "UFART", 269, "0x7650808198966e4285687d3deb556ccc", M),
    pin("@184", 184, "HPENGU", 292, "0x1765b5a9ec8fc3cdbc209c63cac68e86", M),
    pin("@182", 182, "XAUT0", 297, "0xfd61ec89811ba3cf2ae12d0ed8ef1afd", M),
    pin("@180", 180, "USDHL", 291, "0xd289c79872a9eace15cc4cadb030661f", M),
    pin("@132", 132, "LIQD", 178, "0xa043053570d42d6f553896820dfd42b6", M),
    pin("@188", 188, "UPUMP", 299, "0x544e60f98a36d7b22c0fb5824b84f795", M),
    pin("@193", 193, "UUUSPX", 319, "0x2ff71b802a6788a052c7f1a58ec863af", M),
    pin("@194", 194, "UBONK", 320, "0xb113d34e351cf195733c98442530c099", M),
    pin("@230", 230, "USDH", 360, "0x54e00a5988577cb0b0c9ab0cb6ef7f4b", M),
    pin("@210", 210, "UXPL", 343, "0x2c54c60600e1d786b2dfc139a38a5a99", M),
    pin("@228", 228, "UDZ", 361, "0x9cd8fd4cae61e63a10ba7615780ee520", M),
    pin("@206", 206, "UENA", 338, "0x593494b6af79172fa983a0cf1c88e0e0", M),
    pin("@336", 336, "KHYPE", 121, "0xbc8a22f25703a03101630ce6b09f4baa", M),
    pin("@243", 243, "UMON", 383, "0x58dae745c8c5fed4012f35ef39829c2d", M),
    pin("@334", 334, "KNTQ", 124, "0xbd31bd605c0a1b82c72aae3587f9061f", M),
    pin("@256", 256, "SEDA", 374, "0x83a0bf54708a0236a49f7301677ffdc2", M),
    pin("@258", 258, "STABLE", 398, "0xec43194f64d555bdaef5afb5b6c6c686", M),
    pin("@261", 261, "HAR", 205, "0x9325025f805731935c1df7f97e654cda", M),
    pin("@251", 251, "MMOVE", 395, "0xedfb8d993ee8cb935338601d8673dfcf", M),
    pin("@242", 242, "SWAP", 213, "0x1684cb225aa305ea5be44f2a79214e7e", M),
    pin("@284", 284, "QONE", 401, "0xbf086597fdd837bfb58cf968533edaf3", M),
    pin("@335", 335, "HPL", 120, "0x5e887f0c6c3deec190c36186bf23369f", M),
    pin("@272", 272, "UZEC", 419, "0x1c994ad3381d31c86c8c2d74ed89a365", M),
    pin("@305", 305, "BASED", 339, "0xbe946bd7862245615d6729ec5b67cc7e", M),
    pin("@290", 290, "UVIRT", 443, "0x85b8124314ae77b78b4b6f20ecd93149", M),
    pin("@306", 306, "UAVAX", 451, "0x730fc3855fb77d2aa5a19dd7891dbe80", M),
    pin("@286", 286, "HSEI", 437, "0x4519b5c4a2fd0beb66306336f63c7b99", M),
    pin("@699", 699, "UANSEM", 844, "0xa7e941cbc468d48b99dc6002f8f5042b", M),
    pin("@465", 465, "SPCXD", 610, "0x4f49b5f025c969501c6a350f984e1725", M),
    pin("@700", 700, "DRV", 843, "0x0896dbb30344c65b8727f41c3fe9ef62", M),
    pin("@704", 704, "QQQX", 847, "0xbf0ff526276afdfba89c41a520e154fe", M),
    pin("@703", 703, "SPYX", 846, "0x29067197b3125c8b82ad0f338e4a31b2", M),
    pin("@706", 706, "MUX", 849, "0x6679db5a5be138456cf95b1fc7e870a5", M),
    pin("@702", 702, "NVDAX", 845, "0x8e3a7531199e3f0d6e616a1f9edae9a3", M),
    pin("@705", 705, "SKHYX", 848, "0xd7721f1acc95fd05516bdc5138ded7bc", M),
    pin("@719", 719, "TREAD", 512, "0xc03b5b39372b9daa292adc59a8568263", M),
    // Not on the Strict list: HTAO, TAO bridged by the Mentat bridge (its HyperEVM contract is the bridge's OFT,
    // 0xdf23…621f), for Buy TAO. Pinned from mainnet `spotMeta` on 2026-10-26.
    pin("@307", 307, "HTAO", 452, "0x3958075da51fc7a18e390dc83bd71d87", M),
  ]),
  testnet: Object.freeze<SpotPairPin[]>([
    pin("PURR/USDC", 0, "PURR", 1, "0xc4bf3f870c0e9465323c0b6ed28096c2", T),
    pin("@138", 138, "HFUN", 159, "0xd986b6fd648918a55dafc525b79f9095", T),
    pin("@60", 60, "SCHIZO", 79, "0x3a66f36f388dd3b7f04bcf55855482a2", T),
    pin("@1035", 1035, "HYPE", 1105, "0x7317beb7cceed72ef0b346074cc8e7ab", T),
    pin("@1137", 1137, "UETH", 1242, "0xe4371d8166f362d6578725f11e0a14f3", T),
    pin("@1461", 1461, "UUVIRT", 1588, "0x0740d272a61e2ee49107c96562b23934", T),
  ]),
});

/**
 * One spot order on a verified pair may be at most this share of the pair's 24 h notional volume, read by the signer
 * itself (`spotMetaAndAssetCtxs.dayNtlVlm`). Mainnet only: it limits what a thin book (or a manipulated mark) can cost
 * in one order and stops orders far larger than the market. Null: no cap (testnet, where volumes are tiny and funds are
 * not real). Stablecoin pairs are exempt: their price is pinned near $1 and banded at 10% like every order.
 */
export const SPOT_ORDER_MAX_SHARE_OF_DAY_VOLUME: Readonly<Record<SpotNetwork, number | null>> = Object.freeze({ mainnet: 0.1, testnet: null });

/** The largest order (USD) {@link SPOT_ORDER_MAX_SHARE_OF_DAY_VOLUME} allows for a pair, or undefined without a cap. */
export function spotOrderCapUsd(network: SpotNetwork, dayVolumeUsd: number | undefined): number | undefined {
  const share = SPOT_ORDER_MAX_SHARE_OF_DAY_VOLUME[network];
  if (share === null) return undefined;
  return typeof dayVolumeUsd === "number" && Number.isFinite(dayVolumeUsd) && dayVolumeUsd > 0 ? dayVolumeUsd * share : 0;
}

/** Why an order of `notionalUsd` on a verified pair is too large for its 24 h volume, or "" when it fits. */
export function spotOrderVolumeProblem(input: { network: SpotNetwork; label: string; notionalUsd: number; dayVolumeUsd: number | undefined }): string {
  const cap = spotOrderCapUsd(input.network, input.dayVolumeUsd);
  if (cap === undefined || input.notionalUsd <= cap + 1e-9) return "";
  const pct = Math.round((SPOT_ORDER_MAX_SHARE_OF_DAY_VOLUME[input.network] ?? 0) * 100);
  const usd = (x: number) => `$${(Math.floor(x * 100) / 100).toLocaleString("en-US")}`;
  return cap > 0
    ? `${input.label}: one order can be at most ${pct}% of what the pair traded in the last 24 hours (${usd(cap)}); this one is ${usd(input.notionalUsd)}.`
    : `${input.label}: the pair has not traded in the last 24 hours, so Kokoah can't place orders on it now.`;
}

/** Coin names of the verified (non-stablecoin) pairs of `network`. */
export function verifiedSpotPairCoins(network: SpotNetwork): string[] {
  return VERIFIED_SPOT_PAIRS[network].map((p) => p.coin);
}

/**
 * A readable name for a policy's spot coin id (`allowedSpotCoins`, e.g. `@107`) as `base/quote` (e.g. `HYPE/USDC`),
 * from the pinned stablecoin and verified lists. These are the only coins a signer allows spot on, so a wallet showing
 * what the user signs needs no `spotMeta` fetch. A coin id on neither list (which a signer-accepted policy never holds)
 * is returned unchanged.
 */
export function spotPairDisplayName(network: SpotNetwork, coin: string): string {
  const pair = STABLECOIN_PAIRS[network].find((p) => p.coin === coin) ?? VERIFIED_SPOT_PAIRS[network].find((p) => p.coin === coin);
  return pair ? `${pair.base.name}/${pair.quote.name}` : coin;
}

/**
 * The pinned pairs of `network` (stablecoins first, then verified tokens) that the live `spotMeta` confirms exactly.
 * Anything that differs is left out (fail closed). Pass only a `spotMeta` the caller fetched from Hyperliquid itself.
 */
export function verifiedSpotPairs(network: SpotNetwork, spotMeta: SpotMetaLike | null | undefined): VerifiedSpotPair[] {
  const stable = STABLECOIN_PAIRS[network].filter((p) => spotPairMatches(p, spotMeta)).map((p) => ({ ...p, trust: "stablecoin" as const }));
  const verified = VERIFIED_SPOT_PAIRS[network].filter((p) => spotPairMatches(p, spotMeta)).map((p) => ({ ...p, trust: "verified" as const }));
  return [...stable, ...verified];
}

/**
 * Kokoah's trust in a spot token, by its token id (names can be copied; token ids can't): `stablecoin` for Convert's
 * stablecoins and USDC, `verified` for the verified list, else `unverified`.
 */
export function spotTokenTrust(network: SpotNetwork, token: { name: string; index: number; tokenId?: string | null }): SpotTrust {
  const id = typeof token.tokenId === "string" ? token.tokenId.toLowerCase() : undefined;
  const same = (p: PinnedSpotToken) => p.index === token.index && p.name === token.name && p.tokenId === id;
  if (STABLECOIN_PAIRS[network].some((p) => same(p.base) || same(p.quote))) return "stablecoin";
  if (VERIFIED_SPOT_PAIRS[network].some((p) => same(p.base))) return "verified";
  return "unverified";
}
