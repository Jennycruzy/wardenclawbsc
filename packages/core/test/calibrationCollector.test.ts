import { describe, it, expect } from "vitest";
import { recordPending, maturePending, type PendingSample } from "../src/index.js";

const obs = (symbol: string, score: number, price: number, iso: string): PendingSample => ({
  symbol,
  score,
  priceAtScore: price,
  scoredAtIso: iso,
});

describe("calibration collector — recordPending", () => {
  it("appends a fresh observation", () => {
    const out = recordPending([], obs("CAKE", 70, 1.4, "2026-06-18T00:00:00Z"));
    expect(out).toHaveLength(1);
  });

  it("de-duplicates repeated scores of the same symbol within the min gap", () => {
    let p: PendingSample[] = [];
    p = recordPending(p, obs("CAKE", 70, 1.4, "2026-06-18T00:00:00Z"));
    p = recordPending(p, obs("CAKE", 72, 1.41, "2026-06-18T00:10:00Z")); // 10m < 1h gap
    expect(p).toHaveLength(1);
  });

  it("records again once the min gap has elapsed", () => {
    let p: PendingSample[] = [];
    p = recordPending(p, obs("CAKE", 70, 1.4, "2026-06-18T00:00:00Z"));
    p = recordPending(p, obs("CAKE", 72, 1.41, "2026-06-18T02:00:00Z")); // 2h > 1h gap
    expect(p).toHaveLength(2);
  });

  it("rejects non-positive prices and non-finite scores (never a fake sample)", () => {
    let p = recordPending([], obs("CAKE", 70, 0, "2026-06-18T00:00:00Z"));
    p = recordPending(p, obs("CAKE", Number.NaN, 1.4, "2026-06-18T00:00:00Z"));
    expect(p).toHaveLength(0);
  });
});

describe("calibration collector — maturePending", () => {
  it("matures an observation past the horizon into a signed sample with win flag", () => {
    const pending = [obs("CAKE", 80, 1.0, "2026-06-18T00:00:00Z")];
    const prices = new Map([["CAKE", 1.05]]); // +5% = +500 bps
    const { matured, remaining } = maturePending(
      pending,
      prices,
      "2026-06-19T00:00:00Z", // 24h later
      24,
    );
    expect(remaining).toHaveLength(0);
    expect(matured).toHaveLength(1);
    expect(matured[0]!.realizedMoveBps).toBeCloseTo(500, 2);
    expect(matured[0]!.win).toBe(true);
    expect(matured[0]!.score).toBe(80);
    expect(matured[0]!.symbol).toBe("CAKE");
    expect(matured[0]!.scoredAtIso).toBe("2026-06-18T00:00:00Z");
    expect(matured[0]!.horizonHours).toBe(24);
  });

  it("keeps observations younger than the horizon pending", () => {
    const pending = [obs("CAKE", 80, 1.0, "2026-06-18T00:00:00Z")];
    const { matured, remaining } = maturePending(
      pending,
      new Map([["CAKE", 1.05]]),
      "2026-06-18T01:00:00Z", // 1h later, horizon 24h
      24,
    );
    expect(matured).toHaveLength(0);
    expect(remaining).toHaveLength(1);
  });

  it("never fabricates a move: carries forward when no fresh price, drops past max age", () => {
    const pending = [obs("GONE", 80, 1.0, "2026-06-18T00:00:00Z")];
    // Past horizon, no price available -> still within maxAge (96h), carried forward.
    const carried = maturePending(pending, new Map(), "2026-06-19T00:00:00Z", 24);
    expect(carried.matured).toHaveLength(0);
    expect(carried.remaining).toHaveLength(1);
    // Well past maxAge (default 4× horizon), no price -> dropped, no sample invented.
    const dropped = maturePending(pending, new Map(), "2026-06-25T00:00:00Z", 24);
    expect(dropped.matured).toHaveLength(0);
    expect(dropped.remaining).toHaveLength(0);
  });
});
