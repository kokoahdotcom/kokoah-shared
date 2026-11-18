/**
 * Automation moving a user's whole-position TP/SL (Hyperliquid lists it with size 0): the breakeven and trailing
 * guardians modify it with `wholePosition`, so it keeps closing whatever is open, and the trailing engine keeps that a
 * modify instead of place-then-cancel (automation never places a new whole-position order). Stops listed with a size,
 * and stops the rules place themselves, stay sized.
 */
import { describe, expect, it } from "vitest";
import { compileAction } from "../src/actions/index.js";
import { evaluateTrailingStop, placeThenCancel } from "../src/algos/index.js";
import type { ActionIntent } from "../src/intents/index.js";
import type { TrailingStopRule } from "../src/guardians/schemas.js";
import {
  evaluateRule,
  type GuardianEvaluation,
  type GuardianOrder,
  type GuardianPosition,
  type GuardianRule,
  isWholePositionOrder,
  type MarketState,
  parseGuardianRule,
  type PositionState,
} from "../src/guardians/index.js";
import { mainnetRegistry } from "./helpers.js";

const NOW = 1_790_000_000_000;
const C = (n: number) => `0x${n.toString(16).padStart(32, "0")}` as `0x${string}`;
const market = (coin: string, markPrice: number, szDecimals = 2): MarketState => ({ [coin]: { markPrice, szDecimals } });
const long = (size: number, entryPrice: number): GuardianPosition => ({ side: "long", size, entryPrice, liquidationPrice: null, marginMode: "cross" });
const state = (positions: Record<string, GuardianPosition>, orders: GuardianOrder[]): PositionState => ({ account: { equityUsd: 10_000 }, positions, orders });
const advance = (rule: GuardianRule, r: GuardianEvaluation): GuardianRule => ({ ...rule, state: r.nextState, status: r.status }) as GuardianRule;
const modifyOf = (i: ActionIntent | undefined) => {
  if (!i || i.kind !== "modify") throw new Error(`expected modify intent, got ${i?.kind}`);
  return i;
};
/** A user's stop on the exchange: whole-position when listed with size 0. */
const stop = (over: Partial<GuardianOrder> = {}): GuardianOrder => ({ coin: "ETH", oid: 42, side: "sell", status: "open", origSize: 0, filledSize: 0, triggerPrice: 2900, ...over });

describe("whole-position orders as automation sees them", () => {
  it("are open triggers listed without a size, or flagged by the reader", () => {
    expect(isWholePositionOrder(stop())).toBe(true);
    expect(isWholePositionOrder(stop({ origSize: 0.5 }))).toBe(false);
    expect(isWholePositionOrder(stop({ origSize: 0.5, wholePosition: true }))).toBe(true);
    expect(isWholePositionOrder(stop({ status: "filled" }))).toBe(false);
    const { triggerPrice: _, ...plain } = stop();
    expect(isWholePositionOrder(plain)).toBe(false);
  });
});

describe("breakeven on a whole-position stop", () => {
  const rule = parseGuardianRule({ type: "breakeven", id: "be1", createdAt: NOW, coin: "ETH", trigger: { kind: "price", price: "3100" }, offsetBps: 10, stopOrder: { oid: 42 } });

  it("moves it and keeps it whole (size 0 on the wire)", () => {
    const hit = evaluateRule(rule, market("ETH", 3150, 4), state({ ETH: long(1, 3000) }, [stop()]), NOW);
    const m = modifyOf(hit.intents[0]);
    expect(m.target).toEqual({ oid: 42 });
    expect(m.order).toMatchObject({ coin: "ETH", side: "sell", orderType: "stopMarket", size: "1", triggerPrice: "3003", reduceOnly: true, wholePosition: true });
    expect(hit.nextState).toMatchObject({ moved: true, stopWhole: true });
    const compiled = compileAction(m, { registry: mainnetRegistry(), builder: { address: "0x1111111111111111111111111111111111111111", feeTenthsBps: 25 } });
    expect(compiled.action).toMatchObject({ type: "modify", order: { s: "0", r: true, t: { trigger: { tpsl: "sl", triggerPx: "3003" } } } });
  });

  it("leaves a stop with a size of its own sized", () => {
    const hit = evaluateRule(rule, market("ETH", 3150, 4), state({ ETH: long(1, 3000) }, [stop({ origSize: 1 })]), NOW);
    const m = modifyOf(hit.intents[0]);
    expect(m.order.wholePosition).toBeUndefined();
    expect(hit.nextState).toMatchObject({ stopWhole: false });
  });

  it("places a sized stop of its own when there is none (never a whole-position one)", () => {
    const hit = evaluateRule(rule, market("ETH", 3150, 4), state({ ETH: long(1, 3000) }, []), NOW);
    const placed = hit.intents[0];
    expect(placed).toMatchObject({ kind: "order", size: "1", positionTpsl: true });
    expect(placed && "wholePosition" in placed ? placed.wholePosition : undefined).toBeUndefined();
  });
});

describe("trailing stop on a whole-position stop", () => {
  const rule = parseGuardianRule({ type: "trailingStop", id: "ts1", createdAt: NOW, coin: "SOL", trail: { kind: "pct", value: 10 }, stopOrder: { oid: 42 } });
  const userStop = stop({ coin: "SOL", triggerPrice: 95 });

  it("ratchets it as a modify that keeps it whole, also in the engine's plan", () => {
    const first = evaluateRule(rule, market("SOL", 100), state({ SOL: long(2, 100) }, [userStop]), NOW);
    expect(first.intents).toEqual([]); // 90 would be looser than 95
    const up = evaluateTrailingStop(advance(rule, first) as TrailingStopRule, market("SOL", 110), state({ SOL: long(2, 100) }, [userStop]), NOW);
    expect(up.intents).toHaveLength(1);
    const m = modifyOf(up.intents[0]);
    expect(m.order).toMatchObject({ size: "2", triggerPrice: "99", wholePosition: true });
    expect(up.requires).toEqual({});
    expect(up.nextState).toMatchObject({ stopWhole: true });
  });

  it("keeps its own replacement whole, listed or not yet listed", () => {
    const first = evaluateRule(rule, market("SOL", 110), state({ SOL: long(2, 100) }, [userStop]), NOW);
    const moved = advance(rule, first);
    const own = (moved.state as { stopCloid: string }).stopCloid;
    // Listed again with size 0 under its new cloid.
    const listed = evaluateRule(moved, market("SOL", 120), state({ SOL: long(2, 100) }, [stop({ coin: "SOL", oid: 43, cloid: own, triggerPrice: 99 })]), NOW);
    expect(modifyOf(listed.intents[0]).order).toMatchObject({ triggerPrice: "108", wholePosition: true });
    // Not listed yet: the state remembers it was whole, so it is never turned into a sized stop.
    const unlisted = evaluateRule(moved, market("SOL", 120), state({ SOL: long(2, 100) }, []), NOW);
    expect(modifyOf(unlisted.intents[0]).order).toMatchObject({ triggerPrice: "108", wholePosition: true });
  });
});

describe("the engine's place-then-cancel", () => {
  const modify = (wholePosition?: true): ActionIntent =>
    ({
      kind: "modify",
      origin: "guardian",
      target: { oid: 42 },
      order: { coin: "SOL", side: "sell", orderType: "stopMarket", size: "2", triggerPrice: "99", reduceOnly: true, cloid: C(7), ...(wholePosition ? { wholePosition } : {}) },
    }) as ActionIntent;

  it("keeps a whole-position move a modify, and turns a sized one into place, then cancel", () => {
    expect(placeThenCancel([modify(true)])).toEqual({ intents: [modify(true)], requires: {}, cleanup: [] });
    const sized = placeThenCancel([modify()]);
    expect(sized.intents.map((i) => i.kind)).toEqual(["order", "cancel"]);
    expect(sized.intents[0]).toMatchObject({ positionTpsl: true, size: "2" });
  });
});
