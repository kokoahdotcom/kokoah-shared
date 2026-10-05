import { describe, expect, it } from "vitest";
import type { SpotMetaLike } from "../src/markets/index.js";
import {
  SPOT_ORDER_MAX_SHARE_OF_DAY_VOLUME,
  spotOrderCapUsd,
  spotOrderVolumeProblem,
  spotPairDisplayName,
  spotTokenTrust,
  STABLECOIN_PAIRS,
  USDC_TOKEN,
  VERIFIED_SPOT_PAIRS,
  verifiedSpotPairCoins,
  verifiedSpotPairs,
  verifiedStablecoinPairs,
} from "../src/policy/index.js";
import { fixture } from "./helpers.js";

type Meta = { universe: Array<{ name: string; index: number; tokens: number[]; isCanonical?: boolean }>; tokens: Array<{ name: string; index: number; tokenId: string; szDecimals: number }> };
// `spotMetaAndAssetCtxs` captured on 2026-09-25, trimmed to the pinned pairs, a few busy unverified pairs and a few
// dead ones.
const captured = (network: "mainnet" | "testnet") => structuredClone(fixture<[Meta, Array<{ coin: string; dayNtlVlm: string }>]>(`${network}-spotMetaAndAssetCtxs.json`));
const meta = (network: "mainnet" | "testnet") => captured(network)[0];

describe("verified spot pairs", () => {
  for (const network of ["mainnet", "testnet"] as const) {
    it(`are all confirmed by the captured ${network} spotMeta, against USDC, with unique pins`, () => {
      const pairs = verifiedSpotPairs(network, meta(network) as unknown as SpotMetaLike);
      expect(pairs.filter((p) => p.trust === "stablecoin").map((p) => p.coin)).toEqual(STABLECOIN_PAIRS[network].map((p) => p.coin));
      expect(pairs.filter((p) => p.trust === "verified").map((p) => p.coin)).toEqual(verifiedSpotPairCoins(network));
      const all = [...STABLECOIN_PAIRS[network], ...VERIFIED_SPOT_PAIRS[network]];
      expect(new Set(all.map((p) => p.coin)).size).toBe(all.length);
      expect(new Set(all.map((p) => p.base.tokenId)).size).toBe(all.length);
      for (const p of all) {
        expect(p.quote).toEqual(USDC_TOKEN[network]);
        expect(p.base.tokenId).toMatch(/^0x[0-9a-f]{32}$/);
        expect(p.coin === `@${p.index}` || (p.index === 0 && p.coin === "PURR/USDC")).toBe(true);
      }
    });
  }

  it("cover Hyperliquid's strict list: HYPE, BTC, ETH and SOL on mainnet, PURR and HYPE on testnet", () => {
    expect(verifiedSpotPairCoins("mainnet")).toEqual(expect.arrayContaining(["@107", "@142", "@151", "@156", "PURR/USDC"]));
    expect(verifiedSpotPairCoins("testnet")).toEqual(expect.arrayContaining(["PURR/USDC", "@1035"]));
    expect(VERIFIED_SPOT_PAIRS.mainnet).toHaveLength(50);
    expect(VERIFIED_SPOT_PAIRS.testnet).toHaveLength(6);
  });

  it("drop a pair whose token id, name, index, pair name or token order differs (fail closed)", () => {
    const check = (edit: (m: Meta) => void) => {
      const m = meta("mainnet");
      edit(m);
      return verifiedSpotPairs("mainnet", m as unknown as SpotMetaLike).map((p) => p.coin);
    };
    expect(check((m) => (m.tokens.find((t) => t.name === "HYPE")!.tokenId = "0x00000000000000000000000000000001"))).not.toContain("@107");
    expect(check((m) => (m.tokens.find((t) => t.name === "HYPE")!.name = "HYPE2"))).not.toContain("@107");
    expect(check((m) => (m.universe.find((u) => u.index === 107)!.name = "@108"))).not.toContain("@107");
    expect(check((m) => m.universe.find((u) => u.index === 107)!.tokens.reverse())).not.toContain("@107");
    expect(check((m) => (m.universe = m.universe.filter((u) => u.index !== 107)))).not.toContain("@107");
    // A look-alike token (same name, other id) listed with its own USDC pair is never verified.
    expect(check((m) => {
      m.tokens.push({ name: "HYPE", index: 9999, tokenId: "0x11111111111111111111111111111111", szDecimals: 2 });
      m.universe.push({ name: "@9998", index: 9998, tokens: [9999, 0] });
    })).not.toContain("@9998");
    expect(verifiedSpotPairs("mainnet", null)).toEqual([]);
    expect(verifiedSpotPairs("mainnet", { universe: "x", tokens: [] } as never)).toEqual([]);
    // The stablecoin check is unchanged by the refactor.
    expect(verifiedStablecoinPairs("mainnet", meta("mainnet") as unknown as SpotMetaLike).map((p) => p.coin)).toEqual(["@166", "@150"]);
  });

  it("rate tokens by token id: stablecoin, verified or unverified", () => {
    const m = meta("mainnet");
    const token = (name: string) => m.tokens.find((t) => t.name === name)!;
    expect(spotTokenTrust("mainnet", token("USDC"))).toBe("stablecoin");
    expect(spotTokenTrust("mainnet", token("USDT0"))).toBe("stablecoin");
    expect(spotTokenTrust("mainnet", token("HYPE"))).toBe("verified");
    expect(spotTokenTrust("mainnet", { ...token("HYPE"), tokenId: token("HYPE").tokenId.toUpperCase().replace("0X", "0x") })).toBe("verified");
    expect(spotTokenTrust("mainnet", { ...token("HYPE"), tokenId: "0x11111111111111111111111111111111" })).toBe("unverified");
    expect(spotTokenTrust("mainnet", { name: "HYPE", index: 150 })).toBe("unverified");
    // The busiest pairs outside the strict list stay unverified.
    const verifiedBases = new Set(verifiedSpotPairs("mainnet", m as unknown as SpotMetaLike).map((p) => p.base.index));
    const outside = m.universe.filter((u) => u.tokens[1] === 0 && !verifiedBases.has(u.tokens[0]!) && !STABLECOIN_PAIRS.mainnet.some((p) => p.index === u.index));
    expect(outside.length).toBeGreaterThan(0);
    for (const u of outside) expect(spotTokenTrust("mainnet", m.tokens.find((t) => t.index === u.tokens[0])!)).toBe("unverified");
    // Testnet pins never count on mainnet.
    expect(spotTokenTrust("mainnet", { name: "HYPE", index: 1105, tokenId: "0x7317beb7cceed72ef0b346074cc8e7ab" })).toBe("unverified");
  });
});

describe("spot pair display name", () => {
  it("reads a policy coin id as base/quote from the pinned lists, per network, no spotMeta needed", () => {
    expect(spotPairDisplayName("mainnet", "@107")).toBe("HYPE/USDC");
    expect(spotPairDisplayName("mainnet", "@166")).toBe("USDT0/USDC");
    expect(spotPairDisplayName("mainnet", "PURR/USDC")).toBe("PURR/USDC");
    expect(spotPairDisplayName("testnet", "@1115")).toBe("TZERO/USDC");
    // The same id can name different tokens per network, so the network decides.
    expect(spotPairDisplayName("testnet", "@166")).toBe("@166");
    // A coin id on neither list (never in a signer-accepted policy) is returned unchanged.
    expect(spotPairDisplayName("mainnet", "@99999")).toBe("@99999");
  });
});

describe("spot order volume cap", () => {
  it("caps a mainnet order at 10% of the pair's 24 h volume and has no cap on testnet", () => {
    expect(SPOT_ORDER_MAX_SHARE_OF_DAY_VOLUME).toEqual({ mainnet: 0.1, testnet: null });
    expect(spotOrderCapUsd("mainnet", 250_000)).toBe(25_000);
    expect(spotOrderCapUsd("mainnet", 0)).toBe(0);
    expect(spotOrderCapUsd("mainnet", undefined)).toBe(0);
    expect(spotOrderCapUsd("testnet", 0)).toBeUndefined();
    expect(spotOrderVolumeProblem({ network: "mainnet", label: "JEFF/USDC", notionalUsd: 200, dayVolumeUsd: 2386 })).toBe("");
    expect(spotOrderVolumeProblem({ network: "mainnet", label: "JEFF/USDC", notionalUsd: 300, dayVolumeUsd: 2386 })).toBe(
      "JEFF/USDC: one order can be at most 10% of what the pair traded in the last 24 hours ($238.6); this one is $300.",
    );
    expect(spotOrderVolumeProblem({ network: "mainnet", label: "SWAP/USDC", notionalUsd: 12, dayVolumeUsd: 0 })).toMatch(/has not traded in the last 24 hours/);
    expect(spotOrderVolumeProblem({ network: "testnet", label: "PURR/USDC", notionalUsd: 1_000_000, dayVolumeUsd: 0 })).toBe("");
  });
});

describe("policies listing every pinned pair", () => {
  it("accept all stablecoin and verified pairs of a network in allowedSpotCoins", async () => {
    const { createManualTradingPolicy } = await import("../src/policy/index.js");
    const coins = [...STABLECOIN_PAIRS.mainnet, ...VERIFIED_SPOT_PAIRS.mainnet].map((p) => p.coin);
    expect(coins.length).toBeGreaterThan(50);
    const p = createManualTradingPolicy({ builder: null, overrides: { allowedSpotCoins: coins, spotTrading: true } });
    expect(p.allowedSpotCoins).toHaveLength(coins.length);
  });
});
