/**
 * Open-position persistence. The trailing stop must survive a crash-restart: the
 * worker writes open positions (with their live HWM/stop state) to the runtime
 * store every watch tick, and on startup the watch loop restores them and resumes
 * the trail EXACTLY where it left off — no reset, no duplicate entry.
 *
 * This module is pure (serialize / parse with loud validation). File IO lives in
 * the worker so this stays testable.
 */

import { z } from "zod";
import type { TrailingStopState } from "./trailingStop.js";

export interface OpenPosition {
  mandateId: string;
  symbol: string;
  /** Held token (the long leg) and the stable it was bought with. */
  tokenInAddress: string;
  tokenOutAddress: string;
  /** Token units held (the long leg). */
  amountTokens: number;
  notionalUsd: number;
  openedAtIso: string;
  trail: TrailingStopState;
}

const trailSchema = z.object({
  entryPrice: z.number(),
  atrPct: z.number(),
  highWaterMark: z.number(),
  stopPrice: z.number(),
  realRoundTripBps: z.number(),
  breakevenArmed: z.boolean(),
  tightMode: z.boolean(),
});

const openPositionSchema = z.object({
  mandateId: z.string(),
  symbol: z.string(),
  tokenInAddress: z.string(),
  tokenOutAddress: z.string(),
  amountTokens: z.number(),
  notionalUsd: z.number(),
  openedAtIso: z.string(),
  trail: trailSchema,
});

export const openPositionsSchema = z.array(openPositionSchema);

/** Serialize open positions for the runtime store. */
export function serializeOpenPositions(positions: OpenPosition[]): string {
  return JSON.stringify(openPositionsSchema.parse(positions));
}

/**
 * Parse and validate persisted positions. Throws loudly on corruption rather
 * than silently flying blind on a restart (no fake state).
 */
export function parseOpenPositions(raw: string): OpenPosition[] {
  const data: unknown = JSON.parse(raw);
  return openPositionsSchema.parse(data) as OpenPosition[];
}
