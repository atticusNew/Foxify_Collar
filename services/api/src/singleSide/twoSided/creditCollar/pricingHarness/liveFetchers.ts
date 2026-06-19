/**
 * Live venue fetchers — READ/QUOTE-ONLY public market data (NO API keys, NO trading). Runs on
 * Render where there is venue connectivity. Each fetcher normalizes a venue into the capture shapes
 * (VenueOptionSnapshot / VenuePerpSnapshot) and is resilient: on failure it returns an empty/partial
 * snapshot + an error string, so the harness proceeds with whatever venues responded.
 *
 * NOTE: these hit public endpoints only. Validate live on Render — they cannot be exercised from an
 * offline sandbox. The pure capture/report/routing core is fully tested on fixtures.
 */

import type { OptionQuote, PerpLevel, Venue, VenueOptionSnapshot, VenuePerpSnapshot } from "./capture";

const TIMEOUT_MS = Number(process.env.HARNESS_FETCH_TIMEOUT_MS ?? "8000");

const getJson = async (url: string): Promise<unknown> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
};

type FetchResult<T> = { ok: boolean; error?: string; snapshot: T };

const nearTenors = (expiries: number[], nowMs: number, tenorsDays: number[], keepPerTenor = 1): Set<number> => {
  const future = expiries.filter((e) => e > nowMs);
  const keep = new Set<number>();
  for (const t of tenorsDays) {
    const target = nowMs + t * 86_400_000;
    const sorted = [...future].sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
    for (const e of sorted.slice(0, keepPerTenor)) keep.add(e);
  }
  return keep;
};

const strikesNearWings = (strikes: number[], spot: number, floorPcts: number[], capPcts: number[]): Set<number> => {
  const keep = new Set<number>();
  const targets = [...floorPcts.map((p) => spot * (1 - p)), ...capPcts.map((p) => spot * (1 + p))];
  for (const tgt of targets) {
    const nearest = [...strikes].sort((a, b) => Math.abs(a - tgt) - Math.abs(b - tgt)).slice(0, 2);
    for (const s of nearest) keep.add(s);
  }
  return keep;
};

// ── Deribit (public; one call gives the whole option book summary) ────────────

const parseDeribitOption = (name: string): { strike: number; optType: "put" | "call"; expiryMs: number } | null => {
  const m = name.match(/^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-([CP])$/);
  if (!m) return null;
  const months: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const mo = months[m[2]];
  if (mo == null) return null;
  const expiryMs = Date.UTC(2000 + Number(m[3]), mo, Number(m[1]), 8, 0, 0);
  return { strike: Number(m[4]), optType: m[5] === "C" ? "call" : "put", expiryMs };
};

export const fetchDeribitOptions = async (
  base = process.env.DERIBIT_REST_BASE ?? "https://www.deribit.com/api/v2"
): Promise<FetchResult<VenueOptionSnapshot>> => {
  const nowMs = Date.now();
  try {
    const idx = (await getJson(`${base}/public/get_index_price?index_name=btc_usd`)) as { result?: { index_price?: number } };
    const spot = Number(idx.result?.index_price ?? 0);
    const sum = (await getJson(`${base}/public/get_book_summary_by_currency?currency=BTC&kind=option`)) as {
      result?: Array<{ instrument_name?: string; bid_price?: number | null; ask_price?: number | null }>;
    };
    const options: OptionQuote[] = [];
    for (const r of sum.result ?? []) {
      const parsed = parseDeribitOption(String(r.instrument_name ?? ""));
      if (!parsed || parsed.expiryMs <= nowMs) continue;
      options.push({
        strike: parsed.strike,
        optType: parsed.optType,
        expiryMs: parsed.expiryMs,
        bidUsdcPerBtc: r.bid_price != null ? Number(r.bid_price) * spot : null, // Deribit option prices are in BTC
        askUsdcPerBtc: r.ask_price != null ? Number(r.ask_price) * spot : null
      });
    }
    return { ok: true, snapshot: { venue: "deribit", spot, nowMs, options } };
  } catch (e) {
    return { ok: false, error: (e as Error).message, snapshot: { venue: "deribit", spot: 0, nowMs, options: [] } };
  }
};

export const fetchDeribitPerp = async (
  base = process.env.DERIBIT_REST_BASE ?? "https://www.deribit.com/api/v2"
): Promise<FetchResult<VenuePerpSnapshot>> => {
  const nowMs = Date.now();
  try {
    // depth=1000 (a valid Deribit step) so $5–50m clip impact is measurable, not book-exhausted.
    const ob = (await getJson(`${base}/public/get_order_book?instrument_name=BTC-PERPETUAL&depth=1000`)) as {
      result?: { bids?: number[][]; asks?: number[][]; index_price?: number };
    };
    const spot = Number(ob.result?.index_price ?? 0);
    // Deribit BTC-PERPETUAL order-book amounts are in USD notional.
    const bids: PerpLevel[] = (ob.result?.bids ?? []).map((l) => ({ priceUsd: Number(l[0]), sizeUsd: Number(l[1]) }));
    const asks: PerpLevel[] = (ob.result?.asks ?? []).map((l) => ({ priceUsd: Number(l[0]), sizeUsd: Number(l[1]) }));
    return { ok: true, snapshot: { venue: "deribit", spot, nowMs, bids, asks } };
  } catch (e) {
    return { ok: false, error: (e as Error).message, snapshot: { venue: "deribit", spot: 0, nowMs, bids: [], asks: [] } };
  }
};

// ── OKX (public; list instruments then books for the wing strikes only) ───────

const parseOkxOption = (instId: string): { strike: number; optType: "put" | "call"; expiryMs: number } | null => {
  const m = instId.match(/^BTC-USD-(\d{2})(\d{2})(\d{2})-(\d+)-([CP])$/);
  if (!m) return null;
  const expiryMs = Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3]), 8, 0, 0);
  return { strike: Number(m[4]), optType: m[5] === "C" ? "call" : "put", expiryMs };
};

export const fetchOkxOptions = async (
  wing: { floorPcts: number[]; capPcts: number[]; tenorsDays: number[] },
  base = process.env.OKX_REST_BASE ?? "https://www.okx.com"
): Promise<FetchResult<VenueOptionSnapshot>> => {
  const nowMs = Date.now();
  try {
    const tk = (await getJson(`${base}/api/v5/market/ticker?instId=BTC-USDT`)) as { data?: Array<{ last?: string }> };
    const spot = Number(tk.data?.[0]?.last ?? 0);
    const instr = (await getJson(`${base}/api/v5/public/instruments?instType=OPTION&uly=BTC-USD`)) as { data?: Array<{ instId?: string }> };
    const parsed = (instr.data ?? [])
      .map((d) => ({ instId: String(d.instId ?? ""), p: parseOkxOption(String(d.instId ?? "")) }))
      .filter((x): x is { instId: string; p: { strike: number; optType: "put" | "call"; expiryMs: number } } => x.p != null && x.p.expiryMs > nowMs);
    const keepExp = nearTenors(parsed.map((x) => x.p.expiryMs), nowMs, wing.tenorsDays);
    const keepStrikes = strikesNearWings(parsed.map((x) => x.p.strike), spot, wing.floorPcts, wing.capPcts);
    const targets = parsed.filter((x) => keepExp.has(x.p.expiryMs) && keepStrikes.has(x.p.strike));
    const options: OptionQuote[] = [];
    for (const t of targets) {
      const book = (await getJson(`${base}/api/v5/market/books?instId=${t.instId}&sz=1`)) as { data?: Array<{ bids?: string[][]; asks?: string[][] }> };
      const top = book.data?.[0];
      const bidBtc = top?.bids?.[0]?.[0] != null ? Number(top.bids[0][0]) : null;
      const askBtc = top?.asks?.[0]?.[0] != null ? Number(top.asks[0][0]) : null;
      options.push({
        strike: t.p.strike, optType: t.p.optType, expiryMs: t.p.expiryMs,
        bidUsdcPerBtc: bidBtc != null ? bidBtc * spot : null,
        askUsdcPerBtc: askBtc != null ? askBtc * spot : null
      });
    }
    return { ok: true, snapshot: { venue: "okx", spot, nowMs, options } };
  } catch (e) {
    return { ok: false, error: (e as Error).message, snapshot: { venue: "okx", spot: 0, nowMs, options: [] } };
  }
};

export const fetchOkxPerp = async (
  base = process.env.OKX_REST_BASE ?? "https://www.okx.com"
): Promise<FetchResult<VenuePerpSnapshot>> => {
  const nowMs = Date.now();
  try {
    const instId = process.env.OKX_PERP_INSTID ?? "BTC-USDT-SWAP";
    const ctVal = Number(process.env.OKX_PERP_CT_VAL ?? "0.01"); // BTC per contract for BTC-USDT-SWAP
    const book = (await getJson(`${base}/api/v5/market/books-full?instId=${instId}&sz=400`).catch(() => getJson(`${base}/api/v5/market/books?instId=${instId}&sz=400`))) as { data?: Array<{ bids?: string[][]; asks?: string[][] }> };
    const top = book.data?.[0];
    const toLevels = (rows?: string[][]): PerpLevel[] =>
      (rows ?? []).map((l) => {
        const priceUsd = Number(l[0]);
        const contracts = Number(l[1]);
        return { priceUsd, sizeUsd: contracts * ctVal * priceUsd };
      });
    const bids = toLevels(top?.bids);
    const asks = toLevels(top?.asks);
    const spot = bids[0]?.priceUsd && asks[0]?.priceUsd ? (bids[0].priceUsd + asks[0].priceUsd) / 2 : bids[0]?.priceUsd ?? 0;
    return { ok: true, snapshot: { venue: "okx", spot, nowMs, bids, asks } };
  } catch (e) {
    return { ok: false, error: (e as Error).message, snapshot: { venue: "okx", spot: 0, nowMs, bids: [], asks: [] } };
  }
};

// ── Bullish (public /markets discovery + hybrid orderbook; USDC-quoted) ───────
// Schema matches the pilot's Bullish client (bullish.ts): markets carry marketType / optionType /
// optionStrikePrice / expiryDatetime / underlyingBaseSymbol; orderbook at
// /trading-api/v1/markets/:symbol/orderbook/hybrid. Bullish option premia are USDC per BTC (no ×spot).

export type BullishMarketRaw = {
  symbol?: string;
  marketType?: string;
  optionType?: string;
  optionStrikePrice?: string;
  expiryDatetime?: string;
  underlyingBaseSymbol?: string;
  marketEnabled?: boolean;
};

const ORDERBOOK_TEMPLATE = process.env.BULLISH_ORDERBOOK_PATH_TEMPLATE ?? "/trading-api/v1/markets/:symbol/orderbook/hybrid";

/** Normalize a Bullish orderbook side: array of {price,quantity} objects OR a flat [p,q,p,q,…]. Pure. */
export const normalizeBullishLevels = (value: unknown): Array<{ price: number; quantity: number }> => {
  if (!Array.isArray(value) || value.length === 0) return [];
  if (typeof value[0] === "object" && value[0] !== null) {
    // Bullish hybrid orderbook levels are { price, priceLevelQuantity, type }. Accept common aliases.
    return (value as Array<{ price?: string | number; priceLevelQuantity?: string | number; quantity?: string | number; size?: string | number }>)
      .map((l) => ({ price: Number(l.price), quantity: Number(l.priceLevelQuantity ?? l.quantity ?? l.size) }))
      .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.quantity) && l.price > 0);
  }
  const flat = (value as Array<string | number>).map((x) => Number(x));
  const out: Array<{ price: number; quantity: number }> = [];
  for (let i = 0; i + 1 < flat.length; i += 2) if (flat[i] > 0) out.push({ price: flat[i], quantity: flat[i + 1] });
  return out;
};

/** Pure: filter Bullish /markets to BTC OPTION markets + parse strike/type/expiry. */
export const parseBullishBtcOptionMarkets = (
  records: BullishMarketRaw[]
): Array<{ symbol: string; strike: number; optType: "put" | "call"; expiryMs: number }> => {
  const out: Array<{ symbol: string; strike: number; optType: "put" | "call"; expiryMs: number }> = [];
  for (const r of records) {
    const isOption = /OPTION/i.test(String(r.marketType ?? "")) || (r.optionType != null && r.optionStrikePrice != null);
    const isBtc = String(r.underlyingBaseSymbol ?? "").toUpperCase() === "BTC" || /^BTC/i.test(String(r.symbol ?? ""));
    if (!isOption || !isBtc) continue;
    if (r.marketEnabled === false) continue;
    const strike = Number(r.optionStrikePrice);
    const ot = String(r.optionType ?? "").toUpperCase();
    const optType: "put" | "call" | null = ot.startsWith("C") ? "call" : ot.startsWith("P") ? "put" : null;
    const expiryMs = r.expiryDatetime ? Date.parse(String(r.expiryDatetime)) : NaN;
    if (!r.symbol || !(strike > 0) || optType == null || !Number.isFinite(expiryMs)) continue;
    out.push({ symbol: r.symbol, strike, optType, expiryMs });
  }
  return out;
};

export const fetchBullishMarkets = async (base = process.env.BULLISH_REST_BASE ?? "https://api.exchange.bullish.com"): Promise<BullishMarketRaw[]> => {
  const raw = (await getJson(`${base}/trading-api/v1/markets`)) as BullishMarketRaw[] | { data?: BullishMarketRaw[] };
  return Array.isArray(raw) ? raw : raw.data ?? [];
};

const bullishOrderbook = async (base: string, symbol: string): Promise<{ bid: number | null; ask: number | null; bids: PerpLevel[]; asks: PerpLevel[] }> => {
  const path = ORDERBOOK_TEMPLATE.replace(":symbol", encodeURIComponent(symbol));
  const ob = (await getJson(`${base}${path}`)) as { bids?: unknown; asks?: unknown };
  const bidsN = normalizeBullishLevels(ob.bids);
  const asksN = normalizeBullishLevels(ob.asks);
  return {
    bid: bidsN[0]?.price ?? null,
    ask: asksN[0]?.price ?? null,
    bids: bidsN.map((l) => ({ priceUsd: l.price, sizeUsd: l.quantity * l.price })),
    asks: asksN.map((l) => ({ priceUsd: l.price, sizeUsd: l.quantity * l.price }))
  };
};

export const fetchBullishOptions = async (
  wing: { floorPcts: number[]; capPcts: number[]; tenorsDays: number[] },
  referenceSpot: number,
  records?: BullishMarketRaw[],
  base = process.env.BULLISH_REST_BASE ?? "https://api.exchange.bullish.com"
): Promise<FetchResult<VenueOptionSnapshot> & { dailyListingObserved: boolean }> => {
  const nowMs = Date.now();
  try {
    const recs = records ?? (await fetchBullishMarkets(base));
    const parsed = parseBullishBtcOptionMarkets(recs).filter((o) => o.expiryMs > nowMs);
    if (parsed.length === 0) {
      return { ok: false, error: "no_bullish_btc_option_markets", dailyListingObserved: false, snapshot: { venue: "bullish", spot: referenceSpot, nowMs, options: [] } };
    }
    const dailyListingObserved = parsed.some((o) => o.expiryMs <= nowMs + 30 * 3_600_000);
    const spot = referenceSpot > 0 ? referenceSpot : 0;
    // Quote only the symbols near the wing strikes × target tenors (limit live orderbook calls).
    const keepExp = nearTenors([...new Set(parsed.map((o) => o.expiryMs))], nowMs, wing.tenorsDays);
    const keepStrikes = spot > 0 ? strikesNearWings(parsed.map((o) => o.strike), spot, wing.floorPcts, wing.capPcts) : new Set(parsed.map((o) => o.strike));
    const targets = parsed.filter((o) => keepExp.has(o.expiryMs) && keepStrikes.has(o.strike)).slice(0, 24);
    const options: OptionQuote[] = [];
    for (const t of targets) {
      try {
        const { bid, ask } = await bullishOrderbook(base, t.symbol);
        options.push({ strike: t.strike, optType: t.optType, expiryMs: t.expiryMs, bidUsdcPerBtc: bid, askUsdcPerBtc: ask });
      } catch {
        options.push({ strike: t.strike, optType: t.optType, expiryMs: t.expiryMs, bidUsdcPerBtc: null, askUsdcPerBtc: null });
      }
    }
    const anyQuotes = options.some((o) => o.bidUsdcPerBtc != null && o.askUsdcPerBtc != null);
    return {
      ok: anyQuotes,
      error: anyQuotes ? undefined : "bullish_option_markets_found_but_no_orderbook_quotes",
      dailyListingObserved,
      snapshot: { venue: "bullish", spot, nowMs, options }
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message, dailyListingObserved: false, snapshot: { venue: "bullish", spot: referenceSpot, nowMs, options: [] } };
  }
};

export const fetchBullishPerp = async (
  records?: BullishMarketRaw[],
  base = process.env.BULLISH_REST_BASE ?? "https://api.exchange.bullish.com"
): Promise<FetchResult<VenuePerpSnapshot>> => {
  const nowMs = Date.now();
  try {
    const recs = records ?? (await fetchBullishMarkets(base));
    const explicit = process.env.BULLISH_PERP_SYMBOL;
    const perp = explicit
      ? recs.find((r) => String(r.symbol).toUpperCase() === explicit.toUpperCase())
      : recs.find((r) => /PERP/i.test(String(r.marketType ?? "")) && (/^BTC/i.test(String(r.symbol ?? "")) || String(r.underlyingBaseSymbol ?? "").toUpperCase() === "BTC"));
    if (!perp?.symbol) return { ok: false, error: "no_bullish_btc_perp_market", snapshot: { venue: "bullish", spot: 0, nowMs, bids: [], asks: [] } };
    const { bid, ask, bids, asks } = await bullishOrderbook(base, perp.symbol);
    const spot = bid != null && ask != null ? (bid + ask) / 2 : bid ?? 0;
    return { ok: bids.length > 0 && asks.length > 0, error: bids.length > 0 && asks.length > 0 ? undefined : "bullish_perp_orderbook_empty", snapshot: { venue: "bullish", spot, nowMs, bids, asks } };
  } catch (e) {
    return { ok: false, error: (e as Error).message, snapshot: { venue: "bullish", spot: 0, nowMs, bids: [], asks: [] } };
  }
};

export type LiveCaptureResult = {
  optionSnapshots: VenueOptionSnapshot[];
  perpSnapshots: VenuePerpSnapshot[];
  bullishDailyListingObserved: boolean;
  errors: Array<{ venue: Venue; feed: "options" | "perp"; error: string }>;
};

/** Pull all venues (best-effort). Quote-only. */
export const captureLive = async (wing: { floorPcts: number[]; capPcts: number[]; tenorsDays: number[] }): Promise<LiveCaptureResult> => {
  const errors: LiveCaptureResult["errors"] = [];
  // Deribit/OKX first (also gives a reference spot); Bullish markets fetched once and shared.
  const [dOpt, dPerp, oOpt, oPerp, bMarkets] = await Promise.all([
    fetchDeribitOptions(),
    fetchDeribitPerp(),
    fetchOkxOptions(wing),
    fetchOkxPerp(),
    fetchBullishMarkets().catch(() => [] as BullishMarketRaw[])
  ]);
  const referenceSpot = dOpt.snapshot.spot || oOpt.snapshot.spot || dPerp.snapshot.spot || oPerp.snapshot.spot || 0;
  const [bOpt, bPerp] = await Promise.all([
    fetchBullishOptions(wing, referenceSpot, bMarkets),
    fetchBullishPerp(bMarkets)
  ]);
  const optionSnapshots: VenueOptionSnapshot[] = [];
  const perpSnapshots: VenuePerpSnapshot[] = [];
  for (const [r, feed, list] of [
    [dOpt, "options", optionSnapshots],
    [oOpt, "options", optionSnapshots],
    [bOpt, "options", optionSnapshots]
  ] as const) {
    if (r.ok) (list as VenueOptionSnapshot[]).push(r.snapshot);
    else errors.push({ venue: r.snapshot.venue, feed, error: r.error ?? "unknown" });
  }
  for (const [r, feed] of [[dPerp, "perp"], [oPerp, "perp"], [bPerp, "perp"]] as const) {
    if (r.ok) perpSnapshots.push(r.snapshot);
    else errors.push({ venue: r.snapshot.venue, feed, error: r.error ?? "unknown" });
  }
  return { optionSnapshots, perpSnapshots, bullishDailyListingObserved: bOpt.dailyListingObserved, errors };
};
