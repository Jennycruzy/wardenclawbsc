import { describe, it, expect } from "vitest";
import {
  resolveRoleModel,
  createRoleProvider,
  ROLE_SPECS,
  QwenProvider,
  DisabledProvider,
  type LlmRole,
  type RoleRouterEnv,
} from "../src/llm/index.js";

const ALL_ROLES = Object.keys(ROLE_SPECS) as LlmRole[];

describe("per-role model routing", () => {
  it("resolves every role to a Qwen tier default when only QWEN_API_KEY is set", () => {
    const env: RoleRouterEnv = { LLM_PROVIDER: "qwen", QWEN_API_KEY: "q" };
    const byRole = Object.fromEntries(
      ALL_ROLES.map((r) => [r, resolveRoleModel(r, env)]),
    );
    for (const r of ALL_ROLES) {
      expect(byRole[r]!.provider).toBe("qwen");
      expect(byRole[r]!.source).toBe("provider-default");
    }
    // strongest model for the compiler, cheapest for the high-frequency roles
    expect(byRole.STRATEGY_COMPILER!.model).toBe("qwen-max");
    expect(byRole.NEWS_SENTIMENT!.model).toBe("qwen-turbo");
    expect(byRole.AUDIT_SUMMARY!.model).toBe("qwen-turbo");
    expect(byRole.POST_TRADE_REFLECTION!.model).toBe("qwen-plus");
    expect(byRole.STRATEGY_EXPLANATION!.model).toBe("qwen-plus");
  });

  it("honors a per-role *_MODEL override", () => {
    const env: RoleRouterEnv = {
      LLM_PROVIDER: "qwen",
      QWEN_API_KEY: "q",
      NEWS_SENTIMENT_MODEL: "qwen-flash",
      STRATEGY_COMPILER_MODEL: "qwen3-max",
    };
    const news = resolveRoleModel("NEWS_SENTIMENT", env);
    expect(news.model).toBe("qwen-flash");
    expect(news.source).toBe("role-override");
    expect(resolveRoleModel("STRATEGY_COMPILER", env).model).toBe("qwen3-max");
    // a role without an override still falls back to its tier default
    expect(resolveRoleModel("AUDIT_SUMMARY", env).source).toBe("provider-default");
  });

  it("uses the active provider's own tier defaults (openai)", () => {
    const env: RoleRouterEnv = { LLM_PROVIDER: "openai", OPENAI_API_KEY: "o" };
    expect(resolveRoleModel("STRATEGY_COMPILER", env).model).toBe("gpt-4o");
    expect(resolveRoleModel("AUDIT_SUMMARY", env).model).toBe("gpt-4o-mini");
  });

  it("reports disabled for every role with no keys", () => {
    for (const r of ALL_ROLES) {
      const res = resolveRoleModel(r, {});
      expect(res.provider).toBe("disabled");
      expect(res.model).toBeNull();
      expect(res.source).toBe("disabled");
    }
  });

  it("createRoleProvider builds the right client and degrades to disabled", () => {
    const p = createRoleProvider("STRATEGY_EXPLANATION", {
      LLM_PROVIDER: "qwen",
      QWEN_API_KEY: "q",
    });
    expect(p).toBeInstanceOf(QwenProvider);
    expect(p.name).toBe("qwen");
    expect(createRoleProvider("AUDIT_SUMMARY", {})).toBeInstanceOf(DisabledProvider);
  });
});
