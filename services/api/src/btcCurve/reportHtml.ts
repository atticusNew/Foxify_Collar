/**
 * Server-rendered report page. No framework, no external assets: tables and inline SVG.
 * Readable on a phone, printable, refreshes itself on the collector's cadence.
 */

import type { LatencyRow, BucketRow, GapSeries } from "./analytics";
import type { LadderView, ReportData } from "./report";

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const c = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v.toFixed(digits === 1 && Math.abs(v) < 1 && v !== 0 ? 2 : digits)}¢`;
const usd = (v: number | null | undefined, digits = 2): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(digits)}`;
const signed = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}¢`;
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
  if (v === null) return '<td class="dim">—</td>';
  const cls = Math.abs(v) >= 3 ? "hot" : Math.abs(v) >= 1 ? "warm" : "";
  return `<td class="${cls}">${signed(v)}</td>`;
}

function ladderTable(v: LadderView, opts: { showPoly: boolean }): string {
  const head = `<tr><th>Bucket</th><th>Kalshi<br><small>bid / ask</small></th>${opts.showPoly ? "<th>Polymarket US<br><small>bid / ask</small></th>" : ""}<th>Option-implied<br><small>fair value</small></th>${
    opts.showPoly ? "<th>Kalshi − Poly</th>" : ""
  }<th>Kalshi − model</th>${opts.showPoly ? "<th>Poly − model</th><th>Cross</th>" : ""}</tr>`;
  const rows = v.rows
    .map((r) => {
      const cross = r.cross
        ? `<td class="cross">buy ${r.cross.buyOn === "kalshi" ? "Kalshi" : "Poly"} ${r.cross.buyAtCents}¢ → sell ${r.cross.sellOn === "kalshi" ? "Kalshi" : "Poly"} ${r.cross.sellAtCents}¢ · <b>${signed(r.cross.edgeCents, 2)}</b> net${
            r.cross.qty ? ` · ${num(r.cross.qty, 1)} ct` : ""
          }</td>`
        : '<td class="dim">—</td>';
      return `<tr><td class="lbl">${esc(r.label)}</td>${ba(r.kalshi)}${opts.showPoly ? ba(r.poly) : ""}<td>${c(r.modelCents)}</td>${
        opts.showPoly ? gapCell(r.venueGapCents) : ""
      }${gapCell(r.kalshiVsModelCents)}${opts.showPoly ? gapCell(r.polyVsModelCents) + cross : ""}</tr>`;
    })
    .join("");
  const sums =
    v.sumKalshi !== null || v.sumPoly !== null || v.sumModel !== null
      ? `<tr class="sum"><td class="lbl">Sum of mids <small>(100¢ = a fair book; above it is the venue's overround)</small></td><td>${c(v.sumKalshi, 0)}</td>${
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
  <div class="legend"><span><i class="k"></i>Kalshi mid</span><span><i class="p"></i>Polymarket US mid</span><span><i class="m"></i>Option-implied (Deribit ${esc(v.modelExpiry ?? "")})</span></div>`;
}

function spark(series: Array<[number, number]>, range: number): string {
  if (series.length < 2) return '<span class="dim">collecting…</span>';
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
  if (!rows.length) return '<p class="dim">The gap series fills in as snapshots accumulate (one per minute).</p>';
  const range = Math.max(2, ...rows.map((g) => g.stats.venueMax ?? 0));
  return `<div class="tbl"><table><tr><th>Bucket</th><th>${showPoly ? "Kalshi − Poly, over the window" : "Kalshi − model, over the window"}</th><th>mean |gap|</th><th>max |gap|</th><th>last</th><th>n</th></tr>${rows
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
  if (!rows.length || !rows[0].n) return '<p class="dim">Index history not available this cycle.</p>';
  return `<div class="tbl"><table><tr><th>If you are late by</th><th>index moves (median)</th><th>index moves (p90)</th><th>worst in window</th><th>on a $1 ATM digital, ${esc(tenor)}<br><small>median / p90</small></th></tr>${rows
    .map(
      (r) =>
        `<tr><td class="lbl">${r.horizonSec}s</td><td>${r.p50Bps.toFixed(2)} bps</td><td>${r.p90Bps.toFixed(2)} bps</td><td>${r.maxBps.toFixed(2)} bps</td><td><b>${c(r.atmCentsP50, 2)}</b> / ${c(r.atmCentsP90, 2)}</td></tr>`,
    )
    .join("")}</table></div>`;
}

function replayHtml(d: ReportData): string {
  const r = d.replay;
  const head = `<div class="kpis">
    <div><small>contracts replayed</small><b>${r.n}</b><small>${r.open} in flight</small></div>
    <div><small>mean outcome, naked</small><b>${usd(r.meanNaked, 3)}</b><small>per $1 sold</small></div>
    <div><small>mean outcome, static spread</small><b>${usd(r.meanStatic, 3)}</b><small>up-front cost ${usd(r.meanStaticEntryUsd, 3)}</small></div>
    <div><small>mean outcome, dynamic delta</small><b>${usd(r.meanDynamic, 3)}</b><small>fees paid ${usd(r.meanDynamicCostUsd, 4)}</small></div>
    <div><small>p90 stray from premium</small><b>${usd(r.p90AbsNaked, 2)} · ${usd(r.p90AbsStatic, 2)} · ${usd(r.p90AbsDynamic, 2)}</b><small>naked · static · dynamic</small></div>
  </div>`;
  if (!r.recent.length) return `${head}<p class="dim">The first hourly contract settles within the hour of the collector starting; results appear here as each one closes.</p>`;
  const minsBefore = (e: (typeof r.recent)[number]) => Math.round((e.settlesAtMs - Date.parse(e.openedAt)) / 60_000);
  return `${head}<div class="tbl"><table><tr><th>Hourly close</th><th>Strike</th><th>Sold at<br><small>min before close</small></th><th>Settled</th><th>Paid</th><th>Naked</th><th>Static<br><small>spread cost</small></th><th>Dynamic<br><small>fees · rebalances</small></th></tr>${r.recent
    .map(
      (e) =>
        `<tr><td class="lbl">${et(e.settlesAt)}</td><td>$${num(e.strike)}</td><td>${e.premiumCents.toFixed(1)}¢<small>${minsBefore(e)} min</small></td><td>$${num(e.done?.settleValue ?? 0, 2)}</td><td>${e.done?.payout ? "$1" : "$0"}</td><td>${usd(e.done?.nakedUsd, 3)}</td><td>${usd(
          e.done?.staticUsd,
          3,
        )}<small>${e.staticHedge ? usd(e.staticHedge.entryUsd, 3) : "no spread"}</small></td><td>${usd(e.done?.dynamicUsd, 3)}<small>${usd(e.dynamicHedge.feesUsd, 3)} · ${e.dynamicHedge.rebalances}</small></td></tr>`,
    )
    .join("")}</table></div>`;
}

function collarHtml(d: ReportData): string {
  const col = d.collar;
  if (!col) return '<p class="dim">Not quoted this cycle.</p>';
  if (col.error) return `<p class="dim">${esc(col.error)}</p>`;
  if (!col.rows.length) return '<p class="dim">No strike on this hour\'s ladder has a mark inside the quotable band right now.</p>';
  return `<p class="dim">Hourly ladder closing ${et(col.settlesAt)} · hedge legs on listed BTC option books · per $1 contract, 100 contracts quoted</p><div class="tbl"><table><tr><th>Strike</th><th>Mark</th><th>Floor</th><th>Cap</th><th>Credit to holder</th><th>Upside given up<br><small>100¢ − cap</small></th><th>Hedge expiry</th><th></th></tr>${col.rows
    .map((r) =>
      r.ok
        ? `<tr><td class="lbl">${esc(r.label)}</td><td>${r.markCents}¢</td><td><b>${r.floorCents}¢</b></td><td><b>${r.capCents}¢</b></td><td><b>${c(r.creditCents, 0)}</b></td><td>${c(r.upsideGivenUpCents, 0)}</td><td>${esc(r.hedgeExpiry)}<br><small>${esc(
            r.alignment === "expiry_aligned" ? "aligned" : "unwound at the close",
          )}</small></td><td class="dim">${r.takeCents !== undefined ? `take ${r.takeCents}¢ · legs ${c(r.hedgeCostCents, 0)}` : ""}</td></tr>`
        : `<tr class="ref"><td class="lbl">${esc(r.label)}</td><td>${r.markCents}¢</td><td colspan="6" class="dim">refused · ${esc(r.refusal)}</td></tr>`,
    )
    .join("")}</table></div>`;
}

function hourlyHtml(d: ReportData): string {
  if (!d.hourly) return '<p class="dim">No open hourly ladder with at least 30 minutes to run.</p>';
  const v = d.hourly;
  const rows = v.rows.filter((r) => r.kalshi && r.kalshi.bidCents > 0 && r.kalshi.askCents > 0 && (r.kalshi.bidCents + r.kalshi.askCents) / 2 >= 1.5 && (r.kalshi.bidCents + r.kalshi.askCents) / 2 <= 98.5);
  const hv = d.hourlyVol;
  const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${x.toFixed(0)}%`);
  const volStrip = hv
    ? `<div class="strip"><span>Kalshi's ladder is priced at <b>${pct(hv.ladder?.ladderPct)}</b> vol <small>lognormal fit to ${hv.ladder?.n ?? 0} two-sided strikes · centre $${hv.ladder ? num(hv.ladder.forwardUsd) : "—"} · rms miss ${c(hv.ladder?.rmsCents ?? null)}</small></span>
<span>listed options at the money <b>${pct(hv.smilePct)}</b> <small>Deribit ${esc(hv.smileExpiry ?? "")} mark IV</small></span>
<span>index realised, last hour <b>${pct(hv.realized?.pct)}</b> <small>one-minute BRTI returns, annualised</small></span>
<span>closes in <b>${hv.minutesToClose} min</b></span></div>`
    : "";
  const premiumNote =
    hv?.ladder && hv.smilePct
      ? `<p class="dim">The "Kalshi − model" column is mostly this vol difference: a ladder priced over the listed vol sits below the model on strikes under spot and above it on strikes over spot (the reverse when priced under). That is the venue's risk premium on the hour, not a model error, and it is what a writer who hedges at the listed vol is collecting or paying in §5.</p>`
      : "";
  return `<p class="dim">${esc(v.title)} · closes ${et(v.settlesAt)} · smile from Deribit ${esc(v.modelExpiry ?? "")}</p>${volStrip}${premiumNote}${ladderTable({ ...v, rows }, { showPoly: v.venues.includes("polymarket_us") })}`;
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
<title>Bitcoin on the event venues — the curve, the gaps, the hedge</title>
<style>
:root{--ink:#111;--dim:#6b7280;--line:#e5e7eb;--k:#0a66c2;--p:#7c3aed;--m:#111;--hot:#b91c1c;--warm:#b45309;--ok:#047857}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;color:var(--ink);background:#fff}
main{max-width:1120px;margin:0 auto;padding:20px 16px 60px}h1{font-size:24px;margin:0 0 4px;letter-spacing:-.01em}h2{font-size:18px;margin:34px 0 8px}h3{font-size:15px;margin:18px 0 6px}
p{margin:6px 0}.dim{color:var(--dim)}small{color:var(--dim);font-size:12px;display:block}.lead{font-size:16px}
.strip{display:flex;flex-wrap:wrap;gap:10px 22px;margin:12px 0 4px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:#fafafa}.strip b{font-variant-numeric:tabular-nums}
.tbl{overflow-x:auto;margin:8px 0}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:14px}th{font-weight:600;text-align:left;color:var(--dim);font-size:12px;border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:bottom;white-space:nowrap}
td{padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:top}td.cross{white-space:normal;min-width:150px;font-size:12px}td.lbl{font-weight:500}td small{display:block;color:var(--dim);font-size:11px}
.hot{color:var(--hot);font-weight:600}.warm{color:var(--warm)}.cross{color:var(--ok)}tr.sum td{font-weight:600;background:#fafafa}tr.ref td{color:var(--dim)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:8px 0}.kpis div{border:1px solid var(--line);border-radius:8px;padding:10px 12px}.kpis b{display:block;font-size:20px;margin:2px 0;font-variant-numeric:tabular-nums}
svg.dist{width:100%;height:auto;display:block;margin-top:6px}svg.dist rect.k{fill:var(--k)}svg.dist rect.p{fill:var(--p)}svg.dist rect.m{fill:var(--m);opacity:.75}svg.dist .ax{font-size:9px;fill:var(--dim)}svg.dist .grid{stroke:var(--line);stroke-width:1}
.legend{display:flex;gap:16px;font-size:12px;color:var(--dim);margin:4px 0 0}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}.legend .k{background:var(--k)}.legend .p{background:var(--p)}.legend .m{background:var(--m)}
svg.spark{width:160px;height:28px;display:block}svg.spark polyline{fill:none;stroke:var(--k);stroke-width:1.5}svg.spark .zero{stroke:var(--line)}
.note{border-left:3px solid var(--line);padding:4px 12px;color:var(--dim);font-size:13px;margin:10px 0}.limits{padding-left:18px;font-size:13px;color:var(--dim);margin:6px 0}.limits li{margin:5px 0}.limits b{color:var(--ink)}.ok{color:var(--ok)}.bad{color:var(--hot)}footer{margin-top:40px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:12px}
</style></head><body><main>
<h1>Bitcoin on the event venues</h1>
<p class="lead">The curve, the gaps between venues, what being late costs, and how a static hedge compares with a dynamic one — read live from public market data. Nothing here trades.</p>
<div class="strip"><span>BRTI <b>$${num(d.spotUsd, 2)}</b> <small>settlement index of both venues${d.spotSource !== "brti" ? " (Deribit index this cycle)" : ""}</small></span>
<span>as of <b>${et(d.at)}</b> <small>refreshes every ${d.intervalSec}s</small></span>
<span>window <b>${d.historyPoints}</b> snapshots <small>${d.collectingSince ? `collecting since ${et(d.collectingSince)}` : "first cycle"}</small></span></div>

<h2>1 · The curve: year-end 2026, same contract on two venues</h2>
<p>Both venues list "where does Bitcoin close 2026" as the same $5,000 buckets on the same index (CF Benchmarks BRTI) at the same instant (midnight ET, Dec 31). The one difference is the statistic: Kalshi takes the simple average of the last 60 one-second prints, Polymarket US the 20% trimmed mean of the same 60, so the two settle apart only when the final minute is disorderly. Next to each bucket is the probability the listed option market implies for it (Deribit smile, interpolated, read as −∂C/∂K). Gaps are in cents of a $1 contract.</p>
${range ? distributionSvg(range) : ""}
${range ? ladderTable(range, { showPoly: range.venues.includes("polymarket_us") }) : '<p class="dim">Year-end range ladder not available this cycle.</p>'}
${
  crosses.length
    ? `<div class="note"><b>Executable crosses right now:</b> ${crosses.length} bucket${crosses.length > 1 ? "s" : ""} where one venue's offer is under the other's bid after both taker fees; widest ${signed(Math.max(...crosses.map((r) => r.cross!.edgeCents)), 2)} per contract. At the resting depth shown that is ${usd(crosses.reduce((a, r) => a + (r.cross!.edgeCents * r.cross!.qty) / 100, 0), 2)} in total before the order-level fee rounding, which is the point: the venues disagree by cents per contract, and the depth to collect it is small.</div>`
    : '<div class="note">No executable cross between the two venues after taker fees at this snapshot. The gaps you see are inside the fee band, which is itself the point: cents of difference per contract, not dollars.</div>'
}
<h3>"How high this year" and "how low this year" (one-touch ladders)</h3>
<p class="dim">Fair value for a touch is a model (reflection principle on the smile's vol at the barrier), not a market read. Treat the gap to model as indicative.</p>
${high ? ladderTable(high, { showPoly: high.venues.includes("polymarket_us") }) : ""}
${low ? ladderTable(low, { showPoly: low.venues.includes("polymarket_us") }) : ""}
${d.polyOnly.length ? `<h3>Listed on Polymarket US only</h3>${d.polyOnly.map((v) => `<p class="dim">${esc(v.title)} · settles ${et(v.settlesAt)}</p>${ladderTable(v, { showPoly: true })}`).join("")}` : ""}

<h2>2 · The hourly ladder against the option market</h2>
${hourlyHtml(d)}
<div class="note">${esc(d.notes.polyUsShortDated)}</div>

<h2>3 · Gaps over time</h2>
<p>Kalshi mid minus Polymarket US mid per bucket, every snapshot in the window. A gap that persists is a quoting difference; one that flickers is latency.</p>
${range ? gapsTable(range.gaps, range.venues.includes("polymarket_us")) : ""}

<h2>4 · What being late costs</h2>
<p>How far the settlement index moved over 1, 5, 15 and 60 seconds across the last hour of one-second prints, and what that move is worth on a $1 at-the-money digital. The same move is worth very different amounts on an hourly contract and a year-end one.</p>
<h3>Hourly contract</h3>${latencyTableHtml(d.latency, "hourly")}
<h3>Year-end contract</h3>${latencyTableHtml(d.latencyYearEnd, "year-end")}

<h2>5 · Static vs dynamic hedge, one hourly contract at a time</h2>
<p>For every hourly ladder the collector sees with 20 minutes to 2 hours left, one $1 at-the-money digital is sold at the Kalshi mid and carried to settlement two ways from the same snapshots: a listed call spread bracketing the strike, bought at the offer and sold back at the bid on the first snapshot after the close; and the option-implied digital delta held in spot, rebalanced every snapshot (including the last minutes, when it is largest) at 2 bps of traded notional. Settlement is the simple 60-second BRTI average Kalshi uses. "Naked" is the premium kept minus the payout owed. Outcomes are per $1 of contract; negative is a loss to the writer.</p>
${replayHtml(d)}

<h2>6 · Lock in along the ladder</h2>
<p>The holder-side terms a protection writer could offer on each strike of the current hourly ladder — floor, cap, and the credit paid at settlement — priced leg-for-leg off live listed option books with the give-up side shown. Refusals are named rather than hidden.</p>
${collarHtml(d)}

<h2>Notes and limits</h2>
<ul class="limits">
<li><b>Prices.</b> Kalshi quotes in sub-penny dollars and the page keeps them (0.20¢ is 0.20¢, not 0¢); Polymarket US ticks in whole cents. Mids are (bid + ask)/2 and are only formed when a bucket has a bid and an offer under 100¢. Depth is the resting size at the best level only.</li>
<li><b>Fees.</b> Taker only, per $1 contract, unrounded: Kalshi rounds an order's fee up to the cent, Polymarket US to the nearest cent. Kalshi's KXBTCY carries a 0 multiplier (fee-free); KXBTCD and the touch series use the default 0.07. Polymarket US's coefficient is the one each market publishes, 0.095, which is its Tier 1 (under $10k trailing taker volume); its Tier 4 rate is 0.0695, which would narrow a cross by up to 0.64¢ at 50¢. Maker rebates and taker rebates are ignored on both.</li>
<li><b>Model.</b> Out-of-the-money mark IV per strike from Deribit, linear in log-moneyness, flat beyond the listed wings; Black-76 on the expiry's own forward, zero rate. The year-end expiry is Dec 25 08:00 UTC against a settlement six days and 21 hours later; the smile's vol is kept and each bucket's own time to settlement is used. Touch probabilities are a model (reflection principle at the barrier's vol), not a market read.</li>
<li><b>Hedge replay.</b> One event per hourly ladder, opened at first sight with 20 minutes to 2 hours left. The spread's unwind and the delta's last rebalance use the first snapshot after the close (up to ~2½ minutes later). Deribit strikes near the money are $500–$1,000 apart, so the static spread is a ramp around the strike, not the exact digital. Dynamic rebalancing runs to the close with no cap; a desk would stop or widen as the delta spikes near a pin, which this replay does not do.</li>
<li><b>Reference.</b> Spot BRTI stands in for the hedge reference. A desk would reference the CME BTC future and carry the basis; that changes the hedge numbers in §5 and §6, not the venue comparison in §1–§4.</li>
<li><b>Latency.</b> Index moves are from Polymarket US's one-second BRTI history, so the table measures the index, not any venue's order path.</li>
</ul>

<footer>
<p><b>Sources.</b> Kalshi public market API (KXBTCY, KXBTCMAXY, KXBTCMINY, KXBTCD) · Polymarket US public Retail API (gateway.polymarket.us; BTC series events, books, BRTI candles) · Deribit public book summaries (BTC options) · OKX public option books for the hedge legs in §6. Both event venues settle on CF Benchmarks' Bitcoin Real-Time Index; Kalshi's year-end and hourly ladders take the simple 60-second average, Polymarket US's the 20% trimmed mean over the same 60 seconds; both venues' one-touch ladders use the trimmed mean.</p>
<p><b>Health this cycle.</b> ${healthLine}</p>
<p>Read-only. No credentials are loaded by this service; it cannot place orders, move funds or see an account.</p>
</footer></main></body></html>`;
}
