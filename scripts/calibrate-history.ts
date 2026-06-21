/**
 * Replay the production score over non-overlapping daily CMC observations.
 * Catalyst is excluded because historical trending ranks are unavailable.
 */

import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { STARTER_MAJORS } from "@wardenclaw/bsc-adapter";
import { buildMomentumInputs, buildRsContinuationInputs } from "@wardenclaw/cmc-adapter";
import { buildCalibrationReport, scoreBsc, type CalibrationSample } from "@wardenclaw/core";

interface Point {
  timestamp: string;
  price: number;
  change1h: number;
  change24h: number;
  volume24h: number;
  marketCap: number;
}

const API = (process.env.CMC_API_URL ?? "https://pro-api.coinmarketcap.com").replace(/\/$/, "");
const KEY = process.env.CMC_API_KEY;
const DAYS = Number(process.env.CALIBRATION_HISTORY_DAYS ?? "30");
const SAMPLE_OUT = process.env.CALIBRATION_HISTORY_SAMPLES_PATH ?? "data/calibration/history-samples.json";
const REPORT_OUT = process.env.CALIBRATION_HISTORY_REPORT_PATH ?? "data/calibration/history-report.json";
const DIAGNOSTICS_OUT =
  process.env.CALIBRATION_HISTORY_DIAGNOSTICS_PATH ?? "data/calibration/history-diagnostics.json";
const THRESHOLDS = (process.env.CALIBRATION_SCORE_THRESHOLDS ?? "50,55,60,65,70,75,80")
  .split(",")
  .map(Number)
  .filter(Number.isFinite)
  .sort((a, b) => a - b);

const day = (iso: string): string => iso.slice(0, 10);

async function get(path: string): Promise<unknown> {
  if (!KEY) throw new Error("CMC_API_KEY is required.");
  const response = await fetch(`${API}${path}`, {
    headers: { "X-CMC_PRO_API_KEY": KEY, Accept: "application/json" },
  });
  const body = (await response.json()) as {
    status?: { error_code?: number | string; error_message?: string | null };
  };
  if (!response.ok || Number(body.status?.error_code ?? 0) !== 0) {
    throw new Error(`CMC HTTP ${response.status}: ${body.status?.error_message ?? "unknown error"}`);
  }
  return body;
}

async function quotes(cmcId: number): Promise<Point[]> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - (DAYS + 3) * 86_400;
  const body = (await get(
    `/v2/cryptocurrency/quotes/historical?id=${cmcId}&interval=24h&time_start=${start}&time_end=${end}`,
  )) as {
    data?: {
      quotes?: Array<{
        timestamp?: string;
        quote?: {
          USD?: {
            timestamp?: string;
            price?: number;
            percent_change_1h?: number;
            percent_change_24h?: number;
            volume_24h?: number;
            market_cap?: number;
          };
        };
      }>;
    };
  };
  return (body.data?.quotes ?? []).flatMap((row) => {
    const usd = row.quote?.USD;
    const timestamp = row.timestamp ?? usd?.timestamp;
    if (
      !timestamp ||
      !Number.isFinite(usd?.price) ||
      !Number.isFinite(usd?.percent_change_1h) ||
      !Number.isFinite(usd?.percent_change_24h) ||
      !Number.isFinite(usd?.volume_24h)
    ) return [];
    return [{
      timestamp,
      price: usd!.price!,
      change1h: usd!.percent_change_1h!,
      change24h: usd!.percent_change_24h!,
      volume24h: usd!.volume_24h!,
      marketCap: usd!.market_cap ?? 0,
    }];
  });
}

async function fearGreed(): Promise<Map<string, number>> {
  const body = (await get(`/v3/fear-and-greed/historical?limit=${DAYS + 5}`)) as {
    data?: Array<{ timestamp?: string; value?: number }>;
  };
  return new Map(
    (body.data ?? []).flatMap((row) =>
      row.timestamp && Number.isFinite(row.value)
        ? [[day(new Date(Number(row.timestamp) * 1000).toISOString()), row.value!] as const]
        : [],
    ),
  );
}

function stats(samples: CalibrationSample[]): {
  n: number;
  meanBps: number;
  hitRate: number;
  lower95Bps: number;
} {
  if (samples.length === 0) return { n: 0, meanBps: 0, hitRate: 0, lower95Bps: 0 };
  const moves = samples.map((sample) => sample.realizedMoveBps);
  const mean = moves.reduce((sum, move) => sum + move, 0) / moves.length;
  const variance = moves.length > 1
    ? moves.reduce((sum, move) => sum + (move - mean) ** 2, 0) / (moves.length - 1)
    : 0;
  return {
    n: moves.length,
    meanBps: Number(mean.toFixed(2)),
    hitRate: Number((moves.filter((move) => move > 0).length / moves.length).toFixed(4)),
    lower95Bps: Number((mean - 1.96 * Math.sqrt(variance / moves.length)).toFixed(2)),
  };
}

function thresholdDiagnostics(samples: CalibrationSample[]): unknown[] {
  const dates = [...new Set(samples.map((sample) => sample.scoredAtIso!).sort())];
  const split = dates[Math.max(1, Math.floor(dates.length * 0.7))]!;
  const train = samples.filter((sample) => sample.scoredAtIso! < split);
  const validation = samples.filter((sample) => sample.scoredAtIso! >= split);
  return THRESHOLDS.map((minScore) => ({
    minScore,
    train: stats(train.filter((sample) => sample.score >= minScore)),
    validation: stats(validation.filter((sample) => sample.score >= minScore)),
  }));
}

async function main(): Promise<void> {
  const majors = STARTER_MAJORS.slice(0, 6);
  const [fear, bnb, ...tokenSeries] = await Promise.all([
    fearGreed(),
    quotes(1839),
    ...majors.map((token) => quotes(token.cmcId!)),
  ]);
  const bnbByDay = new Map(bnb.map((point) => [day(point.timestamp), point]));
  const samples: CalibrationSample[] = [];

  for (let tokenIndex = 0; tokenIndex < majors.length; tokenIndex++) {
    const token = majors[tokenIndex]!;
    const points = tokenSeries[tokenIndex]!;
    for (let i = 0; i < points.length - 1; i++) {
      const point = points[i]!;
      const future = points[i + 1]!;
      const date = day(point.timestamp);
      const benchmark = bnbByDay.get(date);
      const fearValue = fear.get(date);
      if (!benchmark || fearValue === undefined || day(future.timestamp) === date) continue;
      const quote = {
        symbol: token.symbol,
        priceUsd: point.price,
        percentChange1h: point.change1h,
        percentChange24h: point.change24h,
        volume24hUsd: point.volume24h,
        marketCapUsd: point.marketCap,
        lastUpdated: point.timestamp,
      };
      const sentiment = {
        value: fearValue,
        classification: "historical",
        lastUpdated: point.timestamp,
      };
      const move = ((future.price - point.price) / point.price) * 10_000;
      const add = (family: "momentum" | "rs_continuation", score: number): void => {
        samples.push({
          symbol: token.symbol,
          family,
          score,
          scoredAtIso: point.timestamp,
          horizonHours: 24,
          realizedMoveBps: Number(move.toFixed(2)),
          win: move > 0,
        });
      };
      add("momentum", scoreBsc(buildMomentumInputs(quote, benchmark.change24h, sentiment, 0.7).inputs));
      if (point.change24h > benchmark.change24h) {
        add("rs_continuation", scoreBsc(buildRsContinuationInputs(quote, benchmark.change24h, sentiment, 0.7).inputs));
      }
    }
  }

  samples.sort((a, b) =>
    a.scoredAtIso!.localeCompare(b.scoredAtIso!) ||
    a.symbol!.localeCompare(b.symbol!) ||
    a.family!.localeCompare(b.family!),
  );
  const generatedAt = new Date().toISOString();
  const report = buildCalibrationReport(samples, THRESHOLDS, {
    version: `historical-${generatedAt.slice(0, 10)}`,
    generatedAt,
    historyDays: DAYS,
  });
  const diagnostics = thresholdDiagnostics(samples);

  for (const path of [SAMPLE_OUT, REPORT_OUT, DIAGNOSTICS_OUT]) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(SAMPLE_OUT, `${JSON.stringify(samples, null, 2)}\n`, "utf8");
  writeFileSync(REPORT_OUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(DIAGNOSTICS_OUT, `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");

  console.log(`✓ ${samples.length} non-overlapping 24h samples`);
  console.log(`  ${samples[0]?.scoredAtIso ?? "none"} → ${samples.at(-1)?.scoredAtIso ?? "none"}`);
  console.table(diagnostics);
}

main().catch((error) => {
  console.error(`✗ historical calibration failed: ${(error as Error).message}`);
  process.exit(1);
});
