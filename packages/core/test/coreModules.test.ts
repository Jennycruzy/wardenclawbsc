import { describe, it, expect } from "vitest";
import {
  evaluateWatchdog,
  WatchdogAction,
  reconcile,
  type PendingMandate,
  valueHoldings,
  buildHourlyReturns,
  maxDrawdownPct,
  totalReturnPct,
  mergeAnchors,
  summarizeProof,
  hasExternalProof,
  verifyCompetitionRules,
  buildCalibrationReport,
  buildPerFamilyCalibration,
} from "../src/index.js";

describe("watchdog", () => {
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

  it("forces a stop exit when price breaches the stop", () => {
    const r = evaluateWatchdog({ ...base, currentPrice: 89 });
    expect(r.actions).toContain(WatchdogAction.EXECUTE_STOP_EXIT);
  });

  it("arms survival mode on a loss streak and reduces", () => {
    const r = evaluateWatchdog({ ...base, lossStreak: 2 });
    expect(r.survivalMode).toBe(true);
    expect(r.actions).toContain(WatchdogAction.REDUCE_POSITION);
  });

  it("closes and revokes at the danger threshold", () => {
    const r = evaluateWatchdog({ ...base, portfolioValueUsd: 7 });
    expect(r.actions).toContain(WatchdogAction.CLOSE_POSITION);
    expect(r.actions).toContain(WatchdogAction.ATTEMPT_REVOKE_APPROVALS);
  });

  it("records a no-trade reason when nothing is wrong", () => {
    const r = evaluateWatchdog(base);
    expect(r.actions).toContain(WatchdogAction.RECORD_NO_TRADE_REASON);
    expect(r.survivalMode).toBe(false);
  });
});

describe("recovery reconciliation", () => {
  const lookup = async (txHash: string) => {
    if (txHash === "0xconfirmed") return { found: true, confirmed: true, success: true };
    if (txHash === "0xpending") return { found: true, confirmed: false };
    return { found: false, confirmed: false };
  };

  it("resolves a confirmed tx as filled", async () => {
    const pending: PendingMandate[] = [{ mandateId: "m1", txHash: "0xconfirmed", status: "submitted", action: "scout" }];
    const report = await reconcile(pending, lookup);
    expect(report.resolutions[0]!.resolution).toBe("confirmed_filled");
  });

  it("does not blindly retry an unconfirmed tx", async () => {
    const pending: PendingMandate[] = [{ mandateId: "m2", txHash: "0xpending", status: "submitted" }];
    const report = await reconcile(pending, lookup);
    expect(report.resolutions[0]!.resolution).toBe("needs_manual_review");
    expect(report.requiresReview).toBe(true);
  });

  it("does not retry a submitted tx whose receipt is unavailable", async () => {
    const pending: PendingMandate[] = [{ mandateId: "m3", txHash: "0xmissing", status: "submitted" }];
    const report = await reconcile(pending, lookup);
    expect(report.resolutions[0]!.resolution).toBe("needs_manual_review");
    expect(report.requiresReview).toBe(true);
  });

  it("prevents a duplicate via repeated nonce", async () => {
    const pending: PendingMandate[] = [
      { mandateId: "m4", txHash: "0xconfirmed", status: "submitted", nonce: 5 },
      { mandateId: "m5", txHash: "0xother", status: "submitted", nonce: 5 },
    ];
    const report = await reconcile(pending, lookup);
    expect(report.duplicatesPrevented).toBe(1);
    expect(report.requiresReview).toBe(true);
  });
});

describe("hourly snapshot", () => {
  it("values holdings in USD", () => {
    expect(valueHoldings([{ symbol: "CAKE", amount: 10, priceUsd: 2 }])).toBe(20);
  });

  it("computes per-hour returns and zeroes hours starting at/below the floor", () => {
    const snaps = [
      { hourIso: "h0", valueUsd: 40 },
      { hourIso: "h1", valueUsd: 44 },
      { hourIso: "h2", valueUsd: 0.5 }, // starts the next hour below the floor
      { hourIso: "h3", valueUsd: 5 },
    ];
    const returns = buildHourlyReturns(snaps, 1.0);
    expect(returns[0]!.returnPct).toBeCloseTo(10, 5);
    expect(returns[2]!.zeroedByFloor).toBe(true);
    expect(returns[2]!.returnPct).toBe(0);
  });

  it("computes max drawdown and total return", () => {
    const snaps = [
      { hourIso: "h0", valueUsd: 40 },
      { hourIso: "h1", valueUsd: 50 },
      { hourIso: "h2", valueUsd: 45 },
    ];
    expect(maxDrawdownPct(snaps)).toBeCloseTo(10, 5);
    expect(totalReturnPct(snaps)).toBeCloseTo(12.5, 5);
  });
});

describe("proof anchors", () => {
  it("merges fragments and ignores empty values", () => {
    const merged = mergeAnchors({ bscTxHash: "0xabc" }, { bscTxHash: "", twakReceipt: "r1" });
    expect(merged.bscTxHash).toBe("0xabc");
    expect(merged.twakReceipt).toBe("r1");
  });

  it("distinguishes external proof from paper-only", () => {
    expect(hasExternalProof({ bscTxHash: "0xabc" })).toBe(true);
    const summary = summarizeProof({ paperFillSource: "internal_paper_engine" });
    expect(summary.paperOnly).toBe(true);
    expect(summary.integrityProof).toBe("JSONL hash chain");
  });
});

describe("competition rules", () => {
  it("verifies with the four open items as warnings", () => {
    const v = verifyCompetitionRules();
    expect(v.ok).toBe(true);
    expect(v.warnings).toHaveLength(4);
    expect(v.missingImplementation).toHaveLength(0);
  });
});

describe("competition-window metrics", () => {
  it("excludes preflight snapshots, deduplicates hours, and uses starting capital", async () => {
    const { competitionSnapshots, returnFromStartingCapital } = await import("../src/index.js");
    const snapshots = competitionSnapshots([
      { hourIso: "2026-06-15T23:00:00Z", valueUsd: 44.95 },
      { hourIso: "2026-06-22T00:00:00Z", valueUsd: 40 },
      { hourIso: "2026-06-22T00:00:00Z", valueUsd: 39.99 },
      { hourIso: "2026-06-22T01:00:00Z", valueUsd: 40.5 },
    ]);
    expect(snapshots).toEqual([
      { hourIso: "2026-06-22T00:00:00Z", valueUsd: 39.99 },
      { hourIso: "2026-06-22T01:00:00Z", valueUsd: 40.5 },
    ]);
    expect(returnFromStartingCapital(39.99, 40)).toBeCloseTo(-0.025, 5);
  });
});

describe("calibration report builder", () => {
  it("aggregates real samples into score bands", () => {
    const samples = [
      { score: 82, realizedMoveBps: 200, win: true },
      { score: 85, realizedMoveBps: 240, win: false },
      { score: 70, realizedMoveBps: 60, win: true },
    ];
    const report = buildCalibrationReport(samples, [65, 80], {
      version: "cal-test",
      generatedAt: "2026-06-20T00:00:00Z",
      historyDays: 30,
    });
    const top = report.bands.find((b) => b.minScore === 80)!;
    expect(top.realizedMoveBps).toBeCloseTo(220, 1);
    expect(top.hitRate).toBeCloseTo(0.5, 5);
  });

  it("splits samples per signal family with family-versioned reports", () => {
    const samples = [
      { score: 82, realizedMoveBps: 200, win: true, family: "catalyst" },
      { score: 85, realizedMoveBps: 300, win: true, family: "catalyst" },
      { score: 81, realizedMoveBps: 120, win: false, family: "rs_continuation" },
      { score: 70, realizedMoveBps: 40, win: true }, // unlabeled
    ];
    const perFamily = buildPerFamilyCalibration(samples, [65, 80], {
      version: "cal-2026-06-13",
      generatedAt: "2026-06-13T00:00:00Z",
      historyDays: 30,
    });
    // Families sorted alphabetically: catalyst, rs_continuation, unlabeled.
    expect(perFamily.map((f) => f.family)).toEqual(["catalyst", "rs_continuation", "unlabeled"]);
    const cat = perFamily.find((f) => f.family === "catalyst")!;
    expect(cat.sampleCount).toBe(2);
    expect(cat.report.version).toBe("cal-2026-06-13-catalyst");
    expect(cat.report.bands.find((b) => b.minScore === 80)!.realizedMoveBps).toBeCloseTo(250, 1);
    expect(perFamily.find((f) => f.family === "unlabeled")!.sampleCount).toBe(1);
  });
});
