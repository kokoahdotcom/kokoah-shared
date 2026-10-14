/**
 * Market registry built from HL `/info` metadata (`meta`, `allPerpMetas`, `perpDexs`, `spotMeta`,
 * optionally `perpConciseAnnotations`).
 *
 * Rules implemented:
 * - Delisted markets are skipped from listings but **keep their index**: asset ids are positional
 *   (research A §3.2; asset-ids docs).
 * - HIP-3 asset ids: `100000 + dexIndex × 10000 + index` where `dexIndex` is the position in `perpDexs`
 *   (and in `allPerpMetas`). The registry cross-checks dex names against coin prefixes and throws on mismatch,
 *   because a wrong index would route orders to the wrong market.
 * - Margin mode: `marginMode` ("strictIsolated" | "noCross") or the deprecated `onlyIsolated` flag.
 * - {@link MarketRegistry.validateCoin} must be used before any WebSocket subscription: subscribing to a
 *   non-existent coin makes HL drop the whole connection (research A §7; FRONTEND_SPEC §22.1).
 *
 * @module
 */
import { type MarginTier, type RawMarginTable, resolveMarginTiers } from "../risk/margin.js";
import type { PriceKind } from "../precision/index.js";
import { parseCoin, perpAssetIdForDex, spotAssetId } from "./assetIds.js";
import {
  type MarketCategory,
  type MarketDisplay,
  normalizeCategory,
  SPOT_TOKEN_DISPLAY_REMAP,
  WELL_KNOWN_MARKETS,
} from "./displayNames.js";

// ---------------------------------------------------------------------------------------------
// Input shapes (structural; compatible with @nktkas/hyperliquid response types and raw JSON)
// ---------------------------------------------------------------------------------------------

/** One entry of `meta.universe`. Extra fields are ignored. */
export interface PerpUniverseEntry {
  readonly name: string;
  readonly szDecimals: number;
  readonly maxLeverage: number;
  readonly marginTableId?: number;
  readonly onlyIsolated?: boolean;
  readonly isDelisted?: boolean;
  readonly marginMode?: string;
  readonly growthMode?: string;
}

/** A `meta` response (one perp dex). */
export interface PerpMetaLike {
  readonly universe: ReadonlyArray<PerpUniverseEntry>;
  readonly marginTables?: ReadonlyArray<readonly [number, RawMarginTable]>;
  readonly collateralToken?: number;
}

/** One entry of `perpDexs` (null for the first dex). */
export type PerpDexLike = {
  readonly name: string;
  readonly fullName?: string;
  readonly deployer?: string;
  readonly assetToStreamingOiCap?: ReadonlyArray<readonly [string, string]>;
  readonly assetToFundingMultiplier?: ReadonlyArray<readonly [string, string]>;
} | null;

/** A `spotMeta` response. */
export interface SpotMetaLike {
  readonly universe: ReadonlyArray<{ readonly tokens: readonly [number, number] | readonly number[]; readonly name: string; readonly index: number; readonly isCanonical?: boolean }>;
  readonly tokens: ReadonlyArray<{ readonly name: string; readonly szDecimals: number; readonly index: number; readonly fullName?: string | null }>;
}

/** `perpConciseAnnotations` response: `[coin, {category, displayName?, keywords?}]` pairs. */
export type PerpAnnotationsLike = ReadonlyArray<readonly [string, { readonly category: string; readonly displayName?: string; readonly keywords?: ReadonlyArray<string> }]>;

/** Input for {@link MarketRegistry.fromInfo}. Provide `allPerpMetas` (preferred) or `meta` (+ optional `dexMetas`). */
export interface MarketRegistryInput {
  /** `allPerpMetas` response: index i is perp dex i (0 = validator-operated dex). */
  allPerpMetas?: ReadonlyArray<PerpMetaLike>;
  /** `meta` response for the first dex. Ignored when `allPerpMetas` is given. */
  meta?: PerpMetaLike;
  /** `meta` responses fetched per HIP-3 dex (`{type:"meta", dex}`), keyed by dex name. Requires `perpDexs`. */
  dexMetas?: Readonly<Record<string, PerpMetaLike>>;
  /** `perpDexs` response: dex names by index. Strongly recommended with `allPerpMetas`; required with `dexMetas`. */
  perpDexs?: ReadonlyArray<PerpDexLike>;
  /** `spotMeta` response. */
  spotMeta?: SpotMetaLike;
  /** `perpConciseAnnotations` response, for categories and display names. */
  annotations?: PerpAnnotationsLike;
  /** Per-coin display overrides, merged over {@link WELL_KNOWN_MARKETS}. */
  displayOverrides?: Readonly<Record<string, Partial<MarketDisplay>>>;
  /**
   * When true, throw {@link MarketRegistryError} on any coin name that can't be parsed or doesn't match its dex
   * (the 0.1.0 behaviour), and on any market whose margin data is invalid. Default false: such entries are skipped,
   * keep their positional index (so every other market's asset id stays correct), are untradeable, and are reported
   * by {@link MarketRegistry.skippedEntries}. Live HL testnet metadata contains names like `VOLMEX:$EVIV` and
   * `tndex:A B:C`.
   */
  strict?: boolean;
}

/** A universe entry {@link MarketRegistry.fromInfo} skipped (non-strict mode). Its asset id maps to no market. */
export interface SkippedMarketEntry {
  readonly dexIndex: number;
  /** Position in the dex's `meta.universe`; the asset id `perpAssetIdForDex(dexIndex, index)` is reserved. */
  readonly index: number;
  readonly name: string;
  /** `invalid_margin`: a max leverage or margin tier ≤ 0, or an empty margin table. */
  readonly reason: "unparseable" | "unresolved_dex_name" | "invalid_margin";
  readonly message: string;
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

/** Kind of market. HIP-3 markets are perps on a builder-deployed dex. */
export type MarketKind = "perp" | "hip3" | "spot";

/** Margin modes a market allows: "cross" (cross and isolated), "strictIsolated" (no margin removal), "noCross". */
export type MarketMarginMode = "cross" | "strictIsolated" | "noCross";

/** Everything the app needs about one market. */
export interface MarketInfo {
  /** Wire coin name used in `/info` and WS (e.g. "BTC", "xyz:SP500", "@107", "PURR/USDC"). */
  readonly coin: string;
  readonly assetId: number;
  readonly kind: MarketKind;
  /** Perp dex name ("" for the first dex and for spot). */
  readonly dex: string;
  /** Perp dex index (0 for the first dex and for spot). */
  readonly dexIndex: number;
  /** Index in the dex's `meta.universe` (perps) or `spotMeta.universe[i].index` (spot). */
  readonly index: number;
  /** Symbol without the dex prefix ("SP500"); for spot the base token name. */
  readonly symbol: string;
  readonly szDecimals: number;
  /** Which MAX_DECIMALS rule applies to prices (6 perps / 8 spot). */
  readonly priceKind: PriceKind;
  /** Perps: max leverage (first margin tier). Spot: 1. */
  readonly maxLeverage: number;
  readonly marginTableId: number | null;
  readonly marginTiers: ReadonlyArray<MarginTier>;
  readonly marginMode: MarketMarginMode;
  /** True when cross margin is unavailable (strictIsolated or noCross). */
  readonly onlyIsolated: boolean;
  readonly isDelisted: boolean;
  /** HIP-3 growth mode (lower fees; `growthMode: "enabled"`). */
  readonly growthMode: boolean;
  readonly displayName: string;
  readonly category: MarketCategory;
  readonly note?: string;
  /** Collateral token index of the dex (perps), if known. */
  readonly collateralToken?: number;
  /** HIP-3: streaming open-interest cap (USD notional) from `perpDexs`, if listed. */
  readonly streamingOiCapUsd?: number;
  /** HIP-3: funding multiplier from `perpDexs`, if listed. */
  readonly fundingMultiplier?: number;
  /** Spot: base and quote token names (as on HyperCore, before display remapping). */
  readonly baseToken?: string;
  readonly quoteToken?: string;
}

/** Summary of one perp dex. */
export interface DexInfo {
  readonly index: number;
  /** "" for the first dex. */
  readonly name: string;
  readonly fullName: string;
  readonly collateralToken?: number;
  readonly liveMarkets: number;
  readonly delistedMarkets: number;
  /** Universe entries skipped: names unparseable or not matching the dex, or invalid margin data (non-strict mode). */
  readonly skippedMarkets: number;
}

/** Result of {@link MarketRegistry.validateCoin}. */
export type CoinValidation =
  | { ok: true; market: MarketInfo }
  | { ok: false; reason: "malformed" | "unknown_dex" | "unknown" | "delisted" | "dex_not_loaded"; message: string; market?: MarketInfo };

/** Thrown when metadata is inconsistent (e.g. dex names don't match coin prefixes). */
export class MarketRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketRegistryError";
  }
}

/** Thrown by {@link MarketRegistry.require} for unknown or delisted coins. */
export class UnknownMarketError extends Error {
  readonly coin: string;
  readonly reason: string;
  constructor(coin: string, reason: string, message: string) {
    super(message);
    this.name = "UnknownMarketError";
    this.coin = coin;
    this.reason = reason;
  }
}

/** Immutable lookup of markets by coin and asset id. */
export class MarketRegistry {
  private readonly live = new Map<string, MarketInfo>();
  private readonly delisted = new Map<string, MarketInfo>();
  private readonly byAssetId = new Map<number, MarketInfo>();
  private readonly spotByPairName = new Map<string, MarketInfo>();
  private readonly dexList: DexInfo[] = [];
  private readonly loadedDexes = new Set<string>();
  private readonly skipped: SkippedMarketEntry[] = [];

  private constructor() {}

  /**
   * Builds a registry from `/info` responses. Throws {@link MarketRegistryError} on structurally inconsistent
   * metadata (e.g. `perpDexs` and `allPerpMetas` of different lengths, which means they were fetched at different
   * times). Individual bad entries (coin names, margin data) are skipped and reported unless `strict: true`.
   */
  static fromInfo(input: MarketRegistryInput): MarketRegistry {
    const reg = new MarketRegistry();
    const strict = input.strict === true;
    // Per-coin merge: an override may change only some fields of a well-known entry.
    const display: Record<string, Partial<MarketDisplay>> = { ...WELL_KNOWN_MARKETS };
    for (const [coin, o] of Object.entries(input.displayOverrides ?? {})) display[coin] = { ...display[coin], ...o };
    const annotations = new Map<string, { category: string; displayName?: string }>();
    for (const [coin, ann] of input.annotations ?? []) annotations.set(coin, ann);

    const metas: Array<{ dexIndex: number; dexName: string; meta: PerpMetaLike; dex: PerpDexLike | undefined }> = [];
    if (input.allPerpMetas) {
      input.allPerpMetas.forEach((meta, dexIndex) => {
        const dex = input.perpDexs?.[dexIndex];
        metas.push({ dexIndex, dexName: dexIndex === 0 ? "" : resolveDexName(meta, dex, dexIndex, strict), meta, dex });
      });
      if (input.perpDexs && input.perpDexs.length !== input.allPerpMetas.length) {
        throw new MarketRegistryError(`perpDexs has ${input.perpDexs.length} entries but allPerpMetas has ${input.allPerpMetas.length}; fetch both at the same time`);
      }
    } else {
      if (input.meta) metas.push({ dexIndex: 0, dexName: "", meta: input.meta, dex: null });
      for (const [dexName, meta] of Object.entries(input.dexMetas ?? {})) {
        if (!input.perpDexs) throw new MarketRegistryError("dexMetas requires perpDexs to resolve dex indices");
        const dexIndex = input.perpDexs.findIndex((d) => d !== null && d.name === dexName);
        if (dexIndex < 1) throw new MarketRegistryError(`Dex "${dexName}" is not in perpDexs`);
        metas.push({ dexIndex, dexName, meta, dex: input.perpDexs[dexIndex] });
      }
    }

    for (const { dexIndex, dexName, meta, dex } of metas) {
      reg.loadedDexes.add(dexName);
      const oiCaps = new Map((dex?.assetToStreamingOiCap ?? []).map(([c, v]) => [c, Number(v)] as const));
      const fundingMult = new Map((dex?.assetToFundingMultiplier ?? []).map(([c, v]) => [c, Number(v)] as const));
      let live = 0;
      let delisted = 0;
      let skipped = 0;
      meta.universe.forEach((u, index) => {
        const parsed = parseCoin(u.name);
        // A *parseable* name that belongs to another dex (or kind) means the metadata is structurally inconsistent
        // (e.g. perpDexs and allPerpMetas fetched at different times): asset ids would be wrong, so always throw.
        if (parsed && dexIndex === 0 && parsed.kind !== "perp") throw new MarketRegistryError(`Unexpected first-dex coin name "${u.name}"`);
        if (parsed && dexIndex > 0 && !dexName.startsWith("#") && (parsed.kind !== "hip3" || parsed.dex !== dexName)) {
          throw new MarketRegistryError(`Coin "${u.name}" at dex index ${dexIndex} does not match dex "${dexName}"`);
        }
        // Unparseable names (e.g. "VOLMEX:$EVIV", "tndex:A B:C" on testnet) are skipped unless strict.
        let problem: { reason: SkippedMarketEntry["reason"]; message: string } | null = null;
        if (!parsed) {
          problem = { reason: "unparseable", message: `Coin name "${u.name}" at dex index ${dexIndex} is not a valid coin name` };
        } else if (dexName.startsWith("#")) {
          problem = { reason: "unresolved_dex_name", message: `Coin "${u.name}" is on dex ${dexIndex}, whose name could not be determined` };
        }
        if (problem) {
          if (strict) throw new MarketRegistryError(problem.message);
          reg.skipped.push({ dexIndex, index, name: u.name, ...problem });
          skipped++;
          return;
        }
        if (!parsed) return; // unreachable: narrowed above
        // One market's bad margin data (a tier or leverage ≤ 0, an empty table) makes only that market untradeable.
        const margin = resolveEntryMargin(u, meta.marginTables ?? []);
        if ("problem" in margin) {
          const message = `Coin "${u.name}" at dex index ${dexIndex} has invalid margin data: ${margin.problem}`;
          if (strict) throw new MarketRegistryError(message);
          reg.skipped.push({ dexIndex, index, name: u.name, reason: "invalid_margin", message });
          skipped++;
          return;
        }
        const { marginTableId, marginTiers } = margin;
        const marginMode: MarketMarginMode =
          u.marginMode === "strictIsolated" ? "strictIsolated" : u.marginMode === "noCross" ? "noCross" : u.onlyIsolated ? "strictIsolated" : "cross";
        const symbol = parsed.symbol;
        const disp = resolveDisplay(u.name, symbol, dexIndex === 0 ? "crypto" : "other", display, annotations);
        const info: MarketInfo = {
          coin: u.name,
          assetId: perpAssetIdForDex(dexIndex, index),
          kind: dexIndex === 0 ? "perp" : "hip3",
          dex: dexName,
          dexIndex,
          index,
          symbol,
          szDecimals: u.szDecimals,
          priceKind: "perp",
          maxLeverage: u.maxLeverage,
          marginTableId,
          marginTiers,
          marginMode,
          onlyIsolated: marginMode !== "cross",
          isDelisted: u.isDelisted === true,
          growthMode: u.growthMode === "enabled",
          ...disp,
          ...(meta.collateralToken !== undefined ? { collateralToken: meta.collateralToken } : {}),
          ...(oiCaps.has(u.name) ? { streamingOiCapUsd: oiCaps.get(u.name) as number } : {}),
          ...(fundingMult.has(u.name) ? { fundingMultiplier: fundingMult.get(u.name) as number } : {}),
        };
        reg.add(info);
        if (info.isDelisted) delisted++;
        else live++;
      });
      reg.dexList.push({
        index: dexIndex,
        name: dexName,
        fullName: dex?.fullName ?? (dexIndex === 0 ? "Hyperliquid" : dexName),
        ...(meta.collateralToken !== undefined ? { collateralToken: meta.collateralToken } : {}),
        liveMarkets: live,
        delistedMarkets: delisted,
        skippedMarkets: skipped,
      });
    }
    reg.dexList.sort((a, b) => a.index - b.index);

    if (input.spotMeta) {
      reg.loadedDexes.add("@spot");
      const tokens = new Map(input.spotMeta.tokens.map((t) => [t.index, t] as const));
      for (const pair of input.spotMeta.universe) {
        const base = tokens.get(pair.tokens[0] ?? -1);
        const quote = tokens.get(pair.tokens[1] ?? -1);
        if (!base || !quote) continue;
        const baseRemap = SPOT_TOKEN_DISPLAY_REMAP[base.name];
        const quoteRemap = SPOT_TOKEN_DISPLAY_REMAP[quote.name];
        const override = display[pair.name];
        const info: MarketInfo = {
          coin: pair.name,
          assetId: spotAssetId(pair.index),
          kind: "spot",
          dex: "",
          dexIndex: 0,
          index: pair.index,
          symbol: base.name,
          szDecimals: base.szDecimals,
          priceKind: "spot",
          maxLeverage: 1,
          marginTableId: null,
          marginTiers: [{ lowerBound: 0, maxLeverage: 1 }],
          marginMode: "cross",
          onlyIsolated: false,
          isDelisted: false,
          growthMode: false,
          displayName: override?.displayName ?? `${baseRemap?.displayName ?? base.name}/${quoteRemap?.displayName ?? quote.name}`,
          category: override?.category ?? "crypto",
          ...(override?.note !== undefined ? { note: override.note } : baseRemap ? { note: baseRemap.note } : {}),
          baseToken: base.name,
          quoteToken: quote.name,
        };
        reg.add(info);
        reg.spotByPairName.set(`${base.name}/${quote.name}`, info);
      }
    }
    return reg;
  }

  private add(info: MarketInfo): void {
    if (this.byAssetId.has(info.assetId)) throw new MarketRegistryError(`Duplicate asset id ${info.assetId} (${info.coin})`);
    this.byAssetId.set(info.assetId, info);
    (info.isDelisted ? this.delisted : this.live).set(info.coin, info);
  }

  /** A live market by wire coin name, or undefined. Pass `includeDelisted` to also return delisted markets. */
  get(coin: string, options: { includeDelisted?: boolean } = {}): MarketInfo | undefined {
    return this.live.get(coin) ?? (options.includeDelisted ? this.delisted.get(coin) : undefined);
  }

  /** Like {@link get} but throws {@link UnknownMarketError}. */
  require(coin: string, options: { includeDelisted?: boolean } = {}): MarketInfo {
    const v = this.validateCoin(coin);
    if (v.ok) return v.market;
    if (v.reason === "delisted" && options.includeDelisted && v.market) return v.market;
    throw new UnknownMarketError(coin, v.reason, v.message);
  }

  /** A market by asset id (live or delisted, since ids are positional). */
  getByAssetId(assetId: number): MarketInfo | undefined {
    return this.byAssetId.get(assetId);
  }

  /** Spot market by token pair name as shown to users, e.g. "HYPE/USDC" → the `@107` market. */
  getSpotByPair(pair: string): MarketInfo | undefined {
    return this.spotByPairName.get(pair);
  }

  /** True if the coin is a live market. */
  has(coin: string): boolean {
    return this.live.has(coin);
  }

  /**
   * Validates a coin before subscribing to it or ordering it. Only `ok: true` coins are safe to subscribe to:
   * a subscription to a non-existent coin makes HL drop the whole WebSocket connection without an error.
   * Delisted coins are reported as not ok (they still exist on HL, but Kokoah should not trade them).
   */
  validateCoin(coin: string): CoinValidation {
    const parsed = parseCoin(coin);
    if (!parsed) return { ok: false, reason: "malformed", message: `"${coin}" is not a valid coin name` };
    const live = this.live.get(coin);
    if (live) return { ok: true, market: live };
    const gone = this.delisted.get(coin);
    if (gone) return { ok: false, reason: "delisted", message: `${coin} is delisted`, market: gone };
    if (parsed.kind === "hip3") {
      const dexKnown = this.dexList.some((d) => d.name === parsed.dex);
      if (!dexKnown) {
        return this.loadedDexes.size > 0 && this.dexList.some((d) => d.index > 0)
          ? { ok: false, reason: "unknown_dex", message: `Unknown HIP-3 dex "${parsed.dex}"` }
          : { ok: false, reason: "dex_not_loaded", message: `HIP-3 dex "${parsed.dex}" metadata is not loaded` };
      }
    }
    if ((parsed.kind === "spotIndex" || parsed.kind === "spotPair") && !this.loadedDexes.has("@spot")) {
      return { ok: false, reason: "dex_not_loaded", message: "Spot metadata is not loaded" };
    }
    return { ok: false, reason: "unknown", message: `Unknown market "${coin}"` };
  }

  /** Throws unless {@link validateCoin} is ok. */
  assertValidCoin(coin: string): MarketInfo {
    return this.require(coin);
  }

  /** Live markets, optionally filtered. */
  list(filter: { kind?: MarketKind; dex?: string; category?: MarketCategory; includeDelisted?: boolean } = {}): MarketInfo[] {
    const all = [...this.live.values(), ...(filter.includeDelisted ? this.delisted.values() : [])];
    return all
      .filter((m) => (filter.kind === undefined || m.kind === filter.kind) && (filter.dex === undefined || m.dex === filter.dex) && (filter.category === undefined || m.category === filter.category))
      .sort((a, b) => a.assetId - b.assetId);
  }

  /** Perp dexes that were loaded (index 0 first). */
  dexes(): DexInfo[] {
    return [...this.dexList];
  }

  /** Universe entries skipped by {@link fromInfo} (non-strict mode). Log these; they are untradeable. */
  skippedEntries(): SkippedMarketEntry[] {
    return [...this.skipped];
  }

  /** Number of live markets. */
  get size(): number {
    return this.live.size;
  }
}

function resolveDexName(meta: PerpMetaLike, dex: PerpDexLike | undefined, dexIndex: number, strict: boolean): string {
  // perpDexs is authoritative for the name. The first parseable coin's prefix is only a cross-check / fallback.
  let prefix: string | undefined;
  for (const u of meta.universe) {
    const parsed = parseCoin(u.name);
    if (parsed?.kind === "hip3") {
      prefix = parsed.dex;
      break;
    }
  }
  if (dex && prefix !== undefined && dex.name !== prefix) {
    throw new MarketRegistryError(`perpDexs[${dexIndex}] is "${dex.name}" but its markets are prefixed "${prefix}:"`);
  }
  const name = dex?.name ?? prefix;
  if (name === undefined) {
    if (meta.universe.length === 0 || !strict) return `#${dexIndex}`;
    throw new MarketRegistryError(`Cannot determine the name of dex ${dexIndex}`);
  }
  return name;
}

/** A perp's margin table id and tiers, or why its margin data can't be used. */
function resolveEntryMargin(
  u: PerpUniverseEntry,
  marginTables: ReadonlyArray<readonly [number, RawMarginTable]>,
): { marginTableId: number; marginTiers: MarginTier[] } | { problem: string } {
  if (!(u.maxLeverage > 0)) return { problem: `maxLeverage must be positive, got ${u.maxLeverage}` };
  const marginTableId = u.marginTableId ?? u.maxLeverage;
  try {
    return { marginTableId, marginTiers: resolveMarginTiers(marginTableId, marginTables, u.maxLeverage) };
  } catch (e) {
    return { problem: e instanceof Error ? e.message : String(e) };
  }
}

function resolveDisplay(
  coin: string,
  symbol: string,
  fallbackCategory: MarketCategory,
  display: Record<string, Partial<MarketDisplay>>,
  annotations: Map<string, { category: string; displayName?: string }>,
): { displayName: string; category: MarketCategory; note?: string } {
  const o = display[coin];
  const ann = annotations.get(coin);
  const displayName = o?.displayName ?? ann?.displayName ?? symbol;
  const category = o?.category ?? normalizeCategory(ann?.category) ?? fallbackCategory;
  return o?.note !== undefined ? { displayName, category, note: o.note } : { displayName, category };
}
