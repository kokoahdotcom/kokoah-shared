/**
 * Copy-trading planner. The follow poller reads the leader's positions (main perp DEX) every poll; the copy bot turns
 * each change into orders in the user's own account, under the user's own caps:
 *
 * - **open / add** (the leader's position grows): `ratio` copies that share of the growth; `fixed` opens or adds
 *   `amountUsd`. The value is capped per order, by the room left under the total cap, and by the leverage cap (the
 *   account's total position value may not exceed `maxLeverage × equity`). Below Hyperliquid's $10 minimum after the
 *   caps, the change is skipped (and said so in the log).
 * - **reduce** (the leader's position shrinks): the copy shrinks by the same fraction (reduce-only).
 * - **close / flip**: the copy is closed (reduce-only); after a flip the new side is opened like an open.
 *
 * Only changes after the copy started are copied (the positions at start are the baseline). Markets outside the allow
 * list, in the deny list, on HIP-3 DEXes, or traded by another bot of the same account are skipped. The copy stops
 * when its value (the total cap plus the copy's PnL) falls `maxDrawdownPct` below its peak, or when it loses
 * `dailyLossLimitUsd` in a UTC day.
 *
 * @module
 */
import { formatSize } from "../precision/index.js";
import type { CopyBotConfig } from "./schema.js";
import { meetsMinimum, type PlannedOrder, type PlannerStep, sizeForUsd } from "./orders.js";

const DAY_MS = 86_400_000;

/** The leader's positions as last polled: signed size by coin. */
export interface LeaderView {
  /** The poll sequence number (`trader_watch.seq`): each new poll is looked at once. */
  seq: number;
  positions: Readonly<Record<string, number>>;
  /** When the poll happened (ms). */
  polledAt: number;
}

export interface CopyState {
  leaderSeq: number;
  /** The leader's positions at the last processed poll. */
  leader: Record<string, number>;
  /** Highest copy value seen (total cap + PnL). */
  peakValue: number;
  /** The UTC day and the copy's PnL at its start. */
  day: { start: number; pnlAtStart: number };
  seq: number;
}

export interface CopyStepInput {
  config: CopyBotConfig;
  state: CopyState | null;
  leader: LeaderView | null;
  now: number;
  marks: Readonly<Record<string, number>>;
  szDecimals: Readonly<Record<string, number>>;
  /** The copy's own positions (signed size in coins). */
  positions: Readonly<Record<string, number>>;
  /** The account the copy trades in: equity, total position value and each coin's signed size (all activity). */
  account: { equityUsd: number; totalNotionalUsd: number; positions: Readonly<Record<string, number>> };
  /** Coins another bot of this account trades. */
  claimed: ReadonlySet<string>;
  /** The copy's PnL so far (realized after fees, and unrealized at the mark). */
  pnl: { realizedUsd: number; unrealizedUsd: number };
  cloid: (seq: number) => `0x${string}`;
}

/** Why a market is not copied, or null. */
export function copyCoinBlocked(c: Pick<CopyBotConfig, "allowCoins" | "denyCoins">, coin: string, claimed: ReadonlySet<string>): string | null {
  if (coin.includes(":")) return "HIP-3 markets are not copied";
  if (c.allowCoins && c.allowCoins.length > 0 && !c.allowCoins.includes(coin)) return "not in your allowed markets";
  if (c.denyCoins?.includes(coin)) return "in your denied markets";
  if (claimed.has(coin)) return "another of your bots trades it";
  return null;
}

/** A risk stop hit by the copy's value, or null. */
export function copyRiskStop(
  c: Pick<CopyBotConfig, "maxTotalUsd" | "maxDrawdownPct" | "dailyLossLimitUsd">,
  state: Pick<CopyState, "peakValue" | "day">,
  pnlUsd: number,
): string | null {
  const value = c.maxTotalUsd + pnlUsd;
  const peak = Math.max(state.peakValue, value);
  if (c.maxDrawdownPct !== undefined && peak > 0 && ((peak - value) / peak) * 100 >= c.maxDrawdownPct) {
    return `Drawdown limit: the copy is ${round2(((peak - value) / peak) * 100)}% below its peak (limit ${c.maxDrawdownPct}%).`;
  }
  const today = pnlUsd - state.day.pnlAtStart;
  if (c.dailyLossLimitUsd !== undefined && today <= -c.dailyLossLimitUsd) {
    return `Daily loss limit: the copy lost $${round2(-today)} today (limit $${c.dailyLossLimitUsd}).`;
  }
  return null;
}

export function copyStep(input: CopyStepInput): PlannerStep<CopyState> {
  const { config: c, now, leader } = input;
  const notes: string[] = [];
  const place: PlannedOrder[] = [];
  const pnl = input.pnl.realizedUsd + input.pnl.unrealizedUsd;
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;

  if (!input.state) {
    const state: CopyState = {
      leaderSeq: leader?.seq ?? -1,
      leader: { ...(leader?.positions ?? {}) },
      peakValue: c.maxTotalUsd,
      day: { start: dayStart, pnlAtStart: pnl },
      seq: 0,
    };
    notes.push(leader ? baselineNote(leader) : "Waiting for the first poll of the trader's positions.");
    return { state, place, cancel: [], notes };
  }
  const state = structuredClone(input.state);
  if (state.day.start !== dayStart) state.day = { start: dayStart, pnlAtStart: pnl };

  const stop = copyRiskStop(c, state, pnl);
  state.peakValue = Math.max(state.peakValue, c.maxTotalUsd + pnl);
  if (stop) return { state, place, cancel: [], notes, stop: { reason: stop, closePosition: c.closeOnStop } };

  if (!leader || leader.seq <= state.leaderSeq) return { state, place, cancel: [], notes };
  if (state.leaderSeq < 0) {
    // The first poll arrived after the copy started: it is the baseline.
    state.leaderSeq = leader.seq;
    state.leader = { ...leader.positions };
    notes.push(baselineNote(leader));
    return { state, place, cancel: [], notes };
  }

  // Positions after this step's orders (to keep the caps right across coins).
  const mine: Record<string, number> = { ...input.positions };
  const account: Record<string, number> = { ...input.account.positions };
  let accountNotional = input.account.totalNotionalUsd;
  const copyValue = () => Object.entries(mine).reduce((sum, [coin, size]) => sum + Math.abs(size) * (input.marks[coin] ?? 0), 0);

  const coins = [...new Set([...Object.keys(state.leader), ...Object.keys(leader.positions)])].sort();
  for (const coin of coins) {
    const a = state.leader[coin] ?? 0;
    const b = leader.positions[coin] ?? 0;
    if (a === b) continue;
    const mark = input.marks[coin];
    const sz = input.szDecimals[coin];
    const blocked = copyCoinBlocked(c, coin, input.claimed);
    if (blocked) {
      notes.push(`Skipped ${coin}: ${blocked}.`);
      continue;
    }
    if (mark === undefined || !(mark > 0) || sz === undefined) {
      notes.push(`Skipped ${coin}: no price for this market right now.`);
      continue;
    }
    const flip = a !== 0 && b !== 0 && Math.sign(a) !== Math.sign(b);
    const shrink = a !== 0 && (b === 0 || flip || Math.abs(b) < Math.abs(a));
    const grow = b !== 0 && (a === 0 || flip || Math.abs(b) > Math.abs(a));
    const held = mine[coin] ?? 0;

    if (shrink && held !== 0 && Math.sign(held) === Math.sign(a)) {
      const fraction = b === 0 || flip ? 1 : (Math.abs(a) - Math.abs(b)) / Math.abs(a);
      const inAccount = account[coin] ?? 0;
      if (inAccount === 0 || Math.sign(inAccount) !== Math.sign(held)) {
        notes.push(`Skipped reducing ${coin}: the account's ${coin} position no longer matches the copy.`);
      } else {
        const want = fraction >= 1 ? Math.abs(held) : Math.abs(held) * fraction;
        const size = Math.min(want, Math.abs(inAccount));
        const text = formatSize(size, sz, fraction >= 1 ? "nearest" : "down");
        if (Number(text) > 0) {
          const closing = fraction >= 1;
          place.push({
            cloid: input.cloid(state.seq++),
            coin,
            side: held > 0 ? "sell" : "buy",
            size: text,
            type: "market",
            reduceOnly: true,
            label: closing ? `Copy close ${coin}` : `Copy reduce ${coin}`,
          });
          const delta = Number(text) * Math.sign(held);
          mine[coin] = held - delta;
          account[coin] = inAccount - delta;
          accountNotional = Math.max(0, accountNotional - Number(text) * mark);
          const copied = `the copied ${coin} ${held > 0 ? "long" : "short"}`;
          notes.push(closing ? `Closing ${copied}.` : `Reducing ${copied} by ${round2(fraction * 100)}%.`);
        }
      }
    }

    if (grow) {
      const current = mine[coin] ?? 0;
      if (current !== 0 && Math.sign(current) !== Math.sign(b)) {
        notes.push(`Skipped ${coin}: the copied position is still on the other side.`);
        continue;
      }
      const growth = a === 0 || flip ? Math.abs(b) : Math.abs(b) - Math.abs(a);
      const wanted = c.sizing.mode === "ratio" ? growth * c.sizing.ratio * mark : c.sizing.amountUsd;
      const roomTotal = c.maxTotalUsd - copyValue();
      const roomLeverage = c.maxLeverage * input.account.equityUsd - accountNotional;
      const usd = Math.min(wanted, c.maxOrderUsd, roomTotal, roomLeverage);
      const size = sizeForUsd(usd, mark, sz, "down");
      if (!(Number(size) > 0) || !meetsMinimum(size, mark)) {
        const why =
          usd === roomLeverage ? `the leverage cap (${c.maxLeverage}×)` : usd === roomTotal ? "the total cap" : usd === c.maxOrderUsd ? "the cap per order" : "the copy ratio";
        notes.push(`Skipped ${coin}: below Hyperliquid's $10 minimum after ${why}.`);
        continue;
      }
      const side = b > 0 ? "buy" : "sell";
      place.push({
        cloid: input.cloid(state.seq++),
        coin,
        side,
        size,
        type: "market",
        reduceOnly: false,
        label: `Copy ${a === 0 || flip ? "open" : "add"} ${coin}`,
      });
      const delta = Number(size) * (b > 0 ? 1 : -1);
      mine[coin] = current + delta;
      account[coin] = (account[coin] ?? 0) + delta;
      accountNotional += Number(size) * mark;
      const usdText = `$${round2(Number(size) * mark)}`;
      const sideText = b > 0 ? "long" : "short";
      notes.push(a === 0 || flip ? `Opening a ${sideText} on ${coin}: about ${usdText}.` : `Adding about ${usdText} to the ${sideText} on ${coin}.`);
    }
  }
  state.leaderSeq = leader.seq;
  state.leader = { ...leader.positions };
  return { state, place, cancel: [], notes };
}

/** The note when the copy takes the leader's positions as its baseline. */
function baselineNote(leader: LeaderView): string {
  const n = Object.keys(leader.positions).length;
  if (n === 0) return "Copying from now on. The trader had no open positions at the start.";
  return `Copying from now on. The trader's ${n} open ${n === 1 ? "position at the start is" : "positions at the start are"} not copied.`;
}

function round2(x: number): string {
  return String(Math.round(x * 100) / 100);
}
