# Track 2 — Strategy Skills: `wardenclaw-doctrine`

**BNB Hack: AI Trading Agent Edition — submitted via DoraHacks by June 21, 2026, 13:00.**

> Submission note: Track 1 and Track 2 are submitted as **one combined BUIDL**. This document
> is the Track 2 entry; the Track 2 Skill lives in `skills/wardenclaw-doctrine/` of the **same
> repository** as the Track 1 agent, per organizer guidance permitting a folder within the same
> repo. The Track 1 agent and its on-chain proof are described in the same BUIDL.

## What it is

`wardenclaw-doctrine` is a CoinMarketCap Skill that turns CMC market data into a complete,
deterministic, **backtestable trading strategy spec** — a Quantopian-style strategy adapted to
crypto. It is **spec-only**: it consumes CMC data and emits signals and strategy state as JSON
(regime, entry candidates, sizing, exits, week-state), **never orders**. Every rule is pure
arithmetic over CMC inputs; no language model ever produces a score, a size, or a trade
decision. It is the **strategy brain of a live Track 1 agent**, packaged as a standalone public
artifact.

## The doctrine in five bullets

- **Regime as a position.** A GREEN/NEUTRAL/RED classifier (benchmark trend, breadth, Fear &
  Greed, volatility, with hysteresis). RED = capital parked in stables by design — in long-only
  spot, deliberate flatness is the trade.
- **Uncrowded entries.** Catalyst/breakout on trending *rank-delta* (not level) with a
  no-first-spike rule; relative-strength continuation *before* a name is crowded; regime-gated
  momentum rotation.
- **Two-ledger net-edge.** Expected move must clear *simulated scoring cost* + margin **and** a
  *measured real-cost* wallet floor — venue-agnostic and friction-honest.
- **Survival-first sizing.** Volatility stop first, size derived from the stop, a drawdown
  governor that forces size → 0 as the binding budget thins; one position at a time.
- **Tournament-aware scheduling.** A HUNT/PRESS/DEFEND week-state machine + a trailing-ratchet
  exit that never widens and keeps the right tail open.

## Answering the four criteria

- **Technical execution.** Deterministic and reimplementable from `strategy-spec.md` alone;
  every emitted signal validates against `signals.schema.json` (`pnpm skill:validate`); a
  friction-honest backtest runner reuses the live agent's own economics engine.
- **Originality.** Regime-parked flatness as a position, *uncrowded* catalyst entries keyed on
  rank-delta with an explicit no-first-spike rule, a two-ledger cost model, and tournament-aware
  risk scheduling — this is not another RSI/MACD blend.
- **Real-world relevance.** **This exact doctrine drives a live Track 1 agent with on-chain
  proof.** Agent wallet `0x2d854b16D6d46DBBEe1a1e4aCAfb4ed6Bba75349`, registered on the
  competition contract `0x212c61b9b72c95d95bf29cf032f5e5635629aed5` (registration tx
  `0x373533515876f5e7c460419816d7cb4f5bfb02ac55d276eb9d3233328e03ad53`, status `0x1`). It has
  executed a live spot round-trip on BSC mainnet and an **autonomous watchdog-driven exit**
  on-chain. The Skill is the same brain, published as a spec — not a hypothetical.
- **Demo.** Two commands: `pnpm install` then `pnpm skill:backtest` — replays the spec over
  price history using only `defaults.json`, applies modeled friction, and emits schema-valid
  signals. A **real** 30-day run across twelve liquid assets versus BNB is committed in
  `backtest/results/`; reproduce with `CMC_API_KEY=… SKILL_BACKTEST_REAL=1 pnpm skill:backtest`.
  Catalyst is explicitly non-evaluable without historical CMC trending ranks; RS produced no
  closed trades; momentum results are modest and negative under un-tuned defaults. Nothing is
  inflated or backfilled.

## Honest stance on parameters

The Skill publishes the **full framework** with documented **public reference defaults**. It
intentionally does **not** publish the live agent's *calibrated* values (tuned score bands,
calibrated score→move mapping, deployed thresholds): the submission is public on June 21 and
the scored window opens June 22, so publishing the calibrated edge would invite mirroring. A
calibration procedure is included so anyone can tune the defaults on recent data. Backtest
results are real-or-absent, never fabricated.

## How to read it

`SKILL.md` (the Skill) → `strategy-spec.md` (the full rules) → `signals.schema.json` (the
output contract) → `backtest/` (runner + methodology + evidence).
