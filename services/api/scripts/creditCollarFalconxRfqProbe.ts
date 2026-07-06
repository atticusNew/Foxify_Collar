/**
 * FalconX RFQ probe — READ-ONLY (quotes only; NEVER executes). Pulls live two-way pricing for the pilot
 * collar from FalconX's derivatives RFQ so we can benchmark them against OKX screen pricing:
 *   1. auth check (GET open derivatives — harmless read),
 *   2. single-leg quotes (call / put) to learn their instrument + pricing schema,
 *   3. the COLLAR as one multi-leg structure (sell call + buy put), one net price — the actual pilot ask.
 *
 * Uses the same HMAC scheme as src/pilot/venue.ts (FX-ACCESS-KEY/SIGN/TIMESTAMP/PASSPHRASE, Coinbase-style
 * base64 HMAC-SHA256 over `${ts}${METHOD}${path}${body}`).
 *
 * Env:
 *   FALCONX_API_KEY / FALCONX_SECRET / FALCONX_PASSPHRASE   (required)
 *   FALCONX_BASE_URL      default https://api.falconx.io
 *   PROBE_QTY_BTC         default 0.8  (~$50k clip)
 *   PROBE_CALL_SYMBOL     default BTC-USD-1D-C   (override once we learn their exact symbology)
 *   PROBE_PUT_SYMBOL      default BTC-USD-1D-P
 *
 * Run: npx tsx scripts/creditCollarFalconxRfqProbe.ts
 */

import { createHmac, randomUUID } from "node:crypto";

const BASE = process.env.FALCONX_BASE_URL || "https://api.falconx.io";
const KEY = process.env.FALCONX_API_KEY || "";
const SECRET = process.env.FALCONX_SECRET || "";
const PASSPHRASE = process.env.FALCONX_PASSPHRASE || "";
const QTY = Number(process.env.PROBE_QTY_BTC ?? 0.8);
const CALL_SYMBOL = process.env.PROBE_CALL_SYMBOL || "BTC-USD-1D-C";
const PUT_SYMBOL = process.env.PROBE_PUT_SYMBOL || "BTC-USD-1D-P";

const sign = (ts: string, method: string, path: string, body: string): string =>
  createHmac("sha256", Buffer.from(SECRET, "base64")).update(`${ts}${method.toUpperCase()}${path}${body}`).digest("base64");

const request = async (path: string, method: "GET" | "POST", body: Record<string, unknown> | null): Promise<{ status: number; json: unknown }> => {
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
  let json: unknown;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: res.status, json };
};

const show = (label: string, r: { status: number; json: unknown }) => {
  console.log(`\n── ${label} [HTTP ${r.status}] ─────────────────────────────`);
  console.log(JSON.stringify(r.json, null, 2).slice(0, 3000));
};

const main = async () => {
  if (!KEY || !SECRET || !PASSPHRASE) {
    console.error("Missing credentials. Set FALCONX_API_KEY, FALCONX_SECRET, FALCONX_PASSPHRASE.");
    process.exit(1);
  }
  console.log(`FalconX RFQ probe (READ-ONLY — no execution) · ${BASE} · qty ${QTY} BTC · legs ${CALL_SYMBOL} / ${PUT_SYMBOL}`);

  // 1) Auth check — harmless read (open option positions; expected empty on a fresh account).
  show("auth check: GET /v1/derivatives (open options)", await request("/v1/derivatives?trade_status=open&product_type=option&market_list=BTC-USD", "GET", null));

  // 2) Single-leg RFQs — learn the schema (instrument symbology, bid/ask fields, quote TTL).
  const legPayload = (side: "buy" | "sell", symbol: string) => ({
    token_pair: { base_token: "BTC", quote_token: "USDC" },
    quantity: QTY,
    structure: [{ side, symbol, weight: 1 }],
    client_order_id: randomUUID()
  });
  show(`single-leg RFQ: SELL ${CALL_SYMBOL} (the cap we'd sell)`, await request("/v3/derivatives/option/quote", "POST", legPayload("sell", CALL_SYMBOL)));
  show(`single-leg RFQ: BUY ${PUT_SYMBOL} (the floor we'd buy)`, await request("/v3/derivatives/option/quote", "POST", legPayload("buy", PUT_SYMBOL)));

  // 3) The pilot collar as ONE structure — sell call + buy put, one net price (no legging).
  const collarPayload = {
    token_pair: { base_token: "BTC", quote_token: "USDC" },
    quantity: QTY,
    structure: [
      { side: "sell", symbol: CALL_SYMBOL, weight: 1 },
      { side: "buy", symbol: PUT_SYMBOL, weight: 1 }
    ],
    client_order_id: randomUUID()
  };
  show("COLLAR RFQ (one structure): sell call + buy put — the pilot trade", await request("/v3/derivatives/option/quote", "POST", collarPayload));

  console.log(
    "\nRead-only probe complete — NOTHING was executed. If quotes came back: bid/ask on the collar = the net" +
      "\ncredit FalconX would pay us per clip; compare against the shadow's OKX pricing. If the symbol format was" +
      "\nrejected, use the error/response schema above to set PROBE_CALL_SYMBOL / PROBE_PUT_SYMBOL and rerun.\n"
  );
};

main().catch((e) => {
  console.error(`probe failed: ${(e as Error).message}`);
  process.exit(1);
});
