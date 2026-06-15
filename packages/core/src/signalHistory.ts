/**
 * Per-token signal history.
 *
 * Entry quality (WS5) keys on CHANGE across checks, not a single snapshot: a
 * trending rank that is rising fast, volume expanding off its own baseline, and a
 * post-spike consolidation+continuation rather than the first vertical. That needs
 * a short rolling history per token, persisted across worker cycles. This module
 * is pure (append / window / serialize with loud validation); the worker owns IO.
 */

import { z } from "zod";

export interface SignalObservation {
  checkIso: string;
  price: number;
  volume24hUsd: number;
  change24hPct: number;
  /** Benchmark (BNB or eligible-majors composite) 24h change at this check (for RS). */
  benchmarkChange24hPct?: number;
  /** CMC trending rank at this check; absent when the token is off the trending list. */
  trendingRank?: number;
}

export interface TokenHistory {
  symbol: string;
  /** Chronological, oldest first. */
  observations: SignalObservation[];
}

const observationSchema = z.object({
  checkIso: z.string(),
  price: z.number(),
  volume24hUsd: z.number(),
  change24hPct: z.number(),
  benchmarkChange24hPct: z.number().optional(),
  trendingRank: z.number().optional(),
});

const tokenHistorySchema = z.object({
  symbol: z.string(),
  observations: z.array(observationSchema),
});

export const signalHistorySchema = z.array(tokenHistorySchema);

/** Append an observation to a token's history, capped at `maxLen` (oldest dropped). */
export function appendObservation(
  history: TokenHistory,
  obs: SignalObservation,
  maxLen = 20,
): TokenHistory {
  const observations = [...history.observations, obs].slice(-maxLen);
  return { ...history, observations };
}

/** The most recent `n` observations (chronological). */
export function recentObservations(history: TokenHistory, n: number): SignalObservation[] {
  return history.observations.slice(-n);
}

export function serializeSignalHistory(histories: TokenHistory[]): string {
  return JSON.stringify(signalHistorySchema.parse(histories));
}

/** Parse persisted history, throwing loudly on corruption (no fake state). */
export function parseSignalHistory(raw: string): TokenHistory[] {
  return signalHistorySchema.parse(JSON.parse(raw)) as TokenHistory[];
}
