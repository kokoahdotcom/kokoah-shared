/**
 * Signed policies: the user signs their automation limits with the main wallet (EIP-712), and servers verify the
 * signature before honouring the policy (FRONTEND_SPEC §14.3 "the limits are signed by the user").
 *
 * The typed data shows each limit in readable form in the wallet; `policyHash` commits to the full canonical policy
 * (including fields not shown, such as vault addresses and the expiresAfter window).
 *
 * @module
 */
import { keccak256, recoverTypedDataAddress, stringToBytes } from "viem";
import { normalizeDecimal } from "../precision/index.js";
import { type Policy, type PolicyInput, parsePolicy, POLICY_VERSION } from "./schema.js";

/** Canonical JSON of a policy (sorted keys, sorted and de-duplicated lists) — the preimage of {@link hashPolicy}. */
export function canonicalPolicyJson(policyInput: PolicyInput | Policy): string {
  const p = parsePolicy(policyInput);
  const normalized = {
    ...p,
    allowedActionTypes: [...new Set(p.allowedActionTypes)].sort(),
    allowedCoins: p.allowedCoins === "*" ? "*" : [...new Set(p.allowedCoins)].sort(),
    allowedVaultAddresses: [...new Set(p.allowedVaultAddresses.map((a) => a.toLowerCase()))].sort(),
    ...(p.allowedOrigins ? { allowedOrigins: [...new Set(p.allowedOrigins)].sort() } : {}),
    ...(p.allowedSpotCoins ? { allowedSpotCoins: [...new Set(p.allowedSpotCoins)].sort() } : {}),
  };
  return stableStringify(normalized);
}

/** keccak256 of {@link canonicalPolicyJson}. */
export function hashPolicy(policy: PolicyInput | Policy): `0x${string}` {
  return keccak256(stringToBytes(canonicalPolicyJson(policy)));
}

/** EIP-712 domain name for Kokoah policies. */
export const POLICY_DOMAIN_NAME = "Kokoah Policy";

/** EIP-712 types of a policy authorization. */
export const POLICY_EIP712_TYPES = {
  KokoahPolicy: [
    { name: "user", type: "address" },
    { name: "agent", type: "address" },
    { name: "network", type: "string" },
    { name: "allowedActions", type: "string" },
    { name: "allowedMarkets", type: "string" },
    { name: "maxOrderNotionalUsd", type: "string" },
    { name: "maxDailyNotionalUsd", type: "string" },
    { name: "maxLeverage", type: "uint32" },
    { name: "stopLossRequired", type: "bool" },
    { name: "maxOrdersPerMinute", type: "uint32" },
    { name: "priceBandPct", type: "string" },
    { name: "builder", type: "address" },
    { name: "builderFeeTenthsBps", type: "uint32" },
    { name: "canWithdrawOrTransfer", type: "bool" },
    { name: "policyHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

/** Who and what a policy signature authorizes. */
export interface PolicyAuthorization {
  /** Main wallet (the signer). */
  user: `0x${string}`;
  /** Agent key the policy governs; omitted/zero address = any Kokoah key of this user. */
  agent?: `0x${string}`;
  network: "Mainnet" | "Testnet";
  /** EIP-712 domain chain id; use the wallet's connected chain. */
  chainId: number;
  issuedAt: number;
  expiresAt: number;
  nonce: number;
}

/** A policy plus its authorization and signature (65-byte hex). */
export interface SignedPolicy {
  policy: PolicyInput | Policy;
  authorization: PolicyAuthorization;
  signature: `0x${string}`;
}

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/** Builds the EIP-712 typed data a user signs for a policy (viem/wagmi `signTypedData` shape). */
export function buildPolicyTypedData(policyInput: PolicyInput | Policy, auth: PolicyAuthorization) {
  const policy = parsePolicy(policyInput);
  if (!(auth.expiresAt > auth.issuedAt)) throw new RangeError("expiresAt must be after issuedAt");
  if (!/^0x[0-9a-fA-F]{40}$/.test(auth.user)) throw new RangeError("user must be a 20-byte hex address");
  if (auth.agent !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(auth.agent)) throw new RangeError("agent must be a 20-byte hex address");
  if (!Number.isSafeInteger(auth.chainId) || auth.chainId <= 0) throw new RangeError("chainId must be a positive integer");
  return {
    domain: { name: POLICY_DOMAIN_NAME, version: String(POLICY_VERSION), chainId: auth.chainId },
    types: { KokoahPolicy: POLICY_EIP712_TYPES.KokoahPolicy.map((f) => ({ name: f.name, type: f.type })) },
    primaryType: "KokoahPolicy" as const,
    message: {
      user: auth.user.toLowerCase() as `0x${string}`,
      agent: (auth.agent ?? ZERO).toLowerCase() as `0x${string}`,
      network: auth.network,
      allowedActions: [...new Set(policy.allowedActionTypes)].sort().join(","),
      allowedMarkets: policy.allowedCoins === "*" ? "*" : [...new Set(policy.allowedCoins)].sort().join(","),
      maxOrderNotionalUsd: normalizeDecimal(policy.maxOrderNotionalUsd),
      maxDailyNotionalUsd: normalizeDecimal(policy.maxDailyNotionalUsd),
      maxLeverage: policy.maxLeverage,
      stopLossRequired: policy.requireStopLossForNewEntries,
      maxOrdersPerMinute: policy.maxOrdersPerMinute,
      priceBandPct: normalizeDecimal(policy.priceBandPct),
      builder: (policy.requiredBuilder?.b ?? ZERO) as `0x${string}`,
      builderFeeTenthsBps: policy.requiredBuilder?.f ?? 0,
      canWithdrawOrTransfer: false,
      policyHash: hashPolicy(policy),
      issuedAt: auth.issuedAt,
      expiresAt: auth.expiresAt,
      nonce: auth.nonce,
    },
  };
}

/** Recovers the address that signed a policy authorization. */
export async function recoverPolicySigner(signed: SignedPolicy): Promise<`0x${string}`> {
  const td = buildPolicyTypedData(signed.policy, signed.authorization);
  return await recoverTypedDataAddress({ ...td, signature: signed.signature });
}

/**
 * Verifies that `signed.signature` is the user's EIP-712 signature over this exact policy and authorization
 * (EOA signatures; smart-contract wallets need ERC-1271 verification, not provided here). Returns false on any
 * mismatch or malformed input, and unless `ignoreExpiry` is set, when not `issuedAt ≤ now < expiresAt`
 * (`now` defaults to `Date.now()`).
 */
export async function verifyPolicySignature(
  signed: SignedPolicy,
  options: {
    now?: number;
    ignoreExpiry?: boolean;
    /**
     * Tolerance for `issuedAt` being ahead of `now` (device clocks run fast). Default 0 (strict, 0.1.0 behaviour).
     * Services should pass e.g. 300_000 (5 minutes). Never applied to `expiresAt`.
     */
    clockSkewMs?: number;
  } = {},
): Promise<boolean> {
  try {
    const a = signed.authorization;
    const now = options.now ?? Date.now();
    const skew = Math.max(0, options.clockSkewMs ?? 0);
    if (!options.ignoreExpiry && !(now + skew >= a.issuedAt && now < a.expiresAt)) return false;
    const signer = await recoverPolicySigner(signed);
    return signer.toLowerCase() === a.user.toLowerCase();
  } catch {
    return false;
  }
}

/** Short human-readable summary of a policy (for UIs and logs). */
export function summarizePolicy(policyInput: PolicyInput | Policy): string {
  const p = parsePolicy(policyInput);
  const usd = (x: number) => (Math.round(x * 100) / 100).toString();
  return [
    `actions: ${p.allowedActionTypes.join(", ")}`,
    `markets: ${p.allowedCoins === "*" ? "all" : p.allowedCoins.join(", ")}`,
    `max order $${usd(p.maxOrderNotionalUsd)}`,
    `max daily $${usd(p.maxDailyNotionalUsd)}`,
    `max leverage ${p.maxLeverage}x`,
    p.requireStopLossForNewEntries ? "stop-loss required on entries" : "stop-loss optional",
    `max ${p.maxOrdersPerMinute} orders/min`,
    `price band ${p.priceBandPct}%`,
    p.requiredBuilder ? `builder ${p.requiredBuilder.b} (${p.requiredBuilder.f / 10} bps)` : "no builder requirement",
    ...(p.allowedSpotCoins?.length ? [`spot conversions: ${[...p.allowedSpotCoins].sort().join(", ")}`] : []),
    ...(p.referralCode !== undefined ? [`referral code ${p.referralCode} only`] : []),
    "cannot withdraw or transfer",
  ].join("; ");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableStringify(x)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
