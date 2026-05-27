/**
 * Probe live per-leg empirical anchors for the two-sided ITM guts strangle.
 *
 * Output: /tmp/two_sided_anchors.json (or path from env TWO_SIDED_ANCHORS_PATH)
 *         in the format consumed by runTwoSidedStrangleProof.ts.
 *
 * Probes BOTH venues for BOTH legs, picks the lower-ask venue per leg as the
 * production anchor, and records both for cross-venue auditing.
 *
 * Required env vars (for Bullish probes via Render proxy):
 *   RENDER_API_URL          (Render-hosted Foxify pilot API base URL; set via env)
 *   RENDER_ADMIN_TOKEN
 *
 * Deribit is public (no auth).
 *
 * Usage:
 *   cd services/api
 *   export RENDER_API_URL=... RENDER_ADMIN_TOKEN=...
 *   npx tsx scripts/backtest/singleSide/probeTwoSidedAnchors.ts
 */

import * as fs from "node:fs/promises";

const ANCHORS_OUT = process.env.TWO_SIDED_ANCHORS_PATH ?? "/tmp/two_sided_anchors.json";
const RENDER_API_URL = process.env.RENDER_API_URL ?? "";
const RENDER_ADMIN_TOKEN = process.env.RENDER_ADMIN_TOKEN ?? "";

// ─── Target strikes (production two-sided ITM guts strangle) ───
// Anchored at today's spot ~$76k with $1k Bullish strike grid:
//   - $77,000 put (1.3% ITM)
//   - $75,000 call (1.3% ITM)
// Anchors at additional alternative strikes ($74k/$78k OTM, $76k/$76k ATM) added for
// completeness so MC alternative-structure comparisons use real anchors too.

type TargetStrike = { strike: number; optionType: "put" | "call" };

const TARGET_STRIKES: TargetStrike[] = [
  // Production ITM guts (highest priority)
  { strike: 77_000, optionType: "put" },
  { strike: 75_000, optionType: "call" },
  // ATM strangle alternative
  { strike: 76_000, optionType: "put" },
  { strike: 76_000, optionType: "call" },
  // OTM strangle alternative
  { strike: 74_000, optionType: "put" },
  { strike: 78_000, optionType: "call" }
];

const TENOR_DAYS_TARGET = 3;
const TENOR_TOL_DAYS = 1.5;

// ─── Generic HTTP helper ───

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

const renderGet = async <T>(pathAndQuery: string): Promise<T> => {
  if (!RENDER_API_URL || !RENDER_ADMIN_TOKEN) {
    throw new Error("RENDER_API_URL and RENDER_ADMIN_TOKEN required for Bullish probes");
  }
  return fetchJson<T>(`${RENDER_API_URL}${pathAndQuery}`, {
    headers: { "X-Admin-Token": RENDER_ADMIN_TOKEN, Accept: "application/json" }
  });
};

const fetchSpotUsd = async (): Promise<number> => {
  const r = await fetchJson<{ data: { amount: string } }>("https://api.coinbase.com/v2/prices/BTC-USD/spot");
  return Number(r.data.amount);
};

const fetchDvol = async (): Promise<number | null> => {
  try {
    const now = Date.now();
    const r = await fetchJson<{ result: { data: number[][] } }>(
      `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${now - 3_600_000}&end_timestamp=${now}&resolution=60`
    );
    const last = r.result.data?.[r.result.data.length - 1];
    return last ? last[4] : null;
  } catch {
    return null;
  }
};

// ─── Bullish ───

type BullishOptionMarket = {
  symbol: string;
  optionStrikePrice?: string;
  optionType?: string;     // "PUT" | "CALL"
  expiryDatetime?: string;
};

type BullishChainResponse = {
  ok: boolean;
  spotUsd?: number;
  bullishMainnet?: boolean;
  optionMarkets?: BullishOptionMarket[];
};

type BullishOrderbookResponse = {
  ok: boolean;
  symbol: string;
  summary: {
    topAsk: { price: string; priceLevelQuantity?: string; quantity?: string } | null;
    topBid: { price: string; priceLevelQuantity?: string; quantity?: string } | null;
  };
  asks: Array<{ price: string; priceLevelQuantity?: string; quantity?: string }>;
};

const fetchBullishChain = (): Promise<BullishChainResponse> =>
  renderGet<BullishChainResponse>("/volume-cover/admin/bullish-option-chain");

const fetchBullishOrderbook = (symbol: string): Promise<BullishOrderbookResponse> =>
  renderGet<BullishOrderbookResponse>(`/volume-cover/admin/bullish-orderbook?symbol=${encodeURIComponent(symbol)}&depth=10`);

const probeBullishLeg = async (
  target: TargetStrike,
  spotUsd: number,
  chain: BullishChainResponse
): Promise<{ askPerBtc: number; depthBtc: number; symbol: string; expiry: string; daysOut: number } | null> => {
  const wanted = target.optionType === "put" ? "PUT" : "CALL";
  const markets = (chain.optionMarkets ?? []).filter(
    (m) => m.optionType === wanted && Number(m.optionStrikePrice) === target.strike
  );
  if (markets.length === 0) return null;
  // Pick expiry closest to TENOR_DAYS_TARGET within tolerance
  const now = Date.now();
  const withDays = markets
    .map((m) => {
      const expMs = m.expiryDatetime ? Date.parse(m.expiryDatetime) : 0;
      return { m, expMs, daysOut: (expMs - now) / 86_400_000 };
    })
    .filter((x) => x.daysOut > 0 && Math.abs(x.daysOut - TENOR_DAYS_TARGET) < TENOR_TOL_DAYS)
    .sort((a, b) => Math.abs(a.daysOut - TENOR_DAYS_TARGET) - Math.abs(b.daysOut - TENOR_DAYS_TARGET));
  if (withDays.length === 0) return null;
  const choice = withDays[0];

  const ob = await fetchBullishOrderbook(choice.m.symbol);
  if (!ob.ok || !ob.summary.topAsk) return null;
  const askPerBtc = Number(ob.summary.topAsk.price);

  // Depth-within-2% above best ask (matches empiricalChainValidator.ts logic)
  const askLimit = askPerBtc * 1.02;
  let depth = 0;
  for (const lvl of ob.asks) {
    const px = Number(lvl.price);
    if (!Number.isFinite(px)) continue;
    if (px > askLimit) break;
    depth += Number(lvl.priceLevelQuantity ?? lvl.quantity ?? 0);
  }
  return {
    askPerBtc,
    depthBtc: depth,
    symbol: choice.m.symbol,
    expiry: choice.m.expiryDatetime ?? "",
    daysOut: choice.daysOut
  };
};

// ─── Deribit ───

type DeribitInstrument = {
  instrument_name: string;
  kind: string;
  option_type: string;
  strike: number;
  expiration_timestamp: number;
};

type DeribitOrderBook = {
  best_ask_price: number;
  best_ask_amount: number;
  index_price: number;
  underlying_price: number;
  asks: number[][];
};

const fetchDeribitInstruments = async (): Promise<DeribitInstrument[]> => {
  const r = await fetchJson<{ result: DeribitInstrument[] }>(
    "https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false"
  );
  return r.result;
};

const fetchDeribitOrderbook = async (instrument: string): Promise<DeribitOrderBook | null> => {
  try {
    const r = await fetchJson<{ result: DeribitOrderBook }>(
      `https://www.deribit.com/api/v2/public/get_order_book?instrument_name=${encodeURIComponent(instrument)}&depth=10`
    );
    return r.result;
  } catch {
    return null;
  }
};

const probeDeribitLeg = async (
  target: TargetStrike,
  spotUsd: number,
  instruments: DeribitInstrument[]
): Promise<{ askPerBtc: number; depthBtc: number; symbol: string; expiry: string; daysOut: number } | null> => {
  const wanted = target.optionType === "put" ? "put" : "call";
  const now = Date.now();
  const candidates = instruments
    .filter((i) => i.kind === "option" && i.option_type === wanted && i.strike === target.strike)
    .map((i) => ({ i, daysOut: (i.expiration_timestamp - now) / 86_400_000 }))
    .filter((x) => x.daysOut > 0 && Math.abs(x.daysOut - TENOR_DAYS_TARGET) < TENOR_TOL_DAYS)
    .sort((a, b) => Math.abs(a.daysOut - TENOR_DAYS_TARGET) - Math.abs(b.daysOut - TENOR_DAYS_TARGET));
  if (candidates.length === 0) return null;
  const choice = candidates[0];

  const ob = await fetchDeribitOrderbook(choice.i.instrument_name);
  if (!ob || ob.best_ask_price <= 0) return null;
  // Deribit option prices are in BTC; convert to USDC-per-BTC via underlying_price.
  const askUsdPerBtc = ob.best_ask_price * ob.underlying_price;

  // Depth-within-2% above best ask (in BTC)
  const askLimitBtc = ob.best_ask_price * 1.02;
  let depth = 0;
  for (const [px, qty] of ob.asks) {
    if (px > askLimitBtc) break;
    depth += qty;
  }
  return {
    askPerBtc: askUsdPerBtc,
    depthBtc: depth,
    symbol: choice.i.instrument_name,
    expiry: new Date(choice.i.expiration_timestamp).toISOString(),
    daysOut: choice.daysOut
  };
};

// ─── Main ───

type LegAnchor = {
  strike: number;
  optionType: "put" | "call";
  venue: "bullish" | "deribit";
  bestAskUsdcPerBtc: number;
  depthWithin2pctBtc: number | null;
  ivAnnualAtPull: number;
  pulledAt: string;
  symbol?: string;
  expiry?: string;
  daysOut?: number;
};

const main = async () => {
  console.log("# Probing two-sided live anchors\n");
  const pulledAt = new Date().toISOString();

  console.log("Fetching spot + DVOL ...");
  const [spotUsd, dvol] = await Promise.all([fetchSpotUsd(), fetchDvol()]);
  const ivAnnual = dvol != null ? dvol / 100 : 0.36;
  console.log(`  spot=$${spotUsd.toFixed(2)} dvol=${dvol?.toFixed(2) ?? "n/a"} → σ=${ivAnnual.toFixed(3)}`);

  console.log("Fetching Bullish chain (Render-proxied) ...");
  let bullishChain: BullishChainResponse | null = null;
  try {
    bullishChain = await fetchBullishChain();
    console.log(`  ${bullishChain.optionMarkets?.length ?? 0} markets`);
  } catch (e) {
    console.warn(`  Bullish chain fetch failed: ${(e as Error).message}`);
  }

  console.log("Fetching Deribit instruments (public) ...");
  let deribitInstruments: DeribitInstrument[] | null = null;
  try {
    deribitInstruments = await fetchDeribitInstruments();
    console.log(`  ${deribitInstruments.length} instruments`);
  } catch (e) {
    console.warn(`  Deribit instruments fetch failed: ${(e as Error).message}`);
  }

  console.log("\nProbing each target strike on both venues:");
  const anchors: LegAnchor[] = [];
  for (const t of TARGET_STRIKES) {
    let bullishR: Awaited<ReturnType<typeof probeBullishLeg>> = null;
    let deribitR: Awaited<ReturnType<typeof probeDeribitLeg>> = null;
    if (bullishChain) {
      try {
        bullishR = await probeBullishLeg(t, spotUsd, bullishChain);
      } catch (e) {
        console.warn(`  bullish ${t.optionType.toUpperCase()} $${t.strike}: ${(e as Error).message}`);
      }
    }
    if (deribitInstruments) {
      try {
        deribitR = await probeDeribitLeg(t, spotUsd, deribitInstruments);
      } catch (e) {
        console.warn(`  deribit ${t.optionType.toUpperCase()} $${t.strike}: ${(e as Error).message}`);
      }
    }

    // Pick lower-ask venue as production anchor (better price → lower hedge cost for Foxify).
    // Both per-venue anchors are recorded if available.
    const bullishOk = bullishR && bullishR.askPerBtc > 0;
    const deribitOk = deribitR && deribitR.askPerBtc > 0;
    let chosenVenue: "bullish" | "deribit" | null = null;
    if (bullishOk && deribitOk) {
      chosenVenue = bullishR!.askPerBtc <= deribitR!.askPerBtc ? "bullish" : "deribit";
    } else if (bullishOk) chosenVenue = "bullish";
    else if (deribitOk) chosenVenue = "deribit";

    console.log(
      `  ${t.optionType.toUpperCase()} $${t.strike}: ` +
        (bullishOk ? `BLSH=$${bullishR!.askPerBtc.toFixed(2)}/BTC d=${bullishR!.depthBtc.toFixed(2)} ` : "BLSH=n/a ") +
        (deribitOk ? `DRBT=$${deribitR!.askPerBtc.toFixed(2)}/BTC d=${deribitR!.depthBtc.toFixed(2)} ` : "DRBT=n/a ") +
        (chosenVenue ? `→ chose ${chosenVenue}` : "→ no anchor available")
    );

    if (chosenVenue === "bullish" && bullishR) {
      anchors.push({
        strike: t.strike,
        optionType: t.optionType,
        venue: "bullish",
        bestAskUsdcPerBtc: bullishR.askPerBtc,
        depthWithin2pctBtc: bullishR.depthBtc,
        ivAnnualAtPull: ivAnnual,
        pulledAt,
        symbol: bullishR.symbol,
        expiry: bullishR.expiry,
        daysOut: bullishR.daysOut
      });
    } else if (chosenVenue === "deribit" && deribitR) {
      anchors.push({
        strike: t.strike,
        optionType: t.optionType,
        venue: "deribit",
        bestAskUsdcPerBtc: deribitR.askPerBtc,
        depthWithin2pctBtc: deribitR.depthBtc,
        ivAnnualAtPull: ivAnnual,
        pulledAt,
        symbol: deribitR.symbol,
        expiry: deribitR.expiry,
        daysOut: deribitR.daysOut
      });
    }
  }

  if (anchors.length === 0) {
    console.error("\nNo anchors successfully probed. Check env vars and network.");
    process.exit(1);
  }

  const out = {
    generatedAt: pulledAt,
    spotAtPull: spotUsd,
    source: "live_pull" as const,
    dvolAtPull: dvol,
    ivAnnualAtPull: ivAnnual,
    anchors
  };
  await fs.writeFile(ANCHORS_OUT, JSON.stringify(out, null, 2));
  console.log(`\n✓ Wrote ${anchors.length} anchors to ${ANCHORS_OUT}`);
  console.log(`  re-run runTwoSidedStrangleProof.ts to consume these anchors.`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
