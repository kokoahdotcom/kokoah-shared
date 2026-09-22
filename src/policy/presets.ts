/**
 * Starting-point policies. These are product defaults, not exchange rules: review and tune them, and remember that a
 * server-side policy only binds once the user has signed it.
 *
 * @module
 */
import type { IntentOrigin } from "../intents/index.js";
import { type Policy, parsePolicy } from "./schema.js";

/** Builder requirement in policy form. */
export interface PolicyBuilder {
  b: `0x${string}`;
  f: number;
}

/**
 * Policy for the browser signer frame (manual trading and user-confirmed AI tickets). Wide limits: the user confirms
 * each order in the UI; the policy is a backstop against a compromised page spamming or draining via bad trades.
 */
export function createManualTradingPolicy(options: { builder: PolicyBuilder | null; overrides?: Partial<Policy> }): Policy {
  return parsePolicy({
    version: 1,
    allowedActionTypes: ["order", "cancel", "cancelByCloid", "modify", "batchModify", "updateLeverage", "updateIsolatedMargin", "scheduleCancel", "noop"],
    allowedCoins: "*",
    maxOrderNotionalUsd: 1_000_000,
    maxDailyNotionalUsd: 25_000_000,
    maxLeverage: 50,
    requireStopLossForNewEntries: false,
    maxOrdersPerMinute: 60,
    priceBandPct: 10,
    allowedVaultAddresses: [],
    requiredBuilder: options.builder,
    maxExpiresAfterWindowMs: 60_000,
    allowedOrigins: ["manual", "ai_ticket"] satisfies IntentOrigin[],
    exemptReduceOnlyFromNotionalCaps: true,
    ...options.overrides,
  });
}

/**
 * Policy for the server-side guardian signer. Tight by default: guardian origin only, listed markets only,
 * stop-loss (within 25% of entry) required on entries, no leverage changes, no cancel-all dead-man's switch.
 */
export function createGuardianPolicy(options: {
  builder: PolicyBuilder | null;
  allowedCoins: string[] | "*";
  maxOrderNotionalUsd: number;
  maxDailyNotionalUsd: number;
  maxLeverage?: number;
  overrides?: Partial<Policy>;
}): Policy {
  return parsePolicy({
    version: 1,
    // No scheduleCancel: it cancels every open order, including the user's own protective stops.
    allowedActionTypes: ["order", "cancel", "cancelByCloid", "modify", "batchModify", "updateIsolatedMargin", "noop"],
    allowedCoins: options.allowedCoins,
    maxOrderNotionalUsd: options.maxOrderNotionalUsd,
    maxDailyNotionalUsd: options.maxDailyNotionalUsd,
    maxLeverage: options.maxLeverage ?? 10,
    requireStopLossForNewEntries: true,
    maxStopLossDistancePct: 25,
    maxOrdersPerMinute: 20,
    priceBandPct: 5,
    allowedVaultAddresses: [],
    requiredBuilder: options.builder,
    maxExpiresAfterWindowMs: 30_000,
    allowedOrigins: ["guardian"] satisfies IntentOrigin[],
    exemptReduceOnlyFromNotionalCaps: true,
    ...options.overrides,
  });
}
