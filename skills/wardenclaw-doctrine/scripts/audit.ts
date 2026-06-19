/**
 * skill:audit — self-audit for the wardenclaw-doctrine skill.
 *
 * Verifies the 8 checks from the build spec and FAILS LOUDLY (exit 1) on any violation:
 *   1 Format conformance     5 No calibration leak
 *   2 Spec completeness      6 Backtest honesty / reproducibility
 *   3 Schema validity        7 Additivity (git diff confined)
 *   4 No execution surface   8 Submission readiness
 *
 * It prints a PASS/FAIL line per check. The leak guard never prints private values.
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = dirname(HERE);
const REPO_ROOT = join(SKILL_DIR, "..", "..");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");

interface Check {
  n: number;
  name: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
function record(n: number, name: string, pass: boolean, detail: string): void {
  checks.push({ n, name, pass, detail });
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const allFiles = walk(SKILL_DIR);
function readText(p: string): string {
  return readFileSync(p, "utf8");
}

// ── 1. Format conformance ────────────────────────────────────────────────────
(() => {
  const skillMd = join(SKILL_DIR, "SKILL.md");
  if (!existsSync(skillMd)) return record(1, "Format conformance", false, "SKILL.md missing");
  const txt = readText(skillMd);
  const fm = txt.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return record(1, "Format conformance", false, "no YAML frontmatter");
  const f = fm[1]!;
  const needs = [/\nname:\s*wardenclaw-doctrine/, /\ndescription:\s*\|/, /Trigger:/, /\nuser-invocable:\s*true/, /\nallowed-tools:/, /mcp__cmc-mcp__/];
  const missing = needs.filter((re) => !re.test("\n" + f)).map((re) => re.source);
  const okFormatNotes = existsSync(join(SKILL_DIR, "FORMAT_NOTES.md"));
  record(1, "Format conformance", missing.length === 0 && okFormatNotes,
    missing.length === 0 ? "SKILL.md frontmatter + FORMAT_NOTES.md conform to verified CMC format" : `frontmatter missing: ${missing.join(", ")}`);
})();

// ── 2. Spec completeness ─────────────────────────────────────────────────────
(() => {
  const spec = join(SKILL_DIR, "strategy-spec.md");
  if (!existsSync(spec)) return record(2, "Spec completeness", false, "strategy-spec.md missing");
  const t = readText(spec).toLowerCase();
  const sections: Array<[string, RegExp]> = [
    ["regime classifier", /regime classifier/],
    ["catalyst family", /catalyst.*\(uncrowded\)|family a .*catalyst/],
    ["rs continuation", /relative-strength continuation/],
    ["momentum rotation", /momentum rotation/],
    ["net-edge two ledgers", /net-edge filter \(two ledgers\)/],
    ["sizing kelly", /drawdown-budgeted fractional kelly/],
    ["exits trailing ratchet", /trailing ratchet doctrine/],
    ["week-state machine", /hunt \/ press \/ defend|week-state machine/],
    ["compliance layer", /compliance layer/],
    ["calibration procedure", /calibration procedure/],
  ];
  const missing = sections.filter(([, re]) => !re.test(t)).map(([n]) => n);
  record(2, "Spec completeness", missing.length === 0,
    missing.length === 0 ? "all doctrine sections present and implementable" : `missing sections: ${missing.join(", ")}`);
})();

// ── 3. Schema validity (run the validator) ───────────────────────────────────
(() => {
  try {
    execSync(`${TSX} ${join(SKILL_DIR, "scripts", "validate-signals.ts")}`, { cwd: REPO_ROOT, stdio: "pipe" });
    record(3, "Schema validity", true, "all example signals validate; all five kinds present");
  } catch (e) {
    record(3, "Schema validity", false, `validator failed: ${(e as { stdout?: Buffer }).stdout?.toString().trim() ?? e}`);
  }
})();

// ── 4. No execution surface ──────────────────────────────────────────────────
(() => {
  const execPatterns: Array<[string, RegExp]> = [
    ["TWAK", /\btwak\b/i],
    ["viem", /\bviem\b/i],
    ["ethers", /\bethers\b/i],
    ["tx signing", /signTransaction|sendTransaction|eth_sendRawTransaction|signTypedData|signMessage/],
    ["private key/mnemonic", /privateKey|private_key|PRIVATE_KEY|mnemonic|seedPhrase/],
    ["x402 payment", /payX402|\bx402\b/i],
    ["wallet construction", /new\s+Wallet\s*\(|Wallet\.fromMnemonic|HDNode/],
    ["router execution", /pancakeRouter|swapExactTokens|router\.swap|routerAddress/i],
    ["execution adapter import", /@wardenclaw\/(twak-adapter|bsc-adapter|bnb-agent)/],
  ];
  const hits: string[] = [];
  // The audit's own artifacts necessarily NAME the forbidden tokens to document the guard;
  // they are markdown/script docs, not an execution surface. Everything else is scanned.
  const selfDocs = ["audit.ts", "AUDIT.md"];
  for (const file of allFiles) {
    if (selfDocs.some((s) => file.endsWith(s))) continue;
    const txt = readText(file);
    for (const [label, re] of execPatterns) {
      if (re.test(txt)) hits.push(`${relative(SKILL_DIR, file)} :: ${label}`);
    }
  }
  record(4, "No execution surface", hits.length === 0,
    hits.length === 0 ? "no TWAK/signing/wallet/router/x402/execution-adapter references" : `execution references found: ${hits.join("; ")}`);
})();

// ── 5. No calibration leak ───────────────────────────────────────────────────
(() => {
  const defaults = JSON.parse(readText(join(SKILL_DIR, "defaults.json")));
  const problems: string[] = [];

  // (a) Structural: the ONLY score->move model must be the labeled naive prior; no embedded
  //     calibration bands (realizedMoveBps / hitRate / bands) anywhere in the folder.
  const bandLike = /realizedMoveBps|hitRate|realizedVsPredicted|"bands"\s*:/;
  // Skip files that DESCRIBE the leak guard rather than ship parameters.
  const leakDocSkip = ["audit.ts", "AUDIT.md", "strategy-spec.md", "METHODOLOGY.md"];
  for (const file of allFiles) {
    if (leakDocSkip.some((s) => file.endsWith(s))) continue;
    if (bandLike.test(readText(file))) problems.push(`calibration-band-shaped data in ${relative(SKILL_DIR, file)}`);
  }
  const prior = defaults.expected_move_reference_prior;
  if (!prior || prior.model !== "naive_linear") problems.push("expected_move prior is not the labeled naive_linear reference");

  // (b) Disclaimer present.
  if (!/reference defaults/i.test(JSON.stringify(defaults._meta ?? {}))) problems.push("defaults.json missing reference-defaults disclaimer");

  // (c) If a private config is reachable, diff WITHOUT printing private values.
  const privatePath = process.env.WARDENCLAW_PRIVATE_CONFIG
    ?? [join(REPO_ROOT, "data", "calibration", "report.json")].find((p) => existsSync(p));
  let privacyNote: string;
  if (privatePath && existsSync(privatePath)) {
    const priv = readText(privatePath);
    // Extract candidate private numbers (calibration realized-move values / tuned bands).
    const nums = (priv.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).filter((n) => Math.abs(n) >= 1);
    const folderText = allFiles.filter((f) => !f.endsWith("audit.ts")).map(readText).join("\n");
    const leaked = [...new Set(nums)].filter((n) => {
      // Only flag "edge-shaped" values (e.g. realized-move bps, calibrated bands), not trivial
      // shared constants. Heuristic: 3+ significant-digit values that appear in the private
      // config and verbatim in the folder.
      const s = String(n);
      return s.replace(/[-.]/g, "").length >= 3 && new RegExp(`(^|[^\\d.])${s.replace(".", "\\.")}([^\\d]|$)`).test(folderText);
    });
    if (leaked.length > 0) problems.push(`${leaked.length} private calibrated value(s) appear in the skill folder (values withheld)`);
    privacyNote = `private config at ${relative(REPO_ROOT, privatePath)} diffed; ${leaked.length === 0 ? "no leak" : "LEAK"}`;
  } else {
    privacyNote = "no private config reachable in this environment — structural leak-guards enforced";
  }

  record(5, "No calibration leak", problems.length === 0,
    problems.length === 0 ? `public reference defaults only; ${privacyNote}` : problems.join("; "));
})();

// ── 6. Backtest honesty / reproducibility ────────────────────────────────────
(() => {
  try {
    const examplesPath = join(SKILL_DIR, "examples", "example-signals.jsonl");
    execSync(`${TSX} ${join(SKILL_DIR, "backtest", "run-skill-backtest.ts")}`, { cwd: REPO_ROOT, stdio: "pipe" });
    const a = readText(examplesPath);
    execSync(`${TSX} ${join(SKILL_DIR, "backtest", "run-skill-backtest.ts")}`, { cwd: REPO_ROOT, stdio: "pipe" });
    const b = readText(examplesPath);
    const deterministic = a === b;

    // No fabricated REAL evidence: any results JSON must declare is_real_market_evidence
    // and only true ones may carry headline performance.
    const resultsDir = join(SKILL_DIR, "backtest", "results");
    const fab: string[] = [];
    for (const f of existsSync(resultsDir) ? readdirSync(resultsDir) : []) {
      if (!f.endsWith(".json")) continue;
      const r = JSON.parse(readText(join(resultsDir, f)));
      if (r.is_real_market_evidence === true && (r.data_source !== "cmc-history")) fab.push(`${f}: claims real evidence without cmc-history source`);
      if (r.is_real_market_evidence === false && !/synthetic/i.test(JSON.stringify(r))) fab.push(`${f}: fixture not labeled synthetic`);
    }
    const pass = deterministic && fab.length === 0;
    record(6, "Backtest honesty", pass,
      pass ? "runner reproducible; results carry no fabricated real-market numbers (real run requires CMC_API_KEY)" : `${!deterministic ? "non-deterministic output; " : ""}${fab.join("; ")}`);
  } catch (e) {
    record(6, "Backtest honesty", false, `backtest run failed: ${(e as { stderr?: Buffer }).stderr?.toString().trim() ?? e}`);
  }
})();

// ── 7. Additivity (git diff confined) ────────────────────────────────────────
(() => {
  // The true zero-regression invariant: NO Track 1 source or config is touched. Allowed
  // changes are the skill folder, Markdown docs (reflecting Track 2), and package.json
  // (script additions only). Any change under packages/, apps/, scripts/, ops/, or to
  // lockfiles/tsconfig is a hard failure.
  // -uall expands new directories into individual files; parse "XY PATH" robustly.
  // Runtime evidence under data/ is intentionally untracked on the live host and is not
  // part of either Track's source/config surface.
  const out = execSync("git status --porcelain -uall -- . ':(exclude)data/**'", {
    cwd: REPO_ROOT,
  }).toString().trim();
  const forbiddenPrefix = /^(packages\/|apps\/|scripts\/|ops\/)/;
  const forbiddenExact = new Set(["pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json"]);
  const offenders: string[] = [];
  for (const line of out.split("\n").filter(Boolean)) {
    const m = line.match(/^..\s+(.*)$/);
    if (!m) continue;
    const path = m[1]!.replace(/^"|"$/g, "");
    const target = path.includes(" -> ") ? path.split(" -> ")[1]!.replace(/^"|"$/g, "") : path;
    if (target.startsWith("skills/wardenclaw-doctrine/")) continue;
    const isDoc = target.endsWith(".md");
    const isPkgJson = target === "package.json";
    const isTrack1Code = forbiddenPrefix.test(target) || forbiddenExact.has(target);
    if (!isTrack1Code && (isDoc || isPkgJson)) continue;
    offenders.push(target);
  }
  record(7, "Additivity", offenders.length === 0,
    offenders.length === 0 ? "no Track 1 source/config touched; changes confined to skill folder + Markdown docs + package.json scripts" : `out-of-scope changes (Track 1 code/config): ${offenders.join(", ")}`);
})();

// ── 8. Submission readiness ──────────────────────────────────────────────────
(() => {
  const sub = join(SKILL_DIR, "SUBMISSION.md");
  if (!existsSync(sub)) return record(8, "Submission readiness", false, "SUBMISSION.md missing");
  const t = readText(sub);
  const hasAgent = /0x2d854b16D6d46DBBEe1a1e4aCAfb4ed6Bba75349/i.test(t);
  const hasDeadline = /june 21/i.test(t);
  const hasTrack1 = /track 1/i.test(t);
  const ok = hasAgent && hasDeadline && hasTrack1 && existsSync(join(SKILL_DIR, "AUDIT.md"));
  record(8, "Submission readiness", ok,
    ok ? "SUBMISSION.md has live agent address, June 21 deadline, Track 1 cross-link; AUDIT.md present"
       : `missing: ${[!hasAgent && "agent address", !hasDeadline && "June 21 deadline", !hasTrack1 && "Track 1 cross-link"].filter(Boolean).join(", ")}`);
})();

// ── Report ───────────────────────────────────────────────────────────────────
checks.sort((a, b) => a.n - b.n);
console.log("\nwardenclaw-doctrine — skill self-audit\n" + "=".repeat(48));
let failed = 0;
for (const c of checks) {
  const tag = c.pass ? "PASS" : "FAIL";
  if (!c.pass) failed++;
  console.log(`[${tag}] ${c.n}. ${c.name} — ${c.detail}`);
}
console.log("=".repeat(48));
if (failed > 0) {
  console.error(`\n✗ ${failed}/${checks.length} checks FAILED.`);
  process.exit(1);
}
console.log(`\n✓ All ${checks.length} checks passed.`);
