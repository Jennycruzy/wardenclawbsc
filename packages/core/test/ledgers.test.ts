import { describe, it, expect } from "vitest";
import {
  computeScoredFrictionBps,
  initRollingCost,
  recordRoundTrip,
  realRoundTripBps,
  measureRoundTripBps,
  serializeRollingCost,
  parseRollingCost,
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

  it("round-trips state through serialize/parse and throws loudly on corruption", () => {
    const s = recordRoundTrip(initRollingCost(140, 5), 160);
    expect(parseRollingCost(serializeRollingCost(s))).toEqual(s);
    expect(() => parseRollingCost('{"bootstrapBps":1}')).toThrow();
    expect(() => parseRollingCost("nope")).toThrow();
  });
});

describe("measureRoundTripBps — real round-trip from a fill", () => {
  it("measures pure cost on a flat round trip (slippage + LP fee only)", () => {
    const bps = measureRoundTripBps({
      entryNotionalUsd: 20,
      exitProceedsUsd: 19.8, // lost 1% to the round-trip
      entryPrice: 2,
      exitPrice: 2,
    });
    expect(bps).toBeCloseTo(100, 5);
  });

  it("isolates cost from the token's price move (a +10% winner still reads 100bps cost)", () => {
    const bps = measureRoundTripBps({
      entryNotionalUsd: 20,
      exitProceedsUsd: 21.78, // frictionless would be 22 (20 × 2.2/2); 1% short
      entryPrice: 2,
      exitPrice: 2.2,
    });
    expect(bps).toBeCloseTo(100, 5);
  });

  it("adds gas paid in native BNB on top of slippage", () => {
    const bps = measureRoundTripBps({
      entryNotionalUsd: 20,
      exitProceedsUsd: 20, // flat, no slippage
      entryPrice: 2,
      exitPrice: 2,
      entryGasUsd: 0.02,
      exitGasUsd: 0.02, // $0.04 / $20 = 20bps
    });
    expect(bps).toBeCloseTo(20, 5);
  });

  it("clamps a favorable fill to zero (never feeds a negative cost into the estimate)", () => {
    const bps = measureRoundTripBps({
      entryNotionalUsd: 20,
      exitProceedsUsd: 20.1, // better than frictionless
      entryPrice: 2,
      exitPrice: 2,
    });
    expect(bps).toBe(0);
  });

  it("fails loud on degenerate inputs", () => {
    expect(() => measureRoundTripBps({ entryNotionalUsd: 0, exitProceedsUsd: 1, entryPrice: 2, exitPrice: 2 })).toThrow();
    expect(() => measureRoundTripBps({ entryNotionalUsd: 20, exitProceedsUsd: 1, entryPrice: 0, exitPrice: 2 })).toThrow();
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
