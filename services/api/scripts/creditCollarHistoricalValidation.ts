/**
 * HISTORICAL validation of the directional breakeven table + GATED NEUTRAL REPLAY (reviewer asks: real
 * tape, crash-regime coverage, overlap-aware confidence intervals, and the calm-only policy replayed
 * rather than asserted).
 *
 * Data: real BTC daily closes. Default = Kraken (720d, single call). Set HIST_START=2019-01-01 to fetch
 * the full history via Coinbase paginated candles (COVID crash, May-2021, LUNA, FTX included).
 *
 * Per rolling 14-day pilot window (2 positions/day, deployed strikes cap 2.1/2.9 · floor 6):
 *   • directional breakeven hit-rate, EXACT (pilot P&L is linear in hit-rate h)
 *   • neutral both-sides net — UNGATED vs CALM-ONLY GATED (trailing 20-day avg |move| < 1.2% ⟹ issue,
 *     else pause). TRAILING-ONLY approximation of the live gate (daily candles can't replay the intra-day
 *     leading signal); the live gated shadow remains the binding instrument.
 *   • block-bootstrap 95% CIs (28-day blocks preserve autocorrelation; rolling windows are ~93%
 *     overlapping so naive quantiles overstate confidence).
 *
 * Run: npx tsx scripts/creditCollarHistoricalValidation.ts   (BT_FEE=25|80 · HIST_START=2019-01-01 · CANDLES_JSON=path)
 */

import { readFileSync } from "node:fs";

const NOTIONAL = 50_000;
const CREDIT = 80;
const FEE = Number(process.env.BT_FEE ?? 25);
const POS_PER_DAY = 2;
const WINDOW_DAYS = 14;
const GATE_LOOKBACK_DAYS = 20; // ≈ live trailing lookback (40 settled positions at 2/day)
const GATE_CALM_PCT = 0.012; // calm-only policy line

const CAP_LONG = 0.021, CAP_SHORT = 0.029, FLOOR = 0.06;
const collarLong = (m: number) => NOTIONAL * (Math.max(0, -m - FLOOR) - Math.max(0, m - CAP_LONG));
const collarShort = (m: number) => NOTIONAL * (Math.max(0, m - FLOOR) - Math.max(0, -m - CAP_SHORT));

// ── data ──────────────────────────────────────────────────────────────────────
const fetchKraken = async (): Promise<{ dates: string[]; closes: number[] }> => {
  const res = await fetch("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440");
  const body = (await res.json()) as { error: string[]; result: Record<string, Array<[number, string, string, string, string]>> };
  if (body.error?.length) throw new Error(`kraken: ${body.error.join(",")}`);
  const rows = Object.values(body.result).find(Array.isArray) as Array<[number, string, string, string, string]>;
  return { dates: rows.map((r) => new Date(r[0] * 1000).toISOString().slice(0, 10)), closes: rows.map((r) => Number(r[4])) };
};

const fetchCoinbaseSince = async (startIso: string): Promise<{ dates: string[]; closes: number[] }> => {
  const out = new Map<number, number>(); // ts → close
  const DAY = 86_400_000;
  let start = Date.parse(startIso);
  const now = Date.now();
  while (start < now) {
    const end = Math.min(start + 290 * DAY, now);
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    const res = await fetch(url, { headers: { "User-Agent": "atticus-validation" } });
    const rows = (await res.json()) as Array<[number, number, number, number, number, number]>;
    if (!Array.isArray(rows)) throw new Error(`coinbase: ${JSON.stringify(rows).slice(0, 120)}`);
    for (const r of rows) out.set(r[0] * 1000, r[4]); // [time, low, high, open, close, vol]
    start = end;
    await new Promise((r) => setTimeout(r, 350)); // public rate limit
  }
  const ts = [...out.keys()].sort((a, b) => a - b);
  return { dates: ts.map((t) => new Date(t).toISOString().slice(0, 10)), closes: ts.map((t) => out.get(t) as number) };
};

const fetchDailyCloses = async (): Promise<{ dates: string[]; closes: number[]; source: string }> => {
  if (process.env.CANDLES_JSON) {
    const raw = JSON.parse(readFileSync(process.env.CANDLES_JSON, "utf8")) as Array<[number, string, string, string, string]>;
    return { dates: raw.map((r) => new Date(r[0] * 1000).toISOString().slice(0, 10)), closes: raw.map((r) => Number(r[4])), source: "file" };
  }
  if (process.env.HIST_START) {
    const d = await fetchCoinbaseSince(process.env.HIST_START);
    return { ...d, source: "coinbase(paginated)" };
  }
  return { ...(await fetchKraken()), source: "kraken(720d)" };
};

// ── stats helpers ─────────────────────────────────────────────────────────────
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
const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ── per-window engines ────────────────────────────────────────────────────────
/** Directional breakeven over a window of moves: E(h) = h·ΣW + (1−h)·ΣL + ΣC = 0 ⟹ h* = −(L+C)/(W−L). */
const windowBreakeven = (w: number[]): number | null => {
  let W = 0, L = 0, C = 0;
  for (const m of w) {
    const winCollar = m >= 0 ? collarLong(m) : collarShort(m);
    const loseCollar = m >= 0 ? collarShort(m) : collarLong(m);
    W += POS_PER_DAY * (Math.abs(m) * NOTIONAL + winCollar);
    L += POS_PER_DAY * (-Math.abs(m) * NOTIONAL + loseCollar);
    C += POS_PER_DAY * (CREDIT - FEE);
  }
  const denom = W - L;
  if (denom <= 1e-9) return null;
  const be = -(L + C) / denom;
  return be < 0 ? 0 : be > 1 ? null : be;
};

/** Neutral both-sides net over a window; `eligible[i]` false ⟹ the gate paused that day (no open, no credit). */
const windowNeutralNet = (w: number[], eligible?: boolean[]): number => {
  let net = 0;
  for (let i = 0; i < w.length; i++) {
    if (eligible && !eligible[i]) continue;
    const m = w[i];
    net += POS_PER_DAY * ((collarLong(m) + collarShort(m)) / 2 + CREDIT - FEE);
  }
  return net;
};

const main = async () => {
  const { dates, closes, source } = await fetchDailyCloses();
  const moves: number[] = [];
  for (let i = 1; i < closes.length; i++) moves.push(closes[i] / closes[i - 1] - 1);

  console.log(`\nHISTORICAL VALIDATION — real BTC daily closes ${dates[0]} → ${dates[dates.length - 1]} (${moves.length} days, ${source})`);
  console.log(`Strikes cap +${pct(CAP_LONG)}/−${pct(CAP_SHORT)} · floor ${pct(FLOOR)} · $${CREDIT} credit · $${FEE} fee · ${POS_PER_DAY}/day × ${WINDOW_DAYS}d windows`);
  const big = moves.filter((m) => Math.abs(m) >= 0.05).length;
  console.log(`Fat tails: ${big}/${moves.length} days (${pct(big / moves.length)}) ≥5%; max |move| ${pct(Math.max(...moves.map(Math.abs)))}\n`);

  // Calm-only gate eligibility per day (trailing-only approximation of the live gate).
  const eligible: boolean[] = moves.map((_, i) => {
    if (i < GATE_LOOKBACK_DAYS) return true; // warm-up: allow (live gate would use the leading signal here)
    const trail = moves.slice(i - GATE_LOOKBACK_DAYS, i);
    return trail.reduce((a, m) => a + Math.abs(m), 0) / trail.length < GATE_CALM_PCT;
  });
  const eligibleRate = eligible.filter(Boolean).length / eligible.length;

  type Win = { avgAbs: number; be: number | null; neutral: number; neutralGated: number; gatedDays: number };
  const windows: Win[] = [];
  for (let s = 0; s + WINDOW_DAYS < moves.length; s++) {
    const w = moves.slice(s, s + WINDOW_DAYS);
    const e = eligible.slice(s, s + WINDOW_DAYS);
    windows.push({
      avgAbs: w.reduce((a, m) => a + Math.abs(m), 0) / w.length,
      be: windowBreakeven(w),
      neutral: windowNeutralNet(w),
      neutralGated: windowNeutralNet(w, e),
      gatedDays: e.filter((x) => !x).length
    });
  }

  const buckets: Array<{ name: string; test: (w: Win) => boolean }> = [
    { name: "calm   (<1.2%)", test: (w) => w.avgAbs < 0.012 },
    { name: "normal (1.2–2%)", test: (w) => w.avgAbs >= 0.012 && w.avgAbs < 0.02 },
    { name: "active (2–3%)", test: (w) => w.avgAbs >= 0.02 && w.avgAbs < 0.03 },
    { name: "extreme(≥3%)", test: (w) => w.avgAbs >= 0.03 }
  ];

  console.log("— Directional breakeven + neutral book (UNGATED vs CALM-ONLY GATED, trailing-only replay) —");
  console.log(["bucket", "wins", "BE p50", "BE p90", "worst BE", "neutral p50", "GATED p50", "paused d/win"].map((h) => h.padEnd(15)).join(""));
  for (const b of buckets) {
    const ws = windows.filter(b.test);
    if (!ws.length) { console.log(`${b.name.padEnd(15)}0`); continue; }
    const bes = ws.map((w) => w.be).filter((x): x is number => x != null);
    console.log([
      b.name, String(ws.length), pct(median(bes)), pct(quantile(bes, 0.9)), pct(Math.max(...bes)),
      fmt(median(ws.map((w) => w.neutral))), fmt(median(ws.map((w) => w.neutralGated))),
      (ws.reduce((a, w) => a + w.gatedDays, 0) / ws.length).toFixed(1)
    ].map((c) => c.padEnd(15)).join(""));
  }

  const allBes = windows.map((w) => w.be).filter((x): x is number => x != null);
  const totU = windows.reduce((a, w) => a + w.neutral, 0) / windows.length;
  const totG = windows.reduce((a, w) => a + w.neutralGated, 0) / windows.length;
  console.log(`\nAll windows: BE p50 ${pct(median(allBes))} · p90 ${pct(quantile(allBes, 0.9))} · worst ${pct(Math.max(...allBes))}`);
  console.log(`Neutral mean/fortnight: UNGATED ${fmt(totU)} (${pct(windows.filter((w) => w.neutral > 0).length / windows.length)} positive) → GATED ${fmt(totG)} (${pct(windows.filter((w) => w.neutralGated > 0).length / windows.length)} positive incl. zero-issuance) · gate open ${pct(eligibleRate)} of days`);

  // ── Block bootstrap (28-day blocks) — overlap-honest 95% CIs ──
  const B = 400, BLOCK = 28;
  const rng = mulberry32(42);
  const beP50s: number[] = [], neuGs: number[] = [];
  for (let rep = 0; rep < B; rep++) {
    const synth: number[] = [];
    while (synth.length < moves.length) {
      const s = Math.floor(rng() * (moves.length - BLOCK));
      synth.push(...moves.slice(s, s + BLOCK));
    }
    synth.length = moves.length;
    const el = synth.map((_, i) => {
      if (i < GATE_LOOKBACK_DAYS) return true;
      const t = synth.slice(i - GATE_LOOKBACK_DAYS, i);
      return t.reduce((a, m) => a + Math.abs(m), 0) / t.length < GATE_CALM_PCT;
    });
    const bes: number[] = [], gs: number[] = [];
    for (let s = 0; s + WINDOW_DAYS < synth.length; s += WINDOW_DAYS) { // non-overlapping inside bootstrap
      const w = synth.slice(s, s + WINDOW_DAYS);
      const be = windowBreakeven(w);
      if (be != null) bes.push(be);
      gs.push(windowNeutralNet(w, el.slice(s, s + WINDOW_DAYS)));
    }
    beP50s.push(median(bes));
    neuGs.push(gs.reduce((a, x) => a + x, 0) / gs.length);
  }
  console.log(`\nBlock-bootstrap 95% CI (28d blocks, non-overlapping windows):`);
  console.log(`  breakeven p50: ${pct(quantile(beP50s, 0.025))} … ${pct(quantile(beP50s, 0.975))}`);
  console.log(`  gated-neutral mean/fortnight: ${fmt(quantile(neuGs, 0.025))} … ${fmt(quantile(neuGs, 0.975))}`);
  console.log(`\nNOTE: gated replay is the TRAILING-only approximation (daily candles can't replay the intra-day leading signal); the live gated shadow is the binding instrument.\n`);
};

main().catch((e) => {
  console.error(`validation failed: ${(e as Error).message}`);
  process.exit(1);
});
