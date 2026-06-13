import { describe, it, expect } from "vitest";
import {
  chooseX402Path,
  x402BlocksTrade,
  x402PathLabel,
  payX402InLoop,
  isReceiptComplete,
  type TwakExecutor,
  type X402Receipt,
} from "../src/index.js";

describe("x402 path selection (TWAK-first)", () => {
  it("selects TWAK whenever a live signer is configured", () => {
    expect(chooseX402Path({ twakConfigured: true, fallbackViemEnabled: false, viemKeyPresent: false })).toBe("twak");
    // TWAK wins even if the viem fallback is also available.
    expect(chooseX402Path({ twakConfigured: true, fallbackViemEnabled: true, viemKeyPresent: true })).toBe("twak");
  });

  it("uses the viem fallback ONLY behind the flag with a key present", () => {
    expect(chooseX402Path({ twakConfigured: false, fallbackViemEnabled: true, viemKeyPresent: true })).toBe("viem_fallback");
    expect(chooseX402Path({ twakConfigured: false, fallbackViemEnabled: false, viemKeyPresent: true })).toBe("none");
    expect(chooseX402Path({ twakConfigured: false, fallbackViemEnabled: true, viemKeyPresent: false })).toBe("none");
  });

  it("labels the viem fallback as non-TWAK, never as TWAK x402", () => {
    expect(x402PathLabel("twak")).toBe("twak");
    expect(x402PathLabel("viem_fallback")).toContain("non-TWAK");
  });

  it("blocks the dependent trade when x402 is required but no path exists", () => {
    expect(x402BlocksTrade("none", true)).toBe(true);
    expect(x402BlocksTrade("none", false)).toBe(false);
    expect(x402BlocksTrade("twak", true)).toBe(false);
  });
});

describe("payX402InLoop", () => {
  const fakeExecutor = (receipt: Partial<X402Receipt>): TwakExecutor => ({
    configured: true,
    resolveAgentWallet: async () => "0xwallet",
    signAndSubmit: async () => {
      throw new Error("not used");
    },
    registerForCompetition: async () => ({ registered: true, contractAddress: "0x", agentWallet: "0xwallet", detail: "test" }),
    payX402: async () => ({
      requestUrl: "https://api.example.com/data",
      amount: "10000",
      asset: "USDC",
      payer: "0xwallet",
      recipient: "0xseller",
      receipt: "settle-1",
      responseSummary: "ok",
      usedInDecision: false,
      timestamp: "2026-06-22T00:00:00Z",
      ...receipt,
    }),
  });

  it("tags the receipt as used-in-decision and carries the mandate id", async () => {
    const r = await payX402InLoop(fakeExecutor({}), {
      url: "https://api.example.com/data",
      maxAmount: "10000",
      asset: "USDC",
      mandateId: "m-1",
    });
    expect(r.usedInDecision).toBe(true);
    expect(r.mandateId).toBe("m-1");
    expect(isReceiptComplete(r)).toBe(true);
  });
});
