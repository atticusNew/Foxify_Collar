#!/usr/bin/env tsx
/**
 * Live Deribit strangle chain probe — read-only, public-endpoint, no auth.
 *
 * Purpose: ground-truth the actual cost of the tight strangle hedge for
 * 50k_2pct_1k across multiple tenors so we can stop estimating and price
 * the matrix against reality.
 *
 * For each tenor (1d/2d/3d/5d/7d/14d):
 *   - Find closest Deribit expiry
 *   - Pull orderbook for 1% OTM and 2% OTM strikes (call + put)
 *   - Compute MID (passive limit fill expectation) and ASK/BID
 *     (aggressive market-order expectation)
 *   - Aggregate strangle cost for 1.4 BTC contracts (50k_2pct_1k size)
 *   - Back-solve ATM IV from observed prices
 *
 * Output: CSV-ish table per tenor with the breakdown.
 *
 * Run:
 *   npx tsx services/api/scripts/probes/deribit_strangle_chain_probe.ts
 */

const DERIBIT = "https://www.deribit.com/api/v2/public";

const HEDGE_PCT = 0.01; // strikes at 1% OTM (current code default)
const TRIGGER_PCT = 0.02; // strikes at 2% OTM (matrix-priced layout)
const CONTRACTS_BTC = 1.4; // 50k_2pct_1k effective contract size

const TENOR_TARGETS_DAYS = [1, 2, 3, 5, 7, 14];

type Instrument = {
  instrument_name: string;
  expiration_timestamp: number;
  strike: number;
  option_type: "call" | "put";
};

type Quote = {
  best_bid_price: number;
  best_ask_price: number;
  mark_price: number;
  index_price: number;
  underlying_price: number;
  mark_iv: number;
  bid_iv: number;
  ask_iv: number;
};

const fetchJson = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
  const j = await r.json();
  return j.result as T;
};

const getIndex = async (): Promise<number> => {
  const r = await fetchJson<{ index_price: number }>(
    `${DERIBIT}/get_index_price?index_name=btc_usd`
  );
  return r.index_price;
};

const listInstruments = async (): Promise<Instrument[]> => {
  return await fetchJson<Instrument[]>(
    `${DERIBIT}/get_instruments?currency=BTC&kind=option&expired=false`
  );
};

const getQuote = async (instrument: string): Promise<Quote | null> => {
  try {
    return await fetchJson<Quote>(
      `${DERIBIT}/ticker?instrument_name=${encodeURIComponent(instrument)}`
    );
  } catch {
    return null;
  }
};

const closestStrike = (
  candidates: Instrument[],
  desiredStrike: number,
  type: "call" | "put"
): Instrument | null => {
  const filtered = candidates.filter((i) => i.option_type === type);
  if (filtered.length === 0) return null;
  return filtered.reduce((best, cur) => {
    const dBest = Math.abs(best.strike - desiredStrike);
    const dCur = Math.abs(cur.strike - desiredStrike);
    return dCur < dBest ? cur : best;
  });
};

const main = async (): Promise<void> => {
  const spot = await getIndex();
  console.log(`\n=== Deribit live probe @ ${new Date().toISOString()} ===`);
  console.log(`BTC spot (Deribit index): $${spot.toFixed(2)}\n`);

  const all = await listInstruments();
  // Bucket by expiry
  const byExpiry = new Map<number, Instrument[]>();
  for (const inst of all) {
    if (!byExpiry.has(inst.expiration_timestamp)) {
      byExpiry.set(inst.expiration_timestamp, []);
    }
    byExpiry.get(inst.expiration_timestamp)!.push(inst);
  }
  const expiries = [...byExpiry.keys()].sort((a, b) => a - b);

  const nowMs = Date.now();

  // Layout the strikes we'll be looking for
  const putStrike1pct = Math.round(spot * (1 - HEDGE_PCT));
  const callStrike1pct = Math.round(spot * (1 + HEDGE_PCT));
  const putStrike2pct = Math.round(spot * (1 - TRIGGER_PCT));
  const callStrike2pct = Math.round(spot * (1 + TRIGGER_PCT));

  console.log(`Target strikes:`);
  console.log(`  1% OTM: put $${putStrike1pct} / call $${callStrike1pct}`);
  console.log(`  2% OTM: put $${putStrike2pct} / call $${callStrike2pct}\n`);

  // Header
  console.log(
    [
      "tenor_d_target",
      "expiry",
      "days_actual",
      "layout",
      "put_strike",
      "put_bid",
      "put_ask",
      "put_mid",
      "call_strike",
      "call_bid",
      "call_ask",
      "call_mid",
      "strangle_mid_per_btc",
      "strangle_ask_per_btc",
      "strangle_cost_1.4btc_mid",
      "strangle_cost_1.4btc_ask",
      "atm_iv_back_solve_%"
    ].join("\t")
  );

  for (const targetDays of TENOR_TARGETS_DAYS) {
    const targetMs = nowMs + targetDays * 86_400_000;
    // Closest expiry >= now + 1h (avoid stale near-zero-DTE)
    const candidates = expiries.filter((e) => e > nowMs + 3_600_000);
    if (candidates.length === 0) {
      console.error(`No live expiries`);
      continue;
    }
    const chosenExpiry = candidates.reduce((best, cur) =>
      Math.abs(cur - targetMs) < Math.abs(best - targetMs) ? cur : best
    );
    const dActual = (chosenExpiry - nowMs) / 86_400_000;
    const instr = byExpiry.get(chosenExpiry)!;

    for (const [layoutName, putK, callK] of [
      ["1%_otm", putStrike1pct, callStrike1pct] as const,
      ["2%_otm", putStrike2pct, callStrike2pct] as const
    ]) {
      const put = closestStrike(instr, putK, "put");
      const call = closestStrike(instr, callK, "call");
      if (!put || !call) continue;
      const [putQ, callQ] = await Promise.all([
        getQuote(put.instrument_name),
        getQuote(call.instrument_name)
      ]);
      if (!putQ || !callQ) continue;

      // Deribit quotes premium in BTC. Convert to USDC using
      // underlying_price (which Deribit reports per instrument).
      const ulPut = putQ.underlying_price || spot;
      const ulCall = callQ.underlying_price || spot;

      const putBidUsd = putQ.best_bid_price * ulPut;
      const putAskUsd = putQ.best_ask_price * ulPut;
      const putMidUsd = (putBidUsd + putAskUsd) / 2;

      const callBidUsd = callQ.best_bid_price * ulCall;
      const callAskUsd = callQ.best_ask_price * ulCall;
      const callMidUsd = (callBidUsd + callAskUsd) / 2;

      const strangleMidPerBtc = putMidUsd + callMidUsd;
      const strangleAskPerBtc = putAskUsd + callAskUsd;
      const strangleCostMid = strangleMidPerBtc * CONTRACTS_BTC;
      const strangleCostAsk = strangleAskPerBtc * CONTRACTS_BTC;

      // Back-solve ATM IV from put-call avg mark IV (mark_iv from Deribit
      // is already %, e.g. 34.5).
      const ivPct = ((putQ.mark_iv ?? 0) + (callQ.mark_iv ?? 0)) / 2;

      console.log(
        [
          targetDays,
          new Date(chosenExpiry).toISOString().slice(0, 10),
          dActual.toFixed(2),
          layoutName,
          put.strike,
          putBidUsd.toFixed(2),
          putAskUsd.toFixed(2),
          putMidUsd.toFixed(2),
          call.strike,
          callBidUsd.toFixed(2),
          callAskUsd.toFixed(2),
          callMidUsd.toFixed(2),
          strangleMidPerBtc.toFixed(2),
          strangleAskPerBtc.toFixed(2),
          strangleCostMid.toFixed(2),
          strangleCostAsk.toFixed(2),
          ivPct.toFixed(2)
        ].join("\t")
      );

      // Small throttle to be nice to public API
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  console.log(`\nDone.`);
};

main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
