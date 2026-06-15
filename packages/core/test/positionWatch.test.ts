import { describe, it, expect } from "vitest";
import {
  evaluateWatchTick,
  initTrailingStop,
  updateTrailingStop,
  type TrailingStopConfig,
} from "../src/index.js";

const cfg: TrailingStopConfig = {
  stopAtrMultiple: 1.5,
  breakevenTriggerAtr: 1.0,
  trailAtrMultiple: 1.5,
  trailTightAtrMultiple: 1.0,
};

const trail = () => initTrailingStop({ entryPrice: 100, atrPct: 0.04, realRoundTripBps: 140, config: cfg });

const base = {
  config: cfg,
  stalenessLimitSeconds: 180,
  stalenessAction: "alert_only" as const,
};

describe("fast watch loop — tick decision", () => {
  it("fires an exit when a dump breaches the stop between decision cycles", () => {
    const r = evaluateWatchTick({ ...base, trail: trail(), price: { fresh: true, price: 92 } });
    expect(r.action).toBe("exit");
    expect(r.exit?.reason).toBe("EXIT_STOP");
    expect(r.exit?.currentPrice).toBe(92);
  });

  it("holds and ratchets the trail when price is fresh and above the stop", () => {
    const r = evaluateWatchTick({ ...base, trail: trail(), price: { fresh: true, price: 109 } });
    expect(r.action).toBe("hold");
    expect(r.updatedTrail?.highWaterMark).toBe(109);
    expect(r.updatedTrail?.stopPrice).toBeGreaterThan(94); // ratcheted up
  });

  it("catches a mid-cycle crash on a token that had run up (trail exit, in profit)", () => {
    // Run the trail up first (as the watch loop would across ticks), then crash.
    let t = trail();
    t = updateTrailingStop(t, { currentPrice: 120, config: cfg }); // HWM 120, stop 112.8
    const r = evaluateWatchTick({ ...base, trail: t, price: { fresh: true, price: 112 } });
    expect(r.action).toBe("exit");
    expect(r.exit?.reason).toBe("EXIT_TRAIL_RATCHET");
    expect(r.exit!.gainPct).toBeGreaterThan(0); // exits in profit, not at entry stop
  });

  it("fires a staleness alert when the price feed is blind past the limit", () => {
    const r = evaluateWatchTick({
      ...base,
      trail: trail(),
      price: { fresh: false, secondsSinceLastPrice: 200 },
    });
    expect(r.action).toBe("stale");
    expect(r.stale?.action).toBe("alert_only");
    expect(r.exit).toBeUndefined(); // never fly blind, but don't blind-exit either
  });

  it("holds through a brief price miss under the staleness limit", () => {
    const r = evaluateWatchTick({
      ...base,
      trail: trail(),
      price: { fresh: false, secondsSinceLastPrice: 60 },
    });
    expect(r.action).toBe("hold");
    expect(r.updatedTrail).toBeDefined();
  });

  it("honors a 'reduce' staleness action when configured", () => {
    const r = evaluateWatchTick({
      ...base,
      stalenessAction: "reduce",
      trail: trail(),
      price: { fresh: false, secondsSinceLastPrice: 300 },
    });
    expect(r.stale?.action).toBe("reduce");
  });

  it("tighten mode trails closer on the tick (defend/red)", () => {
    const normal = evaluateWatchTick({ ...base, trail: trail(), price: { fresh: true, price: 120 } });
    const tight = evaluateWatchTick({ ...base, tightMode: true, trail: trail(), price: { fresh: true, price: 120 } });
    expect(tight.updatedTrail!.stopPrice).toBeGreaterThan(normal.updatedTrail!.stopPrice);
  });

  it("forces a rotation-to-stables exit on a RED regime even when the stop is not breached", () => {
    // Price 109 is well above the stop — a normal tick would hold; the RED force-exit
    // rotates to stables anyway, at the current price.
    const r = evaluateWatchTick({
      ...base,
      trail: trail(),
      price: { fresh: true, price: 109 },
      forceExit: { reason: "EXIT_REGIME_RED" },
    });
    expect(r.action).toBe("exit");
    expect(r.exit?.reason).toBe("EXIT_REGIME_RED");
    expect(r.exit?.currentPrice).toBe(109);
  });

  it("never blind-exits on a forced rotation when the price feed is stale", () => {
    const r = evaluateWatchTick({
      ...base,
      trail: trail(),
      price: { fresh: false, secondsSinceLastPrice: 300 },
      forceExit: { reason: "EXIT_REGIME_RED" },
    });
    expect(r.action).toBe("stale");
    expect(r.exit).toBeUndefined();
  });
});
