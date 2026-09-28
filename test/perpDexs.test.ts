import { describe, expect, it } from "vitest";
import { perpDexProblem, VERIFIED_PERP_DEXS } from "../src/policy/index.js";

describe("verified HIP-3 dexes", () => {
  const xyz = VERIFIED_PERP_DEXS.mainnet.find((d) => d.name === "xyz")!;

  it("lets mainnet signers trade a pinned dex while its deployer is unchanged", () => {
    expect(perpDexProblem("mainnet", "xyz", { name: "xyz", deployer: xyz.deployer.toUpperCase().replace("0X", "0x") })).toBeUndefined();
  });

  it("refuses an unpinned dex, a pinned dex with another deployer, and a dex HL doesn't list", () => {
    expect(perpDexProblem("mainnet", "evil", { name: "evil", deployer: "0x1111111111111111111111111111111111111111" })).toMatch(/not verified/);
    expect(perpDexProblem("mainnet", "xyz", { name: "xyz", deployer: "0x1111111111111111111111111111111111111111" })).toMatch(/new deployer/);
    expect(perpDexProblem("mainnet", "xyz", undefined)).toMatch(/Unknown HIP-3 dex/);
  });

  it("accepts any listed dex on testnet (test money)", () => {
    expect(perpDexProblem("testnet", "tndex", { name: "tndex", deployer: "0x1111111111111111111111111111111111111111" })).toBeUndefined();
    expect(perpDexProblem("testnet", "tndex", undefined)).toMatch(/Unknown HIP-3 dex/);
  });

  it("pins lowercase addresses and unique names", () => {
    const names = VERIFIED_PERP_DEXS.mainnet.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const d of VERIFIED_PERP_DEXS.mainnet) expect(d.deployer).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
