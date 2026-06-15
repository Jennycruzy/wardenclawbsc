/**
 * Auto-drafted DoraHacks strategy explanation — grounded in the audit trail, not
 * marketing.
 *
 * Pipeline:
 *   1. `buildExplanationDigest` deterministically summarizes the real inputs
 *      (week ledger legs, scored-ledger result, regime history, audit events,
 *      week-state transitions, trailing exits) into a compact, factual digest.
 *   2. `draftStrategyExplanation` turns that digest into the structured write-up.
 *      With an LLM it narrates the digest; with no LLM it fills a deterministic
 *      template. Either way the result passes an anti-hallucination guard so
 *      every claim is traceable to a supplied input — fields with no basis stay
 *      empty, and notable trades referencing unknown mandateIds are dropped.
 *
 * SAFETY: this never decides, sizes, prices, or approves a trade. It only
 * narrates what already happened, after the fact.
 */

import {
  strategyExplanationSchema,
  type StrategyExplanation,
} from "./llm/schemas.js";
import { LlmDisabledError, type LlmProvider } from "./llm/provider.js";
import type { WeekLedger } from "./weekLedger.js";
import type { ScoredLedgerSummary } from "./ledgers.js";
import type { AuditEvent } from "./auditLogger.js";
import type { SignalMandate } from "./types.js";

export interface RegimePoint {
  timestamp?: string;
  regime: string;
}

export interface WeekStateTransition {
  timestamp?: string;
  state: string;
  reason?: string;
}

export interface TrailingExitRecord {
  mandateId: string;
  reason?: string;
  /** Realized scored or wallet PnL of the exit, in bps (optional). */
  pnlBps?: number;
}

export interface ExplanationInputs {
  weekLedger?: WeekLedger;
  scored?: ScoredLedgerSummary;
  regimeHistory?: RegimePoint[];
  auditEvents?: AuditEvent[];
  mandateLog?: SignalMandate[];
  weekStateTransitions?: WeekStateTransition[];
  trailingExits?: TrailingExitRecord[];
  /** Live wallet value in USD, if known. */
  walletValueUsd?: number;
  /** Override the digest timestamp (tests). */
  now?: () => Date;
}

export interface DigestNotableTrade {
  mandateId: string;
  why: string;
  outcome: string;
}

export interface ExplanationDigest {
  generatedAt: string;
  weekStartIso?: string;
  legCount: number;
  entryLegs: number;
  exitLegs: number;
  scoutLegs: number;
  pressTradeUsed?: boolean;
  scoredReturnPct?: number;
  scoredReturnUsd?: number;
  startValueUsd?: number;
  peakValueUsd?: number;
  walletValueUsd?: number;
  regimeCounts: Record<string, number>;
  weekStates: string[];
  decisionCount: number;
  executionCount: number;
  knownMandateIds: string[];
  notableTrades: DigestNotableTrade[];
  /** Extractive sentence bank. LLM prose must use these exact supplied facts. */
  basis: Record<
    "thesis" | "regimeBehaviour" | "entryLogic" | "riskControls" | "resultSummary" | "honestCaveats",
    string[]
  >;
  /** Plain factual statements; the narration may only restate these. */
  facts: string[];
  /** True when there is essentially nothing to explain yet. */
  empty: boolean;
}

function pct(bps: number): number {
  return Math.round((bps / 100) * 100) / 100;
}

/** Build the deterministic factual digest. Pure function of the inputs. */
export function buildExplanationDigest(inputs: ExplanationInputs): ExplanationDigest {
  const now = (inputs.now ?? (() => new Date()))();
  const legs = inputs.weekLedger?.legs ?? [];
  const entryLegs = legs.filter((l) => l.kind === "entry").length;
  const exitLegs = legs.filter((l) => l.kind === "exit").length;
  const scoutLegs = legs.filter((l) => l.kind === "scout").length;

  const regimeCounts: Record<string, number> = {};
  for (const p of inputs.regimeHistory ?? []) {
    regimeCounts[p.regime] = (regimeCounts[p.regime] ?? 0) + 1;
  }

  const weekStates = Array.from(
    new Set((inputs.weekStateTransitions ?? []).map((t) => t.state)),
  );

  const events = inputs.auditEvents ?? [];
  const mandates = inputs.mandateLog ?? [];
  const decisionCount = events.filter((e) => e.stage === "decision").length;
  const executionCount = events.filter((e) => e.stage === "execution").length;
  // The audit trail is the sole source of truth for which mandates exist. A
  // trailing-exit record for a mandateId that never appears in the trail is
  // dropped — so the narration can never reference a trade we cannot prove.
  const knownMandateIds = Array.from(
    new Set(
      [...events.map((e) => e.mandateId), ...mandates.map((mandate) => mandate.id)]
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );

  const mandateTrades: DigestNotableTrade[] = mandates
    .filter((mandate) => mandate.result && mandate.result.outcome !== "skipped")
    .map((mandate) => ({
      mandateId: mandate.id,
      why: mandate.decision.reason.join("; "),
      outcome: [
        mandate.result?.outcome,
        typeof mandate.result?.pnlPct === "number"
          ? `${mandate.result.pnlPct >= 0 ? "+" : ""}${mandate.result.pnlPct.toFixed(2)}%`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    }));

  // Notable trades come only from persisted mandates or trailing exits tied to a
  // known mandate. The final list is deterministic and never copied from the LLM.
  const trailingTrades: DigestNotableTrade[] = (inputs.trailingExits ?? [])
    .filter((t) => knownMandateIds.includes(t.mandateId))
    .map((t) => ({
      mandateId: t.mandateId,
      why: t.reason ?? "trailing-stop exit",
      outcome:
        typeof t.pnlBps === "number"
          ? `${t.pnlBps >= 0 ? "+" : ""}${pct(t.pnlBps)}% scored`
          : "exit recorded",
    }));
  const notableTrades = Array.from(
    new Map([...mandateTrades, ...trailingTrades].map((trade) => [trade.mandateId, trade])).values(),
  );

  const scoredReturnPct =
    inputs.scored != null ? pct(inputs.scored.cumulativeReturnBps) : undefined;

  const facts: string[] = [];
  if (inputs.weekLedger) {
    facts.push(
      `Week started ${inputs.weekLedger.weekStartIso} at $${inputs.weekLedger.startValueUsd.toFixed(2)}; peak $${inputs.weekLedger.peakValueUsd.toFixed(2)}.`,
    );
    facts.push(
      `${legs.length} executed legs: ${entryLegs} entry, ${exitLegs} exit, ${scoutLegs} scout.`,
    );
    facts.push(`Pre-committed PRESS trade ${inputs.weekLedger.pressTradeUsed ? "was" : "was not"} used.`);
  }
  if (inputs.scored) {
    facts.push(
      `Scored ledger: ${inputs.scored.tradeCount} trades, cumulative ${scoredReturnPct}% (${inputs.scored.cumulativeReturnUsd >= 0 ? "+" : ""}$${inputs.scored.cumulativeReturnUsd.toFixed(2)}).`,
    );
  }
  if (typeof inputs.walletValueUsd === "number") {
    facts.push(`Live wallet value $${inputs.walletValueUsd.toFixed(2)}.`);
  }
  if (Object.keys(regimeCounts).length > 0) {
    const parts = Object.entries(regimeCounts).map(([r, n]) => `${r}×${n}`);
    facts.push(`Regime observations: ${parts.join(", ")}.`);
  }
  if (weekStates.length > 0) {
    facts.push(`Week-state phases entered: ${weekStates.join(", ")}.`);
  }
  if (decisionCount > 0 || executionCount > 0) {
    facts.push(`Audit trail: ${decisionCount} decision events, ${executionCount} execution events.`);
  }
  if (mandates.length > 0) {
    const approved = mandates.filter((mandate) => mandate.risk.approved).length;
    facts.push(`${mandates.length} validated mandates: ${approved} approved, ${mandates.length - approved} rejected.`);
  }

  const familyCounts: Record<string, number> = {};
  const rejectCounts: Record<string, number> = {};
  for (const mandate of mandates) {
    familyCounts[mandate.decision.signalFamily] =
      (familyCounts[mandate.decision.signalFamily] ?? 0) + 1;
    for (const code of mandate.decision.rejectedReasons ?? []) {
      rejectCounts[code] = (rejectCounts[code] ?? 0) + 1;
    }
  }

  const basis: ExplanationDigest["basis"] = {
    thesis: [],
    regimeBehaviour: [],
    entryLogic: [],
    riskControls: [],
    resultSummary: [],
    honestCaveats: [
      "This draft is extractive: every claim is copied from the deterministic audit digest.",
    ],
  };
  if (mandates.length > 0) {
    basis.thesis.push(
      `The audit log contains ${mandates.length} validated mandates across ${Object.keys(familyCounts).length} signal families.`,
    );
  } else if (decisionCount > 0) {
    basis.thesis.push(`The audit log contains ${decisionCount} recorded decision events.`);
  }
  if (Object.keys(regimeCounts).length > 0) {
    basis.regimeBehaviour.push(
      `Recorded regime observations were ${Object.entries(regimeCounts)
        .map(([regime, count]) => `${regime} (${count})`)
        .join(", ")}.`,
    );
  }
  if (Object.keys(familyCounts).length > 0) {
    basis.entryLogic.push(
      `Recorded signal families were ${Object.entries(familyCounts)
        .map(([family, count]) => `${family} (${count})`)
        .join(", ")}.`,
    );
  }
  if (entryLegs > 0 || decisionCount > 0) {
    basis.entryLogic.push(
      `${decisionCount} decision events correspond to ${entryLegs} recorded entry legs.`,
    );
  }
  if (Object.keys(rejectCounts).length > 0) {
    basis.riskControls.push(
      `Deterministic rejection codes recorded were ${Object.entries(rejectCounts)
        .map(([code, count]) => `${code} (${count})`)
        .join(", ")}.`,
    );
  }
  if (mandates.length > 0) {
    const approved = mandates.filter((mandate) => mandate.risk.approved).length;
    basis.riskControls.push(
      `${approved} of ${mandates.length} validated mandates passed the recorded risk verdict.`,
    );
  }
  if (scoredReturnPct !== undefined) {
    basis.resultSummary.push(
      `The scored ledger records ${scoredReturnPct}% across ${inputs.scored?.tradeCount ?? 0} trades.`,
    );
  }
  if (legs.length > 0) {
    basis.resultSummary.push(
      `The week ledger records ${legs.length} executed legs: ${entryLegs} entry, ${exitLegs} exit, and ${scoutLegs} scout.`,
    );
  }
  if (typeof inputs.walletValueUsd === "number") {
    basis.resultSummary.push(`The recorded wallet value is $${inputs.walletValueUsd.toFixed(2)}.`);
  }
  if (notableTrades.length === 0) {
    basis.honestCaveats.push("No completed notable trade is supported by the supplied records.");
  }
  if (
    mandates.length === 0 &&
    events.length === 0 &&
    legs.length === 0 &&
    Object.keys(regimeCounts).length === 0
  ) {
    basis.thesis.push("No audited strategy activity is available yet.");
    basis.riskControls.push("No audited risk-control outcome is available yet.");
    basis.resultSummary.push("No audited trade result is available yet.");
  }

  const empty =
    legs.length === 0 &&
    events.length === 0 &&
    mandates.length === 0 &&
    (inputs.scored?.tradeCount ?? 0) === 0 &&
    (inputs.regimeHistory?.length ?? 0) === 0;

  const digest: ExplanationDigest = {
    generatedAt: now.toISOString(),
    legCount: legs.length,
    entryLegs,
    exitLegs,
    scoutLegs,
    regimeCounts,
    weekStates,
    decisionCount,
    executionCount,
    knownMandateIds,
    notableTrades,
    basis,
    facts,
    empty,
  };
  if (inputs.weekLedger) {
    digest.weekStartIso = inputs.weekLedger.weekStartIso;
    digest.startValueUsd = inputs.weekLedger.startValueUsd;
    digest.peakValueUsd = inputs.weekLedger.peakValueUsd;
    digest.pressTradeUsed = inputs.weekLedger.pressTradeUsed;
  }
  if (inputs.scored) {
    digest.scoredReturnPct = scoredReturnPct;
    digest.scoredReturnUsd = inputs.scored.cumulativeReturnUsd;
  }
  if (typeof inputs.walletValueUsd === "number") digest.walletValueUsd = inputs.walletValueUsd;
  return digest;
}

/**
 * Anti-hallucination guard. Drops notable trades whose mandateId is not in the
 * digest, and blanks any prose field whose supporting digest section is empty.
 */
export function enforceGrounding(
  draft: StrategyExplanation,
  digest: ExplanationDigest,
): StrategyExplanation {
  const grounded = (
    field: keyof ExplanationDigest["basis"],
    value: string,
  ): string => {
    const allowed = new Set(digest.basis[field]);
    if (allowed.size === 0) return "";
    const claims = value
      .split(/\n+/)
      .map((claim) => claim.trim())
      .filter(Boolean);
    return claims.length > 0 && claims.every((claim) => allowed.has(claim))
      ? claims.join("\n")
      : digest.basis[field].join("\n");
  };
  return strategyExplanationSchema.parse({
    thesis: grounded("thesis", draft.thesis),
    regimeBehaviour: grounded("regimeBehaviour", draft.regimeBehaviour),
    entryLogic: grounded("entryLogic", draft.entryLogic),
    riskControls: grounded("riskControls", draft.riskControls),
    notableTrades: digest.notableTrades,
    resultSummary: grounded("resultSummary", draft.resultSummary),
    honestCaveats: grounded("honestCaveats", draft.honestCaveats),
  });
}

/** Deterministic, LLM-free write-up built straight from the digest. */
export function templateExplanation(digest: ExplanationDigest): StrategyExplanation {
  return strategyExplanationSchema.parse({
    thesis: digest.basis.thesis.join("\n"),
    regimeBehaviour: digest.basis.regimeBehaviour.join("\n"),
    entryLogic: digest.basis.entryLogic.join("\n"),
    riskControls: digest.basis.riskControls.join("\n"),
    notableTrades: digest.notableTrades,
    resultSummary: digest.basis.resultSummary.join("\n"),
    honestCaveats: digest.basis.honestCaveats.join("\n"),
  });
}

const SYSTEM_PROMPT =
  "You are a careful technical writer producing a competition strategy explanation. " +
  "You will be given a JSON digest of FACTS from a trading agent's audit trail. " +
  "Write a structured explanation using ONLY exact sentences from each field's basis array. " +
  "You may reorder or omit basis sentences, joining selected sentences with newlines, but you must not paraphrase them. " +
  "Return notableTrades exactly as supplied in the digest. If a basis array is empty, return an empty string. " +
  "Reply with ONLY a JSON object matching the required schema.";

/**
 * Draft the explanation. Uses the LLM provider to narrate the digest; on any
 * disabled/failed LLM it falls back to the deterministic template. The result is
 * always grounding-checked, so it can never contain a claim absent from the
 * digest.
 */
export async function draftStrategyExplanation(
  inputs: ExplanationInputs,
  provider?: LlmProvider,
): Promise<{ explanation: StrategyExplanation; digest: ExplanationDigest; source: "llm" | "template" }> {
  const digest = buildExplanationDigest(inputs);
  if (!provider || provider.name === "disabled") {
    return { explanation: templateExplanation(digest), digest, source: "template" };
  }
  try {
    const raw = await provider.generateStructured({
      system: SYSTEM_PROMPT,
      user: `Audit-trail digest (the only facts you may use):\n${JSON.stringify(digest, null, 2)}`,
      schema: strategyExplanationSchema,
    });
    return { explanation: enforceGrounding(raw, digest), digest, source: "llm" };
  } catch (err) {
    if (err instanceof LlmDisabledError) {
      return { explanation: templateExplanation(digest), digest, source: "template" };
    }
    // Any other LLM failure: never block the deliverable, fall back to template.
    return { explanation: templateExplanation(digest), digest, source: "template" };
  }
}

/** Render the structured explanation as paste-ready DoraHacks Markdown. */
export function renderExplanationMarkdown(
  explanation: StrategyExplanation,
  digest: ExplanationDigest,
  source: "llm" | "template",
): string {
  const lines: string[] = [];
  lines.push("# WARDENCLAW BSC — Strategy Explanation");
  lines.push("");
  lines.push(
    `_Auto-drafted from the audit trail (${source === "llm" ? "LLM-narrated" : "deterministic template"}) at ${digest.generatedAt}. Every figure is taken from the recorded ledgers and logs._`,
  );
  lines.push("");
  const section = (title: string, body: string) => {
    if (body && body.trim()) {
      lines.push(`## ${title}`, "", body.trim(), "");
    }
  };
  section("Thesis", explanation.thesis);
  section("Regime behaviour", explanation.regimeBehaviour);
  section("Entry logic", explanation.entryLogic);
  section("Risk controls", explanation.riskControls);
  section("Result summary", explanation.resultSummary);
  if (explanation.notableTrades.length > 0) {
    lines.push("## Notable trades", "");
    for (const t of explanation.notableTrades) {
      lines.push(`- \`${t.mandateId}\` — ${t.why} → ${t.outcome}`);
    }
    lines.push("");
  }
  section("Honest caveats", explanation.honestCaveats);
  lines.push("---", "");
  lines.push("### Underlying facts (digest)", "");
  for (const f of digest.facts) lines.push(`- ${f}`);
  lines.push("");
  return lines.join("\n");
}
