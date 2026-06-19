---
name: wardenclaw-doctrine
description: |
  Turns CoinMarketCap market data into a complete, deterministic, backtestable trading
  strategy: a market-regime classifier (GREEN/NEUTRAL/RED), three uncrowded entry families
  (catalyst/breakout, relative-strength continuation, regime-gated momentum), a two-ledger
  cost-aware net-edge filter, drawdown-budgeted fractional-Kelly sizing, a trailing-ratchet
  exit doctrine, and a tournament-aware HUNT/PRESS/DEFEND week-state machine. Spec-only: it
  emits signals and strategy state as JSON, never orders.
  Use this skill when a user wants a rules-based crypto strategy from CMC data, asks for
  regime detection, position sizing under a drawdown cap, uncrowded breakout/relative-strength
  entries, trailing-stop exit logic, or a backtestable strategy spec rather than ad-hoc calls.
  Trigger: "trading strategy from CMC", "market regime detection", "should I be in cash",
  "position sizing under drawdown cap", "uncrowded breakout entry", "backtestable strategy spec",
  "/wardenclaw-doctrine"
license: MIT
compatibility: ">=1.0.0"
user-invocable: true
allowed-tools:
  - mcp__cmc-mcp__get_crypto_quotes_latest
  - mcp__cmc-mcp__trending_crypto_narratives
  - mcp__cmc-mcp__get_global_metrics_latest
  - Read
  - Bash
---

# WARDENCLAW Doctrine — CMC Strategy Skill

A deterministic crypto trading **strategy spec** built on CoinMarketCap data. It is the
strategy brain of a live BSC trading agent, packaged as a standalone, **spec-only** artifact:
it consumes CMC market data and emits **signals and strategy state**, never orders. There is
no execution, signing, wallet, router, or transaction construction anywhere in this skill.

The full, implementable rules live in [`strategy-spec.md`](./strategy-spec.md). Public
reference parameters live in [`defaults.json`](./defaults.json). Every emitted signal
validates against [`signals.schema.json`](./signals.schema.json).

## When to use this skill

Use it to produce a repeatable, auditable strategy decision from CMC data instead of
improvising calls: classify the market regime, screen uncrowded entries, size a position
under a drawdown budget, manage a trailing-ratchet exit, or run a friction-honest backtest of
the whole doctrine. Lead with the regime classifier — **RED means "park in stables"; in a
long-only spot context, deliberate flatness is a position.**

## CMC data consumed

| Surface | MCP tool | Used for |
|---|---|---|
| Latest quotes (price, % change 1h/24h, 24h volume, market cap) | `mcp__cmc-mcp__get_crypto_quotes_latest` | momentum, relative strength, volume expansion, ATR |
| Trending | `mcp__cmc-mcp__trending_crypto_narratives` | catalyst rank-delta entries |
| Global metrics + Fear & Greed | `mcp__cmc-mcp__get_global_metrics_latest` | regime trend, breadth, sentiment |

A reading older than the staleness limit is rejected — the strategy never acts on stale
perception, and never fabricates a quote.

## The doctrine in brief

1. **Regime classifier (GREEN/NEUTRAL/RED)** — weighted vote over benchmark trend, breadth,
   Fear & Greed, and volatility, with N-confirmation hysteresis. RED parks capital in stables.
2. **Entry A — Catalyst/Breakout (uncrowded)** — trending rank *delta* (not level), fresh
   volume expansion, and a no-first-spike continuation rule.
3. **Entry B — Relative-Strength Continuation** — outperformance vs the benchmark over
   consecutive checks with rising volume, before a name is crowded. GREEN/NEUTRAL only.
4. **Entry C — Regime-Gated Momentum Rotation** — the base family; strongest liquid major vs
   stables.
5. **Net-edge filter (two ledgers)** — expected move must beat the *simulated scoring cost*
   plus a margin, and a *measured real-cost* wallet floor.
6. **Sizing — drawdown-budgeted fractional Kelly** — volatility stop first, size from the
   stop, governor that drives size → 0 as the binding drawdown budget thins; one position.
7. **Exits — trailing ratchet** — volatility stop → breakeven+costs → ATR trail off the high;
   never widens; no fixed take-profit; tight-trail when defending.
8. **Week-state — HUNT/PRESS/DEFEND** — full aggression early, one pre-committed lowered-band
   trade if flat late, tightened gates when defending a lead.
9. **Compliance (optional)** — minimum-activity awareness via a stable↔stable last-resort
   trade for rule-constrained venues.

## Output — signals emitted (never orders)

Five signal kinds, one JSON object per decision cycle (JSONL), each validating against
`signals.schema.json`: `regime_state`, `week_state`, `entry_candidate` (family + reasons +
net-edge), `sizing` (size fraction + binding layer), `exit_instruction` (HOLD/EXIT + reason).
See [`examples/example-signals.jsonl`](./examples/example-signals.jsonl) for real emitted
output from a backtest run.

## Run the backtest (two commands)

```bash
pnpm install
pnpm skill:backtest        # replays the spec over price history using ONLY defaults.json
```

With `CMC_API_KEY` set and `SKILL_BACKTEST_REAL=1`, the runner replays ~30 days of **real**
CMC history; without those it runs a documented, clearly-labeled fixture so the demo works
offline. Friction (gas + slippage + LP fee + simulated scoring cost) is applied so results are
cost-honest. Per-family stats and the equity curve land in
[`backtest/results/`](./backtest/results/); methodology and honesty caveats are in
[`backtest/METHODOLOGY.md`](./backtest/METHODOLOGY.md).

## Principles

- **Deterministic.** No language model ever produces a score, a size, or a trade decision —
  every number is arithmetic over CMC inputs and configured parameters.
- **Spec-only.** Emits signals and state; never constructs or signs a transaction.
- **Cost-honest.** Two ledgers separate simulated scoring cost from realized venue cost, so
  the spec is venue-agnostic.
- **Public framework, private calibration.** The full framework ships with honest reference
  defaults; the live agent's *calibrated* values are intentionally not published here
  (see `strategy-spec.md` §12). Calibrate on recent data before deploying.

## Reference files

- `strategy-spec.md` — the full deterministic specification (the heart).
- `defaults.json` — documented public reference parameters.
- `signals.schema.json` — JSON Schema for every emitted signal/state.
- `backtest/` — runner, methodology, and committed results.
- `examples/example-signals.jsonl` — real emitted signals from a backtest run.
- `FORMAT_NOTES.md` — the CMC Skill format this file conforms to.
- `SUBMISSION.md` — the Track 2 submission text.
