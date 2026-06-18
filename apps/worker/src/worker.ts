/**
 * WARDENCLAW BSC worker — the autonomous loop that runs unattended during the live
 * window (§0.11). Responsibilities:
 *   1. Crash-recovery reconciliation BEFORE any new trade (no duplicate trades).
 *   2. Per-cycle: honor the kill-switch, refresh CMC perception, run the gate
 *      chain, decide via the scheduler, (dry or live) execute, persist mandates.
 *   3. Heartbeat each cycle; hourly portfolio snapshot; alerts on key events.
 *
 * Requires CMC_API_KEY (real perception, never fabricated). Live signing requires
 * a configured TWAK executor; without it the worker runs the full ops loop in DRY
 * decision mode (no signing) and says so. It never fakes a fill or a tx hash.
 *
 *   pnpm --filter @wardenclaw/worker start
 *
 * Env: WORKER_INTERVAL_SECONDS (default 300), WORKER_MAX_CYCLES (default 0 = forever).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as loadDotenv } from "dotenv";
import {
  AuditLogger,
  appendMandate,
  buildCalibrationReport,
  loadRiskConfig,
  reconcile,
  recordPending,
  valueHoldings,
  initTrailingStop,
  evaluateWatchTick,
  evaluateWatchdog,
  WatchdogAction,
  serializeOpenPositions,
  parseOpenPositions,
  appendObservation,
  recentObservations,
  serializeSignalHistory,
  parseSignalHistory,
  COMPETITION,
  initWeekLedger,
  recordWeekValue,
  recordLeg,
  consumePressTrade,
  legsOnUtcDay,
  entriesOnUtcDay,
  deriveWeekBudgetState,
  evaluateWeekBudget,
  weekElapsedFraction,
  serializeWeekLedger,
  parseWeekLedger,
  updateDailyDrawdown,
  serializeDailyAnchor,
  parseDailyAnchor,
  updateWindowDrawdown,
  serializeWindowDrawdownAnchor,
  parseWindowDrawdownAnchor,
  initRegimeState,
  evaluateRegime,
  serializeRegimeState,
  parseRegimeState,
  ExitReason,
  initRollingCost,
  recordRoundTrip,
  measureRoundTripBps,
  realRoundTripBps as rollingRealCostBps,
  serializeRollingCost,
  parseRollingCost,
  computeFriction,
  scoredReturnBps,
  type RegimeState,
  type RegimeConfig,
  type RollingCostState,
  type BscScoreInputs,
  type CalibrationReport,
  type PendingMandate,
  type PendingSample,
  type ChainTxState,
  type Holding,
  type OpenPosition,
  type TrailingStopConfig,
  type TokenHistory,
  type SignalObservation,
  type WeekLedger,
  type WeekBudgetConfig,
  type DailyAnchor,
  type WindowDrawdownAnchor,
} from "@wardenclaw/core";
import {
  CmcClient,
  CmcX402Client,
  buildMomentumInputs,
  buildCatalystInputs,
  buildRsContinuationInputs,
} from "@wardenclaw/cmc-adapter";
import {
  loadEligibleTokens,
  LiveBscReader,
  NoPoolError,
  PANCAKE_V2_ROUTER,
  STARTER_MAJORS,
  TWAK_AGGREGATOR_ROUTER,
  TWAK_TOKEN_SPENDER,
} from "@wardenclaw/bsc-adapter";
import {
  evaluateCandidate,
  buildBscMandate,
  decideTradePlan,
  sendAlert,
  registrationAlertState,
  registerAgentIdentity,
  type PipelineContext,
} from "@wardenclaw/bnb-agent";
import {
  CliTwakExecutor,
  PolicyEnforcingExecutor,
  payX402InLoop,
  chooseX402Path,
  type TwakPolicyConfig,
  type TwakIntent,
} from "@wardenclaw/twak-adapter";

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const ROOT = repoRoot();
// Load the monorepo-root .env so secrets are picked up regardless of cwd.
loadDotenv({ path: join(ROOT, ".env") });
const RUNTIME_DIR = join(ROOT, "data", "runtime");
const AUDIT_DIR = join(ROOT, "data", "audit");
const config = loadRiskConfig(process.env as Record<string, string | undefined>);
const intervalMs = Number(process.env.WORKER_INTERVAL_SECONDS ?? "300") * 1000;
const maxCycles = Number(process.env.WORKER_MAX_CYCLES ?? "0");
const watchIntervalMs = config.positionWatchIntervalSeconds * 1000;
const trailConfig: TrailingStopConfig = {
  stopAtrMultiple: config.stopAtrMultiple,
  breakevenTriggerAtr: config.breakevenTriggerAtr,
  trailAtrMultiple: config.trailAtrMultiple,
  trailTightAtrMultiple: config.trailTightAtrMultiple,
};

function killEngaged(): boolean {
  const f = join(RUNTIME_DIR, "kill.flag.json");
  if (!existsSync(f)) return false;
  try {
    return Boolean((JSON.parse(readFileSync(f, "utf8")) as { engaged?: boolean }).engaged);
  } catch {
    return false;
  }
}

function writeHeartbeat(mode: string, cyclesRun: number): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(
    join(RUNTIME_DIR, "heartbeat.json"),
    JSON.stringify({ lastBeatIso: new Date().toISOString(), mode, cyclesRun }),
    "utf8",
  );
}

const PENDING_FILE = join(RUNTIME_DIR, "pending.json");

function writeRuntimeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

function loadPending(): PendingMandate[] {
  if (!existsSync(PENDING_FILE)) return [];
  const parsed = JSON.parse(readFileSync(PENDING_FILE, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("runtime pending.json is corrupt");
  return parsed as PendingMandate[];
}

function savePending(list: PendingMandate[]): void {
  writeRuntimeFileAtomic(PENDING_FILE, JSON.stringify(list, null, 2));
}

/**
 * Mark a mandate in-flight BEFORE/AROUND a TWAK submit, so a crash between submit
 * and the local fill record leaves a durable trace. On restart, reconcile() reads
 * these and resolves each against the chain instead of blindly re-submitting —
 * this is what prevents a duplicate trade. Upserts by mandateId.
 */
function markPending(entry: PendingMandate): void {
  const list = loadPending().filter((m) => m.mandateId !== entry.mandateId);
  list.push(entry);
  savePending(list);
}

/** Clear a mandate once its fill is fully recorded (no longer in-flight). */
function clearPending(mandateId: string): void {
  if (!existsSync(PENDING_FILE)) return;
  savePending(loadPending().filter((m) => m.mandateId !== mandateId));
}

interface RecordedFill {
  mandateId: string;
  action: "entry" | "scout" | "exit";
  txHash: string;
  recordedAtIso: string;
}

const RECORDED_FILLS_FILE = join(RUNTIME_DIR, "recorded-fills.json");

function loadRecordedFills(): RecordedFill[] {
  if (!existsSync(RECORDED_FILLS_FILE)) return [];
  const parsed = JSON.parse(readFileSync(RECORDED_FILLS_FILE, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("runtime recorded-fills.json is corrupt");
  return parsed as RecordedFill[];
}

/** Durable local commit marker written only after every state effect of a fill. */
function markFillRecorded(fill: Omit<RecordedFill, "recordedAtIso">): void {
  const list = loadRecordedFills().filter((x) => x.mandateId !== fill.mandateId);
  list.push({ ...fill, recordedAtIso: new Date().toISOString() });
  writeRuntimeFileAtomic(RECORDED_FILLS_FILE, JSON.stringify(list.slice(-200), null, 2));
}

/**
 * Real on-chain lookup for crash recovery: query the first BSC RPC for the tx
 * receipt. A confirmed receipt means the trade already landed (do not re-submit);
 * a missing receipt means it never broadcast (safe to re-evaluate as fresh).
 */
async function lookupTx(txHash: string): Promise<ChainTxState> {
  const rpc = (process.env.BSC_RPC_URLS ?? "").split(",")[0]?.trim();
  if (!rpc) return { found: false, confirmed: false };
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
    });
    const json = (await res.json()) as { result?: { blockNumber?: string | null; status?: string } | null };
    const receipt = json.result;
    if (!receipt) return { found: false, confirmed: false };
    const confirmed = Boolean(receipt.blockNumber);
    return { found: true, confirmed, success: receipt.status === "0x1" };
  } catch {
    return { found: false, confirmed: false };
  }
}

/** Best-effort raw JSON-RPC call against the first configured BSC endpoint. */
async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const rpc = (process.env.BSC_RPC_URLS ?? "").split(",")[0]?.trim();
  if (!rpc) return undefined;
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return ((await res.json()) as { result?: unknown }).result;
}

/** Resolve the TWAK trading wallet (it holds the key; we never see it directly) from
 *  the registration tx's sender, or an explicit WALLET_ADDRESS override. Best-effort. */
async function resolveTradingWallet(): Promise<string | undefined> {
  const explicit = (process.env.WALLET_ADDRESS ?? process.env.TWAK_AGENT_WALLET)?.trim();
  if (explicit) return explicit;
  const reg = process.env.REGISTRATION_TX_HASH?.trim();
  if (!reg) return undefined;
  try {
    const tx = (await rpcCall("eth_getTransactionByHash", [reg])) as { from?: string } | undefined;
    return tx?.from;
  } catch {
    return undefined;
  }
}

// An unlimited ERC20 approval is MaxUint256 (~1.16e77). No bounded approval a $40 book
// would ever grant approaches 2^200 (~1.6e60), so this cleanly flags the unlimited
// pattern regardless of token decimals or price — without false-positiving on a real
// per-trade approval. TWAK signs the approvals internally (the swap CLI takes no
// approval bound), so this is how we verify its on-chain behavior.
const UNLIMITED_ALLOWANCE_THRESHOLD = 2n ** 200n;
const APPROVAL_EVENT_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

/** ERC20 allowance(owner, spender) in raw token units, or undefined on RPC failure. */
async function routerAllowanceRaw(token: string, owner: string, spender: string): Promise<bigint | undefined> {
  const data = "0xdd62ed3e" + owner.slice(2).padStart(64, "0") + spender.slice(2).padStart(64, "0");
  try {
    const out = (await rpcCall("eth_call", [{ to: token, data }, "latest"])) as string | undefined;
    if (!out || out === "0x") return undefined;
    return BigInt(out);
  } catch {
    return undefined;
  }
}

/** Extract token spenders revealed by Approval events in a submitted swap receipt. */
async function approvalSpendersFromTx(txHash: string, owner: string): Promise<string[]> {
  try {
    const receipt = (await rpcCall("eth_getTransactionReceipt", [txHash])) as {
      logs?: Array<{ topics?: string[] }>;
    } | undefined;
    const ownerTopic = `0x${owner.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
    const spenders = new Set<string>();
    for (const log of receipt?.logs ?? []) {
      const topics = log.topics ?? [];
      if (
        topics[0]?.toLowerCase() === APPROVAL_EVENT_TOPIC &&
        topics[1]?.toLowerCase() === ownerTopic &&
        /^0x[0-9a-f]{64}$/i.test(topics[2] ?? "")
      ) {
        spenders.add(`0x${topics[2]!.slice(-40).toLowerCase()}`);
      }
    }
    return [...spenders];
  } catch {
    return [];
  }
}

// Forward calibration collector: the worker records each scored candidate's price
// as a pending observation; `pnpm collect:calibration` matures these into real
// { score, realizedMoveBps, win } samples once the holding horizon elapses. Opt-in
// via CALIBRATION_COLLECT_ENABLED — purely a recording side-channel that never
// touches a trade decision.
const CALIBRATION_DIR = join(ROOT, "data", "calibration");
const PENDING_SAMPLES_FILE = join(CALIBRATION_DIR, "pending-samples.json");

function loadPendingSamples(): PendingSample[] {
  if (!existsSync(PENDING_SAMPLES_FILE)) return [];
  try {
    return JSON.parse(readFileSync(PENDING_SAMPLES_FILE, "utf8")) as PendingSample[];
  } catch {
    return [];
  }
}

function savePendingSamples(samples: PendingSample[]): void {
  mkdirSync(CALIBRATION_DIR, { recursive: true });
  writeFileSync(PENDING_SAMPLES_FILE, JSON.stringify(samples, null, 2), "utf8");
}

const POSITIONS_FILE = join(RUNTIME_DIR, "positions.json");

/** Restore open positions (with live HWM/stop) so the trail resumes after a restart. */
function loadOpenPositions(): OpenPosition[] {
  if (!existsSync(POSITIONS_FILE)) return [];
  return parseOpenPositions(readFileSync(POSITIONS_FILE, "utf8")); // throws loud on corruption
}

function saveOpenPositions(positions: OpenPosition[]): void {
  writeRuntimeFileAtomic(POSITIONS_FILE, serializeOpenPositions(positions));
}

const SIGNAL_HISTORY_FILE = join(RUNTIME_DIR, "signalHistory.json");
/** Recent observations passed to the entry gates (rolling window per token). */
const ENTRY_WINDOW = 8;

/** Restore per-token signal history so entry gates see change across restarts. */
function loadSignalHistory(): Map<string, TokenHistory> {
  if (!existsSync(SIGNAL_HISTORY_FILE)) return new Map();
  const list = parseSignalHistory(readFileSync(SIGNAL_HISTORY_FILE, "utf8")); // throws loud on corruption
  return new Map(list.map((h) => [h.symbol, h]));
}

function saveSignalHistory(history: Map<string, TokenHistory>): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(SIGNAL_HISTORY_FILE, serializeSignalHistory([...history.values()]), "utf8");
}

const WEEK_LEDGER_FILE = join(RUNTIME_DIR, "weekLedger.json");

/** Restore (or freshly start) the week ledger so the HUNT/PRESS/DEFEND state
 *  survives restarts. A persisted ledger from a previous competition week (its
 *  weekStart no longer matches the current window) is re-initialized. */
function loadWeekLedger(weekStartIso: string, startValueUsd: number): WeekLedger {
  if (existsSync(WEEK_LEDGER_FILE)) {
    const restored = parseWeekLedger(readFileSync(WEEK_LEDGER_FILE, "utf8")); // throws loud on corruption
    if (restored.weekStartIso === weekStartIso) return restored;
  }
  return initWeekLedger(weekStartIso, startValueUsd);
}

function saveWeekLedger(ledger: WeekLedger): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(WEEK_LEDGER_FILE, serializeWeekLedger(ledger), "utf8");
}

const DAILY_ANCHOR_FILE = join(RUNTIME_DIR, "daily-drawdown.json");
const WINDOW_DRAWDOWN_FILE = join(RUNTIME_DIR, "window-drawdown.json");

/** Restore the intraday peak anchor so the daily-drawdown layer survives restarts.
 *  A stale anchor from a previous UTC day is harmless — updateDailyDrawdown resets it. */
function loadDailyAnchor(): DailyAnchor | undefined {
  if (!existsSync(DAILY_ANCHOR_FILE)) return undefined;
  return parseDailyAnchor(readFileSync(DAILY_ANCHOR_FILE, "utf8")); // throws loud on corruption
}

function saveDailyAnchor(anchor: DailyAnchor): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(DAILY_ANCHOR_FILE, serializeDailyAnchor(anchor), "utf8");
}

function loadWindowDrawdownAnchor(): WindowDrawdownAnchor | undefined {
  if (!existsSync(WINDOW_DRAWDOWN_FILE)) return undefined;
  return parseWindowDrawdownAnchor(readFileSync(WINDOW_DRAWDOWN_FILE, "utf8"));
}

function saveWindowDrawdownAnchor(anchor: WindowDrawdownAnchor): void {
  writeRuntimeFileAtomic(WINDOW_DRAWDOWN_FILE, serializeWindowDrawdownAnchor(anchor));
}

const SCOUT_RESERVE_FILE = join(RUNTIME_DIR, "scout-reserve.json");
type ScoutStable = "USDT" | "USDC";

/** Which stable the compliance-scout reserve currently sits in. The scout alternates
 *  direction so the ~$5 it moves never strands on one side and starves the USDT the
 *  real entries spend. Defaults to USDT (the all-USDT home state). */
function loadScoutHeldStable(): ScoutStable {
  if (!existsSync(SCOUT_RESERVE_FILE)) return "USDT";
  const held = (JSON.parse(readFileSync(SCOUT_RESERVE_FILE, "utf8")) as { heldStable?: string }).heldStable;
  return held === "USDC" ? "USDC" : "USDT";
}

function saveScoutHeldStable(heldStable: ScoutStable): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(SCOUT_RESERVE_FILE, JSON.stringify({ heldStable }), "utf8");
}

const LOSS_STREAK_FILE = join(RUNTIME_DIR, "loss-streak.json");

/** Consecutive realized losses, persisted so the survival pause survives restarts. */
function loadLossStreak(): number {
  if (!existsSync(LOSS_STREAK_FILE)) return 0;
  const n = (JSON.parse(readFileSync(LOSS_STREAK_FILE, "utf8")) as { streak?: number }).streak;
  return Number.isFinite(n) && (n as number) >= 0 ? Math.floor(n as number) : 0;
}

function saveLossStreak(streak: number): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(LOSS_STREAK_FILE, JSON.stringify({ streak }), "utf8");
}

const REGIME_FILE = join(RUNTIME_DIR, "regime.json");

/** Restore the committed regime + hysteresis counter so the analyst does not
 *  reset to NEUTRAL (and re-incur the confirmation delay) on every restart. */
function loadRegimeState(): RegimeState {
  if (!existsSync(REGIME_FILE)) return initRegimeState();
  return parseRegimeState(readFileSync(REGIME_FILE, "utf8")); // throws loud on corruption
}

function saveRegimeState(state: RegimeState): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(REGIME_FILE, serializeRegimeState(state), "utf8");
}

const WALLET_COST_FILE = join(RUNTIME_DIR, "wallet-cost.json");
const BOOK_FILE = join(RUNTIME_DIR, "book.json");
const REGISTRATION_ALERT_FILE = join(RUNTIME_DIR, "registration-alert.json");
const BENCHMARK_HISTORY_FILE = join(RUNTIME_DIR, "benchmark-history.json");
const MANUAL_REVIEW_FILE = join(RUNTIME_DIR, "manual-review.json");

interface RuntimeBook {
  walletCashUsd: number;
  scoredValueUsd: number;
}

function loadBook(): RuntimeBook {
  if (!existsSync(BOOK_FILE)) {
    return { walletCashUsd: config.startingCapitalUsd, scoredValueUsd: config.startingCapitalUsd };
  }
  const parsed = JSON.parse(readFileSync(BOOK_FILE, "utf8")) as RuntimeBook;
  if (!Number.isFinite(parsed.walletCashUsd) || !Number.isFinite(parsed.scoredValueUsd)) {
    throw new Error("runtime book is corrupt");
  }
  return parsed;
}

function saveBook(book: RuntimeBook): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(BOOK_FILE, JSON.stringify(book), "utf8");
}

function manualReviewRequired(): boolean {
  return existsSync(MANUAL_REVIEW_FILE);
}

function requireManualReview(detail: Record<string, unknown>): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(
    MANUAL_REVIEW_FILE,
    JSON.stringify({ requiredAtIso: new Date().toISOString(), ...detail }),
    "utf8",
  );
}

function lastRegistrationAlertMs(): number {
  if (!existsSync(REGISTRATION_ALERT_FILE)) return 0;
  try {
    return Number((JSON.parse(readFileSync(REGISTRATION_ALERT_FILE, "utf8")) as { sentAtMs?: number }).sentAtMs ?? 0);
  } catch {
    return 0;
  }
}

function markRegistrationAlert(nowMs: number): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(REGISTRATION_ALERT_FILE, JSON.stringify({ sentAtMs: nowMs }), "utf8");
}

interface BenchmarkPoint {
  atIso: string;
  priceUsd: number;
}

function loadBenchmarkHistory(): BenchmarkPoint[] {
  if (!existsSync(BENCHMARK_HISTORY_FILE)) return [];
  const parsed = JSON.parse(readFileSync(BENCHMARK_HISTORY_FILE, "utf8")) as BenchmarkPoint[];
  if (!Array.isArray(parsed) || parsed.some((p) => !Number.isFinite(p.priceUsd))) {
    throw new Error("benchmark history is corrupt");
  }
  return parsed.slice(-288);
}

function saveBenchmarkHistory(history: BenchmarkPoint[]): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(BENCHMARK_HISTORY_FILE, JSON.stringify(history.slice(-288)), "utf8");
}

/** Restore the rolling real round-trip cost (Wallet Ledger) so measured fills
 *  survive restarts. Bootstraps from a modeled real-friction estimate at size
 *  until the first real fill is measured. */
function loadWalletCost(bootstrapBps: number): RollingCostState {
  if (existsSync(WALLET_COST_FILE)) {
    return parseRollingCost(readFileSync(WALLET_COST_FILE, "utf8")); // throws loud on corruption
  }
  return initRollingCost(bootstrapBps);
}

function saveWalletCost(state: RollingCostState): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(WALLET_COST_FILE, serializeRollingCost(state), "utf8");
}

/** WS8 wallet-cost snapshot — surfaced on /bsc/ops + /bsc/proof. */
function writeWalletCost(state: {
  rollingBps: number;
  sampleCount: number;
  bootstrapBps: number;
  measured: boolean;
  dustCeilingBps: number;
  walletFloorBps: number;
}): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(
    join(RUNTIME_DIR, "wallet-cost.snapshot.json"),
    JSON.stringify({ lastBeatIso: new Date().toISOString(), ...state }),
    "utf8",
  );
}

/** Heartbeat for the fast watch loop — surfaced on /bsc/ops. */
function writeWatchHeartbeat(state: { watching: boolean; openPositions: number; lastError?: string }): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(
    join(RUNTIME_DIR, "watch-heartbeat.json"),
    JSON.stringify({ lastBeatIso: new Date().toISOString(), ...state }),
    "utf8",
  );
}

/** WS6 week-budget snapshot — surfaced on /bsc/ops (HUNT/PRESS/DEFEND). */
function writeWeekBudget(state: {
  riskState: string;
  sizeMultiplier: number;
  minimumScore: number;
  netEdgeBonusBps: number;
  pressTrade: boolean;
  pressTradeUsed: boolean;
  tightTrail: boolean;
  weekReturnPct: number;
  weekElapsedPct: number;
  legsUsed: number;
  legsRemaining: number;
  legsScarce: boolean;
  reason: string;
}): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(
    join(RUNTIME_DIR, "week-budget.json"),
    JSON.stringify({ lastBeatIso: new Date().toISOString(), ...state }),
    "utf8",
  );
}

/** WS7 regime snapshot — surfaced on /bsc/ops (GREEN/NEUTRAL/RED). */
function writeRegime(state: {
  regime: string;
  rawRegime: string;
  score: number;
  blocksEntries: boolean;
  benchmarkChange24hPct: number;
  benchmarkShortChangePct: number;
  btcChange24hPct: number;
  benchmarkAboveRecentMean: boolean;
  volatilityRatio: number;
  fearGreed: number;
  breadthUpFraction: number;
  reason: string;
}): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(
    join(RUNTIME_DIR, "regime.snapshot.json"),
    JSON.stringify({ lastBeatIso: new Date().toISOString(), ...state }),
    "utf8",
  );
}

function seedCalibration(): CalibrationReport {
  // Used only until `pnpm calibrate:edge` writes a real report. Labeled, and live
  // mode flags it stale; the worker runs dry by default.
  return buildCalibrationReport(
    [
      { score: 70, realizedMoveBps: 90, win: true },
      { score: 85, realizedMoveBps: 320, win: true },
    ],
    [60, 80],
    { version: "seed-worker", generatedAt: new Date().toISOString(), historyDays: 0 },
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!process.env.CMC_API_KEY) {
    console.error("✗ CMC_API_KEY required (real perception). The worker never fabricates market data.");
    process.exit(1);
  }
  const twakConfigured = Boolean(process.env.TWAK_CONFIG_PATH);
  const mode = twakConfigured ? "live" : "dry";

  // Live competition mode refuses to start unless the dress rehearsal passed
  // (§0.12), overridable only by explicit confirmation after manual live steps.
  if (mode === "live" && process.env.REHEARSAL_OVERRIDE !== "true") {
    const gate = join(RUNTIME_DIR, "rehearsal.json");
    const passed = existsSync(gate)
      ? Boolean((JSON.parse(readFileSync(gate, "utf8")) as { passed?: boolean }).passed)
      : false;
    if (!passed) {
      console.error(
        "✗ Live mode blocked: dress rehearsal not passed (§0.12).\n" +
          "  Run `pnpm rehearsal:checklist`, complete the manual live steps, then either\n" +
          "  pass all checks or set REHEARSAL_OVERRIDE=true to start with explicit confirmation.",
      );
      process.exit(1);
    }
  }
  if (manualReviewRequired()) {
    console.error(
      "✗ Live execution blocked: data/runtime/manual-review.json exists. Resolve the submitted transaction from chain evidence, reconcile book/position state, then remove the flag.",
    );
    process.exit(1);
  }

  console.log(`[worker] starting in ${mode.toUpperCase()} mode (interval ${intervalMs / 1000}s)`);

  mkdirSync(AUDIT_DIR, { recursive: true });
  const runId = `bsc-worker-${Date.now()}`;
  const audit = new AuditLogger(join(AUDIT_DIR, `${runId}.jsonl`));
  const mandatesPath = join(AUDIT_DIR, `${runId}.mandates.jsonl`);

  // 1. Crash-recovery reconciliation BEFORE any trade.
  const pending = loadPending();
  // A confirmed fill is only safe to clear if local state already reflects it: an entry
  // must have its tracked position, an exit must have removed it. Read positions straight
  // from disk (the openPositions working copy is restored further below). Anything else —
  // a confirmed entry with no position, or a confirmed exit whose position is still
  // open — is an unrecorded fill and is escalated to manual review by reconcile().
  const recoveredPositions = loadOpenPositions();
  const recordedFills = new Map(loadRecordedFills().map((fill) => [fill.mandateId, fill]));
  const isRecorded = (m: PendingMandate): boolean => {
    const fill = recordedFills.get(m.mandateId);
    if (!m.action || !m.txHash || fill?.action !== m.action || fill.txHash.toLowerCase() !== m.txHash.toLowerCase()) {
      return false;
    }
    if (m.action === "entry") return recoveredPositions.some((p) => p.mandateId === m.mandateId);
    if (m.action === "exit") {
      const posId = m.mandateId.replace(/-exit$/, "");
      return !recoveredPositions.some((p) => p.mandateId === posId);
    }
    return m.action === "scout";
  };
  const report = await reconcile(pending, lookupTx, isRecorded);
  await audit.append({
    timestamp: new Date().toISOString(),
    mandateId: "recovery",
    stage: "recovery",
    input: { pending: pending.length },
    output: { ...report },
  });
  if (report.requiresReview) {
    // An in-flight mandate could not be safely resolved against the chain (e.g.
    // a re-used nonce). Arm the manual-review halt and stop — the next start is
    // blocked at the manualReviewRequired() gate until an operator resolves it.
    requireManualReview({
      stage: "recovery",
      reason: "Crash recovery found in-flight mandate(s) needing manual chain reconciliation before trading resumes.",
      resolutions: report.resolutions,
    });
    await sendAlert(process.env.ALERT_WEBHOOK_URL, {
      reason: "restart_recovery",
      message: `Recovery requires review: ${report.resolutions.length} pending mandate(s). Trading halted until data/runtime/manual-review.json is resolved.`,
      timestamp: new Date().toISOString(),
    });
    console.warn("[worker] recovery requires manual review — halting until manual-review.json is resolved.");
    process.exit(1);
  }
  // Reconciled cleanly: every pending mandate was resolved against the chain
  // (confirmed, failed, or never broadcast), so none remain in-flight. Clear the
  // file so a resolved mandate is never reconciled — or duplicated — twice.
  if (pending.length > 0) savePending([]);
  await sendAlert(process.env.ALERT_WEBHOOK_URL, {
    reason: "restart_recovery",
    message: `Worker started cleanly (${mode} mode). ${report.duplicatesPrevented} duplicates prevented.`,
    timestamp: new Date().toISOString(),
  });

  // Restore the per-token signal history so the entry-quality gates (catalyst
  // uncrowding, RS continuation) see change across cycles and restarts.
  const signalHistory = loadSignalHistory();

  // WS6 week-schedule risk budget: a leg/return/drawdown ledger over the
  // competition week, restored across restarts. Drives the HUNT/PRESS/DEFEND
  // size multiplier each cycle. Re-initializes when a new week opens.
  const weekStartIso = COMPETITION.tradingWindow.startUtc;
  const weekEndIso = COMPETITION.tradingWindow.endUtc;
  const weekLengthDays = Math.max(1, Math.round((Date.parse(weekEndIso) - Date.parse(weekStartIso)) / 86_400_000));
  const weekBudgetCfg: WeekBudgetConfig = {
    weeklyLegBudget: config.weeklyLegBudget,
    flatBandLoPct: config.flatBandLoPct,
    flatBandHiPct: config.flatBandHiPct,
    defendTriggerPct: config.defendTriggerPct,
    huntMinScore: config.huntMinScore,
    pressMinScore: config.pressMinScore,
    defendMinScore: config.defendMinScore,
    netEdgeDefendBonusBps: config.netEdgeDefendBonusBps,
    pressStartDay: config.pressStartDay,
    reservedLegsPerDay: config.minTradesPerDay,
    weekLengthDays,
  };
  let weekLedger = loadWeekLedger(weekStartIso, config.startingCapitalUsd);
  saveWeekLedger(weekLedger);
  let dailyAnchor = loadDailyAnchor();
  let windowDrawdownAnchor = loadWindowDrawdownAnchor();
  let scoutHeldStable = loadScoutHeldStable();
  let lossStreak = loadLossStreak();
  let book = loadBook();
  saveBook(book);
  let defendTightTrail = false;
  let lastRiskState: string | null = null;
  // Per-position watchdog verdicts, refreshed each main cycle and read by the concurrent
  // watch loop: a forced rotation-to-stables (portfolio danger) or a trail-tighten
  // (thesis wobble — flip / liquidity / slippage / soft-drawdown). Maps by mandateId.
  let watchdogForceExit = new Map<string, ExitReason>();
  let watchdogTighten = new Set<string>();

  // WS7 red-day regime analyst: GREEN/NEUTRAL/RED with hysteresis, restored across
  // restarts. A committed RED regime blocks new directional entries (the gate) and
  // arms the watch loop to rotate open risk to stables. The flag is shared with the
  // concurrent watch loop, which owns position exits.
  const regimeCfg: RegimeConfig = {
    redBenchmarkPct: config.redBenchmarkPct,
    greenBenchmarkPct: config.greenBenchmarkPct,
    redFearGreed: config.redFearGreed,
    greenFearGreed: config.greenFearGreed,
    redBreadth: config.redBreadth,
    greenBreadth: config.greenBreadth,
    hysteresisChecks: config.regimeHysteresisChecks,
    highVolatilityRatio: config.regimeHighVolatilityRatio,
  };
  let regimeState = loadRegimeState();
  let regimeRed = regimeState.current === "RED";
  let benchmarkHistory = loadBenchmarkHistory();

  // WS8 Wallet Ledger: the MEASURED real round-trip cost. Bootstraps from a modeled
  // real-friction estimate at a representative size and is replaced by the rolling
  // mean of realized fills as they land. Feeds the wallet floor and the dust gate.
  const walletBootstrapBps = computeFriction({
    notionalUsd: Math.max(5, config.startingCapitalUsd * 0.25),
    gasInUsd: 0.02,
    gasOutUsd: 0.02,
    expectedSlippageBps: 10,
    lpFeeBps: 25,
    twakFeeBps: config.twakFeeBps,
    scoringSimCostBps: 0,
  }).realFrictionBps;
  let walletCost = loadWalletCost(walletBootstrapBps);
  saveWalletCost(walletCost);
  // Last observed gas-per-leg, shared with the watch loop for round-trip measurement.
  let lastGasPerLegUsd = 0.02;

  // Restore open positions (with live HWM/stop) so the trail resumes exactly.
  const openPositions = loadOpenPositions();
  const lastPriceMs = new Map<string, number>();
  for (const p of openPositions) lastPriceMs.set(p.mandateId, Date.now());
  if (openPositions.length > 0) {
    await sendAlert(process.env.ALERT_WEBHOOK_URL, {
      reason: "restart_recovery",
      message: `Resuming trail watch on ${openPositions.length} open position(s): ${openPositions.map((p) => p.symbol).join(", ")}.`,
      timestamp: new Date().toISOString(),
    });
    console.log(`[worker] resuming watch on ${openPositions.length} open position(s).`);
  }

  const cmc = new CmcClient();
  const loaded = loadEligibleTokens(process.env.ELIGIBLE_TOKENS_PATH ?? "data/eligible-tokens.json");
  const calibration = seedCalibration();
  const usdt = loaded.tokens.find((t) => t.symbol === "USDT");
  if (!usdt) throw new Error("USDT not found in eligible set — cannot route stable legs.");
  const usdc = loaded.tokens.find((t) => t.symbol === "USDC");
  if (!usdc) throw new Error("USDC not found in eligible set — cannot run the compliance scout.");

  // Approval-safety monitor: TWAK signs swaps (and their approvals) internally, so our
  // "no infinite approval" policy is only enforced on the intent we build, not on chain.
  // Verify TWAK's actual behavior by reading the router's allowance and alerting (once)
  // if it is effectively unlimited — the operator can then revoke it (approve spender 0).
  const tradingWallet = await resolveTradingWallet();
  const approvalAlerted = new Set<string>();
  const approvalSpenders = new Set(
    [
      PANCAKE_V2_ROUTER,
      TWAK_AGGREGATOR_ROUTER,
      TWAK_TOKEN_SPENDER,
      ...(process.env.TWAK_APPROVAL_SPENDERS ?? "").split(","),
    ]
      .map((x) => x.trim().toLowerCase())
      .filter((x) => /^0x[0-9a-f]{40}$/.test(x)),
  );
  if (!tradingWallet) {
    console.warn("[worker] approval monitor disabled — set WALLET_ADDRESS or REGISTRATION_TX_HASH to enable.");
  }
  async function rememberApprovalSpenders(txHash: string): Promise<void> {
    if (!tradingWallet) return;
    for (const spender of await approvalSpendersFromTx(txHash, tradingWallet)) {
      approvalSpenders.add(spender);
    }
  }
  async function checkRouterApprovals(): Promise<void> {
    if (!tradingWallet) return;
    const targets = [
      { symbol: "USDT", address: usdt!.bscContractAddress },
      ...openPositions.map((p) => ({ symbol: p.symbol, address: p.tokenOutAddress })),
    ];
    for (const t of targets) {
      for (const spender of approvalSpenders) {
        const alertKey = `${t.address.toLowerCase()}:${spender}`;
        if (approvalAlerted.has(alertKey)) continue;
        const allowance = await routerAllowanceRaw(t.address, tradingWallet, spender);
        if (allowance !== undefined && allowance > UNLIMITED_ALLOWANCE_THRESHOLD) {
          approvalAlerted.add(alertKey); // alert once per run per token+spender
          await sendAlert(process.env.ALERT_WEBHOOK_URL, {
            reason: "execution_failure",
            message: `Unlimited ${t.symbol} approval detected for spender ${spender} on ${tradingWallet}. Revoke that exact spender (approve 0) before resuming live trading.`,
            timestamp: new Date().toISOString(),
          });
          console.warn(`[worker] UNLIMITED ${t.symbol} approval detected for spender ${spender}.`);
        }
      }
    }
  }

  const twakPolicy: TwakPolicyConfig = {
    requiredChainId: 56,
    allowedRouters: ["pancakeswap"],
    allowedSpenders: [PANCAKE_V2_ROUTER],
    allowedContracts: [PANCAKE_V2_ROUTER],
    maxTradeUsd: Number(process.env.TWAK_MAX_TRADE_USD ?? "30"),
    maxDailySpendUsd: Number(process.env.TWAK_MAX_DAILY_SPEND_USD ?? "20"),
    maxSlippageBps: Number(process.env.TWAK_MAX_SLIPPAGE_BPS ?? "50"),
    allowInfiniteApprovals: false,
    approvalBufferBps: config.approvalBufferBps,
  };

  // Real BSC chain reader (viem) — reserves, on-chain quotes, gas. Pinned to 56.
  const rpcUrls = (process.env.BSC_RPC_URLS ?? "https://bsc-dataseed.binance.org,https://bsc-dataseed1.defibit.io")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  const reader = new LiveBscReader({ rpcUrls });
  await reader.assertChain();

  // Real TWAK signer (the only thing that signs) — live mode only. Keep the inner
  // CLI executor for TWAK-native x402 (payX402 needs no swap policy).
  const twakCli = mode === "live" ? new CliTwakExecutor({ tokens: loaded.tokens }) : null;
  const executor = twakCli
    ? new PolicyEnforcingExecutor(twakCli, loaded.allowlist, twakPolicy)
    : null;

  // x402 path: TWAK-first (native x402 + self-custody integrity for the rubric).
  // The viem CmcX402Client is a clearly-labeled fallback, only behind
  // X402_FALLBACK_VIEM with a raw Base key present.
  const x402Path = chooseX402Path({
    twakConfigured: Boolean(twakCli),
    fallbackViemEnabled: process.env.X402_FALLBACK_VIEM === "true",
    viemKeyPresent: Boolean(process.env.X402_PRIVATE_KEY),
  });
  const viemX402 = x402Path === "viem_fallback" ? new CmcX402Client() : null;
  const x402Required = process.env.X402_REQUIRED === "true";
  const x402Url = `${(process.env.CMC_X402_ENDPOINT ?? "https://pro-api.coinmarketcap.com").replace(/\/$/, "")}/x402/v1/dex/search?q=bnb`;
  if (x402Path === "viem_fallback") {
    console.warn("[worker] x402 path: viem_fallback (non-TWAK) — raw Base key signing. Unset X402_FALLBACK_VIEM to require TWAK x402.");
  } else if (x402Path === "none" && x402Required) {
    console.error("[worker] x402 REQUIRED but no path available (no TWAK live signer, viem fallback off) — trades will be BLOCKED.");
    await sendAlert(process.env.ALERT_WEBHOOK_URL, {
      reason: "execution_failure",
      message: "x402 required by config but no path available — trades blocked until TWAK x402 is live or the viem fallback is enabled.",
      timestamp: new Date().toISOString(),
    });
  }

  // Optional: register the agent identity on-chain via the BNB AI Agent SDK sidecar.
  if (process.env.BNB_SDK_REGISTER === "true") {
    try {
      const id = await registerAgentIdentity({
        scriptPath: join(ROOT, "apps", "bnb-sdk-sidecar", "register_agent.py"),
        env: { BNB_SDK_NETWORK: process.env.BNB_SDK_NETWORK ?? "bsc" },
      });
      console.log(`[worker] BNB agent identity registered: id=${id.agentId} tx=${id.transactionHash}`);
    } catch (err) {
      await sendAlert(process.env.ALERT_WEBHOOK_URL, {
        reason: "execution_failure",
        message: `BNB SDK identity registration failed: ${(err as Error).message}`,
        timestamp: new Date().toISOString(),
      });
      console.warn(`[worker] BNB SDK registration failed (continuing): ${(err as Error).message}`);
    }
  }

  const usdtAddress = usdt.bscContractAddress;
  const usdtDecimals = usdt.decimals;

  /** Fetch the held token's price in USD (≈ USDT) via the live quoter. */
  async function fetchTokenPriceUsd(pos: OpenPosition): Promise<number> {
    const token = loaded.tokens.find(
      (t) => t.bscContractAddress.toLowerCase() === pos.tokenOutAddress.toLowerCase(),
    );
    if (!token) throw new Error(`held token not in eligible set: ${pos.tokenOutAddress}`);
    const q = await reader.getAmountOut(
      token.bscContractAddress,
      usdtAddress,
      1,
      token.decimals,
      usdtDecimals,
    );
    return q.amountOut; // USDT out for 1 token ≈ USD price
  }

  async function currentWalletValueUsd(): Promise<number> {
    let value = book.walletCashUsd;
    for (const pos of openPositions) value += pos.amountTokens * (await fetchTokenPriceUsd(pos));
    return value;
  }

  /** One pass over all open positions: ratchet trails, fire safety exits on breach. */
  async function watchAllPositions(): Promise<void> {
    for (const pos of [...openPositions]) {
      let price: { fresh: true; price: number } | { fresh: false; secondsSinceLastPrice: number };
      try {
        const p = await fetchTokenPriceUsd(pos);
        lastPriceMs.set(pos.mandateId, Date.now());
        price = { fresh: true, price: p };
      } catch {
        const last = lastPriceMs.get(pos.mandateId) ?? Date.now();
        price = { fresh: false, secondsSinceLastPrice: (Date.now() - last) / 1000 };
      }

      const tick = evaluateWatchTick({
        trail: pos.trail,
        price,
        config: trailConfig,
        stalenessLimitSeconds: config.watchStalenessLimitSeconds,
        stalenessAction: config.watchStalenessAction,
        // RED regime, DEFEND, or a watchdog thesis-wobble tightens the trail; RED or a
        // watchdog portfolio-danger verdict forces a rotation-to-stables exit.
        tightMode:
          pos.trail.tightMode || regimeRed || defendTightTrail || watchdogTighten.has(pos.mandateId),
        forceExit: watchdogForceExit.has(pos.mandateId)
          ? { reason: watchdogForceExit.get(pos.mandateId)! }
          : regimeRed
            ? { reason: ExitReason.REGIME_RED }
            : undefined,
      });

      if (tick.action === "stale") {
        await sendAlert(process.env.ALERT_WEBHOOK_URL, {
          reason: "execution_failure",
          message: `Watch loop blind on ${pos.symbol} for ${tick.stale!.secondsSinceLastPrice.toFixed(0)}s (>${config.watchStalenessLimitSeconds}s). Armed: ${tick.stale!.action}.`,
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      if (tick.updatedTrail) pos.trail = tick.updatedTrail;

      if (tick.action === "exit" && tick.exit) {
        // Forced safety exit through TWAK: sell the held token back to the stable.
        // This bypasses the net-edge gate by construction (it never runs it) but the
        // TWAK policy still enforces chain/router/eligibility/slippage before signing.
        const exitIntent: TwakIntent = {
          kind: "swap",
          chainId: 56,
          executionType: "spot_only",
          router: "pancakeswap",
          spender: PANCAKE_V2_ROUTER,
          to: PANCAKE_V2_ROUTER,
          tokenInAddress: pos.tokenOutAddress, // held token
          tokenOutAddress: pos.tokenInAddress, // stable (USDT)
          amountInUsd: pos.notionalUsd,
          txValueWei: "0",
          isInfiniteApproval: false,
          approvalAmount: pos.notionalUsd,
          mandateAmount: pos.notionalUsd,
          slippageBps: config.maxSlippageBps,
          isNonSpot: false,
          decodedAction: "exit",
          mandateAction: "exit",
          mandateId: pos.mandateId,
        };
        const exitMandateId = `${pos.mandateId}-exit`;
        let recordedExitTxHash: string | undefined;
        try {
          // Mark the exit in-flight before signing so a crash mid-exit is recoverable.
          if (executor) markPending({ mandateId: exitMandateId, status: "pending_build", action: "exit" });
          const outcome = executor ? await executor.execute(exitIntent, { spentTodayUsd: 0 }) : null;
          if (outcome?.receipt) markPending({ mandateId: exitMandateId, txHash: outcome.receipt.txHash, status: "submitted", action: "exit" });
          if (outcome?.receipt) {
            await rememberApprovalSpenders(outcome.receipt.txHash);
            await checkRouterApprovals();
          }
          await audit.append({
            timestamp: new Date().toISOString(),
            mandateId: pos.mandateId,
            stage: "watchdog",
            input: {
              reason: tick.exit.reason,
              entryPrice: tick.exit.entryPrice,
              highWaterMark: tick.exit.highWaterMark,
              exitPrice: tick.exit.currentPrice,
              stopPrice: tick.exit.stopPrice,
              gainPct: tick.exit.gainPct,
            },
            output: outcome?.receipt
              ? { status: "submitted", txHash: outcome.receipt.txHash }
              : { status: outcome?.refused ? "refused" : "dry", detail: outcome?.policy?.reason },
            proofAnchors: outcome?.receipt
              ? { bscTxHash: outcome.receipt.txHash, twakReceipt: outcome.receipt.twakReceiptId }
              : undefined,
          });
          if (outcome?.refused) {
            clearPending(exitMandateId); // never broadcast — not in-flight
            await sendAlert(process.env.ALERT_WEBHOOK_URL, {
              reason: "twak_refusal",
              message: `TWAK refused safety exit on ${pos.symbol}: ${outcome.policy.reason}`,
              timestamp: new Date().toISOString(),
            });
            continue; // keep watching — do not drop a position we failed to exit
          }
          if (outcome?.receipt && typeof outcome.receipt.realizedOut !== "number") {
            requireManualReview({
              mandateId: pos.mandateId,
              txHash: outcome.receipt.txHash,
              action: "exit",
              reason: "TWAK submitted the exit without a confirmed realizedOut; do not retry",
            });
            await sendAlert(process.env.ALERT_WEBHOOK_URL, {
              reason: "restart_recovery",
              message: `Exit ${outcome.receipt.txHash} submitted without confirmed output. Trading halted for manual chain reconciliation; do not retry.`,
              timestamp: new Date().toISOString(),
            });
            return;
          }
          console.log(`[worker] ${tick.exit.reason} ${pos.symbol} @ ${tick.exit.currentPrice} (gain ${tick.exit.gainPct.toFixed(2)}%)`);

          // WS8: measure the REAL round-trip cost from this completed fill (entry
          // notional vs actual exit proceeds, isolated from the price move) and fold
          // it into the rolling Wallet Ledger estimate that drives the wallet floor +
          // dust gate. Requires a real exit fill with a realized output.
          if (outcome?.receipt && typeof outcome.receipt.realizedOut === "number" && tick.exit.entryPrice > 0) {
            const measuredBps = measureRoundTripBps({
              entryNotionalUsd: pos.notionalUsd,
              exitProceedsUsd: outcome.receipt.realizedOut,
              entryPrice: tick.exit.entryPrice,
              exitPrice: tick.exit.currentPrice,
              entryGasUsd: lastGasPerLegUsd,
              exitGasUsd: lastGasPerLegUsd,
            });
            walletCost = recordRoundTrip(walletCost, measuredBps);
            saveWalletCost(walletCost);
            console.log(
              `[worker] measured real round-trip on ${pos.symbol}: ${measuredBps.toFixed(0)}bps (rolling ${rollingRealCostBps(walletCost).toFixed(0)}bps over ${walletCost.samples.length} fill(s))`,
            );
            book.walletCashUsd += outcome.receipt.realizedOut;
            // Track consecutive realized losses (proceeds below cost basis) so a streak
            // pauses new directional entries via the survival gate above.
            lossStreak = outcome.receipt.realizedOut < pos.notionalUsd ? lossStreak + 1 : 0;
            saveLossStreak(lossStreak);
            const priceMoveBps = ((tick.exit.currentPrice - tick.exit.entryPrice) / tick.exit.entryPrice) * 10_000;
            book.scoredValueUsd +=
              (scoredReturnBps({
                priceMoveBps,
                scoredFrictionBps: config.scoringSimCostBps * 2,
              }) /
                10_000) *
              pos.notionalUsd;
            weekLedger = recordLeg(weekLedger, "exit");
            saveBook(book);
            saveWeekLedger(weekLedger);
            recordedExitTxHash = outcome.receipt.txHash;
          }
        } catch (err) {
          await sendAlert(process.env.ALERT_WEBHOOK_URL, {
            reason: "execution_failure",
            message: `Safety exit failed for ${pos.symbol}: ${(err as Error).message}`,
            timestamp: new Date().toISOString(),
          });
          continue; // retry next tick; never silently drop
        }
        // Exit submitted (or dry): stop tracking this position.
        const idx = openPositions.findIndex((p) => p.mandateId === pos.mandateId);
        if (idx >= 0) openPositions.splice(idx, 1);
        lastPriceMs.delete(pos.mandateId);
        // Persist the position removal before declaring the fill locally recorded.
        // If the process dies after this marker but before pending.json is cleared,
        // restart recovery can prove both the tx and its local state effect.
        saveOpenPositions(openPositions);
        if (recordedExitTxHash) {
          markFillRecorded({
            mandateId: exitMandateId,
            action: "exit",
            txHash: recordedExitTxHash,
          });
        }
        clearPending(exitMandateId); // exit fully recorded — no longer in-flight
      }
    }
    saveOpenPositions(openPositions);
  }

  async function runWatchLoop(): Promise<void> {
    for (;;) {
      try {
        if (openPositions.length > 0 && !manualReviewRequired()) await watchAllPositions();
        writeWatchHeartbeat({ watching: openPositions.length > 0, openPositions: openPositions.length });
      } catch (err) {
        writeWatchHeartbeat({ watching: openPositions.length > 0, openPositions: openPositions.length, lastError: (err as Error).message });
      }
      if (killEngaged()) break;
      await sleep(watchIntervalMs);
    }
  }
  void runWatchLoop();

  let spentTodayUsd = 0;
  let cycles = 0;
  let lastSnapshotHour = "";

  while (maxCycles === 0 || cycles < maxCycles) {
    cycles++;
    writeHeartbeat(mode, cycles);

    if (killEngaged()) {
      await sendAlert(process.env.ALERT_WEBHOOK_URL, {
        reason: "emergency_stop",
        message: "Kill-switch engaged — worker halting new entries.",
        timestamp: new Date().toISOString(),
      });
      console.warn("[worker] kill-switch engaged — halting. (Would cancel intents + attempt revocations.)");
      break;
    }

    try {
      if (manualReviewRequired()) {
        console.error("[worker] manual review flag armed - halting before any new entry.");
        break;
      }
      // Verify TWAK has not set an unbounded router allowance on the trading wallet.
      // Alert-once-per-token guard inside keeps this cheap to call every cycle.
      await checkRouterApprovals();
      const nowMs = Date.now();
      const registration = registrationAlertState(
        nowMs,
        Boolean(process.env.REGISTRATION_TX_HASH),
        Date.parse(COMPETITION.tradingWindow.startUtc),
        Date.parse("2026-06-18T00:00:00Z"),
      );
      if (
        registration.severity !== "none" &&
        nowMs - lastRegistrationAlertMs() >= registration.cadenceMs
      ) {
        await sendAlert(process.env.ALERT_WEBHOOK_URL, {
          reason: "registration_missing",
          message: `[${registration.severity.toUpperCase()}] ${registration.message}`,
          timestamp: new Date(nowMs).toISOString(),
        });
        markRegistrationAlert(nowMs);
      }

      const symbols = STARTER_MAJORS.map((t) => t.symbol).slice(0, 6);
      const [quotes, fg, benchmarks, trending] = await Promise.all([
        cmc.getQuotes(symbols),
        cmc.getFearGreed(),
        cmc.getQuotes(["BNB", "BTC"]),
        cmc.getTrending(20).catch((err) => {
          console.warn(`[worker] trending fetch failed (catalyst candidates skipped this cycle): ${(err as Error).message}`);
          return null;
        }),
      ]);
      const bnbQuote = benchmarks.data.find((q) => q.symbol === "BNB");
      const btcQuote = benchmarks.data.find((q) => q.symbol === "BTC");
      if (!bnbQuote || !btcQuote) throw new Error("CMC benchmark quotes missing BNB or BTC");
      const bnbChange = bnbQuote.percentChange24h;
      const bnbPrice = bnbQuote.priceUsd;

      // Real gas cost per leg from on-chain gas price × BNB price.
      const gasPerLegUsd = bnbPrice > 0 ? await reader.gasPerLegUsd(bnbPrice) : 0.02;
      lastGasPerLegUsd = gasPerLegUsd; // share with the watch loop for round-trip measurement

      // x402-in-the-loop: pay for a CMC x402 request used in this decision cycle.
      // TWAK-first; viem only as a labeled fallback. Failure may block trades.
      let x402ReceiptId: string | undefined;
      let x402PathUsed: "twak" | "viem_fallback" | undefined;
      let x402Failed = false;
      if (x402Path === "twak" && twakCli) {
        try {
          const receipt = await payX402InLoop(twakCli, {
            url: x402Url,
            maxAmount: process.env.X402_MAX_PAYMENT_ATOMIC ?? "10000",
            asset: process.env.X402_ASSET ?? "",
            mandateId: `x402-c${cycles}`,
          });
          x402ReceiptId = receipt.receipt;
          x402PathUsed = "twak";
          await audit.append({
            timestamp: new Date().toISOString(),
            mandateId: `x402-c${cycles}`,
            stage: "perception",
            input: { url: receipt.requestUrl, path: "twak" },
            output: { paid: true, receipt: receipt.receipt },
            proofAnchors: { x402Receipt: receipt.receipt },
          });
        } catch (err) {
          x402Failed = true;
          await sendAlert(process.env.ALERT_WEBHOOK_URL, {
            reason: "execution_failure",
            message: `TWAK x402 payment failed: ${(err as Error).message}`,
            timestamp: new Date().toISOString(),
          });
        }
      } else if (x402Path === "viem_fallback" && viemX402) {
        try {
          const paid = await viemX402.get("/x402/v1/dex/search", { q: "bnb" });
          x402ReceiptId = paid.receipt.receipt;
          x402PathUsed = "viem_fallback";
          await audit.append({
            timestamp: new Date().toISOString(),
            mandateId: `x402-c${cycles}`,
            stage: "perception",
            input: { url: paid.receipt.requestUrl, path: "viem_fallback (non-TWAK)" },
            output: { paid: true, receipt: paid.receipt.receipt },
            proofAnchors: { x402Receipt: paid.receipt.receipt },
          });
        } catch (err) {
          x402Failed = true;
          await sendAlert(process.env.ALERT_WEBHOOK_URL, {
            reason: "execution_failure",
            message: `x402 (viem fallback) payment failed: ${(err as Error).message}`,
            timestamp: new Date().toISOString(),
          });
        }
      }
      // If x402 is required by config but unavailable or failed, block trades.
      const x402Blocks = x402Required && (x402Path === "none" || x402Failed);

      // WS6 reads the competition-style Scored Ledger, while wallet protection
      // reads actual stable cash plus marked-to-market open fills.
      const walletValueUsd = await currentWalletValueUsd();
      const currentValueUsd = book.scoredValueUsd;
      weekLedger = recordWeekValue(weekLedger, currentValueUsd);
      // Drawdown safety is marked to market, including unrealized open-position PnL.
      // The scored ledger remains separate for competition economics and week doctrine.
      const competitionWindowStarted = Date.now() >= Date.parse(weekStartIso);
      const windowRisk = updateWindowDrawdown(
        competitionWindowStarted ? windowDrawdownAnchor : undefined,
        walletValueUsd,
        weekStartIso,
      );
      if (competitionWindowStarted) {
        windowDrawdownAnchor = windowRisk.anchor;
        saveWindowDrawdownAnchor(windowDrawdownAnchor);
      } else {
        // Rehearsal PnL must not contaminate the June 22 competition peak.
        windowDrawdownAnchor = undefined;
      }
      // Intraday peak-to-trough (resets at UTC midnight) uses the same marked basis.
      const daily = updateDailyDrawdown(dailyAnchor, walletValueUsd, new Date().toISOString());
      dailyAnchor = daily.anchor;
      saveDailyAnchor(dailyAnchor);
      const weekElapsed = weekElapsedFraction(new Date().toISOString(), weekStartIso, weekEndIso);
      const weekState = deriveWeekBudgetState(weekLedger, currentValueUsd, weekElapsed);
      const weekBudget = evaluateWeekBudget(weekState, weekBudgetCfg);
      defendTightTrail = weekBudget.tightTrail;
      if (weekBudget.state !== lastRiskState) {
        await audit.append({
          timestamp: new Date().toISOString(),
          mandateId: "week-state",
          stage: "risk",
          input: {
            previousState: lastRiskState,
            weekReturnPct: weekState.weekReturnPct,
            pressTradeUsed: weekState.pressTradeUsed,
          },
          output: { state: weekBudget.state, reason: weekBudget.reason },
        });
        lastRiskState = weekBudget.state;
      }
      saveWeekLedger(weekLedger);
      writeWeekBudget({
        riskState: weekBudget.state,
        sizeMultiplier: weekBudget.sizeMultiplier,
        minimumScore: weekBudget.minimumScore,
        netEdgeBonusBps: weekBudget.netEdgeBonusBps,
        pressTrade: weekBudget.pressTrade,
        pressTradeUsed: weekState.pressTradeUsed,
        tightTrail: weekBudget.tightTrail,
        weekReturnPct: weekState.weekReturnPct,
        weekElapsedPct: weekElapsed * 100,
        legsUsed: weekState.legsUsed,
        legsRemaining: weekBudget.legsRemaining,
        legsScarce: weekBudget.legsScarce,
        reason: weekBudget.reason,
      });

      // WS7 regime read: benchmark 24h change, Fear & Greed, and breadth (fraction
      // of the majors up). The committed regime carries hysteresis; RED blocks new
      // entries (the gate) and arms the watch loop to rotate to stables.
      const upMajors = quotes.data.filter((q) => q.percentChange24h > 0).length;
      const breadthUpFraction = quotes.data.length > 0 ? upMajors / quotes.data.length : 0;
      const recentMean =
        benchmarkHistory.length > 0
          ? benchmarkHistory.reduce((sum, p) => sum + p.priceUsd, 0) / benchmarkHistory.length
          : bnbPrice;
      const majorsShortVol =
        quotes.data.length > 0
          ? quotes.data.reduce((sum, q) => sum + Math.abs(q.percentChange1h), 0) / quotes.data.length
          : 0;
      const volatilityRatio = Math.abs(bnbQuote.percentChange1h) / Math.max(majorsShortVol, 0.01);
      const regimeSignals = {
        benchmarkChange24hPct: bnbChange,
        benchmarkShortChangePct: bnbQuote.percentChange1h,
        btcChange24hPct: btcQuote.percentChange24h,
        benchmarkAboveRecentMean: bnbPrice >= recentMean,
        fearGreed: fg.data.value,
        breadthUpFraction,
        volatilityRatio,
      };
      const regime = evaluateRegime(regimeState, regimeSignals, regimeCfg);
      benchmarkHistory = [...benchmarkHistory, { atIso: bnbQuote.lastUpdated, priceUsd: bnbPrice }].slice(-288);
      saveBenchmarkHistory(benchmarkHistory);
      regimeState = regime.state;
      regimeRed = regime.blocksEntries;
      saveRegimeState(regimeState);
      writeRegime({
        regime: regimeState.current,
        rawRegime: regime.rawRegime,
        score: regime.score,
        blocksEntries: regime.blocksEntries,
        benchmarkChange24hPct: bnbChange,
        benchmarkShortChangePct: bnbQuote.percentChange1h,
        btcChange24hPct: btcQuote.percentChange24h,
        benchmarkAboveRecentMean: bnbPrice >= recentMean,
        volatilityRatio,
        fearGreed: fg.data.value,
        breadthUpFraction,
        reason: regime.reason,
      });
      if (regime.changed) {
        await sendAlert(process.env.ALERT_WEBHOOK_URL, {
          reason: regimeState.current === "RED" ? "emergency_stop" : "restart_recovery",
          message:
            regimeState.current === "RED"
              ? `Regime turned RED (${regime.reason}) — blocking new entries and rotating open positions to stables.`
              : `Regime cleared to ${regimeState.current} (${regime.reason}) — entries re-enabled.`,
          timestamp: new Date().toISOString(),
        });
        console.warn(`[worker] ${regime.reason}`);
      }

      const ctx: PipelineContext = {
        config,
        calibration,
        allowlist: loaded.allowlist,
        twakPolicy,
        portfolioUsd: walletValueUsd,
        deployableUsd: Math.max(0, book.walletCashUsd - config.gasReserveUsd),
        // Whole-window peak-to-trough drawdown uses marked-to-market wallet value,
        // so unrealized losses throttle risk before they become realized exits.
        windowDrawdownPct: windowRisk.windowDrawdownPct,
        // Intraday peak-to-trough (resets at UTC midnight); drives the governor's daily
        // layer so a bad day throttles size independently of the whole-window budget.
        dailyDrawdownPct: daily.dailyDrawdownPct,
        openPositions: openPositions.length,
        tradesToday: entriesOnUtcDay(weekLedger, new Date().toISOString()),
        // Hard backstop: block new directional entries (scouts and forced safety exits
        // stay allowed) once the internal whole-window budget is breached OR after a run
        // of consecutive realized losses. The governor already shrinks size to ~0 near the
        // drawdown cap; this slams the brakes well inside the 30% DQ and stops a losing
        // streak from compounding. Scout-only rehearsals are unaffected (drawdown 0, no losses).
        survivalMode:
          windowRisk.windowDrawdownPct >= config.internalWindowDrawdownPct ||
          lossStreak >= config.survivalLossStreak,
        marketDataStale: false,
        calibrationStale: mode === "dry",
        sizeMultiplier: weekBudget.sizeMultiplier,
        riskState: weekBudget.state,
        minimumScore: weekBudget.minimumScore,
        netEdgeBonusBps: weekBudget.netEdgeBonusBps,
        pressTrade: weekBudget.pressTrade,
        marketRegime: regimeState.current,
        // Once real fills are measured, the wallet floor + dust gate use the MEASURED
        // round-trip; until then ctx leaves it undefined so the pipeline falls back to
        // the accurate per-candidate modeled friction at size.
        realRoundTripBps: walletCost.samples.length > 0 ? rollingRealCostBps(walletCost) : undefined,
      };

      // WS8 wallet-cost snapshot for the dashboards.
      const walletRollingBps = walletCost.samples.length > 0 ? rollingRealCostBps(walletCost) : walletCost.bootstrapBps;
      writeWalletCost({
        rollingBps: walletRollingBps,
        sampleCount: walletCost.samples.length,
        bootstrapBps: walletCost.bootstrapBps,
        measured: walletCost.samples.length > 0,
        dustCeilingBps: config.dustRoundTripCeilingBps,
        walletFloorBps: config.walletFloorFraction * walletRollingBps,
      });

      // Trending → catalyst candidates. Keep only eligible trending tokens and, when
      // a trending token is not already among the majors, fetch its quote so we have
      // real price/volume for it.
      const trendingRankBySymbol = new Map<string, number>();
      for (const t of trending?.data ?? []) {
        if (loaded.tokens.some((tok) => tok.symbol === t.symbol)) trendingRankBySymbol.set(t.symbol, t.rank);
      }
      const majorSymbols = new Set(quotes.data.map((q) => q.symbol));
      const extraTrendingSymbols = [...trendingRankBySymbol.keys()].filter((s) => !majorSymbols.has(s));
      let trendingQuotes: typeof quotes.data = [];
      if (extraTrendingSymbols.length > 0) {
        try {
          trendingQuotes = (await cmc.getQuotes(extraTrendingSymbols)).data;
        } catch (err) {
          console.warn(`[worker] trending quotes fetch failed: ${(err as Error).message}`);
        }
      }
      const allQuotes = [...quotes.data, ...trendingQuotes];

      // Record one observation per token this cycle (deduped by CMC timestamp so we
      // never fabricate repeated points), then persist for restart-safe entry gates.
      for (const q of allQuotes) {
        const prior = signalHistory.get(q.symbol) ?? { symbol: q.symbol, observations: [] };
        if (prior.observations[prior.observations.length - 1]?.checkIso === q.lastUpdated) continue;
        const obs: SignalObservation = {
          checkIso: q.lastUpdated,
          price: q.priceUsd,
          volume24hUsd: q.volume24hUsd,
          change24hPct: q.percentChange24h,
          benchmarkChange24hPct: bnbChange,
          trendingRank: trendingRankBySymbol.get(q.symbol),
        };
        signalHistory.set(q.symbol, appendObservation(prior, obs));
      }
      saveSignalHistory(signalHistory);

      // One pool lookup per token per cycle (reserves + a real shadow-fill probe),
      // cached so a token appearing in several families is fetched only once.
      type Pool = { reserveIn: number; reserveOut: number; shadow: { expectedOut: number; simulatedOut: number } };
      const poolCache = new Map<string, Pool | null>();
      const resolvePool = async (token: (typeof loaded.tokens)[number]): Promise<Pool | null> => {
        const key = token.bscContractAddress.toLowerCase();
        if (poolCache.has(key)) return poolCache.get(key)!;
        try {
          const reserves = await reader.getReserves(usdt.bscContractAddress, token.bscContractAddress, usdt.decimals, token.decimals);
          // Shadow-fill: two on-chain quotes at intended size; deviation flags MEV/thin liquidity.
          const probe = Math.min(config.startingCapitalUsd, 15);
          const q1 = await reader.getAmountOut(usdt.bscContractAddress, token.bscContractAddress, probe, usdt.decimals, token.decimals);
          const q2 = await reader.getAmountOut(usdt.bscContractAddress, token.bscContractAddress, probe, usdt.decimals, token.decimals);
          const pool: Pool = { reserveIn: reserves.reserveIn, reserveOut: reserves.reserveOut, shadow: { expectedOut: q1.amountOut, simulatedOut: q2.amountOut } };
          poolCache.set(key, pool);
          return pool;
        } catch (err) {
          if (err instanceof NoPoolError) {
            console.log(`[worker] ${token.symbol}: no direct USDT pool — skipped`);
            poolCache.set(key, null);
            return null;
          }
          throw err;
        }
      };

      // --- Per-position watchdog (main-cycle cadence) ---
      // The trailing-stop loop owns the price stop; the watchdog adds the rest of the
      // protective layer: a thesis wobble (CMC signal flip / liquidity thinning /
      // slippage spike), a soft drawdown, or a loss streak TIGHTENS the trail (lock gains,
      // don't dump a runner on noise); only a portfolio-danger reading forces a rotation
      // to stables. Verdicts are handed to the concurrent watch loop via the shared maps.
      watchdogForceExit = new Map<string, ExitReason>();
      watchdogTighten = new Set<string>();
      for (const pos of openPositions) {
        const heldToken = loaded.tokens.find(
          (t) => t.bscContractAddress.toLowerCase() === pos.tokenOutAddress.toLowerCase(),
        );
        const quote = allQuotes.find((q) => q.symbol === pos.symbol);
        const pool = heldToken ? await resolvePool(heldToken) : null;
        const shadowDevBps = pool
          ? (Math.abs(pool.shadow.expectedOut - pool.shadow.simulatedOut) /
              Math.max(pool.shadow.expectedOut, 1e-9)) *
            10_000
          : 0;
        const wd = evaluateWatchdog({
          // Feed a price at the high-water mark so the watchdog's own stop-breach branch
          // never double-fires — the watch loop is the single owner of the price stop.
          currentPrice: pos.trail.highWaterMark,
          stopPrice: pos.trail.stopPrice,
          hasOpenPosition: true,
          hasPendingOrder: false,
          windowDrawdownPct: windowRisk.windowDrawdownPct,
          softDrawdownPct: config.softDrawdownPct,
          lossStreak,
          portfolioValueUsd: walletValueUsd,
          dangerPortfolioValueUsd: config.dangerPortfolioValueUsd,
          // Entry-time reserves aren't stored, so liquidity-thinning is proxied by the
          // shadow-fill deviation (which also flags slippage spikes / MEV) below.
          liquidityThinning: false,
          // Thesis break for a long: the coin has actually turned red on the day AND lost
          // its edge over the benchmark — not merely lagging BNB while still rising.
          cmcSignalFlipped: quote ? quote.percentChange24h < 0 && quote.percentChange24h - bnbChange < 0 : false,
          slippageSpiking: shadowDevBps > config.shadowFillToleranceBps,
        });
        if (wd.actions.includes(WatchdogAction.CLOSE_POSITION)) {
          watchdogForceExit.set(pos.mandateId, ExitReason.PORTFOLIO_DANGER);
        } else if (
          wd.actions.includes(WatchdogAction.REDUCE_POSITION) ||
          wd.actions.includes(WatchdogAction.PAUSE_STRATEGY)
        ) {
          watchdogTighten.add(pos.mandateId);
        }
      }

      // Candidate specs across the three families: momentum on every major;
      // rs_continuation on majors outperforming the benchmark; catalyst on eligible
      // trending tokens. Catalyst + rs_continuation carry recent history so their
      // deterministic entry-quality gates fire (the LLM touches none of this).
      interface Spec {
        quote: (typeof allQuotes)[number];
        token: (typeof loaded.tokens)[number];
        family: "momentum" | "catalyst" | "rs_continuation";
        inputs: BscScoreInputs;
        tools: string[];
        entryObservations?: SignalObservation[];
      }
      const specs: Spec[] = [];
      for (const quote of quotes.data) {
        const token = loaded.tokens.find((t) => t.symbol === quote.symbol);
        if (!token) continue;
        const momentum = buildMomentumInputs(quote, bnbChange, fg.data, 0.7);
        specs.push({ quote, token, family: "momentum", inputs: momentum.inputs, tools: momentum.toolsUsed });
        if (quote.percentChange24h - bnbChange > 0) {
          const rs = buildRsContinuationInputs(quote, bnbChange, fg.data, 0.7);
          specs.push({
            quote,
            token,
            family: "rs_continuation",
            inputs: rs.inputs,
            tools: rs.toolsUsed,
            entryObservations: recentObservations(signalHistory.get(quote.symbol)!, ENTRY_WINDOW),
          });
        }
      }
      for (const quote of allQuotes) {
        const rank = trendingRankBySymbol.get(quote.symbol);
        if (rank === undefined) continue;
        const token = loaded.tokens.find((t) => t.symbol === quote.symbol);
        if (!token) continue;
        const catalyst = buildCatalystInputs(
          quote,
          { symbol: quote.symbol, cmcId: token.cmcId ?? 0, rank, percentChange24h: quote.percentChange24h },
          fg.data,
          0.7,
        );
        specs.push({
          quote,
          token,
          family: "catalyst",
          inputs: catalyst.inputs,
          tools: catalyst.toolsUsed,
          entryObservations: recentObservations(signalHistory.get(quote.symbol)!, ENTRY_WINDOW),
        });
      }

      // Evaluate every spec against REAL pool reserves + a real shadow-fill.
      const evaluated: Array<{
        result: ReturnType<typeof evaluateCandidate>;
        token: (typeof loaded.tokens)[number];
        tools: string[];
        ts: string;
        price: number;
        atrPct: number;
      }> = [];
      for (const spec of specs) {
        const pool = await resolvePool(spec.token);
        if (!pool) continue;
        const atrPct = Math.max(0.02, Math.abs(spec.quote.percentChange24h) / 100);
        const result = evaluateCandidate(
          {
            symbol: spec.quote.symbol,
            signalFamily: spec.family,
            scoreInputs: spec.inputs,
            cmcToolsUsed: spec.tools,
            marketDataTimestamp: spec.quote.lastUpdated,
            tokenInAddress: usdt.bscContractAddress,
            tokenOutAddress: spec.token.bscContractAddress,
            router: "pancakeswap",
            spender: PANCAKE_V2_ROUTER,
            to: PANCAKE_V2_ROUTER,
            atrPct,
            reserveIn: pool.reserveIn,
            reserveOut: pool.reserveOut,
            poolFeeBps: 25,
            gasPerLegUsd,
            shadow: pool.shadow,
            entryObservations: spec.entryObservations,
          },
          ctx,
        );
        evaluated.push({ result, token: spec.token, tools: spec.tools, ts: spec.quote.lastUpdated, price: spec.quote.priceUsd, atrPct });
      }

      // Forward calibration: record each scored candidate's price so the realized
      // move can be measured once the horizon elapses. Side-channel only — wrapped
      // so a recording fault can never interrupt trading.
      if (process.env.CALIBRATION_COLLECT_ENABLED === "true") {
        try {
          let pendingSamples = loadPendingSamples();
          const scoredAtIso = new Date().toISOString();
          for (const e of evaluated) {
            pendingSamples = recordPending(pendingSamples, {
              symbol: e.token.symbol,
              family: e.result.signalFamily,
              score: e.result.score,
              priceAtScore: e.price,
              scoredAtIso,
            });
          }
          savePendingSamples(pendingSamples);
        } catch (err) {
          console.warn(`[worker] calibration sample recording skipped: ${(err as Error).message}`);
        }
      }

      // Rank approved candidates, then let the scheduler decide whether to attack,
      // hold, or use the last-resort stable-to-stable compliance scout.
      let winner = evaluated
        .filter((e) => e.result.approved)
        .sort((a, b) => b.result.score - a.result.score)[0];
      const now = new Date();
      const hoursLeftInDay =
        (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) / 3_600_000;
      const schedule = decideTradePlan(
        {
          tradesToday: legsOnUtcDay(weekLedger, now.toISOString()),
          tradesThisWeek: weekLedger.legs.length,
          hoursLeftInDay,
          survivalMode: false,
          haveEdgeCandidate: Boolean(winner),
          safeToScout: openPositions.length === 0 && book.walletCashUsd >= config.microScoutUsd,
        },
        config,
      );
      if (schedule.dailyTradeAtRisk) {
        await sendAlert(process.env.ALERT_WEBHOOK_URL, {
          reason: "daily_trade_at_risk",
          message: schedule.reason,
          timestamp: now.toISOString(),
        });
      }
      if (schedule.plan === "hold") winner = undefined;
      if (schedule.plan === "micro_scout") {
        // Alternate direction so the scout reserve round-trips instead of stranding on
        // USDC: out of USDT when we hold USDT, back to USDT when we hold the prior scout's
        // USDC. resolvePool always reports reserves with the USDT side as reserveIn, so we
        // orient them to the chosen swap direction.
        const fromUsdt = scoutHeldStable === "USDT";
        const tokenIn = fromUsdt ? usdt : usdc;
        const tokenOut = fromUsdt ? usdc : usdt;
        const pool = await resolvePool(usdc);
        if (pool) {
          const scoutResult = evaluateCandidate(
            {
              symbol: tokenOut.symbol,
              signalFamily: "momentum",
              scoreInputs: {
                momentum: 0,
                liquiditySafety: 1,
                relativeStrengthVsBnb: 0,
                sentiment: 0,
                volatilitySafety: 1,
                walletRiskState: 1,
              },
              cmcToolsUsed: [],
              marketDataTimestamp: now.toISOString(),
              tokenInAddress: tokenIn.bscContractAddress,
              tokenOutAddress: tokenOut.bscContractAddress,
              router: "pancakeswap",
              spender: PANCAKE_V2_ROUTER,
              to: PANCAKE_V2_ROUTER,
              atrPct: 0.001,
              reserveIn: fromUsdt ? pool.reserveIn : pool.reserveOut,
              reserveOut: fromUsdt ? pool.reserveOut : pool.reserveIn,
              poolFeeBps: 25,
              gasPerLegUsd,
              shadow: pool.shadow,
              isMicroScout: true,
            },
            ctx,
          );
          const scout = {
            result: scoutResult,
            token: tokenOut,
            tools: [] as string[],
            ts: now.toISOString(),
            price: 1,
            atrPct: 0.001,
          };
          evaluated.push(scout);
          winner = scoutResult.approved ? scout : undefined;
        }
      }

      let approved = 0;
      for (const e of evaluated) {
        const isWinner = winner === e;
        const mandate = buildBscMandate({
          result: e.result,
          mode: mode === "live" ? "live" : "rehearsal",
          strategyId: "bsc-two-family",
          naturalLanguageIntent: "Momentum + catalyst over the eligible list, spot only, $40 book.",
          compiledStrategy: {},
          assetContract: e.token.bscContractAddress,
          cmcToolsUsed: e.tools,
          marketDataTimestamp: e.ts,
          calibrationVersion: calibration.version,
          createdAt: new Date().toISOString(),
          id: `${runId}-c${cycles}-${e.result.signalFamily}-${e.token.symbol}`,
          x402Receipt: x402ReceiptId,
          x402Path: x402PathUsed,
        });
        if (e.result.approved) approved++;

        // Live execution: the winner is signed by TWAK (the sole signer).
        // Blocked when x402 is required by config but unavailable/failed this cycle.
        if (isWinner && executor && e.result.intent && x402Blocks) {
          await sendAlert(process.env.ALERT_WEBHOOK_URL, {
            reason: "execution_failure",
            message: `Trade ${e.token.symbol} blocked: x402 required but ${x402Path === "none" ? "no path available" : "payment failed"} this cycle.`,
            timestamp: new Date().toISOString(),
          });
          console.warn(`[worker] ${e.token.symbol} blocked — x402 required but unavailable/failed.`);
        } else if (isWinner && executor && e.result.intent) {
          try {
            // Mark the mandate in-flight BEFORE the submit, then attach the txHash
            // once it returns, so a crash mid-submit leaves a recoverable trace.
            const pendingAction = e.result.signalFamily === "scout" ? "scout" : "entry";
            markPending({ mandateId: mandate.id, status: "pending_build", action: pendingAction });
            const outcome = await executor.execute(e.result.intent, { spentTodayUsd });
            if (outcome.refused) {
              clearPending(mandate.id); // never broadcast — not in-flight
              await sendAlert(process.env.ALERT_WEBHOOK_URL, {
                reason: "twak_refusal",
                message: `TWAK refused ${e.token.symbol}: ${outcome.policy.rejectCode} — ${outcome.policy.reason}`,
                timestamp: new Date().toISOString(),
              });
            } else if (outcome.receipt) {
              markPending({ mandateId: mandate.id, txHash: outcome.receipt.txHash, status: "submitted", action: pendingAction });
              await rememberApprovalSpenders(outcome.receipt.txHash);
              await checkRouterApprovals();
              spentTodayUsd += e.result.economics.positionSizeUsd;
              mandate.execution.status = "submitted";
              mandate.execution.txHash = outcome.receipt.txHash;
              mandate.proofAnchors.bscTxHash = outcome.receipt.txHash;
              mandate.proofAnchors.twakReceipt = outcome.receipt.twakReceiptId;
              const filledAt = new Date().toISOString();
              if (e.result.signalFamily === "scout") {
                if (typeof outcome.receipt.realizedOut !== "number") {
                  requireManualReview({
                    mandateId: mandate.id,
                    txHash: outcome.receipt.txHash,
                    action: "scout",
                    reason: "TWAK submitted the scout without a confirmed realizedOut; do not retry",
                  });
                  await sendAlert(process.env.ALERT_WEBHOOK_URL, {
                    reason: "restart_recovery",
                    message: `Scout ${outcome.receipt.txHash} submitted without confirmed output. Trading halted for manual chain reconciliation.`,
                    timestamp: filledAt,
                  });
                  await appendMandate(mandatesPath, mandate);
                  continue;
                }
                book.walletCashUsd += outcome.receipt.realizedOut - e.result.economics.positionSizeUsd;
                weekLedger = recordLeg(weekLedger, "scout", filledAt);
                // The scout reserve has moved to the other stable; next scout reverses it.
                scoutHeldStable = scoutHeldStable === "USDT" ? "USDC" : "USDT";
                saveScoutHeldStable(scoutHeldStable);
              } else {
                if (typeof outcome.receipt.realizedOut !== "number") {
                  requireManualReview({
                    mandateId: mandate.id,
                    txHash: outcome.receipt.txHash,
                    action: "entry",
                    reason: "TWAK submitted the entry without a confirmed realizedOut; do not retry",
                  });
                  await sendAlert(process.env.ALERT_WEBHOOK_URL, {
                    reason: "restart_recovery",
                    message: `Entry ${outcome.receipt.txHash} submitted without confirmed output. Trading halted for manual chain reconciliation.`,
                    timestamp: filledAt,
                  });
                  await appendMandate(mandatesPath, mandate);
                  continue;
                }
                book.walletCashUsd -= e.result.economics.positionSizeUsd;
                weekLedger = recordLeg(weekLedger, "entry", filledAt);
                if (e.result.pressTrade) weekLedger = consumePressTrade(weekLedger);
                // Open a tracked position so the fast watch loop trails it immediately.
                const trail = initTrailingStop({
                  entryPrice: e.price,
                  atrPct: e.atrPct,
                  realRoundTripBps: e.result.economics.realRoundTripBps ?? e.result.economics.realFrictionBps,
                  config: trailConfig,
                  tightMode: defendTightTrail,
                });
                openPositions.push({
                  mandateId: mandate.id,
                  symbol: e.token.symbol,
                  tokenInAddress: usdt.bscContractAddress,
                  tokenOutAddress: e.token.bscContractAddress,
                  amountTokens: outcome.receipt.realizedOut,
                  notionalUsd: e.result.economics.positionSizeUsd,
                  openedAtIso: filledAt,
                  trail,
                });
                lastPriceMs.set(mandate.id, Date.now());
                saveOpenPositions(openPositions);
              }
              saveBook(book);
              saveWeekLedger(weekLedger);
              markFillRecorded({
                mandateId: mandate.id,
                action: pendingAction,
                txHash: outcome.receipt.txHash,
              });
              await audit.append({
                timestamp: new Date().toISOString(),
                mandateId: mandate.id,
                stage: "execution",
                input: { amountUsd: e.result.economics.positionSizeUsd },
                output: { status: "submitted", txHash: outcome.receipt.txHash },
                proofAnchors: { bscTxHash: outcome.receipt.txHash, twakReceipt: outcome.receipt.twakReceiptId },
              });
              clearPending(mandate.id); // fully recorded — no longer in-flight
              console.log(`[worker] EXECUTED ${e.token.symbol} → tx ${outcome.receipt.txHash}`);
            }
          } catch (err) {
            await sendAlert(process.env.ALERT_WEBHOOK_URL, {
              reason: "execution_failure",
              message: `TWAK execution failed for ${e.token.symbol}: ${(err as Error).message}`,
              timestamp: new Date().toISOString(),
            });
            console.error(`[worker] execution failed for ${e.token.symbol}: ${(err as Error).message}`);
          }
        }

        await appendMandate(mandatesPath, mandate);
      }

      // Hourly snapshot (mirrors the verified hourly scoring). Valued from CMC.
      const hour = new Date().toISOString().slice(0, 13);
      if (hour !== lastSnapshotHour) {
        lastSnapshotHour = hour;
        const holdings: Holding[] = [{ symbol: "USDT", amount: book.walletCashUsd, priceUsd: 1 }];
        for (const pos of openPositions) {
          holdings.push({ symbol: pos.symbol, amount: pos.amountTokens, priceUsd: await fetchTokenPriceUsd(pos) });
        }
        const valueUsd = valueHoldings(holdings);
        const snapPath = join(AUDIT_DIR, `${runId}.snapshots.jsonl`);
        writeFileSync(snapPath, "", { flag: "a" });
        const line = JSON.stringify({ hourIso: `${hour}:00:00.000Z`, valueUsd }) + "\n";
        const fs = await import("node:fs/promises");
        await fs.appendFile(snapPath, line, "utf8");
      }

      console.log(`[worker] cycle ${cycles}: ${approved}/${evaluated.length} approved, gas/leg $${gasPerLegUsd.toFixed(4)} (${mode}).`);
    } catch (err) {
      await sendAlert(process.env.ALERT_WEBHOOK_URL, {
        reason: "execution_failure",
        message: `Cycle ${cycles} error: ${(err as Error).message}`,
        timestamp: new Date().toISOString(),
      });
      console.error(`[worker] cycle ${cycles} error (loop continues):`, (err as Error).message);
    }

    if (maxCycles !== 0 && cycles >= maxCycles) break;
    await sleep(intervalMs);
  }

  console.log(`[worker] stopped after ${cycles} cycle(s). Mandates: ${mandatesPath}`);
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exitCode = 1;
});
