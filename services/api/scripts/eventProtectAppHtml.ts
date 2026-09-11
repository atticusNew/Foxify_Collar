/**
 * Earn & Protect - events: the showcase page.
 *
 * Light theme in Kalshi's published palette (white / light gray / black
 * #050D0A / lightmode green #00B67A) so the surface reads native to the venue,
 * under a black Atticus header (the layer wears the venue's skin). Vocabulary
 * is Kalshi's own: Yes/No, chance, payout, closes, settled. "Resolution"
 * language is gone from the visible surface.
 *
 * The screen answers one question in total dollars: "your minimum payout $X,
 * up to $Y if Yes, includes a $Z credit paid Yes or No." Everything else
 * (per-contract cents, tickers, hedge legs, fees, take, tenor, the BRTI
 * settlement mechanics) lives behind one "see the hedge" disclosure.
 *
 * Design rules: one accent per screen state (green owns the offer, amber owns
 * refusals), sentence case except the honesty label, no em dashes in visible
 * copy, mobile-first at 390px, the toggle is the feature, one number owns the
 * card (the all-in minimum payout), tabular numerals everywhere money moves.
 *
 * Everything financial on this page is quoted live by the server; the position
 * and lifecycle are simulated and labeled.
 */

import { ATTICUS_LOGO_DATA_URI } from "./eventProtectLogo";

export function renderEventAppHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:," />
<title>Earn &amp; Protect · events</title>
<meta name="description" content="One tap turns an all-or-nothing event position into a guaranteed floor, a cap, and a cash credit, hedged on live listed option books. Demonstration with live pricing from Kalshi and OKX." />
<meta property="og:title" content="Earn &amp; Protect · events" />
<meta property="og:description" content="The derivatives layer for event markets: a one-tap floor on a Kalshi position, hedged on live listed option books. Demonstration, live venue pricing." />
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
.eyebrow{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dim);margin-bottom:8px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--green);animation:pulse 2s infinite;flex:none}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.simlabel{margin-left:auto;font-size:9.5px;letter-spacing:.07em;color:var(--faint);border:1px solid var(--line);border-radius:99px;padding:3px 8px;text-transform:uppercase;white-space:nowrap}
h1{font-size:19px;line-height:1.3;font-weight:650;letter-spacing:-.01em}
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
.refreshed{color:var(--faint);font-size:11px;text-align:right;margin-top:10px;font-variant-numeric:tabular-nums}
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
    <div class="eyebrow"><span class="dot"></span><span id="eyeline">live from Kalshi</span><span class="simlabel">simulation · live pricing</span></div>
    <div class="loading" id="loading">
      <div class="spinner"></div>
      <div>quoting live protection from Kalshi and the options market…</div>
      <div class="note">live books, executable depth, rounded against us</div>
    </div>
    <div id="main" style="display:none">
    <h1 id="title">&nbsp;</h1>
    <div class="chancerow">
      <span class="chance" id="chance">–</span>
      <span class="chancelbl">chance</span>
      <span class="countd" id="countd">–</span>
    </div>
    <div class="settleline">settled by Bitcoin's official reference price</div>

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

      <div class="protectedline" id="protectedline"><span>Protected · <b id="paysline">payout at close</b></span><button type="button" class="undo" id="undo">undo</button></div>

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

  <div class="card how">
    <details>
      <summary>How this works</summary>
      <ul>
        <li><b>Real market, real hedge prices.</b> The event and its prices are live from Kalshi's public data. The protection terms are quoted from live listed OKX option books at executable depth.</li>
        <li><b>The trade you are making.</b> You give up the top slice of your win to guarantee you never leave empty-handed. The options market pays more for that slice than your floor costs; the difference is your credit.</li>
        <li><b>How it settles.</b> The market is settled by the BRTI, the Bitcoin reference index published by CF Benchmarks: an average across major exchanges, read over the final 60 seconds. Yes or No, you get your payout plus the credit.</li>
        <li><b>Honest economics.</b> We keep a published share of the credit we source, waived when tiny. Nothing is embedded in your terms. When the books cannot fund a credit, we refuse and say why.</li>
        <li><b>Read only.</b> This demonstration holds no keys, places no orders (hedge fills are simulated at live quotes), and cannot move funds.</li>
      </ul>
    </details>
  </div>

  <div class="err" id="err"></div>

  <footer>
    <b>Demonstration, not an offer.</b> The position and lifecycle above are simulated; market prices and hedge quotes are live. Event contracts and options involve risk. US availability requires a regulated deployment path; that work is underway. Nothing here is investment advice.
  </footer>
</div>

<script>
(function(){
  var S={payload:null,phase:'idle',terms:null,marketTicker:null,closeIso:null,fetchedAt:0};
  var $=function(id){return document.getElementById(id)};
  function usd(c){return (c/100).toLocaleString('en-US',{style:'currency',currency:'USD'})}

  function fmtCountdown(iso){
    var ms=new Date(iso).getTime()-Date.now();
    if(ms<=0)return 'now';
    var s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);
    if(h>0)return h+'h '+(m%60)+'m';
    return m+'m '+(s%60)+'s';
  }
  function tick(){
    if(S.closeIso){
      $('countd').textContent='closes in '+fmtCountdown(S.closeIso);
    }
    if(S.fetchedAt){
      var age=Math.max(0,Math.round((Date.now()-S.fetchedAt)/1000));
      $('refreshed').textContent=age<2?'quotes refreshed just now':'quotes refreshed '+age+'s ago';
    }
  }
  function fmtEt(iso){
    try{
      return new Date(iso).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}).toLowerCase().replace(' ','')+' ET';
    }catch(e){return 'close'}
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

  function paintOffer(q){
    var p=S.payload,mk=p.market,pos=p.position;
    var o=outcomeTotals(q);
    $('minout').textContent=usd(o.no);
    $('maxout').textContent=usd(o.yes);
    $('creditout').textContent=usd(q.creditCents);
    $('offer').style.display='block';
    var takeLine=q.takeWaived?'take waived (de minimis)':('published take '+usd(q.takeCents)+' ('+(q.takeBps/100)+'% of credit sourced)');
    $('legs').innerHTML=
      '<div class="row"><span>market</span><b>Kalshi '+mk.ticker+'</b></div>'+
      '<div class="row"><span>settled by</span><b>60s average of the BRTI (CF Benchmarks) vs '+Number(mk.strike).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0})+'</b></div>'+
      '<div class="row"><span>per contract</span><b>in at '+pos.entryCents+'\\u00A2 · now '+q.markCents+'\\u00A2 · floor '+q.floorCents+'\\u00A2 · cap '+q.capCents+'\\u00A2</b></div>'+
      '<div class="row"><span>without protection</span><b>'+usd(o.nakedYes)+' if Yes · '+usd(o.nakedNo)+' if No</b></div>'+
      '<div class="row"><span>buy '+q.legs[0].contracts+'x</span><b>'+q.legs[0].instId+'</b></div>'+
      '<div class="row"><span>sell '+q.legs[1].contracts+'x</span><b>'+q.legs[1].instId+'</b></div>'+
      '<div class="row"><span>hedge tenor</span><b>'+(q.alignment==='expiry_aligned'?'expiry aligned':'unwound at close (estimate)')+'</b></div>'+
      '<div class="row"><span>venue fees</span><b>'+usd(q.feesCents)+'</b></div>'+
      '<div class="row"><span>economics</span><b>'+takeLine+'</b></div>'+
      '<div class="row"><span>cost of protection</span><b>'+evLine(evCostBps(q.markCents,q.floorCents,q.capCents,q.creditCents,q.contracts))+' at current odds</b></div>'+
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
    $('loading').style.display='none';
    if(!p.ok||!p.market){ $('eyeline').textContent=p.error||'no quotable market open right now'; $('main').style.display='none'; return; }
    $('main').style.display='block';
    var mk=p.market,pos=p.position,q=p.quote;
    if(S.marketTicker&&S.marketTicker!==mk.ticker&&S.phase!=='idle'){ resetSim(); }
    S.marketTicker=mk.ticker;

    $('eyeline').textContent='live from Kalshi · BTC '+Number(p.spotUsd).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
    $('title').textContent='Bitcoin '+mk.subtitle.toLowerCase()+' by '+fmtEt(mk.closeTime)+'?';
    $('chance').textContent=mk.markCents+'%';
    S.closeIso=mk.closeTime;
    $('countd').textContent='closes in '+fmtCountdown(mk.closeTime);

    var val=mk.markCents*pos.contracts, cost=pos.entryCents*pos.contracts, pnl=val-cost;
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
      if(new Date(mk.closeTime).getTime()<=Date.now()){ settle(mk); }
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
    $('paysline').textContent='payout at '+fmtEt(S.payload.market.closeTime);
    $('protectedline').classList.add('show');
    $('toggledesc').textContent='terms locked at your tap';
  });

  document.addEventListener('click',function(ev){
    var el=ev.target;
    while(el&&el!==document){ if(el.id==='undo'){ ev.preventDefault(); resetSim(); return; } el=el.parentNode; }
  });

  function settle(mk){
    S.phase='settled';
    var t=S.terms,yes=mk.markCents>=50; // sim: settle on last observed side
    var o=outcomeTotals(t);
    $('protectedline').classList.remove('show');
    var tk=$('ticket');
    tk.innerHTML='<h3>Settled '+(yes?'Yes':'No')+' (simulated)</h3>'+
      '<div class="row"><span class="k">'+(yes?'cap':'floor')+' × '+t.contracts+'</span><span>'+usd((yes?t.capCents:t.floorCents)*t.contracts)+'</span></div>'+
      '<div class="row"><span class="k">credit</span><span>'+usd(t.creditCents)+'</span></div>'+
      '<div class="row total"><span class="k">payout with protection</span><span>'+usd(yes?o.yes:o.no)+'</span></div>'+
      '<div class="row"><span class="k">without protection</span><span>'+usd(yes?o.nakedYes:o.nakedNo)+'</span></div>';
    tk.classList.add('show');
  }

  function poll(){
    fetch('/api/showcase').then(function(r){return r.json()}).then(function(p){
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
