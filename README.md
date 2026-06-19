# WARDENCLAW BSC

> A deterministic, self-custodial BNB Smart Chain trading agent built to maximize
> competition return while keeping drawdown and real-wallet friction under control.

WARDENCLAW BSC is a live, spot-only agent for the BNB Hack Track 1 trading
window:

- **Opens:** June 22, 2026 at 00:00 UTC
- **Closes:** June 28, 2026 at 23:59:59 UTC
- **Chain:** BNB Smart Chain, chain ID 56
- **Execution:** eligible BEP-20 spot swaps through PancakeSwap
- **Custody:** Trust Wallet Agent Kit (TWAK) is the only BSC trade executor
- **Perception:** CoinMarketCap quotes, trending, Fear & Greed, and x402
- **Book:** organizer-authorized capital in eligible stables, with separate native BNB for gas

The LLM may produce structured perception or narration upstream. It cannot score,
size, approve, sign, or execute a trade. Every execution decision is made by the
deterministic gate chain.

## Current Status

The win-first upgrade and operations pass are implemented on `main`.

- `pnpm typecheck`: green
- `pnpm lint`: green
- `pnpm test`: **317 tests passed**
- Live BSC reserve and quote read: passed
- Production Next.js build: green
- VPS web and API: deployed from `main`
- Trading worker: intentionally stopped until registration and rehearsal are complete

The software is built, but the following real-world actions cannot be completed
by code and are still operator responsibilities:

1. Run `twak compete register` and set `REGISTRATION_TX_HASH`.
2. Run `pnpm check:cmc`, then build the eligible-token file using the proven key.
3. Fund the TWAK wallet with eligible stables and separate gas BNB.
4. Complete the $5 mainnet rehearsal, including watchdog and trailing exits.
5. Run fresh edge calibration.
6. Confirm phone alerts and the kill-switch.
7. Complete the DoraHacks submission.

See [PREFLIGHT.md](docs/PREFLIGHT.md) for the ordered checklist. Registration
closes when trading opens on **June 22, 2026 at 00:00 UTC**.

## Win-First Strategy

The strategy aims for a small number of concentrated, trailed entries while
remaining flat in eligible stables when the market is hostile.

### Two Ledgers

- **Scored Ledger:** price movement minus the competition's configurable
  simulated transaction cost. It drives scored net edge, the week state, and the
  judge view.
- **Wallet Ledger:** actual stable cash plus marked-to-market open positions. It
  embeds real TWAK fees, gas, slippage, and LP fees. It drives wallet protection,
  hourly snapshots, the wallet floor, and dust rejection.

Changing `SCORING_SIM_COST_BPS` retunes the scored-cost model without changing
source code. Real round-trip cost is measured from confirmed fills and persisted;
it is never hardcoded as a claimed live cost.

### Entry Families

- **Momentum:** liquid eligible majors with benchmark-relative strength.
- **Catalyst:** requires rapidly improving trending rank, fresh volume expansion,
  and a post-spike consolidation plus continuation. A first vertical spike is
  rejected.
- **Relative-strength continuation:** requires two consecutive checks of
  benchmark outperformance with rising volume.

All families pass the same deterministic execution gates.

### Week State

- **HUNT, days 1-5:** normal 80+ score threshold from hour one.
- **PRESS, day 6+:** when scored return remains between -2% and +3%, exactly one
  pre-committed trade may use the 65+ score band. PRESS does not increase size or
  bypass any gate. Once filled, it is permanently consumed for the window.
- **DEFEND, above +8% scored return:** requires 90+ score, adds 50 bps of net-edge
  margin, and uses the tighter trailing stop.

Entry, exit, and compliance-scout legs are timestamped and persisted.

### Market Regime

The deterministic regime analyst classifies `GREEN`, `NEUTRAL`, or `RED` using:

- BNB short-horizon and 24-hour trend
- BTC 24-hour confirmation
- BNB price relative to its recent decision-cycle mean
- Liquid-major market breadth
- CoinMarketCap Fear & Greed
- Benchmark volatility relative to the majors baseline
- Two-cycle hysteresis before changing committed regime

`RED` blocks new directional entries and rotates open risk into eligible stables.
The LLM, PRESS logic, and signal score cannot override it. Safety exits and the
last-resort stable compliance scout remain available.

### Runner Protection

Each position has a persisted high-water mark and software-enforced stop:

1. Start with a volatility stop below entry.
2. At a one-ATR gain, ratchet to entry plus measured real round-trip cost.
3. Trail below the high-water mark.
4. Never lower or widen the stop.
5. Use the tighter trail in RED or DEFEND.

The dedicated watch loop checks open positions every 45 seconds by default,
independently of the slower entry-decision cadence.

## Deterministic Gate Chain

No directional entry reaches TWAK unless it passes:

1. Active score threshold
2. Signal-family entry-quality checks
3. Eligible contracts on both legs
4. Spot-only and chain-56 assertions
5. Allowlisted router and spender
6. Volatility-stop coherence
7. Three-layer drawdown governor
8. Scored net-edge requirement
9. Wallet-floor requirement
10. Measured-cost dust gate
11. Shadow-fill tolerance
12. Market-regime gate
13. TWAK local policy and slippage limits

Forced safety exits bypass entry edge requirements but still pass TWAK policy,
eligibility, chain, router, and slippage controls.

## Safety Invariants

- Spot-only; no leverage, margin, perps, or borrowing.
- Native BNB is gas only and cannot be held as a trading position.
- BNB/WBNB position intents are rejected.
- Eligibility is keyed by contract address, not ticker symbol.
- No infinite approvals.
- No BSC trading private key is stored by the API, worker, database, or audit
  logs. The optional viem x402 fallback uses `X402_PRIVATE_KEY` only when
  explicitly enabled and is labeled non-TWAK.
- No fake price, fill, receipt, transaction hash, registration, or measured cost.
- Dry and rehearsal modes are explicitly labeled.
- A submitted transaction with an unknown realized output arms
  `data/runtime/manual-review.json` and halts execution instead of risking a
  duplicate submission.
- Live mode refuses to start until the rehearsal gate passes unless the operator
  explicitly sets `REHEARSAL_OVERRIDE=true`.

## Repository Layout

```text
apps/
  api/                 Health, registration reminders, and authenticated kill-switch
  worker/              Autonomous decision loop, fast watch loop, persistence
  web/                 /bsc, /bsc/proof, /bsc/ops, mandates, replay, rules
  bnb-sdk-sidecar/      Optional Python BNB AI Agent SDK identity bridge

packages/
  core/                Risk, economics, ledgers, stops, regime, week state, audit
  bnb-agent/           Candidate pipeline, scheduler, mandate builder, runtime alerts
  bsc-adapter/         Eligible tokens, RPC failover, PancakeSwap reads and quotes
  cmc-adapter/         CMC perception and labeled x402 fallback
  twak-adapter/        TWAK execution, policy, registration, and TWAK-native x402

scripts/               Verification, calibration, rehearsal, replay, backtest, demos
docs/                  Setup, economics, operations, safety, audit, submission evidence
data/runtime/          Restart-safe live state; generated and gitignored
data/audit/            Hash-chained events, mandates, and hourly snapshots
```

## Requirements

- Node.js 20 or newer
- pnpm 10.32.1, pinned by `packageManager`
- A CMC API key for real perception
- A TWAK wallet/configuration for live signing
- BSC RPC endpoints with failover
- A phone-reachable webhook and kill-switch token for live operations

## Install and Verify

```bash
pnpm install
cp .env.example .env

pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @wardenclaw/web build
```

Every environment variable is documented inline in `.env.example`. Adapters fail
loudly when required credentials are missing.

Useful verification commands:

```bash
pnpm verify:competition-rules
pnpm verify:integrations
pnpm verify:integrations -- --live
pnpm verify:llm
pnpm check:cmc
pnpm explain:strategy
```

`CMC_API_KEY` is required for live perception. `pnpm check:cmc` makes real calls
through the same `CmcClient` used by the worker and reports key info, quotes,
volume, trending, Fear & Greed, contract resolution, and x402 reachability.

Qwen is optional. Set `LLM_PROVIDER=qwen` plus `QWEN_API_KEY`; role routing uses
stronger models for strategy compilation, cheap models for frequent
classification/summaries, and a mid-tier model for post-trade reflection and the
DoraHacks explanation. With no LLM key, trading remains deterministic and
`pnpm explain:strategy` emits an extractive template from the available audit data.

## Configure Capital

Set the competition configuration to the organizer-authorized amount:

```env
STARTING_CAPITAL_USD=<AUTHORIZED_AMOUNT>
GAS_RESERVE_USD=2
```

To operate a new, non-competition book at another amount, such as $100, change
the environment only:

```env
STARTING_CAPITAL_USD=100
```

No source-code edit is required. Fund the same amount in eligible stables and
keep native BNB separate for gas.

Do not change starting capital in the middle of an existing runtime ledger.
`data/runtime/book.json`, `weekLedger.json`, `positions.json`, and hourly
snapshots were initialized against the old book. Close/reconcile all positions
and start a deliberate fresh ledger before changing the amount. For the
competition, retain the organizer-authorized capital amount.

## Preflight and Rehearsal

Run these in order:

```bash
twak compete register
# Set the real result:
# REGISTRATION_TX_HASH=0x...

pnpm build:eligible-tokens
pnpm verify:integrations -- --live
pnpm rehearsal:checklist
pnpm calibrate:edge
```

The rehearsal must include:

- One real $5 eligible-token round trip
- One watchdog stop exit
- One trailing-stop exit
- Measured TWAK round-trip cost
- Kill-switch test from a phone
- Restart/reconciliation test without a duplicate trade

The API sends missing-registration reminders daily, every six hours after
June 18, and hourly in the final 24 hours before registration closes.

## Run Locally

Start the dashboard:

```bash
pnpm --filter @wardenclaw/web dev
```

Useful pages:

- `http://localhost:3000/bsc` - current strategy and recent mandates
- `http://localhost:3000/bsc/proof` - judge scoreboard and proof anchors
- `http://localhost:3000/bsc/ops` - countdown, registration, health, costs, regime
- `http://localhost:3000/bsc/rules` - competition-rule assertions and warnings

Exercise the system without moving funds:

```bash
pnpm demo:twak-refusal
pnpm run:bsc-agent
pnpm backtest:bsc
pnpm replay --mandate <mandate-id>
```

`run:bsc-agent` exercises a real-data decision flow. The autonomous live loop is
`@wardenclaw/worker` and remains protected by its TWAK and rehearsal checks.

## Production Operations

Build the production workspace:

```bash
pnpm install --frozen-lockfile
pnpm build
```

The web and API may run throughout preflight. Start them using the deployment's
assigned ports and process names.

`ops/pm2.config.cjs` starts **both the API and the trading worker**. Do not run it
as a generic preflight command. Enable it only after registration, funding,
rehearsal, calibration, alerts, and the kill-switch are confirmed:

```bash
pm2 start ops/pm2.config.cjs
pm2 save
```

Emergency stop:

```bash
curl -X POST "$NEXT_PUBLIC_API_URL/kill" \
  -H "authorization: Bearer $KILL_SWITCH_TOKEN"
```

See [OPERATIONS.md](docs/OPERATIONS.md) for restart handling, phone alerts,
manual-review recovery, and live-window checks.

## Dashboards and Proof

- **`/bsc`**: strategy state, market regime, mandate stream, reject reasons.
- **`/bsc/proof`**: wallet value, total return, max drawdown, executed legs,
  Scored/Wallet economics, BSC transaction hashes, TWAK and x402 receipts.
- **`/bsc/ops`**: live countdown, registration status, ordered preflight,
  integration health, watch heartbeat, week state, regime inputs, measured cost.
- **`/bsc/mandates/:id`**: complete decision and proof record.
- **`/bsc/replay/:id`**: deterministic hash-chain replay.

Missing runtime artifacts produce explicit empty states. The UI does not invent
sample trades or proof.

## Key Runtime Files

```text
data/runtime/book.json                  Wallet cash and scored competition value
data/runtime/positions.json             Open positions with HWM and active stop
data/runtime/signalHistory.json         Restart-safe entry observations
data/runtime/weekLedger.json            Timestamped legs and PRESS consumption
data/runtime/regime.json                Committed regime and hysteresis state
data/runtime/benchmark-history.json      Recent BNB prices for regime analysis
data/runtime/wallet-cost.json            Rolling measured real round-trip cost
data/runtime/watch-heartbeat.json        Fast-watch health
data/runtime/manual-review.json          Hard execution halt pending reconciliation
data/runtime/rehearsal.json              Live-mode rehearsal gate
```

These files are generated, gitignored, and must be backed up with operational
care during the competition.

## Commands

| Command | Purpose |
|---|---|
| `pnpm build` | Build all workspace packages and the web app |
| `pnpm typecheck` | Type-check the complete workspace |
| `pnpm lint` | Run the repository's static lint/type gate |
| `pnpm test` | Run all automated tests |
| `pnpm verify:competition-rules` | Verify encoded competition rules |
| `pnpm build:eligible-tokens` | Resolve the eligible universe to BSC contracts |
| `pnpm calibrate:edge` | Produce fresh score-to-move calibration |
| `pnpm run:bsc-agent` | Run one real-data BSC decision flow |
| `pnpm demo:twak-refusal` | Demonstrate TWAK policy refusals without moving funds |
| `pnpm backtest:bsc` | Run the BSC strategy/economics backtest |
| `pnpm replay --mandate <id>` | Replay a mandate's hash-chained audit |
| `pnpm rehearsal:checklist` | Regenerate/check the live rehearsal gate |
| `pnpm verify:integrations -- --live` | Fail if required live integrations are missing |
| `pnpm skill:backtest` | Track 2 Skill: replay the doctrine spec over price history (defaults only) |
| `pnpm skill:validate` | Track 2 Skill: validate emitted signals against the JSON schema |

## Documentation

- [Setup](docs/SETUP.md)
- [Preflight checklist](docs/PREFLIGHT.md)
- [Economics and two-ledger model](docs/ECONOMICS.md)
- [Operations runbook](docs/OPERATIONS.md)
- [Safety policy](docs/SAFETY.md)
- [LLM policy](docs/LLM_POLICY.md)
- [Competition rules](docs/COMPETITION_RULES.md)
- [BNB submission guide](docs/BNB_SUBMISSION.md)
- [Strategy explanation](docs/STRATEGY_EXPLANATION.md)
- [Combined Track 1 + Track 2 demo script](docs/DEMO_SCRIPT.md)
- [Special-prize evidence](docs/SPECIAL_PRIZES.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Track 2 Strategy Skill](skills/wardenclaw-doctrine/SKILL.md) — `wardenclaw-doctrine` (spec-only CMC Skill)

## Track 2 Skill — wardenclaw-doctrine

A separate, additive Track 2 "Strategy Skills" submission lives in
[`skills/wardenclaw-doctrine/`](skills/wardenclaw-doctrine/). It is a **CoinMarketCap Skill**
that packages this agent's deterministic doctrine as a standalone, public, **spec-only**
strategy: it consumes CMC data and emits signals and strategy state as JSON (regime, entry
candidates, sizing, exits, week-state), never orders. It is the strategy brain of the live
Track 1 agent, published with documented **public reference defaults** — the live calibrated
values stay private. It does not modify any Track 1 trading code. See
[`SKILL.md`](skills/wardenclaw-doctrine/SKILL.md) and
[`SUBMISSION.md`](skills/wardenclaw-doctrine/SUBMISSION.md).

## Scope and Disclaimer

This repository is hackathon software, not investment advice. It can lose money.
Software stops are not exchange-native orders and depend on RPC availability,
worker uptime, TWAK execution, and network conditions. The internal controls are
designed to fail loudly and reduce avoidable risk; they cannot guarantee a top
prize, profit, execution, or protection from all market events.
