/**
 * Pricing-capture core — Phase A (pure, offline, READ/QUOTE-ONLY). Turns normalized venue snapshots
 * into the dataset that finalizes credit-sizing, feasibility, and the hedge-architecture decision:
 *   - option HALF-SPREADS at the solver's actual WING strikes (floor ~3–5% OTM, cap ~1–2.5% OTM),
 *     PER TENOR (prioritizing daily / ~24h), and whether the venue LISTS a daily BTC option,
 *   - perp TOP-OF-BOOK spread + DEPTH/IMPACT at the residual CLIP sizes implied by the ramp tiers.
 *
 * Pure: the live fetchers (liveFetchers.ts) normalize each venue into these shapes and inject them,
 * so this is deterministic + testable on fixtures. No trading, no auth, no I/O here.
 */

export type Venue = "bullish" | "deribit" | "okx";
export type OptType = "put" | "call";

/** A normalized option quote (premium in USDC per BTC, both venues converted up front). */
export type OptionQuote = {
  strike: number;
  optType: OptType;
  expiryMs: number;
  bidUsdcPerBtc: number | null;
  askUsdcPerBtc: number | null;
};

export type VenueOptionSnapshot = {
  venue: Venue;
  spot: number;
  nowMs: number;
  options: OptionQuote[];
};

/** A normalized perp order-book level: price in USD, available size in USD NOTIONAL. */
export type PerpLevel = { priceUsd: number; sizeUsd: number };

export type VenuePerpSnapshot = {
  venue: Venue;
  spot: number;
  nowMs: number;
  bids: PerpLevel[]; // descending price
  asks: PerpLevel[]; // ascending price
};

// ── Option wing-spread capture ────────────────────────────────────────────────

export type WingSpreadRow = {
  venue: Venue;
  tenorDays: number;        // the nearest listed expiry's days-to-expiry
  expiryMs: number;
  wing: "floor_put" | "cap_call";
  targetMoneynessPct: number; // signed OTM target (put below spot, call above)
  strike: number;
  bidUsdcPerBtc: number | null;
  askUsdcPerBtc: number | null;
  midUsdcPerBtc: number | null;
  /** HALF-spread as a fraction of mid premium — what the pricer's legHalfSpread model needs. */
  halfSpreadRelMid: number | null;
  halfSpreadUsdcPerBtc: number | null;
};

export type WingCaptureConfig = {
  /** Floor (put) OTM targets, e.g. [0.03, 0.04, 0.05]. */
  floorPcts: number[];
  /** Cap (call) OTM targets, e.g. [0.01, 0.015, 0.02, 0.025]. */
  capPcts: number[];
  /** Tenors to capture, days. Prioritize daily/~24h first. */
  tenorsDays: number[];
  /** A listed expiry within this many hours of 24h counts as "daily". */
  dailyMaxHours?: number;
};

const pickNearestExpiry = (expiries: number[], nowMs: number, tenorDays: number): number | null => {
  const future = expiries.filter((e) => e > nowMs);
  if (future.length === 0) return null;
  const target = nowMs + tenorDays * 86_400_000;
  return future.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
};

const nearestStrike = (opts: OptionQuote[], optType: OptType, expiryMs: number, target: number): OptionQuote | null => {
  const cands = opts.filter((o) => o.optType === optType && o.expiryMs === expiryMs);
  if (cands.length === 0) return null;
  return cands.sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))[0];
};

/** Whether this venue lists a daily (~24h) BTC option — gates tenor-aligned hedging. */
export const listsDailyOption = (snap: VenueOptionSnapshot, dailyMaxHours = 30): boolean => {
  const lo = snap.nowMs + (24 - (dailyMaxHours - 24)) * 3_600_000; // ~18h
  const hi = snap.nowMs + dailyMaxHours * 3_600_000;
  return snap.options.some((o) => o.expiryMs >= Math.min(lo, snap.nowMs + 12 * 3_600_000) && o.expiryMs <= hi);
};

export const captureWingSpreads = (snap: VenueOptionSnapshot, cfg: WingCaptureConfig): WingSpreadRow[] => {
  const rows: WingSpreadRow[] = [];
  const expiries = [...new Set(snap.options.map((o) => o.expiryMs))];
  for (const tenorDays of cfg.tenorsDays) {
    const expiryMs = pickNearestExpiry(expiries, snap.nowMs, tenorDays);
    if (expiryMs == null) continue;
    const actualTenor = +((expiryMs - snap.nowMs) / 86_400_000).toFixed(2);
    const wings: Array<{ wing: WingSpreadRow["wing"]; optType: OptType; pcts: number[]; sign: 1 | -1 }> = [
      { wing: "floor_put", optType: "put", pcts: cfg.floorPcts, sign: -1 },
      { wing: "cap_call", optType: "call", pcts: cfg.capPcts, sign: 1 }
    ];
    for (const w of wings) {
      for (const pct of w.pcts) {
        const target = snap.spot * (1 + w.sign * pct);
        const q = nearestStrike(snap.options, w.optType, expiryMs, target);
        if (!q) continue;
        const bid = q.bidUsdcPerBtc;
        const ask = q.askUsdcPerBtc;
        const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
        const halfAbs = bid != null && ask != null ? (ask - bid) / 2 : null;
        const halfRel = halfAbs != null && mid != null && mid > 0 ? halfAbs / mid : null;
        rows.push({
          venue: snap.venue,
          tenorDays: actualTenor,
          expiryMs,
          wing: w.wing,
          targetMoneynessPct: w.sign * pct,
          strike: q.strike,
          bidUsdcPerBtc: bid != null ? +bid.toFixed(2) : null,
          askUsdcPerBtc: ask != null ? +ask.toFixed(2) : null,
          midUsdcPerBtc: mid != null ? +mid.toFixed(2) : null,
          halfSpreadRelMid: halfRel != null ? +halfRel.toFixed(4) : null,
          halfSpreadUsdcPerBtc: halfAbs != null ? +halfAbs.toFixed(2) : null
        });
      }
    }
  }
  return rows;
};

// ── Perp depth / impact capture ───────────────────────────────────────────────

export type PerpImpactRow = {
  venue: Venue;
  clipUsd: number;
  side: "buy" | "sell";
  topOfBookSpreadBps: number | null;
  /** VWAP slippage vs mid to fill the clip, in bps. null if the book can't fill the clip. */
  impactBps: number | null;
  filledUsd: number;
  bookExhausted: boolean;
};

const bestPrices = (snap: VenuePerpSnapshot): { bid: number | null; ask: number | null; mid: number | null } => {
  const bid = snap.bids[0]?.priceUsd ?? null;
  const ask = snap.asks[0]?.priceUsd ?? null;
  const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
  return { bid, ask, mid };
};

/** Walk the book to VWAP-fill `clipUsd`; impact = (vwap − mid)/mid (buy) or (mid − vwap)/mid (sell). */
export const capturePerpImpact = (snap: VenuePerpSnapshot, clipsUsd: number[]): PerpImpactRow[] => {
  const { bid, ask, mid } = bestPrices(snap);
  const topBps = bid != null && ask != null && mid != null && mid > 0 ? ((ask - bid) / mid) * 1e4 : null;
  const rows: PerpImpactRow[] = [];
  for (const clipUsd of clipsUsd) {
    for (const side of ["buy", "sell"] as const) {
      const levels = side === "buy" ? snap.asks : snap.bids;
      let remaining = clipUsd;
      let cost = 0;
      let filled = 0;
      for (const lvl of levels) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, lvl.sizeUsd);
        cost += take * lvl.priceUsd;
        filled += take;
        remaining -= take;
      }
      const exhausted = remaining > 1e-6;
      const vwap = filled > 0 ? cost / filled : null;
      let impactBps: number | null = null;
      if (vwap != null && mid != null && mid > 0) {
        impactBps = side === "buy" ? ((vwap - mid) / mid) * 1e4 : ((mid - vwap) / mid) * 1e4;
      }
      rows.push({
        venue: snap.venue,
        clipUsd,
        side,
        topOfBookSpreadBps: topBps != null ? +topBps.toFixed(3) : null,
        impactBps: impactBps != null ? +impactBps.toFixed(3) : null,
        filledUsd: +filled.toFixed(2),
        bookExhausted: exhausted
      });
    }
  }
  return rows;
};

// ── Combined keyed dataset ────────────────────────────────────────────────────

export type CaptureDataset = {
  capturedAtMs: number;
  spotUsd: number;
  options: WingSpreadRow[];
  dailyListing: Record<Venue, boolean>;
  perp: PerpImpactRow[];
  venuesSeen: Venue[];
  notes: string[];
};

export const buildDataset = (
  optionSnaps: VenueOptionSnapshot[],
  perpSnaps: VenuePerpSnapshot[],
  wingCfg: WingCaptureConfig,
  clipsUsd: number[]
): CaptureDataset => {
  const options = optionSnaps.flatMap((s) => captureWingSpreads(s, wingCfg));
  const perp = perpSnaps.flatMap((s) => capturePerpImpact(s, clipsUsd));
  const dailyListing = {} as Record<Venue, boolean>;
  for (const s of optionSnaps) dailyListing[s.venue] = listsDailyOption(s, wingCfg.dailyMaxHours);
  const venuesSeen = [...new Set([...optionSnaps.map((s) => s.venue), ...perpSnaps.map((s) => s.venue)])];
  const spotUsd = optionSnaps[0]?.spot ?? perpSnaps[0]?.spot ?? 0;
  return {
    capturedAtMs: Date.now(),
    spotUsd,
    options,
    dailyListing,
    perp,
    venuesSeen,
    notes: [
      "READ/QUOTE-ONLY capture. Half-spreads at WING strikes per tenor; perp impact at ramp clip sizes.",
      "dailyListing gates tenor-aligned back-to-back hedging (Bullish daily BTC option presence)."
    ]
  };
};
