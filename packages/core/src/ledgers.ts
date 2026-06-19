/**
 * Two first-class ledgers.
 *
 * The competition scores SIMULATED transaction costs, not live TWAK quotes, so
 * the number that wins the tournament (Scored Ledger) is NOT the number in the
 * real wallet capital (Wallet Ledger). We keep them separate on purpose:
 *
 *   • Scored Ledger  — price moves minus the simulated scoring cost. Drives the
 *     net-edge gate and the /bsc/proof leaderboard view (what judges rank).
 *   • Wallet Ledger  — actual on-chain portfolio value, embedding real TWAK fees,
 *     gas, slippage and LP fees. Drives capital protection (gas reserve, danger
 *     threshold, survival mode, dust prevention) and the wallet-floor sanity check.
 *
 * The real round-trip cost is MEASURED from fills (see RollingCost), never
 * hardcoded — it starts from the rehearsal swap and updates on every real fill.
 */

import { z } from "zod";

// ── Measuring a realized round-trip from real fills ──────────────────────────

export interface RoundTripMeasurement {
  /** USDT spent to enter (entry leg notional). */
  entryNotionalUsd: number;
  /** USDT actually received on exit (the exit fill's realized output). */
  exitProceedsUsd: number;
  /** Token mid price (USDT/token) at entry. */
  entryPrice: number;
  /** Token mid price (USDT/token) at exit. */
  exitPrice: number;
  /** Native gas paid on the entry leg, in USD (defaults 0). */
  entryGasUsd?: number;
  /** Native gas paid on the exit leg, in USD (defaults 0). */
  exitGasUsd?: number;
}

/**
 * Measure the REAL round-trip cost of a completed position in bps of notional,
 * isolated from the token's price move. The frictionless benchmark for a round
 * trip of `entryNotionalUsd` is `entryNotionalUsd × (exitPrice/entryPrice)` —
 * what the capital would be worth at exit with zero cost. The shortfall of the
 * actual proceeds against that benchmark is the slippage + LP-fee cost of BOTH
 * legs; gas (paid separately in native BNB) is added explicitly. Clamped at ≥0
 * so a favorable fill never feeds a negative cost into the rolling estimate.
 */
export function measureRoundTripBps(m: RoundTripMeasurement): number {
  if (!(m.entryNotionalUsd > 0)) throw new Error("measureRoundTripBps: entryNotionalUsd must be > 0");
  if (!(m.entryPrice > 0) || !(m.exitPrice > 0)) throw new Error("measureRoundTripBps: prices must be > 0");
  if (!(m.exitProceedsUsd >= 0)) throw new Error("measureRoundTripBps: exitProceedsUsd must be >= 0");
  const frictionlessUsd = m.entryNotionalUsd * (m.exitPrice / m.entryPrice);
  const slipFeeBps = (1 - m.exitProceedsUsd / frictionlessUsd) * 10_000;
  const gasBps = (((m.entryGasUsd ?? 0) + (m.exitGasUsd ?? 0)) / m.entryNotionalUsd) * 10_000;
  return Math.max(0, slipFeeBps + gasBps);
}

// ── Rolling real round-trip cost estimate (Wallet Ledger input) ──────────────

export interface RollingCostState {
  /** Modeled estimate used until real fills arrive (real friction at size). */
  bootstrapBps: number;
  /** Realized round-trip bps measured from real fills, most-recent last. */
  samples: number[];
  /** Max samples retained for the rolling mean. */
  windowSize: number;
}

export function initRollingCost(bootstrapBps: number, windowSize = 10): RollingCostState {
  if (!(bootstrapBps >= 0)) throw new Error("initRollingCost: bootstrapBps must be >= 0");
  if (windowSize < 1) throw new Error("initRollingCost: windowSize must be >= 1");
  return { bootstrapBps, samples: [], windowSize };
}

/** Record a realized round-trip cost (bps) from a real fill. Returns new state. */
export function recordRoundTrip(state: RollingCostState, realizedBps: number): RollingCostState {
  if (!Number.isFinite(realizedBps) || realizedBps < 0) {
    throw new Error(`recordRoundTrip: realizedBps must be a finite number >= 0 (got ${realizedBps})`);
  }
  const samples = [...state.samples, realizedBps].slice(-state.windowSize);
  return { ...state, samples };
}

/** Current rolling real round-trip cost: mean of fills, or the bootstrap if none. */
export function realRoundTripBps(state: RollingCostState): number {
  if (state.samples.length === 0) return state.bootstrapBps;
  return state.samples.reduce((s, v) => s + v, 0) / state.samples.length;
}

const rollingCostSchema = z.object({
  bootstrapBps: z.number(),
  samples: z.array(z.number()),
  windowSize: z.number(),
});

export function serializeRollingCost(state: RollingCostState): string {
  return JSON.stringify(rollingCostSchema.parse(state));
}

/** Parse a persisted wallet-cost ledger, throwing loudly on corruption. */
export function parseRollingCost(raw: string): RollingCostState {
  return rollingCostSchema.parse(JSON.parse(raw)) as RollingCostState;
}

// ── Scored Ledger ────────────────────────────────────────────────────────────

export interface ScoredTrade {
  id: string;
  /** Realized price move over the trade, in bps (can be negative). */
  priceMoveBps: number;
  /** Round-trip simulated scoring cost charged to this trade, in bps. */
  scoredFrictionBps: number;
  notionalUsd: number;
}

/** Scored return for a single trade in bps: price move minus the scoring cost. */
export function scoredReturnBps(t: Pick<ScoredTrade, "priceMoveBps" | "scoredFrictionBps">): number {
  return t.priceMoveBps - t.scoredFrictionBps;
}

export interface ScoredLedgerSummary {
  tradeCount: number;
  cumulativeReturnBps: number;
  cumulativeReturnUsd: number;
}

/** Aggregate scored trades into the leaderboard view. */
export function summarizeScoredLedger(trades: ScoredTrade[]): ScoredLedgerSummary {
  let cumulativeReturnBps = 0;
  let cumulativeReturnUsd = 0;
  for (const t of trades) {
    const r = scoredReturnBps(t);
    cumulativeReturnBps += r;
    cumulativeReturnUsd += (r / 10_000) * t.notionalUsd;
  }
  return { tradeCount: trades.length, cumulativeReturnBps, cumulativeReturnUsd };
}
