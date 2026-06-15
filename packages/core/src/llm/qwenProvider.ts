/**
 * First-class Qwen (Alibaba Model Studio / DashScope) provider.
 *
 * Qwen exposes an OpenAI-compatible Chat Completions surface, so this is a thin
 * subclass of OpenAiProvider: identical request/response shape and the same
 * shared structured-generation + repair loop — only the defaults and the
 * provider name differ. No money path: like every provider it can only ever
 * return schema-validated JSON objects; the deterministic engine decides trades.
 *
 * Verified against Alibaba Cloud Model Studio official docs (Mar 2026):
 *   - Base URL (international/Singapore): https://dashscope-intl.aliyuncs.com/compatible-mode/v1
 *   - Base URL (China/Beijing):          https://dashscope.aliyuncs.com/compatible-mode/v1
 *   - Auth: `Authorization: Bearer <DASHSCOPE/QWEN key>` (handled by the parent).
 *   - Current international commercial models include qwen3-max, qwen-max,
 *     qwen3.5-plus, qwen-plus, qwen3.5-flash, qwen-flash, and qwen-turbo.
 *   - JSON mode supports `response_format: { type: "json_object" }`, but Alibaba
 *     requires the word "JSON" in a system or user message. `complete` enforces
 *     that requirement without changing the shared validation/repair loop.
 *
 * QWEN_BASE_URL also lets this target any OpenAI-compatible Qwen gateway (e.g. a
 * hackathon-provided endpoint serving `qwen*-plus`) without touching code.
 */

import { OpenAiProvider, type OpenAiProviderConfig } from "./openaiProvider.js";
import {
  LlmDisabledError,
  type LlmMessage,
  type LlmProviderName,
} from "./provider.js";

/** International (Singapore) OpenAI-compatible endpoint — the safe default. */
export const DASHSCOPE_INTL_BASE_URL =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
/** China (Beijing) OpenAI-compatible endpoint, for reference/override. */
export const DASHSCOPE_CN_BASE_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
/** A current, broadly-available commercial model — sane default. */
export const DEFAULT_QWEN_MODEL = "qwen-plus";

export interface QwenProviderConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  jsonMode?: boolean;
}

export class QwenProvider extends OpenAiProvider {
  override readonly name: LlmProviderName = "qwen";

  constructor(cfg: QwenProviderConfig) {
    if (!cfg.apiKey) {
      // Loud, never a silent fake — consistent with the other providers.
      throw new LlmDisabledError("QwenProvider requires QWEN_API_KEY");
    }
    const openAiCfg: OpenAiProviderConfig = {
      apiKey: cfg.apiKey,
      model: cfg.model ?? DEFAULT_QWEN_MODEL,
      baseUrl: cfg.baseUrl ?? DASHSCOPE_INTL_BASE_URL,
    };
    // Forward optional knobs only when set, so undefined never clobbers a default.
    if (cfg.maxTokens !== undefined) openAiCfg.maxTokens = cfg.maxTokens;
    if (cfg.jsonMode !== undefined) openAiCfg.jsonMode = cfg.jsonMode;
    super(openAiCfg);
  }

  protected override complete(
    messages: LlmMessage,
    temperature: number,
  ): Promise<string> {
    const hasJsonKeyword = /json/i.test(`${messages.system}\n${messages.user}`);
    return super.complete(
      hasJsonKeyword
        ? messages
        : {
            ...messages,
            system: `${messages.system}\nReturn a valid JSON object.`,
          },
      temperature,
    );
  }
}
