/**
 * Bullish chain provider for the liquid strike picker.
 *
 * Pulls Bullish markets list + per-symbol orderbooks, returns quotes in the
 * same VenueQuote (DeribitQuote-shaped, venue="bullish") format that the
 * liquid picker consumes.
 *
 * Used by LiquidChainCache to merge Bullish into the chain snapshot alongside
 * Deribit. Production wires this via the shared BullishTradingClient + cached
 * orderbook helper (5s cache per symbol).
 *
 * Performance: fetching orderbooks for the entire chain is N API calls. We
 * filter aggressively (strike window, tenor window, BTC only) BEFORE
 * orderbook calls, typically yielding 20-40 calls per snapshot. With Bullish
 * rate-limit (~10 req/sec for orderbook), this is ~3-4 seconds. Acceptable
 * for a 30s cache refresh.
 */

import type { BullishTradingClient } from "../../pilot/bullish";
import type { DeribitQuote } from "../../../scripts/backtest/singleSide/liquidStrikePicker";

export type BullishProviderConfig = {
  /** Strike-window radius in USD to filter markets before fetching orderbooks. */
  strikeWindowUsdc: number;
  /** Tenor-window radius in days to filter markets before fetching orderbooks. */
  tenorWindowDays: number;
  /** Spot price to anchor the strike window (typically passed from Deribit fetch). */
  centerSpot: number;
  /** Target tenor in days to anchor the tenor window. */
  centerTenorDays: number;
  /** Max concurrent orderbook fetches. Default 4 to respect Bullish rate limit. */
  maxConcurrency?: number;
  /** Per-orderbook fetch timeout in ms. Default 4000. */
  timeoutMs?: number;
  /**
   * Cap on the number of orderbook fetches per refresh — keep ONLY the strikes
   * NEAREST centerSpot (per side/expiry, by |strike − centerSpot|). We trade
   * near-ATM, so fetching every in-window strike (often 50-70) hammers Bullish's
   * rate limit → 429 → backoff → 0 quotes. Default 16 (≈ a few strikes × both
   * sides × a couple expiries). Set 0/undefined to fetch all (legacy).
   */
  maxOrderbookFetches?: number;
  /**
   * Exact instrument symbols to ALWAYS fetch, bypassing the strike+tenor window AND
   * the nearest-N cap. Used to PIN the instruments of currently-held live positions
   * so they are valued on their EXACT venue quote even after spot moves the strike out
   * of the ATM fetch window. Without this, a held strike that drifts away from spot
   * falls out of the snapshot → MTM cross-values it off the other venue (a misleading
   * proxy). Held positions are few (1-2 pairs), so the extra fetches are negligible.
   */
  pinnedSymbols?: string[];
};

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 4_000;

/**
 * Rate-limit backoff state (module-level singleton so all callers share it).
 * When ANY Bullish call returns HTTP 429, we suppress further Bullish chain
 * fetches for BACKOFF_MS to give the rate-limit window time to recover.
 * Without this, repeated 429s would keep happening on every refresh.
 */
// Env-configurable so the operator can widen the cool-off if 429s persist on the
// public endpoint (until Bullish whitelist / authed `registered.` access lands).
// Wider backoff = fewer Bullish attempts = less chance of compounding rate limits
// (chain just serves Deribit-only during the window). Default 60s.
const BACKOFF_MS = Math.max(1_000, Number(process.env.BULLISH_RATE_LIMIT_BACKOFF_MS ?? "60000"));
let _rateLimitedUntilMs = 0;

const isRateLimited = (nowMs: number): boolean => nowMs < _rateLimitedUntilMs;
const markRateLimited = (nowMs: number): void => { _rateLimitedUntilMs = nowMs + BACKOFF_MS; };
/** For tests / observability. */
export const __getBullishBackoffState = (): { rateLimitedUntilMs: number } => ({ rateLimitedUntilMs: _rateLimitedUntilMs });
export const __resetBullishBackoffState = (): void => { _rateLimitedUntilMs = 0; };

type BullishMarketLike = {
  symbol: string;
  marketEnabled: boolean;
  createOrderEnabled: boolean;
  optionType?: string;
  optionStrikePrice?: string;
  expiryDatetime?: string;
  underlyingBaseSymbol?: string;
};

const parseBullishExpiry = (iso: string | undefined, nowMs: number): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t > nowMs ? t : null;
};

/**
 * Run promises with a concurrency limit. Simple promise pool.
 */
const runWithConcurrency = async <T, R>(
  items: T[],
  fn: (item: T) => Promise<R | null>,
  concurrency: number
): Promise<R[]> => {
  const out: R[] = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      const r = await fn(items[i]);
      if (r != null) out.push(r);
    }
  });
  await Promise.all(workers);
  return out;
};

/**
 * Fetch a Bullish chain snapshot for the strike + tenor window around target.
 * Returns DeribitQuote-shaped entries with venue="bullish".
 *
 * @param client Shared BullishTradingClient instance from server boot.
 * @param spot Approximate spot price (used as underlyingPrice in quotes).
 * @param config Window parameters.
 * @param fetchOrderbook Optional override for orderbook fetcher (for tests).
 */
export const fetchBullishChainSnapshot = async (
  client: BullishTradingClient,
  spot: number,
  config: BullishProviderConfig,
  fetchOrderbook?: (symbol: string) => Promise<{ bid: number | null; ask: number | null } | null>,
  nowMs = Date.now()
): Promise<{ spot: number; quotes: DeribitQuote[] }> => {
  // Rate-limit short-circuit — skip fetch entirely if we're inside a backoff window.
  // Returning empty quotes is fine: LiquidChainCache treats this as "Bullish unavailable
  // for this refresh" and serves Deribit-only quotes from the merge.
  if (isRateLimited(nowMs)) {
    throw new Error(`bullish_rate_limited_until_${new Date(_rateLimitedUntilMs).toISOString()}`);
  }
  const concurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const targetTenorMs = config.centerTenorDays * 86_400_000;
  const tenorWindowMs = config.tenorWindowDays * 86_400_000;

  // 1. Get markets list (cached 120s by Bullish client)
  let markets;
  try {
    markets = await client.getMarkets({ cacheTtlMs: 120_000 });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("429") || msg.toLowerCase().includes("rate_limit")) {
      markRateLimited(nowMs);
    }
    throw e;
  }

  // 2. Filter to BTC options inside strike + tenor window. PINNED symbols (held
  // positions) bypass the windows so a held strike is always fetched even after
  // spot drifts away from it.
  const pinnedSet = new Set((config.pinnedSymbols ?? []).filter(Boolean));
  const candidates: Array<{ market: BullishMarketLike; strike: number; optType: "put" | "call"; expiryMs: number; isPinned: boolean }> = [];
  for (const m of markets as BullishMarketLike[]) {
    if (!m.marketEnabled || !m.createOrderEnabled) continue;
    if ((m.underlyingBaseSymbol ?? "").toUpperCase() !== "BTC") continue;
    const optTypeRaw = (m.optionType ?? "").toUpperCase();
    if (optTypeRaw !== "PUT" && optTypeRaw !== "CALL") continue;
    const strike = Number(m.optionStrikePrice ?? "0");
    if (!Number.isFinite(strike) || strike <= 0) continue;
    const expiryMs = parseBullishExpiry(m.expiryDatetime, nowMs);
    if (expiryMs == null) continue;
    const isPinned = pinnedSet.has(m.symbol);
    if (!isPinned) {
      if (Math.abs(strike - config.centerSpot) > config.strikeWindowUsdc) continue;
      if (Math.abs((expiryMs - nowMs) - targetTenorMs) > tenorWindowMs) continue;
    }
    candidates.push({
      market: m,
      strike,
      optType: optTypeRaw === "PUT" ? "put" : "call",
      expiryMs,
      isPinned
    });
  }

  // 2b. RATE-LIMIT GUARD: cap orderbook fetches to the strikes NEAREST centerSpot.
  // We trade near-ATM; fetching every in-window strike (often 50-70) is what was
  // tripping Bullish's 429 → backoff → 0 quotes (even though ATM is liquid).
  // PINNED (held) symbols are ALWAYS fetched on top of the nearest-N cap — they
  // are few and must be valued on their exact quote regardless of distance to spot.
  const maxFetches = config.maxOrderbookFetches ?? 16;
  const pinnedCands = candidates.filter((c) => c.isPinned);
  const windowCands = candidates.filter((c) => !c.isPinned);
  let fetchCandidates = windowCands;
  if (maxFetches > 0 && windowCands.length > maxFetches) {
    fetchCandidates = [...windowCands]
      .sort((a, b) => Math.abs(a.strike - config.centerSpot) - Math.abs(b.strike - config.centerSpot))
      .slice(0, maxFetches);
  }
  if (pinnedCands.length > 0) {
    const seen = new Set(fetchCandidates.map((c) => c.market.symbol));
    fetchCandidates = [...fetchCandidates];
    for (const pc of pinnedCands) {
      if (!seen.has(pc.market.symbol)) { fetchCandidates.push(pc); seen.add(pc.market.symbol); }
    }
  }

  // 3. Fetch orderbook for each candidate concurrently. If we hit a 429 from
  // any single orderbook call, immediately abort the rest and mark backoff —
  // continuing would just keep hitting the rate limit.
  let rateLimited = false;
  const defaultFetcher = async (symbol: string): Promise<{ bid: number | null; ask: number | null } | null> => {
    if (rateLimited) return null; // short-circuit remaining in-flight
    try {
      const book = await client.getHybridOrderBook(symbol);
      const bid = book.bids?.[0]?.price ?? null;
      const ask = book.asks?.[0]?.price ?? null;
      return { bid: bid != null ? Number(bid) : null, ask: ask != null ? Number(ask) : null };
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("429") || msg.toLowerCase().includes("rate_limit")) {
        rateLimited = true;
        markRateLimited(Date.now());
      }
      return null;
    }
  };
  const fetcher = fetchOrderbook ?? defaultFetcher;

  const quotes = await runWithConcurrency(fetchCandidates, async (c) => {
    const ob = await fetcher(c.market.symbol);
    if (!ob || ob.bid == null || ob.ask == null) return null;
    if (ob.bid <= 0 || ob.ask <= 0) return null;
    const bidUsdcPerBtc = ob.bid;       // Bullish quotes are already in USDC per option
    const askUsdcPerBtc = ob.ask;
    const midUsdcPerBtc = (bidUsdcPerBtc + askUsdcPerBtc) / 2;
    if (midUsdcPerBtc <= 0) return null;
    const spreadPct = (askUsdcPerBtc - bidUsdcPerBtc) / midUsdcPerBtc;
    const tenorHours = (c.expiryMs - nowMs) / 3_600_000;
    return {
      instrument_name: c.market.symbol,
      strike: c.strike,
      optType: c.optType,
      tenorHours,
      bidUsdcPerBtc,
      askUsdcPerBtc,
      midUsdcPerBtc,
      spreadPct,
      markIv: 0,        // Bullish doesn't expose IV in orderbook; left as 0
      askIv: null,
      underlyingPrice: spot,
      venue: "bullish" as const
    };
  }, concurrency);

  return { spot, quotes };
};
