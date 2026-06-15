import { BscShell } from "@/components/bscShell";
import { Card, SectionTitle, Badge, Dot, KeyValue } from "@/components/ui";
import {
  competitionCountdown,
  readBscEnv,
  readPreflightStatus,
  readWatchHeartbeat,
  readWeekBudget,
  readRegime,
  readWalletCost,
} from "@/lib/data";

export const dynamic = "force-dynamic";

const WEEK_STATE_TONE: Record<string, "pos" | "warn" | "accent"> = {
  PRESS: "pos",
  DEFEND: "warn",
  HUNT: "accent",
};

const REGIME_TONE: Record<string, "pos" | "neutral" | "neg"> = {
  GREEN: "pos",
  NEUTRAL: "neutral",
  RED: "neg",
};

/** Phone-first health view (§0.11). Reads live config + integration readiness. */
export default function BscOps() {
  const env = readBscEnv();
  const watch = readWatchHeartbeat();
  const week = readWeekBudget();
  const regime = readRegime();
  const walletCost = readWalletCost();
  const countdown = competitionCountdown();
  const preflight = readPreflightStatus();
  const hoursRemaining = Math.max(0, Math.floor(countdown.remainingMs / 3_600_000));
  const days = Math.floor(hoursRemaining / 24);
  const hours = hoursRemaining % 24;
  const nowMs = Date.now();
  const registrationEscalated = nowMs >= Date.parse("2026-06-18T00:00:00Z");
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
      <Card className={`mb-3 ${!preflight.registered ? "border-neg/50 bg-neg/10" : "border-pos/30 bg-pos/5"}`}>
        <SectionTitle
          title={countdown.phase === "preflight" ? `PREFLIGHT: ${days}d ${hours}h remaining` : `Competition ${countdown.phase}`}
          subtitle={`${countdown.label} · opens June 22, 2026 at 00:00 UTC`}
        />
        {!preflight.registered ? (
          <div className="rounded-lg border border-neg/40 bg-bg px-3 py-3">
            <div className="flex items-center gap-2">
              <Badge tone="neg">{registrationEscalated ? "URGENT" : "DO FIRST"}</Badge>
              <strong className="text-sm">Registration tx is missing</strong>
            </div>
            <p className="mt-2 text-xs text-ink-muted">
              Run <code className="font-mono text-ink">twak compete register</code>, then set{" "}
              <code className="font-mono text-ink">REGISTRATION_TX_HASH</code>. Registration closes when trading opens.
            </p>
          </div>
        ) : (
          <p className="text-sm text-pos">Registration tx recorded. Keep the hash in the deployment environment.</p>
        )}
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          {[
            ["1. Register with TWAK", preflight.registered],
            ["2. Build eligible tokens", preflight.eligibleTokensBuilt],
            ["3. Fund wallet + gas", false],
            ["4. $5 rehearsal + watchdog/trail exits", preflight.rehearsalPassed],
            ["5. Run calibration", preflight.calibrationPresent],
            ["6. Phone alerts + kill-switch", preflight.alertsConfigured && preflight.killSwitchConfigured],
            ["7. DoraHacks submission", false],
          ].map(([label, done]) => (
            <div key={String(label)} className="flex items-center gap-2 rounded-md border border-line/60 px-2.5 py-2">
              <Dot tone={done ? "pos" : "warn"} />
              <span>{label}</span>
            </div>
          ))}
        </div>
      </Card>

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
          <SectionTitle title="Red-day regime" subtitle="GREEN / NEUTRAL / RED with hysteresis — RED blocks new entries and rotates open risk to stables" />
          {regime ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between border-b border-line/50 py-2.5">
                <div className="flex items-center gap-2.5">
                  <Dot tone={REGIME_TONE[regime.regime] ?? "neutral"} />
                  <span className="text-sm">Committed regime</span>
                </div>
                <Badge tone={REGIME_TONE[regime.regime] ?? "neutral"}>
                  {regime.regime}
                  {regime.blocksEntries ? " · entries blocked" : ""}
                </Badge>
              </div>
              <KeyValue k="Raw read" v={`${regime.rawRegime} (score ${regime.score >= 0 ? "+" : ""}${regime.score})`} />
              <KeyValue k="Benchmark 24h" v={`${regime.benchmarkChange24hPct >= 0 ? "+" : ""}${regime.benchmarkChange24hPct.toFixed(1)}%`} />
              <KeyValue k="Benchmark short" v={`${regime.benchmarkShortChangePct >= 0 ? "+" : ""}${regime.benchmarkShortChangePct.toFixed(1)}%`} />
              <KeyValue k="BTC 24h" v={`${regime.btcChange24hPct >= 0 ? "+" : ""}${regime.btcChange24hPct.toFixed(1)}%`} />
              <KeyValue k="BNB vs recent mean" v={regime.benchmarkAboveRecentMean ? "above" : "below"} />
              <KeyValue k="Volatility ratio" v={`${regime.volatilityRatio.toFixed(2)}x`} />
              <KeyValue k="Fear & Greed" v={`${regime.fearGreed}`} />
              <KeyValue k="Breadth up" v={`${Math.round(regime.breadthUpFraction * 100)}% of majors`} />
              <p className="pt-2 text-xs text-ink-faint">{regime.reason}</p>
            </div>
          ) : (
            <p className="py-3 text-xs text-ink-faint">
              No regime snapshot yet. The worker votes benchmark 24h change, Fear &amp; Greed, and majors breadth each
              cycle; a switch needs <code className="font-mono">REGIME_HYSTERESIS_CHECKS</code> consecutive confirming reads.
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
              <KeyValue k="Entry threshold" v={`${week.minimumScore}+ score`} />
              <KeyValue k="Net-edge bonus" v={`${week.netEdgeBonusBps} bps`} />
              <KeyValue k="PRESS shot" v={week.pressTradeUsed ? "consumed" : week.pressTrade ? "available now" : "not active"} />
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
          <SectionTitle title="Measured TWAK round-trip cost" subtitle="The real $40 cost — measured from fills, never hardcoded — driving the wallet floor and dust gate" />
          {walletCost ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between border-b border-line/50 py-2.5">
                <div className="flex items-center gap-2.5">
                  <Dot tone={walletCost.measured ? "pos" : "neutral"} />
                  <span className="text-sm">Real round-trip</span>
                </div>
                <Badge tone={walletCost.measured ? "pos" : "neutral"}>
                  {walletCost.rollingBps.toFixed(0)} bps · {walletCost.measured ? `${walletCost.sampleCount} fill(s)` : "bootstrap"}
                </Badge>
              </div>
              <KeyValue k="Wallet floor" v={`${walletCost.walletFloorBps.toFixed(0)} bps (move must clear)`} />
              <KeyValue k="Dust ceiling" v={`${walletCost.dustCeilingBps} bps`} />
              {!walletCost.measured ? (
                <KeyValue k="Modeled bootstrap" v={`${walletCost.bootstrapBps.toFixed(0)} bps until first real fill`} />
              ) : null}
            </div>
          ) : (
            <p className="py-3 text-xs text-ink-faint">
              No cost snapshot yet. The worker measures each completed round-trip (entry notional vs actual exit
              proceeds, isolated from the price move) and rolls it into the wallet floor and dust gate.
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
