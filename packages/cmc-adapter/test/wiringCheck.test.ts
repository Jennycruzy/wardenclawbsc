import { describe, it, expect } from "vitest";
import {
  checkCmcWiring,
  isPlaceholderKey,
  renderPreflightCmcBlock,
  upsertPreflightCmcBlock,
  PREFLIGHT_CMC_START,
  type FetchLike,
} from "../src/index.js";

const GOOD_KEY = "abcdef0123456789abcdef0123456789"; // 32 chars, non-placeholder

/** Route a mocked CMC fetch by URL; per-surface status overridable. */
function mockFetch(overrides: Record<string, { ok: boolean; status: number; body?: unknown }> = {}): FetchLike {
  return (async (url: string) => {
    const pick = (key: string, body: unknown) => {
      const o = overrides[key];
      const status = o?.status ?? 200;
      const ok = o?.ok ?? true;
      return { ok, status, json: async () => (o && "body" in o ? o.body : body), text: async () => JSON.stringify(body) };
    };
    if (url.includes("/x402/")) return pick("x402", {});
    if (url.includes("/v1/key/info")) {
      return pick("key_info", { data: { plan: { credit_limit_monthly: 10000 } } });
    }
    if (url.includes("/v2/cryptocurrency/quotes/latest")) {
      const symbol = url.includes("symbol=CAKE") ? "CAKE" : "BNB";
      return pick(symbol === "CAKE" ? "volume" : "quotes", {
        data: {
          [symbol]: {
            quote: {
              USD: {
                price: symbol === "CAKE" ? 2.5 : 620.5,
                volume_24h: symbol === "CAKE" ? 10_000_000 : 500_000_000,
                last_updated: "2026-06-15T00:00:00Z",
              },
            },
          },
        },
      });
    }
    if (url.includes("/v1/cryptocurrency/trending/latest")) {
      return pick("trending", { data: [{ id: 1, symbol: "CAKE" }, { id: 2, symbol: "BNB" }] });
    }
    if (url.includes("/v3/fear-and-greed/latest")) {
      return pick("fear_greed", { data: { value: 55, value_classification: "Greed", update_time: "2026-06-15T00:00:00Z" } });
    }
    if (url.includes("/v2/cryptocurrency/info")) {
      return pick("info", { data: { CAKE: { id: 7186, symbol: "CAKE", platform: { name: "BNB Smart Chain" } } } });
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
  }) as unknown as FetchLike;
}

describe("isPlaceholderKey", () => {
  it("flags empty, short, and template-looking keys", () => {
    expect(isPlaceholderKey(undefined)).toBe(true);
    expect(isPlaceholderKey("")).toBe(true);
    expect(isPlaceholderKey("short")).toBe(true);
    expect(isPlaceholderKey("your_cmc_api_key_here")).toBe(true);
    expect(isPlaceholderKey("<set-me-please-now>")).toBe(true);
    expect(isPlaceholderKey(GOOD_KEY)).toBe(false);
  });
});

describe("checkCmcWiring", () => {
  it("fails loudly on a missing key (no network)", async () => {
    const r = await checkCmcWiring({ env: {}, fetchImpl: mockFetch() });
    expect(r.keyPresent).toBe(false);
    expect(r.pass).toBe(false);
    expect(r.surfaces).toHaveLength(0);
  });

  it("fails loudly on a placeholder key", async () => {
    const r = await checkCmcWiring({ env: { CMC_API_KEY: "your_key_here_xxxx" }, fetchImpl: mockFetch() });
    expect(r.keyPlaceholder).toBe(true);
    expect(r.pass).toBe(false);
  });

  it("parses a mocked 200 across every surface and PASSES", async () => {
    const r = await checkCmcWiring({
      env: { CMC_API_KEY: GOOD_KEY },
      fetchImpl: mockFetch({ x402: { ok: false, status: 402 } }),
      now: (() => {
        let t = 1000;
        return () => (t += 10);
      })(),
    });
    expect(r.pass).toBe(true);
    const byName = Object.fromEntries(r.surfaces.map((s) => [s.surface, s]));
    expect(byName.quotes!.ok).toBe(true);
    expect(byName.key_info!.ok).toBe(true);
    expect(byName.volume!.ok).toBe(true);
    expect(byName.trending!.ok).toBe(true);
    expect(byName.fear_greed!.ok).toBe(true);
    expect(byName.symbol_resolution!.ok).toBe(true);
    expect(r.surfaces.every((s) => s.latencyMs >= 0)).toBe(true);
    // x402: 402 challenge counts as reachable with no spend
    expect(r.x402.reachable).toBe(true);
    expect(r.x402.detail).toContain("402");
  });

  it("reports a per-surface failure when a required endpoint returns 401", async () => {
    const r = await checkCmcWiring({
      env: { CMC_API_KEY: GOOD_KEY },
      fetchImpl: mockFetch({ info: { ok: false, status: 401 }, x402: { ok: false, status: 402 } }),
    });
    const info = r.surfaces.find((s) => s.surface === "symbol_resolution")!;
    expect(info.ok).toBe(false);
    expect(info.status).toBe(401);
    expect(info.detail).toContain("UNAUTHORIZED");
    // a required surface failing flips the whole report to FAIL
    expect(r.pass).toBe(false);
    // but a healthy required surface still reports OK
    expect(r.surfaces.find((s) => s.surface === "quotes")!.ok).toBe(true);
  });

  it("a strategy surface 401 fails the report and names the plan problem", async () => {
    const r = await checkCmcWiring({
      env: { CMC_API_KEY: GOOD_KEY },
      fetchImpl: mockFetch({ trending: { ok: false, status: 401 }, x402: { ok: false, status: 402 } }),
    });
    expect(r.surfaces.find((s) => s.surface === "trending")!.ok).toBe(false);
    expect(r.surfaces.find((s) => s.surface === "trending")!.detail).toContain("UNAUTHORIZED");
    expect(r.pass).toBe(false);
  });
});

describe("PREFLIGHT block rendering", () => {
  it("renders a not-run block and upserts idempotently", () => {
    const block = renderPreflightCmcBlock(null);
    expect(block).toContain("Not run yet");
    const base = "# PREFLIGHT\n\nsome content\n";
    const once = upsertPreflightCmcBlock(base, block);
    expect(once).toContain(PREFLIGHT_CMC_START);
    // upserting again replaces rather than duplicating
    const twice = upsertPreflightCmcBlock(once, renderPreflightCmcBlock(null));
    expect(twice.match(new RegExp(PREFLIGHT_CMC_START, "g"))?.length).toBe(1);
  });
});
