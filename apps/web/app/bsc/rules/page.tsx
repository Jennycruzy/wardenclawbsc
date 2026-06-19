import { BscShell } from "@/components/bscShell";
import { Card, SectionTitle, Badge, Dot } from "@/components/ui";
import { COMPETITION_RULES, verifyCompetitionRules } from "@wardenclaw/core";

export const dynamic = "force-dynamic";

export default function BscRules() {
  const v = verifyCompetitionRules();
  const verified = COMPETITION_RULES.filter((r) => r.status === "verified");

  return (
    <BscShell
      title="Competition Rules"
      subtitle="Confirmed requirements enforced by WARDENCLAW."
      actions={
        <Badge tone={v.ok ? "pos" : "neg"}>
          <Dot tone={v.ok ? "pos" : "neg"} /> {v.ok ? "verify passes" : "verify failing"}
        </Badge>
      }
    >
      <Card>
        <SectionTitle title="Verified rules" subtitle={`${verified.length} rules, each with an implementation reference`} />
        <div className="space-y-2.5">
          {verified.map((r) => (
            <div key={r.rule} className="flex items-start justify-between gap-3 border-b border-line/50 py-2 last:border-0">
              <div>
                <span className="text-sm text-ink">{r.rule}</span>
                {r.exactValue ? <span className="ml-2 text-xs text-ink-muted">({r.exactValue})</span> : null}
                <details className="mt-0.5 text-[11px] text-ink-faint">
                  <summary className="cursor-pointer">Implementation reference</summary>
                  <code className="font-mono">{r.implementationFile}</code>
                </details>
              </div>
              <Badge tone="pos"><Dot tone="pos" /> verified</Badge>
            </div>
          ))}
        </div>
      </Card>
    </BscShell>
  );
}
