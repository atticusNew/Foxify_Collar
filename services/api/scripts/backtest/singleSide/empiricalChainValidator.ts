/**
 * Empirical Chain Validator — pull LIVE Bullish + Deribit chains and
 * validate every Phase 0 single-side cell's strike availability, depth,
 * bid/ask, and BS-vs-actual gap. Then compute the per-position capital
 * ladder (1 → 25 positions) using ACTUAL ask prices.
 *
 * NETWORK ACCESS:
 *   - Bullish: routed through the LIVE RENDER API (zero new endpoints
 *     needed). Uses the existing `/volume-cover/admin/bullish-option-chain`
 *     and `/volume-cover/admin/bullish-orderbook` admin endpoints, which
 *     are already deployed, admin-token-gated, and explicitly designed
 *     for "comparing Bullish vs Deribit during proposal negotiation
 *     calibration" (see volumeCoverRoutes.ts:2169).
 *   - Deribit: public API direct (no auth, geo-unrestricted).
 *
 * USAGE:
 *   export RENDER_API_URL="https://foxify-pilot-new.onrender.com"
 *   export RENDER_ADMIN_TOKEN="<token>"
 *   cd services/api
 *   npx tsx scripts/backtest/singleSide/empiricalChainValidator.ts
 *
 * NO production hot-path impact. Read-only chain queries.
 *
 * Output: docs/SINGLE_SIDE_EMPIRICAL_VALIDATION.md
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bsPut, bsCall } from "./coreEngine";

// ─────────────────────────── Cell matrix ───────────────────────────

type Cell = {
  cellId: string;
  notionalUsdc: number;
  triggerPct: number;
  payoutUsdc: number;
  hedgePct: number;
  hedgeTenorDays: number;
  baseDailyPremiumUsdc: number;
  expectedVenuePrimary: "bullish" | "deribit";
  expectedVenueFallback: "bullish" | "deribit";
};

const CELLS: Cell[] = [
  { cellId: "ss_50k_2pct_1k",   notionalUsdc:  50_000, triggerPct: 0.02, payoutUsdc:  1_000, hedgePct: 0.01, hedgeTenorDays: 3, baseDailyPremiumUsdc:   310, expectedVenuePrimary: "bullish", expectedVenueFallback: "deribit" },
  { cellId: "ss_50k_5pct_2_5k", notionalUsdc:  50_000, triggerPct: 0.05, payoutUsdc:  2_500, hedgePct: 0.03, hedgeTenorDays: 3, baseDailyPremiumUsdc:   140, expectedVenuePrimary: "bullish", expectedVenueFallback: "deribit" },
  { cellId: "ss_50k_7pct_3_5k", notionalUsdc:  50_000, triggerPct: 0.07, payoutUsdc:  3_500, hedgePct: 0.05, hedgeTenorDays: 6, baseDailyPremiumUsdc:   310, expectedVenuePrimary: "deribit", expectedVenueFallback: "bullish" },
  { cellId: "ss_200k_5pct_10k", notionalUsdc: 200_000, triggerPct: 0.05, payoutUsdc: 10_000, hedgePct: 0.03, hedgeTenorDays: 3, baseDailyPremiumUsdc:   600, expectedVenuePrimary: "bullish", expectedVenueFallback: "deribit" },
  { cellId: "ss_200k_7pct_14k", notionalUsdc: 200_000, triggerPct: 0.07, payoutUsdc: 14_000, hedgePct: 0.05, hedgeTenorDays: 6, baseDailyPremiumUsdc: 1_250, expectedVenuePrimary: "deribit", expectedVenueFallback: "bullish" }
];

const RFR = 0.045;

// ─────────────────────────── Env / config ───────────────────────────

const RENDER_API_URL = (process.env.RENDER_API_URL ?? "").trim();
const RENDER_ADMIN_TOKEN = (process.env.RENDER_ADMIN_TOKEN ?? "").trim();
if (!RENDER_API_URL || !RENDER_ADMIN_TOKEN) {
  console.error("Missing required env vars:");
  console.error("  RENDER_API_URL    — e.g. https://foxify-pilot-new.onrender.com");
  console.error("  RENDER_ADMIN_TOKEN — admin token for the live API");
  console.error("");
  console.error("Both are READ-ONLY for chain queries. No production hot-path impact.");
  process.exit(1);
}

// ─────────────────────────── Network helpers ───────────────────────────

const fetchJson = async <T>(url: string, opts: RequestInit = {}, timeoutMs = 20_000): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} on ${url.slice(0, 120)} :: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
};

const renderGet = async <T>(pathAndQuery: string): Promise<T> =>
  fetchJson<T>(`${RENDER_API_URL}${pathAndQuery}`, {
    headers: { "X-Admin-Token": RENDER_ADMIN_TOKEN, Accept: "application/json" }
  });

// ─────────────────────────── Spot + DVOL ───────────────────────────

const fetchSpotUsd = async (): Promise<number> => {
  const res = await fetchJson<{ data: { amount: string } }>(
    "https://api.coinbase.com/v2/prices/BTC-USD/spot"
  );
  return Number(res.data.amount);
};

const fetchDvol = async (): Promise<number | null> => {
  try {
    const now = Date.now();
    const res = await fetchJson<{ result: { data: number[][] } }>(
      `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${now - 3_600_000}&end_timestamp=${now}&resolution=60`
    );
    const last = res.result.data[res.result.data.length - 1];
    return last && Number.isFinite(last[1]) ? Number(last[1]) : null;
  } catch {
    return null;
  }
};

// ─────────────────────────── Bullish (via Render) ───────────────────────────

type BullishChainResponse = {
  generatedAtIso: string;
  spotBtcUsdc: number;
  bullishMainnet: boolean;
  totalBtcOptionMarkets: number;
  expiriesInWindow: string[];
  cellAnalysis: Array<{
    cellId: string;
    targetPutStrike: number;
    targetCallStrike: number;
    triggerLow: number;
    triggerHigh: number;
    viable: boolean;
    firstViableExpiry: { expiry: string; daysOut: number; putStrike: number; callStrike: number } | null;
    perExpiry: Array<{
      expiryDate: string;
      daysOut: number;
      totalPuts: number;
      totalCalls: number;
      putsInHedgeZone: number[];
      callsInHedgeZone: number[];
      closestPutStrike: number | null;
      closestCallStrike: number | null;
      viable: boolean;
    }>;
  }>;
};

type BullishOrderbookResponse = {
  ok: boolean;
  symbol: string;
  summary: {
    topBid: { price: string; priceLevelQuantity?: string; quantity?: string } | null;
    topAsk: { price: string; priceLevelQuantity?: string; quantity?: string } | null;
    midPrice: number | null;
    spreadPct: number | null;
    bidLevels: number;
    askLevels: number;
  };
  bids: Array<{ price: string; priceLevelQuantity?: string; quantity?: string }>;
  asks: Array<{ price: string; priceLevelQuantity?: string; quantity?: string }>;
  error?: string;
};

const fetchBullishChainFromRender = async (): Promise<BullishChainResponse> =>
  renderGet<BullishChainResponse>("/volume-cover/admin/bullish-option-chain");

const fetchBullishOrderbookFromRender = async (
  symbol: string
): Promise<BullishOrderbookResponse> =>
  renderGet<BullishOrderbookResponse>(
    `/volume-cover/admin/bullish-orderbook?symbol=${encodeURIComponent(symbol)}&depth=10`
  );

const buildBullishSymbol = (
  expiryDateIso: string,
  strike: number,
  optionType: "P" | "C"
): string => {
  const ymd = expiryDateIso.slice(0, 10).replaceAll("-", "");
  return `BTC-USDC-${ymd}-${Math.round(strike)}-${optionType}`;
};

// ─────────────────────────── Deribit (public API) ───────────────────────────

type DeribitInstrument = {
  instrument_name: string;
  base_currency: string;
  kind: string;
  option_type: string;
  strike: number;
  expiration_timestamp: number;
};

type DeribitOrderBook = {
  best_bid_price: number;
  best_bid_amount: number;
  best_ask_price: number;
  best_ask_amount: number;
  index_price: number;
  underlying_price: number;
  bids: number[][];
  asks: number[][];
};

const fetchDeribitInstruments = async (): Promise<DeribitInstrument[]> => {
  const res = await fetchJson<{ result: DeribitInstrument[] }>(
    "https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false"
  );
  return res.result;
};

const fetchDeribitOrderbook = async (instrument: string): Promise<DeribitOrderBook | null> => {
  try {
    const res = await fetchJson<{ result: DeribitOrderBook }>(
      `https://www.deribit.com/api/v2/public/get_order_book?instrument_name=${encodeURIComponent(instrument)}&depth=10`
    );
    return res.result;
  } catch {
    return null;
  }
};

// ─────────────────────────── Probe types ───────────────────────────

type LegProbe = {
  side: "long_cover_put" | "short_cover_call";
  targetStrike: number;
  actualStrike: number | null;
  strikeMatchPct: number | null;
  targetTenorDays: number;
  actualTenorDays: number | null;
  bestBidUsd: number | null;
  bestAskUsd: number | null;
  spreadPct: number | null;
  topAskBtc: number | null;
  depthWithin2pctBtc: number | null;
  bsModelPriceUsd: number | null;
  askVsBsRatio: number | null;
  symbol: string | null;
  notes: string[];
};

type CellProbe = {
  cell: Cell;
  spotUsd: number;
  ivPct: number;
  bullishLong: LegProbe;
  bullishShort: LegProbe;
  deribitLong: LegProbe;
  deribitShort: LegProbe;
  /** For cells with target tenor ≥ 5d: also probe the longest available
   * expiry within ~14d window so we can answer the 6d-availability
   * question empirically. Null for short-tenor cells. */
  bullishLongTenorLong: LegProbe | null;
  bullishLongTenorShort: LegProbe | null;
  deribitLongTenorLong: LegProbe | null;
  deribitLongTenorShort: LegProbe | null;
  primaryHedgeCostUsd: number | null;
  fallbackHedgeCostUsd: number | null;
  contractsBtcPerCover: number;
  warnings: string[];
};

// ─────────────────────────── Helpers ───────────────────────────

const findClosestStrike = (target: number, available: number[]): number | null => {
  if (available.length === 0) return null;
  let best: number | null = null;
  let dist = Infinity;
  for (const s of available) {
    const d = Math.abs(s - target);
    if (d < dist) {
      dist = d;
      best = s;
    }
  }
  return best;
};

const computeTargetExpiryUtc = (now: Date, tenorDays: number): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + tenorDays, 8, 0, 0));

const findClosestExpiryByMs = (targetMs: number, available: number[]): number | null => {
  if (available.length === 0) return null;
  let best: number | null = null;
  let dist = Infinity;
  for (const e of available) {
    const d = Math.abs(e - targetMs);
    if (d < dist) {
      dist = d;
      best = e;
    }
  }
  return best;
};

// ─────────────────────────── Bullish leg probe (via Render) ───────────────────────────

/**
 * Probe a single Bullish leg by directly constructing symbols at the
 * known $1k strike grid and calling the Render `/admin/bullish-orderbook`
 * endpoint. Tries target strike then ±$1k, ±$2k around it.
 *
 * `expiryDateOverride` lets us probe a non-default expiry (e.g. probing
 * a 6d expiry on top of the default 3d for tenor-availability analysis).
 */
const probeBullishLeg = async (
  side: "long_cover_put" | "short_cover_call",
  spot: number,
  cell: Cell,
  bullishChain: BullishChainResponse,
  ivAnnual: number,
  expiryDateOverride?: string
): Promise<LegProbe> => {
  const optionType = side === "long_cover_put" ? "P" : "C";
  const targetStrike =
    side === "long_cover_put"
      ? spot * (1 - cell.hedgePct)
      : spot * (1 + cell.hedgePct);
  const targetTenorDays = cell.hedgeTenorDays;
  const targetExpiryMs = computeTargetExpiryUtc(new Date(), targetTenorDays).getTime();

  const probe: LegProbe = {
    side,
    targetStrike,
    actualStrike: null,
    strikeMatchPct: null,
    targetTenorDays,
    actualTenorDays: null,
    bestBidUsd: null,
    bestAskUsd: null,
    spreadPct: null,
    topAskBtc: null,
    depthWithin2pctBtc: null,
    bsModelPriceUsd: null,
    askVsBsRatio: null,
    symbol: null,
    notes: []
  };

  // Pick expiry: either operator-supplied override, or closest from the chain
  let expiryDate: string;
  let expiryMs: number;
  if (expiryDateOverride) {
    expiryDate = expiryDateOverride;
    expiryMs = new Date(`${expiryDate}T08:00:00.000Z`).getTime();
  } else {
    const expiriesMs = bullishChain.expiriesInWindow.map((d) =>
      new Date(`${d}T08:00:00.000Z`).getTime()
    );
    const closestExpiryMs = findClosestExpiryByMs(targetExpiryMs, expiriesMs);
    if (closestExpiryMs === null) {
      probe.notes.push("no expiries in chain");
      return probe;
    }
    expiryMs = closestExpiryMs;
    expiryDate = new Date(closestExpiryMs).toISOString().slice(0, 10);
  }
  probe.actualTenorDays = (expiryMs - Date.now()) / 86_400_000;

  // Bullish strike grid is $1k for BTC options (verified across 5/26, 6/26,
  // 7/31, 9/25 expiries — see docs/STATE_OF_WORK_2026_05_22.md:323-349).
  const grid = 1000;
  const baseStrike = Math.round(targetStrike / grid) * grid;

  // Try strikes in priority order: target, then drift inward (toward spot for
  // OTM legs), then outward. For long_cover_put (OTM put below spot):
  // closer to spot = more conservative cover. Same logic for short_cover_call.
  const offsets = side === "long_cover_put" ? [0, 1, -1, 2, -2] : [0, -1, 1, -2, 2];

  const triedStrikes: number[] = [];
  for (const offset of offsets) {
    const trialStrike = baseStrike + offset * grid;
    if (trialStrike <= 0) continue;
    triedStrikes.push(trialStrike);
    const symbol = buildBullishSymbol(expiryDate, trialStrike, optionType);
    let ob: BullishOrderbookResponse;
    try {
      ob = await fetchBullishOrderbookFromRender(symbol);
    } catch {
      continue;
    }
    if (!ob.ok || ob.error) continue;
    if (!ob.summary.topBid && !ob.summary.topAsk) continue;

    // Found a listed strike with at least one side quoted
    probe.actualStrike = trialStrike;
    probe.strikeMatchPct = (trialStrike - targetStrike) / targetStrike;
    probe.symbol = symbol;
    if (ob.summary.topBid) {
      probe.bestBidUsd = Number(ob.summary.topBid.price);
    }
    if (ob.summary.topAsk) {
      probe.bestAskUsd = Number(ob.summary.topAsk.price);
      probe.topAskBtc = Number(
        ob.summary.topAsk.priceLevelQuantity ?? ob.summary.topAsk.quantity ?? 0
      );
    }
    if (probe.bestBidUsd && probe.bestAskUsd && probe.bestBidUsd > 0 && probe.bestAskUsd > 0) {
      const mid = (probe.bestBidUsd + probe.bestAskUsd) / 2;
      probe.spreadPct = ((probe.bestAskUsd - probe.bestBidUsd) / mid) * 100;
      // Bug B fix: depth-within-2% means 2% above BEST ASK (the buyer's
      // slippage budget against the quoted price), not 2% above mid.
      const askLimit = probe.bestAskUsd * 1.02;
      let depth = 0;
      for (const level of ob.asks) {
        const px = Number(level.price);
        if (px > askLimit) break;
        depth += Number(level.priceLevelQuantity ?? level.quantity ?? 0);
      }
      probe.depthWithin2pctBtc = depth;
    }

    const T = (probe.actualTenorDays ?? targetTenorDays) / 365;
    const bsPrice =
      optionType === "P"
        ? bsPut(spot, trialStrike, T, RFR, ivAnnual)
        : bsCall(spot, trialStrike, T, RFR, ivAnnual);
    probe.bsModelPriceUsd = bsPrice;
    if (probe.bestAskUsd && bsPrice > 0) probe.askVsBsRatio = probe.bestAskUsd / bsPrice;

    // Brief throttle to be polite to Render
    await new Promise((r) => setTimeout(r, 80));
    return probe;
  }

  probe.notes.push(
    `no Bullish strike listed at ${expiryDate} within \$2k of target ${targetStrike.toFixed(0)} (tried ${triedStrikes.join(", ")})`
  );
  return probe;
};

// ─────────────────────────── Deribit leg probe (public) ───────────────────────────

const probeDeribitLeg = async (
  side: "long_cover_put" | "short_cover_call",
  spot: number,
  cell: Cell,
  deribitInstruments: DeribitInstrument[],
  ivAnnual: number
): Promise<LegProbe> => {
  const optionType = side === "long_cover_put" ? "put" : "call";
  const targetStrike =
    side === "long_cover_put"
      ? spot * (1 - cell.hedgePct)
      : spot * (1 + cell.hedgePct);
  const targetTenorDays = cell.hedgeTenorDays;
  const targetExpiryMs = computeTargetExpiryUtc(new Date(), targetTenorDays).getTime();

  const probe: LegProbe = {
    side,
    targetStrike,
    actualStrike: null,
    strikeMatchPct: null,
    targetTenorDays,
    actualTenorDays: null,
    bestBidUsd: null,
    bestAskUsd: null,
    spreadPct: null,
    topAskBtc: null,
    depthWithin2pctBtc: null,
    bsModelPriceUsd: null,
    askVsBsRatio: null,
    symbol: null,
    notes: []
  };

  const candidates = deribitInstruments.filter((i) => i.kind === "option" && i.option_type === optionType);
  if (candidates.length === 0) {
    probe.notes.push("no deribit options for type");
    return probe;
  }
  const expiriesMs = Array.from(new Set(candidates.map((i) => i.expiration_timestamp)));
  const closestExpiryMs = findClosestExpiryByMs(targetExpiryMs, expiriesMs);
  if (closestExpiryMs === null) {
    probe.notes.push("no expiries");
    return probe;
  }
  probe.actualTenorDays = (closestExpiryMs - Date.now()) / 86_400_000;

  const tenorMatch = candidates.filter((i) => i.expiration_timestamp === closestExpiryMs);
  const strikes = tenorMatch.map((i) => i.strike);
  const closestStrike = findClosestStrike(targetStrike, strikes);
  if (closestStrike === null) {
    probe.notes.push("no strike");
    return probe;
  }
  probe.actualStrike = closestStrike;
  probe.strikeMatchPct = (closestStrike - targetStrike) / targetStrike;

  const inst = tenorMatch.find((i) => i.strike === closestStrike);
  if (!inst) {
    probe.notes.push("instrument not found");
    return probe;
  }
  probe.symbol = inst.instrument_name;

  const ob = await fetchDeribitOrderbook(inst.instrument_name);
  if (!ob) {
    probe.notes.push("orderbook fetch failed");
    return probe;
  }
  // Deribit option prices are quoted in BTC (fraction of underlying). Convert to USD.
  const ulPx = ob.underlying_price ?? spot;
  if (ob.best_bid_price > 0) probe.bestBidUsd = ob.best_bid_price * ulPx;
  if (ob.best_ask_price > 0) {
    probe.bestAskUsd = ob.best_ask_price * ulPx;
    probe.topAskBtc = ob.best_ask_amount;
  }
  if (probe.bestBidUsd && probe.bestAskUsd && probe.bestBidUsd > 0 && probe.bestAskUsd > 0) {
    const mid = (probe.bestBidUsd + probe.bestAskUsd) / 2;
    probe.spreadPct = ((probe.bestAskUsd - probe.bestBidUsd) / mid) * 100;
    // Bug B fix: depth-within-2% above BEST ASK in Deribit's BTC-fraction units.
    // Deribit option prices are quoted as fraction of BTC; ob.asks levels are
    // [price_btc, qty_btc]. Best-ask × 1.02 gives the buyer-side slippage cap.
    const askLimitBtc = ob.best_ask_price * 1.02;
    let depth = 0;
    for (const level of ob.asks) {
      const [px, qty] = level;
      if (px > askLimitBtc) break;
      depth += qty;
    }
    probe.depthWithin2pctBtc = depth;
  }

  const T = (probe.actualTenorDays ?? targetTenorDays) / 365;
  const bsPrice =
    optionType === "put"
      ? bsPut(spot, closestStrike, T, RFR, ivAnnual)
      : bsCall(spot, closestStrike, T, RFR, ivAnnual);
  probe.bsModelPriceUsd = bsPrice;
  if (probe.bestAskUsd && bsPrice > 0) probe.askVsBsRatio = probe.bestAskUsd / bsPrice;
  return probe;
};

// ─────────────────────────── Cell-level probe ───────────────────────────

const probeCell = async (
  cell: Cell,
  spot: number,
  ivAnnual: number,
  bullishChain: BullishChainResponse,
  deribitInstruments: DeribitInstrument[]
): Promise<CellProbe> => {
  const intrinsicAtTrigger = spot * (cell.triggerPct - cell.hedgePct);
  const baseContracts = cell.payoutUsdc / intrinsicAtTrigger;
  const contractsBtc = Math.ceil(baseContracts / 0.1) * 0.1;

  process.stdout.write(`\n[${cell.cellId}] target P=$${(spot * (1 - cell.hedgePct)).toFixed(0)}, C=$${(spot * (1 + cell.hedgePct)).toFixed(0)}, ${cell.hedgeTenorDays}d, ${contractsBtc.toFixed(2)} BTC\n`);

  // Sequential — Render rate limiting; Deribit also serial to avoid bursts
  const bullishLong = await probeBullishLeg("long_cover_put", spot, cell, bullishChain, ivAnnual);
  const bullishShort = await probeBullishLeg("short_cover_call", spot, cell, bullishChain, ivAnnual);
  const deribitLong = await probeDeribitLeg("long_cover_put", spot, cell, deribitInstruments, ivAnnual);
  const deribitShort = await probeDeribitLeg("short_cover_call", spot, cell, deribitInstruments, ivAnnual);

  // For 6d+ target cells: also probe the longest expiry within ~10d to
  // verify whether longer tenor exists today (vs Sunday-only artifact).
  let bullishLongTenorLong: LegProbe | null = null;
  let bullishLongTenorShort: LegProbe | null = null;
  let deribitLongTenorLong: LegProbe | null = null;
  let deribitLongTenorShort: LegProbe | null = null;
  if (cell.hedgeTenorDays >= 5) {
    // Find a Bullish expiry strictly later than the closest one
    const expiriesMs = bullishChain.expiriesInWindow.map((d) =>
      new Date(`${d}T08:00:00.000Z`).getTime()
    );
    const targetMs = computeTargetExpiryUtc(new Date(), cell.hedgeTenorDays).getTime();
    const longerExpiriesMs = expiriesMs.filter((e) => (e - Date.now()) / 86_400_000 >= 5);
    if (longerExpiriesMs.length > 0) {
      const closestLongerMs = findClosestExpiryByMs(targetMs, longerExpiriesMs);
      if (closestLongerMs !== null) {
        const expDate = new Date(closestLongerMs).toISOString().slice(0, 10);
        bullishLongTenorLong = await probeBullishLeg(
          "long_cover_put",
          spot,
          cell,
          bullishChain,
          ivAnnual,
          expDate
        );
        bullishLongTenorShort = await probeBullishLeg(
          "short_cover_call",
          spot,
          cell,
          bullishChain,
          ivAnnual,
          expDate
        );
      }
    }
    // Deribit: probe a 6d+ expiry directly
    const drTargetMs = targetMs;
    const drCandidates = deribitInstruments.filter(
      (i) =>
        i.kind === "option" &&
        (i.expiration_timestamp - Date.now()) / 86_400_000 >= 5
    );
    const drExpiriesMs = Array.from(new Set(drCandidates.map((i) => i.expiration_timestamp)));
    const drClosestLongerMs = findClosestExpiryByMs(drTargetMs, drExpiriesMs);
    if (drClosestLongerMs !== null) {
      // Build a synthetic cell for the longer-tenor probe
      const longTenorCell = { ...cell, hedgeTenorDays: (drClosestLongerMs - Date.now()) / 86_400_000 };
      // Probe by manually constructing — reuse probeDeribitLeg with the modified
      // tenor; it picks the expiry closest to target (which now matches longer tenor).
      deribitLongTenorLong = await probeDeribitLeg(
        "long_cover_put",
        spot,
        longTenorCell,
        deribitInstruments,
        ivAnnual
      );
      deribitLongTenorShort = await probeDeribitLeg(
        "short_cover_call",
        spot,
        longTenorCell,
        deribitInstruments,
        ivAnnual
      );
    }
  }

  process.stdout.write(
    `  bullish L=${bullishLong.bestAskUsd?.toFixed(0) ?? "n/a"} S=${bullishShort.bestAskUsd?.toFixed(0) ?? "n/a"} | ` +
    `deribit L=${deribitLong.bestAskUsd?.toFixed(0) ?? "n/a"} S=${deribitShort.bestAskUsd?.toFixed(0) ?? "n/a"}` +
    (bullishLongTenorLong || deribitLongTenorLong
      ? ` | LONG-TENOR: B-L=${bullishLongTenorLong?.bestAskUsd?.toFixed(0) ?? "n/a"} D-L=${deribitLongTenorLong?.bestAskUsd?.toFixed(0) ?? "n/a"}`
      : "") +
    "\n"
  );

  const effective = (longProbe: LegProbe, shortProbe: LegProbe): number | null => {
    const askLong = longProbe.bestAskUsd;
    const askShort = shortProbe.bestAskUsd;
    if (askLong === null && askShort === null) return null;
    if (askLong !== null && askShort === null) return askLong * contractsBtc;
    if (askLong === null && askShort !== null) return askShort * contractsBtc;
    return ((askLong! + askShort!) / 2) * contractsBtc;
  };

  const primaryProbeLong = cell.expectedVenuePrimary === "bullish" ? bullishLong : deribitLong;
  const primaryProbeShort = cell.expectedVenuePrimary === "bullish" ? bullishShort : deribitShort;
  const fallbackProbeLong = cell.expectedVenueFallback === "bullish" ? bullishLong : deribitLong;
  const fallbackProbeShort = cell.expectedVenueFallback === "bullish" ? bullishShort : deribitShort;

  const primaryHedgeCost = effective(primaryProbeLong, primaryProbeShort);
  const fallbackHedgeCost = effective(fallbackProbeLong, fallbackProbeShort);

  const warnings: string[] = [];
  if (primaryHedgeCost === null) warnings.push(`PRIMARY (${cell.expectedVenuePrimary}) has no fillable ask`);
  if (fallbackHedgeCost === null) warnings.push(`FALLBACK (${cell.expectedVenueFallback}) has no fillable ask`);
  for (const probe of [bullishLong, bullishShort, deribitLong, deribitShort]) {
    if (probe.strikeMatchPct !== null && Math.abs(probe.strikeMatchPct) > 0.005) {
      warnings.push(
        `${probe.side} on ${probe.symbol ?? "?"}: strike off by ${(probe.strikeMatchPct * 100).toFixed(2)}%`
      );
    }
    if (probe.askVsBsRatio !== null && (probe.askVsBsRatio > 1.4 || probe.askVsBsRatio < 0.7)) {
      warnings.push(
        `${probe.side} on ${probe.symbol}: actual ask is ${probe.askVsBsRatio.toFixed(2)}× BS — calibration gap`
      );
    }
    if (probe.depthWithin2pctBtc !== null && probe.depthWithin2pctBtc < contractsBtc) {
      warnings.push(
        `${probe.side} on ${probe.symbol}: depth-within-2% (${probe.depthWithin2pctBtc.toFixed(2)} BTC) < contracts (${contractsBtc} BTC)`
      );
    }
    for (const note of probe.notes) {
      warnings.push(`${probe.side} on ${probe.symbol ?? "?"}: ${note}`);
    }
  }

  return {
    cell,
    spotUsd: spot,
    ivPct: ivAnnual * 100,
    bullishLong,
    bullishShort,
    deribitLong,
    deribitShort,
    bullishLongTenorLong,
    bullishLongTenorShort,
    deribitLongTenorLong,
    deribitLongTenorShort,
    primaryHedgeCostUsd: primaryHedgeCost,
    fallbackHedgeCostUsd: fallbackHedgeCost,
    contractsBtcPerCover: contractsBtc,
    warnings
  };
};

// ─────────────────────────── Capital ladder ───────────────────────────

type CapitalRow = {
  positionCount: number;
  totalCapitalUsd: number;
  perPositionUsd: number;
  totalContractsBtc: number;
  bullishHeadroom: "OK" | "TIGHT" | "EXCEEDS" | "n/a";
};

const computeCapitalLadder = (probe: CellProbe): CapitalRow[] => {
  const counts = [1, 2, 3, 5, 10, 15, 20, 25];
  const rows: CapitalRow[] = [];
  const perPosition = probe.primaryHedgeCostUsd ?? probe.fallbackHedgeCostUsd ?? 0;
  const contractsPerPosition = probe.contractsBtcPerCover;

  // Bullish observed depth = MIN of long-leg and short-leg depth (worst case for fire-storm)
  const bullishDepthLong = probe.bullishLong.depthWithin2pctBtc;
  const bullishDepthShort = probe.bullishShort.depthWithin2pctBtc;
  const bullishDepth =
    bullishDepthLong === null && bullishDepthShort === null
      ? null
      : Math.min(bullishDepthLong ?? Infinity, bullishDepthShort ?? Infinity);

  for (const n of counts) {
    const totalContracts = n * contractsPerPosition;
    let headroom: "OK" | "TIGHT" | "EXCEEDS" | "n/a" = "n/a";
    if (bullishDepth !== null) {
      headroom =
        bullishDepth < totalContracts * 0.5
          ? "EXCEEDS"
          : bullishDepth < totalContracts
            ? "TIGHT"
            : "OK";
    }
    rows.push({
      positionCount: n,
      totalCapitalUsd: n * perPosition,
      perPositionUsd: perPosition,
      totalContractsBtc: totalContracts,
      bullishHeadroom: headroom
    });
  }
  return rows;
};

// ─────────────────────────── Formatters ───────────────────────────

const fmt$ = (n: number | null): string => (n === null ? "n/a" : `\$${Math.round(n).toLocaleString()}`);
const fmt$2 = (n: number | null): string => (n === null ? "n/a" : `\$${n.toFixed(2)}`);
const fmtPct = (n: number | null, dec = 1): string => (n === null ? "n/a" : `${(n * 100).toFixed(dec)}%`);
const fmtBtc = (n: number | null, dec = 2): string => (n === null ? "n/a" : `${n.toFixed(dec)} BTC`);

// ─────────────────────────── Main ───────────────────────────

const main = async () => {
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("Single-Side Empirical Chain Validator");
  console.log("Bullish: via Render admin endpoints | Deribit: public API");
  console.log("═══════════════════════════════════════════════════════════════════\n");

  const spot = await fetchSpotUsd();
  const dvol = await fetchDvol();
  const ivAnnual = dvol !== null ? dvol / 100 : 0.55;
  console.log(`Spot:       \$${spot.toLocaleString()}`);
  console.log(`DVOL:       ${dvol !== null ? dvol.toFixed(1) : "n/a (defaulting σ=55%)"}`);
  console.log(`σ used:     ${(ivAnnual * 100).toFixed(1)}% annualized\n`);

  console.log(`Fetching Bullish chain via Render (${RENDER_API_URL})...`);
  let bullishChain: BullishChainResponse;
  try {
    bullishChain = await fetchBullishChainFromRender();
  } catch (err: unknown) {
    console.error(`FAILED to fetch Bullish chain via Render: ${(err as Error).message}`);
    console.error("Verify RENDER_API_URL and RENDER_ADMIN_TOKEN are correct.");
    process.exit(1);
  }
  console.log(`Got ${bullishChain.totalBtcOptionMarkets} Bullish BTC option markets.`);
  console.log(`Mainnet: ${bullishChain.bullishMainnet}, Render spot: \$${bullishChain.spotBtcUsdc.toFixed(0)}.`);
  console.log(`Expiries in 30d window: ${bullishChain.expiriesInWindow.join(", ")}`);

  console.log(`\nFetching Deribit instruments via public API...`);
  const deribitInstruments = await fetchDeribitInstruments();
  console.log(`Got ${deribitInstruments.length} Deribit BTC option instruments.\n`);

  const probes: CellProbe[] = [];
  for (const cell of CELLS) {
    probes.push(await probeCell(cell, spot, ivAnnual, bullishChain, deribitInstruments));
  }

  // ─── Build markdown report ───

  const lines: string[] = [];
  lines.push(`# Single-Side Empirical Chain Validation`);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**BTC spot:** \$${spot.toLocaleString()}`);
  lines.push(`**DVOL:** ${dvol !== null ? dvol.toFixed(1) : "n/a"}`);
  lines.push(`**σ used for BS:** ${(ivAnnual * 100).toFixed(1)}% annualized`);
  lines.push(`**Bullish source:** \`${RENDER_API_URL}/volume-cover/admin/bullish-option-chain\` + \`/bullish-orderbook\` (Render-routed, mainnet=${bullishChain.bullishMainnet})`);
  lines.push(`**Deribit source:** \`https://www.deribit.com/api/v2/public/...\` (public, no auth)`);
  lines.push("");
  lines.push(`> Live chain read against the Phase 0 cell matrix.`);
  lines.push(`> Bullish goes through the existing live admin endpoints (read-only,`);
  lines.push(`> admin-token-gated, zero new code on the live API).`);
  lines.push(`> Deribit goes through the public API directly.`);
  lines.push(`> Re-run \`tsx scripts/backtest/singleSide/empiricalChainValidator.ts\` to refresh.`);
  lines.push("");

  // ─── Section 1: Strike + tenor availability ───
  lines.push(`## 1. Strike + tenor availability per cell`);
  lines.push("");
  lines.push(`Per cell × venue × leg: target strike, nearest listed strike, tenor offset.`);
  lines.push(`LONG-cover = Atticus buys PUT below spot; SHORT-cover = Atticus buys CALL above spot.`);
  lines.push("");
  for (const probe of probes) {
    lines.push(`### ${probe.cell.cellId} (target tenor ${probe.cell.hedgeTenorDays}d, contracts ${probe.contractsBtcPerCover.toFixed(2)} BTC)`);
    lines.push("");
    lines.push(`| Venue | Leg | Target strike | Actual strike | Strike Δ% | Tenor (d) | Symbol |`);
    lines.push(`|---|---|---:|---:|---:|---:|---|`);
    const rows: Array<[string, LegProbe]> = [
      ["bullish", probe.bullishLong],
      ["bullish", probe.bullishShort],
      ["deribit", probe.deribitLong],
      ["deribit", probe.deribitShort]
    ];
    for (const [venue, p] of rows) {
      lines.push(
        `| ${venue} | ${p.side} | \$${p.targetStrike.toFixed(0)} | ${p.actualStrike !== null ? `\$${p.actualStrike.toFixed(0)}` : "—"} | ${p.strikeMatchPct !== null ? fmtPct(p.strikeMatchPct, 2) : "n/a"} | ${p.actualTenorDays?.toFixed(2) ?? "n/a"} | ${p.symbol ?? "—"} |`
      );
    }
    lines.push("");
  }

  // ─── Section 2: Bid/ask + depth + BS-vs-actual ───
  lines.push(`## 2. Bid/ask + depth + BS-vs-actual`);
  lines.push("");
  for (const probe of probes) {
    lines.push(`### ${probe.cell.cellId}`);
    lines.push("");
    lines.push(`| Venue | Leg | Bid | Ask | Spread | Top ask BTC | Depth ≤2% | BS modeled | Ask/BS |`);
    lines.push(`|---|---|---:|---:|---:|---:|---:|---:|---:|`);
    const rows: Array<[string, LegProbe]> = [
      ["bullish", probe.bullishLong],
      ["bullish", probe.bullishShort],
      ["deribit", probe.deribitLong],
      ["deribit", probe.deribitShort]
    ];
    for (const [venue, p] of rows) {
      lines.push(
        `| ${venue} | ${p.side} | ${fmt$2(p.bestBidUsd)} | ${fmt$2(p.bestAskUsd)} | ${p.spreadPct?.toFixed(1) ?? "n/a"}% | ${fmtBtc(p.topAskBtc)} | ${fmtBtc(p.depthWithin2pctBtc)} | ${fmt$2(p.bsModelPriceUsd)} | ${p.askVsBsRatio?.toFixed(2) ?? "n/a"} |`
      );
    }
    lines.push("");
    if (probe.warnings.length > 0) {
      lines.push(`⚠️ **Warnings:**`);
      for (const w of probe.warnings) lines.push(`- ${w}`);
      lines.push("");
    }
  }

  // ─── Section 2.5: Long-tenor probe for 6d cells ───
  const cellsWithLongTenorProbe = probes.filter(
    (p) =>
      p.bullishLongTenorLong || p.bullishLongTenorShort || p.deribitLongTenorLong || p.deribitLongTenorShort
  );
  if (cellsWithLongTenorProbe.length > 0) {
    lines.push(`## 2.5 Tenor availability — explicit longer-expiry probe (≥5d)`);
    lines.push("");
    lines.push(`For target-tenor ≥5d cells, probes the closest available expiry that is`);
    lines.push(`strictly ≥5 days from now, on both venues. Answers: "is the 6d tenor we`);
    lines.push(`designed against actually listable today, or is the matrix only feasible`);
    lines.push(`with weekday-dependent shorter tenor?"`);
    lines.push("");
    lines.push(`| Cell | Venue | Leg | Symbol | Tenor (d) | Bid | Ask | Depth ≤2% above ask |`);
    lines.push(`|---|---|---|---|---:|---:|---:|---:|`);
    for (const probe of cellsWithLongTenorProbe) {
      const rows: Array<[string, LegProbe | null]> = [
        ["bullish", probe.bullishLongTenorLong],
        ["bullish", probe.bullishLongTenorShort],
        ["deribit", probe.deribitLongTenorLong],
        ["deribit", probe.deribitLongTenorShort]
      ];
      for (const [venue, p] of rows) {
        if (!p) continue;
        lines.push(
          `| ${probe.cell.cellId} | ${venue} | ${p.side} | ${p.symbol ?? "—"} | ${p.actualTenorDays?.toFixed(2) ?? "n/a"} | ${fmt$2(p.bestBidUsd)} | ${fmt$2(p.bestAskUsd)} | ${fmtBtc(p.depthWithin2pctBtc)} |`
        );
      }
    }
    lines.push("");
  }

  // ─── Section 3: Effective hedge cost per cover ───
  lines.push(`## 3. Effective hedge cost per cover`);
  lines.push("");
  lines.push(`Cost = avg(long-leg ask, short-leg ask) × contracts. Direction is`);
  lines.push(`50/50 random (Foxify chooses), so per-cover hedge cost is the symmetric average.`);
  lines.push(`Compares to BS-modeled cost used in the daily backtest (\`coreEngine.ts\` with 7% uplift).`);
  lines.push("");
  lines.push(`| Cell | Contracts | Primary | Primary cost | Fallback | Fallback cost | BS-modeled | Empirical/BS |`);
  lines.push(`|---|---:|---|---:|---|---:|---:|---:|`);
  for (const probe of probes) {
    const cell = probe.cell;
    const T = cell.hedgeTenorDays / 365;
    const bsLong = bsPut(probe.spotUsd, probe.spotUsd * (1 - cell.hedgePct), T, RFR, ivAnnual);
    const bsShort = bsCall(probe.spotUsd, probe.spotUsd * (1 + cell.hedgePct), T, RFR, ivAnnual);
    const bsCost = ((bsLong + bsShort) / 2) * 1.07 * probe.contractsBtcPerCover;
    const empVsBs =
      probe.primaryHedgeCostUsd !== null && bsCost > 0
        ? probe.primaryHedgeCostUsd / bsCost
        : null;
    lines.push(
      `| ${cell.cellId} | ${probe.contractsBtcPerCover.toFixed(2)} | ${cell.expectedVenuePrimary} | ${fmt$(probe.primaryHedgeCostUsd)} | ${cell.expectedVenueFallback} | ${fmt$(probe.fallbackHedgeCostUsd)} | ${fmt$(bsCost)} | ${empVsBs?.toFixed(2) ?? "n/a"} |`
    );
  }
  lines.push("");

  // ─── Section 4: Capital ladder per cell ───
  lines.push(`## 4. Capital ladder (1 → 25 concurrent positions)`);
  lines.push("");
  lines.push(`Capital deployed = ACTUAL ask × contracts × position-count. LONG options only,`);
  lines.push(`no margin needed. \`Headroom\` flags one-direction concurrent BTC outstanding`);
  lines.push(`vs Bullish observed depth-within-2%-of-mid (single-direction fire-storm).`);
  lines.push("");
  for (const probe of probes) {
    lines.push(`### ${probe.cell.cellId}`);
    lines.push("");
    const ladder = computeCapitalLadder(probe);
    const perPos = ladder[0]?.perPositionUsd ?? 0;
    lines.push(`Per-position capital: **${fmt$(perPos)}** | Per-position contracts: **${probe.contractsBtcPerCover.toFixed(2)} BTC**`);
    lines.push(`Bullish depth-within-2%: long=${fmtBtc(probe.bullishLong.depthWithin2pctBtc)}, short=${fmtBtc(probe.bullishShort.depthWithin2pctBtc)}`);
    lines.push("");
    lines.push(`| # positions | Total capital | Total BTC | Bullish headroom |`);
    lines.push(`|---:|---:|---:|---|`);
    for (const r of ladder) {
      const headroomLabel =
        r.bullishHeadroom === "EXCEEDS"
          ? "❌ EXCEEDS depth"
          : r.bullishHeadroom === "TIGHT"
            ? "⚠️ TIGHT"
            : r.bullishHeadroom === "OK"
              ? "✅ OK"
              : "—";
      lines.push(
        `| ${r.positionCount} | ${fmt$(r.totalCapitalUsd)} | ${fmtBtc(r.totalContractsBtc, 1)} | ${headroomLabel} |`
      );
    }
    lines.push("");
  }

  // ─── Section 5: go/no-go ───
  lines.push(`## 5. Phase 0 go/no-go per cell`);
  lines.push("");
  lines.push(`| Cell | Strike avail (B/D) | Quote avail (B/D) | Empirical/BS | Depth at 25 pos | Verdict |`);
  lines.push(`|---|:-:|:-:|---:|:-:|:-:|`);
  for (const probe of probes) {
    const blStrike = probe.bullishLong.actualStrike !== null && probe.bullishShort.actualStrike !== null;
    const drStrike = probe.deribitLong.actualStrike !== null && probe.deribitShort.actualStrike !== null;
    const blPx = probe.bullishLong.bestAskUsd !== null && probe.bullishShort.bestAskUsd !== null;
    const drPx = probe.deribitLong.bestAskUsd !== null && probe.deribitShort.bestAskUsd !== null;
    const T = probe.cell.hedgeTenorDays / 365;
    const bsLong = bsPut(probe.spotUsd, probe.spotUsd * (1 - probe.cell.hedgePct), T, RFR, ivAnnual);
    const bsShort = bsCall(probe.spotUsd, probe.spotUsd * (1 + probe.cell.hedgePct), T, RFR, ivAnnual);
    const bsCost = ((bsLong + bsShort) / 2) * 1.07 * probe.contractsBtcPerCover;
    const gap =
      probe.primaryHedgeCostUsd && bsCost > 0
        ? ((probe.primaryHedgeCostUsd - bsCost) / bsCost) * 100
        : null;
    const total25Btc = probe.contractsBtcPerCover * 25;
    const bullishDepth = Math.min(
      probe.bullishLong.depthWithin2pctBtc ?? Infinity,
      probe.bullishShort.depthWithin2pctBtc ?? Infinity
    );
    const depthAt25 = bullishDepth >= total25Btc ? "✅" : bullishDepth >= total25Btc * 0.5 ? "⚠️" : "❌";
    const verdict =
      blStrike && (blPx || drPx) && (gap === null || Math.abs(gap) < 35) && depthAt25 !== "❌"
        ? "✅ GO"
        : !blStrike && !drStrike
          ? "❌ NO STRIKE"
          : !blPx && !drPx
            ? "❌ NO LIQUIDITY"
            : "⚠️ REVIEW";
    lines.push(
      `| ${probe.cell.cellId} | ${blStrike ? "✅" : "❌"}/${drStrike ? "✅" : "❌"} | ${blPx ? "✅" : "❌"}/${drPx ? "✅" : "❌"} | ${gap !== null ? `${gap > 0 ? "+" : ""}${gap.toFixed(0)}%` : "n/a"} | ${depthAt25} | ${verdict} |`
    );
  }
  lines.push("");

  lines.push(`---`);
  lines.push("");
  lines.push(`*Generated by services/api/scripts/backtest/singleSide/empiricalChainValidator.ts*`);
  lines.push(`*This is a SNAPSHOT — markets move. Re-run before any cutover decision.*`);

  const outPath = path.resolve(process.cwd(), "../..", "docs/SINGLE_SIDE_EMPIRICAL_VALIDATION.md");
  await fs.writeFile(outPath, lines.join("\n"));
  console.log(`\n✓ Empirical validation report written: ${outPath}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
