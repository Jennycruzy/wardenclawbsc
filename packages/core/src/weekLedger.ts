/**
 * Week-ledger persistence for the WS6 risk budget. The HUNT/PRESS/DEFEND state
 * machine keys on week-to-date return, drawdown from the week peak, and legs used
 * — all of which must survive a worker restart, so they are written to the runtime
 * store and restored on startup. This module is pure (init / record / derive /
 * serialize / parse with loud validation); file IO lives in the worker.
 */

import { z } from "zod";
import type { WeekBudgetState } from "./weekBudget.js";

export interface WeekLedger {
  /** Start of the competition week this ledger tracks (window open). */
  weekStartIso: string;
  /** Portfolio value at the start of the week (return baseline). */
  startValueUsd: number;
  /** Highest portfolio value seen this week (give-back baseline). */
  peakValueUsd: number;
  /** Trade legs (round-trip entries) executed this week. */
  legsUsed: number;
}

const weekLedgerSchema = z.object({
  weekStartIso: z.string(),
  startValueUsd: z.number(),
  peakValueUsd: z.number(),
  legsUsed: z.number(),
});

/** A fresh ledger for a week starting at `weekStartIso` with `startValueUsd`. */
export function initWeekLedger(weekStartIso: string, startValueUsd: number): WeekLedger {
  return { weekStartIso, startValueUsd, peakValueUsd: startValueUsd, legsUsed: 0 };
}

/** Update the running peak with the latest portfolio value (ratchet up only). */
export function recordWeekValue(ledger: WeekLedger, valueUsd: number): WeekLedger {
  return valueUsd > ledger.peakValueUsd ? { ...ledger, peakValueUsd: valueUsd } : ledger;
}

/** Count one executed trade leg against the weekly budget. */
export function recordLeg(ledger: WeekLedger): WeekLedger {
  return { ...ledger, legsUsed: ledger.legsUsed + 1 };
}

/**
 * Derive the week-budget STATE from the ledger, the current value, and how far
 * through the week we are. Return and drawdown are pure functions of the ledger;
 * the elapsed fraction is supplied by the caller (computed from the window).
 */
export function deriveWeekBudgetState(
  ledger: WeekLedger,
  currentValueUsd: number,
  weekElapsedFraction: number,
): WeekBudgetState {
  const weekReturnPct =
    ledger.startValueUsd > 0 ? ((currentValueUsd - ledger.startValueUsd) / ledger.startValueUsd) * 100 : 0;
  const drawdownFromPeakPct =
    ledger.peakValueUsd > 0 ? Math.max(0, ((ledger.peakValueUsd - currentValueUsd) / ledger.peakValueUsd) * 100) : 0;
  return { weekElapsedFraction, weekReturnPct, legsUsed: ledger.legsUsed, drawdownFromPeakPct };
}

export function serializeWeekLedger(ledger: WeekLedger): string {
  return JSON.stringify(weekLedgerSchema.parse(ledger));
}

/** Parse a persisted ledger, throwing loudly on corruption (no fake state). */
export function parseWeekLedger(raw: string): WeekLedger {
  return weekLedgerSchema.parse(JSON.parse(raw)) as WeekLedger;
}
