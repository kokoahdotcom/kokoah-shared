/**
 * Trailing stop helpers shared by the ticket, the chart and the Protect preset. The trailing itself runs on the
 * server as the `trailingStop` guardian rule (`evaluateRule`): it ratchets a real reduce-only stop resting on
 * Hyperliquid and never loosens it. The UI places the first stop at once with {@link trailStopPrice}, so a stop rests
 * on Hyperliquid from the start, and hands that order to the rule (`stopOrder`).
 *
 * @module
 */
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
