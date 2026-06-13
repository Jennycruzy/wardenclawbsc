import { describe, it, expect } from "vitest";
import {
  evaluateRiskGates,
  EligibleAllowlist,
  DEFAULT_RISK_CONFIG,
  type RiskGateCandidate,
  type RiskGateState,
  type RiskGateContext,
} from "../src/index.js";

const USDT = "0x55d398326f99059fF775485246999027B3197955";
const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const CAKE = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82";

const allowlist = EligibleAllowlist.fromJson([
  { symbol: "USDT", cmcId: 825, bscContractAddress: USDT, decimals: 18, isStable: true },
  { symbol: "USDC", cmcId: 3408, bscContractAddress: USDC, decimals: 18, isStable: true },
  { symbol: "CAKE", cmcId: 7186, bscContractAddress: CAKE, decimals: 18 },
]);

const ctx: RiskGateContext = { config: DEFAULT_RISK_CONFIG, allowlist };

const baseState: RiskGateState = {
  portfolioValueUsd: 40,
  windowDrawdownPct: 0,
  dailyDrawdownPct: 0,
  openPositions: 0,
  tradesToday: 0,
  calibrationStale: false,
  marketDataStale: false,
  survivalMode: false,
};

const baseCandidate: RiskGateCandidate = {
  chainId: 56,
  router: "pancakeswap",
  spender: "0xrouter",
  tokenInAddress: USDT,
  tokenOutAddress: CAKE,
  approvalAmount: 20,
  mandateAmount: 20,
  isInfiniteApproval: false,
  isNonSpot: false,
  notionalUsd: 20,
  expectedMoveBps: 300,
  scoredFrictionBps: 120,
};

describe("risk constitution gate chain", () => {
  it("approves a clean spot trade between eligible contracts", () => {
    const r = evaluateRiskGates(baseCandidate, baseState, ctx);
    expect(r.approved).toBe(true);
    expect(r.passedGates).toContain("net_edge");
  });

  it("rejects a non-spot / leverage route", () => {
    const r = evaluateRiskGates({ ...baseCandidate, isNonSpot: true }, baseState, ctx);
    expect(r.rejectCode).toBe("REJECT_NON_SPOT");
  });

  it("rejects a wrong-chain transaction", () => {
    const r = evaluateRiskGates({ ...baseCandidate, chainId: 1 }, baseState, ctx);
    expect(r.rejectCode).toBe("REJECT_WRONG_CHAIN");
  });

  it("rejects a non-allowlisted router", () => {
    const r = evaluateRiskGates({ ...baseCandidate, router: "shadyswap" }, baseState, ctx);
    expect(r.rejectCode).toBe("REJECT_ROUTER_NOT_ALLOWED");
  });

  it("rejects an off-list output token", () => {
    const r = evaluateRiskGates(
      { ...baseCandidate, tokenOutAddress: "0x000000000000000000000000000000000000dead" },
      baseState,
      ctx,
    );
    expect(r.rejectCode).toBe("REJECT_INELIGIBLE_CONTRACT");
  });

  it("rejects an infinite approval by default", () => {
    const r = evaluateRiskGates({ ...baseCandidate, isInfiniteApproval: true }, baseState, ctx);
    expect(r.rejectCode).toBe("REJECT_INFINITE_APPROVAL");
  });

  it("rejects an approval above mandate + buffer", () => {
    const r = evaluateRiskGates({ ...baseCandidate, approvalAmount: 100 }, baseState, ctx);
    expect(r.rejectCode).toBe("REJECT_INFINITE_APPROVAL");
  });

  it("blocks a directional trade with insufficient net edge", () => {
    const r = evaluateRiskGates({ ...baseCandidate, expectedMoveBps: 100 }, baseState, ctx);
    expect(r.rejectCode).toBe("REJECT_NET_EDGE");
  });

  it("rejects a scored-positive trade that fails the wallet floor", () => {
    // scored required = 20 + 30 = 50 (cleared by 60); wallet floor = 0.75 × 200 = 150 (failed).
    const r = evaluateRiskGates(
      { ...baseCandidate, expectedMoveBps: 60, scoredFrictionBps: 20, realRoundTripBps: 200 },
      baseState,
      ctx,
    );
    expect(r.rejectCode).toBe("REJECT_WALLET_FLOOR");
  });

  it("clears both gates and records the wallet_floor gate", () => {
    const r = evaluateRiskGates(
      { ...baseCandidate, expectedMoveBps: 300, scoredFrictionBps: 20, realRoundTripBps: 200 },
      baseState,
      ctx,
    );
    expect(r.approved).toBe(true);
    expect(r.passedGates).toContain("wallet_floor");
  });

  it("allows the stable↔stable micro-scout despite weak edge", () => {
    const r = evaluateRiskGates(
      {
        ...baseCandidate,
        tokenInAddress: USDT,
        tokenOutAddress: USDC,
        expectedMoveBps: 0,
        isMicroScout: true,
      },
      baseState,
      ctx,
    );
    expect(r.approved).toBe(true);
    expect(r.passedGates).toContain("micro_scout_exempt");
  });

  it("blocks stale market data for directional trades", () => {
    const r = evaluateRiskGates(baseCandidate, { ...baseState, marketDataStale: true }, ctx);
    expect(r.rejectCode).toBe("REJECT_STALE_DATA");
  });

  it("blocks stale calibration", () => {
    const r = evaluateRiskGates(baseCandidate, { ...baseState, calibrationStale: true }, ctx);
    expect(r.rejectCode).toBe("REJECT_STALE_CALIBRATION");
  });

  it("survival mode blocks new entries but a forced safety exit still passes", () => {
    const blocked = evaluateRiskGates(baseCandidate, { ...baseState, survivalMode: true }, ctx);
    expect(blocked.approved).toBe(false);

    const exit = evaluateRiskGates(
      { ...baseCandidate, forcedSafetyExit: true, expectedMoveBps: 0 },
      { ...baseState, survivalMode: true },
      ctx,
    );
    expect(exit.approved).toBe(true);
  });

  it("blocks when below the danger threshold", () => {
    const r = evaluateRiskGates(baseCandidate, { ...baseState, portfolioValueUsd: 5 }, ctx);
    expect(r.rejectCode).toBe("REJECT_DANGER_THRESHOLD");
  });

  it("enforces the max daily trade cap", () => {
    const r = evaluateRiskGates(baseCandidate, { ...baseState, tradesToday: 3 }, ctx);
    expect(r.rejectCode).toBe("REJECT_MAX_DAILY_TRADES");
  });

  it("aborts on a bad shadow fill", () => {
    const r = evaluateRiskGates(
      { ...baseCandidate, shadowFill: { expectedOut: 100, simulatedOut: 90 } },
      baseState,
      ctx,
    );
    expect(r.rejectCode).toBe("REJECT_SHADOW_FILL");
  });

  it("blocks new directional entries in a RED regime (REJECT_REGIME_RED)", () => {
    const r = evaluateRiskGates(baseCandidate, { ...baseState, regime: "RED" }, ctx);
    expect(r.approved).toBe(false);
    expect(r.rejectCode).toBe("REJECT_REGIME_RED");
  });

  it("still allows the stable scout and the rotation-to-stables exit in a RED regime", () => {
    const scout = evaluateRiskGates(
      { ...baseCandidate, tokenOutAddress: USDC, isMicroScout: true },
      { ...baseState, regime: "RED" },
      ctx,
    );
    expect(scout.approved).toBe(true);

    const exit = evaluateRiskGates(
      { ...baseCandidate, forcedSafetyExit: true, expectedMoveBps: 0 },
      { ...baseState, regime: "RED" },
      ctx,
    );
    expect(exit.approved).toBe(true);
  });

  it("does not block entries when the regime is GREEN or NEUTRAL", () => {
    expect(evaluateRiskGates(baseCandidate, { ...baseState, regime: "GREEN" }, ctx).approved).toBe(true);
    expect(evaluateRiskGates(baseCandidate, { ...baseState, regime: "NEUTRAL" }, ctx).approved).toBe(true);
  });

  it("rejects a dust trade when the measured real round-trip exceeds the ceiling", () => {
    // 400bps > the 350bps default ceiling — fixed cost dominates a too-small notional.
    const r = evaluateRiskGates(
      { ...baseCandidate, expectedMoveBps: 1000, realRoundTripBps: 400 },
      baseState,
      ctx,
    );
    expect(r.approved).toBe(false);
    expect(r.rejectCode).toBe("REJECT_DUST_TRADE");
  });

  it("exempts the stable scout and forced safety exits from the dust gate", () => {
    const scout = evaluateRiskGates(
      { ...baseCandidate, tokenOutAddress: USDC, isMicroScout: true, realRoundTripBps: 400 },
      baseState,
      ctx,
    );
    expect(scout.approved).toBe(true);

    const exit = evaluateRiskGates(
      { ...baseCandidate, forcedSafetyExit: true, expectedMoveBps: 0, realRoundTripBps: 400 },
      baseState,
      ctx,
    );
    expect(exit.approved).toBe(true);
  });

  it("allows a healthy-cost trade below the dust ceiling", () => {
    const r = evaluateRiskGates(
      { ...baseCandidate, expectedMoveBps: 300, realRoundTripBps: 120 },
      baseState,
      ctx,
    );
    expect(r.approved).toBe(true);
    expect(r.passedGates).toContain("net_edge");
  });
});
