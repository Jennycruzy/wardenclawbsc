/**
 * Per-UTC-day drawdown anchor.
 *
 * The week ledger tracks the whole-window peak (the 30% DQ metric). This tracks
 * the intraday peak so the governor's daily layer (maxDailyDrawdownPct) can throttle
 * size on a bad day independently of the slower whole-window budget. The anchor
 * resets at UTC midnight; it is pure and restart-safe (persisted by the worker).
 */

import { z } from "zod";

export interface DailyAnchor {
  /** UTC calendar day (YYYY-MM-DD) the peak belongs to. */
  dayIso: string;
  /** Highest portfolio value seen so far today, same valuation basis as the
   *  whole-window drawdown (marked-to-market wallet value). */
  peakValueUsd: number;
}

const dailyAnchorSchema = z.object({
  dayIso: z.string(),
  peakValueUsd: z.number(),
});

export interface DailyDrawdownResult {
  anchor: DailyAnchor;
  /** Peak-to-trough drawdown so far today, in percent, never negative. */
  dailyDrawdownPct: number;
}

/**
 * Roll the anchor for the current UTC day, fold in the latest value, and report
 * today's peak-to-trough drawdown. A missing anchor or a new UTC day resets the
 * peak to the current value (drawdown 0) — we never carry a stale peak across days.
 */
export function updateDailyDrawdown(
  anchor: DailyAnchor | undefined,
  valueUsd: number,
  nowIso: string = new Date().toISOString(),
): DailyDrawdownResult {
  const today = nowIso.slice(0, 10);
  if (!anchor || anchor.dayIso !== today) {
    return { anchor: { dayIso: today, peakValueUsd: valueUsd }, dailyDrawdownPct: 0 };
  }
  const peakValueUsd = Math.max(anchor.peakValueUsd, valueUsd);
  const dailyDrawdownPct =
    peakValueUsd > 0 ? Math.max(0, ((peakValueUsd - valueUsd) / peakValueUsd) * 100) : 0;
  return { anchor: { dayIso: today, peakValueUsd }, dailyDrawdownPct };
}

export function serializeDailyAnchor(anchor: DailyAnchor): string {
  return JSON.stringify(dailyAnchorSchema.parse(anchor));
}

export function parseDailyAnchor(raw: string): DailyAnchor {
  return dailyAnchorSchema.parse(JSON.parse(raw));
}
