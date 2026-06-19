/**
 * wardenclaw-doctrine — skill backtest runner.
 *
 * Replays the strategy spec (strategy-spec.md) using ONLY defaults.json — never the
 * private calibrated runtime config — and emits the five signal kinds (validating against
 * signals.schema.json) plus friction-honest per-family statistics.
 *
 * SPEC-ONLY. This runner imports pure strategy functions from @wardenclaw/core read-only.
 * It constructs and signs NOTHING: no orders, wallets, routers, or transactions.
 *
 * Data modes:
 *   - Default (demo): a documented synthetic fixture that exercises every family, regime,
 *     and week-state so the backtest runs in two commands with no API key. Signals and
 *     stats from this mode are clearly labeled data_source="documented-synthetic-fixture"
 *     and are NOT presented as real-market performance evidence.
 *   - Real (SKILL_BACKTEST_REAL=1 + CMC_API_KEY): replays ~30 days of real CMC daily OHLCV
 *     history. Fails loudly without a key. Its outputs are the panel's real evidence.
 *
 * Economics (friction = gas + slippage + LP fee + simulated scoring cost, the net-edge gate,
 * and volatility-stop coherence) come from the repo's own backtester so results match the
 * scored economics the live agent runs.
 *
 *   pnpm skill:backtest
 */

import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runBacktest,
  type Bar,
  computeFriction,
  evaluateNetEdge,
  evaluateGovernor,
  evaluateStopCoherence,
  evaluateRegime,
  initRegimeState,
  type RegimeSignals,
  type RegimeConfig,
  type RegimeState,
  evaluateCatalystEntry,
  type CatalystEntryConfig,
  evaluateRsContinuation,
  scoreBsc,
  type BscScoreInputs,
  evaluateWeekBudget,
  type WeekBudgetConfig,
  type WeekBudgetState,
  initTrailingStop,
  updateTrailingStop,
  isStopBreached,
  exitReasonFor,
  type SignalObservation,
} from "@wardenclaw/core";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = dirname(HERE);
const RESULTS_DIR = process.env.SKILL_BACKTEST_OUTPUT_DIR ?? join(HERE, "results");
const EXAMPLES_PATH =
  process.env.SKILL_BACKTEST_EXAMPLES_PATH ?? join(SKILL_DIR, "examples", "example-signals.jsonl");

// ── Load PUBLIC defaults (never the private runtime config) ──────────────────
interface Defaults {
  regime: Record<string, number>;
  entry_catalyst: Record<string, number>;
  entry_rs_continuation: Record<string, number | boolean>;
  net_edge: Record<string, number>;
  sizing: Record<string, number>;
  exits: Record<string, number>;
  week_state: Record<string, number>;
  expected_move_reference_prior: { scoreFloor: number; bpsPerScorePoint: number };
}
const defaults = JSON.parse(readFileSync(join(SKILL_DIR, "defaults.json"), "utf8")) as Defaults;

/** Naive reference prior: score → expected move (bps). NOT a calibrated mapping. */
function expectedMoveBps(score: number): number {
  const p = defaults.expected_move_reference_prior;
  return Math.max(0, (score - p.scoreFloor) * p.bpsPerScorePoint);
}

const regimeConfig: RegimeConfig = {
  redBenchmarkPct: defaults.regime.redBenchmarkPct!,
  greenBenchmarkPct: defaults.regime.greenBenchmarkPct!,
  redFearGreed: defaults.regime.redFearGreed!,
  greenFearGreed: defaults.regime.greenFearGreed!,
  redBreadth: defaults.regime.redBreadth!,
  greenBreadth: defaults.regime.greenBreadth!,
  hysteresisChecks: defaults.regime.hysteresisChecks!,
  highVolatilityRatio: defaults.regime.highVolatilityRatio!,
};
const catalystConfig: CatalystEntryConfig = {
  trendingDeltaMin: defaults.entry_catalyst.trendingDeltaMin!,
  trendingTopN: defaults.entry_catalyst.trendingTopN!,
  volumeExpansionMin: defaults.entry_catalyst.volumeExpansionMin!,
  spikeCooldownChecks: defaults.entry_catalyst.spikeCooldownChecks!,
  maxRetracePct: defaults.entry_catalyst.maxRetracePct!,
  spikeMinPct: defaults.entry_catalyst.spikeMinPct!,
};
const weekConfig: WeekBudgetConfig = {
  weeklyLegBudget: defaults.week_state.weeklyLegBudget!,
  flatBandLoPct: defaults.week_state.flatBandLoPct!,
  flatBandHiPct: defaults.week_state.flatBandHiPct!,
  defendTriggerPct: defaults.week_state.defendTriggerPct!,
  huntMinScore: defaults.week_state.huntMinScore!,
  pressMinScore: defaults.week_state.pressMinScore!,
  defendMinScore: defaults.week_state.defendMinScore!,
  netEdgeDefendBonusBps: defaults.week_state.netEdgeDefendBonusBps!,
  pressStartDay: defaults.week_state.pressStartDay!,
  reservedLegsPerDay: defaults.week_state.reservedLegsPerDay!,
  weekLengthDays: defaults.week_state.weekLengthDays!,
};

const SCHEMA_VERSION = "1.0.0";
type Mode = "backtest";
const DATA_SOURCE_FIXTURE = "documented-synthetic-fixture";

// ── Signal emission (validates against signals.schema.json) ──────────────────
const signals: object[] = [];
function emit(sig: object): void {
  signals.push(sig);
}
function base(ts: string, dataSource: string): { schema_version: string; ts: string; mode: Mode; data_source: string } {
  return { schema_version: SCHEMA_VERSION, ts, mode: "backtest", data_source: dataSource };
}

// ── Friction-honest per-family economics via the repo backtester ─────────────
function familyBacktest(bars: Bar[], minScore: number, scoreForBar: (b: Bar, i: number) => number) {
  const signalFn = (bar: Bar, index: number, hasPosition: boolean) => {
    if (hasPosition || index < 6) return null;
    const score = scoreForBar(bar, index);
    if (score < minScore) return null;
    return { score, expectedMoveBps: expectedMoveBps(score) };
  };
  return runBacktest(bars, signalFn, {
    startingCapitalUsd: 40,
    perTradeRiskPct: defaults.sizing.perTradeRiskPct!,
    stopAtrMultiple: defaults.exits.stopAtrMultiple!,
    maxPositionPct: defaults.sizing.maxPositionPct!,
    netEdgeMinBps: defaults.net_edge.netEdgeMinBps!,
    frictionBudgetBps: defaults.net_edge.frictionBudgetBps!,
    scoringSimCostBps: defaults.net_edge.scoringSimCostBps!,
    gasPerLegUsd: 0.02,
    slippageBps: 8,
    lpFeeBps: 25,
    safetyBufferBps: 5,
  });
}

// ── Documented synthetic fixture ─────────────────────────────────────────────
// A deterministic scenario engineered to exercise every doctrine branch. The price
// numbers are NOT real market data; they are a documented fixture for schema-validity and
// a runnable demo, never performance evidence (see METHODOLOGY.md).
function iso(dayOffset: number): string {
  return new Date(Date.UTC(2026, 4, 1 + dayOffset)).toISOString();
}

/**
 * A breakout token. Indices 0..9 are the ENTRY window: gentle base, a vertical first spike,
 * a pullback that holds the retracement floor, then a continuation that reclaims the
 * consolidation high — with the trending rank jumping >= trendingDeltaMin on the final check
 * and a fresh volume expansion. Indices 10..11 are the post-entry pullback that the trailing
 * ratchet (§7) exits on. Prices are a documented fixture, not real market data.
 */
function catalystEpisode(): { bars: Bar[]; obs: SignalObservation[] } {
  const bars: Bar[] = [];
  const obs: SignalObservation[] = [];
  const prices = [1.0, 1.01, 1.02, 1.18, 1.16, 1.15, 1.17, 1.22, 1.3, 1.38, 1.34, 1.26];
  const ranks = [40, 36, 32, 28, 24, 21, 18, 16, 10, 4, 6, 12];
  for (let i = 0; i < prices.length; i++) {
    // Modest volume through the base, a fresh expansion on the continuation bar (idx 9).
    const vol = i < 9 ? 1_000_000 + i * 30_000 : 3_000_000;
    bars.push({ time: iso(i), price: prices[i]!, atrPct: 0.05 });
    obs.push({
      checkIso: iso(i),
      price: prices[i]!,
      volume24hUsd: vol,
      change24hPct: i === 0 ? 0 : ((prices[i]! - prices[i - 1]!) / prices[i - 1]!) * 100,
      benchmarkChange24hPct: 1.0,
      trendingRank: ranks[i]!,
    });
  }
  return { bars, obs };
}

/** A relative-strength leader: outperforms the benchmark on consecutive checks, volume rising. */
function rsEpisode(): { bars: Bar[]; obs: SignalObservation[] } {
  const bars: Bar[] = [];
  const obs: SignalObservation[] = [];
  let price = 1.0;
  let vol = 1_200_000;
  for (let i = 0; i < 10; i++) {
    const step = i < 2 ? 0.005 : 0.03; // outperformance kicks in
    price = price * (1 + step);
    vol = vol * 1.05;
    bars.push({ time: iso(i), price, atrPct: 0.04 });
    obs.push({
      checkIso: iso(i),
      price,
      volume24hUsd: vol,
      change24hPct: step * 100,
      benchmarkChange24hPct: 0.6, // token clears it by > rsOutperformMinBps after warmup
    });
  }
  return { bars, obs };
}

/** Momentum rotation: chop, a sustained run, a pullback (regime GREEN). */
function momentumEpisode(): Bar[] {
  const bars: Bar[] = [];
  let price = 1.0;
  for (let i = 0; i < 40; i++) {
    const phase = i < 10 ? 0 : i < 28 ? 0.012 : -0.006;
    const wiggle = ((i % 5) - 2) * 0.001;
    price = price * (1 + phase + wiggle);
    bars.push({ time: iso(i), price, atrPct: 0.03 });
  }
  return bars;
}

// ── Step the FULL spec to emit signals across regimes, families, week-states ──
function emitFixtureSignals(): void {
  const cat = catalystEpisode();
  const rs = rsEpisode();

  // 1) Regime sweep: a GREEN tape, then a deteriorating RED window (with hysteresis).
  let regimeState: RegimeState = initRegimeState();
  const regimeReads: Array<{ day: number; sig: RegimeSignals }> = [
    { day: 0, sig: greenSignals() },
    { day: 1, sig: greenSignals() },
    { day: 2, sig: redSignals() },
    { day: 3, sig: redSignals() }, // 2nd consecutive → flips RED (hysteresisChecks=2)
    { day: 4, sig: redSignals() },
  ];
  let lastRegime = "NEUTRAL";
  for (const r of regimeReads) {
    const res = evaluateRegime(regimeState, r.sig, regimeConfig);
    regimeState = res.state;
    lastRegime = res.state.current;
    emit({
      ...base(iso(r.day), DATA_SOURCE_FIXTURE),
      kind: "regime_state",
      state: res.state.current,
      raw_regime: res.rawRegime,
      score: res.score,
      pending_count: res.state.pendingCount,
      blocks_entries: res.blocksEntries,
      reasons: [res.reason],
    });
  }

  // 2) Week-state sweep: HUNT early, PRESS when flat & late, DEFEND with a lead.
  const weekScenarios: Array<{ ts: string; st: WeekBudgetState }> = [
    { ts: iso(0), st: { weekElapsedFraction: 0.1, weekReturnPct: 0, legsUsed: 0, drawdownFromPeakPct: 0, pressTradeUsed: false } },
    { ts: iso(5), st: { weekElapsedFraction: 0.8, weekReturnPct: 0.5, legsUsed: 4, drawdownFromPeakPct: 1, pressTradeUsed: false } },
    { ts: iso(6), st: { weekElapsedFraction: 0.95, weekReturnPct: 11, legsUsed: 6, drawdownFromPeakPct: 1, pressTradeUsed: true } },
  ];
  for (const w of weekScenarios) {
    const res = evaluateWeekBudget(w.st, weekConfig);
    emit({
      ...base(w.ts, DATA_SOURCE_FIXTURE),
      kind: "week_state",
      state: res.state,
      minimum_score: res.minimumScore,
      size_multiplier: res.sizeMultiplier,
      net_edge_bonus_bps: res.netEdgeBonusBps,
      tight_trail: res.tightTrail,
      press_trade: res.pressTrade,
      legs_remaining: res.legsRemaining,
      reasons: [res.reason],
    });
  }

  // 3) Entry candidates — one per family, with the real evaluators + net-edge.
  const minScore = weekConfig.huntMinScore;
  // Catalyst — evaluate at the continuation bar (entry window = obs[0..9]); the pullback
  // bars (10..11) are reserved for the trailing-ratchet exit below.
  const catRes = evaluateCatalystEntry(cat.obs.slice(0, 10), catalystConfig);
  const catScore = 84;
  emit(entryCandidate(iso(8), "catalyst", catScore, catRes.pass, true, catRes.rejectCode, catRes.reasons, minScore));
  // RS continuation.
  const rsRes = evaluateRsContinuation(rs.obs, { rsOutperformMinBps: defaults.entry_rs_continuation.rsOutperformMinBps as number });
  const rsScore = 81;
  emit(entryCandidate(iso(8), "rs_continuation", rsScore, rsRes.pass, true, rsRes.rejectCode, rsRes.reasons, minScore));
  // Momentum (regime-gated): show it BLOCKED during the RED window.
  const momScore = 83;
  emit(entryCandidate(iso(4), "momentum", momScore, false, false, "REJECT_REGIME_RED", [`regime ${lastRegime} blocks directional momentum entries`], minScore));

  // 4) Sizing for the catalyst entry (governor + stop coherence).
  emitSizing(iso(8), "CATTKN", catScore);

  // 5) Exits — trail the catalyst position to a ratcheted trail exit.
  emitExits(iso(8), "CATTKN", cat.bars.slice(7));
}

function greenSignals(): RegimeSignals {
  return { benchmarkChange24hPct: 3.5, benchmarkShortChangePct: 0.8, btcChange24hPct: 2.1, benchmarkAboveRecentMean: true, fearGreed: 68, breadthUpFraction: 0.72, volatilityRatio: 0.9 };
}
function redSignals(): RegimeSignals {
  return { benchmarkChange24hPct: -6.0, benchmarkShortChangePct: -1.2, btcChange24hPct: -3.4, benchmarkAboveRecentMean: false, fearGreed: 18, breadthUpFraction: 0.22, volatilityRatio: 1.8 };
}

function entryCandidate(
  ts: string,
  family: "catalyst" | "rs_continuation" | "momentum",
  score: number,
  familyPass: boolean,
  regimeOk: boolean,
  rejectCode: string | undefined,
  reasons: string[],
  minScore: number,
): object {
  const move = expectedMoveBps(score);
  const scoredFriction = defaults.net_edge.scoringSimCostBps! * 2;
  const ne = evaluateNetEdge({ expectedMoveBps: move, scoredFrictionBps: scoredFriction, netEdgeMinBps: defaults.net_edge.netEdgeMinBps! });
  const passed = familyPass && regimeOk && score >= minScore && ne.passed;
  return {
    ...base(ts, DATA_SOURCE_FIXTURE),
    kind: "entry_candidate",
    symbol: family === "catalyst" ? "CATTKN" : family === "rs_continuation" ? "RSTKN" : "MOMTKN",
    family,
    score,
    expected_move_bps: move,
    passed,
    regime_gated_ok: regimeOk,
    reject_code: passed ? null : (rejectCode ?? (regimeOk ? "REJECT_NET_EDGE" : "REJECT_REGIME_RED")),
    net_edge: {
      expected_move_bps: move,
      scored_friction_bps: scoredFriction,
      required_move_bps: ne.requiredMoveBps,
      margin_bps: ne.marginBps,
      passed: ne.passed,
    },
    reasons,
  };
}

function emitSizing(ts: string, symbol: string, score: number): void {
  const atrPct = 0.05;
  const coherence = evaluateStopCoherence({
    portfolioUsd: 40,
    deployableUsd: 40,
    perTradeRiskPct: defaults.sizing.perTradeRiskPct!,
    stopAtrMultiple: defaults.exits.stopAtrMultiple!,
    recentAtrPct: atrPct,
    maxPositionPct: defaults.sizing.maxPositionPct!,
    frictionBudgetBps: defaults.net_edge.frictionBudgetBps!,
    estimateFrictionBps: (n) =>
      computeFriction({ notionalUsd: n, gasInUsd: 0.02, gasOutUsd: 0.02, expectedSlippageBps: 8, lpFeeBps: 25, scoringSimCostBps: defaults.net_edge.scoringSimCostBps!, safetyBufferBps: 5 }).frictionBps,
  });
  // Edge estimate is a reference hit-rate prior derived from the score (NOT calibrated).
  const edgeEstimate = Math.max(0, Math.min(1, (score - 50) / 50));
  const gov = evaluateGovernor({
    state: { windowDrawdownPct: 2, dailyDrawdownPct: 1 },
    competitionDqDrawdownPct: defaults.sizing.competitionDqDrawdownPct!,
    internalWindowDrawdownPct: defaults.sizing.internalWindowDrawdownPct!,
    maxDailyDrawdownPct: defaults.sizing.maxDailyDrawdownPct!,
    kellyFraction: defaults.sizing.kellyFraction!,
    edgeEstimate,
    maxPositionFraction: defaults.sizing.maxPositionPct! / 100,
  });
  emit({
    ...base(ts, DATA_SOURCE_FIXTURE),
    kind: "sizing",
    symbol,
    size_fraction: Number(gov.sizeFraction.toFixed(4)),
    binding_layer: gov.bindingLayer,
    kelly_fraction: defaults.sizing.kellyFraction!,
    edge_estimate: Number(edgeEstimate.toFixed(4)),
    remaining_budget_pct: gov.remainingBudgetPct,
    stop_distance_pct: Number(coherence.stopDistancePct.toFixed(4)),
    position_notional_usd: Number(coherence.positionSizeUsd.toFixed(2)),
    reasons: [coherence.reason, gov.reason],
  });
}

function emitExits(ts0: string, symbol: string, bars: Bar[]): void {
  let st = initTrailingStop({ entryPrice: bars[0]!.price, atrPct: bars[0]!.atrPct, realRoundTripBps: 137, config: {
    stopAtrMultiple: defaults.exits.stopAtrMultiple!,
    breakevenTriggerAtr: defaults.exits.breakevenTriggerAtr!,
    trailAtrMultiple: defaults.exits.trailAtrMultiple!,
    trailTightAtrMultiple: defaults.exits.trailTightAtrMultiple!,
  } });
  const cfg = {
    stopAtrMultiple: defaults.exits.stopAtrMultiple!,
    breakevenTriggerAtr: defaults.exits.breakevenTriggerAtr!,
    trailAtrMultiple: defaults.exits.trailAtrMultiple!,
    trailTightAtrMultiple: defaults.exits.trailTightAtrMultiple!,
  };
  for (let i = 1; i < bars.length; i++) {
    const price = bars[i]!.price;
    st = updateTrailingStop(st, { currentPrice: price, config: cfg });
    const breached = isStopBreached(st, price);
    emit({
      ...base(bars[i]!.time, DATA_SOURCE_FIXTURE),
      kind: "exit_instruction",
      symbol,
      action: breached ? "EXIT" : "HOLD",
      exit_reason: breached ? exitReasonFor(st) : null,
      stop_price: Number(st.stopPrice.toFixed(6)),
      high_water_mark: Number(st.highWaterMark.toFixed(6)),
      breakeven_armed: st.breakevenArmed,
      tight_mode: st.tightMode,
      reasons: [breached ? "price breached the ratcheted stop — forced safety exit" : "holding; trail ratcheted up"],
    });
    if (breached) break;
  }
}

// ── Real CMC history (SKILL_BACKTEST_REAL=1 + CMC_API_KEY) ────────────────────
interface RichBar extends Bar {
  volume24hUsd: number;
  change24hPct: number;
}

/** Read-only fetch of real daily OHLCV history. Never fabricates; fails loudly without a key. */
async function fetchCmcDailyBars(symbol: string, days: number): Promise<RichBar[]> {
  const key = process.env.CMC_API_KEY;
  if (!key) {
    throw new Error(
      "Real backtest requires CMC_API_KEY. This runner never fabricates market data. " +
        "Set CMC_API_KEY (a key with historical OHLCV access) and re-run, or omit SKILL_BACKTEST_REAL to use the documented fixture.",
    );
  }
  const baseUrl = (process.env.CMC_API_URL ?? "https://pro-api.coinmarketcap.com").replace(/\/$/, "");
  const url = `${baseUrl}/v2/cryptocurrency/ohlcv/historical?symbol=${encodeURIComponent(symbol)}&count=${days}&interval=daily&convert=USD`;
  const res = await fetch(url, { headers: { "X-CMC_PRO_API_KEY": key, Accept: "application/json" } });
  if (!res.ok) throw new Error(`CMC OHLCV HTTP ${res.status} for ${symbol} (historical OHLCV requires a paid plan).`);
  const body = (await res.json()) as { data?: any };
  const quotes = (Array.isArray(body.data?.quotes) ? body.data.quotes : body.data?.[symbol]?.[0]?.quotes) as Array<any> | undefined;
  if (!quotes || quotes.length === 0) throw new Error(`CMC returned no historical quotes for ${symbol}.`);
  return quotes.map((q) => {
    const u = q.quote?.USD ?? {};
    const open = Number(u.open ?? u.close ?? 0);
    const close = Number(u.close ?? u.price ?? 0);
    const atrPct = u.high && u.low && close ? Math.max(0.005, (Number(u.high) - Number(u.low)) / close) : 0.03;
    return {
      time: String(q.time_open ?? new Date().toISOString()),
      price: close,
      atrPct,
      volume24hUsd: Number(u.volume ?? 0),
      change24hPct: open > 0 ? ((close - open) / open) * 100 : 0,
    };
  });
}

// ── Aggregate + write ────────────────────────────────────────────────────────
interface FamilyStat {
  family: string;
  evaluable: boolean;
  numTrades: number;
  winRatePct: number;
  avgRealizedMovePct: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  rejections: Record<string, number>;
  note?: string;
}

type BacktestRun = ReturnType<typeof runBacktest>;

function summarizeMany(
  family: string,
  runs: Array<{ symbol: string; run: BacktestRun }>,
  note?: string,
): FamilyStat {
  const trades = runs.flatMap(({ run }) => run.trades);
  const wins = trades.filter((t) => t.exitPrice > t.entryPrice).length;
  const avgMove = trades.length
    ? (trades.reduce((s, t) => s + (t.exitPrice - t.entryPrice) / t.entryPrice, 0) / trades.length) * 100
    : 0;
  const rejections: Record<string, number> = {};
  for (const { run } of runs) {
    for (const [code, count] of Object.entries(run.rejections)) {
      rejections[code] = (rejections[code] ?? 0) + count;
    }
  }
  return {
    family,
    evaluable: true,
    numTrades: trades.length,
    winRatePct: trades.length ? Number(((wins / trades.length) * 100).toFixed(1)) : 0,
    avgRealizedMovePct: Number(avgMove.toFixed(2)),
    totalReturnPct: Number(
      (runs.reduce((sum, { run }) => sum + run.totalReturnPct, 0) / Math.max(1, runs.length)).toFixed(2),
    ),
    maxDrawdownPct: Number(Math.max(0, ...runs.map(({ run }) => run.maxDrawdownPct)).toFixed(2)),
    rejections,
    ...(note ? { note } : {}),
  };
}

function summarize(family: string, r: BacktestRun, note?: string): FamilyStat {
  return summarizeMany(family, [{ symbol: "fixture", run: r }], note);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

/** Per-bar relative-strength gate over real history: token vs benchmark, confirmed + rising volume. */
function realRsScorer(obs: SignalObservation[], cfg: { rsOutperformMinBps: number }) {
  return (_b: Bar, i: number): number => {
    const window = obs.slice(0, i + 1);
    const res = evaluateRsContinuation(window, cfg);
    return res.pass ? 82 : 0;
  };
}

async function main(): Promise<void> {
  const real = process.env.SKILL_BACKTEST_REAL === "1";
  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(dirname(EXAMPLES_PATH), { recursive: true });

  // Always emit the doctrine signals from the documented fixture (schema-validity + demo).
  emitFixtureSignals();
  writeFileSync(EXAMPLES_PATH, signals.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

  const dataSource = real ? "cmc-history" : DATA_SOURCE_FIXTURE;
  const smaScorer = (bars: Bar[]) => (b: Bar, i: number): number => {
    const w = bars.slice(Math.max(0, i - 5), i + 1);
    const sma = w.reduce((s, x) => s + x.price, 0) / w.length;
    return b.price > sma * 1.004 ? 82 : 0;
  };

  let stats: FamilyStat[];
  let equity: Array<{ family: string; symbol: string; time: string; equityUsd: number }>;
  let evidence: Record<string, unknown>;

  if (real) {
    const days = Number(process.env.SKILL_BACKTEST_DAYS ?? 30);
    const benchSym = process.env.SKILL_BACKTEST_BENCHMARK ?? "BNB";
    const symbols = (
      process.env.SKILL_BACKTEST_SYMBOLS ?? "BTC,ETH,SOL,XRP,DOGE,ADA,LINK,AVAX,DOT,LTC,BCH,UNI"
    )
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s && s !== benchSym);
    const bench = await fetchCmcDailyBars(benchSym, days);
    const series = await Promise.all(
      symbols.map(async (symbol) => ({ symbol, bars: await fetchCmcDailyBars(symbol, days) })),
    );
    const rsRuns: Array<{ symbol: string; run: BacktestRun }> = [];
    const momentumRuns: Array<{ symbol: string; run: BacktestRun }> = [];
    equity = [];
    for (const { symbol, bars } of series) {
      const n = Math.min(bars.length, bench.length);
      const aligned = bars.slice(-n);
      const alignedBench = bench.slice(-n);
      const rsObs: SignalObservation[] = aligned.map((bar, i) => ({
        checkIso: bar.time,
        price: bar.price,
        volume24hUsd: bar.volume24hUsd,
        change24hPct: bar.change24hPct,
        benchmarkChange24hPct: alignedBench[i]!.change24hPct,
      }));
      const tokenBars: Bar[] = aligned.map((b) => ({
        time: b.time,
        price: b.price,
        atrPct: b.atrPct,
      }));
      const rsRun = familyBacktest(
        tokenBars,
        weekConfig.huntMinScore,
        realRsScorer(rsObs, {
          rsOutperformMinBps: defaults.entry_rs_continuation.rsOutperformMinBps as number,
        }),
      );
      const momentumRun = familyBacktest(tokenBars, weekConfig.huntMinScore, smaScorer(tokenBars));
      rsRuns.push({ symbol, run: rsRun });
      momentumRuns.push({ symbol, run: momentumRun });
      for (const point of rsRun.equityCurve) {
        equity.push({
          family: "rs_continuation",
          symbol,
          time: point.time,
          equityUsd: Number(point.equityUsd.toFixed(4)),
        });
      }
      for (const point of momentumRun.equityCurve) {
        equity.push({
          family: "momentum",
          symbol,
          time: point.time,
          equityUsd: Number(point.equityUsd.toFixed(4)),
        });
      }
    }
    stats = [
      {
        family: "catalyst",
        evaluable: false,
        numTrades: 0,
        winRatePct: 0,
        avgRealizedMovePct: 0,
        totalReturnPct: 0,
        maxDrawdownPct: 0,
        rejections: {},
        note:
          "not historically evaluable: CMC exposes current trending/gainers surfaces but no dated trending-rank series. " +
          "Using market-cap rank or future-known 30d gainers as a substitute would violate the written strategy. " +
          "The exact catalyst evaluator is exercised only by the labeled fixture until daily CMC rank snapshots exist.",
      },
      summarizeMany(
        "rs_continuation",
        rsRuns,
        `real relative strength across ${symbols.join(", ")} vs ${benchSym}; requested ${days} daily bars per asset`,
      ),
      summarizeMany(
        "momentum",
        momentumRuns,
        `SMA-crossover momentum across ${symbols.join(", ")}; requested ${days} daily bars per asset`,
      ),
    ];
    evidence = {
      requested_days: days,
      benchmark: benchSym,
      universe: symbols.map((symbol, i) => ({
        symbol,
        tier: i < 2 ? "large-cap" : i < 4 ? "liquid-major" : "liquid-alt",
        bars: series.find((x) => x.symbol === symbol)!.bars.length,
      })),
      window_start: series
        .flatMap((x) => x.bars.map((b) => b.time))
        .sort()[0],
      window_end: series
        .flatMap((x) => x.bars.map((b) => b.time))
        .sort()
        .at(-1),
      catalyst_history_available: false,
    };
  } else {
    const momBars = momentumEpisode();
    stats = [
      summarize("catalyst", familyBacktest(catalystEpisode().bars, weekConfig.huntMinScore, () => 84)),
      summarize("rs_continuation", familyBacktest(rsEpisode().bars, weekConfig.huntMinScore, () => 81)),
      summarize("momentum", familyBacktest(momBars, weekConfig.huntMinScore, smaScorer(momBars))),
    ];
    equity = familyBacktest(momBars, weekConfig.huntMinScore, smaScorer(momBars)).equityCurve.map(
      (p) => ({
        family: "momentum",
        symbol: "MOMTKN",
        time: p.time,
        equityUsd: Number(p.equityUsd.toFixed(4)),
      }),
    );
    evidence = { fixture: true };
  }

  const reportCore = {
    skill: "wardenclaw-doctrine",
    mode: "backtest",
    data_source: dataSource,
    is_real_market_evidence: real,
    note: real
      ? "Real CMC daily OHLCV history. Defaults (defaults.json) only; the private calibrated config was not used."
      : "DOCUMENTED SYNTHETIC FIXTURE — runnable demo and schema-validity evidence only, NOT real-market performance. Run with SKILL_BACKTEST_REAL=1 and CMC_API_KEY for real evidence.",
    parameters_source: "defaults.json (public reference defaults)",
    evidence,
    perFamily: stats,
  };
  const report = {
    ...reportCore,
    generatedAt: real ? new Date().toISOString() : iso(0),
    evidence_hash_sha256: canonicalHash(reportCore),
  };

  if (real) {
    writeFileSync(join(RESULTS_DIR, "per-family.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
    writeFileSync(
      join(RESULTS_DIR, "equity-curve.csv"),
      "family,symbol,time,equityUsd\n" +
        equity.map((p) => `${p.family},${p.symbol},${p.time},${p.equityUsd}`).join("\n") +
        "\n",
      "utf8",
    );
    console.log(`[skill:backtest] REAL run written to ${RESULTS_DIR}`);
  } else {
    // Fixture mode: write a clearly-labeled fixture report (NOT into results/ as headline
    // evidence) so the demo is inspectable without masquerading as real performance.
    writeFileSync(join(RESULTS_DIR, "FIXTURE_demo-run.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(`[skill:backtest] FIXTURE demo run (no CMC_API_KEY / SKILL_BACKTEST_REAL unset).`);
    console.log(`[skill:backtest] Wrote labeled fixture report to ${RESULTS_DIR}/FIXTURE_demo-run.json`);
  }
  console.log(`[skill:backtest] Emitted ${signals.length} signals → ${EXAMPLES_PATH}`);
  for (const s of stats) {
    if (!s.evaluable) {
      console.log(`  [${s.family}] not evaluable — ${s.note}`);
      continue;
    }
    console.log(`  [${s.family}] trades=${s.numTrades} win=${s.winRatePct}% avgMove=${s.avgRealizedMovePct}% return=${s.totalReturnPct}% maxDD=${s.maxDrawdownPct}%${s.note ? `  (${s.note})` : ""}`);
  }
}

main().catch((err) => {
  console.error("✗ run-skill-backtest failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
