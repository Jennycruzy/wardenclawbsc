/**
 * Relative-Strength Continuation entry — catches strength BEFORE it is crowded,
 * independent of the trending list.
 *
 * Trigger: the token outperforms the market benchmark (BNB or an eligible-majors
 * composite) by ≥ rsOutperformMinBps on TWO consecutive decision checks, with
 * volume rising across those checks. The regime gate (not RED) is enforced by the
 * caller (risk constitution); this is the pure RS structure.
 */

import { RejectCode } from "./types.js";
import type { SignalObservation } from "./signalHistory.js";

export interface RsContinuationConfig {
  /** Required outperformance vs the benchmark, in bps (24h change difference). */
  rsOutperformMinBps: number;
}

export interface RsContinuationResult {
  pass: boolean;
  rejectCode?: RejectCode;
  /** How many of the last two checks cleared the outperformance bar. */
  outperformChecks: number;
  reasons: string[];
}

export function evaluateRsContinuation(
  obs: SignalObservation[],
  cfg: RsContinuationConfig,
): RsContinuationResult {
  if (obs.length < 2) {
    return { pass: false, rejectCode: RejectCode.RS_NOT_CONFIRMED, outperformChecks: 0, reasons: ["need two consecutive checks"] };
  }
  const last2 = obs.slice(-2);
  const reasons: string[] = [];

  let outperformChecks = 0;
  for (const o of last2) {
    if (o.benchmarkChange24hPct === undefined) {
      reasons.push("missing benchmark change — cannot confirm relative strength");
      continue;
    }
    const outperformBps = (o.change24hPct - o.benchmarkChange24hPct) * 100;
    if (outperformBps >= cfg.rsOutperformMinBps) {
      outperformChecks++;
      reasons.push(`outperformed by ${outperformBps.toFixed(0)}bps`);
    } else {
      reasons.push(`outperformed only ${outperformBps.toFixed(0)}bps (need ≥${cfg.rsOutperformMinBps})`);
    }
  }

  // Volume must be rising across the two checks.
  const volumeRising = last2[1]!.volume24hUsd > last2[0]!.volume24hUsd;
  reasons.push(volumeRising ? "volume rising" : "volume not rising");

  const pass = outperformChecks === 2 && volumeRising;
  return {
    pass,
    rejectCode: pass ? undefined : RejectCode.RS_NOT_CONFIRMED,
    outperformChecks,
    reasons,
  };
}
