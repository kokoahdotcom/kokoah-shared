import { describe, expect, it } from "vitest";
import { backtestBot, backtestInterval, gridWorstPositionUsd, parseBotConfig, type BacktestCandle, type BacktestInput, type DcaBotConfig, type GridBotConfig } from "../src/bots/index.js";

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 1);
const FEES = { makerRate: 0.00015, takerRate: 0.00045, builderRate: 0.0002 };

/** Hourly candles through the given closes (each opens at the previous close, wicks 0.1% beyond). */
function candles(closes: number[], open = closes[0]!): BacktestCandle[] {
  let prev = open;
  return closes.map((c, i) => {
    const k = { t: T0 + i * H, o: prev, h: Math.max(prev, c) * 1.001, l: Math.min(prev, c) * 0.999, c };
    prev = c;
    return k;
  });
}

const grid = (over: Partial<GridBotConfig> = {}) =>
  parseBotConfig({ kind: "grid", coin: "ETH", lower: 2000, upper: 3000, levels: 11, spacing: "arithmetic", orderSizeUsd: 100, maxLeverage: 5, ...over }) as GridBotConfig;
const dca = (over: Partial<DcaBotConfig> = {}) =>
  parseBotConfig({ kind: "dca", coin: "ETH", side: "buy", orderSizeUsd: 50, intervalMinutes: 60, maxLeverage: 3, ...over }) as DcaBotConfig;

const run = (config: GridBotConfig | DcaBotConfig, k: BacktestCandle[], over: Partial<BacktestInput> = {}) =>
  backtestBot({ config, candles: k, intervalMs: H, szDecimals: 4, marketMaxLeverage: 25, fees: FEES, equityUsd: 5000, ...over });

describe("bot backtest", () => {
  it("runs a grid through back-and-forth prices: grids completed, profit after fees", () => {
    const wave = Array.from({ length: 48 }, (_, i) => 2500 + 220 * Math.sin((i / 6) * Math.PI));
    const r = run(grid(), candles(wave, 2500));
    expect(r.end).toBe("end");
    expect(r.completedGrids).toBeGreaterThan(4);
    expect(r.fills).toBe(r.buys + r.sells);
    expect(r.feesUsd).toBeGreaterThan(0);
    expect(r.pnlUsd).toBeCloseTo(r.realizedUsd - r.feesUsd + r.fundingUsd + r.unrealizedUsd, 6);
    expect(r.pnlUsd).toBeGreaterThan(0);
    expect(r.inRangePct).toBe(100);
    expect(r.lowPrice).toBeLessThan(2300);
    expect(r.highPrice).toBeGreaterThan(2700);
    expect(r.curve.length).toBe(48);
    // Resting fills are at grid lines with the maker fee.
    const lines = new Set([2000, 2100, 2200, 2300, 2400, 2500, 2600, 2700, 2800, 2900, 3000]);
    expect(r.fillList.filter((f) => f.maker).every((f) => lines.has(f.price))).toBe(true);
  });

  it("fills a resting order only when the price trades through it", () => {
    // Lines at 2400 and 2600 around a start at 2500; the low touches 2400 exactly, never below.
    const k: BacktestCandle[] = [
      { t: T0, o: 2500, h: 2510, l: 2400, c: 2450 },
      { t: T0 + H, o: 2450, h: 2460, l: 2400, c: 2455 },
    ];
    expect(run(grid(), k).fills).toBe(0);
    k[1]!.l = 2399;
    const r = run(grid(), k);
    expect(r.fills).toBe(1);
    expect(r.fillList[0]).toMatchObject({ side: "buy", price: 2400, maker: true });
  });

  it("stops a grid at its stop-loss and closes the position", () => {
    const r = run(grid({ stopLossPrice: 1900 }), candles([2500, 2300, 2100, 1950, 1850, 1800], 2500));
    expect(r.end).toBe("stopLoss");
    expect(r.endedAt).not.toBeNull();
    expect(r.endPosition.size).toBe(0);
    expect(r.pnlUsd).toBeLessThan(0);
    expect(r.curve.at(-1)!.t).toBe(r.endedAt);
  });

  it("refuses a grid the account value can't carry under the leverage cap", () => {
    const c = grid({ maxLeverage: 1 });
    expect(gridWorstPositionUsd(c, 2500, 4)).toBeGreaterThan(500);
    const r = run(c, candles([2500, 2510]), { equityUsd: 300 });
    expect(r).toMatchObject({ end: "leverage", fills: 0, pnlUsd: 0 });
  });

  it("places DCA orders on time even with longer candles, and pays funding on the position", () => {
    const k = candles(Array.from({ length: 24 }, () => 2500), 2500);
    const r = run(dca({ intervalMinutes: 15 }), k, { funding: k.map((x) => ({ t: x.t, rate: 0.0001 })) });
    // 24 hours, every 15 minutes (the first at the start).
    expect(r.ordersPlaced).toBe(96);
    expect(r.buys).toBe(96);
    // A long pays positive funding.
    expect(r.fundingUsd).toBeLessThan(0);
  });

  it("closes DCA cycles at the take-profit", () => {
    const up = [2500, 2450, 2400, 2450, 2500, 2550, 2600, 2650, 2700];
    const r = run(dca({ takeProfitPct: 3, safety: { count: 2, stepPct: 2, sizeMultiplier: 2, maxTotalUsd: 500 } }), candles(up, 2500));
    expect(r.cyclesClosed).toBeGreaterThanOrEqual(1);
    expect(r.realizedUsd).toBeGreaterThan(0);
  });

  it("liquidates an account that can't carry the position", () => {
    const crash = [2500, 2500, 2500, 2500, 1500, 900, 600];
    const r = run(dca({ orderSizeUsd: 1000, maxLeverage: 50 }), candles(crash, 2500), { equityUsd: 120, marketMaxLeverage: 50 });
    expect(r.end).toBe("liquidated");
    expect(r.endPosition.size).toBe(0);
    expect(r.pnlUsd).toBeLessThanOrEqual(-100);
  });

  it("finishes a DCA after its orders and picks candle sizes for a period", () => {
    const r = run(dca({ maxOrders: 3 }), candles(Array.from({ length: 10 }, () => 2500), 2500));
    expect(r).toMatchObject({ end: "finished", ordersPlaced: 3 });
    expect(backtestInterval(7).interval).toBe("5m");
    expect(backtestInterval(30).interval).toBe("15m");
    expect(backtestInterval(90).interval).toBe("1h");
    expect(() => run(dca(), [])).toThrow(RangeError);
  });
});
