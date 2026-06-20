/**
 * Multi-source BTC spot feeds — READ-ONLY public tickers (NO keys, NO trading). For the reference
 * oracle's median (Bullish/Deribit + CEXs). Each source is independent + resilient: a failure just
 * drops that source (the oracle's min-3 fail-closed handles degradation). Runs on Render.
 */

import type { PriceSample } from "../referenceOracle";

const TIMEOUT_MS = Number(process.env.HARNESS_FETCH_TIMEOUT_MS ?? "8000");

const getJson = async (url: string): Promise<unknown> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const num = (x: unknown): number => Number(x);

type SourceDef = { source: string; url: string; pick: (j: unknown) => number };

// Broad set of public, no-key BTC spot tickers so we comfortably clear the oracle's min-3 even when a
// few are blocked/slow from a datacenter IP (e.g. Binance often 451s from cloud egress). More sources
// = more margin above the fail-closed floor; the oracle's MAD filter rejects any outlier.
const SOURCES: SourceDef[] = [
  { source: "deribit", url: (process.env.DERIBIT_REST_BASE ?? "https://www.deribit.com/api/v2") + "/public/get_index_price?index_name=btc_usd", pick: (j) => num((j as { result?: { index_price?: number } }).result?.index_price) },
  { source: "okx", url: (process.env.OKX_REST_BASE ?? "https://www.okx.com") + "/api/v5/market/ticker?instId=BTC-USDT", pick: (j) => num((j as { data?: Array<{ last?: string }> }).data?.[0]?.last) },
  { source: "coinbase", url: "https://api.coinbase.com/v2/prices/BTC-USD/spot", pick: (j) => num((j as { data?: { amount?: string } }).data?.amount) },
  { source: "binance", url: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", pick: (j) => num((j as { price?: string }).price) },
  { source: "kraken", url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD", pick: (j) => {
    const r = (j as { result?: Record<string, { c?: string[] }> }).result ?? {};
    const first = Object.values(r)[0];
    return num(first?.c?.[0]);
  } },
  { source: "bitstamp", url: "https://www.bitstamp.net/api/v2/ticker/btcusd/", pick: (j) => num((j as { last?: string }).last) },
  { source: "gemini", url: "https://api.gemini.com/v1/pubticker/btcusd", pick: (j) => num((j as { last?: string }).last) },
  { source: "bybit", url: "https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT", pick: (j) => num((j as { result?: { list?: Array<{ lastPrice?: string }> } }).result?.list?.[0]?.lastPrice) },
  { source: "bitfinex", url: "https://api-pub.bitfinex.com/v2/ticker/tBTCUSD", pick: (j) => num((j as number[])?.[6]) } // [bid,..,lastPrice(idx6),..]
];

export type SpotFeedResult = { samples: PriceSample[]; errors: Array<{ source: string; error: string }> };

/** One source with a single retry on transient failure. */
const fetchSource = async (s: SourceDef, nowMs: number): Promise<PriceSample | { error: string }> => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const price = s.pick(await getJson(s.url));
      if (!(price > 0)) throw new Error("non-positive price");
      return { source: s.source, priceUsd: price, tsMs: nowMs };
    } catch (e) {
      if (attempt === 0) {
        await sleep(300); // quick retry to ride out a transient timeout/rate-limit
        continue;
      }
      return { error: (e as Error).message };
    }
  }
  return { error: "unreachable" };
};

/** Fetch BTC spot from all public sources in parallel (each with one retry). Quote-only. */
export const fetchSpotSamples = async (nowMs = Date.now()): Promise<SpotFeedResult> => {
  const errors: SpotFeedResult["errors"] = [];
  const samples: PriceSample[] = [];
  const results = await Promise.all(SOURCES.map((s) => fetchSource(s, nowMs)));
  results.forEach((r, i) => {
    if ("error" in r) errors.push({ source: SOURCES[i].source, error: r.error });
    else samples.push(r);
  });
  return { samples, errors };
};
