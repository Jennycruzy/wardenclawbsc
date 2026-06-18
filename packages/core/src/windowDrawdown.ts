/**
 * Whole-competition-window marked-to-market drawdown anchor.
 *
 * This is intentionally separate from the scored/realized book. Open positions
 * must affect the 30% safety metric immediately; waiting until an exit realizes
 * the loss leaves the governor blind while risk is still live.
 */

import { z } from "zod";

export interface WindowDrawdownAnchor {
  windowStartIso: string;
  peakValueUsd: number;
}

const schema = z.object({
  windowStartIso: z.string(),
  peakValueUsd: z.number(),
});

export interface WindowDrawdownResult {
  anchor: WindowDrawdownAnchor;
  windowDrawdownPct: number;
}

export function updateWindowDrawdown(
  anchor: WindowDrawdownAnchor | undefined,
  markedValueUsd: number,
  windowStartIso: string,
): WindowDrawdownResult {
  if (!anchor || anchor.windowStartIso !== windowStartIso) {
    return {
      anchor: { windowStartIso, peakValueUsd: markedValueUsd },
      windowDrawdownPct: 0,
    };
  }
  const peakValueUsd = Math.max(anchor.peakValueUsd, markedValueUsd);
  const windowDrawdownPct =
    peakValueUsd > 0
      ? Math.max(0, ((peakValueUsd - markedValueUsd) / peakValueUsd) * 100)
      : 0;
  return {
    anchor: { windowStartIso, peakValueUsd },
    windowDrawdownPct,
  };
}

export function serializeWindowDrawdownAnchor(anchor: WindowDrawdownAnchor): string {
  return JSON.stringify(schema.parse(anchor));
}

export function parseWindowDrawdownAnchor(raw: string): WindowDrawdownAnchor {
  return schema.parse(JSON.parse(raw));
}
