/**
 * Policy evaluation. Deny by default:
 * 1. hard-denied types (fund movements, vault/sub-account admin, approvals, referrer, rate-limit purchase, account
 *    config, TWAP) are denied with a specific code even if a policy lists them. One exception: `setReferrer` carrying
 *    exactly the policy's `referralCode`, for the main account (a raw wire action only);
 * 2. anything not in the policy's allow-list is denied;
 * 3. per-action limits: coins, notional, daily notional, leverage, stop-loss requirement (a stop-limit counts only when
 *    its limit can fill, see `stopCoverage.ts`; origin `bot` is exempt only when the policy says
 *    `botEntriesWithoutStopLoss`, and then only for its entries and its own orders), orders per minute, isolated
 *    margin (automation only adds it, at most `maxOrderNotionalUsd` at a time, counted toward the daily notional and
 *    the per-minute rate),
 *    price band vs mark (orders that execute now: `priceBandPct`; resting limits and untriggered triggers: the wider
 *    resting band; a trigger's limit within `priceBandPct` of its trigger unless it is reduce-only and away from the
 *    mark, then max(`priceBandPct`, 10%); see `band.ts`), vault addresses, required builder, `expiresAfter` window, origin, daily loss lock,
 *    `scheduleCancel` at most 1 h ahead, and (with `requireStopCoverage`) no cancel or modify that takes stop-loss
 *    cover away from a position, no entry that leaves the position it adds to partly covered, and no `scheduleCancel`
 *    set at all;
 * 4. spot: denied unless the pair is in `allowedSpotCoins`, and then only as one plain order (IOC, or with
 *    `spotTrading` also GTC and post-only limits within the bands), with the builder on sells and none on buys
 *    (Hyperliquid charges builder fees on spot sells only). Spot legs are exempt from the leverage, stop-loss and
 *    loss-lock rules, which are about perp exposure.
 *
 * Research basis: agents can sign `vaultTransfer`, `createVault` (10k USDC fee), `createSubAccount`, … (research B
 * §1.7, §1.8), so the signer must decode and check the structured action before hashing.
 *
 * @module
 */
import { parseCloid } from "../actions/cloid.js";
import { type CompiledAction, SCHEDULE_CANCEL_MAX_LEAD_MS } from "../actions/compile.js";
import type { ActionIntent, IntentOrigin } from "../intents/index.js";
import { decodeAssetId, parseCoin } from "../markets/assetIds.js";
import type { MarketRegistry } from "../markets/registry.js";
import { checkLimitPriceBand, checkTriggerPriceBand, type LimitTif, triggerLimitBandProblem } from "./band.js";
import type { Policy } from "./schema.js";
import { type AccountBook, namedOrderRefs, positionAfterEntriesProblem, STOP_COVERAGE_ACTION_TYPES, stopCanFill, stopCoverageProblems } from "./stopCoverage.js";
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
  /**
   * The traded account's open isolated positions, by coin, with the leverage each is at now, read by the signer itself.
   * Raising that leverage takes margin out of the position (closer to liquidation), like removing margin: automation may
   * not do it. Given for `updateLeverage`; see {@link PolicyContext.requireIsolatedPositions}.
   */
  isolatedPositionLeverage?: Readonly<Record<string, number>>;
  /**
   * An `updateLeverage` of automation must come with {@link PolicyContext.isolatedPositionLeverage} (an unread account
   * is refused, never taken for one without isolated positions). For signers that read it themselves (the signer
   * service); previews leave it unset.
   */
  requireIsolatedPositions?: boolean;
  /**
   * With `policy.requireStopLossForNewEntries`, cancels and modifies (the exact wire action) must not take stop-loss
   * cover away from a position, and an order's entries must leave the whole position they add to covered
   * (`stopCoverage.ts`), checked against `accountBook`; without it they are `STOP_LOSS_REQUIRED`, and so is setting a
   * `scheduleCancel` (it would cancel every stop-loss when it fires; clearing one stays allowed). For signers that read
   * the traded account's positions and orders themselves (the signer service, the signer frame); others leave it
   * unset. Where the policy says `botEntriesWithoutStopLoss`, origin `bot` is exempt for its entries, and its cancels
   * and modifies only for orders whose cloid carries the bot origin (its own: no other origin may place one). That
   * exemption trusts any order on the book whose cloid carries the bot byte, including ones not placed through a Kokoah
   * signer (on Hyperliquid directly, or before only bots could place them), which this check can't tell apart.
   */
  requireStopCoverage?: boolean;
  /** The traded account's positions and resting orders on the markets the action touches, read by the signer itself. */
  accountBook?: AccountBook;
  /**
   * Every perp entry leg (not reduce-only) must have its coin in `leverageByCoin`: a missing one is `LEVERAGE_EXCEEDED`
   * instead of a leg whose leverage goes unchecked. For signers that read the account's leverage themselves (the signer
   * service); previews and callers without it leave it unset and keep checking only what they know.
   */
  requireLeverage?: boolean;
  /** Daily loss lock (guardian) active: new entries are denied, reduce-only is allowed. */
  lossLockActive?: boolean;
  /**
   * Today's realized loss (USD, positive = loss; {@link dailyRealizedLossUsd}) for `policy.maxDailyLossUsd`. Checked
   * only when given: the signer service always measures it when the policy sets the limit; previews may leave it out.
   */
  dailyLossUsd?: number;
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
  /** A market trigger (wire `isMarket`; stopMarket, takeProfitMarket and market TP/SL legs on intents). */
  isMarket?: boolean;
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
      const coin = wire ? resolveCoin(wire.asset as number, context, add) : intent?.kind === "updateLeverage" ? intent.coin : undefined;
      checkCoin(coin);
      if (!(lev <= policy.maxLeverage)) add("LEVERAGE_EXCEEDED", `Leverage ${lev}x is above the policy maximum of ${policy.maxLeverage}x.`);
      // Raising the leverage of an open isolated position takes margin out of it, which no notional cap covers: like
      // removing margin, automation (see updateIsolatedMargin below) may lower it, never raise it, nor switch the
      // position's margin mode. Lowering it only adds margin to the position, as adding margin does.
      const cross = wire ? wire.isCross !== false : intent?.kind === "updateLeverage" && intent.marginMode !== "isolated";
      if (isAutomation(policy, origin) && coin !== undefined) {
        const now = context.isolatedPositionLeverage;
        if (now === undefined) {
          if (context.requireIsolatedPositions === true && !cross) {
            add("ACTION_TYPE_NOT_ALLOWED", `The account's isolated ${coin} position could not be checked, so its leverage is not changed.`);
          } else if (context.requireIsolatedPositions === true) {
            add("ACTION_TYPE_NOT_ALLOWED", `The account's ${coin} position could not be checked, so its margin mode is not changed.`);
          }
        } else if (Object.hasOwn(now, coin)) {
          if (cross) add("ACTION_TYPE_NOT_ALLOWED", `Automation may not switch the open isolated ${coin} position to cross margin.`);
          else if (!(lev <= (now[coin] as number))) {
            add("ACTION_TYPE_NOT_ALLOWED", `Automation may lower the leverage of the isolated ${coin} position, not raise it (from ${now[coin]}x to ${lev}x): that takes margin out of it.`);
          }
        }
      }
      break;
    }
    case "updateIsolatedMargin":
    case "topUpIsolatedOnlyMargin": {
      checkCoin(wire ? resolveCoin(wire.asset as number, context, add) : intent?.kind === "updateIsolatedMargin" ? intent.coin : undefined);
      // Automation (a key without manual trading, such as the servers' automation keys, or any origin other than the
      // user's own hand) may add margin to an isolated position, never take it out: removing it moves the user's own
      // position toward liquidation, which no notional cap covers. It adds at most `maxOrderNotionalUsd` at a time (the
      // margin of the largest order the key may place, even at 1×), never the account's whole cross collateral at once.
      // `topUpIsolatedOnlyMargin` names a target leverage instead of an amount, so it can't be capped: automation doesn't
      // sign it.
      const automation = isAutomation(policy, origin);
      const amountUsd = wire ? Number(wire.ntli) / 1e6 : intent?.kind === "updateIsolatedMargin" ? Number(intent.amountUsd) : Number.NaN;
      if (automation) {
        if (actionType === "topUpIsolatedOnlyMargin") {
          add("ACTION_TYPE_NOT_ALLOWED", "Automation may add isolated margin only as an amount (updateIsolatedMargin), so it can be capped.");
        } else if (!(amountUsd > 0)) {
          add("ACTION_TYPE_NOT_ALLOWED", "Automation may add margin to an isolated position, not remove it.");
        } else if (!(amountUsd <= policy.maxOrderNotionalUsd)) {
          add("ORDER_NOTIONAL_EXCEEDED", `Adding $${fmt(amountUsd)} of margin at once is above the $${fmt(policy.maxOrderNotionalUsd)} order limit.`);
        }
        // Each addition also counts like an order toward the daily notional and the per-minute rate, so automation can't
        // move the account's cross collateral into one position faster or further than it may trade.
        if (amountUsd > 0) {
          if (!(context.dailyNotionalUsedUsd + amountUsd <= policy.maxDailyNotionalUsd)) {
            add("DAILY_NOTIONAL_EXCEEDED", `Daily notional would reach $${fmt(context.dailyNotionalUsedUsd + amountUsd)}, above the $${fmt(policy.maxDailyNotionalUsd)} limit.`);
          }
          if (!(context.ordersInLastMinute + 1 <= policy.maxOrdersPerMinute)) add("ORDER_RATE_EXCEEDED", `More than ${policy.maxOrdersPerMinute} orders per minute.`);
        }
      }
      break;
    }
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
    case "scheduleCancel": {
      // It cancels every open order, the user's own stops included: no further out than `compileAction` allows, also for
      // a raw wire action.
      const time = wire ? wire.time : intent?.kind === "scheduleCancel" ? intent.time : undefined;
      if (typeof time === "number" && time > context.now + SCHEDULE_CANCEL_MAX_LEAD_MS) {
        add("INVALID_SUBJECT", "scheduleCancel time must be at most 1 hour in the future.");
      }
      break;
    }
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

  // Stops required: a cancel or modify must not take stop-loss cover away from a position afterwards, and a dead man's
  // switch (which cancels every open order, stop-losses included, when it fires) is never set; clearing one is fine.
  // Bots the policy lets trade without stops may still cancel and change their own orders (bot-origin cloids), never
  // the user's or a guardian's stops.
  const botExempt = origin === "bot" && policy.botEntriesWithoutStopLoss === true;
  const stopsGuarded = context.requireStopCoverage === true && policy.requireStopLossForNewEntries;
  if (stopsGuarded && actionType === "scheduleCancel") {
    const time = wire ? wire.time : intent?.kind === "scheduleCancel" ? intent.time : undefined;
    if (time !== undefined && time !== null) add("STOP_LOSS_REQUIRED", "A scheduled cancel-all would also cancel the stop-losses this policy requires.");
  }
  // An exempt bot's action that names only its own orders needs no account read.
  const ownOrdersOnly = (w: Wire): boolean => {
    const refs = namedOrderRefs(w);
    return botExempt && refs.length > 0 && refs.every((r) => typeof r === "string" && isBotCloid(r));
  };
  if (stopsGuarded && wire !== undefined && STOP_COVERAGE_ACTION_TYPES.includes(actionType) && !ownOrdersOnly(wire)) {
    if (!context.accountBook || !context.registry) {
      add("STOP_LOSS_REQUIRED", "The account's open positions and stop-losses could not be checked, so no order is cancelled or changed.");
    } else {
      const problems = stopCoverageProblems({
        action: wire,
        book: context.accountBook,
        registry: context.registry,
        maxStopLossDistancePct: policy.maxStopLossDistancePct,
        ...(botExempt ? { exempt: isBotCloid } : {}),
      });
      for (const p of problems) add("STOP_LOSS_REQUIRED", p);
    }
  }

  // A cloid with the bot origin marks a bot's own order, which an exempt bot may cancel or change freely: only a bot
  // may place one.
  if (origin !== "bot" && placedCloids(intent, wire).some((c) => isBotCloid(c))) {
    add("ORIGIN_NOT_ALLOWED", `Only origin "bot" may place an order whose cloid carries the bot origin.`);
  }

  const legs = collectOrderLegs(intent, wire, context, add);
  if (legs.length > 0) checkOrderLegs(legs, actionType, wire, context, coinAllowed, add, origin);

  return { allowed: violations.length === 0, violations, actionType };
}

function checkOrderLegs(
  legs: OrderLeg[],
  actionType: string,
  wire: Wire | undefined,
  context: PolicyContext,
  coinAllowed: (coin: string) => boolean,
  add: AddFn,
  origin: IntentOrigin | undefined,
): void {
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
    // Notional at the worst plausible price: limit, trigger or mark (a sell's limit, e.g. a market sell's slippage
    // price, can sit well below the value it trades).
    let px: number;
    if (leg.isTrigger) {
      px = Math.max(leg.price ?? 0, leg.triggerPrice ?? 0, mark ?? 0);
    } else if (leg.price !== undefined) {
      px = Math.max(leg.price, mark ?? 0);
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
      const problem = triggerLimitBandProblem({
        triggerPrice: leg.triggerPrice as number,
        limitPrice: leg.price,
        bandPct: band,
        label: leg.coin,
        reduceOnly: leg.reduceOnly === true,
        isBuy: leg.isBuy,
        tpsl: leg.tpsl ?? "sl",
      });
      if (problem) add("PRICE_OUTSIDE_BAND", problem);
      add("MARK_PRICE_UNAVAILABLE", `No mark price for ${leg.coin}.`);
    } else {
      // The limit's allowance from its trigger: max(band, 10%) only for a reduce-only trigger away from the mark.
      const check = checkTriggerPriceBand({
        isBuy: leg.isBuy,
        tpsl: leg.tpsl ?? "sl",
        triggerPrice: leg.triggerPrice as number,
        limitPrice: leg.price,
        mark,
        bandPct: band,
        label: leg.coin,
        reduceOnly: leg.reduceOnly === true,
      });
      for (const p of check.problems) add("PRICE_OUTSIDE_BAND", p);
    }
    // Leverage of the market, when known (and required to be known with `requireLeverage`).
    const lev = leg.spot ? undefined : context.leverageByCoin?.[leg.coin];
    if (!leg.reduceOnly && lev !== undefined && !(lev <= policy.maxLeverage)) {
      add("LEVERAGE_EXCEEDED", `${leg.coin} is set to ${lev}x, above the policy maximum of ${policy.maxLeverage}x.`);
    } else if (!leg.reduceOnly && !leg.spot && lev === undefined && context.requireLeverage === true) {
      add("LEVERAGE_EXCEEDED", `${leg.coin}: the account's current leverage is unknown, so the ${policy.maxLeverage}x maximum can't be checked.`);
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
    if (policy.maxDailyLossUsd !== undefined && context.dailyLossUsd !== undefined && !(context.dailyLossUsd < policy.maxDailyLossUsd)) {
      add(
        "DAILY_LOSS_LIMIT",
        `Today's realized loss of $${fmt(context.dailyLossUsd)} reached the $${fmt(policy.maxDailyLossUsd)} daily loss limit: only closing and reducing orders are allowed until 00:00 UTC.`,
      );
    }
    // Bots manage their own exits: the user's signed `botEntriesWithoutStopLoss` exempts origin `bot` only.
    const botExempt = origin === "bot" && policy.botEntriesWithoutStopLoss === true;
    if (policy.requireStopLossForNewEntries && !botExempt) {
      const failed = new Set<string>();
      for (const e of entries) {
        if (context.hasStopLoss?.(e.coin as string) === true) continue;
        if (actionType !== "order") {
          add("STOP_LOSS_REQUIRED", `${e.coin} has no stop-loss; modified entries need an existing exchange stop.`);
          failed.add(e.coin as string);
          continue;
        }
        const problem = attachedStopProblem(e, legs, context.markPrices[e.coin as string], policy.maxStopLossDistancePct);
        if (problem) {
          add("STOP_LOSS_REQUIRED", problem);
          failed.add(e.coin as string);
        }
      }
      // The whole position each entry adds to, as the signer read the account (`requireStopCoverage`).
      if (context.requireStopCoverage === true && actionType === "order") {
        for (const coin of new Set(entries.map((e) => e.coin as string))) {
          if (failed.has(coin) || context.hasStopLoss?.(coin) === true) continue;
          if (!context.accountBook) {
            add("STOP_LOSS_REQUIRED", "The account's open positions and stop-losses could not be checked, so no position is opened or added to.");
            break;
          }
          const problem = positionAfterEntriesProblem({ coin, legs, book: context.accountBook, mark: context.markPrices[coin], maxStopLossDistancePct: policy.maxStopLossDistancePct });
          if (problem) add("STOP_LOSS_REQUIRED", problem);
        }
      }
    }
  }
  // Rate (orders created by this action; cancels have no order legs and are exempt).
  if (!(context.ordersInLastMinute + legs.length <= policy.maxOrdersPerMinute)) {
    add("ORDER_RATE_EXCEEDED", `More than ${policy.maxOrdersPerMinute} orders per minute.`);
  }
  if (legs.some((l) => l.spot)) checkSpotLegs(legs, actionType, wire, policy, add);
  // Builder (order actions; modify actions carry no builder field). Spot buys carry none: Hyperliquid charges builder
  // fees on spot sells only. The policy's fee is the most an order may pay: a promotion (BuilderFeeSchedule) charges less.
  if (policy.requiredBuilder && wire?.type === "order") {
    const b = wire.builder as { b?: string; f?: number } | undefined;
    if (legs.length > 0 && legs.every((l) => l.spot && l.isBuy)) {
      if (b !== undefined) add("BUILDER_MISMATCH", "Spot buys carry no builder fee (Hyperliquid charges it on spot sells only).");
    } else if (!b) add("BUILDER_REQUIRED", "Orders must carry the Kokoah builder code.");
    else if (b.b?.toLowerCase() !== policy.requiredBuilder.b || !(Number.isInteger(b.f) && b.f! >= 0 && b.f! <= policy.requiredBuilder.f)) {
      add("BUILDER_MISMATCH", `Builder must be ${policy.requiredBuilder.b} with f at most ${policy.requiredBuilder.f}.`);
    }
  }
}

/** Time-in-force values a spot limit may carry when `spotTrading` is on (`FrontendMarket` is Hyperliquid's own). */
const SPOT_TRADING_TIFS: ReadonlySet<LimitTif | undefined> = new Set<LimitTif | undefined>(["Gtc", "Ioc", "Alo"]);

/**
 * Spot: only pairs in `allowedSpotCoins`, one plain order per action: no modify, no triggers, no reduce-only, no TP/SL
 * grouping. Without `spotTrading` (Convert's stablecoin pairs) the order must be immediate-or-cancel; with it, market
 * orders and IOC, GTC and post-only limits are allowed (the price bands above still apply).
 */
function checkSpotLegs(legs: OrderLeg[], actionType: string, wire: Wire | undefined, policy: Policy, add: AddFn): void {
  const allowed = policy.allowedSpotCoins ?? [];
  const trading = policy.spotTrading === true;
  for (const leg of legs) {
    if (!leg.spot || leg.coin === undefined) continue;
    if (!allowed.includes(leg.coin)) {
      add(
        "SPOT_NOT_ALLOWED",
        trading ? `${leg.coin}: this spot pair can't be traded with this key.` : `${leg.coin}: spot trading is not available; only stablecoin conversions on listed pairs are.`,
      );
    }
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
    // Market intents (no limit price) compile to IOC; wire and limit intents must say IOC unless spot trading is on.
    else if (leg.price === undefined) continue;
    else if (!trading && leg.tif !== "Ioc") add("SPOT_NOT_ALLOWED", "Spot orders must be immediate-or-cancel.");
    else if (trading && !SPOT_TRADING_TIFS.has(leg.tif)) add("SPOT_NOT_ALLOWED", "Spot limits must be good-till-canceled, immediate-or-cancel or post-only.");
  }
}

/**
 * An entry is protected when an attached stop-loss leg (reduce-only, opposite side, same coin) covers its full size,
 * can fill when it fires (a market trigger, or a limit beyond its trigger), sits on the losing side of the entry
 * and, when the policy sets `maxStopLossDistancePct`, is close enough to it.
 */
function attachedStopProblem(entry: OrderLeg, legs: OrderLeg[], rawMark: number | undefined, maxDistancePct: number | undefined): string | null {
  const stops = legs.filter((l) => l.reduceOnly && l.isTrigger && l.tpsl === "sl" && l.coin === entry.coin && l.isBuy !== entry.isBuy);
  if (stops.length === 0) return `New ${entry.coin} entries need a stop-loss.`;
  const ref = entry.isTrigger ? entry.triggerPrice : (entry.price ?? rawMark);
  let unfillable = false;
  for (const sl of stops) {
    if (!(sl.size >= entry.size)) continue;
    const t = sl.triggerPrice as number;
    if (ref === undefined || !(ref > 0)) return `Cannot check the ${entry.coin} stop-loss without an entry or mark price.`;
    if (!(entry.isBuy ? t < ref : t > ref)) continue;
    if (maxDistancePct !== undefined && !((Math.abs(ref - t) / ref) * 100 <= maxDistancePct + 1e-9)) continue;
    if (!stopCanFill({ isBuy: sl.isBuy, triggerPrice: t, isMarket: sl.isMarket, limitPrice: sl.price })) {
      unfillable = true;
      continue;
    }
    return null;
  }
  if (unfillable) {
    return `The ${entry.coin} stop-loss's limit price must be beyond its trigger (below it for a sell, above it for a buy), or it may never fill.`;
  }
  return maxDistancePct !== undefined
    ? `The ${entry.coin} stop-loss must cover the whole entry, sit on the losing side and be within ${maxDistancePct}% of the entry.`
    : `The ${entry.coin} stop-loss must cover the whole entry and sit on the losing side.`;
}

/** The cloids of the orders an action places (orders, and the replacement orders of modifies). */
function placedCloids(intent: ActionIntent | undefined, wire: Wire | undefined): string[] {
  const out: unknown[] = [];
  if (wire) {
    const orders: unknown[] =
      wire.type === "order" && Array.isArray(wire.orders)
        ? wire.orders
        : wire.type === "modify"
          ? [wire.order]
          : wire.type === "batchModify" && Array.isArray(wire.modifies)
            ? (wire.modifies as Array<{ order?: unknown }>).map((m) => m.order)
            : [];
    for (const o of orders) if (typeof o === "object" && o !== null) out.push((o as { c?: unknown }).c);
  } else if (intent?.kind === "order") {
    out.push(intent.cloid, intent.takeProfit?.cloid, intent.stopLoss?.cloid);
  } else if (intent?.kind === "modify") {
    out.push(intent.order.cloid);
  }
  return out.filter((c): c is string => typeof c === "string");
}

/**
 * Whether automation signs this: a key without manual trading (such as the servers' automation keys), or any origin
 * other than the user's own hand.
 */
function isAutomation(policy: Policy, origin: IntentOrigin | undefined): boolean {
  return (policy.allowedOrigins !== undefined && !policy.allowedOrigins.includes("manual")) || (origin !== undefined && origin !== "manual");
}

/** True for a cloid whose Kokoah tag names the bot origin: a bot's own order. */
function isBotCloid(cloid: string | undefined): boolean {
  return cloid !== undefined && parseCloid(cloid)?.origin === "bot";
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
      const w = o as { a: number; b: boolean; p: string; s: string; r: boolean; t: { limit?: { tif: LimitTif }; trigger?: { isMarket?: boolean; triggerPx: string; tpsl: "tp" | "sl" } } };
      const trig = w.t.trigger;
      const tif = w.t.limit?.tif;
      return {
        coin: resolveCoin(w.a, context, add),
        isBuy: w.b,
        size: Number(w.s),
        price: Number(w.p),
        triggerPrice: trig ? Number(trig.triggerPx) : undefined,
        isTrigger: trig !== undefined,
        ...(trig ? { tpsl: trig.tpsl, isMarket: trig.isMarket === true } : {}),
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
      // Market-type triggers: the compiler puts the limit at trigger ± the slippage it is given (10% by default); the
      // trigger stands in for the limit price here, and the compiled wire action is checked with its real limit.
      price: intent.price !== undefined ? Number(intent.price) : isTrigger && intent.triggerPrice !== undefined ? Number(intent.triggerPrice) : undefined,
      triggerPrice: intent.triggerPrice !== undefined ? Number(intent.triggerPrice) : undefined,
      isTrigger,
      ...(isTrigger ? { tpsl: tpslOf(intent.orderType), isMarket: intent.orderType === "stopMarket" || intent.orderType === "takeProfitMarket" } : {}),
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
        isMarket: leg.orderType !== "limit",
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
        ...(isTrigger ? { tpsl: tpslOf(o.orderType), isMarket: o.orderType === "stopMarket" || o.orderType === "takeProfitMarket" } : { tif: o.tif ?? "Gtc" }),
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
