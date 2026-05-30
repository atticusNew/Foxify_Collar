#!/usr/bin/env tsx
/**
 * Live Bullish spread feasibility probe — 50k_2pct_1k cell, MINIMAL.
 *
 * Proxies through our shadow service's bullish-orderbook admin endpoint
 * (which uses the JWT singleton client) since Bullish's public
 * orderbook URL blocks unauthenticated requests with 403.
 *
 * Hits 4 specific strikes × 2 Friday expiries = 8 calls total.
 * Throttled, with progress logging.
 *
 * Required env:
 *   SHADOW_API=https://foxify-pilot-shadow-3r1m.onrender.com
 *   SHADOW_ADMIN_TOKEN=<your shadow admin token>
 *
 * Run:
 *   SHADOW_API=... SHADOW_ADMIN_TOKEN=... \
 *     npx tsx services/api/scripts/probes/bullish_spread_chain_probe.ts
 */

const SHADOW_API = process.env.SHADOW_API || "https://foxify-pilot-shadow-3r1m.onrender.com";
const SHADOW_ADMIN_TOKEN = process.env.SHADOW_ADMIN_TOKEN || "";

const TRIGGER_PCT = 0.02;
const SPREAD_WIDTH_USD = 2_000;
const STRIKE_TICK_USD = 500;

const REQUEST_DELAY_MS = 600;
const REQUEST_TIMEOUT_MS = 15_000; // shadow can be slow

const buildSymbol = (expiry: string, strike: number, kind: "C" | "P"): string =>
  `BTC-USDC-${expiry}-${strike}-${kind}`;

type ShadowOrderbookResponse = {
  ok: boolean;
  symbol?: string;
  summary?: {
    topBid: { price: string; quantity: string } | null;
    topAsk: { price: string; quantity: string } | null;
    midPrice: number | null;
    spreadPct: number | null;
    bidLevels: number;
    askLevels: number;
  };
  bids?: { price: string; quantity: string }[];
  asks?: { price: string; quantity: string }[];
  error?: string;
};

type FetchResult = {
  symbol: string;
  status: "ok" | "not_found" | "rate_limited" | "error" | "timeout";
  topBid: number;
  topAsk: number;
  bidLevels: number;
  askLevels: number;
  message?: string;
  elapsedMs: number;
};

let earlyAbort = false;

const fetchOrderbook = async (symbol: string): Promise<FetchResult> => {
  const startMs = Date.now();
  if (earlyAbort) {
    return { symbol, status: "rate_limited", topBid: 0, topAsk: 0, bidLevels: 0, askLevels: 0, elapsedMs: 0, message: "early abort" };
  }
  const url = `${SHADOW_API}/volume-cover/admin/bullish-orderbook?symbol=${encodeURIComponent(symbol)}&depth=1`;
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "X-Admin-Token": SHADOW_ADMIN_TOKEN, Accept: "application/json" }
    });
    const elapsedMs = Date.now() - startMs;
    if (r.status === 502 || r.status === 429) {
      const body = await r.text();
      // 502/429 here is typically rate-limit upstream (Bullish)
      if (body.includes("RATE_LIMIT") || body.includes("96100")) {
        earlyAbort = true;
        return { symbol, status: "rate_limited", topBid: 0, topAsk: 0, bidLevels: 0, askLevels: 0, elapsedMs, message: body.slice(0, 200) };
      }
      return { symbol, status: "error", topBid: 0, topAsk: 0, bidLevels: 0, askLevels: 0, elapsedMs, message: `${r.status}: ${body.slice(0, 100)}` };
    }
    if (r.status === 404) {
      return { symbol, status: "not_found", topBid: 0, topAsk: 0, bidLevels: 0, askLevels: 0, elapsedMs };
    }
    if (!r.ok) {
      const body = await r.text();
      return { symbol, status: "error", topBid: 0, topAsk: 0, bidLevels: 0, askLevels: 0, elapsedMs, message: `HTTP ${r.status}: ${body.slice(0, 100)}` };
    }
    const data = (await r.json()) as ShadowOrderbookResponse;
    if (!data.ok || !data.summary) {
      return { symbol, status: "error", topBid: 0, topAsk: 0, bidLevels: 0, askLevels: 0, elapsedMs, message: data.error?.slice(0, 100) ?? "no_data" };
    }
    return {
      symbol,
      status: "ok",
      topBid: data.summary.topBid ? Number(data.summary.topBid.price) : 0,
      topAsk: data.summary.topAsk ? Number(data.summary.topAsk.price) : 0,
      bidLevels: data.summary.bidLevels ?? 0,
      askLevels: data.summary.askLevels ?? 0,
      elapsedMs
    };
  } catch (err: any) {
    const elapsedMs = Date.now() - startMs;
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      return { symbol, status: "timeout", topBid: 0, topAsk: 0, bidLevels: 0, askLevels: 0, elapsedMs };
    }
    return { symbol, status: "error", topBid: 0, topAsk: 0, bidLevels: 0, askLevels: 0, elapsedMs, message: String(err?.message || err).slice(0, 100) };
  }
};

const computeFridays = (): string[] => {
  const today = new Date();
  const dow = today.getUTCDay();
  const daysUntilFriday = (5 - dow + 7) % 7 || 7;
  const fridays: string[] = [];
  for (let i = 0; i < 4; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + daysUntilFriday + i * 7);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    fridays.push(`${yyyy}${mm}${dd}`);
  }
  return fridays;
};

const daysFromNow = (yyyymmdd: string): number => {
  const yyyy = Number(yyyymmdd.slice(0, 4));
  const mm = Number(yyyymmdd.slice(4, 6)) - 1;
  const dd = Number(yyyymmdd.slice(6, 8));
  const expMs = Date.UTC(yyyy, mm, dd, 8, 0, 0);
  return (expMs - Date.now()) / 86_400_000;
};

const getSpot = async (): Promise<number> => {
  const r = await fetch("https://api.exchange.coinbase.com/products/BTC-USD/ticker", {
    signal: AbortSignal.timeout(5_000)
  });
  const j = (await r.json()) as { price: string };
  return Number(j.price);
};

const formatUsd = (n: number): string => `$${n.toFixed(2)}`;

const main = async (): Promise<void> => {
  if (!SHADOW_ADMIN_TOKEN) {
    console.error("ERR: SHADOW_ADMIN_TOKEN env var required");
    process.exit(1);
  }

  const spot = await getSpot();
  console.log(`\n${"=".repeat(72)}`);
  console.log(`Bullish Spread Feasibility Probe (via shadow proxy)`);
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log(`Spot (Coinbase): $${spot.toFixed(2)}`);
  console.log(`Shadow API: ${SHADOW_API}`);
  console.log(`${"=".repeat(72)}\n`);

  const triggerLow = Math.round(spot * (1 - TRIGGER_PCT));
  const triggerHigh = Math.round(spot * (1 + TRIGGER_PCT));
  const snapDown = (n: number) => Math.floor(n / STRIKE_TICK_USD) * STRIKE_TICK_USD;
  const snapUp = (n: number) => Math.ceil(n / STRIKE_TICK_USD) * STRIKE_TICK_USD;

  const putLong = snapUp(triggerLow);
  const putShort = putLong - SPREAD_WIDTH_USD;
  const callLong = snapDown(triggerHigh);
  const callShort = callLong + SPREAD_WIDTH_USD;

  console.log(`Cell 50k_2pct_1k @ spot $${spot.toFixed(0)}:`);
  console.log(`  Triggers: $${triggerLow} / $${triggerHigh}`);
  console.log(`  Spread layout:`);
  console.log(`    Put long  $${putLong} / short $${putShort} (width $${SPREAD_WIDTH_USD})`);
  console.log(`    Call long $${callLong} / short $${callShort} (width $${SPREAD_WIDTH_USD})`);
  console.log();

  const fridays = computeFridays();
  const expiriesToTest = [fridays[0], fridays[1]].filter(Boolean) as string[];
  console.log(`Testing 2 Friday expiries (Bullish standard):`);
  for (const e of expiriesToTest) console.log(`  ${e} (${daysFromNow(e).toFixed(2)}d)`);
  console.log();

  const calls: { expiry: string; strike: number; kind: "C" | "P"; role: string }[] = [];
  for (const expiry of expiriesToTest) {
    calls.push({ expiry, strike: putLong, kind: "P", role: "put_long" });
    calls.push({ expiry, strike: putShort, kind: "P", role: "put_short" });
    calls.push({ expiry, strike: callLong, kind: "C", role: "call_long" });
    calls.push({ expiry, strike: callShort, kind: "C", role: "call_short" });
  }

  console.log(`API calls: ${calls.length} via shadow proxy (throttle ${REQUEST_DELAY_MS}ms, timeout ${REQUEST_TIMEOUT_MS}ms each)\n`);

  const results: { call: typeof calls[number]; res: FetchResult }[] = [];

  for (const [i, call] of calls.entries()) {
    const symbol = buildSymbol(call.expiry, call.strike, call.kind);
    process.stdout.write(`[${i + 1}/${calls.length}] ${symbol} ... `);
    const res = await fetchOrderbook(symbol);
    results.push({ call, res });
    process.stdout.write(`${res.status} (${res.elapsedMs}ms)`);
    if (res.status === "ok") {
      process.stdout.write(`  bid=${formatUsd(res.topBid)} ask=${formatUsd(res.topAsk)} (${res.bidLevels}b/${res.askLevels}a)`);
    }
    if (res.message) process.stdout.write(`  msg=${res.message.slice(0, 80)}`);
    process.stdout.write("\n");

    if (earlyAbort) {
      console.log("Early abort triggered (rate limit). Stopping.");
      break;
    }
    await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`SUMMARY`);
  console.log(`${"=".repeat(72)}\n`);

  for (const expiry of expiriesToTest) {
    console.log(`\nExpiry ${expiry} (${daysFromNow(expiry).toFixed(2)}d):`);
    const expResults = results.filter((r) => r.call.expiry === expiry);
    if (expResults.length === 0) {
      console.log(`  (no data)`);
      continue;
    }

    const findRole = (role: string) => expResults.find((r) => r.call.role === role);
    const putL = findRole("put_long");
    const putS = findRole("put_short");
    const callL = findRole("call_long");
    const callS = findRole("call_short");

    const printLeg = (label: string, x: typeof putL) => {
      if (!x) return console.log(`  ${label}: skipped`);
      if (x.res.status === "ok") {
        console.log(`  ${label.padEnd(16, " ")} $${x.call.strike.toString().padEnd(6, " ")}: bid=${formatUsd(x.res.topBid).padStart(8, " ")} ask=${formatUsd(x.res.topAsk).padStart(8, " ")} (${x.res.bidLevels}b/${x.res.askLevels}a)`);
      } else {
        console.log(`  ${label.padEnd(16, " ")} $${x.call.strike.toString().padEnd(6, " ")}: ${x.res.status}${x.res.message ? ` (${x.res.message.slice(0, 50)})` : ""}`);
      }
    };

    printLeg("put LONG", putL);
    printLeg("put SHORT", putS);
    printLeg("call LONG", callL);
    printLeg("call SHORT", callS);

    const okPutL = putL?.res.status === "ok";
    const okPutS = putS?.res.status === "ok";
    const okCallL = callL?.res.status === "ok";
    const okCallS = callS?.res.status === "ok";

    if (okPutL && okPutS && okCallL && okCallS) {
      const putAsk = putL!.res.topAsk;
      const putShortBid = putS!.res.topBid;
      const callAsk = callL!.res.topAsk;
      const callShortBid = callS!.res.topBid;

      const putSpreadAsk = putAsk - putShortBid;
      const callSpreadAsk = callAsk - callShortBid;
      const totalSpreadCost = (putSpreadAsk + callSpreadAsk) * 0.5;

      const shortPutFeasible = putShortBid > 0 && putS!.res.bidLevels > 0;
      const shortCallFeasible = callShortBid > 0 && callS!.res.bidLevels > 0;

      console.log(`\n  SPREAD ECONOMICS (0.5 BTC, $${SPREAD_WIDTH_USD} width):`);
      console.log(`    Put spread:  long_ask=${formatUsd(putAsk)} − short_bid=${formatUsd(putShortBid)} = ${formatUsd(putSpreadAsk)}/BTC`);
      console.log(`    Call spread: long_ask=${formatUsd(callAsk)} − short_bid=${formatUsd(callShortBid)} = ${formatUsd(callSpreadAsk)}/BTC`);
      console.log(`    TOTAL hedge cost: ${formatUsd(totalSpreadCost)}`);
      console.log(`    Short-leg feasibility: put_short_bid=${shortPutFeasible ? "✓" : "✗"} call_short_bid=${shortCallFeasible ? "✓" : "✗"}`);

      const premium = 700; // 2d × $350
      const realized = -totalSpreadCost * 0.5;
      console.log(`    Atticus net (2d hold, 50% rec): premium $${premium} − loss ${formatUsd(-realized)} = ${formatUsd(premium + realized)}`);

      if (!shortPutFeasible || !shortCallFeasible) {
        console.log(`    ⚠ NOT FEASIBLE: short legs need bid-side liquidity to sell-to-open`);
      }
    } else {
      console.log(`\n  SPREAD ECONOMICS: incomplete (one or more legs unavailable)`);
    }
  }

  console.log(`\n${"=".repeat(72)}\n`);
};

main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
