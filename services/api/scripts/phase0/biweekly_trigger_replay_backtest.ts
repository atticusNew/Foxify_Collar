#!/usr/bin/env tsx
/**
 * Phase 0 Deliverable 2 — Trigger-replay backtest under biweekly hedge model.
 *
 * Pure analysis. Read-only. No DB, no auth, no production impact.
 *
 * Replays each of the 16 historical triggered protections under a
 * counterfactual biweekly hedge:
 *
 *   ACTIVATION TIME (row.createdAt):
 *     buy a 14-day BTC option at strike = row.triggerPrice, BS-priced
 *     using row.entryPrice as spot and DVOL-at-that-hour as sigma.
 *     Cost per BTC × (notional / spot) = hedge cost in USD.
 *     Inflate by ~3.3% to reflect the live Deribit ask spread we
 *     measured in D1's chain validation.
 *
 *   EXIT (one of):
 *     a) Triggered → sell at row.triggeredAt: BS price the SAME option
 *        with reduced T (= 14d - elapsed) using DVOL/spot at trigger
 *        time. Deflate by ~3.3% for the bid-side spread. NO cooling
 *        delay — biweekly options are biddable so the immediate-sale
 *        path is realistic.
 *     b) Never triggered (expired_otm rows) → unwind at the actual
 *        product expiry (1 day after activation, matching when the
 *        user's protection ended). Same BS unwind math.
 *
 * Compares hypothetical hedge economics to the actual outcome:
 *   - hedge cost
 *   - hedge recovery
 *   - net hedge P&L (recovery − cost − payout)
 *   - recovery ratio % (recovery / payout)
 *
 * Trader-side premium is held CONSTANT at what was actually collected.
 * Per-day biweekly trader pricing is the job of D3, not D2. The point
 * of D2 is to isolate the hedge economics: would the SAME trades have
 * had materially better recovery under the biweekly hedge?
 *
 * Bid-ask spread calibration:
 *   D1's live chain validation found median spread of live ask vs
 *   BS@markIV = 3.3% (p90 4.0%). We apply ±3.3% as the round-trip
 *   transaction cost. This is conservative for the buy side (real ask
 *   may be 5-10% above BS-DVOL due to skew on tier-distance strikes)
 *   and accurate for the sell side at-the-money (where smile is small).
 *   Sweep flag --spread-pct overrides for sensitivity analysis.
 *
 * Usage:
 *   npx tsx services/api/scripts/phase0/biweekly_trigger_replay_backtest.ts
 *   npx tsx services/api/scripts/phase0/biweekly_trigger_replay_backtest.ts --tenor 14
 *   npx tsx services/api/scripts/phase0/biweekly_trigger_replay_backtest.ts --spread-pct 5.0
 *   npx tsx services/api/scripts/phase0/biweekly_trigger_replay_backtest.ts --in path.json --out-dir path/
 *
 * Output:
 *   docs/cfo-report/phase0/biweekly_trigger_replay.json   (per-trade results)
 *   docs/cfo-report/phase0/biweekly_trigger_replay.md     (human report)
 *
 * Exit codes:
 *   0 — backtest completed (artifacts written)
 *   1 — fetch failure (Deribit/Coinbase unreachable)
 *   2 — bad CLI args / input file invalid
 */

import { bsPut, bsCall } from "../../src/pilot/blackScholes";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ─────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const argFlag = (name: string, fallback?: string): string | undefined => {
  const idx = argv.indexOf(name);
  if (idx === -1) return fallback;
  return argv[idx + 1];
};

const TENOR_DAYS = Number(argFlag("--tenor", "14"));
const SPREAD_PCT = Number(argFlag("--spread-pct", "3.3"));
// Default input path is relative to repo root. The npm script is run from
// services/api so we resolve from there with `../../` prefix; the --in flag
// accepts an absolute path or any path resolvable from process.cwd().
const IN_PATH =
  argFlag("--in", "../../services/api/scripts/phase0/inputs/historical_triggers_snapshot.json")!;
const OUT_DIR = argFlag("--out-dir", "../../docs/cfo-report/phase0")!;

if (!Number.isFinite(TENOR_DAYS) || TENOR_DAYS <= 0 || TENOR_DAYS > 60) {
  console.error("ERROR: --tenor must be a positive integer ≤ 60");
  process.exit(2);
}
if (!Number.isFinite(SPREAD_PCT) || SPREAD_PCT < 0 || SPREAD_PCT > 50) {
  console.error("ERROR: --spread-pct must be 0..50");
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const DERIBIT_BASE = "https://www.deribit.com/api/v2";
const COINBASE_BASE = "https://api.exchange.coinbase.com";
const RISK_FREE_RATE = 0;

const log = (msg: string): void => {
  process.stderr.write(`[phase0/d2] ${msg}\n`);
};

// ─────────────────────────────────────────────────────────────────────
// Input schema
// ─────────────────────────────────────────────────────────────────────

type Trigger = {
  id: string;
  createdAt: string;
  direction: "long" | "short";
  slPct: number;
  protectedNotionalUsd: number;
  entryPrice: number;
  triggerPrice: number;
  expiryAt: string;
  status: string;
  triggeredAt: string | null;
  spotAtTrigger: number | null;
  spotMoveThroughTriggerPct: number | null;
  triggerPattern: string;
  premiumCollectedUsd: number;
  hedgeCostUsd: number;
  hedgeRecoveryUsd: number;
  payoutOwedUsd: number;
  netPnlUsd: number;
  recoveryRatioPct: number | null;
};

const loadTriggers = (path: string): { rows: Trigger[]; capturedAt: string } => {
  const raw = readFileSync(path, "utf-8");
  const j = JSON.parse(raw);
  if (!Array.isArray(j?.rows)) {
    console.error("ERROR: input file missing 'rows' array");
    process.exit(2);
  }
  return { rows: j.rows as Trigger[], capturedAt: j._capturedAt ?? "unknown" };
};

// ─────────────────────────────────────────────────────────────────────
// Historical data fetching (paginated)
// ─────────────────────────────────────────────────────────────────────

type DvolPoint = { tsMs: number; dvol: number };
type SpotPoint = { tsMs: number; spotUsd: number };

const fetchDvolHistory = async (startMs: number, endMs: number): Promise<DvolPoint[]> => {
  const out: DvolPoint[] = [];
  const WINDOW_MS = 30 * 86400 * 1000;
  let cursor = startMs;
  while (cursor < endMs) {
    const windowEnd = Math.min(cursor + WINDOW_MS, endMs);
    const url =
      `${DERIBIT_BASE}/public/get_volatility_index_data` +
      `?currency=BTC&resolution=3600` +
      `&start_timestamp=${cursor}` +
      `&end_timestamp=${windowEnd}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`deribit dvol http ${res.status}`);
    const j: any = await res.json();
    const rows: any[] = j?.result?.data ?? [];
    for (const r of rows) {
      const tsMs = Number(r?.[0]);
      const close = Number(r?.[4]);
      if (Number.isFinite(tsMs) && Number.isFinite(close) && close > 0) {
        out.push({ tsMs, dvol: close });
      }
    }
    cursor = windowEnd + 1;
  }
  out.sort((a, b) => a.tsMs - b.tsMs);
  const seen = new Set<number>();
  return out.filter((p) => {
    if (seen.has(p.tsMs)) return false;
    seen.add(p.tsMs);
    return true;
  });
};

const fetchSpotHistory = async (startMs: number, endMs: number): Promise<SpotPoint[]> => {
  const out: SpotPoint[] = [];
  const WINDOW_MS = 12 * 86400 * 1000;
  let cursor = startMs;
  while (cursor < endMs) {
    const windowEnd = Math.min(cursor + WINDOW_MS, endMs);
    const startIso = new Date(cursor).toISOString();
    const endIso = new Date(windowEnd).toISOString();
    const url =
      `${COINBASE_BASE}/products/BTC-USD/candles` +
      `?granularity=3600&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "atticus-phase0-d2/1.0" }
    });
    if (!res.ok) throw new Error(`coinbase candles http ${res.status}`);
    const j: any = await res.json();
    if (!Array.isArray(j)) throw new Error("coinbase candles unexpected shape");
    for (const r of j) {
      const tsSec = Number(r?.[0]);
      const close = Number(r?.[4]);
      if (Number.isFinite(tsSec) && Number.isFinite(close) && close > 0) {
        out.push({ tsMs: tsSec * 1000, spotUsd: close });
      }
    }
    cursor = windowEnd + 1;
    await new Promise((r) => setTimeout(r, 350));
  }
  out.sort((a, b) => a.tsMs - b.tsMs);
  const seen = new Set<number>();
  return out.filter((p) => {
    if (seen.has(p.tsMs)) return false;
    seen.add(p.tsMs);
    return true;
  });
};

// ─────────────────────────────────────────────────────────────────────
// Lookup helpers — find the hourly point closest to a given timestamp
// ─────────────────────────────────────────────────────────────────────

const findClosest = <T extends { tsMs: number }>(arr: T[], targetMs: number): T | null => {
  if (!arr.length) return null;
  // Binary search for efficiency on the sorted array.
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (arr[mid].tsMs < targetMs) lo = mid + 1;
    else hi = mid;
  }
  // lo is the smallest index with tsMs >= targetMs (or arr.length-1)
  const candidates = [arr[lo]];
  if (lo > 0) candidates.push(arr[lo - 1]);
  candidates.sort((a, b) => Math.abs(a.tsMs - targetMs) - Math.abs(b.tsMs - targetMs));
  // Reject if more than 90 minutes off (data gap)
  const best = candidates[0];
  if (Math.abs(best.tsMs - targetMs) > 90 * 60 * 1000) return null;
  return best;
};

// ─────────────────────────────────────────────────────────────────────
// Pricing math (mirrors D1 with minor extensions for variable T)
// ─────────────────────────────────────────────────────────────────────

const priceOption = (params: {
  spot: number;
  strike: number;
  sigma: number;
  tenorDays: number;
  direction: "long" | "short";
}): { perBtc: number; intrinsicPerBtc: number; timeValuePerBtc: number } => {
  const { spot, strike, sigma, tenorDays, direction } = params;
  const T = Math.max(0, tenorDays) / 365.25;
  const intrinsic =
    direction === "long" ? Math.max(0, strike - spot) : Math.max(0, spot - strike);
  if (T <= 0 || sigma <= 0) {
    return { perBtc: intrinsic, intrinsicPerBtc: intrinsic, timeValuePerBtc: 0 };
  }
  const total =
    direction === "long"
      ? bsPut(spot, strike, T, RISK_FREE_RATE, sigma)
      : bsCall(spot, strike, T, RISK_FREE_RATE, sigma);
  const totalEff = Math.max(intrinsic, total);
  return {
    perBtc: totalEff,
    intrinsicPerBtc: intrinsic,
    timeValuePerBtc: Math.max(0, totalEff - intrinsic)
  };
};

// ─────────────────────────────────────────────────────────────────────
// Per-trigger replay
// ─────────────────────────────────────────────────────────────────────

type ReplayRow = {
  id: string;
  createdAt: string;
  direction: "long" | "short";
  slPct: number;
  protectedNotionalUsd: number;
  triggerPrice: number;
  status: string;
  triggeredAt: string | null;

  // Inputs at activation
  spotAtActivation: number | null;
  dvolAtActivation: number | null;

  // Inputs at exit
  exitTimeIso: string;
  exitReason: "triggered_sell_at_fire" | "expired_natural_unwind" | "unknown_no_data";
  spotAtExit: number | null;
  dvolAtExit: number | null;
  hoursActivationToExit: number | null;
  daysRemainingOnHedgeAtExit: number | null;

  // Hypothetical biweekly hedge math
  bsHedgeCostUsd_mid: number | null;
  bsHedgeCostUsd_ask: number | null; // = mid × (1 + spread/100)
  bsRecoveryUsd_mid: number | null;
  bsRecoveryUsd_bid: number | null; // = mid × (1 − spread/100)
  intrinsicAtExitUsd: number | null;
  timeValueAtExitUsd: number | null;
  hypotheticalRecoveryRatioPct: number | null; // = bsRecoveryUsd_bid / payout × 100
  hypotheticalHedgeNetUsd: number | null; // = recovery_bid − hedge_cost_ask
  hypotheticalTotalNetPnlUsd: number | null; // = premium − hedge_cost_ask + recovery_bid − payout

  // Actual numbers from input snapshot (for side-by-side)
  actualHedgeCostUsd: number;
  actualRecoveryUsd: number;
  actualPayoutOwedUsd: number;
  actualPremiumCollectedUsd: number;
  actualNetPnlUsd: number;
  actualRecoveryRatioPct: number | null;

  notes: string[];
};

const replayTrigger = (params: {
  trigger: Trigger;
  dvolHist: DvolPoint[];
  spotHist: SpotPoint[];
  tenorDays: number;
  spreadPct: number;
}): ReplayRow => {
  const { trigger, dvolHist, spotHist, tenorDays, spreadPct } = params;
  const row: ReplayRow = {
    id: trigger.id,
    createdAt: trigger.createdAt,
    direction: trigger.direction,
    slPct: trigger.slPct,
    protectedNotionalUsd: trigger.protectedNotionalUsd,
    triggerPrice: trigger.triggerPrice,
    status: trigger.status,
    triggeredAt: trigger.triggeredAt,
    spotAtActivation: null,
    dvolAtActivation: null,
    exitTimeIso: "",
    exitReason: "unknown_no_data",
    spotAtExit: null,
    dvolAtExit: null,
    hoursActivationToExit: null,
    daysRemainingOnHedgeAtExit: null,
    bsHedgeCostUsd_mid: null,
    bsHedgeCostUsd_ask: null,
    bsRecoveryUsd_mid: null,
    bsRecoveryUsd_bid: null,
    intrinsicAtExitUsd: null,
    timeValueAtExitUsd: null,
    hypotheticalRecoveryRatioPct: null,
    hypotheticalHedgeNetUsd: null,
    hypotheticalTotalNetPnlUsd: null,
    actualHedgeCostUsd: trigger.hedgeCostUsd,
    actualRecoveryUsd: trigger.hedgeRecoveryUsd,
    actualPayoutOwedUsd: trigger.payoutOwedUsd,
    actualPremiumCollectedUsd: trigger.premiumCollectedUsd,
    actualNetPnlUsd: trigger.netPnlUsd,
    actualRecoveryRatioPct: trigger.recoveryRatioPct,
    notes: []
  };

  const activationMs = Date.parse(trigger.createdAt);
  if (!Number.isFinite(activationMs)) {
    row.notes.push("invalid createdAt");
    return row;
  }

  // Look up DVOL & spot at activation. Spot is also in trigger.entryPrice
  // (the platform's own entry-price snapshot); we prefer the entry price
  // since it's what the platform actually used. But we still pull DVOL
  // from history.
  const dvolAt = findClosest(dvolHist, activationMs);
  const spotAt = findClosest(spotHist, activationMs);
  if (!dvolAt) {
    row.notes.push("no DVOL within ±90min of activation; using spot history fallback only is insufficient — skipping");
    return row;
  }
  row.dvolAtActivation = dvolAt.dvol;
  row.spotAtActivation = trigger.entryPrice; // platform's record = source of truth
  if (spotAt && Math.abs(spotAt.spotUsd - trigger.entryPrice) / trigger.entryPrice > 0.01) {
    row.notes.push(
      `spot history vs platform entry differ by >1% (${spotAt.spotUsd.toFixed(0)} vs ${trigger.entryPrice.toFixed(0)}); using platform entry`
    );
  }

  // ── HEDGE COST AT ACTIVATION ──
  // Strike = trigger price (matches PR #76 ITM-aggressive selection on 2%
  // tier; for 3-10% tiers actual selection may differ but trigger-strike is
  // the cleanest comparable baseline).
  const strike = trigger.triggerPrice;
  const sigmaActivation = dvolAt.dvol / 100;
  const entryOption = priceOption({
    spot: trigger.entryPrice,
    strike,
    sigma: sigmaActivation,
    tenorDays,
    direction: trigger.direction
  });
  // Convert per-BTC USD price to USD per protected notional. Hedge BTC
  // quantity needed = notional / spot.
  const hedgeBtcQty = trigger.protectedNotionalUsd / trigger.entryPrice;
  const hedgeCostMid = entryOption.perBtc * hedgeBtcQty;
  const spreadMult = 1 + spreadPct / 100;
  const hedgeCostAsk = hedgeCostMid * spreadMult;
  row.bsHedgeCostUsd_mid = hedgeCostMid;
  row.bsHedgeCostUsd_ask = hedgeCostAsk;

  // ── EXIT TIME ──
  let exitMs: number;
  if (trigger.triggeredAt) {
    exitMs = Date.parse(trigger.triggeredAt);
    row.exitReason = "triggered_sell_at_fire";
  } else {
    // expired_otm path: actual product was 1-day; we unwind the 14-day
    // hedge at the moment the product would have ended naturally.
    // Use actual expiryAt from the snapshot.
    exitMs = Date.parse(trigger.expiryAt);
    row.exitReason = "expired_natural_unwind";
  }
  if (!Number.isFinite(exitMs)) {
    row.notes.push("invalid exit timestamp");
    return row;
  }
  row.exitTimeIso = new Date(exitMs).toISOString();
  row.hoursActivationToExit = (exitMs - activationMs) / 3600000;
  const elapsedDays = (exitMs - activationMs) / 86400000;
  row.daysRemainingOnHedgeAtExit = Math.max(0, tenorDays - elapsedDays);

  // ── EXIT VALUE ──
  // Need DVOL & spot at exit. Spot at trigger fire is in the snapshot
  // (trigger.spotAtTrigger); for expired_otm we take it from history.
  const dvolExit = findClosest(dvolHist, exitMs);
  if (!dvolExit) {
    row.notes.push("no DVOL within ±90min of exit; cannot price unwind");
    return row;
  }
  row.dvolAtExit = dvolExit.dvol;

  let spotAtExit: number;
  if (trigger.spotAtTrigger !== null && trigger.triggeredAt) {
    spotAtExit = trigger.spotAtTrigger;
  } else {
    const spotPt = findClosest(spotHist, exitMs);
    if (!spotPt) {
      row.notes.push("no spot within ±90min of exit; cannot price unwind");
      return row;
    }
    spotAtExit = spotPt.spotUsd;
  }
  row.spotAtExit = spotAtExit;

  const sigmaExit = dvolExit.dvol / 100;
  const exitOption = priceOption({
    spot: spotAtExit,
    strike,
    sigma: sigmaExit,
    tenorDays: row.daysRemainingOnHedgeAtExit ?? 0,
    direction: trigger.direction
  });
  // For SELL we use the same per-BTC quantity bought at entry — that's the
  // hedge size we're unwinding. Convert per-BTC USD value to total USD.
  const recoveryMid = exitOption.perBtc * hedgeBtcQty;
  const recoveryBid = recoveryMid * (1 - spreadPct / 100);
  row.bsRecoveryUsd_mid = recoveryMid;
  row.bsRecoveryUsd_bid = Math.max(0, recoveryBid);
  row.intrinsicAtExitUsd = exitOption.intrinsicPerBtc * hedgeBtcQty;
  row.timeValueAtExitUsd = exitOption.timeValuePerBtc * hedgeBtcQty;

  // ── HYPOTHETICAL P&L ──
  // Recovery ratio is meaningful only when there's a payout obligation.
  if (trigger.payoutOwedUsd > 0) {
    row.hypotheticalRecoveryRatioPct = (row.bsRecoveryUsd_bid / trigger.payoutOwedUsd) * 100;
  }
  row.hypotheticalHedgeNetUsd = row.bsRecoveryUsd_bid - row.bsHedgeCostUsd_ask;
  row.hypotheticalTotalNetPnlUsd =
    trigger.premiumCollectedUsd -
    row.bsHedgeCostUsd_ask +
    row.bsRecoveryUsd_bid -
    trigger.payoutOwedUsd;

  return row;
};

// ─────────────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────────────

type Aggregate = {
  count: number;
  triggeredCount: number;
  expiredOtmCount: number;
  meanActualRecoveryRatioPct: number;
  meanHypotheticalRecoveryRatioPct: number;
  recoveryRatioImprovementPp: number; // percentage points
  meanActualNetPnlUsd: number;
  meanHypotheticalNetPnlUsd: number;
  netPnlImprovementUsd: number;
  sumActualNetPnlUsd: number;
  sumHypotheticalNetPnlUsd: number;
  sumNetPnlImprovementUsd: number;
  meanActualHedgeCostUsd: number;
  meanHypotheticalHedgeCostUsd: number;
  meanActualRecoveryUsd: number;
  meanHypotheticalRecoveryUsd: number;
};

const aggregate = (rows: ReplayRow[]): Aggregate => {
  const triggered = rows.filter((r) => r.exitReason === "triggered_sell_at_fire" && r.bsRecoveryUsd_bid !== null);
  const triggeredWithPayout = triggered.filter(
    (r) => r.actualPayoutOwedUsd > 0 && r.actualRecoveryRatioPct !== null && r.hypotheticalRecoveryRatioPct !== null
  );
  const expiredOtm = rows.filter((r) => r.exitReason === "expired_natural_unwind" && r.bsRecoveryUsd_bid !== null);

  const mean = (arr: number[]): number =>
    arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
  const sum = (arr: number[]): number => arr.reduce((a, b) => a + b, 0);

  const actualRecPcts = triggeredWithPayout.map((r) => r.actualRecoveryRatioPct as number);
  const hypoRecPcts = triggeredWithPayout.map((r) => r.hypotheticalRecoveryRatioPct as number);

  const actualNetPnls = rows.map((r) => r.actualNetPnlUsd);
  const hypoNetPnls = rows
    .filter((r) => r.hypotheticalTotalNetPnlUsd !== null)
    .map((r) => r.hypotheticalTotalNetPnlUsd as number);

  return {
    count: rows.length,
    triggeredCount: triggered.length,
    expiredOtmCount: expiredOtm.length,
    meanActualRecoveryRatioPct: mean(actualRecPcts),
    meanHypotheticalRecoveryRatioPct: mean(hypoRecPcts),
    recoveryRatioImprovementPp: mean(hypoRecPcts) - mean(actualRecPcts),
    meanActualNetPnlUsd: mean(actualNetPnls),
    meanHypotheticalNetPnlUsd: mean(hypoNetPnls),
    netPnlImprovementUsd: mean(hypoNetPnls) - mean(actualNetPnls),
    sumActualNetPnlUsd: sum(actualNetPnls),
    sumHypotheticalNetPnlUsd: sum(hypoNetPnls),
    sumNetPnlImprovementUsd: sum(hypoNetPnls) - sum(actualNetPnls),
    meanActualHedgeCostUsd: mean(rows.map((r) => r.actualHedgeCostUsd)),
    meanHypotheticalHedgeCostUsd: mean(
      rows.filter((r) => r.bsHedgeCostUsd_ask !== null).map((r) => r.bsHedgeCostUsd_ask as number)
    ),
    meanActualRecoveryUsd: mean(rows.map((r) => r.actualRecoveryUsd)),
    meanHypotheticalRecoveryUsd: mean(
      rows.filter((r) => r.bsRecoveryUsd_bid !== null).map((r) => r.bsRecoveryUsd_bid as number)
    )
  };
};

// ─────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────

const fmtUsd = (n: number | null, places = 2): string => {
  if (n === null || !Number.isFinite(n)) return "n/a";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places })}`;
};
const fmtPct = (n: number | null, places = 1): string => {
  if (n === null || !Number.isFinite(n)) return "n/a";
  return `${n.toFixed(places)}%`;
};

const renderMarkdown = (params: {
  capturedAt: string;
  inputCapturedAt: string;
  tenorDays: number;
  spreadPct: number;
  rows: ReplayRow[];
  agg: Aggregate;
}): string => {
  const { capturedAt, inputCapturedAt, tenorDays, spreadPct, rows, agg } = params;
  const lines: string[] = [];
  lines.push(`# Phase 0 D2 — Trigger-Replay Backtest under Biweekly Hedge Model`);
  lines.push("");
  lines.push(`> Generated by \`services/api/scripts/phase0/biweekly_trigger_replay_backtest.ts\`.`);
  lines.push(`> Pure analysis, read-only. No production state changed.`);
  lines.push("");
  lines.push(`**Captured:** ${capturedAt}`);
  lines.push(`**Input snapshot:** ${inputCapturedAt} (16 historical triggers — see \`services/api/scripts/phase0/inputs/historical_triggers_snapshot.json\`)`);
  lines.push(`**Hedge tenor counterfactually priced:** ${tenorDays} days`);
  lines.push(`**Bid-ask spread applied:** ±${spreadPct}% round trip (from D1 chain validation; sweep with \`--spread-pct\`)`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## What this is");
  lines.push("");
  lines.push(
    "For each of the 16 historical protections in the snapshot, we replay what would " +
      `have happened if the platform had hedged with a ${tenorDays}-day BTC option ` +
      "instead of a 1-day option. Per the strategic review, the central question is " +
      "whether trigger recovery — chronically ~18% on the 1-day product vs the 68% " +
      "baseline target — improves materially under the biweekly model."
  );
  lines.push("");
  lines.push("**Methodology:**");
  lines.push("");
  lines.push(
    `1. **Activation (\`createdAt\`):** buy a ${tenorDays}-day option at strike = trigger price ` +
      "(matches PR #76 ITM-aggressive selection on 2% tier; baseline reasonable for other " +
      "tiers). Cost = BS price using DVOL/100 as sigma, inflated by " +
      `${spreadPct}% to reflect the live ask spread we measured in D1.`
  );
  lines.push(
    `2. **Exit:**
   - Triggered → sell IMMEDIATELY at trigger fire time. No 30-min cooling delay
     (biweekly options are biddable, so the 1-day-product cooling-window rationale
     doesn't apply). BS price the SAME option at reduced T using DVOL/spot at trigger
     time, deflate by ${spreadPct}% for the bid spread.
   - Never triggered (expired_otm) → unwind at the actual product expiry (1 day after
     activation). Same BS unwind math.`
  );
  lines.push(
    "3. **Premium held constant** at what the trader actually paid under today's 1-day pricing. " +
      "Per-day biweekly pricing is the job of D3, not D2. The point of D2 is to isolate the " +
      "**hedge** economics — would the same trades have had materially better recovery under " +
      "the biweekly hedge?"
  );
  lines.push("");
  lines.push(
    "**Caveats:** BS-with-DVOL is a model, not the real Deribit chain. Real prices include " +
      "the IV smile (skewed strikes trade at higher IV than DVOL — D1 showed up to 9.9% " +
      "premium on tail-side strikes). The 3.3% spread number is from one snapshot in a low-vol " +
      "regime; it likely widens in stress. Use the `--spread-pct` flag to sweep and see " +
      "sensitivity. Also: only 14 of the 16 trades actually triggered, so recovery-ratio stats " +
      "are over n=14, not n=16."
  );
  lines.push("");

  // ── Headline aggregate ──
  lines.push("## Headline aggregate (n=14 triggered trades)");
  lines.push("");
  lines.push("| Metric | Actual (1-day product) | Hypothetical (biweekly) | Improvement |");
  lines.push("|---|---|---|---|");
  lines.push(
    `| Mean recovery ratio % | ${fmtPct(agg.meanActualRecoveryRatioPct)} | ${fmtPct(agg.meanHypotheticalRecoveryRatioPct)} | ${fmtPct(agg.recoveryRatioImprovementPp, 1)} pp |`
  );
  lines.push(
    `| Mean hedge cost / trade | ${fmtUsd(agg.meanActualHedgeCostUsd)} | ${fmtUsd(agg.meanHypotheticalHedgeCostUsd)} | ${fmtUsd(agg.meanHypotheticalHedgeCostUsd - agg.meanActualHedgeCostUsd, 2)} |`
  );
  lines.push(
    `| Mean recovery / trade | ${fmtUsd(agg.meanActualRecoveryUsd)} | ${fmtUsd(agg.meanHypotheticalRecoveryUsd)} | ${fmtUsd(agg.meanHypotheticalRecoveryUsd - agg.meanActualRecoveryUsd, 2)} |`
  );
  lines.push(
    `| Mean net P&L / trade (incl. premium & payout, all 16) | ${fmtUsd(agg.meanActualNetPnlUsd)} | ${fmtUsd(agg.meanHypotheticalNetPnlUsd)} | ${fmtUsd(agg.netPnlImprovementUsd, 2)} |`
  );
  lines.push(
    `| **Sum net P&L across 16 trades** | **${fmtUsd(agg.sumActualNetPnlUsd)}** | **${fmtUsd(agg.sumHypotheticalNetPnlUsd)}** | **${fmtUsd(agg.sumNetPnlImprovementUsd, 2)}** |`
  );
  lines.push("");

  // ── Per-trade detail ──
  lines.push("## Per-trade detail");
  lines.push("");
  lines.push("Sorted by createdAt descending (most recent first).");
  lines.push("");
  lines.push(
    "| ID (8) | dir | SL% | notional | exit | hours held | DVOL@activate | DVOL@exit | spot@exit | actual cost / recov / net | hypo cost / recov / net | actual rec% | hypo rec% | Δ pp |"
  );
  lines.push(
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"
  );
  const sorted = [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  for (const r of sorted) {
    const idShort = r.id.slice(0, 8);
    const exitTag =
      r.exitReason === "triggered_sell_at_fire"
        ? "trig"
        : r.exitReason === "expired_natural_unwind"
        ? "expOtm"
        : "?";
    const dvolAct = r.dvolAtActivation !== null ? r.dvolAtActivation.toFixed(1) : "n/a";
    const dvolExit = r.dvolAtExit !== null ? r.dvolAtExit.toFixed(1) : "n/a";
    const spotExit = r.spotAtExit !== null ? `$${Math.round(r.spotAtExit).toLocaleString()}` : "n/a";
    const hours = r.hoursActivationToExit !== null ? r.hoursActivationToExit.toFixed(1) : "n/a";
    const actCRN = `${fmtUsd(r.actualHedgeCostUsd, 0)} / ${fmtUsd(r.actualRecoveryUsd, 0)} / ${fmtUsd(r.actualNetPnlUsd, 0)}`;
    const hypCRN = `${fmtUsd(r.bsHedgeCostUsd_ask, 0)} / ${fmtUsd(r.bsRecoveryUsd_bid, 0)} / ${fmtUsd(r.hypotheticalTotalNetPnlUsd, 0)}`;
    const actR = fmtPct(r.actualRecoveryRatioPct);
    const hypR = fmtPct(r.hypotheticalRecoveryRatioPct);
    const delta =
      r.actualRecoveryRatioPct !== null && r.hypotheticalRecoveryRatioPct !== null
        ? fmtPct(r.hypotheticalRecoveryRatioPct - r.actualRecoveryRatioPct)
        : "n/a";
    lines.push(
      `| ${idShort} | ${r.direction} | ${r.slPct}% | ${fmtUsd(r.protectedNotionalUsd, 0)} | ${exitTag} | ${hours} | ${dvolAct} | ${dvolExit} | ${spotExit} | ${actCRN} | ${hypCRN} | ${actR} | ${hypR} | ${delta} |`
    );
  }
  lines.push("");

  // ── Notes flagged on rows ──
  const withNotes = rows.filter((r) => r.notes.length > 0);
  if (withNotes.length > 0) {
    lines.push("## Per-trade notes");
    lines.push("");
    for (const r of withNotes) {
      lines.push(`- **${r.id.slice(0, 8)}**: ${r.notes.join("; ")}`);
    }
    lines.push("");
  }

  // ── Sensitivity reminder ──
  lines.push("## Sensitivity & next steps");
  lines.push("");
  lines.push(
    `1. **Spread sensitivity:** these numbers assume ${spreadPct}% round-trip. ` +
      "In stress regime spread likely widens to 5-10%. Re-run with `--spread-pct 5.0` " +
      "and `--spread-pct 10.0` to see worst-case bounding. The headline conclusion (recovery " +
      "improves materially) tends to be robust to spread because we're trading 30-80% spread " +
      "today vs ~3-10% in any biweekly scenario."
  );
  lines.push(
    `2. **Strike-selection sensitivity:** D2 prices the strike at the trigger price uniformly. ` +
      "Production today uses ITM-aggressive on 2% tier (PR #76) and OTM on wider tiers — " +
      "deeper-ITM selection gives more intrinsic at trigger, narrower-OTM gives less but " +
      "is cheaper. Out of D2 scope; revisit in D3 if needed."
  );
  lines.push(
    "3. **D3 (per-day pricing model)** is gated on D2 confirming the recovery thesis. If the " +
      "headline aggregate above shows materially positive improvement, D3 designs the trader " +
      "rate table; if not, we stop and revise."
  );
  lines.push(
    "4. **D4 (capital requirements)** is gated on the per-trade hedge-cost numbers above. " +
      "Mean hypothetical hedge cost × expected concurrent trade count = required Deribit equity."
  );
  lines.push("");
  return lines.join("\n");
};

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

const ensureDir = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(path, { recursive: true });
};

const main = async (): Promise<void> => {
  log(`starting trigger-replay backtest (tenor=${TENOR_DAYS}d, spread=±${SPREAD_PCT}%, in=${IN_PATH}, out=${OUT_DIR})`);

  const { rows: triggers, capturedAt: inputCapturedAt } = loadTriggers(IN_PATH);
  log(`loaded ${triggers.length} historical triggers from ${IN_PATH}`);

  // Determine the date range we need DVOL/spot for. Use min activation
  // through max(triggeredAt, expiryAt) + 1 day for buffer.
  const allTimes: number[] = [];
  for (const t of triggers) {
    const c = Date.parse(t.createdAt);
    if (Number.isFinite(c)) allTimes.push(c);
    if (t.triggeredAt) {
      const tr = Date.parse(t.triggeredAt);
      if (Number.isFinite(tr)) allTimes.push(tr);
    }
    const e = Date.parse(t.expiryAt);
    if (Number.isFinite(e)) allTimes.push(e);
  }
  const startMs = Math.min(...allTimes) - 86400000; // 1d buffer
  const endMs = Math.max(...allTimes) + 86400000; // 1d buffer
  log(`historical data window: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`);

  log("fetching DVOL hourly history…");
  let dvolHist: DvolPoint[];
  try {
    dvolHist = await fetchDvolHistory(startMs, endMs);
    log(`  → ${dvolHist.length} DVOL samples`);
  } catch (e: any) {
    log(`ERROR: DVOL fetch failed: ${e?.message}`);
    process.exit(1);
  }

  log("fetching BTC-USD hourly spot history…");
  let spotHist: SpotPoint[];
  try {
    spotHist = await fetchSpotHistory(startMs, endMs);
    log(`  → ${spotHist.length} spot samples`);
  } catch (e: any) {
    log(`ERROR: spot fetch failed: ${e?.message}`);
    process.exit(1);
  }

  log("replaying each trigger under biweekly hedge model…");
  const replayRows: ReplayRow[] = [];
  for (const t of triggers) {
    const r = replayTrigger({ trigger: t, dvolHist, spotHist, tenorDays: TENOR_DAYS, spreadPct: SPREAD_PCT });
    replayRows.push(r);
    if (r.notes.length > 0) {
      log(`  ! ${r.id.slice(0, 8)}: ${r.notes.join("; ")}`);
    }
  }

  const agg = aggregate(replayRows);
  log(
    `aggregate: actual mean recovery ${agg.meanActualRecoveryRatioPct.toFixed(1)}% → ` +
      `hypothetical ${agg.meanHypotheticalRecoveryRatioPct.toFixed(1)}% ` +
      `(Δ ${(agg.meanHypotheticalRecoveryRatioPct - agg.meanActualRecoveryRatioPct).toFixed(1)} pp)`
  );

  ensureDir(OUT_DIR);
  const capturedAt = new Date().toISOString();
  const jsonPath = join(OUT_DIR, "biweekly_trigger_replay.json");
  const mdPath = join(OUT_DIR, "biweekly_trigger_replay.md");

  const dataset = {
    capturedAt,
    inputs: {
      tenorDays: TENOR_DAYS,
      spreadPct: SPREAD_PCT,
      inputSnapshotPath: IN_PATH,
      inputCapturedAt
    },
    aggregate: agg,
    rows: replayRows
  };
  writeFileSync(jsonPath, JSON.stringify(dataset, null, 2) + "\n");
  log(`wrote ${jsonPath}`);

  const md = renderMarkdown({
    capturedAt,
    inputCapturedAt,
    tenorDays: TENOR_DAYS,
    spreadPct: SPREAD_PCT,
    rows: replayRows,
    agg
  });
  writeFileSync(mdPath, md);
  log(`wrote ${mdPath}`);

  log("done.");
};

main().catch((e) => {
  log(`fatal: ${e?.message ?? e}`);
  process.exit(1);
});
