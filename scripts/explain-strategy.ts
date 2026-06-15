/**
 * Auto-draft the DoraHacks strategy explanation FROM THE LIVE AUDIT TRAIL.
 *
 *   pnpm explain:strategy
 *
 * Reads the real ledgers and audit logs the agent wrote (data/runtime + data/audit),
 * builds a deterministic factual digest, and narrates it with the
 * STRATEGY_EXPLANATION LLM role. With no LLM key it still emits a deterministic,
 * template-filled write-up — so there is always something to submit. Writes:
 *   docs/STRATEGY_EXPLANATION.md   (paste-ready Markdown)
 *   docs/STRATEGY_EXPLANATION.json (raw structured object + digest)
 *
 * Never trades, never signs. The LLM only narrates facts already in the digest.
 */
import "dotenv/config";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRoleProvider,
  draftStrategyExplanation,
  renderExplanationMarkdown,
  parseMandate,
  parseWeekLedger,
  resolveRoleModel,
  type AuditEvent,
  type ExplanationInputs,
  type RegimePoint,
  type ScoredLedgerSummary,
  type SignalMandate,
  type TrailingExitRecord,
  type WeekLedger,
  type WeekStateTransition,
} from "@wardenclaw/core";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_DIR = join(repoRoot, "data", "runtime");
const AUDIT_DIR = join(repoRoot, "data", "audit");
const DOCS_DIR = join(repoRoot, "docs");

function tryRead<T>(label: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    console.warn(`  · skipped ${label}: ${(err as Error).message}`);
    return undefined;
  }
}

function loadWeekLedger(): WeekLedger | undefined {
  const f = join(RUNTIME_DIR, "weekLedger.json");
  if (!existsSync(f)) return undefined;
  return tryRead("weekLedger.json", () => parseWeekLedger(readFileSync(f, "utf8")));
}

function loadBook(): { walletCashUsd: number; scoredValueUsd: number } | undefined {
  const f = join(RUNTIME_DIR, "book.json");
  if (!existsSync(f)) return undefined;
  return tryRead("book.json", () => JSON.parse(readFileSync(f, "utf8")));
}

function loadRegimePoints(): RegimePoint[] {
  const f = join(RUNTIME_DIR, "regime.json");
  if (!existsSync(f)) return [];
  const state = tryRead("regime.json", () => JSON.parse(readFileSync(f, "utf8"))) as
    | { regime?: string; current?: string; history?: Array<{ regime?: string; timestamp?: string }> }
    | undefined;
  if (!state) return [];
  if (Array.isArray(state.history)) {
    return state.history
      .filter((h) => typeof h.regime === "string")
      .map((h) => ({ regime: h.regime as string, timestamp: h.timestamp }));
  }
  const current = state.regime ?? state.current;
  return current ? [{ regime: current }] : [];
}

function loadAuditEvents(): AuditEvent[] {
  if (!existsSync(AUDIT_DIR)) return [];
  const events: AuditEvent[] = [];
  for (const file of readdirSync(AUDIT_DIR)) {
    if (!file.endsWith(".jsonl")) continue;
    if (file.endsWith(".mandates.jsonl") || file.endsWith(".snapshots.jsonl")) continue;
    const raw = tryRead(file, () => readFileSync(join(AUDIT_DIR, file), "utf8"));
    if (!raw) continue;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as AuditEvent);
      } catch {
        /* skip a malformed line rather than abort the whole draft */
      }
    }
  }
  return events;
}

function loadMandates(): SignalMandate[] {
  if (!existsSync(AUDIT_DIR)) return [];
  const mandates: SignalMandate[] = [];
  for (const file of readdirSync(AUDIT_DIR)) {
    if (!file.endsWith(".mandates.jsonl")) continue;
    const raw = tryRead(file, () => readFileSync(join(AUDIT_DIR, file), "utf8"));
    if (!raw) continue;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const mandate = tryRead(`${file} mandate`, () => parseMandate(JSON.parse(line)));
      if (mandate) mandates.push(mandate);
    }
  }
  return mandates;
}

function loadWeekStateTransitions(): WeekStateTransition[] {
  const file = join(RUNTIME_DIR, "week-budget.json");
  if (!existsSync(file)) return [];
  const snapshot = tryRead("week-budget.json", () =>
    JSON.parse(readFileSync(file, "utf8")) as {
      riskState?: string;
      generatedAt?: string;
    },
  );
  return snapshot?.riskState
    ? [{ state: snapshot.riskState, timestamp: snapshot.generatedAt }]
    : [];
}

function trailingExitsFromAudit(events: AuditEvent[]): TrailingExitRecord[] {
  return events
    .filter((event) => event.stage === "watchdog")
    .map((event) => ({
      mandateId: event.mandateId,
      reason:
        typeof event.input.reason === "string"
          ? event.input.reason
          : "watchdog exit recorded",
    }));
}

function main(): void {
  console.log("Drafting strategy explanation from the audit trail…");

  const weekLedger = loadWeekLedger();
  const book = loadBook();
  const regimeHistory = loadRegimePoints();
  const auditEvents = loadAuditEvents();
  const mandateLog = loadMandates();

  // Derive a scored-ledger summary from the persisted book vs. the week start.
  let scored: ScoredLedgerSummary | undefined;
  if (book && weekLedger && weekLedger.startValueUsd > 0) {
    const cumulativeReturnUsd = book.scoredValueUsd - weekLedger.startValueUsd;
    scored = {
      tradeCount: weekLedger.legs.filter((l) => l.kind === "entry").length,
      cumulativeReturnUsd,
      cumulativeReturnBps: (cumulativeReturnUsd / weekLedger.startValueUsd) * 10_000,
    };
  }

  const inputs: ExplanationInputs = {
    weekLedger,
    scored,
    regimeHistory,
    auditEvents,
    mandateLog,
    weekStateTransitions: loadWeekStateTransitions(),
    trailingExits: trailingExitsFromAudit(auditEvents),
    walletValueUsd: book?.walletCashUsd,
  };

  const resolved = resolveRoleModel("STRATEGY_EXPLANATION", process.env);
  console.log(
    `  · role=STRATEGY_EXPLANATION provider=${resolved.provider} model=${resolved.model ?? "(disabled)"} (${resolved.source})`,
  );
  const provider = createRoleProvider("STRATEGY_EXPLANATION", process.env);

  draftStrategyExplanation(inputs, provider)
    .then(({ explanation, digest, source }) => {
      mkdirSync(DOCS_DIR, { recursive: true });
      const md = renderExplanationMarkdown(explanation, digest, source);
      writeFileSync(join(DOCS_DIR, "STRATEGY_EXPLANATION.md"), md, "utf8");
      writeFileSync(
        join(DOCS_DIR, "STRATEGY_EXPLANATION.json"),
        JSON.stringify({ source, explanation, digest }, null, 2),
        "utf8",
      );
      console.log(`  · digest: ${digest.legCount} legs, ${digest.knownMandateIds.length} mandates, empty=${digest.empty}`);
      console.log(`✅ wrote docs/STRATEGY_EXPLANATION.md and .json (source: ${source})`);
      if (source === "template") {
        console.log("   (LLM disabled or unavailable — deterministic template used.)");
      }
    })
    .catch((err) => {
      console.error(`✗ explain:strategy failed: ${(err as Error).message}`);
      process.exit(1);
    });
}

main();
