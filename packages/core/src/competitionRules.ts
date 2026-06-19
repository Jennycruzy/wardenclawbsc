/**
 * Machine-readable competition rules. Confirmed requirements are separated from
 * unresolved organizer details. Open-item values are internal safety assumptions,
 * not official rules. The verify step warns on them before live scoring.
 */

export type RuleStatus = "verified" | "needs-exact-value" | "needs-organizer-confirmation";

export interface CompetitionRule {
  rule: string;
  source: string;
  status: RuleStatus;
  exactValue?: string;
  implementationFile: string;
}

const SOURCE = "DoraHacks official page (transcribed 2026-06-09)";
const OPEN_SOURCE = "Internal safety assumption; exact organizer value not confirmed";

export const COMPETITION_RULES: CompetitionRule[] = [
  {
    rule: "Track 1 trades live spot on BSC June 22–28, 2026",
    source: SOURCE,
    status: "verified",
    implementationFile: "packages/core/src/config.ts",
  },
  {
    rule: "Ranked by total return with a max drawdown cap as a disqualification gate",
    source: SOURCE,
    status: "verified",
    implementationFile: "packages/core/src/drawdownGovernor.ts",
  },
  {
    rule: "Minimum trades: at least 1 per day, 7 over the trading week",
    source: SOURCE,
    status: "verified",
    exactValue: "1/day, 7/week",
    implementationFile: "packages/core/src/config.ts",
  },
  {
    rule: "Returns measured hour by hour; an hour starting at <= $1 scores 0%",
    source: SOURCE,
    status: "verified",
    exactValue: "$1.00 floor",
    implementationFile: "packages/core/src/hourlySnapshot.ts",
  },
  {
    rule: "Must hold a non-zero balance of in-scope assets at competition start",
    source: SOURCE,
    status: "verified",
    implementationFile: "packages/core/src/eligibleTokens.ts",
  },
  {
    rule: "Trades outside the eligible token list do not count",
    source: SOURCE,
    status: "verified",
    implementationFile: "packages/core/src/eligibleTokens.ts",
  },
  {
    rule: "On-chain registration via the competition contract before the window opens",
    source: SOURCE,
    status: "verified",
    exactValue: "0x212c61b9b72c95d95bf29cf032f5e5635629aed5",
    implementationFile: "packages/core/src/config.ts",
  },
  {
    rule: "Simulated transaction costs are applied in scoring",
    source: SOURCE,
    status: "verified",
    implementationFile: "packages/core/src/frictionModel.ts",
  },
  {
    rule: "Exact disqualification drawdown percentage and measurement basis",
    source: OPEN_SOURCE,
    status: "needs-organizer-confirmation",
    exactValue: "30% indicative (page example); presumed whole-window peak-to-trough",
    implementationFile: "packages/core/src/config.ts",
  },
  {
    rule: "Exact simulated-transaction-cost amount/model used in scoring",
    source: OPEN_SOURCE,
    status: "needs-organizer-confirmation",
    exactValue: "SCORING_SIM_COST_BPS=10 per leg (internal safety assumption)",
    implementationFile: "packages/core/src/frictionModel.ts",
  },
  {
    rule: "Whether WBNB hops / native BNB count as in-scope",
    source: OPEN_SOURCE,
    status: "needs-organizer-confirmation",
    exactValue: "Presume not held as a position; WBNB allowed only as a route hop",
    implementationFile: "packages/core/src/eligibleTokens.ts",
  },
  {
    rule: "The 149-vs-enumerated eligible-token count discrepancy",
    source: OPEN_SOURCE,
    status: "needs-organizer-confirmation",
    exactValue: "Enumerated list treated as working truth",
    implementationFile: "data/eligible-tokens.json",
  },
];

export interface RuleVerification {
  ok: boolean;
  verified: CompetitionRule[];
  warnings: CompetitionRule[];
  /** Verified rules missing an implementation reference (a hard failure). */
  missingImplementation: CompetitionRule[];
}

export function verifyCompetitionRules(
  rules: CompetitionRule[] = COMPETITION_RULES,
): RuleVerification {
  const verified = rules.filter((r) => r.status === "verified");
  const warnings = rules.filter((r) => r.status !== "verified");
  const missingImplementation = verified.filter((r) => !r.implementationFile);
  return {
    ok: missingImplementation.length === 0,
    verified,
    warnings,
    missingImplementation,
  };
}
