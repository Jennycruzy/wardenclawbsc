/**
 * Crash-recovery reconciliation. On every start, before any new trade, the agent
 * must reconcile in-flight transactions against on-chain state so it never
 * duplicates a trade. This module is pure logic over an injected chain lookup;
 * the worker supplies the real RPC query.
 */

export interface PendingMandate {
  mandateId: string;
  /** Present once a tx was submitted; absent means never broadcast. */
  txHash?: string;
  status: "submitted" | "pending_build" | "unknown";
  /** Nonce used for the submitted tx, if any. */
  nonce?: number;
  /** What the mandate does. Lets recovery tell a confirmed fill whose local state
   *  was recorded from one that wasn't (an untracked position). */
  action?: "entry" | "scout" | "exit";
}

/**
 * Whether a confirmed fill's effect is already reflected in local state — an entry
 * has a tracked position, an exit removed it. When false for an entry/exit, the fill
 * landed on chain but the worker crashed before recording it, so the position is
 * untracked (no stop) and the book is wrong: that must go to manual review, not clear.
 */
export type RecordedCheck = (m: PendingMandate) => boolean;

export interface ChainTxState {
  found: boolean;
  confirmed: boolean;
  success?: boolean;
}

export type ChainTxLookup = (txHash: string) => Promise<ChainTxState>;

export interface RecoveryResolution {
  mandateId: string;
  resolution:
    | "confirmed_filled"
    | "confirmed_failed"
    | "needs_manual_review";
  detail: string;
}

export interface RecoveryReport {
  resolutions: RecoveryResolution[];
  duplicatesPrevented: number;
  /** True when at least one mandate needs human review before trading resumes. */
  requiresReview: boolean;
}

/**
 * Reconcile pending mandates. Submitted-but-unconfirmed txs are resolved by
 * querying the chain, never by blind re-submission. Re-used nonces flag a
 * potential duplicate and require review.
 */
export async function reconcile(
  pending: PendingMandate[],
  lookup: ChainTxLookup,
  isRecorded: RecordedCheck = () => true,
): Promise<RecoveryReport> {
  const resolutions: RecoveryResolution[] = [];
  let duplicatesPrevented = 0;
  let requiresReview = false;

  const seenNonces = new Set<number>();

  for (const m of pending) {
    if (!m.txHash) {
      // The pending marker is written before TWAK is called. A crash can therefore
      // happen after TWAK broadcast but before the CLI returns the hash. Absence of
      // a locally persisted hash is not proof that nothing was broadcast.
      requiresReview = true;
      resolutions.push({
        mandateId: m.mandateId,
        resolution: "needs_manual_review",
        detail: "pending mandate has no txHash; broadcast status is unknown — reconcile wallet nonce/balances before resuming",
      });
      continue;
    }

    if (m.nonce !== undefined) {
      if (seenNonces.has(m.nonce)) {
        duplicatesPrevented++;
        requiresReview = true;
        resolutions.push({
          mandateId: m.mandateId,
          resolution: "needs_manual_review",
          detail: `duplicate nonce ${m.nonce} across pending mandates`,
        });
        continue;
      }
      seenNonces.add(m.nonce);
    }

    const state = await lookup(m.txHash);
    if (state.found && state.confirmed && state.success) {
      // The tx filled on chain. Safe to clear only if its effect is already in local
      // state; an unrecorded entry/exit fill means an untracked position + wrong book.
      const effectRecorded = m.action !== undefined && isRecorded(m);
      if (!effectRecorded) {
        requiresReview = true;
        resolutions.push({
          mandateId: m.mandateId,
          resolution: "needs_manual_review",
          detail: `tx ${m.txHash} (${m.action ?? "unknown action"}) filled on chain but its local state commit cannot be proven — reconcile position/book before resuming`,
        });
      } else {
        resolutions.push({
          mandateId: m.mandateId,
          resolution: "confirmed_filled",
          detail: `tx ${m.txHash} confirmed and filled (${m.action ?? "unknown action"})`,
        });
      }
    } else if (state.found && state.confirmed && !state.success) {
      resolutions.push({
        mandateId: m.mandateId,
        resolution: "confirmed_failed",
        detail: `tx ${m.txHash} confirmed but reverted (success=false)`,
      });
    } else if (state.found && !state.confirmed) {
      requiresReview = true;
      resolutions.push({
        mandateId: m.mandateId,
        resolution: "needs_manual_review",
        detail: `tx ${m.txHash} seen but unconfirmed; wait, do not resubmit`,
      });
    } else {
      // A null receipt is ambiguous: the tx can still be pending, dropped from this
      // RPC's mempool, or temporarily unavailable. Never convert ambiguity into a
      // fresh submission because that can duplicate the trade.
      requiresReview = true;
      resolutions.push({
        mandateId: m.mandateId,
        resolution: "needs_manual_review",
        detail: `tx ${m.txHash} has no receipt; it may be pending/dropped or the RPC may be inconsistent — do not resubmit`,
      });
    }
  }

  return { resolutions, duplicatesPrevented, requiresReview };
}
