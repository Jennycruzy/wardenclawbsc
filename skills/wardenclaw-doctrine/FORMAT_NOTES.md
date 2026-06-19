# FORMAT_NOTES — what CMC Skill format this conforms to

## What was verified

The official CoinMarketCap Skill format was confirmed against the **official CMC skills
repository** and the CMC AI Agent Hub docs:

- Repo: `github.com/coinmarketcap-official/skills-for-ai-agents-by-CoinMarketCap`
- Hub docs: `coinmarketcap.com/api/agent` and `pro.coinmarketcap.com/api/documentation/ai-agent-hub`

Existing published Skills inspected for the exact structure: `skills/cmc-api-crypto/SKILL.md`,
`skills/cmc-mcp/SKILL.md`, and `skills/market-report/SKILL.md` (the closest analog — a
strategy/report-style Skill rather than a raw API reference).

## The format followed

Each Skill is a folder under `skills/<skill-name>/` containing a `SKILL.md`: **YAML
frontmatter** followed by an English Markdown body, optionally with a `references/`
subfolder. The frontmatter fields observed and used here:

| Field | Required? | Used here |
|---|---|---|
| `name` | yes | `wardenclaw-doctrine` (kebab-case, matches the folder) |
| `description` | yes | multi-line block; ends with a `Trigger:` line of activation phrases, matching the published Skills |
| `license` | optional (present in `market-report`) | `MIT` |
| `compatibility` | optional (present in `market-report`) | `">=1.0.0"` |
| `user-invocable` | yes (in every inspected Skill) | `true` |
| `allowed-tools` | yes | the `mcp__cmc-mcp__*` tools the Skill consumes, plus `Read`/`Bash` for the backtest — exactly how `market-report` declares its CMC tools |

Body sections are free-form English appropriate to the Skill (the published Skills vary their
headings — `cmc-api-crypto` uses API-reference headings; `market-report` uses report-section
headings). This Skill uses strategy-appropriate sections: When to use, CMC data consumed, the
doctrine, output signals, how to run the backtest, principles, reference files.

## CMC tool declaration

CMC surfaces are declared in `allowed-tools` using the Agent Hub MCP identifiers:
`mcp__cmc-mcp__get_crypto_quotes_latest` (quotes), `mcp__cmc-mcp__trending_crypto_narratives`
(trending), `mcp__cmc-mcp__get_global_metrics_latest` (global metrics + Fear & Greed). These
are the same surfaces the repo's `packages/cmc-adapter` consumes (tagged `quotes`, `trending`,
`fear_greed`), which map to the CMC REST endpoints `/v2/cryptocurrency/quotes/latest`,
`/v1/cryptocurrency/trending/latest`, and `/v3/fear-and-greed/latest` respectively.

## Caveat / what could not be fully pinned

The Hub documentation pages describe *choosing and using* Skills more than a single formal
*authoring* spec; the authoritative structure was therefore taken from the **published Skills
in the official repo** (the most reliable source). If CMC later publishes a stricter authoring
schema (e.g. additional required frontmatter keys), update `SKILL.md` accordingly — the body
content and `strategy-spec.md` are unaffected. This file records exactly what was followed and
why, rather than inventing a format silently.
