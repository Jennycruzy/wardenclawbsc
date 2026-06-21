#!/usr/bin/env bash
#
# wardenclaw-mode.sh — competition mode controller for the wardenbsc worker.
#
#   Usage: wardenclaw-mode.sh <live|dry>
#
# Transitions the live pm2 process `wardenbsc-collector` (apps/worker → `pnpm start`
# → tsx src/worker.ts) between LIVE (real BSC execution) and DRY (simulation).
#
# WHY a recreate instead of `pm2 restart`:
#   worker.ts computes `mode = Boolean(process.env.TWAK_CONFIG_PATH) ? "live" : "dry"`
#   and loads .env via dotenv with the DEFAULT (override:false) option
#   (worker.ts:137 `loadDotenv({ path: join(ROOT, ".env") })`). pm2's saved dump
#   (`/root/.pm2/dump.pm2`) has TWAK_CONFIG_PATH baked in as an EMPTY string, so the
#   key is already present in process.env and dotenv refuses to overwrite it — the
#   correct .env value (/root/.twak) never reaches the worker, pinning it to DRY.
#   The only deterministic fix is to recreate the process with TWAK_CONFIG_PATH
#   positively exported to the value we want (non-empty => live, empty => dry), then
#   `pm2 save` so the corrected env survives ordinary restarts.
#
# This script is idempotent, single-flighted (flock), fails closed (any doubt =>
# abort without touching the running worker once past preflight only on a controlled
# recreate), mirrors the worker's own live-boot gates, and verifies the boot banner
# before declaring success. It posts to ALERT_WEBHOOK_URL on success and failure.
#
set -Eeuo pipefail

# ---- deployment facts (single source of truth lives in .env; these are paths) ----
export HOME=/root
export PM2_HOME=/root/.pm2
export PATH=/usr/local/bin:/usr/bin:/bin

ROOT=/root/wardenbsc
ENV_FILE="$ROOT/.env"
APP_CWD="$ROOT/apps/worker"
RUNTIME="$ROOT/data/runtime"
PROC=wardenbsc-collector            # the ACTUAL running process name (NOT ops/pm2.config.cjs)
PM2=/usr/bin/pm2
PNPM=/usr/bin/pnpm
NODE=/usr/local/bin/node
LOG=/var/log/wardenclaw-golive.log
LOCK=/run/wardenclaw-golive.lock
VERIFY_SECS=45

MODE="${1:-}"
# live  : recreate worker in LIVE mode (real BSC execution)
# dry   : recreate worker in DRY mode (simulation)
# check : run all LIVE preflight gates and exit — does NOT touch the worker
case "$MODE" in live|dry|check) ;; *) echo "usage: $0 <live|dry|check>" >&2; exit 2 ;; esac

# ---- single-flight ----
exec 9>"$LOCK"
flock -n 9 || { echo "wardenclaw-mode: another run is in progress" >&2; exit 1; }

ts()  { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s [%s] %s\n' "$(ts)" "$MODE" "$*" | tee -a "$LOG" >&2; }

# read one key from .env: strip inline " # comment", surrounding ws and quotes.
envval() {
  { grep -E "^$1=" "$ENV_FILE" 2>/dev/null || true; } \
    | head -1 | cut -d= -f2- \
    | sed -E 's/[[:space:]]+#.*$//' \
    | sed -E 's/^[[:space:]"'\'']+//; s/[[:space:]"'\'']+$//'
}

WEBHOOK="$(envval ALERT_WEBHOOK_URL || true)"
alert() { # $1=OK|FAIL  $2=message
  [[ -n "$WEBHOOK" ]] || return 0
  local payload
  payload="$(jq -nc --arg t "WardenClaw go-$MODE [$1]: $2" --arg r "$1" --arg ts "$(ts)" \
    '{text:$t,reason:$r,mode:"'"$MODE"'",ts:$ts}')"
  curl -fsS -m 10 -X POST -H 'content-type: application/json' -d "$payload" "$WEBHOOK" >/dev/null 2>&1 || true
}
fail() { trap - ERR; log "ABORT: $*"; alert FAIL "$*"; exit 1; }
trap 'fail "unexpected error at line $LINENO"' ERR

log "=== wardenclaw-mode $MODE starting ==="

# ---------------- shared preflight (fail closed) ----------------
[[ -f "$ENV_FILE" ]]                      || fail ".env missing at $ENV_FILE"
[[ -d "$APP_CWD"  ]]                      || fail "worker dir missing: $APP_CWD"
[[ -x "$PM2" && -x "$PNPM" && -x "$NODE" ]] || fail "pm2/pnpm/node not all present"
$PM2 ping >/dev/null 2>&1                 || fail "pm2 daemon not responding (HOME=$HOME PM2_HOME=$PM2_HOME)"
[[ ! -f "$RUNTIME/kill.flag.json" ]]      || fail "kill.flag.json present — operator halt engaged; resolve before (re)starting"
[[ ! -f "$RUNTIME/manual-review.json" ]]  || fail "manual-review.json present — unresolved fill; reconcile before (re)starting"
[[ -s "$ROOT/data/eligible-tokens.json" ]] || fail "eligible-tokens.json missing/empty — perception universe not built"

TWAK_PATH="$(envval TWAK_CONFIG_PATH || true)"

if [[ "$MODE" == "live" || "$MODE" == "check" ]]; then
  # ---- live-only gates: mirror worker.ts:650-674 so we fail fast & loud ----
  [[ -n "$TWAK_PATH" ]]                                   || fail "TWAK_CONFIG_PATH empty in .env — cannot go live"
  [[ -f "$TWAK_PATH/credentials.json" ]]                 || fail "TWAK credentials.json missing under $TWAK_PATH"
  [[ -f "$TWAK_PATH/wallet.json" ]]                      || fail "TWAK wallet.json missing under $TWAK_PATH"
  # rehearsal gate (worker.ts:655). NEVER silently override — operator must have
  # set REHEARSAL_OVERRIDE=true OR produced a real rehearsal.json {passed:true}.
  local_override="$(envval REHEARSAL_OVERRIDE || true)"
  reh_passed=false
  if [[ -f "$RUNTIME/rehearsal.json" ]]; then
    reh_passed="$(jq -r 'if .passed==true then "true" else "false" end' "$RUNTIME/rehearsal.json" 2>/dev/null || echo false)"
  fi
  if [[ "$reh_passed" != "true" && "$local_override" != "true" ]]; then
    fail "rehearsal gate NOT satisfied (rehearsal.json passed=$reh_passed, REHEARSAL_OVERRIDE=$local_override). Re-run the rehearsal to a real pass OR set REHEARSAL_OVERRIDE=true in .env BEFORE the window. Worker left untouched in its current mode."
  fi
  LAUNCH_TWAK="$TWAK_PATH"   # non-empty => worker computes mode=live
  WANT="LIVE"
else
  LAUNCH_TWAK=""             # empty => worker computes mode=dry
  WANT="DRY"
fi

if [[ "$MODE" == "check" ]]; then
  log "OK: all LIVE preflight gates pass — worker NOT touched (this was a check)"
  alert OK "preflight check passed; ready to go live"
  exit 0
fi

# ---------------- controlled recreate ----------------
# Capture current out-log line count so we only inspect lines written AFTER restart.
OUT_LOG="$($PM2 jlist 2>/dev/null | jq -r --arg n "$PROC" '.[]|select(.name==$n)|.pm2_env.pm_out_log_path' 2>/dev/null | head -1 || true)"
[[ -n "$OUT_LOG" ]] || OUT_LOG="/root/.pm2/logs/${PROC}-out.log"
MARK="$(wc -l < "$OUT_LOG" 2>/dev/null || echo 0)"

log "recreating $PROC with TWAK_CONFIG_PATH='${LAUNCH_TWAK:-<empty>}' (out-log=$OUT_LOG mark=$MARK)"
export TWAK_CONFIG_PATH="$LAUNCH_TWAK"
$PM2 delete "$PROC" >/dev/null 2>&1 || true
$PM2 start "$PNPM" --name "$PROC" --cwd "$APP_CWD" --interpreter "$NODE" \
  --restart-delay 5000 --max-restarts 50 --update-env -- start >/dev/null \
  || fail "pm2 start of $PROC failed"
$PM2 save >/dev/null || log "warning: pm2 save failed (env will not persist across reboot)"

# ---------------- deterministic verification ----------------
# worker.ts:676 prints `[worker] starting in LIVE|DRY mode` AFTER all boot gates and
# BEFORE any trade. We key success on that banner + online status + no crash loop.
status=""; restarts=""; banner=""
for _ in $(seq 1 "$VERIFY_SECS"); do
  sleep 1
  status="$($PM2 jlist 2>/dev/null | jq -r --arg n "$PROC" '.[]|select(.name==$n)|.pm2_env.status' 2>/dev/null | head -1 || true)"
  restarts="$($PM2 jlist 2>/dev/null | jq -r --arg n "$PROC" '.[]|select(.name==$n)|.pm2_env.restart_time' 2>/dev/null | head -1 || true)"
  banner="$(tail -n +"$((MARK+1))" "$OUT_LOG" 2>/dev/null | grep -oE 'starting in (LIVE|DRY) mode' | tail -1 | awk '{print $3}' || true)"
  [[ "$status" == "online" && -n "$banner" ]] && break
done

[[ "$restarts" =~ ^[0-9]+$ ]]      || restarts=0
[[ "$status" == "online" ]]        || fail "process not online after ${VERIFY_SECS}s (status='${status:-none}')"
[[ "$restarts" -le 1 ]]            || fail "process is crash-looping (restart_time=$restarts) — inspect ${OUT_LOG%-out.log}-error.log"
[[ "$banner" == "$WANT" ]]         || fail "expected $WANT banner, got '${banner:-none}' — env/gate did not take effect"

log "OK: $PROC online in $banner mode (restarts=${restarts:-0})"
alert OK "$PROC now running in $WANT mode (restarts=${restarts:-0})"
