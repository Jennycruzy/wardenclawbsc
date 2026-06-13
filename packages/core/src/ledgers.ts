/**
 * Two first-class ledgers.
 *
 * The competition scores SIMULATED transaction costs, not live TWAK quotes, so
 * the number that wins the tournament (Scored Ledger) is NOT the number in the
 * real $40 wallet (Wallet Ledger). We keep them separate on purpose:
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
