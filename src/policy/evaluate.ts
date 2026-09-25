/**
 * Policy evaluation. Deny by default:
 * 1. hard-denied types (fund movements, vault/sub-account admin, approvals, referrer, rate-limit purchase, account
 *    config, TWAP) are denied with a specific code even if a policy lists them. One exception: `setReferrer` carrying
 *    exactly the policy's `referralCode`, for the main account (a raw wire action only);
 * 2. anything not in the policy's allow-list is denied;
 * 3. per-action limits: coins, notional, daily notional, leverage, stop-loss requirement, orders per minute,
 *    price band vs mark (orders that execute now: `priceBandPct`; resting limits and untriggered triggers: the wider
 *    resting band, see `band.ts`), vault addresses, required builder, `expiresAfter` window, origin, daily loss lock;
 * 4. spot: denied unless the pair is in `allowedSpotCoins`, and then only as one plain IOC order, with the builder on
 *    sells and none on buys (Hyperliquid charges builder fees on spot sells only). Spot legs are exempt from the
 *    leverage, stop-loss and loss-lock rules, which are about perp exposure.
 *
 * Research basis: agents can sign `vaultTransfer`, `createVault` (10k USDC fee), `createSubAccount`, … (research B
 * §1.7, §1.8), so the signer must decode and check the structured action before hashing.
 *
 * @module
 */
import type { CompiledAction } from "../actions/compile.js";
import type { ActionIntent, IntentOrigin } from "../intents/index.js";
import { decodeAssetId, parseCoin } from "../markets/assetIds.js";
import type { MarketRegistry } from "../markets/registry.js";
import { checkLimitPriceBand, checkTriggerPriceBand, type LimitTif, triggerLimitBandProblem } from "./band.js";
import type { Policy } from "./schema.js";
import { DENIED_ACTION_TYPES, DENIED_MESSAGES, type PolicyViolationCode } from "./types.js";
import { isAddress, wireActionProblems } from "./wire.js";

/** A policy violation. */
export interface PolicyViolation {
  code: PolicyViolationCode;
  message: string;
}

/** Result of {@link evaluatePolicy}. */
export interface PolicyDecision {
  allowed: boolean;
  violations: PolicyViolation[];
  /** HL action type evaluated. */
  actionType: string;
}

/** A raw HL wire action with its envelope (e.g. received by a signer). */
export interface WireActionSubject {
  kind: "wire";
  action: { type: string } & Record<string, unknown>;
  vaultAddress?: string;
  expiresAfter?: number;
  origin?: IntentOrigin;
}

/** A compiled intent (preferred: checks both the intent and the exact wire action, including the builder). */
export interface CompiledSubject {
  kind: "compiled";
  compiled: CompiledAction;
  expiresAfter?: number;
}

/** What {@link evaluatePolicy} can evaluate. */
export type PolicySubject = ActionIntent | WireActionSubject | CompiledSubject;

/** Everything the evaluation needs besides the subject. */
export interface PolicyContext {
  policy: Policy;
  /** Current time (ms). */
  now: number;
  /** Mark price by coin. Needed for price bands and the notional of market intents. */
  markPrices: Readonly<Record<string, number>>;
  /**
   * Book mid by coin, when the evaluator fetched it itself (never from an untrusted caller). Optional: it only
   * refines which limits count as marketable (see `band.ts`).
   */
  midPrices?: Readonly<Record<string, number>>;
  /** Notional already used today (USD), not counting this action. */
  dailyNotionalUsedUsd: number;
  /** Orders placed in the last 60 s, not counting this action. */
  ordersInLastMinute: number;
  /** Needed to resolve asset ids of wire and compiled actions. */
  registry?: MarketRegistry;
  /** Signed policy expiry (ms); evaluation fails at or after it. */
  policyExpiresAt?: number;
  /** For intents: the `expiresAfter` the signer will put on the request. */
  expiresAfter?: number;
  /** Returns true when the coin's position already has an exchange-resident stop-loss. */
  hasStopLoss?: (coin: string) => boolean;
  /** Current leverage setting per coin, when known. */
  leverageByCoin?: Readonly<Record<string, number>>;
  /** Daily loss lock (guardian) active: new entries are denied, reduce-only is allowed. */
  lossLockActive?: boolean;
}

interface OrderLeg {
  coin: string | undefined;
  isBuy: boolean;
  size: number;
  /** Limit price (wire `p`), or undefined for market intents. */
  price: number | undefined;
  triggerPrice: number | undefined;
  isTrigger: boolean;
  tpsl?: "tp" | "sl";
  reduceOnly: boolean;
  /** A spot market (asset id 10000–99999, or a spot coin name on intents). */
  spot: boolean;
  /** Market intents: slippage in bps. */
  slippageBps?: number;
  /** Limit orders: time in force (intents default to GTC). */
  tif?: LimitTif;
}

type AddFn = (code: PolicyViolationCode, message: string) => void;
type Wire = { type: string } & Record<string, unknown>;

/**
 * Evaluates an intent, a compiled action or a raw wire action against `context.policy`.
 * Returns every violation found (not just the first), so UIs can explain all of them. Fails closed: malformed input
 * (non-numeric sizes or prices, wrong types, unknown markets) is a violation, never a pass.
 *
 * Signers should evaluate the **compiled** subject (the exact wire action they will sign) and sign `compiled.action`.
 */
export function evaluatePolicy(subject: PolicySubject, context: PolicyContext): PolicyDecision {
  const violations: PolicyViolation[] = [];
  const add: AddFn = (code, message) => {
    if (!violations.some((x) => x.code === code && x.message === message)) violations.push({ code, message });
  };
  const deny = (actionType: string): PolicyDecision => ({ allowed: false, violations, actionType });
  const policy = context.policy;

  if (typeof subject !== "object" || subject === null || typeof (subject as { kind?: unknown }).kind !== "string") {
    add("INVALID_SUBJECT", "Nothing to evaluate.");
    return deny("unknown");
  }

  // Normalize subject → wire action (when available) + intent (when available) + envelope.
  let intent: ActionIntent | undefined;
  let wire: Wire | undefined;
  let vaultAddress: unknown;
  let expiresAfter: unknown;
  let origin: IntentOrigin | undefined;
  if (subject.kind === "wire") {
    wire = subject.action;
    vaultAddress = subject.vaultAddress;
    expiresAfter = subject.expiresAfter;
    origin = subject.origin;
  } else if (subject.kind === "compiled") {
    intent = subject.compiled.intent;
    wire = subject.compiled.action as unknown as Wire;
    vaultAddress = subject.compiled.vaultAddress;
    expiresAfter = subject.expiresAfter ?? context.expiresAfter;
    origin = intent.origin;
  } else {
    intent = subject;
    vaultAddress = subject.vaultAddress;
    expiresAfter = context.expiresAfter;
    origin = subject.origin;
  }
  if (wire !== undefined && (typeof wire !== "object" || wire === null || typeof wire.type !== "string")) {
    add("INVALID_SUBJECT", "Wire action has no type.");
    return deny("unknown");
  }
  const actionType = wire?.type ?? intentActionType(intent as ActionIntent);

  // 1. Hard denies (own properties only: "__proto__", "constructor", … are not action types). `setReferrer` goes on to
  // the checks below only when the policy names Kokoah's code and the subject is the raw wire action.
  const referrer = actionType === "setReferrer" && policy.referralCode !== undefined && subject.kind === "wire";
  if (Object.hasOwn(DENIED_ACTION_TYPES, actionType) && !referrer) {
    const denied = DENIED_ACTION_TYPES[actionType] as PolicyViolationCode;
    add(denied, DENIED_MESSAGES[denied] ?? `Action "${actionType}" is never allowed.`);
    return deny(actionType);
  }
  // 2. Allow-list (the policy's `referralCode` is what allows `setReferrer`).
  if (!referrer && !(policy.allowedActionTypes as readonly string[]).includes(actionType)) {
    add("ACTION_TYPE_NOT_ALLOWED", `Action "${actionType}" is not allowed by this policy.`);
    return deny(actionType);
  }
  // 3. Structure: fail closed on anything malformed.
  if (vaultAddress !== undefined && !isAddress(vaultAddress)) add("INVALID_SUBJECT", "vaultAddress must be a 20-byte hex address.");
  if (expiresAfter !== undefined && !(typeof expiresAfter === "number" && Number.isSafeInteger(expiresAfter))) add("INVALID_SUBJECT", "expiresAfter must be an integer (ms).");
  if (wire) for (const problem of wireActionProblems(wire)) add("INVALID_SUBJECT", problem);
  if (violations.length > 0) return deny(actionType);

  // 4. Envelope checks.
  if (context.policyExpiresAt !== undefined && !(context.now < context.policyExpiresAt)) add("POLICY_EXPIRED", "The signed policy has expired.");
  if (policy.allowedOrigins && (origin === undefined || !policy.allowedOrigins.includes(origin))) {
    add("ORIGIN_NOT_ALLOWED", `Origin "${origin ?? "unknown"}" is not allowed by this policy.`);
  }
  if (typeof vaultAddress === "string" && !policy.allowedVaultAddresses.includes(vaultAddress.toLowerCase() as `0x${string}`)) {
    add("VAULT_NOT_ALLOWED", `Acting for ${vaultAddress} is not allowed by this policy.`);
  }
  if (policy.maxExpiresAfterWindowMs !== null) {
    if (typeof expiresAfter !== "number") add("EXPIRES_AFTER_REQUIRED", "Actions must carry an expiresAfter deadline.");
    else if (expiresAfter <= context.now) add("EXPIRES_AFTER_IN_PAST", "expiresAfter is already in the past.");
    else if (expiresAfter - context.now > policy.maxExpiresAfterWindowMs) {
      add("EXPIRES_AFTER_TOO_FAR", `expiresAfter is more than ${policy.maxExpiresAfterWindowMs} ms in the future.`);
    }
  }

  // 5. Per-action checks. Wire values win over intent values: the wire action is what gets signed.
  const coinAllowed = (coin: string): boolean => policy.allowedCoins === "*" || policy.allowedCoins.includes(coin);
  const checkCoin = (coin: string | undefined): void => {
    if (coin !== undefined && !coinAllowed(coin)) add("COIN_NOT_ALLOWED", `${coin} is not in the allowed markets.`);
  };
  switch (actionType) {
    case "updateLeverage": {
      const lev = wire ? (wire.leverage as number) : intent?.kind === "updateLeverage" ? intent.leverage : Number.NaN;
      checkCoin(wire ? resolveCoin(wire.asset as number, context, add) : intent?.kind === "updateLeverage" ? intent.coin : undefined);
      if (!(lev <= policy.maxLeverage)) add("LEVERAGE_EXCEEDED", `Leverage ${lev}x is above the policy maximum of ${policy.maxLeverage}x.`);
      break;
    }
    case "updateIsolatedMargin":
    case "topUpIsolatedOnlyMargin":
      checkCoin(wire ? resolveCoin(wire.asset as number, context, add) : intent?.kind === "updateIsolatedMargin" ? intent.coin : undefined);
      break;
    case "cancel":
    case "cancelByCloid": {
      // Cancels are exempt from notional and rate limits, but a key restricted to some markets may only touch those.
      if (wire) {
        for (const c of wire.cancels as Array<{ a?: number; asset?: number }>) checkCoin(resolveCoin((c.a ?? c.asset) as number, context, add));
      } else if (intent?.kind === "cancel") {
        for (const c of intent.cancels) checkCoin(c.coin);
      }
      break;
    }
    case "modify":
    case "batchModify":
      // "a: true" (always place) places the new order even when nothing was cancelled — an order without a builder.
      if (policy.requiredBuilder && wire?.a === true) add("BUILDER_REQUIRED", "Always-place modifies would place orders without the Kokoah builder code.");
      break;
    case "setReferrer":
      if (wire?.code !== policy.referralCode) add("REFERRER_ACTION_DENIED", "Only Kokoah's own referral code can be set.");
      if (vaultAddress !== undefined) add("REFERRER_ACTION_DENIED", "A referrer can only be set for the main account.");
      break;
    case "startFeeTrial":
      if (vaultAddress !== undefined) add("VAULT_NOT_ALLOWED", "The fee trial can only be started for the main account.");
      break;
    default:
      break;
  }

  const legs = collectOrderLegs(intent, wire, context, add);
  if (legs.length > 0) checkOrderLegs(legs, actionType, wire, context, coinAllowed, add);

  return { allowed: violations.length === 0, violations, actionType };
}

function checkOrderLegs(legs: OrderLeg[], actionType: string, wire: Wire | undefined, context: PolicyContext, coinAllowed: (coin: string) => boolean, add: AddFn): void {
  const policy = context.policy;
  const exempt = policy.exemptReduceOnlyFromNotionalCaps;
  const band = policy.priceBandPct;
  let actionNotional = 0;
  for (const leg of legs) {
    if (leg.coin === undefined) continue;
    if (!coinAllowed(leg.coin)) add("COIN_NOT_ALLOWED", `${leg.coin} is not in the allowed markets.`);
    const rawMark = context.markPrices[leg.coin];
    const mark = typeof rawMark === "number" && Number.isFinite(rawMark) && rawMark > 0 ? rawMark : undefined;
    if (!(leg.size > 0) || (leg.price !== undefined && !(leg.price > 0)) || (leg.triggerPrice !== undefined && !(leg.triggerPrice > 0))) {
      add("INVALID_SUBJECT", `${leg.coin}: size and prices must be positive numbers.`);
      continue;
    }
    // Notional at the worst plausible price: limit, trigger or (for triggers that may fire now) mark.
    let px: number;
    if (leg.isTrigger) {
      px = Math.max(leg.price ?? 0, leg.triggerPrice ?? 0, mark ?? 0);
    } else if (leg.price !== undefined) {
      px = leg.price;
    } else if (mark !== undefined) {
      px = mark * (1 + (leg.slippageBps ?? 0) / 10_000);
    } else {
      add("MARK_PRICE_UNAVAILABLE", `No mark price for ${leg.coin}.`);
      continue;
    }
    const notionalUsd = leg.size * px;
    if (!(leg.reduceOnly && exempt)) {
      actionNotional += notionalUsd;
      if (!(notionalUsd <= policy.maxOrderNotionalUsd)) {
        add("ORDER_NOTIONAL_EXCEEDED", `Order notional $${fmt(notionalUsd)} is above the $${fmt(policy.maxOrderNotionalUsd)} limit.`);
      }
    }
    // Price band (see band.ts): orders that execute now within `priceBandPct` of mark; resting limits and untriggered
    // triggers within the wider resting band.
    if (!leg.isTrigger) {
      if (leg.price === undefined) {
        const slipPct = (leg.slippageBps ?? 0) / 100;
        if (slipPct > band) add("PRICE_OUTSIDE_BAND", `Slippage ${slipPct}% is wider than the ${band}% price band.`);
      } else if (mark === undefined) {
        add("MARK_PRICE_UNAVAILABLE", `No mark price for ${leg.coin}.`);
      } else {
        const rawMid = context.midPrices?.[leg.coin];
        const check = checkLimitPriceBand({
          isBuy: leg.isBuy,
          price: leg.price,
          mark,
          mid: typeof rawMid === "number" && Number.isFinite(rawMid) && rawMid > 0 ? rawMid : undefined,
          tif: leg.tif,
          bandPct: band,
          label: leg.coin,
        });
        if (!check.ok) add("PRICE_OUTSIDE_BAND", check.message);
      }
    } else if (mark === undefined) {
      // The limit-vs-trigger part needs no mark; check it before reporting the missing mark.
      const problem = triggerLimitBandProblem({ triggerPrice: leg.triggerPrice as number, limitPrice: leg.price, bandPct: band, label: leg.coin });
      if (problem) add("PRICE_OUTSIDE_BAND", problem);
      add("MARK_PRICE_UNAVAILABLE", `No mark price for ${leg.coin}.`);
    } else {
      const check = checkTriggerPriceBand({
        isBuy: leg.isBuy,
        tpsl: leg.tpsl ?? "sl",
        triggerPrice: leg.triggerPrice as number,
        limitPrice: leg.price,
        mark,
        bandPct: band,
        label: leg.coin,
      });
      for (const p of check.problems) add("PRICE_OUTSIDE_BAND", p);
    }
    // Leverage of the market, when known.
    const lev = leg.spot ? undefined : context.leverageByCoin?.[leg.coin];
    if (!leg.reduceOnly && lev !== undefined && !(lev <= policy.maxLeverage)) {
      add("LEVERAGE_EXCEEDED", `${leg.coin} is set to ${lev}x, above the policy maximum of ${policy.maxLeverage}x.`);
    }
  }
  if (!(context.dailyNotionalUsedUsd + actionNotional <= policy.maxDailyNotionalUsd)) {
    add(
      "DAILY_NOTIONAL_EXCEEDED",
      `Daily notional would reach $${fmt(context.dailyNotionalUsedUsd + actionNotional)}, above the $${fmt(policy.maxDailyNotionalUsd)} limit.`,
    );
  }
  // New exposure: non-reduce-only perp orders, including modifies (which can rewrite any resting order).
  const entries = legs.filter((l) => !l.reduceOnly && l.coin !== undefined && !l.spot);
  if (entries.length > 0) {
    if (context.lossLockActive) add("DAILY_LOSS_LOCKED", "The daily loss lock is active: only closing and reducing orders are allowed.");
    if (policy.requireStopLossForNewEntries) {
      for (const e of entries) {
        if (context.hasStopLoss?.(e.coin as string) === true) continue;
        if (actionType !== "order") {
          add("STOP_LOSS_REQUIRED", `${e.coin} has no stop-loss; modified entries need an existing exchange stop.`);
          continue;
        }
        const problem = attachedStopProblem(e, legs, context.markPrices[e.coin as string], policy.maxStopLossDistancePct);
        if (problem) add("STOP_LOSS_REQUIRED", problem);
      }
    }
  }
  // Rate (orders created by this action; cancels have no order legs and are exempt).
  if (!(context.ordersInLastMinute + legs.length <= policy.maxOrdersPerMinute)) {
    add("ORDER_RATE_EXCEEDED", `More than ${policy.maxOrdersPerMinute} orders per minute.`);
  }
  if (legs.some((l) => l.spot)) checkSpotLegs(legs, actionType, wire, policy, add);
  // Builder (order actions; modify actions carry no builder field). Spot buys carry none: Hyperliquid charges builder
  // fees on spot sells only.
  if (policy.requiredBuilder && wire?.type === "order") {
    const b = wire.builder as { b?: string; f?: number } | undefined;
    if (legs.length > 0 && legs.every((l) => l.spot && l.isBuy)) {
      if (b !== undefined) add("BUILDER_MISMATCH", "Spot buys carry no builder fee (Hyperliquid charges it on spot sells only).");
    } else if (!b) add("BUILDER_REQUIRED", "Orders must carry the Kokoah builder code.");
    else if (b.b?.toLowerCase() !== policy.requiredBuilder.b || b.f !== policy.requiredBuilder.f) {
      add("BUILDER_MISMATCH", `Builder must be ${policy.requiredBuilder.b} with f=${policy.requiredBuilder.f}.`);
    }
  }
}

/**
 * Spot: only pairs in `allowedSpotCoins` (Convert's stablecoin pairs), and only as one plain IOC order: no modify, no
 * triggers, no reduce-only, no TP/SL grouping. Spot trading beyond that is a separate, later decision.
 */
function checkSpotLegs(legs: OrderLeg[], actionType: string, wire: Wire | undefined, policy: Policy, add: AddFn): void {
  const allowed = policy.allowedSpotCoins ?? [];
  for (const leg of legs) {
    if (!leg.spot || leg.coin === undefined) continue;
    if (!allowed.includes(leg.coin)) add("SPOT_NOT_ALLOWED", `${leg.coin}: spot trading is not available; only stablecoin conversions on listed pairs are.`);
  }
  if (actionType !== "order") {
    add("SPOT_NOT_ALLOWED", "Spot orders cannot be modified.");
    return;
  }
  if (legs.length !== 1) add("SPOT_NOT_ALLOWED", "A spot order must be a single order.");
  const grouping = wire?.grouping;
  if (grouping !== undefined && grouping !== "na") add("SPOT_NOT_ALLOWED", "A spot order cannot carry TP/SL grouping.");
  for (const leg of legs) {
    if (!leg.spot) continue;
    if (leg.isTrigger || leg.reduceOnly) add("SPOT_NOT_ALLOWED", "Spot orders must be plain orders (no triggers, no reduce-only).");
    // Market intents (no limit price) compile to IOC; wire and limit intents must say IOC.
    else if (!(leg.price === undefined || leg.tif === "Ioc")) add("SPOT_NOT_ALLOWED", "Spot orders must be immediate-or-cancel.");
  }
}

/**
 * An entry is protected when an attached stop-loss leg (reduce-only, opposite side, same coin) covers its full size,
 * sits on the losing side of the entry and, when the policy sets `maxStopLossDistancePct`, is close enough to it.
 */
function attachedStopProblem(entry: OrderLeg, legs: OrderLeg[], rawMark: number | undefined, maxDistancePct: number | undefined): string | null {
  const stops = legs.filter((l) => l.reduceOnly && l.isTrigger && l.tpsl === "sl" && l.coin === entry.coin && l.isBuy !== entry.isBuy);
  if (stops.length === 0) return `New ${entry.coin} entries need a stop-loss.`;
  const ref = entry.isTrigger ? entry.triggerPrice : (entry.price ?? rawMark);
  for (const sl of stops) {
    if (!(sl.size >= entry.size)) continue;
    const t = sl.triggerPrice as number;
    if (ref === undefined || !(ref > 0)) return `Cannot check the ${entry.coin} stop-loss without an entry or mark price.`;
    if (!(entry.isBuy ? t < ref : t > ref)) continue;
    if (maxDistancePct !== undefined && !((Math.abs(ref - t) / ref) * 100 <= maxDistancePct + 1e-9)) continue;
    return null;
  }
  return maxDistancePct !== undefined
    ? `The ${entry.coin} stop-loss must cover the whole entry, sit on the losing side and be within ${maxDistancePct}% of the entry.`
    : `The ${entry.coin} stop-loss must cover the whole entry and sit on the losing side.`;
}

function intentActionType(intent: ActionIntent): string {
  if (intent.kind === "cancel") return intent.cancels.every((c) => "cloid" in c) ? "cancelByCloid" : "cancel";
  return intent.kind;
}

function resolveCoin(assetId: number, context: PolicyContext, add: AddFn): string | undefined {
  if (!context.registry) {
    add("UNKNOWN_MARKET", "A market registry is required to evaluate wire actions.");
    return undefined;
  }
  const m = Number.isSafeInteger(assetId) ? context.registry.getByAssetId(assetId) : undefined;
  if (!m) {
    add("UNKNOWN_MARKET", `Unknown asset id ${assetId}.`);
    return undefined;
  }
  if (m.isDelisted) add("UNKNOWN_MARKET", `${m.coin} is delisted.`);
  return m.coin;
}

function tpslOf(orderType: string): "tp" | "sl" {
  return orderType.startsWith("stop") ? "sl" : "tp";
}

/** Order legs of the subject. Wire actions have already passed `wireActionProblems`. */
function collectOrderLegs(intent: ActionIntent | undefined, wire: Wire | undefined, context: PolicyContext, add: AddFn): OrderLeg[] {
  if (wire && (wire.type === "order" || wire.type === "modify" || wire.type === "batchModify")) {
    const raw: unknown[] =
      wire.type === "order" ? (wire.orders as unknown[]) : wire.type === "modify" ? [wire.order] : (wire.modifies as Array<{ order: unknown }>).map((m) => m.order);
    return raw.map((o) => {
      const w = o as { a: number; b: boolean; p: string; s: string; r: boolean; t: { limit?: { tif: LimitTif }; trigger?: { triggerPx: string; tpsl: "tp" | "sl" } } };
      const trig = w.t.trigger;
      const tif = w.t.limit?.tif;
      return {
        coin: resolveCoin(w.a, context, add),
        isBuy: w.b,
        size: Number(w.s),
        price: Number(w.p),
        triggerPrice: trig ? Number(trig.triggerPx) : undefined,
        isTrigger: trig !== undefined,
        ...(trig ? { tpsl: trig.tpsl } : {}),
        ...(tif !== undefined ? { tif } : {}),
        reduceOnly: w.r,
        spot: isSpotAsset(w.a),
      };
    });
  }
  if (wire) return [];
  if (intent?.kind === "order") {
    const isTrigger = intent.orderType !== "market" && intent.orderType !== "limit";
    const parent: OrderLeg = {
      coin: intent.coin,
      isBuy: intent.side === "buy",
      size: Number(intent.size),
      // Market-type triggers: the compiler uses trigger ± 10%; the trigger stands in for the limit price here.
      price: intent.price !== undefined ? Number(intent.price) : isTrigger && intent.triggerPrice !== undefined ? Number(intent.triggerPrice) : undefined,
      triggerPrice: intent.triggerPrice !== undefined ? Number(intent.triggerPrice) : undefined,
      isTrigger,
      ...(isTrigger ? { tpsl: tpslOf(intent.orderType) } : {}),
      reduceOnly: intent.reduceOnly,
      spot: isSpotCoin(intent.coin),
      ...(intent.orderType === "market" ? { slippageBps: intent.slippageBps ?? 100 } : {}),
      ...(intent.orderType === "limit" ? { tif: intent.tif ?? "Gtc" } : {}),
    };
    const legs: OrderLeg[] = [parent];
    const attached = [
      [intent.takeProfit, "tp"],
      [intent.stopLoss, "sl"],
    ] as const;
    for (const [leg, tpsl] of attached) {
      if (!leg) continue;
      legs.push({
        coin: intent.coin,
        isBuy: !parent.isBuy,
        size: Number(intent.size),
        price: Number(leg.limitPrice ?? leg.triggerPrice),
        triggerPrice: Number(leg.triggerPrice),
        isTrigger: true,
        tpsl,
        reduceOnly: true,
        spot: parent.spot,
      });
    }
    return legs;
  }
  if (intent?.kind === "modify") {
    const o = intent.order;
    const isTrigger = o.orderType !== "limit";
    return [
      {
        coin: o.coin,
        isBuy: o.side === "buy",
        size: Number(o.size),
        price: o.price !== undefined ? Number(o.price) : o.triggerPrice !== undefined ? Number(o.triggerPrice) : undefined,
        triggerPrice: o.triggerPrice !== undefined ? Number(o.triggerPrice) : undefined,
        isTrigger,
        ...(isTrigger ? { tpsl: tpslOf(o.orderType) } : { tif: o.tif ?? "Gtc" }),
        reduceOnly: o.reduceOnly,
        spot: isSpotCoin(o.coin),
      },
    ];
  }
  return [];
}

function isSpotAsset(assetId: number): boolean {
  try {
    return decodeAssetId(assetId).kind === "spot";
  } catch {
    return false;
  }
}

function isSpotCoin(coin: string): boolean {
  const kind = parseCoin(coin)?.kind;
  return kind === "spotIndex" || kind === "spotPair";
}

function fmt(x: number): string {
  return (Math.round(x * 100) / 100).toString();
}
