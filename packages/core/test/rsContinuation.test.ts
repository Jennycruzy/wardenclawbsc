import { describe, it, expect } from "vitest";
import {
  evaluateRsContinuation,
  RejectCode,
  type RsContinuationConfig,
  type SignalObservation,
} from "../src/index.js";

const cfg: RsContinuationConfig = { rsOutperformMinBps: 200 };

/** Observation with the fields the RS gate reads (price unused here). */
function ob(change24hPct: number, benchmarkChange24hPct: number | undefined, volume24hUsd: number): SignalObservation {
  return { checkIso: "2026-06-13T00:00:00Z", price: 1, volume24hUsd, change24hPct, benchmarkChange24hPct };
}

describe("evaluateRsContinuation", () => {
  it("accepts two consecutive outperformance checks with rising volume", () => {
    const obs = [ob(5, 2, 100), ob(6, 2.5, 150)]; // +300bps then +350bps, volume rising
    const r = evaluateRsContinuation(obs, cfg);
    expect(r.pass).toBe(true);
    expect(r.outperformChecks).toBe(2);
    expect(r.rejectCode).toBeUndefined();
  });

  it("rejects when only one of the two checks outperforms (REJECT_RS_NOT_CONFIRMED)", () => {
    const obs = [ob(5, 2, 100), ob(3, 2.5, 150)]; // +300bps then only +50bps
    const r = evaluateRsContinuation(obs, cfg);
    expect(r.pass).toBe(false);
    expect(r.outperformChecks).toBe(1);
    expect(r.rejectCode).toBe(RejectCode.RS_NOT_CONFIRMED);
  });

  it("rejects when both outperform but volume is not rising", () => {
    const obs = [ob(5, 2, 150), ob(6, 2.5, 100)]; // outperforms twice, volume falling
    const r = evaluateRsContinuation(obs, cfg);
    expect(r.pass).toBe(false);
    expect(r.outperformChecks).toBe(2);
    expect(r.rejectCode).toBe(RejectCode.RS_NOT_CONFIRMED);
  });

  it("rejects fewer than two observations", () => {
    const r = evaluateRsContinuation([ob(5, 2, 100)], cfg);
    expect(r.pass).toBe(false);
    expect(r.outperformChecks).toBe(0);
    expect(r.rejectCode).toBe(RejectCode.RS_NOT_CONFIRMED);
  });

  it("cannot confirm relative strength with a missing benchmark", () => {
    const obs = [ob(5, undefined, 100), ob(6, undefined, 150)];
    const r = evaluateRsContinuation(obs, cfg);
    expect(r.pass).toBe(false);
    expect(r.outperformChecks).toBe(0);
    expect(r.reasons.some((s) => s.includes("missing benchmark"))).toBe(true);
  });
});
