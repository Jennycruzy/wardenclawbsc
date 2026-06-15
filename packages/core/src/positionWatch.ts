/**
 * Fast position-watch decision logic.
 *
 * Protection cadence ≠ decision cadence. A catalyst-tier token can dump double
 * digits between slow decision cycles, so the worker runs a dedicated watch loop
 * every POSITION_WATCH_INTERVAL_SECONDS *while a position is open*. That loop does
 * NOT score, open positions, or call the LLM — it only updates the trail and fires
 * a TWAK safety exit on breach.
 *
 * This module is the pure decision over one tick; the worker supplies the real
 * quoter price (with RPC failover) and performs the TWAK exit + persistence.
 */

import {
  updateTrailingStop,
  isStopBreached,
  exitReasonFor,
  unrealizedGainPct,
  type TrailingStopConfig,
  type TrailingStopState,
  type ExitReason,
} from "./trailingStop.js";

export type StalenessAction = "alert_only" | "reduce";

export type WatchPriceInput =
  | { fresh: true; price: number }
  | { fresh: false; secondsSinceLastPrice: number };

export interface WatchTickInput {
  trail: TrailingStopState;
  price: WatchPriceInput;
  config: TrailingStopConfig;
  stalenessLimitSeconds: number;
  stalenessAction: StalenessAction;
  /** Engage the tight (defend/red) trail on this tick. */
  tightMode?: boolean;
  /**
   * Force a rotation-to-stables exit this tick regardless of the stop, when the
   * price is fresh (WS7 RED regime). A blind feed can't be exited, so staleness
   * still takes precedence.
   */
  forceExit?: { reason: ExitReason };
}

export interface WatchExit {
  reason: ExitReason;
  stopPrice: number;
  currentPrice: number;
  entryPrice: number;
  highWaterMark: number;
  gainPct: number;
}

export interface WatchStale {
  secondsSinceLastPrice: number;
  /** The conservative action armed while the price feed is blind. */
  action: StalenessAction;
}

export interface WatchTickResult {
  action: "exit" | "hold" | "stale";
  /** New trail state when the price was fresh (persist this). */
  updatedTrail?: TrailingStopState;
  exit?: WatchExit;
  stale?: WatchStale;
}

/**
 * Evaluate one watch tick. Fresh price → ratchet the trail and exit on breach.
 * Missing price beyond the staleness limit → alert and arm the conservative
 * action (never silently fly blind). A momentary miss under the limit is a hold
 * on the existing trail.
 */
export function evaluateWatchTick(input: WatchTickInput): WatchTickResult {
  if (!input.price.fresh) {
    if (input.price.secondsSinceLastPrice >= input.stalenessLimitSeconds) {
      return {
        action: "stale",
        stale: { secondsSinceLastPrice: input.price.secondsSinceLastPrice, action: input.stalenessAction },
      };
    }
    // Brief miss under the limit: hold on the last good trail, no change.
    return { action: "hold", updatedTrail: input.trail };
  }

  const currentPrice = input.price.price;
  const updatedTrail = updateTrailingStop(input.trail, {
    currentPrice,
    tightMode: input.tightMode,
    config: input.config,
  });

  // Forced rotation (RED regime) exits at the current price regardless of the stop.
  if (input.forceExit) {
    return {
      action: "exit",
      updatedTrail,
      exit: {
        reason: input.forceExit.reason,
        stopPrice: updatedTrail.stopPrice,
        currentPrice,
        entryPrice: updatedTrail.entryPrice,
        highWaterMark: updatedTrail.highWaterMark,
        gainPct: unrealizedGainPct(updatedTrail, currentPrice),
      },
    };
  }

  if (isStopBreached(updatedTrail, currentPrice)) {
    return {
      action: "exit",
      updatedTrail,
      exit: {
        reason: exitReasonFor(updatedTrail),
        stopPrice: updatedTrail.stopPrice,
        currentPrice,
        entryPrice: updatedTrail.entryPrice,
        highWaterMark: updatedTrail.highWaterMark,
        gainPct: unrealizedGainPct(updatedTrail, currentPrice),
      },
    };
  }

  return { action: "hold", updatedTrail };
}
