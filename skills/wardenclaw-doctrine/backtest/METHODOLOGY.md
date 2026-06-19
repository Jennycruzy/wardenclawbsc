# Backtest methodology & honesty caveats

## What the runner does

[`run-skill-backtest.ts`](./run-skill-backtest.ts) replays the doctrine in
[`strategy-spec.md`](../strategy-spec.md) using **only** [`defaults.json`](../defaults.json) —
never the live agent's private calibrated config. It does two things:

1. **Emits the five signal kinds** (`regime_state`, `week_state`, `entry_candidate`,
   `sizing`, `exit_instruction`) by stepping the real `@wardenclaw/core` strategy functions
   over a scenario, writing them to [`../examples/example-signals.jsonl`](../examples/example-signals.jsonl).
   Every emitted signal validates against `signals.schema.json` (`pnpm skill:validate`).
2. **Computes friction-honest per-family statistics** by running the repo's own backtester
   (`@wardenclaw/core` `runBacktest`) per family — trade count, hit rate, average realized
   move, total return, max drawdown.

The economics are the **same** ones the live agent runs: round-trip friction (gas + slippage
+ LP fee + simulated scoring cost), the two-ledger net-edge gate, and volatility-stop
coherence. Nothing is idealized away.

## Data modes

| Mode | Trigger | What it is | Used as evidence? |
|---|---|---|---|
| **Fixture (default)** | no `CMC_API_KEY` / `SKILL_BACKTEST_REAL` unset | a **documented synthetic** scenario engineered to exercise every regime, family, and week-state | **No** — schema-validity + runnable demo only |
| **Real** | `SKILL_BACKTEST_REAL=1` **and** `CMC_API_KEY` set | ~30 days of **real CMC daily OHLCV** history (`/v2/cryptocurrency/ohlcv/historical`) | **Yes** — the panel's real performance evidence |

The runner **never fabricates market data**. In real mode it fails loudly without a key.

## State of `results/` in this commit

A **real run was executed** against real CMC daily OHLCV history (a CMC key with historical
access was used at run time; the key is never committed). Committed evidence:

- **`results/per-family.json`** + **`results/equity-curve.csv`** — the **real** run
  (`is_real_market_evidence: true`, `data_source: "cmc-history"`), ~90 days of ETH (token) vs
  BNB (benchmark) daily history, defaults-only, friction applied.
- **`results/FIXTURE_demo-run.json`** — the clearly-labeled **synthetic fixture** run
  (`is_real_market_evidence: false`), so the demo is inspectable without a key.

What the real run found (honestly, not flatteringly): over a choppy ~90-day window with
**un-tuned conservative defaults**, the SMA-momentum family took 2 trades for a small net
loss, and the relative-strength family took **0** trades (ETH did not clear the conservative
200 bps outperformance-vs-BNB bar on two consecutive days with rising volume). This is the
point of publishing reference defaults rather than the calibrated edge — see the caveats below.

Reproduce it yourself (real historical OHLCV requires a CMC plan that includes the historical
endpoint):

```bash
CMC_API_KEY=your_key SKILL_BACKTEST_REAL=1 pnpm skill:backtest
# optional: SKILL_BACKTEST_DAYS=90 SKILL_BACKTEST_SYMBOL=ETH SKILL_BACKTEST_BENCHMARK=BNB
```

## Honesty caveats (read these)

- **Defaults are not tuned to the test window.** `defaults.json` are honest *reference*
  parameters, deliberately **not** the live agent's calibrated values (see `strategy-spec.md`
  §12). The `expected_move_bps` mapping used here is a transparent **naive linear prior**, not
  a calibrated edge. Calibrate on recent data (`strategy-spec.md` §11) before trusting any
  number for deployment.
- **Costs are modeled, not measured** in backtest (gas/slippage/LP/scoring-sim from the
  friction model). The live wallet floor uses costs *measured from real fills*; a backtest has
  no fills, so the wallet floor is modeled or skipped and labeled as such.
- **Past ≠ future.** A backtest over any window — synthetic or real — is not a forecast.
- **Catalyst family in real mode:** the historical OHLCV endpoint provides price/volume but
  **not** a trending-rank time series, so the catalyst rank-delta check (spec §2, A1) cannot be
  reconstructed from OHLCV alone; in real mode the catalyst family is reported on the
  price/volume legs only. The fixture mode exercises the full catalyst rule, including
  rank-delta. This limitation is the data source's, not the spec's.

A panel should trust a spec that states its limits over one that claims a 90% win rate. These
caveats are the point.
