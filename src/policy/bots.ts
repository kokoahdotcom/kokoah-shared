/**
 * Bots and the signed automation policy. Bots trade through the `kokoah-bot` automation key, so the policy the user
 * signed bounds every bot order (the signer service checks each one). This module says what a set of bots needs
 * ({@link BotLimitNeeds}, from `bots/needs.ts`), what the current policy lacks ({@link botLimitShortfalls}), and builds
 * the one policy to re-sign ({@link policyForBots}): the current policy with only the short fields raised, so every
 * other choice (and any field this module does not know) is kept.
 *
 * @module
 */
import type { Policy } from "./schema.js";

/** What running bots need from the policy. */
export interface BotLimitNeeds {
  /** Markets the bots trade ("*": any market, e.g. a copy bot without an allow list). */
  coins: "*" | string[];
  /** Largest single order (USD, at its worst price). */
  maxOrderNotionalUsd: number;
  /** Daily volume the bots can reach (USD, UTC day). */
  dailyNotionalUsd: number;
  /** Highest leverage cap among the bots. */
  maxLeverage: number;
  /** Peak order rate. */
  ordersPerMinute: number;
  /** Bots open positions without an attached stop-loss (they manage their own exits). */
  entriesWithoutStopLoss: boolean;
  /** Slippage of the bots' market orders (percent); the policy's price band must allow it. */
  marketSlippagePct: number;
  /** Sub-accounts the bots trade for. */
  vaultAddresses?: string[];
}

/** Actions every bot needs: place orders and cancel its own (by cloid) or by order id. */
export const BOT_ACTION_TYPES = ["order", "cancel", "cancelByCloid"] as const;

/** Upper bounds a bot policy may be raised to (the same as the automation limits form). */
export const BOT_POLICY_BOUNDS = Object.freeze({
  maxOrderNotionalUsd: 1_000_000,
  maxDailyNotionalUsd: 25_000_000,
  maxLeverage: 50,
  maxOrdersPerMinute: 60,
  priceBandPct: 10,
});

export type BotLimitField =
  | "allowedActionTypes"
  | "allowedOrigins"
  | "allowedCoins"
  | "maxOrderNotionalUsd"
  | "maxDailyNotionalUsd"
  | "maxLeverage"
  | "maxOrdersPerMinute"
  | "requireStopLossForNewEntries"
  | "priceBandPct"
  | "allowedVaultAddresses";

/** One limit the policy is too tight on, in plain language. */
export interface BotLimitShortfall {
  field: BotLimitField;
  label: string;
  current: string;
  needed: string;
}

/** Thrown by {@link policyForBots} when the bots need more than the automation limits may ever allow. */
export class BotLimitsTooHighError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotLimitsTooHighError";
  }
}

/** Combines the needs of several bots: markets and sub-accounts united, daily volume summed, the rest the maximum. */
export function mergeBotNeeds(list: readonly BotLimitNeeds[]): BotLimitNeeds | null {
  if (list.length === 0) return null;
  const coins: "*" | Set<string> = list.some((n) => n.coins === "*") ? "*" : new Set(list.flatMap((n) => n.coins as string[]));
  const vaults = [...new Set(list.flatMap((n) => (n.vaultAddresses ?? []).map((a) => a.toLowerCase())))].sort();
  return {
    coins: coins === "*" ? "*" : [...coins].sort(),
    maxOrderNotionalUsd: Math.max(...list.map((n) => n.maxOrderNotionalUsd)),
    dailyNotionalUsd: list.reduce((s, n) => s + n.dailyNotionalUsd, 0),
    maxLeverage: Math.max(...list.map((n) => n.maxLeverage)),
    ordersPerMinute: Math.max(...list.map((n) => n.ordersPerMinute)),
    entriesWithoutStopLoss: list.some((n) => n.entriesWithoutStopLoss),
    marketSlippagePct: Math.max(...list.map((n) => n.marketSlippagePct)),
    ...(vaults.length ? { vaultAddresses: vaults } : {}),
  };
}

const money = (x: number) => `$${x.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const coinsText = (c: "*" | readonly string[]) => (c === "*" ? "All markets" : c.join(", "));

function missingCoins(policy: Policy, needs: BotLimitNeeds): "*" | string[] {
  if (policy.allowedCoins === "*") return [];
  if (needs.coins === "*") return "*";
  const allowed = policy.allowedCoins as readonly string[];
  return needs.coins.filter((c) => !allowed.includes(c));
}

/** What the policy lacks for these needs (empty: the bots can run under it). */
export function botLimitShortfalls(policy: Policy, needs: BotLimitNeeds): BotLimitShortfall[] {
  const out: BotLimitShortfall[] = [];
  const actions = policy.allowedActionTypes as readonly string[];
  const lackingActions = BOT_ACTION_TYPES.filter((a) => !actions.includes(a));
  if (lackingActions.length) out.push({ field: "allowedActionTypes", label: "Allowed actions", current: actions.join(", "), needed: `also ${lackingActions.join(", ")}` });
  if (policy.allowedOrigins && !policy.allowedOrigins.includes("guardian")) {
    out.push({ field: "allowedOrigins", label: "Order origin", current: policy.allowedOrigins.join(", "), needed: "also automation (guardian)" });
  }
  const missing = missingCoins(policy, needs);
  if (missing === "*" || missing.length) {
    out.push({ field: "allowedCoins", label: "Allowed markets", current: coinsText(policy.allowedCoins), needed: missing === "*" ? "All markets" : `also ${missing.join(", ")}` });
  }
  if (policy.maxOrderNotionalUsd < needs.maxOrderNotionalUsd) {
    out.push({ field: "maxOrderNotionalUsd", label: "Max order size", current: money(policy.maxOrderNotionalUsd), needed: money(needs.maxOrderNotionalUsd) });
  }
  if (policy.maxDailyNotionalUsd < needs.dailyNotionalUsd) {
    out.push({ field: "maxDailyNotionalUsd", label: "Max daily volume", current: money(policy.maxDailyNotionalUsd), needed: money(needs.dailyNotionalUsd) });
  }
  if (policy.maxLeverage < needs.maxLeverage) out.push({ field: "maxLeverage", label: "Max leverage", current: `${policy.maxLeverage}×`, needed: `${needs.maxLeverage}×` });
  if (policy.maxOrdersPerMinute < needs.ordersPerMinute) {
    out.push({ field: "maxOrdersPerMinute", label: "Orders per minute", current: String(policy.maxOrdersPerMinute), needed: String(needs.ordersPerMinute) });
  }
  if (needs.entriesWithoutStopLoss && policy.requireStopLossForNewEntries) {
    out.push({ field: "requireStopLossForNewEntries", label: "Stop-loss on new entries", current: "Required", needed: "Not required (bots manage their own exits)" });
  }
  if (policy.priceBandPct < needs.marketSlippagePct) {
    out.push({ field: "priceBandPct", label: "Limit price band", current: `${policy.priceBandPct}%`, needed: `${needs.marketSlippagePct}%` });
  }
  const vaults = policy.allowedVaultAddresses.map((a) => a.toLowerCase());
  const lackingVaults = (needs.vaultAddresses ?? []).filter((a) => !vaults.includes(a.toLowerCase()));
  if (lackingVaults.length) {
    out.push({ field: "allowedVaultAddresses", label: "Sub-accounts", current: vaults.length ? vaults.join(", ") : "None", needed: `also ${lackingVaults.join(", ")}` });
  }
  return out;
}

/**
 * The policy to re-sign so the bots can run: `policy` with only the short fields raised to what the bots need (never
 * lowered). Throws {@link BotLimitsTooHighError} when a need is above {@link BOT_POLICY_BOUNDS}.
 */
export function policyForBots(policy: Policy, needs: BotLimitNeeds): Policy {
  const over: string[] = [];
  if (needs.maxOrderNotionalUsd > BOT_POLICY_BOUNDS.maxOrderNotionalUsd) over.push(`an order of ${money(needs.maxOrderNotionalUsd)} (max ${money(BOT_POLICY_BOUNDS.maxOrderNotionalUsd)})`);
  if (needs.dailyNotionalUsd > BOT_POLICY_BOUNDS.maxDailyNotionalUsd) over.push(`a daily volume of ${money(needs.dailyNotionalUsd)} (max ${money(BOT_POLICY_BOUNDS.maxDailyNotionalUsd)})`);
  if (needs.maxLeverage > BOT_POLICY_BOUNDS.maxLeverage) over.push(`${needs.maxLeverage}× leverage (max ${BOT_POLICY_BOUNDS.maxLeverage}×)`);
  if (needs.ordersPerMinute > BOT_POLICY_BOUNDS.maxOrdersPerMinute) over.push(`${needs.ordersPerMinute} orders a minute (max ${BOT_POLICY_BOUNDS.maxOrdersPerMinute})`);
  if (needs.marketSlippagePct > BOT_POLICY_BOUNDS.priceBandPct) over.push(`a ${needs.marketSlippagePct}% price band (max ${BOT_POLICY_BOUNDS.priceBandPct}%)`);
  if (over.length) throw new BotLimitsTooHighError(`These bots need more than automation allows: ${over.join("; ")}. Lower their sizes.`);

  const next: Policy = { ...policy };
  const actions = [...(policy.allowedActionTypes as readonly string[])];
  for (const a of BOT_ACTION_TYPES) if (!actions.includes(a)) actions.push(a);
  next.allowedActionTypes = actions as Policy["allowedActionTypes"];
  if (policy.allowedOrigins && !policy.allowedOrigins.includes("guardian")) next.allowedOrigins = [...policy.allowedOrigins, "guardian"];
  const missing = missingCoins(policy, needs);
  if (missing === "*") next.allowedCoins = "*";
  else if (missing.length) next.allowedCoins = [...(policy.allowedCoins as readonly string[]), ...missing];
  next.maxOrderNotionalUsd = Math.max(policy.maxOrderNotionalUsd, needs.maxOrderNotionalUsd);
  next.maxDailyNotionalUsd = Math.max(policy.maxDailyNotionalUsd, needs.dailyNotionalUsd, next.maxOrderNotionalUsd);
  next.maxLeverage = Math.max(policy.maxLeverage, needs.maxLeverage);
  next.maxOrdersPerMinute = Math.max(policy.maxOrdersPerMinute, needs.ordersPerMinute);
  if (needs.entriesWithoutStopLoss) next.requireStopLossForNewEntries = false;
  next.priceBandPct = Math.max(policy.priceBandPct, needs.marketSlippagePct);
  const vaults = new Set(policy.allowedVaultAddresses.map((a) => a.toLowerCase()));
  for (const a of needs.vaultAddresses ?? []) vaults.add(a.toLowerCase());
  next.allowedVaultAddresses = [...vaults].sort() as Policy["allowedVaultAddresses"];
  return next;
}
