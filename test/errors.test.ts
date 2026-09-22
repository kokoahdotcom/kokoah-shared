import { describe, expect, it } from "vitest";
import { HL_ERROR_CATALOG, mapHlError, mapOrderStatus, parseExchangeResponse } from "../src/errors/index.js";

describe("mapHlError (FRONTEND_SPEC §9.10 + HL error table)", () => {
  it.each([
    ["Price must be divisible by tick size.", "TICK_SIZE", "Tick"],
    ["Order must have minimum value of $10.", "MIN_TRADE_NOTIONAL", "MinTradeNtl"],
    ["Order 0: Order must have minimum value of $10.", "MIN_TRADE_NOTIONAL", "MinTradeNtl"],
    ["Order must have minimum value of 10 USDC.", "MIN_TRADE_SPOT_NOTIONAL", "MinTradeSpotNtl"],
    ["Insufficient margin to place order.", "INSUFFICIENT_MARGIN", "PerpMargin"],
    ["Reduce only order would increase position.", "REDUCE_ONLY", "ReduceOnly"],
    ["Post only order would have immediately matched, bbo was 99.5@100.5.", "POST_ONLY_WOULD_MATCH", "BadAloPx"],
    ["Order could not immediately match against any resting orders. asset=0", "IOC_NO_MATCH", "IocCancel"],
    ["Invalid TP/SL price.", "BAD_TRIGGER_PRICE", "BadTriggerPx"],
    ["No liquidity available for market order.", "NO_LIQUIDITY", "MarketOrderNoLiquidity"],
    ["Order would increase open interest while open interest is capped", "OPEN_INTEREST_CAP", undefined],
    ["Order rejected due to price more aggressive than oracle while at open interest cap", "OPEN_INTEREST_CAP", "TooAggressiveAtOpenInterestCap"],
    ["Order would increase open interest too quickly", "OPEN_INTEREST_INCREASE_TOO_FAST", "OpenInterestIncrease"],
    ["Order has insufficient spot balance to trade", "INSUFFICIENT_SPOT_BALANCE", "InsufficientSpotBalance"],
    ["Order price too far from oracle", "ORACLE_PRICE_BAND", "Oracle"],
    ["Order price cannot be more than 80% away from the reference price", "REFERENCE_PRICE_BAND", undefined],
    ["Order would cause position to exceed margin tier limit at current leverage", "MAX_POSITION", "PerpMaxPosition"],
    ["Order was never placed, already canceled, or filled.", "ORDER_NOT_FOUND", "MissingOrder"],
    ["Too many cumulative requests sent (37986 > 10436) for cumulative volume traded $437.92. Place taker orders to free up 1 request per USDC traded.", "RATE_LIMITED", undefined],
    ["L1 error: User or API Wallet 0x0123456789abcdef0123456789abcdef01234567 does not exist.", "UNKNOWN_SIGNER", undefined],
    ["Must deposit before performing actions. User: 0x0123456789abcdef0123456789abcdef01234567", "ACCOUNT_NOT_ACTIVATED", undefined],
    ["Invalid nonce: duplicate nonce", "INVALID_NONCE", undefined],
    ["Action already expired", "ACTION_EXPIRED", undefined],
    ["Multi-sig required", "MULTI_SIG_REQUIRED", undefined],
    ["Failed to deserialize the JSON body into the target type", "MALFORMED_REQUEST", undefined],
    ["Something new and unexpected", "UNKNOWN", undefined],
  ])("%s → %s", (raw, code, hlType) => {
    const m = mapHlError(raw);
    expect(m.code).toBe(code);
    expect(m.raw).toBe(raw);
    expect(m.hlType).toBe(hlType);
    expect(m.message).toBe(HL_ERROR_CATALOG[m.code].message);
  });

  it("extracts details", () => {
    expect(mapHlError("User or API Wallet 0xABCDEF0123456789abcdef0123456789abcdef01 does not exist.").details?.address).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
    expect(mapHlError("Too many cumulative requests sent").details?.waitSeconds).toBe(10);
    expect(mapHlError("Order 2: Invalid TP/SL price.").details?.orderIndex).toBe(2);
    expect(mapHlError("Post only order would have immediately matched, bbo was 1@2").details?.bbo).toBe("1@2");
    expect(mapHlError("Invalid nonce").retryable).toBe(true);
    expect(mapHlError("Reduce only order would increase position.").retryable).toBe(false);
  });

  it("uses the spec's plain-English wording", () => {
    expect(HL_ERROR_CATALOG.MIN_TRADE_NOTIONAL.message).toBe("Order value is below the $10 minimum.");
    expect(HL_ERROR_CATALOG.UNKNOWN_SIGNER.message).toBe("Trading key is missing or expired; re-enable trading.");
    expect(HL_ERROR_CATALOG.SIBLING_FILLED.message).toBe("Cancelled because the other side of the TP/SL pair filled.");
  });
});

describe("mapOrderStatus", () => {
  it.each([
    ["open", "open", false, undefined],
    ["filled", "filled", true, undefined],
    ["triggered", "triggered", false, undefined],
    ["canceled", "canceled", true, "USER_CANCELED"],
    ["siblingFilledCanceled", "canceled", true, "SIBLING_FILLED"],
    ["liquidatedCanceled", "canceled", true, "LIQUIDATED"],
    ["scheduledCancel", "canceled", true, "SCHEDULED_CANCEL"],
    ["selfTradeCanceled", "canceled", true, "SELF_TRADE"],
    ["reduceOnlyCanceled", "canceled", true, "REDUCE_ONLY"],
    ["marginCanceled", "canceled", true, "MARGIN_CANCELED"],
    ["openInterestCapCanceled", "canceled", true, "OPEN_INTEREST_CAP"],
    ["delistedCanceled", "canceled", true, "DELISTED"],
    ["tickRejected", "rejected", true, "TICK_SIZE"],
    ["minTradeNtlRejected", "rejected", true, "MIN_TRADE_NOTIONAL"],
    ["perpMarginRejected", "rejected", true, "INSUFFICIENT_MARGIN"],
    ["badAloPxRejected", "rejected", true, "POST_ONLY_WOULD_MATCH"],
    ["iocCancelRejected", "rejected", true, "IOC_NO_MATCH"],
    ["marketOrderNoLiquidityRejected", "rejected", true, "NO_LIQUIDITY"],
    ["oracleRejected", "rejected", true, "ORACLE_PRICE_BAND"],
    ["tooManyOpenOrdersRejected", "rejected", true, "TOO_MANY_OPEN_ORDERS"],
    ["brandNewRejected", "rejected", true, "UNKNOWN"],
    ["mystery", "unknown", false, undefined],
  ] as const)("%s", (status, kind, terminal, code) => {
    const m = mapOrderStatus(status);
    expect(m.kind).toBe(kind);
    expect(m.terminal).toBe(terminal);
    expect(m.code).toBe(code);
    expect(m.message.length).toBeGreaterThan(3);
  });
});

describe("parseExchangeResponse", () => {
  it("parses top-level errors", () => {
    const r = parseExchangeResponse({ status: "err", response: "User or API Wallet 0x0000000000000000000000000000000000000001 does not exist." });
    expect(r).toMatchObject({ ok: false, error: { code: "UNKNOWN_SIGNER" } });
    expect(parseExchangeResponse("Failed to deserialize the JSON body into the target type")).toMatchObject({ ok: false, error: { code: "MALFORMED_REQUEST" } });
    expect(parseExchangeResponse(null)).toMatchObject({ ok: false });
  });

  it("parses per-order statuses", () => {
    const r = parseExchangeResponse({
      status: "ok",
      response: {
        type: "order",
        data: {
          statuses: [
            { resting: { oid: 1, cloid: "0x6b6f0101000000000000000000000001" } },
            { filled: { totalSz: "0.1", avgPx: "100000", oid: 2 } },
            { error: "Order must have minimum value of $10." },
            "waitingForFill",
            "waitingForTrigger",
          ],
        },
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.type).toBe("order");
    expect(r.statuses.map((s) => s.kind)).toEqual(["resting", "filled", "error", "waitingForFill", "waitingForTrigger"]);
    expect(r.statuses[0]).toEqual({ kind: "resting", oid: 1, cloid: "0x6b6f0101000000000000000000000001" });
    expect(r.statuses[1]).toEqual({ kind: "filled", oid: 2, totalSz: "0.1", avgPx: "100000" });
  });

  it("expands a single pre-validation error to the whole batch", () => {
    const r = parseExchangeResponse({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Invalid TP/SL price." }] } } }, 3);
    expect(r.ok && r.statuses.length).toBe(3);
    expect(r.ok && r.statuses.every((s) => s.kind === "error")).toBe(true);
  });

  it("parses cancel success and single-status errors", () => {
    expect(parseExchangeResponse({ status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } })).toEqual({ ok: true, type: "cancel", statuses: [{ kind: "success" }] });
    expect(parseExchangeResponse({ status: "ok", response: { type: "default", data: { status: { error: "Invalid nonce" } } } })).toMatchObject({ ok: false, error: { code: "INVALID_NONCE" } });
    expect(parseExchangeResponse({ status: "ok", response: { type: "default" } })).toEqual({ ok: true, type: "default", statuses: [] });
  });
});
