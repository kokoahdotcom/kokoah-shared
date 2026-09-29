import { describe, expect, it } from "vitest";
import { dailyRealizedLossUsd, isPerpFill, realizedPnlUsd, utcDayStart } from "../src/policy/index.js";

const DAY = Date.UTC(2026, 8, 29);

describe("daily realized loss", () => {
  it("sums closed PnL minus fees of today's perp fills", () => {
    const fills = [
      { coin: "BTC", closedPnl: "-120.5", fee: "1.5", time: DAY + 1_000 },
      { coin: "xyz:TSLA", closedPnl: "20", fee: "0.25", time: DAY + 2_000 },
      { coin: "ETH", closedPnl: "0.0", fee: "0.75", time: DAY + 3_000 }, // an opening fill: its fee counts
      { coin: "@107", closedPnl: "0.0", fee: "0.4", time: DAY + 4_000 }, // spot: fee in the bought token
      { coin: "PURR/USDC", closedPnl: "0.0", fee: "3", time: DAY + 5_000 },
      { coin: "BTC", closedPnl: "-999", fee: "1", time: DAY - 1 }, // yesterday
    ];
    expect(realizedPnlUsd(fills, DAY)).toBeCloseTo(-120.5 - 1.5 + 20 - 0.25 - 0.75, 9);
    expect(dailyRealizedLossUsd(realizedPnlUsd(fills, DAY))).toBeCloseTo(103, 9);
    expect(dailyRealizedLossUsd(50)).toBe(0);
  });

  it("refuses a fill it can't read instead of guessing", () => {
    expect(() => realizedPnlUsd([{ coin: "BTC", closedPnl: "NaN", fee: "0", time: DAY }], DAY)).toThrow(RangeError);
  });

  it("knows the UTC day and perp coins", () => {
    expect(utcDayStart(DAY + 86_399_999)).toBe(DAY);
    expect(utcDayStart(DAY + 86_400_000)).toBe(DAY + 86_400_000);
    expect(isPerpFill("BTC")).toBe(true);
    expect(isPerpFill("dex:COIN")).toBe(true);
    expect(isPerpFill("@1")).toBe(false);
  });
});
