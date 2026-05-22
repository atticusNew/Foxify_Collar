#!/usr/bin/env tsx
/**
 * Multi-cell spread chain probe — Deribit live data, read-only.
 *
 * Pulls real bids/asks for every production cell across two spread
 * designs PLUS the two strangle reference layouts. Output drives the
 * "which design wins per cell" decision before any spread code lands.
 *
 * Designs evaluated per cell:
 *
 *   [SA] Strangle A — "production_now"
 *        Long put at (spot × (1 − hedgePct)), long call at (spot × (1 + hedgePct))
 *        Strikes INSIDE trigger boundary. Current live behavior.
 *        Contracts = payout / (triggerOffset − hedgeOffset)   ← intrinsic-at-trigger sizing
 *
 *   [SB] Strangle B — "trigger-aligned"
 *        Long put at trigger_low, long call at trigger_high.
 *        Strikes AT trigger boundary. Cheaper but zero intrinsic at trigger.
 *        Contracts = payout / triggerOffset                   ← speculative sizing
 *
 *   [DA] Spread Design A — "trigger-aligned debit spread"
 *        Long at trigger boundary, short past trigger by spreadWidth.
 *        Capital-efficient; cap = width × contracts = payout.
 *
 *   [DB] Spread Design B — "TIGHT-spread" (USER-PREFERRED)
 *        Long INSIDE trigger (at hedgePct strike, same as SA),
 *        short past trigger by spreadWidth.
 *        Preserves TIGHT salvage geometry. Already ITM at trigger.
 *
 * Per-cell width policy: width = spot × max(2 × hedgePct, triggerPct × 0.5)
 *   → ensures short strike is at trigger + (≥half-trigger-distance) OTM
 *   → contracts stays in 0.3-2.0 BTC range for 6 main cells
 *
 * Run:
 *   npx tsx services/api/scripts/probes/spread_chain_probe_all_cells.ts
 *
 * Optional env:
 *   PROBE_CELLS=50k_2pct_1k,50k_5pct_2_5k     (subset of cells, comma-separated)
 *   PROBE_RECOVERY=0.5                         (no-breach hedge recovery assumption)
 */

const DERIBIT = "https://www.deribit.com/api/v2/public";

type CellDef = {
  cellId: string;
  notionalUsdc: number;
  triggerPct: number;
  hedgePct: number;
  payoutUsdc: number;
  dailyPremiumUsdc: number;
  expiryHorizonDays: number;
};

// Mirrors services/api/src/volumeCover/matrix.ts (6 main production cells).
// The 30k_2pct_600 + 1k_2pct_20 cells are shadow-only and excluded by default.
const CELLS: readonly CellDef[] = [
  { cellId: "50k_2pct_1k",    notionalUsdc:  50_000, triggerPct: 0.02, hedgePct: 0.01, payoutUsdc:  1_000, dailyPremiumUsdc: 350, expiryHorizonDays: 3  },
  { cellId: "50k_5pct_2_5k",  notionalUsdc:  50_000, triggerPct: 0.05, hedgePct: 0.03, payoutUsdc:  2_500, dailyPremiumUsdc: 200, expiryHorizonDays: 5  },
  { cellId: "50k_10pct_5k",   notionalUsdc:  50_000, triggerPct: 0.10, hedgePct: 0.05, payoutUsdc:  5_000, dailyPremiumUsdc: 100, expiryHorizonDays: 14 },
  { cellId: "200k_5pct_10k",  notionalUsdc: 200_000, triggerPct: 0.05, hedgePct: 0.03, payoutUsdc: 10_000, dailyPremiumUsdc: 800, expiryHorizonDays: 5  },
  { cellId: "200k_10pct_20k", notionalUsdc: 200_000, triggerPct: 0.10, hedgePct: 0.05, payoutUsdc: 20_000, dailyPremiumUsdc: 400, expiryHorizonDays: 14 },
  { cellId: "200k_15pct_30k", notionalUsdc: 200_000, triggerPct: 0.15, hedgePct: 0.07, payoutUsdc: 30_000, dailyPremiumUsdc: 370, expiryHorizonDays: 14 }
];

const RECOVERY_PCT = Number(process.env.PROBE_RECOVERY ?? "0.5");

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
  underlying_price: number;
  mark_iv: number;
};

const fetchJson = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
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

const toUsd = (q: Quote | null, side: "bid" | "ask" | "mark", spot: number): number => {
  if (!q) return 0;
  const ul = q.underlying_price || spot;
  if (side === "bid") return q.best_bid_price * ul;
  if (side === "ask") return q.best_ask_price * ul;
  return q.mark_price * ul;
};

const f$ = (n: number): string => `$${n.toFixed(2)}`;
const fpct = (n: number): string => `${(n * 100).toFixed(1)}%`;

type DesignResult = {
  cell: CellDef;
  spot: number;
  expiryIso: string;
  tenorDays: number;

  // Strikes resolved on-chain
  hedgePutStrike: number;        // SA put + DB put long
  hedgeCallStrike: number;       // SA call + DB call long
  triggerPutStrike: number;      // SB put + DA put long
  triggerCallStrike: number;     // SB call + DA call long
  shortPutStrike: number;        // DA + DB put short
  shortCallStrike: number;       // DA + DB call short

  // Per-leg quotes
  hedgePutQ: Quote | null;
  hedgeCallQ: Quote | null;
  triggerPutQ: Quote | null;
  triggerCallQ: Quote | null;
  shortPutQ: Quote | null;
  shortCallQ: Quote | null;

  // Sizing
  saContractsBtc: number;
  sbContractsBtc: number;
  daContractsBtc: number;
  dbContractsBtc: number;
  spreadWidthUsdc: number;

  // Costs (ask side, full position)
  saAsk: number;
  sbAsk: number;
  daAsk: number;
  dbAsk: number;

  // Costs (mid side, best-case passive fill)
  saMid: number;
  sbMid: number;
  daMid: number;
  dbMid: number;

  // Short-leg liquidity flags
  shortPutMissing: boolean;
  shortCallMissing: boolean;
  shortPutBidZero: boolean;
  shortCallBidZero: boolean;
};

const probeCell = async (
  cell: CellDef,
  spot: number,
  allInstr: Instrument[],
  byExpiry: Map<number, Instrument[]>
): Promise<DesignResult | null> => {
  const nowMs = Date.now();
  const targetMs = nowMs + cell.expiryHorizonDays * 86_400_000;
  const candidates = [...byExpiry.keys()].filter((e) => e > nowMs + 3_600_000);
  if (candidates.length === 0) return null;
  const chosenExpiry = candidates.reduce((best, cur) =>
    Math.abs(cur - targetMs) < Math.abs(best - targetMs) ? cur : best
  );
  const instr = byExpiry.get(chosenExpiry)!;
  const tenorDays = (chosenExpiry - nowMs) / 86_400_000;

  // Strike planning
  const triggerOffset = spot * cell.triggerPct;
  const hedgeOffset = spot * cell.hedgePct;

  // Width policy: short leg at trigger + (half-trigger-distance) OTM minimum.
  // For each cell, that's a defensible distance past trigger where liquidity
  // is plausible while keeping cap = width × contracts == payout.
  const spreadWidthUsdc = Math.max(spot * cell.triggerPct * 0.5, spot * cell.hedgePct * 2);

  const triggerPutTarget  = spot - triggerOffset;
  const triggerCallTarget = spot + triggerOffset;
  const hedgePutTarget    = spot - hedgeOffset;
  const hedgeCallTarget   = spot + hedgeOffset;
  // Short leg target = trigger ± (triggerOffset × 0.5) further OTM.
  // For Design A: short = trigger_long − width. For Design B: short = hedge_long − width.
  // Place short strikes at the same OTM distance for both designs so liquidity
  // assessment isn't biased by where the long sits.
  const shortPutTarget    = spot - triggerOffset - spot * cell.triggerPct * 0.5;
  const shortCallTarget   = spot + triggerOffset + spot * cell.triggerPct * 0.5;

  // Resolve to actual on-chain strikes
  const hedgePut    = closestStrike(instr, hedgePutTarget,    "put");
  const hedgeCall   = closestStrike(instr, hedgeCallTarget,   "call");
  const triggerPut  = closestStrike(instr, triggerPutTarget,  "put");
  const triggerCall = closestStrike(instr, triggerCallTarget, "call");
  const shortPut    = closestStrike(instr, shortPutTarget,    "put");
  const shortCall   = closestStrike(instr, shortCallTarget,   "call");

  // Pull all 6 quotes in parallel
  const [hedgePutQ, hedgeCallQ, triggerPutQ, triggerCallQ, shortPutQ, shortCallQ] = await Promise.all([
    hedgePut    ? getQuote(hedgePut.instrument_name)    : Promise.resolve(null),
    hedgeCall   ? getQuote(hedgeCall.instrument_name)   : Promise.resolve(null),
    triggerPut  ? getQuote(triggerPut.instrument_name)  : Promise.resolve(null),
    triggerCall ? getQuote(triggerCall.instrument_name) : Promise.resolve(null),
    shortPut    ? getQuote(shortPut.instrument_name)    : Promise.resolve(null),
    shortCall   ? getQuote(shortCall.instrument_name)   : Promise.resolve(null)
  ]);

  // Sizing
  // Strangle A (TIGHT): contracts such that intrinsic-at-trigger covers payout
  // intrinsic per BTC at trigger = (triggerOffset − hedgeOffset)
  const intrinsicAtTriggerPerBtc = triggerOffset - hedgeOffset;
  const saContractsBtc = cell.payoutUsdc / intrinsicAtTriggerPerBtc;

  // Strangle B (trigger-aligned): contracts such that triggerOffset × contracts = payout
  // (deep-move sizing; long is OTM at trigger)
  const sbContractsBtc = cell.payoutUsdc / triggerOffset;

  // Spreads: contracts = payout / width (cap-matched)
  const daContractsBtc = cell.payoutUsdc / spreadWidthUsdc;
  const dbContractsBtc = cell.payoutUsdc / spreadWidthUsdc;

  // Costs
  const saAsk =
    (toUsd(hedgePutQ, "ask", spot) + toUsd(hedgeCallQ, "ask", spot)) * saContractsBtc;
  const sbAsk =
    (toUsd(triggerPutQ, "ask", spot) + toUsd(triggerCallQ, "ask", spot)) * sbContractsBtc;
  // Spread debit = long ask − short bid (worst case for taker)
  const daPutDebit  = toUsd(triggerPutQ,  "ask", spot) - toUsd(shortPutQ,  "bid", spot);
  const daCallDebit = toUsd(triggerCallQ, "ask", spot) - toUsd(shortCallQ, "bid", spot);
  const daAsk       = (daPutDebit + daCallDebit) * daContractsBtc;
  const dbPutDebit  = toUsd(hedgePutQ,    "ask", spot) - toUsd(shortPutQ,  "bid", spot);
  const dbCallDebit = toUsd(hedgeCallQ,   "ask", spot) - toUsd(shortCallQ, "bid", spot);
  const dbAsk       = (dbPutDebit + dbCallDebit) * dbContractsBtc;

  // Mid
  const midPerBtc = (q: Quote | null) => ((toUsd(q, "bid", spot) + toUsd(q, "ask", spot)) / 2);
  const saMid = (midPerBtc(hedgePutQ) + midPerBtc(hedgeCallQ)) * saContractsBtc;
  const sbMid = (midPerBtc(triggerPutQ) + midPerBtc(triggerCallQ)) * sbContractsBtc;
  const daMid = ((midPerBtc(triggerPutQ) - midPerBtc(shortPutQ)) +
                 (midPerBtc(triggerCallQ) - midPerBtc(shortCallQ))) * daContractsBtc;
  const dbMid = ((midPerBtc(hedgePutQ) - midPerBtc(shortPutQ)) +
                 (midPerBtc(hedgeCallQ) - midPerBtc(shortCallQ))) * dbContractsBtc;

  return {
    cell, spot,
    expiryIso: new Date(chosenExpiry).toISOString().slice(0, 10),
    tenorDays,
    hedgePutStrike:    hedgePut?.strike ?? hedgePutTarget,
    hedgeCallStrike:   hedgeCall?.strike ?? hedgeCallTarget,
    triggerPutStrike:  triggerPut?.strike ?? triggerPutTarget,
    triggerCallStrike: triggerCall?.strike ?? triggerCallTarget,
    shortPutStrike:    shortPut?.strike ?? shortPutTarget,
    shortCallStrike:   shortCall?.strike ?? shortCallTarget,
    hedgePutQ, hedgeCallQ, triggerPutQ, triggerCallQ, shortPutQ, shortCallQ,
    saContractsBtc, sbContractsBtc, daContractsBtc, dbContractsBtc,
    spreadWidthUsdc,
    saAsk, sbAsk, daAsk, dbAsk,
    saMid, sbMid, daMid, dbMid,
    shortPutMissing:  shortPut == null,
    shortCallMissing: shortCall == null,
    shortPutBidZero:  shortPutQ != null  && shortPutQ.best_bid_price === 0,
    shortCallBidZero: shortCallQ != null && shortCallQ.best_bid_price === 0
  };
};

const main = async (): Promise<void> => {
  const spot = await getIndex();
  const allInstr = await listInstruments();
  const byExpiry = new Map<number, Instrument[]>();
  for (const inst of allInstr) {
    if (!byExpiry.has(inst.expiration_timestamp)) byExpiry.set(inst.expiration_timestamp, []);
    byExpiry.get(inst.expiration_timestamp)!.push(inst);
  }

  const filter = (process.env.PROBE_CELLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const cellsToProbe = filter.length === 0 ? CELLS : CELLS.filter((c) => filter.includes(c.cellId));

  console.log(`\n${"=".repeat(82)}`);
  console.log(`Multi-cell spread chain probe — Deribit live`);
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log(`BTC spot (Deribit index): ${f$(spot)}`);
  console.log(`Cells: ${cellsToProbe.map((c) => c.cellId).join(", ")}`);
  console.log(`Recovery assumption (no-breach): ${fpct(RECOVERY_PCT)}`);
  console.log(`${"=".repeat(82)}\n`);

  const results: DesignResult[] = [];
  for (const cell of cellsToProbe) {
    const r = await probeCell(cell, spot, allInstr, byExpiry);
    if (r != null) results.push(r);
    await new Promise((res) => setTimeout(res, 150));
  }

  // Per-cell detail block
  for (const r of results) {
    console.log(`\n${"-".repeat(82)}`);
    console.log(`Cell: ${r.cell.cellId}  |  ${fpct(r.cell.triggerPct)} trigger / ${fpct(r.cell.hedgePct)} hedge`);
    console.log(`Notional: $${r.cell.notionalUsdc.toLocaleString()}, Payout: $${r.cell.payoutUsdc.toLocaleString()}, Premium: $${r.cell.dailyPremiumUsdc}/d, Tenor: ${r.cell.expiryHorizonDays}d`);
    console.log(`Chosen expiry: ${r.expiryIso} (${r.tenorDays.toFixed(2)}d actual)`);
    console.log(`Spread width policy: ${f$(r.spreadWidthUsdc)} (= max(triggerPct×0.5, hedgePct×2) × spot)`);
    console.log(`${"-".repeat(82)}`);

    const ivLine = (q: Quote | null) => q && q.mark_iv != null ? ` iv=${q.mark_iv.toFixed(1)}%` : "";
    const liqLine = (q: Quote | null) =>
      q ? `bid=${f$(toUsd(q, "bid", r.spot))} ask=${f$(toUsd(q, "ask", r.spot))} mark=${f$(toUsd(q, "mark", r.spot))}${ivLine(q)}` : "[NO QUOTE]";

    console.log(`\n  STRIKES (Deribit-resolved):`);
    console.log(`    Put-long hedge (SA/DB):    $${r.hedgePutStrike}    ${liqLine(r.hedgePutQ)}`);
    console.log(`    Put-long trigger (SB/DA):  $${r.triggerPutStrike}    ${liqLine(r.triggerPutQ)}`);
    console.log(`    Put-short (DA/DB):         $${r.shortPutStrike}    ${liqLine(r.shortPutQ)}${r.shortPutMissing ? " ⚠ NOT LISTED" : ""}${r.shortPutBidZero ? " ⚠ ZERO BID" : ""}`);
    console.log(`    Call-long hedge (SA/DB):   $${r.hedgeCallStrike}    ${liqLine(r.hedgeCallQ)}`);
    console.log(`    Call-long trigger (SB/DA): $${r.triggerCallStrike}    ${liqLine(r.triggerCallQ)}`);
    console.log(`    Call-short (DA/DB):        $${r.shortCallStrike}    ${liqLine(r.shortCallQ)}${r.shortCallMissing ? " ⚠ NOT LISTED" : ""}${r.shortCallBidZero ? " ⚠ ZERO BID" : ""}`);

    console.log(`\n  SIZING:`);
    console.log(`    [SA] TIGHT strangle      ${r.saContractsBtc.toFixed(2)} BTC/leg`);
    console.log(`    [SB] trigger-aligned     ${r.sbContractsBtc.toFixed(2)} BTC/leg`);
    console.log(`    [DA] trigger-debit       ${r.daContractsBtc.toFixed(2)} BTC/leg  (cap matches payout)`);
    console.log(`    [DB] TIGHT-spread        ${r.dbContractsBtc.toFixed(2)} BTC/leg  (cap matches payout)`);

    console.log(`\n  TOTAL HEDGE COST:`);
    console.log(`    [SA] TIGHT strangle:     ASK ${f$(r.saAsk).padStart(10)}  MID ${f$(r.saMid).padStart(10)}`);
    console.log(`    [SB] trigger-aligned:    ASK ${f$(r.sbAsk).padStart(10)}  MID ${f$(r.sbMid).padStart(10)}`);
    console.log(`    [DA] trigger debit:      ASK ${f$(r.daAsk).padStart(10)}  MID ${f$(r.daMid).padStart(10)}`);
    console.log(`    [DB] TIGHT-spread:       ASK ${f$(r.dbAsk).padStart(10)}  MID ${f$(r.dbMid).padStart(10)}`);

    const baseline = r.saAsk;
    if (baseline > 0) {
      console.log(`\n  COST SAVINGS vs [SA] live baseline (ASK side):`);
      console.log(`    [SB] saves ${f$(baseline - r.sbAsk).padStart(9)} (${fpct((baseline - r.sbAsk) / baseline)})`);
      console.log(`    [DA] saves ${f$(baseline - r.daAsk).padStart(9)} (${fpct((baseline - r.daAsk) / baseline)})`);
      console.log(`    [DB] saves ${f$(baseline - r.dbAsk).padStart(9)} (${fpct((baseline - r.dbAsk) / baseline)})`);
    }
  }

  // Summary table — one row per cell, all 4 designs side by side
  console.log(`\n\n${"=".repeat(110)}`);
  console.log(`SUMMARY — Per-cell ASK cost (full position), savings %, short-leg liquidity flags`);
  console.log(`Assumption: no breach; spreads use cap-matched contracts = payout / width.`);
  console.log(`${"=".repeat(110)}`);

  const pad = (s: string, n: number) => s.padStart(n);
  console.log(
    `\n${pad("CELL", 18)} ${pad("[SA] live", 11)} ${pad("[SB] align", 11)} ${pad("[DA] tdebit", 12)} ${pad("[DB] TIGHT-sp", 14)} ${pad("DB save", 9)} ${pad("DB liq", 12)}`
  );
  console.log("-".repeat(110));
  for (const r of results) {
    const dbSavePct = r.saAsk > 0 ? (r.saAsk - r.dbAsk) / r.saAsk : 0;
    const dbLiq = r.shortPutMissing || r.shortCallMissing
      ? "missing"
      : r.shortPutBidZero || r.shortCallBidZero
      ? "zero-bid"
      : "ok";
    console.log(
      `${pad(r.cell.cellId, 18)} ${pad(f$(r.saAsk), 11)} ${pad(f$(r.sbAsk), 11)} ${pad(f$(r.daAsk), 12)} ${pad(f$(r.dbAsk), 14)} ${pad(fpct(dbSavePct), 9)} ${pad(dbLiq, 12)}`
    );
  }

  // P&L summary at 2-day hold + recovery assumption
  console.log(`\n${"-".repeat(110)}`);
  console.log(`ATTICUS P&L per pair (2-day Foxify hold, no breach, ${fpct(RECOVERY_PCT)} hedge recovery)`);
  console.log(`${"-".repeat(110)}`);
  console.log(
    `\n${pad("CELL", 18)} ${pad("premium", 10)} ${pad("[SA] live", 11)} ${pad("[SB]", 9)} ${pad("[DA]", 9)} ${pad("[DB]", 9)} ${pad("DB-SA Δ", 10)}`
  );
  console.log("-".repeat(110));
  for (const r of results) {
    const premium = r.cell.dailyPremiumUsdc * 2;
    const realized = (cost: number) => cost * (1 - RECOVERY_PCT);
    const netSA = premium - realized(r.saAsk);
    const netSB = premium - realized(r.sbAsk);
    const netDA = premium - realized(r.daAsk);
    const netDB = premium - realized(r.dbAsk);
    console.log(
      `${pad(r.cell.cellId, 18)} ${pad(f$(premium), 10)} ${pad(f$(netSA), 11)} ${pad(f$(netSB), 9)} ${pad(f$(netDA), 9)} ${pad(f$(netDB), 9)} ${pad(f$(netDB - netSA), 10)}`
    );
  }

  // Recommendation hints
  console.log(`\n${"-".repeat(110)}`);
  console.log(`READING THE TABLE:`);
  console.log(`  • DB save > 50% AND DB liq=ok → strong candidate for spread migration`);
  console.log(`  • DB save 25-50% AND DB liq=ok → migrate after shadow validation`);
  console.log(`  • DB liq=zero-bid or missing → spread infeasible on Deribit, stay strangle`);
  console.log(`  • Negative DB-SA Δ → spread design loses money vs current; recheck width policy`);
  console.log(`${"=".repeat(110)}\n`);
};

main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
