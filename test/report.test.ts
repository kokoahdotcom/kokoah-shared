import { describe, expect, it } from "vitest";
import {
  AFTER_LOSS_HOURS,
  buildReportCard,
  dexOf,
  FEE_FINDINGS,
  HIGH_TAKER_SHARE,
  HL_ORDER_HISTORY,
  isMonthKey,
  isOwnLiquidation,
  lastDaysWindow,
  liquidatedPositions,
  monthKey,
  monthWindow,
  reportWindow,
  stopsAtLiquidations,
  triggerKind,
  MIN_TRIPS,
  units,
  usd,
  WINDOW_MS,
  receiptsOf,
  type FigureKey,
  type ReportFill,
  type ReportFundingRow as FundingRow,
  type ReportInput,
  type ReportOrder,
  type ReportOrderStatus,
} from "../src/report/index.js";

// Hyperliquid's answers as the app types them (kokoah-frontend `HlPosition`, `Clearinghouse`, `HlPortfolio`), so the
// fixtures are what the app passes in.
interface HlPosition {
  coin: string;
  szi: string;
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  returnOnEquity: string;
  marginUsed: string;
  liquidationPx: string | null;
  leverage: { type: "cross" | "isolated"; value: number; rawUsd?: string };
  cumFunding: { sinceOpen: string };
}
interface Clearinghouse {
  assetPositions: { position: HlPosition }[];
  marginSummary: { accountValue: string; totalNtlPos: string; totalRawUsd: string; totalMarginUsed: string };
  crossMarginSummary?: { accountValue: string; totalNtlPos: string; totalRawUsd: string; totalMarginUsed: string };
  crossMaintenanceMarginUsed?: string;
  withdrawable: string;
  time: number;
}
type HlPortfolio = [string, { accountValueHistory: [number, string][]; pnlHistory: [number, string][]; vlm: string }][];

// Made-up addresses (the checks against Hyperliquid used real accounts; none is named here).
const ME = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 21, 12, 0);
const FROM = NOW - WINDOW_MS;
/** A UTC midnight two days into the window. */
const D0 = Date.UTC(2026, 9, 24);

let seq = 0;
function fill(o: Partial<ReportFill> & Pick<ReportFill, "coin" | "side" | "px" | "sz" | "time">): ReportFill {
  seq++;
  return { tid: seq, oid: seq, fee: "0", closedPnl: "0", startPosition: "0", crossed: false, hash: "", ...o };
}

/** A trip opened and closed by one fill each: `exit − px` per unit for a long, the other way for a short. */
function trip(o: {
  at: number;
  coin?: string;
  side?: "long" | "short";
  hold?: number;
  sz?: number;
  px?: number;
  exit?: number;
  fee?: string;
  builderFee?: string;
  crossed?: boolean;
}): ReportFill[] {
  const coin = o.coin ?? "BTC";
  const long = (o.side ?? "long") === "long";
  const sz = o.sz ?? 1;
  const px = o.px ?? 100;
  const exit = o.exit ?? px;
  const pnl = (exit - px) * sz * (long ? 1 : -1);
  const common = { coin, fee: o.fee ?? "0", builderFee: o.builderFee, crossed: o.crossed ?? false };
  return [
    fill({ ...common, side: long ? "B" : "A", px: String(px), sz: String(sz), time: o.at }),
    fill({
      ...common,
      side: long ? "A" : "B",
      px: String(exit),
      sz: String(sz),
      time: o.at + (o.hold ?? HOUR),
      startPosition: String(long ? sz : -sz),
      closedPnl: String(pnl),
    }),
  ];
}

const fund = (time: number, coin: string, usdc: string, szi = "1", fundingRate = "0.0001"): FundingRow => ({
  time,
  coin,
  szi,
  fundingRate,
  usdc,
  hash: null,
});

function position(coin: string, szi: string, positionValue: string, liquidationPx: string | null, unrealizedPnl = "0") {
  const p: HlPosition = {
    coin,
    szi,
    entryPx: "0",
    positionValue,
    unrealizedPnl,
    returnOnEquity: "0",
    marginUsed: "0",
    liquidationPx,
    leverage: { type: "cross", value: 10 },
    cumFunding: { sinceOpen: "0" },
  };
  return { position: p };
}
const state = (...positions: ReturnType<typeof position>[]): Clearinghouse => ({
  assetPositions: positions,
  marginSummary: { accountValue: "0", totalNtlPos: "0", totalRawUsd: "0", totalMarginUsed: "0" },
  withdrawable: "0",
  time: NOW,
});
const portfolio = (pnl: [number, string][]): HlPortfolio => [
  ["perpMonth", { accountValueHistory: [], pnlHistory: pnl, vlm: "0" }],
];

function card(fills: ReportFill[], o: Partial<ReportInput> & { fundingRows?: FundingRow[] } = {}) {
  return buildReportCard({
    address: ME,
    now: NOW,
    fills,
    funding: { rows: o.fundingRows ?? [], from: FROM, through: NOW, complete: true },
    states: [state()],
    ...o,
  });
}

describe("exact money", () => {
  it("sums decimal strings exactly, to 8 decimals", () => {
    expect(usd(units("0.1") + units("0.2"))).toBe("0.3");
    expect(usd(units("-790.190179") + units("17.229992"))).toBe("-772.960187");
    expect(usd(units("0.000000015"))).toBe("0.00000002");
    expect(usd(units("-0.0"))).toBe("0");
    expect(units(null)).toBe(0n);
    expect(units("1e-3")).toBe(100_000n);
    expect(units("nonsense")).toBe(0n);
  });
});

describe("coverage", () => {
  it("counts perp fills in the window once, HIP-3 included, and leaves spot out", () => {
    const btc = trip({ at: D0 });
    const c = card([
      ...btc,
      btc[0]!, // the same fill twice (the store's and Hyperliquid's copy)
      ...trip({ at: D0 + DAY, coin: "xyz:TSLA" }),
      fill({ coin: "@107", side: "B", px: "1", sz: "5", time: D0 }),
      fill({ coin: "PURR/USDC", side: "A", px: "1", sz: "5", time: D0 }),
      fill({ coin: "BTC", side: "B", px: "1", sz: "1", time: FROM - 1 }),
      fill({ coin: "BTC", side: "B", px: "1", sz: "1", time: NOW + 1 }),
    ]);
    expect(c.coverage).toEqual({
      from: FROM,
      to: NOW,
      fills: 4,
      spotLeftOut: 2,
      fillsComplete: true,
      unfilledGaps: [],
      funding: { rows: 0, from: FROM, through: NOW, complete: true },
      complete: true,
    });
    expect(c.trips.closed).toBe(2);
  });

  it("is incomplete with an unfilled gap (clipped to the window, merged) or funding that stops early", () => {
    const c = card(trip({ at: D0 }), {
      unfilledGaps: [
        [FROM - DAY, FROM + HOUR],
        [D0, D0 + HOUR],
        [D0 + HOUR + 1, D0 + 2 * HOUR],
        [NOW + 1, NOW + DAY],
      ],
      funding: { rows: [fund(D0, "BTC", "-1")], from: FROM, through: FROM + 10 * DAY, complete: false },
    });
    expect(c.coverage.unfilledGaps).toEqual([
      [FROM, FROM + HOUR],
      [D0, D0 + 2 * HOUR],
    ]);
    expect(c.coverage).toMatchObject({ fillsComplete: false, complete: false });
    expect(c.coverage.funding).toEqual({ rows: 1, from: FROM, through: FROM + 10 * DAY, complete: false });
  });
});

describe("result after costs", () => {
  it("is closedPnl minus every fee plus funding as Hyperliquid signs it, summed exactly", () => {
    const fills = [
      // closedPnl is the price change alone; fees come off separately (checked on Hyperliquid).
      ...trip({ at: D0, sz: 0.1, px: 100, exit: 101, fee: "0.1" }),
      ...trip({ at: D0 + DAY, sz: 0.2, px: 100, exit: 101, fee: "0.2", builderFee: "0.05" }),
    ];
    const c = card(fills, {
      fundingRows: [
        // Real hours (mainnet): a long paid at a positive rate; a HIP-3 long paid at a rate that rounds to below zero.
        fund(D0 + 1, "BTC", "-21.7585", "729.51", "0.0000124317"),
        fund(D0 + DAY + 1, "xyz:ANTH", "-0.008398", "3.55", "-0.0000001281"),
        // A short received.
        fund(D0 + 2 * DAY, "BTC", "0.5", "-1", "0.0001"),
        fund(FROM - 1, "BTC", "-100"),
      ],
    });
    expect(c.result.price).toEqual({ usd: "0.3", rows: 2 });
    expect(c.result.fees).toEqual({ usd: "0.6", rows: 4 });
    expect(c.result.funding).toEqual({ usd: "-21.266898", rows: 3 });
    expect(c.result.net).toEqual({ usd: "-21.566898", rows: 7 });
    expect(c.costs.fundingPaid).toEqual({ usd: "21.766898", rows: 2 });
    expect(c.costs.fundingReceived).toEqual({ usd: "0.5", rows: 1 });
    expect(c.costs.exchangeFees).toEqual({ usd: "0.5", rows: 4 });
    expect(c.costs.builderFees).toEqual({ usd: "0.1", rows: 2 });
  });

  it("puts Hyperliquid's own figure next to it, from the sample at or before the window start", () => {
    const c = card(trip({ at: D0, px: 100, exit: 120, fee: "0.25" }), {
      fundingRows: [fund(D0 + HOUR / 2, "BTC", "-0.5")],
      portfolio: portfolio([
        [FROM - 14 * HOUR, "0.0"],
        [FROM + HOUR, "1.0"],
        [NOW, "19.0"],
      ]),
    });
    // 20 − 0.5 fees − 0.5 funding: flat at both ends, so the two agree.
    expect(c.result.net.usd).toBe("19");
    expect(c.result.hyperliquid).toEqual({
      from: FROM - 14 * HOUR,
      to: NOW,
      pnl: "19",
      points: 3,
      beforeWindow: true,
    });
    expect(c.result.difference).toEqual({
      usd: "0",
      openNow: { usd: "0", rows: 0 },
      carriedIn: [],
      explained: "0",
      unexplained: "0",
      timing: true,
    });
    // Hyperliquid's samples start after the window: its first one.
    const late = card([], {
      portfolio: portfolio([
        [FROM + HOUR, "0"],
        [NOW, "-3"],
      ]),
    });
    expect(late.result.hyperliquid).toMatchObject({ from: FROM + HOUR, pnl: "-3", points: 2, beforeWindow: false });
    expect(card([], { portfolio: portfolio([[NOW, "1"]]) }).result.hyperliquid).toBeNull();
    expect(card([]).result.difference).toBeNull();
  });

  it("explains the difference by positions open now when nothing was open at the start", () => {
    const fills = [fill({ coin: "ETH", side: "B", px: "2000", sz: "1", time: D0, fee: "1" })];
    const c = card(fills, {
      portfolio: portfolio([
        [FROM, "0"],
        [NOW, "24.5"],
      ]),
      states: [state(position("ETH", "1", "2025.5", "1500", "25.5")), state()],
    });
    expect(c.result.net.usd).toBe("-1");
    expect(c.result.difference).toEqual({
      usd: "25.5",
      openNow: { usd: "25.5", rows: 1 },
      carriedIn: [],
      explained: "25.5",
      unexplained: "0",
      timing: true,
    });
  });

  it("puts what the open positions leave only up to a small limit down to the graph’s timing", () => {
    // A result of −1: the limit is $1 (1% of it is less).
    const at = (pnl: string, fills = [fill({ coin: "ETH", side: "B", px: "2000", sz: "1", time: D0, fee: "1" })]) =>
      card(fills, {
        portfolio: portfolio([
          [FROM, "0"],
          [NOW, pnl],
        ]),
        states: [state()],
      }).result.difference;
    expect(at("-1.9")).toMatchObject({ unexplained: "-0.9", timing: true });
    expect(at("0")).toMatchObject({ unexplained: "1", timing: true });
    expect(at("0.5")).toMatchObject({ unexplained: "1.5", timing: false });
    // A result of −500: 1% of it ($5) is the limit.
    const big = [...trip({ at: D0, exit: 600, sz: 1, px: 1100 })];
    expect(at("-504", big)).toMatchObject({ unexplained: "-4", timing: true });
    expect(at("-506", big)).toMatchObject({ unexplained: "-6", timing: false });
    // With part of the history unread, missing fills could be the cause: never timing.
    const gappy = card([fill({ coin: "ETH", side: "B", px: "2000", sz: "1", time: D0, fee: "1" })], {
      portfolio: portfolio([
        [FROM, "0"],
        [NOW, "-1.5"],
      ]),
      states: [state()],
      unfilledGaps: [[D0 + DAY, D0 + 2 * DAY]],
    }).result.difference;
    expect(gappy).toMatchObject({ unexplained: "-0.5", timing: false });
  });

  it("can't explain it when a position was open at the window start, or a dex wasn't read", () => {
    const carried = [
      // The first fill in the window starts from a position: it was open before.
      fill({ coin: "SOL", side: "A", px: "90", sz: "2", time: D0, startPosition: "2", closedPnl: "-20" }),
    ];
    const c = card(carried, {
      portfolio: portfolio([
        [FROM, "0"],
        [NOW, "-31"],
      ]),
      states: [state(position("HYPE", "10", "300", null, "-3"))],
    });
    expect(c.result.difference).toMatchObject({ usd: "-11", carriedIn: ["HYPE", "SOL"], explained: null });
    const unread = card([], {
      portfolio: portfolio([
        [FROM, "0"],
        [NOW, "1"],
      ]),
      states: [state(), null],
    });
    expect(unread.result.difference).toMatchObject({ openNow: null, explained: null, unexplained: null });
    expect(unread.liquidations.positionsRead).toBe(false);
  });
});

describe("where the money went", () => {
  const liq = (o: Partial<ReportFill> & Pick<ReportFill, "time">, user = ME, method = "market") =>
    fill({
      coin: "ETH",
      side: "A",
      px: "2000",
      sz: "1",
      startPosition: "1",
      dir: "Close Long",
      crossed: true,
      liquidation: { liquidatedUser: user, markPx: "2000", method },
      ...o,
    });

  it("makes fees the biggest cost when they take more than the trading lost", () => {
    const c = card([...trip({ at: D0, exit: 150, fee: "40" }), ...trip({ at: D0 + DAY, exit: 90 })]);
    // The trading itself made 40: no price cost.
    expect(c.costs.amounts).toEqual({ fees: "80", liquidations: "0", funding: "0", price: "0" });
    expect(c.costs.biggest).toBe("fees");
    expect(c.findings[0]).toEqual({
      key: "feesBiggestCost",
      tool: "limitOrders",
      values: { fees: 80, price: 40, net: -40, shareOfGains: 2 },
    });
  });

  it("counts liquidation fills apart, their fees with them", () => {
    const c = card([
      fill({ coin: "ETH", side: "B", px: "2100", sz: "1", time: D0, fee: "1" }),
      liq({ time: D0 + HOUR, closedPnl: "-100", fee: "2" }),
    ]);
    expect(c.costs.liquidations).toEqual({ price: { usd: "-100", rows: 1 }, fees: { usd: "2", rows: 1 }, cost: "102" });
    expect(c.costs.amounts).toEqual({ fees: "1", liquidations: "102", funding: "0", price: "0" });
    expect(c.costs.biggest).toBe("liquidations");
    // The price and fee lines leave the liquidation out: it is counted once.
    expect(c.costs.price).toEqual({ usd: "0", rows: 0 });
    expect(c.costs.exchangeFees).toEqual({ usd: "1", rows: 1 });
  });

  it("has lines that add up to the result after costs", () => {
    const c = card(
      [
        fill({ coin: "ETH", side: "B", px: "2100", sz: "1", time: D0, fee: "1", builderFee: "0.2" }),
        liq({ time: D0 + HOUR, closedPnl: "-100", fee: "2", builderFee: "0.5" }),
        ...trip({ at: D0 + DAY, exit: 130, fee: "0.5", builderFee: "0.1" }),
      ],
      { fundingRows: [fund(D0 + 1, "ETH", "-3"), fund(D0 + DAY + 1, "BTC", "1")] },
    );
    const k = c.costs;
    expect([k.price.usd, k.exchangeFees.usd, k.builderFees.usd, k.liquidations.cost]).toEqual([
      "30",
      "1.6",
      "0.4",
      "102",
    ]);
    const lines =
      units(k.price.usd) -
      units(k.exchangeFees.usd) -
      units(k.builderFees.usd) +
      units(k.fundingReceived.usd) -
      units(k.fundingPaid.usd) -
      units(k.liquidations.cost);
    expect(usd(lines)).toBe(c.result.net.usd);
    expect(c.result.net.usd).toBe("-76");
  });

  it("gives the fees’ share of the gains made outside liquidations", () => {
    const c = card([
      ...trip({ at: D0, exit: 150, fee: "40" }),
      fill({ coin: "ETH", side: "B", px: "2010", sz: "1", time: D0 + DAY }),
      liq({ time: D0 + DAY + HOUR, closedPnl: "-10" }),
    ]);
    expect(c.costs.biggest).toBe("fees");
    expect(c.findings.find((f) => f.key === "feesBiggestCost")).toMatchObject({
      values: { fees: 80, price: 50, shareOfGains: 1.6 },
    });
  });

  it("picks funding or the price result when they cost most, fees first on a tie, nothing when nothing cost", () => {
    const funding = card(trip({ at: D0, exit: 101, fee: "0.5" }), {
      fundingRows: [fund(D0 + 1, "BTC", "-3"), fund(D0 + 2, "BTC", "1")],
    });
    expect(funding.costs.biggest).toBe("funding");
    expect(funding.costs.amounts.funding).toBe("2");
    expect(card(trip({ at: D0, exit: 70, fee: "1" })).costs.biggest).toBe("price");
    expect(card(trip({ at: D0, exit: 95, fee: "2.5" })).costs.biggest).toBe("fees");
    // A maker earning rebates on a winning trade: no cost at all.
    const none = card(trip({ at: D0, exit: 110, fee: "-0.1" }));
    expect(none.costs.biggest).toBeNull();
    expect(none.findings).toEqual([]);
  });
});

describe("receipts", () => {
  it("lists the rows behind every money figure, each with its part, adding up to the figure", () => {
    const c = card(
      [
        fill({ coin: "ETH", side: "B", px: "2100", sz: "1", time: D0, fee: "1", builderFee: "0.2", crossed: true }),
        fill({
          coin: "ETH",
          side: "A",
          px: "2000",
          sz: "1",
          time: D0 + HOUR,
          startPosition: "1",
          closedPnl: "-100",
          fee: "2",
          builderFee: "0.5",
          crossed: true,
          liquidation: { liquidatedUser: ME, markPx: "2000", method: "market" },
        }),
        ...trip({ at: D0 + DAY, exit: 130, fee: "0.5", builderFee: "0.1" }),
        // Another account's liquidation this address took: an ordinary fill.
        fill({
          coin: "SOL",
          side: "B",
          px: "90",
          sz: "1",
          time: D0 + 2 * DAY,
          fee: "-0.01",
          liquidation: { liquidatedUser: OTHER, markPx: "90", method: "market" },
        }),
      ],
      { fundingRows: [fund(D0 + 1, "ETH", "-3"), fund(D0 + DAY + 1, "BTC", "1"), fund(D0 + DAY + 2, "BTC", "0")] },
    );
    const sum = (key: FigureKey) => usd(receiptsOf(c, key).reduce((s, r) => s + units(r.usd), 0n));
    const figures: [FigureKey, { usd: string; rows: number }][] = [
      ["net", c.result.net],
      ["price", c.result.price],
      ["fees", c.result.fees],
      ["funding", c.result.funding],
      ["costPrice", c.costs.price],
      ["exchangeFees", c.costs.exchangeFees],
      ["builderFees", c.costs.builderFees],
      ["fundingPaid", c.costs.fundingPaid],
      ["fundingReceived", c.costs.fundingReceived],
      ["liquidations", { usd: c.liquidations.cost, rows: c.liquidations.fills }],
      ["taker", { usd: c.taker.takerFees.usd, rows: c.taker.takerFills }],
    ];
    for (const [key, figure] of figures) {
      expect(sum(key), key).toBe(figure.usd);
      expect(receiptsOf(c, key).length, key).toBe(figure.rows);
    }
    // Every fill and funding entry is a row of the result, the zero ones too, oldest first.
    expect(receiptsOf(c, "net").map((r) => (r.kind === "fill" ? r.fill.time : r.funding.time))).toEqual([
      D0,
      D0 + 1,
      D0 + HOUR,
      D0 + DAY,
      D0 + DAY + 1,
      D0 + DAY + 2,
      D0 + DAY + HOUR,
      D0 + 2 * DAY,
    ]);
    expect(receiptsOf(c, "liquidations")).toEqual([expect.objectContaining({ kind: "fill", usd: "102" })]);
  });

  it("keeps the trips behind the trip figures, habits and days", () => {
    const c = card([
      // Open at the window start, closed by a fill: a day, not a trip figure.
      fill({ coin: "SOL", side: "A", px: "90", sz: "1", time: D0, startPosition: "1", closedPnl: "-4" }),
      ...trip({ at: D0 + DAY, exit: 95 }),
      ...trip({ at: D0 + DAY + 3 * HOUR, exit: 110 }),
      fill({ coin: "ETH", side: "B", px: "10", sz: "1", time: D0 + 3 * DAY }),
    ]);
    expect(c.rows.closed.map((t) => t.realizedPnl)).toEqual([-5, 10]);
    expect(c.rows.afterLoss.map((t) => t.realizedPnl)).toEqual([10]);
    expect(c.rows.dayTrips.map((t) => t.realizedPnl)).toEqual([-4, -5, 10]);
    expect(c.rows.leftOut.carriedIn).toHaveLength(1);
    expect(c.rows.leftOut.open.map((t) => t.coin)).toEqual(["ETH"]);
    expect(c.rows.leftOut.gaps).toEqual([]);
  });
});

describe("taker share", () => {
  it("is the volume that crossed the book, with the fees it paid", () => {
    const c = card([
      ...trip({ at: D0, sz: 1, px: 100, exit: 100, crossed: true, fee: "0.045" }),
      ...trip({ at: D0 + DAY, sz: 1, px: 100, exit: 100, crossed: false, fee: "0.015" }),
    ]);
    expect(c.taker).toEqual({
      volume: 400,
      takerVolume: 200,
      share: 0.5,
      fills: 4,
      takerFills: 2,
      takerFees: { usd: "0.09", rows: 2 },
      makerFees: { usd: "0.03", rows: 2 },
    });
    expect(c.findings.map((f) => f.key)).not.toContain("highTakerShare");
  });

  it(`is a finding from ${HIGH_TAKER_SHARE} with enough fills`, () => {
    const fills = (n: number) => Array.from({ length: n }, (_, i) => trip({ at: D0 + i * DAY, crossed: true })).flat();
    expect(card(fills(10)).findings.find((f) => f.key === "highTakerShare")).toEqual({
      key: "highTakerShare",
      tool: "limitOrders",
      values: { share: 1, takerVolume: 2000, volume: 2000, takerFees: 0 },
    });
    expect(card(fills(9)).findings.map((f) => f.key)).not.toContain("highTakerShare");
  });
});

describe("liquidations", () => {
  // Real fills (mainnet, November 2026), the address replaced: a market liquidation, then the backstop that took the
  // rest of the position; and another account's liquidation this one filled.
  const open = fill({ coin: "ETH", side: "B", px: "2120.0", sz: "4.813", time: D0, crossed: true, fee: "4.6" });
  const market = [
    fill({
      coin: "ETH",
      px: "2055.0",
      sz: "2.0666",
      side: "A",
      time: D0 + 5 * HOUR,
      startPosition: "4.813",
      dir: "Close Long",
      closedPnl: "-89.525112",
      oid: 598672952596,
      crossed: true,
      fee: "1.911088",
      liquidation: { liquidatedUser: ME, markPx: "2112.0", method: "market" },
    }),
  ];
  const backstop = fill({
    coin: "ETH",
    px: "2083.83",
    sz: "2.7464",
    side: "A",
    time: D0 + 5 * HOUR + 9867,
    startPosition: "2.7464",
    dir: "Liquidated Isolated Long",
    closedPnl: "-39.795336",
    oid: 598673387318,
    crossed: false,
    fee: "0.0",
    liquidation: { liquidatedUser: ME, markPx: "2072.0", method: "backstop" },
  });
  const theirs = fill({
    coin: "BTC",
    px: "60000",
    sz: "0.1",
    side: "B",
    time: D0 + DAY,
    crossed: false,
    liquidation: { liquidatedUser: OTHER, markPx: "60010", method: "market" },
  });

  it("counts the address's own liquidations by order, not another account's it took", () => {
    const c = card([open, ...market, backstop, theirs]);
    expect(isOwnLiquidation(theirs, ME)).toBe(false);
    const mixedCase = "0xAbCdEf0000000000000000000000000000000001";
    const named = { ...backstop, liquidation: { markPx: "1", method: "backstop", liquidatedUser: mixedCase } };
    expect(isOwnLiquidation(named, mixedCase.toLowerCase())).toBe(true);
    expect(c.liquidations).toMatchObject({
      count: 2,
      backstop: 1,
      fills: 2,
      price: { usd: "-129.320448", rows: 2 },
      fees: { usd: "1.911088", rows: 1 },
      cost: "131.231536",
    });
    expect(c.findings.find((f) => f.key === "liquidated")).toEqual({
      key: "liquidated",
      tool: "guardians",
      // The market liquidation and the backstop that took the rest: one position. Without the orders read, nothing is
      // said about stop-losses.
      values: { count: 2, fills: 2, cost: 131.231536, positions: 1, withStop: null },
    });
    expect(c.liquidations.stops).toEqual({ state: "unread", withStop: null, positions: 1, dexes: 1 });
    // The liquidated trade is still one round trip, after fees.
    expect(c.trips.closed).toBe(1);
    // A liquidation without a name counts when it reads as a backstop.
    const unnamed = { ...backstop, liquidation: { markPx: "1", method: "backstop" } };
    expect(isOwnLiquidation(unnamed, ME)).toBe(true);
    expect(isOwnLiquidation({ ...unnamed, dir: "Close Long" }, ME)).toBe(false);
  });

  it("counts the fills of one liquidation order as one liquidation", () => {
    const pieces = [0, 1, 2].map((i) =>
      fill({
        coin: "xyz:NVDA",
        side: "A",
        px: "147.67",
        sz: "10",
        time: D0 + HOUR,
        oid: 610583241230,
        startPosition: String(30 - 10 * i),
        closedPnl: "-50",
        crossed: true,
        fee: "0.2",
        liquidation: { liquidatedUser: ME, markPx: "147.72", method: "market" },
      }),
    );
    const c = card([fill({ coin: "xyz:NVDA", side: "B", px: "152.67", sz: "30", time: D0 }), ...pieces]);
    expect(c.liquidations).toMatchObject({ count: 1, fills: 3, cost: "150.6" });
    expect(c.trips.closed).toBe(1);
  });

  it("measures how close open positions on every dex are to liquidation, nearest first", () => {
    // Real positions (mainnet, November 2026): a BTC short on the main dex and a short on a HIP-3 dex.
    const c = card([], {
      states: [
        state(position("BTC", "-0.17171", "10107.36573", "60354.8115448743", "-104.05626")),
        state(
          position("xyz:NVDA", "-38.88", "4980.1392", "134.3694426318", "3.888"),
          position("xyz:GOLD", "0.5", "1800", null, "1"),
        ),
      ],
    });
    const open = c.liquidations.open;
    expect(open.map((p) => [p.coin, p.side, p.liquidationPx === null])).toEqual([
      ["BTC", "short", false],
      ["xyz:NVDA", "short", false],
      ["xyz:GOLD", "long", true],
    ]);
    expect(open[0]!.mark).toBeCloseTo(58863, 0);
    expect(open[0]!.distance).toBeCloseTo(0.0253, 4);
    expect(open[1]!.distance).toBeCloseTo(0.049, 3);
    expect(open[2]!.distance).toBeNull();
    expect(c.liquidations.nearest).toBe(open[0]!.distance);
    expect(c.findings).toEqual([
      { key: "nearLiquidation", tool: "guardians", values: { positions: 2, nearest: open[0]!.distance } },
    ]);
    expect(card([], { states: [state(position("BTC", "1", "60000", "30000"))] }).findings).toEqual([]);
  });
});

describe("round trips", () => {
  it("splits a flip from long to short and pro-rates its fee", () => {
    const c = card([
      fill({ coin: "BTC", side: "B", px: "100", sz: "1", time: D0, fee: "1" }),
      fill({
        coin: "BTC",
        side: "A",
        px: "110",
        sz: "2",
        time: D0 + HOUR,
        startPosition: "1",
        closedPnl: "10",
        fee: "2",
      }),
    ]);
    expect(c.trips).toMatchObject({ closed: 1, wins: 1, net: 8, leftOut: { carriedIn: 0, open: 1, gaps: 0 } });
  });

  it("counts one order's partial fills (any trade id order), a TWAP's slices and HIP-3 as one trade each", () => {
    const partial = [
      fill({ coin: "ETH", side: "B", px: "10", sz: "1", time: D0, tid: 903, startPosition: "2" }),
      fill({ coin: "ETH", side: "B", px: "10", sz: "1", time: D0, tid: 901, startPosition: "0" }),
      fill({ coin: "ETH", side: "B", px: "10", sz: "1", time: D0, tid: 902, startPosition: "1" }),
      fill({ coin: "ETH", side: "A", px: "12", sz: "3", time: D0 + HOUR, startPosition: "3", closedPnl: "6" }),
    ];
    const twap = [
      ...Array.from({ length: 5 }, (_, i) =>
        fill({
          coin: "xyz:TSLA",
          side: "A",
          px: "400",
          sz: "1",
          time: D0 + i * 60_000,
          startPosition: String(-i),
          twapId: 77,
        }),
      ),
      fill({ coin: "xyz:TSLA", side: "B", px: "390", sz: "5", time: D0 + DAY, startPosition: "-5", closedPnl: "50" }),
    ];
    const c = card([...partial, ...twap]);
    expect(c.trips).toMatchObject({ closed: 2, wins: 2, net: 56 });
  });

  it("leaves out a trip open at the window start or broken by a gap, but counts its money", () => {
    const c = card([
      // Open before the window: the first fill in it starts from a short.
      fill({ coin: "SOL", side: "B", px: "90", sz: "3", time: D0, startPosition: "-3", closedPnl: "30", fee: "0.1" }),
      // A gap: the tracked position (flat) disagrees with the next fill's start.
      ...trip({ at: D0 + DAY }),
      fill({ coin: "BTC", side: "A", px: "100", sz: "1", time: D0 + 3 * DAY, startPosition: "2", closedPnl: "5" }),
    ]);
    expect(c.trips).toMatchObject({ closed: 1, leftOut: { carriedIn: 1, open: 0, gaps: 1 } });
    expect(c.result.price.usd).toBe("35");
    expect(c.result.difference).toBeNull();
  });

  it("calls a market carried in only when its first fill in the window starts from a position", () => {
    const c = card(
      [
        // Opened from flat in the window; the next fill starts from 2: a gap, not a position from before.
        fill({ coin: "BTC", side: "B", px: "100", sz: "1", time: D0 }),
        fill({ coin: "BTC", side: "A", px: "100", sz: "2", time: D0 + DAY, startPosition: "2" }),
      ],
      {
        portfolio: portfolio([
          [FROM, "0"],
          [NOW, "0"],
        ]),
      },
    );
    expect(c.trips.leftOut).toEqual({ carriedIn: 0, open: 0, gaps: 2 });
    expect(c.result.difference).toMatchObject({ carriedIn: [], explained: "0" });
    // Trips broken by a gap make no day: the part before the gap would land on the next fill's day.
    expect(c.days.list).toEqual([]);
    // One order's fills in the first millisecond, starting from a short and passing through flat: carried in.
    const flip = card([
      fill({ coin: "ETH", side: "B", px: "10", sz: "1", time: D0, tid: 802, startPosition: "-1" }),
      fill({ coin: "ETH", side: "B", px: "10", sz: "1", time: D0, tid: 801, startPosition: "0" }),
      fill({ coin: "ETH", side: "A", px: "11", sz: "1", time: D0 + HOUR, startPosition: "1", closedPnl: "1" }),
    ]);
    expect(flip.trips).toMatchObject({ closed: 1, leftOut: { carriedIn: 1, open: 0, gaps: 0 } });
  });

  it(`shows win rate only with the average win and loss, after fees, from ${MIN_TRIPS} trips`, () => {
    const fills = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        // Every third trip loses; one wins 1 before fees of 2, which makes it a loss.
        trip({ at: D0 + i * DAY, exit: i === 0 ? 101 : i % 3 ? 110 : 95, fee: i === 0 ? "1" : "0" }),
      ).flat();
    const few = card(fills(MIN_TRIPS - 1));
    expect(few.trips).toMatchObject({
      closed: MIN_TRIPS - 1,
      enough: false,
      winRate: null,
      avgWin: null,
      avgLoss: null,
    });
    const c = card(fills(MIN_TRIPS));
    // Trips 1, 2, 4, 5, 7, 8 win 10 each; 3, 6, 9 lose 5; trip 0 nets −1.
    expect(c.trips).toMatchObject({ closed: 10, wins: 6, losses: 4, winRate: 0.6, avgWin: 10, enough: true });
    expect(c.trips.avgLoss).toBeCloseTo(-4, 9);
  });
});

describe("habits", () => {
  /** Day i: a losing trip at 00:00, a bigger one an hour after it closed, and a normal one at 12:00. */
  function days(n: number, bigger = 3) {
    return Array.from({ length: n }, (_, i) => [
      ...trip({ at: D0 + i * DAY, exit: 90 }),
      ...trip({ at: D0 + i * DAY + 2 * HOUR, sz: bigger, exit: 105 }),
      ...trip({ at: D0 + i * DAY + 12 * HOUR, exit: 110 }),
    ]).flat();
  }

  it(`compares trade size within ${AFTER_LOSS_HOURS} h after a loss with the rest`, () => {
    const c = card(days(10));
    expect(c.habits.sizeAfterLoss).toEqual({
      enough: true,
      hours: AFTER_LOSS_HOURS,
      afterLoss: { trips: 10, median: 300 },
      other: { trips: 20, median: 100 },
      ratio: 3,
    });
    expect(c.findings.find((f) => f.key === "sizeUpAfterLoss")?.values).toEqual({
      ratio: 3,
      hours: AFTER_LOSS_HOURS,
      afterLossTrips: 10,
      otherTrips: 20,
      afterLossMedian: 300,
      otherMedian: 100,
    });
    // Too few after-loss trips, or no bigger: no finding.
    expect(card(days(9)).habits.sizeAfterLoss.enough).toBe(false);
    expect(card(days(9)).findings.map((f) => f.key)).not.toContain("sizeUpAfterLoss");
    expect(card(days(10, 1.2)).findings.map((f) => f.key)).not.toContain("sizeUpAfterLoss");
  });

  it("doesn't count a trip as after its own loss", () => {
    // Opened and closed at a loss in the same millisecond, nothing before it.
    const c = card(trip({ at: D0, hold: 0, exit: 90 }));
    expect(c.habits.sizeAfterLoss.afterLoss.trips).toBe(0);
  });

  it("compares how long losers and winners are held", () => {
    const fills = (n: number) =>
      Array.from({ length: n }, (_, i) => [
        ...trip({ at: D0 + i * DAY, hold: HOUR, exit: 110 }),
        ...trip({ at: D0 + i * DAY + 6 * HOUR, hold: 3 * HOUR, exit: 90 }),
      ]).flat();
    const c = card(fills(10));
    expect(c.habits.holdTime).toEqual({
      enough: true,
      winners: { trips: 10, median: HOUR },
      losers: { trips: 10, median: 3 * HOUR },
      ratio: 3,
    });
    expect(c.findings.find((f) => f.key === "holdLosersLonger")).toEqual({
      key: "holdLosersLonger",
      tool: "guardians",
      values: { ratio: 3, losers: 10, winners: 10, losersMedianMs: 3 * HOUR, winnersMedianMs: HOUR },
    });
    expect(card(fills(9)).habits.holdTime.enough).toBe(false);
    expect(card(days(10)).findings.map((f) => f.key)).not.toContain("holdLosersLonger");
  });

  it("finds the worst UTC hour and weekday by net, from buckets with enough trips", () => {
    const c = card(days(10));
    expect(c.habits.timing.worstHour).toEqual({ key: 0, trips: 10, net: -100 });
    expect(c.habits.timing.hours[2]).toEqual({ key: 2, trips: 10, net: 150 });
    expect(c.habits.timing.hours.reduce((s, b) => s + b.trips, 0)).toBe(30);
    // Every weekday nets above zero here: no worst weekday.
    expect(c.habits.timing.worstWeekday).toBeNull();
    // A worse hour with too few trips doesn't count; one counted bucket alone has nothing to compare with.
    const lone = card([
      ...Array.from({ length: 5 }, (_, i) => trip({ at: D0 + i * DAY + 3 * HOUR, exit: 99 })).flat(),
      ...Array.from({ length: 4 }, (_, i) => trip({ at: D0 + i * DAY + 5 * HOUR, exit: 50 })).flat(),
    ]);
    expect(lone.habits.timing.worstHour).toBeNull();
    // Five losing trips on one day, five winning ones the next: the first day's weekday is the worst.
    const worst = card([
      ...Array.from({ length: 5 }, (_, i) => trip({ at: D0 + 2 * i * HOUR, exit: 80 })).flat(),
      ...Array.from({ length: 5 }, (_, i) => trip({ at: D0 + DAY + 2 * i * HOUR, exit: 101 })).flat(),
    ]);
    expect(worst.habits.timing.worstWeekday).toEqual({ key: new Date(D0).getUTCDay(), trips: 5, net: -100 });
  });
});

describe("losing days", () => {
  it("counts the days trips closed on, each with its fees and funding", () => {
    const c = card(
      [
        // Day 0: −5 price, −5 fees. Day 1: +3, −0.5 funding while open.
        ...trip({ at: D0 + HOUR, exit: 95, fee: "2.5" }),
        ...trip({ at: D0 + DAY + HOUR, exit: 103 }),
        // Opened late on day 3 (a fee), closed on day 4: day 4 only.
        ...trip({ at: D0 + 3 * DAY + 23 * HOUR, hold: 2 * HOUR, exit: 104, fee: "1" }),
      ],
      // Day 2: funding only, while nothing is open.
      { fundingRows: [fund(D0 + DAY + 1.5 * HOUR, "BTC", "-0.5"), fund(D0 + 2 * DAY + HOUR, "BTC", "-1")] },
    );
    expect(c.days).toEqual({
      active: 3,
      losing: 1,
      winning: 2,
      worst: { day: D0, net: -10, trips: 1 },
      list: [
        { day: D0, net: -10, trips: 1 },
        { day: D0 + DAY, net: 2.5, trips: 1 },
        { day: D0 + 4 * DAY, net: 2, trips: 1 },
      ],
    });
  });

  it("counts a trip open at the window start only when a fill closed it, not a gap", () => {
    // Long 2 at the window start, sold down to 1, then the next fill starts from 0.5: a gap cut it.
    const cut = card([
      fill({ coin: "SOL", side: "A", px: "90", sz: "1", time: D0, startPosition: "2", closedPnl: "-10" }),
      fill({ coin: "SOL", side: "A", px: "90", sz: "0.5", time: D0 + DAY, startPosition: "0.5", closedPnl: "-5" }),
    ]);
    expect(cut.trips.leftOut).toEqual({ carriedIn: 1, open: 0, gaps: 1 });
    expect(cut.days.list).toEqual([]);
    // The same start closed by its own fills: a day, on the day it closed.
    const clean = card([
      fill({ coin: "SOL", side: "A", px: "90", sz: "1", time: D0, startPosition: "2", closedPnl: "-10" }),
      fill({ coin: "SOL", side: "A", px: "90", sz: "1", time: D0 + DAY, startPosition: "1", closedPnl: "-10" }),
    ]);
    expect(clean.trips.leftOut).toEqual({ carriedIn: 1, open: 0, gaps: 0 });
    expect(clean.days.list).toEqual([{ day: D0 + DAY, net: -20, trips: 1 }]);
    // Flipped through flat by a fill: closed cleanly too; the short it opened is still open.
    const flip = card([
      fill({ coin: "SOL", side: "A", px: "90", sz: "3", time: D0, startPosition: "2", closedPnl: "4" }),
    ]);
    expect(flip.trips.leftOut).toEqual({ carriedIn: 1, open: 1, gaps: 0 });
    expect(flip.days.list).toEqual([{ day: D0, net: 4, trips: 1 }]);
  });

  it("makes no losing days of opening fees or funding alone", () => {
    // Six winning trades, each opened one day and closed the next.
    const swing = card(
      Array.from({ length: 6 }, (_, i) =>
        trip({ at: D0 + 2 * i * DAY + HOUR, hold: DAY, exit: 110, fee: "0.05", crossed: true }),
      ).flat(),
    );
    expect(swing.trips.wins).toBe(6);
    expect(swing.days).toMatchObject({ active: 6, losing: 0, winning: 6 });
    expect(swing.findings.map((f) => f.key)).not.toContain("manyLosingDays");
    // A position held all month, no trade in the window, funding paid every hour.
    const holder = card([], {
      fundingRows: Array.from({ length: 29 * 24 }, (_, i) => fund(FROM + HOUR + i * HOUR, "BTC", "-0.01")),
    });
    expect(holder.days).toEqual({ active: 0, losing: 0, winning: 0, worst: null, list: [] });
    expect(holder.findings.map((f) => f.key)).not.toContain("manyLosingDays");
  });

  it("is a finding with many losing days, at least half the active ones", () => {
    const daysOf = (losing: number, winning: number) =>
      Array.from({ length: losing + winning }, (_, i) =>
        trip({ at: D0 + i * DAY, exit: i < losing ? 99 : 101 }),
      ).flat();
    expect(card(daysOf(5, 5)).findings.find((f) => f.key === "manyLosingDays")).toEqual({
      key: "manyLosingDays",
      tool: "lossLock",
      values: { losingDays: 5, activeDays: 10, worstDay: -1 },
    });
    expect(card(daysOf(5, 6)).findings.map((f) => f.key)).not.toContain("manyLosingDays");
    expect(card(daysOf(4, 0)).findings.map((f) => f.key)).not.toContain("manyLosingDays");
  });
});

describe("findings", () => {
  it("come in a fixed order, each naming its tool and never a market", () => {
    const fills = [
      ...Array.from({ length: 12 }, (_, i) => trip({ at: D0 + i * DAY, exit: 99, fee: "5", crossed: true })).flat(),
      fill({ coin: "ETH", side: "B", px: "2000", sz: "1", time: D0 + 20 * DAY, crossed: true }),
      fill({
        coin: "ETH",
        side: "A",
        px: "1900",
        sz: "1",
        time: D0 + 21 * DAY,
        startPosition: "1",
        closedPnl: "-100",
        crossed: true,
        liquidation: { liquidatedUser: ME, markPx: "1900", method: "market" },
      }),
    ];
    const c = card(fills, { states: [state(position("BTC", "1", "100", "95"))] });
    // Liquidations first, the fee findings last.
    expect(c.findings.map((f) => [f.key, f.tool])).toEqual([
      ["liquidated", "guardians"],
      ["nearLiquidation", "guardians"],
      ["manyLosingDays", "lossLock"],
      ["feesBiggestCost", "limitOrders"],
      ["highTakerShare", "limitOrders"],
    ]);
    expect(JSON.stringify(c.findings)).not.toMatch(/BTC|ETH/);
  });
});

describe("findings: the whole order", () => {
  it("puts liquidations first, then the habits and losing days, and the fee findings last", () => {
    // Each day: a loser held 3 h, a bigger winner opened an hour after it, and a normal winner; every fill a taker.
    const daysOf = Array.from({ length: 12 }, (_, i) => [
      ...trip({ at: D0 + i * DAY, hold: 3 * HOUR, exit: 99, fee: "5", crossed: true }),
      ...trip({ at: D0 + i * DAY + 4 * HOUR, sz: 3, exit: 100.5, fee: "0.1", crossed: true }),
      ...trip({ at: D0 + i * DAY + 12 * HOUR, exit: 100.2, fee: "0.05", crossed: true }),
    ]).flat();
    const liquidated = [
      fill({ coin: "ETH", side: "B", px: "2000", sz: "1", time: D0 + 20 * DAY, crossed: true }),
      fill({
        coin: "ETH",
        side: "A",
        px: "1900",
        sz: "1",
        time: D0 + 21 * DAY,
        startPosition: "1",
        closedPnl: "-100",
        crossed: true,
        liquidation: { liquidatedUser: ME, markPx: "1900", method: "market" },
      }),
    ];
    const c = card([...daysOf, ...liquidated], { states: [state(position("BTC", "1", "100", "95"))] });
    expect(c.costs.biggest).toBe("fees");
    expect(c.findings.map((f) => f.key)).toEqual([
      "liquidated",
      "nearLiquidation",
      "sizeUpAfterLoss",
      "holdLosersLonger",
      "manyLosingDays",
      "feesBiggestCost",
      "highTakerShare",
    ]);
    expect([...FEE_FINDINGS].sort()).toEqual(["feesBiggestCost", "highTakerShare"]);
  });
});

describe("stop-losses at a liquidation", () => {
  // Shapes as Hyperliquid answers them (mainnet, November 2026), the address left out: a whole-position stop market
  // cancelled at a liquidation, a stop that triggered (its later entries read isTrigger false, "Triggered"), a
  // trailing stop, a take profit, and a liquidation's own order under the fill's oid.
  const L = D0 + 5 * HOUR;
  let oid = 700_000_000_000;
  function order(o: Partial<ReportOrder> & Pick<ReportOrder, "coin" | "side" | "timestamp">): ReportOrder {
    return {
      oid: ++oid,
      isTrigger: false,
      orderType: "Limit",
      triggerPx: "0.0",
      triggerCondition: "N/A",
      reduceOnly: false,
      tif: "Gtc",
      ...o,
    };
  }
  const stop = (o: Partial<ReportOrder> & Pick<ReportOrder, "timestamp">) =>
    order({
      coin: "ETH",
      side: "A",
      isTrigger: true,
      orderType: "Stop Market",
      triggerPx: "1900.0",
      triggerCondition: "Price below 1900",
      reduceOnly: true,
      tif: null,
      ...o,
    });
  const status = (o: ReportOrder, s: string, at: number): ReportOrderStatus => ({
    order: o,
    status: s,
    statusTimestamp: at,
  });
  /** An order that rested: "open" at its placement, then its last status. */
  const rested = (o: ReportOrder, s: string, at: number) => [status(o, s, at), status(o, "open", o.timestamp)];
  /** Newest status first, as Hyperliquid answers. */
  const history = (...entries: ReportOrderStatus[][]) =>
    entries.flat().sort((a, b) => b.statusTimestamp - a.statusTimestamp);

  /** A long opened a day before `at`, then liquidated by one order per step (sizes in `steps`) from `at`. */
  function longLiquidated(coin: string, at: number, steps: number[], o: { oid?: number; method?: string } = {}) {
    const total = steps.reduce((s, x) => s + x, 0);
    const opening = fill({ coin, side: "B", px: "2000", sz: String(total), time: at - DAY });
    let left = total;
    const liqs = steps.map((sz, i) => {
      const f = fill({
        coin,
        side: "A",
        px: "1800",
        sz: String(sz),
        time: at + i * 30_000,
        oid: (o.oid ?? 600_000_000_000 + seq) + i,
        startPosition: String(left),
        dir: "Close Long",
        closedPnl: String(-200 * sz),
        crossed: true,
        liquidation: { liquidatedUser: ME, markPx: "1800", method: o.method ?? "market" },
      });
      left -= sz;
      return f;
    });
    return { fills: [opening, ...liqs], liqs };
  }
  /** The liquidations' own orders, as the history holds them (filled at their fill's time). */
  const own = (liqs: ReportFill[]) =>
    liqs.map((f) =>
      status(
        order({
          coin: f.coin,
          side: f.side,
          timestamp: f.time,
          oid: f.oid,
          orderType: "Market",
          tif: "LiquidationMarket",
        }),
        "filled",
        f.time,
      ),
    );
  /** An old fill of the account's, so that the history's oldest status is long before the liquidations. */
  const oldest = [status(order({ coin: "BTC", side: "B", timestamp: D0 - 40 * DAY }), "filled", D0 - 40 * DAY)];
  const check = (fills: ReportFill[], h: ReportOrderStatus[] | null, open: ReportOrder[] | null = []) =>
    stopsAtLiquidations(fills, ME, FROM, {
      history: h,
      open: Object.fromEntries(liquidatedPositions(fills, ME).map((p) => [dexOf(p.coin), open])),
    });

  it("finds a stop-loss resting at the liquidation, cancelled by it", () => {
    const eth = longLiquidated("ETH", L, [2]);
    const s = stop({ timestamp: L - DAY });
    expect(check(eth.fills, history(rested(s, "liquidatedCanceled", L), own(eth.liqs), oldest))).toEqual({
      state: "checked",
      withStop: 1,
      positions: 1,
      dexes: 1,
    });
    // Still open now (only its placement in the history, or only in the open orders): it rested then too.
    expect(check(eth.fills, history([status(s, "open", s.timestamp)], own(eth.liqs), oldest))).toMatchObject({
      withStop: 1,
    });
    const old = stop({ timestamp: L - 300 * DAY });
    expect(check(eth.fills, history(own(eth.liqs), oldest), [old])).toMatchObject({ withStop: 1 });
  });

  it("finds a stop limit that triggered but never filled, though its later entries say isTrigger false", () => {
    const eth = longLiquidated("ETH", L, [1]);
    const limit = stop({ timestamp: L - HOUR, orderType: "Stop Limit", triggerCondition: "Price below 1890" });
    const triggered = { ...limit, isTrigger: false, triggerCondition: "Triggered" };
    const h = history(
      [
        status(triggered, "liquidatedCanceled", L),
        status(limit, "triggered", L - 60_000),
        status(limit, "open", limit.timestamp),
      ],
      own(eth.liqs),
      oldest,
    );
    expect(check(eth.fills, h)).toMatchObject({ state: "checked", withStop: 1 });
    // A stop market without the isTrigger field: its type says it.
    const bare = { ...stop({ timestamp: L - HOUR }), isTrigger: undefined };
    expect(check(eth.fills, history(rested(bare, "liquidatedCanceled", L), own(eth.liqs), oldest))).toMatchObject({
      withStop: 1,
    });
    // An order whose kind nothing tells: no claim.
    const unknown = {
      ...order({ coin: "ETH", side: "A", timestamp: L - HOUR }),
      isTrigger: undefined,
      orderType: undefined,
    };
    expect(check(eth.fills, history(rested(unknown, "liquidatedCanceled", L), own(eth.liqs), oldest))).toMatchObject({
      state: "unclear",
    });
  });

  it("counts a position liquidated in two steps once, with the stop the first step cancelled", () => {
    // 5 ETH long: one step closes 1, a second 30 s later the other 4; the stop goes at the first.
    const eth = longLiquidated("ETH", L, [1, 4]);
    expect(liquidatedPositions(eth.fills, ME)).toEqual([
      { coin: "ETH", side: "A", time: L, oids: eth.liqs.map((f) => f.oid), opened: { kind: "at", at: L - DAY } },
    ]);
    const s = stop({ timestamp: L - DAY });
    expect(check(eth.fills, history(rested(s, "liquidatedCanceled", L), own(eth.liqs), oldest))).toEqual({
      state: "checked",
      withStop: 1,
      positions: 1,
      dexes: 1,
    });
    // A market liquidation and then the backstop that took the rest: one position too.
    const backstop = longLiquidated("ETH", L, [2, 3]);
    backstop.liqs[1]!.dir = "Liquidated Isolated Long";
    expect(liquidatedPositions(backstop.fills, ME)).toHaveLength(1);
    // Flat between two liquidations, or another fill between them: two positions.
    const two = [...longLiquidated("ETH", L, [1]).fills, ...longLiquidated("ETH", L + 3 * DAY, [1]).fills];
    expect(liquidatedPositions(two, ME)).toHaveLength(2);
    const card1 = card([...eth.fills], { orders: { history: history(own(eth.liqs), oldest), open: { "": [] } } });
    expect(card1.liquidations).toMatchObject({
      count: 2,
      stops: { state: "checked", withStop: 0, positions: 1, dexes: 1 },
    });
    expect(card1.findings[0]).toMatchObject({ key: "liquidated", values: { count: 2, positions: 1, withStop: 0 } });
  });

  it("counts a stop that a cross liquidation of another market cancelled earlier, while the position was open", () => {
    // ETH is liquidated at L, which cancels every order of the account, BTC's stop too; BTC is liquidated at L + 1 h.
    const eth = longLiquidated("ETH", L, [1]);
    const btc = longLiquidated("BTC", L + HOUR, [1]);
    const btcStop = stop({ coin: "BTC", timestamp: L - DAY, triggerCondition: "Price below 1900" });
    const fills = [...eth.fills, ...btc.fills];
    const h = history(rested(btcStop, "liquidatedCanceled", L), own(eth.liqs), own(btc.liqs), oldest);
    expect(check(fills, h)).toEqual({ state: "checked", withStop: 1, positions: 2, dexes: 1 });
    // The BTC position opened after the ETH liquidation: that stop wasn't its own.
    const late = longLiquidated("BTC", L + 3 * DAY, [1]);
    const lateFills = [...eth.fills, ...late.fills];
    expect(
      check(lateFills, history(rested(btcStop, "liquidatedCanceled", L), own(eth.liqs), own(late.liqs), oldest)),
    ).toEqual({
      state: "checked",
      withStop: 0,
      positions: 2,
      dexes: 1,
    });
    // Cancelled by a liquidation before the window, the position already open at its start: it can't be tied.
    const carried = fill({ ...btc.liqs[0]!, tid: 99_999, oid: 99_999, time: FROM + HOUR });
    const before = stop({ coin: "BTC", timestamp: FROM - 3 * DAY });
    expect(
      check(
        [carried],
        history(rested(before, "liquidatedCanceled", FROM - DAY), own([carried]), [
          status(order({ coin: "BTC", side: "B", timestamp: FROM - 40 * DAY }), "filled", FROM - 40 * DAY),
        ]),
      ),
    ).toMatchObject({ state: "unclear" });
  });

  it("finds none when the stop came after, was cancelled before, or is on another market or side", () => {
    const eth = longLiquidated("ETH", L, [1]);
    const after = stop({ timestamp: L + 1 });
    const before = stop({ timestamp: L - DAY });
    const btc = stop({ timestamp: L - DAY, coin: "BTC" });
    const adds = stop({ timestamp: L - DAY, side: "B", triggerCondition: "Price above 2100" });
    const limit = order({ coin: "ETH", side: "A", timestamp: L - DAY, reduceOnly: true });
    expect(
      check(
        eth.fills,
        history(
          rested(after, "reduceOnlyCanceled", L + 2),
          rested(before, "canceled", L - 1),
          rested(btc, "liquidatedCanceled", L),
          rested(adds, "liquidatedCanceled", L),
          rested(limit, "liquidatedCanceled", L),
          own(eth.liqs),
          oldest,
        ),
      ),
    ).toEqual({ state: "checked", withStop: 0, positions: 1, dexes: 1 });
  });

  it("never counts a take profit, and reads the direction for a short too", () => {
    const eth = longLiquidated("ETH", L, [1]);
    const tpAbove = stop({ timestamp: L - DAY, orderType: "Take Profit Market", triggerCondition: "Price above 2400" });
    expect(check(eth.fills, history(rested(tpAbove, "liquidatedCanceled", L), own(eth.liqs), oldest))).toMatchObject({
      state: "checked",
      withStop: 0,
    });
    const tpBare = stop({ timestamp: L - DAY, orderType: "Take Profit Limit", triggerCondition: undefined });
    expect(check(eth.fills, history(rested(tpBare, "liquidatedCanceled", L), own(eth.liqs), oldest))).toMatchObject({
      withStop: 0,
    });
    // A short on a HIP-3 market: a buy stop above.
    const open = fill({ coin: "xyz:NVDA", side: "A", px: "150", sz: "10", time: L - DAY });
    const liq = fill({
      coin: "xyz:NVDA",
      side: "B",
      px: "165",
      sz: "10",
      time: L,
      oid: 610583241230,
      startPosition: "-10",
      closedPnl: "-150",
      liquidation: { liquidatedUser: ME, markPx: "165", method: "market" },
    });
    const shortStop = stop({ coin: "xyz:NVDA", side: "B", timestamp: L - DAY, triggerCondition: "Price above 160" });
    const shortTp = stop({
      coin: "xyz:NVDA",
      side: "B",
      timestamp: L - DAY,
      orderType: "Take Profit Market",
      triggerCondition: "Price below 120",
    });
    expect(check([open, liq], history(rested(shortStop, "liquidatedCanceled", L), own([liq]), oldest))).toMatchObject({
      withStop: 1,
    });
    expect(check([open, liq], history(rested(shortTp, "liquidatedCanceled", L), own([liq]), oldest))).toMatchObject({
      withStop: 0,
    });
    expect(triggerKind(stop({ timestamp: 0, orderType: "Stop Market", triggerCondition: undefined }))).toBe("stop");
  });

  it("says nothing when an order resting then can’t be told apart", () => {
    const eth = longLiquidated("ETH", L, [1]);
    const trailing = stop({
      timestamp: L - DAY,
      orderType: "Trailing Stop Market",
      triggerCondition: "Activation above 0.3, retracement 5%",
      reduceOnly: false,
    });
    expect(check(eth.fills, history(rested(trailing, "liquidatedCanceled", L), own(eth.liqs), oldest))).toEqual({
      state: "unclear",
      withStop: null,
      positions: 1,
      dexes: 1,
    });
    // A plain stop next to it settles that position.
    const s = stop({ timestamp: L - DAY });
    expect(
      check(
        eth.fills,
        history(rested(trailing, "liquidatedCanceled", L), rested(s, "liquidatedCanceled", L), own(eth.liqs), oldest),
      ),
    ).toMatchObject({ state: "checked", withStop: 1 });
  });

  it("claims nothing unless the history holds each liquidation and reaches back past it", () => {
    const eth = longLiquidated("ETH", L, [1]);
    const full = (from: number) =>
      history(
        own(eth.liqs),
        Array.from({ length: HL_ORDER_HISTORY - 1 }, (_, i) =>
          status(order({ coin: "BTC", side: "B", timestamp: from + i }), "filled", from + i),
        ),
      );
    const none = { state: "incomplete", withStop: null, positions: 1, dexes: 1 };
    // An empty answer, or one without the liquidation's own order (or with its market spelt otherwise): no claim.
    expect(check(eth.fills, [])).toEqual(none);
    expect(check(eth.fills, history(oldest))).toEqual(none);
    const respelt = own(eth.liqs).map((h) => ({ ...h, order: { ...h.order, coin: "ETH-PERP" } }));
    expect(check(eth.fills, history(respelt, oldest))).toEqual(none);
    // A short answer whose oldest status is the liquidation itself, or after it: no claim.
    expect(check(eth.fills, history(own(eth.liqs)))).toEqual(none);
    // A full answer whose oldest status is after the liquidation, or at it: an order resting then may be missing.
    expect(check(eth.fills, full(L + 1))).toEqual(none);
    expect(check(eth.fills, full(L))).toEqual(none);
    // Its oldest before the liquidation: everything after is there.
    expect(check(eth.fills, full(L - 1))).toEqual({ state: "checked", withStop: 0, positions: 1, dexes: 1 });
    // Not newest first: a full answer vouches for nothing.
    const shuffled = full(L - 1);
    [shuffled[0], shuffled[1]] = [shuffled[1]!, shuffled[0]!];
    expect(check(eth.fills, shuffled)).toEqual(none);
    // Two positions, the history reaching back past only the later one.
    const early = longLiquidated("BTC", L - 10 * DAY, [1]);
    const both = [...early.fills, ...eth.fills];
    expect(check(both, history(full(L - DAY), own(early.liqs)).slice(0, HL_ORDER_HISTORY))).toMatchObject({
      state: "incomplete",
    });
  });

  it("counts a stop that fired before the liquidation, though it closed only part of the position", () => {
    // 10 ETH long; the stop triggers in a crash an hour before and its market order fills 2; the rest is liquidated.
    const opening = fill({ coin: "ETH", side: "B", px: "2000", sz: "10", time: L - DAY });
    const s = stop({ timestamp: L - 2 * DAY });
    const stopFill = fill({
      coin: "ETH",
      side: "A",
      px: "1890",
      sz: "2",
      time: L - HOUR,
      oid: s.oid,
      startPosition: "10",
    });
    const liq = fill({
      coin: "ETH",
      side: "A",
      px: "1800",
      sz: "8",
      time: L,
      oid: 600_100_000_001,
      startPosition: "8",
      closedPnl: "-1600",
      liquidation: { liquidatedUser: ME, markPx: "1800", method: "market" },
    });
    const done = { ...s, isTrigger: false, triggerCondition: "Triggered", tif: "Gtc" };
    const fired = [status(done, "filled", L - HOUR), status(s, "triggered", L - HOUR), status(s, "open", s.timestamp)];
    const fills = [opening, stopFill, liq];
    expect(check(fills, history(fired, own([liq]), oldest))).toEqual({
      state: "checked",
      withStop: 1,
      positions: 1,
      dexes: 1,
    });
    // A stop for 5 of the 10 that filled whole, the other 5 liquidated: set, and it fired.
    const half = { ...s, oid: s.oid + 1 };
    const halfFill = fill({ ...stopFill, tid: 77_001, oid: half.oid, sz: "5" });
    const rest = fill({ ...liq, tid: 77_002, sz: "5", startPosition: "5" });
    expect(
      check(
        [opening, halfFill, rest],
        history(
          [status({ ...half, isTrigger: false }, "filled", L - HOUR), status(half, "open", half.timestamp)],
          own([rest]),
          oldest,
        ),
      ),
    ).toMatchObject({ state: "checked", withStop: 1 });
    // A stop that fired and closed the whole of an earlier position: not this one's.
    const earlier = fill({
      coin: "ETH",
      side: "A",
      px: "1890",
      sz: "10",
      time: L - 2 * HOUR,
      oid: s.oid,
      startPosition: "10",
    });
    const reopen = fill({ coin: "ETH", side: "B", px: "1850", sz: "8", time: L - HOUR });
    const firedEarlier = [
      status(done, "filled", L - 2 * HOUR),
      status(s, "triggered", L - 2 * HOUR),
      status(s, "open", s.timestamp),
    ];
    expect(check([opening, earlier, reopen, liq], history(firedEarlier, own([liq]), oldest))).toMatchObject({
      state: "checked",
      withStop: 0,
    });
  });

  it("says nothing about a stop the exchange cancelled another way while the position was open", () => {
    const eth = longLiquidated("ETH", L, [1]);
    const s = stop({ timestamp: L - 2 * DAY });
    for (const reason of ["marginCanceled", "reduceOnlyCanceled", "siblingFilledCanceled"])
      expect(check(eth.fills, history(rested(s, reason, L - HOUR), own(eth.liqs), oldest))).toMatchObject({
        state: "unclear",
      });
    // The trader cancelled it: not counted, and nothing unclear. Rejected when placed: it never rested.
    expect(check(eth.fills, history(rested(s, "canceled", L - HOUR), own(eth.liqs), oldest))).toMatchObject({
      state: "checked",
      withStop: 0,
    });
    const rejected = stop({ timestamp: L - 2 * DAY });
    expect(
      check(eth.fills, history([status(rejected, "badTriggerPxRejected", rejected.timestamp)], own(eth.liqs), oldest)),
    ).toMatchObject({ state: "checked", withStop: 0 });
  });

  it("keeps one position across an add between two liquidation steps", () => {
    const eth = longLiquidated("ETH", L, [1, 4]);
    const add = fill({ coin: "ETH", side: "B", px: "1810", sz: "2", time: L + 10_000, startPosition: "4" });
    // The second step now starts from 6.
    const second = { ...eth.liqs[1]!, startPosition: "6", sz: "6" };
    const fills = [eth.fills[0]!, eth.liqs[0]!, add, second];
    expect(liquidatedPositions(fills, ME).map((p) => p.oids)).toEqual([[eth.liqs[0]!.oid, second.oid]]);
    const s = stop({ timestamp: L - DAY });
    expect(check(fills, history(rested(s, "liquidatedCanceled", L), own(eth.liqs), oldest))).toMatchObject({
      withStop: 1,
      positions: 1,
    });
  });

  it("says nothing when a fill without its start position hides whether the position was the same", () => {
    // BTC's stop cancelled at the ETH liquidation; a BTC sell between then and BTC's liquidation lacks startPosition.
    const eth = longLiquidated("ETH", L, [1]);
    const btc = longLiquidated("BTC", L + 2 * HOUR, [1]);
    const blind = fill({ coin: "BTC", side: "A", px: "1900", sz: "0.5", time: L + HOUR, startPosition: undefined });
    const btcLiq = { ...btc.liqs[0]!, startPosition: "0.5", sz: "0.5" };
    const btcStop = stop({ coin: "BTC", timestamp: L - DAY });
    const fills = [...eth.fills, btc.fills[0]!, blind, btcLiq];
    expect(
      check(fills, history(rested(btcStop, "liquidatedCanceled", L), own(eth.liqs), own([btcLiq]), oldest)),
    ).toMatchObject({ state: "unclear" });
    // And a liquidation fill without its start position ends the position there.
    const unknownStep = { ...eth.liqs[0]!, startPosition: undefined };
    const next = fill({ ...eth.liqs[0]!, tid: 88_001, oid: 600_200_000_001, time: L + 30_000, startPosition: "1" });
    expect(liquidatedPositions([eth.fills[0]!, unknownStep, next], ME)).toHaveLength(2);
  });

  it("says it skipped the check when the liquidations were on too many dexes", () => {
    const eth = longLiquidated("ETH", L, [1]);
    expect(stopsAtLiquidations(eth.fills, ME, FROM, { history: null, open: {}, skipped: true })).toEqual({
      state: "skipped",
      withStop: null,
      positions: 1,
      dexes: 1,
    });
  });

  it("stays quick on a heavy account: one pass over the fills, then a lookup per order", () => {
    // 120 positions on one market, each opened, traded ~165 times and liquidated; 900 stops, each cancelled by an
    // earlier liquidation; about 20,000 fills.
    const fills: ReportFill[] = [];
    const statuses: ReportOrderStatus[] = [];
    const liqs: ReportFill[] = [];
    let t = FROM + HOUR;
    for (let i = 0; i < 120; i++) {
      fills.push(fill({ coin: "BTC", side: "B", px: "100", sz: "10", time: (t += 1000) }));
      let pos = 10;
      for (let j = 0; j < 165; j++) {
        const buy = j % 2 === 0;
        fills.push(
          fill({
            coin: "BTC",
            side: buy ? "B" : "A",
            px: "100",
            sz: "1",
            time: (t += 1000),
            startPosition: String(pos),
          }),
        );
        pos += buy ? 1 : -1;
      }
      const liq = fill({
        coin: "BTC",
        side: "A",
        px: "90",
        sz: String(pos),
        time: (t += 1000),
        startPosition: String(pos),
        closedPnl: "-100",
        liquidation: { liquidatedUser: ME, markPx: "90", method: "market" },
      });
      fills.push(liq);
      liqs.push(liq);
    }
    for (let k = 0; k < 900; k++) {
      const s = stop({ coin: "BTC", timestamp: FROM + k });
      const at = liqs[Math.floor((k / 900) * 119)]!.time;
      statuses.push(...rested(s, "liquidatedCanceled", at));
    }
    const h = history(statuses, own(liqs), oldest);
    const started = performance.now();
    const result = check(fills, h);
    const took = performance.now() - started;
    expect(fills.length).toBeGreaterThan(20_000);
    expect(result).toMatchObject({ state: "checked", positions: 120 });
    // It took 2.7 s when every order rescanned every fill; a generous bound for a slow machine.
    expect(took).toBeLessThan(1500);
  });

  it("counts a stop that fired and was then rejected; says nothing for one rejected after resting without firing", () => {
    const eth = longLiquidated("ETH", L, [1]);
    const s = stop({ timestamp: L - DAY });
    const after = { ...s, isTrigger: false, triggerCondition: "Triggered", tif: "FrontendMarket" };
    // A thin crash: the stop triggers, its market order is rejected, and the position is then liquidated.
    for (const reason of ["iocCancelRejected", "marketOrderNoLiquidityRejected", "perpMarginRejected"]) {
      const h = history(
        [status(after, reason, L - HOUR), status(s, "triggered", L - HOUR), status(s, "open", s.timestamp)],
        own(eth.liqs),
        oldest,
      );
      expect(check(eth.fills, h), reason).toMatchObject({ state: "checked", withStop: 1 });
    }
    // Rested a day, then rejected on margin without firing: it can't be told.
    expect(check(eth.fills, history(rested(s, "perpMarginRejected", L - HOUR), own(eth.liqs), oldest))).toMatchObject({
      state: "unclear",
    });
  });

  it("says nothing for a stop that closed the old position in the very millisecond a new one opened", () => {
    const opening = fill({ coin: "ETH", side: "B", px: "2000", sz: "10", time: L - DAY });
    const s = stop({ timestamp: L - 2 * DAY });
    const closeAll = fill({
      coin: "ETH",
      side: "A",
      px: "1890",
      sz: "10",
      time: L - HOUR,
      oid: s.oid,
      startPosition: "10",
    });
    const reopen = fill({ coin: "ETH", side: "B", px: "1890", sz: "8", time: L - HOUR, startPosition: "0" });
    const liq = fill({
      coin: "ETH",
      side: "A",
      px: "1800",
      sz: "8",
      time: L,
      oid: 600_300_000_001,
      startPosition: "8",
      closedPnl: "-720",
      liquidation: { liquidatedUser: ME, markPx: "1800", method: "market" },
    });
    const done = { ...s, isTrigger: false, triggerCondition: "Triggered" };
    const h = history(
      [status(done, "filled", L - HOUR), status(s, "triggered", L - HOUR), status(s, "open", s.timestamp)],
      own([liq]),
      oldest,
    );
    expect(check([opening, closeAll, reopen, liq], h)).toMatchObject({ state: "unclear" });
  });

  it("ties no earlier stop to a position whose opening an unread gap may hide", () => {
    // ETH's liquidation a day into the window cancels BTC's stop; BTC was opened in a gap the card couldn't read.
    const ethAt = FROM + DAY;
    const eth = longLiquidated("ETH", ethAt, [1]);
    const btcLiq = fill({
      coin: "BTC",
      side: "A",
      px: "1800",
      sz: "1",
      time: FROM + 4 * DAY,
      oid: 600_400_000_001,
      startPosition: "1",
      closedPnl: "-200",
      liquidation: { liquidatedUser: ME, markPx: "1800", method: "market" },
    });
    const btcStop = stop({ coin: "BTC", timestamp: FROM - DAY });
    const h = history(rested(btcStop, "liquidatedCanceled", ethAt), own(eth.liqs), own([btcLiq]), oldest);
    const fills = [...eth.fills, btcLiq];
    const open = { "": [] };
    // Without the gap, BTC was carried in and held since the window start: the stop counts.
    expect(stopsAtLiquidations(fills, ME, FROM, { history: h, open })).toMatchObject({ withStop: 1 });
    const gap: [number, number][] = [[FROM + 3 * DAY - HOUR, FROM + 3 * DAY + HOUR]];
    expect(stopsAtLiquidations(fills, ME, FROM, { history: h, open }, gap)).toMatchObject({ state: "unclear" });
    // A gap between two of BTC's fills whose start positions still match: the same.
    const btcOpen = fill({ coin: "BTC", side: "B", px: "2000", sz: "1", time: FROM + HOUR });
    const both = [...eth.fills, btcOpen, btcLiq];
    expect(stopsAtLiquidations(both, ME, FROM, { history: h, open })).toMatchObject({ withStop: 1 });
    expect(stopsAtLiquidations(both, ME, FROM, { history: h, open }, gap)).toMatchObject({ state: "unclear" });
    // And a gap between two liquidation steps ends the position.
    const steps = longLiquidated("ETH", FROM + 5 * DAY, [1, 4]);
    expect(
      liquidatedPositions(steps.fills, ME, [[FROM + 5 * DAY + 10_000, FROM + 5 * DAY + 20_000]], FROM),
    ).toHaveLength(2);
  });

  it("claims nothing when a read failed", () => {
    const eth = longLiquidated("ETH", L, [1]);
    const h = history(own(eth.liqs), oldest);
    expect(check(eth.fills, null)).toEqual({ state: "unread", withStop: null, positions: 1, dexes: 1 });
    expect(check(eth.fills, h, null)).toMatchObject({ state: "unread" });
    expect(stopsAtLiquidations(eth.fills, ME, FROM, null)).toMatchObject({ state: "unread" });
    // A dex a liquidation was on that wasn't read.
    expect(stopsAtLiquidations(eth.fills, ME, FROM, { history: h, open: { xyz: [] } })).toMatchObject({
      state: "unread",
    });
    expect(stopsAtLiquidations([], ME, FROM, { history: h, open: {} })).toBeNull();
  });
});

describe("windows", () => {
  const OCT = monthWindow("2026-10");
  const NOV = monthWindow("2026-11");

  it("names a UTC calendar month, from its first millisecond through its last", () => {
    expect(OCT).toEqual({ from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 10, 1) - 1 });
    expect(monthWindow("2026-12")).toEqual({ from: Date.UTC(2026, 11, 1), to: Date.UTC(2027, 0, 1) - 1 });
    expect(monthWindow("2028-02").to).toBe(Date.UTC(2028, 1, 29, 23, 59, 59, 999));
    for (const bad of ["2026-13", "2026-00", "2026-1", "26-10", "2026-10-01", "0999-01", " 2026-10", ""]) {
      expect(isMonthKey(bad)).toBe(false);
      expect(() => monthWindow(bad)).toThrow(RangeError);
    }
    expect(isMonthKey("2026-10")).toBe(true);
    expect(monthKey(OCT.from)).toBe("2026-10");
    expect(monthKey(OCT.to)).toBe("2026-10");
    expect(monthKey(OCT.to + 1)).toBe("2026-11");
  });

  it("defaults to the last 30 days, the same card as that window given", () => {
    expect(lastDaysWindow(NOW)).toEqual({ from: FROM, to: NOW });
    expect(reportWindow(NOW)).toEqual({ from: FROM, to: NOW, live: true });
    const fills = [...trip({ at: D0, exit: 110 }), ...trip({ at: D0 + DAY, exit: 90 })];
    const input = {
      portfolio: portfolio([
        [FROM, "0"],
        [NOW, "0"],
      ]),
      states: [state(position("ETH", "1", "2000", "1900"))],
    };
    const plain = card(fills, input);
    expect(plain.live).toBe(true);
    expect(card(fills, { ...input, window: lastDaysWindow(NOW) })).toEqual(plain);
  });

  it("covers a past month alone, without the positions open now or Hyperliquid's 30-day figure", () => {
    const now = Date.UTC(2026, 10, 3, 9, 0);
    const c = buildReportCard({
      address: ME,
      now,
      window: OCT,
      fills: [
        ...trip({ at: Date.UTC(2026, 8, 30, 23), hold: 2 * HOUR, exit: 150 }), // closed on Oct 1, opened in September
        ...trip({ at: Date.UTC(2026, 9, 10), exit: 120, fee: "1" }),
        ...trip({ at: Date.UTC(2026, 9, 31, 23), hold: 2 * HOUR, exit: 80 }), // still open when October ended
        ...trip({ at: Date.UTC(2026, 10, 2), exit: 500 }), // November
      ],
      funding: {
        rows: [fund(Date.UTC(2026, 9, 10, 0, 30), "BTC", "-2"), fund(Date.UTC(2026, 10, 2, 0, 30), "BTC", "-9")],
        from: OCT.from,
        through: OCT.to,
        complete: true,
      },
      portfolio: portfolio([
        [now - 30 * DAY, "0"],
        [now, "400"],
      ]),
      // A position open now, near liquidation, that no fill in October touched.
      states: [state(position("ETH", "1", "2000", "1950", "-40"))],
    });
    expect(c.live).toBe(false);
    expect(c.coverage).toMatchObject({ from: OCT.from, to: OCT.to, fills: 4, complete: true });
    // Oct 1's close counts its price result (it opened before), October's own trip counts whole, the last one only
    // its opening; November's is left out.
    expect(c.result.price.usd).toBe("70");
    expect(c.result.fees.usd).toBe("2");
    expect(c.result.funding.usd).toBe("-2");
    expect(c.result.net.usd).toBe("66");
    expect(c.trips.closed).toBe(1);
    expect(c.trips.leftOut).toEqual({ carriedIn: 1, open: 1, gaps: 0 });
    expect(c.rows.dayTrips).toHaveLength(2);
    // Now's positions and Hyperliquid's figure describe today, not October.
    expect(c.liquidations).toMatchObject({ open: [], positionsRead: false, nearest: null });
    expect(c.result.hyperliquid).toBeNull();
    expect(c.result.difference).toBeNull();
    expect(c.findings.map((f) => f.key)).not.toContain("nearLiquidation");
    // Funding that stops before the month's end leaves it incomplete.
    const short = buildReportCard({
      address: ME,
      now,
      window: OCT,
      fills: [],
      funding: { rows: [], from: OCT.from, through: OCT.to - DAY, complete: false },
    });
    expect(short.coverage).toMatchObject({ complete: false, funding: { through: OCT.to - DAY, complete: false } });
  });

  it("stops a month still under way at now, and compares it with Hyperliquid's figure from the month's start", () => {
    const c = card(trip({ at: Date.UTC(2026, 10, 5), exit: 110 }), {
      window: NOV,
      funding: { rows: [], from: NOV.from, through: NOW, complete: true },
      portfolio: portfolio([
        [FROM, "0"],
        [NOV.from - HOUR, "50"],
        [NOW, "60"],
      ]),
      states: [state(position("ETH", "1", "2000", "1900"))],
    });
    expect(reportWindow(NOW, NOV)).toEqual({ from: NOV.from, to: NOW, live: true });
    expect(c.live).toBe(true);
    expect(c.coverage).toMatchObject({ from: NOV.from, to: NOW, fills: 2, complete: true });
    expect(c.result.net.usd).toBe("10");
    expect(c.result.hyperliquid).toMatchObject({ from: NOV.from - HOUR, to: NOW, pnl: "10", beforeWindow: true });
    expect(c.liquidations).toMatchObject({ positionsRead: true, open: [{ coin: "ETH" }] });
    expect(c.findings.map((f) => f.key)).toContain("nearLiquidation");
  });

  it("is incomplete for a month before the record's coverage that no read covered", () => {
    const now = Date.UTC(2026, 10, 21);
    // The record starts on Sep 20: September before it was read from nowhere, August not at all.
    const recordFrom = Date.UTC(2026, 8, 20);
    const sep = monthWindow("2026-09");
    const partly = buildReportCard({
      address: ME,
      now,
      window: sep,
      fills: trip({ at: Date.UTC(2026, 8, 25), exit: 101 }),
      unfilledGaps: [[sep.from - 40 * DAY, recordFrom - 1]],
      funding: { rows: [], from: sep.from, through: sep.to, complete: true },
    });
    expect(partly.coverage).toMatchObject({
      fillsComplete: false,
      complete: false,
      unfilledGaps: [[sep.from, recordFrom - 1]],
    });
    const aug = monthWindow("2026-08");
    const before = buildReportCard({
      address: ME,
      now,
      window: aug,
      fills: [],
      unfilledGaps: [[aug.from, aug.to]],
      funding: { rows: [], from: aug.from, through: aug.to, complete: true },
    });
    expect(before.coverage).toMatchObject({ fills: 0, fillsComplete: false, unfilledGaps: [[aug.from, aug.to]] });
    expect(before.live).toBe(false);
  });

  it("is empty for a month that hasn't started, without the positions open now", () => {
    const dec = monthWindow("2026-12");
    expect(reportWindow(NOW, dec)).toMatchObject({ from: dec.from, live: false });
    const c = card(trip({ at: NOW - DAY }), {
      window: dec,
      states: [state(position("ETH", "1", "2000", "1950", "-40"))],
    });
    expect(c.live).toBe(false);
    expect(c.coverage.fills).toBe(0);
    expect(c.trips.closed).toBe(0);
    expect(c.liquidations).toMatchObject({ open: [], positionsRead: false });
    expect(c.findings.map((f) => f.key)).not.toContain("nearLiquidation");
  });
});
