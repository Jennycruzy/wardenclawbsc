/**
 * Week-schedule risk budget — HUNT / PRESS / DEFEND.
 *
 * The competition is a one-week sprint, not an indefinite grind, so risk is
 * budgeted across the WEEK, not just per-trade. A deterministic state machine
 * (the LLM touches none of it) sets a size multiplier from three facts: how far
 * through the week we are, the week-to-date return, and how many trade "legs"
 * (round-trip entries) remain in the weekly budget.
 *
 *   HUNT   — the default. Flat or early; seek edges at baseline size.
 *   PRESS  — ahead, budget healthy, legs available: size UP (still bounded by the
 *            hard caps downstream) to compound the lead.
 *   DEFEND — behind, OR giving back gains, OR a lead worth locking in (win-first),
 *            OR late in the week with legs too scarce to keep pacing: size DOWN.
 *
 * Win-first: a lead past `lockInReturnPct` is DEFENDED, never re-risked — finishing
 * ahead beats squeezing the last basis point. Leg-counting reserves enough legs to
 * satisfy the daily-minimum compliance trade for every remaining day.
 *
 * The multiplier only scales the governor's allowed fraction; the maxPositionPct
 * cap and the volatility-stop size still bind, so PRESS can never breach them.
 */

export type RiskState = "HUNT" | "PRESS" | "DEFEND";

export interface WeekBudgetConfig {
  /** Total trade legs (round-trip entries) budgeted for the competition week. */
  weeklyLegBudget: number;
  /** Week-to-date return (%) at/above which we PRESS the advantage. */
  pressThresholdPct: number;
  /** Week-to-date return (%) at/below which we DEFEND. Typically negative. */
  defendThresholdPct: number;
  /** Week return (%) at/above which the lead is locked in → DEFEND (win-first). */
  lockInReturnPct: number;
  /** Drawdown from the week's peak (%) that forces DEFEND (stop giving back gains). */
  maxGiveBackPct: number;
  /** Size multiplier applied when PRESSing (>1; still capped downstream). */
  pressSizeMultiplier: number;
  /** Size multiplier applied when DEFENDing (<1). */
  defendSizeMultiplier: number;
  /** Fraction of the week elapsed beyond which scarce legs force DEFEND. */
  lateWeekFraction: number;
  /** Legs reserved per remaining day for the daily-minimum compliance trade. */
  reservedLegsPerDay: number;
  /** Length of the competition week in days (for leg pacing). */
  weekLengthDays: number;
}

export interface WeekBudgetState {
  /** Fraction of the competition week elapsed, clamped to [0,1]. */
  weekElapsedFraction: number;
  /** Realized week-to-date return, percent (signed). */
  weekReturnPct: number;
  /** Trade legs used so far this week. */
  legsUsed: number;
  /** Drawdown from the week's peak value, percent (≥0). */
  drawdownFromPeakPct: number;
}

export interface WeekBudgetResult {
  state: RiskState;
  /** Multiplier applied to the governor's allowed size fraction. */
  sizeMultiplier: number;
  /** Legs left in the weekly budget (never negative). */
  legsRemaining: number;
  /** Legs reserved to cover the daily minimum for the remaining days. */
  reservedLegs: number;
  /** True when remaining legs are at/below the compliance reserve. */
  legsScarce: boolean;
  reason: string;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Fraction of the competition week elapsed at `nowIso`, clamped to [0,1].
 * Before the window opens this is 0; after it closes, 1.
 */
export function weekElapsedFraction(nowIso: string, startIso: string, endIso: string): number {
  const now = Date.parse(nowIso);
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(now) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 0;
  }
  return clamp01((now - start) / (end - start));
}

export function evaluateWeekBudget(state: WeekBudgetState, cfg: WeekBudgetConfig): WeekBudgetResult {
  const elapsed = clamp01(state.weekElapsedFraction);
  const legsRemaining = Math.max(0, cfg.weeklyLegBudget - state.legsUsed);
  const daysRemaining = Math.max(0, cfg.weekLengthDays * (1 - elapsed));
  // Reserve enough legs to keep satisfying the daily minimum for every day left.
  const reservedLegs = Math.ceil(daysRemaining) * cfg.reservedLegsPerDay;
  const legsScarce = legsRemaining <= reservedLegs;

  const base = { legsRemaining, reservedLegs, legsScarce };
  const defend = (reason: string): WeekBudgetResult => ({
    state: "DEFEND",
    sizeMultiplier: cfg.defendSizeMultiplier,
    reason,
    ...base,
  });

  // Win-first: a lead worth locking in is defended, not re-risked.
  if (state.weekReturnPct >= cfg.lockInReturnPct) {
    return defend(`lead locked at +${state.weekReturnPct.toFixed(1)}% (≥${cfg.lockInReturnPct}%) — defending to finish ahead`);
  }
  // Behind, giving back gains, or late with scarce legs → protect capital.
  if (state.weekReturnPct <= cfg.defendThresholdPct) {
    return defend(`week return ${state.weekReturnPct.toFixed(1)}% ≤ ${cfg.defendThresholdPct}% — defending`);
  }
  if (state.drawdownFromPeakPct >= cfg.maxGiveBackPct) {
    return defend(`gave back ${state.drawdownFromPeakPct.toFixed(1)}% from the week peak (≥${cfg.maxGiveBackPct}%) — defending`);
  }
  if (elapsed >= cfg.lateWeekFraction && legsScarce) {
    return defend(`late week (${(elapsed * 100).toFixed(0)}% elapsed) with ${legsRemaining} leg(s) left ≤ ${reservedLegs} reserved — defending`);
  }

  // Ahead, budget healthy, legs to spare → press the advantage.
  if (state.weekReturnPct >= cfg.pressThresholdPct && !legsScarce) {
    return {
      state: "PRESS",
      sizeMultiplier: cfg.pressSizeMultiplier,
      reason: `week return +${state.weekReturnPct.toFixed(1)}% (≥${cfg.pressThresholdPct}%), ${legsRemaining} leg(s) left — pressing ×${cfg.pressSizeMultiplier}`,
      ...base,
    };
  }

  return {
    state: "HUNT",
    sizeMultiplier: 1,
    reason: `week return ${state.weekReturnPct.toFixed(1)}%, ${legsRemaining} leg(s) left — hunting at baseline size`,
    ...base,
  };
}
