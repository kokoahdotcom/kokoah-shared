import { hashTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { compileAction } from "../src/actions/index.js";
import type { ActionIntentInput } from "../src/intents/index.js";
import { parseActionIntent } from "../src/intents/index.js";
import {
  type AgentMandate,
  agentPolicyProblems,
  AgentPolicyValidationError,
  buildPolicyTypedData,
  canonicalPolicyJson,
  createGuardianPolicy,
  createManualTradingPolicy,
  DENIED_ACTION_TYPES,
  evaluatePolicy,
  hashPolicy,
  parsePolicy,
  type Policy,
  type PolicyAuthorization,
  type PolicyContext,
  POLICY_EIP712_TYPES,
  POLICY_EIP712_TYPES_V2,
  POLICY_EIP712_TYPES_V3,
  POLICY_TYPED_DATA_VERSION,
  PolicySchema,
  policyTypedDataFields,
  PolicyValidationError,
  prepareAgentPolicySignature,
  preparePolicySignature,
  recoverPolicySigner,
  summarizePolicy,
  verifyPolicySignature,
} from "../src/policy/index.js";
import { mainnetRegistry } from "./helpers.js";

const registry = mainnetRegistry();
const NOW = 1_790_000_000_000;
const BUILDER = { b: "0x1111111111111111111111111111111111111111" as const, f: 25 };

const policy: Policy = parsePolicy({
  version: 1,
  allowedActionTypes: ["order", "cancel", "cancelByCloid", "modify", "updateLeverage", "updateIsolatedMargin", "scheduleCancel", "noop"],
  allowedCoins: ["BTC", "ETH", "xyz:SP500"],
  maxOrderNotionalUsd: 50_000,
  maxDailyNotionalUsd: 200_000,
  maxLeverage: 10,
  requireStopLossForNewEntries: true,
  maxOrdersPerMinute: 10,
  priceBandPct: 3,
  allowedVaultAddresses: ["0x2222222222222222222222222222222222222222"],
  requiredBuilder: BUILDER,
  maxExpiresAfterWindowMs: 30_000,
});

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  policy,
  now: NOW,
  markPrices: { BTC: 100_000, ETH: 3_000, "xyz:SP500": 6_800, SOL: 150 },
  dailyNotionalUsedUsd: 0,
  ordersInLastMinute: 0,
  registry,
  expiresAfter: NOW + 15_000,
  ...over,
});

const entry = (o: Partial<Record<string, unknown>> = {}): ActionIntentInput =>
  ({
    kind: "order",
    coin: "BTC",
    side: "buy",
    orderType: "limit",
    size: "0.1",
    price: "100000",
    origin: "manual",
    stopLoss: { triggerPrice: "98000" },
    ...o,
  }) as ActionIntentInput;

const codes = (d: ReturnType<typeof evaluatePolicy>) => d.violations.map((v) => v.code);
const evalIntent = (i: ActionIntentInput, c: Partial<PolicyContext> = {}) => evaluatePolicy(parseActionIntent(i), ctx(c));

describe("policy schema", () => {
  it("cannot allow-list hard-denied actions or unknown keys", () => {
    for (const t of ["withdraw3", "vaultTransfer", "setReferrer", "reserveRequestWeight", "twapOrder"]) {
      expect(() => parsePolicy({ ...policy, allowedActionTypes: [t] })).toThrow(PolicyValidationError);
    }
    expect(() => parsePolicy({ ...policy, extra: 1 })).toThrow(PolicyValidationError);
    expect(() => parsePolicy({ ...policy, version: 2 })).toThrow(PolicyValidationError);
    expect(policy.exemptReduceOnlyFromNotionalCaps).toBe(true);
  });

  it("presets are valid", () => {
    const manual = createManualTradingPolicy({ builder: BUILDER });
    expect(manual.allowedOrigins).toEqual(["manual", "ai_ticket"]);
    const guardian = createGuardianPolicy({ builder: BUILDER, allowedCoins: ["BTC"], maxOrderNotionalUsd: 10_000, maxDailyNotionalUsd: 50_000 });
    expect(guardian.requireStopLossForNewEntries).toBe(true);
    expect(guardian.allowedActionTypes).not.toContain("updateLeverage");
    expect(summarizePolicy(guardian)).toContain("cannot withdraw or transfer");
  });
});

describe("deny by default", () => {
  it.each([
    ["withdraw3", "WITHDRAWAL_DENIED"],
    ["usdSend", "TRANSFER_DENIED"],
    ["spotSend", "TRANSFER_DENIED"],
    ["sendAsset", "TRANSFER_DENIED"],
    ["usdClassTransfer", "TRANSFER_DENIED"],
    ["subAccountTransfer", "TRANSFER_DENIED"],
    ["vaultTransfer", "VAULT_ACTION_DENIED"],
    ["createVault", "VAULT_ACTION_DENIED"],
    ["createSubAccount", "SUBACCOUNT_ACTION_DENIED"],
    ["setReferrer", "REFERRER_ACTION_DENIED"],
    ["reserveRequestWeight", "RATE_LIMIT_PURCHASE_DENIED"],
    ["approveAgent", "APPROVAL_DENIED"],
    ["approveBuilderFee", "APPROVAL_DENIED"],
    ["convertToMultiSigUser", "ACCOUNT_CONFIG_DENIED"],
    ["agentSetAbstraction", "ACCOUNT_CONFIG_DENIED"],
    ["twapOrder", "TWAP_DENIED"],
    ["claimRewards", "STAKING_OR_REWARDS_DENIED"],
    ["perpDeploy", "DEPLOYER_ACTION_DENIED"],
    ["someFutureAction", "ACTION_TYPE_NOT_ALLOWED"],
    ["batchModify", "ACTION_TYPE_NOT_ALLOWED"], // allowlistable, but not in this policy
  ])("%s → %s", (type, code) => {
    const d = evaluatePolicy({ kind: "wire", action: { type }, expiresAfter: NOW + 1000 }, ctx());
    expect(d.allowed).toBe(false);
    expect(codes(d)).toEqual([code]);
    expect(d.violations[0]!.message.length).toBeGreaterThan(10);
  });

  it("every hard-denied type has a code", () => {
    for (const [type, code] of Object.entries(DENIED_ACTION_TYPES)) {
      expect(codes(evaluatePolicy({ kind: "wire", action: { type } }, ctx()))).toEqual([code]);
    }
  });

  it("rejects malformed subjects", () => {
    expect(codes(evaluatePolicy(null as never, ctx()))).toEqual(["INVALID_SUBJECT"]);
    expect(codes(evaluatePolicy({ kind: "wire", action: {} } as never, ctx()))).toEqual(["INVALID_SUBJECT"]);
  });
});

describe("order limits", () => {
  it("allows an entry within every limit", () => {
    const d = evalIntent(entry());
    expect(d).toEqual({ allowed: true, violations: [], actionType: "order" });
  });

  it("requires a stop-loss on new entries (attached or already on the exchange)", () => {
    expect(codes(evalIntent(entry({ stopLoss: undefined })))).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(evalIntent(entry({ stopLoss: undefined }), { hasStopLoss: (c) => c === "BTC" }).allowed).toBe(true);
    // Reduce-only orders never need one.
    expect(evalIntent(entry({ stopLoss: undefined, reduceOnly: true, side: "sell" })).allowed).toBe(true);
  });

  it("caps order notional and daily notional; reduce-only is exempt", () => {
    expect(codes(evalIntent(entry({ size: "1" })))).toContain("ORDER_NOTIONAL_EXCEEDED");
    expect(codes(evalIntent(entry(), { dailyNotionalUsedUsd: 195_000 }))).toEqual(["DAILY_NOTIONAL_EXCEEDED"]);
    expect(evalIntent(entry({ size: "1", reduceOnly: true, side: "sell", stopLoss: undefined }), { dailyNotionalUsedUsd: 195_000 }).allowed).toBe(true);
    const strict = { ...policy, exemptReduceOnlyFromNotionalCaps: false };
    expect(codes(evalIntent(entry({ size: "1", reduceOnly: true, side: "sell", stopLoss: undefined }), { policy: strict }))).toContain("ORDER_NOTIONAL_EXCEEDED");
  });

  it("checks the price band vs mark and market-order slippage", () => {
    // Marketable (a buy above mark) and IOC limits execute now: the policy band (3% here).
    expect(codes(evalIntent(entry({ price: "110000", stopLoss: { triggerPrice: "98000" } })))).toEqual(["PRICE_OUTSIDE_BAND"]);
    expect(codes(evalIntent(entry({ price: "90000", tif: "Ioc", stopLoss: { triggerPrice: "88000" } })))).toEqual(["PRICE_OUTSIDE_BAND"]);
    // A resting GTC/ALO buy 10% below mark is fine; 60% below is not.
    expect(evalIntent(entry({ price: "90000", stopLoss: { triggerPrice: "88000" } })).allowed).toBe(true);
    expect(evalIntent(entry({ price: "90000", tif: "Alo", stopLoss: { triggerPrice: "88000" } })).allowed).toBe(true);
    const typo = evalIntent(entry({ price: "40000", stopLoss: { triggerPrice: "38000" } }));
    expect(new Set(codes(typo))).toEqual(new Set(["PRICE_OUTSIDE_BAND"])); // the limit and its 62%-away stop
    expect(typo.violations[0]!.message).toContain("resting limits must be within 50%");
    const market = entry({ orderType: "market", price: undefined, slippageBps: 500 });
    expect(codes(evalIntent(market))).toEqual(["PRICE_OUTSIDE_BAND"]);
    expect(evalIntent(entry({ orderType: "market", price: undefined, slippageBps: 100 })).allowed).toBe(true);
    expect(codes(evalIntent(entry({ orderType: "market", price: undefined }), { markPrices: {} }))).toContain("MARK_PRICE_UNAVAILABLE");
  });

  it("restricts coins, origins, vaults and leverage", () => {
    expect(codes(evalIntent(entry({ coin: "SOL", price: "150", stopLoss: { triggerPrice: "140" } })))).toEqual(["COIN_NOT_ALLOWED"]);
    expect(codes(evalIntent(entry({ vaultAddress: "0x3333333333333333333333333333333333333333" })))).toEqual(["VAULT_NOT_ALLOWED"]);
    expect(evalIntent(entry({ vaultAddress: "0x2222222222222222222222222222222222222222" })).allowed).toBe(true);
    expect(codes(evalIntent(entry(), { policy: { ...policy, allowedOrigins: ["guardian"] } }))).toEqual(["ORIGIN_NOT_ALLOWED"]);
    expect(codes(evalIntent({ kind: "updateLeverage", coin: "BTC", leverage: 20, marginMode: "cross", origin: "manual" }))).toEqual(["LEVERAGE_EXCEEDED"]);
    expect(evalIntent({ kind: "updateLeverage", coin: "BTC", leverage: 10, marginMode: "cross", origin: "manual" }).allowed).toBe(true);
    expect(codes(evalIntent(entry(), { leverageByCoin: { BTC: 25 } }))).toEqual(["LEVERAGE_EXCEEDED"]);
    expect(codes(evalIntent({ kind: "updateIsolatedMargin", coin: "SOL", amountUsd: "5", origin: "manual" }))).toEqual(["COIN_NOT_ALLOWED"]);
  });

  it("with requireLeverage, an entry whose leverage is unknown is refused instead of going unchecked", () => {
    const required = { requireLeverage: true };
    // Without the flag an unknown leverage stays unchecked, as before.
    expect(evalIntent(entry()).allowed).toBe(true);
    expect(codes(evalIntent(entry(), required))).toEqual(["LEVERAGE_EXCEEDED"]);
    const other = evalIntent(entry(), { ...required, leverageByCoin: { ETH: 5 } });
    expect(other.violations.map((v) => v.message)).toEqual(["BTC: the account's current leverage is unknown, so the 10x maximum can't be checked."]);
    expect(evalIntent(entry(), { ...required, leverageByCoin: { BTC: 10 } }).allowed).toBe(true);
    expect(codes(evalIntent(entry(), { ...required, leverageByCoin: { BTC: 40 } }))).toEqual(["LEVERAGE_EXCEEDED"]);
    // A modify of an entry too, on the intent and on the compiled wire action.
    const modify = { kind: "modify", target: { oid: 1 }, order: { coin: "BTC", side: "buy", orderType: "limit", size: "0.1", price: "100000" }, origin: "manual" } as ActionIntentInput;
    const withStop = { ...required, hasStopLoss: () => true };
    expect(codes(evalIntent(modify, withStop))).toEqual(["LEVERAGE_EXCEEDED"]);
    expect(evalIntent(modify, { ...withStop, leverageByCoin: { BTC: 3 } }).allowed).toBe(true);
    const compiled = compileAction(parseActionIntent(modify), { registry, builder: { address: BUILDER.b, feeTenthsBps: BUILDER.f }, now: NOW });
    expect(codes(evaluatePolicy({ kind: "compiled", compiled }, ctx(withStop)))).toEqual(["LEVERAGE_EXCEEDED"]);
    expect(codes(evaluatePolicy({ kind: "compiled", compiled }, ctx({ ...withStop, leverageByCoin: { BTC: 40 } })))).toEqual(["LEVERAGE_EXCEEDED"]);
    expect(evaluatePolicy({ kind: "compiled", compiled }, ctx({ ...withStop, leverageByCoin: { BTC: 10 } })).allowed).toBe(true);
    // Reduce-only orders, stops and cancels need no leverage.
    const close = entry({ side: "sell", reduceOnly: true, stopLoss: undefined, tif: "Ioc", price: "99000" });
    expect(evalIntent(close, required).allowed).toBe(true);
    expect(evalIntent({ ...modify, order: { ...(modify as { order: object }).order, reduceOnly: true } } as ActionIntentInput, required).allowed).toBe(true);
    expect(evalIntent({ kind: "cancel", cancels: [{ coin: "BTC", oid: 1 }], origin: "manual" }, required).allowed).toBe(true);
  });

  it("enforces orders per minute (cancels exempt)", () => {
    expect(codes(evalIntent(entry(), { ordersInLastMinute: 9 }))).toEqual(["ORDER_RATE_EXCEEDED"]); // parent + SL = 2 orders
    expect(evalIntent({ kind: "cancel", cancels: [{ coin: "BTC", oid: 1 }], origin: "manual" }, { ordersInLastMinute: 100 }).allowed).toBe(true);
  });

  it("enforces the expiresAfter window", () => {
    expect(codes(evalIntent(entry(), { expiresAfter: undefined }))).toEqual(["EXPIRES_AFTER_REQUIRED"]);
    expect(codes(evalIntent(entry(), { expiresAfter: NOW }))).toEqual(["EXPIRES_AFTER_IN_PAST"]);
    expect(codes(evalIntent(entry(), { expiresAfter: NOW + 60_000 }))).toEqual(["EXPIRES_AFTER_TOO_FAR"]);
    expect(evalIntent(entry(), { expiresAfter: undefined, policy: { ...policy, maxExpiresAfterWindowMs: null } }).allowed).toBe(true);
  });

  it("values a sell limited below the mark at the mark, not at its limit", () => {
    // 0.5 BTC IOC sell 2.9% under a $100,000 mark: $48,550 at its limit, $50,000 at the mark (the cap is $50,000).
    const sell = entry({ side: "sell", size: "0.5", price: "97100", tif: "Ioc", stopLoss: undefined, reduceOnly: false });
    const withRoom = { policy: { ...policy, requireStopLossForNewEntries: false } };
    expect(evalIntent(sell, withRoom).allowed).toBe(true);
    expect(codes(evalIntent({ ...sell, size: "0.50001" } as ActionIntentInput, withRoom))).toContain("ORDER_NOTIONAL_EXCEEDED");
    expect(codes(evalIntent(sell, { ...withRoom, dailyNotionalUsedUsd: 150_001 }))).toContain("DAILY_NOTIONAL_EXCEEDED");
  });

  it("lets automation keys add isolated margin but never remove it", () => {
    const margin = (amountUsd: string, origin: string) => ({ kind: "updateIsolatedMargin", coin: "BTC", amountUsd, origin }) as ActionIntentInput;
    const server = { policy: { ...policy, allowedOrigins: ["guardian"] as Policy["allowedOrigins"] } };
    expect(evalIntent(margin("50", "guardian"), server).allowed).toBe(true);
    expect(codes(evalIntent(margin("-50", "guardian"), server))).toContain("ACTION_TYPE_NOT_ALLOWED");
    // The user's own key may take margin out.
    expect(evalIntent(margin("-50", "manual")).allowed).toBe(true);
  });

  it("denies new entries while the daily loss lock is active, but allows reducing", () => {
    expect(codes(evalIntent(entry(), { lossLockActive: true }))).toEqual(["DAILY_LOSS_LOCKED"]);
    expect(evalIntent(entry({ reduceOnly: true, side: "sell", stopLoss: undefined }), { lossLockActive: true }).allowed).toBe(true);
  });

  it("denies new entries once today's realized loss reaches the signed daily loss limit, but allows reducing", () => {
    const limited = { policy: { ...policy, maxDailyLossUsd: 500 } };
    expect(evalIntent(entry(), { ...limited, dailyLossUsd: 499.99 }).allowed).toBe(true);
    const at = evalIntent(entry(), { ...limited, dailyLossUsd: 500 });
    expect(codes(at)).toEqual(["DAILY_LOSS_LIMIT"]);
    expect(at.violations[0]!.message).toContain("$500");
    expect(evalIntent(entry({ reduceOnly: true, side: "sell", stopLoss: undefined }), { ...limited, dailyLossUsd: 9_000 }).allowed).toBe(true);
    // Not measured (a preview): not checked; no limit signed: never checked.
    expect(evalIntent(entry(), limited).allowed).toBe(true);
    expect(evalIntent(entry(), { dailyLossUsd: 9_000 }).allowed).toBe(true);
  });

  it("fails after the signed policy expires", () => {
    expect(codes(evalIntent(entry(), { policyExpiresAt: NOW }))).toEqual(["POLICY_EXPIRED"]);
  });

  it("reports several violations at once", () => {
    const d = evalIntent(entry({ size: "0.4", price: "130000", stopLoss: undefined }), { expiresAfter: undefined });
    expect(codes(d).sort()).toEqual(["EXPIRES_AFTER_REQUIRED", "ORDER_NOTIONAL_EXCEEDED", "PRICE_OUTSIDE_BAND", "STOP_LOSS_REQUIRED"].sort());
  });
});

describe("compiled and wire actions", () => {
  const builder = { address: BUILDER.b, feeTenthsBps: BUILDER.f };

  it("checks the builder on the exact wire action", () => {
    const ok = compileAction(entry(), { registry, builder });
    expect(evaluatePolicy({ kind: "compiled", compiled: ok }, ctx()).allowed).toBe(true);
    const none = compileAction(entry(), { registry });
    expect(codes(evaluatePolicy({ kind: "compiled", compiled: none }, ctx()))).toEqual(["BUILDER_REQUIRED"]);
    const wrong = compileAction(entry(), { registry, builder: { ...builder, feeTenthsBps: 100 } });
    expect(codes(evaluatePolicy({ kind: "compiled", compiled: wrong }, ctx()))).toEqual(["BUILDER_MISMATCH"]);
    const other = compileAction(entry(), { registry, builder: { ...builder, address: "0x2222222222222222222222222222222222222222" } });
    expect(codes(evaluatePolicy({ kind: "compiled", compiled: other }, ctx()))).toEqual(["BUILDER_MISMATCH"]);
  });

  it("accepts a lower builder fee (a promotion) but never a higher one", () => {
    for (const f of [0, 10, BUILDER.f]) {
      const c = compileAction(entry(), { registry, builder: { ...builder, feeTenthsBps: f } });
      expect(evaluatePolicy({ kind: "compiled", compiled: c }, ctx()).allowed).toBe(true);
    }
    const above = compileAction(entry(), { registry, builder: { ...builder, feeTenthsBps: BUILDER.f + 1 } });
    expect(codes(evaluatePolicy({ kind: "compiled", compiled: above }, ctx()))).toEqual(["BUILDER_MISMATCH"]);
  });

  it("evaluates compiled market orders at their IOC price", () => {
    const c = compileAction(entry({ orderType: "market", price: undefined, slippageBps: 100 }), { registry, builder, getMidPrice: () => 100_000 });
    expect(evaluatePolicy({ kind: "compiled", compiled: c }, ctx()).allowed).toBe(true);
  });

  it("evaluates raw wire actions via the registry", () => {
    const c = compileAction(entry({ coin: "xyz:SP500", size: "1", price: "6800", stopLoss: { triggerPrice: "6600" } }), { registry, builder });
    const wire = { kind: "wire" as const, action: c.action as unknown as { type: string }, expiresAfter: NOW + 10_000, origin: "manual" as const };
    expect(evaluatePolicy(wire, ctx()).allowed).toBe(true);
    expect(codes(evaluatePolicy(wire, ctx({ registry: undefined })))).toContain("UNKNOWN_MARKET");
    const unknownAsset = { ...wire, action: { ...wire.action, orders: [{ a: 9999, b: true, p: "1", s: "1", r: false, t: { limit: { tif: "Gtc" } } }] } };
    expect(codes(evaluatePolicy(unknownAsset, ctx()))).toContain("UNKNOWN_MARKET");
    const malformed = { ...wire, action: { type: "order", orders: [{ a: 0 }] } };
    expect(codes(evaluatePolicy(malformed, ctx()))).toContain("INVALID_SUBJECT");
  });

  it("does not require a builder on cancels or leverage changes", () => {
    const c = compileAction({ kind: "cancel", cancels: [{ coin: "BTC", oid: 1 }], origin: "manual" }, { registry });
    expect(evaluatePolicy({ kind: "compiled", compiled: c }, ctx()).allowed).toBe(true);
  });
});

describe("signed policies (EIP-712)", () => {
  const user = privateKeyToAccount(generatePrivateKey());
  const auth = { user: user.address, network: "Testnet" as const, chainId: 421614, issuedAt: NOW, expiresAt: NOW + 30 * 86_400_000, nonce: 1 };

  it("golden: the signed policy type and digest are unchanged (existing signatures keep verifying)", () => {
    // Pinned from 0.1.2. The resting price band is evaluator logic, not a signed field.
    const manual = createManualTradingPolicy({ builder: BUILDER });
    const td = buildPolicyTypedData(manual, {
      user: "0x3333333333333333333333333333333333333333",
      network: "Testnet",
      chainId: 421614,
      issuedAt: 1_790_000_000_000,
      expiresAt: 1_790_000_000_000 + 86_400_000,
      nonce: 7,
    });
    expect(hashPolicy(manual)).toBe("0xb4bb1459bcb66f6add58b01f7cf7ae6b74286fdfb0cbad7130cde014ed5ab776");
    expect(hashTypedData(td)).toBe("0x5197cf8b93c93224ab4e6eecf7893290170734820594bcacee0b67733e4a189c");
  });

  it("hash is stable under list reordering and changes with any field", () => {
    const shuffled = { ...policy, allowedCoins: ["xyz:SP500", "ETH", "BTC"], allowedActionTypes: [...policy.allowedActionTypes].reverse() };
    expect(hashPolicy(shuffled)).toBe(hashPolicy(policy));
    expect(canonicalPolicyJson(shuffled)).toBe(canonicalPolicyJson(policy));
    expect(hashPolicy({ ...policy, maxLeverage: 11 })).not.toBe(hashPolicy(policy));
    // The daily loss limit is bound by the hash; left out, it leaves older policies' hashes as they were.
    expect(hashPolicy({ ...policy, maxDailyLossUsd: 500 })).not.toBe(hashPolicy(policy));
    expect(canonicalPolicyJson(policy)).not.toContain("maxDailyLossUsd");
    expect(() => parsePolicy({ ...policy, maxDailyLossUsd: 0 })).toThrow(PolicyValidationError);
    expect(summarizePolicy({ ...policy, maxDailyLossUsd: 500 })).toContain("max daily loss $500");
    expect(hashPolicy({ ...policy, allowedVaultAddresses: [] })).not.toBe(hashPolicy(policy));
  });

  it("verifies the user's signature and rejects tampering", async () => {
    const td = buildPolicyTypedData(policy, auth);
    expect(td.message).toMatchObject({ maxOrderNotionalUsd: "50000", maxLeverage: 10, stopLossRequired: true, canWithdrawOrTransfer: false, builderFeeTenthsBps: 25, allowedMarkets: "BTC,ETH,xyz:SP500" });
    const signature = await user.signTypedData(td);
    const signed = { policy, authorization: auth, signature };
    const at = { now: NOW + 1 };
    expect(await verifyPolicySignature(signed, at)).toBe(true);
    expect((await recoverPolicySigner(signed)).toLowerCase()).toBe(user.address.toLowerCase());
    expect(await verifyPolicySignature(signed, { now: NOW + 1 })).toBe(true);
    expect(await verifyPolicySignature(signed, { now: auth.expiresAt })).toBe(false);
    expect(await verifyPolicySignature(signed, { now: NOW - 1 })).toBe(false);
    expect(await verifyPolicySignature({ ...signed, policy: { ...policy, maxLeverage: 50 } }, at)).toBe(false);
    expect(await verifyPolicySignature({ ...signed, policy: { ...policy, allowedVaultAddresses: [] } }, at)).toBe(false); // not displayed, but in policyHash
    expect(await verifyPolicySignature({ ...signed, authorization: { ...auth, user: privateKeyToAccount(generatePrivateKey()).address } }, at)).toBe(false);
    expect(await verifyPolicySignature({ ...signed, authorization: { ...auth, network: "Mainnet" } }, at)).toBe(false);
    expect(await verifyPolicySignature({ ...signed, signature: "0x1234" }, at)).toBe(false);
    // Expiry is checked by default (now = Date.now()); ignoreExpiry skips it explicitly.
    expect(await verifyPolicySignature(signed, { now: auth.expiresAt + 1 })).toBe(false);
    expect(await verifyPolicySignature(signed, { now: auth.expiresAt + 1, ignoreExpiry: true })).toBe(true);
    // Clock skew: issuedAt 60 s in the future is rejected by default, accepted with a 5-minute tolerance,
    // and the tolerance never extends expiresAt.
    expect(await verifyPolicySignature(signed, { now: NOW - 60_000 })).toBe(false);
    expect(await verifyPolicySignature(signed, { now: NOW - 60_000, clockSkewMs: 300_000 })).toBe(true);
    expect(await verifyPolicySignature(signed, { now: NOW - 600_000, clockSkewMs: 300_000 })).toBe(false);
    expect(await verifyPolicySignature(signed, { now: auth.expiresAt, clockSkewMs: 300_000 })).toBe(false);
  });

  it("validates the authorization", () => {
    expect(() => buildPolicyTypedData(policy, { ...auth, expiresAt: auth.issuedAt })).toThrow(RangeError);
    expect(() => buildPolicyTypedData(policy, { ...auth, user: "0x12" as `0x${string}` })).toThrow(RangeError);
    expect(() => buildPolicyTypedData(policy, { ...auth, chainId: 0 })).toThrow(RangeError);
    expect(() => buildPolicyTypedData(policy, { ...auth, typedDataVersion: 4 as never })).toThrow(/typedDataVersion must be 1, 2 or 3/);
  });
});

describe("signed policies, format 2 (every field readable)", () => {
  const user = privateKeyToAccount(generatePrivateKey());
  const auth: PolicyAuthorization = { user: user.address, network: "Testnet", chainId: 421614, issuedAt: NOW, expiresAt: NOW + 30 * 86_400_000, nonce: 1 };
  const v2 = { ...auth, typedDataVersion: 2 as const };
  const at = { now: NOW + 1 };
  const shown = (m: Record<string, unknown>, n: Record<string, unknown>) => Object.keys(m).filter((k) => k !== "policyHash" && m[k] !== n[k]).sort();

  /** One change to every policy field; adding a field to the schema fails to compile here until it has one. */
  const changes: Record<Exclude<keyof Policy, "version">, Partial<Policy>> = {
    allowedActionTypes: { allowedActionTypes: [...policy.allowedActionTypes, "batchModify"] },
    allowedCoins: { allowedCoins: "*" },
    maxOrderNotionalUsd: { maxOrderNotionalUsd: 1 },
    maxDailyNotionalUsd: { maxDailyNotionalUsd: 1 },
    maxDailyLossUsd: { maxDailyLossUsd: 500 },
    maxLeverage: { maxLeverage: 3 },
    requireStopLossForNewEntries: { requireStopLossForNewEntries: false },
    maxStopLossDistancePct: { maxStopLossDistancePct: 5 },
    botEntriesWithoutStopLoss: { botEntriesWithoutStopLoss: true },
    maxOrdersPerMinute: { maxOrdersPerMinute: 1 },
    priceBandPct: { priceBandPct: 1 },
    allowedVaultAddresses: { allowedVaultAddresses: [] },
    requiredBuilder: { requiredBuilder: null },
    maxExpiresAfterWindowMs: { maxExpiresAfterWindowMs: null },
    allowedOrigins: { allowedOrigins: ["guardian"] },
    exemptReduceOnlyFromNotionalCaps: { exemptReduceOnlyFromNotionalCaps: false },
    allowedSpotCoins: { allowedSpotCoins: ["@166"] },
    spotTrading: { spotTrading: true },
    referralCode: { referralCode: "KOKOAH" },
  };

  it("new signatures use format 2 and verify; the format is bound by the signature", async () => {
    expect(POLICY_TYPED_DATA_VERSION).toBe(2);
    const { authorization, typedData } = preparePolicySignature(policy, auth);
    expect(authorization).toEqual({ ...auth, typedDataVersion: 2 });
    expect(typedData).toEqual(buildPolicyTypedData(policy, authorization));
    expect(typedData.domain).toEqual({ name: "Kokoah Policy", version: "2", chainId: 421614 });
    expect(typedData.types.KokoahPolicy).toEqual(POLICY_EIP712_TYPES_V2.KokoahPolicy);
    const signature = await user.signTypedData(typedData);
    const signed = { policy, authorization, signature };
    expect(await verifyPolicySignature(signed, at)).toBe(true);
    expect((await recoverPolicySigner(signed)).toLowerCase()).toBe(user.address.toLowerCase());
    // The same signature claimed as format 1 (or with the format left out) recovers someone else.
    expect(await verifyPolicySignature({ ...signed, authorization: auth }, at)).toBe(false);
    expect(await verifyPolicySignature({ ...signed, authorization: { ...auth, typedDataVersion: 1 } }, at)).toBe(false);
    expect(await verifyPolicySignature({ ...signed, authorization: { ...auth, typedDataVersion: 3 as never } }, at)).toBe(false);
    // Any change to the policy still fails, through the readable fields and through policyHash.
    for (const change of Object.values(changes)) expect(await verifyPolicySignature({ ...signed, policy: { ...policy, ...change } }, at)).toBe(false);
    // An explicit format is kept.
    expect(preparePolicySignature(policy, { ...auth, typedDataVersion: 1 }).authorization.typedDataVersion).toBe(1);
  });

  it("format 1 signatures keep verifying, also with the format named explicitly", async () => {
    const signature = await user.signTypedData(buildPolicyTypedData(policy, auth));
    expect(await verifyPolicySignature({ policy, authorization: auth, signature }, at)).toBe(true);
    expect(await verifyPolicySignature({ policy, authorization: { ...auth, typedDataVersion: 1 }, signature }, at)).toBe(true);
    expect(await verifyPolicySignature({ policy, authorization: v2, signature }, at)).toBe(false);
    expect(buildPolicyTypedData(policy, { ...auth, typedDataVersion: 1 })).toEqual(buildPolicyTypedData(policy, auth));
  });

  it("golden: format 2's type and digest are pinned", () => {
    const manual = createManualTradingPolicy({ builder: BUILDER });
    const td = buildPolicyTypedData(manual, {
      user: "0x3333333333333333333333333333333333333333",
      network: "Testnet",
      chainId: 421614,
      issuedAt: 1_790_000_000_000,
      expiresAt: 1_790_000_000_000 + 86_400_000,
      nonce: 7,
      typedDataVersion: 2,
    });
    expect(hashPolicy(manual)).toBe("0xb4bb1459bcb66f6add58b01f7cf7ae6b74286fdfb0cbad7130cde014ed5ab776"); // the policy hash is the same in both formats
    expect(hashTypedData(td)).toBe("0x19f9b9b7f18e2a18b9007ff1b9ccaf6a86949228a7c8a3b3b6953aa140aa959d"); // also eth_account (Python)
  });

  it("shows every field of the policy in readable form", () => {
    const full = parsePolicy({
      ...policy,
      allowedVaultAddresses: ["0x2222222222222222222222222222222222222222", "0x1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
      allowedOrigins: ["guardian", "bot", "guardian"],
      maxDailyLossUsd: 250.5,
      maxStopLossDistancePct: 7.5,
      botEntriesWithoutStopLoss: true,
      exemptReduceOnlyFromNotionalCaps: false,
      allowedSpotCoins: ["@166", "@107"],
      spotTrading: true,
      referralCode: "KOKOAH",
    });
    const td = buildPolicyTypedData(full, { ...v2, agent: "0x4444444444444444444444444444444444444444" });
    expect(td.message).toEqual({
      user: user.address.toLowerCase(),
      agent: "0x4444444444444444444444444444444444444444",
      network: "Testnet",
      allowedActions: "cancel,cancelByCloid,modify,noop,order,scheduleCancel,updateIsolatedMargin,updateLeverage",
      allowedMarkets: "BTC,ETH,xyz:SP500",
      allowedOrigins: "bot,guardian",
      allowedSubAccounts: "0x1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,0x2222222222222222222222222222222222222222",
      maxOrderNotionalUsd: "50000",
      maxDailyNotionalUsd: "200000",
      reduceOnlyExemptFromCaps: false,
      maxDailyLossUsd: "250.5",
      maxLeverage: 10,
      stopLossRequired: true,
      maxStopLossDistancePct: "7.5",
      botsWithoutStopLoss: true,
      maxOrdersPerMinute: 10,
      priceBandPct: "3",
      maxActionLifetimeMs: "30000",
      allowedSpotPairs: "@107,@166",
      spotTrading: true,
      referralCode: "KOKOAH",
      builder: BUILDER.b,
      builderFeeTenthsBps: 25,
      canWithdrawOrTransfer: false,
      policyHash: hashPolicy(full),
      issuedAt: NOW,
      expiresAt: NOW + 30 * 86_400_000,
      nonce: 1,
    });
    // In the order of the type, as wallets that show the message raw list it.
    expect(Object.keys(td.message)).toEqual(POLICY_EIP712_TYPES_V2.KokoahPolicy.map((f) => f.name));
    // What is not set reads "*" (all origins), "none" (no sub-accounts, spot pairs or referral code) or "unlimited".
    const bare = parsePolicy({ ...policy, allowedVaultAddresses: [], maxExpiresAfterWindowMs: null, allowedSpotCoins: [] });
    expect(buildPolicyTypedData(bare, v2).message).toMatchObject({
      allowedOrigins: "*",
      allowedSubAccounts: "none",
      reduceOnlyExemptFromCaps: true,
      maxDailyLossUsd: "unlimited",
      maxStopLossDistancePct: "unlimited",
      botsWithoutStopLoss: false,
      maxActionLifetimeMs: "unlimited",
      allowedSpotPairs: "none",
      spotTrading: false,
      referralCode: "none",
    });
  });

  it("every policy field changes a readable field in format 2 (format 1 showed some only through policyHash)", () => {
    const fields2 = policyTypedDataFields();
    const fields1 = policyTypedDataFields(1);
    const base2 = buildPolicyTypedData(policy, v2).message as Record<string, unknown>;
    const base1 = buildPolicyTypedData(policy, auth).message as Record<string, unknown>;
    const hiddenInV1: string[] = [];
    for (const [key, change] of Object.entries(changes)) {
      const changed = { ...policy, ...change };
      expect(hashPolicy(changed), key).not.toBe(hashPolicy(policy));
      const m2 = buildPolicyTypedData(changed, v2).message as Record<string, unknown>;
      expect(shown(m2, base2), key).toEqual(fields2.filter((f) => f.shows.includes(key as never)).map((f) => f.name).sort());
      expect(shown(m2, base2).length, key).toBeGreaterThan(0);
      const m1 = buildPolicyTypedData(changed, auth).message as Record<string, unknown>;
      expect(shown(m1, base1), key).toEqual(fields1.filter((f) => f.shows.includes(key as never)).map((f) => f.name).sort());
      if (shown(m1, base1).length === 0) hiddenInV1.push(key);
    }
    expect(hiddenInV1.sort()).toEqual(
      [
        "allowedOrigins",
        "allowedSpotCoins",
        "allowedVaultAddresses",
        "botEntriesWithoutStopLoss",
        "exemptReduceOnlyFromNotionalCaps",
        "maxDailyLossUsd",
        "maxExpiresAfterWindowMs",
        "maxStopLossDistancePct",
        "referralCode",
        "spotTrading",
      ].sort(),
    );
  });

  it("lists the readable fields: format 2 shows every policy and authorization field", () => {
    const fields = policyTypedDataFields();
    expect(fields.map(({ name, type }) => ({ name, type }))).toEqual(POLICY_EIP712_TYPES_V2.KokoahPolicy);
    expect(policyTypedDataFields(1).map(({ name, type }) => ({ name, type }))).toEqual(POLICY_EIP712_TYPES.KokoahPolicy);
    const shownKeys = new Set(fields.flatMap((f) => f.shows));
    const policyKeys = Object.keys(PolicySchema.entries).filter((k) => k !== "version");
    expect(policyKeys.filter((k) => !shownKeys.has(k as never))).toEqual([]);
    for (const k of ["user", "agent", "network", "issuedAt", "expiresAt", "nonce"]) expect(shownKeys.has(k as never), k).toBe(true);
    // Format 1's types are unchanged (wallet decoders match them exactly).
    expect(POLICY_EIP712_TYPES.KokoahPolicy.length).toBe(18);
  });

  it("refuses values format 2 couldn't show unambiguously", () => {
    expect(() => buildPolicyTypedData({ ...policy, allowedCoins: ["BTC", "none"] }, v2)).toThrow(/allowedCoins has an entry/);
    expect(() => buildPolicyTypedData({ ...policy, allowedCoins: ["*"] }, v2)).toThrow(/allowedCoins has an entry/);
    expect(() => buildPolicyTypedData({ ...policy, allowedCoins: ["BTC,ETH"] }, v2)).toThrow(/allowedCoins has an entry/);
    expect(() => buildPolicyTypedData({ ...policy, allowedSpotCoins: ["NONE"] }, v2)).toThrow(/allowedSpotCoins has an entry/);
    expect(() => buildPolicyTypedData({ ...policy, referralCode: "None" }, v2)).toThrow(/referralCode can't be shown/);
    // Format 1 builds them as before (existing signatures keep verifying).
    expect(buildPolicyTypedData({ ...policy, allowedCoins: ["*"] }, auth).message.allowedMarkets).toBe("*");
  });
});

describe("regressions from the security review", () => {
  const builder = { address: BUILDER.b, feeTenthsBps: BUILDER.f };
  const withModify: Policy = { ...policy, allowedActionTypes: [...policy.allowedActionTypes, "batchModify"] };
  const order = (o: Record<string, unknown> = {}) => ({ a: 0, b: true, p: "100000", s: "0.4", r: false, t: { limit: { tif: "Gtc" } }, ...o });
  const wireSubject = (action: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ kind: "wire" as const, action: action as { type: string }, expiresAfter: NOW + 10_000, origin: "manual" as const, ...extra });

  it("modify / batchModify of entries honour the loss lock and the stop-loss rule", () => {
    const modify = wireSubject({ type: "modify", oid: 123, order: order() });
    expect(codes(evaluatePolicy(modify, ctx({ lossLockActive: true, policy: withModify })))).toEqual(expect.arrayContaining(["DAILY_LOSS_LOCKED", "STOP_LOSS_REQUIRED"]));
    expect(evaluatePolicy(modify, ctx({ policy: withModify, hasStopLoss: () => true })).allowed).toBe(true);
    const batch = wireSubject({ type: "batchModify", modifies: [{ oid: 1, order: order() }] });
    expect(codes(evaluatePolicy(batch, ctx({ policy: withModify })))).toContain("STOP_LOSS_REQUIRED");
    // Moving a reduce-only stop is always fine.
    const moveStop = wireSubject({ type: "modify", oid: 5, order: order({ b: false, r: true, p: "85500", t: { trigger: { isMarket: true, triggerPx: "95000", tpsl: "sl" } } }) });
    expect(evaluatePolicy(moveStop, ctx({ lossLockActive: true })).allowed).toBe(true);
    const intentModify = { kind: "modify", target: { oid: 1 }, order: { coin: "BTC", side: "buy", orderType: "limit", size: "0.4", price: "100000" }, origin: "manual" } as ActionIntentInput;
    expect(codes(evalIntent(intentModify, { lossLockActive: true }))).toEqual(expect.arrayContaining(["DAILY_LOSS_LOCKED", "STOP_LOSS_REQUIRED"]));
  });

  it("always-place modifies cannot dodge the builder requirement", () => {
    const a = wireSubject({ type: "modify", oid: 5, order: order({ b: false, r: true }), a: true });
    expect(codes(evaluatePolicy(a, ctx()))).toContain("BUILDER_REQUIRED");
  });

  it("values trigger legs at max(limit, trigger, mark) and bands already-crossed triggers against mark", () => {
    const tp = wireSubject({
      type: "order",
      orders: [order({ b: false, s: "5", p: "9000", t: { trigger: { isMarket: false, triggerPx: "10000", tpsl: "tp" } } })],
      grouping: "na",
      builder: { b: BUILDER.b, f: BUILDER.f },
    });
    const c = codes(evaluatePolicy(tp, ctx({ policy: { ...policy, requireStopLossForNewEntries: false } })));
    expect(c).toEqual(expect.arrayContaining(["ORDER_NOTIONAL_EXCEEDED", "PRICE_OUTSIDE_BAND"]));
    const intentTp = entry({ side: "sell", orderType: "takeProfitLimit", size: "0.1", price: "9000", triggerPrice: "10000", stopLoss: undefined });
    expect(codes(evalIntent(intentTp, { policy: { ...policy, requireStopLossForNewEntries: false } }))).toContain("PRICE_OUTSIDE_BAND");
    // A far-away, not-yet-crossed stop is fine.
    const farStop = entry({ side: "sell", orderType: "stopMarket", size: "0.1", price: undefined, triggerPrice: "80000", reduceOnly: true, stopLoss: undefined });
    expect(evalIntent(farStop).allowed).toBe(true);
    expect(codes(evalIntent(farStop, { markPrices: {} }))).toContain("MARK_PRICE_UNAVAILABLE");
  });

  it.each([
    ["size abc", { s: "abc" }],
    ["missing size", { s: undefined }],
    ["negative size", { s: "-0.49" }],
    ["numeric size", { s: 0.4 }],
    ["price abc", { p: "abc" }],
    ["exponent price", { p: "1e5" }],
    ["missing triggerPx", { t: { trigger: { isMarket: true, tpsl: "sl" } } }],
    ["bad tif", { t: { limit: { tif: "Day" } } }],
    ["extra key", { x: 1 }],
    ["string asset", { a: "0" }],
  ])("fails closed on malformed wire orders: %s", (_n, patch) => {
    const legs = [order(), order({ b: false, r: true, p: "88200", t: { trigger: { isMarket: true, triggerPx: "98000", tpsl: "sl" } } })];
    legs.push(order(patch));
    const d = evaluatePolicy(wireSubject({ type: "order", orders: legs, grouping: "na", builder: { b: BUILDER.b, f: BUILDER.f } }), ctx({ dailyNotionalUsedUsd: 190_000 }));
    expect(d.allowed).toBe(false);
    expect(codes(d)).toContain("INVALID_SUBJECT");
  });

  it.each([null, 0, -5, "5", 2.5, undefined])("fails closed on updateLeverage leverage %j", (leverage) => {
    const d = evaluatePolicy(wireSubject({ type: "updateLeverage", asset: 0, isCross: true, leverage }), ctx());
    expect(codes(d)).toEqual(["INVALID_SUBJECT"]);
  });

  it("fails closed on malformed envelopes and odd action types", () => {
    expect(codes(evaluatePolicy(wireSubject({ type: "noop" }, { expiresAfter: Number.NaN }), ctx()))).toEqual(["INVALID_SUBJECT"]);
    expect(codes(evaluatePolicy(wireSubject({ type: "noop" }, { vaultAddress: null }), ctx()))).toEqual(["INVALID_SUBJECT"]);
    for (const type of ["__proto__", "constructor", "toString", "hasOwnProperty", "Order", "ORDER"]) {
      const d = evaluatePolicy(wireSubject({ type }), ctx());
      expect(d.allowed).toBe(false);
      expect(codes(d)).toEqual(["ACTION_TYPE_NOT_ALLOWED"]);
    }
    expect(codes(evaluatePolicy(wireSubject({ type: "order", orders: [] }), ctx()))).toContain("INVALID_SUBJECT");
    expect(codes(evaluatePolicy(wireSubject({ type: "cancel", cancels: [{ a: 0 }] }), ctx()))).toEqual(["INVALID_SUBJECT"]);
  });

  it("a token stop-loss does not satisfy the stop-loss requirement", () => {
    const tiny = wireSubject({
      type: "order",
      orders: [order({ c: undefined }), order({ b: false, r: true, s: "0.00001", p: "0.9", t: { trigger: { isMarket: true, triggerPx: "1", tpsl: "sl" } } })],
      grouping: "normalTpsl",
      builder: { b: BUILDER.b, f: BUILDER.f },
    });
    expect(codes(evaluatePolicy(tiny, ctx()))).toContain("STOP_LOSS_REQUIRED");
    const farButFull = entry({ stopLoss: { triggerPrice: "55000" } });
    expect(evalIntent(farButFull).allowed).toBe(true); // no distance limit in this policy (45% is inside the resting band)
    // A stop 99.999% away is a typo: the resting trigger band refuses it.
    expect(codes(evalIntent(entry({ stopLoss: { triggerPrice: "1" } })))).toEqual(["PRICE_OUTSIDE_BAND"]);
    expect(codes(evalIntent(farButFull, { policy: { ...policy, maxStopLossDistancePct: 10 } }))).toContain("STOP_LOSS_REQUIRED");
    expect(evalIntent(entry(), { policy: { ...policy, maxStopLossDistancePct: 10 } }).allowed).toBe(true); // 2% away
  });

  it("restricts cancels to the allowed markets", () => {
    expect(codes(evalIntent({ kind: "cancel", cancels: [{ coin: "SOL", oid: 1 }], origin: "manual" }))).toEqual(["COIN_NOT_ALLOWED"]);
    expect(codes(evaluatePolicy(wireSubject({ type: "cancel", cancels: [{ a: 999999, o: 1 }] }), ctx()))).toEqual(["UNKNOWN_MARKET"]);
    expect(codes(evaluatePolicy(wireSubject({ type: "cancelByCloid", cancels: [{ asset: 5, cloid: "0x" + "1".repeat(32) }] }), ctx()))).toEqual(["COIN_NOT_ALLOWED"]);
    expect(evalIntent({ kind: "cancel", cancels: [{ coin: "BTC", oid: 1 }], origin: "manual" }).allowed).toBe(true);
  });

  it("takes leverage from the wire action of a compiled subject", () => {
    const honest = compileAction({ kind: "updateLeverage", coin: "BTC", leverage: 5, marginMode: "cross", origin: "manual" }, { registry, builder });
    const forged = { ...honest, action: { ...honest.action, leverage: 40 } as typeof honest.action };
    expect(evaluatePolicy({ kind: "compiled", compiled: honest }, ctx()).allowed).toBe(true);
    expect(codes(evaluatePolicy({ kind: "compiled", compiled: forged }, ctx()))).toEqual(["LEVERAGE_EXCEEDED"]);
  });

  it("guardian preset excludes the cancel-all dead-man's switch and bounds stop distance", () => {
    const g = createGuardianPolicy({ builder: BUILDER, allowedCoins: ["BTC"], maxOrderNotionalUsd: 1, maxDailyNotionalUsd: 1 });
    expect(g.allowedActionTypes).not.toContain("scheduleCancel");
    expect(g.maxStopLossDistancePct).toBe(25);
  });
});

describe("signed policies, format 3 (agent mandate)", () => {
  const user = privateKeyToAccount(generatePrivateKey());
  const agentPolicy: Policy = parsePolicy({
    version: 1,
    allowedActionTypes: ["order", "cancel", "cancelByCloid", "updateLeverage"],
    allowedCoins: ["BTC", "ETH"],
    maxOrderNotionalUsd: 1_000,
    maxDailyNotionalUsd: 5_000,
    maxDailyLossUsd: 200,
    maxLeverage: 5,
    requireStopLossForNewEntries: true,
    maxOrdersPerMinute: 20,
    priceBandPct: 2,
    allowedVaultAddresses: [],
    requiredBuilder: BUILDER,
    maxExpiresAfterWindowMs: null,
    allowedOrigins: ["agent"],
  });
  const mandate: AgentMandate = {
    agentId: `0x${"ab".repeat(32)}`,
    agentName: "Trend-1",
    agentAccount: "0x3333333333333333333333333333333333333333",
    askAboveUsd: "210",
    maxOpenNotionalUsd: "1000",
    maxConcurrentPositions: 3,
    maxEntriesPerDay: 20,
    cooldownLosses: 0,
    cooldownMinutes: 0,
    tradingWindows: "*",
    reduceOnlyAfter: "never",
  };
  const base = { user: user.address, network: "Testnet" as const, chainId: 421614, issuedAt: NOW, expiresAt: NOW + 30 * 86_400_000, nonce: 1 };
  const at = { now: NOW + 1 };

  it("signs and verifies an agent mandate, and binds every agent field", async () => {
    const { authorization, typedData } = prepareAgentPolicySignature(agentPolicy, { ...base, mandate });
    expect(authorization.typedDataVersion).toBe(3);
    expect(authorization.agentMandate).toEqual(mandate);
    expect(typedData.domain).toEqual({ name: "Kokoah Policy", version: "3", chainId: 421614 });
    expect(typedData.types.KokoahPolicy).toEqual(POLICY_EIP712_TYPES_V3.KokoahPolicy);
    expect(Object.keys(typedData.message)).toEqual(POLICY_EIP712_TYPES_V3.KokoahPolicy.map((f) => f.name));
    expect(typedData.message).toMatchObject({
      allowedOrigins: "agent",
      allowedSubAccounts: "none",
      canWithdrawOrTransfer: false,
      referralCode: "none",
      agentId: `0x${"ab".repeat(32)}`,
      agentName: "Trend-1",
      agentAccount: "0x3333333333333333333333333333333333333333",
      askAboveUsd: "210",
      maxOpenNotionalUsd: "1000",
      maxConcurrentPositions: 3,
      maxEntriesPerDay: 20,
      cooldownLosses: 0,
      cooldownMinutes: 0,
      tradingWindows: "*",
      reduceOnlyAfter: "never",
    });
    const signature = await user.signTypedData(typedData);
    const signed = { policy: agentPolicy, authorization, signature };
    expect(await verifyPolicySignature(signed, at)).toBe(true);
    expect((await recoverPolicySigner(signed)).toLowerCase()).toBe(user.address.toLowerCase());
    // Tampering with any agent field breaks the signature (it is bound directly, not only through policyHash).
    const tampered = { ...authorization, agentMandate: { ...mandate, askAboveUsd: "100000" } };
    expect(await verifyPolicySignature({ ...signed, authorization: tampered }, at)).toBe(false);
    // The same signature claimed as format 2 recovers someone else.
    expect(await verifyPolicySignature({ ...signed, authorization: { ...authorization, typedDataVersion: 2 } }, at)).toBe(false);
  });

  it("golden: format 3's type and digest are pinned (the extension decoder matches them exactly)", () => {
    const td = buildPolicyTypedData(agentPolicy, {
      user: "0x3333333333333333333333333333333333333333",
      network: "Testnet",
      chainId: 421614,
      issuedAt: 1_790_000_000_000,
      expiresAt: 1_790_000_000_000 + 86_400_000,
      nonce: 7,
      typedDataVersion: 3,
      agentMandate: mandate,
    });
    expect(POLICY_EIP712_TYPES_V3.KokoahPolicy).toHaveLength(39);
    expect(hashPolicy(agentPolicy)).toBe("0x94eb38795827338bbbc5524d573cc776cd60be403b43392475d7f70c3adcfc53");
    expect(hashTypedData(td)).toBe("0xff09c8e5d95ec70c609f73de1214086d344a13a89063a70dc03cac83ffe39376");
  });

  it("lists the readable fields: format 3 shows every format-2 field plus the agent mandate", () => {
    const fields = policyTypedDataFields(3);
    expect(fields.map(({ name, type }) => ({ name, type }))).toEqual(POLICY_EIP712_TYPES_V3.KokoahPolicy);
    const agentShown = Object.fromEntries(fields.filter((f) => f.shows.length === 1).map((f) => [f.name, f.shows[0]]));
    for (const k of ["agentId", "agentName", "agentAccount", "askAboveUsd", "maxOpenNotionalUsd", "maxConcurrentPositions", "maxEntriesPerDay", "cooldownLosses", "cooldownMinutes", "tradingWindows", "reduceOnlyAfter"]) {
      expect(agentShown[k]).toBe(k);
    }
  });

  it("refuses a policy or mandate that is not a valid agent card", () => {
    expect(agentPolicyProblems(agentPolicy, mandate)).toEqual([]);
    const bad: Array<[Partial<Policy> | null, Partial<AgentMandate> | null, RegExp]> = [
      [{ allowedOrigins: ["agent", "bot"] }, null, /allowedOrigins must be exactly/],
      [{ allowedOrigins: undefined }, null, /allowedOrigins must be exactly/],
      [{ allowedVaultAddresses: ["0x2222222222222222222222222222222222222222"] }, null, /no sub-accounts/],
      [{ maxDailyLossUsd: undefined }, null, /maxDailyLossUsd is required/],
      [{ requireStopLossForNewEntries: false }, null, /requireStopLossForNewEntries must be true/],
      [{ referralCode: "KOKOAH" }, null, /no referralCode/],
      [null, { agentId: "0x00" }, /agentId must be a non-zero/],
      [null, { agentId: `0x${"00".repeat(32)}` }, /agentId must be a non-zero/],
      [null, { agentAccount: "0x12" }, /agentAccount must be/],
      [null, { agentName: "" }, /agentName must be/],
      [null, { agentName: "x".repeat(41) }, /agentName must be/],
      [null, { agentName: "bad​name" }, /agentName must be/],
      [null, { askAboveUsd: "-5" }, /askAboveUsd must be/],
      [null, { maxOpenNotionalUsd: "0" }, /maxOpenNotionalUsd must be/],
      [null, { cooldownLosses: 3, cooldownMinutes: 0 }, /both 0 .*or both set/],
      [null, { cooldownLosses: 0, cooldownMinutes: 30 }, /both 0 .*or both set/],
      [null, { maxEntriesPerDay: -1 }, /maxEntriesPerDay must be/],
      [null, { tradingWindows: "mon-fri@13:00-21:00" }, /tradingWindows must be/],
      [null, { reduceOnlyAfter: "2026-01-01T00:00:00Z" }, /reduceOnlyAfter must be/],
    ];
    for (const [pp, mm, re] of bad) {
      const p = pp ? parsePolicy({ ...agentPolicy, ...pp }) : agentPolicy;
      const m = mm ? { ...mandate, ...mm } : mandate;
      const problems = agentPolicyProblems(p, m);
      expect(problems.some((x) => re.test(x)), `${re} in ${JSON.stringify(problems)}`).toBe(true);
    }
    expect(() => prepareAgentPolicySignature(agentPolicy, { ...base, mandate: { ...mandate, reduceOnlyAfter: "soon" } })).toThrow(AgentPolicyValidationError);
    expect(() => prepareAgentPolicySignature(parsePolicy({ ...agentPolicy, maxDailyLossUsd: undefined }), { ...base, mandate })).toThrow(/maxDailyLossUsd is required/);
  });
});
