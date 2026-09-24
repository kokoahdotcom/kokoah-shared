/**
 * Trailing stop helpers shared by the ticket, the chart and the Protect preset. The trailing itself runs on the
 * server as the `trailingStop` guardian rule (`evaluateRule`): it ratchets a real reduce-only stop resting on
 * Hyperliquid and never loosens it. The UI places the first stop at once with {@link trailStopPrice}, so a stop rests
 * on Hyperliquid from the start, and hands that order to the rule (`stopOrder`).
 *
 * @module
 */
import { evaluateRule, type GuardianEvaluation, type MarketState, type PositionState } from "../guardians/evaluate.js";
import type { TrailingStopRule } from "../guardians/schemas.js";
import { type ActionIntent, parseActionIntent } from "../intents/index.js";
import { roundPriceToTick, type PriceKind } from "../precision/index.js";

/** Trail distance: a percentage of the best price, or a fixed price distance. */
export type TrailDistance = { kind: "pct"; value: number } | { kind: "price"; value: number };

/**
 * The stop price `distance` behind `reference` for a position side, rounded so it is never tighter than asked: long
 * stops round down, short stops round up. Undefined when the distance swallows the price.
 */
export function trailStopPrice(side: "long" | "short", reference: number, distance: TrailDistance, szDecimals: number, kind: PriceKind = "perp"): string | undefined {
  if (!(reference > 0) || !(distance.value > 0)) return undefined;
  const d = distance.kind === "pct" ? (reference * distance.value) / 100 : distance.value;
  const raw = side === "long" ? reference - d : reference + d;
  if (!(raw > 0)) return undefined;
  try {
    return roundPriceToTick(raw, szDecimals, kind, side === "long" ? "down" : "up");
  } catch {
    return undefined;
  }
}

/** Problems with trailing settings (plain English); empty when valid. */
export function trailProblems(input: { side: "long" | "short"; mark: number; distance: TrailDistance; activationPrice?: number }): string[] {
  const p: string[] = [];
  const { distance, mark } = input;
  if (!(distance.value > 0)) p.push("Enter a trail distance.");
  else if (distance.kind === "pct" && !(distance.value < 100)) p.push("The trail must be under 100%.");
  else if (distance.kind === "price" && mark > 0 && input.side === "long" && distance.value >= mark) p.push("The trail distance is larger than the price.");
  if (input.activationPrice !== undefined) {
    if (!(input.activationPrice > 0)) p.push("Enter a valid activation price.");
    else if (mark > 0 && (input.side === "long" ? input.activationPrice <= mark : input.activationPrice >= mark))
      p.push(input.side === "long" ? "A long's activation price must be above the mark price." : "A short's activation price must be below the mark price.");
  }
  return p;
}

/**
 * Whether a resting stop at `existing` is at least as protective as a new trail stop at `candidate`: a long stop at or
 * above it, a short stop at or below it. The UI then hands that stop to the rule instead of placing another.
 */
export function stopAtLeastAsTight(side: "long" | "short", existing: number, candidate: number): boolean {
  return side === "long" ? existing >= candidate : existing <= candidate;
}

// ---------------------------------------------------------------------------------------------
// Server execution of the trailing stop guardian
// ---------------------------------------------------------------------------------------------

/**
 * How the engine sends a list of intents: `requires[i] = j` means intent `i` is sent only after intent `j` was
 * submitted (otherwise it is not executed); a failed `cleanup` intent never fails the rule (its order is gone either
 * way). Keys are intent indexes as strings (JSON-safe).
 */
export interface ExecutionPlan {
  intents: ActionIntent[];
  requires: Record<string, number>;
  cleanup: number[];
}

/**
 * Turns every `modify` of a trigger order into "place the new stop, then cancel the old one" (Kokoah algos never
 * `modify`: a modified order may lose its builder fee). The new stop is a reduce-only position TP/SL `order` with the
 * modify's replacement cloid; the cancel runs only if the new stop was placed, so the position is never left without
 * one, and a failed cancel (the old stop already filled or was canceled) is harmless.
 */
export function placeThenCancel(intents: readonly ActionIntent[]): ExecutionPlan {
  const out: ActionIntent[] = [];
  const requires: Record<string, number> = {};
  const cleanup: number[] = [];
  for (const intent of intents) {
    const o = intent.kind === "modify" ? intent.order : undefined;
    if (intent.kind !== "modify" || !o || o.orderType === "limit" || o.triggerPrice === undefined) {
      out.push(intent);
      continue;
    }
    const placed = out.length;
    out.push(
      parseActionIntent({
        kind: "order",
        origin: intent.origin,
        coin: o.coin,
        side: o.side,
        orderType: o.orderType,
        size: o.size,
        triggerPrice: o.triggerPrice,
        ...(o.price !== undefined ? { price: o.price } : {}),
        reduceOnly: true,
        positionTpsl: true,
        ...(o.cloid !== undefined ? { cloid: o.cloid } : {}),
        ...(intent.vaultAddress !== undefined ? { vaultAddress: intent.vaultAddress } : {}),
      }),
    );
    const target = "cloid" in intent.target ? { coin: o.coin, cloid: intent.target.cloid } : { coin: o.coin, oid: intent.target.oid };
    requires[String(out.length)] = placed;
    cleanup.push(out.length);
    out.push(parseActionIntent({ kind: "cancel", origin: intent.origin, cancels: [target], ...(intent.vaultAddress !== undefined ? { vaultAddress: intent.vaultAddress } : {}) }));
  }
  return { intents: out, requires, cleanup };
}

/**
 * The trailing stop guardian as Kokoah runs it: `evaluateRule` (distance in % or $, optional activation, never
 * loosens), plus two things that keep a real stop resting on Hyperliquid:
 * - when the rule's own stop was canceled or rejected while the position is still open, a new stop is placed from the
 *   best price so far (never looser than the old one, since that price only improves);
 * - stop moves are place-then-cancel (see {@link placeThenCancel}) instead of `modify`.
 */
export function evaluateTrailingStop(rule: TrailingStopRule, market: MarketState, ps: PositionState, now: number): GuardianEvaluation & ExecutionPlan {
  const st = rule.state;
  const own = st?.stopCloid ? ps.orders.find((o) => o.cloid?.toLowerCase() === st.stopCloid) : undefined;
  const pos = ps.positions[rule.coin];
  const gone = !!own && (own.status === "canceled" || own.status === "rejected") && !!pos && pos.size > 0 && (st?.side === undefined || st.side === pos.side);
  const input: TrailingStopRule = gone ? { ...rule, state: { ...st!, stopCloid: undefined, stopPrice: undefined } } : rule;
  const ev = evaluateRule(input, market, ps, now) as GuardianEvaluation;
  const plan = placeThenCancel(ev.intents);
  const reason = gone && ev.intents.length > 0 ? `The trailing stop was canceled; ${ev.reason.charAt(0).toLowerCase()}${ev.reason.slice(1)}` : ev.reason;
  return { ...ev, ...plan, fire: ev.fire, reason };
}
