/**
 * Earn & Protect - events: the showcase page.
 *
 * Event-native presentation: the market reads like an event listing (question,
 * percent chance, countdown), the product reads as outcomes in dollars ("leave
 * with at least ..."), and execution is one tap with an undo window. All desk
 * language (strikes, verticals, cents terms, fees, take, tenor) lives behind
 * one "see the hedge" disclosure.
 *
 * Design rules inherited from the retail surface: one accent per screen state,
 * sentence case everywhere except the honesty label, no em dashes in visible
 * copy, mobile-first at 390px, the toggle is the feature, one number owns the
 * card (the guaranteed minimum).
 *
 * Everything financial on this page is quoted live by the server; the position
 * and lifecycle are simulated and labeled.
 */

export function renderEventAppHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:," />
<title>Earn &amp; Protect · events</title>
<style>
:root{
  --bg:#0b0e11; --card:#12161b; --card2:#171c22; --line:#232a32;
  --ink:#e8edf2; --dim:#8a95a1; --faint:#5a6470;
  --accent:#50d2c1; --accent-ink:#04211d;
  --floor:#e2695e; --cap:#d9a441; --live:#ffffff;
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;min-height:100vh}
.wrap{max-width:430px;margin:0 auto;padding:14px 14px 40px}
header{display:flex;align-items:center;justify-content:space-between;padding:6px 2px 14px}
.brand{font-weight:700;letter-spacing:.02em}
.brand span{color:var(--dim);font-weight:400}
.simlabel{font-size:10px;letter-spacing:.08em;color:var(--dim);border:1px solid var(--line);border-radius:99px;padding:4px 9px;text-transform:uppercase;white-space:nowrap}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:12px}
.eyebrow{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dim);margin-bottom:6px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--accent);animation:pulse 2s infinite;flex:none}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
h1{font-size:19px;line-height:1.3;font-weight:650}
.chancerow{display:flex;align-items:baseline;gap:10px;margin:10px 0 2px}
.chance{font-size:34px;font-weight:700;font-variant-numeric:tabular-nums}
.chancelbl{color:var(--dim);font-size:13px}
.countd{margin-left:auto;color:var(--dim);font-size:12px;text-align:right}
.railbox{padding:18px 6px 2px;position:relative}
.rail{height:4px;border-radius:2px;background:var(--line);position:relative}
.tick{position:absolute;top:-7px;width:2px;height:18px;border-radius:1px}
.tick.entry{background:var(--faint)}
.tick.floor{background:var(--floor)}
.tick.cap{background:var(--cap)}
.mark{position:absolute;top:-4px;width:12px;height:12px;border-radius:50%;background:var(--live);box-shadow:0 0 0 3px rgba(255,255,255,.15);transform:translateX(-6px);transition:left .6s ease}
.raillabels{display:flex;justify-content:space-between;color:var(--faint);font-size:11px;margin-top:9px}
.legend{display:flex;gap:14px;font-size:11px;color:var(--dim);margin-top:7px;flex-wrap:wrap}
.legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.posline{color:var(--dim);font-size:13px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
.posline b{color:var(--ink);font-weight:600}
.posline .gain{color:var(--accent);font-weight:600}
.posline .loss{color:var(--floor);font-weight:600}
.protect{margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}
.hero{text-align:center;padding:2px 0 4px}
.hero .min{font-size:30px;font-weight:700;font-variant-numeric:tabular-nums}
.hero .min b{color:var(--accent)}
.hero .sweet{color:var(--dim);font-size:13px;margin-top:3px}
.hero .sweet b{color:var(--accent);font-weight:650}
.outcomes{display:flex;gap:8px;margin-top:12px}
.outcomes div{flex:1;background:var(--card2);border-radius:10px;padding:10px 10px;text-align:center}
.outcomes .n{font-weight:650;font-variant-numeric:tabular-nums;font-size:16px}
.outcomes .was{color:var(--faint);font-size:11px;text-decoration:line-through;margin-top:1px}
.outcomes .l{color:var(--dim);font-size:11px;margin-top:2px}
.togglerow{display:flex;justify-content:space-between;align-items:center;margin-top:14px}
.togglerow .t{font-weight:650}
.togglerow .d{color:var(--dim);font-size:12px;margin-top:2px}
.switch{position:relative;width:52px;height:30px;flex:none}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;inset:0;background:var(--line);border-radius:99px;cursor:pointer;transition:.25s}
.slider:before{content:"";position:absolute;left:3px;top:3px;width:24px;height:24px;border-radius:50%;background:var(--dim);transition:.25s}
input:checked + .slider{background:var(--accent)}
input:checked + .slider:before{background:var(--accent-ink);transform:translateX(22px)}
input:disabled + .slider{opacity:.45;cursor:default}
.protectedline{display:none;margin-top:12px;background:var(--card2);border-radius:10px;padding:11px 13px;font-size:14px;align-items:center;justify-content:space-between}
.protectedline.show{display:flex}
.protectedline b{color:var(--accent);font-weight:650}
.undo{background:none;border:1px solid var(--accent);color:var(--accent);border-radius:10px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;min-width:72px}
.hedge{margin-top:10px}
.hedge summary{cursor:pointer;color:var(--dim);font-size:13px;padding:7px 0;list-style:none}
.hedge summary::before{content:"\\25B8";margin-right:6px;font-size:11px}
.hedge[open] summary::before{content:"\\25BE"}
.legs{background:var(--card2);border-radius:10px;padding:10px 12px;font-size:12px;color:var(--dim)}
.legs .row{display:flex;justify-content:space-between;padding:3px 0;font-variant-numeric:tabular-nums;gap:12px}
.legs .row b{color:var(--ink);font-weight:600;text-align:right}
.refusal{display:none;margin-top:12px;background:var(--card2);border-left:3px solid var(--cap);border-radius:8px;padding:11px 13px;font-size:13px;color:var(--dim)}
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
.err{color:var(--floor);font-size:13px;padding:8px 2px;display:none}
.err.show{display:block}
@media(min-width:700px){.wrap{max-width:480px}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand">Atticus <span>· Earn &amp; Protect · events</span></div>
    <div class="simlabel">simulation · live pricing</div>
  </header>

  <div class="card" id="hero">
    <div class="eyebrow"><span class="dot"></span><span id="eyeline">loading live market…</span></div>
    <h1 id="title">&nbsp;</h1>
    <div class="chancerow">
      <span class="chance" id="chance">–</span>
      <span class="chancelbl">chance of yes</span>
      <span class="countd" id="countd">–</span>
    </div>

    <div class="railbox">
      <div class="rail" id="rail">
        <div class="tick entry" id="tickentry" style="left:0%"></div>
        <div class="tick floor" id="tickfloor" style="display:none"></div>
        <div class="tick cap" id="tickcap" style="display:none"></div>
        <div class="mark" id="markdot" style="left:0%"></div>
      </div>
      <div class="raillabels"><span>0%</span><span>100%</span></div>
      <div class="legend"><span><i style="background:var(--faint)"></i>your entry</span><span><i style="background:var(--live)"></i>now</span><span id="lgfloor" style="display:none"><i style="background:var(--floor)"></i>floor</span><span id="lgcap" style="display:none"><i style="background:var(--cap)"></i>cap</span></div>
    </div>

    <div class="posline" id="posline">&nbsp;</div>

    <div class="protect">
      <div class="hero" id="offer" style="display:none">
        <div class="min">leave with at least <b id="minout">–</b></div>
        <div class="sweet">plus a <b id="creditout">–</b> credit paid at resolution, win or lose</div>
      </div>

      <div class="outcomes" id="outcomes" style="display:none">
        <div><div class="n" id="oyes">–</div><div class="was" id="oyeswas">–</div><div class="l">if yes</div></div>
        <div><div class="n" id="ono">–</div><div class="was" id="onowas">–</div><div class="l">if no</div></div>
      </div>

      <div class="togglerow">
        <div><div class="t">Protect into resolution</div><div class="d" id="toggledesc">one tap · protected instantly</div></div>
        <label class="switch"><input type="checkbox" id="toggle" disabled /><span class="slider"></span></label>
      </div>

      <div class="protectedline" id="protectedline"><span>Protected · <b id="paysline">pays at resolution</b></span><button type="button" class="undo" id="undo">undo</button></div>

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
        <li><b>Real market, real hedge prices.</b> The event and its prices are live from Kalshi's public data. The protection terms are quoted from live listed OKX option books at executable depth.</li>
        <li><b>The trade you are making.</b> You give up the top slice of your win to guarantee you never leave empty-handed. The options market pays more for that slice than your floor costs; the difference is your credit.</li>
        <li><b>At resolution.</b> Win or lose, you get your outcome plus the credit. In an embedded deployment the venue's settlement rails net the cap the way funding payments already work.</li>
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
  var S={payload:null,phase:'idle',terms:null,marketTicker:null};
  var $=function(id){return document.getElementById(id)};
  function usd(c){return (c/100).toLocaleString('en-US',{style:'currency',currency:'USD'})}
  function pctpos(c){return Math.max(0,Math.min(100,c))+'%'}

  function fmtCountdown(iso){
    var ms=new Date(iso).getTime()-Date.now();
    if(ms<=0)return 'now';
    var m=Math.floor(ms/60000),h=Math.floor(m/60);
    return h>0?(h+'h '+(m%60)+'m'):(m+'m');
  }
  function fmtEt(iso){
    try{
      return new Date(iso).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}).toLowerCase().replace(' ','')+' ET';
    }catch(e){return 'resolution'}
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
    var o=outcomeTotals(q);
    $('minout').textContent=usd(o.no);
    $('creditout').textContent=usd(q.creditCents);
    $('oyes').textContent=usd(o.yes);
    $('oyeswas').textContent='was '+usd(o.nakedYes);
    $('ono').textContent=usd(o.no);
    $('onowas').textContent='was '+usd(o.nakedNo);
    $('offer').style.display='block';
    $('outcomes').style.display='flex';
    $('tickfloor').style.left=pctpos(q.floorCents);$('tickfloor').style.display='block';
    $('tickcap').style.left=pctpos(q.capCents);$('tickcap').style.display='block';
    $('lgfloor').style.display='inline';$('lgcap').style.display='inline';
    var takeLine=q.takeWaived?'take waived (de minimis)':('published take '+usd(q.takeCents)+' ('+(q.takeBps/100)+'% of credit sourced)');
    $('legs').innerHTML=
      '<div class="row"><span>terms</span><b>floor '+q.floorCents+'% · cap '+q.capCents+'% · credit '+usd(q.creditCents)+'</b></div>'+
      '<div class="row"><span>buy '+q.legs[0].contracts+'x</span><b>'+q.legs[0].instId+'</b></div>'+
      '<div class="row"><span>sell '+q.legs[1].contracts+'x</span><b>'+q.legs[1].instId+'</b></div>'+
      '<div class="row"><span>hedge tenor</span><b>'+(q.alignment==='expiry_aligned'?'expiry aligned':'unwound at resolution (estimate)')+'</b></div>'+
      '<div class="row"><span>venue fees</span><b>'+usd(q.feesCents)+'</b></div>'+
      '<div class="row"><span>economics</span><b>'+takeLine+'</b></div>'+
      '<div class="row"><span>fills</span><b>simulated fills at live quotes</b></div>';
    $('hedge').style.display='block';
  }

  function hideOffer(){
    $('offer').style.display='none';
    $('outcomes').style.display='none';
    $('hedge').style.display='none';
    $('tickfloor').style.display='none';$('tickcap').style.display='none';
    $('lgfloor').style.display='none';$('lgcap').style.display='none';
  }

  function render(){
    var p=S.payload; if(!p)return;
    $('err').classList.remove('show');
    if(!p.ok||!p.market){ $('eyeline').textContent='no quotable market open right now'; return; }
    var mk=p.market,pos=p.position,q=p.quote;
    if(S.marketTicker&&S.marketTicker!==mk.ticker&&S.phase!=='idle'){ resetSim(); }
    S.marketTicker=mk.ticker;

    $('eyeline').textContent='live · Kalshi '+mk.ticker+' · BTC '+Number(p.spotUsd).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
    $('title').textContent='Bitcoin '+mk.subtitle.toLowerCase()+' by '+fmtEt(mk.closeTime)+'?';
    $('chance').textContent=mk.markCents+'%';
    $('countd').textContent='resolves in '+fmtCountdown(mk.closeTime);
    $('tickentry').style.left=pctpos(pos.entryCents);
    $('markdot').style.left=pctpos(mk.markCents);

    var val=mk.markCents*pos.contracts, cost=pos.entryCents*pos.contracts, pnl=val-cost;
    var src=pos.entrySource==='real_print'?'entry from a real print':'entered now';
    $('posline').innerHTML='Your position (simulated · '+src+'): <b>'+pos.contracts+' yes</b> · in at <b>'+pos.entryCents+'%</b> · worth <b>'+usd(val)+'</b> <span class="'+(pnl>=0?'gain':'loss')+'">('+(pnl>=0?'+':'')+usd(pnl)+')</span>';

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
    $('paysline').textContent='pays at '+fmtEt(S.payload.market.closeTime);
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
    tk.innerHTML='<h3>Settlement · resolved '+(yes?'yes':'no')+' (simulated)</h3>'+
      '<div class="row"><span class="k">'+(yes?'cap':'floor')+' × '+t.contracts+'</span><span>'+usd((yes?t.capCents:t.floorCents)*t.contracts)+'</span></div>'+
      '<div class="row"><span class="k">credit</span><span>'+usd(t.creditCents)+'</span></div>'+
      '<div class="row total"><span class="k">with protection</span><span>'+usd(yes?o.yes:o.no)+'</span></div>'+
      '<div class="row"><span class="k">without protection</span><span>'+usd(yes?o.nakedYes:o.nakedNo)+'</span></div>';
    tk.classList.add('show');
  }

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
