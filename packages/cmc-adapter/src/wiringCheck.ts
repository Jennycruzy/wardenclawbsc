/**
 * CMC end-to-end wiring check — proves the CMC Pro key is plumbed through the
 * SAME client the agent uses, not merely present in env. Exercises each surface
 * the live pipeline depends on (quotes, volume, trending, Fear & Greed, symbol→contract
 * resolution) with one real call each, plus a no-spend x402 reachability probe.
 *
 * `fetchImpl` is injectable so tests drive the real response shapes without a
 * network; the script wires the global fetch.
 */

import { CmcClient, CmcApiError, type FetchLike } from "./client.js";

export interface SurfaceResult {
  surface: string;
  ok: boolean;
  status?: number;
  latencyMs: number;
  detail: string;
  /** A required surface failing flips the whole report to FAIL. */
  required: boolean;
}

export interface X402Probe {
  endpoint: string;
  /** null when not probed (e.g. no key). */
  reachable: boolean | null;
  detail: string;
}

export interface CmcWiringReport {
  keyPresent: boolean;
  keyPlaceholder: boolean;
  baseUrl: string;
  surfaces: SurfaceResult[];
  x402: X402Probe;
  pass: boolean;
  generatedAt: string;
}

const PLACEHOLDER_HINTS = [
  "your",
  "placeholder",
  "changeme",
  "change-me",
  "xxxx",
  "todo",
  "<",
  "example",
];

/** A key is a placeholder if it's empty, too short, or looks like a template. */
export function isPlaceholderKey(key: string | undefined): boolean {
  if (!key) return true;
  const k = key.trim().toLowerCase();
  if (k.length < 16) return true;
  return PLACEHOLDER_HINTS.some((h) => k.includes(h));
}

interface CheckOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Symbol used to exercise the contract-resolution surface. */
  resolveSymbol?: string;
}

export async function checkCmcWiring(opts: CheckOptions = {}): Promise<CmcWiringReport> {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const now = opts.now ?? (() => Date.now());
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const baseUrl = (env.CMC_API_URL ?? "https://pro-api.coinmarketcap.com").replace(/\/$/, "");
  const key = env.CMC_API_KEY;
  const keyPresent = !!key && key.trim().length > 0;
  const keyPlaceholder = isPlaceholderKey(key);
  const x402Endpoint = (env.CMC_X402_ENDPOINT ?? baseUrl).replace(/\/$/, "");

  if (!keyPresent || keyPlaceholder) {
    return {
      keyPresent,
      keyPlaceholder,
      baseUrl,
      surfaces: [],
      x402: { endpoint: x402Endpoint, reachable: null, detail: "not probed (no usable key)" },
      pass: false,
      generatedAt: new Date(now()).toISOString(),
    };
  }

  const client = new CmcClient({ apiKey: key, baseUrl, fetchImpl });

  const surfaces: SurfaceResult[] = [];
  const run = async (
    surface: string,
    required: boolean,
    fn: () => Promise<{ detail: string; status?: number }>,
  ): Promise<void> => {
    const t0 = now();
    try {
      const { detail, status } = await fn();
      surfaces.push({ surface, ok: true, status: status ?? 200, latencyMs: now() - t0, detail, required });
    } catch (err) {
      const status = err instanceof CmcApiError ? err.status : undefined;
      const unauthorized = status === 401 || status === 403 || status === 1006;
      const detail = unauthorized
        ? `UNAUTHORIZED on your plan (HTTP ${status}) — ${(err as Error).message}`
        : (err as Error).message;
      surfaces.push({ surface, ok: false, status, latencyMs: now() - t0, detail, required });
    }
  };

  await run("key_info", true, async () => {
    const info = await client.getKeyInfo();
    return { detail: `${Object.keys(info).length} key-info fields parsed` };
  });
  await run("quotes", true, async () => {
    const q = await client.getQuotes(["BNB"]);
    return { detail: `BNB $${q.data[0]?.priceUsd?.toFixed(2) ?? "?"}` };
  });
  await run("volume", true, async () => {
    const q = await client.getQuotes(["CAKE"]);
    const volume = q.data[0]?.volume24hUsd;
    if (!(typeof volume === "number" && volume > 0)) {
      throw new CmcApiError("CMC returned no positive CAKE 24h volume");
    }
    return { detail: `CAKE 24h volume $${volume.toFixed(0)}` };
  });
  await run("trending", true, async () => {
    const t = await client.getTrending(5);
    return { detail: `${t.data.length} trending tokens` };
  });
  await run("fear_greed", true, async () => {
    const fg = await client.getFearGreed();
    return { detail: `${fg.data.value} (${fg.data.classification})` };
  });
  await run("symbol_resolution", true, async () => {
    const sym = opts.resolveSymbol ?? "CAKE";
    await client.getMetadata([sym]);
    return { detail: `resolved ${sym} info payload` };
  });

  // x402 dry reachability: hit the x402 path with NO payment. A 402 challenge
  // (or a 200) proves the endpoint is wired without spending any USDC.
  let x402: X402Probe;
  try {
    const url = `${x402Endpoint}/x402/v3/cryptocurrency/quotes/latest?symbol=BNB&convert=USD`;
    const res = await fetchImpl(url);
    const reachable = res.status === 402 || res.ok;
    x402 = {
      endpoint: x402Endpoint,
      reachable,
      detail: res.status === 402 ? "402 challenge received (wired, no spend)" : `HTTP ${res.status}`,
    };
  } catch (err) {
    x402 = { endpoint: x402Endpoint, reachable: false, detail: (err as Error).message };
  }

  const pass = surfaces.filter((s) => s.required).every((s) => s.ok);
  return {
    keyPresent,
    keyPlaceholder,
    baseUrl,
    surfaces,
    x402,
    pass,
    generatedAt: new Date(now()).toISOString(),
  };
}

export const PREFLIGHT_CMC_START = "<!-- CMC_WIRING:START -->";
export const PREFLIGHT_CMC_END = "<!-- CMC_WIRING:END -->";

/** A markdown block for PREFLIGHT.md, shared by check:cmc and rehearsal:checklist. */
export function renderPreflightCmcBlock(report: CmcWiringReport | null): string {
  const lines: string[] = [PREFLIGHT_CMC_START, "", "### CMC key end-to-end wiring (`pnpm check:cmc`)", ""];
  if (!report) {
    lines.push("⬜ Not run yet — run `pnpm check:cmc` with a real `CMC_API_KEY` to prove the key is plumbed end to end.");
  } else if (!report.keyPresent) {
    lines.push(`✗ **FAIL** — CMC_API_KEY missing (checked ${report.generatedAt}). The agent is blind without it.`);
  } else if (report.keyPlaceholder) {
    lines.push(`✗ **FAIL** — CMC_API_KEY looks like a placeholder (checked ${report.generatedAt}).`);
  } else {
    lines.push(`${report.pass ? "✅ **PASS**" : "✗ **FAIL**"} — checked ${report.generatedAt} against ${report.baseUrl}.`, "");
    lines.push("| Surface | Result | Latency | Detail |", "|---|---|---|---|");
    for (const s of report.surfaces) {
      const tag = s.ok ? "OK" : s.required ? "FAIL" : "WARN";
      lines.push(`| ${s.surface} | ${tag} | ${s.latencyMs}ms | ${s.detail.replace(/\|/g, "\\|")} |`);
    }
    lines.push(`| x402 | reachable=${report.x402.reachable === null ? "n/a" : report.x402.reachable} | — | ${report.x402.detail} |`);
  }
  lines.push("", PREFLIGHT_CMC_END);
  return lines.join("\n");
}

/** Insert or replace the CMC block within an existing PREFLIGHT.md body. */
export function upsertPreflightCmcBlock(existing: string, block: string): string {
  const start = existing.indexOf(PREFLIGHT_CMC_START);
  const end = existing.indexOf(PREFLIGHT_CMC_END);
  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + PREFLIGHT_CMC_END.length);
    return `${before}${block}${after}`;
  }
  return `${existing.replace(/\s*$/, "")}\n\n${block}\n`;
}

/** Human-readable PASS/FAIL summary lines for the CLI and PREFLIGHT.md. */
export function renderWiringReport(report: CmcWiringReport): string[] {
  const lines: string[] = [];
  if (!report.keyPresent) {
    lines.push("✗ CMC_API_KEY is MISSING. The agent is blind without it.");
    return lines;
  }
  if (report.keyPlaceholder) {
    lines.push("✗ CMC_API_KEY looks like a placeholder. Set a real CMC Pro key.");
    return lines;
  }
  lines.push(`CMC base: ${report.baseUrl}`);
  for (const s of report.surfaces) {
    const tag = s.ok ? "OK  " : s.required ? "FAIL" : "WARN";
    lines.push(`  [${tag}] ${s.surface.padEnd(18)} ${s.latencyMs}ms  ${s.detail}`);
  }
  const x = report.x402;
  lines.push(`  [x402] reachable=${x.reachable === null ? "n/a" : x.reachable} — ${x.detail}`);
  lines.push(report.pass ? "✅ CMC WIRING: PASS" : "✗ CMC WIRING: FAIL (a required surface failed)");
  return lines;
}
