import { describe, expect, it } from "vitest";
import {
  decodeAssetId,
  formatHip3Coin,
  hip3AssetId,
  isHip3Coin,
  MarketRegistry,
  MarketRegistryError,
  normalizeCategory,
  outcomeAssetId,
  parseCoin,
  perpAssetId,
  perpAssetIdForDex,
  spotAssetId,
  UnknownMarketError,
  type PerpMetaLike,
  type PerpDexLike,
} from "../src/markets/index.js";
import { fixture, mainnetRegistry } from "./helpers.js";

describe("asset ids (HL asset-ids docs)", () => {
  it("computes perp, spot, HIP-3 and outcome ids", () => {
    expect(perpAssetId(0)).toBe(0);
    expect(spotAssetId(0)).toBe(10000); // PURR/USDC
    expect(spotAssetId(107)).toBe(10107); // HYPE/USDC on mainnet
    expect(hip3AssetId(1, 0)).toBe(110000); // test:ABC example / xyz index 0
    expect(hip3AssetId(1, 52)).toBe(110052);
    expect(hip3AssetId(10, 9999)).toBe(209999);
    expect(perpAssetIdForDex(0, 5)).toBe(5);
    expect(perpAssetIdForDex(2, 5)).toBe(120005);
    expect(outcomeAssetId(1, 0)).toBe(100000010);
  });

  it("rejects out-of-range inputs", () => {
    expect(() => perpAssetId(-1)).toThrow(RangeError);
    expect(() => perpAssetId(10000)).toThrow(RangeError);
    expect(() => hip3AssetId(0, 1)).toThrow(RangeError);
    expect(() => hip3AssetId(1, 10000)).toThrow(RangeError);
    expect(() => spotAssetId(1.5)).toThrow(RangeError);
    // @ts-expect-error side must be 0 or 1
    expect(() => outcomeAssetId(1, 2)).toThrow(RangeError);
  });

  it("decodes ids back", () => {
    expect(decodeAssetId(0)).toEqual({ kind: "perp", dexIndex: 0, indexInMeta: 0 });
    expect(decodeAssetId(10107)).toEqual({ kind: "spot", spotIndex: 107 });
    expect(decodeAssetId(110052)).toEqual({ kind: "hip3", dexIndex: 1, indexInMeta: 52 });
    expect(decodeAssetId(100000010)).toEqual({ kind: "outcome", outcome: 1, side: 0 });
    expect(() => decodeAssetId(100005)).toThrow(RangeError);
    for (let d = 1; d < 20; d++) for (const i of [0, 1, 999, 9999]) expect(decodeAssetId(hip3AssetId(d, i))).toEqual({ kind: "hip3", dexIndex: d, indexInMeta: i });
  });
});

describe("coin names", () => {
  it.each([
    ["xyz:SP500", { dex: "xyz", symbol: "SP500", kind: "hip3" }],
    ["BTC", { dex: "", symbol: "BTC", kind: "perp" }],
    ["kPEPE", { dex: "", symbol: "kPEPE", kind: "perp" }],
    ["@107", { dex: "", symbol: "@107", kind: "spotIndex" }],
    ["PURR/USDC", { dex: "", symbol: "PURR/USDC", kind: "spotPair" }],
    ["#10", { dex: "", symbol: "#10", kind: "outcome" }],
  ] as const)("parseCoin(%s)", (coin, parsed) => {
    expect(parseCoin(coin)).toEqual(parsed);
  });
  it.each(["", " BTC", "BTC ", "a:b:c", ":SP500", "xyz:", "@abc", "xyz:@1", "BTC/", "x y"])("rejects %j", (coin) => {
    expect(parseCoin(coin)).toBeNull();
  });
  it("formats and detects HIP-3 names", () => {
    expect(formatHip3Coin("xyz", "SP500")).toBe("xyz:SP500");
    expect(() => formatHip3Coin("", "SP500")).toThrow();
    expect(() => formatHip3Coin("xyz", "a:b")).toThrow();
    expect(isHip3Coin("xyz:GOLD")).toBe(true);
    expect(isHip3Coin("BTC")).toBe(false);
  });
});

describe("MarketRegistry from real mainnet fixtures", () => {
  const reg = mainnetRegistry();

  it("resolves validator-perp markets with margin tiers", () => {
    const btc = reg.require("BTC");
    expect(btc).toMatchObject({ assetId: 0, kind: "perp", dex: "", szDecimals: 5, maxLeverage: 40, marginTableId: 56, onlyIsolated: false, category: "crypto" });
    expect(btc.marginTiers).toEqual([
      { lowerBound: 0, maxLeverage: 40 },
      { lowerBound: 150_000_000, maxLeverage: 20 },
    ]);
    expect(reg.require("ETH").assetId).toBe(1);
  });

  it("skips delisted markets but keeps positional asset ids", () => {
    // MATIC (index 3) is delisted; DYDX (index 4) must still be asset 4.
    expect(reg.get("MATIC")).toBeUndefined();
    expect(reg.get("MATIC", { includeDelisted: true })?.isDelisted).toBe(true);
    expect(reg.getByAssetId(3)?.coin).toBe("MATIC");
    expect(reg.require("DYDX").assetId).toBe(4);
    expect(reg.require("SOL").assetId).toBe(5);
    expect(reg.list({ kind: "perp" }).some((m) => m.coin === "MATIC")).toBe(false);
    expect(reg.list({ kind: "perp", includeDelisted: true }).some((m) => m.coin === "MATIC")).toBe(true);
  });

  it("resolves HIP-3 markets: asset ids, isolated-only modes, display names and categories", () => {
    const sp = reg.require("xyz:SP500");
    expect(sp).toMatchObject({ assetId: 110052, kind: "hip3", dex: "xyz", dexIndex: 1, index: 52, symbol: "SP500", szDecimals: 3, maxLeverage: 50 });
    expect(sp.displayName).toBe("S&P 500");
    expect(sp.category).toBe("indices");
    expect(sp.growthMode).toBe(true);
    expect(sp.fundingMultiplier).toBe(0.5);
    expect(sp.streamingOiCapUsd).toBeGreaterThan(0);
    expect(reg.require("xyz:XYZ100").assetId).toBe(110000);
    const eur = reg.require("xyz:EUR");
    expect(eur.marginMode).toBe("noCross");
    expect(eur.onlyIsolated).toBe(true);
    expect(eur.displayName).toBe("EUR/USD");
    expect(eur.category).toBe("fx");
    expect(reg.require("xyz:CL").displayName).toBe("WTI Crude Oil");
    expect(reg.require("xyz:GOLD").category).toBe("commodities");
    // Not in the well-known table: falls back to HL annotations.
    expect(reg.require("xyz:AMAT")).toMatchObject({ displayName: "AMAT", category: "stocks" });
    expect(reg.require("para:TOTAL2").category).toBe("crypto");
  });

  it("exposes strict-isolated validator perps (deprecated onlyIsolated flag)", () => {
    const hpos = reg.get("HPOS", { includeDelisted: true });
    expect(hpos?.marginMode).toBe("strictIsolated");
    expect(hpos?.onlyIsolated).toBe(true);
  });

  it("summarizes dexes", () => {
    const dexes = reg.dexes();
    expect(dexes[0]).toMatchObject({ index: 0, name: "", liveMarkets: 178 });
    expect(dexes.find((d) => d.name === "xyz")).toMatchObject({ index: 1, fullName: "XYZ", liveMarkets: 108 });
    expect(dexes.find((d) => d.name === "flx")).toMatchObject({ liveMarkets: 0, delistedMarkets: 16 });
    expect(reg.list({ dex: "xyz" })).toHaveLength(108);
  });

  it("names spot pairs from tokens and remaps bridged assets", () => {
    const hype = reg.require("@107");
    expect(hype).toMatchObject({ assetId: 10107, kind: "spot", priceKind: "spot", displayName: "HYPE/USDC", baseToken: "HYPE", quoteToken: "USDC" });
    const ubtc = reg.require("@142");
    expect(ubtc.displayName).toBe("BTC/USDC");
    expect(ubtc.note).toContain("UBTC");
    expect(reg.require("PURR/USDC").assetId).toBe(10000);
    expect(reg.getSpotByPair("HYPE/USDC")?.coin).toBe("@107");
  });

  it("validates coins before subscribing (invalid coins kill the WS connection)", () => {
    expect(reg.validateCoin("BTC").ok).toBe(true);
    expect(reg.validateCoin("xyz:SP500").ok).toBe(true);
    expect(reg.validateCoin("@107").ok).toBe(true);
    const cases: Array<[string, string]> = [
      ["NOTACOIN", "unknown"],
      ["xyz:NOTACOIN", "unknown"],
      ["zzz:BTC", "unknown_dex"],
      ["MATIC", "delisted"],
      ["flx:TSLA", "delisted"],
      ["BTC ", "malformed"],
      ["a:b:c", "malformed"],
      ["@99999", "unknown"],
    ];
    for (const [coin, reason] of cases) {
      const r = reg.validateCoin(coin);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe(reason);
    }
    expect(() => reg.require("NOTACOIN")).toThrow(UnknownMarketError);
    expect(() => reg.assertValidCoin("MATIC")).toThrow(UnknownMarketError);
    expect(reg.require("MATIC", { includeDelisted: true }).coin).toBe("MATIC");
  });

  it("applies display overrides over the well-known table", () => {
    const r = MarketRegistry.fromInfo({
      allPerpMetas: fixture("mainnet-allPerpMetas.json"),
      perpDexs: fixture("mainnet-perpDexs.json"),
      displayOverrides: { "xyz:SP500": { displayName: "US 500", note: "index perp" }, BTC: { displayName: "Bitcoin" } },
    });
    expect(r.require("xyz:SP500")).toMatchObject({ displayName: "US 500", category: "indices", note: "index perp" });
    expect(r.require("BTC").displayName).toBe("Bitcoin");
    // Without annotations, an unknown HIP-3 coin falls back to its symbol and "other".
    expect(r.require("xyz:AMAT")).toMatchObject({ displayName: "AMAT", category: "other" });
  });
});

describe("MarketRegistry safety checks", () => {
  const all = fixture<PerpMetaLike[]>("mainnet-allPerpMetas.json");
  const dexes = fixture<PerpDexLike[]>("mainnet-perpDexs.json");

  it("refuses perpDexs that don't line up with allPerpMetas (wrong asset ids otherwise)", () => {
    const swapped = [...dexes];
    [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
    expect(() => MarketRegistry.fromInfo({ allPerpMetas: all, perpDexs: swapped })).toThrow(MarketRegistryError);
    expect(() => MarketRegistry.fromInfo({ allPerpMetas: all, perpDexs: dexes.slice(0, 5) })).toThrow(MarketRegistryError);
  });

  it("works from allPerpMetas alone (dex names from coin prefixes)", () => {
    const r = MarketRegistry.fromInfo({ allPerpMetas: all });
    expect(r.require("xyz:SP500").assetId).toBe(110052);
  });

  it("supports per-dex meta responses with perpDexs", () => {
    const r = MarketRegistry.fromInfo({ meta: all[0], dexMetas: { xyz: all[1]! }, perpDexs: dexes });
    expect(r.require("xyz:GOLD").assetId).toBe(110003);
    expect(r.validateCoin("para:TOTAL2")).toMatchObject({ ok: false, reason: "unknown_dex" });
    expect(() => MarketRegistry.fromInfo({ meta: all[0], dexMetas: { xyz: all[1]! } })).toThrow(MarketRegistryError);
    expect(() => MarketRegistry.fromInfo({ meta: all[0], dexMetas: { nope: all[1]! }, perpDexs: dexes })).toThrow(MarketRegistryError);
  });

  it("reports HIP-3 and spot coins as not loaded when only the first dex is known", () => {
    const testnet = MarketRegistry.fromInfo({ meta: fixture("testnet-meta.json") });
    expect(testnet.validateCoin("xyz:SP500")).toMatchObject({ ok: false, reason: "dex_not_loaded" });
    expect(testnet.validateCoin("@1")).toMatchObject({ ok: false, reason: "dex_not_loaded" });
    expect(testnet.validateCoin("SOL").ok).toBe(true);
    expect(testnet.require("SOL").assetId).toBe(0); // testnet ids differ from mainnet
    expect(testnet.size).toBeGreaterThan(0);
  });

  it("builds from the testnet perpDexs fixture", () => {
    const td = fixture<PerpDexLike[]>("testnet-perpDexs.json");
    expect(td[0]).toBeNull();
    expect(td.length).toBeGreaterThan(100);
  });
});

describe("normalizeCategory", () => {
  it.each([
    ["stocks", "stocks"],
    ["stock", "stocks"],
    ["FX", "fx"],
    ["indices", "indices"],
    ["commodities", "commodities"],
    ["preipo", "preipo"],
    ["rates", "rates"],
    ["crypto", "crypto"],
    ["whatever", "other"],
  ] as const)("%s → %s", (raw, out) => {
    expect(normalizeCategory(raw)).toBe(out);
  });
  it("returns undefined for empty input", () => {
    expect(normalizeCategory(undefined)).toBeUndefined();
    expect(normalizeCategory("")).toBeUndefined();
  });
});
