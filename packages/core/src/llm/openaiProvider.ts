/**
 * Real OpenAI Chat Completions client. Throws loudly when the key is missing.
 */

import { BaseLlmProvider, type LlmMessage, type LlmProviderName } from "./provider.js";

export interface OpenAiProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  /**
   * Send `response_format: { type: "json_object" }` to force JSON mode. Defaults
   * to true (matches OpenAI). Some OpenAI-compatible gateways reject the
   * parameter outright (HTTP 400); set false there — the shared repair loop and
   * `extractJson` still recover clean JSON from a plain completion.
   */
  jsonMode?: boolean;
}

export class OpenAiProvider extends BaseLlmProvider {
  readonly name: LlmProviderName = "openai";
  protected readonly cfg: Required<OpenAiProviderConfig>;

  constructor(cfg: OpenAiProviderConfig) {
    super();
    if (!cfg.apiKey) throw new Error("OpenAiProvider requires an apiKey");
    if (!cfg.model) throw new Error("OpenAiProvider requires a model");
    // Build explicitly so an undefined override never clobbers a default.
    this.cfg = {
      apiKey: cfg.apiKey,
      model: cfg.model,
      baseUrl: cfg.baseUrl ?? "https://api.openai.com/v1",
      maxTokens: cfg.maxTokens ?? 2048,
      jsonMode: cfg.jsonMode ?? true,
    };
  }

  protected async complete(messages: LlmMessage, temperature: number): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      max_tokens: this.cfg.maxTokens,
      temperature,
      messages: [
        { role: "system", content: messages.system },
        { role: "user", content: messages.user },
      ],
    };
    if (this.cfg.jsonMode) body.response_format = { type: "json_object" };
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${this.name} API error ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error(`${this.name} API returned no content`);
    return text;
  }
}
