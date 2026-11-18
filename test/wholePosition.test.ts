// Hyperliquid's TP/SL for the whole position: a reduce-only trigger with size 0 in a `positionTpsl` order action, as
// Hyperliquid's own app sends it. It closes whatever is open when it fires; a position TP/SL with a size of its own is
// fixed at that size.
import { describe, expect, it } from "vitest";
import { compileAction } from "../src/actions/index.js";
import { type ActionIntentInput, parseActionIntent, safeParseActionIntent } from "../src/intents/index.js";
import {
  type AccountBook,
  type AccountOrder,
  coveredSize,
  createGuardianPolicy,
  evaluatePolicy,
  marketTriggerSlippageFor,
  type PolicyContext,
  positionAfterEntriesProblem,
} from "../src/policy/index.js";
import { wireActionProblems } from "../src/policy/wire.js";
import { mainnetRegistry } from "./helpers.js";

const registry = mainnetRegistry();
const NOW = 1_790_000_000_000;
const BUILDER = { address: "0x1111111111111111111111111111111111111111" as const, feeTenthsBps: 25 };
const policy = createGuardianPolicy({ builder: { b: BUILDER.address, f: 25 }, allowedCoins: "*", maxOrderNotionalUsd: 100_000, maxDailyNotionalUsd: 400_000 });
const strict = { ...policy, exemptReduceOnlyFromNotionalCaps: false };

/** Long 0.5 BTC from $100,000: a whole-position stop (oid 12, size 0) and a fixed position stop (oid 14, 0.5). */
const wholeStop: AccountOrder = { coin: "BTC", oid: 12, isBuy: false, size: 0, isTrigger: true, triggerPrice: 95_000, tpsl: "sl", reduceOnly: true, positionTpsl: true, isMarket: true, limitPrice: 85_500, filledSize: 0, attachedStops: [] };
const fixedStop: AccountOrder = { ...wholeStop, oid: 14, size: 0.5 };
const book = (orders: AccountOrder[] = [wholeStop], size = 0.5): AccountBook => ({ positions: [{ coin: "BTC", size, entryPrice: 100_000 }], orders });

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  policy,
  now: NOW,
  markPrices: { BTC: 100_000 },
  dailyNotionalUsedUsd: 0,
  ordersInLastMinute: 0,
  registry,
  expiresAfter: NOW + 15_000,
  ...over,
});
const compile = (intent: ActionIntentInput) =>
  compileAction(parseActionIntent(intent), { registry, now: NOW, builder: BUILDER, getMidPrice: () => "100000", marketTriggerSlippageBps: marketTriggerSlippageFor(policy, { BTC: 100_000 }) });
const evalCompiled = (intent: ActionIntentInput, over: Partial<PolicyContext> = {}) =>
  evaluatePolicy({ kind: "compiled", compiled: compile(intent), expiresAfter: NOW + 15_000 }, ctx(over));
const evalWire = (action: Record<string, unknown>, over: Partial<PolicyContext> = {}) =>
  evaluatePolicy({ kind: "wire", action: action as { type: string }, expiresAfter: NOW + 15_000, origin: "guardian" }, ctx(over));

const wholeSl = { kind: "order", coin: "BTC", side: "sell", orderType: "stopMarket", size: "0.5", triggerPrice: "95000", reduceOnly: true, positionTpsl: true, wholePosition: true, origin: "guardian" } as const;
const modifyWhole = (oid: number, over: Record<string, unknown> = {}) =>
  ({ kind: "modify", target: { oid }, order: { coin: "BTC", side: "sell", orderType: "stopMarket", size: "0.5", triggerPrice: "96000", reduceOnly: true, wholePosition: true, ...over }, origin: "guardian" }) as const;

describe("whole-position TP/SL intents", () => {
  it("accepts a reduce-only position TP/SL trigger", () => {
    expect(parseActionIntent(wholeSl)).toMatchObject({ wholePosition: true, positionTpsl: true, size: "0.5" });
    expect(parseActionIntent({ ...wholeSl, orderType: "takeProfitLimit", triggerPrice: "110000", price: "109000" })).toMatchObject({ wholePosition: true });
  });
  it.each([
    ["without positionTpsl", { positionTpsl: false }],
    ["without reduceOnly", { reduceOnly: false }],
    ["on a limit order", { orderType: "limit", triggerPrice: undefined, price: "95000", positionTpsl: false }],
    ["on a market order", { orderType: "market", triggerPrice: undefined }],
  ])("refuses it %s", (_name, over) => {
    const r = safeParseActionIntent({ ...wholeSl, ...over } as ActionIntentInput);
    expect(r.success).toBe(false);
  });
  it("leaves it out unless asked", () => {
    const { wholePosition: _w, ...fixed } = wholeSl;
    expect(parseActionIntent(fixed)).not.toHaveProperty("wholePosition");
  });
  it("accepts a modify of one, never of a limit or a non-reduce-only order", () => {
    expect(parseActionIntent(modifyWhole(12))).toMatchObject({ order: { wholePosition: true } });
    expect(safeParseActionIntent(modifyWhole(12, { reduceOnly: false }) as ActionIntentInput).success).toBe(false);
    expect(safeParseActionIntent(modifyWhole(12, { orderType: "limit", triggerPrice: undefined, price: "96000" }) as ActionIntentInput).success).toBe(false);
  });
});

describe("whole-position TP/SL compile", () => {
  it("sends size 0 in a positionTpsl action, with the builder", () => {
    const c = compile(wholeSl);
    expect(c.action).toMatchObject({ type: "order", grouping: "positionTpsl", builder: { b: BUILDER.address, f: 25 } });
    expect((c.action as { orders: Array<Record<string, unknown>> }).orders).toEqual([
      expect.objectContaining({ a: 0, b: false, s: "0", r: true, t: { trigger: { isMarket: true, triggerPx: "95000", tpsl: "sl" } } }),
    ]);
  });
  it("keeps a position TP/SL with a size of its own fixed at that size", () => {
    const { wholePosition: _w, ...fixed } = wholeSl;
    expect((compile(fixed).action as { orders: Array<{ s: string }> }).orders[0]!.s).toBe("0.5");
  });
  it("still checks the size it was given", () => {
    expect(() => compile({ ...wholeSl, size: "0.123456789" })).toThrow(/not valid/);
  });
  it("modifies one with size 0", () => {
    expect(compile(modifyWhole(12)).action).toMatchObject({ type: "modify", oid: 12, order: { s: "0", r: true, t: { trigger: { triggerPx: "96000", tpsl: "sl" } } } });
  });
});

describe("whole-position TP/SL on the wire", () => {
  const order = compile(wholeSl).action as unknown as { orders: Array<Record<string, unknown>>; grouping: string };
  const zero = order.orders[0]!;
  const entry = (compile({ kind: "order", coin: "BTC", side: "buy", orderType: "limit", price: "99000", size: "0.1", origin: "guardian" }).action as unknown as { orders: Array<Record<string, unknown>> }).orders[0]!;

  it("is allowed in a positionTpsl action of exits only", () => {
    expect(wireActionProblems({ type: "order", orders: [zero], grouping: "positionTpsl" })).toEqual([]);
    const tp = { ...zero, t: { trigger: { isMarket: true, triggerPx: "110000", tpsl: "tp" } } };
    expect(wireActionProblems({ type: "order", orders: [tp, zero], grouping: "positionTpsl" })).toEqual([]);
  });
  it.each([
    ["grouping na", { type: "order", orders: [zero], grouping: "na" }],
    ["grouping normalTpsl", { type: "order", orders: [entry, zero], grouping: "normalTpsl" }],
    ["next to an entry", { type: "order", orders: [entry, zero], grouping: "positionTpsl" }],
    ["not reduce-only", { type: "order", orders: [{ ...zero, r: false }], grouping: "positionTpsl" }],
    ["on a limit order", { type: "order", orders: [{ ...zero, t: { limit: { tif: "Gtc" } } }], grouping: "positionTpsl" }],
    ["written 0.0", { type: "order", orders: [{ ...zero, s: "0.0" }], grouping: "positionTpsl" }],
  ])("is refused %s", (_name, action) => {
    expect(wireActionProblems(action as never).some((p) => /size/.test(p))).toBe(true);
  });
  it("is refused in a modify of a limit or a non-reduce-only order", () => {
    expect(wireActionProblems({ type: "modify", oid: 12, order: { ...zero, r: false } }).some((p) => /size/.test(p))).toBe(true);
    expect(wireActionProblems({ type: "modify", oid: 12, order: { ...zero, t: { limit: { tif: "Gtc" } } } }).some((p) => /size/.test(p))).toBe(true);
  });
});

describe("whole-position TP/SL policy", () => {
  it("allows a new one without reading the account when reduce-only exits are exempt from the caps", () => {
    expect(evalCompiled(wholeSl)).toMatchObject({ allowed: true });
  });
  it("counts the position it closes when reduce-only exits count toward the caps", () => {
    // 2 BTC at $100,000: $200,000 against the $100,000 order limit.
    expect(evalCompiled(wholeSl, { policy: strict, accountBook: book([], 2) }).violations.map((v) => v.code)).toContain("ORDER_NOTIONAL_EXCEEDED");
    expect(evalCompiled(wholeSl, { policy: strict, accountBook: book([], 0.5) })).toMatchObject({ allowed: true });
    // $50,000 of the position on top of $360,000 already used today passes $400,000.
    expect(evalCompiled(wholeSl, { policy: strict, accountBook: book([], 0.5), dailyNotionalUsedUsd: 360_000 }).violations.map((v) => v.code)).toContain("DAILY_NOTIONAL_EXCEEDED");
  });
  it("refuses it on a spot market", () => {
    const spot = { ...(compile(wholeSl).action as unknown as Record<string, unknown>) };
    const orders = (spot.orders as Array<Record<string, unknown>>).map((o) => ({ ...o, a: 10_107 }));
    expect(evalWire({ ...spot, orders }).violations.map((v) => v.message).join(" ")).toMatch(/perpetual positions only/);
  });
  it("refuses it when the caps need the position and it wasn't read", () => {
    const d = evalCompiled(wholeSl, { policy: strict });
    expect(d.allowed).toBe(false);
    expect(d.violations.map((v) => v.message).join(" ")).toMatch(/position could not be read/);
  });
  it("allows a size-0 modify only of a whole-position TP/SL on the account", () => {
    const modify = compile(modifyWhole(12)).action as unknown as Record<string, unknown>;
    expect(evalWire(modify, { accountBook: book() })).toMatchObject({ allowed: true });
    // Not read, not on the book, a fixed position stop, a plain stop, the other side.
    expect(evalWire(modify).allowed).toBe(false);
    expect(evalWire(modify, { accountBook: book([]) }).allowed).toBe(false);
    expect(evalWire({ ...modify, oid: 14 }, { accountBook: book([wholeStop, fixedStop]) }).allowed).toBe(false);
    expect(evalWire(modify, { accountBook: book([{ ...wholeStop, positionTpsl: false }]) }).allowed).toBe(false);
    expect(evalWire(modify, { accountBook: book([{ ...wholeStop, isBuy: true }]) }).allowed).toBe(false);
    // By cloid, and in a batch.
    const cloid = "0x6b6f0101000000000000000000000abc";
    expect(evalWire({ ...modify, oid: cloid }, { accountBook: book([{ ...wholeStop, cloid }]) })).toMatchObject({ allowed: true });
    const batch = { type: "batchModify", modifies: [{ oid: 12, order: (modify as { order: unknown }).order }] };
    expect(evalWire(batch, { accountBook: book() })).toMatchObject({ allowed: true });
    expect(evalWire({ ...batch, modifies: [{ oid: 14, order: (modify as { order: unknown }).order }] }, { accountBook: book([fixedStop]) }).allowed).toBe(false);
  });
  it("keeps the stop-loss cover when a whole-position stop is moved", () => {
    const modify = compile(modifyWhole(12)).action as unknown as Record<string, unknown>;
    expect(evalWire(modify, { accountBook: book(), requireStopCoverage: true })).toMatchObject({ allowed: true });
  });
});

describe("position TP/SL cover", () => {
  const position = { coin: "BTC", size: 0.8, entryPrice: 100_000 };
  it("is the whole position for size 0, only its own size otherwise", () => {
    expect(coveredSize(position, [wholeStop], undefined)).toBe(0.8);
    expect(coveredSize(position, [fixedStop], undefined)).toBe(0.5);
  });
  it("lets an entry add to a position only when its stops cover what it grows to", () => {
    const add = [{ coin: "BTC", isBuy: true, size: 0.3, price: 100_000, triggerPrice: undefined, isTrigger: false, reduceOnly: false }];
    expect(positionAfterEntriesProblem({ coin: "BTC", legs: add, book: book([wholeStop]), mark: 100_000 })).toBeNull();
    expect(positionAfterEntriesProblem({ coin: "BTC", legs: add, book: book([fixedStop]), mark: 100_000 })).toMatch(/needs stop-losses/);
  });
});
