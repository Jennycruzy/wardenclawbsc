import { BscShell } from "@/components/bscShell";
import { Card, SectionTitle, Badge, Dot, KeyValue } from "@/components/ui";
import { readBscEnv, readWatchHeartbeat, readWeekBudget } from "@/lib/data";

export const dynamic = "force-dynamic";

const WEEK_STATE_TONE: Record<string, "pos" | "warn" | "accent"> = {
  PRESS: "pos",
  DEFEND: "warn",
  HUNT: "accent",
};

/** Phone-first health view (§0.11). Reads live config + integration readiness. */
export default function BscOps() {
  const env = readBscEnv();
  const watch = readWatchHeartbeat();
  const week = readWeekBudget();
  const watchStaleMs = watch ? Date.now() - new Date(watch.lastBeatIso).getTime() : null;
  const watchHealthy = watchStaleMs !== null && watchStaleMs < 120_000;

  const checks: Array<{ label: string; ok: boolean; detail: string }> = [
    { label: "Spot-only execution", ok: env.executionType === "spot_only", detail: env.executionType },
    { label: "Router pinned", ok: env.routerAllowed === "pancakeswap", detail: env.routerAllowed },
    { label: "CMC perception", ok: env.cmcConfigured, detail: env.cmcConfigured ? "CMC_API_KEY set" : "set CMC_API_KEY" },
    { label: "TWAK signer", ok: env.twakConfigured, detail: env.twakConfigured ? "configured" : "set TWAK_CONFIG_PATH" },
    { label: "RPC failover pool", ok: env.rpcConfigured, detail: env.rpcConfigured ? "BSC_RPC_URLS set" : "set BSC_RPC_URLS" },
  ];

  return (
    <BscShell
      title="Operations"
      subtitle="Health, integrations, and the emergency stop — usable from a phone."
      actions={<Badge tone="neutral"><Dot tone="neutral" /> read-only</Badge>}
    >
      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <SectionTitle title="Integration readiness" />
          <div className="space-y-1">
            {checks.map((c) => (
              <div key={c.label} className="flex items-center justify-between border-b border-line/50 py-2.5 last:border-0">
                <div className="flex items-center gap-2.5">
                  <Dot tone={c.ok ? "pos" : "warn"} />
                  <span className="text-sm">{c.label}</span>
                </div>
                <span className="text-xs text-ink-muted">{c.detail}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <SectionTitle title="Fast position-watch loop" subtitle="Protection cadence — trails open positions and fires safety exits between decision cycles" />
          {watch ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between border-b border-line/50 py-2.5">
                <div className="flex items-center gap-2.5">
                  <Dot tone={watchHealthy ? "pos" : "warn"} />
                  <span className="text-sm">Heartbeat</span>
                </div>
                <span className="text-xs text-ink-muted">
                  {watchHealthy ? "live" : "stale"} · {watchStaleMs !== null ? `${Math.round(watchStaleMs / 1000)}s ago` : "—"}
                </span>
              </div>
              <KeyValue k="Watching" v={watch.watching ? `${watch.openPositions} open position(s)` : "idle (flat)"} />
              {watch.lastError ? <KeyValue k="Last error" v={watch.lastError} /> : null}
            </div>
          ) : (
            <p className="py-3 text-xs text-ink-faint">
              No watch heartbeat yet. The loop runs only while the worker is up; it watches open positions every{" "}
              <code className="font-mono">POSITION_WATCH_INTERVAL_SECONDS</code> and never opens trades or calls the LLM.
            </p>
          )}
        </Card>

        <Card>
          <SectionTitle title="Week-schedule risk budget" subtitle="HUNT / PRESS / DEFEND — sizes risk across the competition week, not just per trade" />
          {week ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between border-b border-line/50 py-2.5">
                <div className="flex items-center gap-2.5">
                  <Dot tone={WEEK_STATE_TONE[week.riskState] ?? "neutral"} />
                  <span className="text-sm">State</span>
                </div>
                <Badge tone={WEEK_STATE_TONE[week.riskState] ?? "neutral"}>
                  {week.riskState} · size ×{week.sizeMultiplier}
                </Badge>
              </div>
              <KeyValue k="Week return" v={`${week.weekReturnPct >= 0 ? "+" : ""}${week.weekReturnPct.toFixed(1)}%`} />
              <KeyValue k="Week elapsed" v={`${week.weekElapsedPct.toFixed(0)}%`} />
              <KeyValue
                k="Legs"
                v={`${week.legsUsed} used · ${week.legsRemaining} left${week.legsScarce ? " (scarce)" : ""}`}
              />
              <p className="pt-2 text-xs text-ink-faint">{week.reason}</p>
            </div>
          ) : (
            <p className="py-3 text-xs text-ink-faint">
              No week-budget snapshot yet. The worker writes it each decision cycle; the size multiplier is bounded by{" "}
              <code className="font-mono">MAX_POSITION_PCT</code> and the volatility stop, so PRESS never breaches the caps.
            </p>
          )}
        </Card>

        <Card>
          <SectionTitle title="Wallet & registration" />
          <KeyValue k="Agent wallet" v={env.walletAddress ?? "not set"} mono />
          <KeyValue k="Competition contract" v={env.competitionContract} mono />
          <KeyValue
            k="Registration tx"
            v={env.registrationTxHash ? <span className="font-mono">{env.registrationTxHash.slice(0, 14)}…</span> : <Badge tone="warn">pending</Badge>}
          />
          <KeyValue k="Starting capital" v={`$${env.startingCapitalUsd}`} />
        </Card>
      </div>

      <Card className="mt-3 border-neg/30 bg-neg/5">
        <SectionTitle title="Emergency stop" subtitle="STOP TRADING NOW — halts the loop, cancels pending intents, attempts approval revocation" />
        <p className="text-sm text-ink-muted">
          The kill-switch is an authenticated endpoint on the worker/API. From a phone, call it with your{" "}
          <code className="font-mono text-xs text-ink">KILL_SWITCH_TOKEN</code>:
        </p>
        <code className="mt-3 block overflow-x-auto rounded-lg border border-line bg-bg px-3 py-2 font-mono text-xs text-neg">
          curl -X POST $NEXT_PUBLIC_API_URL/kill -H &quot;authorization: Bearer $KILL_SWITCH_TOKEN&quot;
        </code>
        <p className="mt-3 text-xs text-ink-faint">
          The worker also writes a heartbeat; a stale heartbeat triggers a process-manager restart and an
          alert to <code className="font-mono">ALERT_WEBHOOK_URL</code>. See docs/OPERATIONS.md.
        </p>
      </Card>
    </BscShell>
  );
}
