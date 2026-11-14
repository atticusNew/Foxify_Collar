/**
 * The on-chain demo page: a venue's own positions page with our Lock in button on every row,
 * in two shells (a phone and a desktop table), for each of the three venues as the host.
 *
 * Each host is drawn in its own colours and its own words, read from its public site on
 * 13 November 2026: Polymarket a white page with a blue button and prices in cents, SX Bet a
 * dark navy page with a blue-to-green outlined button and decimal odds, Limitless a white page
 * with a lime button. A venue is named in text only: no logo and no mark of theirs is drawn.
 *
 * The page is one static document. It reads the figures from `api/positions` beside itself
 * every 30 seconds (demo.ts makes them) and prices nothing itself.
 *
 * What a reader sees is a position, what it is worth now, and what Lock in pays. How that is
 * arrived at is not on the page.
 *
 * A tap on Lock in runs a short progress (a spinner and three words, a few seconds) before the
 * row reads locked. Nothing is priced or placed in that time: it is the wait a real lock has.
 *
 * A locked row has the same Details toggle. It opens a receipt of what was done: the amount
 * locked, that it is paid at settlement and is the same if the pick wins or loses, what closing
 * paid at that moment, the difference, and when. Nothing in it says how the lock was made.
 *
 * The founder's contact (email and Telegram) is on the page: beside the screen on a desktop,
 * under it on a phone, with a "Talk to us" link at the top of a phone that jumps to it.
 *
 * It opens on the phone. Links: ?view=desktop opens on the desktop table (on a wide screen);
 * ?venue=polymarket, sx_bet or limitless opens on that host.
 */

import { VENUES, VENUE_SHORT, type Venue } from "./types";

export const DEMO_REFRESH_SEC = 30;
/** the words the Lock in button shows while a lock runs, in order */
export const DEMO_LOCK_STAGES = ["Pricing", "Executing", "Confirming"] as const;
/** how long each word stays, in milliseconds, before a little jitter */
export const DEMO_STAGE_MS = 800;
export const DEMO_CONTACT_EMAIL = "michael@atticustrade.com";
export const DEMO_CONTACT_TELEGRAM = "willialso";

const MAILTO = `mailto:${DEMO_CONTACT_EMAIL}?subject=${encodeURIComponent("Lock in on-chain demo")}`;
const TELEGRAM = `https://t.me/${DEMO_CONTACT_TELEGRAM}`;
const contactHtml = (id: string): string =>
  `<div class="contact"${id ? ` id="${id}"` : ""}><b>Talk to us</b><p>Add Lock in to your venue.</p>` +
  `<div class="cbtns"><a href="${MAILTO}">Email</a><a class="alt" href="${TELEGRAM}" target="_blank" rel="noopener noreferrer">Telegram</a></div>` +
  `<small>${DEMO_CONTACT_EMAIL} · @${DEMO_CONTACT_TELEGRAM}</small></div>`;

interface HostLook {
  /** the top bar's tabs, and which one is open */
  nav: string[];
  on: number;
  /** what the venue calls the page */
  title: string;
  /** the five column heads: the position, its price, what was paid, what it pays, what it is worth */
  cols: [string, string, string, string, string];
  /** true when the venue shows decimal odds rather than a price in cents */
  odds: boolean;
}

const LOOK: Record<Venue, HostLook> = {
  polymarket: { nav: ["Markets", "Portfolio", "Activity"], on: 1, title: "Portfolio", cols: ["Market", "Avg \u2192 Now", "Bet", "To win", "Value"], odds: false },
  sx_bet: { nav: ["Sports", "My bets", "Activity"], on: 1, title: "My bets", cols: ["Bet", "Odds", "Stake", "Payout", "Value"], odds: true },
  limitless: { nav: ["Markets", "Portfolio", "Leaderboard"], on: 1, title: "Portfolio", cols: ["Market", "Entry \u2192 Now", "Invested", "To win", "Value"], odds: false },
};

export function renderOnchainDemoHtml(): string {
  const hosts = JSON.stringify(VENUES.map((v) => ({ venue: v, name: VENUE_SHORT[v], ...LOOK[v] })));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<link rel="icon" href="data:,">
<title>Lock in · on-chain venues · demonstration</title>
<meta name="description" content="One tap. Any on-chain market. A Lock in button on every open position, on the venue's own page. Demonstration: positions are simulated, prices are live.">
<style>
:root{--stage:#eceef2;--stage-ink:#0f1115;--stage-dim:#5f6775;--gold:#C9A227}
[data-host="polymarket"]{--bg:#fff;--card:#fff;--card2:#f4f5f7;--line:#e6e8ec;--ink:#23272d;--dim:#6b7280;--faint:#9aa1ad;--accent:#2e5cff;--accent-ink:#fff;--tab:#23272d;--up:#1a9d57;--down:#e23c3c;--upwash:rgba(26,157,87,.08);--r:9px;--font:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
[data-host="sx_bet"]{--bg:#12161f;--card:#191e2a;--card2:#212736;--line:#2b3245;--ink:#f0f3f9;--dim:#828ba1;--faint:#5f6880;--accent:#2196f3;--accent-ink:#fff;--tab:#2196f3;--up:#36c98e;--down:#ff4d4d;--upwash:rgba(54,201,142,.1);--r:10px;--font:Poppins,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
[data-host="limitless"]{--bg:#fff;--card:#fff;--card2:#f5f5f5;--line:#e5e5e5;--ink:#000;--dim:#737373;--faint:#a3a3a3;--accent:#c3ff00;--accent-ink:#000;--tab:#000;--up:#16a34a;--down:#ef4444;--upwash:rgba(22,163,74,.08);--r:8px;--font:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
html,body{min-height:100%}
body{background:var(--bg);color:var(--ink);font:15px/1.45 var(--font);-webkit-font-smoothing:antialiased}
button{font:inherit}
.pitch{display:none}
.ctl{display:flex;align-items:center;justify-content:center;gap:10px;padding:12px 12px 4px;flex-wrap:wrap}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:999px;padding:2px;background:var(--card2);gap:2px}
.seg button{appearance:none;border:0;border-radius:999px;background:transparent;color:var(--dim);font-size:12.5px;font-weight:600;padding:5px 12px;cursor:pointer;white-space:nowrap}
.seg button[aria-pressed="true"]{background:var(--ink);color:var(--bg)}
.viewseg{display:none}
.shell{background:var(--bg);color:var(--ink);font-family:var(--font);position:relative}
.top{padding:14px 16px 0;display:flex;align-items:center;gap:8px 22px;flex-wrap:wrap}
.brand{font-weight:750;font-size:18px;letter-spacing:-.01em}
.nav{display:flex;gap:18px;order:3;flex:1 1 100%;border-bottom:1px solid var(--line)}
.nav span{padding:8px 0 10px;font-size:14px;color:var(--faint);font-weight:600}
.nav span.on{color:var(--ink);box-shadow:inset 0 -2px 0 var(--tab)}
.live{margin-left:auto;font-size:12px;color:var(--dim);display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.live i{width:7px;height:7px;border-radius:50%;background:var(--up)}
.live.off i{background:var(--faint)}
.ttl{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:16px 16px 4px}
.ttl h2{font-size:20px;font-weight:750;letter-spacing:-.01em}
.ttl span{font-size:13px;color:var(--dim);font-variant-numeric:tabular-nums}
.ttl span b{color:var(--ink);font-weight:650}
.thead{display:none}
.list{padding:4px 12px 8px}
.pos{background:var(--card);border:1px solid var(--line);border-radius:calc(var(--r) + 4px);padding:12px;margin:8px 0}
.row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px 12px}
.c.name{grid-column:1/-1;min-width:0}
.c.name b{display:block;font-weight:650;font-size:15.5px;line-height:1.25}
.meta{display:block;color:var(--dim);font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta em{font-style:normal;color:var(--down);font-weight:700}
.c.f{font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums;min-width:0}
.c.f label{display:block;white-space:nowrap}
.c.f b{display:block;color:var(--ink);font-weight:600;font-size:13.5px;white-space:nowrap}
.c.f i{display:block;font-style:normal;font-size:11.5px;font-weight:600;white-space:nowrap}
.up{color:var(--up)}
.down{color:var(--down)}
.c.act{grid-column:1/-1;min-width:0}
.btns{display:flex;gap:8px;align-items:stretch}
.go{appearance:none;flex:1;min-width:0;display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid transparent;border-radius:var(--r);padding:10px 14px;font-size:14.5px;font-weight:700;background:var(--accent);color:var(--accent-ink);cursor:pointer;white-space:nowrap;font-variant-numeric:tabular-nums}
.go svg{width:14px;height:14px;flex:none}
.go:hover{filter:brightness(1.06)}
[data-host="sx_bet"] .go{background:linear-gradient(90deg,#182342,#1a2e33) padding-box,linear-gradient(90deg,#418fd5,#35c9a0) border-box;color:#f0f3f9}
.go.off{background:var(--card2);color:var(--faint);border-color:var(--line);cursor:default;filter:none}
.go.done{background:var(--upwash);color:var(--up);border-color:var(--up);cursor:default;filter:none}
.go.busy{cursor:progress;filter:none}
.spin{width:14px;height:14px;flex:none;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation-duration:2.4s}}
.tg{appearance:none;flex:none;width:40px;border:1px solid var(--line);border-radius:var(--r);background:transparent;color:var(--dim);cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.tg svg{width:14px;height:14px;transition:transform .15s}
.pos.open .tg svg{transform:rotate(180deg)}
.sub{margin-top:6px;font-size:12px;color:var(--dim);display:flex;gap:10px;justify-content:space-between;font-variant-numeric:tabular-nums}
.sub .more{color:var(--up);font-weight:600}
.sub a{color:var(--dim);cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.det{margin-top:12px;padding:10px 12px;border-radius:var(--r);background:var(--card2);font-size:13px;font-variant-numeric:tabular-nums}
.det div{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid var(--line);color:var(--dim)}
.det dd{color:var(--ink);font-weight:600;white-space:nowrap}
.det dd.up{color:var(--up)}
.det p{padding-top:8px;color:var(--dim);font-size:12.5px;line-height:1.45}
.det p.pow{font-size:11.5px;color:var(--faint)}
.pow b{font-family:Georgia,"Times New Roman",serif;font-weight:400;color:var(--gold);font-size:13px;letter-spacing:.01em}
.empty{padding:38px 18px;color:var(--dim);text-align:center;font-size:14px;line-height:1.5}
.note{padding:10px 16px calc(22px + env(safe-area-inset-bottom));text-align:center;color:var(--faint);font-size:11.5px;line-height:1.55}
.note span{display:block}
.ask{display:inline-flex;align-items:center;font-size:12.5px;font-weight:650;color:var(--ink);text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:7px 12px;white-space:nowrap}
.contact{margin:6px 12px calc(26px + env(safe-area-inset-bottom));padding:16px;border:1px solid var(--line);border-radius:calc(var(--r) + 4px);background:var(--card2);text-align:center}
.contact b{display:block;font-size:16px;font-weight:700}
.contact p{margin-top:2px;font-size:13px;color:var(--dim)}
.cbtns{display:flex;gap:8px;margin-top:12px}
.cbtns a{flex:1;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--r);padding:10px 12px;font-size:14px;font-weight:700;text-decoration:none;background:var(--ink);color:var(--bg);border:1px solid var(--ink)}
.cbtns a.alt{background:transparent;color:var(--ink);border-color:var(--line)}
.contact small{display:block;margin-top:10px;font-size:12px;color:var(--dim);overflow-wrap:anywhere}
.toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,8px);background:#0f1115;color:#fff;font-size:12.5px;font-weight:600;padding:8px 14px;border-radius:999px;opacity:0;pointer-events:none;transition:opacity .16s,transform .16s;white-space:nowrap;z-index:5}
.toast.on{opacity:.96;transform:translate(-50%,0)}

/* a phone drawn on a desktop: the same card rows, inside a frame */
@media (min-width:900px){
  body{background:var(--stage);color:var(--stage-ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .stage{display:grid;grid-template-columns:minmax(280px,340px) minmax(0,1fr);gap:44px;max-width:1400px;margin:0 auto;padding:34px 36px 48px;align-items:start}
  .pitch{display:block;position:sticky;top:34px}
  .pitch .wm{font-family:Georgia,"Times New Roman",serif;color:var(--gold);font-size:21px;letter-spacing:.01em}
  .pitch h1{margin-top:22px;font-size:34px;line-height:1.08;letter-spacing:-.02em;font-weight:750}
  .pitch .lede{margin-top:14px;font-size:16px;line-height:1.5;color:var(--stage-dim)}
  .pitch .try{margin-top:22px;font-size:14.5px;font-weight:650}
  .pitch .try b{color:#00915f}
  .pitch .small{margin-top:22px;font-size:12px;line-height:1.55;color:var(--stage-dim)}
  .ask,.demo>.contact{display:none}
  .pitch .contact{margin:26px 0 0;padding:18px 0 0;border:0;border-top:1px solid #dfe2e8;border-radius:0;background:transparent;text-align:left}
  .pitch .contact p{color:var(--stage-dim)}
  .pitch .cbtns a{border-radius:9px;background:var(--stage-ink);color:#fff;border-color:var(--stage-ink)}
  .pitch .cbtns a.alt{background:#fff;color:var(--stage-ink);border-color:#dfe2e8}
  .pitch .contact small{color:var(--stage-dim)}
  .ctl{padding:0 0 14px}
  .ctl .seg{background:#fff;border-color:#dfe2e8}
  .ctl .seg button{color:var(--stage-dim)}
  .ctl .seg button[aria-pressed="true"]{background:var(--stage-ink);color:#fff}
  .viewseg{display:inline-flex}
  .shell{margin:0 auto;border-radius:16px;box-shadow:0 18px 50px rgba(15,17,21,.16);border:1px solid rgba(15,17,21,.08);overflow:hidden}
  .shell[data-view="mobile"]{width:400px;border-radius:38px;border:0;outline:8px solid #0b0c0f}
  .shell[data-view="mobile"] .scroll{height:740px;overflow-y:auto}
  .shell[data-view="desktop"]{width:100%;max-width:1010px}
  .shell[data-view="desktop"] .scroll{max-height:800px;overflow-y:auto}
  .shell[data-view="desktop"] .top{padding:14px 24px;border-bottom:1px solid var(--line);flex-wrap:nowrap}
  .shell[data-view="desktop"] .nav{order:0;flex:0 1 auto;border:0;gap:22px}
  .shell[data-view="desktop"] .nav span{padding:6px 0}
  .shell[data-view="desktop"] .ttl{padding:22px 24px 6px}
  .shell[data-view="desktop"] .ttl h2{font-size:24px}
  .shell[data-view="desktop"] .thead,.shell[data-view="desktop"] .row{display:grid;grid-template-columns:minmax(0,2.1fr) minmax(0,1.05fr) minmax(0,.8fr) minmax(0,.8fr) minmax(0,.95fr) 214px;gap:14px;align-items:center}
  .shell[data-view="desktop"] .thead{padding:14px 24px 8px;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--faint);border-bottom:1px solid var(--line)}
  .shell[data-view="desktop"] .list{padding:0 12px 8px}
  .shell[data-view="desktop"] .pos{background:transparent;border:0;border-bottom:1px solid var(--line);border-radius:0;margin:0;padding:14px 12px}
  .shell[data-view="desktop"] .c.name,.shell[data-view="desktop"] .c.act{grid-column:auto}
  .shell[data-view="desktop"] .c.f label{display:none}
  .shell[data-view="desktop"] .c.f b{font-size:14px;font-weight:500}
  .shell[data-view="desktop"] .go{padding:9px 10px;font-size:13.5px}
  .shell[data-view="desktop"] .tg{width:34px}
  .shell[data-view="desktop"] .det{margin-left:auto;max-width:440px}
  .toast{bottom:40px}
}
</style>
</head>
<body data-host="polymarket">
<div class="stage">
<aside class="pitch">
  <div class="wm">Atticus</div>
  <h1>One tap. Any on-chain market.</h1>
  <p class="lede">Lock in sits on every open position, on your own page. One tap fixes what the position pays, win or lose, and your trader never leaves.</p>
  <p class="try">Tap <b>Lock in</b> on any row. Switch the venue or the view above the screen.</p>
  <p class="small">Demonstration. Positions are simulated at live prices and nothing is bought. Atticus's fee is not included. Not affiliated with or endorsed by any venue.</p>
  ${contactHtml("")}
</aside>
<main class="demo">
  <div class="ctl">
    <div class="seg viewseg" role="group" aria-label="View"><button type="button" data-view="mobile" aria-pressed="false">Mobile</button><button type="button" data-view="desktop" aria-pressed="false">Desktop</button></div>
    <div class="seg homeseg" role="group" aria-label="Venue" id="homeseg"></div>
    <a class="ask" href="#contact">Talk to us</a>
  </div>
  <div class="shell" id="shell" data-view="mobile" data-host="polymarket">
    <div class="scroll">
      <div class="top"><div class="brand" id="brand"></div><div class="nav" id="nav"></div><div class="live" id="live"><i></i><span>Live prices</span></div></div>
      <div class="ttl"><h2 id="title"></h2><span id="total"></span></div>
      <div class="thead" id="thead"></div>
      <div class="list" id="list"><div class="empty">Loading positions.</div></div>
      <div class="note"><span>Demonstration. Simulated positions at live prices; nothing is bought.</span><span>Atticus's fee is not included. Not affiliated with or endorsed by any venue.</span><span class="pow">Powered by <b>Atticus</b></span></div>
    </div>
  </div>
  ${contactHtml("contact")}
</main>
</div>
<div class="toast" id="toast"></div>
<script>
(function(){
  var HOSTS=${hosts};
  var API=location.pathname.replace(/\\/+$/,'')+'/api/positions';
  var STAGES=${JSON.stringify(DEMO_LOCK_STAGES)};
  var S={data:null,home:null,asked:false,view:'mobile',open:null,locked:{},busy:{},failed:false};
  var $=function(id){return document.getElementById(id)};
  var esc=function(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
  var usd=function(c){var n=Math.abs(c),d=Math.floor(n/100),r=String(n%100);if(r.length<2)r='0'+r;return (c<0?'-':'')+'$'+String(d).replace(/\\B(?=(\\d{3})+(?!\\d))/g,',')+'.'+r};
  var SHIELD='<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1 2.5 3v4.3c0 3.3 2.3 6.2 5.5 7.2 3.2-1 5.5-3.9 5.5-7.2V3L8 1Zm2.9 5.3-3.3 3.6a.6.6 0 0 1-.9 0L5.1 8.2a.6.6 0 1 1 .9-.8l1.1 1.2 2.9-3.1a.6.6 0 1 1 .9.8Z"/></svg>';
  var CHECK='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>';
  var CHEV='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';

  function hostOf(v){for(var i=0;i<HOSTS.length;i++)if(HOSTS[i].venue===v)return HOSTS[i];return HOSTS[0]}
  function rowsOf(v){
    var out=[],seen={},hs=S.data?S.data.homes:[];
    for(var i=0;i<hs.length;i++)if(hs[i].venue===v)for(var j=0;j<hs[i].positions.length;j++){var p=hs[i].positions[j];seen[p.id]=1;out.push(p)}
    /* a locked position, or one a lock is running on, stays on the list after its game leaves the feed */
    for(var id in S.locked)if(!seen[id]&&id.indexOf(v+':')===0){seen[id]=1;out.push(S.locked[id])}
    for(var bid in S.busy)if(!seen[bid]&&bid.indexOf(v+':')===0)out.push(S.busy[bid].p);
    return out;
  }
  function when(iso){
    var t=Date.parse(iso);if(!isFinite(t))return '';
    if(t<=Date.now())return '<em>Live</em>';
    try{return esc(new Date(t).toLocaleString([], {weekday:'short',hour:'numeric',minute:'2-digit'}))}catch(e){return ''}
  }
  function price(h,p){
    if(h.odds)return (100/p.entryCents).toFixed(2)+' \\u2192 '+(100/p.nowCents).toFixed(2);
    return p.entryCents+'\\u00a2 \\u2192 '+Math.round(p.nowCents)+'\\u00a2';
  }
  function action(p){
    var lk=S.locked[p.id],bz=S.busy[p.id];
    if(bz)return '<div class="btns"><button type="button" class="go busy" disabled aria-busy="true"><i class="spin"></i>'+STAGES[bz.i]+'\u2026</button></div><div class="sub"><span>Lock in '+usd(bz.p.lockCents)+'</span></div>';
    if(lk)return '<div class="btns"><button type="button" class="go done" disabled>'+CHECK+'Locked '+usd(lk.lockCents)+'</button><button type="button" class="tg" data-act="details" aria-label="Details" aria-expanded="'+(S.open===p.id)+'">'+CHEV+'</button></div><div class="sub"><span>Paid when the game settles</span><a data-act="undo">Undo</a></div>';
    if(p.lockCents===null)return '<div class="btns"><button type="button" class="go off" disabled>'+SHIELD+'Lock in</button></div><div class="sub"><span>Not available right now</span></div>';
    return '<div class="btns"><button type="button" class="go" data-act="lock">'+SHIELD+'Lock in '+usd(p.lockCents)+'</button><button type="button" class="tg" data-act="details" aria-label="Details" aria-expanded="'+(S.open===p.id)+'">'+CHEV+'</button></div><div class="sub"><span class="more">'+usd(p.moreCents)+' more than closing now</span></div>';
  }
  function details(h,p){
    return '<dl class="det"><div><dt>Close now on '+esc(h.name)+'</dt><dd>'+usd(p.valueCents)+'</dd></div><div><dt>Lock in</dt><dd>'+usd(p.lockCents)+'</dd></div><div><dt>Difference</dt><dd class="up">+'+usd(p.moreCents)+'</dd></div>'+
      '<p>Lock in pays '+usd(p.lockCents)+' when the game settles, win or lose.</p><p class="pow">Powered by <b>Atticus</b></p></dl>';
  }
  /* what was done, for a locked row: the amounts and the time, and nothing of how */
  function receipt(h,lk){
    var at='';try{at=new Date(lk.lockedAt).toLocaleString([], {weekday:'short',hour:'numeric',minute:'2-digit'})}catch(e){}
    return '<dl class="det"><div><dt>Locked in</dt><dd>'+usd(lk.lockCents)+'</dd></div><div><dt>If your pick wins</dt><dd>'+usd(lk.lockCents)+'</dd></div><div><dt>If your pick loses</dt><dd>'+usd(lk.lockCents)+'</dd></div>'+
      '<div><dt>Paid</dt><dd>When the game settles</dd></div><div><dt>Closing on '+esc(h.name)+' paid</dt><dd>'+usd(lk.valueCents)+'</dd></div><div><dt>Difference</dt><dd class="up">+'+usd(lk.moreCents)+'</dd></div>'+
      (at?'<div><dt>Locked</dt><dd>'+esc(at)+'</dd></div>':'')+
      '<p>Demonstration: nothing was bought.</p><p class="pow">Powered by <b>Atticus</b></p></dl>';
  }
  function render(){
    var h=hostOf(S.home),shell=$('shell');
    shell.setAttribute('data-view',S.view);shell.setAttribute('data-host',h.venue);document.body.setAttribute('data-host',h.venue);
    var vb=document.querySelectorAll('.viewseg button');for(var i=0;i<vb.length;i++)vb[i].setAttribute('aria-pressed',String(vb[i].getAttribute('data-view')===S.view));
    /* a venue with nothing to show has no tab, unless the link asked for it */
    var seg='';for(var j=0;j<HOSTS.length;j++){var v=HOSTS[j].venue;if(S.data&&S.data.at&&v!==S.home&&!rowsOf(v).length)continue;seg+='<button type="button" data-home="'+v+'" aria-pressed="'+(v===S.home)+'">'+esc(HOSTS[j].name)+'</button>'}
    $('homeseg').innerHTML=seg;
    $('brand').textContent=h.name;
    var nav='';for(var n=0;n<h.nav.length;n++)nav+='<span'+(n===h.on?' class="on"':'')+'>'+esc(h.nav[n])+'</span>';
    $('nav').innerHTML=nav;
    $('title').textContent=h.title;
    document.title='Lock in demonstration · '+h.name;
    $('live').className=S.failed?'live off':'live';
    $('live').lastChild.textContent=S.failed?'Prices paused':'Live prices';
    $('thead').innerHTML='<span>'+esc(h.cols[0])+'</span><span>'+esc(h.cols[1])+'</span><span>'+esc(h.cols[2])+'</span><span>'+esc(h.cols[3])+'</span><span>'+esc(h.cols[4])+'</span><span></span>';
    var rows=rowsOf(h.venue);
    if(!S.data||!S.data.at){$('total').innerHTML='';$('list').innerHTML='<div class="empty">'+(S.failed?'Prices could not be read just now. This page tries again every ${DEMO_REFRESH_SEC} seconds.':'Loading positions.')+'</div>';return}
    if(!rows.length){$('total').innerHTML='';$('list').innerHTML='<div class="empty">No open positions on '+esc(h.name)+' right now.</div>';return}
    var html='',total=0;
    for(var k=0;k<rows.length;k++){
      var p=rows[k],pl=p.valueCents-p.stakeCents,lk=S.locked[p.id],open=S.open===p.id&&!S.busy[p.id]&&(!!lk||p.lockCents!==null);
      total+=p.valueCents;
      html+='<div class="pos'+(open?' open':'')+'" data-id="'+esc(p.id)+'"><div class="row">'+
        '<div class="c name"><b>'+esc(p.pick)+'</b><span class="meta">'+esc(p.game)+' · '+esc(p.competition)+' · '+when(p.startsAt)+'</span></div>'+
        '<div class="c f"><label>'+esc(h.cols[1])+'</label><b>'+price(h,p)+'</b></div>'+
        '<div class="c f"><label>'+esc(h.cols[2])+'</label><b>'+usd(p.stakeCents)+'</b></div>'+
        '<div class="c f"><label>'+esc(h.cols[3])+'</label><b>'+usd(p.payoutCents)+'</b></div>'+
        '<div class="c f"><label>'+esc(h.cols[4])+'</label><b>'+usd(p.valueCents)+'</b><i class="'+(pl<0?'down':'up')+'">'+(pl<0?'':'+')+usd(pl)+'</i></div>'+
        '<div class="c act">'+action(p)+'</div></div>'+(open?(lk?receipt(h,lk):details(h,p)):'')+'</div>';
    }
    $('total').innerHTML=rows.length+' open · <b>'+usd(total)+'</b>';
    $('list').innerHTML=html;
  }
  function find(id){var rows=rowsOf(S.home);for(var i=0;i<rows.length;i++)if(rows[i].id===id)return rows[i];return null}
  var toastT=null;
  function toast(text){var t=$('toast');t.textContent=text;t.className='toast on';clearTimeout(toastT);toastT=setTimeout(function(){t.className='toast'},2400)}

  /* the lock, in stages the button reports in words; the amount is the one that was on the button when it was tapped */
  function startLock(id,p){
    var b={i:0,p:JSON.parse(JSON.stringify(p))};b.p.lockedAt=Date.now();
    S.busy[id]=b;if(S.open===id)S.open=null;
    var t=setInterval(function(){
      b.i++;
      if(b.i<STAGES.length){render();return}
      clearInterval(t);delete S.busy[id];S.locked[id]=b.p;
      toast('Locked in '+usd(b.p.lockCents)+'. Demonstration: nothing was bought.');
      render();
    },${DEMO_STAGE_MS}+Math.floor(Math.random()*250));
  }

  $('list').addEventListener('click',function(e){
    var el=e.target;while(el&&el!==this&&!(el.getAttribute&&el.getAttribute('data-act')))el=el.parentNode;
    if(!el||el===this)return;
    var row=el;while(row&&!row.getAttribute('data-id'))row=row.parentNode;
    if(!row)return;
    var id=row.getAttribute('data-id'),p=find(id),act=el.getAttribute('data-act');
    if(!p)return;
    if(act==='lock'&&p.lockCents!==null&&!S.busy[id]&&!S.locked[id]){startLock(id,p)}
    else if(act==='undo'){delete S.locked[id];if(S.open===id)S.open=null}
    else if(act==='details'){S.open=S.open===id?null:id}
    render();
  });
  document.querySelector('.ctl').addEventListener('click',function(e){
    var b=e.target;if(!b||b.tagName!=='BUTTON')return;
    var v=b.getAttribute('data-view'),h=b.getAttribute('data-home');
    if(v)S.view=v;
    if(h){S.home=h;S.asked=true;S.open=null}
    render();
  });

  function load(){
    fetch(API,{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error(String(r.status));return r.json()}).then(function(d){
      S.data=d;S.failed=false;
      /* the first venue with positions, unless the link or a tap chose one */
      if(!S.asked&&!rowsOf(S.home).length)for(var i=0;i<HOSTS.length;i++)if(rowsOf(HOSTS[i].venue).length){S.home=HOSTS[i].venue;break}
      render();
    }).catch(function(){S.failed=true;render()});
  }
  var qs=location.search;
  var wide=window.matchMedia&&window.matchMedia('(min-width:900px)').matches;
  S.view=wide&&/[?&]view=desktop\\b/i.test(qs)?'desktop':'mobile';
  S.home=HOSTS[0].venue;
  var m=/[?&]venue=([a-z_]+)/i.exec(qs);
  if(m)for(var i=0;i<HOSTS.length;i++)if(HOSTS[i].venue===m[1].toLowerCase()){S.home=HOSTS[i].venue;S.asked=true}
  render();load();setInterval(load,${DEMO_REFRESH_SEC * 1000});
})();
</script>
</body>
</html>`;
}
