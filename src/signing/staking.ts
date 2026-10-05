/**
 * HYPE staking for the main wallet (user-signed, readable EIP-712): `cDeposit`, `cWithdraw` and `tokenDelegate`, in their
 * own module so an app loads them only where it stakes. Same scheme and checks as `userSigned.ts`; the golden vectors
 * (scripts/golden) compare them with the Python SDK.
 *
 * @module
 */
import { CDepositRequest, CDepositTypes, CWithdrawRequest, CWithdrawTypes, TokenDelegateRequest, TokenDelegateTypes } from "@nktkas/hyperliquid/api/exchange";
import { decimalToUnits } from "../vaults/hlp.js";
import { ZERO_ADDRESS } from "./l1.js";
import { prepareUserSigned, type PreparedUserSignedAction, type UserSignedNetwork } from "./userSigned.js";

/** Staking amounts (`wei`) are HYPE × 10^8, an integer. */
export const HYPE_WEI_DECIMALS = 8;

/** HYPE → staking `wei` (× 10^8), exactly: at most 8 decimals, above zero, within a safe integer. */
export function hypeToWei(amount: string | number): number {
  return decimalToUnits(amount, HYPE_WEI_DECIMALS, "HYPE amount");
}

/** Parameters shared by the staking builders. */
export interface StakingAmountParams {
  /** HYPE, as a decimal (at most 8 decimals). */
  amount: string | number;
  nonce: number;
  network: UserSignedNetwork;
  signatureChainId?: `0x${string}`;
}

/**
 * Builds `cDeposit` (`HyperliquidTransaction:CDeposit`): moves HYPE from the spot balance to the staking balance.
 * The main wallet signs it; the signed fields are the network, the amount (`wei`, HYPE × 10^8) and the nonce.
 */
export function buildStakingDeposit(params: StakingAmountParams): PreparedUserSignedAction {
  return prepareUserSigned(CDepositRequest.entries.action, CDepositTypes, { type: "cDeposit", wei: hypeToWei(params.amount), nonce: params.nonce }, params);
}

/**
 * Builds `cWithdraw` (`HyperliquidTransaction:CWithdraw`): starts moving undelegated HYPE from the staking balance
 * back to spot (Hyperliquid releases it after 7 days).
 */
export function buildStakingWithdraw(params: StakingAmountParams): PreparedUserSignedAction {
  return prepareUserSigned(CWithdrawRequest.entries.action, CWithdrawTypes, { type: "cWithdraw", wei: hypeToWei(params.amount), nonce: params.nonce }, params);
}

/**
 * Builds `tokenDelegate` (`HyperliquidTransaction:TokenDelegate`): delegates staking-balance HYPE to `validator`, or
 * takes it back with `undelegate` (a delegation is locked for a day after it is made). `validator` is lowercased.
 */
export function buildTokenDelegate(params: StakingAmountParams & { validator: `0x${string}`; undelegate: boolean }): PreparedUserSignedAction {
  if (!/^0x[0-9a-fA-F]{40}$/.test(params.validator)) throw new RangeError("validator must be a 20-byte hex address");
  if (params.validator.toLowerCase() === ZERO_ADDRESS) throw new RangeError("validator must not be the zero address");
  if (typeof params.undelegate !== "boolean") throw new RangeError("undelegate must be a boolean");
  return prepareUserSigned(
    TokenDelegateRequest.entries.action,
    TokenDelegateTypes,
    { type: "tokenDelegate", validator: params.validator.toLowerCase(), wei: hypeToWei(params.amount), isUndelegate: params.undelegate, nonce: params.nonce },
    params,
  );
}
