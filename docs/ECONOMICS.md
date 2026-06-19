# Win-First Economics

A micro-capital spot book must win the scoring model without bleeding the real wallet.
WARDENCLAW therefore keeps two independent ledgers.

## Two ledgers

- **Scored Ledger:** realized price move minus `SCORING_SIM_COST_BPS` per leg.
  It drives the net-edge gate, HUNT/PRESS/DEFEND state, and judge scoreboard.
- **Wallet Ledger:** actual stable cash plus marked-to-market real fills. It
  embeds TWAK fees, gas, LP fees, and slippage; it drives capital protection,
  hourly snapshots, the wallet floor, and the dust gate.

Every completed real round trip updates rolling `realRoundTripBps`. Before the
first fill, the engine uses per-candidate modeled real friction and labels it
bootstrap, never measured.

## Entry economics

Scored edge must pass:

```text
expected_move_bps >= scored_friction_bps + NET_EDGE_MIN_BPS
```

Real-wallet sanity must also pass:

```text
expected_move_bps >= WALLET_FLOOR_FRACTION * real_round_trip_bps
```

Changing `SCORING_SIM_COST_BPS` retunes scored economics without code changes.
Forced safety exits bypass edge checks but still obey TWAK policy and slippage.

## Stops and sizing

Position size comes from the volatility stop, governor, deployable stable cash,
and `MAX_POSITION_PCT`. A setup that becomes uneconomic at the coherent size is
rejected rather than forced.

The stop starts at `STOP_ATR_MULTIPLE`, ratchets to entry plus measured fees
after `BREAKEVEN_TRIGGER_ATR`, then trails the high-water mark at
`TRAIL_ATR_MULTIPLE`. It never widens and has no fixed take-profit. RED and
DEFEND use `TRAIL_TIGHT_ATR_MULTIPLE`.

## Week doctrine

- Days 1-5: **HUNT**, score 80+.
- Day 6+: if scored return is between -2% and +3%, exactly one **PRESS** entry
  may use score 65+. It still passes every gate and is persisted as consumed.
- Above +8% scored return: **DEFEND**, score 90+, extra
  `NET_EDGE_DEFEND_BONUS_BPS`, and the tight trail.

The internal 15% window drawdown budget remains inside the competition DQ cap.
PRESS does not enlarge position size or bypass the governor.

## Compliance and execution

Executed entry and exit swaps are timestamped as legs. Near UTC day end, the
stable-to-stable Micro-Scout runs only when the day has zero legs, no position is
open or planned, and the route remains eligible and inside slippage limits.

Before signing, the exact swap is shadow-quoted against current BSC state.
Adverse deviation beyond `SHADOW_FILL_TOLERANCE_BPS` rejects the entry.
