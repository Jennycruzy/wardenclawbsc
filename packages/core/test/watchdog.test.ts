import { describe, it, expect } from "vitest";
import { evaluateWatchdog, WatchdogAction } from "../src/watchdog.js";

const base = {
  currentPrice: 100,
  stopPrice: 90,
  hasOpenPosition: true,
  hasPendingOrder: false,
  windowDrawdownPct: 0,
  softDrawdownPct: 4,
  lossStreak: 0,
  portfolioValueUsd: 40,
  dangerPortfolioValueUsd: 8,
  liquidityThinning: false,
  cmcSignalFlipped: false,
  slippageSpiking: false,
};

describe("evaluateWatchdog", () => {
  it("takes no protective action when all is healthy", () => {
    const r = evaluateWatchdog(base);
    expect(r.actions).toEqual([WatchdogAction.RECORD_NO_TRADE_REASON]);
    expect(r.survivalMode).toBe(false);
  });

  it("forces a stop exit when price breaches the stop", () => {
    const r = evaluateWatchdog({ ...base, currentPrice: 89 });
    expect(r.actions).toContain(WatchdogAction.EXECUTE_STOP_EXIT);
  });

  it("closes the position and enters survival at the danger threshold", () => {
    const r = evaluateWatchdog({ ...base, portfolioValueUsd: 8 });
    expect(r.survivalMode).toBe(true);
    expect(r.actions).toContain(WatchdogAction.CLOSE_POSITION);
    expect(r.actions).toContain(WatchdogAction.SWITCH_TO_SURVIVAL_MODE);
  });

  it("de-risks and arms survival on a loss streak", () => {
    const r = evaluateWatchdog({ ...base, lossStreak: 2 });
    expect(r.survivalMode).toBe(true);
    expect(r.actions).toContain(WatchdogAction.REDUCE_POSITION);
  });

  it("de-risks and arms survival past the soft drawdown", () => {
    const r = evaluateWatchdog({ ...base, windowDrawdownPct: 5 });
    expect(r.survivalMode).toBe(true);
    expect(r.actions).toContain(WatchdogAction.REDUCE_POSITION);
  });

  it("reduces and pauses on a thesis-break signal (flip / thinning / slippage)", () => {
    for (const sig of ["cmcSignalFlipped", "liquidityThinning", "slippageSpiking"] as const) {
      const r = evaluateWatchdog({ ...base, [sig]: true });
      expect(r.actions).toContain(WatchdogAction.REDUCE_POSITION);
      expect(r.actions).toContain(WatchdogAction.PAUSE_STRATEGY);
    }
  });

  it("cancels a dangling pending order with no position", () => {
    const r = evaluateWatchdog({ ...base, hasOpenPosition: false, hasPendingOrder: true });
    expect(r.actions).toContain(WatchdogAction.CANCEL_PENDING_ORDER);
  });
});
