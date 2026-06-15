import { describe, it, expect } from "vitest";
import {
  competitionDay,
  evaluateWeekBudget,
  weekElapsedFraction,
  type WeekBudgetConfig,
  type WeekBudgetState,
} from "../src/index.js";

const cfg: WeekBudgetConfig = {
  weeklyLegBudget: 14,
  flatBandLoPct: -2,
  flatBandHiPct: 3,
  defendTriggerPct: 8,
  huntMinScore: 80,
  pressMinScore: 65,
  defendMinScore: 90,
  netEdgeDefendBonusBps: 50,
  pressStartDay: 6,
  reservedLegsPerDay: 1,
  weekLengthDays: 7,
};

function state(overrides: Partial<WeekBudgetState> = {}): WeekBudgetState {
  return {
    weekElapsedFraction: 0.3,
    weekReturnPct: 0,
    legsUsed: 4,
    drawdownFromPeakPct: 0,
    pressTradeUsed: false,
    ...overrides,
  };
}

describe("evaluateWeekBudget", () => {
  it("HUNTs from hour one on days 1-5 at the normal score threshold", () => {
    const r = evaluateWeekBudget(state({ weekElapsedFraction: 0 }), cfg);
    expect(r.state).toBe("HUNT");
    expect(r.minimumScore).toBe(80);
    expect(r.pressTrade).toBe(false);
  });

  it("offers exactly one lowered-band PRESS trade on day 6 while flat", () => {
    const r = evaluateWeekBudget(state({ weekElapsedFraction: 5 / 7, weekReturnPct: 1 }), cfg);
    expect(r.state).toBe("PRESS");
    expect(r.minimumScore).toBe(65);
    expect(r.pressTrade).toBe(true);
  });

  it("restores HUNT thresholds after the PRESS trade is consumed", () => {
    const r = evaluateWeekBudget(
      state({ weekElapsedFraction: 5 / 7, weekReturnPct: 1, pressTradeUsed: true }),
      cfg,
    );
    expect(r.state).toBe("HUNT");
    expect(r.minimumScore).toBe(80);
    expect(r.pressTrade).toBe(false);
  });

  it("does not PRESS outside the flat band", () => {
    expect(evaluateWeekBudget(state({ weekElapsedFraction: 5 / 7, weekReturnPct: -3 }), cfg).state).toBe("HUNT");
    expect(evaluateWeekBudget(state({ weekElapsedFraction: 5 / 7, weekReturnPct: 4 }), cfg).state).toBe("HUNT");
  });

  it("DEFENDs above the trigger with a tighter trail and stricter gates", () => {
    const r = evaluateWeekBudget(state({ weekElapsedFraction: 0.2, weekReturnPct: 9 }), cfg);
    expect(r.state).toBe("DEFEND");
    expect(r.minimumScore).toBe(90);
    expect(r.netEdgeBonusBps).toBe(50);
    expect(r.tightTrail).toBe(true);
  });

  it("does not spend the compliance reserve on a PRESS trade", () => {
    const r = evaluateWeekBudget(state({ weekElapsedFraction: 5 / 7, legsUsed: 12 }), cfg);
    expect(r.legsScarce).toBe(true);
    expect(r.state).toBe("HUNT");
  });
});

describe("competition timing", () => {
  const start = "2026-06-22T00:00:00Z";
  const end = "2026-06-28T23:59:59Z";

  it("maps the opening instant to day 1 and 5/7 elapsed to day 6", () => {
    expect(competitionDay(0, 7)).toBe(1);
    expect(competitionDay(5 / 7, 7)).toBe(6);
  });

  it("clamps elapsed fraction outside the window", () => {
    expect(weekElapsedFraction("2026-06-20T00:00:00Z", start, end)).toBe(0);
    expect(weekElapsedFraction("2026-07-01T00:00:00Z", start, end)).toBe(1);
  });
});
