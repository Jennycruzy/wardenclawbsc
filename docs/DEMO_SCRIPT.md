# WARDENCLAW BSC — Four-Minute Track 1 + Track 2 Demo

Primary URL: [wardenclawbsc.duckdns.org](https://wardenclawbsc.duckdns.org/bsc)

## Recording setup

Open these before recording:

1. `https://wardenclawbsc.duckdns.org/bsc`
2. `https://wardenclawbsc.duckdns.org/bsc/proof`
3. `https://wardenclawbsc.duckdns.org/bsc/ops`
4. `https://wardenclawbsc.duckdns.org/bsc/rules`
5. `skills/wardenclaw-doctrine/SKILL.md` on GitHub
6. A terminal in the repository

Never show `.env`, private keys, access tokens, wallet configuration, or VPS
credentials.

## 0:00–0:25 — Product

Show `/bsc`.

> WARDENCLAW combines two submissions around one deterministic trading doctrine.
> Track 1 is a live, self-custodial BNB Smart Chain agent. Track 2 packages the
> same strategy as a reusable CoinMarketCap Skill. CMC supplies perception,
> deterministic code controls decisions and risk, and Trust Wallet Agent Kit is
> the sole signing boundary.

Point to the competition status cards.

> Preflight evidence is separated from June 22-to-28 competition scoring, so
> rehearsal activity cannot inflate returns or trade counts.

## 0:25–1:05 — Track 1 strategy and deterministic gate chain

Remain on `/bsc`.

> The agent searches three families: momentum rotation, catalyst breakouts, and
> relative-strength continuation. Catalyst entries require improving trending
> rank, volume expansion, a cooldown after the first spike, and continuation.
> Relative strength must persist across consecutive checks.

> Every candidate passes exact contract eligibility, liquidity and route safety,
> calibrated expected move, simulated scoring cost, measured wallet friction,
> volatility-based stop and sizing, drawdown limits, stop coherence, and a
> shadow-fill check. Language-model output cannot score, size, approve, sign, or
> execute a trade.

## 1:05–1:45 — Red-day regime and week-state risk

Switch to `/bsc/ops` and point to “Red-day regime.”

> The regime engine classifies GREEN, NEUTRAL, or RED from BNB short and 24-hour
> trend, BTC confirmation, benchmark position versus its recent mean, volatility,
> Fear and Greed, and market breadth. Hysteresis requires repeated confirmation,
> preventing one noisy reading from changing state.

> GREEN allows normal opportunity selection. NEUTRAL remains selective. RED
> blocks new directional entries and tells the watchdog to rotate open risk back
> to eligible stablecoins. In a long-only spot system, deliberate flatness is a
> valid position.

Point to the week-state section.

> During the competition the scheduler moves through HUNT, PRESS, and DEFEND.
> HUNT seeks qualified edge, PRESS permits one controlled late-week opportunity,
> and DEFEND raises entry quality and tightens the trailing stop when protecting
> gains. None of these states bypasses the core risk gates.

## 1:45–2:20 — Custody, execution proof, and watchdog

Switch to `/bsc/proof`.

> This is the evidence layer: registered wallet, registration transaction,
> competition-only return and drawdown, confirmed trade legs, and BSC transaction
> anchors. The rehearsal scout is shown separately and does not count toward the
> competition.

> WARDENCLAW uses two ledgers. The scored ledger applies the competition cost
> model. The wallet ledger uses actual execution proceeds and measured friction
> to protect real capital.

> Open positions use a persistent high-water-mark trailing stop. It advances from
> the volatility stop to breakeven plus costs, then ratchets behind favorable
> movement and never widens. A fast watchdog runs between decision cycles and can
> exit on a crossed stop, unsafe data, portfolio danger, or RED regime.

## 2:20–2:45 — TWAK signer-side refusals

Run:

```bash
pnpm demo:twak-refusal
```

> The signer independently accepts a valid spot swap and rejects non-spot
> trading, the wrong chain, unknown spenders, ineligible contracts, held WBNB,
> unlimited approvals, excessive size, and mandate mismatch. These refusals
> happen before signing, even if an upstream component is compromised.

## 2:45–3:05 — Operations and confirmed rules

Return to `/bsc/ops`.

> Operations shows integration readiness, wallet funding, registration,
> rehearsal evidence, calibration, alerts, kill-switch readiness, process
> heartbeat, measured round-trip cost, and the competition countdown.

Briefly show `/bsc/rules`.

> The public Rules page displays only confirmed competition requirements and
> their implementation references.

## 3:05–3:35 — Track 2 Strategy Skill

Open `skills/wardenclaw-doctrine/SKILL.md` on GitHub.

> Track 2 is `wardenclaw-doctrine`, a standalone CMC Strategy Skill containing the
> same regime, entry, net-edge, sizing, trailing-exit, and HUNT/PRESS/DEFEND
> doctrine. It is intentionally spec-only: it emits strategy state and signals,
> never orders, wallets, signatures, or transactions.

Show:

- `strategy-spec.md`
- `signals.schema.json`
- `defaults.json`
- `examples/example-signals.jsonl`

> The public defaults are documented reference parameters. The full behavior is
> reproducible from the specification and every output has a published schema.

## 3:35–3:55 — Track 2 validation and backtest

Run:

```bash
pnpm skill:validate
pnpm skill:backtest
```

> Validation confirms all five output kinds: regime state, week state, entry
> candidate, sizing, and exit instruction. The backtest applies friction and
> produces per-family results plus an equity curve. Without a CMC key it uses a
> clearly labeled synthetic fixture for reproducibility, never as claimed market
> performance; real-data runs are labeled separately.

## 3:55–4:00 — Close

Return to `/bsc/proof`.

> Track 1 proves guarded self-custodial execution on BSC. Track 2 makes the same
> strategy portable and inspectable. WARDENCLAW trades only when measured edge
> survives friction, custody, and risk constraints.

## Backup

Record one clean take while the public deployment is healthy. If networking
fails, run:

```bash
pnpm --filter @wardenclaw/web dev
```

Then use `http://localhost:3000/bsc` with the same sequence.
