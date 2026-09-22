/**
 * Asset ids and coin names.
 *
 * Source: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids
 * - Perps: index in `meta.universe` (BTC = 0 on mainnet).
 * - Spot: `10000 + spotMeta.universe[i].index`.
 * - HIP-3 (builder-deployed perps): `100000 + perp_dex_index × 10000 + index_in_meta`; names are always `{dex}:{coin}`.
 * - Outcomes (HIP-4): `100_000_000 + 10 × outcome + side`.
 * Mainnet and testnet ids differ.
 *
 * @module
 */

export const SPOT_ASSET_OFFSET = 10_000;
export const HIP3_ASSET_OFFSET = 100_000;
export const HIP3_DEX_STRIDE = 10_000;
export const OUTCOME_ASSET_OFFSET = 100_000_000;

function assertIndex(value: number, what: string, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new RangeError(`${what} must be an integer in [0, ${max}], got ${value}`);
}

/** Perp asset id on the first (validator-operated) dex: the index in `meta.universe`. */
export function perpAssetId(indexInMeta: number): number {
  assertIndex(indexInMeta, "indexInMeta", SPOT_ASSET_OFFSET - 1);
  return indexInMeta;
}

/** Spot asset id: `10000 + spotIndex` (the `index` field of `spotMeta.universe[i]`, not the token id). */
export function spotAssetId(spotIndex: number): number {
  assertIndex(spotIndex, "spotIndex", HIP3_ASSET_OFFSET - SPOT_ASSET_OFFSET - 1);
  return SPOT_ASSET_OFFSET + spotIndex;
}

/** HIP-3 asset id: `100000 + dexIndex × 10000 + indexInMeta` (dexIndex ≥ 1; 0 is the first dex). */
export function hip3AssetId(dexIndex: number, indexInMeta: number): number {
  assertIndex(dexIndex, "dexIndex");
  if (dexIndex < 1) throw new RangeError("HIP-3 dexIndex must be ≥ 1 (index 0 is the validator-operated dex)");
  assertIndex(indexInMeta, "indexInMeta", HIP3_DEX_STRIDE - 1);
  const id = HIP3_ASSET_OFFSET + dexIndex * HIP3_DEX_STRIDE + indexInMeta;
  if (id >= OUTCOME_ASSET_OFFSET) throw new RangeError("dexIndex too large");
  return id;
}

/** Perp asset id for any dex: plain index for dex 0, HIP-3 formula otherwise. */
export function perpAssetIdForDex(dexIndex: number, indexInMeta: number): number {
  return dexIndex === 0 ? perpAssetId(indexInMeta) : hip3AssetId(dexIndex, indexInMeta);
}

/** Outcome (HIP-4) asset id: `100000000 + 10 × outcome + side`, side ∈ {0, 1}. */
export function outcomeAssetId(outcome: number, side: 0 | 1): number {
  assertIndex(outcome, "outcome");
  if (side !== 0 && side !== 1) throw new RangeError("side must be 0 or 1");
  return OUTCOME_ASSET_OFFSET + 10 * outcome + side;
}

/** Decoded asset id. */
export type DecodedAssetId =
  | { kind: "perp"; dexIndex: 0; indexInMeta: number }
  | { kind: "spot"; spotIndex: number }
  | { kind: "hip3"; dexIndex: number; indexInMeta: number }
  | { kind: "outcome"; outcome: number; side: 0 | 1 };

/** Decodes an asset id into its kind and indices. */
export function decodeAssetId(assetId: number): DecodedAssetId {
  assertIndex(assetId, "assetId");
  if (assetId < SPOT_ASSET_OFFSET) return { kind: "perp", dexIndex: 0, indexInMeta: assetId };
  if (assetId < HIP3_ASSET_OFFSET) return { kind: "spot", spotIndex: assetId - SPOT_ASSET_OFFSET };
  if (assetId < OUTCOME_ASSET_OFFSET) {
    const rel = assetId - HIP3_ASSET_OFFSET;
    const dexIndex = Math.floor(rel / HIP3_DEX_STRIDE);
    if (dexIndex < 1) throw new RangeError(`Asset id ${assetId} is in the reserved range 100000–109999`);
    return { kind: "hip3", dexIndex, indexInMeta: rel % HIP3_DEX_STRIDE };
  }
  const enc = assetId - OUTCOME_ASSET_OFFSET;
  return { kind: "outcome", outcome: Math.floor(enc / 10), side: (enc % 10) as 0 | 1 };
}

// ---------------------------------------------------------------------------------------------
// Coin names
// ---------------------------------------------------------------------------------------------

/** Parsed coin name. */
export interface ParsedCoin {
  /** HIP-3 dex name, or "" for the first perp dex / spot. */
  dex: string;
  /** Symbol without the dex prefix (e.g. "SP500", "BTC", "@107", "PURR/USDC"). */
  symbol: string;
  kind: "perp" | "hip3" | "spotIndex" | "spotPair" | "outcome";
}

const DEX_NAME_RE = /^[A-Za-z0-9<>_-]{1,32}$/;
const SYMBOL_RE = /^[A-Za-z0-9._/@#+-]{1,64}$/;

/**
 * Parses a Hyperliquid coin string.
 * - `"xyz:SP500"` → HIP-3 `{dex:"xyz", symbol:"SP500"}`
 * - `"BTC"` → first-dex perp
 * - `"@107"` → spot pair by index, `"PURR/USDC"` → canonical spot pair name
 * - `"#10"` → outcome coin
 *
 * Returns null for malformed input (empty parts, several colons, whitespace).
 */
export function parseCoin(coin: string): ParsedCoin | null {
  if (typeof coin !== "string" || coin.length === 0 || coin !== coin.trim()) return null;
  const parts = coin.split(":");
  if (parts.length > 2) return null;
  if (parts.length === 2) {
    const [dex = "", symbol = ""] = parts;
    if (!DEX_NAME_RE.test(dex) || !SYMBOL_RE.test(symbol) || symbol.includes("/") || symbol.startsWith("@")) return null;
    return { dex, symbol, kind: "hip3" };
  }
  if (!SYMBOL_RE.test(coin)) return null;
  if (coin.startsWith("@")) return /^@\d+$/.test(coin) ? { dex: "", symbol: coin, kind: "spotIndex" } : null;
  if (coin.startsWith("#")) return /^#\d+$/.test(coin) ? { dex: "", symbol: coin, kind: "outcome" } : null;
  if (coin.includes("/")) return /^[^/]+\/[^/]+$/.test(coin) ? { dex: "", symbol: coin, kind: "spotPair" } : null;
  return { dex: "", symbol: coin, kind: "perp" };
}

/** Builds a HIP-3 coin name: `formatHip3Coin("xyz", "SP500")` → `"xyz:SP500"`. */
export function formatHip3Coin(dex: string, symbol: string): string {
  if (!DEX_NAME_RE.test(dex)) throw new RangeError(`Invalid dex name: ${JSON.stringify(dex)}`);
  if (!SYMBOL_RE.test(symbol) || symbol.includes(":")) throw new RangeError(`Invalid symbol: ${JSON.stringify(symbol)}`);
  return `${dex}:${symbol}`;
}

/** True for `dex:COIN` names. */
export function isHip3Coin(coin: string): boolean {
  return parseCoin(coin)?.kind === "hip3";
}
