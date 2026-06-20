# WARDENCLAW BSC — Comprehensive Judge Demo & Reproduction Guide

**Live demo:** [wardenclawbsc.duckdns.org/bsc](https://wardenclawbsc.duckdns.org/bsc)
**Tracks:** Track 1 (live self-custodial BSC agent) + Track 2 (portable CMC Strategy Skill)
**This doc has three parts:** (A) the recorded video script, (B) a self-serve
reproduction guide judges can run themselves, and (C) reference material to answer
any question on the spot.

---

## TL;DR for judges (read this first)

WARDENCLAW is a self-custodial BNB Smart Chain trading agent built on one rule:
**the language model can perceive, but it can never trade.** CoinMarketCap is the
eyes; deterministic, tested code is the decision-and-risk brain; Trust Wallet Agent
Kit (TWAK) is the only hand that can sign — and it independently refuses anything
off-mandate before signing. The same strategy ships twice: as the live agent
(Track 1) and as a portable, spec-only CoinMarketCap Skill (Track 2).

Five things that distinguish it:

1. **The LLM is provably outside the money path** — scoring, sizing, approval,
   signing, and execution are deterministic and tested (371 passing tests).
2. **Real on-chain proof** — registered wallet, a real registration transaction,
   and live mainnet spot swaps shown on `/bsc/proof`.
3. **An independent signer-side refusal layer** — demoed live; holds even if
   everything upstream is compromised; no funds move.
4. **Honest accounting** — preflight/rehearsal is walled off from June 22–28
   scoring, and every claim is labeled real vs. unverified.
5. **Reproducible without our secrets** — the entire deterministic core and both
   terminal demos run offline from a clean clone (see Part B). No keys in the repo.

**Anchored facts (verified before recording):** all four pages return HTTP 200
live; `pnpm test` → 371 passing; agent wallet `0x2d854b16D6d46DBBEe1a1e4aCAfb4ed6Bba75349`;
registration tx `0x3735…ad53` on contract `0x212c…aed5` (status `0x1`, block
104452111); refusal demo → 1 APPROVE + 8 `REJECT_*`; skill validation → 16 signals,
all 5 kinds.

> **Never show on camera:** `.env`, private keys, access tokens, wallet
> seed/config, VPS credentials. `/bsc/proof` shows only public on-chain identifiers
> — that is the correct surface to display.

---

# PART A — Recorded video script (~4:00, with a 60-second [CORE] cut)

**Open before recording:** `/bsc`, `/bsc/proof`, `/bsc/ops`, `/bsc/rules`,
`/bsc/mandates`, `skills/wardenclaw-doctrine/SKILL.md` on GitHub, and a terminal in
the repo.

### 0:00–0:25 — The thesis **[CORE]**
Show `/bsc`.

> WARDENCLAW is two submissions around one deterministic doctrine. Track 1 is a
> live, self-custodial BSC agent; Track 2 is the same strategy as a reusable
> CoinMarketCap Skill. CoinMarketCap is the eyes, deterministic code is the
> decision-and-risk brain, and Trust Wallet Agent Kit is the only hand that signs.
> The language model never scores, sizes, approves, signs, or executes a trade.

Point to the **Two tracks, one doctrine** card, then the four status tiles above it.

> Preflight and rehearsal evidence is separated from the June 22-to-28 competition
> window — see "preflight executions: evidence only, not scored" and "approvals:
> June 22-28 only" — so nothing we do in testing can inflate the scored return or
> trade count.

### 0:25–1:05 — The deterministic gate chain **[CORE]**
Remain on `/bsc`; scroll to the **Strategy — three uncrowded edges** card.

> The agent hunts three uncrowded edge families: catalyst breakouts,
> relative-strength continuation, and regime-gated momentum rotation. A catalyst
> entry needs improving trending rank, volume expansion, a cooldown after the first
> spike, and confirmed continuation; relative strength must persist across checks.

Point to the **Gate chain** line on that same card.

> Every candidate then runs the full gauntlet — exact contract eligibility,
> liquidity and route safety, a calibrated expected move, the competition's
> simulated cost, measured wallet friction, a volatility stop with size coherence,
> a three-layer drawdown governor, a shadow-fill check, and the Risk Constitution.
> If measured edge doesn't clear friction plus simulated cost plus a margin, the
> trade is skipped — never forced.

### 1:05–1:45 — Regime and week-state risk
Switch to `/bsc/ops`, point to "Red-day regime."

> The regime engine votes GREEN, NEUTRAL, or RED over BNB trend, BTC confirmation,
> benchmark-versus-mean, volatility, Fear and Greed, and breadth, with hysteresis
> so one noisy tick can't flip state. RED blocks new entries and tells the watchdog
> to rotate open risk back to eligible stablecoins. In a long-only spot system,
> deliberate flatness is a position.

Point to week-state.

> Across the window the scheduler moves through HUNT, PRESS, and DEFEND — seek
> edge, allow one controlled late-week entry, then raise entry quality and tighten
> the trailing stop to protect gains. None of these states bypasses the risk gates.

### 1:45–2:20 — Custody, on-chain proof, and the watchdog **[CORE]**
Switch to `/bsc/proof`.

> This is the evidence layer: the registered wallet, the on-chain registration
> transaction, competition-only return and drawdown, confirmed trade legs, and BSC
> transaction anchors. The rehearsal scout is shown separately and does not count.

> Two ledgers run in parallel: a scored ledger applying the competition cost model,
> and a wallet ledger using actual proceeds and measured friction to protect real
> capital. Open positions ride a persistent high-water-mark trailing stop that
> ratchets behind favorable moves and never widens, and a fast watchdog between
> cycles can exit on a crossed stop, unsafe data, portfolio danger, or RED regime.

### 2:20–2:50 — TWAK signer-side refusals (run live) **[CORE]**
In the terminal:

```bash
pnpm demo:twak-refusal
```

Expected — one approve, eight refusals, each with a reason code:

```
✓ APPROVE  clean spot swap (APPROVED)         safe to sign
✗ REFUSE   non-spot / perp route              REJECT_NON_SPOT
✗ REFUSE   wrong chain (Ethereum)             REJECT_WRONG_CHAIN — chainId 1 != 56
✗ REFUSE   unknown spender                    REJECT_SPENDER_NOT_ALLOWED
✗ REFUSE   off-list token out                 REJECT_INELIGIBLE_CONTRACT
✗ REFUSE   holding WBNB as a position         REJECT_HELD_NATIVE_OR_WBNB
✗ REFUSE   infinite approval                  REJECT_INFINITE_APPROVAL
✗ REFUSE   over per-trade cap                 REJECT_OVER_MAX_TRADE — $100 > $30
✗ REFUSE   decoded action != mandate          REJECT_ACTION_MISMATCH
```

> The signer accepts a valid spot swap and independently rejects everything
> off-mandate. No funds move, and every outcome is written to a hash-chained audit
> log. This is the last line of defense — it holds even if an upstream component is
> compromised.

### 2:50–3:10 — Mandates, operations, and confirmed rules
Show `/bsc/mandates` briefly.

> Every decision the agent makes is a Signal Mandate with full perception
> attribution and the gate outcomes that produced it — each is independently
> replayable.

Return to `/bsc/ops`.

> Operations shows integration readiness, wallet funding, registration, rehearsal
> evidence, calibration, alerts, kill-switch readiness, the process heartbeat,
> measured round-trip cost, and the competition countdown.

Briefly show `/bsc/rules`.

> The Rules page shows only confirmed competition requirements with their
> implementation references; where organizer rules are still ambiguous, we label
> our internal assumption rather than claim it as fact.

### 3:10–3:40 — Track 2: the portable Strategy Skill
Open `skills/wardenclaw-doctrine/SKILL.md` on GitHub.

> Track 2 is `wardenclaw-doctrine`: the same regime, entry, net-edge, sizing,
> trailing-exit, and HUNT/PRESS/DEFEND doctrine packaged as a standalone CMC
> Strategy Skill. It is intentionally spec-only — it emits strategy state and
> signals as JSON and never produces an order, wallet, signature, or transaction.

Show `strategy-spec.md`, `signals.schema.json`, `defaults.json`,
`examples/example-signals.jsonl`.

### 3:40–3:55 — Track 2 validation and backtest (run live)
```bash
pnpm skill:validate
pnpm skill:backtest
```

Expected:

```
✓ All 16 signals valid against signals.schema.json.
✓ All five signal kinds present: regime_state, week_state, entry_candidate, sizing, exit_instruction.

[skill:backtest] FIXTURE demo run (no CMC_API_KEY / SKILL_BACKTEST_REAL unset).
  [catalyst]        trades=1 win=100% avgMove=7.69%  return=2.61% maxDD=4.26%
  [rs_continuation] trades=1 win=100% avgMove=9.27%  return=4.08% maxDD=0%
  [momentum]        trades=1 win=100% avgMove=14.18% return=8.74% maxDD=5.36%
```

> Validation confirms all five output kinds. The backtest applies friction and
> reports per-family results — and it loudly labels itself a synthetic fixture when
> there's no CMC key, so it's never mistaken for market performance. Real-data runs
> are labeled separately.

### 3:55–4:00 — Close **[CORE]**
Return to `/bsc/proof`.

> Track 1 proves guarded, self-custodial execution on BSC. Track 2 makes the same
> doctrine portable and inspectable. WARDENCLAW trades only when measured edge
> survives friction, custody, and risk — and when it shouldn't trade, it doesn't.

### The 60-second [CORE] cut
`/bsc` thesis (15s) → `/bsc/proof` registration tx + two ledgers (15s) →
`pnpm demo:twak-refusal` live (25s) → close on `/bsc/proof` (5s).

---

# PART B — Reproduce it yourself (judges, no VPS, no secrets needed)

Everything in this section runs from a clean clone on `localhost`. None of it needs
our VPS, and the offline subset needs **no API key** — because no secrets live in
the repo.

### B.1 — One-time setup
```bash
git clone <repo-url> && cd wardenclawbsc
pnpm install
```

### B.2 — Run the whole deterministic core OFFLINE (no key required)
```bash
pnpm test                  # 371 tests: gates, policy, sizing, regime, watchdog
pnpm demo:twak-refusal     # signer refuses 8 off-mandate intents, approves 1
pnpm skill:validate        # 16 signals valid; all 5 signal kinds present
pnpm skill:backtest        # per-family backtest on a LABELED synthetic fixture
pnpm verify:integrations    # readiness report (shows what live mode would need)
pnpm explain:strategy      # regenerates the audit-grounded write-up (LLM optional)
```

These five commands are the core of the submission and reproduce identically on any
machine. `demo:twak-refusal` also appends a hash-chained audit record under
`data/audit/`.

### B.3 — Browse the dashboards on localhost
```bash
pnpm --filter @wardenclaw/web dev
# open http://localhost:3000/bsc
```

What you'll see locally vs. on the live VPS:

| Page | localhost (clean clone) | live VPS |
|---|---|---|
| `/bsc` | Full strategy/product content | same |
| `/bsc/rules` | Full confirmed-rules content | same |
| `/bsc/mandates` | Shows whatever audit logs exist locally (e.g. the refusal demo) | full live mandate history |
| `/bsc/proof` | "Not configured / no live data" placeholders | **real wallet, registration tx, confirmed legs** |
| `/bsc/ops` | Readiness shows local state only | live funding/registration/heartbeat |

This is intentional: proof identifiers come from environment variables
(`REGISTRATION_TX_HASH`, `TWAK_AGENT_WALLET`, …) and runtime snapshots in
`data/runtime/`, **none of which are committed**. The public repo carries no
secrets, so the real on-chain proof only renders on the configured VPS — which is
why the live URL is part of the demo.

### B.4 — Verify our on-chain claims yourself (no clone needed)
Anyone can independently confirm the registration on a BSC explorer:

- Wallet: `0x2d854b16D6d46DBBEe1a1e4aCAfb4ed6Bba75349`
- Registration tx: `0x373533515876f5e7c460419816d7cb4f5bfb02ac55d276eb9d3233328e03ad53`
- Competition contract: `0x212c61b9b72c95d95bf29cf032f5e5635629aed5`
- Expected: status `0x1` (success), block 104452111, chain 56.

### B.5 — Live mode (operator only — not required for judging)
Live trading needs real secrets that are deliberately absent from the repo. With a
`.env` configured (`CMC_API_KEY`, TWAK config, `BSC_RPC_URLS`, alerts, kill-switch):
```bash
pnpm check:cmc             # proves the real CMC key/client/surfaces
pnpm build:eligible-tokens  # CMC-resolved eligible BEP-20 contracts
pnpm calibrate:edge        # tune score→expected-move on real history
pnpm run:bsc-agent         # dry decision run on real CMC data (no signing)
pnpm rehearsal:checklist   # §0.12 preflight gate → docs/PREFLIGHT.md
pm2 start ops/pm2.config.cjs   # run the worker under process management
```

---

# PART C — Reference (answer anything on the spot)

### C.1 — Architecture & trust boundary
```
        ┌──────────── PERCEPTION (real, attributed) ───────────┐
        │ CoinMarketCap: quotes · trending · global · F&G       │
        └───────────────────────────┬───────────────────────────┘
                                     │  (LLM may summarize/classify here only)
            ┌────────────────────────▼─────────────────────────┐
            │     DETERMINISTIC DECISION + RISK BRAIN (tested)   │
            │  score → expected move → drawdown governor →        │
            │  vol stop + size coherence → friction + sim cost →  │
            │  net-edge gate → shadow-fill → Risk Constitution    │
            └────────────────────────┬─────────────────────────┘
                                     │  Signal Mandate (no keys here)
            ┌────────────────────────▼─────────────────────────┐
            │   TWAK LOCAL POLICY (independent signer-side gate)  │
            │   refuses non-spot/chain/spender/contract/size/…    │
            └────────────────────────┬─────────────────────────┘
                                     │  (only here can anything sign)
                              TWAK signs → BSC mainnet tx
```
The LLM sits only in the top box. No private key touches the backend or a database.

### C.2 — Page-by-page reference
- `/bsc` — product overview, the Two-tracks and Strategy (entry families + gate
  chain) cards, competition status tiles, and the recent Signal Mandates feed.
- `/bsc/proof` — wallet, registration tx, competition-only return/drawdown, confirmed
  legs, BSC anchors, two-ledger view, trailing-stop state.
- `/bsc/ops` — readiness, funding, registration, rehearsal, calibration, alerts,
  kill-switch, heartbeat, round-trip cost, countdown, red-day regime, week-state.
- `/bsc/rules` — confirmed competition requirements + implementation references.
- `/bsc/mandates` and `/bsc/mandates/[id]` — every decision as an attributed,
  replayable Signal Mandate.
- `/bsc/replay/[id]` — deterministic replay of a mandate's gate outcomes.

### C.3 — Command reference (what each proves / does it need a key?)
| Command | Proves | Needs key? |
|---|---|---|
| `pnpm test` | 371 tests across gates/policy/sizing/regime | No |
| `pnpm demo:twak-refusal` | Signer-side refusals, no funds move | No |
| `pnpm skill:validate` | 16 signals valid, all 5 kinds | No |
| `pnpm skill:backtest` | Friction-honest per-family backtest (labeled fixture) | No (real if `CMC_API_KEY`+`SKILL_BACKTEST_REAL`) |
| `pnpm verify:integrations` | Live-readiness report | No |
| `pnpm explain:strategy` | Audit-grounded write-up (template if LLM off) | No |
| `pnpm check:cmc` | Real CMC key/client/surfaces | **Yes** |
| `pnpm build:eligible-tokens` | CMC-resolved eligible contracts | **Yes** |
| `pnpm calibrate:edge` | Score→move calibration on real history | **Yes** |
| `pnpm run:bsc-agent` | Dry decision run on real CMC (no signing) | **Yes** |

### C.4 — The eight TWAK refusal codes (and what each blocks)
`REJECT_NON_SPOT` (no perps/leverage/margin) · `REJECT_WRONG_CHAIN` (must be 56) ·
`REJECT_SPENDER_NOT_ALLOWED` (allowlisted routers only) · `REJECT_INELIGIBLE_CONTRACT`
(eligibility keyed by exact address, not symbol) · `REJECT_HELD_NATIVE_OR_WBNB`
(BNB/WBNB never held as a position) · `REJECT_INFINITE_APPROVAL` (bounded approvals
only) · `REJECT_OVER_MAX_TRADE` (per-trade USD cap) · `REJECT_ACTION_MISMATCH`
(decoded action must equal the signed mandate's action).

### C.5 — Honest real vs. unverified
| Layer | Status |
|---|---|
| CMC perception | Real Pro API client; fails loud without a key; per-tool attribution |
| Deterministic gates | Real, fully tested; the LLM cannot bypass them |
| TWAK execution | Interface + local policy real and tested; SDK binding unverified in this env, fails loud (never fakes a signature/tx) |
| BSC RPC / quotes | RPC failover + constant-product quote model real; live quoter wired in worker |
| Eligible tokens | CMC-resolved authoritative file; curated canonical mainnet set as documented fallback |
| Registration / live swap | Real flows behind TWAK; performed in dress rehearsal — never simulated as done |

### C.6 — Backup & troubleshooting
- Record one clean take while the deployment is healthy (all four pages verified at
  HTTP 200 before recording).
- If the public site is down, run `pnpm --filter @wardenclaw/web dev` and use
  `http://localhost:3000/bsc` — but display real proof from the BSC explorer
  (Part B.4) since localhost won't have the live identifiers.
- The two terminal demos (`demo:twak-refusal`, `skill:validate`/`skill:backtest`)
  run fully offline and never depend on networking or the VPS.
