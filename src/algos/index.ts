/**
 * Advanced order types ("algos"): pure planners shared by the browser runner and the server guardian engine.
 * - {@link planScale}: scale ladders;
 * - {@link nextChaseStep}: post-only chase orders;
 * - {@link nextTwapSlice}: Kokoah TWAP slices, and the server `twap` guardian rule ({@link evaluateTwapRule});
 * - trailing stop helpers ({@link trailStopPrice});
 * - brackets: split take profits, breakeven and one-cancels-other entries ({@link planBracket}, the server `bracket`
 *   rule {@link evaluateBracketRule});
 * - the server side of a browser chase ({@link evaluateChaseRule}: heartbeat, hand-off or cancel);
 * - start triggers ({@link startTriggerHit}) and Hyperliquid's post-only window ({@link exchangeWindow}).
 * Child orders carry algo cloids (`algoCloid` in `actions`).
 *
 * @module
 */
export * from "./scale.js";
export * from "./chase.js";
export * from "./twap.js";
export * from "./twapRule.js";
export * from "./trailing.js";
export * from "./engineRule.js";
export * from "./bracket.js";
export * from "./bracketRule.js";
export * from "./chaseRule.js";
export * from "./trigger.js";
export * from "./exchangeWindow.js";
