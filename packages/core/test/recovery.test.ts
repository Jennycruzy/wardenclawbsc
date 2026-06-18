import { describe, it, expect } from "vitest";
import { reconcile, type PendingMandate, type ChainTxState } from "../src/recovery.js";

const confirmed: ChainTxState = { found: true, confirmed: true, success: true };
const reverted: ChainTxState = { found: true, confirmed: true, success: false };
const seenUnconfirmed: ChainTxState = { found: true, confirmed: false };
const notFound: ChainTxState = { found: false, confirmed: false };

const lookupAll = (state: ChainTxState) => async () => state;

describe("reconcile", () => {
  it("halts on a pending-build marker with no hash because broadcast is ambiguous", async () => {
    const r = await reconcile([{ mandateId: "a", status: "pending_build" }], lookupAll(notFound));
    expect(r.resolutions[0]!.resolution).toBe("needs_manual_review");
    expect(r.requiresReview).toBe(true);
  });

  it("flags a duplicate nonce for manual review", async () => {
    const pending: PendingMandate[] = [
      { mandateId: "a", txHash: "0x1", status: "submitted", nonce: 7 },
      { mandateId: "b", txHash: "0x2", status: "submitted", nonce: 7 },
    ];
    const r = await reconcile(pending, lookupAll(confirmed));
    expect(r.duplicatesPrevented).toBe(1);
    expect(r.requiresReview).toBe(true);
  });

  it("resolves a confirmed scout fill cleanly (no tracked position to lose)", async () => {
    const r = await reconcile([{ mandateId: "s", txHash: "0x1", status: "submitted", action: "scout" }], lookupAll(confirmed));
    expect(r.resolutions[0]!.resolution).toBe("confirmed_filled");
    expect(r.requiresReview).toBe(false);
  });

  it("resolves a confirmed entry cleanly when its position is recorded", async () => {
    const r = await reconcile(
      [{ mandateId: "e", txHash: "0x1", status: "submitted", action: "entry" }],
      lookupAll(confirmed),
      (m) => m.mandateId === "e", // position present
    );
    expect(r.resolutions[0]!.resolution).toBe("confirmed_filled");
    expect(r.requiresReview).toBe(false);
  });

  it("escalates a confirmed ENTRY fill with no recorded position (untracked position)", async () => {
    const r = await reconcile(
      [{ mandateId: "e", txHash: "0x1", status: "submitted", action: "entry" }],
      lookupAll(confirmed),
      () => false, // no position on disk
    );
    expect(r.resolutions[0]!.resolution).toBe("needs_manual_review");
    expect(r.requiresReview).toBe(true);
  });

  it("escalates a confirmed EXIT fill whose position is still open (phantom position)", async () => {
    const r = await reconcile(
      [{ mandateId: "x-exit", txHash: "0x1", status: "submitted", action: "exit" }],
      lookupAll(confirmed),
      () => false, // exit not reflected → position still present
    );
    expect(r.resolutions[0]!.resolution).toBe("needs_manual_review");
    expect(r.requiresReview).toBe(true);
  });

  it("escalates a confirmed scout whose book commit cannot be proven", async () => {
    const r = await reconcile(
      [{ mandateId: "s", txHash: "0x1", status: "submitted", action: "scout" }],
      lookupAll(confirmed),
      () => false,
    );
    expect(r.resolutions[0]!.resolution).toBe("needs_manual_review");
    expect(r.requiresReview).toBe(true);
  });

  it("escalates a legacy confirmed fill with no action metadata", async () => {
    const r = await reconcile([{ mandateId: "legacy", txHash: "0x1", status: "submitted" }], lookupAll(confirmed));
    expect(r.resolutions[0]!.resolution).toBe("needs_manual_review");
    expect(r.requiresReview).toBe(true);
  });

  it("marks a reverted tx as confirmed_failed without review", async () => {
    const r = await reconcile([{ mandateId: "a", txHash: "0x1", status: "submitted", action: "entry" }], lookupAll(reverted));
    expect(r.resolutions[0]!.resolution).toBe("confirmed_failed");
    expect(r.requiresReview).toBe(false);
  });

  it("holds a seen-but-unconfirmed tx for review (never resubmit)", async () => {
    const r = await reconcile([{ mandateId: "a", txHash: "0x1", status: "submitted" }], lookupAll(seenUnconfirmed));
    expect(r.resolutions[0]!.resolution).toBe("needs_manual_review");
    expect(r.requiresReview).toBe(true);
  });

  it("halts when a submitted tx has no receipt instead of risking a duplicate", async () => {
    const r = await reconcile([{ mandateId: "a", txHash: "0x1", status: "submitted", action: "entry" }], lookupAll(notFound));
    expect(r.resolutions[0]!.resolution).toBe("needs_manual_review");
    expect(r.requiresReview).toBe(true);
  });
});
