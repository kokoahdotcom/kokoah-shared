/**
 * Policy schema (valibot).
 *
 * @module
 */
import * as v from "valibot";
import { AddressSchema, CoinSchema, INTENT_ORIGINS } from "../intents/index.js";
import { ALLOWLISTABLE_ACTION_TYPES } from "./types.js";

/** A Hyperliquid referral code as `setReferrer` carries it (1–20 of A–Z a–z 0–9 _ -). */
export const ReferralCodeSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,20}$/, "Referral code must be 1-20 of A-Z a-z 0-9 _ -"));

/** Current policy schema version. */
export const POLICY_VERSION = 1;

/** Policy schema. Unknown keys are rejected; hard-denied action types cannot be allow-listed. */
export const PolicySchema = v.strictObject({
  version: v.literal(POLICY_VERSION),
  /** Allowed action types (anything else is denied). */
  allowedActionTypes: v.pipe(v.array(v.picklist(ALLOWLISTABLE_ACTION_TYPES)), v.minLength(1)),
  /** "*" for every live market, or a list of HL coin names. */
  allowedCoins: v.union([v.literal("*"), v.pipe(v.array(CoinSchema), v.minLength(1))]),
  /** Max notional of a single order (USD). */
  maxOrderNotionalUsd: v.pipe(v.number(), v.minValue(0)),
  /** Max total notional of orders per UTC day (USD). */
  maxDailyNotionalUsd: v.pipe(v.number(), v.minValue(0)),
  /** Max leverage for `updateLeverage` and for entries in markets whose current leverage is known. */
  maxLeverage: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /** New entries must carry an attached stop-loss (or the position must already have one). */
  requireStopLossForNewEntries: v.boolean(),
  /**
   * With `requireStopLossForNewEntries`: the attached stop must be within this % of the entry price (so a token stop
   * far away does not count). Optional; no distance limit when omitted.
   */
  maxStopLossDistancePct: v.optional(v.pipe(v.number(), v.gtValue(0), v.maxValue(100))),
  /** Max orders per rolling minute (cancels are exempt). */
  maxOrdersPerMinute: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** Max distance of a limit price from mark, in percent. */
  priceBandPct: v.pipe(v.number(), v.minValue(0), v.maxValue(100)),
  /** Vault/sub-account addresses the key may act for. Empty: master account only. */
  allowedVaultAddresses: v.array(AddressSchema),
  /** Every order action must carry exactly this builder `{b, f}`. Null: no builder requirement. */
  requiredBuilder: v.nullable(
    v.strictObject({
      b: AddressSchema,
      f: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1000)),
    }),
  ),
  /** Max `expiresAfter − now` in ms; `expiresAfter` is then mandatory. Null: not required. */
  maxExpiresAfterWindowMs: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1000))),
  /** Allowed intent origins. Default: all. */
  allowedOrigins: v.optional(v.pipe(v.array(v.picklist(INTENT_ORIGINS)), v.minLength(1))),
  /** Reduce-only orders don't count toward notional caps (so protection and closes always work). Default true. */
  exemptReduceOnlyFromNotionalCaps: v.optional(v.boolean(), true),
  /**
   * Spot pairs (HL coin names such as `@166`) the key may trade, with single IOC orders only (Kokoah's Convert uses
   * the stablecoin pairs, see `STABLECOIN_PAIRS`). Omitted or empty: every spot order is denied. Spot sells must carry
   * `requiredBuilder`; spot buys carry no builder (Hyperliquid charges builder fees on spot sells only).
   */
  allowedSpotCoins: v.optional(v.pipe(v.array(CoinSchema), v.maxLength(50))),
  /**
   * The one referral code `setReferrer` may carry (Kokoah's own Hyperliquid code). Omitted: `setReferrer` stays
   * hard-denied. Signers that allow it must also make sure it is signed at most once per account.
   */
  referralCode: v.optional(ReferralCodeSchema),
});

/** A validated policy. */
export type Policy = v.InferOutput<typeof PolicySchema>;
/** Policy input (defaults optional). */
export type PolicyInput = v.InferInput<typeof PolicySchema>;

/** Thrown by {@link parsePolicy}. */
export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyValidationError";
  }
}

/** Validates a policy; throws {@link PolicyValidationError} with a readable summary. */
export function parsePolicy(input: unknown): Policy {
  const r = v.safeParse(PolicySchema, input);
  if (!r.success) throw new PolicyValidationError(`Invalid policy: ${v.summarize(r.issues)}`);
  return r.output;
}
