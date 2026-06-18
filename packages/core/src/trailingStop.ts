/**
 * Trailing-stop ratchet — the right-tail PnL fix.
 *
 * Spot markets have no native stops, so the fast watch loop (WS3) re-evaluates
 * this on its own cadence and fires a TWAK safety exit on breach. The ratchet is
 * deterministic and only ever moves the stop UP:
 *
 *   1. Initial stop  — the volatility stop: STOP_ATR_MULTIPLE × ATR below entry.
 *   2. Breakeven+fees — once unrealized gain ≥ BREAKEVEN_TRIGGER_ATR × ATR, the
 *      stop jumps to entry + estimated REAL round-trip cost, so a runner can never
 *      turn back into a wallet loss.
 *   3. Trail          — beyond breakeven, trail TRAIL_ATR_MULTIPLE × ATR below the
 *      high-water mark (HWM). No fixed take-profit — the right tail stays open.
 *   4. Ratchet-up only — the stop never widens.
 *   5. Tighten mode   — DEFEND/RED states trail at the tighter TRAIL_TIGHT_ATR_MULTIPLE.
 *
 * A breach is a FORCED SAFETY EXIT: it bypasses the net-edge gate (existing rule)
 * but still respects slippage caps and eligibility.
 */

export interface TrailingStopConfig {
  /** Initial stop distance: multiples of ATR below entry. */
  stopAtrMultiple: number;
  /** Unrealized gain (in ATR multiples) that arms the breakeven+fees ratchet. */
  breakevenTriggerAtr: number;
  /** Normal trail distance below HWM, in ATR multiples. */
  trailAtrMultiple: number;
  /** Tight (defend/red) trail distance below HWM, in ATR multiples. */
  trailTightAtrMultiple: number;
}

export interface TrailingStopState {
  entryPrice: number;
  /** ATR as a fraction of price; refreshed on the watch cadence. */
  atrPct: number;
  /** Highest mid price seen since entry. */
  highWaterMark: number;
  /** Current stop price — only ratchets up. */
  stopPrice: number;
  /** Measured real round-trip cost in bps (drives breakeven+fees). */
  realRoundTripBps: number;
  /** Whether the breakeven+fees ratchet has engaged (latches on). */
  breakevenArmed: boolean;
  /** Whether the tight (defend/red) trail is active. */
  tightMode: boolean;
}

export const ExitReason = {
  /** Breached the initial volatility stop (still below/at breakeven). */
  STOP: "EXIT_STOP",
  /** Breached the ratcheted trail (breakeven armed) — locking in the runner. */
  TRAIL_RATCHET: "EXIT_TRAIL_RATCHET",
  /** Rotated to stables because the market regime turned RED (WS7). */
  REGIME_RED: "EXIT_REGIME_RED",
  /** Watchdog forced a rotation to stables: portfolio fell to the danger threshold. */
  PORTFOLIO_DANGER: "EXIT_PORTFOLIO_DANGER",
} as const;
export type ExitReason = (typeof ExitReason)[keyof typeof ExitReason];

function initialStopPrice(entryPrice: number, atrPct: number, cfg: TrailingStopConfig): number {
  return entryPrice * (1 - cfg.stopAtrMultiple * atrPct);
}

export interface InitTrailingStopParams {
  entryPrice: number;
  atrPct: number;
  realRoundTripBps: number;
  config: TrailingStopConfig;
  tightMode?: boolean;
}

/** Create trail state at fill. */
export function initTrailingStop(params: InitTrailingStopParams): TrailingStopState {
  if (!(params.entryPrice > 0)) throw new Error("initTrailingStop: entryPrice must be > 0");
  if (!(params.atrPct > 0)) throw new Error("initTrailingStop: atrPct must be > 0");
  if (params.realRoundTripBps < 0) throw new Error("initTrailingStop: realRoundTripBps must be >= 0");
  return {
    entryPrice: params.entryPrice,
    atrPct: params.atrPct,
    highWaterMark: params.entryPrice,
    stopPrice: initialStopPrice(params.entryPrice, params.atrPct, params.config),
    realRoundTripBps: params.realRoundTripBps,
    breakevenArmed: false,
    tightMode: params.tightMode ?? false,
  };
}

export interface UpdateTrailingStopParams {
  currentPrice: number;
  /** Refreshed ATR (fraction of price). Falls back to the stored ATR. */
  atrPct?: number;
  /** Engage/disengage tighten mode (DEFEND/RED). */
  tightMode?: boolean;
  config: TrailingStopConfig;
}

/**
 * Recompute HWM and ratchet the stop. Pure: returns a new state, never widens
 * the stop. Tighten mode can be toggled on per call (it never relaxes the trail).
 */
export function updateTrailingStop(
  state: TrailingStopState,
  params: UpdateTrailingStopParams,
): TrailingStopState {
  if (!(params.currentPrice > 0)) throw new Error("updateTrailingStop: currentPrice must be > 0");
  const cfg = params.config;
  const atrPct = params.atrPct ?? state.atrPct;
  const tightMode = params.tightMode ?? state.tightMode;

  const highWaterMark = Math.max(state.highWaterMark, params.currentPrice);
  const gain = (params.currentPrice - state.entryPrice) / state.entryPrice;
  const breakevenArmed = state.breakevenArmed || gain >= cfg.breakevenTriggerAtr * atrPct;

  // Candidate stops — the stop is the MAX so it only ratchets up.
  const candidates = [state.stopPrice];
  if (breakevenArmed) {
    // Breakeven + real fees: never let a runner become a wallet loss.
    candidates.push(state.entryPrice * (1 + state.realRoundTripBps / 10_000));
    // Trail below the high-water mark.
    const trailMult = tightMode ? cfg.trailTightAtrMultiple : cfg.trailAtrMultiple;
    candidates.push(highWaterMark * (1 - trailMult * atrPct));
  }
  const stopPrice = Math.max(...candidates);

  return { ...state, atrPct, highWaterMark, stopPrice, breakevenArmed, tightMode };
}

/** True when the current price has breached the stop (a forced safety exit). */
export function isStopBreached(state: TrailingStopState, currentPrice: number): boolean {
  return currentPrice <= state.stopPrice;
}

/** Which exit reason a breach represents (for the audit trail). */
export function exitReasonFor(state: TrailingStopState): ExitReason {
  return state.breakevenArmed ? ExitReason.TRAIL_RATCHET : ExitReason.STOP;
}

/** Unrealized gain (fraction) at a price, relative to entry. */
export function unrealizedGainPct(state: TrailingStopState, currentPrice: number): number {
  return ((currentPrice - state.entryPrice) / state.entryPrice) * 100;
}
