/**
 * Server-only data layer for the dashboard. Reads REAL artifacts produced by the
 * engine — mandate JSONL, audit JSONL, and hourly snapshots — from the monorepo
 * data/ directory. It never invents data: a missing file yields an empty result
 * and the UI renders an explicit empty state with instructions.
 */

import "server-only";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  parseMandate,
  replayMandate,
  type AuditEvent,
  type MandateReplay,
  type SignalMandate,
} from "@wardenclaw/core";

/** Walk up from cwd to find the monorepo root (where pnpm-workspace.yaml lives). */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const ROOT = findRepoRoot();
const AUDIT_DIR = join(ROOT, "data", "audit");

function listFiles(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .map((f) => join(dir, f));
}

function readJsonl<T>(path: string, parse: (o: unknown) => T): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => parse(JSON.parse(l)));
}

// ---- Mandates -------------------------------------------------------------

export function loadBscMandates(): SignalMandate[] {
  const files = listFiles(AUDIT_DIR, ".mandates.jsonl");
  const all: SignalMandate[] = [];
  for (const f of files) {
    for (const m of readJsonl(f, (o) => parseMandate(o))) {
      if (m.venue === "bsc") all.push(m);
    }
  }
  all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return all;
}

export function getBscMandate(id: string): SignalMandate | null {
  return loadBscMandates().find((m) => m.id === id) ?? null;
}

// ---- Audit events ---------------------------------------------------------

function loadAllAuditEvents(): AuditEvent[] {
  const files = listFiles(AUDIT_DIR, ".jsonl").filter((f) => !f.endsWith(".mandates.jsonl"));
  const events: AuditEvent[] = [];
  for (const f of files) {
    events.push(...readJsonl(f, (o) => o as AuditEvent));
  }
  return events;
}

export function getReplay(mandateId: string): MandateReplay | null {
  const events = loadAllAuditEvents();
  const mine = events.filter((e) => e.mandateId === mandateId);
  if (mine.length === 0) return null;
  // Replay over the file's own ordered events so the integrity check is meaningful.
  return replayMandate(mandateId, events);
}

// ---- Proof / derived stats ------------------------------------------------

export interface BscProofStats {
  total: number;
  approved: number;
  rejected: number;
  byRejectCode: Array<{ code: string; count: number }>;
  byFamily: Array<{ family: string; count: number }>;
  lastUpdated: string | null;
}

export function computeBscProof(mandates: SignalMandate[]): BscProofStats {
  const rejectCounts = new Map<string, number>();
  const familyCounts = new Map<string, number>();
  let approved = 0;
  let rejected = 0;
  for (const m of mandates) {
    if (m.risk.approved) approved++;
    else rejected++;
    for (const r of m.decision.rejectedReasons ?? []) rejectCounts.set(r, (rejectCounts.get(r) ?? 0) + 1);
    familyCounts.set(m.decision.signalFamily, (familyCounts.get(m.decision.signalFamily) ?? 0) + 1);
  }
  return {
    total: mandates.length,
    approved,
    rejected,
    byRejectCode: [...rejectCounts.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
    byFamily: [...familyCounts.entries()].map(([family, count]) => ({ family, count })),
    lastUpdated: mandates[0]?.createdAt ?? null,
  };
}

export interface HourlySnapshotRow {
  hourIso: string;
  valueUsd: number;
}

export function loadHourlySnapshots(): HourlySnapshotRow[] {
  const files = listFiles(AUDIT_DIR, ".snapshots.jsonl");
  const rows: HourlySnapshotRow[] = [];
  for (const f of files) {
    rows.push(...readJsonl(f, (o) => o as HourlySnapshotRow));
  }
  rows.sort((a, b) => (a.hourIso < b.hourIso ? -1 : 1));
  return rows;
}

// ---- Environment / mode readouts -----------------------------------------

export interface BscEnv {
  walletAddress: string | null;
  registrationTxHash: string | null;
  competitionContract: string;
  startingCapitalUsd: number;
  executionType: string;
  routerAllowed: string;
  twakConfigured: boolean;
  cmcConfigured: boolean;
  rpcConfigured: boolean;
}

export function readBscEnv(): BscEnv {
  return {
    walletAddress: process.env.TWAK_AGENT_WALLET ?? null,
    registrationTxHash: process.env.REGISTRATION_TX_HASH ?? null,
    competitionContract: process.env.COMPETITION_CONTRACT_ADDRESS ?? "0x212c61b9b72c95d95bf29cf032f5e5635629aed5",
    startingCapitalUsd: Number(process.env.STARTING_CAPITAL_USD ?? "40"),
    executionType: process.env.EXECUTION_TYPE ?? "spot_only",
    routerAllowed: process.env.ROUTER_ALLOWED ?? "pancakeswap",
    twakConfigured: Boolean(process.env.TWAK_CONFIG_PATH || process.env.TWAK_AGENT_WALLET),
    cmcConfigured: Boolean(process.env.CMC_API_KEY),
    rpcConfigured: Boolean(process.env.BSC_RPC_URLS),
  };
}
