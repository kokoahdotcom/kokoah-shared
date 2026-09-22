/**
 * Margin tiers, initial margin and maintenance margin.
 *
 * Sources:
 * - Margining: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margining
 *   "The margin required to open a position is position_size * mark_price / leverage."
 * - Margin tiers: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margin-tiers
 *   maintenance_margin = notional × maintenance_margin_rate − maintenance_deduction
 *   maintenance_margin_rate(tier n) = (initial margin rate at max leverage of tier n) / 2 = 1 / (2 × maxLeverage_n)
 *   maintenance_deduction(0) = 0
 *   maintenance_deduction(n) = maintenance_deduction(n−1) + lowerBound(n) × (rate(n) − rate(n−1))
 *   "For IDs less than 50, there is a single tier with max leverage equal to the ID."
 * - Spec FRONTEND_SPEC §23.
 *
 * @module
 */

/** One margin tier: from `lowerBound` USD notional upward, leverage is capped at `maxLeverage`. */
export interface MarginTier {
  /** Lower bound of position notional (USD) for this tier. The first tier starts at 0. */
  readonly lowerBound: number;
  readonly maxLeverage: number;
}

/** A margin tier with the derived maintenance parameters. */
export interface MaintenanceTier extends MarginTier {
  /** Maintenance margin rate: `1 / (2 × maxLeverage)`. */
  readonly maintenanceMarginRate: number;
  /** Maintenance deduction (USD) that keeps maintenance margin continuous across tiers. */
  readonly maintenanceDeduction: number;
  /** Maintenance leverage: `2 × maxLeverage` (so `l = 1 / maintenanceLeverage` in the liquidation formula). */
  readonly maintenanceLeverage: number;
}

/** Raw margin table as returned in `meta.marginTables` (`[id, table]` pairs). */
export interface RawMarginTable {
  readonly description?: string;
  readonly marginTiers: ReadonlyArray<{ readonly lowerBound: string | number; readonly maxLeverage: number }>;
}

/** Margin table ids below this value are implicit single-tier tables with max leverage equal to the id. */
export const IMPLICIT_MARGIN_TABLE_ID_LIMIT = 50;

/** Converts a raw `meta.marginTables` entry into sorted numeric tiers. */
export function marginTiersFromTable(table: RawMarginTable): MarginTier[] {
  const tiers = table.marginTiers.map((t) => ({ lowerBound: Number(t.lowerBound), maxLeverage: t.maxLeverage }));
  for (const t of tiers) {
    if (!Number.isFinite(t.lowerBound) || t.lowerBound < 0 || !(t.maxLeverage > 0)) {
      throw new RangeError(`Invalid margin tier: ${JSON.stringify(t)}`);
    }
  }
  tiers.sort((a, b) => a.lowerBound - b.lowerBound);
  if (tiers.length === 0) throw new RangeError("Margin table has no tiers");
  return tiers;
}

/** A single tier covering all notionals (used for margin table ids < 50 and as a fallback). */
export function singleTier(maxLeverage: number): MarginTier[] {
  if (!(maxLeverage > 0)) throw new RangeError(`maxLeverage must be positive, got ${maxLeverage}`);
  return [{ lowerBound: 0, maxLeverage }];
}

/**
 * Resolves the tiers for a market from its `marginTableId` and the dex's `meta.marginTables`.
 * Ids below 50 are implicit single tiers. Unknown ids fall back to a single tier at `fallbackMaxLeverage`.
 */
export function resolveMarginTiers(
  marginTableId: number,
  marginTables: ReadonlyArray<readonly [number, RawMarginTable]>,
  fallbackMaxLeverage?: number,
): MarginTier[] {
  if (marginTableId < IMPLICIT_MARGIN_TABLE_ID_LIMIT) return singleTier(marginTableId);
  const found = marginTables.find(([id]) => id === marginTableId);
  if (found) return marginTiersFromTable(found[1]);
  if (fallbackMaxLeverage !== undefined) return singleTier(fallbackMaxLeverage);
  throw new RangeError(`Unknown margin table id ${marginTableId}`);
}

/** Adds maintenance rate, deduction and leverage to each tier (sorted by lower bound). */
export function maintenanceSchedule(tiers: ReadonlyArray<MarginTier>): MaintenanceTier[] {
  if (tiers.length === 0) throw new RangeError("No margin tiers");
  const sorted = [...tiers].sort((a, b) => a.lowerBound - b.lowerBound);
  const out: MaintenanceTier[] = [];
  let prevRate = 0;
  let deduction = 0;
  sorted.forEach((t, i) => {
    const rate = 1 / (2 * t.maxLeverage);
    if (i > 0) deduction += t.lowerBound * (rate - prevRate);
    out.push({
      lowerBound: t.lowerBound,
      maxLeverage: t.maxLeverage,
      maintenanceMarginRate: rate,
      maintenanceDeduction: deduction,
      maintenanceLeverage: 2 * t.maxLeverage,
    });
    prevRate = rate;
  });
  return out;
}

/** The tier that applies to a position notional (the highest tier whose lower bound is ≤ notional). */
export function tierForNotional(tiers: ReadonlyArray<MarginTier>, notionalUsd: number): MaintenanceTier {
  const schedule = maintenanceSchedule(tiers);
  const n = Math.abs(notionalUsd);
  let chosen = schedule[0] as MaintenanceTier;
  for (const t of schedule) if (t.lowerBound <= n) chosen = t;
  return chosen;
}

/** Notional value: `|size| × price`. */
export function notional(size: number, price: number): number {
  return Math.abs(size) * price;
}

/** Initial margin: `notional / leverage` (HL: `position_size × mark_price / leverage`). */
export function initialMargin(notionalUsd: number, leverage: number): number {
  if (!(leverage > 0)) throw new RangeError(`leverage must be positive, got ${leverage}`);
  return Math.abs(notionalUsd) / leverage;
}

/** Maintenance margin rate for a notional: half the initial margin rate at the tier's max leverage. */
export function maintenanceMarginRate(tiers: ReadonlyArray<MarginTier>, notionalUsd = 0): number {
  return tierForNotional(tiers, notionalUsd).maintenanceMarginRate;
}

/** Maintenance margin in USD: `notional × rate(tier) − deduction(tier)`. */
export function maintenanceMargin(tiers: ReadonlyArray<MarginTier>, notionalUsd: number): number {
  const t = tierForNotional(tiers, notionalUsd);
  return Math.abs(notionalUsd) * t.maintenanceMarginRate - t.maintenanceDeduction;
}

/** Maximum leverage allowed for a position of this notional (from the tier it falls into). */
export function maxLeverageForNotional(tiers: ReadonlyArray<MarginTier>, notionalUsd: number): number {
  return tierForNotional(tiers, notionalUsd).maxLeverage;
}
