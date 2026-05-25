#!/usr/bin/env tsx
/**
 * Bullish spread feasibility probe v2 (2026-05-22).
 *
 * v1 used a $500-tick assumption that didn't match Bullish's actual
 * strike grid; every symbol returned 404. This version first calls
 * /admin/bullish-option-chain to enumerate ACTUAL listed strikes, then
 * picks the closest available strike to each design target and probes
 * the orderbook for real bid/ask.
 *
 * Focuses on 50k_2pct_1k (the cell being actively optimized) and the
 * 1k_2pct_20 test cell (candidate for end-to-end Bullish validation).
 *
 * For each cell × design we resolve and probe:
 *   [DB] TIGHT-spread (long INSIDE trigger, short PAST trigger)
 *     - Put long at closest strike near (spot × (1 − hedgePct))
 *     - Put short at closest strike near (triggerLow − bufferUsdc)
 *     - Call long at closest strike near (spot × (1 + hedgePct))
 *     - Call short at closest strike near (triggerHigh + bufferUsdc)
 *
 * Required env:
 *   SHADOW_API=https://foxify-pilot-shadow-3r1m.onrender.com
 *   SHADOW_ADMIN_TOKEN=<shadow admin token>
 *
 * Run:
 *   SHADOW_API=... SHADOW_ADMIN_TOKEN=... \
 *     npx tsx services/api/scripts/probes/bullish_spread_chain_probe_v2.ts
 *
 * Rate-limit awareness:
 *   - 1 call to /admin/bullish-option-chain (uses 60s-cached getMarkets;
 *     marginal Bullish request cost since the cache is shared with the
 *     admin dashboard).
 *   - N orderbook calls (4 strikes × 2 expiries × 2 cells = 16 max).
 *     Spaced 800ms apart with early abort on rate-limit signal.
 *   - Total Bullish-side requests: ~17 if all hit cold cache.
 */

const SHADOW_API = process.env.SHADOW_API || "https://foxify-pilot-shadow-3r1m.onrender.com";
const SHADOW_ADMIN_TOKEN = process.env.SHADOW_ADMIN_TOKEN || "";

if (!SHADOW_ADMIN_TOKEN) {
  console.error("Missing SHADOW_ADMIN_TOKEN env. Set it to the shadow admin token.");
  process.exit(1);
}

const REQUEST_DELAY_MS = 800;
const REQUEST_TIMEOUT_MS = 20_000;

// Cell focus — only the 50k_2pct optimization target + its test cell.
const CELLS_TO_PROBE: ReadonlyArray<{
  cellId: string;
  notionalUsdc: number;
  triggerPct: number;
  hedgePct: number;
  payoutUsdc: number;
  bufferUsdcPastTrigger: number;
}> = [
  // Test cell (real-fill candidate). Same shape as 50k_2pct_1k, 1/50th size.
  { cellId: "1k_2pct_20",   notionalUsdc:   1_000, triggerPct: 0.02, hedgePct: 0.01, payoutUsdc:  20, bufferUsdcPastTrigger: 1_000 },
  // Primary optimization target.
  { cellId: "50k_2pct_1k",  notionalUsdc:  50_000, triggerPct: 0.02, hedgePct: 0.01, payoutUsdc: 1_000, bufferUsdcPastTrigger: 1_000 }
];

type OptionChainResponse = {
  generatedAtIso: string;
  spotBtcUsdc: number;
  totalBtcOptionMarkets: number;
  expiriesInWindow: string[];
  cellAnalysis: Array<{
    cellId: string;
    targetPutStrike: number;
    targetCallStrike: number;
    triggerLow: number;
    triggerHigh: number;
    perExpiry: Array<{
      expiryDate: string;
      daysOut: number;
      totalPuts: number;
      totalCalls: number;
      putsInHedgeZone: number[];
      callsInHedgeZone: number[];
      closestPutStrike: number;
      closestCallStrike: number;
      viable: boolean;
    }>;
  }>;
};

type OrderbookResponse = {
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

let earlyAbort = false;

const fetchJson = async <T,>(url: string): Promise<{ status: number; data: T | null; raw: string }> => {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "X-Admin-Token": SHADOW_ADMIN_TOKEN, Accept: "application/json" }
  });
  const raw = await r.text();
  try {
    const data = JSON.parse(raw) as T;
    return { status: r.status, data, raw };
  } catch {
    return { status: r.status, data: null, raw };
  }
};

const fetchOrderbook = async (
  symbol: string
): Promise<{
  symbol: string;
  status: "ok" | "rate_limited" | "not_listed" | "error";
  topBidUsdc: number | null;
  topBidQty: number | null;
  topAskUsdc: number | null;
  topAskQty: number | null;
  midUsdc: number | null;
  spreadPct: number | null;
  bidLevels: number;
  askLevels: number;
  message?: string;
  elapsedMs: number;
}> => {
  const startMs = Date.now();
  if (earlyAbort) {
    return {
      symbol, status: "rate_limited",
      topBidUsdc: null, topBidQty: null, topAskUsdc: null, topAskQty: null,
      midUsdc: null, spreadPct: null, bidLevels: 0, askLevels: 0,
      elapsedMs: 0, message: "early abort"
    };
  }
  const url = `${SHADOW_API}/volume-cover/admin/bullish-orderbook?symbol=${encodeURIComponent(symbol)}&depth=3`;
  const { status, data, raw } = await fetchJson<OrderbookResponse>(url);
  const elapsedMs = Date.now() - startMs;

  if (raw.includes("RATE_LIMIT") || raw.includes("96100")) {
    earlyAbort = true;
    return {
      symbol, status: "rate_limited",
      topBidUsdc: null, topBidQty: null, topAskUsdc: null, topAskQty: null,
      midUsdc: null, spreadPct: null, bidLevels: 0, askLevels: 0,
      elapsedMs, message: "RATE_LIMIT_EXCEEDED"
    };
  }
  if (raw.includes("bullish_http_404")) {
    return {
      symbol, status: "not_listed",
      topBidUsdc: null, topBidQty: null, topAskUsdc: null, topAskQty: null,
      midUsdc: null, spreadPct: null, bidLevels: 0, askLevels: 0,
      elapsedMs, message: "bullish 404: market not found"
    };
  }
  if (status !== 200 || !data || !data.ok || !data.summary) {
    return {
      symbol, status: "error",
      topBidUsdc: null, topBidQty: null, topAskUsdc: null, topAskQty: null,
      midUsdc: null, spreadPct: null, bidLevels: 0, askLevels: 0,
      elapsedMs, message: data?.error ?? `HTTP ${status}`
    };
  }
  return {
    symbol, status: "ok",
    topBidUsdc: data.summary.topBid ? Number(data.summary.topBid.price) : null,
    topBidQty: data.summary.topBid ? Number(data.summary.topBid.quantity) : null,
    topAskUsdc: data.summary.topAsk ? Number(data.summary.topAsk.price) : null,
    topAskQty: data.summary.topAsk ? Number(data.summary.topAsk.quantity) : null,
    midUsdc: data.summary.midPrice,
    spreadPct: data.summary.spreadPct,
    bidLevels: data.summary.bidLevels ?? 0,
    askLevels: data.summary.askLevels ?? 0,
    elapsedMs
  };
};

const closestStrike = (strikes: number[], target: number): number | null => {
  if (strikes.length === 0) return null;
  return strikes.reduce((best, cur) => (Math.abs(cur - target) < Math.abs(best - target) ? cur : best));
};

const formatExpirySymbol = (expiryDate: string): string => expiryDate.replace(/-/g, "");
const buildSymbol = (expiry: string, strike: number, kind: "C" | "P"): string =>
  `BTC-USDC-${formatExpirySymbol(expiry)}-${strike}-${kind}`;

const f$ = (n: number | null): string => (n == null ? "  —  " : `$${n.toFixed(2)}`);
const fqty = (n: number | null): string => (n == null ? " — " : n.toFixed(3));
const fpct = (n: number | null): string => (n == null ? " — " : `${n.toFixed(2)}%`);

const main = async (): Promise<void> => {
  console.log(`\n${"=".repeat(88)}`);
  console.log(`Bullish spread feasibility probe v2`);
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log(`Shadow: ${SHADOW_API}`);
  console.log(`${"=".repeat(88)}\n`);

  // Step 1: enumerate the option chain (1 Bullish call via 60s shared cache)
  console.log(`[1/2] Fetching Bullish option chain enumeration...`);
  const { status, data: chain, raw } = await fetchJson<OptionChainResponse>(
    `${SHADOW_API}/volume-cover/admin/bullish-option-chain`
  );
  if (status !== 200 || !chain) {
    console.error(`  FAILED: HTTP ${status}: ${raw.slice(0, 300)}`);
    process.exit(1);
  }
  const spot = chain.spotBtcUsdc;
  console.log(`  Spot: $${spot.toFixed(2)}`);
  console.log(`  Total BTC option markets: ${chain.totalBtcOptionMarkets}`);
  console.log(`  Expiries available: ${chain.expiriesInWindow.join(", ")}\n`);

  // Step 2: per cell, resolve [DB] strikes and probe orderbook
  console.log(`[2/2] Probing [DB] TIGHT-spread strikes per cell...\n`);

  type ProbeRow = {
    cellId: string;
    expiry: string;
    daysOut: number;
    putLongStrike: number | null;
    putShortStrike: number | null;
    callLongStrike: number | null;
    callShortStrike: number | null;
    putLongBook: Awaited<ReturnType<typeof fetchOrderbook>> | null;
    putShortBook: Awaited<ReturnType<typeof fetchOrderbook>> | null;
    callLongBook: Awaited<ReturnType<typeof fetchOrderbook>> | null;
    callShortBook: Awaited<ReturnType<typeof fetchOrderbook>> | null;
  };
  const rows: ProbeRow[] = [];

  for (const cell of CELLS_TO_PROBE) {
    const cellChain = chain.cellAnalysis.find((c) => c.cellId === cell.cellId);
    if (!cellChain) {
      console.log(`  [skip] ${cell.cellId}: not in option-chain output`);
      continue;
    }

    // Targets (USDC-denominated)
    const triggerLow = cellChain.triggerLow;
    const triggerHigh = cellChain.triggerHigh;
    const putLongTarget = cellChain.targetPutStrike;
    const callLongTarget = cellChain.targetCallStrike;
    const putShortTarget = triggerLow - cell.bufferUsdcPastTrigger;
    const callShortTarget = triggerHigh + cell.bufferUsdcPastTrigger;

    // For 3d horizon: pick the expiry closest to 3 days (the live tenor for 2% cells).
    // Iterate ALL listed expiries; pick the two best for analysis (one near-term, one
    // further out) using all available strikes in the chain (not just hedge zone).

    // Pull all listed strikes from the perExpiry hedge-zone list, then union across
    // expiries to get a master list per expiry of *all* strikes Bullish lists.
    // The option-chain endpoint only returns hedge-zone strikes; for short legs we
    // need to look in WIDER cells' hedge-zone lists at the same expiry.

    // Quick approach: extract all strikes from the FULL chain by inspecting every
    // cell's perExpiry block at that expiry. Wider cells (10%/15% trigger) expose
    // strikes further from spot — those are the candidates for our short legs.

    const allStrikesAtExpiry = (expiryDate: string): { puts: number[]; calls: number[] } => {
      const puts = new Set<number>();
      const calls = new Set<number>();
      for (const c of chain.cellAnalysis) {
        const e = c.perExpiry.find((p) => p.expiryDate === expiryDate);
        if (!e) continue;
        for (const s of e.putsInHedgeZone) puts.add(s);
        for (const s of e.callsInHedgeZone) calls.add(s);
      }
      return { puts: [...puts].sort((a, b) => a - b), calls: [...calls].sort((a, b) => a - b) };
    };

    // Pick the 3-day expiry and the 6-day expiry for comparison
    const targetExpiries = chain.expiriesInWindow
      .map((dateStr) => {
        const peer = cellChain.perExpiry.find((p) => p.expiryDate === dateStr);
        return { dateStr, daysOut: peer?.daysOut ?? 0 };
      })
      .filter((e) => e.daysOut >= 1 && e.daysOut <= 10)
      .sort((a, b) => Math.abs(a.daysOut - 3) - Math.abs(b.daysOut - 3))
      .slice(0, 2);

    if (targetExpiries.length === 0) {
      console.log(`  [skip] ${cell.cellId}: no expiry in 1-10d window`);
      continue;
    }

    for (const ex of targetExpiries) {
      const { puts, calls } = allStrikesAtExpiry(ex.dateStr);

      const putLong = closestStrike(puts, putLongTarget);
      const putShort = closestStrike(puts, putShortTarget);
      const callLong = closestStrike(calls, callLongTarget);
      const callShort = closestStrike(calls, callShortTarget);

      console.log(`\n  ${cell.cellId} @ ${ex.dateStr} (${ex.daysOut}d):`);
      console.log(`    Targets:  putLong≈${putLongTarget.toFixed(0)} / putShort≈${putShortTarget.toFixed(0)} / callLong≈${callLongTarget.toFixed(0)} / callShort≈${callShortTarget.toFixed(0)}`);
      console.log(`    Resolved: putLong=$${putLong} / putShort=$${putShort} / callLong=$${callLong} / callShort=$${callShort}`);

      const orderbookFor = async (strike: number | null, kind: "C" | "P") => {
        if (strike == null) return null;
        const symbol = buildSymbol(ex.dateStr, strike, kind);
        const result = await fetchOrderbook(symbol);
        await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
        return result;
      };

      const putLongBook = await orderbookFor(putLong, "P");
      const putShortBook = await orderbookFor(putShort, "P");
      const callLongBook = await orderbookFor(callLong, "C");
      const callShortBook = await orderbookFor(callShort, "C");

      rows.push({
        cellId: cell.cellId,
        expiry: ex.dateStr,
        daysOut: ex.daysOut,
        putLongStrike: putLong,
        putShortStrike: putShort,
        callLongStrike: callLong,
        callShortStrike: callShort,
        putLongBook,
        putShortBook,
        callLongBook,
        callShortBook
      });

      if (earlyAbort) {
        console.log(`  [ABORT] Bullish rate limit hit; stopping further probes`);
        break;
      }
    }
    if (earlyAbort) break;
  }

  // Summary
  console.log(`\n\n${"=".repeat(88)}`);
  console.log(`SUMMARY — Bullish [DB] TIGHT-spread feasibility`);
  console.log(`${"=".repeat(88)}\n`);

  for (const r of rows) {
    console.log(`Cell: ${r.cellId} | Expiry: ${r.expiry} (${r.daysOut}d)`);
    console.log(`  ${("LEG").padEnd(20)} ${("STRIKE").padStart(8)} ${("BID").padStart(10)} ${("BID-QTY").padStart(10)} ${("ASK").padStart(10)} ${("ASK-QTY").padStart(10)} ${("SPRD").padStart(8)} ${("LEVELS B/A").padStart(12)} STATUS`);

    const printRow = (label: string, strike: number | null, book: any) => {
      if (book == null) {
        console.log(`  ${label.padEnd(20)} ${("—").padStart(8)} ${"—".padStart(10)} ${"—".padStart(10)} ${"—".padStart(10)} ${"—".padStart(10)} ${"—".padStart(8)} ${"—".padStart(12)} no_strike`);
        return;
      }
      const lev = `${book.bidLevels}/${book.askLevels}`;
      console.log(`  ${label.padEnd(20)} ${("$" + strike).padStart(8)} ${f$(book.topBidUsdc).padStart(10)} ${fqty(book.topBidQty).padStart(10)} ${f$(book.topAskUsdc).padStart(10)} ${fqty(book.topAskQty).padStart(10)} ${fpct(book.spreadPct).padStart(8)} ${lev.padStart(12)} ${book.status}${book.message ? " (" + book.message + ")" : ""}`);
    };

    printRow("[DB] put-long",   r.putLongStrike,   r.putLongBook);
    printRow("[DB] put-short",  r.putShortStrike,  r.putShortBook);
    printRow("[DB] call-long",  r.callLongStrike,  r.callLongBook);
    printRow("[DB] call-short", r.callShortStrike, r.callShortBook);

    // Net spread cost (ask side, worst-case taker)
    const putLongAsk = r.putLongBook?.status === "ok" ? r.putLongBook.topAskUsdc : null;
    const putShortBid = r.putShortBook?.status === "ok" ? r.putShortBook.topBidUsdc : null;
    const callLongAsk = r.callLongBook?.status === "ok" ? r.callLongBook.topAskUsdc : null;
    const callShortBid = r.callShortBook?.status === "ok" ? r.callShortBook.topBidUsdc : null;

    if (putLongAsk != null && putShortBid != null && callLongAsk != null && callShortBid != null) {
      const putDebit = putLongAsk - putShortBid;
      const callDebit = callLongAsk - callShortBid;
      const totalDebitPerBtc = putDebit + callDebit;
      console.log(`  → Net spread debit per BTC: $${totalDebitPerBtc.toFixed(2)} (put=$${putDebit.toFixed(2)}, call=$${callDebit.toFixed(2)})`);
    } else {
      console.log(`  → Net spread debit: incomplete (missing one or more legs)`);
    }
    console.log();
  }

  console.log(`${"=".repeat(88)}\n`);
};

main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
