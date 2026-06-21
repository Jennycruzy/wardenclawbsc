/**
 * Forward calibration-sample collector.
 *
 * Real calibration samples are an observed (score → realized move) pair: a
 * candidate is scored, then the price move that follows over a holding horizon is
 * measured. The CMC plan exposes only latest quotes (no history), so samples
 * cannot be replayed retroactively — they must be accumulated FORWARD. The worker
 * records each scored candidate's price as a pending observation; once the horizon
 * elapses, the realized move is measured against a fresh quote and emitted as a
 * { score, realizedMoveBps, win } sample for `calibrate:edge`.
 *
 * This module is pure logic over injected state; callers own all I/O and quotes,
 * and it never fabricates a realized move — an observation with no fresh price is
 * carried forward and eventually dropped, never guessed.
 */

import type { CalibrationSample } from "./edgeCalibration.js";

export interface PendingSample {
  symbol: string;
  family?: string;
  score: number;
  /** Mid/quote price at the moment the candidate was scored. */
  priceAtScore: number;
  scoredAtIso: string;
}

export interface MatureResult {
  matured: CalibrationSample[];
  remaining: PendingSample[];
}

/**
 * Append a scored observation, de-duplicating repeated scores of the same symbol
 * within `minGapMs`. The worker scores the universe every cycle (~5 min), so
 * without this a single token would spawn hundreds of near-identical pending rows
 * per day and swamp the real signal.
 */
export function recordPending(
  pending: PendingSample[],
  obs: PendingSample,
  minGapMs = 3_600_000,
): PendingSample[] {
  if (!(obs.priceAtScore > 0) || !Number.isFinite(obs.score)) return pending;
  for (let i = pending.length - 1; i >= 0; i--) {
    const prev = pending[i];
    if (!prev || prev.symbol !== obs.symbol) continue;
    const gap = Date.parse(obs.scoredAtIso) - Date.parse(prev.scoredAtIso);
    if (Number.isFinite(gap) && gap < minGapMs) return pending;
    break;
  }
  return [...pending, obs];
}

/**
 * Mature pending observations whose holding horizon has elapsed, using a fresh
 * price per symbol. An observation with no current price is kept until it exceeds
 * `maxAgeHours`, then dropped — we never invent a realized move.
 */
export function maturePending(
  pending: PendingSample[],
  currentPriceBySymbol: Map<string, number>,
  nowIso: string,
  horizonHours: number,
  options: { maxAgeHours?: number; winThresholdBps?: number } = {},
): MatureResult {
  const maxAgeHours = options.maxAgeHours ?? horizonHours * 4;
  const winThresholdBps = options.winThresholdBps ?? 0;
  const nowMs = Date.parse(nowIso);
  const matured: CalibrationSample[] = [];
  const remaining: PendingSample[] = [];

  for (const p of pending) {
    const ageHours = (nowMs - Date.parse(p.scoredAtIso)) / 3_600_000;
    if (!Number.isFinite(ageHours) || ageHours < horizonHours) {
      remaining.push(p);
      continue;
    }
    const current = currentPriceBySymbol.get(p.symbol);
    if (current === undefined || !(current > 0) || !(p.priceAtScore > 0)) {
      if (ageHours <= maxAgeHours) remaining.push(p);
      continue;
    }
    const realizedMoveBps = ((current - p.priceAtScore) / p.priceAtScore) * 10_000;
    matured.push({
      score: p.score,
      realizedMoveBps: Number(realizedMoveBps.toFixed(2)),
      win: realizedMoveBps > winThresholdBps,
      family: p.family,
      symbol: p.symbol,
      scoredAtIso: p.scoredAtIso,
      horizonHours,
    });
  }

  return { matured, remaining };
}
