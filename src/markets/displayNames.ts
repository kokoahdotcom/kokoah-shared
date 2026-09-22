/**
 * Display names and categories for markets (FRONTEND_SPEC §22.5 "Market names").
 *
 * Resolution order for a perp/HIP-3 market:
 * 1. caller overrides (`displayOverrides` passed to the registry);
 * 2. {@link WELL_KNOWN_MARKETS} (this small, editable table);
 * 3. HL's own annotations (`perpConciseAnnotations`: category + displayName);
 * 4. fallback: the symbol itself; category "crypto" on the first dex, "other" on HIP-3 dexes.
 *
 * Spot pairs are named from their tokens (`@107` → "HYPE/USDC"), with bridged tokens remapped
 * via {@link SPOT_TOKEN_DISPLAY_REMAP} (e.g. UBTC shown as BTC, with a note).
 *
 * @module
 */

/** Market category used for grouping and filters. */
export type MarketCategory = "crypto" | "stocks" | "indices" | "commodities" | "fx" | "preipo" | "rates" | "other";

/** Display metadata for one market. */
export interface MarketDisplay {
  displayName: string;
  category: MarketCategory;
  /** Optional short note shown next to the name (e.g. "Unit-bridged BTC"). */
  note?: string;
}

/**
 * Well-known HIP-3 markets (trade.xyz, dex `xyz`). Keys are HL coin names. Edit freely; unknown coins fall back to
 * HL annotations and then to the raw symbol. Names checked against HL's `perpConciseAnnotations` keywords on 2026-09-21.
 */
export const WELL_KNOWN_MARKETS: Readonly<Record<string, MarketDisplay>> = Object.freeze({
  // Indices
  "xyz:SP500": { displayName: "S&P 500", category: "indices" },
  "xyz:XYZ100": { displayName: "XYZ100 (Nasdaq-100)", category: "indices" },
  "xyz:JP225": { displayName: "Japan 225 (Nikkei)", category: "indices" },
  "xyz:KR200": { displayName: "KOSPI 200", category: "indices" },
  // Commodities
  "xyz:GOLD": { displayName: "Gold", category: "commodities" },
  "xyz:SILVER": { displayName: "Silver", category: "commodities" },
  "xyz:PLATINUM": { displayName: "Platinum", category: "commodities" },
  "xyz:PALLADIUM": { displayName: "Palladium", category: "commodities" },
  "xyz:COPPER": { displayName: "Copper", category: "commodities" },
  "xyz:CL": { displayName: "WTI Crude Oil", category: "commodities" },
  "xyz:BRENTOIL": { displayName: "Brent Crude Oil", category: "commodities" },
  "xyz:NATGAS": { displayName: "Natural Gas", category: "commodities" },
  // FX
  "xyz:EUR": { displayName: "EUR/USD", category: "fx" },
  "xyz:GBP": { displayName: "GBP/USD", category: "fx" },
  "xyz:JPY": { displayName: "USD/JPY", category: "fx" },
  "xyz:DXY": { displayName: "US Dollar Index", category: "fx" },
  // Stocks
  "xyz:TSLA": { displayName: "Tesla", category: "stocks" },
  "xyz:NVDA": { displayName: "NVIDIA", category: "stocks" },
  "xyz:AAPL": { displayName: "Apple", category: "stocks" },
  "xyz:MSFT": { displayName: "Microsoft", category: "stocks" },
  "xyz:AMZN": { displayName: "Amazon", category: "stocks" },
  "xyz:GOOGL": { displayName: "Alphabet", category: "stocks" },
  "xyz:META": { displayName: "Meta Platforms", category: "stocks" },
  "xyz:COIN": { displayName: "Coinbase", category: "stocks" },
  "xyz:HOOD": { displayName: "Robinhood", category: "stocks" },
  "xyz:PLTR": { displayName: "Palantir", category: "stocks" },
  "xyz:MSTR": { displayName: "Strategy", category: "stocks" },
  "xyz:AMD": { displayName: "AMD", category: "stocks" },
  "xyz:NFLX": { displayName: "Netflix", category: "stocks" },
  "xyz:INTC": { displayName: "Intel", category: "stocks" },
  "xyz:ORCL": { displayName: "Oracle", category: "stocks" },
  "xyz:TSM": { displayName: "TSMC", category: "stocks" },
  "xyz:MU": { displayName: "Micron", category: "stocks" },
  "xyz:CRCL": { displayName: "Circle", category: "stocks" },
  "xyz:SKHX": { displayName: "SK hynix", category: "stocks" },
  "xyz:SMSN": { displayName: "Samsung Electronics", category: "stocks" },
  "xyz:SNDK": { displayName: "Sandisk", category: "stocks" },
});

/**
 * Spot tokens shown under a different name (bridged or wrapped assets). The list mirrors ccxt's Hyperliquid
 * `spotCurrencyMapping` (2026-09); the note keeps the HyperCore token name visible.
 */
export const SPOT_TOKEN_DISPLAY_REMAP: Readonly<Record<string, { displayName: string; note: string }>> = Object.freeze({
  UBTC: { displayName: "BTC", note: "Unit-bridged BTC (HyperCore token UBTC)" },
  UETH: { displayName: "ETH", note: "Unit-bridged ETH (HyperCore token UETH)" },
  USOL: { displayName: "SOL", note: "Unit-bridged SOL (HyperCore token USOL)" },
  UFART: { displayName: "FARTCOIN", note: "Bridged FARTCOIN (HyperCore token UFART)" },
  UPUMP: { displayName: "PUMP", note: "Bridged PUMP (HyperCore token UPUMP)" },
  UBONK: { displayName: "BONK", note: "Bridged BONK (HyperCore token UBONK)" },
  UXPL: { displayName: "XPL", note: "Bridged XPL (HyperCore token UXPL)" },
  UDZ: { displayName: "2Z", note: "Bridged 2Z (HyperCore token UDZ)" },
  UUUSPX: { displayName: "SPX", note: "Bridged SPX (HyperCore token UUUSPX)" },
  HPENGU: { displayName: "PENGU", note: "Bridged PENGU (HyperCore token HPENGU)" },
  USDT0: { displayName: "USDT", note: "USDT0 on HyperCore" },
  XAUT0: { displayName: "XAUT", note: "XAUT0 on HyperCore" },
});

/** Normalizes HL annotation categories ("stocks", "stock", "FX", "indices", …) to {@link MarketCategory}. */
export function normalizeCategory(raw: string | undefined | null): MarketCategory | undefined {
  if (!raw) return undefined;
  const c = raw.trim().toLowerCase();
  switch (c) {
    case "crypto":
      return "crypto";
    case "stock":
    case "stocks":
    case "equity":
    case "equities":
      return "stocks";
    case "index":
    case "indices":
    case "indexes":
      return "indices";
    case "commodity":
    case "commodities":
      return "commodities";
    case "fx":
    case "forex":
    case "currency":
    case "currencies":
      return "fx";
    case "preipo":
    case "pre-ipo":
      return "preipo";
    case "rates":
    case "rate":
      return "rates";
    default:
      return "other";
  }
}
