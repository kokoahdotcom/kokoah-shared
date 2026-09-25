import { describe, expect, it } from "vitest";
import { botLimitNeeds, parseBotConfig } from "../src/bots/index.js";
import { botLimitShortfalls, BotLimitsTooHighError, createGuardianPolicy, mergeBotNeeds, parsePolicy, policyForBots, type BotLimitNeeds } from "../src/policy/index.js";

const builder = { b: "0x1111111111111111111111111111111111111111" as const, f: 25 };
/** The default automation limits: close and reduce only (entries capped at $1), stop-loss required. */
const reduceOnly = () =>
  createGuardianPolicy({
    builder,
    allowedCoins: "*",
    maxOrderNotionalUsd: 1,
    maxDailyNotionalUsd: 1,
    maxLeverage: 1,
    overrides: { allowedActionTypes: ["order", "cancel", "cancelByCloid", "modify", "batchModify", "noop"] },
  });

const needs = (over: Partial<BotLimitNeeds> = {}): BotLimitNeeds => ({
  coins: ["ETH"],
  maxOrderNotionalUsd: 77,
  dailyNotionalUsd: 1500,
  maxLeverage: 3,
  ordersPerMinute: 11,
  entriesWithoutStopLoss: true,
  marketSlippagePct: 1,
  ...over,
});

describe("bot limits", () => {
  it("lists every limit the default policy is too tight on", () => {
    const short = botLimitShortfalls(reduceOnly(), needs());
    expect(short.map((s) => s.field)).toEqual(["allowedOrigins", "maxOrderNotionalUsd", "maxDailyNotionalUsd", "maxLeverage", "botEntriesWithoutStopLoss"]);
    expect(short[0]).toEqual({ field: "allowedOrigins", label: "Order origin", current: "guardian", needed: "also bots (bot)" });
    expect(short[1]).toEqual({ field: "maxOrderNotionalUsd", label: "Max order size", current: "$1", needed: "$77" });
  });

  it("raises only what is short and keeps everything else", () => {
    const base = parsePolicy({ ...reduceOnly(), allowedCoins: ["BTC"], maxDailyNotionalUsd: 50_000, allowedOrigins: ["manual"] });
    const next = policyForBots(base, needs({ vaultAddresses: ["0x00000000000000000000000000000000000000AB"] }));
    expect(botLimitShortfalls(next, needs({ vaultAddresses: ["0x00000000000000000000000000000000000000ab"] }))).toEqual([]);
    expect(next.allowedCoins).toEqual(["BTC", "ETH"]);
    expect(next.maxDailyNotionalUsd).toBe(50_000);
    expect(next.maxOrderNotionalUsd).toBe(77);
    // The stop-loss rule stays for every other origin; only bots are exempt.
    expect(next.requireStopLossForNewEntries).toBe(true);
    expect(next.botEntriesWithoutStopLoss).toBe(true);
    expect(next.allowedOrigins).toEqual(["manual", "bot"]);
    expect(next.allowedVaultAddresses).toEqual(["0x00000000000000000000000000000000000000ab"]);
    // Untouched fields.
    expect(next.requiredBuilder).toEqual(builder);
    expect(next.maxExpiresAfterWindowMs).toBe(base.maxExpiresAfterWindowMs);
    expect(next.allowedActionTypes).toEqual(base.allowedActionTypes);
    // Still a valid policy.
    expect(parsePolicy(next)).toEqual(next);
    // Any market for a copy bot without an allow list.
    expect(policyForBots(base, needs({ coins: "*" })).allowedCoins).toBe("*");
  });

  it("adds missing bot actions and refuses needs above the bounds", () => {
    const tight = parsePolicy({ ...reduceOnly(), allowedActionTypes: ["order", "noop"] });
    expect(botLimitShortfalls(tight, needs())[0]).toMatchObject({ field: "allowedActionTypes", needed: "also cancel, cancelByCloid" });
    expect(botLimitShortfalls(tight, needs())[1]).toMatchObject({ field: "allowedOrigins", needed: "also bots (bot)" });
    expect(policyForBots(tight, needs()).allowedActionTypes).toEqual(["order", "noop", "cancel", "cancelByCloid"]);
    expect(() => policyForBots(tight, needs({ maxOrderNotionalUsd: 2_000_000 }))).toThrow(BotLimitsTooHighError);
    expect(() => policyForBots(tight, needs({ dailyNotionalUsd: 30_000_000, maxLeverage: 60 }))).toThrow(/daily volume.*leverage/);
  });

  it("merges the needs of several bots", () => {
    expect(mergeBotNeeds([])).toBeNull();
    const grid = botLimitNeeds(parseBotConfig({ kind: "grid", coin: "ETH", lower: 2000, upper: 3000, levels: 11, spacing: "arithmetic", orderSizeUsd: 50, maxLeverage: 3 }));
    const dca = botLimitNeeds(parseBotConfig({ kind: "dca", coin: "BTC", side: "buy", orderSizeUsd: 200, intervalMinutes: 1440, maxLeverage: 5 }), "0x00000000000000000000000000000000000000cd");
    const merged = mergeBotNeeds([grid, dca])!;
    expect(merged.coins).toEqual(["BTC", "ETH"]);
    expect(merged.dailyNotionalUsd).toBe(grid.dailyNotionalUsd + dca.dailyNotionalUsd);
    expect(merged.maxOrderNotionalUsd).toBe(Math.max(grid.maxOrderNotionalUsd, dca.maxOrderNotionalUsd));
    expect(merged.maxLeverage).toBe(5);
    expect(merged.vaultAddresses).toEqual(["0x00000000000000000000000000000000000000cd"]);
    expect(mergeBotNeeds([grid, needs({ coins: "*" })])!.coins).toBe("*");
  });
});
