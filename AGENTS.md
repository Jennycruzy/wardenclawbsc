# AGENTS.md — build state & continuation plan

Working handoff for WARDENCLAW BSC (BNB Hack Track 1, win-first upgrade). Read this
first when resuming.

## SESSION HANDOFF — 2026-06-15 (live ops; read FIRST, for Codex to continue)

Live operations were run against the VPS (`root@38.49.216.59:/root/wardenbsc`). State below.

### Done & verified
- **On-chain registration COMPLETE.** Agent wallet `0x2d854b16D6d46DBBEe1a1e4aCAfb4ed6Bba75349`
  registered on competition contract `0x212c61b9b72c95d95bf29cf032f5e5635629aed5`, tx
  `0x373533515876f5e7c460419816d7cb4f5bfb02ac55d276eb9d3233328e03ad53` (status 0x1, block 104452111).
  `REGISTRATION_TX_HASH` set in VPS `.env`. **Do NOT re-register.**
- **TWAK key rotated.** Old key `0652e53f` was registration-scoped only (swap API returned 403 from
  every IP — proven NOT an IP issue). NEW key `6938de90…` (swap-enabled) is in VPS `.env`
  (`TWAK_ACCESS_ID`/`TWAK_HMAC_SECRET`) and `twak auth setup`. Resolves the SAME wallet. Old key can
  be revoked. See `memory/twak-swap-api-403-blocker.md`.
- **eligible-tokens.json built** on the VPS (148 tokens; USDT/USDC/ETH confirmed). ETH =
  `0x2170ed0880ac9a755fd29b2688956bd959f933f8`, USDT = `0x55d398326f99059fF775485246999027B3197955`.
- **Live $5 ETH round-trip executed** (entry `0x44f24692…`, manual exit `0x14c8fe21…`). **Measured real
  round-trip cost = 1.367% (≈137 bps)**, excl gas. Seeded VPS `data/runtime/wallet-cost.json` =
  `{"bootstrapBps":136.7,"samples":[136.7],"windowSize":10}`.
- **Routing reality:** `twak swap` aggregates the route itself — fills go via the TWAK aggregator
  (provider **LiquidMesh**, router `0x3d90f66b534dd8482b181e24655a9e8265316be9`), NOT a direct
  PancakeSwap-router call. `twak swap` has no venue flag. Accepted as "executed via TWAK CLI." Docs
  updated (`BNB_SUBMISSION.md` no longer claims "PancakeSwap router only").
- **typecheck + build green** on the VPS; `pm2 restart wardenbsc-web(19) wardenbsc-api(20)` done (new key live).
- **#10 watchdog exit PROVEN on-chain** — the worker autonomously detected a stop breach and signed +
  submitted a real exit swap (tx `0x37b86bcb…`, status 0x1, USDT +4.665).

### ✅ Critical TWAK receipt bug fixed — 2026-06-16
`packages/twak-adapter/src/cliExecutor.ts` now parses TWAK v0.19.1 `out.output` strings such as
`"4.665 USDT"` and keeps `realizedOut` unit-agnostic: EXITS are stable proceeds, ENTRIES are bought
token units. Hash-only swaps remain `submitted` with no fabricated output. Adapter tests cover entry
output, exit output, and hash-only receipts.

Commit `ddcbaa0` (`Parse TWAK CLI swap output receipts`) is pushed to GitHub `main` and deployed on
the VPS. Verified green locally: `pnpm --filter @wardenclaw/twak-adapter test`, `pnpm typecheck`,
`pnpm lint`, `pnpm test`, and `pnpm --filter @wardenclaw/web build`. VPS `pnpm install --frozen-lockfile`
and `pnpm build` also passed; `wardenbsc-web` and `wardenbsc-api` were restarted under PM2.

### Remaining rehearsal checklist (do after the bug fix)
- **#11 hourly snapshot** — auto (worker writes `.snapshots.jsonl`); verify a real USD valuation row.
- **#12 kill-switch** — set `KILL_SWITCH_TOKEN`; test live from phone; verify revocation.
- **#13 restart-and-reconcile** — kill worker mid-position; verify RECOVERY_REPORT + no duplicate.
- **#14 calibration** — `pnpm calibrate:edge` on fresh data.
- **#15 phone alerts** — set `ALERT_WEBHOOK_URL`; confirm receipt (incl. trade-at-risk).
- Then `pnpm rehearsal:checklist` to flip the live gate; start the worker for the window.

### Operator runbook for #12-#15 (resume here if interrupted)
1. **Kill-switch live test.** On VPS, ensure `.env` has a strong `KILL_SWITCH_TOKEN`, then
   `pm2 restart wardenbsc-api`. From phone or terminal, call the kill-switch route with
   `Authorization: Bearer <token>` and confirm the API returns success and writes the expected
   runtime revocation/kill state. Reset/revoke only when ready to continue rehearsal.
2. **Restart-and-reconcile.** Start the worker only for the rehearsal test from
   `/root/wardenbsc/apps/worker` with `pnpm start`. Once there is an intentional test position,
   `pkill -f 'src/worker.ts'`, restart it, and verify recovery logs/audit show no duplicate entry.
   Inspect `data/runtime/positions.json`, `data/runtime/manual-review.json`, and recent
   `data/audit/*.jsonl` before proceeding.
3. **Fresh calibration.** Run `cd /root/wardenbsc && pnpm calibrate:edge`. Inspect generated output
   and `git status --short`. Commit/push tracked calibration changes if any; leave gitignored runtime
   calibration state on the VPS.
4. **Phone alerts.** Set `ALERT_WEBHOOK_URL` in VPS `.env`, restart the API (and worker if running),
   then send a test payload to the webhook or use the app's alert-test route if present. Confirm the
   phone receives the alert, then trigger one real app-generated alert path such as kill-switch or
   trade-at-risk.
5. **Final gate.** Run `cd /root/wardenbsc && pnpm rehearsal:checklist`. Do not start the competition
   worker until the checklist is clean or every remaining manual item is explicitly verified.

### Housekeeping
- Wallet now holds ≈ **40.76 USDT + ~0.00015 ETH dust + BNB (gas, reduced)**. Top up gas/stables before
  the window per the $40 book.
- Rotate the VPS root password, the OCI box password, and the TWAK HMAC secret (all passed through a
  chat session). Move VPS to SSH-key-only. Revoke old TWAK key `0652e53f`.
- A test worker was launched during #10 and force-stopped. 2026-06-16 verification: no stray
  `tsx src/worker.ts` process is running on the VPS; watchdog exit tx `0x37b86bcb…` is successful on
  BSC; wallet balances are ≈40.7626568 USDT + 0.0001516 ETH dust + 0.0141952 BNB; stale
  `data/runtime/positions.json` was backed up to `positions.json.stale-20260616T002540Z` and reset to
  `[]`; `manual-review.json` is absent.

## Snapshot (2026-06-13)

- **Branch:** `win-first-upgrade` (local + GitHub `origin` + VPS all in sync).
- **HEAD:** `2f58d44` — "Measure the real TWAK round-trip cost; enforce the dust gate".
- **Gate:** `pnpm typecheck && pnpm lint && pnpm test` green — **284 tests** (incl. a
  live BSC-mainnet read); `pnpm --filter @wardenclaw/web build` green.
- **Live:** VPS `root@38.49.216.59:/root/wardenbsc` runs `wardenbsc-web` (pm2 id 19)
  and `wardenbsc-api` (id 20). The **worker is not running** there yet (started only
  for rehearsal/live), so none of the win-first logic changes live trading until the
  worker is launched. See `memory/vps-deployment.md`.

## Conventions (do not break)

- **Commits:** author `jennycruzy`, **NO AI attribution** — no `Co-Authored-By`, no
  "Generated with" trailer. Clean descriptive subjects; no "Phase N"/"Workstream N"
  prefixes. (See `memory/commit-style.md`.)
- **No fake data, fail loud.** Every adapter throws without credentials; the worker
  never fabricates a fill, tx hash, price, or cost. Dry mode is labeled.
- **The LLM never reaches execution.** It proposes structured perception upstream;
  the deterministic gate chain + TWAK policy take only numbers/addresses.
- **Each workstream ships green + deployed:** lint + typecheck + test + web build all
  pass, then commit → push → VPS `git pull && pnpm install && pnpm build && pm2
  restart wardenbsc-web wardenbsc-api`. (After restart, the API needs ~10s to bind —
  a health check sooner can read 000; that's the bind window, not a failure.)
- **Per-workstream checklist:** core module(s) → wire into pipeline/worker → surface
  on a dashboard → tests → `.env.example` knobs → `docs/SELF_AUDIT.md` row + test
  count → green gate → commit → deploy.

## Architecture (where things live)

- `packages/core` — deterministic engine. Risk config (`config.ts`), Risk
  Constitution (`riskConstitution.ts`), friction (`frictionModel.ts`), two ledgers
  (`ledgers.ts`/`scoredCost.ts`), net-edge + wallet floor (`netEdgeGate.ts`), stops
  (`trailingStop.ts`, `stopCoherence.ts`, `positionWatch.ts`), governor
  (`drawdownGovernor.ts`), calibration (`edgeCalibration.ts`), entry quality
  (`signalHistory.ts`, `catalystEntry.ts`, `rsContinuation.ts`), week budget
  (`weekBudget.ts`, `weekLedger.ts`), regime (`regimeAnalyst.ts`), mandate schema
  (`types.ts`, `signalMandate.ts`). All reject codes live in `types.ts`.
- `packages/bnb-agent` — `pipeline.ts` (the gate-chain over one candidate;
  `PipelineContext` carries `sizeMultiplier`, `riskState`, `marketRegime`,
  `realRoundTripBps`), `scheduler.ts`, `runtime.ts`, `mandate.ts` (build mandate).
- `packages/{cmc,twak,bsc}-adapter` — CMC perception + x402, Trust Wallet Agent Kit
  executor + local policy, PancakeSwap live reads (`LiveBscReader`).
- `apps/worker/src/worker.ts` — the autonomous loop: recovery → per-cycle perception
  → gate chain → (dry/live) execute → persist; plus the fast watch loop. Owns all
  file IO; runtime state in `data/runtime/*` (gitignored): `positions.json`,
  `signalHistory.json`, `weekLedger.json`, `regime.json`, `wallet-cost.json`, and
  the dashboard snapshots (`*.snapshot.json`, `week-budget.json`, heartbeats).
- `apps/api` — kill-switch + `/health`. `apps/web` — `/bsc/*` dashboards
  (`/bsc/proof` judge scoreboard, `/bsc/ops` health). Web reads runtime snapshots via
  `apps/web/lib/data.ts`.

## Done — win-first WS1–WS8

| WS | What | Key files |
|----|------|-----------|
| 1 | Two ledgers (Scored vs Wallet) + wallet-floor gate | `ledgers.ts`, `scoredCost.ts`, `netEdgeGate.ts` |
| 2 | Trailing-stop ratchet, restart-safe | `trailingStop.ts`, `positionStore.ts` |
| 3 | Fast position-watch loop + staleness + ops heartbeat | `positionWatch.ts`, worker `runWatchLoop` |
| 4 | TWAK-first x402; viem labeled fallback; `X402_REQUIRED` blocks | `twak-adapter` `payX402`, `chooseX402Path` |
| 5 | Entry quality (catalyst uncrowding) + `rs_continuation`; per-family calibration | `signalHistory.ts`, `catalystEntry.ts`, `rsContinuation.ts` |
| 6 | Week-schedule risk budget HUNT/PRESS/DEFEND + leg-counting + win-first sizing | `weekBudget.ts`, `weekLedger.ts` |
| 7 | Red-day regime GREEN/NEUTRAL/RED + hysteresis; RED blocks + rotates to stables | `regimeAnalyst.ts`, `REJECT_REGIME_RED`, `EXIT_REGIME_RED` |
| 8 | Measured real TWAK round-trip cost → wallet floor + dust gate | `ledgers.ts` `measureRoundTripBps`, `REJECT_DUST_TRADE` |

Each row's full evidence (files + tests) is in `docs/SELF_AUDIT.md` → "Win-First
upgrade (workstreams)".

## Left to do

### WS9 — Operations + docs (not started)
- **PREFLIGHT countdown** to the trading window (`COMPETITION.tradingWindow` =
  2026-06-22T00:00Z → 2026-06-28T23:59Z) — surface days/hours remaining on `/bsc/ops`
  and/or `docs/PREFLIGHT.md`.
- **Registration alert escalating after Jun 18** — if the agent wallet is not
  registered on the competition contract, escalate the alert severity/cadence past
  2026-06-18 (4 days before open). Registration state already reads from env
  (`TWAK_AGENT_WALLET` / registration tx); add the time-based escalation.
- **Docs polish:** README (done in this pass), `docs/ECONOMICS.md`,
  `docs/OPERATIONS.md`, `docs/SPECIAL_PRIZES.md` — fold in WS1–WS8 (two ledgers,
  measured cost, regime, week budget) and the final knob list.

### Final — audit pass (not started)
- `docs/SELF_AUDIT.md`: confirm every WS row, refresh the **7 honesty-audit answers**
  and the **adversarial self-review** to cover the new gates (regime RED, dust,
  week-budget caps, measured cost), and the final test count.
- Full green gate one more time; commit + deploy.

## Resume cleanly

```bash
cd /workspaces/wardenclawbsc
git status && git log --oneline -3
pnpm install && pnpm typecheck && pnpm lint && pnpm test   # expect 284 green
```

Then pick up at **WS9** above. If anything looks off, the last known-good state is
`2f58d44` on `win-first-upgrade` (local, GitHub, and VPS all there).
