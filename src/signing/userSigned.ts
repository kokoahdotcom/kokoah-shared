/**
 * User-signed actions (main wallet only): `approveAgent`, `approveBuilderFee`, `withdraw3`, …
 *
 * Scheme (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing, Python SDK
 * `sign_user_signed_action`): EIP-712 domain `{name:"HyperliquidSignTransaction", version:"1",
 * chainId: signatureChainId, verifyingContract: 0x0}`, primary type `HyperliquidTransaction:<Name>`; the message
 * includes `hyperliquidChain: "Mainnet" | "Testnet"` (replay protection) and the action's `nonce`/`time`, which must
 * equal the request nonce. `signatureChainId` may be any chain; wallets prefer the chain they are connected to.
 *
 * The builders here return both the **typed data** (for `walletClient.signTypedData` / wagmi `useSignTypedData`) and
 * the **action** to post, derived from one set of inputs so they cannot drift apart. Types come from the SDK
 * (`ApproveAgentTypes`, `ApproveBuilderFeeTypes`, `Withdraw3Types`, `SendAssetTypes`, `UserSetAbstractionTypes`).
 * HYPE staking is in `staking.ts`, so apps load it only where they stake.
 *
 * @module
 */
import {
  ApproveAgentRequest,
  ApproveAgentTypes,
  ApproveBuilderFeeRequest,
  ApproveBuilderFeeTypes,
  SendAssetRequest,
  SendAssetTypes,
  UserSetAbstractionRequest,
  UserSetAbstractionTypes,
  Withdraw3Request,
  Withdraw3Types,
} from "@nktkas/hyperliquid/api/exchange";
import { type AbstractWallet, canonicalize, type Signature, signUserSignedAction as sdkSignUserSignedAction } from "@nktkas/hyperliquid/signing";
import * as v from "valibot";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import type { NetworkConfig } from "../network/index.js";
import { normalizeDecimal, toNumber } from "../precision/index.js";
import { MAX_PERP_BUILDER_FEE_TENTHS_BPS, tenthsBpsToPercentString } from "../risk/formulas.js";
import { signatureToHex, ZERO_ADDRESS } from "./l1.js";

/** EIP-712 field list. */
export type Eip712Fields = ReadonlyArray<{ readonly name: string; readonly type: string }>;
/** EIP-712 types object with a single primary type (as HL uses). */
export type Eip712Types = Readonly<Record<string, Eip712Fields>>;

/** Domain name of user-signed actions. */
export const USER_SIGNED_DOMAIN_NAME = "HyperliquidSignTransaction";

/** Typed data in the shape viem/wagmi `signTypedData` accept. `nonce`/`time` stay numbers (JSON-safe). */
export interface UserSignedTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** A user-signed action ready to sign (typed data) and to post (action). */
export interface PreparedUserSignedAction<A extends Record<string, unknown> = Record<string, unknown>> {
  /** JSON action to post as `action` (with `nonce` equal to the request nonce). */
  action: A;
  /** Typed data to sign with the main wallet. */
  typedData: UserSignedTypedData;
  /** Request nonce (equals the action's `nonce`/`time`). */
  nonce: number;
}

/** Network selector for user-signed actions. */
export type UserSignedNetwork = Pick<NetworkConfig, "hyperliquidChain" | "defaultSignatureChainId">;

/** Builds EIP-712 typed data for any user-signed action (`action` must contain `signatureChainId`). */
export function userSignedTypedData(action: { signatureChainId: `0x${string}` } & Record<string, unknown>, types: Eip712Types): UserSignedTypedData {
  const primaryType = Object.keys(types)[0];
  if (primaryType === undefined) throw new RangeError("EIP-712 types must have a primary type");
  const fields = types[primaryType] as Eip712Fields;
  const message: Record<string, unknown> = {};
  for (const f of fields) {
    if (!(f.name in action)) throw new RangeError(`Action is missing EIP-712 field "${f.name}"`);
    message[f.name] = action[f.name];
  }
  return {
    domain: { name: USER_SIGNED_DOMAIN_NAME, version: "1", chainId: parseInt(action.signatureChainId, 16), verifyingContract: ZERO_ADDRESS },
    types: { [primaryType]: fields.map((f) => ({ name: f.name, type: f.type })) },
    primaryType,
    message,
  };
}

/** EIP-712 digest of a user-signed action (for raw-digest signers). */
export function userSignedDigest(typedData: UserSignedTypedData): `0x${string}` {
  return hashTypedData(typedData as Parameters<typeof hashTypedData>[0]);
}

/** Signs a user-signed action with a local/abstract wallet (delegates to the SDK). */
export async function signUserSignedAction(params: {
  wallet: AbstractWallet;
  action: { signatureChainId: `0x${string}` } & Record<string, unknown>;
  types: Eip712Types;
}): Promise<Signature> {
  return await sdkSignUserSignedAction({ wallet: params.wallet, action: params.action, types: params.types as Record<string, Eip712Fields> });
}

/** Recovers the signer of a user-signed action. */
export async function recoverUserSignedSigner(params: { typedData: UserSignedTypedData; signature: Signature }): Promise<`0x${string}`> {
  return await recoverTypedDataAddress({
    ...(params.typedData as Parameters<typeof hashTypedData>[0]),
    signature: signatureToHex(params.signature),
  });
}

// ---------------------------------------------------------------------------------------------
// approveAgent
// ---------------------------------------------------------------------------------------------

/** HL caps `valid_until` at 180 days in the future (exchange endpoint docs). */
export const MAX_AGENT_VALIDITY_MS = 180 * 24 * 60 * 60 * 1000;
/** Max agent name length (HL UI and SDK schema; the `valid_until` suffix does not count). */
export const MAX_AGENT_NAME_LENGTH = 16;

/** `"<name> valid_until <ms>"`, the format HL parses for agent expiry. */
export function formatAgentName(name: string, validUntilMs?: number): string {
  validateAgentName(name);
  if (validUntilMs === undefined) return name;
  if (!Number.isSafeInteger(validUntilMs) || validUntilMs <= 0) throw new RangeError("validUntil must be a positive integer (ms)");
  return `${name} valid_until ${validUntilMs}`;
}

/** Splits `"<name> valid_until <ms>"` into name and expiry. */
export function parseAgentName(full: string): { name: string; validUntil?: number } {
  const m = /^(.*) valid_until (\d+)$/.exec(full);
  return m ? { name: m[1] as string, validUntil: Number(m[2]) } : { name: full };
}

function validateAgentName(name: string): void {
  if (name.length === 0) throw new RangeError("Agent name must not be empty (Kokoah only uses named agents)");
  if (name.length > MAX_AGENT_NAME_LENGTH) throw new RangeError(`Agent name must be at most ${MAX_AGENT_NAME_LENGTH} characters`);
  if (/valid_until/.test(name)) throw new RangeError('Agent name must not contain "valid_until"');
}

/** Parameters for {@link buildApproveAgent}. */
export interface ApproveAgentParams {
  /** The new agent's address (generate a fresh key; never reuse an agent address). */
  agentAddress: `0x${string}`;
  /** Agent name without the suffix, 1–16 chars, e.g. "kokoah-web". */
  agentName: string;
  /** Expiry in ms since epoch; must be in the future and at most 180 days after `now`. */
  validUntil: number;
  /** Nonce (ms); also used as `now` for the expiry checks unless `now` is given. */
  nonce: number;
  now?: number;
  network: UserSignedNetwork;
  /** EIP-712 chain id (hex). Default: the network's default. Prefer the main wallet's connected chain. */
  signatureChainId?: `0x${string}`;
}

/**
 * Builds a named `approveAgent` with a `valid_until` expiry, for the main wallet to sign in the browser.
 * Kokoah never uses the unnamed agent slot (HL's own app uses it and would de-register Kokoah's key).
 */
export function buildApproveAgent(params: ApproveAgentParams): PreparedUserSignedAction {
  if (!/^0x[0-9a-fA-F]{40}$/.test(params.agentAddress)) throw new RangeError("agentAddress must be a 20-byte hex address");
  const now = params.now ?? params.nonce;
  if (params.validUntil <= now) throw new RangeError("validUntil must be in the future");
  if (params.validUntil > now + MAX_AGENT_VALIDITY_MS) throw new RangeError("validUntil must be at most 180 days in the future");
  return prepareUserSigned(
    ApproveAgentRequest.entries.action,
    ApproveAgentTypes,
    {
      type: "approveAgent",
      agentAddress: params.agentAddress.toLowerCase(),
      agentName: formatAgentName(params.agentName, params.validUntil),
      nonce: params.nonce,
    },
    params,
  );
}

/**
 * Builds a revoke for a named agent: `approveAgent` with the same name and the zero address, which is how HL's app
 * removes an agent (research B §1.6; the zero address for named agents is inferred — verify with the testnet spike).
 */
export function buildRevokeAgent(params: { agentName: string; nonce: number; network: UserSignedNetwork; signatureChainId?: `0x${string}` }): PreparedUserSignedAction {
  return prepareUserSigned(
    ApproveAgentRequest.entries.action,
    ApproveAgentTypes,
    { type: "approveAgent", agentAddress: ZERO_ADDRESS, agentName: formatAgentName(params.agentName), nonce: params.nonce },
    params,
  );
}

// ---------------------------------------------------------------------------------------------
// approveBuilderFee
// ---------------------------------------------------------------------------------------------

/** Parameters for {@link buildApproveBuilderFee}. */
export interface ApproveBuilderFeeParams {
  builder: `0x${string}`;
  /** Max fee in tenths of a bp (100 = 0.1%, the perps cap). 0 revokes the approval. */
  maxFeeTenthsBps: number;
  nonce: number;
  network: UserSignedNetwork;
  signatureChainId?: `0x${string}`;
}

/**
 * Builds `approveBuilderFee` for the main wallet (`maxFeeRate` as a percent string, e.g. 100 → "0.1%").
 * A user may have at most 10 active builder approvals; 0 revokes (HL app behaviour, research B §4.3).
 */
export function buildApproveBuilderFee(params: ApproveBuilderFeeParams): PreparedUserSignedAction {
  if (!/^0x[0-9a-fA-F]{40}$/.test(params.builder)) throw new RangeError("builder must be a 20-byte hex address");
  if (!Number.isInteger(params.maxFeeTenthsBps) || params.maxFeeTenthsBps < 0 || params.maxFeeTenthsBps > MAX_PERP_BUILDER_FEE_TENTHS_BPS) {
    throw new RangeError(`maxFeeTenthsBps must be an integer between 0 and ${MAX_PERP_BUILDER_FEE_TENTHS_BPS} (0.1%)`);
  }
  return prepareUserSigned(
    ApproveBuilderFeeRequest.entries.action,
    ApproveBuilderFeeTypes,
    {
      type: "approveBuilderFee",
      maxFeeRate: tenthsBpsToPercentString(params.maxFeeTenthsBps),
      builder: params.builder.toLowerCase(),
      nonce: params.nonce,
    },
    params,
  );
}

// ---------------------------------------------------------------------------------------------
// withdraw3
// ---------------------------------------------------------------------------------------------

/**
 * Builds `withdraw3` (bridge withdrawal to Arbitrum) for the main wallet. `time` equals the nonce.
 * `amount` is normalized ("12.50" → "12.5"): the exact string is signed, so the posted action must carry the same one.
 */
export function buildWithdraw(params: {
  destination: `0x${string}`;
  amount: string | number;
  nonce: number;
  network: UserSignedNetwork;
  signatureChainId?: `0x${string}`;
}): PreparedUserSignedAction {
  if (!/^0x[0-9a-fA-F]{40}$/.test(params.destination)) throw new RangeError("destination must be a 20-byte hex address");
  return prepareUserSigned(
    Withdraw3Request.entries.action,
    Withdraw3Types,
    { type: "withdraw3", destination: params.destination.toLowerCase(), amount: normalizeDecimal(params.amount), time: params.nonce },
    params,
  );
}

// ---------------------------------------------------------------------------------------------
// sendAsset
// ---------------------------------------------------------------------------------------------

/** A perp dex name ("" = the first USDC perp dex), or "spot". HIP-3 dex names are short lowercase words. */
const DEX_NAME = /^(spot|[a-z0-9]{0,16})$/;
/** `tokenName:tokenId` as `sendAsset` expects it, e.g. "USDC:0x6d1e7cde53ba9467b783cb7c530ce054". */
const TOKEN_SPEC = /^([A-Za-z0-9]{1,20}):(0x[0-9a-fA-F]{32})$/;

/** Parameters for {@link buildSendAsset}. */
export interface SendAssetParams {
  /** The recipient's HyperCore address. */
  destination: `0x${string}`;
  /** Where the funds come from: "" (the first perp dex), a HIP-3 dex name, or "spot". */
  sourceDex: string;
  /** Where the recipient gets them: "" (the first perp dex), a HIP-3 dex name, or "spot". */
  destinationDex: string;
  /** `tokenName:tokenId` from `spotMeta` (e.g. "USDC:0x6d1e7cde53ba9467b783cb7c530ce054"). */
  token: string;
  /** Amount in token units (not wei); normalized, e.g. "25.50" → "25.5". Must be above zero. */
  amount: string | number;
  nonce: number;
  network: UserSignedNetwork;
  signatureChainId?: `0x${string}`;
  /**
   * Send from this sub-account of the signing master instead of the master itself (signed as `fromSubAccount`).
   * Omit for the main account (""). HL only accepts it when the signer is the sub-account's master.
   */
  fromSubAccount?: `0x${string}`;
}

/**
 * Builds `sendAsset` (HyperCore transfer to another address, `HyperliquidTransaction:SendAsset`) for the main wallet.
 * Every signed field is a readable string: destination, source and destination balance, token, amount and the
 * sub-account the funds leave from (`fromSubAccount`, "" for the main account). Refuses the zero address, and a
 * sub-account sending to itself.
 */
export function buildSendAsset(params: SendAssetParams): PreparedUserSignedAction {
  if (!/^0x[0-9a-fA-F]{40}$/.test(params.destination)) throw new RangeError("destination must be a 20-byte hex address");
  if (params.destination.toLowerCase() === ZERO_ADDRESS) throw new RangeError("destination must not be the zero address");
  const from = params.fromSubAccount;
  if (from !== undefined) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(from)) throw new RangeError("fromSubAccount must be a 20-byte hex address");
    if (from.toLowerCase() === ZERO_ADDRESS) throw new RangeError("fromSubAccount must not be the zero address");
    if (from.toLowerCase() === params.destination.toLowerCase()) throw new RangeError("fromSubAccount and destination must differ");
  }
  for (const [name, dex] of [
    ["sourceDex", params.sourceDex],
    ["destinationDex", params.destinationDex],
  ] as const) {
    if (!DEX_NAME.test(dex)) throw new RangeError(`${name} must be "", "spot" or a perp dex name`);
  }
  const token = TOKEN_SPEC.exec(params.token);
  if (!token) throw new RangeError('token must be "name:tokenId" (a 16-byte hex token id)');
  const amount = normalizeDecimal(params.amount);
  if (amount.startsWith("-") || !(toNumber(amount) > 0)) throw new RangeError("amount must be above zero");
  return prepareUserSigned(
    SendAssetRequest.entries.action,
    SendAssetTypes,
    {
      type: "sendAsset",
      destination: params.destination.toLowerCase(),
      sourceDex: params.sourceDex,
      destinationDex: params.destinationDex,
      token: `${token[1]}:${(token[2] as string).toLowerCase()}`,
      amount,
      fromSubAccount: from === undefined ? "" : from.toLowerCase(),
      nonce: params.nonce,
    },
    params,
  );
}

/** Parameters for {@link buildSubAccountTransfer}. */
export interface SubAccountTransferParams {
  /** The signing main wallet (the sub-account's master). */
  master: `0x${string}`;
  /** One of the master's sub-accounts (check it with `@kokoah/shared/subaccounts` before asking for a signature). */
  subAccount: `0x${string}`;
  /** `toSubAccount`: master → sub-account. `toMaster`: sub-account → master. */
  direction: "toSubAccount" | "toMaster";
  /** `tokenName:tokenId`, e.g. USDC from `spotMeta`. */
  token: string;
  amount: string | number;
  /** Balance moved on both sides: "" (the first perp dex, the default), a HIP-3 dex name, or "spot". */
  dex?: string;
  nonce: number;
  network: UserSignedNetwork;
  signatureChainId?: `0x${string}`;
}

/**
 * Moves funds between the main account and one of its sub-accounts in one readable `sendAsset` signed by the main
 * wallet: to the sub-account (`destination` = sub-account, `fromSubAccount` = "") or back to the main account
 * (`destination` = master, `fromSubAccount` = sub-account). Used instead of the opaque L1 `subAccountTransfer`, which
 * Kokoah never asks the main wallet to sign.
 */
export function buildSubAccountTransfer(params: SubAccountTransferParams): PreparedUserSignedAction {
  for (const [name, a] of [
    ["master", params.master],
    ["subAccount", params.subAccount],
  ] as const) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new RangeError(`${name} must be a 20-byte hex address`);
  }
  if (params.master.toLowerCase() === params.subAccount.toLowerCase()) throw new RangeError("subAccount must differ from master");
  if (params.direction !== "toSubAccount" && params.direction !== "toMaster") throw new RangeError('direction must be "toSubAccount" or "toMaster"');
  const dex = params.dex ?? "";
  const common = {
    sourceDex: dex,
    destinationDex: dex,
    token: params.token,
    amount: params.amount,
    nonce: params.nonce,
    network: params.network,
    ...(params.signatureChainId !== undefined ? { signatureChainId: params.signatureChainId } : {}),
  };
  return params.direction === "toSubAccount"
    ? buildSendAsset({ ...common, destination: params.subAccount })
    : buildSendAsset({ ...common, destination: params.master, fromSubAccount: params.subAccount });
}

// ---------------------------------------------------------------------------------------------
// userSetAbstraction (account type)
// ---------------------------------------------------------------------------------------------

/** Account types Kokoah lets a user choose: Standard (`disabled`) and Unified (`unifiedAccount`). No portfolio margin yet. */
export const ACCOUNT_MODES = ["disabled", "unifiedAccount"] as const;
export type AccountMode = (typeof ACCOUNT_MODES)[number];

/**
 * Builds `userSetAbstraction` (`HyperliquidTransaction:UserSetAbstraction`) for the main wallet: Standard (separate
 * spot and perps balances) or Unified (one balance per asset). `user` is lowercased, as the Python SDK does.
 */
export function buildAccountMode(params: {
  user: `0x${string}`;
  abstraction: AccountMode;
  nonce: number;
  network: UserSignedNetwork;
  signatureChainId?: `0x${string}`;
}): PreparedUserSignedAction {
  if (!/^0x[0-9a-fA-F]{40}$/.test(params.user)) throw new RangeError("user must be a 20-byte hex address");
  if (!(ACCOUNT_MODES as readonly string[]).includes(params.abstraction)) {
    throw new RangeError(`abstraction must be one of ${ACCOUNT_MODES.join(", ")}`);
  }
  return prepareUserSigned(
    UserSetAbstractionRequest.entries.action,
    UserSetAbstractionTypes,
    { type: "userSetAbstraction", user: params.user.toLowerCase(), abstraction: params.abstraction, nonce: params.nonce },
    params,
  );
}

// ---------------------------------------------------------------------------------------------

/** Builds a user-signed action from one set of fields (shared by every builder, including `staking.ts`). */
export function prepareUserSigned(
  schema: v.GenericSchema,
  types: Eip712Types,
  fields: Record<string, unknown> & { type: string },
  params: { network: UserSignedNetwork; signatureChainId?: `0x${string}`; nonce: number },
): PreparedUserSignedAction {
  const signatureChainId = (params.signatureChainId ?? params.network.defaultSignatureChainId).toLowerCase() as `0x${string}`;
  if (!/^0x[0-9a-f]+$/.test(signatureChainId)) throw new RangeError("signatureChainId must be a hex string");
  const { type, ...rest } = fields;
  const raw = { type, signatureChainId, hyperliquidChain: params.network.hyperliquidChain, ...rest };
  const action = canonicalize(schema, v.parse(schema, raw)) as Record<string, unknown> & { signatureChainId: `0x${string}` };
  return { action, typedData: userSignedTypedData(action, types), nonce: params.nonce };
}
