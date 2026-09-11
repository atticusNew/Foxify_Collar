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

export function renderEventXAppHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:," />
<title>Earn &amp; Protect · events · cross venue</title>
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
.eyebrow{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dim);margin-bottom:8px}
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
.protectedline{display:none;margin-top:12px;background:var(--green-wash);border:1px solid #cdeee0;border-radius:10px;padding:11px 13px;font-size:14px;align-items:center;justify-content:space-between}
.protectedline.show{display:flex}
.protectedline b{color:var(--green-deep);font-weight:650}
.undo{background:#fff;border:1px solid var(--green);color:var(--green-deep);border-radius:9px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;min-width:72px}
.hedge{margin-top:10px}
.hedge summary{cursor:pointer;color:var(--dim);font-size:13px;padding:7px 0;list-style:none}
.hedge summary::before{content:"\\25B8";margin-right:6px;font-size:11px}
.hedge[open] summary::before{content:"\\25BE"}
.legs{background:var(--card2);border-radius:10px;padding:10px 12px;font-size:12px;color:var(--dim)}
.legs .row{display:flex;justify-content:space-between;padding:3px 0;font-variant-numeric:tabular-nums;gap:12px}
.legs .row b{color:var(--ink);font-weight:600;text-align:right}
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
@media(min-width:700px){.wrap,.topbar .in{max-width:480px}}
</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="wordmark">Earn &amp; Protect <span>· events · cross venue</span></div>
  <img src="${ATTICUS_LOGO_DATA_URI}" alt="Atticus" />
</div></div>
<div class="wrap">
  <div class="card" id="hero">
    <div class="eyebrow"><span class="dot"></span><span id="eyeline">loading live markets…</span><span class="simlabel">simulation · live pricing</span></div>
    <h1 id="title">&nbsp;</h1>
    <div class="matchline" id="matchline">&nbsp;</div>
    <div class="chancerow">
      <span class="chance" id="chance">–</span>
      <span class="chancelbl">chance</span>
      <span class="countd" id="countd">–</span>
    </div>
    <div class="settleline">settled by the official final score</div>

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
        <div class="lbl">your minimum payout</div>
        <div class="min" id="minout">–</div>
        <div class="sweet">up to <b id="maxout">–</b> if Yes · includes a <b id="creditout">–</b> credit paid Yes or No</div>
      </div>

      <div class="togglerow">
        <div><div class="t">Protect this position</div><div class="d" id="toggledesc">one tap · protected instantly</div></div>
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
  </div>

  <div class="card how">
    <details>
      <summary>How this works</summary>
      <ul>
        <li><b>Real markets on two venues.</b> The game and its prices are live from Kalshi's and Polymarket's public data. The protection terms are quoted from Polymarket's live order book at executable depth.</li>
        <li><b>The trade you are making.</b> You give up the top slice of your win to guarantee you never leave empty-handed. The same game on the other venue prices that risk differently; the difference is your credit.</li>
        <li><b>The hedge is the same game.</b> Protection is backed by buying the opposing outcome on the other venue, which pays exactly when your side loses. Pairs quote only from a curated whitelist where both venues verifiably settle on the identical official result.</li>
        <li><b>Honest economics.</b> We keep a published share of the credit we source, waived when tiny. Nothing is embedded in your terms. When the venues cannot fund a credit, we refuse and say why.</li>
        <li><b>Read only.</b> This demonstration holds no keys or wallets, places no orders (hedge fills are simulated at live quotes), and cannot move funds.</li>
      </ul>
    </details>
  </div>

  <div class="err" id="err"></div>

  <footer>
    <b>Demonstration, not an offer.</b> The position and lifecycle above are simulated; market prices and hedge quotes are live from both venues. Event contracts involve risk. US availability requires a regulated deployment path; that work is underway. Nothing here is investment advice.
  </footer>
</div>

<script>
(function(){
  var S={payload:null,phase:'idle',terms:null,pairKey:null};
  var $=function(id){return document.getElementById(id)};
  function usd(c){return (c/100).toLocaleString('en-US',{style:'currency',currency:'USD'})}
  function shares(milli){var s=milli/1000;return (Math.round(s*10)/10).toLocaleString('en-US')}
  function centsFromMilli(m){return (Math.round(m/10*10)/10)/1}

  function fmtCountdown(iso){
    var ms=new Date(iso).getTime()-Date.now();
    if(ms<=0)return 'now';
    var m=Math.floor(ms/60000),h=Math.floor(m/60),d=Math.floor(h/24);
    if(d>0)return d+'d '+(h%24)+'h';
    return h>0?(h+'h '+(m%60)+'m'):(m+'m');
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

  function paintOffer(q){
    var p=S.payload,pr=p.pair,pos=p.position;
    var o=outcomeTotals(q);
    $('minout').textContent=usd(o.no);
    $('maxout').textContent=usd(o.yes);
    $('creditout').textContent=usd(q.creditCents);
    $('offer').style.display='block';
    var takeLine=q.takeWaived?'take waived (de minimis)':('published take '+usd(q.takeCents)+' ('+(q.takeBps/100)+'% of credit sourced)');
    var parityShort=(pr.parityNote||'').split(';')[0];
    $('legs').innerHTML=
      '<div class="row"><span>protected on</span><b>Kalshi '+pr.kalshiTicker+'</b></div>'+
      '<div class="row"><span>hedged on</span><b>Polymarket '+pr.pmEventSlug+'</b></div>'+
      '<div class="row"><span>same result</span><b>'+parityShort+'</b></div>'+
      '<div class="row"><span>per contract</span><b>in at '+pos.entryCents+'\\u00A2 · now '+q.markCents+'\\u00A2 · floor '+q.floorCents+'\\u00A2 · cap '+q.capCents+'\\u00A2</b></div>'+
      '<div class="row"><span>without protection</span><b>'+usd(o.nakedYes)+' if Yes · '+usd(o.nakedNo)+' if No</b></div>'+
      '<div class="row"><span>buy '+shares(q.hedge.sharesMilli)+' shares</span><b>'+q.hedge.outcome+' @ avg '+centsFromMilli(q.hedge.avgPriceMilli)+'\\u00A2 · Polymarket</b></div>'+
      '<div class="row"><span>hedge cost</span><b>'+usd(q.hedge.costCents)+'</b></div>'+
      '<div class="row"><span>venue fees</span><b>'+usd(q.feesCents)+'</b></div>'+
      '<div class="row"><span>economics</span><b>'+takeLine+'</b></div>'+
      '<div class="row"><span>fills</span><b>simulated fills at live quotes</b></div>';
    $('hedge').style.display='block';
  }

  function hideOffer(){
    $('offer').style.display='none';
    $('hedge').style.display='none';
  }

  function render(){
    var p=S.payload; if(!p)return;
    $('err').classList.remove('show');
    if(!p.ok||!p.pair){ $('eyeline').textContent='no whitelisted pair quotable right now'; return; }
    var pr=p.pair,pos=p.position,q=p.quote;
    var key=pr.kalshiTicker;
    if(S.pairKey&&S.pairKey!==key&&S.phase!=='idle'){ resetSim(); }
    S.pairKey=key;

    $('eyeline').textContent='live from Kalshi + Polymarket · '+pr.league.toUpperCase();
    $('title').textContent=pr.kalshiSide+' to win?';
    $('matchline').textContent=pr.pmEventTitle+' · starts '+fmtEt(pr.gameStartTime);
    $('chance').textContent=pr.markCents+'%';
    $('countd').textContent='starts in '+fmtCountdown(pr.gameStartTime);

    var val=pr.markCents*pos.contracts, cost=pos.entryCents*pos.contracts, pnl=val-cost;
    var src=pos.entrySource==='real_print'?'entry from a real Kalshi trade':'entered now';
    $('poscount').textContent=pos.contracts+' contracts';
    $('possub').textContent='avg '+pos.entryCents+'\\u00A2 · simulated · '+src;
    $('posval').textContent=usd(val);
    var pe=$('pospnl');
    pe.textContent=(pnl>=0?'+':'')+usd(pnl);
    pe.className='pnl '+(pnl>=0?'gain':'loss');

    var t=$('toggle');
    if(S.phase==='idle'){
      if(q&&q.ok){
        t.disabled=false;
        $('refusal').classList.remove('show');
        paintOffer(q); // the live offer is visible BEFORE the flip
        $('toggledesc').textContent='one tap · protected instantly';
      } else if(q){
        t.disabled=true; t.checked=false;
        hideOffer();
        $('refusal').innerHTML='<b>Not quotable right now.</b> '+q.detail+' Refusing honestly beats mispricing.';
        $('refusal').classList.add('show');
      }
    }
    if(S.phase==='protected'&&S.terms){
      if(new Date(pr.gameStartTime).getTime()<=Date.now()){ /* in play: hold to settlement */ }
    }
  }

  function resetSim(){
    S.phase='idle';S.terms=null;
    $('toggle').checked=false;
    $('protectedline').classList.remove('show');
    $('ticket').classList.remove('show');
    $('toggledesc').textContent='one tap · protected instantly';
    render();
  }

  $('toggle').addEventListener('change',function(e){
    if(!e.target.checked){ resetSim(); return; }
    var q=S.payload&&S.payload.quote;
    if(!(q&&q.ok)){ e.target.checked=false; return; }
    // one tap: the visible offer becomes the locked terms immediately
    S.phase='protected'; S.terms=q;
    paintOffer(q);
    $('paysline').textContent='payout when the game settles';
    $('protectedline').classList.add('show');
    $('toggledesc').textContent='terms locked at your tap';
  });

  document.addEventListener('click',function(ev){
    var el=ev.target;
    while(el&&el!==document){ if(el.id==='undo'){ ev.preventDefault(); resetSim(); return; } el=el.parentNode; }
  });

  function poll(){
    fetch('/api/showcase').then(function(r){return r.json()}).then(function(p){
      S.payload=p; render();
    }).catch(function(){
      $('err').textContent='live feed unreachable; retrying…';
      $('err').classList.add('show');
    });
  }
  poll(); setInterval(poll,10000); setInterval(render,30000);
})();
</script>
</body>
</html>`;
}
