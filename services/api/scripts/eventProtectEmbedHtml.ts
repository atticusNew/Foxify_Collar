/**
 * EMBED DEMO — the protection layer inside somebody else's app.
 *
 * The pitch to a prediction market or broker is not "send your users to our
 * page"; it is "one button on your positions list". This page is that pitch,
 * runnable: a neutral host shell (a brand's positions list, their colours,
 * their wordmark) with our Protect button on every row. Tapping it opens the
 * Protect sheet, priced live from the same scan as the public board; one more
 * tap and the row reshapes to what protection really is on a binary contract:
 * fewer contracts, cash set aside, a floor and a cap. Nothing leaves the host.
 *
 * Positions are the board's simulated positions (real prints, live marks); the
 * sheet reads /api/showcase?ticker= (retail shape, so dev tools show a visitor
 * exactly what the sheet shows). Taps are counted in the same funnel as the
 * public board under page "embed".
 *
 * `?brand=` names the host; it is honoured only when the name is on
 * EVENT_X_BRAND_ALLOWLIST (fail-closed to "Your app"), so nobody can render a
 * competitor's or a regulator's name into a screenshot. `?skin=dark` flips the
 * host shell; the sheet keeps its own look in both, because that is the point:
 * the sheet is ours, the shell is theirs.
 */

import { ATTICUS_LOGO_DATA_URI } from "./eventProtectLogo";
import type { CrossLedgerSummary } from "../src/eventCollar/crossVenue/crossLedger";
import type { EventFunnelSummary } from "../src/eventCollar/crossVenue/eventFunnel";

export interface EmbedOptions {
  /** the host's display name, already checked against the allowlist */
  brand: string;
  skin: "light" | "dark";
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Resolve `?brand=` against the allowlist; anything else is "Your app". */
export function resolveBrand(requested: string | null | undefined, allowlist: string | undefined): string {
  const want = (requested ?? "").trim();
  if (!want) return "Your app";
  const allowed = (allowlist ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const hit = allowed.find((a) => a.toLowerCase() === want.toLowerCase());
  return hit ?? "Your app";
}

export function renderEventEmbedHtml(opts: EmbedOptions): string {
  const brand = escapeHtml(opts.brand);
  const dark = opts.skin === "dark";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex" />
<link rel="icon" href="data:," />
<title>${brand} · Positions</title>
<meta name="description" content="How Earn &amp; Protect sits inside a prediction market's positions list: one Protect button per row, one sheet, one tap. Demonstration; positions are simulated, prices are live." />
<style>
:root{
  ${
    dark
      ? `--bg:#0f1115; --card:#171a21; --card2:#1d212a; --line:#262b36; --ink:#f3f5f8; --dim:#9aa3b2; --faint:#6b7382; --accent:#5b8def; --accent-ink:#ffffff; --up:#3ccf91; --down:#ff6b6b;`
      : `--bg:#f4f5f7; --card:#ffffff; --card2:#f7f8fa; --line:#e6e8ec; --ink:#0f1115; --dim:#5f6775; --faint:#98a0ad; --accent:#2a5bd7; --accent-ink:#ffffff; --up:#1d9a63; --down:#d64545;`
  }
  --ep-green:#00b67a; --ep-deep:#014737; --ep-ink:#050d0a; --ep-dim:#5c6a64; --ep-faint:#98a49e; --ep-line:#e4e7e7; --ep-card2:#f2f4f4;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.phone{max-width:430px;margin:0 auto;min-height:100vh;background:var(--bg);position:relative}
.host-top{padding:14px 16px 8px;display:flex;align-items:center;justify-content:space-between}
.host-top .brand{font-weight:700;font-size:17px;letter-spacing:-.01em;display:flex;align-items:center;gap:8px}
.host-top .brand i{display:inline-block;width:22px;height:22px;border-radius:7px;background:var(--accent)}
.host-top .bal{font-variant-numeric:tabular-nums;font-size:13px;color:var(--dim)}
.tabs{display:flex;gap:18px;padding:0 16px;border-bottom:1px solid var(--line)}
.tabs span{padding:8px 0 10px;font-size:14px;color:var(--faint);font-weight:600}
.tabs span.on{color:var(--ink);border-bottom:2px solid var(--accent)}
.list{padding:8px 12px 120px}
.pos{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 12px 10px;margin:8px 0}
.pos .h{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.pos .name{font-weight:650;font-size:15px;line-height:1.25}
.pos .meta{color:var(--faint);font-size:12px;margin-top:2px}
.pos .pl{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.pos .pl b{display:block;font-size:15px}
.pos .pl.up b{color:var(--up)}.pos .pl.down b{color:var(--down)}
.pos .pl i{font-style:normal;color:var(--faint);font-size:12px}
.pos .f{display:flex;justify-content:space-between;align-items:center;margin-top:10px;gap:10px}
.pos .size{color:var(--dim);font-size:13px;font-variant-numeric:tabular-nums}
.pbtn{appearance:none;border:0;border-radius:999px;padding:7px 13px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;background:var(--ep-green);color:#fff;display:inline-flex;align-items:center;gap:6px;box-shadow:0 1px 0 rgba(0,0,0,.06)}
.pbtn:disabled{opacity:.6;cursor:default}
.pbtn svg{width:13px;height:13px}
.pos.protected{border-color:rgba(0,182,122,.45)}
.pos .shield{display:inline-flex;align-items:center;gap:5px;background:rgba(0,182,122,.12);color:var(--ep-green);font-size:12px;font-weight:700;border-radius:999px;padding:3px 9px}
.pos .terms{margin-top:8px;font-size:13px;color:var(--dim);line-height:1.5;font-variant-numeric:tabular-nums}
.pos .terms b{color:var(--ink);font-weight:650}
.pos .undo{color:var(--faint);font-size:12px;text-decoration:underline;cursor:pointer;background:none;border:0;font:inherit;padding:0;margin-top:4px}
.empty{padding:30px 16px;color:var(--faint);text-align:center;font-size:14px}
.host-note{position:fixed;left:0;right:0;bottom:0;padding:10px 16px 14px;text-align:center;color:var(--faint);font-size:11.5px;line-height:1.45;background:linear-gradient(to top,var(--bg) 70%,transparent);pointer-events:none}
.host-note a{color:var(--dim);pointer-events:auto}
/* ---- the sheet: ours, same in any host ---- */
.scrim{position:fixed;inset:0;background:rgba(5,13,10,.5);opacity:0;pointer-events:none;transition:opacity .18s}
.scrim.on{opacity:1;pointer-events:auto}
.sheet{position:fixed;left:0;right:0;bottom:0;margin:0 auto;max-width:430px;background:#fff;color:var(--ep-ink);border-radius:18px 18px 0 0;padding:10px 16px calc(16px + env(safe-area-inset-bottom));transform:translateY(105%);transition:transform .22s cubic-bezier(.2,.8,.2,1);box-shadow:0 -12px 40px rgba(0,0,0,.18);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.sheet.on{transform:translateY(0)}
.sheet .grab{width:38px;height:4px;border-radius:2px;background:#dfe3e2;margin:0 auto 12px}
.sheet .eyebrow{display:flex;align-items:center;justify-content:space-between;color:var(--ep-faint);font-size:11.5px;letter-spacing:.02em}
.sheet .eyebrow img{height:16px;display:block}
.sheet h2{font-size:19px;font-weight:700;letter-spacing:-.01em;margin-top:8px;color:var(--ep-ink)}
.sheet .who{color:var(--ep-dim);font-size:13.5px;margin-top:2px}
.tiles{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:14px}
.tile{background:var(--ep-card2);border-radius:12px;padding:10px 10px 9px;text-align:left}
.tile .l{color:var(--ep-dim);font-size:11.5px}
.tile .v{font-weight:700;font-size:17px;margin-top:2px;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.tile.k .v{color:var(--ep-green)}
.chips{display:flex;gap:6px;margin-top:12px}
.chip{flex:1;appearance:none;border:1px solid var(--ep-line);background:#fff;border-radius:10px;padding:7px 6px;font:inherit;font-size:12.5px;color:var(--ep-dim);cursor:pointer}
.chip b{display:block;color:var(--ep-ink);font-size:12.5px}
.chip[aria-pressed="true"]{border-color:var(--ep-green);background:rgba(0,182,122,.07)}
.chip[aria-pressed="true"] b{color:var(--ep-green)}
.go{appearance:none;border:0;width:100%;margin-top:14px;border-radius:12px;padding:14px;background:var(--ep-green);color:#fff;font:inherit;font-weight:700;font-size:16px;cursor:pointer}
.go:disabled{opacity:.55;cursor:default}
.go.quiet{background:#fff;color:var(--ep-ink);border:1px solid var(--ep-line)}
.sheet .fine{color:var(--ep-faint);font-size:11.5px;text-align:center;margin-top:9px;line-height:1.45}
.sheet .fine a{color:var(--ep-dim)}
.sheet .refusal{background:var(--ep-card2);border-radius:12px;padding:14px;margin-top:14px;color:var(--ep-ink);font-size:14.5px;line-height:1.5}
.sheet .refusal b{font-weight:700}
.sheet .how{display:none;margin-top:12px;color:var(--ep-dim);font-size:13px;line-height:1.55}
.sheet .how.on{display:block}
.sheet .how p{margin:4px 0}
.sheet .done{text-align:center;padding:10px 0 2px}
.sheet .done .ck{width:52px;height:52px;border-radius:50%;background:rgba(0,182,122,.12);color:var(--ep-green);display:inline-flex;align-items:center;justify-content:center;font-size:26px;font-weight:700}
.sheet .done h2{margin-top:10px}
.sheet .done .sum{margin-top:6px;color:var(--ep-dim);font-size:14px;font-variant-numeric:tabular-nums}
.sheet .done .sum b{color:var(--ep-ink)}
.skel{height:14px;border-radius:7px;background:var(--ep-card2);margin-top:8px;animation:pulse 1.2s infinite}
@keyframes pulse{0%,100%{opacity:.6}50%{opacity:1}}
</style>
</head>
<body>
<div class="phone" id="phone">
  <div class="host-top">
    <div class="brand"><i></i>${brand}</div>
    <div class="bal" id="bal">Cash $0.00</div>
  </div>
  <div class="tabs"><span class="on">Positions</span><span>Markets</span><span>Activity</span></div>
  <div class="list" id="list"><div class="empty" id="loading">loading your positions…</div></div>
  <div class="host-note">This is the host's app, not ours; the green button and the sheet are the integration. Simulated positions at live prices; nothing is bought. <a href="/">The board</a> · <a href="/receipts">Receipts</a></div>
</div>
<div class="scrim" id="scrim"></div>
<div class="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-h">
  <div class="grab"></div>
  <div class="eyebrow"><span>protection by</span><img src="${ATTICUS_LOGO_DATA_URI}" alt="Atticus" /></div>
  <div id="sh-body"></div>
</div>
<script>
(function(){
  'use strict';
  var S={rows:[],byTicker:{},protectedBy:{},open:null,quote:null,tier:'balanced',how:false,cash:0};
  var TIER_ORDER=['tight','balanced','wide'];
  var TIER_WORDS={tight:'Safest',balanced:'Balanced',wide:'Most upside'};
  var SID=(function(){
    try{
      var k='epx_sid',v=sessionStorage.getItem(k);
      if(v&&/^[a-z0-9]{8,32}$/.test(v))return v;
      var a=new Uint8Array(12);(window.crypto||{}).getRandomValues?crypto.getRandomValues(a):a.forEach(function(_,i){a[i]=Math.floor(Math.random()*256)});
      v='';for(var i=0;i<a.length;i++)v+=(a[i]%36).toString(36);
      sessionStorage.setItem(k,v);return v;
    }catch(e){return 'anon'+Math.random().toString(36).slice(2,14)}
  })();
  function track(action,ticker,tier){
    try{
      var body=JSON.stringify({sid:SID,action:action,ticker:ticker||null,tier:tier||null});
      if(navigator.sendBeacon&&navigator.sendBeacon('/api/metrics',new Blob([body],{type:'application/json'})))return;
      fetch('/api/metrics',{method:'POST',body:body,keepalive:true,headers:{'content-type':'application/json'}}).catch(function(){});
    }catch(e){}
  }
  function usd(c){return (c/100).toLocaleString('en-US',{style:'currency',currency:'USD'})}
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
  function el(id){return document.getElementById(id)}
  function fmtEt(iso){
    try{
      var dt=new Date(iso);
      var day=dt.toLocaleDateString('en-US',{weekday:'short',timeZone:'America/New_York'});
      var tm=dt.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}).toLowerCase().replace(' ','');
      return day+' '+tm+' ET';
    }catch(e){return ''}
  }
  function contractsWord(n){return (Math.abs(n-Math.round(n))<1e-9?String(Math.round(n)):n.toFixed(1))}
  /* On a binary contract, floor F / cap C / credit K on n contracts is the same thing as keeping
     n*(C-F)/100 contracts and setting F*n + K aside in cash. The row shows that, because that is
     what the user will actually see in the host's ledger. */
  function reshape(n,F,C,K){return {kept:n*(C-F)/100, cashCents:F*n+K, floorTotal:F*n+K, capTotal:C*n+K}}

  function paintList(){
    var list=el('list');
    if(!S.rows.length){list.innerHTML='<div class="empty">'+esc(S.err||'No open positions to protect right now.')+'</div>';return}
    var html='';
    for(var i=0;i<S.rows.length;i++){
      var r=S.rows[i],p=S.protectedBy[r.kalshiTicker];
      var pl=(r.markCents-r.entryCents)*r.contracts;
      var when=r.kind==='crypto'?'settles '+fmtEt(r.eventTimeIso):fmtEt(r.eventTimeIso);
      html+='<div class="pos'+(p?' protected':'')+'" data-ticker="'+esc(r.kalshiTicker)+'">'+
        '<div class="h"><div><div class="name">'+esc(r.sideName)+'</div><div class="meta">'+esc(r.league.toUpperCase())+' · '+esc(when)+'</div></div>'+
        '<div class="pl '+(pl>0?'up':pl<0?'down':'')+'"><b>'+(pl>=0?'+':'-')+usd(Math.abs(pl))+'</b><i>'+r.markCents+'¢ now</i></div></div>';
      if(p){
        html+='<div class="terms"><b>'+contractsWord(p.kept)+' of '+r.contracts+' contracts</b> kept · <b>'+usd(p.cashCents)+'</b> cash set aside<br>keep at least <b>'+usd(p.floorTotal)+'</b> · up to <b>'+usd(p.capTotal)+'</b></div>'+
          '<div class="f"><span class="shield">&#x2713; Protected</span><button class="undo" data-undo="'+esc(r.kalshiTicker)+'">undo (demo)</button></div>';
      }else{
        html+='<div class="f"><span class="size">'+r.contracts+' contracts · in at '+r.entryCents+'¢</span>'+
          '<button class="pbtn" data-protect="'+esc(r.kalshiTicker)+'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>Protect</button></div>';
      }
      html+='</div>';
    }
    list.innerHTML=html;
    el('bal').textContent='Cash '+usd(S.cash);
  }

  function openSheet(ticker){
    S.open=ticker;S.quote=null;S.how=false;
    el('scrim').className='scrim on';el('sheet').className='sheet on';
    var r=S.byTicker[ticker];
    el('sh-body').innerHTML='<h2 id="sh-h">Protect this position</h2><div class="who">'+esc(r?r.sideName:'')+' · '+(r?r.contracts:'')+' contracts</div><div class="skel"></div><div class="skel" style="width:70%"></div><div class="skel" style="width:40%"></div>';
    track('row_tap',ticker);
    fetch('/api/showcase?ticker='+encodeURIComponent(ticker),{cache:'no-store'}).then(function(x){return x.json()}).then(function(p){
      if(S.open!==ticker)return;
      S.quote=p&&p.quote?p.quote:null;
      if(S.quote&&S.quote.ok&&S.quote.tiers){S.tier=S.quote.tiers.balanced?'balanced':(S.quote.tiers.tight?'tight':'wide')}
      paintSheet(p);
    }).catch(function(){if(S.open===ticker)paintSheet(null)});
  }
  function closeSheet(){S.open=null;el('scrim').className='scrim';el('sheet').className='sheet'}

  function termsFor(q){var t=q.tiers&&q.tiers[S.tier];return t||{floorCents:q.floorCents,capCents:q.capCents,creditCents:q.creditCents}}

  function paintSheet(p){
    var r=S.byTicker[S.open]||{};
    var q=S.quote;
    var body=el('sh-body');
    if(!q||!q.ok){
      var detail=q&&q.detail?q.detail:(p&&p.error?p.error:'Live pricing is unavailable right now.');
      body.innerHTML='<h2 id="sh-h">Protect this position</h2><div class="who">'+esc(r.sideName||'')+'</div>'+
        '<div class="refusal"><b>Not right now.</b> '+esc(detail)+'</div>'+
        '<button class="go quiet" id="sh-close">Close</button>'+
        '<div class="fine">Protection is only offered when the market can fund a credit for it.</div>';
      el('sh-close').onclick=closeSheet;return;
    }
    var n=q.contracts||r.contracts,t=termsFor(q),rs=reshape(n,t.floorCents,t.capCents,t.creditCents);
    var chips='';
    if(q.tiers){
      for(var i=0;i<TIER_ORDER.length;i++){var k=TIER_ORDER[i],tt=q.tiers[k];if(!tt)continue;
        chips+='<button class="chip" data-tier="'+k+'" aria-pressed="'+(k===S.tier)+'"><b>'+TIER_WORDS[k]+'</b>at least '+usd(tt.floorCents*n+tt.creditCents)+'</button>';}
    }
    body.innerHTML='<h2 id="sh-h">Protect this position</h2><div class="who">'+esc(r.sideName||'')+' · '+n+' contracts · '+(r.markCents||q.markCents||'')+'¢ now</div>'+
      '<div class="tiles"><div class="tile"><div class="l">keep at least</div><div class="v">'+usd(rs.floorTotal)+'</div></div>'+
      '<div class="tile k"><div class="l">cash now</div><div class="v">+'+usd(t.creditCents)+'</div></div>'+
      '<div class="tile"><div class="l">up to</div><div class="v">'+usd(rs.capTotal)+'</div></div></div>'+
      (chips?'<div class="chips" id="chips">'+chips+'</div>':'')+
      '<button class="go" id="sh-go">Protect</button>'+
      '<div class="fine">priced live · terms lock at your tap · <a href="#" id="sh-how">how it works</a></div>'+
      '<div class="how" id="how"><p>You keep '+contractsWord(rs.kept)+' of your '+n+' contracts and '+usd(rs.cashCents)+' is set aside in cash, '+usd(t.creditCents)+' of it paid to you now.</p><p>If '+esc(r.sideName||'your side')+' loses you keep '+usd(rs.floorTotal)+' instead of nothing. If it wins you get '+usd(rs.capTotal)+' instead of '+usd(100*n)+'.</p><p>The credit you see is the credit you get. Settles on the same official result as your position.</p></div>';
    var cs=body.querySelectorAll('[data-tier]');
    for(var j=0;j<cs.length;j++)cs[j].onclick=function(){S.tier=this.getAttribute('data-tier');track('tier_pick',S.open,S.tier);paintSheet(p)};
    el('sh-how').onclick=function(e){e.preventDefault();S.how=!S.how;el('how').className='how'+(S.how?' on':'')};
    if(S.how)el('how').className='how on';
    el('sh-go').onclick=function(){confirmProtect(q,n,t)};
  }

  function confirmProtect(q,n,t){
    var ticker=S.open,r=S.byTicker[ticker];
    var rs=reshape(n,t.floorCents,t.capCents,t.creditCents);
    S.protectedBy[ticker]={kept:rs.kept,cashCents:rs.cashCents,floorTotal:rs.floorTotal,capTotal:rs.capTotal,creditCents:t.creditCents,tier:S.tier};
    S.cash+=t.creditCents;
    track('protect_on',ticker,S.tier);
    el('sh-body').innerHTML='<div class="done"><div class="ck">&#x2713;</div><h2 id="sh-h">Protected</h2>'+
      '<div class="sum">'+esc(r?r.sideName:'')+'<br>keep at least <b>'+usd(rs.floorTotal)+'</b> · up to <b>'+usd(rs.capTotal)+'</b><br><b>+'+usd(t.creditCents)+'</b> added to your cash</div></div>'+
      '<button class="go" id="sh-done">Done</button><div class="fine">Nothing to manage. It settles with your position.</div>';
    el('sh-done').onclick=function(){closeSheet();paintList()};
    paintList();
  }

  document.addEventListener('click',function(e){
    var b=e.target.closest?e.target.closest('[data-protect],[data-undo]'):null;
    if(!b)return;
    var t=b.getAttribute('data-protect');
    if(t){openSheet(t);return}
    var u=b.getAttribute('data-undo');
    if(u&&S.protectedBy[u]){S.cash-=S.protectedBy[u].creditCents;delete S.protectedBy[u];track('protect_undo',u);paintList()}
  });
  el('scrim').onclick=closeSheet;

  function load(){
    fetch('/api/showcase',{cache:'no-store'}).then(function(x){return x.json()}).then(function(p){
      var rows=(p&&p.board)||[];
      S.rows=rows;S.byTicker={};
      for(var i=0;i<rows.length;i++)S.byTicker[rows[i].kalshiTicker]=rows[i];
      S.err=rows.length?null:(p&&p.error)||null;
      paintList();
    }).catch(function(){S.rows=[];S.err='Positions are unavailable right now.';paintList()});
  }
  load();
  setInterval(function(){if(!S.open)load()},60000);
})();
</script>
</body>
</html>`;
}

export interface PartnerConsoleInput {
  atIso: string;
  brand: string;
  ledger: CrossLedgerSummary;
  funnel: EventFunnelSummary;
  /** the partner's share of the published take, percent */
  sharePct: number;
  maxEvCostBps: number;
}

const usd = (c: number): string => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (bps: number | null, digits = 2): string => (bps === null ? "–" : `${(bps / 100).toFixed(digits)}%`);

/** Public words for a hedge route, for the partner: on their book or off it. */
const PARTNER_ROUTE_WORDS: Record<string, string> = {
  kalshi_self: "priced on the market's own No side",
  polymarket: "priced cross-venue on the same game",
};

const PARTNER_REFUSAL_WORDS: Record<string, string> = {
  credit_nonpositive: "the market could not fund a credit",
  protection_too_rich: "protection would have cost more than our ceiling",
  pm_book_empty: "no depth to hedge",
  pm_book_too_thin: "not enough depth for the size",
  kalshi_book_empty: "no depth on the market's No side",
  kalshi_book_too_thin: "not enough depth on the market's No side",
  market_too_close_to_start: "too close to the start",
  mark_out_of_range: "odds outside the range we protect",
  no_matched_market: "no verified pairing",
  resolution_mismatch: "settlement rules did not match",
};

/**
 * PARTNER CONSOLE — what a host sees about the layer running on their users.
 * Volume protected, credits paid to their users, what the protection cost,
 * how much of it was priced on their own book, what was refused and why, and
 * their share of the take. Operator token only: it names our take.
 */
export function renderPartnerHtml(input: PartnerConsoleInput): string {
  const l = input.ledger;
  const f = input.funnel;
  const total = l.priced + l.refused;
  const fill = total > 0 ? `${Math.round((l.priced / total) * 100)}%` : "–";
  const partnerShareCents = Math.round((l.takeKeptCents * input.sharePct) / 100);
  const ownBook = l.routeSplit.kalshi_self ?? 0;
  const ownPct = l.priced > 0 ? `${Math.round((ownBook / l.priced) * 100)}%` : "–";
  const routeRows = Object.entries(l.routeSplit)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `<div class="row"><span>${escapeHtml(PARTNER_ROUTE_WORDS[r] ?? r)}</span><b>${n}</b></div>`)
    .join("");
  const refusalRows = Object.entries(l.refusalsByCode)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `<div class="row"><span>${escapeHtml(PARTNER_REFUSAL_WORDS[c] ?? c.replace(/_/g, " "))}</span><b>${n}</b></div>`)
    .join("");
  const tierRows = Object.entries(f.protects.byTier)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `<div class="row"><span>${escapeHtml(t)}</span><b>${n}</b></div>`)
    .join("");
  const embedLoads = f.pageLoads7d.reduce((n, d) => n + (d.byPage.embed ?? 0), 0);
  const period = l.firstAt ? `${l.firstAt.slice(0, 10)} to ${l.lastAt?.slice(0, 10) ?? l.firstAt.slice(0, 10)} UTC` : "no quotes recorded yet";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<link rel="icon" href="data:," />
<title>Partner console · ${escapeHtml(input.brand)} · Earn &amp; Protect</title>
<style>
:root{--bg:#f6f7f7;--card:#fff;--card2:#f2f4f4;--line:#e4e7e7;--ink:#050d0a;--dim:#5c6a64;--faint:#98a49e;--green:#00b67a;--deep:#014737}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;min-height:100vh}
.topbar{background:#050d0a}.topbar .in{max-width:640px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:10px 16px}
.topbar .wordmark{color:#fff;font-weight:650;font-size:14px}.topbar .wordmark span{color:#8f9c96;font-weight:400}
.topbar img{height:22px;display:block}
.wrap{max-width:640px;margin:0 auto;padding:14px 14px 40px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-bottom:12px}
h1{font-size:20px;font-weight:700;letter-spacing:-.01em}h2{font-size:14px;font-weight:700;margin-bottom:6px}
.sub{color:var(--dim);font-size:13px;line-height:1.5;margin-top:4px}
.bignums{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:12px}
@media(min-width:520px){.bignums{grid-template-columns:repeat(4,1fr)}}
.bignum{background:var(--card2);border-radius:12px;padding:10px 12px}
.bignum .n{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.01em}.bignum .n.green{color:var(--green)}
.bignum .l{color:var(--dim);font-size:11.5px;margin-top:2px}
.row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid var(--line);font-size:13.5px}
.row:last-child{border-bottom:0}.row span{color:var(--dim)}.row b{font-weight:650;font-variant-numeric:tabular-nums;text-align:right}
.row b i{font-style:normal;color:var(--faint);font-weight:400;font-size:12px}
.period{color:var(--dim);font-size:12px;margin-top:10px}
.rule{color:var(--faint);font-size:11.5px;margin-top:8px;line-height:1.45}
a{color:var(--dim)}
</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="wordmark">Earn &amp; Protect <span>· partner console · ${escapeHtml(input.brand)}</span></div>
  <img src="${ATTICUS_LOGO_DATA_URI}" alt="Atticus" />
</div></div>
<div class="wrap">
  <div class="card">
    <h1>The layer on your users' positions</h1>
    <div class="sub">Every quote the layer wrote for positions on your board, what it paid your users, what it cost them in expected value, and your share. Quotes are live; positions are simulated until the integration is on.</div>
    <div class="bignums">
      <div class="bignum"><div class="n">${usd(l.stakeQuotedCents)}</div><div class="l">volume protected</div></div>
      <div class="bignum"><div class="n green">${usd(l.creditsSourcedCents)}</div><div class="l">credits paid to your users</div></div>
      <div class="bignum"><div class="n">${escapeHtml(pct(l.avgEvCostBps))}</div><div class="l">average cost of protection</div></div>
      <div class="bignum"><div class="n green">${usd(partnerShareCents)}</div><div class="l">your share (${input.sharePct}% of take)</div></div>
    </div>
    <div class="period">${escapeHtml(period)}</div>
  </div>
  <div class="card">
    <h2>Quotes</h2>
    <div class="row"><span>priced</span><b>${l.priced} <i>of ${total} · ${fill} fill</i></b></div>
    <div class="row"><span>priced on your own book</span><b>${ownBook} <i>${ownPct}</i></b></div>
    ${routeRows}
    <div class="row"><span>ceiling on cost of protection</span><b>${escapeHtml(pct(input.maxEvCostBps))} <i>of expected value</i></b></div>
    <div class="rule">Above the ceiling the layer refuses rather than quotes rich insurance; refusals are counted, not hidden.</div>
  </div>
  <div class="card">
    <h2>Refused, and why</h2>
    ${refusalRows || '<div class="row"><span>nothing refused yet</span><b>–</b></div>'}
  </div>
  <div class="card">
    <h2>Your users</h2>
    <div class="row"><span>Protect taps (all pages)</span><b>${f.protects.total} <i>${f.protects.last7d} in 7 days</i></b></div>
    <div class="row"><span>credits on those taps</span><b>${usd(f.protects.creditCentsTotal)}</b></div>
    <div class="row"><span>contracts protected on those taps</span><b>${f.protects.contractsTotal}</b></div>
    <div class="row"><span>embedded shell loads, 7 days</span><b>${embedLoads}</b></div>
    ${tierRows ? `<div class="rule" style="margin-top:10px">Protection tier chosen</div>${tierRows}` : ""}
  </div>
  <div class="card">
    <h2>Integration</h2>
    <div class="row"><span>mode</span><b>quote-only <i>we hedge, you settle</i></b></div>
    <div class="row"><span>surface</span><b>one button per position row</b></div>
    <div class="row"><span>settlement</span><b>your official result, same as the position</b></div>
    <div class="row"><span>revenue share</span><b>${input.sharePct}% of the published take</b></div>
    <div class="rule">The published take is already netted out of every credit shown to a user: the credit they see is the credit they get. <a href="/embed">See the embedded shell</a> · <a href="/receipts">Receipts</a></div>
  </div>
</div>
</body>
</html>`;
}
