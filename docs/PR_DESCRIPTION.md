# Qwen role routing, audit explanation, and CMC preflight

## Summary

- Adds first-class Alibaba Qwen support through DashScope's official
  OpenAI-compatible API, with per-role model routing and the existing shared
  schema-validation/repair loop.
- Adds an extractive DoraHacks strategy-explanation drafter sourced from
  persisted mandates, audit events, ledgers, regime/week state, and watchdog
  exits. Disabled mode still produces a deterministic draft.
- Adds `pnpm check:cmc`, which proves the real CMC key through the worker's own
  client across key info, quotes, volume, trending, Fear & Greed, contract
  resolution, and a no-spend x402 reachability probe.

## Roles and keys

- **CMC Pro key:** required. It is the agent's data input. `pnpm check:cmc`
  proves the key, base URL, headers, client parsing, plan access, and required
  data surfaces end to end.
- **Qwen key:** optional. It powers non-executing classification, summaries,
  reflection, and the audit-grounded strategy explanation. Cheap Qwen models
  serve frequent roles; stronger models are reserved for strategy compilation
  and explanation.
- **No LLM key:** the agent still trades deterministically. The strategy
  explanation command uses its deterministic extractive fallback.

No LLM output can decide, size, price, approve, or execute a trade.
