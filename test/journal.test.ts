import { describe, expect, it } from "vitest";
import { buildRoundTrips, entryAvg, exitAvg, netPnl, type JournalFill } from "../src/journal/index.js";

let tid = 1000;
function fill(p: Partial<JournalFill> & Pick<JournalFill, "side" | "px" | "sz" | "startPosition">): JournalFill {
  tid += 1;
  return { tid, time: tid * 1000, coin: "BTC", closedPnl: 0, fee: 0, builderFee: 0, origin: "manual", ...p };
}

describe("buildRoundTrips", () => {
  it("keeps one order's fills (same time, trade ids out of order) in one trip", () => {
    // A market buy that filled in six pieces at one time, then a market sell in three; Hyperliquid's trade ids are
    // not in fill order.
    const at = 1_790_000_000_000;
    const buy = [
      { tid: 905, px: 309.79, sz: 0.291, startPosition: 5.146 },
      { tid: 101, px: 309.62, sz: 2.442, startPosition: 0.652 },
      { tid: 777, px: 310.43, sz: 0.76, startPosition: 5.437 },
      { tid: 555, px: 309.19, sz: 0.336, startPosition: 0 },
      { tid: 333, px: 309.69, sz: 2.052, startPosition: 3.094 },
      { tid: 999, px: 309.19, sz: 0.316, startPosition: 0.336 },
    ].map((f) => fill({ ...f, time: at, side: "B", fee: 0.1 }));
    const sell = [
      { tid: 42, px: 316.5, sz: 3, startPosition: 3.197, closedPnl: 20.4 },
      { tid: 7, px: 316.6, sz: 3, startPosition: 6.197, closedPnl: 20.7 },
      { tid: 88, px: 316.4, sz: 0.197, startPosition: 0.197, closedPnl: 1.32 },
    ].map((f) => fill({ ...f, time: at + 3_600_000, side: "A", fee: 0.1 }));
    const trips = buildRoundTrips([...sell, ...buy]);
    expect(trips).toHaveLength(1);
    const t = trips[0]!;
    expect(t.incomplete).toBe(false);
    expect(t.entryQty).toBeCloseTo(6.197, 9);
    expect(entryAvg(t)).toBeCloseTo((0.291 * 309.79 + 2.442 * 309.62 + 0.76 * 310.43 + 0.336 * 309.19 + 2.052 * 309.69 + 0.316 * 309.19) / 6.197, 9);
    expect(exitAvg(t)).toBeCloseTo((3 * 316.5 + 3 * 316.6 + 0.197 * 316.4) / 6.197, 9);
    expect(t.realizedPnl).toBeCloseTo(42.42, 9);
    expect(t.closedAt).toBe(at + 3_600_000);
    expect(t.fillCount).toBe(9);
    expect(t.id).toBe("555");
  });

  it("open → close is one closed trip with gross and net PnL", () => {
    const fills = [
      fill({ side: "B", px: 100, sz: 1, startPosition: 0, fee: 0.05, builderFee: 0.025 }),
      fill({ side: "A", px: 110, sz: 1, startPosition: 1, closedPnl: 10, fee: 0.055, builderFee: 0.0275 }),
    ];
    const [t] = buildRoundTrips(fills, [{ time: fills[0]!.time + 500, coin: "BTC", usdc: -0.3 }]);
    expect(t).toBeDefined();
    expect(t!.side).toBe("long");
    expect(t!.closedAt).toBe(fills[1]!.time);
    expect(entryAvg(t!)).toBe(100);
    expect(exitAvg(t!)).toBe(110);
    expect(t!.realizedPnl).toBe(10);
    expect(t!.feesHl).toBeCloseTo(0.0525, 10);
    expect(t!.feesBuilder).toBeCloseTo(0.0525, 10);
    expect(t!.funding).toBeCloseTo(-0.3, 10);
    expect(netPnl(t!)).toBeCloseTo(10 - 0.105 - 0.3, 10);
    expect(t!.fillCount).toBe(2);
    expect(t!.maxSize).toBe(1);
    expect(t!.id).toBe(String(fills[0]!.tid));
  });

  it("adds update the average entry and max size", () => {
    const fills = [
      fill({ side: "B", px: 100, sz: 1, startPosition: 0 }),
      fill({ side: "B", px: 130, sz: 2, startPosition: 1 }),
      fill({ side: "A", px: 140, sz: 3, startPosition: 3, closedPnl: 60 }),
    ];
    const [t] = buildRoundTrips(fills);
    expect(entryAvg(t!)).toBe(120);
    expect(t!.maxSize).toBe(3);
    expect(t!.closedAt).not.toBeNull();
    expect(t!.realizedPnl).toBe(60);
  });

  it("partial closes stay in the same trip until flat", () => {
    const fills = [
      fill({ side: "A", px: 50, sz: 4, startPosition: 0 }),
      fill({ side: "B", px: 45, sz: 1, startPosition: -4, closedPnl: 5 }),
      fill({ side: "B", px: 40, sz: 1, startPosition: -3, closedPnl: 10 }),
    ];
    let trips = buildRoundTrips(fills);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.side).toBe("short");
    expect(trips[0]!.closedAt).toBeNull();
    expect(exitAvg(trips[0]!)).toBe(42.5);
    expect(trips[0]!.firstExitAt).toBe(fills[1]!.time);

    fills.push(fill({ side: "B", px: 40, sz: 2, startPosition: -2, closedPnl: 20 }));
    trips = buildRoundTrips(fills);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.closedAt).toBe(fills[3]!.time);
    expect(trips[0]!.realizedPnl).toBe(35);
    expect(trips[0]!.exitQty).toBe(4);
  });

  it("a flip closes the trip and opens the opposite one with the remainder, splitting fees by size", () => {
    const fills = [
      fill({ side: "B", px: 100, sz: 1, startPosition: 0, fee: 0.1 }),
      fill({ side: "A", px: 120, sz: 3, startPosition: 1, closedPnl: 20, fee: 0.3, builderFee: 0.03 }),
      fill({ side: "B", px: 110, sz: 2, startPosition: -2, closedPnl: 20 }),
    ];
    const trips = buildRoundTrips(fills);
    expect(trips).toHaveLength(2);
    const [a, b] = trips;
    expect(a!.side).toBe("long");
    expect(a!.closedAt).toBe(fills[1]!.time);
    expect(a!.exitQty).toBe(1);
    expect(a!.realizedPnl).toBe(20);
    expect(a!.feesHl).toBeCloseTo(0.1 + 0.27 / 3, 10);
    expect(a!.feesBuilder).toBeCloseTo(0.01, 10);
    expect(b!.side).toBe("short");
    expect(b!.id).toBe(`${fills[1]!.tid}f`);
    expect(b!.openedAt).toBe(fills[1]!.time);
    expect(b!.entryQty).toBe(2);
    expect(entryAvg(b!)).toBe(120);
    expect(b!.feesHl).toBeCloseTo((0.27 * 2) / 3, 10);
    expect(b!.closedAt).toBe(fills[2]!.time);
    expect(b!.realizedPnl).toBe(20);
  });

  it("keeps coins separate and ignores spot fills", () => {
    const fills = [
      fill({ coin: "BTC", side: "B", px: 1, sz: 1, startPosition: 0 }),
      fill({ coin: "xyz:SP500", side: "A", px: 5000, sz: 0.1, startPosition: 0 }),
      fill({ coin: "@107", side: "B", px: 20, sz: 5, startPosition: 0 }),
      fill({ coin: "BTC", side: "A", px: 2, sz: 1, startPosition: 1, closedPnl: 1 }),
    ];
    const trips = buildRoundTrips(fills);
    expect(trips.map((t) => t.coin).sort()).toEqual(["BTC", "xyz:SP500"]);
    expect(trips.find((t) => t.coin === "BTC")!.closedAt).not.toBeNull();
    expect(trips.find((t) => t.coin === "xyz:SP500")!.closedAt).toBeNull();
  });

  it("handles float dust when closing (e.g. 0.1 + 0.2 - 0.3)", () => {
    const fills = [
      fill({ side: "B", px: 10, sz: 0.1, startPosition: 0 }),
      fill({ side: "B", px: 10, sz: 0.2, startPosition: 0.1 }),
      fill({ side: "A", px: 11, sz: 0.3, startPosition: 0.3, closedPnl: 0.3 }),
    ];
    const trips = buildRoundTrips(fills);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.closedAt).not.toBeNull();
  });

  it("marks trips incomplete on history gaps and derives entry from closedPnl", () => {
    // History starts mid-position: first known fill reduces a 2-unit long opened before the window.
    const fills = [
      fill({ side: "A", px: 120, sz: 1, startPosition: 2, closedPnl: 20 }),
      fill({ side: "A", px: 130, sz: 1, startPosition: 1, closedPnl: 30 }),
    ];
    const [t] = buildRoundTrips(fills);
    expect(t!.incomplete).toBe(true);
    expect(t!.side).toBe("long");
    expect(t!.closedAt).toBe(fills[1]!.time);
    expect(entryAvg(t!)).toBeCloseTo(100, 10);
    expect(t!.maxSize).toBe(2);

    // A gap in the middle closes the open trip as incomplete and resynchronizes.
    const g = [
      fill({ side: "B", px: 10, sz: 1, startPosition: 0 }),
      fill({ side: "A", px: 12, sz: 1, startPosition: 3, closedPnl: 2 }),
    ];
    const trips = buildRoundTrips(g);
    expect(trips).toHaveLength(2);
    expect(trips[0]!.incomplete).toBe(true);
    expect(trips[1]!.incomplete).toBe(true);
    expect(trips[1]!.closedAt).toBeNull();
  });

  it("takes the origin from the opening fill and counts fills", () => {
    const fills = [
      fill({ side: "B", px: 1, sz: 1, startPosition: 0, origin: "guardian" }),
      fill({ side: "A", px: 1, sz: 1, startPosition: 1, origin: "manual" }),
    ];
    const [t] = buildRoundTrips(fills);
    expect(t!.origin).toBe("guardian");
    expect(t!.fillCount).toBe(2);
  });

  it("does not attribute funding outside the trip window", () => {
    const fills = [fill({ side: "B", px: 1, sz: 1, startPosition: 0 }), fill({ side: "A", px: 1, sz: 1, startPosition: 1 })];
    const [t] = buildRoundTrips(fills, [
      { time: fills[0]!.time - 1, coin: "BTC", usdc: -5 },
      { time: fills[1]!.time + 1, coin: "BTC", usdc: -7 },
      { time: fills[0]!.time + 1, coin: "ETH", usdc: -9 },
    ]);
    expect(t!.funding).toBe(0);
  });
});
