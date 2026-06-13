import { describe, it, expect } from "vitest";
import {
  initTrailingStop,
  updateTrailingStop,
  isStopBreached,
  exitReasonFor,
  serializeOpenPositions,
  parseOpenPositions,
  type TrailingStopConfig,
  type OpenPosition,
} from "../src/index.js";

const cfg: TrailingStopConfig = {
  stopAtrMultiple: 1.5,
  breakevenTriggerAtr: 1.0,
  trailAtrMultiple: 1.5,
  trailTightAtrMultiple: 1.0,
};

// entry 100, ATR 4% → initial stop 100*(1-1.5*0.04) = 94.
const init = () => initTrailingStop({ entryPrice: 100, atrPct: 0.04, realRoundTripBps: 140, config: cfg });

describe("trailing-stop ratchet", () => {
  it("sets the initial volatility stop below entry", () => {
    expect(init().stopPrice).toBeCloseTo(94, 6);
  });

  // (a) stop never widens.
  it("never widens the stop on a pullback", () => {
    let s = init();
    s = updateTrailingStop(s, { currentPrice: 109, config: cfg }); // run up
    const raised = s.stopPrice;
    s = updateTrailingStop(s, { currentPrice: 101, config: cfg }); // pull back
    expect(s.stopPrice).toBe(raised); // unchanged, never lowered
  });

  // (b) breakeven ratchet triggers at the configured ATR gain and includes fees.
  it("ratchets to breakeven+fees once gain clears the trigger", () => {
    let s = init();
    s = updateTrailingStop(s, { currentPrice: 104, config: cfg }); // +4% = 1.0 ATR → arms
    expect(s.breakevenArmed).toBe(true);
    // stop is at least entry + real round-trip fees (140bps): 100*1.014 = 101.4
    expect(s.stopPrice).toBeGreaterThanOrEqual(100 * 1.014 - 1e-9);
  });

  // (c) trail follows HWM at the configured multiple.
  it("trails the high-water mark at TRAIL_ATR_MULTIPLE", () => {
    let s = init();
    s = updateTrailingStop(s, { currentPrice: 120, config: cfg }); // HWM 120, armed
    // trail = 120*(1 - 1.5*0.04) = 120*0.94 = 112.8
    expect(s.highWaterMark).toBe(120);
    expect(s.stopPrice).toBeCloseTo(112.8, 6);
  });

  // (d) a +9% → reversal exits in profit, not at the entry stop.
  it("exits a +9% runner in profit after a reversal (both ledgers positive)", () => {
    let s = init();
    s = updateTrailingStop(s, { currentPrice: 109, config: cfg }); // HWM 109
    // trail = 109*0.94 = 102.46
    expect(s.stopPrice).toBeCloseTo(102.46, 6);
    // reversal to 102.4 breaches the trail
    expect(isStopBreached(s, 102.4)).toBe(true);
    expect(exitReasonFor(s)).toBe("EXIT_TRAIL_RATCHET");
    // exit ~+2.46% gross — comfortably above the 140bps real round-trip → wallet-positive
    expect((s.stopPrice - 100) / 100 * 10_000).toBeGreaterThan(140);
  });

  it("a pre-breakeven breach is a plain stop, not a trail exit", () => {
    const s = init();
    expect(isStopBreached(s, 93)).toBe(true);
    expect(exitReasonFor(s)).toBe("EXIT_STOP");
  });

  // tighten mode trails closer.
  it("tighten mode trails at the tight multiple", () => {
    let normal = init();
    let tight = init();
    normal = updateTrailingStop(normal, { currentPrice: 120, config: cfg });
    tight = updateTrailingStop(tight, { currentPrice: 120, tightMode: true, config: cfg });
    expect(tight.stopPrice).toBeGreaterThan(normal.stopPrice); // tighter = higher stop
    // tight trail = 120*(1 - 1.0*0.04) = 115.2
    expect(tight.stopPrice).toBeCloseTo(115.2, 6);
  });
});

describe("open-position persistence (restart restore)", () => {
  const position = (): OpenPosition => {
    let trail = init();
    trail = updateTrailingStop(trail, { currentPrice: 118, config: cfg });
    return {
      mandateId: "m-1",
      symbol: "CAKE",
      tokenInAddress: "0xusdt",
      tokenOutAddress: "0xcake",
      amountTokens: 12.34,
      notionalUsd: 20,
      openedAtIso: "2026-06-22T01:00:00Z",
      trail,
    };
  };

  // (e) restart mid-position restores HWM and stop exactly.
  it("round-trips HWM and stop through serialize/parse", () => {
    const p = position();
    const restored = parseOpenPositions(serializeOpenPositions([p]));
    expect(restored).toHaveLength(1);
    expect(restored[0]!.trail.highWaterMark).toBe(p.trail.highWaterMark);
    expect(restored[0]!.trail.stopPrice).toBe(p.trail.stopPrice);
    expect(restored[0]!.trail.breakevenArmed).toBe(p.trail.breakevenArmed);
  });

  it("throws loudly on corrupt persisted state (no silent blind restart)", () => {
    expect(() => parseOpenPositions('[{"mandateId":"x"}]')).toThrow();
    expect(() => parseOpenPositions("not json")).toThrow();
  });
});
