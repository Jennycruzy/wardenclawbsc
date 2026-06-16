/**
 * Real TWAK executor backed by the official Trust Wallet CLI (`@trustwallet/cli`,
 * command `twak`). This is the concrete, self-custodial signer: it shells out to
 * the installed CLI, which signs locally with the agent wallet and submits the
 * transaction. The backend never holds the key.
 *
 * Requires (set on the machine, never committed):
 *   TWAK_ACCESS_ID, TWAK_HMAC_SECRET   — from portal.trustwallet.com (then `twak init`)
 *   TWAK_WALLET_PASSWORD               — for the agent wallet (or OS keychain)
 *   the `twak` binary on PATH          — `npm i -g @trustwallet/cli`
 *
 * It never fabricates a tx hash: a missing CLI, a non-zero exit, or unparseable
 * output all throw. Verified command surface (tw-agent-skills `skills/wallet`):
 *   twak wallet status --json
 *   twak swap <from> <to> --chain bsc --usd <amt> --slippage <pct> --json
 *   twak compete register --json
 *   twak x402 request <url> --max-payment <atomic> [--prefer-network bsc]
 *        [--prefer-asset <addr|name>] --yes --json   (references/x402.md)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EligibleAllowlist, type EligibleToken } from "@wardenclaw/core";
import type { RegistrationResult, TwakIntent, TwakReceipt, X402Receipt } from "./types.js";
import type { TwakExecutor } from "./executor.js";

const run = promisify(execFile);

export interface CliTwakOptions {
  /** Tradeable tokens, used to resolve a leg address back to its symbol. */
  tokens: EligibleToken[];
  /** Binary name/path (default "twak"). */
  bin?: string;
  /** Default chain key (BSC mainnet). */
  chain?: string;
}

export class TwakCliError extends Error {
  constructor(message: string, readonly stderr?: string) {
    super(message);
    this.name = "TwakCliError";
  }
}

function parseOutputAmount(output: unknown): number | undefined {
  if (typeof output !== "string") return undefined;
  const match = output.trim().match(/^([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? amount : undefined;
}

export class CliTwakExecutor implements TwakExecutor {
  readonly configured = true;
  private readonly bin: string;
  private readonly chain: string;
  private readonly bySymbol = new Map<string, EligibleToken>();
  private readonly byAddress = new Map<string, EligibleToken>();

  constructor(opts: CliTwakOptions) {
    this.bin = opts.bin ?? process.env.TWAK_BIN ?? "twak";
    this.chain = opts.chain ?? "bsc";
    for (const t of opts.tokens) {
      this.bySymbol.set(t.symbol.toLowerCase(), t);
      this.byAddress.set(t.bscContractAddress.toLowerCase(), t);
    }
  }

  private symbolFor(address: string): string {
    const t = this.byAddress.get(address.toLowerCase());
    if (!t) throw new TwakCliError(`no symbol known for ${address} — refuse to swap an unmapped contract`);
    return t.symbol;
  }

  private async json(args: string[]): Promise<Record<string, unknown>> {
    const env = { ...process.env };
    try {
      const { stdout } = await run(this.bin, args, { env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
      const text = stdout.trim();
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start === -1 || end === -1) throw new TwakCliError(`twak produced no JSON: ${text.slice(0, 200)}`);
      return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      if (e.code === "ENOENT") {
        throw new TwakCliError(
          `the 'twak' CLI is not installed or not on PATH. Run \`npm i -g @trustwallet/cli\` and \`twak init\`.`,
        );
      }
      throw new TwakCliError(`twak ${args[0]} failed: ${e.message}`, e.stderr);
    }
  }

  async resolveAgentWallet(): Promise<string> {
    const out = await this.json(["wallet", "status", "--json"]);
    const addr =
      (out.address as string) ??
      ((out.addresses as Record<string, string> | undefined)?.[this.chain]) ??
      (out.bsc as string);
    if (!addr) throw new TwakCliError("could not resolve agent wallet address from `twak wallet status`");
    return addr;
  }

  async signAndSubmit(intent: TwakIntent): Promise<TwakReceipt> {
    if (intent.executionType !== "spot_only" || intent.chainId !== 56 || intent.isNonSpot) {
      throw new TwakCliError("CliTwakExecutor refuses a non-spot / non-BSC intent (defense in depth)");
    }
    const from = this.symbolFor(intent.tokenInAddress);
    const to = this.symbolFor(intent.tokenOutAddress);
    const slippagePct = (intent.slippageBps / 100).toFixed(2);
    const args = [
      "swap",
      from,
      to,
      "--chain",
      this.chain,
      "--usd",
      intent.amountInUsd.toFixed(2),
      "--slippage",
      slippagePct,
      "--json",
    ];
    const out = await this.json(args);
    const txHash = (out.hash as string) ?? (out.txHash as string) ?? (out.transactionHash as string);
    if (!txHash) throw new TwakCliError("twak swap returned no transaction hash");
    const realizedOut =
      parseOutputAmount(out.output) ?? (typeof out.amountOut === "number" ? (out.amountOut as number) : undefined);
    return {
      txHash,
      twakReceiptId: (out.id as string) ?? undefined,
      status: realizedOut !== undefined ? "confirmed" : "submitted",
      realizedOut,
    };
  }

  async registerForCompetition(contractAddress: string): Promise<RegistrationResult> {
    const out = await this.json(["compete", "register", "--json"]);
    return {
      registered: Boolean(out.registered),
      contractAddress,
      agentWallet: (out.participant as string) ?? "",
      registrationTxHash: (out.hash as string) ?? undefined,
      detail: (out.explorer as string) ?? "registered via `twak compete register`",
    };
  }

  /**
   * Pay an x402 pay-per-request through the TWAK CLI — the self-custodial,
   * TWAK-native x402 path (settles via EIP-3009/Permit2 on the route TWAK picks;
   * `X402_PREFER_NETWORK` can pin BSC or Base). `maxAmount` is in atomic units of
   * the chosen asset (e.g. "10000" = 0.01 USDC at 6dp). Never fabricates a
   * receipt: an error envelope or a missing settlement id throws.
   */
  async payX402(req: { url: string; maxAmount: string; asset: string }): Promise<X402Receipt> {
    const args = ["x402", "request", req.url, "--max-payment", req.maxAmount, "--yes", "--json"];
    if (req.asset) args.push("--prefer-asset", req.asset);
    const preferNetwork = process.env.X402_PREFER_NETWORK;
    if (preferNetwork) args.push("--prefer-network", preferNetwork);

    const out = await this.json(args);
    if (out.error) {
      throw new TwakCliError(`twak x402 request failed (${(out.errorCode as string) ?? "ERROR"}): ${String(out.error)}`);
    }
    const settlement =
      (out.receipt as string) ??
      (out.settlement as string) ??
      (out.id as string) ??
      (out.txHash as string) ??
      (out.hash as string);
    if (!settlement) {
      throw new TwakCliError("twak x402 request returned no settlement/receipt id");
    }
    return {
      requestUrl: req.url,
      amount: String((out.amount as string | number | undefined) ?? req.maxAmount),
      asset: String((out.asset as string | undefined) ?? req.asset),
      payer: (out.payer as string) ?? (out.from as string) ?? "",
      recipient: (out.recipient as string) ?? (out.payTo as string) ?? (out.to as string) ?? "x402-endpoint",
      receipt: String(settlement),
      responseSummary: "twak x402 request",
      usedInDecision: true,
      timestamp: new Date().toISOString(),
    };
  }

  /** The address-keyed allowlist this executor enforces symbols against. */
  allowlist(): EligibleAllowlist {
    return new EligibleAllowlist([...this.byAddress.values()]);
  }
}
