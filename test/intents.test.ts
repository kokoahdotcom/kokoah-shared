import { describe, expect, it } from "vitest";
import { IntentValidationError, isEntryIntent, parseActionIntent, safeParseActionIntent } from "../src/intents/index.js";

const order = (o: Record<string, unknown>) => ({ kind: "order", coin: "BTC", side: "buy", size: "0.01", origin: "manual", ...o });

describe("intents", () => {
  it("normalizes decimals, lowercases hex and applies defaults", () => {
    const i = parseActionIntent(order({ orderType: "limit", price: 100000.0, size: "0.0100", cloid: "0xABCDEF0123456789ABCDEF0123456789", vaultAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }));
    expect(i).toMatchObject({ kind: "order", price: "100000", size: "0.01", reduceOnly: false, positionTpsl: false, cloid: "0xabcdef0123456789abcdef0123456789", vaultAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(isEntryIntent(i)).toBe(true);
    // Idempotent: parsing the output again yields the same object.
    expect(parseActionIntent(i)).toEqual(i);
  });

  it("accepts every order type with the right fields", () => {
    const ok: unknown[] = [
      order({ orderType: "market", slippageBps: 50 }),
      order({ orderType: "market" }),
      order({ orderType: "limit", price: "100", tif: "Alo" }),
      order({ orderType: "stopMarket", triggerPrice: "90", reduceOnly: true, side: "sell" }),
      order({ orderType: "stopLimit", triggerPrice: "90", price: "89", reduceOnly: true, side: "sell", positionTpsl: true }),
      order({ orderType: "takeProfitMarket", triggerPrice: "110", reduceOnly: true, side: "sell" }),
      order({ orderType: "takeProfitLimit", triggerPrice: "110", price: "111" }),
      order({ orderType: "limit", price: "100", takeProfit: { triggerPrice: "110" }, stopLoss: { triggerPrice: "95", orderType: "limit", limitPrice: "94" } }),
      order({ orderType: "market", stopLoss: { triggerPrice: "95" } }),
    ];
    for (const x of ok) expect(safeParseActionIntent(x).success, JSON.stringify(x)).toBe(true);
  });

  it.each([
    ["limit without price", order({ orderType: "limit" }), "need a price"],
    ["market with price", order({ orderType: "market", price: "1" }), "must not have a price"],
    ["stop without trigger", order({ orderType: "stopMarket" }), "need a triggerPrice"],
    ["limit with trigger", order({ orderType: "limit", price: "1", triggerPrice: "1" }), "must not have a triggerPrice"],
    ["tif on market", order({ orderType: "market", tif: "Ioc" }), "tif is only valid"],
    ["slippage on limit", order({ orderType: "limit", price: "1", slippageBps: 10 }), "slippageBps is only valid"],
    ["TP/SL on trigger", order({ orderType: "stopMarket", triggerPrice: "1", stopLoss: { triggerPrice: "1" } }), "only valid on market or limit"],
    ["TP/SL on reduce-only", order({ orderType: "limit", price: "1", reduceOnly: true, stopLoss: { triggerPrice: "0.5" } }), "not valid on reduce-only"],
    ["positionTpsl on limit", order({ orderType: "limit", price: "1", positionTpsl: true }), "positionTpsl requires"],
    ["positionTpsl without reduceOnly", order({ orderType: "stopMarket", triggerPrice: "1", positionTpsl: true }), "positionTpsl requires"],
    ["stop above buy entry", order({ orderType: "limit", price: "100", stopLoss: { triggerPrice: "101" } }), "Stop-loss trigger must be below"],
    ["tp below buy entry", order({ orderType: "limit", price: "100", takeProfit: { triggerPrice: "99" } }), "Take-profit trigger must be above"],
    ["stop below sell entry", order({ side: "sell", orderType: "limit", price: "100", stopLoss: { triggerPrice: "99" } }), "Stop-loss trigger must be below"],
    ["duplicate cloids", order({ orderType: "limit", price: "100", cloid: "0x" + "1".repeat(32), stopLoss: { triggerPrice: "90", cloid: "0x" + "1".repeat(32) } }), "distinct"],
    ["limit leg without limitPrice", order({ orderType: "limit", price: "100", stopLoss: { triggerPrice: "90", orderType: "limit" } }), "limit TP/SL leg"],
  ])("rejects %s", (_name, input, message) => {
    const r = safeParseActionIntent(input);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.issues.map((i) => i.message).join(" | ")).toContain(message);
  });

  it.each([
    ["unknown key", order({ orderType: "market", leverage: 10 })],
    ["bad cloid", order({ orderType: "market", cloid: "0x1234" })],
    ["zero size", order({ orderType: "market", size: "0" })],
    ["negative size", order({ orderType: "market", size: -1 })],
    ["garbage size", order({ orderType: "market", size: "1,5" })],
    ["missing origin", { kind: "order", coin: "BTC", side: "buy", size: "1", orderType: "market" }],
    ["bad origin", order({ orderType: "market", origin: "bot" })],
    ["coin with space", order({ orderType: "market", coin: "B TC" })],
    ["slippage over 10%", order({ orderType: "market", slippageBps: 1001 })],
    ["bad vault", order({ orderType: "market", vaultAddress: "0x12" })],
    ["unknown kind", { kind: "withdraw", origin: "manual" }],
  ])("rejects %s (schema)", (_n, input) => {
    expect(safeParseActionIntent(input).success).toBe(false);
    expect(() => parseActionIntent(input)).toThrow(IntentValidationError);
  });

  it("validates cancels, modifies and account intents", () => {
    expect(safeParseActionIntent({ kind: "cancel", cancels: [{ coin: "BTC", oid: 1 }, { coin: "ETH", oid: 2 }], origin: "manual" }).success).toBe(true);
    expect(safeParseActionIntent({ kind: "cancel", cancels: [{ coin: "BTC", cloid: "0x" + "a".repeat(32) }], origin: "manual" }).success).toBe(true);
    expect(safeParseActionIntent({ kind: "cancel", cancels: [{ coin: "BTC", oid: 1 }, { coin: "BTC", cloid: "0x" + "a".repeat(32) }], origin: "manual" }).success).toBe(false);
    expect(safeParseActionIntent({ kind: "cancel", cancels: [], origin: "manual" }).success).toBe(false);
    expect(safeParseActionIntent({ kind: "cancel", cancels: [{ coin: "BTC", oid: -1 }], origin: "manual" }).success).toBe(false);

    const modify = { kind: "modify", target: { oid: 5 }, order: { coin: "BTC", side: "sell", orderType: "stopMarket", size: "1", triggerPrice: "90", reduceOnly: true }, origin: "guardian" };
    expect(safeParseActionIntent(modify).success).toBe(true);
    expect(safeParseActionIntent({ ...modify, order: { ...modify.order, orderType: "market" } }).success).toBe(false);
    expect(safeParseActionIntent({ ...modify, order: { coin: "BTC", side: "buy", orderType: "limit", size: "1" } }).success).toBe(false);

    expect(safeParseActionIntent({ kind: "updateLeverage", coin: "BTC", leverage: 10, marginMode: "cross", origin: "manual" }).success).toBe(true);
    expect(safeParseActionIntent({ kind: "updateLeverage", coin: "BTC", leverage: 0, marginMode: "cross", origin: "manual" }).success).toBe(false);
    expect(safeParseActionIntent({ kind: "updateLeverage", coin: "BTC", leverage: 2.5, marginMode: "cross", origin: "manual" }).success).toBe(false);
    expect(safeParseActionIntent({ kind: "updateIsolatedMargin", coin: "BTC", amountUsd: "-5", origin: "manual" }).success).toBe(true);
    expect(safeParseActionIntent({ kind: "updateIsolatedMargin", coin: "BTC", amountUsd: "0", origin: "manual" }).success).toBe(false);
    expect(safeParseActionIntent({ kind: "scheduleCancel", time: 1790000060000, origin: "manual" }).success).toBe(true);
    expect(safeParseActionIntent({ kind: "scheduleCancel", origin: "manual" }).success).toBe(true);
    expect(safeParseActionIntent({ kind: "noop", origin: "guardian" }).success).toBe(true);
  });

  it("reports issue paths", () => {
    const r = safeParseActionIntent(order({ orderType: "market", size: "abc" }));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.issues.some((i) => i.path === "size")).toBe(true);
  });
});
