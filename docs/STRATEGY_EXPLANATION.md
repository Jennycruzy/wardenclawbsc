# WARDENCLAW BSC — Strategy Explanation

WARDENCLAW is a spot-only BNB Smart Chain trading agent designed for a small
competition account where transaction friction and drawdown limits matter as
much as signal quality. It holds one eligible BEP-20 position at a time and
parks capital in eligible stablecoins when no setup clears every risk gate.

## Market selection

The agent evaluates three entry families:

- Momentum rotation into the strongest liquid eligible asset.
- Catalyst breakouts confirmed by improving CMC trending rank, volume expansion,
  consolidation, and continuation after the initial spike.
- Relative-strength continuation confirmed across consecutive observations.

A deterministic GREEN/NEUTRAL/RED regime classifier uses BNB and BTC trend,
market breadth, Fear & Greed, and volatility. RED blocks directional entries.

## Entry and sizing

Every candidate must use exact allowlisted contract addresses on BSC chain 56.
The expected move must clear the competition's simulated cost, measured wallet
friction, and an additional edge margin. Position size is derived from a
volatility stop and constrained by the competition drawdown cap, internal
drawdown budget, daily loss limit, wallet gas reserve, and dust economics.

The agent rejects a trade if its size is too small to survive friction or too
large for the remaining risk budget.

## Position management

Open positions are protected by a persistent high-water-mark trailing stop. The
stop starts from volatility, advances to breakeven plus costs when justified,
then ratchets behind favorable price movement. It never widens and there is no
fixed take-profit, allowing profitable trends to continue while protecting
realized edge.

A separate watchdog checks open positions between decision cycles and can force
an exit when the stop is crossed, market data becomes unsafe, or the regime
turns RED.

## Execution and custody

The backend produces a validated trade mandate but does not hold a private key.
Trust Wallet Agent Kit is the signing and execution boundary. Its local policy
rechecks chain, router, token eligibility, spot-only intent, approval limits,
and mandate validity before signing.

The registered BSC agent wallet is
`0x2d854b16D6d46DBBEe1a1e4aCAfb4ed6Bba75349`. Registration transaction
`0x373533515876f5e7c460419816d7cb4f5bfb02ac55d276eb9d3233328e03ad53`
was confirmed successfully on the competition contract.

## Competition behavior

The weekly state machine uses three modes:

- HUNT: normal selective trading while drawdown capacity is healthy.
- PRESS: one controlled late-week opportunity if minimum activity is at risk.
- DEFEND: tighter entries and trailing protection when preserving gains.

If no directional trade has positive net edge near a required activity
deadline, the only permitted fallback is a small eligible stable-to-stable
trade. The agent does not force a negative-edge directional position.

## Operating principle

The strategy favors selective, measurable edge over trade frequency. Market
data may be summarized upstream, but scoring, eligibility, sizing, risk
approval, stop management, and execution authorization are deterministic.
