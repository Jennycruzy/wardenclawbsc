/**
 * Per-role LLM model routing.
 *
 * The agent uses the LLM for several distinct, NON-trading jobs. Cheap/fast roles
 * (news classification, audit summaries) should run on a small model; the one
 * reasoning-heavy role (strategy compilation) can use the strongest model; the
 * narration roles sit in the middle. Each role reads its own `*_MODEL` env var if
 * set, otherwise falls back to the active provider's default model for its tier.
 *
 * With only a Qwen key set and no overrides, every role resolves to a sensible
 * Qwen default and the system "just works". None of these roles can touch a trade
 * decision, size, price, or gate verdict — they only fill structured summary /
 * classification / explanation objects that are re-validated downstream.
 */

import {
  selectProvider,
  type LlmProvider,
  type LlmProviderName,
} from "./provider.js";
import { createLlmProvider, type LlmFactoryEnv } from "./factory.js";

export type LlmRole =
  | "STRATEGY_COMPILER"
  | "NEWS_SENTIMENT"
  | "AUDIT_SUMMARY"
  | "POST_TRADE_REFLECTION"
  | "STRATEGY_EXPLANATION";

/** Model strength tiers; the cheap tier serves the high-frequency roles. */
export type ModelTier = "strong" | "mid" | "cheap";

interface RoleSpec {
  /** The env var that overrides this role's model. */
  envVar: string;
  tier: ModelTier;
  /** One-line description of the job (never trades). */
  job: string;
}

export const ROLE_SPECS: Record<LlmRole, RoleSpec> = {
  STRATEGY_COMPILER: {
    envVar: "STRATEGY_COMPILER_MODEL",
    tier: "strong",
    job: "NL strategy/constitution -> deterministic strategy JSON (re-validated and clamped)",
  },
  NEWS_SENTIMENT: {
    envVar: "NEWS_SENTIMENT_MODEL",
    tier: "cheap",
    job: "classify CMC news/social into the structured event object; never says buy/sell",
  },
  AUDIT_SUMMARY: {
    envVar: "AUDIT_SUMMARY_MODEL",
    tier: "cheap",
    job: "plain-English summary strictly from audit logs",
  },
  POST_TRADE_REFLECTION: {
    envVar: "POST_TRADE_REFLECTION_MODEL",
    tier: "mid",
    job: "what worked/failed from logs; may flag params, never changes them",
  },
  STRATEGY_EXPLANATION: {
    envVar: "STRATEGY_EXPLANATION_MODEL",
    tier: "mid",
    job: "draft the DoraHacks write-up from the audit trail",
  },
};

/** Default model per provider per tier. */
const TIER_DEFAULTS: Record<Exclude<LlmProviderName, "disabled">, Record<ModelTier, string>> = {
  qwen: { strong: "qwen-max", mid: "qwen-plus", cheap: "qwen-turbo" },
  openai: { strong: "gpt-4o", mid: "gpt-4o-mini", cheap: "gpt-4o-mini" },
  anthropic: {
    strong: "claude-3-5-sonnet-latest",
    mid: "claude-3-5-sonnet-latest",
    cheap: "claude-3-5-haiku-latest",
  },
  local: { strong: "local-model", mid: "local-model", cheap: "local-model" },
};

export interface RoleRouterEnv extends LlmFactoryEnv {
  STRATEGY_COMPILER_MODEL?: string;
  NEWS_SENTIMENT_MODEL?: string;
  AUDIT_SUMMARY_MODEL?: string;
  POST_TRADE_REFLECTION_MODEL?: string;
  STRATEGY_EXPLANATION_MODEL?: string;
}

export interface RoleResolution {
  role: LlmRole;
  provider: LlmProviderName;
  tier: ModelTier;
  /** Null only in disabled mode (no provider/model). */
  model: string | null;
  source: "role-override" | "provider-default" | "disabled";
}

/**
 * Resolve which provider + model a given role should use, without instantiating
 * a client. Pure function of the environment — handy for diagnostics and docs.
 */
export function resolveRoleModel(
  role: LlmRole,
  env: RoleRouterEnv = process.env as RoleRouterEnv,
): RoleResolution {
  const spec = ROLE_SPECS[role];
  const selection = selectProvider(env);
  if (!selection.enabled || selection.name === "disabled") {
    return { role, provider: "disabled", tier: spec.tier, model: null, source: "disabled" };
  }
  const override = (env[spec.envVar as keyof RoleRouterEnv] as string | undefined)?.trim();
  if (override) {
    return { role, provider: selection.name, tier: spec.tier, model: override, source: "role-override" };
  }
  const model = TIER_DEFAULTS[selection.name as Exclude<LlmProviderName, "disabled">][spec.tier];
  return { role, provider: selection.name, tier: spec.tier, model, source: "provider-default" };
}

/**
 * Build a live provider configured for a role. In disabled mode this returns a
 * DisabledProvider (callers degrade gracefully — it never throws here).
 */
export function createRoleProvider(
  role: LlmRole,
  env: RoleRouterEnv = process.env as RoleRouterEnv,
): LlmProvider {
  const resolved = resolveRoleModel(role, env);
  // createLlmProvider already returns a DisabledProvider when model is absent.
  return createLlmProvider(env, resolved.model ?? undefined);
}
