/**
 * Pre-fire per-venue balance guard (Phase C).
 *
 * Before a LIVE (non-shadow) activation places real orders, verify the venue(s)
 * we're about to route to actually have enough available balance to pay the
 * option premium. WHY: without this, an underfunded venue produces a HALF-FILLED
 * strangle — one leg fills, the other rejects on "insufficient funds", and the
 * filled leg has to be reverse-sold (cost + slippage) or, worse, leaves a
 * directional dangling position. Checking balance first turns a messy partial-fill
 * recovery into a clean, pre-trade 503.
 *
 * Units:
 *   - Bullish option premium is paid in USDC → compare against USDC available.
 *   - Deribit option premium is paid in BTC → we read BTC available and convert
 *     to USDC at the live spot to compare against the (USDC-denominated) leg cost.
 *
 * Failure policy (read error / null balance):
 *   - Default FAIL-OPEN (allow + warn): a transient venue balance-read hiccup
 *     should not halt all live trading. The execution path still fails safely
 *     (partial-fill reverse) if funds truly are short.
 *   - Set SS_TWO_SIDED_BALANCE_GUARD_FAIL_CLOSED=true to FAIL-CLOSED (block on any
 *     unreadable balance) for a maximally-conservative posture.
 *
 * Gating: only consulted on the LIVE activation path (FOXIFY_V2_LIVE_EXECUTION=true
 * and isShadow!==true). Shadow fires never touch this.
 */

import type { Venue } from "./types";

export type VenueBalanceReader = {
  /** Available USDC on Bullish (spendable on option premium). null ⇒ read failed/unavailable. */
  getBullishAvailableUsdc?: () => Promise<number | null>;
  /** Available BTC on Deribit (option premium is debited in BTC). null ⇒ read failed/unavailable. */
  getDeribitAvailableBtc?: () => Promise<number | null>;
};

export type VenueBalanceCheckInput = {
  putVenue: Venue;
  putCostUsdc: number;
  callVenue: Venue;
  callCostUsdc: number;
  /** USDC per BTC — converts Deribit's BTC balance to USDC for comparison. */
  spot: number;
};

export type VenueBalanceCheckResult =
  | { ok: true; details: Record<string, unknown> }
  | { ok: false; reason: "insufficient_venue_balance" | "balance_read_failed"; details: Record<string, unknown> };

export type VenueBalanceGuardConfig = {
  /** Fractional headroom required above the bare premium (default 0.10 = need 110% of cost). */
  headroomPct: number;
  /** Block when a balance can't be read (default false ⇒ fail-open + warn). */
  failClosed: boolean;
};

export const getBalanceGuardConfig = (env: NodeJS.ProcessEnv = process.env): VenueBalanceGuardConfig => {
  const hp = Number(env.SS_TWO_SIDED_BALANCE_HEADROOM_PCT ?? "0.10");
  return {
    headroomPct: Number.isFinite(hp) && hp >= 0 ? hp : 0.10,
    failClosed: String(env.SS_TWO_SIDED_BALANCE_GUARD_FAIL_CLOSED ?? "false").toLowerCase() === "true"
  };
};

/** Master enable switch (default ON). Only ever consulted on the live path. */
export const isBalanceGuardEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  String(env.SS_TWO_SIDED_BALANCE_GUARD ?? "true").toLowerCase() !== "false";

/**
 * Aggregate the required USDC per venue, read available balances, and compare with
 * headroom. Pure w.r.t. the injected reader — fully unit-testable with a mock reader.
 */
export const checkVenueBalances = async (
  reader: VenueBalanceReader,
  input: VenueBalanceCheckInput,
  cfg: VenueBalanceGuardConfig = getBalanceGuardConfig()
): Promise<VenueBalanceCheckResult> => {
  // Required premium per venue (sum the legs that route there).
  let bullishReqUsdc = 0;
  let deribitReqUsdc = 0;
  if (input.putVenue === "bullish") bullishReqUsdc += input.putCostUsdc;
  else deribitReqUsdc += input.putCostUsdc;
  if (input.callVenue === "bullish") bullishReqUsdc += input.callCostUsdc;
  else deribitReqUsdc += input.callCostUsdc;

  const mult = 1 + Math.max(0, cfg.headroomPct);
  const details: Record<string, unknown> = {
    headroom_pct: cfg.headroomPct,
    fail_closed: cfg.failClosed,
    bullish_required_usdc: +bullishReqUsdc.toFixed(2),
    deribit_required_usdc: +deribitReqUsdc.toFixed(2),
    spot: input.spot
  };

  // ── Bullish (USDC) ──
  if (bullishReqUsdc > 0) {
    const avail = reader.getBullishAvailableUsdc ? await safeRead(reader.getBullishAvailableUsdc) : null;
    details.bullish_available_usdc = avail;
    const needed = +(bullishReqUsdc * mult).toFixed(2);
    details.bullish_needed_usdc = needed;
    if (avail == null) {
      if (cfg.failClosed) return { ok: false, reason: "balance_read_failed", details: { ...details, venue: "bullish" } };
    } else if (avail < needed) {
      return { ok: false, reason: "insufficient_venue_balance", details: { ...details, venue: "bullish", shortfall_usdc: +(needed - avail).toFixed(2) } };
    }
  }

  // ── Deribit (BTC → USDC at spot) ──
  if (deribitReqUsdc > 0) {
    const availBtc = reader.getDeribitAvailableBtc ? await safeRead(reader.getDeribitAvailableBtc) : null;
    const availUsdc = availBtc != null && input.spot > 0 ? availBtc * input.spot : null;
    details.deribit_available_btc = availBtc;
    details.deribit_available_usdc = availUsdc != null ? +availUsdc.toFixed(2) : null;
    const needed = +(deribitReqUsdc * mult).toFixed(2);
    details.deribit_needed_usdc = needed;
    if (availUsdc == null) {
      if (cfg.failClosed) return { ok: false, reason: "balance_read_failed", details: { ...details, venue: "deribit" } };
    } else if (availUsdc < needed) {
      return { ok: false, reason: "insufficient_venue_balance", details: { ...details, venue: "deribit", shortfall_usdc: +(needed - availUsdc).toFixed(2) } };
    }
  }

  return { ok: true, details };
};

/** Read a balance, swallowing errors to null (treated as "unreadable"). */
const safeRead = async (fn: () => Promise<number | null>): Promise<number | null> => {
  try {
    const v = await fn();
    return Number.isFinite(v as number) ? (v as number) : null;
  } catch {
    return null;
  }
};
