/**
 * The BTC pairs page: server-rendered, no framework, no external assets. The body re-fetches
 * itself every cycle so the page keeps its scroll position. Same conventions as the other
 * report pages. No em dashes in copy.
 */

import type { HorizonSet, PairsReport, PairLeg, StrikePair } from "./pairs";

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const c = (v: number | null | undefined, digits = 1): string => (v === null || v === undefined || !Number.isFinite(v) ? "–" : `${v.toFixed(digits)}¢`);
const signed = (v: number | null | undefined, digits = 1): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  const z = Math.abs(v) < 0.5 * 10 ** -digits;
  return `${!z && v > 0 ? "+" : !z && v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}¢`;
};
const usd = (v: number | null | undefined, digits = 0): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "–" : `$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const num = (v: number, digits = 0): string => v.toLocaleString("en-US", { maximumFractionDigits: digits });
const et = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return `${d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET`;
};
const etTime = (iso: string): string => et(iso).replace(/^.*?, /, "");
const px = (x: number): string => (Number.isInteger(x) ? x.toFixed(0) : x.toFixed(2).replace(/0$/, ""));
const V = (v: string): string => (v === "kalshi" ? "Kalshi" : "Polymarket US");
const PLACE = { below: "One below", atm: "At the money", above: "One above" } as const;
const HORIZON = { hourly: "Hourly", daily: "Daily, 5 PM ET" } as const;
/** "Hourly" reads as the next close; when that is the 5 PM ET contract (Kalshi lists it in the same series), say so. */
const horizonLabel = (h: "hourly" | "daily", settlesAt: string): string => {
  if (h === "daily") return HORIZON.daily;
  const hour = Number(new Date(settlesAt).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }));
  return hour === 17 ? "Next close, the 5 PM ET contract" : HORIZON.hourly;
};

function legCell(l: PairLeg | null): string {
  if (!l) return '<td class="dim">not listed</td>';
  const bid = l.bidCents > 0 ? px(l.bidCents) : "–";
  const ask = l.askCents > 0 && l.askCents < 100 ? px(l.askCents) : "–";
  const depth = l.bidQty || l.askQty ? `${num(l.bidQty)} × ${num(l.askQty)}` : "depth not read";
  return `<td><a href="${esc(l.url)}" target="_blank" rel="noopener"><b>${bid}</b> / <b>${ask}</b></a><small>${depth} · fee ${(l.feeTheta * 100).toFixed(1)}%</small></td>`;
}

function spark(series: Array<[number, number]> | undefined): string {
  if (!series || series.length < 2) return "";
  const W = 140;
  const H = 26;
  const vals = series.map(([, g]) => g);
  const lim = Math.max(1, ...vals.map((v) => Math.abs(v)));
  const x = (i: number) => (i / (series.length - 1)) * W;
  const y = (v: number) => H / 2 - (v / lim) * (H / 2 - 2);
  const pts = series.map(([, g], i) => `${x(i).toFixed(1)},${y(g).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><line class="zero" x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}"/><polyline points="${pts}"/></svg>`;
}

function scoreCell(p: StrikePair): string {
  if (p.score === null) return `<td class="dim">–<small>${esc(p.reading)}</small></td>`;
  const cls = p.score >= 70 ? "ok" : p.score >= 40 ? "warm" : "hot";
  return `<td><b class="${cls}">${p.score}</b><small>${esc(p.reading)}</small></td>`;
}

function lockCell(p: StrikePair): string {
  const l = p.lock;
  if (!l) return '<td class="dim">–</td>';
  const edge = l.edgeCents > 0 ? `<b class="ok">locks ${c(l.edgeCents, 2)}</b>` : `<b>${c(l.costCents, 2)}</b> for both sides`;
  return `<td class="lock">${edge}<small>Yes on ${V(l.yesOn)} ${c(l.yesAtCents, 1)} + No on ${V(l.noOn)} ${c(l.noAtCents, 1)} + fees ${c(l.feesCents, 2)}${l.qty ? ` · ${num(l.qty)} ct` : ""}</small></td>`;
}

function persistCell(p: StrikePair): string {
  const h = p.persistence;
  if (!h) return '<td class="dim">–<small>first readings</small></td>';
  return `<td>${spark(h.series)}<small>${h.n} readings · same sign ${Math.round(h.sameSign * 100)}% · mean ${signed(h.meanGapCents, 2)}</small></td>`;
}

function horizonTable(s: HorizonSet, spotUsd: number): string {
  const head = `<tr><th>Strike</th><th>Kalshi<br><small>Yes bid / ask · depth</small></th><th>Polymarket US<br><small>Yes bid / ask · depth</small></th><th>Kalshi − Poly<br><small>mids</small></th><th>Spreads<br><small>both, summed</small></th><th>Both sides, cheapest<br><small>after both fees</small></th><th>Gap over the window</th><th>Clean score<br><small>0 to 100</small></th></tr>`;
  const rows = s.pairs
    .map((p) => {
      const rel = p.strike - spotUsd;
      const relTxt = Math.abs(rel) < 1 ? "at spot" : `${rel > 0 ? "+" : "−"}${usd(Math.abs(rel))} vs spot`;
      const gapCls = p.gapCents === null ? "dim" : Math.abs(p.gapCents) >= 2 ? "hot" : Math.abs(p.gapCents) >= 1 ? "warm" : "";
      return `<tr class="${p.place === "atm" ? "atm" : ""}"><td class="lbl"><b>${usd(p.strike)}</b> or above<small>${PLACE[p.place]} · ${relTxt}</small></td>${legCell(p.kalshi)}${legCell(p.poly)}<td class="${gapCls}">${signed(p.gapCents, 1)}</td><td>${c(p.spreadCents, 1)}</td>${lockCell(p)}${persistCell(p)}${scoreCell(p)}</tr>`;
    })
    .join("");
  const ctx = s.context.length
    ? `<details><summary>The strikes around the money, mids only</summary><div class="tbl"><table><tr><th>Strike</th>${s.context.map((r) => `<th>${usd(r.strike)}</th>`).join("")}</tr><tr><td class="lbl">Kalshi mid</td>${s.context.map((r) => `<td>${c(r.kalshiMid, 1)}</td>`).join("")}</tr><tr><td class="lbl">Polymarket US mid</td>${s.context.map((r) => `<td>${c(r.polyMid, 1)}</td>`).join("")}</tr><tr><td class="lbl">Kalshi − Poly</td>${s.context.map((r) => `<td class="${r.gapCents !== null && Math.abs(r.gapCents) >= 1 ? "warm" : ""}">${signed(r.gapCents, 1)}</td>`).join("")}</tr></table></div></details>`
    : "";
  const missing = !s.venues.kalshi ? '<p class="warn">Kalshi lists no contract at this close right now; the Polymarket US side stands alone.</p>' : !s.venues.poly ? '<p class="warn">Polymarket US lists no contract at this close right now; the Kalshi side stands alone.</p>' : "";
  return `${missing}<div class="tbl"><table>${head}${rows}</table></div>${ctx}`;
}

function bundleCard(p: StrikePair, spotUsd: number): string {
  const k = p.kalshi;
  const q = p.poly;
  const links = [k ? `<a href="${esc(k.url)}" target="_blank" rel="noopener">Kalshi ${esc(k.id)}</a>` : "", q ? `<a href="${esc(q.url)}" target="_blank" rel="noopener">Polymarket US ${esc(q.id)}</a>` : ""].filter(Boolean).join(" · ");
  const plan = p.lock
    ? `<li>Both sides, cheapest route: Yes on ${V(p.lock.yesOn)} at ${c(p.lock.yesAtCents, 1)}, No on ${V(p.lock.noOn)} at ${c(p.lock.noAtCents, 1)}, fees ${c(p.lock.feesCents, 2)}: <b>${c(p.lock.costCents, 2)}</b> for a contract that pays 100¢${p.lock.edgeCents > 0 ? ` <b class="ok">(locks ${c(p.lock.edgeCents, 2)})</b>` : ""}${p.lock.qty ? `, ${num(p.lock.qty)} contracts at the best levels` : ""}.</li>`
    : "";
  const rel = p.strike - spotUsd;
  return `<div class="card">
<div class="card-h"><div><span class="eyebrow">${horizonLabel(p.horizon, p.settlesAt)} · closes ${etTime(p.settlesAt)}</span><h3>${usd(p.strike)} or above <small>${PLACE[p.place].toLowerCase()} · ${Math.abs(rel) < 1 ? "at spot" : `${rel > 0 ? "+" : "−"}${usd(Math.abs(rel))} vs spot`}</small></h3></div><div class="score"><b>${p.score}</b><small>clean score</small></div></div>
<div class="legs">${k ? `<div><span>Kalshi</span><b>${px(k.bidCents)} / ${px(k.askCents)}</b><small>${num(k.bidQty)} × ${num(k.askQty)} · fee ${(k.feeTheta * 100).toFixed(1)}%</small></div>` : ""}${q ? `<div><span>Polymarket US</span><b>${px(q.bidCents)} / ${px(q.askCents)}</b><small>${num(q.bidQty)} × ${num(q.askQty)} · fee ${(q.feeTheta * 100).toFixed(1)}%</small></div>` : ""}<div><span>Kalshi − Poly</span><b>${signed(p.gapCents, 1)}</b><small>${p.persistence ? `same sign ${Math.round(p.persistence.sameSign * 100)}% of ${p.persistence.n} readings` : "first readings"}</small></div></div>
<p class="reading">${esc(p.reading)}</p>
<ul class="plan">${plan}<li>Same strike, same close, same index (BRTI 60-second average into ${etTime(p.settlesAt)}) on both venues.</li></ul>
<div class="acts"><button type="button" class="go" data-k="${esc(k?.url ?? "")}" data-p="${esc(q?.url ?? "")}">Open both venues</button><span class="links">${links}</span></div>
</div>`;
}

function bundleHtml(d: PairsReport): string {
  if (!d.bundle.length) return '<p class="dim">No strike is two-sided on both venues right now. The tables below show what each venue does quote.</p>';
  const top = d.bundle.slice(0, 2);
  return `<div class="cards">${top.map((p) => bundleCard(p, d.spotUsd)).join("")}</div>${
    d.bundle.length > 2 ? `<p class="dim">Then: ${d.bundle.slice(2).map((p) => `${p.horizon === "daily" ? "daily" : horizonLabel(p.horizon, p.settlesAt) === HORIZON.hourly ? "hourly" : "5 PM today"} ${usd(p.strike)} (${p.score})`).join(", ")}.</p>` : ""
  }`;
}

/** The part of the page that changes every cycle. */
export function renderPairsBody(d: PairsReport): string {
  const healthLine = Object.entries(d.health)
    .map(([k, h]) => `<span class="${h.ok ? "ok" : "bad"}">${esc(k)} ${h.ok ? `${h.ms}ms` : esc(h.detail ?? "down")}</span>`)
    .join(" · ");
  const section = (s: HorizonSet | null, title: string, none: string) =>
    `<h2>${s ? horizonLabel(s.horizon, s.settlesAt) : title}${s ? ` <span class="dim">${usd(s.stepUsd)} grid · closes ${et(s.settlesAt)} · ${s.minutesToClose} min</span>` : ""}</h2>${s ? horizonTable(s, d.spotUsd) : `<p class="dim">${none}</p>`}`;
  return `<div class="strip"><span>BRTI <b>${usd(d.spotUsd, 0)}</b> <small>${esc(d.spotSource)} · as of ${et(d.at)}</small></span><span>Refresh <b>${d.intervalSec}s</b> <small>${d.historyPoints} readings in the window${d.collectingSince ? ` · since ${et(d.collectingSince)}` : ""}</small></span>${
    d.hourly ? `<span>Hourly closes <b>${etTime(d.hourly.settlesAt)}</b> <small>${d.hourly.minutesToClose} min</small></span>` : "<span>Hourly <b>not listed</b> <small>no hour closes inside 90 min (the 5 PM hour belongs to the daily)</small></span>"
  }${d.daily ? `<span>Daily closes <b>${et(d.daily.settlesAt)}</b> <small>${d.daily.minutesToClose} min</small></span>` : "<span>Daily <b>not listed</b></span>"}</div>
<h2>The bundle</h2>
<p>The cleanest pairs right now: both venues two-sided on the same contract, tight, deep, mids in agreement. One button opens both venues' pages; the ladders are yours to place.</p>
${bundleHtml(d)}
${section(d.hourly, "Hourly", "No hourly contract closes within the next 90 minutes on either venue.")}
${section(d.daily, "Daily, 5 PM ET", "No daily contract within 36 hours on either venue (none is listed on Fridays; the weekly takes that close).")}
<h2>Notes and limits</h2>
<ul class="limits">
<li><b>Contracts.</b> Kalshi KXBTCD and Polymarket US btc-strike-hourly / btc-strike-daily. "Strike or above" settles Yes when the BRTI 60-second average into the close is at or above the strike, on both venues. The hourly skips the 5 PM ET hour on Polymarket US (the daily owns it); Kalshi lists it, so that hour shows Kalshi alone. No daily on Fridays on Polymarket US.</li>
<li><b>At the money.</b> The listed strike nearest the BRTI print this cycle; one strike each way is the ladder's own next strike. Spot moves between cycles; the row's "vs spot" tells you where it sits now.</li>
<li><b>Clean score.</b> 40% how tight (both spreads summed, 0¢ full marks, 10¢ none), 30% how deep (thinnest of the four best levels, 200 contracts full marks), 30% how closely the two mids agree (0¢ full marks, 5¢ none). Scored only when both venues show a bid and an ask. It ranks tradability, not edge; the gap and the lock columns carry the edge.</li>
<li><b>Both sides, cheapest.</b> Yes at one venue's ask plus No at 100 minus the other venue's Yes bid, plus both taker fees (Kalshi 0.07, Polymarket US the market's coefficient, 0.095 at Tier 1). Under 100¢ is a cross and locks the difference whichever way BRTI settles. Depth is the thinner level.</li>
<li><b>Timing.</b> The two venues are read within one cycle, not at one instant. A cent of gap can be a few seconds of latency on the hourly; the gap sparkline and "same sign" tell persistent from flicker.</li>
<li><b>Links.</b> Polymarket US links open the event page; Kalshi links open the series page unless the deploy sets the exact event URL pattern. Nothing here places an order.</li>
</ul>
<footer><p><b>Sources.</b> Kalshi public market API (KXBTCD markets, orderbooks, series fee) · Polymarket US public Retail API (gateway.polymarket.us; series, events, books, BRTI prints). No credentials loaded.</p><p><b>Health this cycle.</b> ${healthLine}</p></footer>`;
}

export function renderPairsHtml(d: PairsReport, opts: { token?: string } = {}): string {
  const q = opts.token ? `?k=${encodeURIComponent(opts.token)}&` : "?";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>BTC pairs: Kalshi and Polymarket US, at the money</title>
<style>
:root{--ink:#111;--dim:#6b7280;--line:#e5e7eb;--k:#0a66c2;--hot:#b91c1c;--warm:#b45309;--ok:#047857}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;color:var(--ink);background:#fff}
main{max-width:1180px;margin:0 auto;padding:20px 16px 60px}h1{font-size:24px;margin:0 0 4px;letter-spacing:-.01em}h2{font-size:18px;margin:34px 0 8px}h2 .dim{font-size:13px;font-weight:400;margin-left:8px}h3{font-size:17px;margin:2px 0}
p{margin:6px 0}.dim{color:var(--dim)}small{color:var(--dim);font-size:12px;display:block}.lead{font-size:16px}.warn{color:var(--warm);font-size:13px}
.strip{display:flex;flex-wrap:wrap;gap:10px 22px;margin:12px 0 4px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:#fafafa}.strip b{font-variant-numeric:tabular-nums}
.tbl{overflow-x:auto;margin:8px 0}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:14px}th{font-weight:600;text-align:left;color:var(--dim);font-size:12px;border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:bottom;white-space:nowrap}
td{padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:top}td.lbl{font-weight:500}td small{display:block;color:var(--dim);font-size:11px;white-space:normal;max-width:260px}td a{color:inherit;text-decoration:none;border-bottom:1px dotted var(--dim)}tr.atm td{background:#fafafa}td.lock{white-space:normal;min-width:200px}
.hot{color:var(--hot);font-weight:600}.warm{color:var(--warm)}.ok{color:var(--ok)}.bad{color:var(--hot)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;margin:10px 0}.card{border:1px solid var(--line);border-radius:10px;padding:14px 16px;background:#fff}.card-h{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.eyebrow{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.03em}
.score{text-align:right}.score b{font-size:28px;display:block;line-height:1;font-variant-numeric:tabular-nums;color:var(--ok)}.legs{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}.legs div{border:1px solid var(--line);border-radius:8px;padding:8px 10px}.legs span{display:block;font-size:12px;color:var(--dim)}.legs b{font-size:17px;font-variant-numeric:tabular-nums}
.reading{font-size:13px;color:var(--dim)}.plan{padding-left:18px;font-size:13px;margin:6px 0}.plan li{margin:3px 0}.acts{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;margin-top:10px}.go{background:var(--k);color:#fff;border:0;border-radius:8px;padding:9px 14px;font:600 14px inherit;cursor:pointer}.go:hover{filter:brightness(1.08)}.links{font-size:12px}.links a{color:var(--k)}
svg.spark{width:140px;height:26px;display:block}svg.spark polyline{fill:none;stroke:var(--k);stroke-width:1.5}svg.spark .zero{stroke:var(--line)}
details{margin:8px 0}summary{cursor:pointer;color:var(--k);font-size:13px}
.limits{padding-left:18px;font-size:13px;color:var(--dim);margin:6px 0}.limits li{margin:5px 0}.limits b{color:var(--ink)}footer{margin-top:40px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:12px}
</style></head><body><main>
<h1>BTC pairs: Kalshi and Polymarket US, at the money</h1>
<p class="lead">The same Bitcoin above/below contract on both venues: at the money, one strike up, one strike down, hourly and 5 PM ET daily. Both venues settle on CF Benchmarks' BRTI at the same instant and list the same strike grid, so each row is one contract with two books. Scored for how cleanly it trades; the best pairs bundled at the top. Live from public market data every ${d.intervalSec} seconds. Read-only.</p>
<div id="body">${renderPairsBody(d)}</div>
</main>
<script>
(function(){
  var every=${Math.max(5, d.intervalSec)}*1000, body=document.getElementById('body');
  function tick(){fetch('/fragment${q}t='+Date.now(),{cache:'no-store'}).then(function(r){return r.ok?r.text():null}).then(function(h){if(h)body.innerHTML=h}).catch(function(){})}
  setInterval(tick,every);
  document.addEventListener('click',function(e){
    var b=e.target.closest?e.target.closest('button.go'):null;if(!b)return;
    var k=b.getAttribute('data-k'),p=b.getAttribute('data-p');
    if(k)window.open(k,'_blank','noopener');
    if(p)setTimeout(function(){window.open(p,'_blank','noopener')},50);
  });
})();
</script></body></html>`;
}
