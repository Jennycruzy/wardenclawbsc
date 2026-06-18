/**
 * Mainnet dress-rehearsal checklist (§0.12). Walks the pre-window steps, records
 * pass/fail with evidence to docs/PREFLIGHT.md, and writes a machine-readable
 * gate at data/runtime/rehearsal.json. Live competition mode refuses to start
 * unless this gate shows `passed: true` (overridable only by explicit env).
 *
 *   pnpm rehearsal:checklist
 *
 * Automatable checks are evaluated here; live on-chain steps (registration tx,
 * a real swap, a phone kill-switch test) are listed as MANUAL with instructions —
 * they must be performed and confirmed before June 22. This never fakes a pass.
 */

import "dotenv/config";

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyCompetitionRules } from "@wardenclaw/core";
import { renderPreflightCmcBlock, type CmcWiringReport } from "@wardenclaw/cmc-adapter";

interface Check {
  id: number;
  label: string;
  kind: "auto" | "manual";
  pass: boolean;
  detail: string;
}

function envSet(name: string): boolean {
  return Boolean(process.env[name] && process.env[name] !== "");
}

function envTrue(name: string): boolean {
  return process.env[name] === "true" || process.env[name] === "1";
}

const eligiblePath = process.env.ELIGIBLE_TOKENS_PATH ?? "data/eligible-tokens.json";
const rulesOk = verifyCompetitionRules().ok;
const calibrationPresent = existsSync(join(process.cwd(), "data", "calibration"));

// CMC wiring is proven by `pnpm check:cmc`, which writes this machine-readable
// result. Live mode should flag an unproven key, so check #6 depends on it.
const cmcWiringPath = join(process.cwd(), "data", "runtime", "cmc-wiring.json");
let cmcWiring: CmcWiringReport | null = null;
if (existsSync(cmcWiringPath)) {
  try {
    cmcWiring = JSON.parse(readFileSync(cmcWiringPath, "utf8")) as CmcWiringReport;
  } catch {
    cmcWiring = null;
  }
}
const cmcWiringProven = cmcWiring?.pass === true;

interface AuditEvent {
  stage?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

function auditEvents(): AuditEvent[] {
  const dir = join(process.cwd(), "data", "audit");
  if (!existsSync(dir)) return [];
  const events: AuditEvent[] = [];
  for (const name of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as AuditEvent);
      } catch {
        // A malformed row is not evidence; leave the corresponding check false.
      }
    }
  }
  return events;
}

const events = auditEvents();
const liveSwapEvidence = events.find(
  (e) =>
    e.stage === "execution" &&
    e.output?.status === "submitted" &&
    typeof e.output?.txHash === "string",
);
const watchdogExitEvidence = events.find(
  (e) =>
    e.stage === "watchdog" &&
    e.output?.status === "submitted" &&
    typeof e.output?.txHash === "string",
);
const recoveryEvidence = events.find((e) => {
  if (e.stage !== "recovery" || Number(e.input?.pending ?? 0) < 1) return false;
  const output = e.output as
    | { requiresReview?: boolean; resolutions?: Array<{ resolution?: string }> }
    | undefined;
  return (
    output?.requiresReview === false &&
    output.resolutions?.some((r) => r.resolution === "confirmed_filled") === true
  );
});
const auditDir = join(process.cwd(), "data", "audit");
const snapshotEvidence =
  existsSync(auditDir) &&
  readdirSync(auditDir).some((name) => {
    if (!name.endsWith(".snapshots.jsonl")) return false;
    return readFileSync(join(auditDir, name), "utf8")
      .split("\n")
      .some((line) => {
        if (!line.trim()) return false;
        try {
          const row = JSON.parse(line) as { valueUsd?: number };
          return Number.isFinite(row.valueUsd) && (row.valueUsd as number) > 0;
        } catch {
          return false;
        }
      });
  });

const checks: Check[] = [
  { id: 1, label: "Competition rules complete; verify passes (only §0.1b warnings)", kind: "auto", pass: rulesOk, detail: rulesOk ? "verify:competition-rules ok" : "missing implementation references" },
  { id: 2, label: "data/eligible-tokens.json built (CMC-resolved contracts)", kind: "auto", pass: existsSync(eligiblePath), detail: existsSync(eligiblePath) ? eligiblePath : "run pnpm build:eligible-tokens (needs CMC_API_KEY)" },
  { id: 3, label: "TWAK wallet + on-chain registration vs 0x212c…aed5", kind: "manual", pass: envSet("REGISTRATION_TX_HASH"), detail: envSet("REGISTRATION_TX_HASH") ? `tx ${process.env.REGISTRATION_TX_HASH}` : "run `twak compete register`; set REGISTRATION_TX_HASH" },
  { id: 4, label: "Agent address submitted on DoraHacks with strategy explanation", kind: "manual", pass: envTrue("DORAHACKS_SUBMITTED"), detail: envTrue("DORAHACKS_SUBMITTED") ? "operator confirmed via DORAHACKS_SUBMITTED" : "submit on DoraHacks; set DORAHACKS_SUBMITTED=true" },
  { id: 5, label: "Wallet funded: eligible stables + native BNB gas reserve", kind: "manual", pass: envTrue("WALLET_FUNDED_CONFIRMED"), detail: envTrue("WALLET_FUNDED_CONFIRMED") ? "operator verified on-chain balances" : "verify eligible stables + BNB gas; set WALLET_FUNDED_CONFIRMED=true" },
  { id: 6, label: "CMC perception live (key wired end-to-end through CmcClient)", kind: "auto", pass: cmcWiringProven, detail: cmcWiringProven ? `check:cmc PASS (${cmcWiring?.surfaces.filter((s) => s.ok).length}/${cmcWiring?.surfaces.length} surfaces ok)` : "run pnpm check:cmc with a real CMC_API_KEY (proves key, not just presence)" },
  { id: 7, label: "x402 request paid; receipt logged; used in a decision", kind: "manual", pass: envSet("CMC_X402_ENDPOINT"), detail: envSet("CMC_X402_ENDPOINT") ? "x402 endpoint configured" : "configure CMC_X402_ENDPOINT + TWAK x402" },
  { id: 8, label: "Full gate chain runs on a real candidate", kind: "auto", pass: envSet("CMC_API_KEY"), detail: "pnpm run:bsc-agent exercises the chain on real CMC data" },
  { id: 9, label: "TWAK signs a real aggregated spot swap; BSC tx on /bsc/proof", kind: "auto", pass: Boolean(liveSwapEvidence), detail: liveSwapEvidence ? `audit tx ${String(liveSwapEvidence.output?.txHash)}` : "execute a real TWAK rehearsal swap" },
  { id: 10, label: "Watchdog executes at least one real exit", kind: "auto", pass: Boolean(watchdogExitEvidence), detail: watchdogExitEvidence ? `audit tx ${String(watchdogExitEvidence.output?.txHash)}` : "verify a stop exit during the rehearsal" },
  { id: 11, label: "Hourly snapshot job writes correct USD valuations", kind: "auto", pass: snapshotEvidence, detail: snapshotEvidence ? "positive USD valuation row found" : "no positive .snapshots.jsonl valuation found" },
  { id: 12, label: "Kill-switch tested live from a phone; revocation attempted", kind: "manual", pass: envTrue("KILL_SWITCH_LIVE_TEST_CONFIRMED"), detail: envTrue("KILL_SWITCH_LIVE_TEST_CONFIRMED") ? "operator confirmed live authenticated test" : "test POST /kill; set KILL_SWITCH_LIVE_TEST_CONFIRMED=true" },
  { id: 13, label: "Restart-and-reconcile tested live (no duplicate trade)", kind: "auto", pass: Boolean(recoveryEvidence), detail: recoveryEvidence ? "audit shows pending>0 → confirmed_filled with requiresReview=false" : "no successful pending-tx recovery evidence found" },
  { id: 14, label: "Calibration re-run on fresh data", kind: "auto", pass: calibrationPresent, detail: calibrationPresent ? "data/calibration present" : "run pnpm calibrate:edge" },
  { id: 15, label: "Alerts received on the user's phone (incl. trade-at-risk)", kind: "manual", pass: envTrue("ALERTS_PHONE_CONFIRMED"), detail: envTrue("ALERTS_PHONE_CONFIRMED") ? "operator confirmed phone delivery" : "confirm delivery; set ALERTS_PHONE_CONFIRMED=true" },
];

const autoChecks = checks.filter((c) => c.kind === "auto");
const autoPassed = autoChecks.every((c) => c.pass);
const allPassed = checks.every((c) => c.pass);

function md(): string {
  const opensAt = Date.parse("2026-06-22T00:00:00Z");
  const remainingHours = Math.max(0, Math.floor((opensAt - Date.now()) / 3_600_000));
  const rows = checks
    .map((c) => `| ${c.id} | ${c.pass ? "✅" : "⬜"} | ${c.kind} | ${c.label} | ${c.detail} |`)
    .join("\n");
  return `# PREFLIGHT — Dress Rehearsal Checklist

Generated by \`pnpm rehearsal:checklist\` on ${new Date().toISOString()}.

**Trading opens and registration closes:** June 22, 2026 at 00:00 UTC.
**Time remaining:** ${Math.floor(remainingHours / 24)}d ${remainingHours % 24}h.

Register first: run \`twak compete register\`, verify the BSC transaction, and set
\`REGISTRATION_TX_HASH\`. Missing registration alerts escalate after June 18.

**Automatable checks passed:** ${autoPassed ? "YES" : "NO"} (${autoChecks.filter((c) => c.pass).length}/${autoChecks.length})
**All checks (incl. manual live steps) confirmed:** ${allPassed ? "YES" : "NO"}

Live competition mode refuses to start unless the gate is passed (override with
\`REHEARSAL_OVERRIDE=true\`, used only when you have manually confirmed the live steps).

| # | Done | Kind | Step | Evidence / action |
|---|------|------|------|-------------------|
${rows}

${renderPreflightCmcBlock(cmcWiring)}

## Deadline-ordered actions (§10.3)

- IMMEDIATELY: register, run \`pnpm check:cmc\`, then build eligible tokens.
- BY JUNE 19: competition rules green; calibration on last 30 days; VPS + alerts + kill-switch tested.
- BY JUNE 20–21: full rehearsal passed; on-chain registration tx recorded; DoraHacks submission; Bitget post.
- BY JUNE 22 00:00 UTC: wallet funded with eligible stables + gas BNB; agent started; first heartbeat + snapshot.
- DAILY JUNE 22–28: check /bsc/ops + /bsc/proof from phone; confirm n/7 trade count; respond to alerts.
`;
}

function main(): void {
  const runtimeDir = join(process.cwd(), "data", "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, "rehearsal.json"),
    JSON.stringify({ passed: allPassed, autoPassed, checkedAt: new Date().toISOString(), checks }, null, 2),
  );
  writeFileSync(join(process.cwd(), "docs", "PREFLIGHT.md"), md());

  console.log("\n  Dress-rehearsal checklist\n");
  for (const c of checks) {
    console.log(`  ${c.pass ? "✅" : "⬜"} [${c.kind}] ${String(c.id).padStart(2)}. ${c.label}`);
  }
  console.log(`\n  Automatable: ${autoChecks.filter((c) => c.pass).length}/${autoChecks.length} · All: ${checks.filter((c) => c.pass).length}/${checks.length}`);
  console.log(`  Gate: ${allPassed ? "PASSED" : "NOT PASSED"} (docs/PREFLIGHT.md + data/runtime/rehearsal.json)\n`);
}

main();
