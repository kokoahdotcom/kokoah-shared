import { describe, expect, it } from "vitest";
import { compileAction } from "../src/actions/index.js";
import { type ActionIntentInput, parseActionIntent } from "../src/intents/index.js";
import { type AccountBook, type AccountOrder, createGuardianPolicy, evaluatePolicy, type Policy, type PolicyContext, positionCovered } from "../src/policy/index.js";
import { mainnetRegistry } from "./helpers.js";

const registry = mainnetRegistry();
const NOW = 1_790_000_000_000;
const policy = createGuardianPolicy({ builder: { b: "0x1111111111111111111111111111111111111111", f: 25 }, allowedCoins: "*", maxOrderNotionalUsd: 50_000, maxDailyNotionalUsd: 200_000 });
const CLOID = "0x6b6f0101000000000000000000000abc";

/** Long 0.5 BTC from $100,000 with a reduce-only stop at $95,000 (oid 11), a take-profit (oid 13) and an ETH limit (oid 20). */
const stop: AccountOrder = { coin: "BTC", oid: 11, cloid: CLOID, isBuy: false, size: 0.5, isTrigger: true, triggerPrice: 95_000, tpsl: "sl", reduceOnly: true, positionTpsl: false };
const book = (over: Partial<AccountBook> = {}): AccountBook => ({
  positions: [{ coin: "BTC", size: 0.5, entryPrice: 100_000 }],
  orders: [
    stop,
    { coin: "BTC", oid: 13, isBuy: false, size: 0.5, isTrigger: true, triggerPrice: 110_000, tpsl: "tp", reduceOnly: true, positionTpsl: false },
    { coin: "ETH", oid: 20, isBuy: true, size: 1, isTrigger: false, reduceOnly: false, positionTpsl: false },
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
  const compiled = compileAction(parseActionIntent(intent), { registry, now: NOW });
  return evaluatePolicy({ kind: "compiled", compiled, expiresAfter: NOW + 15_000 }, ctx(c));
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
    expect(check(cancel(999)).allowed).toBe(true);
    const positionStop: AccountOrder = { coin: "BTC", oid: 12, isBuy: false, size: 0, isTrigger: true, triggerPrice: 97_000, tpsl: "sl", reduceOnly: true, positionTpsl: true };
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

  it("checks only where the policy requires stops, and not for bots it exempts", () => {
    const loose: Policy = { ...policy, requireStopLossForNewEntries: false };
    expect(check(cancel(11), { policy: loose }).allowed).toBe(true);
    const bots: Policy = { ...policy, allowedOrigins: ["guardian", "bot"], botEntriesWithoutStopLoss: true };
    expect(check(cancel(11, "BTC", "bot"), { policy: bots }).allowed).toBe(true);
    expect(codes(check(cancel(11, "BTC", "guardian"), { policy: bots }))).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(codes(check(cancel(11, "BTC", "bot"), { policy: { ...bots, botEntriesWithoutStopLoss: false } }))).toEqual(["STOP_LOSS_REQUIRED"]);
  });

  it("without a distance limit, any stop-loss on the closing side counts", () => {
    const anyDistance: Policy = { ...policy, maxStopLossDistancePct: undefined };
    const far = book({ orders: [{ ...stop, triggerPrice: 60_000 }] });
    const d = check(cancel(11), { policy: anyDistance, accountBook: far });
    expect(codes(d)).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(d.violations[0]!.message).toBe("This would leave the open BTC position without a stop-loss; place the new stop first.");
  });
});
