/**
 * Perp Protect — pricing & venue sanity check (ops/diagnostic, read-only).
 *
 * Calls the live quote endpoint with the ADMIN token (so the response carries the internal
 * `venues_used` + `price_competitiveness` diagnostics), prints a readable summary, and independently
 * re-prices the recommended option's strike on Deribit to confirm our cross-venue hedge cost is
 * sane (we source the CHEAPEST qualifying ask, so ours should be ≤ Deribit's at the same strike).
 *
 * Usage:
 *   PERP_PROTECT_API_BASE=<live-api-host> \
 *   PERP_PROTECT_ADMIN_TOKEN=<PILOT_ADMIN_TOKEN> \
 *   npx tsx scripts/perpProtectSanity.ts --side long --size 30000 --lev 10 --tenor 3 [--entry 60000]
 *
 * Falls back to API_BASE=http://localhost:4100 and PILOT_ADMIN_TOKEN env for local runs.
 */

const argOf = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
};

const API_BASE = (process.env.PERP_PROTECT_API_BASE ?? "http://localhost:4100").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.PERP_PROTECT_ADMIN_TOKEN ?? process.env.PILOT_ADMIN_TOKEN ?? "";
const DERIBIT_BASE = process.env.DERIBIT_REST_BASE ?? "https://www.deribit.com";

const side = (argOf("side") ?? "long") as "long" | "short";
const sizeUsd = Number(argOf("size") ?? 30_000);
const leverage = Number(argOf("lev") ?? 10);
const tenorDays = Number(argOf("tenor") ?? 3);
const entry = argOf("entry") ? Number(argOf("entry")) : undefined;

const usd = (x: number | null | undefined) => (x == null ? "—" : `$${Math.round(x).toLocaleString()}`);
const pct = (x: number | null | undefined) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);

/** Independent Deribit ask (USDC/BTC) at the nearest listed strike+expiry — mirrors the server probe. */
async function deribitAsk(spot: number, strike: number, optType: "put" | "call", tenor: number): Promise<{ ask: number | null; strike: number | null; instrument: string | null }> {
  try {
    const now = Date.now();
    const inst = (await (await fetch(`${DERIBIT_BASE}/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false`)).json()) as {
      result?: Array<{ instrument_name?: string; strike?: number; option_type?: string; expiration_timestamp?: number }>;
    };
    const cands = (inst.result ?? []).filter((r) => r.option_type === optType && r.strike != null && r.expiration_timestamp != null && r.expiration_timestamp > now);
    if (!cands.length) return { ask: null, strike: null, instrument: null };
    const targetMs = now + tenor * 86_400_000;
    const expiry = [...new Set(cands.map((c) => c.expiration_timestamp!))].sort((a, b) => Math.abs(a - targetMs) - Math.abs(b - targetMs))[0];
    const pick = cands.filter((c) => c.expiration_timestamp === expiry).sort((a, b) => Math.abs(a.strike! - strike) - Math.abs(b.strike! - strike))[0];
    const ob = (await (await fetch(`${DERIBIT_BASE}/api/v2/public/get_order_book?instrument_name=${pick.instrument_name}`)).json()) as { result?: { best_ask_price?: number } };
    const askBtc = ob.result?.best_ask_price;
    return { ask: askBtc && askBtc > 0 ? +(askBtc * spot).toFixed(2) : null, strike: pick.strike ?? null, instrument: pick.instrument_name ?? null };
  } catch (e) {
    console.warn(`  (deribit cross-check failed: ${(e as Error).message})`);
    return { ask: null, strike: null, instrument: null };
  }
}

async function main() {
  if (!ADMIN_TOKEN) {
    console.error("Missing admin token. Set PERP_PROTECT_ADMIN_TOKEN or PILOT_ADMIN_TOKEN.");
    process.exit(1);
  }
  const body: Record<string, unknown> = { side, size_usd: sizeUsd, leverage, tenor_days: tenorDays };
  if (entry && entry > 0) body.entry_price = entry;

  console.log(`\n→ POST ${API_BASE}/admin/foxify/v2/perp-protect/quote`);
  console.log(`  ${JSON.stringify(body)}\n`);
  const res = await fetch(`${API_BASE}/admin/foxify/v2/perp-protect/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Token": ADMIN_TOKEN },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const q = await res.json() as any;
  const p = q.position;
  console.log(`POSITION  ${p.side} · spot ${usd(p.spot)} · entry ${usd(p.entry_price)} · size ${p.size_btc} BTC (${usd(p.notional_usdc)}) · ${p.leverage}× · margin ${usd(p.margin_usdc)}`);
  console.log(`LIQUIDATION  ${usd(q.liquidation?.price)} (${pct(q.liquidation?.move_pct)})  ·  tenor ${q.tenor_days}d  ·  settlement ${q.settlement_style}\n`);

  console.log("OPTIONS");
  console.log("  label                 strike     premium    hedge/BTC   worst-case   %margin   beforeLiq  rec");
  for (const o of q.options as any[]) {
    const hedgePerBtc = p.size_btc > 0 ? o.hedge_cost_usdc / p.size_btc : 0;
    console.log(
      `  ${String(o.label).padEnd(20)}  ${usd(o.strike).padStart(8)}  ${usd(o.premium_usdc).padStart(8)}  ${usd(hedgePerBtc).padStart(9)}  ${usd(o.worst_case_usdc).padStart(10)}  ${pct(o.cost_pct_margin).padStart(7)}  ${String(o.protects_before_liq).padStart(8)}  ${o.recommended ? "★" : ""}`
    );
  }

  const expected = ["okx", "deribit", "bullish"];
  if (Array.isArray(q.venues_considered)) {
    console.log(`\nVENUES REACHABLE (returned a quote):  ${q.venues_considered.length ? q.venues_considered.join(", ") : "(none!)"}`);
    const missing = expected.filter((v) => !q.venues_considered.includes(v));
    if (missing.length) console.log(`  ⚠ NOT reachable / no listing: ${missing.join(", ")}  (bullish only quotes from the whitelisted Render deploy)`);
  } else {
    console.log(`\nVENUES:  (venues_considered absent — not an admin token?)`);
  }
  if (Array.isArray(q.venues_used)) console.log(`VENUES WON (cheapest on price):  ${q.venues_used.length ? q.venues_used.join(", ") : "(none)"}`);

  if (q.price_competitiveness) {
    const c = q.price_competitiveness;
    const cmp = (q.options as any[]).find((o) => o.id === c.compared_option_id);
    const optType = p.side === "short" ? "CALL" : "PUT";
    console.log(`\nBYBIT — apples-to-apples (same strike, nearest expiry, same ${p.size_btc} BTC):`);
    if (c.available) {
      const spreadStr = c.bybit_spread_pct == null ? "n/a (one-sided book)" : `${(c.bybit_spread_pct * 100).toFixed(1)}%`;
      console.log(`  Atticus  ${optType} @ ${usd(cmp?.strike)}        premium ${usd(c.atticus_premium_usdc)}   (raw hedge ${usd(c.atticus_hedge_cost_usdc)})`);
      console.log(`  Bybit    ${c.bybit_symbol ?? `${optType} @ ${usd(c.bybit_strike)}`}`);
      console.log(`           bid ${usd(c.bybit_bid_usdc_per_btc)} / ask ${usd(c.bybit_ask_usdc_per_btc)} per BTC  ·  spread ${spreadStr}  ·  ask→premium ${usd(c.bybit_premium_usdc)}`);
      console.log(`  → retail: ${c.beats_bybit_retail ? "WE WIN" : "Bybit cheaper"} by ${usd(Math.abs(c.retail_edge_usdc))}   ·   hedge headroom vs Bybit: ${usd(c.hedge_edge_usdc)}`);
      if (c.bybit_fillable === false) {
        console.log(`  ⚠ Bybit ask is NOT fillable (book too wide / one-sided) — treat "Bybit cheaper" with caution; you likely couldn't transact at that ask.`);
      }
      if (cmp && c.bybit_strike != null && Math.round(cmp.strike) !== Math.round(c.bybit_strike)) {
        console.log(`  ⚠ strike mismatch: ours ${usd(cmp.strike)} vs Bybit ${usd(c.bybit_strike)} — comparison is nearest-listed, not identical.`);
      }
    } else {
      console.log(`  unavailable (Bybit region-gated / no matching listing). On the Singapore deploy this populates.`);
    }
  }

  // Independent Deribit re-price of the recommended option's strike.
  const rec = (q.options as any[]).find((o) => o.recommended) ?? (q.options as any[])[0];
  if (rec) {
    const optType: "put" | "call" = p.side === "short" ? "call" : "put";
    const d = await deribitAsk(p.spot, rec.strike, optType, q.tenor_days);
    const ourHedgePerBtc = p.size_btc > 0 ? rec.hedge_cost_usdc / p.size_btc : 0;
    console.log(`\nDERIBIT CROSS-CHECK (recommended ${rec.label} @ ${usd(rec.strike)} ${optType}):`);
    console.log(`  our sourced hedge ${usd(ourHedgePerBtc)}/BTC  vs  Deribit ask ${usd(d.ask)}/BTC${d.strike ? ` @ ${usd(d.strike)}` : ""}`);
    if (d.ask != null) {
      const ok = ourHedgePerBtc <= d.ask * 1.02; // allow 2% for snap/expiry differences
      console.log(`  ${ok ? "✓ sane — our cross-venue source is at/below Deribit" : "⚠ our hedge is ABOVE Deribit — check venue selection/units"}`);
    }
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
