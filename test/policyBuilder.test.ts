import { describe, expect, it } from "vitest";
import { createGuardianPolicy, policyBuilderOutdated, withCurrentBuilder, type Policy } from "../src/policy/index.js";

// Hex letters, so case matters: B as policies store it (lowercase), MIXED as a config may name it.
const B = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const;
const MIXED = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD" as const;
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
    expect(policyBuilderOutdated(policy(45), { address: MIXED, feeTenthsBps: 45 })).toBe(false);
    expect(policyBuilderOutdated(policy(45, OTHER), now)).toBe(true);
    // No builder requirement: the signers attach the current fee anyway.
    expect(policyBuilderOutdated({ requiredBuilder: null }, now)).toBe(false);
    // A current fee that is no fee is refused, never read as "every policy is current".
    expect(() => policyBuilderOutdated(policy(25), { address: B, feeTenthsBps: Number.NaN })).toThrow(RangeError);
  });

  // A higher fee than the policy's cap is refused by the policy check itself (policy.test.ts, "compiled and wire actions",
  // which also ties this helper to it).
  it("signs again with the current builder and fee, checked like any policy, changing nothing else", () => {
    const old = policy(25);
    const next = withCurrentBuilder(old, { address: MIXED, feeTenthsBps: 45 });
    expect(next.requiredBuilder).toEqual({ b: B, f: 45 });
    expect({ ...next, requiredBuilder: old.requiredBuilder }).toEqual(old);
    expect(policyBuilderOutdated(next, { address: B, feeTenthsBps: 45 })).toBe(false);
    const open = { ...old, requiredBuilder: null };
    expect(withCurrentBuilder(open, { address: B, feeTenthsBps: 45 })).toBe(open);
    // A builder that can't be a policy's is refused here, not later when the policy is signed.
    expect(() => withCurrentBuilder(old, { address: "nope", feeTenthsBps: 45 })).toThrow();
    expect(() => withCurrentBuilder(old, { address: B, feeTenthsBps: 2000 })).toThrow();
    expect(() => withCurrentBuilder(old, { address: B, feeTenthsBps: 4.5 })).toThrow(RangeError);
  });
});
