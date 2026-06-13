import { describe, it, expect } from "vitest";
import {
  computeScoredFrictionBps,
  initRollingCost,
  recordRoundTrip,
  realRoundTripBps,
  scoredReturnBps,
  summarizeScoredLedger,
  evaluateNetEdge,
  loadRiskConfig,
} from "../src/index.js";

describe("scored cost model", () => {
  it("charges the per-leg simulated cost on both legs", () => {
    expect(computeScoredFrictionBps({ notionalUsd: 20, scoringSimCostBps: 10 })).toBe(20);
    expect(computeScoredFrictionBps({ notionalUsd: 20, scoringSimCostBps: 25 })).toBe(50);
  });

  // WS1 acceptance (c): changing SCORING_SIM_COST_BPS alone flips the gate, no code edits.
  it("changing SCORING_SIM_COST_BPS flips a net-edge outcome via config", () => {
    const cheap = loadRiskConfig({ SCORING_SIM_COST_BPS: "10" });
    const dear = loadRiskConfig({ SCORING_SIM_COST_BPS: "120" });
    const move = 120;
    const gate = (cfg: typeof cheap) =>
      evaluateNetEdge({
        expectedMoveBps: move,
        scoredFrictionBps: computeScoredFrictionBps({ notionalUsd: 20, scoringSimCostBps: cfg.scoringSimCostBps }),
        netEdgeMinBps: cfg.netEdgeMinBps,
      }).passed;
    expect(gate(cheap)).toBe(true); // required = 20 + 30 = 50
    expect(gate(dear)).toBe(false); // required = 240 + 30 = 270
  });

  it("reads WALLET_FLOOR_FRACTION from env with a 0.75 default", () => {
    expect(loadRiskConfig({}).walletFloorFraction).toBe(0.75);
    expect(loadRiskConfig({ WALLET_FLOOR_FRACTION: "0.9" }).walletFloorFraction).toBe(0.9);
  });
});

describe("rolling real round-trip cost (wallet ledger)", () => {
  it("uses the bootstrap until a real fill is recorded, then the rolling mean", () => {
    let s = initRollingCost(140);
    expect(realRoundTripBps(s)).toBe(140); // modeled bootstrap
    s = recordRoundTrip(s, 160);
    expect(realRoundTripBps(s)).toBe(160); // first measured fill
    s = recordRoundTrip(s, 140);
    expect(realRoundTripBps(s)).toBe(150); // mean of measured fills
  });

  it("keeps only the last windowSize samples", () => {
    let s = initRollingCost(100, 2);
    s = recordRoundTrip(s, 200);
    s = recordRoundTrip(s, 100);
    s = recordRoundTrip(s, 50); // evicts 200
    expect(realRoundTripBps(s)).toBe(75);
  });

  it("rejects a negative realized cost (fail loud, no silent bad data)", () => {
    expect(() => recordRoundTrip(initRollingCost(100), -1)).toThrow();
  });
});

describe("scored ledger", () => {
  it("computes scored return per trade and cumulative", () => {
    expect(scoredReturnBps({ priceMoveBps: 300, scoredFrictionBps: 20 })).toBe(280);
    const summary = summarizeScoredLedger([
      { id: "a", priceMoveBps: 300, scoredFrictionBps: 20, notionalUsd: 20 },
      { id: "b", priceMoveBps: -50, scoredFrictionBps: 20, notionalUsd: 20 },
    ]);
    expect(summary.tradeCount).toBe(2);
    expect(summary.cumulativeReturnBps).toBe(280 - 70);
    // (280/10000)*20 + (-70/10000)*20 = 0.56 - 0.14 = 0.42
    expect(summary.cumulativeReturnUsd).toBeCloseTo(0.42, 5);
  });
});
