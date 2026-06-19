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

const num = (x: unknown): number => Number(x);

type SourceDef = { source: string; url: string; pick: (j: unknown) => number };

const SOURCES: SourceDef[] = [
  { source: "deribit", url: (process.env.DERIBIT_REST_BASE ?? "https://www.deribit.com/api/v2") + "/public/get_index_price?index_name=btc_usd", pick: (j) => num((j as { result?: { index_price?: number } }).result?.index_price) },
  { source: "okx", url: (process.env.OKX_REST_BASE ?? "https://www.okx.com") + "/api/v5/market/ticker?instId=BTC-USDT", pick: (j) => num((j as { data?: Array<{ last?: string }> }).data?.[0]?.last) },
  { source: "coinbase", url: "https://api.coinbase.com/v2/prices/BTC-USD/spot", pick: (j) => num((j as { data?: { amount?: string } }).data?.amount) },
  { source: "binance", url: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", pick: (j) => num((j as { price?: string }).price) },
  { source: "kraken", url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD", pick: (j) => {
    const r = (j as { result?: Record<string, { c?: string[] }> }).result ?? {};
    const first = Object.values(r)[0];
    return num(first?.c?.[0]);
  } }
];

export type SpotFeedResult = { samples: PriceSample[]; errors: Array<{ source: string; error: string }> };

/** Fetch BTC spot from all public sources in parallel. Quote-only. */
export const fetchSpotSamples = async (nowMs = Date.now()): Promise<SpotFeedResult> => {
  const errors: SpotFeedResult["errors"] = [];
  const results = await Promise.all(
    SOURCES.map(async (s): Promise<PriceSample | null> => {
      try {
        const price = s.pick(await getJson(s.url));
        if (!(price > 0)) throw new Error("non-positive price");
        return { source: s.source, priceUsd: price, tsMs: nowMs };
      } catch (e) {
        errors.push({ source: s.source, error: (e as Error).message });
        return null;
      }
    })
  );
  return { samples: results.filter((x): x is PriceSample => x != null), errors };
};
