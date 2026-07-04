/**
 * HISTORICAL validation of the directional breakeven table (reviewer ask: real tape, not parametric sims —
 * GBM understates fat tails). Fetches ~2 years of real BTC daily closes (Kraken public OHLC, no auth),
 * runs every rolling 14-day pilot window through the SAME collared payoff at the deployed strikes, and
 * reports the breakeven hit-rate per window — exactly (the pilot P&L is LINEAR in hit-rate h):
 *
 *   E[net | move m] = h·(win-side perp+collar) + (1−h)·(lose-side perp+collar) + credit − fee
 *   ⟹ window breakeven h* = −(ΣL + ΣC) / (ΣW − ΣL)
 *
 * Buckets windows by realized regime (avg |24h move|) so the historical numbers line up against the
 * simulated table (calm ≤50% · normal ~53–59% · extreme ~62–64% · 72% both-bind limit). Also reports the
 * fat-tail stat the sims miss: how often ≥5% prints appear inside otherwise-normal windows, and the
 * neutral-book net per window for reference.
 *
 * Run: npx tsx scripts/creditCollarHistoricalValidation.ts   (BT_FEE=25|80; CANDLES_JSON=path for offline)
 */

import { readFileSync } from "node:fs";

const NOTIONAL = 50_000;
const CREDIT = 80;
const FEE = Number(process.env.BT_FEE ?? 25);
const POS_PER_DAY = 2;
const WINDOW_DAYS = 14;

// Deployed strikes (pricer-solved at the $80 target, 6% floor).
const CAP_LONG = 0.021, CAP_SHORT = 0.029, FLOOR = 0.06;
const collarLong = (m: number) => NOTIONAL * (Math.max(0, -m - FLOOR) - Math.max(0, m - CAP_LONG));
const collarShort = (m: number) => NOTIONAL * (Math.max(0, m - FLOOR) - Math.max(0, -m - CAP_SHORT));

const fetchDailyCloses = async (): Promise<{ dates: string[]; closes: number[] }> => {
  if (process.env.CANDLES_JSON) {
    const raw = JSON.parse(readFileSync(process.env.CANDLES_JSON, "utf8")) as Array<[number, string, string, string, string]>;
    return { dates: raw.map((r) => new Date(r[0] * 1000).toISOString().slice(0, 10)), closes: raw.map((r) => Number(r[4])) };
  }
  const res = await fetch("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440");
  const body = (await res.json()) as { error: string[]; result: Record<string, Array<[number, string, string, string, string]>> };
  if (body.error?.length) throw new Error(`kraken: ${body.error.join(",")}`);
  const rows = Object.values(body.result).find(Array.isArray) as Array<[number, string, string, string, string]>;
  return { dates: rows.map((r) => new Date(r[0] * 1000).toISOString().slice(0, 10)), closes: rows.map((r) => Number(r[4])) };
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const fmt = (x: number) => (x < 0 ? "−" : "") + "$" + Math.abs(Math.round(x)).toLocaleString("en-US");
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};

const main = async () => {
  const { dates, closes } = await fetchDailyCloses();
  const moves: number[] = [];
  for (let i = 1; i < closes.length; i++) moves.push(closes[i] / closes[i - 1] - 1);
  console.log(`\nHISTORICAL VALIDATION — real BTC daily closes ${dates[0]} → ${dates[dates.length - 1]} (${moves.length} days, Kraken)`);
  console.log(`Deployed strikes: cap +${pct(CAP_LONG)}/−${pct(CAP_SHORT)} · floor ${pct(FLOOR)} · $${CREDIT} credit · $${FEE} fee · ${POS_PER_DAY}/day × ${WINDOW_DAYS}d windows\n`);

  // Fat-tail stat (what GBM misses).
  const big = moves.filter((m) => Math.abs(m) >= 0.05).length;
  console.log(`Fat tails: ${big}/${moves.length} days (${pct(big / moves.length)}) printed |move| ≥ 5%; max |move| ${pct(Math.max(...moves.map(Math.abs)))}\n`);

  type Win = { start: string; avgAbs: number; breakeven: number | null; neutralNet: number; e55: number; big: number };
  const windows: Win[] = [];
  for (let s = 0; s + WINDOW_DAYS < moves.length; s++) {
    const w = moves.slice(s, s + WINDOW_DAYS);
    let W = 0, L = 0, C = 0, neutral = 0;
    for (const m of w) {
      const winCollar = m >= 0 ? collarLong(m) : collarShort(m);
      const loseCollar = m >= 0 ? collarShort(m) : collarLong(m);
      W += POS_PER_DAY * (Math.abs(m) * NOTIONAL + winCollar);
      L += POS_PER_DAY * (-Math.abs(m) * NOTIONAL + loseCollar);
      C += POS_PER_DAY * (CREDIT - FEE);
      neutral += POS_PER_DAY * ((collarLong(m) + collarShort(m)) / 2 + CREDIT - FEE); // both sides ⟹ perps cancel
    }
    const denom = W - L;
    const be = denom > 1e-9 ? -(L + C) / denom : null; // E(h) = h·W + (1−h)·L + C = 0
    windows.push({
      start: dates[s + 1],
      avgAbs: w.reduce((a, m) => a + Math.abs(m), 0) / w.length,
      breakeven: be != null && be >= 0 && be <= 1 ? be : be != null && be < 0 ? 0 : null,
      neutralNet: neutral,
      e55: 0.55 * W + 0.45 * L + C,
      big: w.filter((m) => Math.abs(m) >= 0.05).length
    });
  }

  const buckets: Array<{ name: string; test: (w: Win) => boolean }> = [
    { name: "calm   (avg|m| < 1.2%)", test: (w) => w.avgAbs < 0.012 },
    { name: "normal (1.2–2%)", test: (w) => w.avgAbs >= 0.012 && w.avgAbs < 0.02 },
    { name: "active (2–3%)", test: (w) => w.avgAbs >= 0.02 && w.avgAbs < 0.03 },
    { name: "extreme(≥3%)", test: (w) => w.avgAbs >= 0.03 }
  ];

  console.log(["regime bucket", "windows", "BE p50", "BE p90", "worst BE", "net@55% p50", "neutral p50", "≥5% days/win"].map((h) => h.padEnd(16)).join(""));
  for (const b of buckets) {
    const ws = windows.filter(b.test);
    if (!ws.length) { console.log(`${b.name.padEnd(16)}0`); continue; }
    const bes = ws.map((w) => w.breakeven).filter((x): x is number => x != null);
    console.log(
      [
        b.name,
        String(ws.length),
        pct(median(bes)),
        pct(quantile(bes, 0.9)),
        pct(Math.max(...bes)),
        fmt(median(ws.map((w) => w.e55))),
        fmt(median(ws.map((w) => w.neutralNet))),
        (ws.reduce((a, w) => a + w.big, 0) / ws.length).toFixed(2)
      ].map((c) => c.padEnd(16)).join("")
    );
  }

  const allBes = windows.map((w) => w.breakeven).filter((x): x is number => x != null);
  console.log(`\nAll windows: breakeven p50 ${pct(median(allBes))} · p90 ${pct(quantile(allBes, 0.9))} · worst ${pct(Math.max(...allBes))}`);
  console.log(`Neutral both-sides book: p50 ${fmt(median(windows.map((w) => w.neutralNet)))} per fortnight · % positive ${pct(windows.filter((w) => w.neutralNet > 0).length / windows.length)}`);
  console.log(`Directional @55%: % windows positive ${pct(windows.filter((w) => w.e55 > 0).length / windows.length)}\n`);
};

main().catch((e) => {
  console.error(`validation failed: ${(e as Error).message}`);
  process.exit(1);
});
