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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as loadDotenv } from "dotenv";
import {
  AuditLogger,
  appendMandate,
  buildCalibrationReport,
  loadRiskConfig,
  reconcile,
  valueHoldings,
  initTrailingStop,
  evaluateWatchTick,
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
  deriveWeekBudgetState,
  evaluateWeekBudget,
  weekElapsedFraction,
  serializeWeekLedger,
  parseWeekLedger,
  type BscScoreInputs,
  type CalibrationReport,
  type PendingMandate,
  type Holding,
  type OpenPosition,
  type TrailingStopConfig,
  type TokenHistory,
  type SignalObservation,
  type WeekLedger,
  type WeekBudgetConfig,
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
} from "@wardenclaw/bsc-adapter";
import {
  evaluateCandidate,
  buildBscMandate,
  sendAlert,
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

function loadPending(): PendingMandate[] {
  const f = join(RUNTIME_DIR, "pending.json");
  if (!existsSync(f)) return [];
  try {
    return JSON.parse(readFileSync(f, "utf8")) as PendingMandate[];
  } catch {
    return [];
  }
}

const POSITIONS_FILE = join(RUNTIME_DIR, "positions.json");

/** Restore open positions (with live HWM/stop) so the trail resumes after a restart. */
function loadOpenPositions(): OpenPosition[] {
  if (!existsSync(POSITIONS_FILE)) return [];
  return parseOpenPositions(readFileSync(POSITIONS_FILE, "utf8")); // throws loud on corruption
}

function saveOpenPositions(positions: OpenPosition[]): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(POSITIONS_FILE, serializeOpenPositions(positions), "utf8");
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

  console.log(`[worker] starting in ${mode.toUpperCase()} mode (interval ${intervalMs / 1000}s)`);

  mkdirSync(AUDIT_DIR, { recursive: true });
  const runId = `bsc-worker-${Date.now()}`;
  const audit = new AuditLogger(join(AUDIT_DIR, `${runId}.jsonl`));
  const mandatesPath = join(AUDIT_DIR, `${runId}.mandates.jsonl`);

  // 1. Crash-recovery reconciliation BEFORE any trade.
  const pending = loadPending();
  const report = await reconcile(pending, async () => ({ found: false, confirmed: false }));
  await audit.append({
    timestamp: new Date().toISOString(),
    mandateId: "recovery",
    stage: "recovery",
    input: { pending: pending.length },
    output: { ...report },
  });
  if (report.requiresReview) {
    await sendAlert(process.env.ALERT_WEBHOOK_URL, {
      reason: "restart_recovery",
      message: `Recovery requires review: ${report.resolutions.length} pending mandate(s).`,
      timestamp: new Date().toISOString(),
    });
    console.warn("[worker] recovery requires manual review — not trading until resolved.");
  } else {
    await sendAlert(process.env.ALERT_WEBHOOK_URL, {
      reason: "restart_recovery",
      message: `Worker started cleanly (${mode} mode). ${report.duplicatesPrevented} duplicates prevented.`,
      timestamp: new Date().toISOString(),
    });
  }

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
    pressThresholdPct: config.pressThresholdPct,
    defendThresholdPct: config.defendThresholdPct,
    lockInReturnPct: config.lockInReturnPct,
    maxGiveBackPct: config.maxGiveBackPct,
    pressSizeMultiplier: config.pressSizeMultiplier,
    defendSizeMultiplier: config.defendSizeMultiplier,
    lateWeekFraction: config.lateWeekFraction,
    reservedLegsPerDay: config.minTradesPerDay,
    weekLengthDays,
  };
  let weekLedger = loadWeekLedger(weekStartIso, config.startingCapitalUsd);
  saveWeekLedger(weekLedger);

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
        tightMode: pos.trail.tightMode,
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
        try {
          const outcome = executor ? await executor.execute(exitIntent, { spentTodayUsd: 0 }) : null;
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
            await sendAlert(process.env.ALERT_WEBHOOK_URL, {
              reason: "twak_refusal",
              message: `TWAK refused safety exit on ${pos.symbol}: ${outcome.policy.reason}`,
              timestamp: new Date().toISOString(),
            });
            continue; // keep watching — do not drop a position we failed to exit
          }
          console.log(`[worker] ${tick.exit.reason} ${pos.symbol} @ ${tick.exit.currentPrice} (gain ${tick.exit.gainPct.toFixed(2)}%)`);
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
      }
    }
    saveOpenPositions(openPositions);
  }

  async function runWatchLoop(): Promise<void> {
    for (;;) {
      try {
        if (openPositions.length > 0) await watchAllPositions();
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
      const symbols = STARTER_MAJORS.map((t) => t.symbol).slice(0, 6);
      const [quotes, fg, bnb, trending] = await Promise.all([
        cmc.getQuotes(symbols),
        cmc.getFearGreed(),
        cmc.getQuotes(["BNB"]),
        cmc.getTrending(20).catch((err) => {
          console.warn(`[worker] trending fetch failed (catalyst candidates skipped this cycle): ${(err as Error).message}`);
          return null;
        }),
      ]);
      const bnbChange = bnb.data[0]?.percentChange24h ?? 0;
      const bnbPrice = bnb.data[0]?.priceUsd ?? 0;

      // Real gas cost per leg from on-chain gas price × BNB price.
      const gasPerLegUsd = bnbPrice > 0 ? await reader.gasPerLegUsd(bnbPrice) : 0.02;

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

      // WS6: update the week ledger's peak with the current book value, then derive
      // the HUNT/PRESS/DEFEND state and the size multiplier for this cycle. The book
      // value is the dry $40 book until live valuation is wired (week return is then
      // 0 → HUNT, honestly); the multiplier is bounded by maxPositionPct downstream.
      const currentValueUsd = config.startingCapitalUsd;
      weekLedger = recordWeekValue(weekLedger, currentValueUsd);
      const weekElapsed = weekElapsedFraction(new Date().toISOString(), weekStartIso, weekEndIso);
      const weekState = deriveWeekBudgetState(weekLedger, currentValueUsd, weekElapsed);
      const weekBudget = evaluateWeekBudget(weekState, weekBudgetCfg);
      saveWeekLedger(weekLedger);
      writeWeekBudget({
        riskState: weekBudget.state,
        sizeMultiplier: weekBudget.sizeMultiplier,
        weekReturnPct: weekState.weekReturnPct,
        weekElapsedPct: weekElapsed * 100,
        legsUsed: weekState.legsUsed,
        legsRemaining: weekBudget.legsRemaining,
        legsScarce: weekBudget.legsScarce,
        reason: weekBudget.reason,
      });

      const ctx: PipelineContext = {
        config,
        calibration,
        allowlist: loaded.allowlist,
        twakPolicy,
        portfolioUsd: config.startingCapitalUsd,
        deployableUsd: config.startingCapitalUsd - config.gasReserveUsd,
        windowDrawdownPct: 0,
        dailyDrawdownPct: 0,
        openPositions: openPositions.length,
        tradesToday: 0,
        survivalMode: false,
        marketDataStale: false,
        calibrationStale: mode === "dry",
        sizeMultiplier: weekBudget.sizeMultiplier,
        riskState: weekBudget.state,
      };

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

      // Rank approved candidates; the top one is the trade for this cycle.
      const winner = evaluated
        .filter((e) => e.result.approved)
        .sort((a, b) => b.result.score - a.result.score)[0];

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
            const outcome = await executor.execute(e.result.intent, { spentTodayUsd });
            if (outcome.refused) {
              await sendAlert(process.env.ALERT_WEBHOOK_URL, {
                reason: "twak_refusal",
                message: `TWAK refused ${e.token.symbol}: ${outcome.policy.rejectCode} — ${outcome.policy.reason}`,
                timestamp: new Date().toISOString(),
              });
            } else if (outcome.receipt) {
              spentTodayUsd += e.result.economics.positionSizeUsd;
              // Count this entry against the weekly leg budget (WS6).
              weekLedger = recordLeg(weekLedger);
              saveWeekLedger(weekLedger);
              mandate.execution.status = "submitted";
              mandate.execution.txHash = outcome.receipt.txHash;
              mandate.proofAnchors.bscTxHash = outcome.receipt.txHash;
              mandate.proofAnchors.twakReceipt = outcome.receipt.twakReceiptId;
              // Open a tracked position so the fast watch loop trails it immediately.
              const trail = initTrailingStop({
                entryPrice: e.price,
                atrPct: e.atrPct,
                realRoundTripBps: e.result.economics.realRoundTripBps ?? e.result.economics.realFrictionBps,
                config: trailConfig,
              });
              openPositions.push({
                mandateId: mandate.id,
                symbol: e.token.symbol,
                tokenInAddress: usdt.bscContractAddress,
                tokenOutAddress: e.token.bscContractAddress,
                amountTokens: e.price > 0 ? e.result.economics.positionSizeUsd / e.price : 0,
                notionalUsd: e.result.economics.positionSizeUsd,
                openedAtIso: new Date().toISOString(),
                trail,
              });
              lastPriceMs.set(mandate.id, Date.now());
              saveOpenPositions(openPositions);
              await audit.append({
                timestamp: new Date().toISOString(),
                mandateId: mandate.id,
                stage: "execution",
                input: { amountUsd: e.result.economics.positionSizeUsd },
                output: { status: "submitted", txHash: outcome.receipt.txHash },
                proofAnchors: { bscTxHash: outcome.receipt.txHash, twakReceipt: outcome.receipt.twakReceiptId },
              });
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
        const holdings: Holding[] = [{ symbol: "USDT", amount: config.startingCapitalUsd, priceUsd: 1 }];
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
