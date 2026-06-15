/**
 * Red-day regime analyst — GREEN / NEUTRAL / RED with hysteresis.
 *
 * Micro-cap momentum dies on red market days: breadth collapses, the benchmark
 * bleeds, and every long is correlated. The analyst reads three deterministic
 * breadth signals each cycle (the LLM touches none of it) — benchmark 24h change,
 * the CMC Fear & Greed index, and how many tracked majors are up — and votes them
 * into a raw regime. A RED committed regime blocks new entries (REJECT_REGIME_RED,
 * scouts and safety exits excepted) and the worker rotates open risk to stables.
 *
 * Hysteresis matters more than the raw read: flip-flopping on one noisy cycle is
 * worse than reacting a cycle late. A switch in the committed regime requires
 * `hysteresisChecks` CONSECUTIVE confirming raw reads; a single disagreeing cycle
 * resets the pending counter.
 */

import { z } from "zod";

export type Regime = "GREEN" | "NEUTRAL" | "RED";

export interface RegimeSignals {
  /** Benchmark (BNB / eligible-majors) 24h change, percent. */
  benchmarkChange24hPct: number;
  /** Short-horizon benchmark change from CMC (currently 1h). */
  benchmarkShortChangePct: number;
  /** BTC 24h change for cross-market confirmation. */
  btcChange24hPct: number;
  /** Current benchmark price relative to its recent decision-cycle mean. */
  benchmarkAboveRecentMean: boolean;
  /** CMC Fear & Greed index, 0..100. */
  fearGreed: number;
  /** Fraction of tracked majors with positive 24h change, [0,1]. */
  breadthUpFraction: number;
  /** Benchmark short-horizon absolute move divided by the majors baseline. */
  volatilityRatio: number;
}

export interface RegimeConfig {
  /** Benchmark 24h change (%) at/below which the signal votes RED. */
  redBenchmarkPct: number;
  /** Benchmark 24h change (%) at/above which the signal votes GREEN. */
  greenBenchmarkPct: number;
  /** Fear & Greed at/below which the signal votes RED. */
  redFearGreed: number;
  /** Fear & Greed at/above which the signal votes GREEN. */
  greenFearGreed: number;
  /** Breadth up-fraction at/below which the signal votes RED. */
  redBreadth: number;
  /** Breadth up-fraction at/above which the signal votes GREEN. */
  greenBreadth: number;
  /** Consecutive confirming raw reads required to switch the committed regime. */
  hysteresisChecks: number;
  /** Ratio at/above which volatility is considered elevated. */
  highVolatilityRatio: number;
}

export interface RegimeState {
  /** The committed regime currently in force. */
  current: Regime;
  /** The raw regime accumulating confirmations toward a switch (or === current). */
  pendingRaw: Regime;
  /** Consecutive raw reads that have confirmed `pendingRaw`. */
  pendingCount: number;
}

export interface RegimeResult {
  state: RegimeState;
  /** The unsmoothed read this cycle. */
  rawRegime: Regime;
  /** Net signal vote in [-3, +3] (negative = risk-off). */
  score: number;
  /** Whether the committed regime changed this cycle. */
  changed: boolean;
  /** New directional entries are blocked (committed regime is RED). */
  blocksEntries: boolean;
  reason: string;
}

const regimeStateSchema = z.object({
  current: z.enum(["GREEN", "NEUTRAL", "RED"]),
  pendingRaw: z.enum(["GREEN", "NEUTRAL", "RED"]),
  pendingCount: z.number(),
});

/** Fresh analyst state: NEUTRAL until the signals prove otherwise. */
export function initRegimeState(): RegimeState {
  return { current: "NEUTRAL", pendingRaw: "NEUTRAL", pendingCount: 0 };
}

/** Weighted analyst: benchmark/BTC trend, breadth, sentiment, and volatility. */
export function rawRegime(signals: RegimeSignals, cfg: RegimeConfig): { regime: Regime; score: number } {
  let score = 0;
  const bearishTrend =
    signals.benchmarkChange24hPct <= cfg.redBenchmarkPct &&
    signals.btcChange24hPct < 0 &&
    signals.benchmarkShortChangePct < 0 &&
    !signals.benchmarkAboveRecentMean;
  const bullishTrend =
    signals.benchmarkChange24hPct >= cfg.greenBenchmarkPct &&
    signals.btcChange24hPct > 0 &&
    signals.benchmarkShortChangePct > 0 &&
    signals.benchmarkAboveRecentMean;
  if (bearishTrend) score -= 2;
  else if (bullishTrend) score += 2;
  if (signals.fearGreed <= cfg.redFearGreed) score -= 1;
  else if (signals.fearGreed >= cfg.greenFearGreed) score += 1;
  if (signals.breadthUpFraction <= cfg.redBreadth) score -= 1;
  else if (signals.breadthUpFraction >= cfg.greenBreadth) score += 1;
  if (signals.volatilityRatio >= cfg.highVolatilityRatio) {
    if (signals.benchmarkShortChangePct < 0) score -= 1;
    else if (signals.benchmarkShortChangePct > 0) score += 1;
  }
  const regime: Regime = score <= -3 ? "RED" : score >= 3 ? "GREEN" : "NEUTRAL";
  return { regime, score };
}

/**
 * Advance the regime state by one cycle. The committed regime only changes after
 * `hysteresisChecks` consecutive raw reads agree on a different regime.
 */
export function evaluateRegime(prev: RegimeState, signals: RegimeSignals, cfg: RegimeConfig): RegimeResult {
  const { regime: raw, score } = rawRegime(signals, cfg);

  const result = (state: RegimeState, changed: boolean, reason: string): RegimeResult => ({
    state,
    rawRegime: raw,
    score,
    changed,
    blocksEntries: state.current === "RED",
    reason,
  });

  // Raw agrees with the committed regime → nothing pending.
  if (raw === prev.current) {
    return result({ current: prev.current, pendingRaw: prev.current, pendingCount: 0 }, false, `regime ${prev.current} (score ${score})`);
  }

  // Raw disagrees → accumulate consecutive confirmations.
  const pendingCount = raw === prev.pendingRaw ? prev.pendingCount + 1 : 1;
  if (pendingCount >= cfg.hysteresisChecks) {
    return result(
      { current: raw, pendingRaw: raw, pendingCount: 0 },
      true,
      `regime ${prev.current}→${raw} (score ${score}, confirmed ${pendingCount}×)`,
    );
  }
  return result(
    { current: prev.current, pendingRaw: raw, pendingCount },
    false,
    `regime ${prev.current} holding; ${raw} pending ${pendingCount}/${cfg.hysteresisChecks} (score ${score})`,
  );
}

export function serializeRegimeState(state: RegimeState): string {
  return JSON.stringify(regimeStateSchema.parse(state));
}

/** Parse persisted regime state, throwing loudly on corruption (no fake state). */
export function parseRegimeState(raw: string): RegimeState {
  return regimeStateSchema.parse(JSON.parse(raw)) as RegimeState;
}
