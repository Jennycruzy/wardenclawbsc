/**
 * CMC Pro key end-to-end wiring check.
 *
 *   pnpm check:cmc
 *
 * Proves the CMC key is actually plumbed through the agent's own CmcClient — not
 * merely present in env. Makes one real authenticated call per surface the live
 * pipeline depends on (quotes, trending, Fear & Greed, symbol→contract info),
 * reports per-surface OK/FAIL + latency, and does a no-spend x402 reachability
 * probe. Writes a machine-readable result to data/runtime/cmc-wiring.json (the
 * rehearsal checklist reads it) and updates the CMC block in docs/PREFLIGHT.md.
 *
 * Exits non-zero on a missing/placeholder key or any required-surface failure —
 * better to learn now than during the live window. Never trades, never signs.
 */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkCmcWiring,
  renderWiringReport,
  renderPreflightCmcBlock,
  upsertPreflightCmcBlock,
} from "@wardenclaw/cmc-adapter";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_DIR = join(repoRoot, "data", "runtime");
const PREFLIGHT = join(repoRoot, "docs", "PREFLIGHT.md");

async function main(): Promise<void> {
  console.log("Checking CMC key end-to-end wiring (real calls through CmcClient)…\n");
  const report = await checkCmcWiring({ env: process.env });

  for (const line of renderWiringReport(report)) console.log(line);

  // Persist machine-readable result for the rehearsal gate.
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(join(RUNTIME_DIR, "cmc-wiring.json"), JSON.stringify(report, null, 2), "utf8");

  // Update the CMC block in PREFLIGHT.md (idempotent; rehearsal reads the same json).
  if (existsSync(PREFLIGHT)) {
    const updated = upsertPreflightCmcBlock(readFileSync(PREFLIGHT, "utf8"), renderPreflightCmcBlock(report));
    writeFileSync(PREFLIGHT, updated, "utf8");
    console.log(`\nUpdated ${PREFLIGHT.replace(repoRoot + "/", "")} (CMC wiring block).`);
  }

  if (!report.keyPresent || report.keyPlaceholder) process.exit(1);
  process.exit(report.pass ? 0 : 1);
}

main().catch((err) => {
  console.error(`✗ check:cmc failed: ${(err as Error).message}`);
  process.exit(1);
});
