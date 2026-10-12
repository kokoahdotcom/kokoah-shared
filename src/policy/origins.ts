/**
 * Origin grants in the signed automation policy. The automation key (`kokoah-bot`) signs for three server-side
 * origins: guardian rules (`guardian`), bots (`bot`) and trades the user confirms in Telegram (`telegram`). A policy
 * with `allowedOrigins` lets only the listed ones act, so each is something the user signs for:
 * - bots: `policy/bots.ts` adds `bot` (and, for entries without a stop-loss, `botEntriesWithoutStopLoss`);
 * - Telegram trading: {@link policyForTelegram} adds `telegram` (and the actions a Telegram trade uses).
 *
 * A limits form that rebuilds the policy from its own fields drops grants it does not know about; pass the stored
 * policy through {@link carryOriginGrants} so a re-signature keeps them.
 *
 * @module
 */
import type { IntentOrigin } from "../intents/index.js";
import type { Policy } from "./schema.js";
import type { AllowlistableActionType } from "./types.js";

/** Origins that sign with the automation key on the server. */
export const AUTOMATION_ORIGINS = ["guardian", "bot", "telegram"] as const satisfies readonly IntentOrigin[];
export type AutomationOrigin = (typeof AUTOMATION_ORIGINS)[number];

/** Plain-language names of the origins (for policy reviews and logs). */
export const ORIGIN_LABELS: Readonly<Record<IntentOrigin, string>> = Object.freeze({
  manual: "your own orders",
  guardian: "guardians",
  ai_ticket: "AI-drafted orders you confirm",
  bot: "bots",
  telegram: "Telegram trades you confirm",
  agent: "agents you connected",
});

/** True when the policy lets `origin` act (a policy without `allowedOrigins` allows every origin). */
export function originAllowed(policy: Pick<Policy, "allowedOrigins">, origin: IntentOrigin): boolean {
  return policy.allowedOrigins === undefined || policy.allowedOrigins.includes(origin);
}

/** Actions a Telegram trade needs: place orders and cancel them. */
export const TELEGRAM_REQUIRED_ACTIONS = ["order", "cancel", "cancelByCloid"] as const satisfies readonly AllowlistableActionType[];
/** Also granted with Telegram trading, so `/long BTC 100 5x` can set the market's leverage (within `maxLeverage`). */
export const TELEGRAM_OPTIONAL_ACTIONS = ["updateLeverage"] as const satisfies readonly AllowlistableActionType[];

/** One thing the policy lacks for Telegram trading, in plain language. */
export interface TelegramPolicyShortfall {
  field: "allowedOrigins" | "allowedActionTypes";
  label: string;
  current: string;
  needed: string;
}

/** What the policy lacks for Telegram trading (empty: Telegram trades can run under it, within its limits). */
export function telegramPolicyShortfalls(policy: Policy): TelegramPolicyShortfall[] {
  const out: TelegramPolicyShortfall[] = [];
  if (!originAllowed(policy, "telegram")) {
    out.push({ field: "allowedOrigins", label: "Order origin", current: (policy.allowedOrigins ?? []).join(", "), needed: "also Telegram (telegram)" });
  }
  const actions = policy.allowedActionTypes as readonly string[];
  const lacking = TELEGRAM_REQUIRED_ACTIONS.filter((a) => !actions.includes(a));
  if (lacking.length) out.push({ field: "allowedActionTypes", label: "Allowed actions", current: actions.join(", "), needed: `also ${lacking.join(", ")}` });
  return out;
}

/**
 * The policy to re-sign so Telegram trades can run: `policy` with the `telegram` origin and the Telegram actions
 * added. Every limit (sizes, daily volume, leverage, markets, stop-loss rule, price band) stays as the user set it:
 * Telegram trades are checked against exactly those.
 */
export function policyForTelegram(policy: Policy): Policy {
  const next: Policy = { ...policy };
  if (policy.allowedOrigins && !policy.allowedOrigins.includes("telegram")) next.allowedOrigins = [...policy.allowedOrigins, "telegram"];
  const actions = [...(policy.allowedActionTypes as readonly string[])];
  for (const a of [...TELEGRAM_REQUIRED_ACTIONS, ...TELEGRAM_OPTIONAL_ACTIONS]) if (!actions.includes(a)) actions.push(a);
  next.allowedActionTypes = actions as Policy["allowedActionTypes"];
  return next;
}

/**
 * Keeps the bot and Telegram grants of `previous` (the stored policy) in `next` (a policy rebuilt from a limits form):
 * the `bot` and `telegram` origins, `botEntriesWithoutStopLoss`, and `updateLeverage` when it came with Telegram
 * trading. Nothing else is copied, and nothing is added that `previous` did not grant. A `next` that allows every
 * origin (no `allowedOrigins`) is returned unchanged apart from the stop-loss exemption.
 */
export function carryOriginGrants(previous: Policy | null | undefined, next: Policy): Policy {
  if (!previous) return next;
  const out: Policy = { ...next };
  const prevOrigins = previous.allowedOrigins;
  if (out.allowedOrigins && prevOrigins) {
    const extra = (["bot", "telegram"] as const).filter((o) => prevOrigins.includes(o) && !out.allowedOrigins!.includes(o));
    if (extra.length) out.allowedOrigins = [...out.allowedOrigins, ...extra];
  }
  if (previous.botEntriesWithoutStopLoss === true && out.botEntriesWithoutStopLoss === undefined) out.botEntriesWithoutStopLoss = true;
  const telegram = originAllowed(previous, "telegram") && prevOrigins !== undefined;
  const prevActions = previous.allowedActionTypes as readonly string[];
  const actions = out.allowedActionTypes as readonly string[];
  if (telegram && actions.includes("order")) {
    const extra = TELEGRAM_OPTIONAL_ACTIONS.filter((a) => prevActions.includes(a) && !actions.includes(a));
    if (extra.length) out.allowedActionTypes = [...actions, ...extra] as Policy["allowedActionTypes"];
  }
  return out;
}
