/**
 * Forward calibration-sample collector — maturation pass.
 *
 * The worker (with CALIBRATION_COLLECT_ENABLED=true) records each scored candidate
 * as a pending observation in data/calibration/pending-samples.json. This script
 * matures those observations: once an observation is older than the holding
 * horizon, it measures the realized move against a FRESH CMC quote and appends a
 * real { score, realizedMoveBps, win } sample to data/calibration/samples.json,
 * which `pnpm calibrate:edge` consumes. It never fabricates a move — observations
 * with no fresh price are carried forward and eventually aged out.
 *
 *   pnpm collect:calibration
 *
 * Env: CALIBRATION_HORIZON_HOURS (default 24), CALIBRATION_SAMPLES_PATH,
 * CALIBRATION_PENDING_PATH. Run it on a schedule (cron/pm2) a few times a day.
 */

import "dotenv/config";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CmcClient } from "@wardenclaw/cmc-adapter";
import { maturePending, type CalibrationSample, type PendingSample } from "@wardenclaw/core";

const DIR = join(process.cwd(), "data", "calibration");
const PENDING_PATH = process.env.CALIBRATION_PENDING_PATH ?? join(DIR, "pending-samples.json");
const SAMPLES_PATH = process.env.CALIBRATION_SAMPLES_PATH ?? join(DIR, "samples.json");
const HORIZON_HOURS = Number(process.env.CALIBRATION_HORIZON_HOURS ?? "24");

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function main(): Promise<void> {
  const pending = readJson<PendingSample[]>(PENDING_PATH, []);
  if (pending.length === 0) {
    console.log(`No pending observations at ${PENDING_PATH}. Run the worker with CALIBRATION_COLLECT_ENABLED=true to accumulate them.`);
    return;
  }
  if (!process.env.CMC_API_KEY) {
    console.error("✗ CMC_API_KEY required to measure realized moves (real prices, never fabricated).");
    process.exit(1);
    return;
  }

  // Only the observations old enough to mature need a fresh price; fetch quotes
  // for exactly those symbols to keep CMC credit usage minimal.
  const nowMs = Date.now();
  const dueSymbols = [
    ...new Set(
      pending
        .filter((p) => (nowMs - Date.parse(p.scoredAtIso)) / 3_600_000 >= HORIZON_HOURS)
        .map((p) => p.symbol),
    ),
  ];

  const priceBySymbol = new Map<string, number>();
  if (dueSymbols.length > 0) {
    const cmc = new CmcClient();
    for (const batch of chunk(dueSymbols, 50)) {
      try {
        const sig = await cmc.getQuotes(batch);
        for (const q of sig.data) priceBySymbol.set(q.symbol, q.priceUsd);
      } catch (err) {
        console.warn(`  quote fetch failed for ${batch.length} symbol(s), retried next run: ${(err as Error).message}`);
      }
    }
  }

  const { matured, remaining } = maturePending(pending, priceBySymbol, new Date().toISOString(), HORIZON_HOURS);

  const existing = readJson<CalibrationSample[]>(SAMPLES_PATH, []);
  const all = [...existing, ...matured];

  mkdirSync(DIR, { recursive: true });
  writeFileSync(SAMPLES_PATH, JSON.stringify(all, null, 2) + "\n", "utf8");
  writeFileSync(PENDING_PATH, JSON.stringify(remaining, null, 2) + "\n", "utf8");

  console.log(
    `✓ Matured ${matured.length} new sample(s) (horizon ${HORIZON_HOURS}h). ` +
      `${remaining.length} still pending · ${all.length} total samples in ${SAMPLES_PATH}.`,
  );
  if (all.length > 0) {
    const wins = all.filter((s) => s.win).length;
    console.log(`  Sample hit rate so far: ${((wins / all.length) * 100).toFixed(1)}% · run \`pnpm calibrate:edge\` once enough have accumulated.`);
  }
}

main().catch((err) => {
  console.error(`✗ collect:calibration failed: ${(err as Error).message}`);
  process.exit(1);
});
