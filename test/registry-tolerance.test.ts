import { describe, expect, it } from "vitest";
import { MarketRegistry, MarketRegistryError, perpAssetIdForDex } from "../src/markets/index.js";
import type { PerpDexLike, PerpMetaLike } from "../src/markets/index.js";
import { fixture } from "./helpers.js";

// Minimal universe entries: only the fields fromInfo reads.
const entry = (name: string, extra: Record<string, unknown> = {}) => ({ name, szDecimals: 2, maxLeverage: 10, ...extra });
const meta = (names: string[]) => ({ universe: names.map((n) => entry(n)), marginTables: [] }) as unknown as PerpMetaLike;
const dex = (name: string) => ({ name, fullName: name, deployer: "0x0000000000000000000000000000000000000001" }) as unknown as PerpDexLike;

describe("MarketRegistry.fromInfo with unparseable coin names", () => {
  const allPerpMetas = [meta(["BTC", "ETH"]), meta(["VOLMEX:$EVIV", "VOLMEX:GOOD"]), meta(["tndex:A B:C", "tndex:OK", "tndex:A B:C/../中"])];
  const perpDexs = [null, dex("VOLMEX"), dex("tndex")] as unknown as PerpDexLike[];

  it("skips them, keeps every other market's positional asset id, and reports them", () => {
    const r = MarketRegistry.fromInfo({ allPerpMetas, perpDexs });
    expect(r.require("VOLMEX:GOOD").assetId).toBe(perpAssetIdForDex(1, 1));
    expect(r.require("tndex:OK").assetId).toBe(perpAssetIdForDex(2, 1));
    expect(r.require("ETH").assetId).toBe(1);
    // Skipped entries reserve their ids: nothing maps there.
    expect(r.getByAssetId(perpAssetIdForDex(1, 0))).toBeUndefined();
    expect(r.getByAssetId(perpAssetIdForDex(2, 2))).toBeUndefined();
    expect(r.skippedEntries().map((s) => [s.dexIndex, s.index, s.name, s.reason])).toEqual([
      [1, 0, "VOLMEX:$EVIV", "unparseable"],
      [2, 0, "tndex:A B:C", "unparseable"],
      [2, 2, "tndex:A B:C/../中", "unparseable"],
    ]);
    expect(r.dexes().find((d) => d.name === "tndex")).toMatchObject({ liveMarkets: 1, skippedMarkets: 2 });
    // Unparseable names are never valid subscription targets.
    expect(r.validateCoin("VOLMEX:$EVIV")).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("throws in strict mode (0.1.0 behaviour)", () => {
    expect(() => MarketRegistry.fromInfo({ allPerpMetas, perpDexs, strict: true })).toThrow(MarketRegistryError);
  });

  it("still throws on structural mismatches that would produce wrong asset ids", () => {
    const swapped = [null, dex("tndex"), dex("VOLMEX")] as unknown as PerpDexLike[];
    expect(() => MarketRegistry.fromInfo({ allPerpMetas, perpDexs: swapped })).toThrow(MarketRegistryError);
    // A parseable coin on the wrong dex is structural, not a naming quirk.
    expect(() => MarketRegistry.fromInfo({ allPerpMetas: [meta(["BTC"]), meta(["VOLMEX:GOOD", "other:X"])], perpDexs: [null, dex("VOLMEX")] as unknown as PerpDexLike[] })).toThrow(MarketRegistryError);
  });

  it("builds from a live testnet snapshot (2026-09-22) that contains such names", () => {
    const all = fixture<PerpMetaLike[]>("testnet-allPerpMetas.json");
    const dexes = fixture<PerpDexLike[]>("testnet-perpDexs.json");
    const r = MarketRegistry.fromInfo({ allPerpMetas: all, perpDexs: dexes });
    expect(r.size).toBeGreaterThan(100);
    expect(r.require("BTC").kind).toBe("perp");
    const skippedNames = r.skippedEntries().map((s) => s.name);
    expect(skippedNames).toContain("VOLMEX:$EVIV");
    expect(skippedNames).toContain("tndex:A B:C");
    // Every skipped name fails validation; every live market validates.
    for (const s of r.skippedEntries()) expect(r.validateCoin(s.name).ok).toBe(false);
    for (const m of r.list()) expect(r.validateCoin(m.coin).ok).toBe(true);
  });
});

describe("MarketRegistry.fromInfo with invalid margin data", () => {
  const tiers = (...levs: number[]) => ({ description: "t", marginTiers: levs.map((maxLeverage, i) => ({ lowerBound: String(i * 1000), maxLeverage })) });
  const allPerpMetas = [
    { universe: [entry("BTC"), entry("ETH", { maxLeverage: 0 })], marginTables: [] },
    {
      universe: [entry("xyz:GOOD", { marginTableId: 60 }), entry("xyz:ZERO", { marginTableId: 61 }), entry("xyz:EMPTY", { marginTableId: 62 }), entry("xyz:NEG", { maxLeverage: -5 }), entry("xyz:OK")],
      marginTables: [[60, tiers(20, 10)], [61, tiers(10, 0)], [62, tiers()]],
    },
  ] as unknown as PerpMetaLike[];
  const perpDexs = [null, dex("xyz")] as unknown as PerpDexLike[];

  it("skips only the bad markets and keeps every other market's positional asset id", () => {
    const r = MarketRegistry.fromInfo({ allPerpMetas, perpDexs });
    expect(r.require("BTC").assetId).toBe(0);
    expect(r.require("xyz:GOOD")).toMatchObject({ assetId: perpAssetIdForDex(1, 0), marginTiers: [{ lowerBound: 0, maxLeverage: 20 }, { lowerBound: 1000, maxLeverage: 10 }] });
    expect(r.require("xyz:OK").assetId).toBe(perpAssetIdForDex(1, 4));
    expect(r.skippedEntries().map((s) => [s.dexIndex, s.index, s.name, s.reason])).toEqual([
      [0, 1, "ETH", "invalid_margin"],
      [1, 1, "xyz:ZERO", "invalid_margin"],
      [1, 2, "xyz:EMPTY", "invalid_margin"],
      [1, 3, "xyz:NEG", "invalid_margin"],
    ]);
    expect(r.skippedEntries()[1]?.message).toMatch(/^Coin "xyz:ZERO" at dex index 1 has invalid margin data: Invalid margin tier/);
    for (const s of r.skippedEntries()) {
      expect(r.getByAssetId(perpAssetIdForDex(s.dexIndex, s.index))).toBeUndefined();
      expect(r.validateCoin(s.name).ok).toBe(false);
    }
    expect(r.dexes().map((d) => [d.name, d.liveMarkets, d.skippedMarkets])).toEqual([["", 1, 1], ["xyz", 2, 3]]);
  });

  it("throws in strict mode", () => {
    expect(() => MarketRegistry.fromInfo({ allPerpMetas, perpDexs, strict: true })).toThrow(MarketRegistryError);
    expect(() => MarketRegistry.fromInfo({ allPerpMetas: [allPerpMetas[0]!], strict: true })).toThrow(/"ETH" at dex index 0 has invalid margin data: maxLeverage must be positive/);
  });
});
