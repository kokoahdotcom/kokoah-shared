/**
 * Account actions a Kokoah trading key may sign besides trading: setting Kokoah's own Hyperliquid referral code, and
 * starting Hyperliquid's fee trial. Both are L1 actions (signed by the agent key like an order) and both apply to the
 * master account only.
 *
 * The intents carry no parameters a caller could abuse: the referral code comes from the signer's own trusted
 * configuration (`compileAccountAction`'s `referralCode`), never from the intent.
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

/** Start Hyperliquid's fee trial (a better fee tier for a while; see the fee trial terms in the app). */
export const StartFeeTrialIntentSchema = v.strictObject({
  kind: v.literal("startFeeTrial"),
  origin: v.literal("manual"),
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
/** Wire `startFeeTrial` action. */
export interface HlStartFeeTrialAction {
  type: "startFeeTrial";
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
 * Compiles an account action intent into its wire action. `referralCode` is the signer's own configured code;
 * `setReferrer` fails with `UNSUPPORTED` without one.
 *
 * @throws {CompileError}
 */
export function compileAccountAction(input: AccountIntent | AccountIntentInput, options: { referralCode?: string | null } = {}): CompiledAccountAction {
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
    case "startFeeTrial":
      return { action: { type: "startFeeTrial" }, intent };
  }
}
