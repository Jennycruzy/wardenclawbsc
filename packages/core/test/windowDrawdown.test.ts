import { describe, expect, it } from "vitest";
import {
  parseWindowDrawdownAnchor,
  serializeWindowDrawdownAnchor,
  updateWindowDrawdown,
} from "../src/windowDrawdown.js";

describe("whole-window marked-to-market drawdown", () => {
  const start = "2026-06-22T00:00:00Z";

  it("tracks an unrealized drop from the marked-to-market peak", () => {
    const peak = updateWindowDrawdown(undefined, 50, start);
    const drop = updateWindowDrawdown(peak.anchor, 42.5, start);
    expect(drop.windowDrawdownPct).toBeCloseTo(15, 8);
    expect(drop.anchor.peakValueUsd).toBe(50);
  });

  it("raises the peak and resets for a different competition window", () => {
    const raised = updateWindowDrawdown({ windowStartIso: start, peakValueUsd: 40 }, 44, start);
    expect(raised.windowDrawdownPct).toBe(0);
    expect(raised.anchor.peakValueUsd).toBe(44);

    const reset = updateWindowDrawdown(raised.anchor, 38, "2027-01-01T00:00:00Z");
    expect(reset.windowDrawdownPct).toBe(0);
    expect(reset.anchor.peakValueUsd).toBe(38);
  });

  it("round-trips its durable anchor", () => {
    const anchor = { windowStartIso: start, peakValueUsd: 43.2 };
    expect(parseWindowDrawdownAnchor(serializeWindowDrawdownAnchor(anchor))).toEqual(anchor);
  });
});
