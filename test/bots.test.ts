import { describe, expect, it } from "vitest";
import { parseCloid } from "../src/actions/index.js";
import {
  applyFill,
  applyFills,
  botCancelIntent,
  botCloid,
  BotConfigError,
  botLimitNeeds,
  copyStep,
  dcaSafetyLadder,
  dcaStep,
  dcaTakeProfitPrice,
  emptyBook,
  gridEstimate,
  gridLevels,
  gridMinStepPct,
  gridOrderSize,
  gridPrices,
  gridStep,
  gridStopCondition,
  HL_BASE_FEES,
  ledgerPnl,
  parseBotConfig,
  planSignal,
  plannedOrderIntent,
  SignalAlertSchema,
  signalAlertTemplate,
  signalCoinMatches,
  type BotOrderView,
  type CopyBotConfig,
  type DcaBotConfig,
  type GridBotConfig,
  type GridState,
  type SignalBotConfig,
} from "../src/bots/index.js";
import { OrderIntentSchema } from "../src/intents/index.js";
import * as v from "valibot";

const BOT = "3f2c7a9e-0000-4000-8000-000000000001";
const cloid = (seq: number) => botCloid(BOT, seq);

const grid = (over: Partial<GridBotConfig> = {}): GridBotConfig =>
  parseBotConfig({ kind: "grid", coin: "ETH", lower: 2000, upper: 3000, levels: 11, spacing: "arithmetic", orderSizeUsd: 50, maxLeverage: 3, ...over }) as GridBotConfig;

describe("bot configs", () => {
  it("validates grids and explains problems", () => {
    expect(grid().mode).toBe("neutral");
    expect(grid().closeOnStop).toBe(true);
    expect(() => grid({ upper: 1900 })).toThrow(/upper price must be above/);
    expect(() => grid({ levels: 101 })).toThrow(BotConfigError);
    expect(() => grid({ lower: 2000, upper: 2001, levels: 50 })).toThrow(/at least 0.1% wide/);
    expect(() => grid({ stopLossPrice: 2500 })).toThrow(/outside the range/);
    expect(() => grid({ stopLossPrice: 1900, takeProfitPrice: 1800 })).toThrow(/opposite sides/);
    expect(grid({ stopLossPrice: 1900, takeProfitPrice: 3100 }).stopLossPrice).toBe(1900);
    expect(() => grid({ orderSizeUsd: 5 })).toThrow(/at least \$10/);
  });

  it("validates copy, dca and signal bots", () => {
    const copy = parseBotConfig({
      kind: "copy",
      leader: "0xABCDEF0000000000000000000000000000000001",
      sizing: { mode: "ratio", ratio: 0.1 },
      maxOrderUsd: 100,
      maxTotalUsd: 500,
      maxLeverage: 3,
    }) as CopyBotConfig;
    expect(copy.leader).toBe("0xabcdef0000000000000000000000000000000001");
    expect(() => parseBotConfig({ ...copy, maxTotalUsd: 50 })).toThrow(/total cap must be at least/);
    expect(() => parseBotConfig({ ...copy, allowCoins: ["BTC"], denyCoins: ["BTC"] })).toThrow(/both allowed and denied/);
    expect(() => parseBotConfig({ ...copy, sizing: { mode: "ratio", ratio: 0 } })).toThrow();
    const dca = parseBotConfig({ kind: "dca", coin: "BTC", side: "buy", orderSizeUsd: 20, intervalMinutes: 60, maxLeverage: 2 });
    expect(dca.kind).toBe("dca");
    expect(() => parseBotConfig({ ...dca, intervalMinutes: 1 })).toThrow();
    expect(() => parseBotConfig({ kind: "signal", coin: "BTC", orderSizeUsd: 200, maxOrderUsd: 100, maxPositionUsd: 500, maxLeverage: 2 })).toThrow(/default order size/);
    expect(() => parseBotConfig({ kind: "nope" })).toThrow(BotConfigError);
  });
});

describe("grid", () => {
  it("spaces arithmetic and geometric lines", () => {
    expect(gridPrices({ lower: 100, upper: 200, levels: 5, spacing: "arithmetic" })).toEqual([100, 125, 150, 175, 200]);
    const geo = gridPrices({ lower: 100, upper: 400, levels: 3, spacing: "geometric" });
    expect(geo[1]).toBeCloseTo(200, 9);
    expect(gridMinStepPct({ lower: 100, upper: 400, levels: 3, spacing: "geometric" })).toBeCloseTo(100, 9);
    expect(gridLevels({ lower: 2000, upper: 3000, levels: 3, spacing: "arithmetic" }, 4)).toEqual(["2000", "2500", "3000"]);
    expect(() => gridLevels({ lower: 1, upper: 1.001, levels: 20, spacing: "arithmetic" }, 5)).toThrow(/finer than the market's price tick/);
  });

  it("estimates the profit per grid after fees", () => {
    const e = gridEstimate(grid(), { makerRate: HL_BASE_FEES.makerRate, builderRate: 0.00025 });
    expect(e.grids).toBe(10);
    expect(e.sizeCoins).toBeCloseTo(0.025, 9);
    // Bottom grid: 0.025 × 100 − 0.025 × (2000 + 2100) × 0.0004 = 2.5 − 0.041 = 2.459.
    expect(e.profitPerGridUsd.max).toBeCloseTo(2.459, 6);
    expect(e.profitPerGridUsd.min).toBeCloseTo(2.5 - 0.025 * 5900 * 0.0004, 6);
    expect(e.profitPerGridPct.max).toBeCloseTo((2.459 / 50) * 100, 6);
    expect(e.unprofitable).toBe(false);
    const thin = gridEstimate({ lower: 100, upper: 100.5, levels: 11, spacing: "geometric", orderSizeUsd: 50 }, { makerRate: 0.00015, builderRate: 0.001 });
    expect(thin.unprofitable).toBe(true);
    expect(thin.profitPerGridPct.min).toBeCloseTo(thin.profitPerGridPct.max, 2);
  });

  it("stops at the stop-loss, the take-profit and out of range", () => {
    const c = grid({ stopLossPrice: 1900, takeProfitPrice: 3200 });
    expect(gridStopCondition(c, 1950)).toBeNull();
    expect(gridStopCondition(c, 1900)).toMatch(/Stop-loss/);
    expect(gridStopCondition(c, 3200)).toMatch(/Take-profit/);
    expect(gridStopCondition({ ...c, stopOutOfRange: true }, 3050)).toMatch(/left the range/);
    // A short grid's stop-loss above the range.
    expect(gridStopCondition(grid({ stopLossPrice: 3100 }), 3100)).toMatch(/Stop-loss/);
  });

  it("places buys below and sells above the start, leaves the nearest line empty, and answers fills one line away", () => {
    const c = grid();
    const first = gridStep({ config: c, state: null, mark: 2510, szDecimals: 4, orders: {}, cloid, maxNewOrders: 100 });
    expect(first.stop).toBeUndefined();
    expect(first.state.size).toBe(gridOrderSize(c, 4));
    expect(first.state.size).toBe("0.025");
    expect(first.place).toHaveLength(10);
    const byPrice = Object.fromEntries(first.place.map((o) => [o.price, o.side]));
    expect(byPrice["2500"]).toBeUndefined();
    expect(byPrice["2400"]).toBe("buy");
    expect(byPrice["2600"]).toBe("sell");
    expect(first.place.every((o) => o.type === "limit" && !o.reduceOnly && o.size === "0.025")).toBe(true);
    // Nearest first (2600 is 90 away, 2400 is 110 away).
    expect(first.place[0]!.price).toBe("2600");

    // The buy at 2400 (line 5, index 4) fills: a sell goes to 2500.
    const buy = first.place.find((o) => o.price === "2400")!;
    const orders: Record<string, BotOrderView> = Object.fromEntries(first.place.map((o) => [o.cloid, { status: "open", size: 0.025, filledSize: 0 }]));
    orders[buy.cloid] = { status: "filled", size: 0.025, filledSize: 0.025 };
    const second = gridStep({ config: c, state: first.state, mark: 2390, szDecimals: 4, orders, cloid, maxNewOrders: 100 });
    expect(second.place).toHaveLength(1);
    expect(second.place[0]).toMatchObject({ side: "sell", price: "2500", level: 5 });
    expect(second.state.completedGrids).toBe(0);

    // That sell fills: a buy goes back to 2400 and one grid is complete.
    orders[second.place[0]!.cloid] = { status: "filled", size: 0.025, filledSize: 0.025 };
    const third = gridStep({ config: c, state: second.state, mark: 2510, szDecimals: 4, orders, cloid, maxNewOrders: 100 });
    expect(third.place).toHaveLength(1);
    expect(third.place[0]).toMatchObject({ side: "buy", price: "2400" });
    expect(third.state.completedGrids).toBe(1);
  });

  it("waits outside the range, paces orders, defers far lines and re-places canceled ones", () => {
    const c = grid({ lower: 1000, upper: 3000, levels: 21 });
    const waiting = gridStep({ config: c, state: null, mark: 3500, szDecimals: 4, orders: {}, cloid, maxNewOrders: 5 });
    expect(waiting.place).toHaveLength(0);
    expect(waiting.state.phase).toBe("waiting");
    const start = gridStep({ config: c, state: waiting.state, mark: 2900, szDecimals: 4, orders: {}, cloid, maxNewOrders: 5 });
    expect(start.place).toHaveLength(5);
    expect(start.notes.join(" ")).toMatch(/Grid set up/);
    let state = start.state;
    const orders: Record<string, BotOrderView> = {};
    for (const o of start.place) orders[o.cloid] = { status: "open", size: 0.05, filledSize: 0 };
    for (let i = 0; i < 10; i++) {
      const s = gridStep({ config: c, state, mark: 2900, szDecimals: 4, orders, cloid, maxNewOrders: 5 });
      for (const o of s.place) orders[o.cloid] = { status: "open", size: 0.05, filledSize: 0 };
      state = s.state;
    }
    const placedPrices = Object.values(state.slots).filter((s) => s.cloid).length;
    // Lines more than 45% below 2900 (1000 to 1500) wait; 1600 to 2800 and the sell at 3000 rest.
    expect(Object.entries(state.slots).find(([k]) => state.prices[Number(k)] === "1500")![1].cloid).toBeUndefined();
    expect(Object.entries(state.slots).find(([k]) => state.prices[Number(k)] === "1600")![1].cloid).toBeDefined();
    expect(placedPrices).toBe(14);
    // A canceled order is placed again with a new cloid.
    const [key, slot] = Object.entries(state.slots).find(([, s]) => s.cloid)!;
    orders[slot.cloid!] = { status: "canceled", size: 0.05, filledSize: 0 };
    const again = gridStep({ config: c, state, mark: 2900, szDecimals: 4, orders, cloid, maxNewOrders: 5 });
    expect(again.place.map((o) => o.level)).toContain(Number(key));
    expect(again.state.slots[key]!.failures).toBe(1);
  });

  it("builds a long start position in market chunks before placing the grid", () => {
    const c = grid({ mode: "long" });
    const s1 = gridStep({ config: c, state: null, mark: 2510, szDecimals: 4, orders: {}, cloid, maxNewOrders: 3 });
    expect(s1.state.phase).toBe("building");
    expect(s1.state.buildLeft).toBe(5);
    expect(s1.place.map((o) => [o.type, o.side])).toEqual([
      ["market", "buy"],
      ["market", "buy"],
      ["market", "buy"],
    ]);
    const orders: Record<string, BotOrderView> = Object.fromEntries(s1.place.map((o) => [o.cloid, { status: "filled", size: 0.025, filledSize: 0.025 }]));
    const s2 = gridStep({ config: c, state: s1.state, mark: 2510, szDecimals: 4, orders, cloid, maxNewOrders: 3 });
    expect(s2.state.buildLeft).toBe(2);
    expect(s2.place).toHaveLength(2);
    for (const o of s2.place) orders[o.cloid] = { status: "filled", size: 0.025, filledSize: 0.025 };
    const s3 = gridStep({ config: c, state: s2.state, mark: 2510, szDecimals: 4, orders, cloid, maxNewOrders: 20 });
    expect(s3.state.phase).toBe("running");
    expect(s3.place.every((o) => o.type === "limit")).toBe(true);
    expect(s3.place).toHaveLength(10);
  });

  it("refuses orders under the exchange minimum and asks to stop on a stop condition", () => {
    const tooSmall = gridStep({ config: grid({ orderSizeUsd: 10 }), state: null, mark: 2500, szDecimals: 1, orders: {}, cloid, maxNewOrders: 5 });
    // 10 / 2000 = 0.005 rounds up to 0.1 at 1 decimal: fine. At 0 decimals a 1-coin order is fine too; the check is on value.
    expect(tooSmall.stop).toBeUndefined();
    const stop = gridStep({ config: grid({ stopLossPrice: 1900 }), state: null, mark: 1890, szDecimals: 4, orders: {}, cloid, maxNewOrders: 5 });
    expect(stop.stop).toEqual({ reason: expect.stringMatching(/Stop-loss/), closePosition: true });
  });
});

describe("dca", () => {
  const dca = (over: Partial<DcaBotConfig> = {}) =>
    parseBotConfig({ kind: "dca", coin: "BTC", side: "buy", orderSizeUsd: 20, intervalMinutes: 60, maxLeverage: 2, ...over }) as DcaBotConfig;
  const NOW = 1_790_000_000_000;

  it("builds a capped safety ladder", () => {
    const ladder = dcaSafetyLadder({ count: 5, stepPct: 2, sizeMultiplier: 2, maxTotalUsd: 300 }, 100, "buy", 20);
    expect(ladder.map((s) => [s.index, s.price, s.usd])).toEqual([
      [1, 98, 40],
      [2, 96, 80],
      [3, 94, 160],
    ]);
    const up = dcaSafetyLadder({ count: 2, stepPct: 5, sizeMultiplier: 1, maxTotalUsd: 1000 }, 100, "sell", 20).map((s) => s.price);
    expect(up[0]).toBeCloseTo(105, 9);
    expect(up[1]).toBeCloseTo(110, 9);
    expect(dcaTakeProfitPrice({ side: "buy", takeProfitPct: 2 }, 100)).toBeCloseTo(102, 9);
    expect(dcaTakeProfitPrice({ side: "sell", takeProfitPct: 2 }, 100)).toBeCloseTo(98, 9);
    expect(dcaTakeProfitPrice({ side: "buy" }, 100)).toBeUndefined();
  });

  it("orders on schedule without catching up, and places safety orders after the first order", () => {
    const c = dca({ safety: { count: 2, stepPct: 5, sizeMultiplier: 1.5, maxTotalUsd: 100 } });
    const s1 = dcaStep({ config: c, state: null, now: NOW, mark: 100_000, szDecimals: 5, position: { size: 0, entryPrice: 0 }, orders: {}, cloid, maxNewOrders: 10 });
    expect(s1.place.map((o) => [o.label, o.type, o.side, o.size, o.price])).toEqual([
      ["Order 1", "market", "buy", "0.0002", undefined],
      ["Safety order 1", "limit", "buy", "0.00031", "95000"],
      ["Safety order 2", "limit", "buy", "0.0005", "90000"],
    ]);
    expect(s1.state.nextAt).toBe(NOW + 3_600_000);
    const orders: Record<string, BotOrderView> = { [s1.place[0]!.cloid]: { status: "filled", size: 0.0002, filledSize: 0.0002 } };
    // Not due yet.
    const s2 = dcaStep({ config: c, state: s1.state, now: NOW + 1000, mark: 100_000, szDecimals: 5, position: { size: 0.0002, entryPrice: 100_000 }, orders, cloid, maxNewOrders: 10 });
    expect(s2.place).toHaveLength(0);
    // Six hours late: one order, and the next an interval later (no burst).
    const late = NOW + 6 * 3_600_000;
    const s3 = dcaStep({ config: c, state: s2.state, now: late, mark: 100_000, szDecimals: 5, position: { size: 0.0002, entryPrice: 100_000 }, orders, cloid, maxNewOrders: 10 });
    expect(s3.place).toHaveLength(1);
    expect(s3.state.nextAt).toBe(late + 3_600_000);
  });

  it("closes the cycle at the take-profit, cancels safety orders and starts over", () => {
    const c = dca({ takeProfitPct: 2, safety: { count: 1, stepPct: 5, sizeMultiplier: 1, maxTotalUsd: 100 } });
    const s1 = dcaStep({ config: c, state: null, now: NOW, mark: 100_000, szDecimals: 5, position: { size: 0, entryPrice: 0 }, orders: {}, cloid, maxNewOrders: 10 });
    const safety = s1.place[1]!.cloid;
    const orders: Record<string, BotOrderView> = {
      [s1.place[0]!.cloid]: { status: "filled", size: 0.0002, filledSize: 0.0002 },
      [safety]: { status: "open", size: 0.0002, filledSize: 0 },
    };
    const tp = dcaStep({ config: c, state: s1.state, now: NOW + 60_000, mark: 102_100, szDecimals: 5, position: { size: 0.0002, entryPrice: 100_000 }, orders, cloid, maxNewOrders: 10 });
    expect(tp.place).toEqual([expect.objectContaining({ label: "Take-profit close", side: "sell", reduceOnly: true, size: "0.0002", type: "market" })]);
    expect(tp.cancel).toEqual([safety]);
    orders[tp.place[0]!.cloid] = { status: "filled", size: 0.0002, filledSize: 0.0002 };
    orders[safety] = { status: "canceled", size: 0.0002, filledSize: 0 };
    const next = dcaStep({ config: c, state: tp.state, now: NOW + 120_000, mark: 102_100, szDecimals: 5, position: { size: 0, entryPrice: 0 }, orders, cloid, maxNewOrders: 10 });
    expect(next.state.cycle).toBe(2);
    expect(next.state.anchor).toBeUndefined();
    expect(next.notes.join(" ")).toMatch(/Cycle 1 closed/);
  });

  it("finishes after the last order", () => {
    const c = dca({ maxOrders: 1 });
    const s1 = dcaStep({ config: c, state: null, now: NOW, mark: 100_000, szDecimals: 5, position: { size: 0, entryPrice: 0 }, orders: {}, cloid, maxNewOrders: 10 });
    expect(s1.place).toHaveLength(1);
    const waiting = dcaStep({ config: c, state: s1.state, now: NOW + 1000, mark: 100_000, szDecimals: 5, position: { size: 0, entryPrice: 0 }, orders: { [s1.place[0]!.cloid]: { status: "pending", size: 0.0002, filledSize: 0 } }, cloid, maxNewOrders: 10 });
    expect(waiting.stop).toBeUndefined();
    const done = dcaStep({ config: c, state: s1.state, now: NOW + 1000, mark: 100_000, szDecimals: 5, position: { size: 0.0002, entryPrice: 100_000 }, orders: { [s1.place[0]!.cloid]: { status: "filled", size: 0.0002, filledSize: 0.0002 } }, cloid, maxNewOrders: 10 });
    expect(done.stop).toMatchObject({ finished: true, closePosition: false });
  });

  it("skips orders above the leverage room", () => {
    const c = dca({ safety: { count: 2, stepPct: 5, sizeMultiplier: 1, maxTotalUsd: 100 } });
    const skipped = dcaStep({ config: c, state: null, now: NOW, mark: 100_000, szDecimals: 5, position: { size: 0, entryPrice: 0 }, orders: {}, cloid, maxNewOrders: 10, entryRoomUsd: 5 });
    expect(skipped.place).toHaveLength(0);
    expect(skipped.notes[0]).toMatch(/above 2× leverage/);
    expect(skipped.state.ordersPlaced).toBe(0);
    expect(skipped.state.nextAt).toBe(NOW + 3_600_000);
    const partial = dcaStep({ config: c, state: null, now: NOW, mark: 100_000, szDecimals: 5, position: { size: 0, entryPrice: 0 }, orders: {}, cloid, maxNewOrders: 10, entryRoomUsd: 45 });
    expect(partial.place.map((o) => o.label)).toEqual(["Order 1", "Safety order 1"]);
    expect(partial.state.safetyPlanned).toBe(false);
  });

  it("raises tiny orders to the exchange minimum", () => {
    const s = dcaStep({ config: dca({ orderSizeUsd: 10 }), state: null, now: NOW, mark: 99_999, szDecimals: 5, position: { size: 0, entryPrice: 0 }, orders: {}, cloid, maxNewOrders: 1 });
    expect(Number(s.place[0]!.size) * 99_999).toBeGreaterThanOrEqual(10);
  });
});

describe("copy", () => {
  const config = (over: Partial<CopyBotConfig> = {}) =>
    parseBotConfig({
      kind: "copy",
      leader: "0x00000000000000000000000000000000000000aa",
      sizing: { mode: "ratio", ratio: 0.1 },
      maxOrderUsd: 1000,
      maxTotalUsd: 2000,
      maxLeverage: 5,
      ...over,
    }) as CopyBotConfig;
  const NOW = Date.UTC(2026, 8, 25, 12);
  const base = {
    now: NOW,
    marks: { BTC: 100_000, ETH: 2500, "xyz:SP500": 6000 },
    szDecimals: { BTC: 5, ETH: 4, "xyz:SP500": 2 },
    account: { equityUsd: 1000, totalNotionalUsd: 0, positions: {} },
    claimed: new Set<string>(),
    pnl: { realizedUsd: 0, unrealizedUsd: 0 },
    cloid,
  };

  it("takes the positions at start as the baseline and copies later changes by ratio", () => {
    const start = copyStep({ ...base, config: config(), state: null, positions: {}, leader: { seq: 3, positions: { BTC: 1 }, polledAt: NOW } });
    expect(start.place).toHaveLength(0);
    expect(start.notes[0]).toMatch(/not copied/);
    // The leader adds 0.05 BTC and opens 2 ETH short.
    const s = copyStep({ ...base, config: config(), state: start.state, positions: {}, leader: { seq: 4, positions: { BTC: 1.05, ETH: -2 }, polledAt: NOW } });
    expect(s.place.map((o) => [o.coin, o.side, o.size, o.reduceOnly, o.label])).toEqual([
      ["BTC", "buy", "0.005", false, "Copy add BTC"],
      ["ETH", "sell", "0.2", false, "Copy open ETH"],
    ]);
    expect(s.state.leaderSeq).toBe(4);
    // The same poll again does nothing.
    expect(copyStep({ ...base, config: config(), state: s.state, positions: {}, leader: { seq: 4, positions: { BTC: 1.05, ETH: -2 }, polledAt: NOW } }).place).toHaveLength(0);
  });

  it("reduces proportionally, closes and flips", () => {
    const state = { leaderSeq: 1, leader: { BTC: 1, ETH: -2 }, peakValue: 2000, day: { start: Date.UTC(2026, 8, 25), pnlAtStart: 0 }, seq: 0 };
    const positions = { BTC: 0.01, ETH: -0.3 };
    const account = { equityUsd: 1000, totalNotionalUsd: 1750, positions: { BTC: 0.01, ETH: -0.3 } };
    const s = copyStep({ ...base, account, config: config(), state, positions, leader: { seq: 2, positions: { BTC: 0.25, ETH: 1 }, polledAt: NOW } });
    expect(s.place.map((o) => [o.coin, o.side, o.size, o.reduceOnly])).toEqual([
      // ETH flipped: close 0.3, then open 1 × 0.1 = 0.1 long.
      ["ETH", "buy", "0.3", true],
      ["ETH", "buy", "0.1", false],
      // BTC reduced by 75%.
      ["BTC", "sell", "0.0075", true],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  });

  it("applies the caps, the allow and deny lists, HIP-3 and claimed markets", () => {
    const state = { leaderSeq: 1, leader: {}, peakValue: 2000, day: { start: Date.UTC(2026, 8, 25), pnlAtStart: 0 }, seq: 0 };
    const leader = { seq: 2, positions: { BTC: 1, ETH: 10, SOL: 5, "xyz:SP500": 1 }, polledAt: NOW };
    const s = copyStep({
      ...base,
      marks: { ...base.marks, SOL: 150 },
      szDecimals: { ...base.szDecimals, SOL: 2 },
      config: config({ denyCoins: ["SOL"], sizing: { mode: "fixed", amountUsd: 1500 } }),
      state,
      positions: {},
      leader,
    });
    // Fixed $1,500 capped at $1,000 per order; the total cap leaves $1,000 for the second coin.
    expect(s.place.map((o) => [o.coin, o.size])).toEqual([
      ["BTC", "0.01"],
      ["ETH", "0.4"],
    ]);
    expect(s.notes.join(" ")).toMatch(/Skipped SOL: in your denied markets/);
    expect(s.notes.join(" ")).toMatch(/Skipped xyz:SP500: HIP-3/);
    const levered = copyStep({
      ...base,
      account: { equityUsd: 100, totalNotionalUsd: 495, positions: {} },
      config: config(),
      state,
      positions: {},
      leader: { seq: 2, positions: { BTC: 1 }, polledAt: NOW },
    });
    expect(levered.place).toHaveLength(0);
    expect(levered.notes[0]).toMatch(/leverage cap/);
    const claimed = copyStep({ ...base, claimed: new Set(["BTC"]), config: config(), state, positions: {}, leader: { seq: 2, positions: { BTC: 1 }, polledAt: NOW } });
    expect(claimed.notes[0]).toMatch(/another of your bots/);
  });

  it("stops at the drawdown and daily loss limits", () => {
    const state = { leaderSeq: 1, leader: {}, peakValue: 2200, day: { start: Date.UTC(2026, 8, 25), pnlAtStart: 200 }, seq: 0 };
    const dd = copyStep({ ...base, pnl: { realizedUsd: -100, unrealizedUsd: 0 }, config: config({ maxDrawdownPct: 10 }), state, positions: {}, leader: null });
    // Value 1,900 vs peak 2,200: 13.6% down.
    expect(dd.stop).toMatchObject({ closePosition: true, reason: expect.stringMatching(/Drawdown limit/) });
    const daily = copyStep({ ...base, pnl: { realizedUsd: 100, unrealizedUsd: -60 }, config: config({ dailyLossLimitUsd: 150, closeOnStop: false }), state, positions: {}, leader: null });
    expect(daily.stop).toMatchObject({ closePosition: false, reason: expect.stringMatching(/Daily loss limit/) });
    // A new UTC day resets the daily count.
    const tomorrow = copyStep({ ...base, now: NOW + 86_400_000, pnl: { realizedUsd: 100, unrealizedUsd: -60 }, config: config({ dailyLossLimitUsd: 150 }), state, positions: {}, leader: null });
    expect(tomorrow.stop).toBeUndefined();
  });
});

describe("signal", () => {
  const config = (over: Partial<SignalBotConfig> = {}) =>
    parseBotConfig({ kind: "signal", coin: "BTC", orderSizeUsd: 100, maxOrderUsd: 500, maxPositionUsd: 1000, maxLeverage: 3, ...over }) as SignalBotConfig;
  const alert = (x: Record<string, unknown>) => v.parse(SignalAlertSchema, { id: "a1", ...x });
  const base = { mark: 100_000, szDecimals: 5, position: 0, accountPosition: 0, account: { equityUsd: 10_000, totalNotionalUsd: 0 }, cloid: cloid(0) };

  it("parses TradingView alerts and matches tickers", () => {
    const a = alert({ action: "BUY", sizeUsd: "150", extra: "ignored" });
    expect(a).toMatchObject({ action: "buy", sizeUsd: 150, orderType: "market", reduceOnly: false });
    expect(v.safeParse(SignalAlertSchema, { id: "", action: "buy" }).success).toBe(false);
    expect(v.safeParse(SignalAlertSchema, { id: "x", action: "hold" }).success).toBe(false);
    for (const t of ["BTC", "BTCUSDT", "BTCUSDT.P", "BINANCE:BTCUSDT.P", "BTC-PERP", "btcusd"]) expect(signalCoinMatches("BTC", t)).toBe(true);
    expect(signalCoinMatches("BTC", "ETHUSDT")).toBe(false);
    expect(signalCoinMatches("xyz:SP500", "xyz:SP500")).toBe(true);
    expect(JSON.parse(signalAlertTemplate(config()))).toMatchObject({ action: "{{strategy.order.action}}", coin: "BTC", sizeUsd: 100 });
  });

  it("sizes orders within the caps", () => {
    const p = planSignal({ ...base, config: config(), alert: alert({ action: "buy" }) });
    expect(p).toMatchObject({ ok: true, order: { side: "buy", size: "0.001", type: "market", reduceOnly: false } });
    const capped = planSignal({ ...base, config: config(), alert: alert({ action: "sell", sizeUsd: 5000 }) });
    expect(capped).toMatchObject({ ok: true, order: { side: "sell", size: "0.005" } });
    // Position cap: long 0.009 ($900) and cap $1,000 → at most $100 more.
    const full = planSignal({ ...base, position: 0.009, accountPosition: 0.009, config: config(), alert: alert({ action: "buy", sizeUsd: 400 }) });
    expect(full).toMatchObject({ ok: true, order: { size: "0.001" } });
    const limit = planSignal({ ...base, config: config(), alert: alert({ action: "buy", orderType: "limit", price: 95_000.123 }) });
    expect(limit).toMatchObject({ ok: true, order: { type: "limit", price: "95000" } });
    expect(planSignal({ ...base, config: config(), alert: alert({ action: "buy", orderType: "limit" }) })).toMatchObject({ ok: false });
    expect(planSignal({ ...base, account: { equityUsd: 10, totalNotionalUsd: 25 }, config: config(), alert: alert({ action: "buy" }) })).toMatchObject({ ok: false, reason: expect.stringMatching(/minimum/) });
  });

  it("closes, reduces and honours one-direction bots", () => {
    expect(planSignal({ ...base, config: config(), alert: alert({ action: "close" }) })).toEqual({ ok: false, reason: expect.stringMatching(/Nothing to close/) });
    const close = planSignal({ ...base, position: -0.004, accountPosition: -0.006, config: config(), alert: alert({ action: "flat" }) });
    expect(close).toMatchObject({ ok: true, order: { side: "buy", size: "0.004", reduceOnly: true } });
    const longOnly = config({ direction: "long" });
    expect(planSignal({ ...base, config: longOnly, alert: alert({ action: "sell" }) })).toMatchObject({ ok: false, reason: expect.stringMatching(/long-only/) });
    const reduce = planSignal({ ...base, position: 0.004, accountPosition: 0.004, config: longOnly, alert: alert({ action: "sell", sizeUsd: 200 }) });
    expect(reduce).toMatchObject({ ok: true, order: { side: "sell", size: "0.002", reduceOnly: true } });
    const all = planSignal({ ...base, position: 0.004, accountPosition: 0.004, config: longOnly, alert: alert({ action: "sell", sizeUsd: 900 }) });
    expect(all).toMatchObject({ ok: true, order: { size: "0.004", reduceOnly: true, label: "Signal close" } });
    expect(planSignal({ ...base, config: config(), alert: alert({ action: "buy", coin: "ETHUSDT" }) })).toMatchObject({ ok: false, reason: expect.stringMatching(/names ETHUSDT/) });
  });
});

describe("ledger", () => {
  it("tracks average entry, realized PnL, flips and fees", () => {
    let b = emptyBook();
    b = applyFill(b, { side: "buy", price: 100, size: 1, feeUsd: 0.1 });
    b = applyFill(b, { side: "buy", price: 110, size: 1, feeUsd: 0.1 });
    expect(b).toMatchObject({ size: 2, entryPrice: 105 });
    b = applyFill(b, { side: "sell", price: 120, size: 0.5, feeUsd: 0.05 });
    expect(b).toMatchObject({ size: 1.5, entryPrice: 105, realizedUsd: 7.5 });
    b = applyFill(b, { side: "sell", price: 100, size: 2, feeUsd: 0.1 });
    expect(b.size).toBe(-0.5);
    expect(b.entryPrice).toBe(100);
    expect(b.realizedUsd).toBeCloseTo(0, 9);
    expect(b.feesUsd).toBeCloseTo(0.35, 9);
    const ledger = applyFills({}, [
      { coin: "ETH", side: "sell", price: 2000, size: 0.1, feeUsd: 0.1 },
      { coin: "BTC", side: "buy", price: 100_000, size: 0.001, feeUsd: 0.05 },
    ]);
    const pnl = ledgerPnl(ledger, { ETH: 1900, BTC: 101_000 });
    expect(pnl.unrealizedUsd).toBeCloseTo(10 + 1, 9);
    expect(pnl.totalUsd).toBeCloseTo(11 - 0.15, 9);
    expect(pnl.openValueUsd).toBeCloseTo(190 + 101, 9);
  });
});

describe("bot orders and needs", () => {
  it("derives stable bot-origin cloids and valid intents", () => {
    expect(botCloid(BOT, 7)).toBe(botCloid(BOT, 7));
    expect(botCloid(BOT, 7)).not.toBe(botCloid(BOT, 8));
    expect(parseCloid(botCloid(BOT, 7))).toMatchObject({ kokoah: true, origin: "bot" });
    const limit = plannedOrderIntent({ cloid: cloid(1), coin: "ETH", side: "buy", size: "0.025", type: "limit", price: "2400", reduceOnly: false, label: "x" }, "0x00000000000000000000000000000000000000AB");
    expect(v.safeParse(OrderIntentSchema, limit).success).toBe(true);
    expect(limit).toMatchObject({ orderType: "limit", tif: "Gtc", origin: "bot", vaultAddress: "0x00000000000000000000000000000000000000ab" });
    const market = plannedOrderIntent({ cloid: cloid(2), coin: "ETH", side: "sell", size: "0.025", type: "market", reduceOnly: true, label: "x" });
    expect(market).toMatchObject({ orderType: "market", slippageBps: 100, reduceOnly: true });
    expect(v.safeParse(OrderIntentSchema, market).success).toBe(true);
    expect(botCancelIntent("ETH", [cloid(1)])).toMatchObject({ kind: "cancel", cancels: [{ coin: "ETH", cloid: cloid(1) }] });
  });

  it("says which limits each bot needs", () => {
    const g = botLimitNeeds(grid());
    expect(g).toMatchObject({ coins: ["ETH"], maxLeverage: 3, entriesWithoutStopLoss: true, marketSlippagePct: 1 });
    // 50 / 2000 × 1.01 × 3000 × 1.01 = 76.5 → 77.
    expect(g.maxOrderNotionalUsd).toBe(77);
    const copy = botLimitNeeds(
      parseBotConfig({ kind: "copy", leader: "0x00000000000000000000000000000000000000aa", sizing: { mode: "fixed", amountUsd: 50 }, maxOrderUsd: 100, maxTotalUsd: 300, maxLeverage: 2 }),
      "0x00000000000000000000000000000000000000AB",
    );
    expect(copy).toMatchObject({ coins: "*", maxOrderNotionalUsd: 101, dailyNotionalUsd: 1212, vaultAddresses: ["0x00000000000000000000000000000000000000ab"] });
    const dca = botLimitNeeds(parseBotConfig({ kind: "dca", coin: "BTC", side: "buy", orderSizeUsd: 20, intervalMinutes: 60, maxLeverage: 2, safety: { count: 2, stepPct: 2, sizeMultiplier: 2, maxTotalUsd: 200 } }));
    expect(dca.maxOrderNotionalUsd).toBe(Math.ceil(80 * 1.01 * 1.01));
    expect(dca.dailyNotionalUsd).toBe(Math.ceil((24 * 20 + 120) * 1.01 * 1.01));
  });
});

describe("grid state shape", () => {
  it("round-trips through JSON (the runner stores it)", () => {
    const s = gridStep({ config: grid(), state: null, mark: 2510, szDecimals: 4, orders: {}, cloid, maxNewOrders: 3 });
    const copy = JSON.parse(JSON.stringify(s.state)) as GridState;
    expect(gridStep({ config: grid(), state: copy, mark: 2510, szDecimals: 4, orders: {}, cloid, maxNewOrders: 3 }).place).toHaveLength(3);
  });
});
