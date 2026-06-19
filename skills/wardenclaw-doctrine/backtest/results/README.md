# results/

Evidence directory for the skill backtest.

- **`FIXTURE_demo-run.json`** — a clearly-labeled run over the **documented synthetic fixture**
  (`is_real_market_evidence: false`). It proves the runner works end-to-end and that the spec
  produces the expected per-family behavior. It is **not** real-market performance evidence.

- **`per-family.json` + `equity-curve.csv`** — the **real** run
  (`is_real_market_evidence: true`, `data_source: "cmc-history"`): ~90 days of real ETH vs BNB
  daily OHLCV, defaults-only, friction applied. Reproduce with:

  ```bash
  CMC_API_KEY=your_key SKILL_BACKTEST_REAL=1 pnpm skill:backtest
  ```

  The CMC key is used only at run time and is **never committed**. See
  [`../METHODOLOGY.md`](../METHODOLOGY.md) for the full rationale and honesty caveats
  (the real results are deliberately modest/unflattering — un-tuned conservative defaults).
