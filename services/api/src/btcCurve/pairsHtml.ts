/**
 * The BTC pairs page: a minimal trading UI. Two compact tables (next close, 5 PM ET daily),
 * three strikes each, both venues' books, the gap, a clean score, and a Launch button that
 * posts the pair to the trader's engine. Server-rendered; the body re-fetches itself every
 * cycle. No framework, no external assets. No em dashes in copy.
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
const PLACE = { below: "below", atm: "at the money", above: "above" } as const;

/** "Next close" is the hour closing soonest; when that is the 5 PM ET contract (Kalshi lists it in the same series), say so. */
export const horizonLabel = (h: "hourly" | "daily", settlesAt: string): string => {
  if (h === "daily") return "Daily, 5 PM ET";
  const hour = Number(new Date(settlesAt).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }));
  return hour === 17 ? "Next close, the 5 PM ET contract" : "Hourly, next close";
};

function legCell(l: PairLeg | null): string {
  if (!l) return '<td class="dim">not listed</td>';
  const bid = l.bidCents > 0 ? px(l.bidCents) : "–";
  const ask = l.askCents > 0 && l.askCents < 100 ? px(l.askCents) : "–";
  const depth = l.bidQty || l.askQty ? `${num(l.bidQty)} × ${num(l.askQty)}` : "depth not read";
  return `<td><a href="${esc(l.url)}" target="_blank" rel="noopener"><b>${bid}</b> / <b>${ask}</b></a><small>${depth}</small></td>`;
}

function spark(series: Array<[number, number]> | undefined): string {
  if (!series || series.length < 2) return "";
  const W = 90;
  const H = 18;
  const vals = series.map(([, g]) => g);
  const lim = Math.max(1, ...vals.map((v) => Math.abs(v)));
  const x = (i: number) => (i / (series.length - 1)) * W;
  const y = (v: number) => H / 2 - (v / lim) * (H / 2 - 1);
  const pts = series.map(([, g], i) => `${x(i).toFixed(1)},${y(g).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><line class="zero" x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}"/><polyline points="${pts}"/></svg>`;
}

function gapCell(p: StrikePair): string {
  if (p.gapCents === null) return '<td class="dim">–</td>';
  const cls = Math.abs(p.gapCents) >= 2 ? "hot" : Math.abs(p.gapCents) >= 1 ? "warm" : "";
  const h = p.persistence;
  return `<td class="${cls}">${signed(p.gapCents, 1)}${h ? `<small>${spark(h.series)}${Math.round(h.sameSign * 100)}% same sign · ${h.n}</small>` : ""}</td>`;
}

function bothCell(p: StrikePair): string {
  const l = p.lock;
  if (!l) return '<td class="dim">–</td>';
  const V = (v: string) => (v === "kalshi" ? "K" : "P");
  return `<td>${l.edgeCents > 0 ? `<b class="ok">locks ${c(l.edgeCents, 2)}</b>` : `<b>${c(l.costCents, 2)}</b>`}<small>Yes ${V(l.yesOn)} ${px(l.yesAtCents)} + No ${V(l.noOn)} ${px(l.noAtCents)} + fees ${c(l.feesCents, 2)}${l.qty ? ` · ${num(l.qty)}` : ""}</small></td>`;
}

function scoreCell(p: StrikePair): string {
  if (p.score === null) return `<td class="dim">–<small>${esc(p.reading)}</small></td>`;
  const cls = p.score >= 70 ? "ok" : p.score >= 40 ? "warm" : "hot";
  return `<td><b class="${cls} big">${p.score}</b><small>${esc(p.reading)}</small></td>`;
}

function launchCell(p: StrikePair): string {
  const id = p.kalshi?.id ?? p.poly?.id ?? `${p.horizon}:${p.strike}`;
  const both = [p.kalshi?.url, p.poly?.url].filter(Boolean) as string[];
  return `<td class="act"><button type="button" class="go" data-id="${esc(id)}" ${p.score === null ? 'title="one venue is not two-sided here"' : ""}>Launch</button><button type="button" class="alt" data-open="${esc(both.join("|"))}" title="open both venues' pages">Venues</button><small class="status" data-status="${esc(id)}"></small></td>`;
}

function table(s: HorizonSet, spotUsd: number, bestId: string | null): string {
  const head = `<tr><th>Strike</th><th>Kalshi<br><small>Yes bid / ask · size</small></th><th>Polymarket US<br><small>Yes bid / ask · size</small></th><th>K − P<br><small>mids · window</small></th><th>Both sides<br><small>after fees</small></th><th>Clean<br><small>0 to 100</small></th><th></th></tr>`;
  const rows = s.pairs
    .map((p) => {
      const id = p.kalshi?.id ?? p.poly?.id ?? `${p.horizon}:${p.strike}`;
      const rel = p.strike - spotUsd;
      const relTxt = Math.abs(rel) < 1 ? "at spot" : `${rel > 0 ? "+" : "−"}${usd(Math.abs(rel))}`;
      const best = bestId !== null && id === bestId;
      return `<tr class="${p.place === "atm" ? "atm" : ""}${best ? " best" : ""}"><td class="lbl"><b>${usd(p.strike)}</b><small>${PLACE[p.place]} · ${relTxt}${best ? ' · <span class="ok">cleanest</span>' : ""}</small></td>${legCell(p.kalshi)}${legCell(p.poly)}${gapCell(p)}${bothCell(p)}${scoreCell(p)}${launchCell(p)}</tr>`;
    })
    .join("");
  const missing = !s.venues.kalshi ? '<p class="warn">Kalshi lists no contract at this close; Polymarket US stands alone.</p>' : !s.venues.poly ? '<p class="warn">Polymarket US lists no contract at this close; Kalshi stands alone.</p>' : "";
  return `${missing}<div class="tbl"><table>${head}${rows}</table></div>`;
}

/** The part of the page that changes every cycle. */
export function renderPairsBody(d: PairsReport): string {
  const bestId = d.bundle[0] ? (d.bundle[0].kalshi?.id ?? d.bundle[0].poly?.id ?? null) : null;
  const health = Object.entries(d.health)
    .map(([k, h]) => `<span class="${h.ok ? "ok" : "bad"}">${esc(k)} ${h.ok ? `${h.ms}ms` : esc(h.detail ?? "down")}</span>`)
    .join(" · ");
  const block = (s: HorizonSet | null, title: string, none: string) =>
    `<section><h2>${s ? horizonLabel(s.horizon, s.settlesAt) : title}${s ? ` <span class="meta">closes ${et(s.settlesAt)} · ${s.minutesToClose} min · ${usd(s.stepUsd)} grid</span>` : ""}</h2>${s ? table(s, d.spotUsd, bestId) : `<p class="dim">${none}</p>`}</section>`;
  return `<div class="strip"><span>BRTI <b>${usd(d.spotUsd, 0)}</b><small>${esc(d.spotSource)} · ${etTime(d.at)}</small></span>${
    d.bundle[0] ? `<span>Cleanest now <b>${usd(d.bundle[0].strike)}</b><small>${horizonLabel(d.bundle[0].horizon, d.bundle[0].settlesAt)} · ${PLACE[d.bundle[0].place]} · score ${d.bundle[0].score}</small></span>` : "<span>Cleanest now <b>–</b><small>no strike two-sided on both</small></span>"
  }<span class="right"><small>refresh ${d.intervalSec}s · ${d.historyPoints} readings · ${health}</small></span></div>
${block(d.hourly, "Hourly, next close", "No contract closes within 90 minutes on either venue.")}
${block(d.daily, "Daily, 5 PM ET", "No daily contract within 36 hours (none is listed on Fridays; the weekly takes that close).")}`;
}

export function renderPairsHtml(d: PairsReport, opts: { token?: string; base?: string; launchUrl?: string } = {}): string {
  const base = (opts.base ?? "").replace(/\/$/, "");
  const q = opts.token ? `?k=${encodeURIComponent(opts.token)}&` : "?";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>BTC pairs</title>
<style>
:root{--ink:#111;--dim:#6b7280;--line:#e5e7eb;--k:#0a66c2;--hot:#b91c1c;--warm:#b45309;--ok:#047857;--best:#f0fdf4}
*{box-sizing:border-box}body{margin:0;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;color:var(--ink);background:#fff}
main{max-width:1180px;margin:0 auto;padding:14px 16px 40px}header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}h1{font-size:18px;margin:0;letter-spacing:-.01em}h1 small{display:inline;color:var(--dim);font-weight:400;font-size:13px;margin-left:8px}
h2{font-size:15px;margin:22px 0 6px}.meta{font-size:12px;font-weight:400;color:var(--dim);margin-left:8px}
.dim{color:var(--dim)}small{color:var(--dim);font-size:11px;display:block}.warn{color:var(--warm);font-size:12px;margin:4px 0}
.strip{display:flex;flex-wrap:wrap;gap:8px 22px;align-items:center;margin:10px 0 2px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:#fafafa}.strip b{font-variant-numeric:tabular-nums;font-size:16px}.strip .right{margin-left:auto}.strip .right small{display:inline}
.tbl{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th{font-weight:600;text-align:left;color:var(--dim);font-size:11px;border-bottom:1px solid var(--line);padding:4px 8px;vertical-align:bottom;white-space:nowrap}
td{padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:top}td.lbl b{font-size:15px}td small{white-space:normal;max-width:210px}td a{color:inherit;text-decoration:none;border-bottom:1px dotted var(--dim)}tr.atm td{background:#fafafa}tr.best td{background:var(--best)}
.big{font-size:17px}.hot{color:var(--hot);font-weight:600}.warm{color:var(--warm)}.ok{color:var(--ok)}.bad{color:var(--hot)}
td.act{text-align:right}td.act small{text-align:right;max-width:none;min-height:13px}.go{background:var(--k);color:#fff;border:0;border-radius:7px;padding:7px 14px;font:600 13px inherit;cursor:pointer}.go:hover{filter:brightness(1.08)}.go:disabled{opacity:.5;cursor:default}.alt{background:#fff;color:var(--k);border:1px solid var(--line);border-radius:7px;padding:6px 10px;font:500 12px inherit;cursor:pointer;margin-left:6px}
svg.spark{width:90px;height:18px;display:inline-block;vertical-align:middle;margin-right:6px}svg.spark polyline{fill:none;stroke:var(--k);stroke-width:1.2}svg.spark .zero{stroke:var(--line)}
details{margin:14px 0 0;font-size:12px;color:var(--dim)}summary{cursor:pointer;color:var(--k)}details p{margin:6px 0}details code{background:#f3f4f6;padding:1px 5px;border-radius:4px;color:var(--ink)}
.engine{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}.engine input{flex:1;min-width:260px;font:13px inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px}.engine button{font:500 12px inherit;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:#fff;cursor:pointer}
.limits{padding-left:18px;margin:6px 0}.limits li{margin:4px 0}footer{margin-top:18px;color:var(--dim);font-size:11px}
@media (max-width:760px){td.lbl,th:first-child{position:sticky;left:0;background:#fff;z-index:1}td.act,th:last-child{position:sticky;right:0;background:#fff;z-index:1;box-shadow:-6px 0 8px -6px rgba(0,0,0,.15)}tr.atm td.lbl,tr.atm td.act{background:#fafafa}tr.best td.lbl,tr.best td.act{background:var(--best)}td small{white-space:nowrap;max-width:none}td.lbl small{white-space:normal;max-width:70px}.alt{display:none}}
</style></head><body><main>
<header><h1>BTC pairs <small>Kalshi and Polymarket US · same strike, same close, same index · read-only</small></h1><span class="dim" style="font-size:12px">Launch posts the pair to your engine; nothing here places an order.</span></header>
<div id="body">${renderPairsBody(d)}</div>
<details><summary>Engine endpoint and the API</summary>
<div class="engine"><label for="engine">Launch posts to</label><input id="engine" type="url" placeholder="https://your-engine.example/btc-pair" value="${esc(opts.launchUrl ?? "")}"><button type="button" id="engine-save">Save</button><button type="button" id="engine-test">Test</button><span id="engine-status"></span></div>
<p>Launch sends <code>POST</code> with JSON <code>{ type: "atticus.btc_pair", version: 1, at, spotUsd, index: "BRTI", pair }</code> where <code>pair</code> carries <code>horizon</code>, <code>place</code>, <code>strike</code>, <code>settlesAt</code>, both legs (<code>kalshi.id</code> is the Kalshi ticker, <code>poly.id</code> the Polymarket US market slug; bid, ask, sizes, fee coefficient, url), <code>gapCents</code>, <code>spreadCents</code>, <code>depth</code>, <code>lock</code>, <code>persistence</code>, <code>score</code>. Test sends <code>{ type: "atticus.btc_pair.ping" }</code>. The endpoint must allow cross-origin POST from this page, or your engine can pull instead:</p>
<p><code>GET ${esc(base)}/api/pairs</code> everything · <code>GET ${esc(base)}/api/bundle</code> ranked pairs as launch payloads · <code>GET ${esc(base)}/api/pair?horizon=hourly|daily&amp;place=below|atm|above</code> or <code>?id=&lt;Kalshi ticker | Polymarket US slug&gt;</code> one pair · <code>GET ${esc(base)}/api/stream</code> server-sent events, one <code>pairs</code> event per cycle${opts.token ? " (add <code>k=</code> the token to each)" : ""}.</p>
<ul class="limits">
<li>Both venues settle on the BRTI 60-second average into the close and list the same grid ($100 hourly, $250 daily), so a row is one contract with two books. Polymarket US skips the 5 PM ET hour (its daily owns it) and lists no daily on Fridays.</li>
<li>At the money is the listed strike nearest BRTI this cycle; one each way is the ladder's own next strike. K − P is Kalshi's mid minus Polymarket US's; the sparkline and "same sign" cover the window.</li>
<li>Both sides: Yes at one venue's ask plus No at 100 minus the other's Yes bid, plus both taker fees (Kalshi 0.07, Polymarket US the market's coefficient, 0.095 at Tier 1); under 100¢ locks. Size is the thinner level.</li>
<li>Clean: 40% tightness (both spreads summed, 10¢ scores nothing), 30% depth (thinnest best level, 200 contracts full), 30% agreement of mids (5¢ apart scores nothing). Scored only when both venues are two-sided. It ranks tradability; K − P and Both sides carry the edge.</li>
<li>Venues are read within one cycle, not at one instant. Kalshi links open the series page unless the deploy sets the event URL pattern.</li>
</ul>
<footer>Kalshi public market API (KXBTCD) · Polymarket US public Retail API (gateway.polymarket.us) · BRTI prints from the same gateway. No credentials loaded.</footer>
</details>
</main>
<script>
(function(){
  var BASE=${JSON.stringify(base)},Q=${JSON.stringify(q)},every=${Math.max(5, d.intervalSec)}*1000,body=document.getElementById('body');
  var KEY='atticus.pairs.engine',input=document.getElementById('engine'),estat=document.getElementById('engine-status');
  var saved=null;try{saved=localStorage.getItem(KEY)}catch(e){}
  if(saved)input.value=saved;
  function engine(){return (input.value||'').trim()}
  function tick(){fetch(BASE+'/fragment'+Q+'t='+Date.now(),{cache:'no-store'}).then(function(r){return r.ok?r.text():null}).then(function(h){
    if(!h)return;var keep={};body.querySelectorAll('[data-status]').forEach(function(s){if(s.textContent)keep[s.getAttribute('data-status')]=s.textContent});
    body.innerHTML=h;Object.keys(keep).forEach(function(k){var s=body.querySelector('[data-status="'+k.replace(/"/g,'')+'"]');if(s)s.textContent=keep[k]});
  }).catch(function(){})}
  setInterval(tick,every);
  function post(url,payload){return fetch(url,{method:'POST',mode:'cors',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})}
  document.getElementById('engine-save').onclick=function(){try{localStorage.setItem(KEY,engine())}catch(e){}estat.textContent='saved'};
  document.getElementById('engine-test').onclick=function(){var u=engine();if(!u){estat.textContent='set a URL first';return}estat.textContent='sending…';post(u,{type:'atticus.btc_pair.ping',at:new Date().toISOString()}).then(function(r){estat.textContent='engine answered '+r.status}).catch(function(e){estat.textContent='could not reach it: '+(e&&e.message||e)})};
  document.addEventListener('click',function(e){
    var b=e.target.closest?e.target.closest('button.go,button.alt'):null;if(!b)return;
    if(b.classList.contains('alt')){var us=(b.getAttribute('data-open')||'').split('|').filter(Boolean);us.forEach(function(u,i){setTimeout(function(){window.open(u,'_blank','noopener')},i*60)});return}
    var id=b.getAttribute('data-id'),st=document.querySelector('[data-status="'+id.replace(/"/g,'')+'"]'),u=engine();
    if(!u){if(st)st.textContent='set the engine URL below';document.querySelector('details').open=true;input.focus();return}
    b.disabled=true;if(st)st.textContent='fetching pair…';
    fetch(BASE+'/api/pair'+Q+'id='+encodeURIComponent(id),{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('pair '+r.status);return r.json()})
      .then(function(p){if(st)st.textContent='posting…';return post(u,p)})
      .then(function(r){if(st)st.textContent='engine answered '+r.status+' · '+new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit',second:'2-digit'})})
      .catch(function(err){if(st)st.textContent='failed: '+(err&&err.message||err)})
      .then(function(){b.disabled=false});
  });
})();
</script></body></html>`;
}
