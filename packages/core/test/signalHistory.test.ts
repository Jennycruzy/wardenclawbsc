import { describe, it, expect } from "vitest";
import {
  appendObservation,
  recentObservations,
  serializeSignalHistory,
  parseSignalHistory,
  type SignalObservation,
  type TokenHistory,
} from "../src/index.js";

function obs(i: number): SignalObservation {
  return {
    checkIso: `2026-06-13T00:0${i % 10}:00Z`,
    price: 1 + i / 100,
    volume24hUsd: 1_000_000 + i,
    change24hPct: i,
  };
}

describe("signalHistory", () => {
  it("appends chronologically and caps at maxLen, dropping the oldest", () => {
    let h: TokenHistory = { symbol: "CAKE", observations: [] };
    for (let i = 0; i < 25; i++) h = appendObservation(h, obs(i), 20);
    expect(h.observations).toHaveLength(20);
    // Oldest five (0..4) dropped; window starts at 5 and ends at 24.
    expect(h.observations[0]!.change24hPct).toBe(5);
    expect(h.observations[19]!.change24hPct).toBe(24);
  });

  it("does not mutate the input history (pure append)", () => {
    const h: TokenHistory = { symbol: "CAKE", observations: [obs(0)] };
    const next = appendObservation(h, obs(1));
    expect(h.observations).toHaveLength(1);
    expect(next.observations).toHaveLength(2);
  });

  it("recentObservations returns the last n chronological observations", () => {
    let h: TokenHistory = { symbol: "CAKE", observations: [] };
    for (let i = 0; i < 5; i++) h = appendObservation(h, obs(i));
    const last2 = recentObservations(h, 2);
    expect(last2.map((o) => o.change24hPct)).toEqual([3, 4]);
  });

  it("round-trips through serialize/parse preserving optional fields", () => {
    const histories: TokenHistory[] = [
      {
        symbol: "CAKE",
        observations: [
          { ...obs(1), benchmarkChange24hPct: 1.2, trendingRank: 8 },
          { ...obs(2), benchmarkChange24hPct: 1.5 },
        ],
      },
    ];
    const restored = parseSignalHistory(serializeSignalHistory(histories));
    expect(restored).toEqual(histories);
    expect(restored[0]!.observations[0]!.trendingRank).toBe(8);
    expect(restored[0]!.observations[1]!.trendingRank).toBeUndefined();
  });

  it("throws loudly on corrupted persisted history (no fake state)", () => {
    expect(() => parseSignalHistory('[{"symbol":"CAKE"}]')).toThrow();
    expect(() => parseSignalHistory("not json")).toThrow();
  });
});
