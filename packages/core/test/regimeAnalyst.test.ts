import { describe, it, expect } from "vitest";
import {
  initRegimeState,
  rawRegime,
  evaluateRegime,
  serializeRegimeState,
  parseRegimeState,
  type RegimeConfig,
} from "../src/index.js";

const cfg: RegimeConfig = {
  redBenchmarkPct: -4,
  greenBenchmarkPct: 2,
  redFearGreed: 25,
  greenFearGreed: 60,
  redBreadth: 0.3,
  greenBreadth: 0.6,
  hysteresisChecks: 2,
};

const red = { benchmarkChange24hPct: -6, fearGreed: 15, breadthUpFraction: 0.1 };
const green = { benchmarkChange24hPct: 5, fearGreed: 75, breadthUpFraction: 0.8 };
const neutral = { benchmarkChange24hPct: 0, fearGreed: 45, breadthUpFraction: 0.45 };

describe("rawRegime — three-signal vote", () => {
  it("RED when all three signals are risk-off", () => {
    expect(rawRegime(red, cfg)).toEqual({ regime: "RED", score: -3 });
  });

  it("RED on two of three (the third neutral)", () => {
    const r = rawRegime({ benchmarkChange24hPct: -6, fearGreed: 45, breadthUpFraction: 0.1 }, cfg);
    expect(r).toEqual({ regime: "RED", score: -2 });
  });

  it("NEUTRAL when only one signal is risk-off", () => {
    const r = rawRegime({ benchmarkChange24hPct: -6, fearGreed: 45, breadthUpFraction: 0.45 }, cfg);
    expect(r.regime).toBe("NEUTRAL");
    expect(r.score).toBe(-1);
  });

  it("GREEN when all three are risk-on", () => {
    expect(rawRegime(green, cfg)).toEqual({ regime: "GREEN", score: 3 });
  });

  it("NEUTRAL when bullish and bearish signals offset", () => {
    const r = rawRegime({ benchmarkChange24hPct: 5, fearGreed: 15, breadthUpFraction: 0.45 }, cfg);
    expect(r.regime).toBe("NEUTRAL");
    expect(r.score).toBe(0);
  });
});

describe("evaluateRegime — hysteresis", () => {
  it("requires two consecutive RED reads to commit RED (reacts a cycle late, not on noise)", () => {
    const r1 = evaluateRegime(initRegimeState(), red, cfg);
    expect(r1.state.current).toBe("NEUTRAL");
    expect(r1.changed).toBe(false);
    expect(r1.blocksEntries).toBe(false);
    expect(r1.state.pendingCount).toBe(1);

    const r2 = evaluateRegime(r1.state, red, cfg);
    expect(r2.state.current).toBe("RED");
    expect(r2.changed).toBe(true);
    expect(r2.blocksEntries).toBe(true);
  });

  it("resets the pending counter when a disagreeing read interrupts the streak", () => {
    const r1 = evaluateRegime(initRegimeState(), red, cfg); // RED pending 1/2
    const r2 = evaluateRegime(r1.state, green, cfg); // GREEN interrupts → pending resets to GREEN 1/2
    expect(r2.state.current).toBe("NEUTRAL");
    expect(r2.state.pendingRaw).toBe("GREEN");
    expect(r2.state.pendingCount).toBe(1);
    const r3 = evaluateRegime(r2.state, green, cfg); // GREEN confirmed → commit GREEN
    expect(r3.state.current).toBe("GREEN");
    expect(r3.changed).toBe(true);
  });

  it("clears the pending counter when the raw read agrees with the committed regime", () => {
    const committed = evaluateRegime(
      evaluateRegime(initRegimeState(), red, cfg).state,
      red,
      cfg,
    ).state; // committed RED
    const r = evaluateRegime(committed, red, cfg);
    expect(r.state.current).toBe("RED");
    expect(r.state.pendingCount).toBe(0);
    expect(r.changed).toBe(false);
    expect(r.blocksEntries).toBe(true);
  });

  it("round-trips committed state through serialize/parse and throws loudly on corruption", () => {
    const committed = evaluateRegime(evaluateRegime(initRegimeState(), red, cfg).state, red, cfg).state;
    expect(parseRegimeState(serializeRegimeState(committed))).toEqual(committed);
    expect(() => parseRegimeState('{"current":"PURPLE"}')).toThrow();
    expect(() => parseRegimeState("nope")).toThrow();
  });

  it("a single NEUTRAL read never blocks entries", () => {
    const r = evaluateRegime(initRegimeState(), neutral, cfg);
    expect(r.state.current).toBe("NEUTRAL");
    expect(r.blocksEntries).toBe(false);
  });
});
