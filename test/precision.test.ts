import { describe, expect, it } from "vitest";
import {
  allowedPriceDecimalsAt,
  checkMinOrderNotional,
  checkPrice,
  formatPrice,
  formatSize,
  isValidPrice,
  isValidSize,
  maxPriceDecimals,
  MIN_ORDER_NOTIONAL_USD,
  minOrderSize,
  normalizeDecimal,
  PrecisionError,
  priceTickAt,
  roundPriceToTick,
  sizeStep,
  validateOrderNotional,
} from "../src/precision/index.js";

describe("isValidPrice — HL tick-and-lot-size doc examples", () => {
  it.each([
    // [price, szDecimals, kind, valid]  (docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size)
    ["1234.5", 0, "perp", true],
    ["1234.56", 0, "perp", false],
    ["0.001234", 0, "perp", true],
    ["0.0012345", 0, "perp", false],
    ["0.01234", 1, "perp", true],
    ["0.012345", 1, "perp", false],
    ["123456", 0, "perp", true], // integers are always allowed
    ["12345.6", 0, "perp", false],
    ["0.0001234", 0, "spot", true],
    ["0.0001234", 1, "spot", true],
    ["0.0001234", 2, "spot", false],
    ["0.0001234", 3, "spot", false],
  ] as const)("%s (szDecimals=%i, %s) → %s", (price, sz, kind, valid) => {
    expect(isValidPrice(price, sz, kind)).toBe(valid);
  });
});

describe("isValidPrice — more cases", () => {
  it.each([
    ["1234.50", 0, true], // trailing zero is the same number
    ["97123", 5, true], // BTC-like integer
    ["97123.5", 5, false], // 6 significant figures
    ["9712.3", 5, true], // BTC allows 1 decimal
    ["971.23", 5, false], // 2 decimals > 6 - 5
    ["100000000", 5, true],
    ["0", 0, false],
    ["-1", 0, false],
    ["abc", 0, false],
    ["", 0, false],
    ["1e3", 0, true],
    ["0.000001", 0, true],
    ["0.0000001", 0, false],
  ] as const)("%s (szDecimals=%i) → %s", (price, sz, valid) => {
    expect(isValidPrice(price, sz, "perp")).toBe(valid);
  });

  it("accepts numbers", () => {
    expect(isValidPrice(1234.5, 0)).toBe(true);
    expect(isValidPrice(1234.56, 0)).toBe(false);
  });
});

describe("formatPrice (nearest valid tick, no trailing zeros)", () => {
  it.each([
    [1234.56, 0, "perp", "1234.6"],
    [1234.54, 0, "perp", "1234.5"],
    ["0.0012345", 0, "perp", "0.001235"],
    [97123.456789, 0, "perp", "97123"],
    [1.23456789, 5, "perp", "1.2"],
    ["0.0000123456789", 0, "spot", "0.00001235"],
    [100000.4, 0, "perp", "100000"],
    [123456.7, 0, "perp", "123457"],
    [9.99996, 0, "perp", "10"],
    [3.3000000000000003, 2, "perp", "3.3"],
    ["1000.0", 0, "perp", "1000"],
    ["1234.500", 0, "perp", "1234.5"],
    [0.1 + 0.2, 0, "perp", "0.3"],
  ] as const)("formatPrice(%s, %i, %s) = %s", (price, sz, kind, out) => {
    expect(formatPrice(price, sz, kind)).toBe(out);
    expect(isValidPrice(out, sz, kind)).toBe(true);
  });

  it("throws for non-positive or unparseable prices", () => {
    expect(() => formatPrice(0, 0)).toThrow(PrecisionError);
    expect(() => formatPrice(-5, 0)).toThrow(PrecisionError);
    expect(() => formatPrice("x", 0)).toThrow(PrecisionError);
    expect(() => formatPrice(Number.NaN, 0)).toThrow(PrecisionError);
    expect(() => formatPrice(Number.POSITIVE_INFINITY, 0)).toThrow(PrecisionError);
    expect(() => formatPrice(0.0000001, 0)).toThrow(PrecisionError); // rounds to zero
  });
});

describe("roundPriceToTick directions", () => {
  it.each([
    ["1234.56", 0, "down", "1234.5"],
    ["1234.56", 0, "up", "1234.6"],
    ["1234.55", 0, "nearest", "1234.6"],
    ["1234.54", 0, "nearest", "1234.5"],
    ["0.0012345", 0, "down", "0.001234"],
    ["0.0012345", 0, "up", "0.001235"],
    ["99999.5", 0, "up", "100000"],
    ["99999.5", 0, "down", "99999"],
    ["0.0000004", 0, "up", "0.000001"],
  ] as const)("%s %s → %s", (price, sz, dir, out) => {
    expect(roundPriceToTick(price, sz, "perp", dir)).toBe(out);
  });

  it("down to zero throws, up to zero gives the smallest tick", () => {
    expect(() => roundPriceToTick("0.0000004", 0, "perp", "down")).toThrow(PrecisionError);
  });

  it("always yields a valid price within one tick of the input (randomized)", () => {
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < 3000; i++) {
      const price = Number((10 ** (rnd() * 12 - 6)).toPrecision(9));
      const sz = Math.floor(rnd() * 6);
      const kind = rnd() < 0.8 ? "perp" : "spot";
      const dir = (["nearest", "up", "down"] as const)[i % 3]!;
      let out: string;
      try {
        out = roundPriceToTick(price, sz, kind, dir);
      } catch (e) {
        expect(e).toBeInstanceOf(PrecisionError); // only when rounding down to zero
        continue;
      }
      expect(isValidPrice(out, sz, kind)).toBe(true);
      const tick = Number(priceTickAt(price, sz, kind));
      expect(Math.abs(Number(out) - price)).toBeLessThanOrEqual(tick * 1.000001 + price * 1e-12);
      if (dir === "up") expect(Number(out)).toBeGreaterThanOrEqual(price * (1 - 1e-12));
      if (dir === "down") expect(Number(out)).toBeLessThanOrEqual(price * (1 + 1e-12));
    }
  });
});

describe("checkPrice", () => {
  it("explains the problem and suggests the nearest valid price", () => {
    expect(checkPrice("1234.56", 0)).toEqual({ valid: false, reason: "too_many_significant_figures", suggestion: "1234.6" });
    expect(checkPrice("971.23", 5)).toEqual({ valid: false, reason: "too_many_decimals", suggestion: "971.2" });
    expect(checkPrice("1234.50", 0)).toEqual({ valid: true, normalized: "1234.5" });
    expect(checkPrice("-1", 0)).toEqual({ valid: false, reason: "not_positive" });
    expect(checkPrice("nope", 0)).toEqual({ valid: false, reason: "not_a_number" });
  });
});

describe("price helpers", () => {
  it("maxPriceDecimals", () => {
    expect(maxPriceDecimals(0)).toBe(6);
    expect(maxPriceDecimals(5)).toBe(1);
    expect(maxPriceDecimals(7)).toBe(0);
    expect(maxPriceDecimals(2, "spot")).toBe(6);
    expect(() => maxPriceDecimals(-1)).toThrow();
    expect(() => maxPriceDecimals(1.5)).toThrow();
  });
  it("allowedPriceDecimalsAt and priceTickAt", () => {
    expect(allowedPriceDecimalsAt(1234.5, 0)).toBe(1);
    expect(allowedPriceDecimalsAt(0.001234, 0)).toBe(6);
    expect(allowedPriceDecimalsAt(123456, 0)).toBe(0);
    expect(priceTickAt(1234.5, 0)).toBe("0.1");
    expect(priceTickAt(0.001234, 0)).toBe("0.000001");
    expect(priceTickAt(123456, 0)).toBe("1");
    expect(priceTickAt(12.345, 4)).toBe("0.01");
  });
});

describe("sizes", () => {
  it.each([
    [1.23456789, 5, "down", "1.23456"],
    [0.123456789, 2, "down", "0.12"],
    [100, 0, "down", "100"],
    ["0.0001", 2, "down", "0"],
    ["1.005", 2, "nearest", "1.01"],
    ["1.001", 2, "up", "1.01"],
    ["-0.5", 3, "down", "-0.5"],
    ["-0.5678", 2, "down", "-0.56"],
    ["1.50", 3, "down", "1.5"],
    [1000, 0, "down", "1000"],
  ] as const)("formatSize(%s, %i, %s) = %s", (size, sz, dir, out) => {
    expect(formatSize(size, sz, dir)).toBe(out);
  });

  it("isValidSize and sizeStep", () => {
    expect(isValidSize("1.001", 3)).toBe(true);
    expect(isValidSize("1.0001", 3)).toBe(false);
    expect(isValidSize("0", 3)).toBe(false);
    expect(isValidSize("-1", 3)).toBe(false);
    expect(isValidSize("x", 3)).toBe(false);
    expect(sizeStep(3)).toBe("0.001");
    expect(sizeStep(0)).toBe("1");
  });
});

describe("validateOrderNotional ($10 minimum)", () => {
  it("uses exact decimal multiplication", () => {
    expect(MIN_ORDER_NOTIONAL_USD).toBe(10);
    expect(validateOrderNotional("0.001", "10000")).toEqual({ ok: true, notionalUsd: 10, minNotionalUsd: 10, shortfallUsd: 0 });
    const low = validateOrderNotional("0.0009999", "10000");
    expect(low.ok).toBe(false);
    expect(low.shortfallUsd).toBeCloseTo(0.001, 9);
    expect(validateOrderNotional("0.1", "99.99").ok).toBe(false);
    expect(validateOrderNotional(3, 3.34).ok).toBe(true); // 10.02
    expect(validateOrderNotional(0.1, 100.0000001).ok).toBe(true);
    expect(validateOrderNotional("-0.001", "10000").ok).toBe(true); // absolute notional
  });
});

describe("checkMinOrderNotional (HL: $10, except a reduce-only close of the whole position)", () => {
  it("finds the smallest valid size", () => {
    expect(minOrderSize("85500", 5)).toBe("0.00012"); // 0.00011 × 85500 = 9.405
    expect(minOrderSize("10000", 3)).toBe("0.001"); // exactly $10
    expect(minOrderSize("3.34", 0)).toBe("3");
    expect(minOrderSize("0.5", 0)).toBe("20");
  });

  it("blocks new orders and partial closes below $10 with the valid size", () => {
    const entry = checkMinOrderNotional({ size: "0.0001", price: "85500", szDecimals: 5, symbol: "BTC" });
    expect(entry).toMatchObject({ ok: false, exempt: false, minSize: "0.00012" });
    expect(entry.message).toBe("Order value $8.55 is below Hyperliquid's $10 minimum. Use at least 0.00012 BTC (about $10.26).");
    // The testnet case: a reduce-only partial close worth $8.55 is rejected by HL.
    const partial = checkMinOrderNotional({ size: "0.0001", price: "85500", szDecimals: 5, reduceOnly: true, positionSize: "0.0003", symbol: "BTC" });
    expect(partial.ok).toBe(false);
    expect(partial.message).toContain("Use at least 0.00012 BTC (about $10.26), or close the whole position.");
    // The minimum is above the position: only a full close is possible.
    const tiny = checkMinOrderNotional({ size: "0.0001", price: "85500", szDecimals: 5, reduceOnly: true, positionSize: "0.00011", symbol: "BTC" });
    expect(tiny.message).toContain("Close the whole position (0.00011 BTC) instead");
  });

  it("allows a reduce-only close of the whole position below $10, and anything at or above $10", () => {
    expect(checkMinOrderNotional({ size: "0.0001", price: "85500", szDecimals: 5, reduceOnly: true, positionSize: "0.0001" })).toMatchObject({ ok: true, exempt: true });
    expect(checkMinOrderNotional({ size: "0.0001", price: "85500", szDecimals: 5, reduceOnly: true, positionSize: "-0.0001" }).ok).toBe(true);
    // Not reduce-only: never exempt, even at the position size.
    expect(checkMinOrderNotional({ size: "0.0001", price: "85500", szDecimals: 5, positionSize: "0.0001" }).ok).toBe(false);
    expect(checkMinOrderNotional({ size: "0.00012", price: "85500", szDecimals: 5 })).toMatchObject({ ok: true, exempt: false, message: "" });
  });
});

describe("normalizeDecimal", () => {
  it.each([
    ["1e-7", "0.0000001"],
    [1e21, "1000000000000000000000"],
    ["-0", "0"],
    ["+1.50", "1.5"],
    [".5", "0.5"],
    ["5.", "5"],
    ["00012.3400", "12.34"],
    ["1.5E+3", "1500"],
    [0.1 + 0.2, "0.3"],
  ] as const)("%s → %s", (input, out) => {
    expect(normalizeDecimal(input)).toBe(out);
  });
  it("rejects garbage", () => {
    for (const bad of ["", ".", "1.2.3", "0x10", "1,5", " ", "NaN"]) expect(() => normalizeDecimal(bad)).toThrow(PrecisionError);
  });
});
