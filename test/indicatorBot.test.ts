import { describe, expect, it } from "vitest";
import {
  backtestIndicatorBot,
  BOT_KINDS,
  botCoins,
  botLimitNeeds,
  botTrades,
  conditionText,
  indicatorBars,
  indicatorBarsNeeded,
  indicatorDecision,
  IndicatorReader,
  indicatorSignalConfig,
  parseBotConfig,
  ruleText,
  type BacktestCandle,
  type IndicatorBotConfig,
  type IndicatorRule,
} from "../src/bots/index.js";
import { ema, rsi, supertrend, vwap } from "../src/indicators/index.js";

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 1);

/** Hourly candles through the given closes (each opens at the previous close, wicks 0.1% beyond, volume 10). */
function candles(closes: number[], open = closes[0]!): (BacktestCandle & { v: number })[] {
  let prev = open;
  return closes.map((c, i) => {
    const k = { t: T0 + i * H, o: prev, h: Math.max(prev, c) * 1.001, l: Math.min(prev, c) * 0.999, c, v: 10 };
    prev = c;
    return k;
  });
}
const reader = (closes: number[]) => new IndicatorReader(indicatorBars(candles(closes), H));

const price = { kind: "price" } as const;
const value = (x: number) => ({ kind: "value", value: x }) as const;
const rule = (action: IndicatorRule["action"], conditions: IndicatorRule["conditions"], match: IndicatorRule["match"] = "all"): IndicatorRule => ({ action, match, conditions });

const alertBot = (over: Record<string, unknown> = {}) =>
  parseBotConfig({
    kind: "indicator",
    coin: "BTC",
    timeframe: "1h",
    mode: "alert",
    rules: [{ action: "buy", conditions: [{ op: "crossesBelow", left: { kind: "rsi" }, right: value(30) }] }],
    ...over,
  }) as IndicatorBotConfig;
const tradeBot = (over: Record<string, unknown> = {}) =>
  alertBot({ mode: "trade", orderSizeUsd: 100, maxOrderUsd: 200, maxPositionUsd: 200, maxLeverage: 3, ...over });

describe("indicator bot config", () => {
  it("is a bot kind; an alert bot needs no trading fields and fills the indicators' default lengths", () => {
    expect(BOT_KINDS).toContain("indicator");
    const c = alertBot();
    expect(c.rules[0]!.match).toBe("all");
    expect(c.rules[0]!.conditions[0]).toEqual({ op: "crossesBelow", left: { kind: "rsi", length: 14 }, right: { kind: "value", value: 30 } });
    expect(c.direction).toBe("both");
    expect(botTrades(c)).toBe(false);
    expect(botCoins(c)).toEqual([]);
    expect(indicatorSignalConfig(c)).toBeNull();
    // It is never checked against the automation limits; its needs add nothing.
    expect(botLimitNeeds(c)).toMatchObject({ coins: [], maxOrderNotionalUsd: 0, dailyNotionalUsd: 0, ordersPerMinute: 0 });
  });

  it("trades as a signal bot with the same caps", () => {
    const c = tradeBot();
    expect(botTrades(c)).toBe(true);
    expect(botCoins(c)).toEqual(["BTC"]);
    expect(indicatorSignalConfig(c)).toEqual({ kind: "signal", coin: "BTC", orderSizeUsd: 100, maxOrderUsd: 200, maxPositionUsd: 200, maxLeverage: 3, direction: "both", requireHmac: false });
    expect(botLimitNeeds(c)).toMatchObject({ coins: ["BTC"], maxLeverage: 3, maxOrderNotionalUsd: 202, ordersPerMinute: 10 });
    expect(botTrades(tradeBot({ mode: "both" }))).toBe(true);
  });

  it("refuses what can't work", () => {
    expect(() => alertBot({ mode: "trade" })).toThrow(/needs orderSizeUsd, maxOrderUsd, maxPositionUsd, maxLeverage/);
    expect(() => tradeBot({ orderSizeUsd: 300 })).toThrow(/default order size can't be above the cap per order/);
    expect(() => alertBot({ rules: [] })).toThrow(/Add a rule/);
    expect(() => alertBot({ rules: [{ action: "buy", conditions: [] }] })).toThrow(/A rule needs a condition/);
    expect(() => alertBot({ timeframe: "1m" })).toThrow();
    expect(() => alertBot({ rules: [{ action: "buy", conditions: [{ op: "above", left: value(1), right: value(2) }] }] })).toThrow(/compare an indicator or the price/);
    expect(() => alertBot({ rules: [{ action: "buy", conditions: [{ op: "above", left: { kind: "ema", length: 20 }, right: { kind: "ema", length: 20 } }] }] })).toThrow(/with itself/);
    expect(() => alertBot({ timeframe: "1d", rules: [{ action: "buy", conditions: [{ op: "above", left: price, right: { kind: "vwap" } }] }] })).toThrow(/VWAP restarts every day/);
    expect(() => alertBot({ rules: [{ action: "buy", conditions: [{ op: "above", left: price, right: { kind: "ema", length: 501 } }] }] })).toThrow();
    expect(() => alertBot({ rules: [{ action: "buy", conditions: [{ op: "turnsUp", trend: { kind: "rsi" } }] }] })).toThrow();
    const five = Array.from({ length: 5 }, () => rule("buy", [{ op: "above", left: price, right: value(1) }]));
    expect(() => alertBot({ rules: five })).toThrow();
  });

  it("reads as many candles as its slowest indicator needs, within bounds", () => {
    expect(indicatorBarsNeeded([rule("buy", [{ op: "crossesAbove", left: price, right: value(1) }])], "1h")).toBe(50);
    expect(indicatorBarsNeeded(alertBot().rules, "1h")).toBe(72);
    expect(indicatorBarsNeeded([rule("buy", [{ op: "above", left: price, right: { kind: "ema", length: 200 } }])], "1h")).toBe(802);
    expect(indicatorBarsNeeded([rule("buy", [{ op: "above", left: price, right: { kind: "ema", length: 500 } }])], "1h")).toBe(1000);
    // VWAP: since the day's start.
    expect(indicatorBarsNeeded([rule("buy", [{ op: "above", left: price, right: { kind: "vwap" } }])], "5m")).toBe(291);
  });

  it("says its rules in plain words", () => {
    expect(ruleText(alertBot().rules[0]!)).toBe("Buy when RSI(14) crosses below 30");
    expect(conditionText({ op: "turnsUp", trend: { kind: "supertrend", length: 10, factor: 3 } })).toBe("Supertrend (10, 3) turns up");
    expect(ruleText(rule("close", [{ op: "above", left: price, right: { kind: "bb", line: "upper", length: 20, mult: 2 } }, { op: "below", left: { kind: "macd", line: "hist", fast: 12, slow: 26, signal: 9 }, right: value(0) }], "any"))).toBe(
      "Close when Price is above Bollinger upper (20, 2) or MACD histogram (12, 26, 9) is below 0",
    );
  });
});

describe("reading rules at a close", () => {
  it("computes indicators as the chart does", () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + 10 * Math.sin(i / 5) + i * 0.1);
    const r = reader(closes);
    expect(r.value({ kind: "ema", length: 20 }, 100)).toBeCloseTo(ema(closes, 20)[100]!, 10);
    expect(r.value({ kind: "rsi", length: 14 }, 100)).toBeCloseTo(rsi(closes, 14)[100]!, 10);
    expect(r.value({ kind: "rsi", length: 14 }, 5)).toBeUndefined();
    expect(r.value(price, 7)).toBe(closes[7]);
    const bars = indicatorBars(candles(closes), H);
    expect(r.up({ kind: "supertrend", length: 10, factor: 3 }, 100)).toBe(supertrend(bars, 10, 3).up[100]);
    expect(vwap(bars.t, bars, H)[0]).toBeCloseTo((bars.h[0]! + bars.l[0]! + bars.c[0]!) / 3, 10);
  });

  it("crosses as TradingView does: above now, at or below at the previous close", () => {
    const r = reader([100, 104, 105, 106, 104, 106]);
    const up = { op: "crossesAbove", left: price, right: value(105) } as const;
    expect([1, 2, 3, 4, 5].map((i) => r.condition(up, i))).toEqual([false, false, true, false, true]);
    const down = { op: "crossesBelow", left: price, right: value(105) } as const;
    expect([1, 2, 3, 4, 5].map((i) => r.condition(down, i))).toEqual([false, false, false, true, false]);
    expect(r.condition(up, 0)).toBeUndefined();
  });

  it("fires a rule once when its conditions come true, again only after they stopped being true", () => {
    const rules = [rule("buy", [{ op: "above", left: price, right: value(105) }])];
    const r = reader([100, 106, 107, 108, 104, 106, 107]);
    expect([1, 2, 3, 4, 5, 6].map((i) => indicatorDecision(rules, r, i).actions)).toEqual([["buy"], [], [], [], ["buy"], []]);
    // The first close it can be read never fires: whether it was already true is unknown.
    expect(indicatorDecision(rules, r, 0)).toMatchObject({ fired: [], warming: false });
  });

  it("reads all or any of the conditions", () => {
    const r = reader([100, 106, 99, 110]);
    const above = { op: "above", left: price, right: value(105) } as const;
    const below = { op: "below", left: price, right: value(100) } as const;
    expect([0, 1, 2, 3].map((i) => r.rule(rule("buy", [above, below], "any"), i))).toEqual([false, true, true, true]);
    expect([0, 1, 2, 3].map((i) => r.rule(rule("buy", [above, below]), i))).toEqual([false, false, false, false]);
  });

  it("waits for history: a rule on an unknown value neither fires nor counts as false", () => {
    const rules = [rule("buy", [{ op: "above", left: price, right: { kind: "sma", length: 3 } }])];
    const r = reader([100, 90, 80, 120, 130]);
    expect(indicatorDecision(rules, r, 1)).toMatchObject({ fired: [], warming: true });
    // SMA(3) first known at candle 2 (price below it), so candle 3 fires.
    expect(indicatorDecision(rules, r, 2)).toMatchObject({ fired: [], warming: false });
    expect(indicatorDecision(rules, r, 3).actions).toEqual(["buy"]);
  });

  it("closes first, does one buy or sell, and does neither when both fire", () => {
    const up = { op: "crossesAbove", left: price, right: value(105) } as const;
    const r = reader([100, 100, 106]);
    expect(indicatorDecision([rule("buy", [up]), rule("close", [up]), rule("buy", [up])], r, 2)).toEqual({ fired: [0, 1, 2], actions: ["close", "buy"], conflict: false, warming: false });
    expect(indicatorDecision([rule("buy", [up]), rule("sell", [up]), rule("close", [up])], r, 2)).toEqual({ fired: [0, 1, 2], actions: ["close"], conflict: true, warming: false });
  });

  it("reads a trend line turning", () => {
    const closes = [...Array.from({ length: 40 }, (_, i) => 200 - i * 2), ...Array.from({ length: 40 }, (_, i) => 120 + i * 3)];
    const r = reader(closes);
    const st = { kind: "supertrend", length: 10, factor: 3 } as const;
    const turns = closes.map((_, i) => r.condition({ op: "turnsUp", trend: st }, i)).filter((x) => x === true).length;
    expect(turns).toBe(1);
    expect(r.condition({ op: "isUp", trend: st }, 79)).toBe(true);
    expect(r.condition({ op: "isDown", trend: st }, 39)).toBe(true);
  });
});

describe("indicator bot backtest", () => {
  const FEES = { takerRate: 0.00045, builderRate: 0.0002 };
  // Up through 105, down through 95, up again.
  const closes = [100, 101, 102, 106, 108, 110, 104, 96, 94, 92, 100, 107, 109];
  const rules = [rule("buy", [{ op: "crossesAbove", left: price, right: value(105) }]), rule("close", [{ op: "crossesBelow", left: price, right: value(95) }])];
  const run = (config: IndicatorBotConfig, from = T0) => backtestIndicatorBot({ config, candles: candles(closes), from, intervalMs: H, szDecimals: 4, marketMaxLeverage: 25, fees: FEES, equityUsd: 1000 });

  it("trades at the next open what the rules decided at a close", () => {
    const r = run(tradeBot({ rules }));
    expect(r.signals).toBe(3);
    expect(r.signalList.map((s) => [s.t, s.actions])).toEqual([
      [T0 + 4 * H, ["buy"]],
      [T0 + 9 * H, ["close"]],
      [T0 + 12 * H, ["buy"]],
    ]);
    // Bought at 106's close → filled at the next open (106) plus slippage; closed at the open after 94 (94).
    expect(r.fillList.map((f) => [f.t, f.side])).toEqual([
      [T0 + 4 * H, "buy"],
      [T0 + 9 * H, "sell"],
      [T0 + 12 * H, "buy"],
    ]);
    expect(r.fillList[0]!.price).toBeCloseTo(106 * 1.0003, 6);
    expect(r.signalList[0]!.outcome).toMatch(/^Buying 0\.9433 BTC/);
    expect(r.roundTrips).toBe(1);
    expect(r.wins).toBe(0);
    expect(r.realizedUsd).toBeLessThan(-9);
    expect(r.endPosition.size).toBeCloseTo(0.9345, 4);
    expect(r.pnlUsd).toBeCloseTo(r.realizedUsd - r.feesUsd + r.fundingUsd + r.unrealizedUsd, 6);
    expect(r.candles).toBe(13);
    expect(r.end).toBe("end");
  });

  it("warms up on candles before the test and fires only inside it", () => {
    const r = run(tradeBot({ rules }), T0 + 6 * H);
    expect(r.candles).toBe(7);
    expect(r.signalList.map((s) => s.actions)).toEqual([["close"], ["buy"]]);
    // Nothing to close yet: the bot holds nothing.
    expect(r.signalList[0]!.outcome).toBe("Nothing to close: the bot has no position.");
    expect(r.fills).toBe(1);
  });

  it("only lists where an alert bot would have told the user", () => {
    const r = run(alertBot({ rules }));
    expect(r.signals).toBe(3);
    expect(r.signalList.every((s) => s.outcome === undefined)).toBe(true);
    expect(r.fills).toBe(0);
    expect(r.pnlUsd).toBe(0);
  });

  it("caps the position like a signal bot", () => {
    const again = [rule("buy", [{ op: "crossesAbove", left: price, right: value(105) }])];
    // The first close a cross can be read (the second candle) never fires.
    const zigzag = [100, 100, 106, 104, 106, 104, 106, 104, 106];
    const r = backtestIndicatorBot({ config: tradeBot({ rules: again, maxPositionUsd: 200 }), candles: candles(zigzag), from: T0, intervalMs: H, szDecimals: 4, marketMaxLeverage: 25, fees: FEES, equityUsd: 1000 });
    expect(r.signals).toBe(4);
    expect(r.fills).toBe(2);
    expect(r.signalList[2]!.outcome).toMatch(/below Hyperliquid's \$10 minimum/);
    expect(r.signalList[3]!.outcome).toBe("After the test's last candle.");
    expect(r.maxPositionUsd).toBeLessThanOrEqual(200 * 1.001);
  });
});
