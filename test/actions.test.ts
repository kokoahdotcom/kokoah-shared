import { describe, expect, it } from "vitest";
import {
  CLOID_ORIGIN_CODES,
  CompileError,
  compileAction,
  deriveCloid,
  generateCloid,
  isCloid,
  marketOrderLimitPrice,
  marketTriggerLimitPrice,
  parseCloid,
} from "../src/actions/index.js";
import { mainnetRegistry } from "./helpers.js";

const registry = mainnetRegistry();
const BUILDER = { address: "0x1111111111111111111111111111111111111111" as const, feeTenthsBps: 25 };

function compileError(fn: () => unknown): CompileError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CompileError);
    return e as CompileError;
  }
  throw new Error("expected CompileError");
}

describe("cloids", () => {
  it("generates 0x + 32 lowercase hex with the Kokoah tag", () => {
    for (const origin of ["manual", "guardian", "ai_ticket"] as const) {
      const c = generateCloid(origin);
      expect(isCloid(c)).toBe(true);
      expect(c.slice(2, 10)).toBe(`6b6f${CLOID_ORIGIN_CODES[origin]}01`);
      expect(parseCloid(c)).toEqual({ kokoah: true, origin, tag: c.slice(2, 10) });
    }
    const plain = generateCloid();
    expect(isCloid(plain)).toBe(true);
    expect(generateCloid("0xdeadbeef").startsWith("0xdeadbeef")).toBe(true);
    expect(() => generateCloid("0x123" as `0x${string}`)).toThrow(RangeError);
    expect(new Set(Array.from({ length: 200 }, () => generateCloid("manual"))).size).toBe(200);
  });
  it("derives deterministic cloids", () => {
    expect(deriveCloid("rule-1:0", "guardian")).toBe(deriveCloid("rule-1:0", "guardian"));
    expect(deriveCloid("rule-1:0", "guardian")).not.toBe(deriveCloid("rule-1:1", "guardian"));
    expect(parseCloid(deriveCloid("x", "guardian"))?.origin).toBe("guardian");
    expect(isCloid(deriveCloid("x"))).toBe(true);
  });
  it("parses foreign cloids", () => {
    expect(parseCloid("0x" + "ab".repeat(16))).toEqual({ kokoah: false, tag: "abababab" });
    expect(parseCloid("0x12")).toBeNull();
  });
});

describe("market order pricing", () => {
  it("applies slippage and rounds toward mid", () => {
    expect(marketOrderLimitPrice({ midPrice: 100000, isBuy: true, slippageBps: 100, szDecimals: 5 })).toBe("101000");
    expect(marketOrderLimitPrice({ midPrice: 100000, isBuy: false, slippageBps: 100, szDecimals: 5 })).toBe("99000");
    expect(marketOrderLimitPrice({ midPrice: "6789.1", isBuy: false, slippageBps: 100, szDecimals: 3 })).toBe("6721.3");
    expect(marketOrderLimitPrice({ midPrice: "6789.1", isBuy: true, slippageBps: 100, szDecimals: 3 })).toBe("6856.9"); // 6856.991 → down
    // Tolerance smaller than one tick: rounding toward mid would give mid itself, so round away (stays marketable).
    expect(marketOrderLimitPrice({ midPrice: "10.5", isBuy: true, slippageBps: 1, szDecimals: 5 })).toBe("10.6");
    expect(marketOrderLimitPrice({ midPrice: "10.5", isBuy: false, slippageBps: 1, szDecimals: 5 })).toBe("10.4");
    expect(marketOrderLimitPrice({ midPrice: "0.012345", isBuy: true, slippageBps: 500, szDecimals: 0 })).toBe("0.012962");
    expect(() => marketOrderLimitPrice({ midPrice: 100, isBuy: true, slippageBps: 1.5, szDecimals: 0 })).toThrow(RangeError);
    // A mid too small for the market's decimals is a CompileError, not a raw PrecisionError.
    expect(() => marketOrderLimitPrice({ midPrice: "0.0000001", isBuy: false, slippageBps: 100, szDecimals: 5 })).toThrow(CompileError);
  });
  it("market trigger limit price is trigger ± 10%", () => {
    expect(marketTriggerLimitPrice({ triggerPrice: "100", isBuy: true, szDecimals: 0 })).toBe("110");
    expect(marketTriggerLimitPrice({ triggerPrice: "100", isBuy: false, szDecimals: 0 })).toBe("90");
    expect(marketTriggerLimitPrice({ triggerPrice: "2700", isBuy: false, szDecimals: 4 })).toBe("2430");
    expect(marketTriggerLimitPrice({ triggerPrice: "1.2345", isBuy: true, szDecimals: 0 })).toBe("1.3579"); // 1.35795 → down
  });
  it("market trigger limit price steps one tick away when the tick is coarser than the 10% tolerance", () => {
    // szDecimals 1 → 5 price decimals: tick 0.00001. ±10% of 0.00001 rounds back onto the trigger, leaving no room.
    expect(marketTriggerLimitPrice({ triggerPrice: "0.00001", isBuy: true, szDecimals: 1 })).toBe("0.00002");
    // A sell at the smallest positive tick has no lower price: it keeps the lowest one there is.
    expect(marketTriggerLimitPrice({ triggerPrice: "0.00001", isBuy: false, szDecimals: 1 })).toBe("0.00001");
    expect(marketTriggerLimitPrice({ triggerPrice: "0.00002", isBuy: false, szDecimals: 1 })).toBe("0.00001");
    expect(marketTriggerLimitPrice({ triggerPrice: "0.00003", isBuy: true, szDecimals: 1 })).toBe("0.00004");
    // szDecimals 5 → 1 price decimal: tick 0.1 is 20% of 0.5.
    expect(marketTriggerLimitPrice({ triggerPrice: "0.5", isBuy: true, szDecimals: 5 })).toBe("0.6");
    expect(marketTriggerLimitPrice({ triggerPrice: "0.5", isBuy: false, szDecimals: 5 })).toBe("0.4");
    // Enough ticks inside the tolerance: unchanged (rounded toward the trigger).
    expect(marketTriggerLimitPrice({ triggerPrice: "0.0001", isBuy: false, szDecimals: 1 })).toBe("0.00009");
  });
});

describe("compileAction", () => {
  it("compiles a market order to an IOC limit at mid ± slippage with builder and generated cloid", () => {
    const c = compileAction({ kind: "order", coin: "BTC", side: "buy", orderType: "market", size: "0.01", origin: "manual" }, { registry, builder: BUILDER, getMidPrice: () => 100000 });
    expect(c.action).toMatchObject({
      type: "order",
      orders: [{ a: 0, b: true, p: "101000", s: "0.01", r: false, t: { limit: { tif: "Ioc" } } }],
      grouping: "na",
      builder: { b: BUILDER.address, f: 25 },
    });
    expect(Object.keys(c.action)).toEqual(["type", "orders", "grouping", "builder"]);
    expect(Object.keys((c.action as { orders: object[] }).orders[0]!)).toEqual(["a", "b", "p", "s", "r", "t", "c"]);
    expect(c.marketOrder).toEqual({ midPrice: "100000", limitPrice: "101000", slippageBps: 100 });
    expect(parseCloid(c.cloids[0]!)?.origin).toBe("manual");
  });

  it("omits builder when not configured and keeps order-level fields", () => {
    const c = compileAction(
      { kind: "order", coin: "xyz:GOLD", side: "sell", orderType: "limit", size: "0.5", price: "4000.1", tif: "Alo", origin: "ai_ticket" },
      { registry, newCloid: () => "0x" + "0".repeat(31) + "1" as `0x${string}` },
    );
    expect(Object.keys(c.action)).toEqual(["type", "orders", "grouping"]);
    expect(c.action).toMatchObject({ orders: [{ a: 110003, b: false, p: "4000.1", s: "0.5", t: { limit: { tif: "Alo" } }, c: "0x00000000000000000000000000000001" }] });
  });

  it("attaches TP/SL legs as normalTpsl children (opposite side, same size, reduce-only)", () => {
    const c = compileAction(
      { kind: "order", coin: "ETH", side: "buy", orderType: "market", size: "1", origin: "manual", takeProfit: { triggerPrice: "3300" }, stopLoss: { triggerPrice: "2800", orderType: "limit", limitPrice: "2790" } },
      { registry, builder: BUILDER, getMidPrice: () => "3000" },
    );
    const a = c.action as { grouping: string; orders: Array<Record<string, unknown>> };
    expect(a.grouping).toBe("normalTpsl");
    expect(a.orders).toHaveLength(3);
    expect(a.orders[1]).toMatchObject({ b: false, s: "1", r: true, p: "2970", t: { trigger: { isMarket: true, triggerPx: "3300", tpsl: "tp" } } });
    expect(a.orders[2]).toMatchObject({ b: false, s: "1", r: true, p: "2790", t: { trigger: { isMarket: false, triggerPx: "2800", tpsl: "sl" } } });
    expect(c.cloids).toHaveLength(3);
    expect(new Set(c.cloids).size).toBe(3);
  });

  it("uses positionTpsl grouping for position-level triggers", () => {
    const c = compileAction({ kind: "order", coin: "SOL", side: "sell", orderType: "stopMarket", size: "2", triggerPrice: "150", reduceOnly: true, positionTpsl: true, origin: "guardian" }, { registry });
    expect(c.action).toMatchObject({ grouping: "positionTpsl", orders: [{ a: 5, b: false, p: "135", r: true, t: { trigger: { isMarket: true, triggerPx: "150", tpsl: "sl" } } }] });
  });

  it("buy stop and take-profit triggers", () => {
    const stop = compileAction({ kind: "order", coin: "SOL", side: "buy", orderType: "stopMarket", size: "2", triggerPrice: "150", origin: "manual" }, { registry });
    expect(stop.action).toMatchObject({ orders: [{ b: true, p: "165", t: { trigger: { tpsl: "sl" } } }] });
    const tp = compileAction({ kind: "order", coin: "SOL", side: "buy", orderType: "takeProfitLimit", size: "2", triggerPrice: "140", price: "140.5", origin: "manual" }, { registry });
    expect(tp.action).toMatchObject({ orders: [{ b: true, p: "140.5", t: { trigger: { isMarket: false, triggerPx: "140", tpsl: "tp" } } }] });
  });

  it("returns the vault address for the request envelope", () => {
    const vault = "0x2222222222222222222222222222222222222222";
    const c = compileAction({ kind: "noop", origin: "manual", vaultAddress: vault }, { registry });
    expect(c.vaultAddress).toBe(vault);
    expect(c.action).toEqual({ type: "noop" });
  });

  it("rejects what it would otherwise have to round or guess", () => {
    expect(compileError(() => compileAction({ kind: "order", coin: "NOPE", side: "buy", orderType: "limit", size: "1", price: "1", origin: "manual" }, { registry })).code).toBe("UNKNOWN_MARKET");
    expect(compileError(() => compileAction({ kind: "order", coin: "MATIC", side: "buy", orderType: "limit", size: "1", price: "1", origin: "manual" }, { registry })).code).toBe("DELISTED_MARKET");
    const size = compileError(() => compileAction({ kind: "order", coin: "BTC", side: "buy", orderType: "limit", size: "0.0000011", price: "100000", origin: "manual" }, { registry }));
    expect(size.code).toBe("SIZE_PRECISION");
    expect(size.message).toContain("smaller than one lot");
    expect(compileError(() => compileAction({ kind: "order", coin: "BTC", side: "buy", orderType: "limit", size: "0.123456", price: "100000", origin: "manual" }, { registry })).message).toContain("use 0.12345");
    const px = compileError(() => compileAction({ kind: "order", coin: "BTC", side: "buy", orderType: "limit", size: "0.1", price: "100000.5", origin: "manual" }, { registry }));
    expect(px.code).toBe("PRICE_PRECISION");
    expect(px.message).toContain("nearest valid price is 100001");
    expect(compileError(() => compileAction({ kind: "order", coin: "BTC", side: "buy", orderType: "market", size: "0.1", origin: "manual" }, { registry })).code).toBe("MISSING_MID_PRICE");
    expect(compileError(() => compileAction({ kind: "updateLeverage", coin: "BTC", leverage: 41, marginMode: "cross", origin: "manual" }, { registry })).code).toBe("LEVERAGE_ABOVE_MAX");
    expect(compileError(() => compileAction({ kind: "updateLeverage", coin: "xyz:EUR", leverage: 5, marginMode: "cross", origin: "manual" }, { registry })).code).toBe("CROSS_NOT_ALLOWED");
    expect(compileError(() => compileAction({ kind: "order", coin: "BTC", side: "buy", orderType: "limit", size: "0.1", price: "100000", origin: "manual" }, { registry, builder: { ...BUILDER, feeTenthsBps: 101 } })).code).toBe("INVALID_BUILDER");
    expect(compileError(() => compileAction({ kind: "order", coin: "BTC", side: "buy", orderType: "limit", size: "0.1", price: "100000", origin: "manual" }, { registry, builder: { address: "0x12", feeTenthsBps: 1 } as never })).code).toBe("INVALID_BUILDER");
    expect(compileError(() => compileAction({ kind: "updateIsolatedMargin", coin: "SOL", amountUsd: "1.0000001", origin: "manual" }, { registry })).code).toBe("MARGIN_PRECISION");
    expect(compileError(() => compileAction({ kind: "scheduleCancel", time: 1_000_004_000, origin: "manual" }, { registry, now: 1_000_000_000 })).code).toBe("SCHEDULE_TOO_SOON");
    expect(compileError(() => compileAction({ kind: "order", origin: "manual" } as never, { registry })).code).toBe("INVALID_INTENT");
  });

  it("allows cancels on delisted markets (orders may still rest there)", () => {
    const c = compileAction({ kind: "cancel", cancels: [{ coin: "MATIC", oid: 7 }], origin: "manual" }, { registry });
    expect(c.action).toEqual({ type: "cancel", cancels: [{ a: 3, o: 7 }] });
  });

  it("spot markets allow a 1000 builder fee and use the 8-decimal rule", () => {
    const c = compileAction({ kind: "order", coin: "@107", side: "sell", orderType: "limit", size: "1.5", price: "45.123", origin: "manual" }, { registry, builder: { ...BUILDER, feeTenthsBps: 1000 } });
    expect(c.action).toMatchObject({ orders: [{ a: 10107 }], builder: { f: 1000 } });
  });
});
