import { describe, it, expect } from "vitest";
import {
  evaluateWeekBudget,
  weekElapsedFraction,
  type WeekBudgetConfig,
  type WeekBudgetState,
} from "../src/index.js";

const cfg: WeekBudgetConfig = {
  weeklyLegBudget: 14,
  pressThresholdPct: 8,
  defendThresholdPct: -3,
  lockInReturnPct: 25,
  maxGiveBackPct: 5,
  pressSizeMultiplier: 1.3,
  defendSizeMultiplier: 0.5,
  lateWeekFraction: 0.7,
  reservedLegsPerDay: 1,
  weekLengthDays: 7,
};

function state(overrides: Partial<WeekBudgetState> = {}): WeekBudgetState {
  return { weekElapsedFraction: 0.3, weekReturnPct: 2, legsUsed: 4, drawdownFromPeakPct: 1, ...overrides };
}

describe("evaluateWeekBudget", () => {
  it("HUNTs at baseline size when flat with budget to spare", () => {
    const r = evaluateWeekBudget(state(), cfg);
    expect(r.state).toBe("HUNT");
    expect(r.sizeMultiplier).toBe(1);
    expect(r.legsRemaining).toBe(10);
    expect(r.legsScarce).toBe(false);
  });

  it("PRESSes when ahead, healthy, and legs are available", () => {
    const r = evaluateWeekBudget(state({ weekReturnPct: 12 }), cfg);
    expect(r.state).toBe("PRESS");
    expect(r.sizeMultiplier).toBe(1.3);
  });

  it("DEFENDs when behind (≤ defend threshold)", () => {
    const r = evaluateWeekBudget(state({ weekReturnPct: -5 }), cfg);
    expect(r.state).toBe("DEFEND");
    expect(r.sizeMultiplier).toBe(0.5);
  });

  it("DEFENDs to lock in a lead past the win-first threshold (even though it would also press)", () => {
    const r = evaluateWeekBudget(state({ weekElapsedFraction: 0.5, weekReturnPct: 30 }), cfg);
    expect(r.state).toBe("DEFEND");
    expect(r.reason).toMatch(/lead locked/);
  });

  it("DEFENDs when giving back too much from the week peak", () => {
    const r = evaluateWeekBudget(state({ weekReturnPct: 10, drawdownFromPeakPct: 6 }), cfg);
    expect(r.state).toBe("DEFEND");
    expect(r.reason).toMatch(/gave back/);
  });

  it("DEFENDs late in the week when legs are scarce", () => {
    const r = evaluateWeekBudget(state({ weekElapsedFraction: 0.8, weekReturnPct: 3, legsUsed: 13 }), cfg);
    expect(r.state).toBe("DEFEND");
    expect(r.legsRemaining).toBe(1);
    expect(r.legsScarce).toBe(true);
    expect(r.reason).toMatch(/late week/);
  });

  it("does not PRESS when ahead but legs are scarce mid-week — holds at baseline", () => {
    const r = evaluateWeekBudget(state({ weekElapsedFraction: 0.5, weekReturnPct: 12, legsUsed: 12 }), cfg);
    expect(r.legsScarce).toBe(true);
    expect(r.state).toBe("HUNT");
    expect(r.sizeMultiplier).toBe(1);
  });

  it("reserves legs to cover the daily minimum for the remaining days", () => {
    // 80% through a 7-day week → ~1.4 days left → ceil 2 reserved legs.
    const r = evaluateWeekBudget(state({ weekElapsedFraction: 0.8, legsUsed: 10 }), cfg);
    expect(r.reservedLegs).toBe(2);
    expect(r.legsRemaining).toBe(4);
    expect(r.legsScarce).toBe(false);
  });
});

describe("weekElapsedFraction", () => {
  const start = "2026-06-22T00:00:00Z";
  const end = "2026-06-28T00:00:00Z"; // 6-day span for a clean midpoint

  it("is 0 before the window opens", () => {
    expect(weekElapsedFraction("2026-06-20T00:00:00Z", start, end)).toBe(0);
  });

  it("is 0.5 at the midpoint", () => {
    expect(weekElapsedFraction("2026-06-25T00:00:00Z", start, end)).toBeCloseTo(0.5, 5);
  });

  it("clamps to 1 after the window closes", () => {
    expect(weekElapsedFraction("2026-07-01T00:00:00Z", start, end)).toBe(1);
  });

  it("returns 0 for a degenerate window", () => {
    expect(weekElapsedFraction("2026-06-25T00:00:00Z", end, start)).toBe(0);
  });
});
