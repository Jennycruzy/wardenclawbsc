import { describe, it, expect } from "vitest";
import {
  buildExplanationDigest,
  templateExplanation,
  enforceGrounding,
  draftStrategyExplanation,
  renderExplanationMarkdown,
  BaseLlmProvider,
  DisabledProvider,
  strategyExplanationSchema,
  type ExplanationInputs,
  type LlmMessage,
  type StrategyExplanation,
} from "../src/index.js";

const fixedNow = () => new Date("2026-06-15T00:00:00.000Z");

const richInputs: ExplanationInputs = {
  now: fixedNow,
  weekLedger: {
    weekStartIso: "2026-06-09T00:00:00.000Z",
    startValueUsd: 40,
    peakValueUsd: 44,
    pressTradeUsed: true,
    legs: [
      { atIso: "2026-06-09T01:00:00.000Z", kind: "entry" },
      { atIso: "2026-06-09T05:00:00.000Z", kind: "exit" },
      { atIso: "2026-06-12T23:50:00.000Z", kind: "scout" },
    ],
  },
  scored: { tradeCount: 1, cumulativeReturnBps: 180, cumulativeReturnUsd: 0.72 },
  regimeHistory: [
    { regime: "GREEN" },
    { regime: "GREEN" },
    { regime: "RED" },
  ],
  weekStateTransitions: [
    { state: "HUNT" },
    { state: "PRESS" },
  ],
  auditEvents: [
    {
      timestamp: "2026-06-09T01:00:00.000Z",
      mandateId: "m-001",
      stage: "decision",
      input: {},
      output: {},
      previousHash: "0".repeat(64),
      eventHash: "abc",
    },
    {
      timestamp: "2026-06-09T01:00:01.000Z",
      mandateId: "m-001",
      stage: "execution",
      input: {},
      output: {},
      previousHash: "abc",
      eventHash: "def",
    },
  ],
  trailingExits: [
    { mandateId: "m-001", reason: "+9% runner reversed into trail", pnlBps: 180 },
    { mandateId: "ghost-999", reason: "should be dropped", pnlBps: 50 },
  ],
  walletValueUsd: 41.2,
};

describe("buildExplanationDigest", () => {
  it("is built purely from supplied inputs", () => {
    const d = buildExplanationDigest(richInputs);
    expect(d.legCount).toBe(3);
    expect(d.entryLegs).toBe(1);
    expect(d.exitLegs).toBe(1);
    expect(d.scoutLegs).toBe(1);
    expect(d.scoredReturnPct).toBe(1.8);
    expect(d.regimeCounts).toEqual({ GREEN: 2, RED: 1 });
    expect(d.weekStates).toEqual(["HUNT", "PRESS"]);
    expect(d.decisionCount).toBe(1);
    expect(d.executionCount).toBe(1);
    // notable trades only for known mandates; the ghost is excluded
    expect(d.notableTrades.map((t) => t.mandateId)).toEqual(["m-001"]);
    expect(d.empty).toBe(false);
  });

  it("flags empty when there is nothing to explain", () => {
    const d = buildExplanationDigest({ now: fixedNow });
    expect(d.empty).toBe(true);
  });
});

describe("enforceGrounding / anti-hallucination", () => {
  it("blanks unfounded prose fields and drops unknown mandate trades", () => {
    const emptyDigest = buildExplanationDigest({ now: fixedNow });
    const hallucinated: StrategyExplanation = {
      thesis: "invented thesis",
      regimeBehaviour: "invented regime talk",
      entryLogic: "invented entries",
      riskControls: "invented controls",
      notableTrades: [{ mandateId: "made-up", why: "x", outcome: "y" }],
      resultSummary: "invented +500% gains",
      honestCaveats: "invented caveat",
    };
    const guarded = enforceGrounding(hallucinated, emptyDigest);
    expect(guarded.regimeBehaviour).toBe("");
    expect(guarded.entryLogic).toBe("");
    expect(guarded.resultSummary).toBe("No audited trade result is available yet.");
    expect(guarded.notableTrades).toEqual([]);
    expect(guarded.thesis).toBe("No audited strategy activity is available yet.");
    expect(guarded.riskControls).toBe("No audited risk-control outcome is available yet.");
    expect(guarded.honestCaveats).toContain("extractive");
  });
});

describe("disabled mode", () => {
  it("produces a deterministic, schema-valid template with no LLM", async () => {
    const { explanation, source } = await draftStrategyExplanation(richInputs, new DisabledProvider());
    expect(source).toBe("template");
    expect(() => strategyExplanationSchema.parse(explanation)).not.toThrow();
    expect(explanation.resultSummary).toContain("1.8%");
    expect(explanation.notableTrades).toHaveLength(1);
  });

  it("templateExplanation handles the empty case safely", () => {
    const d = buildExplanationDigest({ now: fixedNow });
    const e = templateExplanation(d);
    expect(e.regimeBehaviour).toBe("");
    expect(e.notableTrades).toEqual([]);
  });
});

describe("LLM-narrated mode (mocked)", () => {
  class ScriptedProvider extends BaseLlmProvider {
    readonly name = "qwen" as const;
    constructor(private readonly out: string) {
      super();
    }
    protected async complete(_m: LlmMessage): Promise<string> {
      return this.out;
    }
  }

  it("produces grounded, schema-valid output and drops invented trades", async () => {
    const modelReply = JSON.stringify({
      thesis: "Win-first deterministic BSC strategy.",
      regimeBehaviour: "Classified GREEN/RED; RED blocked entries.",
      entryLogic: "Score + net-edge gated entries.",
      riskControls: "Hard caps, net-edge gate, trailing stop.",
      notableTrades: [
        { mandateId: "m-001", why: "runner reversed", outcome: "+1.8% scored" },
        { mandateId: "ghost-999", why: "hallucinated", outcome: "+50%" },
      ],
      resultSummary: "1.8% scored over 3 legs.",
      honestCaveats: "Short window, variance applies.",
    });
    const { explanation, source } = await draftStrategyExplanation(
      richInputs,
      new ScriptedProvider(modelReply),
    );
    expect(source).toBe("llm");
    expect(explanation.notableTrades.map((t) => t.mandateId)).toEqual(["m-001"]);
    expect(explanation.resultSummary).not.toContain("+50%");
    expect(explanation.thesis).toBe(buildExplanationDigest(richInputs).basis.thesis.join("\n"));
    expect(() => strategyExplanationSchema.parse(explanation)).not.toThrow();
  });

  it("falls back to the template when the model errors", async () => {
    class BoomProvider extends BaseLlmProvider {
      readonly name = "qwen" as const;
      protected async complete(): Promise<string> {
        throw new Error("network down");
      }
    }
    const { source, explanation } = await draftStrategyExplanation(richInputs, new BoomProvider());
    expect(source).toBe("template");
    expect(explanation.thesis.length).toBeGreaterThan(0);
  });
});

describe("renderExplanationMarkdown", () => {
  it("renders paste-ready markdown with facts and notable trades", () => {
    const digest = buildExplanationDigest(richInputs);
    const md = renderExplanationMarkdown(templateExplanation(digest), digest, "template");
    expect(md).toContain("# WARDENCLAW BSC — Strategy Explanation");
    expect(md).toContain("`m-001`");
    expect(md).toContain("Underlying facts");
    // never leaks the dropped ghost trade
    expect(md).not.toContain("ghost-999");
  });
});
