import { describe, expect, it } from "vitest";
import { compileAction } from "../src/actions/index.js";
import { type ActionIntentInput, parseActionIntent } from "../src/intents/index.js";
import { generateCloid } from "../src/actions/cloid.js";
import {
  type AccountBook,
  type AccountOrder,
  coveredSize,
  createGuardianPolicy,
  evaluatePolicy,
  marketTriggerSlippageFor,
  type Policy,
  type PolicyContext,
  positionCovered,
  stopCanFill,
} from "../src/policy/index.js";
import { mainnetRegistry } from "./helpers.js";

const registry = mainnetRegistry();
const NOW = 1_790_000_000_000;
const policy = createGuardianPolicy({ builder: { b: "0x1111111111111111111111111111111111111111", f: 25 }, allowedCoins: "*", maxOrderNotionalUsd: 100_000, maxDailyNotionalUsd: 400_000 });
const CLOID = "0x6b6f0101000000000000000000000abc";
const BUILDER = { address: "0x1111111111111111111111111111111111111111" as const, feeTenthsBps: 25 };

/** Long 0.5 BTC from $100,000 with a reduce-only stop at $95,000 (oid 11), a take-profit (oid 13) and an ETH limit (oid 20). */
const stop: AccountOrder = { coin: "BTC", oid: 11, cloid: CLOID, isBuy: false, size: 0.5, isTrigger: true, triggerPrice: 95_000, tpsl: "sl", reduceOnly: true, positionTpsl: false, isMarket: true, limitPrice: 85_500 };
const book = (over: Partial<AccountBook> = {}): AccountBook => ({
  positions: [{ coin: "BTC", size: 0.5, entryPrice: 100_000 }],
  orders: [
    stop,
    { coin: "BTC", oid: 13, isBuy: false, size: 0.5, isTrigger: true, triggerPrice: 110_000, tpsl: "tp", reduceOnly: true, positionTpsl: false, isMarket: true, limitPrice: 99_000 },
    { coin: "ETH", oid: 20, isBuy: true, size: 1, isTrigger: false, reduceOnly: false, positionTpsl: false, isMarket: false, limitPrice: 2_900 },
  ],
  ...over,
});

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  policy,
  now: NOW,
  markPrices: { BTC: 100_000, ETH: 3_000 },
  dailyNotionalUsedUsd: 0,
  ordersInLastMinute: 0,
  registry,
  expiresAfter: NOW + 15_000,
  requireStopCoverage: true,
  accountBook: book(),
  ...over,
});

const check = (intent: ActionIntentInput, c: Partial<PolicyContext> = {}) => {
  const context = ctx(c);
  const compiled = compileAction(parseActionIntent(intent), {
    registry,
    now: NOW,
    builder: BUILDER,
    getMidPrice: () => "100000",
    marketTriggerSlippageBps: marketTriggerSlippageFor(context.policy, context.markPrices),
  });
  return evaluatePolicy({ kind: "compiled", compiled, expiresAfter: NOW + 15_000 }, context);
};
const codes = (d: ReturnType<typeof evaluatePolicy>) => d.violations.map((v) => v.code);
const cancel = (oid: number, coin = "BTC", origin = "guardian"): ActionIntentInput => ({ kind: "cancel", cancels: [{ coin, oid }], origin }) as ActionIntentInput;
const moveStop = (over: Record<string, unknown> = {}): ActionIntentInput =>
  ({ kind: "modify", target: { oid: 11 }, order: { coin: "BTC", side: "sell", orderType: "stopMarket", size: "0.5", triggerPrice: "96000", reduceOnly: true, ...over }, origin: "guardian" }) as ActionIntentInput;

describe("stop coverage (stops required)", () => {
  it("refuses cancelling a position's only stop-loss, by oid or by cloid", () => {
    const d = check(cancel(11));
    expect(codes(d)).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(d.violations[0]!.message).toContain("BTC position without a stop-loss within 25%");
    expect(codes(check({ kind: "cancel", cancels: [{ coin: "BTC", cloid: CLOID }], origin: "guardian" } as ActionIntentInput))).toEqual(["STOP_LOSS_REQUIRED"]);
    // Named under another market's asset id: still that order (stricter than Hyperliquid's own match).
    expect(codes(check(cancel(11, "ETH")))).toEqual(["STOP_LOSS_REQUIRED"]);
  });

  it("allows cancelling other orders, a second stop, and the stop of a position that is gone", () => {
    expect(check(cancel(13)).allowed).toBe(true);
    expect(check(cancel(20, "ETH")).allowed).toBe(true);
    // An order the signer looked up and found closed on Hyperliquid (filled, canceled) takes nothing away.
    expect(check(cancel(999), { accountBook: book({ notStops: [999] }) }).allowed).toBe(true);
    const positionStop: AccountOrder = { coin: "BTC", oid: 12, isBuy: false, size: 0, isTrigger: true, triggerPrice: 97_000, tpsl: "sl", reduceOnly: true, positionTpsl: true, isMarket: true, limitPrice: 87_300 };
    expect(check(cancel(11), { accountBook: book({ orders: [...book().orders, positionStop] }) }).allowed).toBe(true);
    expect(check(cancel(11), { accountBook: book({ positions: [] }) }).allowed).toBe(true);
    // Two stops of half the size each cover it together; one alone doesn't.
    const halves = [{ ...stop, size: 0.25 }, { ...stop, oid: 14, cloid: undefined, size: 0.25 }];
    expect(codes(check(cancel(14), { accountBook: book({ orders: halves }) }))).toEqual(["STOP_LOSS_REQUIRED"]);
  });

  it("leaves a position that had no stop as it was: its orders can still be cancelled", () => {
    const far = { ...stop, triggerPrice: 60_000 };
    expect(check(cancel(11), { accountBook: book({ orders: [far] }) }).allowed).toBe(true);
    expect(check(cancel(13), { accountBook: book({ orders: book().orders.slice(1) }) }).allowed).toBe(true);
  });

  it("refuses a modify that moves the stop too far, shrinks it or turns it into something else", () => {
    expect(check(moveStop()).allowed).toBe(true);
    // A trailing stop past the entry locks in profit and still counts.
    expect(check(moveStop({ triggerPrice: "99000" })).allowed).toBe(true);
    expect(codes(check(moveStop({ triggerPrice: "70000" })))).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(codes(check(moveStop({ size: "0.2" })))).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(codes(check(moveStop({ orderType: "takeProfitMarket", triggerPrice: "120000" })))).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(codes(check(moveStop({ orderType: "limit", price: "105000", triggerPrice: undefined, tif: "Gtc" })))).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(codes(check({ ...moveStop({ triggerPrice: "70000" }), target: { cloid: CLOID } } as ActionIntentInput))).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(check({ ...moveStop(), target: { cloid: CLOID } } as ActionIntentInput).allowed).toBe(true);
  });

  it("keeps a position TP/SL a whole-position stop when it is moved on the same side", () => {
    const positionStop: AccountOrder = { ...stop, size: 0, positionTpsl: true };
    expect(check(moveStop({ size: "0.5" }), { accountBook: book({ orders: [positionStop] }) }).allowed).toBe(true);
    expect(codes(check(moveStop({ orderType: "takeProfitMarket", triggerPrice: "120000" }), { accountBook: book({ orders: [positionStop] }) }))).toEqual(["STOP_LOSS_REQUIRED"]);
  });

  it("covers shorts with buy stops above the entry", () => {
    const short = book({ positions: [{ coin: "BTC", size: -0.5, entryPrice: 100_000 }], orders: [{ ...stop, isBuy: true, triggerPrice: 104_000 }] });
    expect(codes(check(cancel(11), { accountBook: short }))).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(positionCovered({ coin: "BTC", size: -0.5, entryPrice: 100_000 }, [{ ...stop, isBuy: false, triggerPrice: 104_000 }], 25)).toBe(false);
  });

  it("fails closed without the account's orders, and checks nothing for callers that don't ask", () => {
    const missing = check(cancel(11), { accountBook: undefined });
    expect(codes(missing)).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(missing.violations[0]!.message).toContain("could not be checked");
    expect(check(cancel(11), { requireStopCoverage: undefined, accountBook: undefined }).allowed).toBe(true);
    // Intents alone (no wire action yet): the compiled action is what gets checked.
    expect(evaluatePolicy(parseActionIntent(cancel(11)), ctx()).allowed).toBe(true);
  });

  it("checks only where the policy requires stops, and lets exempt bots change only their own orders", () => {
    const loose: Policy = { ...policy, requireStopLossForNewEntries: false };
    expect(check(cancel(11), { policy: loose }).allowed).toBe(true);
    const bots: Policy = { ...policy, allowedOrigins: ["guardian", "bot"], botEntriesWithoutStopLoss: true };
    // The user's (manual-tagged) stop: not even an exempt bot may take it away.
    expect(codes(check(cancel(11, "BTC", "bot"), { policy: bots }))).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(codes(check(cancel(11, "BTC", "guardian"), { policy: bots }))).toEqual(["STOP_LOSS_REQUIRED"]);
    // A stop the bot placed itself (bot-origin cloid), by oid or by cloid, also when it's already gone.
    const botCloid = generateCloid("bot");
    const botStop = { ...stop, cloid: botCloid };
    expect(check(cancel(11, "BTC", "bot"), { policy: bots, accountBook: book({ orders: [botStop] }) }).allowed).toBe(true);
    expect(check({ kind: "cancel", cancels: [{ coin: "BTC", cloid: botCloid }], origin: "bot" } as ActionIntentInput, { policy: bots, accountBook: book({ orders: [botStop] }) }).allowed).toBe(true);
    expect(check({ kind: "cancel", cancels: [{ coin: "BTC", cloid: botCloid }], origin: "bot" } as ActionIntentInput, { policy: bots, accountBook: book({ orders: [] }) }).allowed).toBe(true);
    // Naming only its own orders by cloid, it needs no account read; naming any other, it does.
    expect(check({ kind: "cancel", cancels: [{ coin: "BTC", cloid: botCloid }], origin: "bot" } as ActionIntentInput, { policy: bots, accountBook: undefined }).allowed).toBe(true);
    expect(codes(check({ kind: "cancel", cancels: [{ coin: "BTC", cloid: botCloid }, { coin: "BTC", cloid: CLOID }], origin: "bot" } as ActionIntentInput, { policy: bots, accountBook: undefined }))).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(codes(check(cancel(11, "BTC", "bot"), { policy: bots, accountBook: undefined }))).toEqual(["STOP_LOSS_REQUIRED"]);
    // Only for bots the policy exempts, and only for bots.
    expect(codes(check(cancel(11, "BTC", "guardian"), { policy: bots, accountBook: book({ orders: [botStop] }) }))).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(codes(check(cancel(11, "BTC", "bot"), { policy: { ...bots, botEntriesWithoutStopLoss: false }, accountBook: book({ orders: [botStop] }) }))).toEqual(["STOP_LOSS_REQUIRED"]);
    // A bot moving the user's stop is checked like anyone else's modify; a dead man's switch stays refused for bots.
    expect(codes(check({ ...moveStop({ triggerPrice: "70000" }), origin: "bot" } as ActionIntentInput, { policy: bots }))).toEqual(["STOP_LOSS_REQUIRED"]);
    const withSchedule: Policy = { ...bots, allowedActionTypes: [...bots.allowedActionTypes, "scheduleCancel"] };
    expect(codes(check({ kind: "scheduleCancel", time: NOW + 60_000, origin: "bot" } as ActionIntentInput, { policy: withSchedule }))).toEqual(["STOP_LOSS_REQUIRED"]);
  });

  it("refuses a dead man's switch, which would cancel every stop-loss at once, but lets one be cleared", () => {
    const withSchedule: Policy = { ...policy, allowedActionTypes: [...policy.allowedActionTypes, "scheduleCancel"] };
    const schedule = (time?: number): ActionIntentInput => ({ kind: "scheduleCancel", ...(time !== undefined ? { time } : {}), origin: "guardian" }) as ActionIntentInput;
    const d = check(schedule(NOW + 60_000), { policy: withSchedule });
    expect(codes(d)).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(evaluatePolicy({ kind: "wire", action: { type: "scheduleCancel", time: NOW + 60_000 }, expiresAfter: NOW + 15_000, origin: "guardian" }, ctx({ policy: withSchedule })).allowed).toBe(false);
    expect(check(schedule(), { policy: withSchedule }).allowed).toBe(true);
    // Where stops aren't required, or for a caller that doesn't ask, nothing changes.
    expect(check(schedule(NOW + 60_000), { policy: { ...withSchedule, requireStopLossForNewEntries: false } }).allowed).toBe(true);
    expect(check(schedule(NOW + 60_000), { policy: withSchedule, requireStopCoverage: undefined }).allowed).toBe(true);
  });

  it("without a distance limit, any stop-loss on the closing side counts", () => {
    const anyDistance: Policy = { ...policy, maxStopLossDistancePct: undefined };
    const far = book({ orders: [{ ...stop, triggerPrice: 60_000 }] });
    const d = check(cancel(11), { policy: anyDistance, accountBook: far });
    expect(codes(d)).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(d.violations[0]!.message).toBe("This would leave the open BTC position without a stop-loss; place the new stop first.");
  });

  it("counts a stop-limit only when its limit can fill, also when one is moved there", () => {
    // A sell stop at 95,000 whose limit is above the trigger rests unfilled above a falling market.
    const stuck: AccountOrder = { ...stop, isMarket: false, limitPrice: 99_000 };
    const filling: AccountOrder = { ...stop, isMarket: false, limitPrice: 94_000 };
    expect(stopCanFill(stuck)).toBe(false);
    expect(stopCanFill(filling)).toBe(true);
    expect(stopCanFill({ ...stuck, isMarket: true })).toBe(true);
    expect(stopCanFill({ isBuy: true, triggerPrice: 105_000, limitPrice: 104_000 })).toBe(false);
    expect(stopCanFill({ isBuy: false, triggerPrice: 95_000 })).toBe(false);
    expect(check(cancel(11), { accountBook: book({ orders: [stuck] }) }).allowed).toBe(true);
    expect(codes(check(cancel(11), { accountBook: book({ orders: [filling] }) }))).toEqual(["STOP_LOSS_REQUIRED"]);
    // Changing the stop into a stop-limit that can't fill takes its cover away; one that can keeps it.
    expect(codes(check(moveStop({ orderType: "stopLimit", triggerPrice: "95000", price: "99000" })))).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(check(moveStop({ orderType: "stopLimit", triggerPrice: "95000", price: "94000" })).allowed).toBe(true);
  });

  it("refuses taking any cover from a partly covered position", () => {
    // Long 1 BTC, a stop for half of it: cancelling or shrinking that stop leaves less covered.
    const partly = book({ positions: [{ coin: "BTC", size: 1, entryPrice: 100_000 }] });
    expect(coveredSize({ coin: "BTC", size: 1, entryPrice: 100_000 }, partly.orders, 25)).toBe(0.5);
    const d = check(cancel(11), { accountBook: partly });
    expect(codes(d)).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(d.violations[0]!.message).toContain("less of the open BTC position covered");
    expect(codes(check(moveStop({ size: "0.3" }), { accountBook: partly }))).toEqual(["STOP_LOSS_REQUIRED"]);
    // Moving it (same size, still close enough) or growing it is fine; so is cancelling a stop beyond what's needed.
    expect(check(moveStop({ triggerPrice: "97000" }), { accountBook: partly }).allowed).toBe(true);
    expect(check(moveStop({ size: "1" }), { accountBook: partly }).allowed).toBe(true);
    const twice = book({ orders: [stop, { ...stop, oid: 15, cloid: undefined }] });
    expect(check(cancel(15), { accountBook: twice }).allowed).toBe(true);
  });

  it("refuses naming an order the account doesn't have open on the markets the action names", () => {
    const d = check(cancel(999));
    expect(codes(d)).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(d.violations[0]!.message).toContain("Order 999 isn't among the account's open orders");
    expect(codes(check({ kind: "cancel", cancels: [{ coin: "BTC", cloid: generateCloid("guardian") }], origin: "guardian" } as ActionIntentInput))).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(codes(check({ ...moveStop(), target: { oid: 998 } } as ActionIntentInput))).toEqual(["STOP_LOSS_REQUIRED"]);
    const gone = generateCloid("guardian");
    expect(check({ kind: "cancel", cancels: [{ coin: "BTC", cloid: gone }], origin: "guardian" } as ActionIntentInput, { accountBook: book({ notStops: [gone.toUpperCase()] }) }).allowed).toBe(true);
  });
});

describe("stop coverage of the whole position on entries (stops required)", () => {
  const entry = (over: Record<string, unknown> = {}): ActionIntentInput =>
    ({ kind: "order", coin: "BTC", side: "buy", orderType: "limit", size: "0.5", price: "100000", stopLoss: { triggerPrice: "95000" }, origin: "guardian", ...over }) as ActionIntentInput;

  it("allows a first entry with its own stop, and adding to a position whose stops stay in range", () => {
    expect(check(entry(), { accountBook: book({ positions: [], orders: [] }) }).allowed).toBe(true);
    // Long 0.5 from 100,000 with its stop at 95,000; adding 0.5 at 101,000 with a stop at 96,000 keeps it all covered.
    expect(check(entry({ price: "101000", stopLoss: { triggerPrice: "96000" } })).allowed).toBe(true);
  });

  it("refuses adding to a position whose resting stops would no longer cover it", () => {
    // Averaging in far above moves the entry: the old stop falls out of the 25% range, so only half would be covered.
    const far = book({ positions: [{ coin: "BTC", size: 0.5, entryPrice: 100_000 }], orders: [{ ...stop, triggerPrice: 76_000 }] });
    expect(check(entry({ price: "100000" }), { accountBook: far }).allowed).toBe(true);
    const d = check(entry({ price: "130000", stopLoss: { triggerPrice: "125000" } }), { accountBook: far, markPrices: { BTC: 130_000, ETH: 3_000 } });
    expect(codes(d)).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(d.violations[0]!.message).toContain("Once this fills, the BTC position of 1 needs stop-losses within 25% of its entry");
    // A position with no stop at all can't be added to either, whatever the new order's own stop.
    expect(codes(check(entry(), { accountBook: book({ orders: [] }) }))).toEqual(["STOP_LOSS_REQUIRED"]);
    // A position TP/SL covers the whole position, so the new size is covered by it.
    const positionStop: AccountOrder = { ...stop, size: 0, positionTpsl: true };
    expect(check(entry(), { accountBook: book({ orders: [positionStop] }) }).allowed).toBe(true);
  });

  it("refuses an attached stop-limit that can't fill, and needs the account's book", () => {
    const d = check(entry({ stopLoss: { triggerPrice: "95000", orderType: "limit", limitPrice: "96000" } }), { accountBook: book({ positions: [], orders: [] }) });
    expect(codes(d)).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(d.violations[0]!.message).toContain("limit price must be at or beyond its trigger");
    expect(check(entry({ stopLoss: { triggerPrice: "95000", orderType: "limit", limitPrice: "94000" } }), { accountBook: book({ positions: [], orders: [] }) }).allowed).toBe(true);
    const missing = check(entry(), { accountBook: undefined });
    expect(codes(missing)).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(missing.violations[0]!.message).toContain("could not be checked");
    // Callers that don't read the account keep checking the attached stop only; exempt bots aren't checked.
    expect(check(entry(), { requireStopCoverage: undefined, accountBook: undefined }).allowed).toBe(true);
    const bots: Policy = { ...policy, allowedOrigins: ["guardian", "bot"], botEntriesWithoutStopLoss: true };
    expect(check(entry({ origin: "bot", stopLoss: undefined }), { policy: bots, accountBook: undefined }).allowed).toBe(true);
  });

  it("leaves closing orders alone", () => {
    const close: ActionIntentInput = { kind: "order", coin: "BTC", side: "sell", orderType: "market", size: "0.5", reduceOnly: true, origin: "guardian" } as ActionIntentInput;
    expect(check(close, { accountBook: undefined }).allowed).toBe(true);
  });

  it("replays each side at its worst: an opposite entry that never fills can't make a growing position look covered", () => {
    // Long 1 BTC with no stop. One action: buy 0.01 with a stop for it, and a resting sell of 0.5 above the market with
    // a buy stop for that. All filled, the position would shrink to 0.51; but the sell may never fill.
    const order = (o: Record<string, unknown>) => ({ a: 0, r: false, ...o });
    const wire = {
      type: "order",
      orders: [
        order({ b: true, p: "100000", s: "0.01", t: { limit: { tif: "Gtc" } } }),
        order({ b: false, p: "90250", s: "0.01", r: true, t: { trigger: { isMarket: true, triggerPx: "95000", tpsl: "sl" } } }),
        order({ b: false, p: "105000", s: "0.5", t: { limit: { tif: "Gtc" } } }),
        order({ b: true, p: "121000", s: "0.5", r: true, t: { trigger: { isMarket: true, triggerPx: "110000", tpsl: "sl" } } }),
      ],
      grouping: "na",
      builder: { b: BUILDER.address, f: 25 },
    };
    const uncovered = book({ positions: [{ coin: "BTC", size: 1, entryPrice: 100_000 }], orders: [] });
    const d = evaluatePolicy({ kind: "wire", action: wire, expiresAfter: NOW + 15_000, origin: "guardian" }, ctx({ accountBook: uncovered }));
    expect(codes(d)).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(d.violations[0]!.message).toContain("the BTC position of 1.01 needs stop-losses");
  });

  it("lets a partial close with an order that isn't reduce-only through, and a flip that leaves the new side covered", () => {
    // Long 1 BTC with no stop: selling 0.3 of it only takes risk off.
    const uncovered = book({ positions: [{ coin: "BTC", size: 1, entryPrice: 100_000 }], orders: [] });
    const sell = (size: string) => ({ kind: "order", coin: "BTC", side: "sell", orderType: "limit", size, price: "100000", stopLoss: { triggerPrice: "104000" }, origin: "guardian" }) as ActionIntentInput;
    expect(check(sell("0.3"), { accountBook: uncovered }).allowed).toBe(true);
    // Long 0.3 to a short of 0.2, covered by the order's own stop.
    expect(check(sell("0.5"), { accountBook: book({ positions: [{ coin: "BTC", size: 0.3, entryPrice: 100_000 }], orders: [] }) }).allowed).toBe(true);
    // Adding to the uncovered long stays refused.
    expect(codes(check({ ...sell("0.3"), side: "buy", stopLoss: { triggerPrice: "96000" } } as ActionIntentInput, { accountBook: uncovered }))).toEqual(["STOP_LOSS_REQUIRED"]);
  });

  it("allows a batchModify that moves cover between the stops of a partly covered position, not one that lowers it", () => {
    // Long 1 BTC with stops of 0.5 (oid 11) and 0.3 (oid 14): 0.8 covered.
    const partly = book({ positions: [{ coin: "BTC", size: 1, entryPrice: 100_000 }], orders: [stop, { ...stop, oid: 14, cloid: undefined, size: 0.3 }] });
    const stopWire = (s: string) => ({ a: 0, b: false, p: "90250", s, r: true, t: { trigger: { isMarket: true, triggerPx: "95000", tpsl: "sl" } } });
    const batch = (a: string, b: string) => ({ type: "batchModify", modifies: [{ oid: 11, order: stopWire(a) }, { oid: 14, order: stopWire(b) }] });
    const run = (a: string, b: string) => evaluatePolicy({ kind: "wire", action: batch(a, b), expiresAfter: NOW + 15_000, origin: "guardian" }, ctx({ accountBook: partly }));
    expect(run("0.3", "0.5").allowed).toBe(true);
    expect(codes(run("0.3", "0.3"))).toEqual(["STOP_LOSS_REQUIRED"]);
  });

  it("refuses an exempt bot cancelling its own stop together with the user's", () => {
    const bots: Policy = { ...policy, allowedOrigins: ["guardian", "bot"], botEntriesWithoutStopLoss: true };
    const botStop: AccountOrder = { ...stop, oid: 15, cloid: generateCloid("bot") };
    const both = book({ orders: [stop, botStop] });
    const cancelBoth = { kind: "cancel", cancels: [{ coin: "BTC", oid: 11 }, { coin: "BTC", oid: 15 }], origin: "bot" } as ActionIntentInput;
    expect(codes(check(cancelBoth, { policy: bots, accountBook: both }))).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(check(cancel(15, "BTC", "bot"), { policy: bots, accountBook: both }).allowed).toBe(true);
  });

  it("lets only a bot place an order whose cloid carries the bot origin", () => {
    const bots: Policy = { ...policy, allowedOrigins: ["guardian", "bot"], botEntriesWithoutStopLoss: true };
    const tagged = (origin: string) =>
      ({ kind: "order", coin: "BTC", side: "sell", orderType: "stopMarket", size: "0.5", triggerPrice: "95000", reduceOnly: true, cloid: generateCloid("bot"), origin }) as ActionIntentInput;
    expect(codes(check(tagged("guardian"), { policy: bots }))).toEqual(["ORIGIN_NOT_ALLOWED"]);
    expect(evaluatePolicy(parseActionIntent(tagged("guardian")), ctx({ policy: bots })).violations.map((v) => v.code)).toEqual(["ORIGIN_NOT_ALLOWED"]);
    expect(check(tagged("bot"), { policy: bots }).allowed).toBe(true);
    const move = { ...moveStop(), order: { ...(moveStop() as unknown as { order: Record<string, unknown> }).order, cloid: generateCloid("bot") } } as unknown as ActionIntentInput;
    expect(codes(check(move, { policy: bots }))).toEqual(["ORIGIN_NOT_ALLOWED"]);
  });

  it("measures the stops' distance from the worst entry price the fills could give, not the all-filled average", () => {
    // Max 5%. Long 1 BTC from 100,000 with no stop. One action: buy 0.01 at 100,000 with a stop at 96,000; a far buy of
    // 1 at 85,000 with a stop at 81,000; a reduce-only sell stop for 2 at 88,500. All filled: 2.01 at about 92,500, the
    // 88,500 stop 4.3% below. If the far buy never fills: 1.01 at 100,000 with stops 11.5% and 19% away.
    const tight: Policy = { ...policy, maxStopLossDistancePct: 5 };
    const stopWire = (s: string, triggerPx: string, p: string) => ({ a: 0, b: false, p, s, r: true, t: { trigger: { isMarket: true, triggerPx, tpsl: "sl" } } });
    const wire = {
      type: "order",
      orders: [
        { a: 0, b: true, p: "100000", s: "0.01", r: false, t: { limit: { tif: "Gtc" } } },
        stopWire("0.01", "96000", "91200"),
        { a: 0, b: true, p: "85000", s: "1", r: false, t: { limit: { tif: "Gtc" } } },
        stopWire("1", "81000", "72900"),
        stopWire("2", "88500", "79650"),
      ],
      grouping: "na",
      builder: { b: BUILDER.address, f: 25 },
    };
    const uncovered = book({ positions: [{ coin: "BTC", size: 1, entryPrice: 100_000 }], orders: [] });
    const d = evaluatePolicy({ kind: "wire", action: wire, expiresAfter: NOW + 15_000, origin: "guardian" }, ctx({ policy: tight, accountBook: uncovered }));
    expect(codes(d)).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(d.violations[0]!.message).toContain("the BTC position of 2.01 needs stop-losses within 5% of its entry");
    // Stops within 5% of the highest price any fill could give (100,000) cover it.
    const near = { ...wire, orders: [wire.orders[0], wire.orders[1], wire.orders[2], stopWire("1", "81000", "72900"), stopWire("2", "95500", "90725")] };
    expect(evaluatePolicy({ kind: "wire", action: near, expiresAfter: NOW + 15_000, origin: "guardian" }, ctx({ policy: tight, accountBook: uncovered })).allowed).toBe(true);
  });
});
