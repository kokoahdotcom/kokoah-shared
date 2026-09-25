/**
 * The automation limits a bot needs (checked against the signed policy with `policy/bots.ts`). Sizes are what the
 * signer service will see: the largest single order at its worst price (market orders include the bots' slippage) and
 * a daily volume the bot can plausibly reach. The user may always sign more.
 *
 * @module
 */
import type { BotLimitNeeds } from "../policy/bots.js";
import { gridPrices } from "./grid.js";
import { dcaSafetyLadder } from "./dca.js";
import { BOT_LIMITS, type BotConfig, botCoins } from "./schema.js";

const SLIP = 1 + BOT_LIMITS.marketSlippagePct / 100;
/** Size rounding up to the market's decimals can add a little; 1% covers it. */
const ROUNDING = 1.01;

const up = (x: number) => Math.ceil(x);

/** Limits one bot needs. `vaultAddress`: the sub-account it trades for. */
export function botLimitNeeds(config: BotConfig, vaultAddress?: string): BotLimitNeeds {
  const base = {
    coins: botCoins(config),
    maxLeverage: config.maxLeverage,
    entriesWithoutStopLoss: true,
    marketSlippagePct: BOT_LIMITS.marketSlippagePct,
    ...(vaultAddress ? { vaultAddresses: [vaultAddress.toLowerCase()] } : {}),
  };
  switch (config.kind) {
    case "grid": {
      const size = (config.orderSizeUsd / config.lower) * ROUNDING;
      const maxOrder = size * config.upper * SLIP;
      const total = gridPrices(config).reduce((s, p) => s + size * p, 0);
      return {
        ...base,
        maxOrderNotionalUsd: up(maxOrder),
        // Every line filling both ways in a day, plus a start position.
        dailyNotionalUsd: up(total * 2 + (config.mode === "neutral" ? 0 : total)),
        ordersPerMinute: Math.min(20, config.levels),
      };
    }
    case "dca": {
      const safety = config.safety ? dcaSafetyLadder(config.safety, 1, config.side, config.orderSizeUsd) : [];
      const largest = Math.max(config.orderSizeUsd, ...safety.map((s) => s.usd));
      const perDay = Math.ceil(1440 / config.intervalMinutes);
      const recurring = config.orderSizeUsd * (config.maxOrders !== undefined ? Math.min(perDay, config.maxOrders) : perDay);
      const safetyTotal = safety.reduce((s, x) => s + x.usd, 0);
      return {
        ...base,
        maxOrderNotionalUsd: up(Math.max(largest * ROUNDING, 10.1) * SLIP),
        dailyNotionalUsd: up((recurring + safetyTotal) * ROUNDING * SLIP),
        ordersPerMinute: Math.min(20, 1 + safety.length),
      };
    }
    case "copy":
      return {
        ...base,
        maxOrderNotionalUsd: up(config.maxOrderUsd * SLIP),
        // An active trader turns the copy over a few times a day.
        dailyNotionalUsd: up(config.maxTotalUsd * 4 * SLIP),
        ordersPerMinute: 10,
      };
    case "signal":
      return {
        ...base,
        maxOrderNotionalUsd: up(config.maxOrderUsd * SLIP),
        dailyNotionalUsd: up(config.maxPositionUsd * 4 * SLIP),
        ordersPerMinute: 10,
      };
  }
}
