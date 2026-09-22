/**
 * Policy action-type lists and violation codes.
 *
 * @module
 */

/** Action types a policy may allow. */
export const ALLOWLISTABLE_ACTION_TYPES = [
  "order",
  "cancel",
  "cancelByCloid",
  "modify",
  "batchModify",
  "updateLeverage",
  "updateIsolatedMargin",
  "topUpIsolatedOnlyMargin",
  "scheduleCancel",
  "noop",
] as const;
export type AllowlistableActionType = (typeof ALLOWLISTABLE_ACTION_TYPES)[number];

/** Stable violation codes. */
export type PolicyViolationCode =
  | "INVALID_SUBJECT"
  | "WITHDRAWAL_DENIED"
  | "TRANSFER_DENIED"
  | "VAULT_ACTION_DENIED"
  | "SUBACCOUNT_ACTION_DENIED"
  | "REFERRER_ACTION_DENIED"
  | "RATE_LIMIT_PURCHASE_DENIED"
  | "APPROVAL_DENIED"
  | "ACCOUNT_CONFIG_DENIED"
  | "TWAP_DENIED"
  | "STAKING_OR_REWARDS_DENIED"
  | "DEPLOYER_ACTION_DENIED"
  | "ACTION_TYPE_NOT_ALLOWED"
  | "POLICY_EXPIRED"
  | "ORIGIN_NOT_ALLOWED"
  | "VAULT_NOT_ALLOWED"
  | "EXPIRES_AFTER_REQUIRED"
  | "EXPIRES_AFTER_IN_PAST"
  | "EXPIRES_AFTER_TOO_FAR"
  | "UNKNOWN_MARKET"
  | "COIN_NOT_ALLOWED"
  | "MARK_PRICE_UNAVAILABLE"
  | "ORDER_NOTIONAL_EXCEEDED"
  | "DAILY_NOTIONAL_EXCEEDED"
  | "PRICE_OUTSIDE_BAND"
  | "LEVERAGE_EXCEEDED"
  | "STOP_LOSS_REQUIRED"
  | "DAILY_LOSS_LOCKED"
  | "ORDER_RATE_EXCEEDED"
  | "BUILDER_REQUIRED"
  | "BUILDER_MISMATCH";

/** Hard-denied action types and the code each is denied with. Never signable by a Kokoah agent key. */
export const DENIED_ACTION_TYPES: Readonly<Record<string, PolicyViolationCode>> = Object.freeze({
  withdraw3: "WITHDRAWAL_DENIED",
  cWithdraw: "WITHDRAWAL_DENIED",
  sendToEvmWithData: "WITHDRAWAL_DENIED",
  usdSend: "TRANSFER_DENIED",
  spotSend: "TRANSFER_DENIED",
  sendAsset: "TRANSFER_DENIED",
  agentSendAsset: "TRANSFER_DENIED",
  usdClassTransfer: "TRANSFER_DENIED",
  subAccountTransfer: "TRANSFER_DENIED",
  subAccountSpotTransfer: "TRANSFER_DENIED",
  cDeposit: "TRANSFER_DENIED",
  borrowLend: "TRANSFER_DENIED",
  hip3LiquidatorTransfer: "TRANSFER_DENIED",
  userOutcome: "TRANSFER_DENIED",
  vaultTransfer: "VAULT_ACTION_DENIED",
  createVault: "VAULT_ACTION_DENIED",
  vaultModify: "VAULT_ACTION_DENIED",
  vaultDistribute: "VAULT_ACTION_DENIED",
  createSubAccount: "SUBACCOUNT_ACTION_DENIED",
  subAccountModify: "SUBACCOUNT_ACTION_DENIED",
  setReferrer: "REFERRER_ACTION_DENIED",
  registerReferrer: "REFERRER_ACTION_DENIED",
  reserveRequestWeight: "RATE_LIMIT_PURCHASE_DENIED",
  approveAgent: "APPROVAL_DENIED",
  approveBuilderFee: "APPROVAL_DENIED",
  convertToMultiSigUser: "ACCOUNT_CONFIG_DENIED",
  multiSig: "ACCOUNT_CONFIG_DENIED",
  userSetAbstraction: "ACCOUNT_CONFIG_DENIED",
  agentSetAbstraction: "ACCOUNT_CONFIG_DENIED",
  userDexAbstraction: "ACCOUNT_CONFIG_DENIED",
  agentEnableDexAbstraction: "ACCOUNT_CONFIG_DENIED",
  userPortfolioMargin: "ACCOUNT_CONFIG_DENIED",
  evmUserModify: "ACCOUNT_CONFIG_DENIED",
  setDisplayName: "ACCOUNT_CONFIG_DENIED",
  linkStakingUser: "ACCOUNT_CONFIG_DENIED",
  stakingLinkDisableTradingUser: "ACCOUNT_CONFIG_DENIED",
  twapOrder: "TWAP_DENIED",
  twapCancel: "TWAP_DENIED",
  tokenDelegate: "STAKING_OR_REWARDS_DENIED",
  claimRewards: "STAKING_OR_REWARDS_DENIED",
  spotDeploy: "DEPLOYER_ACTION_DENIED",
  perpDeploy: "DEPLOYER_ACTION_DENIED",
  spotUser: "DEPLOYER_ACTION_DENIED",
  activateOutcomeDeployer: "DEPLOYER_ACTION_DENIED",
  finalizeEvmContract: "DEPLOYER_ACTION_DENIED",
  cSignerAction: "DEPLOYER_ACTION_DENIED",
  cValidatorAction: "DEPLOYER_ACTION_DENIED",
  validatorL1Stream: "DEPLOYER_ACTION_DENIED",
  gossipPriorityBid: "DEPLOYER_ACTION_DENIED",
  authorizeAqav2Role: "DEPLOYER_ACTION_DENIED",
});

/** Plain-English messages for the hard-deny codes. */
export const DENIED_MESSAGES: Readonly<Partial<Record<PolicyViolationCode, string>>> = Object.freeze({
  WITHDRAWAL_DENIED: "Kokoah trading keys can never withdraw funds.",
  TRANSFER_DENIED: "Kokoah trading keys can never transfer funds.",
  VAULT_ACTION_DENIED: "Vault deposits, withdrawals and vault creation are not allowed for trading keys.",
  SUBACCOUNT_ACTION_DENIED: "Sub-account creation and changes are not allowed for trading keys.",
  REFERRER_ACTION_DENIED: "Setting a referrer is not allowed for trading keys.",
  RATE_LIMIT_PURCHASE_DENIED: "Buying request weight is not allowed for trading keys (it spends account funds).",
  APPROVAL_DENIED: "Approvals must be signed by the main wallet, never by a trading key.",
  ACCOUNT_CONFIG_DENIED: "Account configuration changes are not allowed for trading keys.",
  TWAP_DENIED: "Native TWAP orders are not allowed (they cannot carry the builder fee).",
  STAKING_OR_REWARDS_DENIED: "Staking and reward claims are not allowed for trading keys.",
  DEPLOYER_ACTION_DENIED: "Deployer and validator actions are not allowed for trading keys.",
});
