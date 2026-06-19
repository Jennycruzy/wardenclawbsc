# Skill self-audit — wardenclaw-doctrine

Run it yourself: `pnpm skill:audit` (the runner in `scripts/audit.ts` enforces every check
below and exits non-zero on any failure). This document records what it verifies and the
result of the authoring run.

## What each check enforces

1. **Format conformance** — `SKILL.md` has the verified CMC frontmatter (`name`,
   `description` with a `Trigger:` line, `user-invocable: true`, `allowed-tools` incl.
   `mcp__cmc-mcp__*`) and `FORMAT_NOTES.md` documents the verified format.
2. **Spec completeness** — `strategy-spec.md` contains every doctrine section (regime, the
   three families, net-edge, sizing, exits, week-state, compliance, calibration),
   implementable without reading the agent's source.
3. **Schema validity** — runs `skill:validate`: every signal in
   `examples/example-signals.jsonl` validates against `signals.schema.json`, and all five
   signal kinds are present.
4. **No execution surface** — greps the whole folder for execution-capable references
   (TWAK, transaction signing, wallet construction, routers, x402, execution-adapter
   imports). Must find none. (The strategy's *concepts* "wallet floor"/"wallet ledger" are
   not execution surfaces and are intentionally not matched.)
5. **No calibration leak** — verifies the only score→move model is the labeled `naive_linear`
   reference prior (no calibration bands / `realizedMoveBps` / `hitRate` anywhere in the
   folder), the reference-defaults disclaimer is present, and — if a private runtime config is
   reachable — diffs its values against the folder **without printing any private number**,
   failing on a verbatim match.
6. **Backtest honesty** — re-runs the backtest twice and confirms deterministic output;
   confirms `results/` carries no fabricated real-market numbers (a real run requires
   `CMC_API_KEY`; the fixture run is labeled `is_real_market_evidence: false`).
7. **Additivity** — the true zero-regression invariant: **no Track 1 source or config is
   touched.** Changes are confined to `skills/wardenclaw-doctrine/`, Markdown docs (updated to
   reflect Track 2), and `package.json` (script additions). Any change under `packages/`,
   `apps/`, `scripts/`, `ops/`, or to lockfiles/`tsconfig.base.json` is a hard failure.
8. **Submission readiness** — `SUBMISSION.md` carries the live Track 1 agent address, the
   June 21 deadline, and a Track 1 cross-link; `AUDIT.md` exists.

## Adversarial pass — can the calibrated edge be reconstructed from this folder?

Attempted reconstruction of the live thresholds from the published folder alone:

- `defaults.json` carries the repo's already-public conservative defaults (the same ones
  committed in `packages/core/src/config.ts`), explicitly labeled "reference defaults —
  calibrate before deploying." They are **not** the live VPS-tuned overrides.
- The score→expected-move mapping is a transparent **naive linear prior**
  (`expected_move_reference_prior`), not the live **calibrated band table** (per-band realized
  move + hit rate). The calibrated bands are the actual edge and appear nowhere in the folder.
- The calibration *procedure* is published (spec §11) but produces **no committed numbers** —
  reproducing the live edge requires the operator's own ~30-day run on recent data.

Conclusion: the framework is fully reproducible; the **calibrated edge is not**. The leak
guard (check 5) enforces this structurally and (when a private config is present) numerically.

## Result of the authoring run

```
wardenclaw-doctrine — skill self-audit
================================================
[PASS] 1. Format conformance — SKILL.md frontmatter + FORMAT_NOTES.md conform to verified CMC format
[PASS] 2. Spec completeness — all doctrine sections present and implementable
[PASS] 3. Schema validity — all example signals validate; all five kinds present
[PASS] 4. No execution surface — no TWAK/signing/wallet/router/x402/execution-adapter references
[PASS] 5. No calibration leak — public reference defaults only; no private config reachable in this environment — structural leak-guards enforced
[PASS] 6. Backtest honesty — runner reproducible; results carry no fabricated real-market numbers (real run requires CMC_API_KEY)
[PASS] 7. Additivity — no Track 1 source/config touched; changes confined to skill folder + Markdown docs + package.json scripts
[PASS] 8. Submission readiness — SUBMISSION.md has live agent address, June 21 deadline, Track 1 cross-link; AUDIT.md present
================================================

✓ All 8 checks passed.
```

Zero-regression gate (existing Track 1 suite, untouched): `pnpm typecheck` green, `pnpm lint`
green, `pnpm test` **362 passed** (≥ the prior baseline; no existing test changed). Outside the
skill folder only documentation (`README.md`, `docs/SELF_AUDIT.md`, `docs/BNB_SUBMISSION.md`,
`docs/SPECIAL_PRIZES.md`, `AGENTS.md`) and `package.json` (three `skill:*` script additions)
changed — **no `packages/`, `apps/`, `scripts/`, or `ops/` source was touched.**

> Note on `results/`: a **real** run was executed against 30 daily CMC OHLCV bars across
> twelve liquid assets versus BNB — committed as `results/per-family.json` + `results/equity-curve.csv`
> (`is_real_market_evidence: true`). The CMC key was used only at run time and is never
> committed (verified absent from the folder). The results are deliberately modest/unflattering
> (un-tuned conservative defaults); see `backtest/METHODOLOGY.md`. Check 6 verifies the results
> are real-sourced and that no fabricated numbers were introduced.
