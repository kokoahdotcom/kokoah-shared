/**
 * Advanced order types ("algos"): pure planners shared by the browser runner and the server guardian engine.
 * - {@link planScale}: scale ladders;
 * - {@link nextChaseStep}: post-only chase orders;
 * - {@link nextTwapSlice}: Kokoah TWAP slices, and the server `twap` guardian rule ({@link evaluateTwapRule});
 * - trailing stop helpers ({@link trailStopPrice}).
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
