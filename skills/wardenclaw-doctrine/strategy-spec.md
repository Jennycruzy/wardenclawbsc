# WARDENCLAW Doctrine — Deterministic Strategy Specification

A complete, backtestable, **spec-only** crypto trading strategy. It consumes CoinMarketCap
market data and emits **signals and strategy state** (regime, entry candidates, sizing,
exits, week-state) — **never orders**. No execution, signing, wallet, router, or
transaction construction appears anywhere in this skill.

This is the strategy brain of a live agent. The same doctrine runs on BSC with on-chain
proof (see `SUBMISSION.md`). This document publishes the **full framework** with **public
reference defaults** (`defaults.json`); the live agent's *calibrated* values are private by
design (see §12, Edge protection).

Determinism rule, used everywhere below: **no language model ever produces a score, a
size, or a trade decision.** An LLM may summarize context or classify news for display, but
every number in this spec is pure arithmetic over CMC inputs and configured parameters.

Conventions: `bps` = basis points (0.01%). `pct` = percent. `ATR` = recent Average True
Range expressed as a **fraction of price** (e.g. 0.04 = 4%). Parameter names in `code font`
are keys in `defaults.json`.

---

## 0. Data inputs (CMC surfaces consumed)

| Input | CMC surface | MCP tool (Agent Hub) | REST equivalent |
|---|---|---|---|
| Latest price, % change 1h/24h, 24h volume, market cap | quotes | `mcp__cmc-mcp__get_crypto_quotes_latest` | `/v2/cryptocurrency/quotes/latest` |
| Trending rank (catalyst family) | trending | `mcp__cmc-mcp__trending_crypto_narratives` | `/v1/cryptocurrency/trending/latest` |
| Fear & Greed level + delta | sentiment | `mcp__cmc-mcp__get_global_metrics_latest` | `/v3/fear-and-greed/latest` |
| Benchmark trend + breadth across majors | global/quotes | `mcp__cmc-mcp__get_global_metrics_latest`, `get_crypto_quotes_latest` | `/v1/global-metrics/quotes/latest`, quotes |

Every rule below names the surface(s) it consumes. A reading older than the staleness limit
is rejected (`REJECT_STALE_DATA`) — the strategy never acts on stale perception.

The **eligible universe** is keyed by **exact token contract address, never by ticker**
(symbols repeat across contracts). The reference universe is the liquid-majors set plus the
venue's eligible-by-contract list.

---

## 1. Market Regime Classifier — GREEN / NEUTRAL / RED (with hysteresis)

**Lead with this.** Regime is evaluated every decision cycle and gates every directional
entry. **RED = capital parked in stables by design. In a long-only spot context, deliberate
flatness is a position** — sitting out a falling, correlated tape is the trade.

**Inputs** (CMC: quotes, global-metrics, fear_greed):
- `benchmarkChange24hPct` — benchmark (BNB / eligible-majors composite) 24h change.
- `benchmarkShortChangePct` — short-horizon (1h) benchmark change.
- `btcChange24hPct` — BTC 24h change, for cross-market confirmation.
- `benchmarkAboveRecentMean` — benchmark price vs its recent decision-cycle mean (boolean).
- `fearGreed` — CMC Fear & Greed index, 0..100.
- `breadthUpFraction` — fraction of tracked majors with positive 24h change, [0,1].
- `volatilityRatio` — benchmark short-horizon absolute move ÷ majors baseline.

**Weighted raw vote** (integer score in [-3, +3]):

```
score = 0
bearishTrend = benchmarkChange24hPct <= redBenchmarkPct AND btcChange24hPct < 0
               AND benchmarkShortChangePct < 0 AND NOT benchmarkAboveRecentMean
bullishTrend = benchmarkChange24hPct >= greenBenchmarkPct AND btcChange24hPct > 0
               AND benchmarkShortChangePct > 0 AND benchmarkAboveRecentMean
if bearishTrend: score -= 2     elif bullishTrend: score += 2
if fearGreed <= redFearGreed: score -= 1   elif fearGreed >= greenFearGreed: score += 1
if breadthUpFraction <= redBreadth: score -= 1  elif breadthUpFraction >= greenBreadth: score += 1
if volatilityRatio >= highVolatilityRatio:
    if benchmarkShortChangePct < 0: score -= 1  elif benchmarkShortChangePct > 0: score += 1

rawRegime = RED   if score <= -3
            GREEN if score >= 3
            NEUTRAL otherwise
```

**Hysteresis (the part that matters more than the raw read).** Flip-flopping on one noisy
cycle is worse than reacting a cycle late. The *committed* regime only changes after
`hysteresisChecks` **consecutive** raw reads agree on a new regime; a single disagreeing
cycle resets the pending counter.

```
if rawRegime == committed: pendingRaw = committed; pendingCount = 0
else:
    pendingCount = (rawRegime == pendingRaw) ? pendingCount + 1 : 1
    pendingRaw = rawRegime
    if pendingCount >= hysteresisChecks: committed = rawRegime; pendingCount = 0
```

**Effect:** committed `RED` blocks new directional entries (`REJECT_REGIME_RED`; safety
exits and the optional compliance scout excepted) and open risk is rotated to stables.
Emits a `regime_state` signal.

Reference params: `redBenchmarkPct -4`, `greenBenchmarkPct 2`, `redFearGreed 25`,
`greenFearGreed 60`, `redBreadth 0.3`, `greenBreadth 0.6`, `hysteresisChecks 2`,
`highVolatilityRatio 1.5`.

---

## 2. Entry Family A — Catalyst / Breakout (uncrowded)

CMC trending **rank level** is a crowded, lagging signal: by the time a token tops trending,
the move is half-spent and level buyers are exit liquidity. A catalyst entry must clear
**THREE** deterministic checks (all required). CMC surfaces: trending, quotes.

**(A1) Trending DELTA, not level.** Rank must be *improving fast* or *freshly* in the top-N.
A token parked at #1 for hours scores **lower**, not higher.
```
if no current trending rank: FAIL (REJECT_TRENDING_STALE)
if no prior rank: PASS iff currentRank <= trendingTopN  (fresh top-N entry)
else improvedBy = priorRank - currentRank   # positive = climbed
     PASS iff improvedBy >= trendingDeltaMin
```

**(A2) Fresh volume expansion.** Price moving without volume is no entry.
```
baseline = mean(volume24hUsd over prior observations)
PASS iff baseline > 0 AND volume24hUsd / baseline >= volumeExpansionMin   else REJECT_NO_VOLUME_EXPANSION
```

**(A3) No-first-spike rule.** Never buy the initial vertical. Missing a parabola is free;
buying its top is not. Detect the first spike (a run-up ≥ `spikeMinPct` off the running base
followed by a pullback). If one exists, require a consolidation that:
1. has lasted ≥ `spikeCooldownChecks` checks since the peak, **and**
2. held above the retracement floor `spikeHigh - maxRetracePct × (spikeHigh - base)` throughout, **and**
3. shows **continuation** — current price reclaims/exceeds the consolidation high.
Otherwise (still vertical, broke the floor, or no continuation yet): FAIL (`REJECT_FIRST_SPIKE`).
If no spike occurred at all, a normal entry is fine.

**Pass = A1 ∧ A2 ∧ A3.** Regime-gated: blocked in committed RED. Emits an
`entry_candidate` with `family = "catalyst"`, the score, and per-check `reasons`.

Reference params: `trendingDeltaMin 5`, `trendingTopN 30`, `volumeExpansionMin 1.5`,
`spikeCooldownChecks 2`, `maxRetracePct 0.5`, `spikeMinPct 0.08`.

---

## 3. Entry Family B — Relative-Strength Continuation

Catches strength **before it is crowded**, independent of the trending list — the
"before it's crowded" entry. CMC surfaces: quotes (token + benchmark).

```
need >= consecutiveChecks observations         # else REJECT_RS_NOT_CONFIRMED
for each of the last `consecutiveChecks` checks:
    outperformBps = (token.change24hPct - benchmark.change24hPct) * 100
    confirm if outperformBps >= rsOutperformMinBps
volumeRising = volume24hUsd[last] > volume24hUsd[prev]
PASS iff (all checks confirmed) AND volumeRising            else REJECT_RS_NOT_CONFIRMED
```

Regime-gated: **GREEN / NEUTRAL only** (blocked in RED). Emits `entry_candidate` with
`family = "rs_continuation"`. Reference params: `rsOutperformMinBps 200`,
`consecutiveChecks 2`, `requireRisingVolume true`.

---

## 4. Entry Family C — Regime-Gated Momentum Rotation

The base family: rotation between the strongest liquid major and stables, taken only when
regime is GREEN/NEUTRAL. CMC surfaces: quotes, fear_greed.

A deterministic 0..100 **trade score** is the weighted sum of normalized components (weights
sum to 1):

| Component | Weight | Source |
|---|---|---|
| `momentum` (24h trend, saturating) | 0.35 | quotes |
| `liquiditySafety` (log of 24h volume vs floor) | 0.20 | quotes |
| `relativeStrength` vs benchmark (signal only — never a hold) | 0.15 | quotes |
| `sentiment` (Fear & Greed / 100) | 0.15 | fear_greed |
| `volatilitySafety` (lower 1h churn = safer) | 0.10 | quotes |
| `walletRiskState` (survival posture) | 0.05 | internal |

```
score = round(100 * Σ clamp01(component.value) * component.weight)
```

Score modes (reference): `>= huntMinScore` → attack; a lower band → scout; below → no trade.
Emits `entry_candidate` with `family = "momentum"`.

---

## 5. Cost-Aware Net-Edge Filter (two ledgers)

A directional trade must clear **two independent hurdles**. This is what makes the strategy
venue-agnostic: it separates *simulated scoring cost* from *realized venue cost*.

**Scored Ledger gate** — the number that wins a scored competition:
```
expectedMoveBps  >=  scoredFrictionBps + netEdgeMinBps        else REJECT_NET_EDGE
  where scoredFrictionBps = scoringSimCostBps * 2   (round trip = 2 legs)
```

**Wallet Ledger floor** — protects real capital even when the scored math says go:
```
if a measured real round-trip cost is available:
    expectedMoveBps  >=  walletFloorFraction * realRoundTripBps   else REJECT_WALLET_FLOOR
```
`realRoundTripBps` is **measured from real fills, never hardcoded** (it bootstraps from a
first rehearsal trade and updates on every fill). In a backtest with no fills, the wallet
floor is modeled from the friction model and may be skipped — clearly noted in results.

**Forced safety exits bypass both** (stop/trail enforcement must always be able to exit).

`expectedMoveBps` comes from the score via the **calibrated** score→move mapping (§11). The
published default uses a transparent **naive linear prior**
(`expected_move_reference_prior`): `expectedMoveBps = max(0, (score - scoreFloor) ×
bpsPerScorePoint)`. **This prior is a placeholder, not an edge** — calibrate before deploying.

Reference params: `netEdgeMinBps 30`, `scoringSimCostBps 10`, `frictionBudgetBps 120`,
`walletFloorFraction 0.75`, `dustRoundTripCeilingBps 350`.

---

## 6. Sizing — Drawdown-Budgeted Fractional Kelly

**Volatility-derived stop FIRST; position size from the stop, never the reverse.**

```
stopDistancePct = stopAtrMultiple * recentAtrPct                 # the volatility band
riskUsd         = (perTradeRiskPct / 100) * portfolioUsd
rawSizeUsd      = riskUsd / stopDistancePct
sizeUsd         = min(rawSizeUsd, maxPositionPct/100 * deployableUsd, governorCapUsd)
# Coherence: if friction at sizeUsd > frictionBudgetBps, the setup is NOT tradeable at this
# book size — REJECT_STOP_COHERENCE (do NOT tighten the stop to force a fit).
```

**Drawdown governor.** Budget risk against whichever drawdown layer binds first — the
competition disqualifier, the internal whole-window budget, or the internal daily limit —
and **shrink size toward zero as that budget thins**:
```
layers = [ competition: remaining(competitionDqDrawdownPct, windowDrawdownPct),
           window:      remaining(internalWindowDrawdownPct, windowDrawdownPct),
           daily:       remaining(maxDailyDrawdownPct, dailyDrawdownPct) ]
binding       = layer with the LEAST remaining headroom
edge          = clamp01(edgeEstimate)                 # calibrated hit-rate of the score band
baseFraction  = kellyFraction * edge
budgetRatio   = binding.remaining / binding.cap       # → 0 as the budget is exhausted
sizeFraction  = max(0, min(baseFraction, maxPositionFraction * budgetRatio, maxPositionFraction))
```
As the binding budget approaches its cap, `budgetRatio → 0`, so **size is forced to 0 near
the cap**. The governor never exceeds caps and never overrides the net-edge gate.
**Concurrency cap = one position** (`maxConcurrentPositions 1`).

Emits a `sizing` signal (`size_fraction`, `binding_layer`, `stop_distance_pct`, reasons).

Reference params: `kellyFraction 0.25`, `perTradeRiskPct 3`, `maxPositionPct 70`,
`maxConcurrentPositions 1`, `competitionDqDrawdownPct 30`, `internalWindowDrawdownPct 15`,
`maxDailyDrawdownPct 6`, `softDrawdownPct 4`, `survivalLossStreak 2`.

---

## 7. Exits — Trailing Ratchet Doctrine

Deterministic, evaluated on a fast watch cadence. The stop **only ever moves up**. No fixed
take-profit — the right tail stays open.

```
1. Initial stop   = entry * (1 - stopAtrMultiple * atrPct)
2. Breakeven+costs: once unrealized gain >= breakevenTriggerAtr * atrPct, arm and raise the
                    stop to entry * (1 + realRoundTripBps/10000) — a runner can never turn
                    back into a wallet loss. (Latches on.)
3. Trail          : once armed, trail trailMult * atrPct below the high-water mark (HWM),
                    where trailMult = tightMode ? trailTightAtrMultiple : trailAtrMultiple
stop = max(previous stop, breakeven+costs candidate, HWM trail candidate)   # ratchet up only
breach: currentPrice <= stop  → FORCED SAFETY EXIT (bypasses net-edge; still respects
        eligibility/slippage). exit_reason = breakeven armed ? EXIT_TRAIL_RATCHET : EXIT_STOP
```

**Tight-trail mode** (DEFEND / RED) trails at the tighter `trailTightAtrMultiple`. Regime
turning RED forces a rotation to stables (`EXIT_REGIME_RED`); a portfolio-danger watchdog can
force `EXIT_PORTFOLIO_DANGER`. Emits an `exit_instruction` (`action` = HOLD/EXIT).

Reference params: `stopAtrMultiple 1.5`, `breakevenTriggerAtr 1.0`, `trailAtrMultiple 1.5`,
`trailTightAtrMultiple 1.0`.

---

## 8. Week-State Machine — HUNT / PRESS / DEFEND

Generic **competition/window-aware risk scheduling**. These controls only make gates
*stricter* or lower the score threshold for **one** pre-committed trade; they never bypass
eligibility, net-edge, coherence, the governor, or exits.

```
day = floor(weekElapsedFraction * weekLengthDays) + 1
legsRemaining = max(0, weeklyLegBudget - legsUsed)
reservedLegs  = remainingDays * reservedLegsPerDay
legsScarce    = legsRemaining <= reservedLegs

DEFEND  if weekReturnPct > defendTriggerPct:
        minimumScore = defendMinScore; netEdgeBonusBps = netEdgeDefendBonusBps; tightTrail = true
PRESS   elif day >= pressStartDay AND weekReturnPct in [flatBandLoPct, flatBandHiPct]
             AND not pressTradeUsed AND not legsScarce:
        minimumScore = pressMinScore; pressTrade = true     # exactly ONE lowered-band shot
HUNT    else:
        minimumScore = huntMinScore                          # full aggression early
```

- **HUNT** — full aggression early in the window.
- **PRESS** — if still flat late (day ≥ `pressStartDay`) and inside the flat band, exactly one
  pre-committed trade at the lowered `pressMinScore`.
- **DEFEND** — protecting a meaningful lead: tightened trail + raised score threshold +
  extra net-edge margin.

Emits a `week_state` signal. Reference params: `weeklyLegBudget 14`, `flatBandLoPct -2`,
`flatBandHiPct 3`, `defendTriggerPct 8`, `huntMinScore 80`, `pressMinScore 65`,
`defendMinScore 90`, `netEdgeDefendBonusBps 50`, `pressStartDay 6`, `reservedLegsPerDay 1`,
`weekLengthDays 7`.

---

## 9. Compliance layer (generic, optional)

For venues that impose a **minimum-activity** rule. Minimum-activity awareness with a
**stable↔stable last-resort trade**: when the period is about to close below the required
trade count and no directional setup qualifies, a tiny `microScoutUsd` stable↔stable swap
satisfies the rule **without taking directional risk**. Described as an optional module —
omit it on venues with no such rule. Reference params: `minTradesPerDay 1`,
`minTradesPerWeek 7`, `microScoutUsd 5`.

---

## 10. Decision-cycle order of operations

```
1. Refresh CMC perception (quotes, trending, fear_greed); reject stale data.
2. Evaluate regime → emit regime_state. If committed RED: block directional entries.
3. Evaluate week-state → emit week_state (sets minimumScore, bonuses, tightTrail).
4. For each eligible candidate: evaluate the relevant family (A/B/C) → emit entry_candidate.
   Drop below minimumScore; drop families disallowed by regime.
5. For the best surviving candidate: net-edge gate (§5). Drop on REJECT_NET_EDGE/WALLET_FLOOR.
6. Sizing: stop-coherence + drawdown governor (§6) → emit sizing. Drop on REJECT_STOP_COHERENCE
   or size_fraction == 0.
7. For any open position: evaluate the trailing ratchet (§7) → emit exit_instruction.
8. (Optional) compliance scout if the activity floor is at risk (§9).
```

A competent quant can reimplement the strategy from §1–§10 alone.

---

## 11. Calibration procedure (replace the reference prior before deploying)

The score→`expectedMoveBps` mapping and the per-band `edgeEstimate` are the single numbers
deciding whether the strategy ever trades, so they must come from **real history, not a
guess**. Procedure:

1. Replay ~30 days of real CMC history across the eligible universe through families A/B/C,
   recording each observed `(score, realizedMoveBps, win, family)` sample.
2. Form score bands at chosen thresholds (e.g. 65 / 75 / 80 / 90). For each band compute the
   **average realized move (bps)** and the **hit rate** — per family.
3. `expectedMoveBps(score)` = realized move of the highest band the score meets;
   `edgeEstimate(score)` = that band's hit rate (feeds the governor).
4. Tune `netEdgeMinBps` **per family** so bands whose realized move is below friction never
   trade. Re-run on a fresh window before each deployment; treat a calibration older than
   `calibrationMaxAgeDays` as stale.

This procedure is faithfully published. The **resulting calibrated numbers** for the live
deployment are intentionally **not** in this folder (§12).

---

## 12. Edge protection — public framework, private calibration

This skill publishes the entire framework with honest reference defaults so a panel can
backtest and trust it. It deliberately **excludes** the live agent's calibrated values: the
tuned score bands, the calibrated score→move mapping, deployed ATR multiples, trending-delta
thresholds, press/defend triggers, and `netEdgeMinBps` **as actually deployed**. Those live in
a private runtime config and are never copied here. The submission is public on **June 21,
2026**; the scored trading window opens **June 22** — publishing the calibrated edge would
invite mirroring during the scored week. Splitting public framework from private calibration
is standard published-strategy practice.
