/**
 * Hyperliquid's weekly upgrade: a short maintenance, then a post-only period in which only post-only (ALO) orders are
 * accepted, so market and IOC orders do not fill. TWAP slices are IOC, so a TWAP pauses for the whole window instead
 * of wasting slices, and resumes afterwards.
 *
 * {@link exchangeWindow} combines the two signals Kokoah has:
 * - the documented schedule: maintenance windows from Hyperliquid's status page (`scheduledFor`–`scheduledUntil`),
 *   followed by {@link POST_ONLY_WINDOW_MS} of post-only trading;
 * - `specialStatuses` from Hyperliquid's `exchangeStatus` info request, which is `null` in normal trading. Its shape
 *   during a special status is not documented, so any other value counts as a special status.
 *
 * @module
 */

/** How long Hyperliquid stays post-only after a maintenance ends. */
export const POST_ONLY_WINDOW_MS = 15 * 60_000;

/** A maintenance window from Hyperliquid's status page (ms timestamps). */
export interface ScheduledMaintenance {
  scheduledFor: number;
  scheduledUntil: number;
}

/** Whether IOC orders can fill right now. */
export interface ExchangeWindow {
  active: boolean;
  reason?: "maintenance" | "postOnly" | "special";
  /** When the window is expected to end (unknown for a special status). */
  until?: number;
}

/** True when `exchangeStatus.specialStatuses` reports something other than normal trading. */
export function hasSpecialStatus(specialStatuses: unknown): boolean {
  if (specialStatuses === null || specialStatuses === undefined) return false;
  if (Array.isArray(specialStatuses)) return specialStatuses.length > 0;
  if (typeof specialStatuses === "object") return Object.keys(specialStatuses).length > 0;
  return specialStatuses !== false && specialStatuses !== "";
}

/** The maintenance or post-only window at `now`, if any (see the module notes). */
export function exchangeWindow(input: { now: number; maintenance?: readonly ScheduledMaintenance[]; specialStatuses?: unknown }): ExchangeWindow {
  const { now } = input;
  for (const m of input.maintenance ?? []) {
    if (!(m.scheduledFor > 0) || !(m.scheduledUntil >= m.scheduledFor)) continue;
    const until = m.scheduledUntil + POST_ONLY_WINDOW_MS;
    if (now >= m.scheduledFor && now < m.scheduledUntil) return { active: true, reason: "maintenance", until };
    if (now >= m.scheduledUntil && now < until) return { active: true, reason: "postOnly", until };
  }
  if (hasSpecialStatus(input.specialStatuses)) return { active: true, reason: "special" };
  return { active: false };
}
