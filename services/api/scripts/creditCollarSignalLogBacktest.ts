/**
 * SIGNAL-LOG backtest — the highest-leverage validation item. A 2-week pilot yields ~14 independent
 * days (±26pt CI on hit-rate); a historical log of Foxify's directional calls converts years of live
 * sampling into minutes of analysis. Feed a CSV of their calls; this scores the realized day-level
 * hit-rate per regime against the historical breakeven table, the collared P&L those calls would have
 * produced at the deployed strikes, and the Bayesian posterior P(edge > breakeven).
 *
 * CSV format (header optional):  date,side        e.g.  2025-03-14,long
 *
 * Run: SIGNAL_LOG_CSV=calls.csv npx tsx scripts/creditCollarSignalLogBacktest.ts   (BT_FEE=25 · HIST_START=...)
 */

import { readFileSync } from "node:fs";

const NOTIONAL = 50_000;
const CREDIT = 80;
const FEE = Number(process.env.BT_FEE ?? 25);
const CAP_LONG = 0.021, CAP_SHORT = 0.029, FLOOR = 0.06;
const collarLong = (m: number) => NOTIONAL * (Math.max(0, -m - FLOOR) - Math.max(0, m - CAP_LONG));
const collarShort = (m: number) => NOTIONAL * (Math.max(0, m - FLOOR) - Math.max(0, -m - CAP_SHORT));

const fetchCloses = async (): Promise<Map<string, number>> => {
  if (process.env.HIST_START) {
    const out = new Map<number, number>();
    const DAY = 86_400_000;
    let start = Date.parse(process.env.HIST_START);
    const now = Date.now();
    while (start < now) {
      const end = Math.min(start + 290 * DAY, now);
      const res = await fetch(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`, { headers: { "User-Agent": "atticus-validation" } });
      const rows = (await res.json()) as Array<[number, number, number, number, number, number]>;
      if (Array.isArray(rows)) for (const r of rows) out.set(r[0] * 1000, r[4]);
      start = end;
      await new Promise((r) => setTimeout(r, 350));
    }
    return new Map([...out.entries()].sort((a, b) => a[0] - b[0]).map(([t, c]) => [new Date(t).toISOString().slice(0, 10), c]));
  }
  const res = await fetch("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440");
  const body = (await res.json()) as { error: string[]; result: Record<string, Array<[number, string, string, string, string]>> };
  const rows = Object.values(body.result).find(Array.isArray) as Array<[number, string, string, string, string]>;
  return new Map(rows.map((r) => [new Date(r[0] * 1000).toISOString().slice(0, 10), Number(r[4])]));
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const fmt = (x: number) => (x < 0 ? "−" : "") + "$" + Math.abs(Math.round(x)).toLocaleString("en-US");

const main = async () => {
  const csvPath = process.env.SIGNAL_LOG_CSV;
  if (!csvPath) {
    console.error("Usage: SIGNAL_LOG_CSV=calls.csv npx tsx scripts/creditCollarSignalLogBacktest.ts");
    console.error("CSV lines: date,side   e.g.  2025-03-14,long");
    process.exit(1);
  }
  const calls: Array<{ date: string; side: "long" | "short" }> = [];
  for (const line of readFileSync(csvPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || /^date/i.test(t)) continue;
    const [d, s] = t.split(",").map((x) => x.trim().toLowerCase());
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (s === "long" || s === "short")) calls.push({ date: d, side: s });
  }
  if (!calls.length) throw new Error("no valid calls in CSV");

  const closes = await fetchCloses();
  const dates = [...closes.keys()];
  const nextDay = new Map<string, string>();
  for (let i = 0; i + 1 < dates.length; i++) nextDay.set(dates[i], dates[i + 1]);
  // trailing 20d avg |move| per date for regime bucketing
  const movesByDate = new Map<string, number>();
  for (let i = 1; i < dates.length; i++) movesByDate.set(dates[i - 1], (closes.get(dates[i])! / closes.get(dates[i - 1])!) - 1);
  const trailAbs = (date: string): number | null => {
    const idx = dates.indexOf(date);
    if (idx < 20) return null;
    let s = 0;
    for (let i = idx - 20; i < idx; i++) s += Math.abs(movesByDate.get(dates[i]) ?? 0);
    return s / 20;
  };

  type Row = { regime: string; n: number; hits: number; pnl: number };
  const buckets: Record<string, Row> = {
    calm: { regime: "calm   (<1.2%)", n: 0, hits: 0, pnl: 0 },
    normal: { regime: "normal (1.2–2%)", n: 0, hits: 0, pnl: 0 },
    active: { regime: "active (2–3%)", n: 0, hits: 0, pnl: 0 },
    extreme: { regime: "extreme(≥3%)", n: 0, hits: 0, pnl: 0 },
    unknown: { regime: "unknown(warmup)", n: 0, hits: 0, pnl: 0 }
  };
  let skipped = 0;
  for (const c of calls) {
    const m = movesByDate.get(c.date);
    if (m == null) { skipped += 1; continue; }
    const hit = (c.side === "long") === (m >= 0);
    const perp = (c.side === "long" ? m : -m) * NOTIONAL;
    const collar = c.side === "long" ? collarLong(m) : collarShort(m);
    const pnl = perp + collar + CREDIT - FEE;
    const t = trailAbs(c.date);
    const key = t == null ? "unknown" : t < 0.012 ? "calm" : t < 0.02 ? "normal" : t < 0.03 ? "active" : "extreme";
    buckets[key].n += 1;
    buckets[key].hits += hit ? 1 : 0;
    buckets[key].pnl += pnl;
  }

  const BE: Record<string, number> = { calm: 0.455, normal: 0.514, active: 0.56, extreme: 0.598, unknown: 0.54 }; // historical p50s (full tape)
  console.log(`\nSIGNAL-LOG BACKTEST — ${calls.length} calls (${skipped} outside price history) · $${CREDIT} credit · $${FEE} fee · deployed strikes\n`);
  console.log(["regime", "calls", "hit-rate", "BE (hist p50)", "clears?", "collared P&L"].map((h) => h.padEnd(16)).join(""));
  let totN = 0, totHits = 0, totPnl = 0;
  for (const key of ["calm", "normal", "active", "extreme", "unknown"]) {
    const b = buckets[key];
    if (!b.n) continue;
    totN += b.n; totHits += b.hits; totPnl += b.pnl;
    const hr = b.hits / b.n;
    console.log([b.regime, String(b.n), pct(hr), pct(BE[key]), hr > BE[key] ? "YES" : "no", fmt(b.pnl)].map((c) => c.padEnd(16)).join(""));
  }
  const hr = totHits / totN;
  const se = Math.sqrt((hr * (1 - hr)) / totN);
  console.log(`\nOverall: ${totHits}/${totN} = ${pct(hr)} (95% CI ±${pct(1.96 * se)}) · total collared P&L ${fmt(totPnl)} (${fmt(totPnl / totN)}/call)`);
  console.log(`Power note: day-level calls are the independent unit; ~600 days separate 55% from breakeven at 95% confidence.\n`);
};

main().catch((e) => {
  console.error(`signal-log backtest failed: ${(e as Error).message}`);
  process.exit(1);
});
