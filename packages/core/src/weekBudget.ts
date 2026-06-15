/**
 * Competition-week doctrine: HUNT early, take one pre-committed PRESS shot when
 * still flat on day 6+, and DEFEND a meaningful lead. These controls only make
 * gates stricter or lower the score threshold for that one PRESS trade; they
 * never bypass eligibility, economics, coherence, governor, shadow-fill, or TWAK.
 */

export type RiskState = "HUNT" | "PRESS" | "DEFEND";

export interface WeekBudgetConfig {
  weeklyLegBudget: number;
  flatBandLoPct: number;
  flatBandHiPct: number;
  defendTriggerPct: number;
  huntMinScore: number;
  pressMinScore: number;
  defendMinScore: number;
  netEdgeDefendBonusBps: number;
  pressStartDay: number;
  reservedLegsPerDay: number;
  weekLengthDays: number;
}

export interface WeekBudgetState {
  weekElapsedFraction: number;
  weekReturnPct: number;
  legsUsed: number;
  drawdownFromPeakPct: number;
  pressTradeUsed: boolean;
}

export interface WeekBudgetResult {
  state: RiskState;
  sizeMultiplier: number;
  minimumScore: number;
  netEdgeBonusBps: number;
  pressTrade: boolean;
  tightTrail: boolean;
  legsRemaining: number;
  reservedLegs: number;
  legsScarce: boolean;
  reason: string;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function weekElapsedFraction(nowIso: string, startIso: string, endIso: string): number {
  const now = Date.parse(nowIso);
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(now) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return clamp01((now - start) / (end - start));
}

export function competitionDay(elapsedFraction: number, weekLengthDays: number): number {
  if (weekLengthDays < 1) return 1;
  return Math.min(weekLengthDays, Math.floor(clamp01(elapsedFraction) * weekLengthDays) + 1);
}

export function evaluateWeekBudget(state: WeekBudgetState, cfg: WeekBudgetConfig): WeekBudgetResult {
  const elapsed = clamp01(state.weekElapsedFraction);
  const day = competitionDay(elapsed, cfg.weekLengthDays);
  const legsRemaining = Math.max(0, cfg.weeklyLegBudget - state.legsUsed);
  const remainingDays = Math.max(0, cfg.weekLengthDays - day + 1);
  const reservedLegs = remainingDays * cfg.reservedLegsPerDay;
  const legsScarce = legsRemaining <= reservedLegs;
  const base = { sizeMultiplier: 1, legsRemaining, reservedLegs, legsScarce };

  if (state.weekReturnPct > cfg.defendTriggerPct) {
    return {
      ...base,
      state: "DEFEND",
      minimumScore: cfg.defendMinScore,
      netEdgeBonusBps: cfg.netEdgeDefendBonusBps,
      pressTrade: false,
      tightTrail: true,
      reason: `scored return +${state.weekReturnPct.toFixed(1)}% > ${cfg.defendTriggerPct}% - protecting the lead`,
    };
  }

  const flat =
    state.weekReturnPct >= cfg.flatBandLoPct &&
    state.weekReturnPct <= cfg.flatBandHiPct;
  if (day >= cfg.pressStartDay && flat && !state.pressTradeUsed && !legsScarce) {
    return {
      ...base,
      state: "PRESS",
      minimumScore: cfg.pressMinScore,
      netEdgeBonusBps: 0,
      pressTrade: true,
      tightTrail: false,
      reason: `day ${day}, scored return ${state.weekReturnPct.toFixed(1)}% inside ${cfg.flatBandLoPct}%..+${cfg.flatBandHiPct}% - one pre-committed PRESS trade available`,
    };
  }

  return {
    ...base,
    state: "HUNT",
    minimumScore: cfg.huntMinScore,
    netEdgeBonusBps: 0,
    pressTrade: false,
    tightTrail: false,
    reason: state.pressTradeUsed
      ? `PRESS trade already consumed - thresholds restored; hunting at score ${cfg.huntMinScore}+`
      : `day ${day}, scored return ${state.weekReturnPct.toFixed(1)}% - hunting at score ${cfg.huntMinScore}+`,
  };
}
