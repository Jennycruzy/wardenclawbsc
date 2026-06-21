# WardenClaw auto go-live / stand-down

Scheduled, fail-closed transition of the BSC trading worker between **DRY** (simulation)
and **LIVE** (real BSC execution), aligned to the Track 1 competition window
(`2026-06-22T00:00:00Z` → `2026-06-28T23:59:59Z`, `packages/core/src/config.ts:180`).

## Why this exists (root cause)

`worker.ts` decides execution mode **once at startup**:
`mode = Boolean(process.env.TWAK_CONFIG_PATH) ? "live" : "dry"` (`worker.ts:650`). It loads
`.env` with dotenv's **default `override:false`** (`worker.ts:137`). pm2's saved dump
(`/root/.pm2/dump.pm2`) has `TWAK_CONFIG_PATH` baked in as an **empty string**, so the key is
already present in `process.env` and dotenv refuses to overwrite it — the correct `.env` value
(`/root/.twak`) never reaches the worker, pinning it to **DRY**. The window gate inside the loop
only affects scoring/drawdown anchoring, **not** the dry/live mode. So "going live" requires
**recreating** the pm2 process with `TWAK_CONFIG_PATH` set correctly — which is exactly what
`wardenclaw-mode.sh` does, then `pm2 save`s so it sticks.

> There is **no** pre- or post-window suppression on `"attack"` plans (`worker.ts:1725` only
> clears `hold`/pre-window `micro_scout`). A LIVE worker therefore trades real money **whenever it
> is running**, regardless of the window. That is why we (a) keep it DRY until the open and
> (b) ship a **stand-down** timer that returns it to DRY at the close. Both are safety-critical.

## Files

| File | Installs to | Purpose |
|------|-------------|---------|
| `wardenclaw-mode.sh` | `/root/wardenbsc/ops/golive/` (`chmod 750`) | the controller (`live` \| `dry` \| `check`) |
| `wardenclaw-golive.{service,timer}` | `/etc/systemd/system/` (`chmod 644`) | fire `… live` at `2026-06-22 00:00:00 UTC` |
| `wardenclaw-standdown.{service,timer}` | `/etc/systemd/system/` (`chmod 644`) | fire `… dry` at `2026-06-29 00:00:00 UTC` |

The script targets the **actually running** process `wardenbsc-collector`
(`cwd=apps/worker`, `pnpm start`). It deliberately does **not** use `ops/pm2.config.cjs`
— that file defines a *different* name (`wardenclaw-worker`) and would spawn a **second**,
duplicate worker. Do not `pm2 start ops/pm2.config.cjs`.

## Preconditions — DO THESE BEFORE THE WINDOW (else go-live aborts, fail-closed)

1. **Rehearsal gate.** Today `data/runtime/rehearsal.json` is `{passed:false}` and
   `.env REHEARSAL_OVERRIDE=false`, so a LIVE boot is **refused** (`worker.ts:655`). Either
   re-run the rehearsal to a genuine `passed:true`, **or** consciously set
   `REHEARSAL_OVERRIDE=true` in `.env`. The script mirrors this gate and **never overrides it
   silently**.
2. **Webhook.** `.env ALERT_WEBHOOK_URL` must be a reachable endpoint that accepts
   `{"text":...}` — every success/failure posts there.
3. **Review.** Read `wardenclaw-mode.sh`. Confirm `TWAK_CONFIG_PATH=/root/.twak` in `.env` and
   that `/root/.twak/{credentials,wallet}.json` exist.

## Install

```bash
# from a checkout of the repo:
scp ops/golive/wardenclaw-mode.sh                 root@38.49.216.59:/root/wardenbsc/ops/golive/
scp ops/golive/*.service ops/golive/*.timer       root@38.49.216.59:/etc/systemd/system/

# on the VPS:
chmod 750 /root/wardenbsc/ops/golive/wardenclaw-mode.sh
chmod 644 /etc/systemd/system/wardenclaw-golive.* /etc/systemd/system/wardenclaw-standdown.*
systemctl daemon-reload
systemctl enable --now wardenclaw-golive.timer wardenclaw-standdown.timer
```

## Verify the install (no trading impact)

```bash
systemctl list-timers 'wardenclaw-*'                 # next-elapse = Jun 22 / Jun 29 00:00 UTC
systemd-analyze calendar '2026-06-22 00:00:00 UTC'   # confirms the instant
/root/wardenbsc/ops/golive/wardenclaw-mode.sh check  # runs ALL live gates, leaves worker untouched
```

`check` is the safe dress rehearsal of the gates: it returns `OK` + fires the webhook only if a
real go-live would succeed; otherwise it tells you the exact blocker. It never recreates the worker.

To rehearse the **mechanism** end-to-end (recreate + verify + alert) without going live, run
`wardenclaw-mode.sh dry` — it bounces `wardenbsc-collector` (~2–3 s, crash-recovery reconciles)
and leaves it in DRY, i.e. its current state.

## Airtightness matrix

| Failure mode | Guard | Outcome |
|---|---|---|
| Two runs race (timer + manual) | `flock -n` on `/run/wardenclaw-golive.lock` | second exits 1, no double-recreate |
| Wrong process / duplicate worker | hard-codes real name `wardenbsc-collector`; never uses `pm2.config.cjs` | in-place transition only |
| Empty-`TWAK_CONFIG_PATH` shadow (root cause) | `export TWAK_CONFIG_PATH=…` before recreate + `pm2 save` | live env positively asserted & persisted |
| Rehearsal gate not passed | mirrors `worker.ts:655`; aborts unless `passed:true` or `REHEARSAL_OVERRIDE=true` | worker untouched, FAIL alert |
| Missing TWAK creds/wallet | checks `credentials.json` + `wallet.json` | abort before recreate |
| Operator halt / unresolved fill | aborts if `kill.flag.json` or `manual-review.json` exists | abort before recreate |
| Empty perception universe | requires non-empty `data/eligible-tokens.json` | abort before recreate |
| pm2 daemon down | `pm2 ping` | abort, FAIL alert |
| Start silently lands in DRY | reads boot banner `worker.ts:676`, requires `LIVE` | FAIL if banner ≠ expected |
| Crash-loop after start | polls `status==online` + `restart_time<=1` for 45 s | FAIL alert, no false success |
| Stale banner from prior boot | only inspects out-log lines written **after** the recreate mark | no false positive |
| Box down at 00:00 UTC | `Persistent=true` | flip runs at next boot |
| Timer fires up to 60 s late | `AccuracySec=1s` | sub-second firing |
| Trading continues after window | stand-down timer flips DRY at `2026-06-29 00:00 UTC` | live execution stops at close |
| Webhook/save transient failure | `curl`/`pm2 save` failures are non-fatal + logged | transition still completes |

Logs: `/var/log/wardenclaw-golive.log` and `journalctl -u wardenclaw-golive.service`.

## Manual control / abort

```bash
ops/golive/wardenclaw-mode.sh live    # go live now (gates still enforced)
ops/golive/wardenclaw-mode.sh dry     # stand down now
systemctl disable --now wardenclaw-golive.timer wardenclaw-standdown.timer   # cancel schedule
# hard emergency stop (worker honors this every cycle, worker.ts:150 killEngaged):
echo '{"engaged":true}' > /root/wardenbsc/data/runtime/kill.flag.json
```

## Residual risks (operator-owned, by design)

- **Rehearsal override is a human decision.** If you set `REHEARSAL_OVERRIDE=true` to clear the
  gate, you accept that the dress rehearsal did not auto-pass.
- **Single scheduled flip.** Mitigated by `Persistent=true`, the boot-banner verification, and the
  webhook — but confirm the success alert at 00:00 UTC. If none arrives, run
  `wardenclaw-mode.sh check` then `… live` manually.
- **Wall-clock dependency.** The box is `Etc/UTC` and timers are UTC-pinned; keep NTP healthy.
