# WARDENCLAW BSC — Combined Track 1 + Track 2 Demo

Primary demo URL: [wardenclawbsc.duckdns.org](https://wardenclawbsc.duckdns.org/bsc)

Target duration: 4–5 minutes.

## Before recording

Open these tabs:

1. `https://wardenclawbsc.duckdns.org/bsc`
2. `https://wardenclawbsc.duckdns.org/bsc/proof`
3. `https://wardenclawbsc.duckdns.org/bsc/ops`
4. `https://wardenclawbsc.duckdns.org/bsc/rules`
5. `skills/wardenclaw-doctrine/SKILL.md` on GitHub

Prepare a terminal in the repository:

```bash
pnpm demo:twak-refusal
pnpm skill:validate
pnpm skill:backtest
```

Do not expose `.env`, private keys, access tokens, wallet configuration, or VPS
credentials during the recording.

## Spoken demo

### 0:00–0:25 — Problem and product

Show `/bsc`.

> WARDENCLAW is a self-custodial, spot-only trading agent on BNB Smart Chain.
> It is designed for a micro-capital competition account, where drawdown and
> transaction friction can matter more than raw signal frequency. CoinMarketCap
> provides market perception, deterministic rules make every trading decision,
> and Trust Wallet Agent Kit is the sole signing and execution boundary.

### 0:25–1:10 — Track 1 decision system

Remain on `/bsc` and point to regime, strategy state, candidates, and mandates.

> The agent evaluates momentum rotation, catalyst breakouts, and
> relative-strength continuation. A GREEN, NEUTRAL, or RED market regime controls
> whether directional risk is allowed. Every candidate must pass contract
> eligibility, expected net edge, measured wallet friction, volatility-based
> sizing, drawdown budgets, stop coherence, and a shadow-fill check. The model
> cannot score, size, approve, or execute a trade.

### 1:10–1:50 — Track 1 proof and custody

Switch to `/bsc/proof`.

> This page is the evidence layer. It shows the registered agent wallet,
> registration transaction, executed legs, wallet and scored ledgers, and BSC
> transaction anchors. The two ledgers are deliberate: competition scoring uses
> simulated costs, while the wallet ledger protects actual capital using measured
> execution friction.

Point to the wallet and transaction links.

> The backend never holds the signing key. It creates a validated mandate, then
> TWAK rechecks chain, router, token allowlists, approval bounds, and action
> consistency before signing.

### 1:50–2:25 — Guardrail demonstration

Switch to the terminal and run:

```bash
pnpm demo:twak-refusal
```

> Here is the signer-side policy in action. A valid spot swap is accepted, while
> non-spot trading, the wrong chain, an unknown spender, an ineligible token,
> holding WBNB, unlimited approval, excessive size, and mandate mismatch are
> rejected before signing. These controls remain effective even if an upstream
> component fails.

### 2:25–2:55 — Operations and survival

Switch to `/bsc/ops`.

> The operations page shows registration, process health, regime, measured
> round-trip cost, watchdog state, and the competition countdown. Open positions
> use a persistent high-water-mark trailing stop. A separate watchdog runs
> between decision cycles and can exit on a crossed stop, unsafe data, or a RED
> regime.

Briefly show `/bsc/rules`.

> Competition assumptions are explicit. Verified rules are separated from open
> organizer questions, which use clearly labeled internal safety assumptions
> instead of hidden guesses.

### 2:55–3:25 — Track 2 transition

Open `skills/wardenclaw-doctrine/SKILL.md` on GitHub.

> Track 2 packages the same strategy brain as `wardenclaw-doctrine`, a standalone
> CoinMarketCap Strategy Skill. It is intentionally spec-only: it consumes market
> data and emits regime, entry, sizing, week-state, and exit signals as JSON. It
> cannot construct or sign a transaction.

> This makes the strategy portable and inspectable. Another builder can implement
> the doctrine from the specification without receiving custody or execution
> access.

### 3:25–4:10 — Track 2 reproducibility

Run:

```bash
pnpm skill:validate
pnpm skill:backtest
```

> The validator checks every emitted signal against the published JSON Schema.
> The backtest command replays the doctrine with its documented reference
> defaults and includes friction. Without a CMC key it uses an explicitly labeled
> synthetic fixture for reproducibility, not as claimed market performance. A
> real-data run requires the CMC key and is labeled separately.

Show:

- `skills/wardenclaw-doctrine/signals.schema.json`
- `skills/wardenclaw-doctrine/strategy-spec.md`
- `skills/wardenclaw-doctrine/backtest/results/`

### 4:10–4:35 — Why the two tracks belong together

Return to `/bsc/proof`.

> Track 1 proves that the system can operate as a guarded, self-custodial BSC
> agent with on-chain evidence. Track 2 extracts the same deterministic strategy
> into a reusable CMC Skill. One is the live execution system; the other is the
> portable strategy specification. They share the same doctrine without sharing
> custody.

### 4:35–4:50 — Close

> WARDENCLAW's core principle is simple: trade only when measured edge survives
> real friction and risk constraints, keep custody at the signer, and make every
> important decision reproducible.

## Recording fallback

If the live site is unavailable:

```bash
pnpm --filter @wardenclaw/web dev
```

Use `http://localhost:3000/bsc` and the same page sequence. Record a clean backup
take before submission even if the public deployment is healthy.
