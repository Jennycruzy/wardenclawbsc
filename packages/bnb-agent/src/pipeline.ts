/**
 * The BSC candidate pipeline: the full deterministic gate chain (§0.2) over one
 * candidate, producing a decision, economics, sizing, and — when approved — a
 * TWAK swap intent ready for the policy-enforcing executor.
 *
 * Order: score → mode → calibrated expected move → governor cap → volatility-stop
 * coherence (size from stop) → friction at size → net-edge → shadow-fill → risk
 * constitution → TWAK local policy. The LLM is nowhere in this chain; it only
 * proposed perception upstream. Any failed gate vetoes with a reject code.
 */

import {
  bscScoreMode,
  computeFriction,
  computeScoredFrictionBps,
  evaluateCatalystEntry,
  evaluateRsContinuation,
  evaluateGovernor,
  evaluateNetEdge,
  evaluateRiskGates,
  evaluateStopCoherence,
  evaluateShadowFill,
  expectedMoveBps as calibratedMoveBps,
  edgeEstimate,
  scoreBsc,
  type BscScoreInputs,
  type CalibrationReport,
  type EligibleAllowlist,
  type Regime,
  type RiskConfig,
  type RiskState,
  type SignalFamily,
  type SignalObservation,
} from "@wardenclaw/core";
import { expectedSlippageBps } from "@wardenclaw/bsc-adapter";
import { evaluateTwakPolicy, type TwakIntent, type TwakPolicyConfig } from "@wardenclaw/twak-adapter";

export interface CandidateInput {
  symbol: string;
  signalFamily: Exclude<SignalFamily, "safety">;
  scoreInputs: BscScoreInputs;
  cmcToolsUsed: string[];
  marketDataTimestamp: string;

  /** Route legs (held tokens) and execution params. */
  tokenInAddress: string;
  tokenOutAddress: string;
  router: string;
  spender: string;
  to: string;

  /** Volatility band for the pair (ATR as a fraction of price). */
  atrPct: number;

  /** Real pool state for slippage/shadow modeling. */
  reserveIn: number;
  reserveOut: number;
  poolFeeBps: number;
  gasPerLegUsd: number;

  /** Optional shadow-fill inputs; when omitted, modeled from reserves at size. */
  shadow?: { expectedOut: number; simulatedOut: number };
  /** Whether the route is non-spot (always rejected); defaults false. */
  isNonSpot?: boolean;
  /** Whether this candidate is the stable↔stable Micro-Scout. */
  isMicroScout?: boolean;
  /**
   * Recent per-token history (chronological). When present, catalyst candidates
   * must clear the uncrowding checks (trending delta, volume expansion, no first
   * spike) and rs_continuation must clear two-consecutive outperformance.
   */
  entryObservations?: SignalObservation[];
}

export interface PipelineContext {
  config: RiskConfig;
  calibration: CalibrationReport;
  allowlist: EligibleAllowlist;
  twakPolicy: TwakPolicyConfig;
  portfolioUsd: number;
  deployableUsd: number;
  windowDrawdownPct: number;
  dailyDrawdownPct: number;
  openPositions: number;
  tradesToday: number;
  survivalMode: boolean;
  marketDataStale: boolean;
  calibrationStale: boolean;
  /** Measured real round-trip cost (Wallet Ledger). Falls back to the modeled
   *  real friction at size when undefined (e.g. before the first real fill). */
  realRoundTripBps?: number;
  /** WS6 week-schedule risk budget: multiplier on the governor's allowed size
   *  (PRESS >1, DEFEND <1, HUNT 1). Bounded downstream by maxPositionPct and the
   *  volatility-stop size, so it can never breach the hard caps. Defaults to 1. */
  sizeMultiplier?: number;
  /** The risk state that produced `sizeMultiplier` (for the audit trail). */
  riskState?: RiskState;
  /** WS7 committed market regime. RED blocks new directional entries (scouts and
   *  safety exits excepted). Defaults to undefined (no regime gate). */
  marketRegime?: Regime;
  /** Active week-state score floor. PRESS lowers it once; DEFEND raises it. */
  minimumScore?: number;
  /** Additional scored net-edge margin required by DEFEND. */
  netEdgeBonusBps?: number;
  /** Marks the one pre-committed late-week PRESS trade. */
  pressTrade?: boolean;
}

export interface PipelineResult {
  symbol: string;
  signalFamily: SignalFamily;
  score: number;
  mode: "attack" | "scout" | "none";
  approved: boolean;
  rejectCode?: string;
  reasons: string[];
  economics: {
    expectedMoveBps: number;
    frictionBps: number;
    realFrictionBps: number;
    simulatedCostBps: number;
    scoredFrictionBps: number;
    realRoundTripBps?: number;
    walletFloorBps?: number;
    walletFloorPassed?: boolean;
    netEdgePassed: boolean;
    stopDistancePct?: number;
    stopCoherencePassed?: boolean;
    shadowFillDeviationBps?: number;
    positionSizeUsd: number;
  };
  governor: { sizeFraction: number; bindingLayer: string; remainingBudgetPct: number };
  /** WS6 week-schedule risk state and the size multiplier it imposed. */
  riskState?: RiskState;
  sizeMultiplier?: number;
  pressTrade?: boolean;
  intent?: TwakIntent;
}

export function evaluateCandidate(input: CandidateInput, ctx: PipelineContext): PipelineResult {
  const reasons: string[] = [];
  const score = scoreBsc(input.scoreInputs);
  const mode = bscScoreMode(score);
  const minimumScore = ctx.minimumScore ?? 65;

  const baseEconomics = {
    expectedMoveBps: 0,
    frictionBps: 0,
    realFrictionBps: 0,
    simulatedCostBps: 0,
    scoredFrictionBps: 0,
    netEdgePassed: false,
    positionSizeUsd: 0,
  };

  // Score gate: below scout threshold → no trade.
  if (score < minimumScore && !input.isMicroScout) {
    return {
      symbol: input.symbol,
      signalFamily: input.signalFamily,
      score,
      mode,
      approved: false,
      rejectCode: "REJECT_LOW_SCORE",
      reasons: [`score ${score} below active ${ctx.riskState ?? "HUNT"} threshold ${minimumScore}`],
      economics: baseEconomics,
      governor: { sizeFraction: 0, bindingLayer: "n/a", remainingBudgetPct: 0 },
    };
  }

  // Family entry-quality gates (deterministic; the LLM touches none of this).
  // Catalyst must be uncrowded (rising rank + fresh volume + post-spike continuation);
  // rs_continuation must show two consecutive outperformance checks with rising volume.
  if (!input.isMicroScout && input.entryObservations) {
    if (input.signalFamily === "catalyst") {
      const cat = evaluateCatalystEntry(input.entryObservations, {
        trendingDeltaMin: ctx.config.trendingDeltaMin,
        trendingTopN: ctx.config.trendingTopN,
        volumeExpansionMin: ctx.config.volumeExpansionMin,
        spikeCooldownChecks: ctx.config.spikeCooldownChecks,
        maxRetracePct: ctx.config.maxRetracePct,
        spikeMinPct: ctx.config.spikeMinPct,
      });
      if (!cat.pass) {
        return {
          symbol: input.symbol,
          signalFamily: input.signalFamily,
          score,
          mode,
          approved: false,
          rejectCode: cat.rejectCode,
          reasons: cat.reasons,
          economics: baseEconomics,
          governor: { sizeFraction: 0, bindingLayer: "n/a", remainingBudgetPct: 0 },
        };
      }
      reasons.push(`catalyst entry: ${cat.reasons.join("; ")}`);
    } else if (input.signalFamily === "rs_continuation") {
      const rs = evaluateRsContinuation(input.entryObservations, {
        rsOutperformMinBps: ctx.config.rsOutperformMinBps,
      });
      if (!rs.pass) {
        return {
          symbol: input.symbol,
          signalFamily: input.signalFamily,
          score,
          mode,
          approved: false,
          rejectCode: rs.rejectCode,
          reasons: rs.reasons,
          economics: baseEconomics,
          governor: { sizeFraction: 0, bindingLayer: "n/a", remainingBudgetPct: 0 },
        };
      }
      reasons.push(`rs continuation: ${rs.reasons.join("; ")}`);
    }
  }

  // Calibrated expected move + governor edge estimate.
  const expectedMoveBps = input.isMicroScout
    ? 0
    : calibratedMoveBps(score, ctx.calibration);
  const edge = edgeEstimate(score, ctx.calibration);

  const governor = evaluateGovernor({
    state: { windowDrawdownPct: ctx.windowDrawdownPct, dailyDrawdownPct: ctx.dailyDrawdownPct },
    competitionDqDrawdownPct: ctx.config.competitionDqDrawdownPct,
    internalWindowDrawdownPct: ctx.config.internalWindowDrawdownPct,
    maxDailyDrawdownPct: ctx.config.maxDailyDrawdownPct,
    kellyFraction: ctx.config.kellyFraction,
    edgeEstimate: edge,
    maxPositionFraction: ctx.config.maxPositionPct / 100,
  });
  // WS6 week budget scales the governor's allowed size (PRESS up / DEFEND down);
  // maxPositionPct and the volatility-stop size still bind downstream.
  const sizeMultiplier = ctx.sizeMultiplier ?? 1;
  const governorCapUsd = governor.sizeFraction * ctx.deployableUsd * sizeMultiplier;
  if (!input.isMicroScout && ctx.riskState && sizeMultiplier !== 1) {
    reasons.push(`week budget ${ctx.riskState}: size ×${sizeMultiplier}`);
  }

  // Friction-at-notional model from real reserves + gas + simulated scoring cost.
  const estimateFrictionBps = (notionalUsd: number): number => {
    const slippageBps = expectedSlippageBps({
      amountIn: notionalUsd,
      reserveIn: input.reserveIn,
      reserveOut: input.reserveOut,
      feeBps: input.poolFeeBps,
    });
    return computeFriction({
      notionalUsd: Math.max(notionalUsd, 1),
      gasInUsd: input.gasPerLegUsd,
      gasOutUsd: input.gasPerLegUsd,
      expectedSlippageBps: slippageBps,
      lpFeeBps: input.poolFeeBps,
      twakFeeBps: ctx.config.twakFeeBps,
      scoringSimCostBps: ctx.config.scoringSimCostBps,
    }).frictionBps;
  };

  // Volatility-derived stop + size coherence (Micro-Scout uses a fixed tiny size).
  let positionSizeUsd: number;
  let stopDistancePct: number | undefined;
  let stopCoherencePassed: boolean | undefined;
  if (input.isMicroScout) {
    positionSizeUsd = ctx.config.microScoutUsd;
  } else {
    const coherence = evaluateStopCoherence({
      portfolioUsd: ctx.portfolioUsd,
      deployableUsd: ctx.deployableUsd,
      perTradeRiskPct: ctx.config.perTradeRiskPct,
      stopAtrMultiple: ctx.config.stopAtrMultiple,
      recentAtrPct: input.atrPct,
      maxPositionPct: ctx.config.maxPositionPct,
      governorCapUsd,
      frictionBudgetBps: ctx.config.frictionBudgetBps,
      estimateFrictionBps,
    });
    stopDistancePct = coherence.stopDistancePct;
    stopCoherencePassed = coherence.passed;
    if (!coherence.passed) {
      return {
        symbol: input.symbol,
        signalFamily: input.signalFamily,
        score,
        mode,
        approved: false,
        rejectCode: coherence.rejectCode,
        reasons: [coherence.reason],
        economics: { ...baseEconomics, expectedMoveBps, stopDistancePct, stopCoherencePassed: false },
        governor: { sizeFraction: governor.sizeFraction, bindingLayer: governor.bindingLayer, remainingBudgetPct: governor.remainingBudgetPct },
      };
    }
    positionSizeUsd = coherence.positionSizeUsd;
  }

  // Friction + net-edge at the chosen size.
  const slippageBps = expectedSlippageBps({
    amountIn: positionSizeUsd,
    reserveIn: input.reserveIn,
    reserveOut: input.reserveOut,
    feeBps: input.poolFeeBps,
  });
  const friction = computeFriction({
    notionalUsd: Math.max(positionSizeUsd, 1),
    gasInUsd: input.gasPerLegUsd,
    gasOutUsd: input.gasPerLegUsd,
    expectedSlippageBps: slippageBps,
    lpFeeBps: input.poolFeeBps,
    twakFeeBps: ctx.config.twakFeeBps,
    scoringSimCostBps: ctx.config.scoringSimCostBps,
  });

  // Two ledgers: scored friction (competition cost, drives net-edge) and the
  // measured real round-trip (Wallet Ledger, drives the wallet floor). Real cost
  // falls back to the modeled real friction at size until a real fill is measured.
  const scoredFrictionBps = computeScoredFrictionBps({
    notionalUsd: Math.max(positionSizeUsd, 1),
    scoringSimCostBps: ctx.config.scoringSimCostBps,
  });
  const realRoundTripBps = ctx.realRoundTripBps ?? friction.realFrictionBps;

  // Shadow-fill deviation (modeled from reserves when not supplied).
  const shadow = input.shadow ?? { expectedOut: 1, simulatedOut: 1 };
  const shadowResult = evaluateShadowFill({
    expectedOut: shadow.expectedOut,
    simulatedOut: shadow.simulatedOut,
    toleranceBps: ctx.config.shadowFillToleranceBps,
  });

  const netEdge = input.isMicroScout
    ? undefined
    : evaluateNetEdge({
        expectedMoveBps,
        scoredFrictionBps,
        netEdgeMinBps: ctx.config.netEdgeMinBps + (ctx.netEdgeBonusBps ?? 0),
        realRoundTripBps,
        walletFloorFraction: ctx.config.walletFloorFraction,
      });

  // Risk Constitution.
  const riskGate = evaluateRiskGates(
    {
      chainId: 56,
      router: input.router,
      spender: input.spender,
      tokenInAddress: input.tokenInAddress,
      tokenOutAddress: input.tokenOutAddress,
      approvalAmount: positionSizeUsd,
      mandateAmount: positionSizeUsd,
      isInfiniteApproval: false,
      isNonSpot: input.isNonSpot ?? false,
      notionalUsd: positionSizeUsd,
      expectedMoveBps,
      scoredFrictionBps,
      realRoundTripBps,
      shadowFill: shadow,
      isMicroScout: input.isMicroScout,
    },
    {
      portfolioValueUsd: ctx.portfolioUsd,
      windowDrawdownPct: ctx.windowDrawdownPct,
      dailyDrawdownPct: ctx.dailyDrawdownPct,
      openPositions: ctx.openPositions,
      tradesToday: ctx.tradesToday,
      calibrationStale: ctx.calibrationStale,
      marketDataStale: ctx.marketDataStale,
      survivalMode: ctx.survivalMode,
      regime: ctx.marketRegime,
    },
    {
      config: ctx.config,
      allowlist: ctx.allowlist,
      allowedSpenders: ctx.twakPolicy.allowedSpenders.length ? ctx.twakPolicy.allowedSpenders : undefined,
    },
  );

  const economics = {
    expectedMoveBps,
    frictionBps: friction.frictionBps,
    realFrictionBps: friction.realFrictionBps,
    simulatedCostBps: friction.simulatedCostBps,
    scoredFrictionBps,
    realRoundTripBps,
    walletFloorBps: netEdge?.walletFloorBps,
    walletFloorPassed: netEdge?.walletFloorPassed,
    netEdgePassed: input.isMicroScout ? true : (netEdge?.passed ?? false),
    stopDistancePct,
    stopCoherencePassed,
    shadowFillDeviationBps: shadowResult.deviationBps,
    positionSizeUsd,
  };

  if (!riskGate.approved) {
    return {
      symbol: input.symbol,
      signalFamily: input.isMicroScout ? "scout" : input.signalFamily,
      score,
      mode,
      approved: false,
      rejectCode: riskGate.rejectCode,
      reasons: riskGate.reasons,
      economics,
      governor: { sizeFraction: governor.sizeFraction, bindingLayer: governor.bindingLayer, remainingBudgetPct: governor.remainingBudgetPct },
    };
  }

  // TWAK local policy — the final self-custody pre-sign guardrail.
  const intent: TwakIntent = {
    kind: "swap",
    chainId: 56,
    executionType: "spot_only",
    router: input.router,
    spender: input.spender,
    to: input.to,
    tokenInAddress: input.tokenInAddress,
    tokenOutAddress: input.tokenOutAddress,
    amountInUsd: positionSizeUsd,
    txValueWei: "0",
    isInfiniteApproval: false,
    approvalAmount: positionSizeUsd,
    mandateAmount: positionSizeUsd,
    slippageBps: Math.round(slippageBps),
    isNonSpot: input.isNonSpot ?? false,
    decodedAction: "enter_long",
    mandateAction: "enter_long",
  };
  const policy = evaluateTwakPolicy(intent, ctx.allowlist, ctx.twakPolicy, { spentTodayUsd: 0 });
  if (!policy.approved) {
    return {
      symbol: input.symbol,
      signalFamily: input.isMicroScout ? "scout" : input.signalFamily,
      score,
      mode,
      approved: false,
      rejectCode: policy.rejectCode,
      reasons: [policy.reason],
      economics,
      governor: { sizeFraction: governor.sizeFraction, bindingLayer: governor.bindingLayer, remainingBudgetPct: governor.remainingBudgetPct },
    };
  }

  reasons.push(`score ${score} (${mode}), ${input.signalFamily} family`);
  reasons.push(economics.netEdgePassed ? "net-edge cleared" : "micro-scout exempt from net-edge");
  return {
    symbol: input.symbol,
    signalFamily: input.isMicroScout ? "scout" : input.signalFamily,
    score,
    mode,
    approved: true,
    reasons,
    economics,
    governor: { sizeFraction: governor.sizeFraction, bindingLayer: governor.bindingLayer, remainingBudgetPct: governor.remainingBudgetPct },
    riskState: input.isMicroScout ? undefined : ctx.riskState,
    sizeMultiplier: input.isMicroScout ? undefined : sizeMultiplier,
    pressTrade: input.isMicroScout ? undefined : ctx.pressTrade,
    intent,
  };
}
