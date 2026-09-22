/**
 * Building the `/exchange` request body. This is the point where a signed action becomes sendable, so it enforces
 * the mainnet write guard ({@link assertWriteAllowed}).
 *
 * Envelope: `{action, nonce, signature, vaultAddress?, expiresAfter?}`; `expiresAfter` is not supported on user-signed
 * actions (exchange endpoint docs; Python SDK comment).
 *
 * @module
 */
import type { AbstractWallet, Signature } from "@nktkas/hyperliquid/signing";
import { assertWriteAllowed, type NetworkConfig } from "../network/index.js";
import { signL1Action } from "./l1.js";

/** JSON body for `POST /exchange`. */
export interface ExchangeRequestBody {
  action: Record<string, unknown>;
  nonce: number;
  signature: Signature;
  vaultAddress?: `0x${string}`;
  expiresAfter?: number;
}

/**
 * Assembles the `/exchange` body. Throws `MainnetWriteBlockedError` on mainnet unless the config explicitly allows
 * writes, and rejects `expiresAfter` on user-signed actions.
 */
export function buildExchangeRequest(params: {
  network: Pick<NetworkConfig, "name" | "isTestnet" | "allowMainnetWrites">;
  action: Record<string, unknown>;
  nonce: number;
  signature: Signature;
  vaultAddress?: `0x${string}` | undefined;
  expiresAfter?: number | undefined;
}): ExchangeRequestBody {
  assertWriteAllowed(params.network);
  const userSigned = "signatureChainId" in params.action;
  if (userSigned && params.expiresAfter !== undefined) throw new RangeError("expiresAfter is not supported on user-signed actions");
  if (userSigned && params.vaultAddress !== undefined) throw new RangeError("vaultAddress is not used on user-signed actions");
  // A user-signed action names its chain; it must match the network the request is built for (so a "Mainnet" action
  // cannot slip through a testnet config and bypass the mainnet guard).
  if ("hyperliquidChain" in params.action) {
    const expected = params.network.isTestnet ? "Testnet" : "Mainnet";
    if (params.action.hyperliquidChain !== expected) {
      throw new RangeError(`Action is for ${String(params.action.hyperliquidChain)} but the network is ${expected}`);
    }
  }
  return {
    action: params.action,
    nonce: params.nonce,
    signature: params.signature,
    ...(params.vaultAddress !== undefined ? { vaultAddress: params.vaultAddress.toLowerCase() as `0x${string}` } : {}),
    ...(params.expiresAfter !== undefined ? { expiresAfter: params.expiresAfter } : {}),
  };
}

/**
 * Signs a compiled L1 action and returns the sendable body. Checks the mainnet guard **before** signing.
 * Pass the output of `compileAction` (its `action` and `vaultAddress`).
 */
export async function prepareL1Request(params: {
  wallet: AbstractWallet;
  network: NetworkConfig;
  /** Accepts `compileAction`'s result directly (its `HlAction` needs no cast). */
  compiled: { action: object; vaultAddress?: `0x${string}` };
  nonce: number;
  expiresAfter?: number;
}): Promise<ExchangeRequestBody> {
  assertWriteAllowed(params.network);
  const action = params.compiled.action as Record<string, unknown>;
  const signature = await signL1Action({
    wallet: params.wallet,
    network: params.network,
    action,
    nonce: params.nonce,
    vaultAddress: params.compiled.vaultAddress,
    expiresAfter: params.expiresAfter,
  });
  return buildExchangeRequest({
    network: params.network,
    action,
    nonce: params.nonce,
    signature,
    vaultAddress: params.compiled.vaultAddress,
    expiresAfter: params.expiresAfter,
  });
}

/** `now + windowMs`, the recommended `expiresAfter` for user-initiated orders (HL's app uses 15 s). */
export function expiresAfterFromNow(now: number, windowMs = 15_000): number {
  return Math.floor(now + windowMs);
}
