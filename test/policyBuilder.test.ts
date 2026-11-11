import { describe, expect, it } from "vitest";
import { createGuardianPolicy, policyBuilderOutdated, withCurrentBuilder, type Policy } from "../src/policy/index.js";

const B = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const policy = (f: number, b: `0x${string}` = B): Policy =>
  createGuardianPolicy({ builder: { b, f }, allowedCoins: ["BTC"], maxOrderNotionalUsd: 5_000, maxDailyNotionalUsd: 20_000 });

describe("a signed policy's builder against Kokoah's current one", () => {
  it("is outdated when signed for a lower fee or another builder, never for the same or a higher fee", () => {
    const now = { address: B, feeTenthsBps: 45 };
    expect(policyBuilderOutdated(policy(25), now)).toBe(true);
    expect(policyBuilderOutdated(policy(0), now)).toBe(true);
    expect(policyBuilderOutdated(policy(45), now)).toBe(false);
    expect(policyBuilderOutdated(policy(50), now)).toBe(false);
    // Addresses compare whatever their case.
    expect(policyBuilderOutdated(policy(45), { address: B.toUpperCase().replace("0X", "0x"), feeTenthsBps: 45 })).toBe(false);
    expect(policyBuilderOutdated(policy(45, OTHER), now)).toBe(true);
    // No builder requirement: the signers attach the current fee anyway.
    expect(policyBuilderOutdated({ requiredBuilder: null }, now)).toBe(false);
  });

  // A higher fee than the policy's cap is refused by the policy check itself (policy.test.ts, "compiled and wire actions").
  it("signs again with the current builder and fee, changing nothing else", () => {
    const old = policy(25);
    const next = withCurrentBuilder(old, { address: B.toUpperCase().replace("0X", "0x"), feeTenthsBps: 45 });
    expect(next.requiredBuilder).toEqual({ b: B, f: 45 });
    expect({ ...next, requiredBuilder: old.requiredBuilder }).toEqual(old);
    expect(policyBuilderOutdated(next, { address: B, feeTenthsBps: 45 })).toBe(false);
    const open = { ...old, requiredBuilder: null };
    expect(withCurrentBuilder(open, { address: B, feeTenthsBps: 45 })).toBe(open);
  });
});
