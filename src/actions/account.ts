/**
 * Account actions a Kokoah trading key may sign besides trading: setting Kokoah's own Hyperliquid referral code, and
 * starting Hyperliquid's fee trial. Both are L1 actions (signed by the agent key like an order; Hyperliquid's own app
 * signs both with its agent) and both apply to the master account only.
 *
 * The intents carry nothing a caller could abuse: the referral code comes from the signer's own trusted configuration
 * (`compileAccountAction`'s `referralCode`), and the fee trial names a VIP tier by number, whose rates come from the
 * fee schedule the signer read from Hyperliquid itself (`feeTiers`), never from the intent.
 *
 * `startFeeTrial` is `{type, addBaseRate, crossBaseRate}` with the tier's maker and taker base rates as decimal
 * strings, formatted as Hyperliquid's app does (`toFixed(8)`, trailing zeros trimmed, at least one decimal). Neither
 * SDK has it yet; the shape comes from Hyperliquid's app code (2026-09-25).
 *
 * @module
 */
import { SetReferrerRequest } from "@nktkas/hyperliquid/api/exchange";
import { canonicalize } from "@nktkas/hyperliquid/signing";
import * as v from "valibot";
import { CompileError } from "./compile.js";

/** Account action intent kinds. */
export const ACCOUNT_INTENT_KINDS = ["setReferrer", "startFeeTrial"] as const;
export type AccountIntentKind = (typeof ACCOUNT_INTENT_KINDS)[number];

/** Set Kokoah's Hyperliquid referral code on the account (the code comes from the signer's configuration). */
export const SetReferrerIntentSchema = v.strictObject({
  kind: v.literal("setReferrer"),
  origin: v.literal("manual"),
});

/**
 * Start Hyperliquid's fee trial for VIP tier `tier` (1 = the first VIP tier of `userFees.feeSchedule.tiers.vip`).
 * Terms (Hyperliquid's app): once every 90 days; while it runs the user keeps paying their current rates and the
 * difference to the trial tier's rates accrues as trial rewards, claimable when the tier's rates are reached within
 * 14 days.
 */
export const StartFeeTrialIntentSchema = v.strictObject({
  kind: v.literal("startFeeTrial"),
  origin: v.literal("manual"),
  tier: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(20)),
});

/** Any account action intent. Strict: unknown keys (a code, a vaultAddress, …) are rejected. */
export const AccountIntentSchema = v.variant("kind", [SetReferrerIntentSchema, StartFeeTrialIntentSchema]);
export type AccountIntent = v.InferOutput<typeof AccountIntentSchema>;
export type AccountIntentInput = v.InferInput<typeof AccountIntentSchema>;

/** True when `input` names an account action kind (then validate it with {@link safeParseAccountIntent}). */
export function isAccountIntentKind(input: unknown): boolean {
  const kind = typeof input === "object" && input !== null ? (input as { kind?: unknown }).kind : undefined;
  return typeof kind === "string" && (ACCOUNT_INTENT_KINDS as readonly string[]).includes(kind);
}

/** Result of {@link safeParseAccountIntent}. */
export type AccountIntentParseResult = { success: true; intent: AccountIntent } | { success: false; issues: Array<{ message: string; path?: string }> };

/** Validates an account action intent without throwing. */
export function safeParseAccountIntent(input: unknown): AccountIntentParseResult {
  const r = v.safeParse(AccountIntentSchema, input);
  if (r.success) return { success: true, intent: r.output };
  return {
    success: false,
    issues: r.issues.map((i) => {
      const path = v.getDotPath(i);
      return path ? { message: i.message, path } : { message: i.message };
    }),
  };
}

/** Wire `setReferrer` action (SDK schema). */
export type HlSetReferrerAction = v.InferOutput<typeof SetReferrerRequest>["action"];
/** Wire `startFeeTrial` action (key order as Hyperliquid's app sends it). */
export interface HlStartFeeTrialAction {
  type: "startFeeTrial";
  /** The trial tier's maker base rate. */
  addBaseRate: string;
  /** The trial tier's taker base rate. */
  crossBaseRate: string;
}

/** One VIP tier of `userFees.feeSchedule.tiers.vip` (rates as fractions of notional). */
export interface FeeTierRates {
  cross: string | number;
  add: string | number;
}

/** A fee trial rate as Hyperliquid's app writes it: `toFixed(8)`, trailing zeros trimmed, at least one decimal. */
export function feeTrialRate(rate: string | number): string {
  const n = Number(rate);
  if (typeof rate === "string" && !/^-?\d+(\.\d+)?$/.test(rate)) throw new RangeError("Fee rate must be a decimal");
  if (!Number.isFinite(n) || Math.abs(n) >= 1) throw new RangeError("Fee rate must be a fraction between -1 and 1");
  const fixed = n.toFixed(8).replace(/0+$/, "");
  const out = fixed.endsWith(".") ? `${fixed}0` : fixed;
  return out === "-0.0" ? "0.0" : out;
}
/** Every wire account action. */
export type HlAccountAction = HlSetReferrerAction | HlStartFeeTrialAction;

/** A compiled account action: sign `action` exactly (master account; no `vaultAddress`). */
export interface CompiledAccountAction {
  action: HlAccountAction;
  intent: AccountIntent;
}

/** A Hyperliquid referral code (the SDK allows 1–20 characters; Kokoah also limits the alphabet). */
export const REFERRAL_CODE_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;

/**
 * Compiles an account action intent into its wire action. `referralCode` is the signer's own configured code
 * (`setReferrer` fails with `UNSUPPORTED` without one); `feeTiers` is the VIP tier list the signer read from
 * Hyperliquid's `userFees` itself (`startFeeTrial` fails with `INVALID_INTENT` for a tier that isn't there).
 *
 * @throws {CompileError}
 */
export function compileAccountAction(
  input: AccountIntent | AccountIntentInput,
  options: { referralCode?: string | null; feeTiers?: ReadonlyArray<FeeTierRates> } = {},
): CompiledAccountAction {
  const parsed = safeParseAccountIntent(input);
  if (!parsed.success) throw new CompileError("INVALID_INTENT", `Invalid intent: ${parsed.issues.map((i) => i.message).join("; ")}`);
  const intent = parsed.intent;
  switch (intent.kind) {
    case "setReferrer": {
      const code = options.referralCode;
      if (typeof code !== "string" || code === "") throw new CompileError("UNSUPPORTED", "No Kokoah referral code is configured");
      if (!REFERRAL_CODE_PATTERN.test(code)) throw new CompileError("INVALID_INTENT", "The configured referral code must be 1-20 of A-Z a-z 0-9 _ -");
      const schema = SetReferrerRequest.entries.action;
      const action = canonicalize(schema, v.parse(schema, { type: "setReferrer", code }));
      return { action, intent };
    }
    case "startFeeTrial": {
      const tier = options.feeTiers?.[intent.tier - 1];
      if (!tier) throw new CompileError("INVALID_INTENT", `Fee tier ${intent.tier} is not in Hyperliquid's fee schedule`);
      let addBaseRate: string;
      let crossBaseRate: string;
      try {
        addBaseRate = feeTrialRate(tier.add);
        crossBaseRate = feeTrialRate(tier.cross);
      } catch (e) {
        throw new CompileError("INVALID_INTENT", `Fee tier ${intent.tier} has malformed rates: ${e instanceof Error ? e.message : String(e)}`);
      }
      return { action: { type: "startFeeTrial", addBaseRate, crossBaseRate }, intent };
    }
  }
}
