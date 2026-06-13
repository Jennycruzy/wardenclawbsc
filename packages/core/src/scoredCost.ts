/**
 * Scored transaction-cost model — the SINGLE source of truth for what the
 * competition charges a trade.
 *
 * Organizers confirmed scoring applies a SIMULATED transaction cost, not live
 * TWAK quotes. Until they publish the exact model we charge a conservative flat
 * `scoringSimCostBps` per leg (round trip = 2 legs). When the real model lands,
 * THIS function is the only thing to change — `SCORING_SIM_COST_BPS` (or a richer
 * body here) retunes the net-edge gate with no other code edits.
 */

export interface ScoredCostInputs {
  /** Trade notional in USD. Unused by the flat model; kept so a future
   *  size-dependent cost model can plug in here without signature churn. */
  notionalUsd: number;
  /** Competition's simulated cost per leg, in bps. */
  scoringSimCostBps: number;
}

/** Round-trip scored friction in bps (the cost the leaderboard charges). */
export function computeScoredFrictionBps(inputs: ScoredCostInputs): number {
  if (inputs.scoringSimCostBps < 0) {
    throw new Error("computeScoredFrictionBps: scoringSimCostBps must be >= 0");
  }
  // Flat per-leg model, both legs. Replace this body when organizers publish.
  return inputs.scoringSimCostBps * 2;
}
