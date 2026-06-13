# WARDENCLAW

> WARDENCLAW turns natural-language trading strategies into risk-bound Signal Mandates that can trade, survive, and prove why they acted.

One shared deterministic core, two focused submissions:

- **WARDENCLAW Stocks** — a Bitget-native paper-trading agent that reacts to tokenized-equity earnings/news/sentiment shocks under deterministic risk gates.
- **WARDENCLAW BSC** — a live, self-custodial, spot-only BSC trading agent that reads markets via CoinMarketCap, signs through Trust Wallet Agent Kit, and optimizes total return under a drawdown cap from a $40 book.

## Status

Both submissions are built. The shared TypeScript core is the source of truth for
the frontend, backend, and worker. External integrations (Bitget public data, CMC
Agent Hub + x402, Trust Wallet Agent Kit, BNB AI Agent SDK, PancakeSwap) are real
adapters that fail loudly when unconfigured — never faked. **284 tests pass**
(including a live BSC-mainnet read); `typecheck`, `lint`, and the Next.js build are
green. The BSC build also runs live on a VPS (web + api) kept in sync each change.

A **win-first upgrade** (workstreams WS1–WS8) is in on branch `win-first-upgrade`:
every feature sits INSIDE the existing safety gates (spot-only, TWAK-only,
eligible-contracts-only). WS9 (ops/docs) and the final audit pass remain — see
[`AGENTS.md`](AGENTS.md) for the exact continuation plan.

### What's implemented

- **`packages/core`** — the deterministic engine: Signal Mandate schema, risk
  config, friction model (real + simulated), net-edge gate, volatility stops +
  coherence, three-layer drawdown governor, shadow-fill guard, calibration mapping,
  address-keyed eligible allowlist, scorer, Risk Constitution, hash-chained audit,
  replay, recovery, hourly snapshots, mandate store, LLM provider layer.
- **Bitget submission** — `packages/bitget-adapter` (real public market data,
  shock/cooldown reactor with first-spike rejection, internal paper engine,
  ranker, agent stack, backtest) + `apps/web` `/bitget` judge dashboard.
- **BNB submission** — `packages/{cmc,twak,bsc}-adapter` + `packages/bnb-agent`
  (the full gate-chain pipeline, scheduler, runtime ops), `apps/api` (kill-switch),
  `apps/worker` (recovery + loop + snapshots), `apps/web` `/bsc` dashboards incl.
  the `/bsc/proof` judge scoreboard.

### Win-first upgrade (branch `win-first-upgrade`)

Offense + precision, all inside the existing gates. Each is deterministic (the LLM
touches none of it), restart-safe, tested, and surfaced on the dashboards:

- **WS1 — Two ledgers**: Scored (simulated cost → net-edge gate) vs Wallet (real
  round-trip → wallet floor); both on every mandate.
- **WS2 — Trailing-stop ratchet**: per-position HWM → breakeven+fees → trail, exit
  on breach, persisted/restored.
- **WS3 — Fast position-watch loop**: protection cadence between decision cycles,
  staleness alert, `/bsc/ops` heartbeat.
- **WS4 — TWAK-first x402**: pay via `twak x402 request`; viem demoted to a labeled
  fallback; `X402_REQUIRED` blocks the dependent trade.
- **WS5 — Entry quality + `rs_continuation`**: catalyst uncrowding (trending delta,
  volume expansion, no first spike) + relative-strength continuation; per-family
  calibration; restart-safe signal history.
- **WS6 — Week-schedule risk budget**: HUNT/PRESS/DEFEND state machine, leg-counting,
  win-first sizing; the multiplier scales only the governor cap, never the hard caps.
- **WS7 — Red-day regime analyst**: GREEN/NEUTRAL/RED 3-signal vote with hysteresis;
  RED blocks new entries (`REJECT_REGIME_RED`) and rotates open risk to stables.
- **WS8 — Measured TWAK round-trip cost**: realized cost measured from fills (isolated
  from price move), feeding the wallet floor and an enforced dust gate
  (`REJECT_DUST_TRADE`).

Docs: `docs/{SETUP,COMPETITION_RULES,BITGET_SUBMISSION,BNB_SUBMISSION,SPECIAL_PRIZES,
SAFETY,LLM_POLICY,ECONOMICS,OPERATIONS,PREFLIGHT,SELF_AUDIT}.md`. Start with
`docs/SETUP.md`. For build state + the continuation plan, see [`AGENTS.md`](AGENTS.md).

## Develop

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test
pnpm demo:twak-refusal              # see TWAK refuse bad trades
pnpm --filter @wardenclaw/web dev     # dashboards on http://localhost:3000
```

## Safety

This is hackathon trading, not investment advice. BSC execution is **spot-only** by team decision. Private keys never touch the backend or database — signing is local through Trust Wallet Agent Kit. Every trade decision produces a structured, replayable audit event.

## Environment

Copy `.env.example` to `.env` and fill in the values you need. Every variable is documented inline.
