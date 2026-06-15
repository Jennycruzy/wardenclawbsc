import { describe, expect, it } from "vitest";
import {
  consumePressTrade,
  evaluateCatalystEntry,
  evaluateRegime,
  evaluateWatchTick,
  evaluateWeekBudget,
  initRegimeState,
  initTrailingStop,
  initWeekLedger,
  parseOpenPositions,
  serializeOpenPositions,
  updateTrailingStop,
  type OpenPosition,
  type RegimeConfig,
  type TrailingStopConfig,
  type WeekBudgetConfig,
} from "../src/index.js";

const trailCfg: TrailingStopConfig = {
  stopAtrMultiple: 1.5,
  breakevenTriggerAtr: 1,
  trailAtrMultiple: 1.5,
  trailTightAtrMultiple: 1,
};

describe("win-first adversarial scenarios", () => {
  it("+9% reversal exits green after real costs", () => {
    let trail = initTrailingStop({
      entryPrice: 100,
      atrPct: 0.04,
      realRoundTripBps: 140,
      config: trailCfg,
    });
    trail = updateTrailingStop(trail, { currentPrice: 109, config: trailCfg });
    const tick = evaluateWatchTick({
      trail,
      price: { fresh: true, price: 102.4 },
      config: trailCfg,
      stalenessLimitSeconds: 180,
      stalenessAction: "alert_only",
    });
    expect(tick.action).toBe("exit");
    expect(tick.exit!.gainPct * 100).toBeGreaterThan(140);
  });

  it("a crash between decision cycles is caught by the watch tick", () => {
    const trail = initTrailingStop({
      entryPrice: 100,
      atrPct: 0.04,
      realRoundTripBps: 140,
      config: trailCfg,
    });
    expect(evaluateWatchTick({
      trail,
      price: { fresh: true, price: 92 },
      config: trailCfg,
      stalenessLimitSeconds: 180,
      stalenessAction: "alert_only",
    }).action).toBe("exit");
  });

  it("a RED-regime trending first spike is rejected and parked", () => {
    const regimeCfg: RegimeConfig = {
      redBenchmarkPct: -4,
      greenBenchmarkPct: 2,
      redFearGreed: 25,
      greenFearGreed: 60,
      redBreadth: 0.3,
      greenBreadth: 0.6,
      hysteresisChecks: 2,
      highVolatilityRatio: 1.5,
    };
    const red = {
      benchmarkChange24hPct: -6,
      benchmarkShortChangePct: -2,
      btcChange24hPct: -4,
      benchmarkAboveRecentMean: false,
      fearGreed: 15,
      breadthUpFraction: 0.1,
      volatilityRatio: 2,
    };
    const r1 = evaluateRegime(initRegimeState(), red, regimeCfg);
    const r2 = evaluateRegime(r1.state, red, regimeCfg);
    expect(r2.blocksEntries).toBe(true);
    const spike = evaluateCatalystEntry(
      [
        { checkIso: "a", price: 1, volume24hUsd: 100, change24hPct: 0, trendingRank: 30 },
        { checkIso: "b", price: 1.05, volume24hUsd: 150, change24hPct: 5, trendingRank: 20 },
        { checkIso: "c", price: 1.2, volume24hUsd: 300, change24hPct: 20, trendingRank: 10 },
      ],
      {
        trendingDeltaMin: 5,
        trendingTopN: 30,
        volumeExpansionMin: 1.5,
        spikeCooldownChecks: 2,
        maxRetracePct: 0.5,
        spikeMinPct: 0.08,
      },
    );
    expect(spike.rejectCode).toBe("REJECT_FIRST_SPIKE");
  });

  it("flat day 6 grants exactly one PRESS trade", () => {
    const cfg: WeekBudgetConfig = {
      weeklyLegBudget: 14,
      flatBandLoPct: -2,
      flatBandHiPct: 3,
      defendTriggerPct: 8,
      huntMinScore: 80,
      pressMinScore: 65,
      defendMinScore: 90,
      netEdgeDefendBonusBps: 50,
      pressStartDay: 6,
      reservedLegsPerDay: 1,
      weekLengthDays: 7,
    };
    const state = {
      weekElapsedFraction: 5 / 7,
      weekReturnPct: 0,
      legsUsed: 4,
      drawdownFromPeakPct: 0,
      pressTradeUsed: false,
    };
    expect(evaluateWeekBudget(state, cfg).state).toBe("PRESS");
    const used = consumePressTrade(initWeekLedger("2026-06-22T00:00:00Z", 40));
    expect(evaluateWeekBudget({ ...state, pressTradeUsed: used.pressTradeUsed }, cfg).state).toBe("HUNT");
  });

  it("crash-restart restores one HWM without duplicating the position", () => {
    let trail = initTrailingStop({
      entryPrice: 100,
      atrPct: 0.04,
      realRoundTripBps: 140,
      config: trailCfg,
    });
    trail = updateTrailingStop(trail, { currentPrice: 118, config: trailCfg });
    const position: OpenPosition = {
      mandateId: "m1",
      symbol: "CAKE",
      tokenInAddress: "0xusdt",
      tokenOutAddress: "0xcake",
      amountTokens: 1,
      notionalUsd: 20,
      openedAtIso: "2026-06-22T00:00:00Z",
      trail,
    };
    const restored = parseOpenPositions(serializeOpenPositions([position]));
    expect(restored).toHaveLength(1);
    expect(restored[0]!.trail.highWaterMark).toBe(118);
  });
});
