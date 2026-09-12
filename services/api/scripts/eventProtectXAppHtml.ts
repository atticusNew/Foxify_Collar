/**
 * Earn & Protect - events, cross-venue (Tier 2): the showcase page.
 *
 * Same surface grammar as the Tier 1 event page (light Kalshi-native theme,
 * total-dollars hero, one-tap toggle, one disclosure), but the hedge is the
 * SAME GAME on another venue: the drawer shows both listings, the resolution
 * parity note, and the opposing-outcome shares bought on Polymarket.
 *
 * Everything financial is quoted live by the server from both venues' public
 * books; the position and lifecycle are simulated and labeled.
 */

import { ATTICUS_LOGO_DATA_URI } from "./eventProtectLogo";
import type { CrossLedgerSummary } from "../src/eventCollar/crossVenue/crossLedger";

export function renderEventXAppHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:," />
<title>Earn &amp; Protect · events</title>
<meta name="description" content="One tap turns an all-or-nothing event position into a guaranteed floor, a cap, and a cash credit. Games and crypto on one board, each priced on every hedge route that is structurally safe for it. Demonstration with live pricing from Kalshi and Polymarket." />
<meta property="og:title" content="Earn &amp; Protect · events" />
<meta property="og:description" content="The derivatives layer for event markets: a one-tap floor on a Kalshi position, games and crypto, hedged on the cheapest safe route. Demonstration, live venue pricing." />
<meta property="og:type" content="website" />
<style>
:root{
  --bg:#f6f7f7; --card:#ffffff; --card2:#f2f4f4; --line:#e4e7e7;
  --ink:#050d0a; --dim:#5c6a64; --faint:#98a49e;
  --green:#00b67a; --green-deep:#014737; --green-wash:#e9f8f2;
  --loss:#d64545; --warn:#b9862f; --warn-wash:#fbf4e6;
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;min-height:100vh}
.topbar{background:#050d0a}
.topbar .in{max-width:430px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:10px 16px}
.topbar .wordmark{color:#fff;font-weight:650;font-size:14px;letter-spacing:.01em}
.topbar .wordmark span{color:#8f9c96;font-weight:400}
.topbar img{height:22px;display:block}
.wrap{max-width:430px;margin:0 auto;padding:14px 14px 40px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:12px;box-shadow:0 1px 2px rgba(5,13,10,.04)}
.eyebrow{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dim);margin-bottom:8px;flex-wrap:wrap;row-gap:5px}
.eyebrow #eyeline{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.dot{width:7px;height:7px;border-radius:50%;background:var(--green);animation:pulse 2s infinite;flex:none}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.simlabel{margin-left:auto;font-size:9.5px;letter-spacing:.07em;color:var(--faint);border:1px solid var(--line);border-radius:99px;padding:3px 8px;text-transform:uppercase;white-space:nowrap}
h1{font-size:19px;line-height:1.3;font-weight:650;letter-spacing:-.01em}
.matchline{color:var(--dim);font-size:13px;margin-top:3px}
.chancerow{display:flex;align-items:baseline;gap:8px;margin:10px 0 0}
.chance{font-size:36px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--green);letter-spacing:-.02em}
.chancelbl{color:var(--dim);font-size:13px}
.countd{margin-left:auto;color:var(--dim);font-size:12px;text-align:right;font-variant-numeric:tabular-nums}
.settleline{color:var(--faint);font-size:12px;margin-top:2px}
.whyline{color:var(--green-deep);font-size:11.5px;margin-top:6px;font-weight:600}
.pos{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}
.pos .side{font-weight:650;font-size:15px}
.pos .side .yes{color:var(--green-deep);background:var(--green-wash);border-radius:6px;padding:1px 7px;margin-right:6px;font-size:13px;font-weight:700}
.pos .sub{color:var(--faint);font-size:11.5px;margin-top:3px}
.pos .val{text-align:right;font-variant-numeric:tabular-nums}
.pos .val .v{font-weight:650;font-size:15px}
.pos .val .pnl{font-size:12.5px;margin-top:3px;font-weight:600}
.pnl.gain{color:var(--green)}
.pnl.loss{color:var(--loss)}
.protect{margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}
.hero{text-align:center;padding:2px 0 4px}
.hero .lbl{color:var(--dim);font-size:13px}
.hero .min{font-size:40px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--green);letter-spacing:-.02em;margin:2px 0}
.hero .sweet{color:var(--dim);font-size:13px}
.hero .sweet b{color:var(--ink);font-weight:650}
.togglerow{display:flex;justify-content:space-between;align-items:center;margin-top:14px}
.togglerow .t{font-weight:650}
.togglerow .d{color:var(--faint);font-size:12px;margin-top:2px}
.switch{position:relative;width:52px;height:30px;flex:none}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;inset:0;background:#d8dedb;border-radius:99px;cursor:pointer;transition:.25s}
.slider:before{content:"";position:absolute;left:3px;top:3px;width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(5,13,10,.25);transition:.25s}
input:checked + .slider{background:var(--green)}
input:checked + .slider:before{transform:translateX(22px)}
input:disabled + .slider{opacity:.45;cursor:default}
.protectedline{display:none;margin-top:12px;background:var(--green-wash);border:1px solid #cdeee0;border-radius:10px;padding:11px 13px;font-size:14px;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.protectedline.show{display:flex}
.protectedline b{color:var(--green-deep);font-weight:650}
.undo{background:#fff;border:1px solid var(--green);color:var(--green-deep);border-radius:9px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;min-width:72px}
.hedge{margin-top:10px}
.hedge summary{cursor:pointer;color:var(--dim);font-size:13px;padding:7px 0;list-style:none}
.hedge summary::before{content:"\\25B8";margin-right:6px;font-size:11px}
.hedge[open] summary::before{content:"\\25BE"}
.legs{background:var(--card2);border-radius:10px;padding:6px 12px;font-size:12px;color:var(--dim)}
.legs .row{display:block;padding:7px 0;font-variant-numeric:tabular-nums;border-top:1px solid var(--line)}
.legs .row:first-child{border-top:0}
.legs .row span{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--faint)}
.legs .row b{display:block;color:var(--ink);font-weight:600;margin-top:2px;font-size:12.5px;line-height:1.45;overflow-wrap:anywhere}
.refusal{display:none;margin-top:12px;background:var(--warn-wash);border-left:3px solid var(--warn);border-radius:8px;padding:11px 13px;font-size:13px;color:var(--dim)}
.refusal.show{display:block}
.refusal b{color:var(--ink)}
.ticket{display:none;margin-top:12px;background:var(--card2);border:1px solid var(--line);border-radius:12px;padding:14px}
.ticket.show{display:block}
.ticket h3{font-size:12px;color:var(--dim);font-weight:600;margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em}
.ticket .row{display:flex;justify-content:space-between;padding:4px 0;font-variant-numeric:tabular-nums;font-size:14px}
.ticket .row .k{color:var(--dim)}
.ticket .total{border-top:1px solid var(--line);margin-top:6px;padding-top:8px;font-weight:700}
.how summary{cursor:pointer;color:var(--dim);font-size:13px;padding:8px 0}
.how li{margin:7px 0 7px 18px;color:var(--dim);font-size:13px}
.how li b{color:var(--ink);font-weight:600}
footer{color:var(--faint);font-size:11.5px;line-height:1.55;padding:14px 4px 0}
footer b{color:var(--dim);font-weight:600}
.err{color:var(--loss);font-size:13px;padding:8px 2px;display:none}
.err.show{display:block}
.refreshed{color:var(--faint);font-size:11px;text-align:right;margin-top:10px;font-variant-numeric:tabular-nums}
.board .bt{font-weight:650;font-size:15px}
.board .bs{color:var(--faint);font-size:12px;margin-top:2px}
.brow{display:block;padding:11px 0;border-top:1px solid var(--line);cursor:pointer;-webkit-tap-highlight-color:transparent}
.brow:active{background:var(--card2)}
#boardrows .brow:first-child{margin-top:10px}
.brow .btop{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.brow .g{font-weight:600;font-size:13.5px;min-width:0}
.brow .g .lg{color:var(--faint);font-weight:500;font-size:10.5px;margin-left:6px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
.brow .g .now{color:var(--green-deep);background:var(--green-wash);font-size:10.5px;border-radius:5px;padding:1px 6px;margin-left:6px;font-weight:650;white-space:nowrap}
.brow .m{color:var(--faint);font-size:11.5px;margin-top:3px}
.brow .rv{text-align:right;font-variant-numeric:tabular-nums;flex:none}
.brow .gr{font-size:13.5px;font-weight:700;white-space:nowrap}
.gr.good{color:var(--green)}
.gr.fair{color:var(--dim)}
.gr.rich{color:var(--warn)}
.brow .ev{font-size:11.5px;margin-top:2px;font-weight:600;white-space:nowrap}
.ev.good{color:var(--green)}
.ev.fair{color:var(--dim)}
.ev.rich{color:var(--warn)}
.boardmore{display:block;width:100%;margin-top:10px;background:var(--card2);border:1px solid var(--line);color:var(--dim);border-radius:9px;padding:9px;font-size:13px;font-weight:600;cursor:pointer}
.boardmore:active{background:var(--line)}
footer a{color:var(--dim);font-weight:600;text-decoration:underline}
.loading{display:flex;flex-direction:column;align-items:center;gap:12px;padding:34px 0 30px;color:var(--dim);font-size:13px;text-align:center}
.loading .note{color:var(--faint);font-size:12px}
.spinner{width:26px;height:26px;border-radius:50%;border:3px solid var(--green-wash);border-top-color:var(--green);animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media(min-width:700px){.wrap,.topbar .in{max-width:480px}}
</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="wordmark">Earn &amp; Protect <span>· events</span></div>
  <img src="${ATTICUS_LOGO_DATA_URI}" alt="Atticus" />
</div></div>
<div class="wrap">
  <div class="card" id="hero">
    <div class="eyebrow"><span class="dot"></span><span id="eyeline">Kalshi + Polymarket</span><span class="simlabel">simulation · live pricing</span></div>
    <div class="loading" id="loading">
      <div class="spinner"></div>
      <div>scanning games and crypto across Kalshi and Polymarket…</div>
    </div>
    <div id="main" style="display:none">
    <h1 id="title">&nbsp;</h1>
    <div class="matchline" id="matchline">&nbsp;</div>
    <div class="chancerow">
      <span class="chance" id="chance">–</span>
      <span class="chancelbl">chance</span>
      <span class="countd" id="countd">–</span>
    </div>
    <div class="whyline" id="whyline">&nbsp;</div>

    <div class="pos">
      <div>
        <div class="side"><span class="yes">Yes</span><span id="poscount">–</span></div>
        <div class="sub" id="possub">&nbsp;</div>
      </div>
      <div class="val">
        <div class="v" id="posval">–</div>
        <div class="pnl" id="pospnl">&nbsp;</div>
      </div>
    </div>

    <div class="protect">
      <div class="hero" id="offer" style="display:none">
        <div class="lbl">guaranteed minimum</div>
        <div class="min" id="minout">–</div>
        <div class="sweet">up to <b id="maxout">–</b> · <b id="creditout">–</b> credit either way</div>
      </div>

      <div class="togglerow">
        <div><div class="t">Protect this position</div><div class="d" id="toggledesc">one tap</div></div>
        <label class="switch"><input type="checkbox" id="toggle" disabled /><span class="slider"></span></label>
      </div>

      <div class="protectedline" id="protectedline"><span>Protected · <b id="paysline">payout when the game settles</b></span><button type="button" class="undo" id="undo">undo</button></div>

      <div class="refusal" id="refusal"></div>

      <details class="hedge" id="hedge" style="display:none">
        <summary>see the hedge</summary>
        <div class="legs" id="legs"></div>
      </details>

      <div class="ticket" id="ticket"></div>
    </div>
    <div class="refreshed" id="refreshed">&nbsp;</div>
    </div>
  </div>

  <div class="card board" id="boardcard" style="display:none">
    <div class="bt">Best protection right now</div>
    <div class="bs">ranked by true cost · tap to load</div>
    <div id="boardrows"></div>
  </div>

  <div class="card how">
    <details>
      <summary>How this works</summary>
      <ul>
        <li><b>Real markets, competing hedge routes.</b> Every event and its prices are live from Kalshi's and Polymarket's public data. Each protection is priced at executable depth on every route that is structurally safe for it: the same game's opposing side on Polymarket, and the protected market's own No side on Kalshi. You get the cheapest one.</li>
        <li><b>Crypto quotes one route on purpose.</b> The venues settle crypto on different index feeds, so a cross-venue hedge would not be the same trade; crypto strike markets therefore quote only the self-hedge route, and the board says so.</li>
        <li><b>The trade you are making.</b> You give up the top slice of your win to guarantee you never leave empty-handed. The market prices that downside risk; when a route prices it cheaper than the cap slice you sold, the difference is your credit.</li>
        <li><b>The hedge is the same game.</b> Protection is backed by buying the side that pays exactly when yours loses - on the other venue or on the very same market. Cross-venue pairs quote only from a curated whitelist where both venues verifiably settle on the identical official result; the self-hedge route is the same instrument by construction.</li>
        <li><b>Honest economics.</b> We keep a published share of the credit we source, waived when tiny. Nothing is embedded in your terms. When the venues cannot fund a credit, we refuse and say why.</li>
        <li><b>Undo is free only here.</b> Nothing is bought in this simulation, so undo simply resets it. In the real product, terms lock at your tap and the hedge is placed immediately; unwinding early would be a new trade quoted from the live books at that moment, never a free reversal.</li>
        <li><b>Read only.</b> This demonstration holds no keys or wallets, places no orders (hedge fills are simulated at live quotes), and cannot move funds.</li>
      </ul>
    </details>
  </div>

  <div class="err" id="err"></div>

  <footer>
    <b>Demonstration, not an offer.</b> Positions are simulated; prices and hedge quotes are live from both venues. Event contracts involve risk. US availability requires a regulated deployment path; that work is underway. Nothing here is investment advice. <a href="/receipts">See the receipts</a>.
  </footer>
</div>

<script>
(function(){
  var S={payload:null,phase:'idle',terms:null,pairKey:null,startIso:null,kind:'sports',fetchedAt:0,sel:null,boardOpen:false};
  var $=function(id){return document.getElementById(id)};
  function usd(c){return (c/100).toLocaleString('en-US',{style:'currency',currency:'USD'})}
  function shares(milli){var s=milli/1000;return (Math.round(s*10)/10).toLocaleString('en-US')}
  function centsFromMilli(m){return (Math.round(m/10*10)/10)/1}

  function fmtCountdown(iso){
    var ms=new Date(iso).getTime()-Date.now();
    if(ms<=0)return 'now';
    var s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60),d=Math.floor(h/24);
    if(d>0)return d+'d '+(h%24)+'h';
    if(h>0)return h+'h '+(m%60)+'m';
    return m+'m '+(s%60)+'s';
  }
  function inPlay(){
    return S.startIso&&new Date(S.startIso).getTime()<=Date.now();
  }
  function countdLabel(){
    if(S.kind==='crypto')return inPlay()?'settling':'settles in '+fmtCountdown(S.startIso);
    return inPlay()?'in play':'starts in '+fmtCountdown(S.startIso);
  }
  function tick(){
    if(S.startIso){
      $('countd').textContent=countdLabel();
    }
    if(S.fetchedAt){
      var age=Math.max(0,Math.round((Date.now()-S.fetchedAt)/1000));
      $('refreshed').textContent=age<2?'quotes refreshed just now':'quotes refreshed '+age+'s ago';
    }
  }
  function fmtEt(iso){
    try{
      var dt=new Date(iso);
      var day=dt.toLocaleDateString('en-US',{weekday:'short',timeZone:'America/New_York'});
      var tm=dt.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}).toLowerCase().replace(' ','');
      return day+' '+tm+' ET';
    }catch(e){return 'game time'}
  }

  function outcomeTotals(t){
    return {
      yes: t.capCents*t.contracts + t.creditCents,
      no: t.floorCents*t.contracts + t.creditCents,
      nakedYes: 100*t.contracts,
      nakedNo: 0
    };
  }

  function evCostBps(mark,floor,cap,credit,n){
    var naked=100*n*mark;
    if(naked<=0)return 0;
    var prot=(cap*n+credit)*mark+(floor*n+credit)*(100-mark);
    return Math.round((naked-prot)*10000/naked);
  }
  function evLine(bps){
    var pct=Math.abs(bps/100).toFixed(1);
    return bps<0?('pays '+pct+'% above expected value'):('costs '+pct+'% of expected value');
  }
  function evShort(bps){
    var pct=Math.abs(bps/100).toFixed(1);
    return bps<0?('pays '+pct+'%'):('costs '+pct+'%');
  }
  function evClass(bps){
    return bps<500?'good':(bps<=1500?'fair':'rich');
  }
  function gradeWord(bps){
    if(bps<0)return 'pays you';
    return bps<500?'cheap':(bps<=1500?'fair':'rich');
  }
  function routeName(r){
    return r==='kalshi_self'?'Kalshi':'Polymarket';
  }
  function routesLine(p){
    var rc=p.routesChecked||[];
    if(!rc.length)return '';
    var parts=[];
    for(var i=0;i<rc.length;i++){
      var r=rc[i];
      var nm=r.route==='kalshi_self'?'Kalshi self-hedge':'Polymarket';
      var v;
      if(r.ok){ v=Math.abs(r.evCostBps/100).toFixed(1)+'%'+(r.evCostBps<0?' rebate':''); }
      else if(r.detail&&r.detail.indexOf('not offered')===0){ v='not offered'; }
      else { v='no quote'; }
      parts.push(nm+' '+v);
    }
    return parts.join(' · ')+' · cheapest safe route wins';
  }

  function paintOffer(q){
    var p=S.payload,pr=p.pair,pos=p.position;
    var o=outcomeTotals(q);
    $('minout').textContent=usd(o.no);
    $('maxout').textContent=usd(o.yes);
    $('creditout').textContent=usd(q.creditCents);
    $('offer').style.display='block';
    var takeLine=q.takeWaived?'take waived (de minimis)':(usd(q.takeCents)+' ('+(q.takeBps/100)+'% of credit sourced)');
    var parityShort=(q.parityNote||pr.parityNote||'').split(';')[0];
    var selfHedge=p.route==='kalshi_self';
    var gapRow='';
    if(!selfHedge&&pr.pmYesPriceMilli>0){
      var pmYes=centsFromMilli(pr.pmYesPriceMilli);
      gapRow='<div class="row"><span>same game, two prices</span><b>Kalshi '+q.markCents+'\\u00A2 · Polymarket '+pmYes+'\\u00A2 · the gap funds your credit</b></div>';
    }
    var entryTag=pos.entrySource==='real_print'?' (real print)':'';
    var buyRow=selfHedge
      ?('<div class="row"><span>the hedge</span><b>buy '+shares(q.hedge.contractsMilli)+' No contracts @ avg '+q.hedge.avgPriceCents+'\\u00A2 · Kalshi, same market</b></div>')
      :('<div class="row"><span>the hedge</span><b>buy '+shares(q.hedge.sharesMilli)+' '+q.hedge.outcome+' shares @ avg '+centsFromMilli(q.hedge.avgPriceMilli)+'\\u00A2 · Polymarket</b></div>');
    var routesRow=routesLine(p);
    $('legs').innerHTML=
      '<div class="row"><span>same result</span><b>'+parityShort+'</b></div>'+
      gapRow+
      '<div class="row"><span>per contract</span><b>in at '+pos.entryCents+'\\u00A2'+entryTag+' · now '+q.markCents+'\\u00A2 · floor '+q.floorCents+'\\u00A2 · cap '+q.capCents+'\\u00A2</b></div>'+
      '<div class="row"><span>without protection</span><b>'+usd(o.nakedYes)+' if Yes · '+usd(o.nakedNo)+' if No</b></div>'+
      '<div class="row"><span>with protection</span><b>'+usd(o.yes)+' if Yes · '+usd(o.no)+' if No</b></div>'+
      buyRow+
      '<div class="row"><span>hedge cost</span><b>'+usd(q.hedge.costCents)+' · fees '+usd(q.feesCents)+'</b></div>'+
      '<div class="row"><span>our take</span><b>'+takeLine+'</b></div>'+
      '<div class="row"><span>cost of protection</span><b>'+evLine(evCostBps(q.markCents,q.floorCents,q.capCents,q.creditCents,q.contracts))+'</b></div>'+
      (routesRow?('<div class="row"><span>routes checked</span><b>'+routesRow+'</b></div>'):'');
    $('hedge').style.display='block';
  }

  function hideOffer(){
    $('offer').style.display='none';
    $('hedge').style.display='none';
  }

  function render(){
    var p=S.payload; if(!p)return;
    $('err').classList.remove('show');
    $('loading').style.display='none';
    if(!p.ok||!p.pair){ $('eyeline').textContent=p.error||'no whitelisted pair quotable right now'; $('main').style.display='none'; $('boardcard').style.display='none'; return; }
    $('main').style.display='block';
    var pr=p.pair,pos=p.position,q=p.quote;
    if(S.sel&&pr.kalshiTicker!==S.sel){ S.sel=null; }
    var key=pr.kalshiTicker;
    if(S.pairKey&&S.pairKey!==key&&S.phase!=='idle'){ resetSim(); }
    S.pairKey=key;
    S.kind=pr.kind||'sports';
    var crypto=S.kind==='crypto';

    $('eyeline').textContent=crypto?'Kalshi':'Kalshi + Polymarket';
    $('title').textContent=(pr.sideName||pr.kalshiSide)+(crypto?'?':' to win?');
    $('matchline').textContent=(crypto?'':(pr.opponent?('vs. '+pr.opponent+' · '):''))+pr.league.toUpperCase()+' · '+(crypto?'settles ':'')+fmtEt(pr.eventTimeIso);
    $('chance').textContent=pr.markCents+'%';
    S.startIso=pr.eventTimeIso;
    $('countd').textContent=countdLabel();
    if(q&&q.ok&&p.route){
      $('whyline').textContent=(S.sel?'your pick':'best value right now')+' · via '+routeName(p.route);
    } else {
      $('whyline').innerHTML='&nbsp;';
    }

    var val=pr.markCents*pos.contracts, cost=pos.entryCents*pos.contracts, pnl=val-cost;
    $('poscount').textContent=pos.contracts+' contracts';
    $('possub').textContent='avg '+pos.entryCents+'\\u00A2 · simulated';
    $('posval').textContent=usd(val);
    var pe=$('pospnl');
    pe.textContent=(pnl>=0?'+':'')+usd(pnl);
    pe.className='pnl '+(pnl>=0?'gain':'loss');

    var t=$('toggle');
    if(S.phase==='idle'){
      if(inPlay()){
        t.disabled=true; t.checked=false;
        hideOffer();
        $('refusal').innerHTML=S.kind==='crypto'
          ?'<b>At the close.</b> Protection locks before this market settles; the position now rides to the official index print.'
          :'<b>In play.</b> Protection locks before the game starts; the position now rides to the final score.';
        $('refusal').classList.add('show');
      } else if(q&&q.ok){
        t.disabled=false;
        $('refusal').classList.remove('show');
        paintOffer(q); // the live offer is visible BEFORE the flip
        $('toggledesc').textContent='one tap';
      } else if(q){
        t.disabled=true; t.checked=false;
        hideOffer();
        $('refusal').innerHTML='<b>Not quotable right now.</b> '+q.detail+' Refusing honestly beats mispricing.';
        $('refusal').classList.add('show');
      }
    }
    if(S.phase==='protected'&&S.terms&&inPlay()){
      $('toggledesc').textContent='in play · terms locked';
    }

    renderBoard(p);
  }

  function renderBoard(p){
    var b=p.board||[];
    if(!b.length){ $('boardcard').style.display='none'; return; }
    var LIMIT=3;
    var expanded=!!S.boardOpen||b.length<=LIMIT;
    var shown=expanded?b:b.slice(0,LIMIT);
    var html='';
    for(var i=0;i<shown.length;i++){
      var r=shown[i];
      var chip=(p.pair&&r.kalshiTicker===p.pair.kalshiTicker)?'<span class="now">showing</span>':'';
      var rowTitle=(r.sideName||r.kalshiSide)+(r.kind==='crypto'?'?':' to win?');
      html+='<div class="brow" data-ticker="'+r.kalshiTicker+'">'+
        '<div class="btop"><div class="g">'+rowTitle+'<span class="lg">'+r.league.toUpperCase()+'</span>'+chip+'</div>'+
        '<div class="rv"><div class="gr '+evClass(r.evCostBps)+'">'+gradeWord(r.evCostBps)+'</div>'+
        '<div class="ev '+evClass(r.evCostBps)+'">'+evShort(r.evCostBps)+'</div></div></div>'+
        '<div class="m">'+fmtEt(r.eventTimeIso)+' · '+r.markCents+'% · '+usd(r.creditCents)+' credit · via '+routeName(r.route)+'</div>'+
        '</div>';
    }
    if(b.length>LIMIT){
      html+='<button type="button" class="boardmore" id="boardmore">'+
        (S.boardOpen?'show fewer games':('show all '+b.length+' games'))+'</button>';
    }
    $('boardrows').innerHTML=html;
    $('boardcard').style.display='block';
  }

  function resetSim(){
    S.phase='idle';S.terms=null;
    $('toggle').checked=false;
    $('protectedline').classList.remove('show');
    $('ticket').classList.remove('show');
    $('toggledesc').textContent='one tap';
    render();
  }

  $('toggle').addEventListener('change',function(e){
    if(!e.target.checked){ resetSim(); return; }
    var q=S.payload&&S.payload.quote;
    if(!(q&&q.ok)){ e.target.checked=false; return; }
    // one tap: the visible offer becomes the locked terms immediately
    S.phase='protected'; S.terms=q;
    paintOffer(q);
    var ot=outcomeTotals(q);
    $('paysline').textContent='guaranteed '+usd(ot.no)+' to '+usd(ot.yes);
    $('protectedline').classList.add('show');
    $('toggledesc').textContent='terms locked at your tap';
  });

  document.addEventListener('click',function(ev){
    var el=ev.target;
    while(el&&el!==document){
      if(el.id==='undo'){ ev.preventDefault(); resetSim(); return; }
      if(el.id==='boardmore'){ ev.preventDefault(); S.boardOpen=!S.boardOpen; if(S.payload)renderBoard(S.payload); return; }
      if(el.getAttribute&&el.getAttribute('data-ticker')){
        var t=el.getAttribute('data-ticker');
        if(S.payload&&S.payload.pair&&S.payload.pair.kalshiTicker===t)return;
        S.sel=t; poll();
        try{window.scrollTo({top:0,behavior:'smooth'})}catch(e){window.scrollTo(0,0)}
        return;
      }
      el=el.parentNode;
    }
  });

  function poll(){
    var u='/api/showcase'+(S.sel?('?ticker='+encodeURIComponent(S.sel)):'');
    fetch(u).then(function(r){return r.json()}).then(function(p){
      S.payload=p; S.fetchedAt=Date.now(); render();
    }).catch(function(){
      $('err').textContent='live feed unreachable; retrying…';
      $('err').classList.add('show');
    });
  }
  poll(); setInterval(poll,10000); setInterval(render,30000); setInterval(tick,1000);
})();
</script>
</body>
</html>`;
}

const REFUSAL_LABELS: Record<string, string> = {
  credit_nonpositive: "the venues could not fund a positive credit",
  market_too_close_to_start: "the game was too close to starting",
  mark_out_of_range: "the odds were outside the quotable band",
  pm_book_empty: "no executable depth on the Polymarket book",
  pm_book_too_thin: "the Polymarket book was too thin for the size",
  kalshi_book_empty: "no executable depth on the market's No side",
  kalshi_book_too_thin: "the market's No side was too thin for the size",
  no_matched_market: "no verified same-game listing on the other venue",
  resolution_mismatch: "the venues' settlement rules did not verifiably match",
};

function usdFromCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The public receipts page: the quote ledger aggregated into a plain-spoken
 * scorecard. Every number is recomputed from the JSONL ledger on each request;
 * nothing is stored or editable, which is the point.
 */
export function renderReceiptsHtml(s: CrossLedgerSummary): string {
  const avgLine =
    s.avgEvCostBps === null
      ? "not yet recorded"
      : s.avgEvCostBps < 0
        ? `${Math.abs(s.avgEvCostBps / 100).toFixed(1)}% BETTER than the naked position, on average`
        : `${(s.avgEvCostBps / 100).toFixed(1)}% of expected value, on average`;
  const routeRows = Object.entries(s.routeSplit)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([route, n]) =>
        `<div class="row"><span>${route === "kalshi_self" ? "hedged on the market's own No side (Kalshi)" : "hedged cross-venue (Polymarket)"}</span><b>${n}</b></div>`,
    )
    .join("");
  const refusalRows = Object.entries(s.refusalsByCode)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([code, n]) =>
        `<div class="row"><span>${escapeHtml(REFUSAL_LABELS[code] ?? code)}</span><b>${n}</b></div>`,
    )
    .join("");
  const windowLine =
    s.firstAt && s.lastAt
      ? `Ledger window: ${escapeHtml(s.firstAt.slice(0, 16).replace("T", " "))} to ${escapeHtml(s.lastAt.slice(0, 16).replace("T", " "))} UTC.`
      : "The ledger is empty; it fills as quotes are made.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:," />
<title>Receipts · Earn &amp; Protect · events</title>
<meta name="description" content="Every protection quote and every honest refusal this demo has made, aggregated from its append-only ledger." />
<style>
:root{
  --bg:#f6f7f7; --card:#ffffff; --card2:#f2f4f4; --line:#e4e7e7;
  --ink:#050d0a; --dim:#5c6a64; --faint:#98a49e;
  --green:#00b67a; --green-deep:#014737; --green-wash:#e9f8f2; --warn:#b9862f;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;min-height:100vh}
.topbar{background:#050d0a}
.topbar .in{max-width:430px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:10px 16px}
.topbar .wordmark{color:#fff;font-weight:650;font-size:14px}
.topbar .wordmark span{color:#8f9c96;font-weight:400}
.topbar img{height:22px;display:block}
.wrap{max-width:430px;margin:0 auto;padding:14px 14px 40px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:12px;box-shadow:0 1px 2px rgba(5,13,10,.04)}
h1{font-size:19px;font-weight:650;letter-spacing:-.01em}
.sub{color:var(--dim);font-size:13px;margin-top:4px}
.bignums{display:flex;gap:10px;margin-top:14px}
.bignum{flex:1;background:var(--card2);border-radius:10px;padding:12px;text-align:center}
.bignum .n{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.bignum .n.green{color:var(--green)}
.bignum .l{color:var(--dim);font-size:11.5px;margin-top:2px}
h2{font-size:12px;color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;font-size:13.5px;color:var(--dim);font-variant-numeric:tabular-nums;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}
.row b{color:var(--ink);font-weight:650;text-align:right}
.back{display:inline-block;margin-top:2px;color:var(--green-deep);font-weight:600;font-size:13px;text-decoration:underline}
footer{color:var(--faint);font-size:11.5px;line-height:1.55;padding:14px 4px 0}
footer b{color:var(--dim);font-weight:600}
@media(min-width:700px){.wrap,.topbar .in{max-width:480px}}
</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="wordmark">Earn &amp; Protect <span>· receipts</span></div>
  <img src="${ATTICUS_LOGO_DATA_URI}" alt="Atticus" />
</div></div>
<div class="wrap">
  <div class="card">
    <h1>Receipts</h1>
    <div class="sub">Every quote this demo has priced and every one it refused, recomputed from the append-only ledger on each visit. Refusing honestly beats mispricing.</div>
    <div class="bignums">
      <div class="bignum"><div class="n green">${s.priced}</div><div class="l">quotes priced</div></div>
      <div class="bignum"><div class="n">${s.refused}</div><div class="l">honest refusals</div></div>
      <div class="bignum"><div class="n green">${usdFromCents(s.creditsSourcedCents)}</div><div class="l">credits sourced</div></div>
    </div>
  </div>
  <div class="card">
    <h2>What the protection really cost</h2>
    <div class="row"><span>true cost of priced protection</span><b>${escapeHtml(avgLine)}</b></div>
    <div class="row"><span>published take kept</span><b>${usdFromCents(s.takeKeptCents)}</b></div>
  </div>
  ${routeRows ? `<div class="card"><h2>Which route won</h2>${routeRows}</div>` : ""}
  ${refusalRows ? `<div class="card"><h2>Why quotes were refused</h2>${refusalRows}</div>` : ""}
  <div class="card">
    <h2>Honesty notes</h2>
    <div class="sub">${windowLine} The ledger lives on this instance's disk, so a redeploy starts a fresh window. Positions are simulated; every quote and refusal in these numbers came from live venue books at the moment it was made.</div>
    <a class="back" href="/">back to the live board</a>
  </div>
  <footer>
    <b>Demonstration, not an offer.</b> Aggregates cover simulated protection quotes priced from live public market data. Nothing here is investment advice.
  </footer>
</div>
</body>
</html>`;
}
