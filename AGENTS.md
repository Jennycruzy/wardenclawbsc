# AGENTS.md — build state & continuation plan

Working handoff for WARDENCLAW BSC (BNB Hack Track 1, win-first upgrade). Read this
first when resuming.

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
