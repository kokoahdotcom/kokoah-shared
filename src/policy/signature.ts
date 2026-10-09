/**
 * Signed policies: the user signs their automation limits with the main wallet (EIP-712), and servers verify the
 * signature before honouring the policy (FRONTEND_SPEC §14.3 "the limits are signed by the user").
 *
 * The typed data shows the limits in readable form in the wallet, and `policyHash` commits to the full canonical policy.
 * Two formats exist, named by the authorization's `typedDataVersion` (the EIP-712 domain version, so the signature binds
 * it): format 2 shows every policy field readably and is what new signatures use; format 1, the original, shows the
 * common limits and binds the rest (sub-accounts, origins, the daily loss limit, stop-loss exceptions, spot, the
 * referral code…) only through `policyHash`. Policies signed in format 1 keep verifying. The policy and its hash are the
 * same in both.
 *
 * @module
 */
import { keccak256, recoverTypedDataAddress, stringToBytes } from "viem";
import { normalizeDecimal } from "../precision/index.js";
import { type Policy, type PolicyInput, parsePolicy } from "./schema.js";

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

/**
 * EIP-712 types of a policy authorization in format 1 (domain version "1"), the original: sub-accounts, origins, the
 * daily loss limit, stop-loss exceptions, spot, the referral code and the expiresAfter window are only in `policyHash`.
 * Kept for policies already signed; new signatures use {@link POLICY_EIP712_TYPES_V2}.
 */
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

/**
 * EIP-712 types of a policy authorization in format 2 (domain version "2"): every policy field in readable form, plus
 * `policyHash` as before. Lists are sorted and comma-separated; "*" means all and "none" means none. A limit that is not
 * set reads "unlimited". Decimals are plain decimal strings, as in format 1.
 */
export const POLICY_EIP712_TYPES_V2 = {
  KokoahPolicy: [
    { name: "user", type: "address" },
    { name: "agent", type: "address" },
    { name: "network", type: "string" },
    { name: "allowedActions", type: "string" },
    { name: "allowedMarkets", type: "string" },
    { name: "allowedOrigins", type: "string" },
    { name: "allowedSubAccounts", type: "string" },
    { name: "maxOrderNotionalUsd", type: "string" },
    { name: "maxDailyNotionalUsd", type: "string" },
    { name: "reduceOnlyExemptFromCaps", type: "bool" },
    { name: "maxDailyLossUsd", type: "string" },
    { name: "maxLeverage", type: "uint32" },
    { name: "stopLossRequired", type: "bool" },
    { name: "maxStopLossDistancePct", type: "string" },
    { name: "botsWithoutStopLoss", type: "bool" },
    { name: "maxOrdersPerMinute", type: "uint32" },
    { name: "priceBandPct", type: "string" },
    { name: "maxActionLifetimeMs", type: "string" },
    { name: "allowedSpotPairs", type: "string" },
    { name: "spotTrading", type: "bool" },
    { name: "referralCode", type: "string" },
    { name: "builder", type: "address" },
    { name: "builderFeeTenthsBps", type: "uint32" },
    { name: "canWithdrawOrTransfer", type: "bool" },
    { name: "policyHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

/** Typed-data format of a policy signature: 1 (the original) or 2 (every policy field readable). */
export type PolicyTypedDataVersion = 1 | 2;

/** The typed-data format new policy signatures use ({@link preparePolicySignature}). */
export const POLICY_TYPED_DATA_VERSION = 2;

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
  /**
   * Typed-data format the user signed (the EIP-712 domain version, so the signature binds it). Omitted means 1, the
   * original format; new signatures use {@link POLICY_TYPED_DATA_VERSION} (2), which shows every policy field.
   */
  typedDataVersion?: PolicyTypedDataVersion;
}

/** A policy plus its authorization and signature (65-byte hex). */
export interface SignedPolicy {
  policy: PolicyInput | Policy;
  authorization: PolicyAuthorization;
  signature: `0x${string}`;
}

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/** The message of a policy's typed data: format 1's fields, and in format 2 also the rest of the policy. */
export type PolicyTypedDataMessage = {
  user: `0x${string}`;
  agent: `0x${string}`;
  network: "Mainnet" | "Testnet";
  allowedActions: string;
  allowedMarkets: string;
  maxOrderNotionalUsd: string;
  maxDailyNotionalUsd: string;
  maxLeverage: number;
  stopLossRequired: boolean;
  maxOrdersPerMinute: number;
  priceBandPct: string;
  builder: `0x${string}`;
  builderFeeTenthsBps: number;
  canWithdrawOrTransfer: boolean;
  policyHash: `0x${string}`;
  issuedAt: number;
  expiresAt: number;
  nonce: number;
} & Partial<{
  allowedOrigins: string;
  allowedSubAccounts: string;
  reduceOnlyExemptFromCaps: boolean;
  maxDailyLossUsd: string;
  maxStopLossDistancePct: string;
  botsWithoutStopLoss: boolean;
  maxActionLifetimeMs: string;
  allowedSpotPairs: string;
  spotTrading: boolean;
  referralCode: string;
}>;

/** The typed-data format an authorization names (omitted: 1); throws a RangeError for anything else. */
export function policyTypedDataVersion(auth: Pick<PolicyAuthorization, "typedDataVersion">): PolicyTypedDataVersion {
  const version = auth.typedDataVersion ?? 1;
  if (version !== 1 && version !== 2) throw new RangeError("typedDataVersion must be 1 or 2");
  return version;
}

/**
 * Builds the EIP-712 typed data a user signs for a policy (viem/wagmi `signTypedData` shape), in the format the
 * authorization names (`typedDataVersion`; omitted: 1, the original). Verifiers rebuild it from the stored
 * authorization; for a new signature, {@link preparePolicySignature} picks the current format.
 */
export function buildPolicyTypedData(policyInput: PolicyInput | Policy, auth: PolicyAuthorization) {
  const policy = parsePolicy(policyInput);
  const version = policyTypedDataVersion(auth);
  if (!(auth.expiresAt > auth.issuedAt)) throw new RangeError("expiresAt must be after issuedAt");
  if (!/^0x[0-9a-fA-F]{40}$/.test(auth.user)) throw new RangeError("user must be a 20-byte hex address");
  if (auth.agent !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(auth.agent)) throw new RangeError("agent must be a 20-byte hex address");
  if (!Number.isSafeInteger(auth.chainId) || auth.chainId <= 0) throw new RangeError("chainId must be a positive integer");
  const fields = version === 1 ? POLICY_EIP712_TYPES.KokoahPolicy : POLICY_EIP712_TYPES_V2.KokoahPolicy;
  const common = {
    user: auth.user.toLowerCase() as `0x${string}`,
    agent: (auth.agent ?? ZERO).toLowerCase() as `0x${string}`,
    network: auth.network,
    allowedActions: [...new Set(policy.allowedActionTypes)].sort().join(","),
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
  };
  const message: PolicyTypedDataMessage =
    version === 1
      ? { ...common, allowedMarkets: policy.allowedCoins === "*" ? "*" : [...new Set(policy.allowedCoins)].sort().join(",") }
      : {
          ...common,
          allowedMarkets: policy.allowedCoins === "*" ? "*" : readableList(policy.allowedCoins, "allowedCoins"),
          allowedOrigins: policy.allowedOrigins === undefined ? "*" : readableList(policy.allowedOrigins, "allowedOrigins"),
          allowedSubAccounts: readableList(
            policy.allowedVaultAddresses.map((a) => a.toLowerCase()),
            "allowedVaultAddresses",
          ),
          reduceOnlyExemptFromCaps: policy.exemptReduceOnlyFromNotionalCaps,
          maxDailyLossUsd: policy.maxDailyLossUsd === undefined ? UNLIMITED : normalizeDecimal(policy.maxDailyLossUsd),
          maxStopLossDistancePct: policy.maxStopLossDistancePct === undefined ? UNLIMITED : normalizeDecimal(policy.maxStopLossDistancePct),
          botsWithoutStopLoss: policy.botEntriesWithoutStopLoss === true,
          maxActionLifetimeMs: policy.maxExpiresAfterWindowMs === null ? UNLIMITED : String(policy.maxExpiresAfterWindowMs),
          allowedSpotPairs: readableList(policy.allowedSpotCoins ?? [], "allowedSpotCoins"),
          spotTrading: policy.spotTrading === true,
          referralCode: readableReferralCode(policy.referralCode),
        };
  return {
    domain: { name: POLICY_DOMAIN_NAME, version: String(version), chainId: auth.chainId },
    types: { KokoahPolicy: fields.map((f): { name: string; type: string } => ({ name: f.name, type: f.type })) },
    primaryType: "KokoahPolicy" as const,
    // In the order of the type, as wallets that show the message raw list it.
    message: Object.fromEntries(fields.map((f) => [f.name, message[f.name]])) as PolicyTypedDataMessage,
  };
}

/**
 * Starts a new policy signature in the current format: the authorization with `typedDataVersion` set
 * ({@link POLICY_TYPED_DATA_VERSION} unless it names one) and its typed data. Sign `typedData` with the main wallet and
 * send `authorization` with the policy and the signature.
 */
export function preparePolicySignature(policyInput: PolicyInput | Policy, auth: PolicyAuthorization) {
  const authorization: PolicyAuthorization = { ...auth, typedDataVersion: auth.typedDataVersion ?? POLICY_TYPED_DATA_VERSION };
  return { authorization, typedData: buildPolicyTypedData(policyInput, authorization) };
}

/** A policy or authorization field, as {@link policyTypedDataFields} names what a typed-data field shows. */
export type PolicyFieldName = Exclude<keyof Policy, "version"> | Exclude<keyof PolicyAuthorization, "chainId" | "typedDataVersion">;

/** A field of the policy typed data: its EIP-712 name and type, and the policy or authorization fields it shows. */
export interface PolicyTypedDataField {
  name: string;
  type: string;
  /** Empty for `canWithdrawOrTransfer` (always false) and `policyHash` (the whole policy, not readable). */
  shows: readonly PolicyFieldName[];
}

const SHOWS: Record<(typeof POLICY_EIP712_TYPES_V2.KokoahPolicy)[number]["name"], readonly PolicyFieldName[]> = {
  user: ["user"],
  agent: ["agent"],
  network: ["network"],
  allowedActions: ["allowedActionTypes"],
  allowedMarkets: ["allowedCoins"],
  allowedOrigins: ["allowedOrigins"],
  allowedSubAccounts: ["allowedVaultAddresses"],
  maxOrderNotionalUsd: ["maxOrderNotionalUsd"],
  maxDailyNotionalUsd: ["maxDailyNotionalUsd"],
  reduceOnlyExemptFromCaps: ["exemptReduceOnlyFromNotionalCaps"],
  maxDailyLossUsd: ["maxDailyLossUsd"],
  maxLeverage: ["maxLeverage"],
  stopLossRequired: ["requireStopLossForNewEntries"],
  maxStopLossDistancePct: ["maxStopLossDistancePct"],
  botsWithoutStopLoss: ["botEntriesWithoutStopLoss"],
  maxOrdersPerMinute: ["maxOrdersPerMinute"],
  priceBandPct: ["priceBandPct"],
  maxActionLifetimeMs: ["maxExpiresAfterWindowMs"],
  allowedSpotPairs: ["allowedSpotCoins"],
  spotTrading: ["spotTrading"],
  referralCode: ["referralCode"],
  builder: ["requiredBuilder"],
  builderFeeTenthsBps: ["requiredBuilder"],
  canWithdrawOrTransfer: [],
  policyHash: [],
  issuedAt: ["issuedAt"],
  expiresAt: ["expiresAt"],
  nonce: ["nonce"],
};

/**
 * The fields a wallet shows for a policy signature in the given format (default: the current one), in order, with the
 * policy and authorization fields each one shows. Policy fields no entry shows are bound only through `policyHash`:
 * in format 2 there are none.
 */
export function policyTypedDataFields(version: PolicyTypedDataVersion = POLICY_TYPED_DATA_VERSION): PolicyTypedDataField[] {
  const fields = version === 1 ? POLICY_EIP712_TYPES.KokoahPolicy : POLICY_EIP712_TYPES_V2.KokoahPolicy;
  return fields.map((f) => ({ name: f.name, type: f.type, shows: SHOWS[f.name] }));
}

/** Format 2's word for a limit that is not set. */
const UNLIMITED = "unlimited";
/** Format 2's word for an empty list or no referral code. */
const NONE = "none";

/**
 * A list as format 2 shows it: de-duplicated, sorted, comma-separated, or "none" when empty. Refuses an item that
 * would read as something else (a comma, "*" or "none"), so every value reads one way.
 */
function readableList(items: readonly string[], field: string): string {
  const sorted = [...new Set(items)].sort();
  const ambiguous = sorted.find((x) => x.includes(",") || x === "*" || x.toLowerCase() === NONE);
  if (ambiguous !== undefined) throw new RangeError(`${field} has an entry that can't be shown unambiguously: ${JSON.stringify(ambiguous)}`);
  return sorted.length === 0 ? NONE : sorted.join(",");
}

function readableReferralCode(code: string | undefined): string {
  if (code === undefined) return NONE;
  if (code.toLowerCase() === NONE) throw new RangeError(`referralCode can't be shown unambiguously: ${JSON.stringify(code)}`);
  return code;
}

/** Recovers the address that signed a policy authorization (in the typed-data format it names). */
export async function recoverPolicySigner(signed: SignedPolicy): Promise<`0x${string}`> {
  const td = buildPolicyTypedData(signed.policy, signed.authorization);
  return await recoverTypedDataAddress({ ...td, signature: signed.signature });
}

/**
 * Verifies that `signed.signature` is the user's EIP-712 signature over this exact policy and authorization, in the
 * typed-data format the authorization names (`typedDataVersion`; omitted: 1), so policies signed in either format verify
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
    ...(p.maxDailyLossUsd !== undefined ? [`max daily loss $${usd(p.maxDailyLossUsd)}`] : []),
    `max leverage ${p.maxLeverage}x`,
    p.requireStopLossForNewEntries ? `stop-loss required on entries${p.botEntriesWithoutStopLoss ? " (bots exempt)" : ""}` : "stop-loss optional",
    ...(p.allowedOrigins ? [`origins: ${[...new Set(p.allowedOrigins)].sort().join(", ")}`] : []),
    `max ${p.maxOrdersPerMinute} orders/min`,
    `price band ${p.priceBandPct}%`,
    p.requiredBuilder ? `builder ${p.requiredBuilder.b} (up to ${p.requiredBuilder.f / 10} bps)` : "no builder requirement",
    ...(p.allowedSpotCoins?.length ? [`spot ${p.spotTrading ? "trading" : "conversions"}: ${[...p.allowedSpotCoins].sort().join(", ")}`] : []),
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
