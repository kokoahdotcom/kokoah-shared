import { describe, expect, it } from "vitest";
import { compileAction, CLOID_ORIGIN_CODES, deriveCloid, generateCloid, parseCloid } from "../src/actions/index.js";
import { botCancelIntent, botCloid, plannedOrderIntent } from "../src/bots/index.js";
import { INTENT_ORIGINS, parseActionIntent, type ActionIntentInput } from "../src/intents/index.js";
import {
  botLimitShortfalls,
  carryOriginGrants,
  createGuardianPolicy,
  evaluatePolicy,
  hashPolicy,
  originAllowed,
  parsePolicy,
  policyForBots,
  policyForTelegram,
  summarizePolicy,
  telegramPolicyShortfalls,
  type BotLimitNeeds,
  type Policy,
  type PolicyContext,
} from "../src/policy/index.js";
import { mainnetRegistry } from "./helpers.js";

const registry = mainnetRegistry();
const NOW = 1_790_000_000_000;
const builder = { b: "0x1111111111111111111111111111111111111111" as const, f: 25 };

/** The automation policy a user signs: guardian origin only, stop-loss required within 25%. */
const automation = (over: Partial<Policy> = {}): Policy =>
  createGuardianPolicy({ builder, allowedCoins: "*", maxOrderNotionalUsd: 5_000, maxDailyNotionalUsd: 50_000, maxLeverage: 10, overrides: over });

const ctx = (policy: Policy): PolicyContext => ({
  policy,
  now: NOW,
  markPrices: { BTC: 100_000, ETH: 3_000 },
  dailyNotionalUsedUsd: 0,
  ordersInLastMinute: 0,
  registry,
  expiresAfter: NOW + 15_000,
});

/** A market entry without a stop-loss. */
const naked = (origin: string): ActionIntentInput => ({ kind: "order", coin: "ETH", side: "buy", orderType: "market", size: "1", origin }) as ActionIntentInput;

const codes = (policy: Policy, i: ActionIntentInput) => evaluatePolicy(parseActionIntent(i), ctx(policy)).violations.map((v) => v.code);

const needs: BotLimitNeeds = {
  coins: ["ETH"],
  maxOrderNotionalUsd: 100,
  dailyNotionalUsd: 1_000,
  maxLeverage: 3,
  ordersPerMinute: 10,
  entriesWithoutStopLoss: true,
  marketSlippagePct: 1,
};

describe("origins", () => {
  it("adds bot and telegram after the existing origins, with their own cloid codes", () => {
    expect(INTENT_ORIGINS).toEqual(["manual", "guardian", "ai_ticket", "bot", "telegram"]);
    expect(CLOID_ORIGIN_CODES).toEqual({ manual: "01", guardian: "02", ai_ticket: "03", bot: "04", telegram: "05" });
    for (const origin of INTENT_ORIGINS) {
      const c = generateCloid(origin);
      expect(c.slice(2, 10)).toBe(`6b6f${CLOID_ORIGIN_CODES[origin]}01`);
      expect(parseCloid(c)).toEqual({ kokoah: true, origin, tag: c.slice(2, 10) });
      expect(parseCloid(deriveCloid("seed", origin))?.origin).toBe(origin);
    }
  });

  it("keeps parsing cloids made before the new origins existed", () => {
    // Fixed values (a guardian-tag bot order from before the switch, a manual one and an AI one).
    expect(parseCloid("0x6b6f0201aabbccddeeff001122334455")).toEqual({ kokoah: true, origin: "guardian", tag: "6b6f0201" });
    expect(parseCloid("0x6b6f0101aabbccddeeff001122334455")?.origin).toBe("manual");
    expect(parseCloid("0x6b6f0301aabbccddeeff001122334455")?.origin).toBe("ai_ticket");
    // An unknown origin byte is still a Kokoah cloid, without an origin.
    expect(parseCloid("0x6b6f0901aabbccddeeff001122334455")).toEqual({ kokoah: true, tag: "6b6f0901" });
  });

  it("compiles telegram and bot intents with their origin in the cloid", () => {
    for (const origin of ["bot", "telegram"] as const) {
      const c = compileAction(parseActionIntent({ kind: "order", coin: "BTC", side: "buy", orderType: "market", size: "0.01", origin }), {
        registry,
        builder: { address: builder.b, feeTenthsBps: builder.f },
        getMidPrice: () => 100_000,
      });
      expect(parseCloid(c.cloids[0]!)?.origin).toBe(origin);
    }
  });

  it("gives bot orders and cancels the bot origin", () => {
    const cloid = botCloid("bot-1", 3);
    expect(parseCloid(cloid)?.origin).toBe("bot");
    const intent = plannedOrderIntent({ cloid, coin: "ETH", side: "buy", size: "0.1", type: "market", reduceOnly: false, label: "DCA" });
    expect(intent.origin).toBe("bot");
    expect(botCancelIntent("ETH", [cloid]).origin).toBe("bot");
  });
});

describe("stop-loss exemption for bots only", () => {
  it("requires a stop-loss on every origin without the signed exemption", () => {
    const p = automation({ allowedOrigins: ["guardian", "bot", "telegram"] });
    for (const origin of ["guardian", "bot", "telegram"]) expect(codes(p, naked(origin))).toEqual(["STOP_LOSS_REQUIRED"]);
  });

  it("exempts only bot entries when the policy signs botEntriesWithoutStopLoss", () => {
    const p = automation({ allowedOrigins: ["guardian", "bot", "telegram"], botEntriesWithoutStopLoss: true });
    expect(codes(p, naked("bot"))).toEqual([]);
    expect(codes(p, naked("guardian"))).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(codes(p, naked("telegram"))).toEqual(["STOP_LOSS_REQUIRED"]);
    // A Telegram entry with a stop inside the distance limit passes.
    expect(codes(p, { ...naked("telegram"), stopLoss: { triggerPrice: "2900" } } as ActionIntentInput)).toEqual([]);
  });

  it("applies the exemption to the compiled wire action and to raw wire actions by their origin", () => {
    const p = automation({ allowedOrigins: ["guardian", "bot"], botEntriesWithoutStopLoss: true });
    const compiled = (origin: "bot" | "guardian") =>
      compileAction(parseActionIntent(naked(origin)), { registry, builder: { address: builder.b, feeTenthsBps: builder.f }, getMidPrice: () => 3_000 });
    expect(evaluatePolicy({ kind: "compiled", compiled: compiled("bot"), expiresAfter: NOW + 15_000 }, ctx(p)).allowed).toBe(true);
    const guardian = evaluatePolicy({ kind: "compiled", compiled: compiled("guardian"), expiresAfter: NOW + 15_000 }, ctx(p));
    expect(guardian.violations.map((v) => v.code)).toEqual(["STOP_LOSS_REQUIRED"]);
    const wire = compiled("bot").action as unknown as { type: string } & Record<string, unknown>;
    expect(evaluatePolicy({ kind: "wire", action: wire, origin: "bot", expiresAfter: NOW + 15_000 }, ctx(p)).allowed).toBe(true);
    expect(evaluatePolicy({ kind: "wire", action: wire, expiresAfter: NOW + 15_000 }, ctx(p)).violations.map((v) => v.code)).toContain("STOP_LOSS_REQUIRED");
  });

  it("is part of the signed policy hash", () => {
    const p = automation();
    expect(hashPolicy({ ...p, botEntriesWithoutStopLoss: true })).not.toBe(hashPolicy(p));
    expect(summarizePolicy({ ...p, botEntriesWithoutStopLoss: true })).toContain("stop-loss required on entries (bots exempt)");
  });
});

describe("bot grants", () => {
  it("asks for the bot origin and the bot exemption instead of turning the requirement off", () => {
    const p = automation();
    // Bots also lower a coin's leverage to the signed maximum themselves (updateLeverage).
    expect(botLimitShortfalls(p, needs).map((s) => s.field)).toEqual(["allowedActionTypes", "allowedOrigins", "botEntriesWithoutStopLoss"]);
    const next = policyForBots(p, needs);
    expect(next.allowedOrigins).toEqual(["guardian", "bot"]);
    expect(next.requireStopLossForNewEntries).toBe(true);
    expect(next.botEntriesWithoutStopLoss).toBe(true);
    expect(botLimitShortfalls(next, needs)).toEqual([]);
    expect(parsePolicy(next)).toEqual(next);
    // Guardians keep the stop-loss requirement under the re-signed policy.
    expect(codes(next, naked("guardian"))).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(codes(next, naked("bot"))).toEqual([]);
  });

  it("needs no exemption when the user does not require stops", () => {
    const p = automation({ requireStopLossForNewEntries: false, allowedOrigins: ["guardian", "bot"] });
    expect(botLimitShortfalls(p, needs).map((s) => s.field)).toEqual(["allowedActionTypes"]);
    expect(botLimitShortfalls(policyForBots(p, needs), needs)).toEqual([]);
  });
});

describe("telegram grants", () => {
  it("lists what Telegram trading lacks and adds only the origin and actions", () => {
    const p = automation();
    expect(originAllowed(p, "telegram")).toBe(false);
    expect(telegramPolicyShortfalls(p)).toEqual([{ field: "allowedOrigins", label: "Order origin", current: "guardian", needed: "also Telegram (telegram)" }]);
    const next = policyForTelegram(p);
    expect(telegramPolicyShortfalls(next)).toEqual([]);
    expect(next.allowedOrigins).toEqual(["guardian", "telegram"]);
    expect(next.allowedActionTypes).toContain("updateLeverage");
    expect({ ...next, allowedOrigins: p.allowedOrigins, allowedActionTypes: p.allowedActionTypes }).toEqual(p);
    expect(parsePolicy(next)).toEqual(next);
    // Telegram entries still need a stop when the user requires one.
    expect(codes(next, naked("telegram"))).toEqual(["STOP_LOSS_REQUIRED"]);
    // A policy without allowedOrigins allows every origin.
    const open = parsePolicy({ ...p, allowedOrigins: undefined });
    expect(originAllowed(open, "telegram")).toBe(true);
    expect(telegramPolicyShortfalls(parsePolicy({ ...open, allowedActionTypes: ["order", "noop"] }))[0]).toMatchObject({ field: "allowedActionTypes", needed: "also cancel, cancelByCloid" });
  });

  it("keeps bot and telegram grants when limits are re-signed from a form", () => {
    const stored = policyForTelegram(policyForBots(automation(), needs));
    const rebuilt = automation({ maxOrderNotionalUsd: 9_000 });
    const carried = carryOriginGrants(stored, rebuilt);
    expect(carried.allowedOrigins).toEqual(["guardian", "bot", "telegram"]);
    expect(carried.botEntriesWithoutStopLoss).toBe(true);
    expect(carried.allowedActionTypes).toContain("updateLeverage");
    expect(carried.maxOrderNotionalUsd).toBe(9_000);
    expect(parsePolicy(carried)).toEqual(carried);
    // Nothing is invented: a plain stored policy carries nothing.
    expect(carryOriginGrants(automation(), rebuilt)).toEqual(rebuilt);
    expect(carryOriginGrants(null, rebuilt)).toBe(rebuilt);
    // A reduce-only form without orders gets no leverage action.
    const noOrders = automation({ allowedActionTypes: ["cancel", "noop"] });
    expect(carryOriginGrants(stored, noOrders).allowedActionTypes).toEqual(["cancel", "noop"]);
  });
});
