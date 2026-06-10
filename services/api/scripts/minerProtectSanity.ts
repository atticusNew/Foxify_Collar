/**
 * Miner Protect — sanity check (ops/diagnostic, read-only). Calls the live quote with the ADMIN
 * token and prints miner economics + breakeven floors + which hashprice source was used.
 *
 * Usage (Render shell — admin token auto-read from PILOT_ADMIN_TOKEN; Luxor used when LUXOR_API_KEY set):
 *   PERP_PROTECT_API_BASE=<live-api-host> \
 *   npm --workspace services/api run miner-protect:sanity -- \
 *     --hashrate 100000 --eff 30 --power 0.05 --tenor 30 [--btcperth 0.00000075] [--opex 0]
 */

const argOf = (n: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
};

const API_BASE = (process.env.PERP_PROTECT_API_BASE ?? "http://localhost:4100").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.PERP_PROTECT_ADMIN_TOKEN ?? process.env.PILOT_ADMIN_TOKEN ?? "";

const usd = (x: number | null | undefined) => (x == null ? "—" : `$${Math.round(x).toLocaleString()}`);

async function main() {
  if (!ADMIN_TOKEN) { console.error("Missing admin token (PERP_PROTECT_ADMIN_TOKEN or PILOT_ADMIN_TOKEN)."); process.exit(1); }
  const body: Record<string, unknown> = {
    hashrate_ths: Number(argOf("hashrate") ?? 100_000),
    efficiency_w_per_th: Number(argOf("eff") ?? 30),
    power_cost_usd_per_kwh: Number(argOf("power") ?? 0.05),
    other_opex_usd_per_day: Number(argOf("opex") ?? 0),
    tenor_days: Number(argOf("tenor") ?? 30)
  };
  if (argOf("btcperth")) body.btc_per_th_per_day = Number(argOf("btcperth")); // else server uses Luxor

  console.log(`\n→ POST ${API_BASE}/admin/foxify/v2/miner-protect/quote\n  ${JSON.stringify(body)}\n`);
  const res = await fetch(`${API_BASE}/admin/foxify/v2/miner-protect/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Token": ADMIN_TOKEN },
    body: JSON.stringify(body)
  });
  if (!res.ok) { console.error(`HTTP ${res.status}: ${await res.text()}`); process.exit(1); }
  const q = await res.json() as any;
  const m = q.miner;
  console.log(`HASHPRICE  source=${q.hashprice_source}  btc/TH/day=${q.btc_per_th_per_day}`);
  console.log(`MINER  ${m.hashrate_ths} TH/s · ${m.efficiency_w_per_th} W/TH · ${m.power_kw} kW · cost ${usd(m.cost_per_day_usd)}/day`);
  console.log(`       BTC/day ${m.btc_per_day} · ${m.tenor_days}d production ${m.expected_production_btc} BTC · gross ${usd(m.gross_revenue_usd)} · cost ${usd(m.period_cost_usd)}`);
  console.log(`BREAKEVEN  ${usd(m.breakeven_price_usd)}  (BTC spot ${usd(m.btc_price)})\n`);
  console.log("FLOORS");
  console.log("  label                  strike    premium   revenue floor  covers cost  rec");
  for (const o of (q.options ?? []) as any[]) {
    console.log(`  ${String(o.label).padEnd(21)}  ${usd(o.strike).padStart(7)}  ${usd(o.premium_usd).padStart(8)}  ${usd(o.revenue_floor_usd).padStart(12)}  ${String(o.covers_cost).padStart(10)}  ${o.recommended ? "★" : ""}`);
  }
  if (!q.options?.length) console.log("  (no tradable floors sourced — venues unreachable/region-gated locally?)");
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
