import { COMPETITION } from "./config.js";
import type { HourlySnapshot } from "./hourlySnapshot.js";

export function isInCompetitionWindow(
  iso: string,
  startIso = COMPETITION.tradingWindow.startUtc,
  endIso = COMPETITION.tradingWindow.endUtc,
): boolean {
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) && timestamp >= Date.parse(startIso) && timestamp <= Date.parse(endIso);
}

/** Keep one value per scoring hour and discard rehearsal/preflight snapshots. */
export function competitionSnapshots(
  snapshots: HourlySnapshot[],
  startIso = COMPETITION.tradingWindow.startUtc,
  endIso = COMPETITION.tradingWindow.endUtc,
): HourlySnapshot[] {
  const byHour = new Map<string, HourlySnapshot>();
  for (const snapshot of snapshots) {
    if (isInCompetitionWindow(snapshot.hourIso, startIso, endIso)) {
      byHour.set(snapshot.hourIso, snapshot);
    }
  }
  return [...byHour.values()].sort((a, b) => Date.parse(a.hourIso) - Date.parse(b.hourIso));
}

export function returnFromStartingCapital(latestValueUsd: number, startingCapitalUsd: number): number {
  if (startingCapitalUsd <= 0) return 0;
  return ((latestValueUsd - startingCapitalUsd) / startingCapitalUsd) * 100;
}
