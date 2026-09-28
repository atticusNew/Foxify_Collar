/**
 * Earn & Protect - events, cross-venue (Tier 2): the showcase page.
 *
 * Same surface grammar as the Tier 1 event page (light Kalshi-native theme,
 * total-dollars hero, one-tap toggle, one disclosure). Retail first: the page
 * shows the event, the position, the floor, the cap, the credit and the tiers,
 * and reads only the retail /api/showcase shape (src/eventCollar/retailShowcase.ts).
 * The hedge leg, the pairing, the routes and our take live on the operator's
 * surfaces (/api/showcase?token=..., the track record), never on this page.
 *
 * Everything financial is quoted live by the server from public books; the
 * position and lifecycle are simulated and labeled.
 */

import { ATTICUS_LOGO_DATA_URI } from "./eventProtectLogo";
import type { CrossLedgerSummary } from "../src/eventCollar/crossVenue/crossLedger";
import type { EventFunnelSummary } from "../src/eventCollar/crossVenue/eventFunnel";

/** Public URL of the track record service (its own deploy, so the track record outlives demo restarts). */
function shadowUrl(): string {
  return process.env.EVENT_X_SHADOW_URL || "https://atticus-event-shadow.onrender.com";
}

export function renderEventXAppHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:," />
<title>Earn &amp; Protect · events</title>
<meta name="description" content="One tap turns an all-or-nothing event position into a guaranteed floor, a cap, and a cash credit. Games and crypto on one board, best value first. Demonstration with live pricing." />
<meta property="og:title" content="Earn &amp; Protect · events" />
<meta property="og:description" content="The derivatives layer for event markets: a one-tap floor on a Kalshi position, games and crypto, paid in cash. Demonstration, live pricing." />
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
.hero{padding:2px 0 4px}
.hero .two{display:flex;gap:10px}
.hero .big{flex:1;min-width:0;text-align:center}
.hero .lbl{color:var(--dim);font-size:12.5px}
.hero .min{font-size:34px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--green);letter-spacing:-.02em;margin:1px 0;white-space:nowrap}
.hero .big.cash .min{color:var(--green-deep)}
.hero .sweet{color:var(--dim);font-size:12.5px;text-align:center;margin-top:4px}
.hero .sweet b{color:var(--ink);font-weight:650}
.tiers{display:flex;gap:6px;margin-top:12px}
.tier{flex:1;min-width:0;background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:8px 5px;text-align:center;cursor:pointer;font:inherit;color:var(--ink);-webkit-tap-highlight-color:transparent}
.tier.on{border-color:var(--green);background:var(--green-wash)}
.tier:disabled{cursor:default;opacity:.7}
.tier .tn{font-size:11px;color:var(--dim);font-weight:650;white-space:nowrap}
.tier .tf{font-size:14px;font-weight:700;margin-top:3px;font-variant-numeric:tabular-nums;white-space:nowrap}
.tier .tc{font-size:10px;color:var(--faint);margin-top:1px;white-space:nowrap}
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
.how li a{color:var(--dim);font-weight:600;text-decoration:underline}
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
    <div class="eyebrow"><span class="dot"></span><span id="eyeline">Kalshi</span><span class="simlabel">simulation · live pricing</span></div>
    <div class="loading" id="loading">
      <div class="spinner"></div>
      <div>scanning games and crypto…</div>
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
        <div class="two">
          <div class="big"><div class="lbl">you keep at least</div><div class="min" id="minout">–</div></div>
          <div class="big cash"><div class="lbl">cash now</div><div class="min" id="creditout">–</div></div>
        </div>
        <div class="sweet">up to <b id="maxout">–</b> if you win · the cash is yours either way</div>
        <div class="tiers" id="tiers"></div>
      </div>

      <div class="togglerow">
        <div><div class="t">Protect this position</div><div class="d" id="toggledesc">one tap</div></div>
        <label class="switch"><input type="checkbox" id="toggle" disabled /><span class="slider"></span></label>
      </div>

      <div class="protectedline" id="protectedline"><span>Protected · <b id="paysline">payout when the game settles</b></span><button type="button" class="undo" id="undo">undo</button></div>

      <div class="refusal" id="refusal"></div>

      <details class="hedge" id="hedge" style="display:none">
        <summary>see the terms</summary>
        <div class="legs" id="legs"></div>
      </details>

      <div class="ticket" id="ticket"></div>
    </div>
    <div class="refreshed" id="refreshed">&nbsp;</div>
    </div>
  </div>

  <div class="card board" id="boardcard" style="display:none">
    <div class="bt">Best protection right now</div>
    <div class="bs">best value first · tap any game</div>
    <div id="boardrows"></div>
  </div>

  <div class="card how">
    <details>
      <summary>How this works</summary>
      <ul>
        <li><b>The trade.</b> You give up the top slice of your win so you never leave empty-handed. The market prices that risk live; when it prices it cheaper than the slice you sold, the difference is paid to you as cash.</li>
        <li><b>Backed by the same game.</b> Protection is backed by buying the side that pays exactly when yours loses, only on listings that verifiably settle on the identical official result. Your floor does not depend on anyone's opinion of the game.</li>
        <li><b>Three ways to protect.</b> Safest keeps the most no matter what; Most upside keeps the most if you win; Balanced sits between. You pick; nothing is pre-chosen for you but a starting point.</li>
        <li><b>The credit you see is the credit you get.</b> Our fee comes out of the cash we source before the number is shown; there is nothing to add back. When the market cannot fund a credit, we refuse and say so. This is a demonstration: prices are live, the position is simulated, no funds can move, and undo simply resets it; in the real product, terms lock at your tap. <a href="/receipts">See the receipts</a>.</li>
      </ul>
    </details>
  </div>

  <div class="err" id="err"></div>

  <footer>
    <b>Demonstration, not an offer.</b> Positions are simulated; prices are live. Event contracts involve risk. US availability requires a regulated deployment path; that work is underway. Nothing here is investment advice. <a href="/receipts">See the receipts</a>. <a href="${shadowUrl()}">See the track record</a>.
  </footer>
</div>

<script>
(function(){
  var S={payload:null,phase:'idle',terms:null,pairKey:null,startIso:null,kind:'sports',fetchedAt:0,sel:null,boardOpen:false,tier:null};
  var TIER_ORDER=['tight','balanced','wide'];
  var TIER_WORDS={tight:'Safest',balanced:'Balanced',wide:'Most upside'};
  var $=function(id){return document.getElementById(id)};
  // Funnel beacon. The session id is random, per tab, and never leaves
  // sessionStorage; the server fills in every financial field itself.
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
  /* A weekday alone reads as "this Sunday"; past 24h out the date rides along so next week's game is never mistaken for today's. */
  function fmtEt(iso){
    try{
      var dt=new Date(iso),far=dt.getTime()-Date.now()>86400000;
      var day=dt.toLocaleDateString('en-US',far?{weekday:'short',month:'short',day:'numeric',timeZone:'America/New_York'}:{weekday:'short',timeZone:'America/New_York'}).replace(',','');
      var tm=dt.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}).toLowerCase().replace(' ','');
      return day+(far?' · ':' ')+tm+' ET';
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

  // The quote's top-level terms are its default tier (Balanced when the venues
  // fund it); the holder may pick another. Each tier is a complete,
  // separately hedged collar.
  function termsFor(q){
    var tiers=q.tiers||{};
    if(!S.tier||!tiers[S.tier])S.tier=tiers.balanced?'balanced':(q.tier||null);
    var t=S.tier&&tiers[S.tier]?tiers[S.tier]:q;
    var out={};for(var k in q)out[k]=q[k];for(var j in t)out[j]=t[j];
    return out;
  }
  function paintTiers(q,locked){
    var tiers=q.tiers||{},html='',n=0;
    for(var i=0;i<TIER_ORDER.length;i++){
      var name=TIER_ORDER[i],t=tiers[name];
      if(!t)continue; n++;
      var o=outcomeTotals({floorCents:t.floorCents,capCents:t.capCents,creditCents:t.creditCents,contracts:q.contracts});
      // one number per tile: the floor is what each tier is about; the selected tier's full terms are the hero
      html+='<button type="button" class="tier'+(name===S.tier?' on':'')+'" data-tier="'+name+'"'+(locked?' disabled':'')+' aria-pressed="'+(name===S.tier?'true':'false')+'">'+
        '<div class="tn">'+TIER_WORDS[name]+'</div>'+
        '<div class="tf">'+usd(o.no)+'</div>'+
        '<div class="tc">at least</div></button>';
    }
    $('tiers').innerHTML=n>1?html:'';
    $('tiers').style.display=n>1?'flex':'none';
  }

  function paintOffer(q0){
    var q=S.phase==='protected'&&S.terms?S.terms:termsFor(q0);
    var p=S.payload,pos=p.position;
    var o=outcomeTotals(q);
    paintTiers(q0,S.phase==='protected');
    $('minout').textContent=usd(o.no);
    $('maxout').textContent=usd(o.yes);
    $('creditout').textContent=usd(q.creditCents);
    $('offer').style.display='block';
    var entryTag=pos.entrySource==='real_print'?' (real print)':'';
    $('legs').innerHTML=
      '<div class="row"><span>per contract</span><b>in at '+pos.entryCents+'\\u00A2'+entryTag+' · now '+q.markCents+'\\u00A2 · floor '+q.floorCents+'\\u00A2 · cap '+q.capCents+'\\u00A2</b></div>'+
      '<div class="row"><span>without protection</span><b>'+usd(o.nakedYes)+' if Yes · '+usd(o.nakedNo)+' if No</b></div>'+
      '<div class="row"><span>with protection</span><b>'+usd(o.yes)+' if Yes · '+usd(o.no)+' if No</b></div>'+
      '<div class="row"><span>cost of protection</span><b>'+evLine(evCostBps(q.markCents,q.floorCents,q.capCents,q.creditCents,q.contracts))+'</b></div>'+
      '<div class="row"><span>settles</span><b>'+(S.kind==='crypto'?'on the official index print':'on the official final score')+' · payout when it settles</b></div>';
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
    if(!p.ok||!p.pair){ $('eyeline').textContent=p.error||'nothing is quotable right now'; $('main').style.display='none'; $('boardcard').style.display='none'; return; }
    $('main').style.display='block';
    var pr=p.pair,pos=p.position,q=p.quote;
    if(S.sel&&pr.kalshiTicker!==S.sel){ S.sel=null; }
    var key=pr.kalshiTicker;
    if(S.pairKey&&S.pairKey!==key){ S.tier=null; if(S.phase!=='idle')resetSim(); }
    S.pairKey=key;
    S.kind=pr.kind||'sports';
    var crypto=S.kind==='crypto';

    $('eyeline').textContent='Kalshi';
    $('title').textContent=(pr.sideName||pr.kalshiSide)+(crypto?'?':' to win?');
    $('matchline').textContent=(crypto?'':(pr.opponent?('vs. '+pr.opponent+' · '):''))+pr.league.toUpperCase()+' · '+(crypto?'settles ':'')+fmtEt(pr.eventTimeIso);
    $('chance').textContent=pr.markCents+'%';
    S.startIso=pr.eventTimeIso;
    $('countd').textContent=countdLabel();
    if(q&&q.ok){
      $('whyline').textContent=S.sel?'your pick':'best value right now';
    } else {
      $('whyline').innerHTML='&nbsp;';
    }

    var val=pr.markCents*pos.contracts, cost=pos.entryCents*pos.contracts, pnl=val-cost;
    $('poscount').textContent=pos.contracts+' contracts';
    $('possub').textContent='in at '+pos.entryCents+'\\u00A2 a contract';
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
        $('refusal').innerHTML='<b>Not right now.</b> '+q.detail;
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
        '<div class="m">'+fmtEt(r.eventTimeIso)+' · '+r.markCents+'% · keep at least '+usd(r.floorTotalCents)+' · '+usd(r.creditCents)+' cash</div>'+
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
    var locked=termsFor(q);
    track('protect_on',S.payload.pair&&S.payload.pair.kalshiTicker,S.tier);
    // one tap: the visible offer (the selected tier) becomes the locked terms immediately
    S.phase='protected'; S.terms=locked;
    paintOffer(q);
    var ot=outcomeTotals(locked);
    $('paysline').textContent='guaranteed '+usd(ot.no)+' to '+usd(ot.yes);
    $('protectedline').classList.add('show');
    $('toggledesc').textContent='terms locked at your tap';
  });

  document.addEventListener('click',function(ev){
    var el=ev.target;
    while(el&&el!==document){
      if(el.id==='undo'){ ev.preventDefault(); track('protect_undo',S.payload&&S.payload.pair&&S.payload.pair.kalshiTicker); resetSim(); return; }
      if(el.getAttribute&&el.getAttribute('data-tier')){
        ev.preventDefault();
        if(S.phase!=='idle')return;
        var tn=el.getAttribute('data-tier');
        if(tn===S.tier)return;
        S.tier=tn; track('tier_pick',S.payload&&S.payload.pair&&S.payload.pair.kalshiTicker,tn);
        if(S.payload&&S.payload.quote&&S.payload.quote.ok)paintOffer(S.payload.quote);
        return;
      }
      if(el.id==='boardmore'){ ev.preventDefault(); S.boardOpen=!S.boardOpen; if(S.boardOpen)track('board_expand'); if(S.payload)renderBoard(S.payload); return; }
      if(el.getAttribute&&el.getAttribute('data-ticker')){
        var t=el.getAttribute('data-ticker');
        if(S.payload&&S.payload.pair&&S.payload.pair.kalshiTicker===t)return;
        track('row_tap',t);
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
  protection_too_rich: "the cheapest route was still rich insurance (above the EV-cost ceiling)",
  credit_too_small: "the best credit fell under the minimum (25¢ and 0.25% of stake)",
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

const ROUTE_LABELS: Record<string, string> = {
  polymarket: "cross-venue (Polymarket)",
  kalshi_self: "market's own No side (Kalshi)",
  unknown: "unattributed",
};

const ACTION_LABELS: Record<string, string> = {
  row_tap: "board taps",
  protect_on: "Protect taps",
  protect_undo: "undos",
  board_expand: "board expands",
  tier_pick: "tier picks",
};

const TIER_LABELS: Record<string, string> = {
  tight: "Safest (tight)",
  balanced: "Balanced",
  wide: "Most upside (wide)",
  unknown: "unattributed",
};

/** Operator-only funnel page: the admin JSON, laid out so a human can read it in ten seconds. */
export function renderFunnelHtml(
  s: EventFunnelSummary,
  meta: { atIso: string; funnelPath: string; token: string | null },
): string {
  const pct = (num: number, den: number): string => (den > 0 ? `${((100 * num) / den).toFixed(0)}%` : "–");
  const utc = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  const dayLabel = (day: string): string => {
    const d = new Date(`${day}T00:00:00Z`);
    return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()]} ${day.slice(5)}`;
  };
  const tokenQs = meta.token ? `?token=${encodeURIComponent(meta.token)}` : "";

  const kv = (rows: Array<[string, string | number]>): string =>
    rows.map(([k, v]) => `<div class="row"><span>${escapeHtml(k)}</span><b>${escapeHtml(String(v))}</b></div>`).join("");
  const countRows = (src: Record<string, number>, labels: Record<string, string>, upper = false): string =>
    Object.entries(src)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `<div class="row"><span>${escapeHtml(labels[k] ?? (upper ? k.toUpperCase() : k))}</span><b>${n}</b></div>`)
      .join("");

  const days = s.pageLoads7d.map((d, i) => {
    const a = s.actions7d[i]?.byAction ?? {};
    return `<tr>
      <td>${escapeHtml(dayLabel(d.day))}</td>
      <td>${d.byPage.app ?? 0}</td>
      <td>${d.byPage.receipts ?? 0}</td>
      <td>${d.byPage.embed ?? 0}</td>
      <td>${a.row_tap ?? 0}</td>
      <td class="hi">${a.protect_on ?? 0}</td>
      <td>${a.protect_undo ?? 0}</td>
      <td>${a.tier_pick ?? 0}</td>
      <td>${a.board_expand ?? 0}</td>
    </tr>`;
  });
  const totals = {
    app: s.pageLoads7d.reduce((n, d) => n + (d.byPage.app ?? 0), 0),
    receipts: s.pageLoads7d.reduce((n, d) => n + (d.byPage.receipts ?? 0), 0),
    embed: s.pageLoads7d.reduce((n, d) => n + (d.byPage.embed ?? 0), 0),
    taps: s.actions7d.reduce((n, d) => n + (d.byAction.row_tap ?? 0), 0),
    protects: s.actions7d.reduce((n, d) => n + (d.byAction.protect_on ?? 0), 0),
    undos: s.actions7d.reduce((n, d) => n + (d.byAction.protect_undo ?? 0), 0),
    tierPicks: s.actions7d.reduce((n, d) => n + (d.byAction.tier_pick ?? 0), 0),
    expands: s.actions7d.reduce((n, d) => n + (d.byAction.board_expand ?? 0), 0),
  };

  const recent = s.recentProtects.map(
    (p) => `<tr>
      <td>${escapeHtml(utc(p.atMs))}</td>
      <td class="mono">${escapeHtml(p.ticker || "–")}</td>
      <td>${escapeHtml(p.league === "unknown" ? "–" : p.league.toUpperCase())}</td>
      <td>${escapeHtml(p.route ? (ROUTE_LABELS[p.route] ?? p.route) : "–")}</td>
      <td>${escapeHtml(p.tier ?? "–")}</td>
      <td class="hi">${p.creditCents === null ? "–" : usdFromCents(p.creditCents)}</td>
      <td>${p.floorCents === null || p.capCents === null ? "–" : `${p.floorCents}¢ → ${p.capCents}¢`}</td>
      <td>${p.contracts ?? "–"}</td>
    </tr>`,
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<link rel="icon" href="data:," />
<title>Funnel · Earn &amp; Protect · events</title>
<style>
:root{
  --bg:#f6f7f7; --card:#ffffff; --card2:#f2f4f4; --line:#e4e7e7;
  --ink:#050d0a; --dim:#5c6a64; --faint:#98a49e;
  --green:#00b67a; --green-deep:#014737; --warn:#b9862f;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;min-height:100vh}
.topbar{background:#050d0a}
.topbar .in{max-width:880px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:10px 16px}
.topbar .wordmark{color:#fff;font-weight:650;font-size:14px}
.topbar .wordmark span{color:#8f9c96;font-weight:400}
.topbar img{height:22px;display:block}
.wrap{max-width:880px;margin:0 auto;padding:14px 14px 40px}
.grid{display:grid;grid-template-columns:1fr;gap:12px}
@media(min-width:700px){.grid.two{grid-template-columns:1fr 1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:12px;box-shadow:0 1px 2px rgba(5,13,10,.04)}
.grid .card{margin-bottom:0}
h1{font-size:19px;font-weight:650;letter-spacing:-.01em}
.sub{color:var(--dim);font-size:13px;margin-top:4px}
.bignums{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}
.bignum{flex:1;min-width:120px;background:var(--card2);border-radius:10px;padding:12px;text-align:center}
.bignum .n{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.bignum .n.green{color:var(--green)}
.bignum .l{color:var(--dim);font-size:11.5px;margin-top:2px}
h2{font-size:12px;color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;font-size:13.5px;color:var(--dim);font-variant-numeric:tabular-nums;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}
.row b{color:var(--ink);font-weight:650;text-align:right}
table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
th{text-align:left;color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:6px 6px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:7px 6px;border-bottom:1px solid var(--line);color:var(--dim);white-space:nowrap}
td.hi{color:var(--ink);font-weight:650}
td.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--ink)}
tr.total td{color:var(--ink);font-weight:650;border-bottom:0}
.tablewrap{overflow-x:auto}
.empty{color:var(--faint);font-size:13px;padding:8px 0}
.actions{display:flex;gap:14px;align-items:center;margin-top:10px;flex-wrap:wrap}
.actions a,.actions button{color:var(--green-deep);font-weight:600;font-size:13px;text-decoration:underline;background:none;border:0;cursor:pointer;font-family:inherit;padding:0}
.actions button.danger{color:var(--warn)}
footer{color:var(--faint);font-size:11.5px;line-height:1.55;padding:14px 4px 0}
</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="wordmark">Earn &amp; Protect <span>· funnel</span></div>
  <img src="${ATTICUS_LOGO_DATA_URI}" alt="Atticus" />
</div></div>
<div class="wrap">
  <div class="card">
    <h1>Who looked, who tapped, who protected</h1>
    <div class="sub">Anonymous per-tab sessions. Every dollar figure below came from the server's own live quote at the moment of the tap, not from the browser. Updated ${escapeHtml(meta.atIso.slice(0, 16).replace("T", " "))} UTC.</div>
    <div class="bignums">
      <div class="bignum"><div class="n">${s.sessions.active7d}</div><div class="l">sessions, 7 days</div></div>
      <div class="bignum"><div class="n green">${s.protects.last7d}</div><div class="l">Protect taps, 7 days</div></div>
      <div class="bignum"><div class="n green">${escapeHtml(pct(s.sessions.protected, s.sessions.distinct))}</div><div class="l">sessions that protected</div></div>
      <div class="bignum"><div class="n">${usdFromCents(s.protects.creditCentsTotal)}</div><div class="l">credits on protected taps</div></div>
    </div>
  </div>

  <div class="grid two">
    <div class="card">
      <h2>Sessions</h2>
      ${kv([
        ["distinct, all time", s.sessions.distinct],
        ["active in the last 24h", s.sessions.active24h],
        ["active in the last 7 days", s.sessions.active7d],
        ["protected at least once", s.sessions.protected],
        ["tapped a game but never protected", s.sessions.tappedNeverProtected],
      ])}
    </div>
    <div class="card">
      <h2>Protect taps</h2>
      ${kv([
        ["all time", s.protects.total],
        ["last 24h", s.protects.last24h],
        ["last 7 days", s.protects.last7d],
        ["contracts protected", s.protects.contractsTotal.toLocaleString("en-US")],
        ["credits paid", usdFromCents(s.protects.creditCentsTotal)],
      ])}
    </div>
  </div>

  <div class="grid two" style="margin-top:12px">
    <div class="card">
      <h2>By league</h2>
      ${countRows(s.protects.byLeague, { unknown: "unattributed" }, true) || '<div class="empty">no Protect taps yet</div>'}
    </div>
    <div class="card">
      <h2>By hedge route</h2>
      ${countRows(s.protects.byRoute, ROUTE_LABELS) || '<div class="empty">no Protect taps yet</div>'}
    </div>
    <div class="card">
      <h2>By protection tier</h2>
      ${countRows(s.protects.byTier ?? {}, TIER_LABELS) || '<div class="empty">no Protect taps yet</div>'}
    </div>
  </div>

  <div class="card" style="margin-top:12px">
    <h2>Last 7 days, UTC</h2>
    <div class="tablewrap"><table>
      <thead><tr><th>day</th><th>board loads</th><th>receipts loads</th><th>embed loads</th><th>${escapeHtml(ACTION_LABELS.row_tap)}</th><th>${escapeHtml(ACTION_LABELS.protect_on)}</th><th>${escapeHtml(ACTION_LABELS.protect_undo)}</th><th>${escapeHtml(ACTION_LABELS.tier_pick)}</th><th>${escapeHtml(ACTION_LABELS.board_expand)}</th></tr></thead>
      <tbody>
        ${days.join("")}
        <tr class="total"><td>7-day total</td><td>${totals.app}</td><td>${totals.receipts}</td><td>${totals.embed}</td><td>${totals.taps}</td><td>${totals.protects}</td><td>${totals.undos}</td><td>${totals.tierPicks}</td><td>${totals.expands}</td></tr>
      </tbody>
    </table></div>
  </div>

  <div class="card">
    <h2>Most recent Protect taps</h2>
    ${
      recent.length
        ? `<div class="tablewrap"><table>
      <thead><tr><th>when (UTC)</th><th>market</th><th>league</th><th>route</th><th>tier</th><th>credit</th><th>floor → cap</th><th>contracts</th></tr></thead>
      <tbody>${recent.join("")}</tbody>
    </table></div>`
        : '<div class="empty">none yet. A tap on a game that has already rolled off the board still counts, shown unattributed.</div>'
    }
  </div>

  <div class="card">
    <h2>Operator</h2>
    <div class="sub">Counters live at <span class="mono">${escapeHtml(meta.funnelPath)}</span> on this instance and are flushed once a minute. Without a persistent disk a redeploy starts a fresh window.</div>
    <div class="actions">
      <a href="/api/admin/funnel${escapeHtml(tokenQs)}">raw JSON</a>
      <a href="/board">live board</a>
      <a href="/receipts">receipts</a>
      <button type="button" class="danger" id="reset">reset counters</button>
    </div>
  </div>
  <footer>Operator view. Not linked from the public pages; the token in this URL is the only key.</footer>
</div>
<script>
document.getElementById('reset').addEventListener('click',function(){
  if(!confirm('Clear every funnel counter on this instance? The quote receipts ledger is not touched.'))return;
  fetch('/api/admin/funnel/reset'+location.search,{method:'POST'}).then(function(){location.reload()});
});
</script>
</body>
</html>`;
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
.rules .row{display:block}
.rules .row span{display:block;font-size:13.5px;font-weight:650;color:var(--ink)}
.rules .row b{display:block;text-align:left;font-weight:400;color:var(--dim);margin-top:2px;line-height:1.45}
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
  </div>
  ${refusalRows ? `<div class="card"><h2>Why quotes were refused</h2>${refusalRows}</div>` : ""}
  <div class="card rules">
    <h2>How the terms are built</h2>
    <div class="sub">Every protection is priced at executable depth, only on listings that verifiably settle on the identical official result, and backed by buying the side that pays exactly when yours loses. What you see is what the market funds right now.</div>
    <div class="row"><span>Safest</span><b>the highest floor the venues fund, with the largest credit at it</b></div>
    <div class="row"><span>Balanced</span><b>a floor halfway between Safest and Most upside, with a cap halfway between the least and the most the venues fund there</b></div>
    <div class="row"><span>Most upside</span><b>the lowest floor offered, with the highest cap the venues fund at it</b></div>
    <div class="row"><span>Our fee</span><b>comes out of the cash we source before the credit is shown; the credit on the card is the credit you get, and nothing is embedded in the floor or the cap</b></div>
    <div class="row"><span>Refusals</span><b>when the market cannot fund a credit, we refuse and say so</b></div>
    <div class="row"><span>Undo</span><b>free only in the demonstration, where nothing is bought; in the real product terms lock at your tap and the hedge is placed immediately, so an early unwind is a new trade quoted from the live books, never a free reversal</b></div>
  </div>
  <div class="card">
    <h2>Honesty notes</h2>
    <div class="sub">${windowLine} The ledger lives on this instance's disk, so a redeploy starts a fresh window. Positions are simulated; every quote and refusal in these numbers came from live market prices at the moment it was made.</div>
    <a class="back" href="/board">back to the live board</a>
  </div>
  <footer>
    <b>Demonstration, not an offer.</b> Aggregates cover simulated protection quotes priced from live public market data. Nothing here is investment advice. <a href="${shadowUrl()}">See the track record</a>.
  </footer>
</div>
</body>
</html>`;
}
