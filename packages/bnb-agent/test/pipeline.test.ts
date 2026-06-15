import { describe, it, expect } from "vitest";
import {
  DEFAULT_RISK_CONFIG,
  EligibleAllowlist,
  parseMandate,
  type BscScoreInputs,
  type CalibrationReport,
  type SignalObservation,
} from "@wardenclaw/core";
import type { TwakPolicyConfig } from "@wardenclaw/twak-adapter";
import { evaluateCandidate, buildBscMandate, type CandidateInput, type PipelineContext } from "../src/index.js";

const USDT = "0x55d398326f99059ff775485246999027b3197955";
const USDC = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";
const CAKE = "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82";
const OFFLIST = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x10ed43c718714eb63d5aa57b78b54704e256024e";

const allowlist = new EligibleAllowlist([
  { symbol: "USDT", cmcId: 825, bscContractAddress: USDT, decimals: 18, isStable: true },
  { symbol: "USDC", cmcId: 3408, bscContractAddress: USDC, decimals: 18, isStable: true },
  { symbol: "CAKE", cmcId: 7186, bscContractAddress: CAKE, decimals: 18 },
]);

const twakPolicy: TwakPolicyConfig = {
  requiredChainId: 56,
  allowedRouters: ["pancakeswap"],
  allowedSpenders: [ROUTER],
  allowedContracts: [ROUTER],
  maxTradeUsd: 30,
  maxDailySpendUsd: 20,
  maxSlippageBps: 50,
  allowInfiniteApprovals: false,
  approvalBufferBps: 50,
};

const calibration: CalibrationReport = {
  version: "test-cal-1",
  generatedAt: "2026-06-20T00:00:00Z",
  historyDays: 30,
  bands: [
    { minScore: 60, realizedMoveBps: 60, hitRate: 0.4, realizedVsPredicted: 1 },
    { minScore: 80, realizedMoveBps: 400, hitRate: 0.9, realizedVsPredicted: 1 },
  ],
};

const strongInputs: BscScoreInputs = {
  momentum: 0.9,
  liquiditySafety: 0.9,
  relativeStrengthVsBnb: 0.9,
  sentiment: 0.9,
  volatilitySafety: 0.9,
  walletRiskState: 0.9,
};

function ctx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    config: DEFAULT_RISK_CONFIG,
    calibration,
    allowlist,
    twakPolicy,
    portfolioUsd: 40,
    deployableUsd: 38,
    windowDrawdownPct: 0,
    dailyDrawdownPct: 0,
    openPositions: 0,
    tradesToday: 0,
    survivalMode: false,
    marketDataStale: false,
    calibrationStale: false,
    ...overrides,
  };
}

function candidate(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    symbol: "CAKE",
    signalFamily: "catalyst",
    scoreInputs: strongInputs,
    cmcToolsUsed: ["quotes", "trending", "fear_greed"],
    marketDataTimestamp: "2026-06-22T00:00:00Z",
    tokenInAddress: USDT,
    tokenOutAddress: CAKE,
    router: "pancakeswap",
    spender: ROUTER,
    to: ROUTER,
    atrPct: 0.04,
    reserveIn: 10_000_000,
    reserveOut: 10_000_000,
    poolFeeBps: 25,
    gasPerLegUsd: 0.01,
    ...overrides,
  };
}

describe("evaluateCandidate — approval", () => {
  it("approves a strong catalyst Attack candidate and emits a TWAK intent", () => {
    const r = evaluateCandidate(candidate(), ctx());
    expect(r.approved).toBe(true);
    expect(r.mode).toBe("attack");
    expect(r.signalFamily).toBe("catalyst");
    expect(r.economics.netEdgePassed).toBe(true);
    expect(r.economics.positionSizeUsd).toBeGreaterThan(0);
    expect(r.intent?.executionType).toBe("spot_only");
    expect(r.intent?.chainId).toBe(56);
  });

  it("builds a valid BSC mandate from the result with CMC attribution", () => {
    const r = evaluateCandidate(candidate(), ctx());
    const m = buildBscMandate({
      result: r,
      mode: "rehearsal",
      strategyId: "bsc-two-family",
      naturalLanguageIntent: "trade momentum + catalysts, spot only",
      compiledStrategy: {},
      assetContract: CAKE,
      cmcToolsUsed: r.economics ? ["quotes", "trending"] : [],
      marketDataTimestamp: "2026-06-22T00:00:00Z",
      calibrationVersion: calibration.version,
      createdAt: "2026-06-22T00:00:00Z",
      id: "bsc-1",
    });
    expect(() => parseMandate(m)).not.toThrow();
    expect(m.venue).toBe("bsc");
    expect(m.executionType).toBe("spot_only");
    expect(m.action).toBe("enter_long");
    expect(m.perception.cmcToolsUsed).toContain("quotes");
    expect(m.economics.calibrationVersion).toBe("test-cal-1");
  });
});

describe("evaluateCandidate — two ledgers (WS1)", () => {
  it("carries both the scored and wallet ledgers on the economics block and mandate", () => {
    const r = evaluateCandidate(candidate(), ctx());
    expect(r.economics.scoredFrictionBps).toBe(DEFAULT_RISK_CONFIG.scoringSimCostBps * 2);
    expect(r.economics.realRoundTripBps).toBeGreaterThan(0);
    expect(r.economics.walletFloorBps).toBeGreaterThan(0);
    expect(r.economics.walletFloorPassed).toBe(true);

    const m = buildBscMandate({
      result: r,
      mode: "rehearsal",
      strategyId: "s",
      naturalLanguageIntent: "n",
      compiledStrategy: {},
      assetContract: CAKE,
      cmcToolsUsed: ["quotes"],
      marketDataTimestamp: "2026-06-22T00:00:00Z",
      calibrationVersion: calibration.version,
      createdAt: "2026-06-22T00:00:00Z",
      id: "bsc-ledgers",
    });
    expect(m.economics.scoredFrictionBps).toBe(r.economics.scoredFrictionBps);
    expect(m.economics.realRoundTripBps).toBe(r.economics.realRoundTripBps);
    expect(m.economics.walletFloorPassed).toBe(true);
  });

  it("rejects a scored-positive but wallet-ruinous trade via the wallet floor", () => {
    // Scored cost is tiny (default 10/leg → 20bps), so a modest move clears the
    // scored gate; but a measured real round-trip of 900bps puts the wallet floor
    // at 675bps, which the calibrated move cannot clear.
    const lowMove: CalibrationReport = {
      ...calibration,
      bands: [{ minScore: 80, realizedMoveBps: 120, hitRate: 0.9, realizedVsPredicted: 1 }],
    };
    const r = evaluateCandidate(candidate(), ctx({ calibration: lowMove, realRoundTripBps: 900 }));
    expect(r.approved).toBe(false);
    expect(r.rejectCode).toBe("REJECT_WALLET_FLOOR");
  });
});

describe("evaluateCandidate — gate rejections", () => {
  it("rejects a low score (REJECT_LOW_SCORE)", () => {
    const weak = { ...strongInputs, momentum: 0.2, liquiditySafety: 0.2, relativeStrengthVsBnb: 0.2, sentiment: 0.2, volatilitySafety: 0.2, walletRiskState: 0.2 };
    const r = evaluateCandidate(candidate({ scoreInputs: weak }), ctx());
    expect(r.approved).toBe(false);
    expect(r.rejectCode).toBe("REJECT_LOW_SCORE");
  });

  it("rejects a non-spot route (REJECT_NON_SPOT)", () => {
    const r = evaluateCandidate(candidate({ isNonSpot: true }), ctx());
    expect(r.rejectCode).toBe("REJECT_NON_SPOT");
  });

  it("rejects an off-list token (REJECT_INELIGIBLE_CONTRACT)", () => {
    const r = evaluateCandidate(candidate({ tokenOutAddress: OFFLIST }), ctx());
    expect(r.rejectCode).toBe("REJECT_INELIGIBLE_CONTRACT");
  });

  it("rejects insufficient net edge (REJECT_NET_EDGE)", () => {
    const lowMove: CalibrationReport = {
      ...calibration,
      bands: [{ minScore: 80, realizedMoveBps: 20, hitRate: 0.9, realizedVsPredicted: 1 }],
    };
    const r = evaluateCandidate(candidate(), ctx({ calibration: lowMove }));
    expect(r.rejectCode).toBe("REJECT_NET_EDGE");
  });

  it("rejects an incoherent stop/size (REJECT_STOP_COHERENCE)", () => {
    // Huge per-leg gas makes friction exceed budget at any feasible size.
    const r = evaluateCandidate(candidate({ gasPerLegUsd: 5 }), ctx());
    expect(r.rejectCode).toBe("REJECT_STOP_COHERENCE");
  });

  it("aborts on adverse shadow-fill deviation (REJECT_SHADOW_FILL)", () => {
    const r = evaluateCandidate(candidate({ shadow: { expectedOut: 100, simulatedOut: 90 } }), ctx());
    expect(r.rejectCode).toBe("REJECT_SHADOW_FILL");
  });
});

describe("evaluateCandidate — governor + micro-scout", () => {
  it("shrinks size as the drawdown budget thins", () => {
    const healthy = evaluateCandidate(candidate(), ctx({ windowDrawdownPct: 0 }));
    const thin = evaluateCandidate(candidate(), ctx({ windowDrawdownPct: 14 }));
    expect(thin.governor.sizeFraction).toBeLessThan(healthy.governor.sizeFraction);
  });

  it("approves a stable↔stable Micro-Scout, exempt from net-edge", () => {
    const scout = candidate({
      symbol: "USDC",
      tokenInAddress: USDT,
      tokenOutAddress: USDC,
      isMicroScout: true,
      scoreInputs: { ...strongInputs, momentum: 0.1 },
    });
    const r = evaluateCandidate(scout, ctx());
    expect(r.approved).toBe(true);
    expect(r.signalFamily).toBe("scout");
    expect(r.economics.positionSizeUsd).toBe(DEFAULT_RISK_CONFIG.microScoutUsd);
  });

  it("still rejects a Micro-Scout to an off-list contract", () => {
    const r = evaluateCandidate(
      candidate({ tokenInAddress: USDT, tokenOutAddress: OFFLIST, isMicroScout: true }),
      ctx(),
    );
    expect(r.approved).toBe(false);
    expect(r.rejectCode).toBe("REJECT_INELIGIBLE_CONTRACT");
  });
});

describe("evaluateCandidate — week-schedule risk budget (WS6)", () => {
  it("DEFEND shrinks position size below the HUNT baseline", () => {
    const baseline = evaluateCandidate(candidate(), ctx());
    const defend = evaluateCandidate(candidate(), ctx({ sizeMultiplier: 0.5, riskState: "DEFEND" }));
    expect(defend.approved).toBe(true);
    expect(defend.economics.positionSizeUsd).toBeLessThan(baseline.economics.positionSizeUsd);
    expect(defend.riskState).toBe("DEFEND");
    expect(defend.sizeMultiplier).toBe(0.5);
    expect(defend.reasons.some((s) => s.includes("week budget DEFEND"))).toBe(true);
  });

  it("PRESS grows position size above the HUNT baseline", () => {
    const baseline = evaluateCandidate(candidate(), ctx());
    const press = evaluateCandidate(candidate(), ctx({ sizeMultiplier: 1.3, riskState: "PRESS" }));
    expect(press.approved).toBe(true);
    expect(press.economics.positionSizeUsd).toBeGreaterThan(baseline.economics.positionSizeUsd);
    expect(press.riskState).toBe("PRESS");
  });

  it("a large PRESS multiplier is still bounded by the hard caps (never breaches them)", () => {
    const press = evaluateCandidate(candidate(), ctx({ sizeMultiplier: 5, riskState: "PRESS" }));
    expect(press.approved).toBe(true);
    // maxPositionPct (70%) of deployable ($38) = $26.6; the volatility-stop size is
    // even tighter here, so a 5× multiplier cannot push size past those caps.
    expect(press.economics.positionSizeUsd).toBeLessThanOrEqual(26.6);
  });

  it("does not apply the week multiplier to a Micro-Scout", () => {
    const scout = evaluateCandidate(
      candidate({ symbol: "USDC", tokenInAddress: USDT, tokenOutAddress: USDC, isMicroScout: true }),
      ctx({ sizeMultiplier: 0.5, riskState: "DEFEND" }),
    );
    expect(scout.approved).toBe(true);
    expect(scout.economics.positionSizeUsd).toBe(DEFAULT_RISK_CONFIG.microScoutUsd);
    expect(scout.sizeMultiplier).toBeUndefined();
  });
});

describe("evaluateCandidate — red-day regime (WS7)", () => {
  it("blocks a directional entry when the committed regime is RED", () => {
    const r = evaluateCandidate(candidate(), ctx({ marketRegime: "RED" }));
    expect(r.approved).toBe(false);
    expect(r.rejectCode).toBe("REJECT_REGIME_RED");
  });

  it("still approves the stable↔stable Micro-Scout in a RED regime (rotation to stables)", () => {
    const scout = evaluateCandidate(
      candidate({ symbol: "USDC", tokenInAddress: USDT, tokenOutAddress: USDC, isMicroScout: true }),
      ctx({ marketRegime: "RED" }),
    );
    expect(scout.approved).toBe(true);
    expect(scout.signalFamily).toBe("scout");
  });

  it("approves a directional entry in GREEN/NEUTRAL regimes", () => {
    expect(evaluateCandidate(candidate(), ctx({ marketRegime: "GREEN" })).approved).toBe(true);
    expect(evaluateCandidate(candidate(), ctx({ marketRegime: "NEUTRAL" })).approved).toBe(true);
  });
});

describe("evaluateCandidate — entry-quality gates (WS5)", () => {
  const catObs = (price: number, volume: number, rank: number | undefined): SignalObservation => ({
    checkIso: "2026-06-22T00:00:00Z",
    price,
    volume24hUsd: volume,
    change24hPct: 0,
    trendingRank: rank,
  });
  const rsObs = (change: number, benchmark: number | undefined, volume: number): SignalObservation => ({
    checkIso: "2026-06-22T00:00:00Z",
    price: 1,
    volume24hUsd: volume,
    change24hPct: change,
    benchmarkChange24hPct: benchmark,
  });

  it("rejects a catalyst on a stale trending rank (REJECT_TRENDING_STALE)", () => {
    const r = evaluateCandidate(
      candidate({ entryObservations: [catObs(1.0, 100, 10), catObs(1.05, 300, 9)] }),
      ctx(),
    );
    expect(r.approved).toBe(false);
    expect(r.rejectCode).toBe("REJECT_TRENDING_STALE");
  });

  it("approves a catalyst whose uncrowding checks all clear", () => {
    // Climbing rank, expanding volume, post-spike continuation reclaiming the base high.
    const obs = [
      catObs(1.0, 100, 30),
      catObs(1.2, 100, 25),
      catObs(1.15, 100, 20),
      catObs(1.16, 100, 15),
      catObs(1.25, 300, 10),
    ];
    const r = evaluateCandidate(candidate({ entryObservations: obs }), ctx());
    expect(r.approved).toBe(true);
    expect(r.reasons.some((s) => s.startsWith("catalyst entry:"))).toBe(true);
  });

  it("rejects rs_continuation without two confirmed outperformance checks", () => {
    const r = evaluateCandidate(
      candidate({ signalFamily: "rs_continuation", entryObservations: [rsObs(5, 2, 100), rsObs(3, 2.5, 150)] }),
      ctx(),
    );
    expect(r.approved).toBe(false);
    expect(r.rejectCode).toBe("REJECT_RS_NOT_CONFIRMED");
  });

  it("approves rs_continuation on two outperformance checks with rising volume", () => {
    const r = evaluateCandidate(
      candidate({ signalFamily: "rs_continuation", entryObservations: [rsObs(5, 2, 100), rsObs(6, 2.5, 150)] }),
      ctx(),
    );
    expect(r.approved).toBe(true);
    expect(r.signalFamily).toBe("rs_continuation");
    expect(r.reasons.some((s) => s.startsWith("rs continuation:"))).toBe(true);
  });

  it("ignores entry gates for a Micro-Scout even when observations are stale", () => {
    const r = evaluateCandidate(
      candidate({
        symbol: "USDC",
        tokenInAddress: USDT,
        tokenOutAddress: USDC,
        isMicroScout: true,
        entryObservations: [catObs(1.0, 100, 10), catObs(1.05, 300, 9)],
      }),
      ctx(),
    );
    expect(r.approved).toBe(true);
    expect(r.signalFamily).toBe("scout");
  });
});
