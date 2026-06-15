# LLM Policy

The LLM is a proposer, never the trader. The deterministic engine decides, the
risk constitution can veto, and the execution adapter only executes approved
mandates.

```
LLM can propose.
Deterministic engine must verify.
Risk Constitution can veto.
Execution adapter only executes approved Signal Mandates.
```

## What the LLM may do

- Compile a natural-language strategy into deterministic JSON (`strategyCompiler.ts`).
- Summarize news / earnings / sentiment into structured objects.
- Classify catalysts.
- Explain trade decisions and produce audit summaries from logs.
- Post-trade reflection (may suggest a parameter review; cannot change live config).

## What the LLM may not do

- Make the final buy/sell decision, size a position, or approve execution.
- Sign transactions.
- Bypass the deterministic score, the risk gates, the net-edge gate, stop
  coherence, the eligible-contract assertion, or the shadow-fill check.
- Invent prices, market data, eligibility, receipts, or tx hashes.
- Raise risk above configured caps. The strategy compiler clamps every risk number
  to the hard caps after the model proposes, so a malicious "ignore risk, all-in"
  prompt is reduced to the configured limits (see `test/strategyCompiler.test.ts`).

## Structured output

Every LLM call validates against a Zod schema (`llm/schemas.ts`). Invalid output is
rejected and repaired once; if still invalid the call fails with a typed error and
no trade occurs (`test/llm.test.ts`).

## Provider selection

```
LLM_PROVIDER=anthropic | openai | qwen | local | disabled
```

If `LLM_PROVIDER` is set it wins. Otherwise: anthropic if `ANTHROPIC_API_KEY`,
then openai if `OPENAI_API_KEY`, then qwen if `QWEN_API_KEY`, else disabled.
`LLM_ENABLED=false` forces disabled. In disabled mode the strategy compiler runs
from a validated manual JSON strategy and trading still works deterministically.

Providers are real HTTP clients (`anthropicProvider.ts`, `openaiProvider.ts`,
`qwenProvider.ts`, `localProvider.ts`) that throw loudly when their key/endpoint
is missing — they never substitute fabricated output.

### Qwen (first-class)

Qwen speaks the OpenAI-compatible Chat Completions API, so `qwenProvider.ts` is a
thin subclass of the OpenAI client with Qwen defaults:

| Env | Default | Notes |
|---|---|---|
| `QWEN_API_KEY` | — | required to enable qwen; throws loudly if missing |
| `QWEN_BASE_URL` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | intl/Singapore. CN: `https://dashscope.aliyuncs.com/compatible-mode/v1`. Also point at a hackathon gateway. |
| `QWEN_MODEL` | `qwen-plus` | overall default model |

> This deployment currently runs Qwen through the **openai** path
> (`OPENAI_BASE_URL=https://hackathon.bitgetops.com/v1`, `OPENAI_MODEL=qwen3.6-plus`),
> which still works unchanged. To use the first-class qwen provider, set
> `LLM_PROVIDER=qwen`, `QWEN_API_KEY`, and `QWEN_BASE_URL`/`QWEN_MODEL`.

## Per-role model routing (`llm/roles.ts`)

Each role reads its own `*_MODEL` env var if set. Otherwise an explicit provider
model (`QWEN_MODEL`, `OPENAI_MODEL`, and equivalents) is preserved, which keeps
custom OpenAI-compatible gateways working. If neither is set, routing falls back
to the active provider's tier default. Cheap/fast models serve the high-frequency
roles; only compilation/explanation reach for a stronger model.

| Role | Job | Tier | `*_MODEL` env | Qwen default | Touches money? |
|---|---|---|---|---|---|
| `STRATEGY_COMPILER` | NL strategy → deterministic JSON (re-validated + clamped) | strong | `STRATEGY_COMPILER_MODEL` | `qwen-max` | No |
| `NEWS_SENTIMENT` | classify CMC news/social into the event object; never says buy/sell | cheap | `NEWS_SENTIMENT_MODEL` | `qwen-turbo` | No |
| `AUDIT_SUMMARY` | plain-English summary strictly from audit logs | cheap | `AUDIT_SUMMARY_MODEL` | `qwen-turbo` | No |
| `POST_TRADE_REFLECTION` | what worked/failed from logs; may flag params, never changes them | mid | `POST_TRADE_REFLECTION_MODEL` | `qwen-plus` | No |
| `STRATEGY_EXPLANATION` | draft the DoraHacks write-up from the audit trail | mid | `STRATEGY_EXPLANATION_MODEL` | `qwen-plus` | No |

Tier defaults for other providers: openai → `gpt-4o` / `gpt-4o-mini`; anthropic →
`claude-3-5-sonnet-latest` / `claude-3-5-haiku-latest`. With only `QWEN_API_KEY`
set and no overrides, every role resolves to a sensible Qwen default and the
system just works (`test/roles.test.ts`).

Alibaba's official structured-output documentation requires the word `JSON` in
the prompt whenever `response_format={"type":"json_object"}` is used. The Qwen
provider enforces that compatibility rule before delegating to the shared
structured-generation and repair loop.

## Strategy explanation

`pnpm explain:strategy` reads persisted mandates, hash-chained audit events,
week/regime state, the two-ledger book, and watchdog exits. It first builds a
deterministic digest and a field-specific sentence bank. The LLM may only select
exact sentences from that bank; unsupported prose is replaced by the
deterministic field text, and notable trades always come from persisted records.
With no LLM key, the same data produces a deterministic template.
