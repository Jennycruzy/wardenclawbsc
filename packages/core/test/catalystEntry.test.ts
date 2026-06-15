import { describe, it, expect } from "vitest";
import {
  evaluateCatalystEntry,
  RejectCode,
  type CatalystEntryConfig,
  type SignalObservation,
} from "../src/index.js";

const cfg: CatalystEntryConfig = {
  trendingDeltaMin: 5,
  trendingTopN: 30,
  volumeExpansionMin: 1.5,
  spikeCooldownChecks: 2,
  maxRetracePct: 0.5,
  spikeMinPct: 0.08,
};

/** Build an observation with the fields the catalyst gate reads. */
function ob(
  price: number,
  volume24hUsd: number,
  trendingRank: number | undefined,
): SignalObservation {
  return { checkIso: "2026-06-13T00:00:00Z", price, volume24hUsd, change24hPct: 0, trendingRank };
}

describe("evaluateCatalystEntry — rejections", () => {
  it("rejects a stale trending rank that is not improving fast enough (REJECT_TRENDING_STALE)", () => {
    const obs = [ob(1.0, 100, 10), ob(1.05, 300, 9)]; // rank improved by only 1, need ≥5
    const r = evaluateCatalystEntry(obs, cfg);
    expect(r.pass).toBe(false);
    expect(r.trendingDeltaOk).toBe(false);
    expect(r.rejectCode).toBe(RejectCode.TRENDING_STALE);
  });

  it("rejects flat volume even when the rank is climbing (REJECT_NO_VOLUME_EXPANSION)", () => {
    const obs = [ob(1.0, 100, 20), ob(1.02, 100, 10)]; // rank +10 ok; volume flat 1.0×
    const r = evaluateCatalystEntry(obs, cfg);
    expect(r.pass).toBe(false);
    expect(r.trendingDeltaOk).toBe(true);
    expect(r.volumeExpansionOk).toBe(false);
    expect(r.rejectCode).toBe(RejectCode.NO_VOLUME_EXPANSION);
  });

  it("rejects buying the first vertical spike (REJECT_FIRST_SPIKE)", () => {
    // Rank climbing, volume expanding, but price is still going vertical with no
    // pullback — a +20% parabola.
    const obs = [ob(1.0, 100, 30), ob(1.05, 150, 20), ob(1.2, 300, 10)];
    const r = evaluateCatalystEntry(obs, cfg);
    expect(r.pass).toBe(false);
    expect(r.trendingDeltaOk).toBe(true);
    expect(r.volumeExpansionOk).toBe(true);
    expect(r.firstSpikeOk).toBe(false);
    expect(r.rejectCode).toBe(RejectCode.FIRST_SPIKE);
  });
});

describe("evaluateCatalystEntry — accepts", () => {
  it("accepts a fresh top-N entry with volume expansion and no parabola", () => {
    const obs = [ob(1.0, 100, undefined), ob(1.03, 200, 5)]; // freshly entered top-30, +3% move
    const r = evaluateCatalystEntry(obs, cfg);
    expect(r.pass).toBe(true);
    expect(r.rejectCode).toBeUndefined();
  });

  it("accepts a post-spike consolidation that breaks out on continuation", () => {
    // Spike to 1.20 (+20% off base 1.0), then a 3-check base holding above the
    // 50% retrace floor (1.10), then current 1.25 reclaims the consolidation high.
    const obs = [
      ob(1.0, 100, 30),
      ob(1.2, 100, 25),
      ob(1.15, 100, 20),
      ob(1.16, 100, 15),
      ob(1.25, 300, 10),
    ];
    const r = evaluateCatalystEntry(obs, cfg);
    expect(r.trendingDeltaOk).toBe(true);
    expect(r.volumeExpansionOk).toBe(true);
    expect(r.firstSpikeOk).toBe(true);
    expect(r.pass).toBe(true);
  });

  it("rejects a post-spike base that breaks the retracement floor", () => {
    // Same spike, but the base dumps below the 50% retrace floor (1.10).
    const obs = [
      ob(1.0, 100, 30),
      ob(1.2, 100, 25),
      ob(1.05, 100, 20), // broke 1.10 floor
      ob(1.25, 300, 10),
    ];
    const r = evaluateCatalystEntry(obs, cfg);
    expect(r.firstSpikeOk).toBe(false);
    expect(r.rejectCode).toBe(RejectCode.FIRST_SPIKE);
  });
});
