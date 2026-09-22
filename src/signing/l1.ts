/**
 * L1 action signing (orders, cancels, leverage, …): thin wrappers around `@nktkas/hyperliquid/signing`.
 *
 * Scheme (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing, Python SDK `sign_l1_action`):
 * `connectionId = keccak256(msgpack(action) ‖ nonce(u64 BE) ‖ (0x00 | 0x01‖vaultAddress) ‖ [0x00‖expiresAfter(u64 BE)])`,
 * signed as EIP-712 `Agent{source, connectionId}` in domain `{name:"Exchange", version:"1", chainId:1337,
 * verifyingContract:0x0}` with `source` "a" (mainnet) / "b" (testnet).
 *
 * The action must already be in canonical key order (use `compileAction`); msgpack hashes key order.
 *
 * @module
 */
import { type AbstractWallet, createL1ActionHash, type Signature, signL1Action as sdkSignL1Action } from "@nktkas/hyperliquid/signing";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { HL_L1_SIGNING_CHAIN_ID } from "../network/index.js";

export type { AbstractWallet, Signature };

/** The zero address used as `verifyingContract` in both HL EIP-712 domains. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** Parameters shared by L1 hashing/signing. */
export interface L1ActionParams {
  /** Wire action in canonical key order. */
  action: Record<string, unknown> | unknown[];
  /** Nonce in ms (see `NonceManager`). */
  nonce: number;
  /** Sub-account or vault address; included in the hash when set. */
  vaultAddress?: `0x${string}` | undefined;
  /** Deadline in ms; included in the hash when set. */
  expiresAfter?: number | undefined;
}

/** Network selector: anything with `isTestnet` (e.g. a `NetworkConfig`). */
export interface NetworkFlag {
  isTestnet: boolean;
}

/** `connectionId` of an L1 action: keccak256 of msgpack(action) ‖ nonce ‖ vault ‖ expiresAfter. */
export function hashL1Action(params: L1ActionParams): `0x${string}` {
  return createL1ActionHash({
    action: params.action,
    nonce: params.nonce,
    ...(params.vaultAddress !== undefined ? { vaultAddress: lower(params.vaultAddress) } : {}),
    ...(params.expiresAfter !== undefined ? { expiresAfter: params.expiresAfter } : {}),
  });
}

/** EIP-712 typed data of the phantom agent for an L1 action (viem/wagmi `signTypedData` shape). */
export function l1TypedData(params: L1ActionParams & { network: NetworkFlag }) {
  return {
    domain: { name: "Exchange", version: "1", chainId: HL_L1_SIGNING_CHAIN_ID, verifyingContract: ZERO_ADDRESS },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent" as const,
    message: { source: params.network.isTestnet ? "b" : "a", connectionId: hashL1Action(params) },
  };
}

/**
 * The 32-byte EIP-712 digest to sign for an L1 action. For signers that only sign raw digests (KMS/HSM): the policy
 * check must run on the structured action *before* computing this, because the digest reveals nothing.
 */
export function l1SigningDigest(params: L1ActionParams & { network: NetworkFlag }): `0x${string}` {
  return hashTypedData(l1TypedData(params));
}

/** Signs an L1 action with a viem/ethers/abstract wallet (delegates to the SDK's `signL1Action`). */
export async function signL1Action(params: L1ActionParams & { wallet: AbstractWallet; network: NetworkFlag }): Promise<Signature> {
  return await sdkSignL1Action({
    wallet: params.wallet,
    action: params.action,
    nonce: params.nonce,
    isTestnet: params.network.isTestnet,
    ...(params.vaultAddress !== undefined ? { vaultAddress: lower(params.vaultAddress) } : {}),
    ...(params.expiresAfter !== undefined ? { expiresAfter: params.expiresAfter } : {}),
  });
}

/** Recovers the address that produced an L1 signature (useful to check a signer's output before sending). */
export async function recoverL1Signer(params: L1ActionParams & { network: NetworkFlag; signature: Signature }): Promise<`0x${string}`> {
  const td = l1TypedData(params);
  return await recoverTypedDataAddress({ ...td, signature: signatureToHex(params.signature) });
}

/** Serializes `{r, s, v}` to a 65-byte hex signature. */
export function signatureToHex(sig: Signature): `0x${string}` {
  const r = sig.r.slice(2).padStart(64, "0");
  const s = sig.s.slice(2).padStart(64, "0");
  return `0x${r}${s}${sig.v.toString(16)}`;
}

/** Parses a 65-byte hex signature into `{r, s, v}` with v ∈ {27, 28}. */
export function signatureFromHex(hex: `0x${string}`): Signature {
  const h = hex.slice(2);
  if (h.length !== 130) throw new RangeError("Expected a 65-byte signature");
  let v = parseInt(h.slice(128, 130), 16);
  if (v === 0 || v === 1) v += 27;
  if (v !== 27 && v !== 28) throw new RangeError(`Invalid recovery id ${v}`);
  return { r: `0x${h.slice(0, 64)}`, s: `0x${h.slice(64, 128)}`, v };
}

function lower(a: `0x${string}`): `0x${string}` {
  return a.toLowerCase() as `0x${string}`;
}
