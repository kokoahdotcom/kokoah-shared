import { describe, expect, it } from "vitest";
import { backtestCopy, copyChanges, parseBotConfig, type CopyBacktestFill, type CopyBacktestInput, type CopyBotConfig } from "../src/bots/index.js";

const T0 = Date.UTC(2026, 9, 1);
const MIN = 60_000;
const H = 3_600_000;
const LEADER = "0x" + "ab".repeat(20);
const MARKETS = { ETH: { szDecimals: 4, maxLeverage: 25 }, BTC: { szDecimals: 5, maxLeverage: 40 }, SOL: { szDecimals: 2, maxLeverage: 20 } };
const FEES = { takerRate: 0.00045, builderRate: 0.0002 };

const copy = (over: Partial<CopyBotConfig> = {}) =>
  parseBotConfig({ kind: "copy", leader: LEADER, sizing: { mode: "ratio", ratio: 0.01 }, maxOrderUsd: 5000, maxTotalUsd: 20_000, maxLeverage: 5, ...over }) as CopyBotConfig;

/** The trader's fills from a list of [minute, coin, signed size, price]; positions start flat unless `start` says. */
function fills(list: [number, string, number, number][], start: Record<string, number> = {}): CopyBacktestFill[] {
  const pos: Record<string, number> = { ...start };
  return list.map(([m, coin, size, px]) => {
    const before = pos[coin] ?? 0;
    pos[coin] = before + size;
    return { t: T0 + m * MIN, coin, side: size > 0 ? "B" : "A", sz: Math.abs(size), px, startPosition: before, pnlUsd: 0 };
  });
}

const run = (config: CopyBotConfig, f: CopyBacktestFill[], over: Partial<CopyBacktestInput> = {}) =>
  backtestCopy({ config, fills: f, from: T0, to: T0 + 24 * H, markets: MARKETS, fees: FEES, equityUsd: 10_000, ...over });

describe("copy backtest", () => {
  it("follows opens, adds, reductions and the close in proportion, and makes what the move makes", () => {
    const f = fills([
      [10, "ETH", 100, 2000],
      [60, "ETH", 50, 2050],
      [120, "ETH", -75, 2100],
      [180, "ETH", -75, 2150],
    ]);
    const r = run(copy(), f);
    expect(r.copied).toBe(4);
    expect(r.fills).toBe(4);
    // 1% of 100 then 50 ETH bought, half then the rest sold: all closed, a profit after fees.
    expect(r.openPositions).toEqual([]);
    expect(r.realizedUsd).toBeGreaterThan(100);
    expect(r.feesUsd).toBeGreaterThan(0);
    expect(r.pnlUsd).toBeCloseTo(r.realizedUsd - r.feesUsd + r.fundingUsd, 6);
    expect(r.byCoin[0]).toMatchObject({ coin: "ETH", fills: 4 });
  });

  it("doesn't copy positions held at the start, nor their reductions, and skips spot and HIP-3 trades", () => {
    const f = [
      ...fills([[30, "BTC", -1, 60_000]], { BTC: 3 }),
      ...fills([[40, "@107", 500, 1], [50, "xyz:SP500", 2, 5000]]),
    ];
    const r = run(copy(), f);
    expect(r).toMatchObject({ copied: 0, fills: 0, traderFills: 1 });
  });

  it("counts the changes its caps and allowed markets skip", () => {
    const f = fills([
      [10, "ETH", 100, 2000],
      [20, "SOL", 1000, 150],
      [30, "BTC", 5, 60_000],
    ]);
    const r = run(copy({ maxTotalUsd: 2500, maxOrderUsd: 2000, denyCoins: ["SOL"] }), f);
    // ETH copied ($2,000), SOL denied, BTC over the total cap ($3,000 wanted, $500 of room: copied smaller).
    expect(r.skipped.markets).toBe(1);
    expect(r.copied).toBe(2);
    const tight = run(copy({ maxTotalUsd: 2010, maxOrderUsd: 2000 }), f);
    expect(tight.skipped.minimum + tight.skipped.caps).toBeGreaterThan(0);
  });

  it("does not see a quick in-and-out between two polls, as live", () => {
    const f = fills([
      [10.1, "ETH", 100, 2000],
      [10.3, "ETH", -100, 2001],
    ]);
    expect(run(copy(), f)).toMatchObject({ copied: 0, fills: 0 });
  });

  it("stops at the drawdown limit and closes the copy", () => {
    const f = fills([[10, "ETH", 400, 2000]]);
    const closes = { ETH: [1, 2, 3, 4, 5].map((h) => ({ t: T0 + h * H, c: 2000 - h * 150 })) };
    const r = run(copy({ maxDrawdownPct: 20, maxTotalUsd: 10_000, maxOrderUsd: 10_000, sizing: { mode: "ratio", ratio: 0.01 } }), f, { closes });
    expect(r.end).toBe("drawdown");
    expect(r.openPositions).toEqual([]);
    expect(r.pnlUsd).toBeLessThan(0);
  });

  it("pays funding on the copy's positions at the trader's rates", () => {
    const f = fills([[5, "ETH", 100, 2000]]);
    const funding = { ETH: Array.from({ length: 10 }, (_, i) => ({ t: T0 + (i + 1) * H, rate: 0.0001 })) };
    const r = run(copy(), f, { funding });
    expect(r.fundingUsd).toBeLessThan(0);
    // 1 ETH (1% of 100) for 10 hours at 0.01%.
    expect(r.fundingUsd).toBeCloseTo(-10 * 1 * 2000 * 0.0001, 6);
  });

  it("gives the same copy from the position changes as from every fill", () => {
    const f = fills([
      [1, "ETH", 10, 2000],
      [1.1, "ETH", 5, 2001],
      [1.3, "ETH", -2, 2003],
      [7, "SOL", -100, 150],
      [7.05, "SOL", -50, 149],
      [90, "ETH", -13, 2100],
      [95, "SOL", 150, 140],
    ]);
    const changes = copyChanges(f, T0);
    expect(changes.length).toBeLessThan(f.length);
    const a = run(copy(), f);
    const b = run(copy(), changes, { traderPnlUsd: 0, traderFillCount: f.length });
    expect(b).toEqual(a);
  });
});
