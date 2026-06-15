# Operations Runbook

The live window is June 22, 2026 00:00 UTC through June 28, 2026 23:59:59 UTC.
Registration closes when the window opens.

## First action

Run `twak compete register`, verify the BSC transaction, and set
`REGISTRATION_TX_HASH`. Until it is set, the webhook alerts daily, every 6 hours
after June 18, and hourly in the final 24 hours. `/bsc/ops` shows the countdown
and ordered preflight checklist.

## Processes

`wardenclaw-web` and `wardenclaw-api` run continuously. Start
`wardenclaw-worker` for rehearsal/live only after the rehearsal gate passes.
On every worker start, reconciliation runs before any new trade.

```bash
pnpm install
pnpm build
pm2 start ops/pm2.config.cjs
pm2 save
pm2 logs wardenclaw-worker
```

Required live environment:

```text
CMC_API_KEY
TWAK_CONFIG_PATH
TWAK_AGENT_WALLET
BSC_RPC_URLS
ALERT_WEBHOOK_URL
KILL_SWITCH_TOKEN
REGISTRATION_TX_HASH
```

Before rehearsal, run:

```bash
pnpm check:cmc
pnpm explain:strategy
```

The first command must pass before CMC is considered proven in the rehearsal
checklist. It uses the worker's `CmcClient`, not a separate test client. The
second reads persisted mandates, audit events, week/regime state, ledgers, and
watchdog exits; without an LLM key it still writes the deterministic draft.

## Protection loop

The position watch runs every `POSITION_WATCH_INTERVAL_SECONDS` only while a
position is open. It performs direct BSC quoter reads, persists HWM/stop state,
uses the tight trail in RED or DEFEND, and sends forced exits through TWAK. If
prices are stale past `WATCH_STALENESS_LIMIT_SECONDS`, it alerts immediately.

`data/runtime/book.json` stores actual stable cash and scored competition value.
`weekLedger.json` stores timestamped entry/exit/scout legs and whether the single
PRESS trade was consumed. Both restore before new entries.

If TWAK broadcasts a transaction before a confirmed `realizedOut` is available,
the worker writes `data/runtime/manual-review.json` and halts all entry/watch
execution. Resolve that tx from chain evidence and reconcile the book/position
before removing the flag. This prevents blind resubmission.

## Emergency stop

```bash
curl -X POST $NEXT_PUBLIC_API_URL/kill \
  -H "authorization: Bearer $KILL_SWITCH_TOKEN"
```

Restart only after reviewing the kill reason, pending transactions, and
`RECOVERY_REPORT`.

## Phone alerts

- `registration_missing`: register and set the tx hash immediately.
- `restart_recovery`: inspect reconciliation; never blindly resubmit.
- `daily_trade_at_risk`: the scout runs only if flat and safe.
- `execution_failure`: inspect worker logs, RPCs, TWAK, and funds.
- `twak_refusal`: inspect the policy reject code.
- `survival_mode` / `drawdown_soft`: verify de-risking on `/bsc/proof`.
- `emergency_stop`: keep the worker stopped until reviewed.

Alert delivery never crashes the trading loop.

## Audit

- `/bsc/ops`: countdown, registration, health, regime, week state, measured cost.
- `/bsc/proof`: scored return, wallet value, drawdown, legs, receipts.
- `data/audit/*.jsonl`: hash-chained stage events.
- `pnpm replay --mandate <id>`: deterministic replay.
