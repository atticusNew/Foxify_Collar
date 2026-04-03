import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type Args = {
  fromIso: string;
  toIso: string;
  outCsvPath: string;
  source: "binance" | "coingecko" | "coinbase" | "auto";
};

type DecimalString = string;

type CandlePoint = {
  tsMs: number;
  closePriceUsd: string;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const BINANCE_LIMIT = 1000;
const BINANCE_BASE = "https://api.binance.com";
const COINGECKO_BASE = "https://api.coingecko.com";
const COINBASE_BASE = "https://api.exchange.coinbase.com";
const COINGECKO_MAX_HOURLY_WINDOW_MS = 89 * DAY_MS;
const MAX_RETRIES = 5;

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const fetchWithRetry = async (url: string, provider: "binance" | "coingecko" | "coinbase"): Promise<Response> => {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) return response;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === MAX_RETRIES - 1) {
      throw new Error(`${provider}_http_${response.status}`);
    }
    const backoffMs = 500 * 2 ** attempt;
    await sleep(backoffMs);
  }
  throw new Error(`${provider}_http_unknown`);
};

const parseArgs = (argv: string[]): Args => {
  const nowIso = new Date().toISOString();
  const defaultFromIso = new Date(Date.now() - 120 * 24 * HOUR_MS).toISOString();
  const args: Args = {
    fromIso: defaultFromIso,
    toIso: nowIso,
    outCsvPath: "artifacts/backtest/btc_usd_1h.csv",
    source: "auto"
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--from" && argv[i + 1]) {
      args.fromIso = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--to" && argv[i + 1]) {
      args.toIso = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--out-csv" && argv[i + 1]) {
      args.outCsvPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--source" && argv[i + 1]) {
      const source = String(argv[i + 1]).trim().toLowerCase();
      if (source !== "binance" && source !== "coingecko" && source !== "coinbase" && source !== "auto") {
        throw new Error(`invalid_source:${source}`);
      }
      args.source = source as Args["source"];
      i += 1;
      continue;
    }
  }
  return args;
};

const parseTime = (rawIso: string, name: "from" | "to"): number => {
  const ts = Date.parse(rawIso);
  if (!Number.isFinite(ts)) {
    throw new Error(`invalid_${name}_iso:${rawIso}`);
  }
  return ts;
};

const fetchBinance1h = async (fromMs: number, toMs: number): Promise<CandlePoint[]> => {
  const all: CandlePoint[] = [];
  let cursor = fromMs;

  while (cursor < toMs) {
    const url = new URL("/api/v3/klines", BINANCE_BASE);
    url.searchParams.set("symbol", "BTCUSDT");
    url.searchParams.set("interval", "1h");
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(toMs));
    url.searchParams.set("limit", String(BINANCE_LIMIT));

    const response = await fetchWithRetry(url.toString(), "binance");

    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      throw new Error("binance_invalid_payload");
    }

    if (payload.length === 0) break;

    for (const row of payload) {
      if (!Array.isArray(row) || row.length < 5) continue;
      const openTime = Number(row[0]);
      const closePrice = String(row[4] ?? "");
      if (!Number.isFinite(openTime) || !closePrice) continue;
      all.push({ tsMs: openTime, closePriceUsd: closePrice });
    }

    const lastOpenTime = Number(payload[payload.length - 1]?.[0] ?? NaN);
    if (!Number.isFinite(lastOpenTime)) break;
    cursor = lastOpenTime + HOUR_MS;
  }

  const dedup = new Map<number, CandlePoint>();
  for (const point of all) {
    if (point.tsMs >= fromMs && point.tsMs <= toMs) {
      dedup.set(point.tsMs, point);
    }
  }
  return Array.from(dedup.values()).sort((a, b) => a.tsMs - b.tsMs);
};

const floorToHour = (tsMs: number): number => Math.floor(tsMs / HOUR_MS) * HOUR_MS;

const fetchCoinGeckoRange = async (fromMs: number, toMs: number): Promise<Array<[number, number]>> => {
  const fromSec = Math.floor(fromMs / 1000);
  const toSec = Math.floor(toMs / 1000);
  const url = new URL("/api/v3/coins/bitcoin/market_chart/range", COINGECKO_BASE);
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("from", String(fromSec));
  url.searchParams.set("to", String(toSec));

  const response = await fetchWithRetry(url.toString(), "coingecko");

  const payload = (await response.json()) as { prices?: Array<[number, number]> };
  if (!Array.isArray(payload?.prices) || payload.prices.length === 0) {
    throw new Error("coingecko_invalid_payload");
  }
  return payload.prices;
};

const fetchCoinGeckoHourly = async (fromMs: number, toMs: number): Promise<CandlePoint[]> => {
  // For large ranges, CoinGecko may degrade to daily points.
  // Query in <=89-day chunks to preserve hourly granularity.
  const byHour = new Map<number, DecimalString>();

  let chunkStart = fromMs;
  while (chunkStart < toMs) {
    const chunkEnd = Math.min(toMs, chunkStart + COINGECKO_MAX_HOURLY_WINDOW_MS);
    const prices = await fetchCoinGeckoRange(chunkStart, chunkEnd);
    for (const point of prices) {
      const tsMs = Number(point?.[0] ?? NaN);
      const px = Number(point?.[1] ?? NaN);
      if (!Number.isFinite(tsMs) || !Number.isFinite(px) || px <= 0) continue;
      const bucket = floorToHour(tsMs);
      if (bucket < fromMs || bucket > toMs) continue;
      byHour.set(bucket, px.toFixed(10));
    }
    chunkStart = chunkEnd + 1;
  }

  return Array.from(byHour.entries())
    .map(([tsMs, closePriceUsd]) => ({ tsMs, closePriceUsd }))
    .sort((a, b) => a.tsMs - b.tsMs);
};

const fetchCoinbase1h = async (fromMs: number, toMs: number): Promise<CandlePoint[]> => {
  // Coinbase candles max 300 rows per request; walk windows to cover long ranges.
  const rows: CandlePoint[] = [];
  const WINDOW_MS = 300 * HOUR_MS;
  let cursor = fromMs;

  while (cursor < toMs) {
    const end = Math.min(toMs, cursor + WINDOW_MS);
    const url = new URL("/products/BTC-USD/candles", COINBASE_BASE);
    url.searchParams.set("granularity", "3600");
    url.searchParams.set("start", new Date(cursor).toISOString());
    url.searchParams.set("end", new Date(end).toISOString());
    const response = await fetchWithRetry(url.toString(), "coinbase");
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      throw new Error("coinbase_invalid_payload");
    }
    for (const row of payload) {
      if (!Array.isArray(row) || row.length < 5) continue;
      const tsSec = Number(row[0]);
      const closePx = Number(row[4]);
      if (!Number.isFinite(tsSec) || !Number.isFinite(closePx) || closePx <= 0) continue;
      const tsMs = floorToHour(tsSec * 1000);
      if (tsMs < fromMs || tsMs > toMs) continue;
      rows.push({ tsMs, closePriceUsd: closePx.toFixed(10) });
    }
    cursor = end + 1;
  }

  const dedup = new Map<number, CandlePoint>();
  for (const row of rows) dedup.set(row.tsMs, row);
  return Array.from(dedup.values()).sort((a, b) => a.tsMs - b.tsMs);
};

const toCsv = (points: CandlePoint[]): string => {
  const lines = ["ts_iso,price_usd"];
  for (const point of points) {
    lines.push(`${new Date(point.tsMs).toISOString()},${point.closePriceUsd}`);
  }
  return `${lines.join("\n")}\n`;
};

const ensureParentDir = async (targetPath: string) => {
  await mkdir(path.dirname(targetPath), { recursive: true });
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const fromMs = parseTime(args.fromIso, "from");
  const toMs = parseTime(args.toIso, "to");
  if (fromMs >= toMs) {
    throw new Error("invalid_time_range:from_must_be_before_to");
  }

  let points: CandlePoint[] = [];
  let sourceUsed = args.source;
  if (args.source === "binance") {
    points = await fetchBinance1h(fromMs, toMs);
    sourceUsed = "binance";
  } else if (args.source === "coingecko") {
    points = await fetchCoinGeckoHourly(fromMs, toMs);
    sourceUsed = "coingecko";
  } else if (args.source === "coinbase") {
    points = await fetchCoinbase1h(fromMs, toMs);
    sourceUsed = "coinbase";
  } else {
    try {
      points = await fetchBinance1h(fromMs, toMs);
      sourceUsed = "binance";
    } catch (binanceError: any) {
      try {
        points = await fetchCoinGeckoHourly(fromMs, toMs);
        sourceUsed = "coingecko";
      } catch (coingeckoError: any) {
        points = await fetchCoinbase1h(fromMs, toMs);
        sourceUsed = "coinbase";
        console.warn(
          JSON.stringify(
            {
              status: "warning",
              reason: "data_source_fallback",
              message: "binance_and_coingecko_unavailable_using_coinbase",
              binance: String(binanceError?.message || binanceError || "unknown_binance_error"),
              coingecko: String(coingeckoError?.message || coingeckoError || "unknown_coingecko_error"),
              fallbackSource: "coinbase"
            },
            null,
            2
          )
        );
      }
    }
  }
  if (!points.length) {
    throw new Error("no_points_returned");
  }

  await ensureParentDir(args.outCsvPath);
  await writeFile(args.outCsvPath, toCsv(points), "utf8");

  console.log(
    JSON.stringify(
      {
        status: "ok",
        source: sourceUsed,
        fromIso: new Date(fromMs).toISOString(),
        toIso: new Date(toMs).toISOString(),
        rows: points.length,
        firstTsIso: new Date(points[0].tsMs).toISOString(),
        lastTsIso: new Date(points[points.length - 1].tsMs).toISOString(),
        outCsv: args.outCsvPath
      },
      null,
      2
    )
  );
};

main().catch((error: any) => {
  console.error(
    JSON.stringify(
      {
        status: "error",
        reason: "backtest_fetch_failed",
        message: String(error?.message || error || "unknown_error")
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
