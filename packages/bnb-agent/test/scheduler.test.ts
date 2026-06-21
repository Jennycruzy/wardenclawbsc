import { describe, it, expect } from "vitest";
import { DEFAULT_RISK_CONFIG } from "@wardenclaw/core";
import { decideTradePlan, type ScheduleState } from "../src/index.js";

const cfg = DEFAULT_RISK_CONFIG;

function state(overrides: Partial<ScheduleState> = {}): ScheduleState {
  return {
    tradesToday: 0,
    tradesThisWeek: 0,
    hoursLeftInDay: 12,
    survivalMode: false,
    haveEdgeCandidate: false,
    safeToScout: true,
    ...overrides,
  };
}

describe("decideTradePlan", () => {
  it("takes the Attack trade when an edge exists (also satisfies the minimum)", () => {
    const d = decideTradePlan(state({ haveEdgeCandidate: true }), cfg);
    expect(d.plan).toBe("attack");
    expect(d.dailyTradeAtRisk).toBe(false);
  });

  it("waits before the configured compliance deadline when no edge exists", () => {
    const d = decideTradePlan(state({ hoursLeftInDay: cfg.microScoutDeadlineHours + 1 }), cfg);
    expect(d.plan).toBe("hold");
    expect(d.dailyTradeAtRisk).toBe(false);
  });

  it("falls back to a Micro-Scout at the configured deadline when safe", () => {
    const d = decideTradePlan(state({ hoursLeftInDay: cfg.microScoutDeadlineHours, safeToScout: true }), cfg);
    expect(d.plan).toBe("micro_scout");
    expect(d.dailyTradeAtRisk).toBe(true);
  });

  it("holds and flags risk when the scout would be unsafe", () => {
    const d = decideTradePlan(state({ hoursLeftInDay: 3, safeToScout: false }), cfg);
    expect(d.plan).toBe("hold");
    expect(d.dailyTradeAtRisk).toBe(true);
    expect(d.reason).toMatch(/unsafe/);
  });

  it("holds once the daily cap is reached", () => {
    const d = decideTradePlan(state({ tradesToday: 3, haveEdgeCandidate: true }), cfg);
    expect(d.plan).toBe("hold");
  });

  it("holds when the minimum is already met and no edge", () => {
    const d = decideTradePlan(state({ tradesToday: 1, hoursLeftInDay: 2 }), cfg);
    expect(d.plan).toBe("hold");
    expect(d.dailyTradeAtRisk).toBe(false);
  });
});
