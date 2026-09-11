/**
 * Kalshi public market data — read-only, no keys, no account.
 * Only public endpoints are used; this module is structurally unable to trade.
 */

import type { KalshiMarket, KalshiTrade } from "./types";

const DEFAULT_BASE = "https://api.elections.kalshi.com/trade-api/v2";

export function kalshiBase(): string {
  return process.env.KALSHI_REST_BASE?.replace(/\/$/, "") || DEFAULT_BASE;
}

const RETRY_DELAYS_MS = [500, 1500, 4000];

/**
 * Per-attempt timeout: blocked networks (ISP-level filtering of some venues)
 * drop packets silently, and the OS connect timeout is ~75s per attempt. A
 * hard cap keeps a blocked venue an honest, bounded refusal instead of a hang.
 */
function attemptTimeoutMs(): number {
  return Number(process.env.EVENT_FETCH_TIMEOUT_MS || 8000);
}

export async function fetchJsonWithRetry(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const res = await fetchImpl(url, {
        headers: { accept: "application/json", "user-agent": "atticus-event-demo" },
        signal: AbortSignal.timeout(attemptTimeoutMs()),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
  }
  throw lastErr;
}

/** Exact dollars-string ("0.4100") to integer cents, no float math. */
export function dollarsToCents(dollars: string | undefined): number {
  if (!dollars) return 0;
  const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec(dollars.trim());
  if (!m) return 0;
  const whole = Number(m[1]);
  const frac = (m[2] ?? "").padEnd(2, "0").slice(0, 2);
  return whole * 100 + Number(frac);
}

/** Normalize one raw Kalshi market object. Exported for tests. */
export function parseKalshiMarket(raw: Record<string, unknown>): KalshiMarket {
  return {
    ticker: String(raw.ticker ?? ""),
    eventTicker: String(raw.event_ticker ?? ""),
    title: String(raw.title ?? ""),
    subtitle: String(raw.yes_sub_title ?? raw.subtitle ?? ""),
    strike: Number(raw.floor_strike ?? raw.cap_strike ?? 0),
    strikeType: String(raw.strike_type ?? ""),
    status: String(raw.status ?? ""),
    openTime: String(raw.open_time ?? ""),
    closeTime: String(raw.close_time ?? ""),
    yesBidCents: dollarsToCents(raw.yes_bid_dollars as string),
    yesAskCents: dollarsToCents(raw.yes_ask_dollars as string),
    lastPriceCents: dollarsToCents(raw.last_price_dollars as string),
    volume: Number(raw.volume_fp ?? raw.volume ?? 0),
    openInterest: Number(raw.open_interest_fp ?? raw.open_interest ?? 0),
    rulesPrimary: String(raw.rules_primary ?? ""),
  };
}

export async function getOpenMarkets(
  seriesTicker: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KalshiMarket[]> {
  const out: KalshiMarket[] = [];
  let cursor = "";
  for (let page = 0; page < 10; page += 1) {
    const url =
      `${kalshiBase()}/markets?series_ticker=${encodeURIComponent(seriesTicker)}` +
      `&status=open&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const data = (await fetchJsonWithRetry(url, fetchImpl)) as {
      markets?: Record<string, unknown>[];
      cursor?: string;
    };
    for (const m of data.markets ?? []) out.push(parseKalshiMarket(m));
    cursor = data.cursor ?? "";
    if (!cursor || (data.markets ?? []).length === 0) break;
  }
  return out;
}

export function parseKalshiTrade(raw: Record<string, unknown>): KalshiTrade {
  return {
    tradeId: String(raw.trade_id ?? ""),
    ticker: String(raw.ticker ?? ""),
    priceCents: dollarsToCents(raw.yes_price_dollars as string) || Number(raw.yes_price ?? 0),
    count: Number(raw.count_fp ?? raw.count ?? 0),
    createdTime: String(raw.created_time ?? ""),
  };
}

/** Recent public trade prints for a market, newest first. */
export async function getRecentTrades(
  ticker: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KalshiTrade[]> {
  const url = `${kalshiBase()}/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=100`;
  const data = (await fetchJsonWithRetry(url, fetchImpl)) as {
    trades?: Record<string, unknown>[];
  };
  return (data.trades ?? []).map(parseKalshiTrade);
}

export function midCents(m: KalshiMarket): number {
  if (m.yesBidCents > 0 && m.yesAskCents > 0 && m.yesAskCents < 100) {
    return Math.round((m.yesBidCents + m.yesAskCents) / 2);
  }
  if (m.lastPriceCents > 0) return m.lastPriceCents;
  return Math.round((m.yesBidCents + m.yesAskCents) / 2);
}
