import { describe, it, expect } from "vitest";
import {
  initWeekLedger,
  recordWeekValue,
  recordLeg,
  deriveWeekBudgetState,
  serializeWeekLedger,
  parseWeekLedger,
} from "../src/index.js";

describe("weekLedger", () => {
  it("initializes with the peak at the starting value and no legs", () => {
    const l = initWeekLedger("2026-06-22T00:00:00Z", 40);
    expect(l).toEqual({ weekStartIso: "2026-06-22T00:00:00Z", startValueUsd: 40, peakValueUsd: 40, legsUsed: 0 });
  });

  it("ratchets the peak up only", () => {
    let l = initWeekLedger("2026-06-22T00:00:00Z", 40);
    l = recordWeekValue(l, 45);
    expect(l.peakValueUsd).toBe(45);
    l = recordWeekValue(l, 42); // pullback does not lower the peak
    expect(l.peakValueUsd).toBe(45);
  });

  it("counts legs without mutating the input", () => {
    const l0 = initWeekLedger("2026-06-22T00:00:00Z", 40);
    const l1 = recordLeg(l0);
    expect(l0.legsUsed).toBe(0);
    expect(l1.legsUsed).toBe(1);
  });

  it("derives week return and give-back drawdown from the ledger", () => {
    let l = initWeekLedger("2026-06-22T00:00:00Z", 40);
    l = recordWeekValue(l, 50); // peak 50
    l = recordLeg(l);
    l = recordLeg(l);
    l = recordLeg(l);
    const s = deriveWeekBudgetState(l, 44, 0.5);
    expect(s.weekReturnPct).toBeCloseTo(10, 5); // (44-40)/40
    expect(s.drawdownFromPeakPct).toBeCloseTo(12, 5); // (50-44)/50
    expect(s.legsUsed).toBe(3);
    expect(s.weekElapsedFraction).toBe(0.5);
  });

  it("round-trips through serialize/parse and throws loudly on corruption", () => {
    const l = recordLeg(recordWeekValue(initWeekLedger("2026-06-22T00:00:00Z", 40), 48));
    expect(parseWeekLedger(serializeWeekLedger(l))).toEqual(l);
    expect(() => parseWeekLedger('{"weekStartIso":"x"}')).toThrow();
    expect(() => parseWeekLedger("not json")).toThrow();
  });
});
