import { describe, it, expect } from "vitest";
import {
  consumePressTrade,
  deriveWeekBudgetState,
  entriesOnUtcDay,
  initWeekLedger,
  legsOnUtcDay,
  parseWeekLedger,
  recordLeg,
  recordWeekValue,
  serializeWeekLedger,
} from "../src/index.js";

describe("weekLedger", () => {
  it("initializes with no legs and an unused PRESS trade", () => {
    expect(initWeekLedger("2026-06-22T00:00:00Z", 40)).toEqual({
      weekStartIso: "2026-06-22T00:00:00Z",
      startValueUsd: 40,
      peakValueUsd: 40,
      legs: [],
      pressTradeUsed: false,
    });
  });

  it("ratchets the peak and derives scored return", () => {
    let l = recordWeekValue(initWeekLedger("2026-06-22T00:00:00Z", 40), 50);
    l = recordWeekValue(l, 44);
    const s = deriveWeekBudgetState(l, 44, 0.5);
    expect(l.peakValueUsd).toBe(50);
    expect(s.weekReturnPct).toBeCloseTo(10, 5);
    expect(s.drawdownFromPeakPct).toBeCloseTo(12, 5);
  });

  it("counts both entry and exit legs on their UTC day", () => {
    let l = initWeekLedger("2026-06-22T00:00:00Z", 40);
    l = recordLeg(l, "entry", "2026-06-22T12:00:00Z");
    l = recordLeg(l, "exit", "2026-06-22T14:00:00Z");
    l = recordLeg(l, "scout", "2026-06-23T23:00:00Z");
    expect(legsOnUtcDay(l, "2026-06-22T23:59:59Z")).toBe(2);
    expect(entriesOnUtcDay(l, "2026-06-22T23:59:59Z")).toBe(1);
    expect(deriveWeekBudgetState(l, 40, 0.2).legsUsed).toBe(3);
  });

  it("persists PRESS consumption across restarts", () => {
    const l = consumePressTrade(initWeekLedger("2026-06-22T00:00:00Z", 40));
    expect(parseWeekLedger(serializeWeekLedger(l)).pressTradeUsed).toBe(true);
  });

  it("throws loudly on corruption", () => {
    expect(() => parseWeekLedger("not json")).toThrow();
  });
});
