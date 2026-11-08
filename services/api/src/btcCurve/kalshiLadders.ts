/**
 * Kalshi BTC ladders — public market data only (no keys, no account).
 *
 * Year-end 2026:  KXBTCY (price range at Dec 31 close), KXBTCMAXY ("how high this year",
 *                 one-touch up), KXBTCMINY ("how low this year", one-touch down).
 * Intraday:       KXBTCD (hourly above/below ladder), KXBTC15M (15-minute up/down).
 *
 * Every series settles on CF Benchmarks' BRTI — the same index Polymarket US uses — so a
 * bucket with the same bounds and the same settlement instant is the same contract.
 */

import { fetchJsonWithRetry, kalshiBase } from "../eventCollar/kalshiPublic";
import { aboveKey, belowKey, keyLevel } from "./keys";
import type { Bucket, Ladder, VenueQuote } from "./types";

export const KALSHI_YEAR_END = {
  range: "KXBTCY",
  touchUp: "KXBTCMAXY",
  touchDown: "KXBTCMINY",
} as const;
export const KALSHI_HOURLY = "KXBTCD";

interface RawMarket {
  ticker: string;
  event_ticker: string;
  status: string;
  close_time: string;
  expiration_time?: string;
  strike_type?: string;
  floor_strike?: number;
  cap_strike?: number;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  volume_fp?: string | number;
  open_interest_fp?: string | number;
  yes_sub_title?: string;
}

interface RawSeries {
  ticker: string;
  fee_type?: string;
  fee_multiplier?: number;
}

/**
 * Kalshi quotes the long-dated ladders in fractions of a cent ("0.0045" = 0.45¢), so cents
 * keep two decimals here instead of truncating to the penny. Exported for tests.
 */
export function dollarsToCentsExact(dollars: string | number | undefined): number {
  if (dollars === undefined || dollars === null || dollars === "") return 0;
  const n = Number(dollars);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10_000) / 100;
}

export async function fetchOpenMarkets(series: string, fetchImpl: typeof fetch = fetch): Promise<RawMarket[]> {
  const out: RawMarket[] = [];
  let cursor = "";
  for (let page = 0; page < 10; page += 1) {
    const url =
      `${kalshiBase()}/markets?series_ticker=${encodeURIComponent(series)}&status=open&limit=1000` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const data = (await fetchJsonWithRetry(url, fetchImpl)) as { markets?: RawMarket[]; cursor?: string };
    out.push(...(data.markets ?? []));
    cursor = data.cursor ?? "";
    if (!cursor || (data.markets ?? []).length === 0) break;
  }
  return out;
}

/** Kalshi's quadratic fee: 0.07 · C · p · (1 − p) scaled by the series multiplier (0 = fee-free). */
export async function fetchFeeTheta(series: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const data = (await fetchJsonWithRetry(`${kalshiBase()}/series/${encodeURIComponent(series)}`, fetchImpl)) as {
    series?: RawSeries;
  };
  const s = data.series;
  if (!s) return 0.07;
  if (s.fee_type && s.fee_type !== "quadratic") return 0.07;
  const mult = typeof s.fee_multiplier === "number" ? s.fee_multiplier : 1;
  return 0.07 * mult;
}

/** Bucket key shared with the Polymarket US reader. Exported for tests. */
export function bucketFromKalshi(m: RawMarket, settlesAt: string, family: "range" | "touch_up" | "touch_down" | "above"): Bucket | null {
  const type = String(m.strike_type ?? "");
  if (family === "range") {
    if (type === "between" && m.floor_strike !== undefined && m.cap_strike !== undefined) {
      return { key: `range:${m.floor_strike}-${m.cap_strike}`, kind: "range", lower: m.floor_strike, upper: m.cap_strike, settlesAt };
    }
    if (type === "greater" && m.floor_strike !== undefined) {
      const key = aboveKey(m.floor_strike, false);
      return { key, kind: "above", level: keyLevel(key), settlesAt };
    }
    if (type === "less" && m.cap_strike !== undefined) {
      const key = belowKey(m.cap_strike, false);
      return { key, kind: "below", level: keyLevel(key), settlesAt };
    }
    return null;
  }
  if (family === "above") {
    if ((type === "greater" || type === "greater_or_equal") && m.floor_strike !== undefined) {
      const key = aboveKey(m.floor_strike, type === "greater_or_equal");
      return { key, kind: "above", level: keyLevel(key), settlesAt };
    }
    return null;
  }
  // Kalshi words the touch ladders as "Above $109,999.99" / "Below $40,000": the round level
  // is the one Polymarket US uses, so the key carries the round level.
  if (family === "touch_up" && m.floor_strike !== undefined) {
    const level = Math.round((m.floor_strike + 0.01) * 100) / 100;
    return { key: `touch_up:${level}`, kind: "touch_up", level, settlesAt };
  }
  if (family === "touch_down" && m.cap_strike !== undefined) {
    return { key: `touch_down:${m.cap_strike}`, kind: "touch_down", level: m.cap_strike, settlesAt };
  }
  return null;
}

function quoteFromKalshi(m: RawMarket, bucketKey: string, feeTheta: number): VenueQuote {
  return {
    venue: "kalshi",
    bucketKey,
    id: m.ticker,
    bidCents: dollarsToCentsExact(m.yes_bid_dollars),
    askCents: dollarsToCentsExact(m.yes_ask_dollars),
    bidQty: 0,
    askQty: 0,
    volume: Number(m.volume_fp ?? 0),
    openInterest: Number(m.open_interest_fp ?? 0),
    feeTheta,
  };
}

/**
 * Depth at the best bid / ask from the public orderbook. Kalshi publishes resting YES bids
 * and resting NO bids (a NO bid at p is a YES offer at 1 − p), each ascending by price, so the
 * best level is the last row. Exported for tests.
 */
export function topDepthFromOrderbook(data: {
  orderbook_fp?: { yes_dollars?: Array<[string, string]> | null; no_dollars?: Array<[string, string]> | null };
  orderbook?: { yes?: Array<[number, number]> | null; no?: Array<[number, number]> | null };
}): { bidQty: number; askQty: number } {
  const yes = data.orderbook_fp?.yes_dollars ?? data.orderbook?.yes ?? [];
  const no = data.orderbook_fp?.no_dollars ?? data.orderbook?.no ?? [];
  const bestYes = yes.length ? yes[yes.length - 1] : null;
  const bestNo = no.length ? no[no.length - 1] : null;
  return { bidQty: bestYes ? Number(bestYes[1]) : 0, askQty: bestNo ? Number(bestNo[1]) : 0 };
}

export async function fetchTopDepth(
  ticker: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bidQty: number; askQty: number }> {
  const data = (await fetchJsonWithRetry(`${kalshiBase()}/markets/${encodeURIComponent(ticker)}/orderbook`, fetchImpl)) as Parameters<
    typeof topDepthFromOrderbook
  >[0];
  return topDepthFromOrderbook(data);
}

export interface KalshiLadderSet {
  yearEnd: Ladder[];
  hourly: Ladder | null;
}

/**
 * The year-end ladders (range, touch up, touch down) and the nearest open hourly ladder.
 * `withDepth` adds the best-level sizes on the year-end range (one orderbook call per strike).
 */
export async function readKalshiLadders(
  opts: { withDepth?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<KalshiLadderSet> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const [rangeRaw, upRaw, downRaw, hourlyRaw, rangeTheta, touchTheta, hourlyTheta] = await Promise.all([
    fetchOpenMarkets(KALSHI_YEAR_END.range, fetchImpl),
    fetchOpenMarkets(KALSHI_YEAR_END.touchUp, fetchImpl),
    fetchOpenMarkets(KALSHI_YEAR_END.touchDown, fetchImpl),
    fetchOpenMarkets(KALSHI_HOURLY, fetchImpl),
    fetchFeeTheta(KALSHI_YEAR_END.range, fetchImpl).catch(() => 0),
    fetchFeeTheta(KALSHI_YEAR_END.touchUp, fetchImpl).catch(() => 0.07),
    fetchFeeTheta(KALSHI_HOURLY, fetchImpl).catch(() => 0.07),
  ]);

  const yearEnd: Ladder[] = [];
  const build = (raw: RawMarket[], family: "range" | "touch_up" | "touch_down", id: string, title: string, theta: number) => {
    if (!raw.length) return;
    const settlesAt = raw.map((m) => m.close_time).sort()[0];
    const buckets: Bucket[] = [];
    const quotes: VenueQuote[] = [];
    for (const m of raw) {
      const b = bucketFromKalshi(m, settlesAt, family);
      if (!b) continue;
      buckets.push(b);
      quotes.push(quoteFromKalshi(m, b.key, theta));
    }
    yearEnd.push({ id, title, settlesAt, buckets: sortBuckets(buckets), quotes, model: {} });
  };
  build(rangeRaw, "range", "btc-yearend-2026-range", "Bitcoin price at the end of 2026", rangeTheta);
  build(upRaw, "touch_up", "btc-yearend-2026-high", "How high will Bitcoin get this year", touchTheta);
  build(downRaw, "touch_down", "btc-yearend-2026-low", "How low will Bitcoin get this year", touchTheta);

  if (opts.withDepth) {
    const range = yearEnd.find((l) => l.id === "btc-yearend-2026-range");
    if (range) {
      await Promise.all(
        range.quotes.map(async (q) => {
          try {
            const d = await fetchTopDepth(q.id, fetchImpl);
            q.bidQty = d.bidQty;
            q.askQty = d.askQty;
          } catch {
            // depth is a nicety; the top of book stands without it
          }
        }),
      );
    }
  }

  // Hourly: the open event closing soonest that still has at least 30 minutes to run.
  let hourly: Ladder | null = null;
  const now = Date.now();
  const byEvent = new Map<string, RawMarket[]>();
  for (const m of hourlyRaw) {
    const list = byEvent.get(m.event_ticker) ?? [];
    list.push(m);
    byEvent.set(m.event_ticker, list);
  }
  const events = [...byEvent.entries()]
    .map(([ev, ms]) => ({ ev, ms, closeMs: Date.parse(ms[0].close_time) }))
    .filter((e) => Number.isFinite(e.closeMs) && e.closeMs - now > 30 * 60_000)
    .sort((a, b) => a.closeMs - b.closeMs);
  if (events.length) {
    const { ev, ms } = events[0];
    const settlesAt = ms[0].close_time;
    const buckets: Bucket[] = [];
    const quotes: VenueQuote[] = [];
    for (const m of ms) {
      const b = bucketFromKalshi(m, settlesAt, "above");
      if (!b) continue;
      buckets.push(b);
      quotes.push(quoteFromKalshi(m, b.key, hourlyTheta));
    }
    hourly = { id: `btc-hourly:${ev}`, title: `Bitcoin price at ${settlesAt} (hourly)`, settlesAt, buckets: sortBuckets(buckets), quotes, model: {} };
  }

  return { yearEnd, hourly };
}

/** Low price to high price; the open-ended tails fall into place by their own level. */
export function sortBuckets(buckets: Bucket[]): Bucket[] {
  const level = (b: Bucket) => b.level ?? b.lower ?? b.upper ?? 0;
  return [...buckets].sort((a, b) => level(a) - level(b));
}
