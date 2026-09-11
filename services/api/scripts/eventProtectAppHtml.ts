/**
 * Earn & Protect - events: the showcase page.
 *
 * Design rules inherited from the retail surface: one accent per screen state,
 * sentence case everywhere except the honesty label, no em dashes in visible
 * copy, mobile-first at 390px, the toggle is the feature.
 *
 * Everything financial on this page is quoted live by the server; the position
 * and lifecycle are simulated and labeled. This file renders static HTML + a
 * small client that polls /api/showcase.
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
.eyebrow{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dim);margin-bottom:4px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--accent);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
h1{font-size:19px;line-height:1.3;font-weight:650;margin-bottom:2px}
.sub{color:var(--dim);font-size:13px;margin-bottom:14px}
.posrow{display:flex;justify-content:space-between;align-items:baseline;padding:10px 0;border-top:1px solid var(--line)}
.posrow .k{color:var(--dim);font-size:13px}
.posrow .v{font-variant-numeric:tabular-nums;font-weight:600}
.gain{color:var(--accent)}
.loss{color:var(--floor)}
.railbox{padding:22px 6px 4px;position:relative}
.rail{height:4px;border-radius:2px;background:var(--line);position:relative}
.tick{position:absolute;top:-7px;width:2px;height:18px;border-radius:1px}
.tick.entry{background:var(--faint)}
.tick.floor{background:var(--floor)}
.tick.cap{background:var(--cap)}
.mark{position:absolute;top:-4px;width:12px;height:12px;border-radius:50%;background:var(--live);box-shadow:0 0 0 3px rgba(255,255,255,.15);transform:translateX(-6px);transition:left .6s ease}
.raillabels{display:flex;justify-content:space-between;color:var(--faint);font-size:11px;margin-top:10px}
.legend{display:flex;gap:14px;font-size:11px;color:var(--dim);margin-top:8px;flex-wrap:wrap}
.legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.togglerow{display:flex;justify-content:space-between;align-items:center;margin-top:16px;padding-top:14px;border-top:1px solid var(--line)}
.togglerow .t{font-weight:650}
.togglerow .d{color:var(--dim);font-size:12px;margin-top:2px}
.switch{position:relative;width:52px;height:30px;flex:none}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;inset:0;background:var(--line);border-radius:99px;cursor:pointer;transition:.25s}
.slider:before{content:"";position:absolute;left:3px;top:3px;width:24px;height:24px;border-radius:50%;background:var(--dim);transition:.25s}
input:checked + .slider{background:var(--accent)}
input:checked + .slider:before{background:var(--accent-ink);transform:translateX(22px)}
.quote{display:none;margin-top:14px;border-top:1px solid var(--line);padding-top:14px}
.quote.show{display:block}
.credit-hero{text-align:center;padding:6px 0 12px}
.credit-hero .amt{font-size:34px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--accent)}
.credit-hero .lbl{color:var(--dim);font-size:12px;margin-top:2px}
.trio{display:flex;gap:8px}
.trio div{flex:1;background:var(--card2);border-radius:10px;padding:9px 10px;text-align:center}
.trio .n{font-weight:650;font-variant-numeric:tabular-nums}
.trio .l{color:var(--dim);font-size:11px;margin-top:1px}
.cta{display:block;width:100%;margin-top:14px;background:var(--accent);color:var(--accent-ink);border:0;border-radius:12px;padding:13px;font-size:15px;font-weight:700;cursor:pointer}
.cta[disabled]{opacity:.5;cursor:default}
.status{display:none;margin-top:14px;border-top:1px solid var(--line);padding-top:12px}
.status.show{display:block}
.stage{display:flex;align-items:center;gap:9px;padding:5px 0;font-size:13px;color:var(--dim)}
.stage.on{color:var(--ink)}
.stage .b{width:8px;height:8px;border-radius:50%;background:var(--line);flex:none}
.stage.on .b{background:var(--accent)}
.legs{margin-top:8px;background:var(--card2);border-radius:10px;padding:10px 12px;font-size:12px;color:var(--dim)}
.legs .row{display:flex;justify-content:space-between;padding:3px 0;font-variant-numeric:tabular-nums}
.legs .row b{color:var(--ink);font-weight:600}
.refusal{display:none;margin-top:14px;background:var(--card2);border-left:3px solid var(--cap);border-radius:8px;padding:11px 13px;font-size:13px;color:var(--dim)}
.refusal.show{display:block}
.refusal b{color:var(--ink)}
.ticket{display:none;margin-top:14px;background:var(--card2);border:1px solid var(--line);border-radius:12px;padding:14px}
.ticket.show{display:block}
.ticket h3{font-size:13px;color:var(--dim);font-weight:600;margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em}
.ticket .row{display:flex;justify-content:space-between;padding:4px 0;font-variant-numeric:tabular-nums;font-size:14px}
.ticket .row .k{color:var(--dim)}
.ticket .total{border-top:1px solid var(--line);margin-top:6px;padding-top:8px;font-weight:700}
.how{margin-top:4px}
.how summary{cursor:pointer;color:var(--dim);font-size:13px;padding:8px 0}
.how li{margin:7px 0 7px 18px;color:var(--dim);font-size:13px}
.how li b{color:var(--ink);font-weight:600}
footer{color:var(--faint);font-size:11.5px;line-height:1.55;padding:14px 4px 0}
footer b{color:var(--dim);font-weight:600}
.count{font-variant-numeric:tabular-nums}
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
    <div class="sub" id="sub">&nbsp;</div>

    <div class="posrow"><span class="k">Your position <span id="possrc">(simulated)</span></span><span class="v" id="poscontracts">–</span></div>
    <div class="posrow"><span class="k">Entry → now</span><span class="v"><span id="entry">–</span> → <span id="mark">–</span></span></div>
    <div class="posrow"><span class="k">Unrealized</span><span class="v" id="unreal">–</span></div>

    <div class="railbox">
      <div class="rail" id="rail">
        <div class="tick entry" id="tickentry" style="left:0%"></div>
        <div class="tick floor" id="tickfloor" style="display:none"></div>
        <div class="tick cap" id="tickcap" style="display:none"></div>
        <div class="mark" id="markdot" style="left:0%"></div>
      </div>
      <div class="raillabels"><span>0¢</span><span>chance it resolves yes</span><span>100¢</span></div>
      <div class="legend"><span><i style="background:var(--faint)"></i>entry</span><span><i style="background:var(--live)"></i>live</span><span id="lgfloor" style="display:none"><i style="background:var(--floor)"></i>floor</span><span id="lgcap" style="display:none"><i style="background:var(--cap)"></i>cap</span></div>
    </div>

    <div class="togglerow">
      <div><div class="t">Protect into resolution</div><div class="d" id="toggledesc">one tap · floor + credit · resolves <span class="count" id="countdown">–</span></div></div>
      <label class="switch"><input type="checkbox" id="toggle" disabled /><span class="slider"></span></label>
    </div>

    <div class="refusal" id="refusal"></div>

    <div class="quote" id="quote">
      <div class="credit-hero"><div class="amt" id="creditamt">$0.00</div><div class="lbl">credit paid at resolution · live listed-market quote</div></div>
      <div class="trio">
        <div><div class="n" id="qfloor">–</div><div class="l">floor if no</div></div>
        <div><div class="n" id="qmark">–</div><div class="l">now</div></div>
        <div><div class="n" id="qcap">–</div><div class="l">cap if yes</div></div>
      </div>
      <button class="cta" id="confirm">Protect this position (simulated)</button>
    </div>

    <div class="status" id="status">
      <div class="stage" id="st1"><span class="b"></span><span>Quote locked from live OKX books</span></div>
      <div class="stage" id="st2"><span class="b"></span><span>Hedge legs placed (simulated fills at live quotes)</span></div>
      <div class="stage" id="st3"><span class="b"></span><span>Active · credit unlocks at resolution</span></div>
      <div class="legs" id="legs"></div>
    </div>

    <div class="ticket" id="ticket"></div>
  </div>

  <div class="card how">
    <details>
      <summary>How this works</summary>
      <ul>
        <li><b>Real market, real hedge prices.</b> The event and its prices are live from Kalshi's public data. The hedge legs are live listed OKX option books, quoted at executable depth.</li>
        <li><b>The structure.</b> A floor below the current price and a cap above it. The cap slice funds the floor; what is left over is your credit. When the books cannot fund a credit, we refuse and say why.</li>
        <li><b>At resolution.</b> Resolves no: you get the floor plus the credit instead of zero. Resolves yes: you get the cap plus the credit. In an embedded deployment the venue's settlement rails net the cap the way funding payments already work.</li>
        <li><b>Honest economics.</b> We keep a published share of the credit we source, waived when tiny. Nothing is embedded in your terms.</li>
        <li><b>Read only.</b> This demonstration holds no keys, places no orders, and cannot move funds.</li>
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
  function cents(c){return (c/100).toLocaleString('en-US',{style:'currency',currency:'USD'})}
  function cc(c){return c+'\\u00a2'}
  function pct(c){return Math.max(0,Math.min(100,c))+'%'}

  function fmtCountdown(iso){
    var ms=new Date(iso).getTime()-Date.now();
    if(ms<=0)return 'now';
    var m=Math.floor(ms/60000),h=Math.floor(m/60);
    return h>0?('in '+h+'h '+(m%60)+'m'):('in '+m+'m');
  }

  function render(){
    var p=S.payload; if(!p)return;
    $('err').classList.remove('show');
    if(!p.ok||!p.market){ $('eyeline').textContent='no quotable market open right now'; return; }
    var mk=p.market,pos=p.position,q=p.quote;
    if(S.marketTicker&&S.marketTicker!==mk.ticker&&S.phase!=='idle'){ resetSim(); }
    S.marketTicker=mk.ticker;

    $('eyeline').textContent='live · Kalshi '+mk.ticker+' · BTC '+Number(p.spotUsd).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
    $('title').textContent=mk.title.replace(/\\?$/,'')+': '+mk.subtitle+'?';
    $('sub').textContent='resolves '+fmtCountdown(mk.closeTime)+' on the BRTI fixing · yes '+cc(mk.yesBidCents)+' / '+cc(mk.yesAskCents);
    $('poscontracts').textContent=pos.contracts+' yes contracts';
    $('possrc').textContent=pos.entrySource==='real_print'?'(simulated · entry from a real print)':'(simulated · entered now)';
    $('entry').textContent=cc(pos.entryCents);
    $('mark').textContent=cc(mk.markCents);
    var pnl=(mk.markCents-pos.entryCents)*pos.contracts;
    var u=$('unreal');u.textContent=(pnl>=0?'+':'')+cents(pnl);u.className='v '+(pnl>=0?'gain':'loss');
    $('tickentry').style.left=pct(pos.entryCents);
    $('markdot').style.left=pct(mk.markCents);
    $('countdown').textContent=fmtCountdown(mk.closeTime);

    var t=$('toggle');
    if(S.phase==='idle'){
      if(q&&q.ok){ t.disabled=false; $('refusal').classList.remove('show'); }
      else if(q){ t.disabled=true; t.checked=false;
        $('refusal').innerHTML='<b>Not quotable right now.</b> '+q.detail+' Refusing honestly beats mispricing.';
        $('refusal').classList.add('show');
      }
    }
    if(S.phase==='quoted'&&q&&q.ok){ paintQuote(q); }
    if((S.phase==='active'||S.phase==='executing')&&S.terms){
      if(new Date(mk.closeTime).getTime()<=Date.now()){ settle(mk); }
    }
  }

  function paintQuote(q){
    S.terms=q;
    $('creditamt').textContent=cents(q.creditCents);
    $('qfloor').textContent=cc(q.floorCents);
    $('qmark').textContent=cc(q.markCents);
    $('qcap').textContent=cc(q.capCents);
    $('tickfloor').style.left=pct(q.floorCents);$('tickfloor').style.display='block';
    $('tickcap').style.left=pct(q.capCents);$('tickcap').style.display='block';
    $('lgfloor').style.display='inline';$('lgcap').style.display='inline';
    $('quote').classList.add('show');
    var takeLine=q.takeWaived?'take waived (de minimis)':('published take '+cents(q.takeCents)+' ('+(q.takeBps/100)+'% of credit sourced)');
    $('legs').innerHTML=
      '<div class="row"><span>buy '+q.legs[0].contracts+'x</span><b>'+q.legs[0].instId+'</b></div>'+
      '<div class="row"><span>sell '+q.legs[1].contracts+'x</span><b>'+q.legs[1].instId+'</b></div>'+
      '<div class="row"><span>hedge tenor</span><b>'+(q.alignment==='expiry_aligned'?'expiry aligned':'unwound at resolution (estimate)')+'</b></div>'+
      '<div class="row"><span>venue fees</span><b>'+cents(q.feesCents)+'</b></div>'+
      '<div class="row"><span>economics</span><b>'+takeLine+'</b></div>';
  }

  function resetSim(){
    S.phase='idle';S.terms=null;
    $('toggle').checked=false;
    $('quote').classList.remove('show');
    $('status').classList.remove('show');
    $('ticket').classList.remove('show');
    ['st1','st2','st3'].forEach(function(id){$(id).classList.remove('on')});
    $('tickfloor').style.display='none';$('tickcap').style.display='none';
    $('lgfloor').style.display='none';$('lgcap').style.display='none';
  }

  $('toggle').addEventListener('change',function(e){
    if(!e.target.checked){ resetSim(); return; }
    var q=S.payload&&S.payload.quote;
    if(q&&q.ok){ S.phase='quoted'; paintQuote(q); }
    else { e.target.checked=false; }
  });

  $('confirm').addEventListener('click',function(){
    if(S.phase!=='quoted')return;
    S.phase='executing';
    $('quote').classList.remove('show');
    $('status').classList.add('show');
    $('st1').classList.add('on');
    setTimeout(function(){$('st2').classList.add('on')},900);
    setTimeout(function(){$('st3').classList.add('on');S.phase='active'},2100);
  });

  function settle(mk){
    S.phase='settled';
    var t=S.terms,yes=mk.markCents>=50; // sim: settle on last observed side
    var payout=yes?t.capCents:t.floorCents, naked=yes?100:0;
    var totalP=payout*t.contracts+t.creditCents, totalN=naked*t.contracts;
    $('status').classList.remove('show');
    var tk=$('ticket');
    tk.innerHTML='<h3>Settlement · resolved '+(yes?'yes':'no')+' (simulated)</h3>'+
      '<div class="row"><span class="k">'+(yes?'cap':'floor')+' × '+t.contracts+'</span><span>'+cents(payout*t.contracts)+'</span></div>'+
      '<div class="row"><span class="k">credit</span><span>'+cents(t.creditCents)+'</span></div>'+
      '<div class="row total"><span class="k">with protection</span><span>'+cents(totalP)+'</span></div>'+
      '<div class="row"><span class="k">without protection</span><span>'+cents(totalN)+'</span></div>';
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
