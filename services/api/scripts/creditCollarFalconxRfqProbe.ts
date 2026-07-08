/**
 * FalconX Options RFQ probe — READ-ONLY (quotes only; NEVER executes; RFQs are closed after quoting).
 * Per FalconX "Options RFQ API V2":
 *   1. GET  /v3/derivatives/option/tokens       — tradable token pairs (auth check)
 *   2. POST /v3/derivatives/option/instruments  — the ACTUAL tradable symbols (no more guessing)
 *   3. POST /v3/derivatives/option/quote        — single-leg + collar-as-one-structure quotes
 *   4. POST /v3/derivatives/option/quote/close_rfq — close every RFQ we opened (leave nothing dangling)
 *
 * Auto-picks the pilot collar from the live instrument list: nearest expiry ≥ MIN_HOURS out, call strike
 * ≈ spot×(1+CAP_PCT), put strike ≈ spot×(1−FLOOR_PCT). Symbol format: BTC-USDC-29AUG25-120000.0-C.
 * The quote response also returns incremental_im_for_trade — FalconX's own margin number per trade.
 *
 * Env: FALCONX_API_KEY / FALCONX_SECRET / FALCONX_PASSPHRASE (required) · FALCONX_BASE_URL
 *      PROBE_QTY_BTC (default 0.8) · PROBE_CAP_PCT (0.02) · PROBE_FLOOR_PCT (0.06) · PROBE_MIN_HOURS (10)
 *      PROBE_CALL_SYMBOL / PROBE_PUT_SYMBOL (optional manual override — skips auto-pick)
 *
 * Run: npx tsx scripts/creditCollarFalconxRfqProbe.ts
 */

import { createHmac, randomUUID } from "node:crypto";

const BASE = process.env.FALCONX_BASE_URL || "https://api.falconx.io";
const KEY = process.env.FALCONX_API_KEY || "";
const SECRET = process.env.FALCONX_SECRET || "";
const PASSPHRASE = process.env.FALCONX_PASSPHRASE || "";
const QTY = Number(process.env.PROBE_QTY_BTC ?? 0.8);
const CAP_PCT = Number(process.env.PROBE_CAP_PCT ?? 0.02);
const FLOOR_PCT = Number(process.env.PROBE_FLOOR_PCT ?? 0.06);
const MIN_HOURS = Number(process.env.PROBE_MIN_HOURS ?? 10);

const sign = (ts: string, method: string, path: string, body: string): string =>
  createHmac("sha256", Buffer.from(SECRET, "base64")).update(`${ts}${method.toUpperCase()}${path}${body}`).digest("base64");

const request = async (path: string, method: "GET" | "POST", body: Record<string, unknown> | null): Promise<{ status: number; json: any }> => {
  const ts = String(Date.now() / 1000);
  const payload = body ? JSON.stringify(body) : "";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "FX-ACCESS-KEY": KEY,
      "FX-ACCESS-SIGN": sign(ts, method, path, payload),
      "FX-ACCESS-TIMESTAMP": ts,
      "FX-ACCESS-PASSPHRASE": PASSPHRASE
    },
    body: body ? payload : undefined
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: res.status, json };
};

const show = (label: string, r: { status: number; json: unknown }, maxLen = 2600) => {
  console.log(`\n── ${label} [HTTP ${r.status}] ─────────────────────────────`);
  console.log(JSON.stringify(r.json, null, 2).slice(0, maxLen));
};

type Instrument = { strike: string; epoch_time_expiry: string; type: "call" | "put"; symbol: string };

const openedRfqIds: string[] = [];
const quoteAndTrack = async (label: string, structure: Array<{ side: "buy" | "sell"; symbol: string; weight: number }>) => {
  const r = await request("/v3/derivatives/option/quote", "POST", {
    token_pair: { base_token: "BTC", quote_token: "USDC" },
    quantity: QTY,
    structure,
    client_order_id: randomUUID()
  });
  show(label, r.json?.legs ? { status: r.status, json: { status: r.json.status, rfq_id: r.json.rfq_id, fx_quote_id: r.json.fx_quote_id, mark_price: r.json.mark_price, ask_price: r.json.ask_price, greeks: r.json.greeks, incremental_im_for_trade: r.json.incremental_im_for_trade, t_quote: r.json.t_quote, t_expiry: r.json.t_expiry, rfq_expiry: r.json.rfq_expiry, legs: r.json.legs, error: r.json.error } } : r);
  if (r.json?.rfq_id) openedRfqIds.push(String(r.json.rfq_id));
  return r;
};

const main = async () => {
  if (!KEY || !SECRET || !PASSPHRASE) {
    console.error("Missing credentials. Set FALCONX_API_KEY, FALCONX_SECRET, FALCONX_PASSPHRASE.");
    process.exit(1);
  }
  console.log(`FalconX Options RFQ probe (READ-ONLY — quotes only, all RFQs closed after) · ${BASE} · qty ${QTY} BTC`);

  // 1) Tradable tokens (auth check).
  show("1. tradable tokens", await request("/v3/derivatives/option/tokens", "GET", null), 800);

  // 2) Tradable instruments — the real symbol list.
  const inst = await request("/v3/derivatives/option/instruments", "POST", { token_pair: { base_token: "BTC", quote_token: "USDC" } });
  const instruments: Instrument[] = Array.isArray(inst.json?.instruments) ? inst.json.instruments : [];
  if (!instruments.length) {
    show("2. tradable instruments (EMPTY/ERROR)", inst);
    console.error("\nNo instruments returned — cannot proceed to quotes.");
    return;
  }
  const expiries = [...new Set(instruments.map((i) => Number(i.epoch_time_expiry)))].sort((a, b) => a - b);
  console.log(`\n── 2. tradable instruments: ${instruments.length} for BTC-USDC ─────────────────────────────`);
  console.log("expiries:", expiries.map((e) => `${new Date(e).toISOString().slice(0, 16)}Z (${((e - Date.now()) / 3_600_000).toFixed(0)}h out)`).join(" · "));

  // 3) Pick the pilot collar: nearest expiry ≥ MIN_HOURS, strikes nearest cap/floor targets.
  const targetExpiry = expiries.find((e) => e - Date.now() >= MIN_HOURS * 3_600_000) ?? expiries[0];
  const atExpiry = instruments.filter((i) => Number(i.epoch_time_expiry) === targetExpiry);
  const calls = atExpiry.filter((i) => i.type === "call");
  const puts = atExpiry.filter((i) => i.type === "put");
  const strikes = [...new Set(atExpiry.map((i) => Number(i.strike)))].sort((a, b) => a - b);
  const spotApprox = strikes[Math.floor(strikes.length / 2)]; // mid of listed strikes ≈ ATM
  const nearest = (arr: Instrument[], target: number) =>
    arr.reduce((best, i) => (Math.abs(Number(i.strike) - target) < Math.abs(Number(best.strike) - target) ? i : best), arr[0]);

  let callSym = process.env.PROBE_CALL_SYMBOL;
  let putSym = process.env.PROBE_PUT_SYMBOL;
  if (!callSym || !putSym) {
    const call = nearest(calls, spotApprox * (1 + CAP_PCT));
    const put = nearest(puts, spotApprox * (1 - FLOOR_PCT));
    callSym = call?.symbol;
    putSym = put?.symbol;
  }
  if (!callSym || !putSym) {
    console.error("Could not select instruments (no calls/puts at target expiry). Strikes:", strikes.join(","));
    return;
  }
  console.log(`picked expiry ${new Date(targetExpiry).toISOString()} · ~ATM ${spotApprox} · CALL ${callSym} (cap) · PUT ${putSym} (floor)`);

  // 4) Quotes: single legs (schema + each side's price), then the collar as ONE structure.
  await quoteAndTrack(`3a. single-leg: SELL ${callSym} (cap we'd sell)`, [{ side: "sell", symbol: callSym, weight: 1 }]);
  await quoteAndTrack(`3b. single-leg: BUY ${putSym} (floor we'd buy)`, [{ side: "buy", symbol: putSym, weight: 1 }]);
  await quoteAndTrack(`3c. COLLAR (one structure): sell call + buy put — the pilot trade`, [
    { side: "sell", symbol: callSym, weight: 1 },
    { side: "buy", symbol: putSym, weight: 1 }
  ]);

  // 5) Close every RFQ we opened — leave nothing dangling (there's a max-open-RFQ limit).
  for (const rfqId of openedRfqIds) {
    const c = await request("/v3/derivatives/option/quote/close_rfq", "POST", { rfq_id: rfqId });
    console.log(`closed rfq ${rfqId}: ${JSON.stringify(c.json)}`);
  }

  console.log(
    "\nDone — quotes only, all RFQs closed, NOTHING executed." +
      "\nRead the collar quote: ask_price.value NEGATIVE = net premium credited to us (the fundable credit per" +
      "\nunit; × qty for the clip). incremental_im_for_trade = FalconX's own margin for the trade. t_expiry −" +
      "\nt_quote = quote validity window. Compare the net credit against the OKX shadow pricing.\n"
  );
};

main().catch((e) => {
  console.error(`probe failed: ${(e as Error).message}`);
  process.exit(1);
});
