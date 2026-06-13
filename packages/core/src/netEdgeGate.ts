/**
 * Net-Edge Gate (two ledgers).
 *
 * A directional trade must clear TWO independent hurdles:
 *
 *   1. Scored Ledger gate — expected move must beat the competition's simulated
 *      round-trip cost plus a configured margin:
 *          expectedMoveBps >= scoredFrictionBps + netEdgeMinBps
 *      This is the number that wins the tournament.
 *
 *   2. Wallet floor — a hard sanity check that the real $40 is never knowingly
 *      traded into wallet-negative territory even when the scored math says go:
 *          expectedMoveBps >= walletFloorFraction × realRoundTripBps
 *      `realRoundTripBps` is MEASURED from real fills (never hardcoded). Skipped
 *      only when no real-cost estimate is supplied.
 *
 * Forced safety exits bypass BOTH (stop/trail enforcement must always be able to
 * get out). Applies to entries and exits alike otherwise.
 */

import { RejectCode } from "./types.js";

export interface NetEdgeInputs {
  expectedMoveBps: number;
  /** Scored Ledger: round-trip simulated scoring cost. */
  scoredFrictionBps: number;
  netEdgeMinBps: number;
  /** Wallet Ledger: measured real round-trip cost. Omit to skip the wallet floor. */
  realRoundTripBps?: number;
  /** Fraction of realRoundTripBps the expected move must exceed (default 0.75). */
  walletFloorFraction?: number;
  /** Forced safety exits bypass the gate. */
  forcedSafetyExit?: boolean;
}

export interface NetEdgeResult {
  passed: boolean;
  /** expectedMove - requiredMove; positive means edge to spare. */
  marginBps: number;
  requiredMoveBps: number;
  /** walletFloorFraction × realRoundTripBps, when a real-cost estimate was given. */
  walletFloorBps?: number;
  walletFloorPassed?: boolean;
  rejectCode?: typeof RejectCode.NET_EDGE | typeof RejectCode.WALLET_FLOOR;
  reason: string;
}

export function evaluateNetEdge(inputs: NetEdgeInputs): NetEdgeResult {
  const requiredMoveBps = inputs.scoredFrictionBps + inputs.netEdgeMinBps;
  const marginBps = inputs.expectedMoveBps - requiredMoveBps;

  const hasWalletFloor = inputs.realRoundTripBps !== undefined;
  const walletFloorFraction = inputs.walletFloorFraction ?? 0.75;
  const walletFloorBps = hasWalletFloor
    ? walletFloorFraction * (inputs.realRoundTripBps as number)
    : undefined;
  const walletFloorPassed = hasWalletFloor
    ? inputs.expectedMoveBps >= (walletFloorBps as number)
    : undefined;

  if (inputs.forcedSafetyExit) {
    return {
      passed: true,
      marginBps,
      requiredMoveBps,
      walletFloorBps,
      walletFloorPassed,
      reason: "forced safety exit — net-edge gate and wallet floor bypassed",
    };
  }

  // 1. Scored Ledger gate.
  if (inputs.expectedMoveBps < requiredMoveBps) {
    return {
      passed: false,
      marginBps,
      requiredMoveBps,
      walletFloorBps,
      walletFloorPassed,
      rejectCode: RejectCode.NET_EDGE,
      reason: `scored: expected ${inputs.expectedMoveBps}bps < required ${requiredMoveBps}bps (scored friction ${inputs.scoredFrictionBps} + margin ${inputs.netEdgeMinBps})`,
    };
  }

  // 2. Wallet floor — protect the real $40 even when scored math passes.
  if (hasWalletFloor && !walletFloorPassed) {
    return {
      passed: false,
      marginBps,
      requiredMoveBps,
      walletFloorBps,
      walletFloorPassed,
      rejectCode: RejectCode.WALLET_FLOOR,
      reason: `wallet floor: expected ${inputs.expectedMoveBps}bps < ${walletFloorFraction}× real round-trip ${inputs.realRoundTripBps}bps = ${(walletFloorBps as number).toFixed(1)}bps`,
    };
  }

  return {
    passed: true,
    marginBps,
    requiredMoveBps,
    walletFloorBps,
    walletFloorPassed,
    reason: `scored expected ${inputs.expectedMoveBps}bps >= required ${requiredMoveBps}bps${hasWalletFloor ? `; wallet floor ${(walletFloorBps as number).toFixed(1)}bps cleared` : ""}`,
  };
}
