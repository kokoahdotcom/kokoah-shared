import { describe, expect, it } from "vitest";
import { CompileError, compileAccountAction, feeTrialRate, isAccountIntentKind, safeParseAccountIntent } from "../src/actions/index.js";
import { createGuardianPolicy, createManualTradingPolicy, evaluatePolicy, hashPolicy, parsePolicy, type Policy, type PolicyContext, summarizePolicy } from "../src/policy/index.js";
import { mainnetRegistry } from "./helpers.js";

const NOW = 1_790_000_000_000;
const BUILDER = { b: "0x1111111111111111111111111111111111111111" as const, f: 25 };
const CODE = "KOKOAH";
// userFees.feeSchedule.tiers.vip (mainnet, 2026-09-25).
const VIP = [
  { ntlCutoff: "5000000.0", cross: "0.0004", add: "0.00012" },
  { ntlCutoff: "25000000.0", cross: "0.00035", add: "0.00008" },
  { ntlCutoff: "100000000.0", cross: "0.0003", add: "0.00004" },
  { ntlCutoff: "500000000.0", cross: "0.00028", add: "0.0" },
];
const TRIAL = { type: "startFeeTrial", addBaseRate: "0.00012", crossBaseRate: "0.0004" };

const manual = (over: Partial<Policy> = {}) => createManualTradingPolicy({ builder: BUILDER, overrides: { allowedActionTypes: [...createManualTradingPolicy({ builder: BUILDER }).allowedActionTypes, "startFeeTrial"], ...over } });
const ctx = (policy: Policy, over: Partial<PolicyContext> = {}): PolicyContext => ({
  policy,
  now: NOW,
  markPrices: {},
  dailyNotionalUsedUsd: 0,
  ordersInLastMinute: 0,
  registry: mainnetRegistry(),
  ...over,
});
const wire = (action: Record<string, unknown> & { type: string }, extra: { vaultAddress?: string; expiresAfter?: number } = {}) =>
  ({ kind: "wire", action, origin: "manual", expiresAfter: NOW + 15_000, ...extra }) as const;
const codes = (d: ReturnType<typeof evaluatePolicy>) => d.violations.map((v) => v.code);

describe("account action intents", () => {
  it("accept only the bare kinds, manual origin, no extra keys", () => {
    expect(safeParseAccountIntent({ kind: "setReferrer", origin: "manual" }).success).toBe(true);
    expect(safeParseAccountIntent({ kind: "startFeeTrial", origin: "manual", tier: 1 }).success).toBe(true);
    // The tier is required and is a number: rates never come from the caller.
    expect(safeParseAccountIntent({ kind: "startFeeTrial", origin: "manual" }).success).toBe(false);
    expect(safeParseAccountIntent({ kind: "startFeeTrial", origin: "manual", tier: 0 }).success).toBe(false);
    expect(safeParseAccountIntent({ kind: "startFeeTrial", origin: "manual", tier: 1.5 }).success).toBe(false);
    expect(safeParseAccountIntent({ kind: "startFeeTrial", origin: "manual", tier: 1, crossBaseRate: "0" }).success).toBe(false);
    // The code never comes from the caller, and there is no sub-account form.
    expect(safeParseAccountIntent({ kind: "setReferrer", origin: "manual", code: "EVIL" }).success).toBe(false);
    expect(safeParseAccountIntent({ kind: "startFeeTrial", origin: "manual", tier: 1, vaultAddress: "0x2222222222222222222222222222222222222222" }).success).toBe(false);
    expect(safeParseAccountIntent({ kind: "setReferrer", origin: "guardian" }).success).toBe(false);
    expect(safeParseAccountIntent({ kind: "setReferrer", origin: "ai_ticket" }).success).toBe(false);
    expect(isAccountIntentKind({ kind: "startFeeTrial" })).toBe(true);
    expect(isAccountIntentKind({ kind: "order" })).toBe(false);
    expect(isAccountIntentKind(null)).toBe(false);
  });

  it("compile setReferrer with the configured code only", () => {
    expect(compileAccountAction({ kind: "setReferrer", origin: "manual" }, { referralCode: CODE }).action).toEqual({ type: "setReferrer", code: CODE });
    expect(Object.keys(compileAccountAction({ kind: "setReferrer", origin: "manual" }, { referralCode: CODE }).action)).toEqual(["type", "code"]);
    expect(() => compileAccountAction({ kind: "setReferrer", origin: "manual" }, {})).toThrow(CompileError);
    expect(() => compileAccountAction({ kind: "setReferrer", origin: "manual" }, { referralCode: null })).toThrow(/No Kokoah referral code/);
    expect(() => compileAccountAction({ kind: "setReferrer", origin: "manual" }, { referralCode: "has space" })).toThrow(CompileError);
    expect(() => compileAccountAction({ kind: "setReferrer", origin: "manual", code: CODE } as never, { referralCode: CODE })).toThrow(CompileError);
  });

  it("compile startFeeTrial from the signer's own fee schedule, rates formatted as Hyperliquid's app does", () => {
    const one = compileAccountAction({ kind: "startFeeTrial", origin: "manual", tier: 1 }, { feeTiers: VIP }).action;
    expect(one).toEqual(TRIAL);
    expect(Object.keys(one)).toEqual(["type", "addBaseRate", "crossBaseRate"]);
    expect(compileAccountAction({ kind: "startFeeTrial", origin: "manual", tier: 4 }, { feeTiers: VIP }).action).toEqual({ type: "startFeeTrial", addBaseRate: "0.0", crossBaseRate: "0.00028" });
    expect(() => compileAccountAction({ kind: "startFeeTrial", origin: "manual", tier: 5 }, { feeTiers: VIP })).toThrow(/not in Hyperliquid's fee schedule/);
    expect(() => compileAccountAction({ kind: "startFeeTrial", origin: "manual", tier: 1 })).toThrow(CompileError);
    expect(() => compileAccountAction({ kind: "startFeeTrial", origin: "manual", tier: 1 }, { feeTiers: [{ cross: "abc", add: "0" }] })).toThrow(/malformed/);
  });

  it("format fee trial rates like Hyperliquid's app (toFixed(8), trimmed, at least one decimal)", () => {
    expect(feeTrialRate("0.0004")).toBe("0.0004");
    expect(feeTrialRate(0.00012)).toBe("0.00012");
    expect(feeTrialRate("0")).toBe("0.0");
    expect(feeTrialRate("0.0")).toBe("0.0");
    expect(feeTrialRate(-0.00001)).toBe("-0.00001");
    expect(feeTrialRate("0.000000001")).toBe("0.0");
    expect(() => feeTrialRate("1")).toThrow();
    expect(() => feeTrialRate("1e-4")).toThrow();
  });
});

describe("setReferrer policy", () => {
  const withCode = manual({ referralCode: CODE });

  it("stays hard-denied without a configured code", () => {
    const d = evaluatePolicy(wire({ type: "setReferrer", code: CODE }), ctx(manual()));
    expect(codes(d)).toEqual(["REFERRER_ACTION_DENIED"]);
  });

  it("allows exactly the configured code for the main account", () => {
    expect(evaluatePolicy(wire({ type: "setReferrer", code: CODE }), ctx(withCode))).toEqual({ allowed: true, violations: [], actionType: "setReferrer" });
  });

  it("denies any other code, case variants included", () => {
    for (const code of ["OTHER", "kokoah", "KOKOAH ", "KOKOAH1"]) {
      const d = evaluatePolicy(wire({ type: "setReferrer", code }), ctx(withCode));
      expect(d.allowed).toBe(false);
    }
    expect(codes(evaluatePolicy(wire({ type: "setReferrer", code: "OTHER" }), ctx(withCode)))).toEqual(["REFERRER_ACTION_DENIED"]);
  });

  it("denies extra keys, a missing code and sub-accounts", () => {
    expect(codes(evaluatePolicy(wire({ type: "setReferrer", code: CODE, extra: 1 }), ctx(withCode)))).toEqual(["INVALID_SUBJECT"]);
    expect(codes(evaluatePolicy(wire({ type: "setReferrer" }), ctx(withCode)))).toEqual(["INVALID_SUBJECT"]);
    const vault = "0x2222222222222222222222222222222222222222";
    const d = evaluatePolicy(wire({ type: "setReferrer", code: CODE }, { vaultAddress: vault }), ctx({ ...withCode, allowedVaultAddresses: [vault] }));
    expect(codes(d)).toEqual(["REFERRER_ACTION_DENIED"]);
  });

  it("keeps the envelope checks (expiry window, origin, policy expiry)", () => {
    expect(codes(evaluatePolicy(wire({ type: "setReferrer", code: CODE }, { expiresAfter: NOW + 120_000 }), ctx(withCode)))).toEqual(["EXPIRES_AFTER_TOO_FAR"]);
    expect(codes(evaluatePolicy({ ...wire({ type: "setReferrer", code: CODE }), origin: "guardian" }, ctx(withCode)))).toEqual(["ORIGIN_NOT_ALLOWED"]);
    expect(codes(evaluatePolicy(wire({ type: "setReferrer", code: CODE }), ctx(withCode, { policyExpiresAt: NOW })))).toEqual(["POLICY_EXPIRED"]);
  });

  it("registerReferrer stays hard-denied even with a code", () => {
    expect(codes(evaluatePolicy(wire({ type: "registerReferrer", code: CODE }), ctx(withCode)))).toEqual(["REFERRER_ACTION_DENIED"]);
  });

  it("cannot be allow-listed as an action type, and guardian policies never carry a code", () => {
    expect(() => parsePolicy({ ...withCode, allowedActionTypes: ["setReferrer"] })).toThrow();
    expect(() => parsePolicy({ ...withCode, referralCode: "bad code" })).toThrow();
    const guardian = createGuardianPolicy({ builder: BUILDER, allowedCoins: "*", maxOrderNotionalUsd: 1000, maxDailyNotionalUsd: 5000 });
    expect(guardian.referralCode).toBeUndefined();
    expect(codes(evaluatePolicy({ ...wire({ type: "setReferrer", code: CODE }), origin: "guardian" }, ctx(guardian)))).toEqual(["REFERRER_ACTION_DENIED"]);
  });

  it("is part of the signed policy hash and summary, and old policies hash as before", () => {
    const base = manual();
    expect(hashPolicy(withCode)).not.toBe(hashPolicy(base));
    expect(hashPolicy({ ...base, referralCode: undefined } as Policy)).toBe(hashPolicy(base));
    expect(summarizePolicy(withCode)).toContain(`referral code ${CODE} only`);
  });
});

describe("startFeeTrial policy", () => {
  it("is allowed only when listed", () => {
    expect(evaluatePolicy(wire(TRIAL), ctx(manual()))).toEqual({ allowed: true, violations: [], actionType: "startFeeTrial" });
    expect(codes(evaluatePolicy(wire(TRIAL), ctx(createManualTradingPolicy({ builder: BUILDER }))))).toEqual(["ACTION_TYPE_NOT_ALLOWED"]);
    const guardian = createGuardianPolicy({ builder: BUILDER, allowedCoins: "*", maxOrderNotionalUsd: 1000, maxDailyNotionalUsd: 5000 });
    expect(codes(evaluatePolicy({ ...wire(TRIAL), origin: "guardian" }, ctx(guardian)))).toEqual(["ACTION_TYPE_NOT_ALLOWED"]);
  });

  it("has exactly two rate fields and never acts for a sub-account", () => {
    expect(codes(evaluatePolicy(wire({ ...TRIAL, tier: 3 }), ctx(manual())))).toEqual(["INVALID_SUBJECT"]);
    expect(codes(evaluatePolicy(wire({ type: "startFeeTrial" }), ctx(manual())))).toEqual(["INVALID_SUBJECT", "INVALID_SUBJECT"]);
    for (const bad of ["0.0004000001", "1.5", "4e-4", ".0004", "0.0004 ", "abc"]) {
      expect(codes(evaluatePolicy(wire({ ...TRIAL, crossBaseRate: bad }), ctx(manual())))).toEqual(["INVALID_SUBJECT"]);
    }
    expect(evaluatePolicy(wire({ ...TRIAL, addBaseRate: "-0.00001" }), ctx(manual())).allowed).toBe(true);
    const vault = "0x2222222222222222222222222222222222222222";
    const d = evaluatePolicy(wire(TRIAL, { vaultAddress: vault }), ctx(manual({ allowedVaultAddresses: [vault] })));
    expect(codes(d)).toEqual(["VAULT_NOT_ALLOWED"]);
  });
});
