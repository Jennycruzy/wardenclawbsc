import Link from "next/link";
import { BscShell } from "@/components/bscShell";
import { Card, Stat, SectionTitle, Badge, EmptyState, Dot } from "@/components/ui";
import { SignalFamilyChip } from "@/components/chips";
import { EquityCurve } from "@/components/charts";
import {
  loadBscMandates,
  loadHourlySnapshots,
  readBscEnv,
  readWalletCost,
  readWeekBudget,
  readRegime,
  competitionCountdown,
} from "@/lib/data";
import {
  COMPETITION,
  DEFAULT_RISK_CONFIG,
  competitionSnapshots,
  isInCompetitionWindow,
  maxDrawdownPct,
  returnFromStartingCapital,
  type HourlySnapshot,
} from "@wardenclaw/core";
import { usd, pct, num, shortTime, signClass } from "@/lib/format";

export const dynamic = "force-dynamic";

export default function BscProof() {
  const mandates = loadBscMandates();
  const env = readBscEnv();
  const allSnaps = loadHourlySnapshots();
  const cfg = DEFAULT_RISK_CONFIG;
  const countdown = competitionCountdown();

  const snapForCore: HourlySnapshot[] = allSnaps.map((s) => ({ hourIso: s.hourIso, valueUsd: s.valueUsd }));
  const scoringSnaps = competitionSnapshots(snapForCore);
  const scoringSeries: HourlySnapshot[] = [
    { hourIso: COMPETITION.tradingWindow.startUtc, valueUsd: env.startingCapitalUsd },
    ...scoringSnaps,
  ];
  const latestScoringValue = scoringSnaps.at(-1)?.valueUsd ?? null;
  const totalReturn =
    latestScoringValue !== null ? returnFromStartingCapital(latestScoringValue, env.startingCapitalUsd) : null;
  const maxDd = scoringSnaps.length > 0 ? maxDrawdownPct(scoringSeries) : null;
  const liveValue = allSnaps.at(-1)?.valueUsd ?? null;
  const competitionMandates = mandates.filter((m) => isInCompetitionWindow(m.createdAt));
  const tradeRows = competitionMandates.filter((m) => m.risk.approved);
  const weeklyTrades = tradeRows.filter((m) => Boolean(m.proofAnchors.bscTxHash)).length;
  const preflightExecutions = mandates.filter(
    (m) => m.risk.approved && Boolean(m.proofAnchors.bscTxHash) && Date.parse(m.createdAt) < Date.parse(COMPETITION.tradingWindow.startUtc),
  );
  const walletCost = readWalletCost();
  const week = readWeekBudget();
  const regime = readRegime();

  return (
    <BscShell
      title="Judge Scoreboard"
      subtitle="Total return under the drawdown cap — verifiable in 30 seconds."
      actions={
        <Badge tone={env.executionType === "spot_only" ? "pos" : "warn"}>
          <Dot tone="pos" /> {env.executionType}
        </Badge>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Portfolio value"
          value={liveValue !== null ? usd(liveValue) : "—"}
          sub={
            liveValue === null
              ? "no snapshots yet"
              : countdown.phase === "preflight"
                ? "preflight wallet value · scoring not started"
                : `competition baseline ${usd(env.startingCapitalUsd)}`
          }
        />
        <Stat
          label="Total return"
          value={totalReturn !== null ? pct(totalReturn) : "—"}
          valueClass={signClass(totalReturn ?? undefined)}
          sub={totalReturn === null ? "competition scoring starts June 22" : "from official starting balance"}
        />
        <Stat
          label="Max drawdown"
          value={maxDd !== null ? pct(-maxDd) : "—"}
          valueClass={maxDd === null ? "text-ink-muted" : "text-neg"}
          sub={
            maxDd === null
              ? "no competition-window drawdown yet"
              : `internal limit ${cfg.internalWindowDrawdownPct}% · organizer threshold pending confirmation`
          }
        />
        <Stat
          label="Weekly trades"
          value={`${weeklyTrades}/7`}
          valueClass={weeklyTrades >= 7 ? "text-pos" : "text-ink"}
          sub="confirmed on-chain competition legs"
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Badge tone={regime?.regime === "RED" ? "neg" : regime?.regime === "GREEN" ? "pos" : "neutral"}>
          Regime {regime?.regime ?? "awaiting first cycle"}
        </Badge>
        <Badge tone={countdown.phase === "preflight" ? "neutral" : week?.riskState === "DEFEND" ? "warn" : week?.riskState === "PRESS" ? "pos" : "accent"}>
          Week state {countdown.phase === "preflight" ? "not started" : week?.riskState ?? "awaiting first cycle"}
          {countdown.phase !== "preflight" && week?.pressTrade ? " · one PRESS shot active" : ""}
        </Badge>
        {regime?.regime === "RED" ? <span className="text-xs text-neg">Capital parked in eligible stables by design.</span> : null}
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionTitle title="Hourly portfolio value" subtitle="Mirrors the organizers' hourly scoring" />
          {scoringSnaps.length > 0 ? (
            <EquityCurve data={scoringSeries.map((s) => ({ time: s.hourIso, equityUsd: s.valueUsd }))} />
          ) : (
            <p className="py-10 text-center text-xs text-ink-faint">
              No competition-window snapshots yet. Preflight values are intentionally excluded from scoring.
            </p>
          )}
        </Card>

        <Card>
          <SectionTitle title="Registration proof" />
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-faint">Contract</span>
              <code className="font-mono text-xs text-ink-muted">{env.competitionContract.slice(0, 10)}…{env.competitionContract.slice(-6)}</code>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-faint">Agent wallet</span>
              <code className="font-mono text-xs text-ink-muted">{env.walletAddress ? `${env.walletAddress.slice(0, 8)}…` : "not set"}</code>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-faint">Registration tx</span>
              {env.registrationTxHash ? (
                <a
                  href={`https://bsctrace.com/tx/${env.registrationTxHash}`}
                  className="font-mono text-xs text-accent hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  {env.registrationTxHash.slice(0, 10)}…
                </a>
              ) : (
                <Badge tone="warn">pending</Badge>
              )}
            </div>
          </div>
          <p className="mt-4 border-t border-line/60 pt-3 text-xs text-ink-faint">
            Integrity: JSONL hash chain. Truth anchors: BSC tx hash, TWAK receipt, x402 receipt per mandate.
          </p>
        </Card>
      </div>

      <div className="mt-3">
        <SectionTitle title="Competition trade ledger" subtitle="Only June 22–28 mandates appear here; preflight executions are separated below" />
        {walletCost ? (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            <Badge tone={walletCost.measured ? "pos" : "neutral"}>
              Real round-trip {walletCost.rollingBps.toFixed(0)} bps · {walletCost.measured ? `${walletCost.sampleCount} measured fill(s)` : "modeled bootstrap"}
            </Badge>
            <span>Wallet floor {walletCost.walletFloorBps.toFixed(0)} bps · dust ceiling {walletCost.dustCeilingBps} bps</span>
          </div>
        ) : null}
        {tradeRows.length === 0 ? (
          <EmptyState
            title="No live trades yet"
            hint="Competition-window mandates with confirmed evidence appear here after trading opens."
            command="pnpm run:bsc-agent"
          />
        ) : (
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-4 py-3 font-medium">Time</th>
                  <th className="px-4 py-3 font-medium">Asset</th>
                  <th className="px-4 py-3 font-medium">Family</th>
                  <th className="px-4 py-3 text-right font-medium">Size</th>
                  <th className="px-4 py-3 text-right font-medium">Move / scored / wallet</th>
                  <th className="px-4 py-3 font-medium">CMC tools</th>
                  <th className="px-4 py-3 font-medium">BSC tx</th>
                </tr>
              </thead>
              <tbody>
                {tradeRows.map((m) => (
                  <tr key={m.id} className="border-b border-line/50 last:border-0 hover:bg-bg-subtle/50">
                    <td className="whitespace-nowrap px-4 py-3 text-ink-muted">{shortTime(m.createdAt)}</td>
                    <td className="px-4 py-3 font-mono">
                      <Link href={`/bsc/mandates/${m.id}`} className="text-accent hover:underline">{m.asset}</Link>
                    </td>
                    <td className="px-4 py-3"><SignalFamilyChip family={m.decision.signalFamily} /></td>
                    <td className="tabular px-4 py-3 text-right">
                      {usd((m.execution.requestedOrder as { amountInUsd?: number } | undefined)?.amountInUsd)}
                    </td>
                    <td className="tabular px-4 py-3 text-right text-ink-muted">
                      <span title="Expected move / scored friction (competition cost) / measured real round-trip (wallet)">
                        {num(m.economics.expectedMoveBps)}
                        {" / "}
                        <span className="text-pos">{m.economics.scoredFrictionBps.toFixed(0)}</span>
                        {" / "}
                        <span className="text-ink-faint">{(m.economics.realRoundTripBps ?? m.economics.realFrictionBps).toFixed(0)}</span>
                        {" bps"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-muted">{(m.perception.cmcToolsUsed ?? []).join(", ") || "—"}</td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {m.proofAnchors.bscTxHash ? (
                        <a href={`https://bsctrace.com/tx/${m.proofAnchors.bscTxHash}`} className="text-accent hover:underline" target="_blank" rel="noreferrer">
                          {m.proofAnchors.bscTxHash.slice(0, 10)}…
                        </a>
                      ) : (
                        <span className="text-ink-faint">dry run</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      <div className="mt-3">
        <SectionTitle
          title="Preflight execution evidence"
          subtitle="Rehearsal transactions prove the execution path but do not count toward competition return or the 7-leg minimum"
        />
        {preflightExecutions.length === 0 ? (
          <p className="text-xs text-ink-faint">No confirmed preflight execution recorded.</p>
        ) : (
          <Card className="space-y-2">
            {preflightExecutions.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line/50 pb-2 last:border-0 last:pb-0">
                <div>
                  <span className="text-sm text-ink">{m.asset} · {m.decision.signalFamily}</span>
                  <span className="ml-2 text-xs text-ink-faint">{shortTime(m.createdAt)}</span>
                </div>
                <a
                  href={`https://bsctrace.com/tx/${m.proofAnchors.bscTxHash}`}
                  className="font-mono text-xs text-accent hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  {m.proofAnchors.bscTxHash?.slice(0, 12)}…
                </a>
              </div>
            ))}
          </Card>
        )}
      </div>
    </BscShell>
  );
}
