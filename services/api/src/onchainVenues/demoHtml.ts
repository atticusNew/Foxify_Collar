/**
 * The on-chain demo page: a venue's positions list with our Lock in line under every row, in
 * two shells (a phone and a desktop table) and for each of the three venues as the host.
 *
 * The page is one static document. It reads the figures from `api/positions` beside itself
 * every 30 seconds (demo.ts makes them) and re-prices nothing: every amount it prints came
 * from the server, for the whole position, from the books as they were read.
 *
 * What a reader sees is the result: what closing now pays, where the position ends with the
 * lock, and the difference. Which venue the other side was priced on is not on the page.
 *
 * Links: ?view=mobile or ?view=desktop opens on that shell; ?venue=polymarket, sx_bet or
 * limitless opens on that host.
 */

import { DEMO_SIZES } from "./demo";
import { VENUES, VENUE_SHORT } from "./types";

export const DEMO_REFRESH_SEC = 30;

export function renderOnchainDemoHtml(): string {
  const homes = JSON.stringify(VENUES.map((v) => ({ venue: v, name: VENUE_SHORT[v] })));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<link rel="icon" href="data:,">
<title>Lock in · on-chain venues · demonstration</title>
<meta name="description" content="One tap. Any on-chain market. One Lock in line under every open position, priced against every venue read. Demonstration: positions are simulated, prices are live.">
<style>
:root{--bg:#0f1115;--card:#171a21;--card2:#1d212a;--line:#262b36;--ink:#f3f5f8;--dim:#9aa3b2;--faint:#6b7382;--up:#3ccf91;--accent:#3ccf91;--accent-ink:#06281a;--wash:rgba(60,207,145,.1);--stage:#eceef2;--stage-ink:#0f1115;--stage-dim:#5f6775;--gold:#C9A227}
*{box-sizing:border-box;margin:0;padding:0}
html,body{min-height:100%}
body{background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
button{font:inherit}
.pitch{display:none}
.ctl{display:flex;align-items:center;justify-content:center;gap:10px;padding:12px 12px 4px;flex-wrap:wrap}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:999px;padding:2px;background:var(--card);gap:2px}
.seg button{appearance:none;border:1px solid transparent;border-radius:999px;background:transparent;color:var(--dim);font-size:12.5px;font-weight:600;padding:5px 12px;cursor:pointer;white-space:nowrap}
.seg button[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.viewseg{display:none}
.shell{background:var(--bg);color:var(--ink);position:relative}
.host-top{padding:14px 16px 8px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.brand{font-weight:700;font-size:17px;letter-spacing:-.01em;display:flex;align-items:center;gap:8px}
.brand i{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:7px;background:var(--accent);color:var(--accent-ink);font-style:normal;font-size:12px;font-weight:800}
.stamp{font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}
.tabs{display:flex;gap:18px;padding:0 16px;border-bottom:1px solid var(--line)}
.tabs span{padding:8px 0 10px;font-size:14px;color:var(--faint);font-weight:600}
.tabs span.on{color:var(--ink);border-bottom:2px solid var(--accent)}
.sum{padding:10px 16px 0;font-size:12.5px;color:var(--dim)}
.sum b{color:var(--ink);font-weight:650}
.thead{display:none}
.list{padding:6px 12px 8px}
.pos{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px;margin:8px 0}
.pos.locked{border-color:var(--accent)}
.row{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:flex-start}
.c.name{flex:1 1 100%;min-width:0}
.c.name b{display:block;font-weight:650;font-size:15px;line-height:1.25}
.meta{display:block;color:var(--faint);font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta em{font-style:normal;color:var(--up);font-weight:700}
.c.f{font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums}
.c.f label{display:block}
.c.f b{display:block;color:var(--ink);font-weight:600;font-size:13px}
.line{display:flex;align-items:center;gap:10px;margin-top:10px;padding:8px 10px;border:1px solid var(--line);border-radius:12px;background:var(--card2);cursor:pointer}
.line .say{flex:1;min-width:0;font-size:13.5px;line-height:1.4;color:var(--ink);font-variant-numeric:tabular-nums}
.line .say b{font-weight:700}
.line .say .more{color:var(--up);font-weight:650;white-space:nowrap}
.line .say.off{color:var(--dim)}
.pbtn{appearance:none;border:1px solid var(--accent);border-radius:999px;padding:4px 11px;font-size:12.5px;font-weight:700;background:transparent;color:var(--accent);white-space:nowrap;display:inline-flex;align-items:center;gap:5px;cursor:pointer;flex:none}
.pbtn svg{width:12px;height:12px}
.pbtn.off{border-color:var(--line);color:var(--faint)}
.pbtn.done{background:var(--accent);color:var(--accent-ink)}
.chev{appearance:none;background:none;border:0;color:var(--faint);cursor:pointer;padding:2px 4px;flex:none;line-height:0}
.chev svg{width:14px;height:14px;transition:transform .15s}
.pos.open .chev svg{transform:rotate(180deg)}
.panel{margin-top:10px;padding:2px 2px 0}
.sizes{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--faint)}
.sizes button{appearance:none;border:1px solid var(--line);background:transparent;color:var(--dim);border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600;cursor:pointer;font-variant-numeric:tabular-nums}
.sizes button[aria-pressed="true"]{border-color:var(--ink);color:var(--ink)}
.cmp{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
.cmp .col{border:1px solid var(--line);border-radius:12px;padding:10px 12px;background:var(--bg)}
.cmp .col.win{border-color:var(--accent);background:var(--wash)}
.cmp h4{font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--faint)}
.cmp .col.win h4{color:var(--accent)}
.cmp .big{font-size:22px;font-weight:750;letter-spacing:-.01em;margin-top:4px;font-variant-numeric:tabular-nums}
.cmp p{font-size:12px;color:var(--dim);margin-top:2px;line-height:1.4}
.how{margin-top:10px;font-size:13px;font-variant-numeric:tabular-nums}
.how div{display:flex;justify-content:space-between;gap:12px;padding:5px 2px;border-bottom:1px solid var(--line);color:var(--dim)}
.how div:last-child{border-bottom:0}
.how dd{color:var(--ink);font-weight:600;white-space:nowrap}
.how dd.up{color:var(--up)}
.fine{margin-top:8px;font-size:11.5px;color:var(--faint);line-height:1.45}
.confirm{appearance:none;display:block;width:100%;margin-top:10px;border:0;border-radius:12px;padding:11px 14px;font-size:15px;font-weight:750;background:var(--accent);color:var(--accent-ink);cursor:pointer}
.undo{appearance:none;background:none;border:0;color:var(--faint);font-size:12px;cursor:pointer;padding:2px 4px;flex:none}
.undo:hover{text-decoration:underline}
.empty{padding:34px 18px;color:var(--faint);text-align:center;font-size:14px;line-height:1.5}
.host-note{padding:10px 16px calc(22px + env(safe-area-inset-bottom));text-align:center;color:var(--faint);font-size:11.5px;line-height:1.55}
.host-note span{display:block}
.host-note .pow{margin-top:4px}
.host-note .pow b{font-family:Georgia,"Times New Roman",serif;font-weight:400;color:var(--gold);font-size:13px;letter-spacing:.01em}
.toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,8px);background:var(--ink);color:var(--bg);font-size:12.5px;font-weight:600;padding:8px 14px;border-radius:999px;opacity:0;pointer-events:none;transition:opacity .16s,transform .16s;white-space:nowrap;z-index:5}
.toast.on{opacity:.96;transform:translate(-50%,0)}

@media (min-width:900px){
  body{background:var(--stage);color:var(--stage-ink)}
  .stage{display:grid;grid-template-columns:minmax(300px,380px) minmax(0,1fr);gap:48px;max-width:1320px;margin:0 auto;padding:34px 40px 48px;align-items:start}
  .pitch{display:block;position:sticky;top:34px}
  .pitch .wm{font-family:Georgia,"Times New Roman",serif;color:var(--gold);font-size:21px;letter-spacing:.01em}
  .pitch h1{margin-top:22px;font-size:34px;line-height:1.08;letter-spacing:-.02em;font-weight:750}
  .pitch .lede{margin-top:12px;font-size:16px;line-height:1.5;color:var(--stage-dim)}
  .pitch ul{list-style:none;margin-top:20px;display:grid;gap:12px}
  .pitch li{position:relative;padding-left:22px;font-size:14.5px;line-height:1.45;color:var(--stage-dim)}
  .pitch li:before{content:"";position:absolute;left:2px;top:7px;width:8px;height:8px;border-radius:50%;background:#00b67a}
  .pitch li b{color:var(--stage-ink);font-weight:650}
  .pitch .try{margin-top:22px;font-size:14.5px;font-weight:650}
  .pitch .try b{color:#00915f}
  .pitch .small{margin-top:20px;font-size:12px;line-height:1.55;color:var(--stage-dim)}
  .ctl{padding:0 0 14px}
  .ctl .seg{background:#fff;border-color:#dfe2e8}
  .ctl .seg button{color:var(--stage-dim)}
  .ctl .seg button[aria-pressed="true"]{background:var(--stage-ink);color:#fff;border-color:var(--stage-ink)}
  .viewseg{display:inline-flex}
  .shell{margin:0 auto;border-radius:18px;box-shadow:0 18px 50px rgba(15,17,21,.18);overflow:hidden}
  .shell[data-view="mobile"]{width:400px;border-radius:38px;border:1px solid rgba(255,255,255,.14);outline:8px solid #0b0c0f}
  .shell[data-view="mobile"] .scroll{height:720px;overflow-y:auto}
  .shell[data-view="desktop"]{width:100%;max-width:900px}
  .shell[data-view="desktop"] .scroll{max-height:760px;overflow-y:auto}
  .shell[data-view="desktop"] .host-top{padding:16px 22px 10px}
  .shell[data-view="desktop"] .tabs{padding:0 22px}
  .shell[data-view="desktop"] .sum{padding:12px 22px 0}
  .shell[data-view="desktop"] .thead{display:grid;grid-template-columns:minmax(0,2.4fr) repeat(4,minmax(0,1fr));gap:14px;padding:14px 22px 6px;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--faint)}
  .shell[data-view="desktop"] .list{padding:0 10px 8px}
  .shell[data-view="desktop"] .pos{background:transparent;border:0;border-bottom:1px solid var(--line);border-radius:0;margin:0;padding:12px 12px 14px}
  .shell[data-view="desktop"] .pos.locked{border-color:var(--line)}
  .shell[data-view="desktop"] .pos.locked .line{border-color:var(--accent)}
  .shell[data-view="desktop"] .row{display:grid;grid-template-columns:minmax(0,2.4fr) repeat(4,minmax(0,1fr));gap:14px;align-items:center}
  .shell[data-view="desktop"] .c.f label{display:none}
  .shell[data-view="desktop"] .c.f b{font-size:14px;font-weight:500}
  .shell[data-view="desktop"] .panel{max-width:620px}
  .toast{bottom:40px}
}
</style>
</head>
<body>
<div class="stage">
<aside class="pitch">
  <div class="wm">Atticus</div>
  <h1>One tap. Any on-chain market.</h1>
  <p class="lede">One line under every open position. Your trader locks in where a position ends, whatever the result, without leaving your page. Priced against every venue we read.</p>
  <ul>
    <li><b>The trader stays on your page.</b></li>
    <li><b>Every venue priced, every time.</b> The line is offered when it beats closing on your own book.</li>
    <li><b>Sized to the position.</b> Every figure is for the whole position at the prices resting now, each venue's fee in.</li>
    <li><b>Said plainly when it does not help.</b> When closing on your book pays more, the row says so.</li>
  </ul>
  <p class="try">Tap <b>Lock in</b> on any row. Switch the venue or the view above the screen.</p>
  <p class="small">Demonstration. Positions are simulated; prices are live and are read again every ${DEMO_REFRESH_SEC} seconds. Nothing is bought. Each venue's published fee is in every figure; Atticus's own fee is not. A lock holds when every venue settles the game on the same result. Not affiliated with or endorsed by any venue.</p>
</aside>
<main class="demo">
  <div class="ctl">
    <div class="seg viewseg" role="group" aria-label="View"><button type="button" data-view="mobile" aria-pressed="false">Mobile</button><button type="button" data-view="desktop" aria-pressed="false">Desktop</button></div>
    <div class="seg homeseg" role="group" aria-label="Venue" id="homeseg"></div>
  </div>
  <div class="shell" id="shell" data-view="mobile">
    <div class="scroll">
      <div class="host-top"><div class="brand"><i id="mark">Y</i><span id="brand">Your venue</span></div><div class="stamp" id="stamp"></div></div>
      <div class="tabs"><span>Markets</span><span class="on">Positions</span><span>Activity</span></div>
      <div class="sum" id="sum"></div>
      <div class="thead"><span>Position</span><span>Shares</span><span>Price</span><span>Pays</span><span>Close now</span></div>
      <div class="list" id="list"><div class="empty">Reading the venues.</div></div>
      <div class="host-note"><span>Demonstration. Simulated positions at live prices; nothing is bought.</span><span>Each venue's fee is in every figure; Atticus's own fee is not.</span><span>Not affiliated with or endorsed by any venue.</span><span class="pow">Powered by <b>Atticus</b></span></div>
    </div>
  </div>
</main>
</div>
<div class="toast" id="toast"></div>
<script>
(function(){
  var HOMES=${homes};
  var SIZES=${JSON.stringify([...DEMO_SIZES])};
  var API=location.pathname.replace(/\\/+$/,'')+'/api/positions';
  var S={data:null,home:null,view:'mobile',open:null,size:{},locked:{},failed:false};
  var $=function(id){return document.getElementById(id)};
  var esc=function(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
  var usd=function(c){var n=Math.abs(c),d=Math.floor(n/100),r=String(n%100);if(r.length<2)r='0'+r;return (c<0?'-':'')+'$'+String(d).replace(/\\B(?=(\\d{3})+(?!\\d))/g,',')+'.'+r};
  var num=function(n){return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g,',')};
  var SHIELD='<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1 2.5 3v4.3c0 3.3 2.3 6.2 5.5 7.2 3.2-1 5.5-3.9 5.5-7.2V3L8 1Zm2.9 5.3-3.3 3.6a.6.6 0 0 1-.9 0L5.1 8.2a.6.6 0 1 1 .9-.8l1.1 1.2 2.9-3.1a.6.6 0 1 1 .9.8Z"/></svg>';
  var CHEV='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';

  function when(iso){
    var t=Date.parse(iso);if(!isFinite(t))return '';
    if(t<=Date.now())return '<em>Live</em>';
    try{return esc(new Date(t).toLocaleString([], {weekday:'short',hour:'numeric',minute:'2-digit'}))}catch(e){return ''}
  }
  function homeOf(v){var hs=S.data?S.data.homes:[];for(var i=0;i<hs.length;i++)if(hs[i].venue===v)return hs[i];return null}
  function nameOf(v){for(var i=0;i<HOMES.length;i++)if(HOMES[i].venue===v)return HOMES[i].name;return 'Your venue'}
  function quoteAt(p){
    if(S.locked[p.id])return S.locked[p.id];
    var want=S.size[p.id]||p.shares;
    for(var i=0;i<p.quotes.length;i++)if(p.quotes[i].shares===want)return p.quotes[i];
    return p.quotes[0];
  }
  function say(p,q,brand){
    if(S.locked[p.id])return '<span class="say">Locked in. Ends at <b>'+usd(q.lockedCents)+'</b> whatever the result.</span><button type="button" class="undo" data-act="undo">undo</button>';
    if(q.state==='lock')return '<span class="say">Whatever the result, end at <b>'+usd(q.lockedCents)+'</b>. <span class="more">'+usd(q.moreCents)+' more than closing now</span></span>';
    if(q.state==='lock_only')return '<span class="say">Whatever the result, end at <b>'+usd(q.lockedCents)+'</b>. '+esc(brand)+' takes '+num(q.closeShares)+' of the '+num(q.shares)+' shares now.</span>';
    if(q.state==='close_pays_more')return '<span class="say off">Closing now pays '+(q.moreCents===0?'the same':'more')+': <b>'+usd(q.closeCents)+'</b>.</span>';
    return '<span class="say off">No lock at this size right now.</span>';
  }
  function panel(p,q,brand){
    var h='<div class="panel"><div class="sizes"><span>Position size</span>';
    for(var i=0;i<SIZES.length;i++)h+='<button type="button" data-act="size" data-size="'+SIZES[i]+'" aria-pressed="'+(SIZES[i]===q.shares)+'">'+num(SIZES[i])+'</button>';
    h+='<span>shares</span></div>';
    var close=q.closeCents===null?'<div class="big">'+num(q.closeShares)+' of '+num(q.shares)+'</div><p>shares are all its book takes now.</p>':'<div class="big">'+usd(q.closeCents)+'</div><p>Paid today.</p>';
    var lock=q.lockedCents===null?'<div class="big">None</div><p>The other side is not all on offer for this size.</p>':'<div class="big">'+usd(q.lockedCents)+'</div><p>Where the position ends, whatever the result.</p>';
    h+='<div class="cmp"><div class="col"><h4>Close now on '+esc(brand)+'</h4>'+close+'</div><div class="col'+(q.state==='lock'||q.state==='lock_only'?' win':'')+'"><h4>Lock in</h4>'+lock+'</div></div>';
    if(q.lockedCents!==null){
      h+='<dl class="how"><div><dt>The other side, bought today</dt><dd>'+usd(q.coverCents)+'</dd></div><div><dt>Paid at the result, whatever it is</dt><dd>'+usd(q.payoutCents)+'</dd></div><div><dt>The position ends at</dt><dd>'+usd(q.lockedCents)+'</dd></div>';
      if(q.moreCents!==null)h+='<div><dt>Against closing now</dt><dd'+(q.moreCents>0?' class="up"':'')+'>'+(q.moreCents>0?'+':'')+usd(q.moreCents)+'</dd></div>';
      h+='</dl>';
    }
    h+='<p class="fine">Priced on '+p.venues+' venues, for the whole position, at the prices resting when they were read. Each venue\\'s fee is in. It holds when every venue settles the game on the same result.</p>';
    if(q.state==='lock'||q.state==='lock_only')h+='<button type="button" class="confirm" data-act="confirm">Lock in '+usd(q.lockedCents)+'</button>';
    return h+'</div>';
  }
  function render(){
    var shell=$('shell');shell.setAttribute('data-view',S.view);
    var vb=document.querySelectorAll('.viewseg button');for(var i=0;i<vb.length;i++)vb[i].setAttribute('aria-pressed',String(vb[i].getAttribute('data-view')===S.view));
    var seg='';for(var j=0;j<HOMES.length;j++)seg+='<button type="button" data-home="'+HOMES[j].venue+'" aria-pressed="'+(HOMES[j].venue===S.home)+'">'+esc(HOMES[j].name)+'</button>';
    $('homeseg').innerHTML=seg;
    var brand=nameOf(S.home);
    $('brand').textContent=brand;$('mark').textContent=brand.charAt(0);
    document.title=brand+' · Positions';
    var home=homeOf(S.home);
    var at=S.data&&S.data.at?Date.parse(S.data.at):0;
    $('stamp').textContent=S.failed?'Prices could not be read just now':at>0?'Prices read '+new Date(at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'}):'';
    if(!S.data||!S.data.at){$('sum').innerHTML='';$('list').innerHTML='<div class="empty">'+(S.failed?'The venues could not be read just now. This page tries again every ${DEMO_REFRESH_SEC} seconds.':'Reading the venues.')+'</div>';return}
    if(!home||!home.positions.length){$('sum').innerHTML='';$('list').innerHTML='<div class="empty">No game on '+esc(brand)+' is also listed on another of the venues right now.</div>';return}
    var h='';
    for(var k=0;k<home.positions.length;k++){
      var p=home.positions[k],q=quoteAt(p),locked=!!S.locked[p.id],offer=q.state==='lock'||q.state==='lock_only';
      h+='<div class="pos'+(locked?' locked':'')+(S.open===p.id?' open':'')+'" data-id="'+esc(p.id)+'"><div class="row">'+
        '<div class="c name"><b>'+esc(p.pick)+'</b><span class="meta">'+esc(p.competition)+' · '+esc(p.matchup)+' · '+when(p.startsAt)+'</span></div>'+
        '<div class="c f"><label>Shares</label><b>'+num(q.shares)+'</b></div>'+
        '<div class="c f"><label>Price</label><b>'+(Math.round(p.priceCents*10)/10)+'\\u00a2</b></div>'+
        '<div class="c f"><label>Pays</label><b>'+usd(q.payoutCents)+'</b></div>'+
        '<div class="c f"><label>Close now</label><b>'+(q.closeCents===null?num(q.closeShares)+' of '+num(q.shares):usd(q.closeCents))+'</b></div></div>'+
        '<div class="line" data-act="toggle"><button type="button" class="pbtn'+(locked?' done':offer?'':' off')+'" data-act="toggle">'+SHIELD+(locked?'Locked':'Lock in')+'</button>'+say(p,q,brand)+(locked?'':'<button type="button" class="chev" data-act="toggle" aria-label="Details">'+CHEV+'</button>')+'</div>'+
        (S.open===p.id&&!locked?panel(p,q,brand):'')+'</div>';
    }
    $('sum').innerHTML='Right now the line beats closing on <b>'+num(home.offered)+' of '+num(home.total)+'</b> open positions.'+(home.total>home.positions.length?' Showing '+home.positions.length+'.':'');
    $('list').innerHTML=h;
  }
  function find(id){var home=homeOf(S.home);if(!home)return null;for(var i=0;i<home.positions.length;i++)if(home.positions[i].id===id)return home.positions[i];return null}
  var toastT=null;
  function toast(text){var t=$('toast');t.textContent=text;t.className='toast on';clearTimeout(toastT);toastT=setTimeout(function(){t.className='toast'},2200)}

  $('list').addEventListener('click',function(e){
    var el=e.target;while(el&&el!==this&&!el.getAttribute('data-act'))el=el.parentNode;
    if(!el||el===this)return;
    var row=el;while(row&&!row.getAttribute('data-id'))row=row.parentNode;
    if(!row)return;
    var id=row.getAttribute('data-id'),p=find(id),act=el.getAttribute('data-act');
    if(!p)return;
    if(act==='size'){S.size[id]=Number(el.getAttribute('data-size'))}
    else if(act==='confirm'){var q=quoteAt(p);if(q.lockedCents!==null){S.locked[id]=q;S.open=null;toast('Locked in at '+usd(q.lockedCents)+'. Demonstration: nothing was bought.')}}
    else if(act==='undo'){delete S.locked[id]}
    else if(act==='toggle'){if(S.locked[id])return;S.open=S.open===id?null:id}
    e.stopPropagation();render();
  });
  document.querySelector('.ctl').addEventListener('click',function(e){
    var b=e.target;if(!b||b.tagName!=='BUTTON')return;
    var v=b.getAttribute('data-view'),h=b.getAttribute('data-home');
    if(v)S.view=v;
    if(h){S.home=h;S.open=null}
    render();
  });

  function load(){
    fetch(API,{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error(String(r.status));return r.json()}).then(function(d){
      S.data=d;S.failed=false;
      if(!S.home){
        var best=null;for(var i=0;i<d.homes.length;i++)if(!best||d.homes[i].positions.length>best.positions.length)best=d.homes[i];
        S.home=best?best.venue:HOMES[0].venue;
      }
      render();
    }).catch(function(){S.failed=true;if(!S.home)S.home=HOMES[0].venue;render()});
  }
  var qs=location.search;
  var wide=window.matchMedia&&window.matchMedia('(min-width:900px)').matches;
  S.view=!wide?'mobile':/[?&]view=mobile\\b/i.test(qs)?'mobile':'desktop';
  var m=/[?&]venue=([a-z_]+)/i.exec(qs);
  if(m)for(var i=0;i<HOMES.length;i++)if(HOMES[i].venue===m[1].toLowerCase())S.home=HOMES[i].venue;
  render();load();setInterval(load,${DEMO_REFRESH_SEC * 1000});
})();
</script>
</body>
</html>`;
}
