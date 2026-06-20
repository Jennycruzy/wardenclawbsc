import Link from "next/link";
import { BscShell } from "@/components/bscShell";
import { Card, Stat, SectionTitle, Badge, Dot, EmptyState } from "@/components/ui";
import { SignalFamilyChip, ExecutionStatusChip } from "@/components/chips";
import { RejectionBars } from "@/components/charts";
import { competitionCountdown, loadBscMandates, computeBscProof, readBscEnv, readRegime, readWeekBudget } from "@/lib/data";
import { num, timeAgo, shortTime } from "@/lib/format";
import { COMPETITION, DEFAULT_RISK_CONFIG, isInCompetitionWindow } from "@wardenclaw/core";
import { STARTER_STABLES, STARTER_MAJORS } from "@wardenclaw/bsc-adapter";

export const dynamic = "force-dynamic";

export default function BscOverview() {
  const mandates = loadBscMandates();
  const competitionMandates = mandates.filter((m) => isInCompetitionWindow(m.createdAt));
  const proof = computeBscProof(competitionMandates);
  const preflightExecutions = mandates.filter(
    (m) =>
      m.risk.approved &&
      Boolean(m.proofAnchors.bscTxHash) &&
      Date.parse(m.createdAt) < Date.parse(COMPETITION.tradingWindow.startUtc),
  ).length;
  const env = readBscEnv();
  const cfg = DEFAULT_RISK_CONFIG;
  const regime = readRegime();
  const week = readWeekBudget();
  const countdown = competitionCountdown();
  const recent = mandates.slice(0, 8);

  return (
    <BscShell
      title="PnL-First BSC Trading Agent"
      subtitle="CMC is its eyes, TWAK is its hands — it only trades when calibrated edge beats real + simulated costs."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="pos"><Dot tone="pos" /> spot-only · ${env.startingCapitalUsd}</Badge>
          <Badge tone={env.cmcConfigured ? "pos" : "warn"}>CMC {env.cmcConfigured ? "live" : "not set"}</Badge>
          <Badge tone={env.twakConfigured ? "pos" : "warn"}>TWAK {env.twakConfigured ? "ready" : "not set"}</Badge>
          <Badge tone={regime?.regime === "RED" ? "neg" : regime?.regime === "GREEN" ? "pos" : "neutral"}>
            {regime?.regime ?? "regime pending"}
          </Badge>
          <Badge tone={countdown.phase === "preflight" ? "neutral" : week?.riskState === "DEFEND" ? "warn" : week?.riskState === "PRESS" ? "pos" : "accent"}>
            {countdown.phase === "preflight" ? "competition not started" : week?.riskState ?? "week state pending"}
          </Badge>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Competition mandates" value={num(proof.total)} sub={`updated ${timeAgo(proof.lastUpdated)}`} />
        <Stat label="Competition approvals" value={num(proof.approved)} valueClass="text-pos" sub="June 22–28 only" />
        <Link href="/bsc/proof" className="block transition hover:opacity-80" title="View on-chain rehearsal proof">
          <Stat label="Preflight executions" value={num(preflightExecutions)} valueClass="text-accent" sub="evidence only · not scored · proof ›" />
        </Link>
        <Stat label="Internal risk budget" value={`${cfg.internalWindowDrawdownPct}%`} sub="organizer DQ threshold pending" />
      </div>

      <Card className="mt-3">
        <SectionTitle title="Two tracks, one doctrine" subtitle="The same deterministic strategy, submitted twice" />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-line/60 p-3">
            <Badge tone="pos"><Dot tone="pos" /> Track 1 — live agent</Badge>
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">
              This self-custodial BSC agent: CMC perception, deterministic gates, TWAK-only signing, on-chain proof.
            </p>
          </div>
          <div className="rounded-lg border border-line/60 p-3">
            <Badge tone="accent"><Dot tone="accent" /> Track 2 — CMC Skill</Badge>
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">
              The same doctrine as a standalone, spec-only CoinMarketCap Skill
              (<span className="font-mono">wardenclaw-doctrine</span>) — emits JSON signals, never orders.
            </p>
          </div>
        </div>
      </Card>

      <Card className="mt-3">
        <SectionTitle title="Strategy — three uncrowded edges" subtitle="Every candidate then clears the same deterministic gate chain" />
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-line/60 p-3">
            <Badge tone="accent" className="font-mono">catalyst</Badge>
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">
              Improving trending <span className="text-ink">rank-delta</span> (not level) + fresh volume
              expansion + a no-first-spike continuation.
            </p>
          </div>
          <div className="rounded-lg border border-line/60 p-3">
            <Badge tone="accent" className="font-mono">rs_continuation</Badge>
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">
              Outperforms the benchmark over consecutive checks with rising volume — caught
              <span className="text-ink"> before it is crowded</span>.
            </p>
          </div>
          <div className="rounded-lg border border-line/60 p-3">
            <Badge tone="accent" className="font-mono">momentum</Badge>
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">
              Regime-gated rotation into the strongest liquid major vs stables —
              <span className="text-ink"> GREEN/NEUTRAL only</span>.
            </p>
          </div>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-ink-muted">
          <span className="text-ink-faint">Gate chain:</span> exact-contract eligibility · liquidity and route
          safety · calibrated expected move · simulated scoring cost · measured wallet friction · volatility stop ·
          three-layer drawdown governor · shadow-fill. If the measured edge does not beat all of that plus a margin,
          the agent does not trade.
        </p>
      </Card>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionTitle title="Tradeable universe" subtitle="Liquidity-passing subset of the eligible list (by contract address)" />
          <div className="space-y-3">
            <div>
              <span className="mb-1.5 block text-xs font-medium text-ink-faint">Stables — parking + Micro-Scout legs</span>
              <div className="flex flex-wrap gap-1.5">
                {STARTER_STABLES.map((t) => (
                  <Badge key={t.symbol} tone="neutral" className="font-mono">{t.symbol}</Badge>
                ))}
              </div>
            </div>
            <div>
              <span className="mb-1.5 block text-xs font-medium text-ink-faint">Liquid majors — momentum family</span>
              <div className="flex flex-wrap gap-1.5">
                {STARTER_MAJORS.map((t) => (
                  <Badge key={t.symbol} tone="accent" className="font-mono">{t.symbol}</Badge>
                ))}
              </div>
            </div>
          </div>
          <p className="mt-4 text-xs leading-relaxed text-ink-muted">
            Native BNB is gas only and is never held as a position. The catalyst tier (ASTER, MYX, BRETT,
            PENGU, …) is enabled per token after its CMC contract resolves and its PancakeSwap route passes
            the liquidity, slippage, and route-safety gates.
          </p>
        </Card>

        <Card>
          <SectionTitle title="Why competition trades were skipped" subtitle="Deterministic reject codes · June 22–28 only" />
          {proof.byRejectCode.length === 0 ? (
            <p className="py-8 text-center text-xs text-ink-faint">No rejections recorded yet.</p>
          ) : (
            <RejectionBars data={proof.byRejectCode} />
          )}
        </Card>
      </div>

      <div className="mt-3">
        <SectionTitle
          title="Recent Signal Mandates"
          subtitle="Operational audit trail; preflight activity is not competition scoring"
          right={<Link href="/bsc/mandates" className="text-xs text-accent hover:underline">View all →</Link>}
        />
        {recent.length === 0 ? (
          <EmptyState
            title="No mandates yet"
            hint="Run the agent against real CMC perception to populate the audit trail. Live signing additionally requires a configured TWAK wallet."
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
                  <th className="px-4 py-3 text-right font-medium">Score</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((m) => (
                  <tr key={m.id} className="border-b border-line/50 last:border-0 hover:bg-bg-subtle/50">
                    <td className="whitespace-nowrap px-4 py-3 text-ink-muted">{shortTime(m.createdAt)}</td>
                    <td className="px-4 py-3 font-mono">
                      <Link href={`/bsc/mandates/${m.id}`} className="text-accent hover:underline">{m.asset}</Link>
                    </td>
                    <td className="px-4 py-3"><SignalFamilyChip family={m.decision.signalFamily} /></td>
                    <td className="tabular px-4 py-3 text-right">{m.decision.tradeScore || "—"}</td>
                    <td className="px-4 py-3"><ExecutionStatusChip status={m.execution.status} /></td>
                    <td className="max-w-[18rem] truncate px-4 py-3 text-xs text-ink-muted">
                      {m.decision.rejectedReasons?.[0] ?? m.decision.reason[0] ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </BscShell>
  );
}
