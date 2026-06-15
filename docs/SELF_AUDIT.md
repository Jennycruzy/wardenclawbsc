# Self-Audit

Status date: June 15, 2026. This audit covers the win-first upgrade on `main`.
External actions still requiring the operator are listed in `docs/PREFLIGHT.md`;
the code never labels them complete without real evidence.

## Hard invariants

- Spot-only, chain 56, PancakeSwap router, eligible contracts on both legs.
- Native BNB is gas only; BNB/WBNB cannot be held as a position.
- The LLM cannot score, size, approve, or execute.
- Every entry passes deterministic score, eligibility, scored net-edge, wallet
  floor, stop coherence, governor, shadow-fill, regime, and TWAK policy checks.
- No fabricated prices, fills, receipts, hashes, registration, or measured costs.

## Win-first workstreams

| WS | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Separate Scored and Wallet Ledgers; scored cost retunable by env; both economics on mandates | implemented | `scoredCost.ts`, `ledgers.ts`, `netEdgeGate.ts`, `pipeline.ts`, `mandate.ts`; `economics.test.ts`, `ledgers.test.ts`, `pipeline.test.ts` |
| 2 | Restart-safe HWM trailing stop, breakeven+fees, never widens, no fixed take-profit | implemented | `trailingStop.ts`, `positionStore.ts`; `trailingStop.test.ts` |
| 3 | 45s protection-only watch loop, staleness alert, forced TWAK exit, heartbeat | implemented | `positionWatch.ts`, worker `runWatchLoop`, `/bsc/ops`; `positionWatch.test.ts` |
| 4 | TWAK-first x402; explicit labeled viem fallback; required-payment failure blocks trade | implemented | `twak-adapter/x402.ts`, `CliTwakExecutor.payX402`, worker path selection; TWAK/CMC x402 tests |
| 5 | Catalyst delta/volume/post-spike gate plus two-check `rs_continuation` and per-family calibration | implemented | `signalHistory.ts`, `catalystEntry.ts`, `rsContinuation.ts`, `edgeCalibration.ts`; associated tests |
| 6 | HUNT days 1-5; exactly one day-6+ flat-band PRESS trade; +8% DEFEND; timestamped entry/exit legs; safe last-resort scout | implemented | `weekBudget.ts`, `weekLedger.ts`, worker scored book + scheduler wiring, mandate `pressTrade`; `weekBudget.test.ts`, `weekLedger.test.ts`, `pipeline.test.ts`, `scheduler.test.ts` |
| 7 | Deterministic GREEN/NEUTRAL/RED analyst using BNB short/24h trend, BTC confirmation, recent mean, breadth, Fear & Greed, volatility, and hysteresis; RED parks risk | implemented | `regimeAnalyst.ts`, worker benchmark history, risk gate, watch-loop RED exit, dashboards; `regimeAnalyst.test.ts`, `riskGates.test.ts`, `positionWatch.test.ts` |
| 8 | Measure real round-trip cost from fills; persist rolling estimate; wallet floor and dust gate react | implemented | `ledgers.ts`, worker `wallet-cost.json`, `/bsc/ops`, `/bsc/proof`; `ledgers.test.ts`, `riskGates.test.ts`, `pipeline.test.ts` |
| 9 | Dated preflight countdown; registration-first checklist; reminders escalating after June 18; final docs | implemented | API registration timer, `registrationAlertState`, `/bsc/ops`, `docs/PREFLIGHT.md`, `ECONOMICS.md`, `OPERATIONS.md`, `SPECIAL_PRIZES.md`; `runtime.test.ts` |

## Seven honesty answers

1. **Can any entry reach TWAK without eligibility, scored net-edge, wallet floor,
   stop coherence, governor, shadow-fill, and regime checks?** No. The pipeline
   produces an intent only after those checks, and TWAK policy validates it again.
2. **Can the stop widen, or can an open position run without a persisted HWM and
   active watch loop?** No. Ratchets use `max(previousStop, candidateStop)`;
   positions serialize the HWM/stop and the worker restores and watches them.
3. **Can x402 sign outside TWAK without the explicit fallback flag and label?**
   No. Viem requires `X402_FALLBACK_VIEM=true` plus its key and is recorded as
   `viem_fallback (non-TWAK)`.
4. **Can PRESS fire more than once or bypass a gate?** No. A real PRESS fill
   persists `pressTradeUsed`; subsequent cycles return to HUNT. PRESS changes only
   the score floor from 80 to 65.
5. **Can RED be overridden by the LLM, a signal, or PRESS?** No. RED is a
   Risk-Constitution rejection. Only safety exits and the last-resort stable scout
   are exempt.
6. **Are both ledgers on every mandate, and does changing
   `SCORING_SIM_COST_BPS` alone retune the scored gate?** Yes.
7. **Is anything fake, stubbed-as-real, or untested?** No fake runtime evidence is
   produced. Live registration, funding, rehearsal fills, phone delivery,
   calibration output, and DoraHacks submission are genuinely pending operator
   actions and are shown as pending. Unit/integration behavior is tested; live
   mainnet settlement still requires those credentials and funds.

## Adversarial self-review

`packages/core/test/adversarialWinFirst.test.ts` records:

| Scenario | Expected result | Result |
|---|---|---|
| +9% runner reverses | trailing exit remains wallet-positive | pass |
| Crash between decision cycles | watch tick exits before next decision cycle | pass |
| RED-regime trending spike | RED blocks entries and first spike rejects | pass |
| Flat day 6 | exactly one PRESS opportunity, then HUNT | pass |
| Crash-restart mid-trail | one position restored with exact HWM; no duplicate | pass |

Additional adversarial coverage includes off-list contracts, wrong chain/router,
non-spot intents, WBNB holding, infinite approvals, stale data, stale calibration,
wallet-ruinous scored-positive trades, scored-negative wallet-positive trades,
dust cost, dead RPC failover, malformed LLM output, and x402 failure.

## Gate

Green on June 15, 2026:

```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm --filter @wardenclaw/web build
```

Result: typecheck green, lint green, **288 tests passed**, including the live
BSC-mainnet reserve/quote read, and the production Next.js build green.
