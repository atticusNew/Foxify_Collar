/**
 * Server-rendered report page. No framework, no external assets: tables and inline SVG.
 * Readable on a phone, printable, refreshes itself on the collector's cadence.
 */

import type { LatencyRow, BucketRow, GapSeries, LadderVolTable, StrikeVolRow, YearEndVenueCell, YearEndVolTable } from "./analytics";
import type { LadderView, ReportData } from "./report";
import { takerFeeCents } from "./analytics";
import type { VenueQuote } from "./types";

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const c = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "–" : `${v.toFixed(digits === 1 && Math.abs(v) < 1 && v !== 0 ? 2 : digits)}¢`;
const usd = (v: number | null | undefined, digits = 2): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "–" : `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(digits)}`;
const signed = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}¢`;
const num = (v: number, digits = 0): string => v.toLocaleString("en-US", { maximumFractionDigits: digits });
const et = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return `${d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET`;
};

function ba(q: BucketRow["kalshi"]): string {
  if (!q) return '<td class="dim">not listed</td>';
  if (q.bidCents <= 0 && q.askCents <= 0) return '<td class="dim">no book</td>';
  const depth = q.bidQty || q.askQty ? `<small>${num(q.bidQty)} × ${num(q.askQty)}</small>` : "";
  return `<td><b>${q.bidCents}</b> / <b>${q.askCents}</b>${depth}</td>`;
}

function gapCell(v: number | null): string {
  if (v === null) return '<td class="dim">–</td>';
  const cls = Math.abs(v) >= 3 ? "hot" : Math.abs(v) >= 1 ? "warm" : "";
  return `<td class="${cls}">${signed(v)}</td>`;
}

function ladderTable(v: LadderView, opts: { showPoly: boolean }): string {
  const head = `<tr><th>Bucket</th><th>Kalshi<br><small>bid / ask</small></th>${opts.showPoly ? "<th>Polymarket US<br><small>bid / ask</small></th>" : ""}<th>Option-implied<br><small>Deribit smile</small></th>${
    opts.showPoly ? "<th>Kalshi − Poly</th>" : ""
  }<th>Kalshi − model</th>${opts.showPoly ? "<th>Poly − model</th><th>Cross</th>" : ""}</tr>`;
  const rows = v.rows
    .map((r) => {
      const cross = r.cross
        ? `<td class="cross">buy ${r.cross.buyOn === "kalshi" ? "Kalshi" : "Poly"} ${r.cross.buyAtCents}¢ → sell ${r.cross.sellOn === "kalshi" ? "Kalshi" : "Poly"} ${r.cross.sellAtCents}¢ · <b>${signed(r.cross.edgeCents, 2)}</b> net${
            r.cross.qty ? ` · ${num(r.cross.qty, 1)} ct` : ""
          }</td>`
        : '<td class="dim">–</td>';
      return `<tr><td class="lbl">${esc(r.label)}</td>${ba(r.kalshi)}${opts.showPoly ? ba(r.poly) : ""}<td>${c(r.modelCents)}</td>${
        opts.showPoly ? gapCell(r.venueGapCents) : ""
      }${gapCell(r.kalshiVsModelCents)}${opts.showPoly ? gapCell(r.polyVsModelCents) + cross : ""}</tr>`;
    })
    .join("");
  const sums =
    v.sumKalshi !== null || v.sumPoly !== null || v.sumModel !== null
      ? `<tr class="sum"><td class="lbl">Sum of mids <small>100¢ = fair book; excess = overround</small></td><td>${c(v.sumKalshi, 0)}</td>${
          opts.showPoly ? `<td>${c(v.sumPoly, 0)}</td>` : ""
        }<td>${c(v.sumModel, 0)}</td>${opts.showPoly ? "<td></td>" : ""}<td></td>${opts.showPoly ? "<td></td><td></td>" : ""}</tr>`
      : "";
  return `<div class="tbl"><table>${head}${rows}${sums}</table></div>`;
}

/** Grouped bars: three sources per bucket. */
function distributionSvg(v: LadderView): string {
  const d = v.distribution;
  if (!d.length) return "";
  const W = 720;
  const H = 220;
  const padL = 34;
  const padB = 30;
  const maxV = Math.max(5, ...d.flatMap((r) => [r.kalshi ?? 0, r.poly ?? 0, r.model ?? 0]));
  const bw = (W - padL - 8) / d.length;
  const y = (val: number) => H - padB - (val / maxV) * (H - padB - 10);
  const bars = d
    .map((r, i) => {
      const x0 = padL + i * bw;
      const w = Math.max(2, (bw - 4) / 3);
      const bar = (val: number | null, k: number, cls: string) =>
        val === null ? "" : `<rect class="${cls}" x="${(x0 + 2 + k * w).toFixed(1)}" y="${y(val).toFixed(1)}" width="${w.toFixed(1)}" height="${(H - padB - y(val)).toFixed(1)}"/>`;
      const k = (n: string) => `${Math.round(Number((/[\d,]+/.exec(n)?.[0] ?? "").replace(/,/g, "")) / 1000)}k`;
      const m = /^(\$[\d,]+) – (\$[\d,]+)$/.exec(r.label);
      const lbl = m ? k(m[1]) : r.label.includes("or above") ? `${k(r.label)}+` : r.label.includes("or below") ? `<${k(r.label)}` : r.label;
      return `${bar(r.kalshi, 0, "k")}${bar(r.poly, 1, "p")}${bar(r.model, 2, "m")}<text x="${(x0 + bw / 2).toFixed(1)}" y="${H - padB + 14}" class="ax" text-anchor="middle">${esc(lbl)}</text>`;
    })
    .join("");
  const ticks = [0, Math.round(maxV / 2), Math.round(maxV)]
    .map((t) => `<text x="${padL - 4}" y="${(y(t) + 3).toFixed(1)}" class="ax" text-anchor="end">${t}¢</text><line x1="${padL}" x2="${W - 4}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" class="grid"/>`)
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="dist" role="img" aria-label="implied distribution by bucket">${ticks}${bars}</svg>
  <div class="legend"><span><i class="k"></i>Kalshi mid</span><span><i class="p"></i>Polymarket US mid</span><span><i class="m"></i>Option-implied, Deribit ${esc(v.modelExpiry ?? "")}</span></div>`;
}

function spark(series: Array<[number, number]>, range: number): string {
  if (series.length < 2) return '<span class="dim">collecting</span>';
  const W = 160;
  const H = 28;
  const t0 = series[0][0];
  const t1 = series[series.length - 1][0];
  const span = Math.max(1, t1 - t0);
  const pts = series.map(([t, g]) => `${(((t - t0) / span) * W).toFixed(1)},${(H / 2 - (Math.max(-range, Math.min(range, g)) / range) * (H / 2 - 2)).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 ${W} ${H}" class="spark"><line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" class="zero"/><polyline points="${pts}"/></svg>`;
}

function gapsTable(gaps: GapSeries[], showPoly: boolean): string {
  const rows = gaps.filter((g) => (showPoly ? g.venue.length : g.kalshiModel.length));
  if (!rows.length) return '<p class="dim">Fills as snapshots accumulate, one per minute.</p>';
  const range = Math.max(2, ...rows.map((g) => g.stats.venueMax ?? 0));
  return `<div class="tbl"><table><tr><th>Bucket</th><th>${showPoly ? "Kalshi − Poly, window" : "Kalshi − model, window"}</th><th>Mean |gap|</th><th>Max |gap|</th><th>Last</th><th>n</th></tr>${rows
    .map((g) => {
      const s = showPoly ? g.venue : g.kalshiModel;
      const abs = s.map(([, x]) => Math.abs(x));
      const mean = abs.length ? abs.reduce((a, b) => a + b, 0) / abs.length : null;
      const max = abs.length ? Math.max(...abs) : null;
      const last = s.length ? s[s.length - 1][1] : null;
      return `<tr><td class="lbl">${esc(g.label)}</td><td>${spark(s, range)}</td><td>${c(mean)}</td><td>${c(max)}</td>${gapCell(last)}<td class="dim">${s.length}</td></tr>`;
    })
    .join("")}</table></div>`;
}

function latencyTableHtml(rows: LatencyRow[], tenor: string): string {
  if (!rows.length || !rows[0].n) return '<p class="dim">Index history unavailable this cycle.</p>';
  return `<div class="tbl"><table><tr><th>Late by</th><th>Index move, median</th><th>Index move, p90</th><th>Max in window</th><th>$1 ATM digital, ${esc(tenor)}<br><small>median / p90</small></th></tr>${rows
    .map(
      (r) =>
        `<tr><td class="lbl">${r.horizonSec}s</td><td>${r.p50Bps.toFixed(2)} bps</td><td>${r.p90Bps.toFixed(2)} bps</td><td>${r.maxBps.toFixed(2)} bps</td><td><b>${c(r.atmCentsP50, 2)}</b> / ${c(r.atmCentsP90, 2)}</td></tr>`,
    )
    .join("")}</table></div>`;
}

function replayHtml(d: ReportData): string {
  const r = d.replay;
  const head = `<div class="kpis">
    <div><small>Contracts settled</small><b>${r.n}</b><small>${r.open} in flight</small></div>
    <div><small>Naked, mean P&amp;L</small><b>${usd(r.meanNaked, 3)}</b><small>per $1 contract</small></div>
    <div><small>Static spread, mean P&amp;L</small><b>${usd(r.meanStatic, 3)}</b><small>mean entry cost ${usd(r.meanStaticEntryUsd, 3)}</small></div>
    <div><small>Dynamic delta, mean P&amp;L</small><b>${usd(r.meanDynamic, 3)}</b><small>mean fees ${usd(r.meanDynamicCostUsd, 4)}</small></div>
    <div><small>p90 |P&amp;L − premium|</small><b>${usd(r.p90AbsNaked, 2)} · ${usd(r.p90AbsStatic, 2)} · ${usd(r.p90AbsDynamic, 2)}</b><small>naked · static · dynamic</small></div>
  </div>`;
  if (!r.recent.length) return `${head}<p class="dim">First row appears when the first hourly contract settles.</p>`;
  const minsBefore = (e: (typeof r.recent)[number]) => Math.round((e.settlesAtMs - Date.parse(e.openedAt)) / 60_000);
  return `${head}<div class="tbl"><table><tr><th>Close</th><th>Strike</th><th>Sold at<br><small>min to close</small></th><th>Settled</th><th>Payout</th><th>Naked</th><th>Static<br><small>entry cost</small></th><th>Dynamic<br><small>fees · rebalances</small></th></tr>${r.recent
    .map(
      (e) =>
        `<tr><td class="lbl">${et(e.settlesAt)}</td><td>$${num(e.strike)}</td><td>${e.premiumCents.toFixed(1)}¢<small>${minsBefore(e)} min</small></td><td>$${num(e.done?.settleValue ?? 0, 2)}</td><td>${e.done?.payout ? "$1" : "$0"}</td><td>${usd(e.done?.nakedUsd, 3)}</td><td>${usd(
          e.done?.staticUsd,
          3,
        )}<small>${e.staticHedge ? usd(e.staticHedge.entryUsd, 3) : "no spread"}</small></td><td>${usd(e.done?.dynamicUsd, 3)}<small>${usd(e.dynamicHedge.feesUsd, 3)} · ${e.dynamicHedge.rebalances}</small></td></tr>`,
    )
    .join("")}</table></div>`;
}

function collarTenor(d: ReportData): "daily" | "hourly" {
  return d.collar?.ladderId.startsWith("btc-daily:") ? "daily" : "hourly";
}

function collarHtml(d: ReportData): string {
  const col = d.collar;
  if (!col) return '<p class="dim">Not quoted this cycle.</p>';
  if (col.error) return `<p class="dim">${esc(col.error)}</p>`;
  if (!col.rows.length) return '<p class="dim">No strike with a mark inside the quotable band this cycle.</p>';
  return `<p class="dim">${esc(col.ladderId.replace(/^btc-/, "").replace(/:.*$/, "").replace(/^\w/, (ch) => ch.toUpperCase()))} close ${et(col.settlesAt)} · hedge legs: listed BTC option books · per $1 contract, 100 contracts</p><div class="tbl"><table><tr><th>Strike</th><th>Mark</th><th>Floor</th><th>Cap</th><th>Credit to holder</th><th>Upside given up<br><small>100¢ − cap</small></th><th>Hedge expiry</th><th></th></tr>${col.rows
    .map((r) =>
      r.ok
        ? `<tr><td class="lbl">${esc(r.label)}</td><td>${r.markCents}¢</td><td><b>${r.floorCents}¢</b></td><td><b>${r.capCents}¢</b></td><td><b>${c(r.creditCents, 0)}</b></td><td>${c(r.upsideGivenUpCents, 0)}</td><td>${esc(r.hedgeExpiry)}<br><small>${esc(
            r.alignment === "expiry_aligned" ? "aligned" : "unwound at close",
          )}</small></td><td class="dim">${r.takeCents !== undefined ? `take ${r.takeCents}¢ · legs ${c(r.hedgeCostCents, 0)}` : ""}</td></tr>`
        : `<tr class="ref"><td class="lbl">${esc(r.label)}</td><td>${r.markCents}¢</td><td colspan="6" class="dim">refused · ${esc(r.refusal)}</td></tr>`,
    )
    .join("")}</table></div>`;
}

function hourlyHtml(d: ReportData): string {
  if (!d.hourly) return '<p class="dim">No hourly ladder closing within 90 minutes.</p>';
  const v = d.hourly;
  const rows = v.rows.filter((r) => r.kalshi && r.kalshi.bidCents > 0 && r.kalshi.askCents > 0 && (r.kalshi.bidCents + r.kalshi.askCents) / 2 >= 1.5 && (r.kalshi.bidCents + r.kalshi.askCents) / 2 <= 98.5);
  const hv = d.hourlyVol;
  const pct = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${x.toFixed(0)}%`);
  const volStrip = hv
    ? `<div class="strip"><span>Kalshi ladder implied vol <b>${pct(hv.ladderPct)}</b> <small>lognormal fit · centre $${hv.ladderCentreUsd !== null ? num(hv.ladderCentreUsd) : "–"} · rms ${c(hv.rmsCents)}</small></span>
<span>Deribit ATM IV <b>${pct(hv.smilePct)}</b> <small>${esc(hv.smileExpiry ?? "")} mark</small></span>
<span>BRTI realised vol, 1h <b>${pct(hv.realizedPct)}</b> <small>1-min returns, annualised</small></span>
<span>Closes in <b>${hv.minutesToClose} min</b></span></div>`
    : "";
  const premiumNote =
    hv && hv.ladderPct !== null && hv.smilePct !== null
      ? `<p class="dim">Kalshi − model column reflects the vol difference above. Ladder priced over listed vol: below model under spot, above model over spot; reversed when priced under. Venue risk premium on the hour, not model error. §5 shows what a writer hedging at listed vol collects or pays for it.</p>`
      : "";
  const premiumTable = d.volPremium.length
    ? `<h3>Ladder vol minus listed vol, by time to close, over the window</h3><div class="tbl"><table><tr><th>Time to close</th><th>Kalshi ladder IV, mean</th><th>Deribit ATM IV, mean</th><th>Premium, mean<br><small>vol points</small></th><th>Premium, min / max</th><th>BRTI realised, mean</th><th>Readings<br><small>hours</small></th></tr>${d.volPremium
        .map(
          (r) =>
            `<tr><td class="lbl">${esc(r.label)}</td><td>${r.meanLadderPct.toFixed(1)}%</td><td>${r.meanSmilePct.toFixed(1)}%</td><td class="${Math.abs(r.meanPremiumPts) >= 10 ? "hot" : Math.abs(r.meanPremiumPts) >= 5 ? "warm" : ""}">${r.meanPremiumPts > 0 ? "+" : ""}${r.meanPremiumPts.toFixed(1)}</td><td>${r.minPremiumPts > 0 ? "+" : ""}${r.minPremiumPts.toFixed(1)} / ${r.maxPremiumPts > 0 ? "+" : ""}${r.maxPremiumPts.toFixed(1)}</td><td>${r.meanRealizedPct !== null ? `${r.meanRealizedPct.toFixed(1)}%` : "–"}</td><td class="dim">${r.n}<small>${r.hours}</small></td></tr>`,
        )
        .join("")}</table></div>`
    : "";
  return `<p class="dim">${esc(v.title)} · closes ${et(v.settlesAt)} · smile: Deribit ${esc(v.modelExpiry ?? "")}</p>${volStrip}${premiumNote}${ladderTable({ ...v, rows }, { showPoly: v.venues.includes("polymarket_us") })}${premiumTable}${strikeVolsHtml(d)}`;
}

function strikeVolTable(t: LadderVolTable, title: string): string {
  const pct = (x: number | null) => (x === null ? "–" : `${x.toFixed(0)}%`);
  const cls = (r: StrikeVolRow) => (r.listedVs === "venue_over" ? "warm" : r.listedVs === "venue_under" ? "cool" : "");
  const rows = t.rows
    .map(
      (r) =>
        `<tr><td class="lbl">${esc(r.label)}</td><td>${r.bidCents.toFixed(1)} / ${r.askCents.toFixed(1)}<small>${r.bidQty || r.askQty ? `${num(r.bidQty)} × ${num(r.askQty)}` : "–"}</small></td><td class="${cls(r)}">${
          r.volLoPct === null ? '<span class="dim">at the money</span>' : `${pct(r.volLoPct)} – ${pct(r.volHiPct)}`
        }</td><td>${pct(r.smilePct)}</td><td class="${cls(r)}">${
          r.listedVs === null ? "–" : r.listedVs === "inside" ? "inside" : r.listedVs === "venue_over" ? "venue over" : "venue under"
        }</td><td>${signed(r.fitResidualCents ?? 0, 2)}</td></tr>`,
    )
    .join("");
  const summary = `<div class="strip"><span>Listed vol inside the venue's band <b>${t.inside} of ${t.withBand}</b> <small>strikes with a band</small></span><span>Centre, 50¢ point <b>$${num(t.centreUsd)}</b> <small>1σ to close $${num(t.stdevUsd)}</small></span><span>One-vol fit <b>${t.fitPct.toFixed(0)}%</b> <small>rms ${c(t.rmsCents)}</small></span>${
    t.skew ? `<span>Skew, below − above centre <b>${t.skew.venuePts > 0 ? "+" : ""}${t.skew.venuePts.toFixed(1)} pts</b> <small>venue · Deribit ${t.skew.smilePts > 0 ? "+" : ""}${t.skew.smilePts.toFixed(1)} pts · ${t.skew.n} strikes</small></span>` : ""
  }<span>Closes in <b>${t.minutesToClose} min</b></span></div>`;
  return `<h3>${esc(title)}</h3>${summary}<div class="tbl"><table><tr><th>Strike</th><th>Kalshi<br><small>bid / ask · depth</small></th><th>Venue vol, bid to ask<br><small>band</small></th><th>Deribit vol<br><small>at strike</small></th><th>Listed vs band</th><th>Mid − one-vol fit<br><small>cents</small></th></tr>${rows}</table></div>`;
}

const VENUE_NAME = { kalshi: "Kalshi", polymarket_us: "Polymarket US" } as const;

function strikeVolsHtml(d: ReportData): string {
  const { hourly, daily } = d.strikeVols;
  if (!hourly.length && !daily.length) return "";
  const venues = [...new Set([...hourly, ...daily].map((t) => t.venue))].map((v) => VENUE_NAME[v]).join(" and ");
  return `<h3>Short-dated ladders, strike by strike, in vol</h3>
<p>Each strike's bid and ask converted to the vol that reproduces it as a digital on the ladder's own centre (the strike where mids cross 50¢), beside Deribit's vol at the same strike. Band holding the listed vol: quoted off the smile. Band above it: the venue charges a premium at that strike. Band below: the venue is under the smile. Last column: each mid against one vol for the whole ladder; a large residual is a strike out of line with its neighbours. Strikes within a quarter of a standard deviation of the centre are left blank, and bands widen toward it; a digital at the money carries almost no vol, so a cent of spread is many vol points there. One table per venue quoting the ladder: ${esc(venues)}.</p>${hourly
    .map((t) => strikeVolTable(t, `${VENUE_NAME[t.venue]} hourly ladder`))
    .join("")}${daily.map((t) => strikeVolTable(t, `${VENUE_NAME[t.venue]} daily ladder, 5 PM ET`)).join("")}`;
}

/**
 * The dollar version of "which venue is rich, and where": each venue's resting bids above option-implied
 * value, at the venue's own bid depth. The options market is the reference here, not a hedge venue; the
 * crosses note above is the part of this the other venue lets a cross-venue trader collect today.
 */
function bidsOverSmileNote(v: LadderView): string {
  const per = (pick: (r: BucketRow) => VenueQuote | null, theta: (q: VenueQuote) => number) => {
    let usdTotal = 0;
    let contracts = 0;
    let buckets = 0;
    let best: { label: string; usd: number; bid: number; model: number; qty: number } | null = null;
    for (const r of v.rows) {
      const q = pick(r);
      if (!q || r.modelCents === null || !(q.bidQty > 0)) continue;
      // half a cent of allowance for the model's wing error: flat extrapolation beyond listed strikes reads deep buckets near zero
      const edge = q.bidCents - takerFeeCents(theta(q), q.bidCents) - r.modelCents - 0.5;
      if (edge <= 0) continue;
      const usdHere = (edge * q.bidQty) / 100;
      usdTotal += usdHere;
      contracts += q.bidQty;
      buckets += 1;
      if (!best || usdHere > best.usd) best = { label: r.label, usd: usdHere, bid: q.bidCents, model: r.modelCents, qty: q.bidQty };
    }
    return { usdTotal, contracts, buckets, best };
  };
  const k = per((r) => r.kalshi, (q) => q.feeTheta);
  const p = per((r) => r.poly, (q) => q.feeTheta);
  if (!k.buckets && !p.buckets) return "";
  const line = (name: string, x: ReturnType<typeof per>) =>
    x.buckets
      ? `${name}: ${usd(x.usdTotal, 0)} over ${x.buckets} bucket${x.buckets > 1 ? "s" : ""}, ${num(x.contracts, 0)} contracts bid${
          x.best ? `; largest ${esc(x.best.label)}, bid ${c(x.best.bid, 1)} vs smile ${c(x.best.model, 2)} on ${num(x.best.qty, 0)} contracts, ${usd(x.best.usd, 0)}` : ""
        }`
      : `${name}: none`;
  return `<div class="note"><b>Resting bids above option-implied value:</b> ${line("Kalshi", k)}. ${line("Polymarket US", p)}. Bid minus taker fee minus option-implied value minus half a cent of allowance for the model's wing error, times the venue's own bid depth. What each venue's bidders are paying above the options market, in size. The crosses above are the part of it the other venue lets you collect today; the rest is a view those bidders hold that neither the other venue nor the options market shares. Not a trade by itself: selling it alone takes the tail.</div>`;
}

function yearEndVolsHtml(t: YearEndVolTable | null): string {
  if (!t) return "";
  const pct = (x: number | null, dp = 0) => (x === null ? "–" : `${x.toFixed(dp)}%`);
  const pts = (x: number | null) => (x === null ? "–" : `${x > 0 ? "+" : ""}${x.toFixed(1)}`);
  const vsWord = (v: YearEndVenueCell["listedVs"]) => (v === null ? "–" : v === "inside" ? "inside" : v === "venue_over" ? "venue over" : "venue under");
  const vsCls = (v: YearEndVenueCell["listedVs"]) => (v === "venue_over" ? "warm" : v === "venue_under" ? "cool" : v === null ? "dim" : "");
  const venueCells = (c: YearEndVenueCell | null) => {
    if (!c) return '<td class="dim">–</td><td class="dim">–</td><td class="dim">–</td>';
    const tick = c.tickShare >= 0.2 ? `<small>0¢-bid buckets were ${Math.round(c.tickShare * 100)}% of the raw sum</small>` : "";
    const band = c.unreachable
      ? '<span class="dim">above any lognormal</span>'
      : c.volPct === null
        ? '<span class="dim">–</span>'
        : `${pct(c.volPct)}<small>${c.volLoPct === null ? "band open" : `${pct(c.volLoPct)} – ${pct(c.volHiPct)}`}</small>`;
    return `<td>${pct(c.pct, 1)}${tick}</td><td class="${vsCls(c.listedVs)}">${band}</td><td class="${vsCls(c.listedVs)}">${vsWord(c.listedVs)}</td>`;
  };
  const rows = t.rows.map((r) => `<tr><td class="lbl">$${num(r.strikeUsd)} or above</td>${venueCells(r.kalshi)}${venueCells(r.poly)}<td>${pct(r.smilePct)}</td></tr>`).join("");
  const rel = (x: number | null) => (x === null ? "" : ` (${x >= t.listedMedianUsd ? "+" : ""}${(((x - t.listedMedianUsd) / t.listedMedianUsd) * 100).toFixed(1)}%)`);
  const strip = `<div class="strip"><span>Listed median <b>$${num(t.listedMedianUsd)}</b> <small>Deribit ${esc(t.expiry)} forward $${num(t.forwardUsd)} at ATM vol · ${t.daysToSettle} days to settlement</small></span><span>Venue 50% point <b>${
    t.kalshiCentreUsd !== null ? `$${num(t.kalshiCentreUsd)}${rel(t.kalshiCentreUsd)}` : "–"
  } · ${t.polyCentreUsd !== null ? `$${num(t.polyCentreUsd)}${rel(t.polyCentreUsd)}` : "–"}</b> <small>Kalshi · Polymarket US, vs listed median</small></span><span>Sum of mids <b>${t.kalshiSumCents !== null ? `${t.kalshiSumCents}¢` : "–"} · ${
    t.polySumCents !== null ? `${t.polySumCents}¢` : "–"
  }</b> <small>0¢-bid buckets read as zero: ${t.kalshiTickCents !== null ? `${t.kalshiTickCents}¢` : "–"} · ${t.polyTickCents !== null ? `${t.polyTickCents}¢` : "–"} of that; rest normalised to 100</small></span><span>Listed vol inside the band <b>${t.inside.kalshi[0]} of ${t.inside.kalshi[1]} · ${t.inside.poly[0]} of ${t.inside.poly[1]}</b> <small>Kalshi · Polymarket US</small></span><span>Tail mass, ≥ $${num(t.tails.upperFromUsd)} · &lt; $${num(t.tails.lowerToUsd)} <b>${["kalshi", "poly", "model"].map((k) => {
    const v = t.tails[k as "kalshi" | "poly" | "model"];
    return v ? `${v[0].toFixed(1)}¢ · ${v[1].toFixed(1)}¢` : "–";
  }).join(" | ")}</b> <small>Kalshi | Polymarket US | Deribit, raw mids, cents of $1</small></span><span>Skew, below − above listed forward <b>${pts(t.skew.kalshiPts)} · ${pts(t.skew.polyPts)} · ${pts(t.skew.smilePts)} pts</b> <small>Kalshi · Polymarket US · Deribit, mid vols</small></span></div>`;
  return `<h3>Bucket boundaries in vol: Kalshi vs Polymarket US vs Deribit</h3>
<p>Range mids summed above each $5,000 line into P(above), each venue divided by its own sum; a bucket bid at 0¢ counts as zero. Inverted to vol on the venue's own 50% point: the vol columns compare shape, the strip compares level. Band: the same sum over bids and over asks; near the centre on $5,000 buckets a digital has little vega, so the band is wide there. Deribit vol at the line beside. Inside: shape agrees. Venue over or under: it does not, and the band is narrow enough to say so. Above any lognormal: more weight past the line than any single vol allows. Wings under 5% or over 95% and the line at the centre are blank. Tail mass in the strip is raw mids, no normalisation, same contracts on all three sources. A venue whose mids sum well past 100¢ is not a coherent distribution; normalising spreads the excess over every line, so read its vol columns as where its book is heavy, with the band as the limit of what it can say.</p>${strip}<div class="tbl"><table><tr><th rowspan="2">Boundary</th><th colspan="3">Kalshi</th><th colspan="3">Polymarket US</th><th rowspan="2">Deribit vol<br><small>at boundary</small></th></tr><tr><th>P(above)<br><small>normalised</small></th><th>Vol<br><small>mid · bid to ask band</small></th><th>Listed vs band</th><th>P(above)<br><small>normalised</small></th><th>Vol<br><small>mid · bid to ask band</small></th><th>Listed vs band</th></tr>${rows}</table></div>`;
}

export function renderReportHtml(d: ReportData, opts: { refreshSec?: number } = {}): string {
  const range = d.yearEnd.find((v) => v.id === "btc-yearend-2026-range");
  const high = d.yearEnd.find((v) => v.id === "btc-yearend-2026-high");
  const low = d.yearEnd.find((v) => v.id === "btc-yearend-2026-low");
  const crosses = d.yearEnd.flatMap((v) => v.rows.filter((r) => r.cross));
  const healthLine = Object.entries(d.health)
    .map(([k, h]) => `<span class="${h.ok ? "ok" : "bad"}">${esc(k)} ${h.ok ? `${h.ms}ms` : esc(h.detail ?? "down")}</span>`)
    .join(" · ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">${opts.refreshSec ? `<meta http-equiv="refresh" content="${opts.refreshSec}">` : ""}
<title>Bitcoin on the event venues: curve, gaps, latency, hedge</title>
<style>
:root{--ink:#111;--dim:#6b7280;--line:#e5e7eb;--k:#0a66c2;--p:#7c3aed;--m:#111;--hot:#b91c1c;--warm:#b45309;--ok:#047857}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;color:var(--ink);background:#fff}
main{max-width:1120px;margin:0 auto;padding:20px 16px 60px}h1{font-size:24px;margin:0 0 4px;letter-spacing:-.01em}h2{font-size:18px;margin:34px 0 8px}h3{font-size:15px;margin:18px 0 6px}
p{margin:6px 0}.dim{color:var(--dim)}small{color:var(--dim);font-size:12px;display:block}.lead{font-size:16px}
.strip{display:flex;flex-wrap:wrap;gap:10px 22px;margin:12px 0 4px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:#fafafa}.strip b{font-variant-numeric:tabular-nums}
.tbl{overflow-x:auto;margin:8px 0}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:14px}th{font-weight:600;text-align:left;color:var(--dim);font-size:12px;border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:bottom;white-space:nowrap}
td{padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:top}td.cross{white-space:normal;min-width:150px;font-size:12px}td.lbl{font-weight:500}td small{display:block;color:var(--dim);font-size:11px}
.hot{color:var(--hot);font-weight:600}.warm{color:var(--warm)}.cool{color:var(--k)}.cross{color:var(--ok)}tr.sum td{font-weight:600;background:#fafafa}tr.ref td{color:var(--dim)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:8px 0}.kpis div{border:1px solid var(--line);border-radius:8px;padding:10px 12px}.kpis b{display:block;font-size:20px;margin:2px 0;font-variant-numeric:tabular-nums}
svg.dist{width:100%;height:auto;display:block;margin-top:6px}svg.dist rect.k{fill:var(--k)}svg.dist rect.p{fill:var(--p)}svg.dist rect.m{fill:var(--m);opacity:.75}svg.dist .ax{font-size:9px;fill:var(--dim)}svg.dist .grid{stroke:var(--line);stroke-width:1}
.legend{display:flex;gap:16px;font-size:12px;color:var(--dim);margin:4px 0 0}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}.legend .k{background:var(--k)}.legend .p{background:var(--p)}.legend .m{background:var(--m)}
svg.spark{width:160px;height:28px;display:block}svg.spark polyline{fill:none;stroke:var(--k);stroke-width:1.5}svg.spark .zero{stroke:var(--line)}
.note{border-left:3px solid var(--line);padding:4px 12px;color:var(--dim);font-size:13px;margin:10px 0}.limits{padding-left:18px;font-size:13px;color:var(--dim);margin:6px 0}.limits li{margin:5px 0}.limits b{color:var(--ink)}.ok{color:var(--ok)}.bad{color:var(--hot)}footer{margin-top:40px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:12px}
</style></head><body><main>
<h1>Bitcoin on the event venues</h1>
<p class="lead">Kalshi and Polymarket US Bitcoin contracts against the listed option market: curve, venue gaps, cost of latency, static vs dynamic hedge. Live from public market data. Read-only.</p>
<div class="strip"><span>BRTI <b>$${num(d.spotUsd, 2)}</b> <small>settlement index, both venues${d.spotSource !== "brti" ? " (Deribit index this cycle)" : ""}</small></span>
<span>As of <b>${et(d.at)}</b> <small>refresh ${d.intervalSec}s</small></span>
<span>Window <b>${d.historyPoints}</b> snapshots <small>${d.collectingSince ? `since ${et(d.collectingSince)}` : "first cycle"}</small></span></div>

<h2>1 · Year-end 2026 curve: Kalshi vs Polymarket US vs options</h2>
<p>Same $5,000 buckets, same index (CF Benchmarks BRTI), same instant (Dec 31, midnight ET). Settlement statistic differs: Kalshi, simple average of the last 60 one-second prints; Polymarket US, 20% trimmed mean of the same 60. Option-implied column: Deribit smile, interpolated, −∂C/∂K. Gaps in cents per $1 contract.</p>
${
  d.basis
    ? `<div class="strip"><span>Deribit ${d.basis.expiry} forward <b>$${num(d.basis.forwardUsd)}</b> <small>vs BRTI $${num(d.basis.spotUsd)} · ${d.basis.pct >= 0 ? "+" : ""}${d.basis.pct.toFixed(2)}% over ${d.basis.daysToExpiry} days · ${d.basis.annualisedPct >= 0 ? "+" : ""}${d.basis.annualisedPct.toFixed(1)}% annualised</small></span><span class="dim">Year-end buckets priced on this forward. Compare with CME December basis.</span></div>`
    : ""
}
${range ? distributionSvg(range) : ""}
${range ? ladderTable(range, { showPoly: range.venues.includes("polymarket_us") }) : '<p class="dim">Year-end range ladder not available this cycle.</p>'}
${
  crosses.length
    ? `<div class="note"><b>Executable crosses:</b> ${crosses.length} bucket${crosses.length > 1 ? "s" : ""} with one venue's offer under the other's bid after both taker fees. Widest ${signed(Math.max(...crosses.map((r) => r.cross!.edgeCents)), 2)} per contract. Total at resting depth ${usd(crosses.reduce((a, r) => a + (r.cross!.edgeCents * r.cross!.qty) / 100, 0), 2)}, before order-level fee rounding. Cents per contract; depth to collect it is small.</div>`
    : '<div class="note">No executable cross after taker fees this snapshot. Gaps are inside the fee band.</div>'
}
${range ? bidsOverSmileNote(range) : ""}
${yearEndVolsHtml(d.yearEndVols)}
<h3>One-touch ladders: high and low of the year</h3>
<p class="dim">Touch fair value is a model (reflection principle, smile vol at the barrier), not a market read. Gap to model indicative only.</p>
${high ? ladderTable(high, { showPoly: high.venues.includes("polymarket_us") }) : ""}
${low ? ladderTable(low, { showPoly: low.venues.includes("polymarket_us") }) : ""}
${d.polyOnly.length ? `<h3>Polymarket US only</h3>${d.polyOnly.map((v) => `<p class="dim">${esc(v.title)} · settles ${et(v.settlesAt)}</p>${ladderTable(v, { showPoly: true })}`).join("")}` : ""}

<h2>2 · Hourly ladder vs options</h2>
${hourlyHtml(d)}
<div class="note">${esc(d.notes.polyUsShortDated)}</div>

<h2>3 · Gaps over time</h2>
<p>Kalshi mid − Polymarket US mid per bucket, each snapshot in the window. Persistent gap: quoting difference. Flickering gap: latency.</p>
${range ? gapsTable(range.gaps, range.venues.includes("polymarket_us")) : ""}

<h2>4 · Cost of latency</h2>
<p>Settlement index moves over 1, 5, 15 and 60 seconds across the last hour of one-second prints, and the value of that move on a $1 at-the-money digital, hourly tenor vs year-end tenor.</p>
<h3>Hourly contract</h3>${latencyTableHtml(d.latency, "hourly")}
<h3>Year-end contract</h3>${latencyTableHtml(d.latencyYearEnd, "year-end")}

<h2>5 · Static vs dynamic hedge, per hourly contract</h2>
<p>Each hourly ladder seen with 20 min to 2 h left: one $1 at-the-money digital sold at Kalshi mid, carried to settlement from the same snapshots. Static: listed call spread bracketing the strike, bought at offer, sold at bid on the first snapshot after close. Dynamic: option-implied digital delta in spot, rebalanced every snapshot through the close, 2 bps on traded notional. Settlement: Kalshi's simple 60-second BRTI average. Naked: premium kept minus payout. Figures per $1 contract; negative is a loss to the writer. Per-contract hedging is the worst case; a book nets delta across strikes and hours.</p>
${replayHtml(d)}

<h2>6 · Lock in on the ${collarTenor(d)} ladder</h2>
<p>Holder-side terms per strike on Kalshi's ${collarTenor(d) === "daily" ? "5 PM ET daily contract (KXBTCD)" : "current hourly ladder"}: floor, cap, credit at settlement. Priced leg for leg off live listed option books, exchange fees and the writer's margin included. Give-up shown. A strike is refused when no floor/cap pair leaves a positive credit after the legs, fees and margin; away from the money that is the usual outcome.</p>
${collarHtml(d)}

<h2>Notes and limits</h2>
<ul class="limits">
<li><b>Prices.</b> Kalshi quotes in sub-penny dollars, kept as quoted (0.20¢, not 0¢). Polymarket US ticks in whole cents. Mid = (bid + ask)/2, formed only with a bid and an offer under 100¢. Depth = resting size at best level only.</li>
<li><b>Fees.</b> Taker only, per $1 contract, unrounded. Kalshi rounds an order's fee up to the cent; Polymarket US to the nearest cent. Kalshi KXBTCY: 0 multiplier (fee-free). KXBTCD and touch series: default 0.07. Polymarket US: the coefficient each market publishes, 0.095 (Tier 1, under $10k trailing taker volume); Tier 4 is 0.0695, narrowing a cross by up to 0.64¢ at 50¢. Maker and taker rebates ignored on both.</li>
<li><b>Model.</b> Deribit out-of-the-money mark IV per strike, linear in log-moneyness, flat beyond listed wings. Black-76, zero rate. Year-end buckets: priced on the expiry's own forward (basis strip above §1); expiry Dec 25 08:00 UTC vs settlement 6d 21h later, smile vol kept, each bucket's own time to settlement used. Buckets settling within a day (hourly ladder): priced on the BRTI reading itself; carry under 1 bp, contract settles on BRTI, smile supplies vol only. Touch probabilities: model (reflection principle at barrier vol), not a market read.</li>
<li><b>Timing.</b> Venue books, option chain and index read within one cycle, not at one instant. BTC moves $30–60 in a typical minute: a few points of probability on an at-the-money hourly strike in its last minutes. Single-row hourly gaps inside that band are noise; the vol strip and replay averages are not.</li>
<li><b>Hedge replay.</b> One event per hourly ladder, opened at first sight with 20 min to 2 h left. Delta flattened at the settlement value; last rebalance at the last snapshot before close (up to one cycle earlier). Spread unwound at Deribit quotes on the first snapshot after close (up to ~2.5 min later), so it carries that much post-close drift. Deribit strikes near the money are $500–$1,000 apart: the static spread is a ramp around the strike, not the exact digital. Dynamic rebalancing runs to the close with no cap; a desk would stop or widen near a pin. Deribit options are priced and settled in BTC; converted at spot each snapshot, dropping a second-order term (premium × move) well under a cent.</li>
<li><b>Reference.</b> Hedge marked against spot BRTI, not a CME future. CME market data is licensed, not public; Deribit's dated future stands in for term basis. Hedging the dynamic leg in futures carries basis: delta notional on an hourly digital is roughly $50–150 per $1 contract, so a 5 bp intra-hour basis move is 2–7¢ of extra tracking error on that leg, zero-mean, not in §5. Static leg already lives on Deribit's forward. Year-end hedge: basis and roll would be a line item.</li>
<li><b>Latency.</b> Index moves from Polymarket US's one-second BRTI history. Measures the index, not any venue's order path.</li>
</ul>

<footer>
<p><b>Sources.</b> Kalshi public market API (KXBTCY, KXBTCMAXY, KXBTCMINY, KXBTCD) · Polymarket US public Retail API (gateway.polymarket.us; BTC series events, books, BRTI candles) · Deribit public book summaries (BTC options) · OKX public option books for the hedge legs in §6. Both event venues settle on CF Benchmarks' Bitcoin Real-Time Index; Kalshi's year-end and hourly ladders take the simple 60-second average, Polymarket US's the 20% trimmed mean over the same 60 seconds; both venues' one-touch ladders use the trimmed mean.</p>
<p><b>Health this cycle.</b> ${healthLine}</p>
<p>Read-only. No credentials loaded. Cannot place orders, move funds or see an account.</p>
</footer></main></body></html>`;
}
