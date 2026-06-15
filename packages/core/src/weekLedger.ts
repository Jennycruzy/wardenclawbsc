import { z } from "zod";
import type { WeekBudgetState } from "./weekBudget.js";

export interface WeekLeg {
  atIso: string;
  kind: "entry" | "exit" | "scout";
}

export interface WeekLedger {
  weekStartIso: string;
  startValueUsd: number;
  peakValueUsd: number;
  legs: WeekLeg[];
  pressTradeUsed: boolean;
}

const weekLedgerSchema = z.object({
  weekStartIso: z.string(),
  startValueUsd: z.number(),
  peakValueUsd: z.number(),
  legs: z.array(z.object({
    atIso: z.string(),
    kind: z.enum(["entry", "exit", "scout"]),
  })).default([]),
  pressTradeUsed: z.boolean().default(false),
});

export function initWeekLedger(weekStartIso: string, startValueUsd: number): WeekLedger {
  return { weekStartIso, startValueUsd, peakValueUsd: startValueUsd, legs: [], pressTradeUsed: false };
}

export function recordWeekValue(ledger: WeekLedger, valueUsd: number): WeekLedger {
  return valueUsd > ledger.peakValueUsd ? { ...ledger, peakValueUsd: valueUsd } : ledger;
}

export function recordLeg(
  ledger: WeekLedger,
  kind: WeekLeg["kind"] = "entry",
  atIso = new Date().toISOString(),
): WeekLedger {
  return { ...ledger, legs: [...ledger.legs, { atIso, kind }] };
}

export function consumePressTrade(ledger: WeekLedger): WeekLedger {
  return ledger.pressTradeUsed ? ledger : { ...ledger, pressTradeUsed: true };
}

export function legsOnUtcDay(ledger: WeekLedger, dayIso: string): number {
  const day = dayIso.slice(0, 10);
  return ledger.legs.filter((leg) => leg.atIso.slice(0, 10) === day).length;
}

export function entriesOnUtcDay(ledger: WeekLedger, dayIso: string): number {
  const day = dayIso.slice(0, 10);
  return ledger.legs.filter(
    (leg) => leg.atIso.slice(0, 10) === day && (leg.kind === "entry" || leg.kind === "scout"),
  ).length;
}

export function deriveWeekBudgetState(
  ledger: WeekLedger,
  currentValueUsd: number,
  weekElapsedFraction: number,
): WeekBudgetState {
  const weekReturnPct =
    ledger.startValueUsd > 0 ? ((currentValueUsd - ledger.startValueUsd) / ledger.startValueUsd) * 100 : 0;
  const drawdownFromPeakPct =
    ledger.peakValueUsd > 0 ? Math.max(0, ((ledger.peakValueUsd - currentValueUsd) / ledger.peakValueUsd) * 100) : 0;
  return {
    weekElapsedFraction,
    weekReturnPct,
    legsUsed: ledger.legs.length,
    drawdownFromPeakPct,
    pressTradeUsed: ledger.pressTradeUsed,
  };
}

export function serializeWeekLedger(ledger: WeekLedger): string {
  return JSON.stringify(weekLedgerSchema.parse(ledger));
}

export function parseWeekLedger(raw: string): WeekLedger {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  // Read the pre-upgrade format without inventing historical fills.
  if (!Array.isArray(parsed.legs)) {
    parsed.legs = [];
    parsed.pressTradeUsed = false;
  }
  return weekLedgerSchema.parse(parsed) as WeekLedger;
}
