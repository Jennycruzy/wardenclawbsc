import { describe, expect, it } from "vitest";
import { loadRiskConfig } from "../src/config.js";

describe("risk config safety invariants", () => {
  it("accepts the production defaults", () => {
    expect(loadRiskConfig({}).internalWindowDrawdownPct).toBe(15);
  });

  it("rejects an internal drawdown budget above the competition cap", () => {
    expect(() =>
      loadRiskConfig({
        COMPETITION_DQ_DRAWDOWN_PCT: "30",
        INTERNAL_WINDOW_DRAWDOWN_PCT: "31",
      }),
    ).toThrow(/internalWindowDrawdownPct/);
  });

  it("rejects a soft threshold that engages after the daily hard limit", () => {
    expect(() =>
      loadRiskConfig({
        SOFT_DRAWDOWN_PCT: "7",
        MAX_DAILY_DRAWDOWN_PCT: "6",
      }),
    ).toThrow(/softDrawdownPct/);
  });

  it("rejects position sizing and slippage outside bounded spot-risk ranges", () => {
    expect(() => loadRiskConfig({ MAX_POSITION_PCT: "101" })).toThrow(/maxPositionPct/);
    expect(() => loadRiskConfig({ MAX_SLIPPAGE_BPS: "1000" })).toThrow(/maxSlippageBps/);
  });

  it("rejects an inverted trade-frequency policy", () => {
    expect(() =>
      loadRiskConfig({
        MIN_TRADES_PER_DAY: "3",
        TARGET_TRADES_PER_DAY: "2",
        MAX_TRADES_PER_DAY: "1",
      }),
    ).toThrow(/trade-frequency/);
  });
});
