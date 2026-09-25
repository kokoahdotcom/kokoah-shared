/**
 * Start triggers: an algo (Chase or TWAP) that waits until the mark price crosses a level, then starts. The direction
 * is fixed when the trigger is set, from where the mark is then: a level above the mark starts the algo once the mark
 * rises to it, a level below once it falls to it. The browser runner and the server rules use the same check.
 *
 * @module
 */
import * as v from "valibot";
import { PositiveDecimalSchema } from "../intents/index.js";

/** Start when the mark reaches `price` from below ("above") or from above ("below"). */
export interface StartTrigger {
  price: number;
  direction: "above" | "below";
}

/** Rule form of a start trigger (the price as a decimal string). */
export const StartTriggerSchema = v.strictObject({
  price: PositiveDecimalSchema,
  direction: v.picklist(["above", "below"]),
});

/** The trigger for a level typed while the mark is `mark`; undefined when either is not a positive price. */
export function startTriggerFor(price: number, mark: number): StartTrigger | undefined {
  if (!(price > 0) || !(mark > 0)) return undefined;
  return { price, direction: price >= mark ? "above" : "below" };
}

/** True once the mark is at or beyond the trigger level in its direction. */
export function startTriggerHit(trigger: { price: number | string; direction: "above" | "below" }, mark: number): boolean {
  const level = Number(trigger.price);
  if (!(level > 0) || !(mark > 0)) return false;
  return trigger.direction === "above" ? mark >= level : mark <= level;
}

/** Plain-English problem with a start level, or "" when it is fine. */
export function startTriggerProblem(price: number, mark: number): string {
  if (!(price > 0)) return "Enter the start price.";
  if (mark > 0 && Math.abs(price - mark) / mark < 0.0001) return "The start price is the current mark: start now instead.";
  return "";
}
