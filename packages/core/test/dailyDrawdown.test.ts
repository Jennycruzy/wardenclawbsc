import { describe, it, expect } from "vitest";
import {
  updateDailyDrawdown,
  serializeDailyAnchor,
  parseDailyAnchor,
  type DailyAnchor,
} from "../src/dailyDrawdown.js";

describe("updateDailyDrawdown", () => {
  it("seeds the anchor at the current value with zero drawdown when none exists", () => {
    const r = updateDailyDrawdown(undefined, 40, "2026-06-22T03:00:00Z");
    expect(r.anchor).toEqual({ dayIso: "2026-06-22", peakValueUsd: 40 });
    expect(r.dailyDrawdownPct).toBe(0);
  });

  it("raises the intraday peak when value climbs, keeping drawdown at zero", () => {
    const a: DailyAnchor = { dayIso: "2026-06-22", peakValueUsd: 40 };
    const r = updateDailyDrawdown(a, 44, "2026-06-22T06:00:00Z");
    expect(r.anchor.peakValueUsd).toBe(44);
    expect(r.dailyDrawdownPct).toBe(0);
  });

  it("reports peak-to-trough drawdown after a drop from the day's peak", () => {
    const a: DailyAnchor = { dayIso: "2026-06-22", peakValueUsd: 50 };
    const r = updateDailyDrawdown(a, 47, "2026-06-22T12:00:00Z");
    // (50 - 47) / 50 = 6%
    expect(r.dailyDrawdownPct).toBeCloseTo(6, 6);
    expect(r.anchor.peakValueUsd).toBe(50); // peak unchanged on a drop
  });

  it("resets the peak (drawdown 0) at the UTC day rollover, never carrying a stale peak", () => {
    const a: DailyAnchor = { dayIso: "2026-06-22", peakValueUsd: 50 };
    const r = updateDailyDrawdown(a, 47, "2026-06-23T00:30:00Z");
    expect(r.anchor).toEqual({ dayIso: "2026-06-23", peakValueUsd: 47 });
    expect(r.dailyDrawdownPct).toBe(0);
  });

  it("never returns a negative drawdown", () => {
    const a: DailyAnchor = { dayIso: "2026-06-22", peakValueUsd: 40 };
    const r = updateDailyDrawdown(a, 45, "2026-06-22T09:00:00Z");
    expect(r.dailyDrawdownPct).toBe(0);
  });

  it("round-trips through serialize/parse", () => {
    const a: DailyAnchor = { dayIso: "2026-06-22", peakValueUsd: 41.5 };
    expect(parseDailyAnchor(serializeDailyAnchor(a))).toEqual(a);
  });
});
