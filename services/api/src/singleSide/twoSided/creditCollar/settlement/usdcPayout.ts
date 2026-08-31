/**
 * USDC PAYOUT RAIL — the small, isolated module that moves ledger entries on-chain.
 *
 * Chain: Arbitrum USDC (HL accounts are EVM addresses, so the position-owner address IS the payout
 * address). Security posture (handoff §security): the hot wallet is separate and SMALL — a full
 * server compromise drains at most the float, bounded further by the per-day outflow cap enforced
 * in processPayoutLedger. The key arrives ONLY via env, is never logged, and live sends are
 * quadruple-gated: PAYOUT_MODE=arbitrum + key + RPC + PAYOUT_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY.
 *
 * Default mode is SIMULATED (paper lane): entries move through the full ledger state machine with
 * a deterministic fake tx hash and nothing touches a chain.
 */

import type { PayoutSender, PayoutSendResult } from "./payoutLedger";

const isEvmAddress = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);

/** Canonical (native) USDC on Arbitrum One. */
export const ARBITRUM_USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
export const USDC_DECIMALS = 6;

export type PayoutRailConfig =
  | { mode: "simulated"; dailyCapUsdc: number }
  | { mode: "arbitrum"; dailyCapUsdc: number; rpcUrl: string; hotWalletKey: string; usdcAddress: string };

export type PayoutRailParse = { ok: true; cfg: PayoutRailConfig } | { ok: false; error: string };

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * Parse the rail config from env, fail-closed: anything other than a COMPLETE, explicitly
 * confirmed arbitrum config is either simulated (the safe default) or a refusal — never a
 * silent downgrade of a requested live rail.
 */
export const parsePayoutRailFromEnv = (env: Record<string, string | undefined>): PayoutRailParse => {
  const dailyCapUsdc = num(env.PAYOUT_DAILY_CAP_USDC, 250);
  const mode = (env.PAYOUT_MODE ?? "simulated").toLowerCase();
  if (mode === "simulated") return { ok: true, cfg: { mode: "simulated", dailyCapUsdc } };
  if (mode !== "arbitrum") return { ok: false, error: `PAYOUT_MODE must be "simulated" or "arbitrum", got "${env.PAYOUT_MODE}"` };
  if (env.PAYOUT_LIVE_CONFIRM !== "I_UNDERSTAND_REAL_MONEY") {
    return { ok: false, error: "PAYOUT_MODE=arbitrum requires PAYOUT_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY" };
  }
  const hotWalletKey = env.PAYOUT_HOT_WALLET_KEY;
  if (!hotWalletKey || !/^(0x)?[0-9a-fA-F]{64}$/.test(hotWalletKey)) {
    return { ok: false, error: "PAYOUT_HOT_WALLET_KEY missing or not a 32-byte hex key" };
  }
  const rpcUrl = env.ARBITRUM_RPC_URL;
  if (!rpcUrl) return { ok: false, error: "ARBITRUM_RPC_URL missing" };
  const usdcAddress = env.PAYOUT_USDC_ADDRESS ?? ARBITRUM_USDC_ADDRESS;
  if (!isEvmAddress(usdcAddress)) return { ok: false, error: `PAYOUT_USDC_ADDRESS is not an address: ${usdcAddress}` };
  return { ok: true, cfg: { mode: "arbitrum", dailyCapUsdc, rpcUrl, hotWalletKey, usdcAddress } };
};

// ── Simulated sender (paper lane) ─────────────────────────────────────────────

export const simulatedPayoutSender = (): PayoutSender => ({
  kind: "simulated",
  send: async (toAddress, amountUsdc, idempotencyKey): Promise<PayoutSendResult> => {
    if (!isEvmAddress(toAddress)) return { ok: false, error: `not an address: ${toAddress}`, retriable: false };
    if (!(amountUsdc >= 0.01)) return { ok: false, error: `amount below one cent: $${amountUsdc}`, retriable: false };
    return { ok: true, txHash: `sim-${idempotencyKey}`, confirmed: true };
  }
});

// ── Arbitrum USDC sender (live rail) ──────────────────────────────────────────

/**
 * Real ERC-20 transfer on Arbitrum One via viem. Loaded lazily so paper-lane processes never touch
 * the chain stack. Failure semantics for the ledger: LOCAL pre-broadcast refusals (bad address,
 * bad amount) are retriable; anything that threw once a broadcast was possible is NOT — the tx may
 * be on chain, so the entry parks for manual verification (requeuePayout after checking).
 */
export const buildArbitrumUsdcSender = async (cfg: Extract<PayoutRailConfig, { mode: "arbitrum" }>): Promise<PayoutSender> => {
  const { createPublicClient, createWalletClient, http, erc20Abi, parseUnits } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { arbitrum } = await import("viem/chains");
  const account = privateKeyToAccount((cfg.hotWalletKey.startsWith("0x") ? cfg.hotWalletKey : `0x${cfg.hotWalletKey}`) as `0x${string}`);
  const wallet = createWalletClient({ account, chain: arbitrum, transport: http(cfg.rpcUrl) });
  const pub = createPublicClient({ chain: arbitrum, transport: http(cfg.rpcUrl) });
  return {
    kind: "arbitrum_usdc",
    send: async (toAddress, amountUsdc, _idempotencyKey): Promise<PayoutSendResult> => {
      if (!isEvmAddress(toAddress)) return { ok: false, error: `not an address: ${toAddress}`, retriable: false };
      if (!(amountUsdc >= 0.01)) return { ok: false, error: `amount below one cent: $${amountUsdc}`, retriable: false };
      let hash: `0x${string}`;
      try {
        hash = await wallet.writeContract({
          address: cfg.usdcAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: "transfer",
          args: [toAddress as `0x${string}`, parseUnits(amountUsdc.toFixed(USDC_DECIMALS), USDC_DECIMALS)]
        });
      } catch (e) {
        // Unknown whether the raw tx left the node — never auto-retry; verify on-chain first.
        return { ok: false, error: `transfer failed: ${(e as Error).message}`, retriable: false };
      }
      try {
        const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
        if (receipt.status !== "success") return { ok: false, error: `tx ${hash} reverted`, retriable: false };
        return { ok: true, txHash: hash, confirmed: true };
      } catch {
        // Broadcast succeeded, receipt pending — report paid-but-unconfirmed; a later pass/ops confirms.
        return { ok: true, txHash: hash, confirmed: false };
      }
    }
  };
};

/** Build the sender for a parsed config. Simulated needs nothing; arbitrum loads the chain stack. */
export const buildPayoutSender = async (cfg: PayoutRailConfig): Promise<PayoutSender> =>
  cfg.mode === "simulated" ? simulatedPayoutSender() : buildArbitrumUsdcSender(cfg);
