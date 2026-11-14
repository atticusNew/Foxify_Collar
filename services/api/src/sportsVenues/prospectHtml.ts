/**
 * The page made for one reader whose customers trade on Crypto.com's exchange: the replay's
 * results and the lock as a customer would see it, in the order of a conversation, retail-size
 * tickets first. The reader is named throughout (`audience.short`), never called by its licence.
 *
 * What it holds back, on purpose. It says what a lock gives the customer (cash now, what is
 * still to win, how much of the stake that is) and that it is done on the exchange from the
 * customer's own account with nobody on the other side. It does not say what order does it, how
 * that order is sized, or at what threshold: no "sell", no "bid", no tier percentages. It names
 * no other venue and says nothing of how the figures are collected beyond "the exchange's public
 * trade tape". Each figure is defined by what the customer ends up with, which is enough to
 * check it. The full tables and the method are the internal pages (audiences.ts), not this one.
 *
 * Every figure is read from the replay report, the lock quote or the book count it is given.
 * The only script is the guide (which note is shown) and the boxes the reader types in, which
 * scale counts that are already on the page.
 */

import type { FeeTerms } from "./analytics";
import type { HolderReport } from "./holder";
import { MICRO_PER_DOLLAR, TIER_NAME, centsOf, lockTerms, netBid, stakeBackSold } from "./lockMath";
import type { LockChoice, LockOption, LockQuote, PastMoment } from "./lockNow";
import { LOCK_STYLE, SMALL_USD, contracts, dollars, esc, et, league, mean, momentWords, num, pct, usd } from "./replayHtml";
import { SPORTS_PAGE_STYLE } from "./reportHtml";
import { LOCK_MAX_BID, LOCK_MIN_BID, lockTallyOf, openTallyOf, type LockTally, type OptionId, type ReplayReport, type StoryRow } from "./tapeReplay";

export interface ProspectLock {
  /** the sides with a price on the board now */
  live: LockChoice[];
  /** the moments of the finished game picked, when one is */
  moments: PastMoment[];
  quote: LockQuote | null;
  selected: string;
  contracts: string;
  paid: string;
}

/** What the page says of the exchange's own book: how often its best price had 1,000 contracts or more behind it. Nothing of any other venue. */
export interface BookFacts {
  readings: number;
  /** 0 to 1 */
  deepShare: number;
}
export interface BookCount {
  sinceMs: number | null;
  pre: BookFacts | null;
  live: BookFacts | null;
}
/** The exchange's own rows of the holder count, one figure of each: every other figure, and all that name or measure another venue, are left out. */
export function bookCountOf(report: HolderReport): BookCount {
  const facts = (phase: "pre" | "live"): BookFacts | null => {
    const x = report.all[phase]?.find((row) => row.venue === "cryptocom" && row.readings > 0);
    return x && Number.isFinite(x.depthShare[1]) ? { readings: x.readings, deepShare: x.depthShare[1] } : null;
  };
  return { sinceMs: report.sinceMs, pre: facts("pre"), live: facts("live") };
}

export interface ProspectInput {
  /** `name` where the page is formal (the title line, the footer), `short` in running text */
  audience: { name: string; short: string; base: string };
  key: string;
  report: ReplayReport;
  fee: FeeTerms;
  feeWords: string;
  book: BookCount | null;
  lock: ProspectLock;
}

/** the value of a finished game's side in the picker: `past:<event>|<side>` */
export const PAST_PREFIX = "past:";

/** The locks of the calculator: one a ticket can take, so they are alternatives. `key` is what the page's source carries. */
export const BROKER_OPTIONS: ReadonlyArray<{ key: string; id: OptionId; label: string }> = [
  { key: "stake_back", id: "live_back80", label: "In play: stake back" },
  { key: "half_back", id: "live_half", label: "In play: half the stake back" },
  { key: "before_start", id: "pre_wide", label: "Before the start: Max upside" },
];
export const BROKER_DEFAULTS = { adoption: 10, share: 100, commission: 0 };

export interface BrokerBase {
  orders: number;
  contracts: number;
  fees: number;
  saved: number;
  returned: number;
}
/** What every retail holder who could lock doing so comes to: whole contracts and whole dollars. */
export const brokerBase = (t: LockTally): BrokerBase => ({ orders: t.n, contracts: Math.round(t.sold / 100), fees: Math.round(t.fee / MICRO_PER_DOLLAR), saved: t.lost, returned: Math.round(t.lostCash / MICRO_PER_DOLLAR) });
/** The same at `adoption` in 100 holders and `share` percent of the exchange, with a commission in cents a contract. The script on the page does this same sum. */
export function brokerRows(b: BrokerBase, adoption: number, share: number, commission: number): BrokerBase & { commission: number } {
  const f = (adoption / 100) * (share / 100);
  return { orders: Math.round(b.orders * f), contracts: Math.round(b.contracts * f), fees: Math.round(b.fees * f), saved: Math.round(b.saved * f), returned: Math.round(b.returned * f), commission: Math.round((b.contracts * f * commission) / 100) };
}

const why = (title: string, body: string): string => `<aside class="why"><b>${esc(title)}</b>${body}</aside>`;
const whole = (dollarsValue: number): string => `$${dollarsValue.toLocaleString("en-US")}`;

/** A real ticket, told by what its holder had: what it cost, what Lock in gave back, how it ended. */
function storyHtml(st: StoryRow, fee: FeeTerms, href: string): string {
  const pos = { qty: st.qty, price: st.price };
  const sold = stakeBackSold(pos, netBid(fee, st.bid), fee);
  const terms = sold === null ? null : lockTerms(pos, sold, st.bid, fee);
  if (!terms) return "";
  const stake = centsOf(terms.stake, "up");
  const cash = centsOf(terms.cash, "down");
  const cap = centsOf(terms.cap, "down");
  const full = centsOf(terms.fullWin, "down");
  const end = st.won
    ? `<p class="then"><b>${esc(st.team)} won.</b> Held to the end as it was: ${dollars(full)}. With Lock in: ${dollars(cash)} in cash at that moment plus ${dollars(cap - cash)} at the end, <b>${dollars(cap)}</b>. The lock cost ${dollars(full - cap)} of the win.</p>`
    : `<p class="then"><b>${esc(st.team)} lost.</b> Held to the end as it was: <b class="bad">$0.00</b>. With Lock in: <b class="ok">${dollars(cash)}</b>.</p>`;
  return `<div class="opt"><h3>${st.won ? "A ticket that won" : "A ticket that lost"}</h3>
<p class="dim">${esc(league(st.league))} · ${esc(st.label)}</p>
<p>${et(st.openedMs)}: someone buys ${num(st.qty / 100, 2)} contracts of ${esc(st.team)} to win at ${num(st.price / 100, 2)}¢. That is <b>${dollars(stake)}</b> with the exchange fee.</p>
<p>${momentWords(st.atMs, st.startMs)} the price is ${num(st.bid / 100, 2)}¢. Lock in there: <b>${dollars(cash)}</b> back in cash, the whole stake, and ${dollars(cap - cash)} still to win.</p>
${end}
<p class="more"><a href="${esc(href)}">See every choice on this ticket</a></p></div>`;
}

export const READER_OPTION: Record<LockOption["id"], [string, string]> = {
  back: ["Stake back", "Everything paid comes back now. What is left rides at no cost."],
  wide: [TIER_NAME.wide, "The least cash now, the most left to win."],
  balanced: [TIER_NAME.balanced, "Between the two."],
  tight: [TIER_NAME.tight, "The most cash now, the least left to win."],
};

/**
 * The lock on a position as its holder would see it: for each choice the cash now, the total if
 * the side wins and the share of the stake back; for a finished game, how it ended. The order
 * behind a choice is not shown.
 */
export function readerLockHtml(q: LockQuote): string {
  const p = q.past;
  const when = p ? `finished${p.winnerName ? `: ${esc(p.winnerName)} won` : ", no result read"}` : q.inPlay ? "in play" : q.startsAt ? `starts ${et(Date.parse(q.startsAt))}` : "start not listed";
  const price = p
    ? `<span>Price then <b>${q.bidCents}¢</b> <small>${momentWords(p.atMs, p.startMs)} · ${et(p.atMs)} · ${p.fromBook ? `the exchange's book, ${num(q.bidQty)} contracts at that price` : `a trade of ${num(q.bidQty, 2)} contracts on the tape`}</small></span>`
    : `<span>Price now <b>${q.bidCents}¢</b> <small>${num(q.bidQty)} contracts at that price</small></span>`;
  const riding = p && p.won !== null ? `<span>Held to the end with no lock <b>${p.won ? dollars(q.fullWinCents) : "$0.00"}</b></span>` : `<span>Riding with no lock <b>${dollars(q.fullWinCents)} or $0.00</b></span>`;
  const head = `<div class="strip"><span>${esc(league(q.league))} · ${esc(q.label)} <b>${esc(q.team)} to win</b> <small>${when}</small></span>${price}<span>Position <b>${num(q.contracts, 2)} contracts at ${q.paidCents}¢</b> <small>${q.paidAssumed ? `no price given: ${p ? "the last trade before the start" : "the price to buy now"} · ` : ""}paid ${dollars(q.stakeCents)} with the fee</small></span>${riding}</div>`;
  const card = (o: LockOption): string => {
    const [name, words] = READER_OPTION[o.id];
    const then =
      p && p.won !== null
        ? p.won
          ? `<p class="then">What happened: ${esc(q.team)} won. Held to the end with no lock: ${dollars(q.fullWinCents)}. With this lock: <b>${dollars(o.capCents)}</b>, ${dollars(q.fullWinCents - o.capCents)} less.</p>`
          : `<p class="then">What happened: ${esc(q.team)} lost. Held to the end with no lock: $0.00. With this lock: <b class="ok">${dollars(o.floorCents)}</b>.</p>`
        : "";
    const short = o.covered ? "" : `<p class="dim">This position is larger than what was at that price: part of it would get less than shown.</p>`;
    return `<div class="opt"><h3>${esc(name)}</h3><p class="dim">${esc(words)}</p>
<div class="three"><div><small>Cash now</small><b>${dollars(o.floorCents)}</b></div><div><small>Total if they win</small><b>${dollars(o.capCents)}</b></div><div><small>Stake returned</small><b>${o.backPercent}%</b></div></div>
<p>If ${esc(q.team)} lose: <b>${dollars(o.floorCents)}</b> instead of $0.00. If they win: <b>${dollars(o.capCents)}</b> instead of ${dollars(q.fullWinCents)}.</p>${then}${short}</div>`;
  };
  const open = q.bidCents * 100 >= LOCK_MIN_BID && q.bidCents * 100 <= LOCK_MAX_BID;
  const none = q.options.length
    ? ""
    : `<p class="lead">${
        !(q.paidCents > 0)
          ? "Say what was paid per contract."
          : !(q.bidCents > 0)
            ? "There is no price on this side right now."
            : !open
              ? `The price is ${q.bidCents}¢. Outside 5¢ to 95¢ the result is all but known and no lock is shown.`
              : "No lock can be shown on this position at this price."
      }</p>`;
  const from = q.stakeBackFromCents;
  const back = !q.options.length || from === undefined ? "" : from === null ? '<p class="dim">Stake back is not available on this position.</p>' : `<p class="dim">Stake back is not available at this price. On this position it opens at ${from}¢.</p>`;
  return `${head}${none}<div class="opts">${q.options.map(card).join("")}</div>${q.options.length ? `<p class="dim">Cash figures are after the exchange's fee.</p>` : ""}${back}`;
}

/** The page's only script: which note is shown, and the calculator's sum (brokerRows, in the browser). */
export const GUIDE_SCRIPT = `(function(){
var stops=[].slice.call(document.querySelectorAll('section[data-stop]'));
var count=document.getElementById('g-count'),i=-1;
function show(n){i=n;stops.forEach(function(s,k){s.classList.toggle('on',k===n)});document.body.classList.toggle('guiding',n>=0);
if(n>=0){count.textContent=(n+1)+' of '+stops.length;stops[n].scrollIntoView({behavior:'smooth',block:'start'})}}
function step(d){if(i<0)return;show(Math.max(0,Math.min(stops.length-1,i+d)))}
document.getElementById('g-start').onclick=function(){show(i<0?0:-1)};
document.getElementById('g-prev').onclick=function(){step(-1)};
document.getElementById('g-next').onclick=function(){step(1)};
document.getElementById('g-close').onclick=function(){show(-1)};
document.getElementById('g-all').onclick=function(){var on=document.body.classList.toggle('notes');this.textContent=on?'Hide the notes':'Show all notes'};
document.addEventListener('keydown',function(e){if(i<0||/INPUT|SELECT|TEXTAREA/.test(e.target.tagName))return;
if(e.key==='ArrowRight'||e.key==='ArrowDown'||e.key==='PageDown'){e.preventDefault();step(1)}
else if(e.key==='ArrowLeft'||e.key==='ArrowUp'||e.key==='PageUp'){e.preventDefault();step(-1)}
else if(e.key==='Escape'){show(-1)}});
var game=document.getElementById('lock-game');
if(game)game.onchange=function(){var f=this.form;if(f.at)f.at.value='';f.paid.value='';f.submit()};
var calc=document.getElementById('calc');
if(calc){var base=JSON.parse(calc.getAttribute('data-base')),games=Number(calc.getAttribute('data-games'))||1;
var val=function(id,lo,hi){var v=Number(document.getElementById(id).value);return isFinite(v)?Math.max(lo,Math.min(hi,v)):lo};
var put=function(k,v,money){var n=Math.round(v).toLocaleString('en-US');document.getElementById('c-'+k).textContent=money?'$'+n:n};
var run=function(){var b=base[document.getElementById('c-option').value],f=val('c-adoption',0,100)/100*val('c-share',0,100)/100,c=val('c-commission',0,1000);
put('orders',b.orders*f);put('contracts',b.contracts*f);put('fees',b.fees*f,1);put('commission',b.contracts*f*c/100,1);put('saved',b.saved*f);put('returned',b.returned*f,1);
put('orders-g',b.orders*f/games);put('contracts-g',b.contracts*f/games);put('fees-g',b.fees*f/games,1);put('commission-g',b.contracts*f*c/100/games,1);put('saved-g',b.saved*f/games);put('returned-g',b.returned*f/games,1)};
['c-option','c-adoption','c-share','c-commission'].forEach(function(id){var e=document.getElementById(id);e.oninput=run;e.onchange=run})}
})();`;

/** The reader's page layout over the shared style; the internal brief wears it too. */
export const PAGE_STYLE = `body{font-size:16px;line-height:1.55;color:#16181d}
main{max-width:1040px;padding:36px 24px 72px}
h1{font-size:30px;line-height:1.2;margin:0 0 6px}.by{color:var(--dim);font-size:14px;margin:0 0 18px}
.lead{font-size:18px;line-height:1.5;margin:0 0 8px}.lead,.sub,section>p,section>ul,section>ol,section>.note,.why,.limits{max-width:780px}
section{padding:2px 16px 10px;margin:0 -16px;border-radius:10px;scroll-margin-top:12px}section.on{outline:3px solid #c7d9f5;background:#fbfdff}
h2{font-size:22px;line-height:1.25;margin:48px 0 12px;display:flex;align-items:center;gap:12px}h2 .n{flex:none;width:28px;height:28px;border-radius:50%;background:#e8f0fb;color:var(--k);font-size:14px;display:flex;align-items:center;justify-content:center}
h3{font-size:17px;margin:28px 0 6px}p{margin:10px 0}
.hl{font-weight:600}section.on .hl{background:#fff3bf;border-radius:3px;padding:0 3px}
.strip{margin:14px 0 0;padding:12px 16px;border-radius:10px;gap:10px 36px;font-size:15px}.strip.facts{display:grid;grid-template-columns:1.5fr 1fr 1.2fr}
.kpis.now{grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin:12px 0 0}.kpis.now div{background:#fff;border-radius:10px;padding:14px 16px}
.kpis.now div>small:first-child{color:var(--ink);font-weight:600;font-size:13px;line-height:1.35;min-height:53px}.kpis.now b{font-size:28px;line-height:1.15;letter-spacing:-.01em;margin:6px 0}.kpis.now b i{font-style:normal;font-weight:500;font-size:14px;letter-spacing:0;color:var(--dim)}.kpis.now small{font-size:12.5px;line-height:1.4}
.why{display:none;border:1px solid #c7d9f5;background:#f3f8ff;border-radius:8px;padding:10px 14px;margin:10px 0;font-size:15px}.why b{display:block;font-size:12px;letter-spacing:.03em;text-transform:uppercase;color:var(--k);margin-bottom:2px}.why p{margin:4px 0}
section.on .why,body.notes .why{display:block}
.opts{grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:14px 0}.opt{border-radius:10px;padding:16px 18px}.opt h3{font-size:16px;margin:0 0 4px}.opt p{margin:8px 0}.opt .more{margin-bottom:0;font-size:14px}
.three div{display:flex;flex-direction:column;justify-content:space-between;gap:4px;padding:10px 12px}.three b{font-size:21px}
.then{background:#f6faf8;border-radius:0 6px 6px 0;padding:8px 12px}
.tbl{margin:14px 0}.tbl table{font-size:14.5px}th{white-space:normal;padding:8px 10px}td{padding:10px}td small{font-size:12px}td.lbl,td.lbl small{white-space:normal}td.lbl{min-width:220px}
.tbl.narrow{max-width:780px}
.note{border-left:3px solid #c7d9f5;background:#f8fafc;border-radius:0 8px 8px 0;padding:12px 16px;margin:16px 0;color:#374151;font-size:14.5px}.note b{color:var(--ink)}
.asks,.steps{padding-left:22px;margin:8px 0}.asks li,.steps li{margin:8px 0}
.limits{font-size:13.5px;line-height:1.5}.limits li{margin:7px 0}
.tools{display:flex;flex-wrap:wrap;gap:8px 10px;align-items:center;margin:16px 0 0}.tools button,#guidebar button{font:inherit;font-size:13px;padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:#fff;cursor:pointer}.tools button#g-start{background:var(--k);border-color:var(--k);color:#fff}
#guidebar{display:none;position:fixed;left:0;right:0;bottom:0;justify-content:center;align-items:center;gap:10px;padding:10px;background:#fff;border-top:1px solid var(--line);box-shadow:0 -4px 14px rgba(0,0,0,.06);font-size:13px}body.guiding #guidebar{display:flex}body.guiding main{padding-bottom:90px}
.calc{display:grid;grid-template-columns:1.2fr 1fr 1fr 1fr;gap:12px 18px;align-items:end;margin:14px 0;padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:#fafafa}.calc label,form.ask label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--dim)}.calc select,.calc input{font:inherit;font-size:15px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:#fff}.calc select,.calc input{width:100%}
form.ask{padding:14px 16px;border-radius:10px}form.ask select,form.ask input{font-size:15px}
footer{font-size:13px}
@media(max-width:900px){.kpis.now{grid-template-columns:repeat(2,minmax(0,1fr))}.kpis.now div>small:first-child{min-height:0}.strip.facts{display:flex}.calc{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:720px){main{padding:22px 16px 60px}h1{font-size:25px}.lead{font-size:17px}.opts{grid-template-columns:minmax(0,1fr)}}
@page{margin:14mm}
@media print{body{font-size:12px}.lead{font-size:14px}h1{font-size:22px}h2{font-size:16px;margin-top:22px}h2 .n{width:22px;height:22px;font-size:12px}.kpis.now{grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}.kpis.now div{padding:9px 10px}.kpis.now div>small:first-child{font-size:10.5px;min-height:42px}.kpis.now small{font-size:10px}.kpis.now b{font-size:19px}.kpis.now b i{font-size:10.5px}.strip{font-size:12px}.strip.facts{display:grid}.opts{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.opt{padding:11px 12px}.three b{font-size:16px}.calc{grid-template-columns:1.2fr 1fr 1fr 1fr}.calc label,form.ask label{font-size:10.5px}.calc select,.calc input,form.ask select,form.ask input{font-size:12px}.tbl{overflow:visible}.tbl table,.note{font-size:10.5px}th,td{padding:5px 6px;white-space:normal}th{font-size:10px}td small{font-size:9.5px}td.lbl{min-width:150px}.limits{font-size:10.5px}.lead,.sub,section>p,section>ul,section>ol,section>.note,.why,.limits,.tbl.narrow{max-width:none}.tools,#guidebar,form.ask button{display:none!important}section.on{outline:0;background:none}section.on .hl{background:none;padding:0}main{padding:0;max-width:none}h2,h3{break-after:avoid}.opt,.kpis div,tr,.why,.note,.strip{break-inside:avoid}a{color:inherit;text-decoration:none}.more{display:none}}`;

export function renderProspectHtml(input: ProspectInput): string {
  const { report: r, fee } = input;
  const t = r.all;
  const home = `${input.audience.base}?k=${encodeURIComponent(input.key)}`;
  const all = openTallyOf(t);
  const retail = openTallyOf(t, "all", "small");
  const back = lockTallyOf(t, "live_back80", "all", "small");
  const half = lockTallyOf(t, "live_half", "all", "small");
  const wide = lockTallyOf(t, "pre_wide", "pre", "small");
  const leagues = Object.entries(r.byLeague)
    .map(([l, x]) => `${league(l)} ${x.games}`)
    .join(" · ");
  const span = t.firstStartMs !== null && t.lastStartMs !== null ? `${et(t.firstStartMs)} to ${et(t.lastStartMs)}` : "";
  const meanTicket = retail.n ? dollars(Math.round(retail.stake / retail.n / 10_000)) : "–";
  const who = esc(input.audience.short);
  const h2 = (n: number, title: string): string => `<h2><span class="n">${n}</span>${title}</h2>`;
  const tools = `<div class="tools"><button type="button" id="g-start">Guide</button><button type="button" id="g-all">Show all notes</button><button type="button" onclick="window.print()">Print or save as PDF</button></div>`;
  const head = `<h1>Lock in on Crypto.com's exchange</h1>
<p class="by">What the exchange's public trade tape shows · Prepared for ${esc(input.audience.name)} by Atticus</p>`;
  const lead = `<p class="lead">Across ${num(t.games)} ${t.games === 1 ? "game" : "games"}, ${pct(retail.lost, retail.n)} of retail tickets finished at $0, and ${pct(retail.lostAheadEver, retail.lost)} of those were ahead at some point in the game. Lock in is one button that lets a customer take their stake back in cash, or part of it, and keep the rest of the position riding.</p>
<p class="sub dim">Every number here is worked out from real tickets, bought by real customers, each followed to the final whistle. Nothing is simulated.</p>`;

  if (!t.games) return page(input, `${head}<p class="lead">No game has finished yet. A game is counted once it is over and its result is on the tape.</p>`, false);

  // one game with a ticket that lost and one that won, the latest such; else the latest of either
  const lostStory = r.stories.find((s) => !s.won);
  const wonStory = (lostStory && r.stories.find((s) => s.won && s.event === lostStory.event)) ?? r.stories.find((s) => s.won);
  const ticket = (s: StoryRow) => storyHtml(s, fee, `${home}&game=${encodeURIComponent(`${PAST_PREFIX}${s.event}|${s.side}`)}&at=${s.atMs}&n=${s.qty / 100}&paid=${s.price / 100}#lock`);
  const stories = [lostStory, wonStory].flatMap((s) => (s ? [ticket(s)] : [])).join("");

  // the lock card
  const lock = input.lock;
  const finished = [...r.games]
    .sort((a, b) => b.startMs - a.startMs)
    .flatMap((g) => {
      const [away, homeName] = g.label.split(" at ");
      return (["away", "home"] as const).map((side) => ({ value: `${PAST_PREFIX}${g.event}|${side}`, label: `${et(g.startMs).split(",")[0]} · ${league(g.league)} · ${g.label} · ${(side === "away" ? away : homeName) ?? side} to win` }));
    });
  const option = (value: string, label: string) => `<option value="${esc(value)}"${value === lock.selected ? " selected" : ""}>${esc(label)}</option>`;
  const past = lock.quote?.past;
  const moments = [...lock.moments];
  if (past && !moments.some((m) => m.atMs === past.atMs)) {
    moments.push({ atMs: past.atMs, bidCents: lock.quote?.bidCents ?? 0, fromBook: past.fromBook, inPlay: past.atMs >= past.startMs });
    moments.sort((a, b) => a.atMs - b.atMs);
  }
  const momentPick =
    past && moments.length
      ? `<label>Moment of the game<select name="at">${moments.map((m) => `<option value="${m.atMs}"${m.atMs === past.atMs ? " selected" : ""}>${momentWords(m.atMs, past.startMs)} · ${m.bidCents}¢</option>`).join("")}</select></label>`
      : "";
  const form = `<form method="get" action="${esc(input.audience.base)}#lock" class="ask"><input type="hidden" name="k" value="${esc(input.key)}">
<label>Game and side<select name="game" id="lock-game">${lock.live.length ? `<optgroup label="On the board now">${lock.live.map((c) => option(c.value, `${c.inPlay ? "In play · " : ""}${c.label} · ${c.bidCents}¢`)).join("")}</optgroup>` : ""}<optgroup label="Finished games, off the tape">${finished.map((f) => option(f.value, f.label)).join("")}</optgroup></select></label>
${momentPick}<label>Contracts held<input name="n" type="number" min="0.01" step="0.01" value="${esc(lock.contracts)}"></label>
<label>Paid per contract, cents<input name="paid" type="number" min="1" max="99" step="0.01" value="${esc(lock.paid)}" placeholder="${past ? "last trade before the start" : "the price now"}"></label>
<button type="submit">Show the lock</button></form>`;
  const card = lock.quote ? readerLockHtml(lock.quote) : '<p class="dim">Pick a game and a side.</p>';

  // the calculator: every figure on it is a count of the replay, scaled
  const base = Object.fromEntries(BROKER_OPTIONS.map((o) => [o.key, brokerBase(lockTallyOf(t, o.id, o.id === "pre_wide" ? "pre" : "all", "small"))]));
  const first = brokerRows(base[BROKER_OPTIONS[0].key], BROKER_DEFAULTS.adoption, BROKER_DEFAULTS.share, BROKER_DEFAULTS.commission);
  const perGame = (v: number) => Math.round(v / t.games);
  const calcRow = (k: keyof typeof first, label: string, small: string, money = false) =>
    `<tr><td class="lbl">${label}<small>${small}</small></td><td><b id="c-${k}">${money ? whole(first[k]) : num(first[k])}</b></td><td id="c-${k}-g">${money ? whole(perGame(first[k])) : num(perGame(first[k]))}</td></tr>`;
  const calc = `<div class="calc" id="calc" data-games="${t.games}" data-base="${esc(JSON.stringify(base))}">
<label>The lock<select id="c-option">${BROKER_OPTIONS.map((o) => `<option value="${o.key}">${esc(o.label)}</option>`).join("")}</select></label>
<label>Of 100 customers who could, how many lock<input id="c-adoption" type="number" min="0" max="100" step="1" value="${BROKER_DEFAULTS.adoption}"></label>
<label>Share of the exchange's retail tickets that are ${who}'s, %<input id="c-share" type="number" min="0" max="100" step="1" value="${BROKER_DEFAULTS.share}"></label>
<label>What ${who} earns per contract, cents<input id="c-commission" type="number" min="0" step="0.1" value="${BROKER_DEFAULTS.commission}"></label></div>
<div class="tbl narrow"><table><tr><th>Over these ${num(t.games)} games</th><th>Total</th><th>Per game, mean</th></tr>
${calcRow("orders", "Orders from locks", "each one the customer's own, on the exchange")}
${calcRow("contracts", "Contracts traded in them", "volume on the exchange")}
${calcRow("fees", "Exchange fees on them", `at ${esc(input.feeWords)}`, true)}
${calcRow("commission", `${who}'s earnings on them`, "at the figure put in above", true)}
${calcRow("saved", "Customers who finish with their lock's cash instead of $0", "their team lost after they locked")}
${calcRow("returned", "Cash those customers keep", "instead of $0", true)}
</table></div>`;

  // the exchange's own book: one figure, said in a sentence
  const share = (v: number): string => `${(v * 100).toFixed(0)}%`;
  const pre = input.book?.pre ?? null;
  const live = input.book?.live ?? null;
  const deep =
    pre && live && share(pre.deepShare) === share(live.deepShare)
      ? `${share(pre.deepShare)} of the time, before the start and in play alike`
      : [pre ? `${share(pre.deepShare)} of the time before the start` : "", live ? `${share(live.deepShare)} of the time in play` : ""].filter(Boolean).join(" and ");
  const bookHtml = `<p>Every lock above is at a price that was on the exchange at that moment.${deep ? ` While games were open, the exchange's best price had 1,000 contracts or more behind it ${deep}.` : ""} The mean retail ticket here is ${meanTicket}, a few dozen contracts. <span class="hl">A ticket that size gets the price shown.</span></p>`;

  const kept = (x: LockTally): string => (x.n ? `${(100 - (x.soldShareSum / x.n) * 100).toFixed(0)}%` : "–");
  const rows = (
    [
      ["In play: stake back", "the whole stake back in cash, with a fifth of the position or more still riding", back],
      ["In play: half the stake back", "half the stake back in cash or more, with 60% of the position still riding", half],
      ["Before the start: Max upside", `a floor of ${mean(wide.backShareSum, wide.n, 100)}% of the stake on average, with 60% of the position still riding`, wide],
    ] as Array<[string, string, LockTally]>
  )
    .map(
      ([name, gives, x]) =>
        `<tr><td class="lbl">${name}<small>${gives}</small></td><td><b>${num(x.n)}</b> · ${pct(x.n, x.eligible)}<small>of ${num(x.eligible)} retail tickets</small></td><td>${num(x.lost)}<small>had paid ${usd(x.lostStake)}, got $0</small></td><td><b class="ok">${usd(x.lostCash)}</b><small>instead of $0</small></td><td>${num(x.won)}</td><td>${usd(x.wonGaveUp)}<small>against riding to the full $1</small></td></tr>`,
    )
    .join("");

  const body = `${head}
${lead}
${tools}
<div class="strip facts"><span>Games counted <b>${num(t.games)}</b> <small>${esc(leagues)}${span ? ` · ${span}` : ""}</small></span><span>Tickets opened <b>${num(all.n)}</b> <small>${usd(all.stake)} paid</small></span><span>Retail tickets, $${num(SMALL_USD)} or less <b>${num(retail.n)}</b> <small>${pct(retail.n, all.n)} of all · mean ${meanTicket}</small></span></div>
<div class="kpis now">
<div><small>Retail tickets that finished at $0</small><b>${pct(retail.lost, retail.n)}</b><small>${num(retail.lost)} tickets · ${usd(retail.lostStake)} paid</small></div>
<div><small>Of those, ahead at some point</small><b>${pct(retail.lostAheadEver, retail.lost)}</b><small>${num(retail.lostAheadEver)} tickets · worth more than was paid, at a real price</small></div>
<div><small>Could have taken the whole stake back in play</small><b>${pct(back.n, back.eligible)}</b><small>${num(back.n)} tickets · the rest of the position riding at no cost</small></div>
<div><small>Of those, their team then lost</small><b>${num(back.lost)} <i>tickets</i></b><small>paid ${usd(back.lostStake)}, got $0 · the lock returns ${usd(back.lostCash)}</small></div>
<div><small>For every 10 in 100 who lock in play</small><b>${num(Math.round(back.n / 10))} <i>orders</i></b><small>${contracts(back.sold / 10)} contracts on the exchange</small></div>
</div>

<section data-stop id="s-problem">${h2(1, "Where customers are lost")}
${why(`For ${who}`, `<p>A customer whose ticket goes to $0 has nothing left to trade with. ${pct(retail.lostAheadEver, retail.lost)} of them were ahead at some point in the game. That moment is what Lock in is for.</p>`)}
<p>Over these ${num(t.games)} games, customers opened ${num(retail.n)} tickets of $${num(SMALL_USD)} or less and paid ${usd(retail.stake)} for them. <span class="hl">${num(retail.lost)} of them, ${pct(retail.lost, retail.n)}, finished at $0</span>, having paid ${usd(retail.lostStake)}.</p>
<p><span class="hl">${num(retail.lostAheadEver)} of those losing tickets (${pct(retail.lostAheadEver, retail.lost)}) were ahead at some point</span>: after they bought, there was a price on the exchange at which the ticket was worth more than they had put in, fees included. They had paid ${usd(retail.lostAheadStake)}. They were right for part of the game and still left with nothing.</p>
</section>

<section data-stop id="s-what">${h2(2, "What Lock in is")}
${why(`For ${who}`, `<p>${who} stays what it is: the platform the customer trades on. Nobody in this picture is the house: not ${who}, not Atticus. It runs on the exchange ${who} already sends orders to.</p>`)}
<p>One button on an open position. It shows the customer three numbers: the cash they can take now (the floor), what the position pays in all if their team wins (the cap), and how much of what they paid that brings back. One tap takes it. The rest of the position stays theirs and keeps riding.</p>
<p>It is done on the exchange, from the customer's own account, at the market's price. For ${who} it is one more order, sent to the exchange like any other. The exchange earns its fee on it. Nobody takes the other side.</p>
<p>A sportsbook's cash-out is the house's price, and the house is on the other side of it. <span class="hl">Here the price is the market's.</span></p>
</section>

<section data-stop id="s-ticket">${h2(3, "Two real tickets")}
${why(`For ${who}`, "<p>These are two customers of the exchange, off the tape. The first leaves with their stake instead of nothing. The second still wins, a little less. Both end the night with money in the account.</p>")}
${stories ? `<p>Both are trades on the exchange's tape, picked by a fixed rule and not by hand: the ticket nearest $50, bought between 25¢ and 75¢, in the latest game that has one. Lock in is taken at the first moment the whole stake could come back.</p><div class="opts">${stories}</div>` : '<p class="dim">No ticket of this size has reached stake back in the games counted so far.</p>'}
<h3 id="lock">Any ticket, at any moment</h3>
<p>Pick a finished game and a moment of it, or a game on the board now. The card is what Lock in would have shown the customer on that position at that price. Arithmetic on a public price; nothing here places an order.</p>
${form}
${card}
</section>

<section data-stop id="s-replay">${h2(4, "The same, on every retail ticket")}
${why(`For ${who}`, `<p>${num(back.lost)} customers in these games left with $0 and would have left with their money back. Whether a customer who gets their stake back trades again sooner is the question a pilot answers. No public data can.</p>`)}
<p>Each ticket is followed from its purchase to the result, and each lock is taken the first moment a real price on the exchange makes it possible. No hindsight picks the moment.</p>
<div class="tbl"><table><tr><th>The lock, and what it gives</th><th>Tickets that could take it</th><th>Their team then lost</th><th>The lock returns to those</th><th>Their team won</th><th>Winners give up</th></tr>${rows}</table></div>
<p><span class="hl">${pct(back.n, back.eligible)} of retail tickets could have taken their whole stake back in play</span>, on average ${mean(back.minutesSum, back.n)} minutes after the scheduled start, with ${kept(back)} of the position still riding. <span class="hl">${num(back.lost)} of those then lost</span>: ${usd(back.lostStake)} paid, $0 back. With the lock, ${usd(back.lostCash)} back. That is ${pct(back.lost, retail.lost)} of every retail ticket that finished at $0.</p>
<p>The chance does not last. Once the stake could come back, it stayed that way for ${mean(back.heldMinutesSum, back.n)} minutes on average before the price fell back, and for ten minutes or more on ${pct(back.held10, back.n)} of tickets. A customer has to be shown it when it is there.</p>
<div class="note"><b>What it costs the winners.</b> The ${num(back.won)} who locked and then won would have collected ${usd(back.wonGaveUp)} less than by riding. A lock moves money from the games a customer wins to the games they lose. Over many games the two come close, and the difference is the exchange's fees and the spread. What changes is how many customers end a night with nothing.</div>
</section>

<section data-stop id="s-adds">${h2(5, `What it adds for ${who}`)}
${why(`For ${who}`, `<p>Every lock is one more order through the platform. Set the share to what ${who} expects to carry: the tape shows the whole exchange and does not say whose customers are whose.</p>`)}
<p>The counts are retail tickets on the whole exchange: at a share of 100% the table is all of it. The first box is an assumption, since nobody knows how many customers lock until it is in front of them. A ticket can take one lock, so the three choices are alternatives, not a sum.</p>
${calc}
</section>

<section id="s-book">${h2(6, "The prices are real")}
${bookHtml}
</section>

<section data-stop id="s-pilot">${h2(7, "What a pilot would answer")}
${why("The ask", `<p>Step one needs no change to the platform and nothing shown to a customer. It turns the exchange-wide numbers on this page into ${who}'s own.</p>`)}
<p>Three things this page cannot know, because they are not public:</p>
<ul class="asks">
<li><b>How many of ${who}'s customers lock.</b> The 10 in 100 here is a placeholder.</li>
<li><b>Whether they come back.</b> Does a customer who got their stake back trade again sooner, and more often, than one who finished at $0? That needs account history.</li>
<li><b>What ${who}'s own customers do.</b> The tape shows the whole exchange and does not say whose customers are whose.</li></ul>
<p>Two steps:</p>
<ol class="steps">
<li><b>In the shadow.</b> These same tables on ${who}'s own customers as they trade, account numbers scrambled, with who came back added. Nothing changes on the platform.</li>
<li><b>Live.</b> The button in front of a small share of customers, measured against the rest.</li></ol>
</section>

<h2>Notes and limits</h2>
<ul class="limits">
<li><b>Whose trades.</b> The whole exchange: every platform that sends orders to it, and its market makers. The tape does not say which trades came from which.</li>
<li><b>What a ticket is.</b> A buy on the tape between 5¢ and 95¢, followed to the result as if held. Some buys close a short, some buyers are market makers, and some holders got out before the end; none of that is visible. One person's three buys are three tickets.</li>
<li><b>Real prices.</b> Every lock is worked out at a price that was really there on that contract at that moment: a trade on the tape or the exchange's own book. Nothing is estimated.</li>
<li><b>Retail.</b> A ticket that cost $${num(SMALL_USD)} or less. The larger ones are ${pct(all.n - retail.n, all.n, 1)} of tickets and ${pct(all.stake - retail.stake, all.stake)} of the money, would move the price, and are left out of every figure below the top strip.</li>
<li><b>Fees.</b> The exchange's fee, ${esc(input.feeWords)}, is in every figure. What ${who} earns on an order is not public and is counted only where it is put in.</li>
<li><b>What this is not.</b> A forecast of how many customers lock, or of what a lock does to whether they come back.</li>
</ul>`;
  return page(input, body, true);
}

function page(input: ProspectInput, body: string, withGuide: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>Lock in on Crypto.com's exchange · ${esc(input.audience.name)}</title>
<style>
${SPORTS_PAGE_STYLE}
${LOCK_STYLE}
${PAGE_STYLE}
</style></head><body><main>
${body}
<footer><p><b>Source.</b> The exchange's public trade data. Nothing on this page places an order. Prepared by Atticus Trade, Inc. for ${esc(input.audience.name)}.</p></footer>
</main>${withGuide ? `<div id="guidebar"><button type="button" id="g-prev">Back</button><span id="g-count"></span><button type="button" id="g-next">Next</button><button type="button" id="g-close">Close the guide</button></div><script>${GUIDE_SCRIPT}</script>` : ""}</body></html>`;
}
