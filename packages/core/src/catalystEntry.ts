/**
 * Catalyst entry quality — uncrowd the catalyst family.
 *
 * CMC trending RANK LEVEL is a crowded, lagging signal: by the time a token tops
 * trending the move is half-spent and rank-level buyers are exit liquidity. A
 * catalyst entry must clear THREE deterministic checks (all required):
 *
 *   1. Trending DELTA, not level — rank rising fast (≥ trendingDeltaMin places) or
 *      freshly entering the top-N. A token parked at #1 for hours scores LOWER.
 *   2. Fresh volume expansion — 24h volume ≥ volumeExpansionMin × its own recent
 *      baseline. Price moving without volume is no entry.
 *   3. No first spike — never buy the initial vertical. Require a post-spike
 *      consolidation that holds above a retracement floor for spikeCooldownChecks,
 *      then enter on continuation (reclaiming the consolidation high).
 *
 * The LLM touches none of this; it is pure math over the token's recent history.
 */

import { RejectCode } from "./types.js";
import type { SignalObservation } from "./signalHistory.js";

export interface CatalystEntryConfig {
  /** Rank places of improvement required since the prior check. */
  trendingDeltaMin: number;
  /** Rank ≤ this counts as "in the top-N" for a fresh-entry pass. */
  trendingTopN: number;
  /** 24h volume must be ≥ this × the recent baseline. */
  volumeExpansionMin: number;
  /** Consecutive post-peak checks of consolidation required before a continuation entry. */
  spikeCooldownChecks: number;
  /** Max fraction of the spike a pullback may retrace and still be a valid base. */
  maxRetracePct: number;
  /** A run-up ≥ this fraction counts as a "spike" worth the no-first-spike guard. */
  spikeMinPct: number;
}

export interface CatalystEntryResult {
  pass: boolean;
  rejectCode?: RejectCode;
  trendingDeltaOk: boolean;
  volumeExpansionOk: boolean;
  firstSpikeOk: boolean;
  reasons: string[];
}

/** Trending must be IMPROVING fast, or freshly in the top-N — never just "high". */
function trendingDelta(obs: SignalObservation[], cfg: CatalystEntryConfig): { ok: boolean; reason: string } {
  const curr = obs[obs.length - 1];
  const prev = obs[obs.length - 2];
  const currRank = curr?.trendingRank;
  if (currRank === undefined) return { ok: false, reason: "not on the trending list" };
  const prevRank = prev?.trendingRank;
  if (prevRank === undefined) {
    return currRank <= cfg.trendingTopN
      ? { ok: true, reason: `freshly entered top-${cfg.trendingTopN} at #${currRank}` }
      : { ok: false, reason: `entered the list at #${currRank}, outside top-${cfg.trendingTopN}` };
  }
  const improvedBy = prevRank - currRank; // positive = climbed
  return improvedBy >= cfg.trendingDeltaMin
    ? { ok: true, reason: `rank rose ${improvedBy} (#${prevRank}→#${currRank})` }
    : { ok: false, reason: `rank stale: moved ${improvedBy} (#${prevRank}→#${currRank}), need ≥${cfg.trendingDeltaMin}` };
}

/** Volume must expand off the token's own recent baseline. */
function volumeExpansion(obs: SignalObservation[], cfg: CatalystEntryConfig): { ok: boolean; reason: string } {
  const curr = obs[obs.length - 1]!;
  const prior = obs.slice(0, -1);
  if (prior.length === 0) return { ok: false, reason: "no baseline volume yet" };
  const baseline = prior.reduce((s, o) => s + o.volume24hUsd, 0) / prior.length;
  if (baseline <= 0) return { ok: false, reason: "baseline volume is zero" };
  const ratio = curr.volume24hUsd / baseline;
  return ratio >= cfg.volumeExpansionMin
    ? { ok: true, reason: `volume ${ratio.toFixed(2)}× baseline` }
    : { ok: false, reason: `volume only ${ratio.toFixed(2)}× baseline, need ≥${cfg.volumeExpansionMin}×` };
}

/**
 * No-first-spike: if a recent run-up qualifies as a spike, require a consolidation
 * that held above the retracement floor for spikeCooldownChecks, then a
 * continuation (current price reclaims/exceeds the consolidation high). If there
 * was no spike at all, a normal entry is fine.
 */
function noFirstSpike(obs: SignalObservation[], cfg: CatalystEntryConfig): { ok: boolean; reason: string } {
  const prices = obs.map((o) => o.price);
  const n = prices.length;
  if (n < 2) return { ok: true, reason: "insufficient history — no spike detected" };
  const current = prices[n - 1]!;

  // Find the FIRST spike peak: the first local top reached after a run-up of at
  // least spikeMinPct off the running base, identified by the first pullback.
  let firstPeakIdx = -1;
  for (let i = 1; i < n; i++) {
    if (prices[i]! < prices[i - 1]!) {
      const runUp = (prices[i - 1]! - runBaseUpTo(prices, i - 1)) / runBaseUpTo(prices, i - 1);
      if (runUp >= cfg.spikeMinPct) {
        firstPeakIdx = i - 1;
        break;
      }
    }
  }

  if (firstPeakIdx === -1) {
    // No pullback yet. Monotonic? If the total run-up is a parabola, it is still
    // going vertical — never buy that. Otherwise there is simply no spike.
    const totalRunUp = (Math.max(...prices) - Math.min(...prices)) / Math.min(...prices);
    return totalRunUp >= cfg.spikeMinPct
      ? { ok: false, reason: `first spike: still vertical (+${(totalRunUp * 100).toFixed(1)}%), no pullback yet` }
      : { ok: true, reason: `no parabola (run-up ${(totalRunUp * 100).toFixed(1)}%) — normal entry` };
  }

  const spikeHigh = prices[firstPeakIdx]!;
  const base = runBaseUpTo(prices, firstPeakIdx);
  const checksSincePeak = n - 1 - firstPeakIdx;
  if (checksSincePeak < cfg.spikeCooldownChecks) {
    return { ok: false, reason: `first spike: only ${checksSincePeak} check(s) since the peak, need ${cfg.spikeCooldownChecks} of cooldown` };
  }
  const baseRegion = prices.slice(firstPeakIdx + 1); // after the spike peak, through current
  const retraceFloor = spikeHigh - cfg.maxRetracePct * (spikeHigh - base);
  if (!baseRegion.every((p) => p >= retraceFloor)) {
    return { ok: false, reason: `broke the ${(cfg.maxRetracePct * 100).toFixed(0)}% retracement floor (${retraceFloor.toFixed(4)})` };
  }
  // Continuation: reclaim/exceed the consolidation (base-region) high, excluding current.
  const baseHigh = Math.max(...baseRegion.slice(0, -1));
  if (current < baseHigh) {
    return { ok: false, reason: `no continuation yet: ${current.toFixed(4)} < consolidation high ${baseHigh.toFixed(4)}` };
  }
  return { ok: true, reason: `post-spike continuation: reclaimed ${baseHigh.toFixed(4)} after a ${checksSincePeak}-check base` };
}

/** Lowest price from the series start up to and including index i. */
function runBaseUpTo(prices: number[], i: number): number {
  let m = prices[0]!;
  for (let k = 1; k <= i; k++) m = Math.min(m, prices[k]!);
  return m;
}

export function evaluateCatalystEntry(
  obs: SignalObservation[],
  cfg: CatalystEntryConfig,
): CatalystEntryResult {
  const trend = trendingDelta(obs, cfg);
  const vol = volumeExpansion(obs, cfg);
  const spike = noFirstSpike(obs, cfg);
  const reasons = [trend.reason, vol.reason, spike.reason];

  let rejectCode: RejectCode | undefined;
  if (!trend.ok) rejectCode = RejectCode.TRENDING_STALE;
  else if (!vol.ok) rejectCode = RejectCode.NO_VOLUME_EXPANSION;
  else if (!spike.ok) rejectCode = RejectCode.FIRST_SPIKE;

  return {
    pass: trend.ok && vol.ok && spike.ok,
    rejectCode,
    trendingDeltaOk: trend.ok,
    volumeExpansionOk: vol.ok,
    firstSpikeOk: spike.ok,
    reasons,
  };
}
