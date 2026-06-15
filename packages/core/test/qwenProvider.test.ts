import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createLlmProvider,
  selectProvider,
  QwenProvider,
  OpenAiProvider,
  DisabledProvider,
  LlmDisabledError,
  DASHSCOPE_INTL_BASE_URL,
  DEFAULT_QWEN_MODEL,
  type LlmFactoryEnv,
} from "../src/llm/index.js";
import { z } from "zod";

describe("Qwen provider selection", () => {
  it("picks qwen on explicit LLM_PROVIDER=qwen", () => {
    const sel = selectProvider({ LLM_PROVIDER: "qwen" });
    expect(sel.name).toBe("qwen");
    expect(sel.enabled).toBe(true);
  });

  it("falls back to qwen after openai when only QWEN_API_KEY is set", () => {
    expect(selectProvider({ QWEN_API_KEY: "q" }).name).toBe("qwen");
    // openai key still wins over qwen by precedence
    expect(selectProvider({ OPENAI_API_KEY: "o", QWEN_API_KEY: "q" }).name).toBe("openai");
    // anthropic still wins over both
    expect(selectProvider({ ANTHROPIC_API_KEY: "a", QWEN_API_KEY: "q" }).name).toBe("anthropic");
  });

  it("builds a QwenProvider with DashScope defaults", () => {
    const env: LlmFactoryEnv = { LLM_PROVIDER: "qwen", QWEN_API_KEY: "q-test" };
    const p = createLlmProvider(env) as QwenProvider;
    expect(p).toBeInstanceOf(QwenProvider);
    // a QwenProvider IS-A OpenAiProvider (reuses the completion logic)
    expect(p).toBeInstanceOf(OpenAiProvider);
    expect(p.name).toBe("qwen");
    const cfg = (p as unknown as { cfg: { baseUrl: string; model: string } }).cfg;
    expect(cfg.baseUrl).toBe(DASHSCOPE_INTL_BASE_URL);
    expect(cfg.model).toBe(DEFAULT_QWEN_MODEL);
  });

  it("honors QWEN_BASE_URL / QWEN_MODEL overrides (e.g. a hackathon gateway)", () => {
    const p = createLlmProvider({
      LLM_PROVIDER: "qwen",
      QWEN_API_KEY: "q",
      QWEN_BASE_URL: "https://hackathon.example.com/v1",
      QWEN_MODEL: "qwen3.6-plus",
    }) as QwenProvider;
    const cfg = (p as unknown as { cfg: { baseUrl: string; model: string } }).cfg;
    expect(cfg.baseUrl).toBe("https://hackathon.example.com/v1");
    expect(cfg.model).toBe("qwen3.6-plus");
  });

  it("degrades to disabled when LLM_PROVIDER=qwen but no key", () => {
    const p = createLlmProvider({ LLM_PROVIDER: "qwen" });
    expect(p).toBeInstanceOf(DisabledProvider);
  });

  it("throws loudly when constructed without a key (never a silent fake)", () => {
    expect(() => new QwenProvider({ apiKey: "" })).toThrow(LlmDisabledError);
  });
});

describe("Qwen structured generation (mocked HTTP)", () => {
  const schema = z.object({ ok: z.boolean(), venue: z.string() });

  afterEach(() => vi.restoreAllMocks());

  function mockFetchOnce(body: string) {
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: body } }] }),
      text: async () => body,
    }));
  }

  it("flows a Qwen HTTP response through generateStructured + schema validation", async () => {
    const fetchMock = mockFetchOnce('{"ok": true, "venue": "bsc"}');
    vi.stubGlobal("fetch", fetchMock);
    const p = new QwenProvider({ apiKey: "q" });
    const out = await p.generateStructured({ system: "s", user: "u", schema });
    expect(out).toEqual({ ok: true, venue: "bsc" });
    // hit the DashScope-compatible chat/completions endpoint with bearer auth
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DASHSCOPE_INTL_BASE_URL}/chat/completions`);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer q");
    const request = JSON.parse(init.body as string) as {
      response_format?: { type?: string };
      messages: Array<{ content: string }>;
    };
    expect(request.response_format).toEqual({ type: "json_object" });
    expect(request.messages.some((message) => /json/i.test(message.content))).toBe(true);
  });

  it("repairs once exactly like OpenAI when the first reply is not JSON", async () => {
    const replies = ["not json at all", '{"ok": true, "venue": "fixed"}'];
    let i = 0;
    const fetchMock = vi.fn(async () => {
      const body = replies[Math.min(i++, replies.length - 1)];
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: body } }] }),
        text: async () => body!,
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const p = new QwenProvider({ apiKey: "q" });
    const out = await p.generateStructured({ system: "s", user: "u", schema });
    expect(out.venue).toBe("fixed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
