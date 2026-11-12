/**
 * The page made for a broker onto Crypto.com's exchange: the same replay and the same lock card
 * as the service's own pages, in the order of a conversation, with retail-size tickets first and
 * nothing that links to another page of the service.
 *
 * Every figure is read from the replay report, the lock quote or the book count it is given; the
 * page works nothing out about the market itself. The only script is the guide (which note is
 * shown) and the two numbers a broker types in, which scale counts that are already on the page.
 */

import type { FeeTerms } from "./analytics";
import type { HolderReport } from "./holder";
import { MICRO_PER_DOLLAR, centsOf, lockTerms, netBid, stakeBackSold } from "./lockMath";
import type { LockChoice, LockQuote, PastMoment } from "./lockNow";
import { LOCK_STYLE, SMALL_USD, contracts, dollars, esc, et, league, lockQuoteHtml, mean, momentWords, num, pct, usd } from "./replayHtml";
import { SPORTS_PAGE_STYLE } from "./reportHtml";
import { lockTallyOf, openTallyOf, type LockTally, type OptionId, type ReplayReport, type StoryRow } from "./tapeReplay";

export interface ProspectLock {
  /** the sides with a bid on the board now */
  live: LockChoice[];
  /** the moments of the finished game picked, when one is */
  moments: PastMoment[];
  quote: LockQuote | null;
  selected: string;
  contracts: string;
  paid: string;
  /** when the book the live choices come from was read */
  bookAt: string | null;
}

/** What the page says of the exchange's own book, and nothing of any other venue's. */
export interface BookFacts {
  readings: number;
  meanSpreadCents: number | null;
  /** share of readings with at least 100, 1,000 and 10,000 contracts at the best bid, 0 to 1 */
  depthShare: number[];
  /** share of readings where a bid better than the book's had room after every fee, 0 to 1 */
  roomShare: number | null;
}
export interface BookCount {
  sinceMs: number | null;
  pre: BookFacts | null;
  live: BookFacts | null;
}
/** The exchange's own rows of the holder count, with every figure that names or measures another venue left out. */
export function bookCountOf(report: HolderReport): BookCount {
  const facts = (phase: "pre" | "live"): BookFacts | null => {
    const x = report.all[phase]?.find((row) => row.venue === "cryptocom" && row.readings > 0);
    return x ? { readings: x.readings, meanSpreadCents: x.meanSpreadCents, depthShare: [...x.depthShare], roomShare: x.roomShare } : null;
  };
  return { sinceMs: report.sinceMs, pre: facts("pre"), live: facts("live") };
}

export interface ProspectInput {
  audience: { name: string; base: string };
  key: string;
  report: ReplayReport;
  /** games being recorded now */
  recording: number;
  fee: FeeTerms;
  feeWords: string;
  book: BookCount | null;
  lock: ProspectLock;
}

/** the value of a finished game's side in the picker: `past:<event>|<side>` */
export const PAST_PREFIX = "past:";

/** The options of the calculator: one a position can take, so they are alternatives. */
export const BROKER_OPTIONS: ReadonlyArray<{ id: OptionId; label: string }> = [
  { id: "live_back80", label: "In play: stake back" },
  { id: "live_half", label: "In play: Max upside with half the stake back" },
  { id: "pre_wide", label: "Before the start: Max upside" },
];
export const BROKER_DEFAULTS = { adoption: 10, share: 100, commission: 0 };

export interface BrokerBase {
  orders: number;
  contracts: number;
  fees: number;
  saved: number;
  returned: number;
}
/** What every retail holder who could lock doing so adds: whole contracts and whole dollars. */
export const brokerBase = (t: LockTally): BrokerBase => ({ orders: t.n, contracts: Math.round(t.sold / 100), fees: Math.round(t.fee / MICRO_PER_DOLLAR), saved: t.lost, returned: Math.round(t.lostCash / MICRO_PER_DOLLAR) });
/** The same at `adoption` in 100 holders and `share` percent of the exchange, with a commission in cents a contract. The script on the page does this same sum. */
export function brokerRows(b: BrokerBase, adoption: number, share: number, commission: number): BrokerBase & { commission: number } {
  const f = (adoption / 100) * (share / 100);
  return { orders: Math.round(b.orders * f), contracts: Math.round(b.contracts * f), fees: Math.round(b.fees * f), saved: Math.round(b.saved * f), returned: Math.round(b.returned * f), commission: Math.round((b.contracts * f * commission) / 100) };
}

const why = (title: string, body: string): string => `<aside class="why"><b>${esc(title)}</b>${body}</aside>`;
const whole = (dollarsValue: number): string => `$${dollarsValue.toLocaleString("en-US")}`;

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
    ? `<p><b>${esc(st.team)} won.</b> Held to the end as it was: ${dollars(full)}. With Lock in: ${dollars(cash)} in cash at that moment plus ${dollars(cap - cash)} on the contracts kept, <b>${dollars(cap)}</b>. The lock cost ${dollars(full - cap)} of the win.</p>`
    : `<p><b>${esc(st.team)} lost.</b> Held to the end as it was: <b class="bad">$0.00</b>. With Lock in: <b class="ok">${dollars(cash)}</b>.</p>`;
  return `<div class="opt"><h3>${st.won ? "A ticket that won" : "A ticket that lost"}</h3>
<p class="dim">${esc(league(st.league))} · ${esc(st.label)}</p>
<p>${et(st.openedMs)}: someone buys ${num(st.qty / 100, 2)} contracts of ${esc(st.team)} to win at ${num(st.price / 100, 2)}¢. That is <b>${dollars(stake)}</b> with the exchange fee.</p>
<p>${momentWords(st.atMs, st.startMs)} the bid is ${num(st.bid / 100, 2)}¢. Selling ${num(terms.sold / 100, 2)} contracts there returns <b>${dollars(cash)}</b>: the whole stake. The other ${num(terms.kept / 100, 2)} contracts keep riding and now cost nothing.</p>
${end}
<p class="dim"><a href="${esc(href)}">Open this ticket on the lock card</a></p></div>`;
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

const PAGE_STYLE = `main{max-width:1120px}section{padding:2px 14px 6px;margin:0 -14px;border-radius:10px;scroll-margin-top:12px}section.on{outline:3px solid #c7d9f5;background:#fbfdff}
h2{margin-top:30px}.hl{font-weight:600}section.on .hl{background:#fff3bf;border-radius:3px;padding:0 3px}
.why{display:none;border:1px solid #c7d9f5;background:#f3f8ff;border-radius:8px;padding:10px 14px;margin:10px 0;font-size:15px}.why b{display:block;font-size:12px;letter-spacing:.03em;text-transform:uppercase;color:var(--k);margin-bottom:2px}.why p{margin:4px 0}
section.on .why,body.notes .why{display:block}
.tools{display:flex;flex-wrap:wrap;gap:8px 10px;align-items:center;margin:12px 0}.tools button,#guidebar button{font:inherit;font-size:13px;padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:#fff;cursor:pointer}.tools button#g-start{background:var(--k);border-color:var(--k);color:#fff}.tools a{font-size:13px;margin-left:6px}
#guidebar{display:none;position:fixed;left:0;right:0;bottom:0;justify-content:center;align-items:center;gap:10px;padding:10px;background:#fff;border-top:1px solid var(--line);box-shadow:0 -4px 14px rgba(0,0,0,.06);font-size:13px}body.guiding #guidebar{display:flex}body.guiding main{padding-bottom:90px}
.who td{white-space:normal}.who td.lbl{white-space:nowrap}
.calc{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:flex-end;margin:12px 0;padding:12px;border:1px solid var(--line);border-radius:8px;background:#fafafa}.calc label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dim)}.calc select,.calc input{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:#fff}.calc input{width:120px}
@media print{.tools,#guidebar,form.ask button{display:none!important}section.on{outline:0;background:none}section.on .hl{background:none;padding:0}main{padding:0;max-width:none}h2{break-after:avoid}.opt,.kpis div,tr,.why{break-inside:avoid}a{color:inherit;text-decoration:none}}`;

export function renderProspectHtml(input: ProspectInput): string {
  const { report: r, fee } = input;
  const t = r.all;
  const q = `?k=${encodeURIComponent(input.key)}`;
  const home = `${input.audience.base}${q}`;
  const detail = `${input.audience.base}/detail${q}`;
  const all = openTallyOf(t);
  const retail = openTallyOf(t, "all", "small");
  const back = lockTallyOf(t, "live_back80", "all", "small");
  const half = lockTallyOf(t, "live_half", "all", "small");
  const wide = lockTallyOf(t, "pre_wide", "pre", "small");
  const liveTrades = t.tape.live.buys + t.tape.live.sells;
  const leagues = Object.entries(r.byLeague)
    .map(([l, x]) => `${league(l)} ${x.games}`)
    .join(" · ");
  const span = t.firstStartMs !== null && t.lastStartMs !== null ? `${et(t.firstStartMs)} to ${et(t.lastStartMs)}` : "";
  const meanTicket = retail.n ? dollars(Math.round(retail.stake / retail.n / 10_000)) : "–";
  const tools = `<div class="tools"><button type="button" id="g-start">Guide</button><button type="button" id="g-all">Show all notes</button><button type="button" onclick="window.print()">Print or save as PDF</button><a href="${esc(detail)}">Every table behind these numbers</a></div>`;
  const head = `<h1>Lock in on Crypto.com's exchange: what the trade tape shows</h1>
<p class="lead">Prepared for ${esc(input.audience.name)} by Atticus. Every number here is worked out from the exchange's own public trade tape: real tickets, bought by real customers, each followed to the final whistle. Nothing is simulated.</p>`;

  if (!t.games) {
    return page(input, `${head}<p class="lead">No game has finished yet. A game is counted once it is over and its result is on the tape, about four and a half hours after its start. ${input.recording ? `${num(input.recording)} are being recorded now.` : ""}</p>`, false);
  }

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
      ? `<label>Moment of the game<select name="at">${moments.map((m) => `<option value="${m.atMs}"${m.atMs === past.atMs ? " selected" : ""}>${momentWords(m.atMs, past.startMs)} · bid ${m.bidCents}¢</option>`).join("")}</select></label>`
      : "";
  const form = `<form method="get" action="${esc(input.audience.base)}#lock" class="ask"><input type="hidden" name="k" value="${esc(input.key)}">
<label>Game and side<select name="game" id="lock-game">${lock.live.length ? `<optgroup label="On the board now">${lock.live.map((c) => option(c.value, `${c.inPlay ? "In play · " : ""}${c.label} · bid ${c.bidCents}¢`)).join("")}</optgroup>` : ""}<optgroup label="Finished games, off the tape">${finished.map((f) => option(f.value, f.label)).join("")}</optgroup></select></label>
${momentPick}<label>Contracts held<input name="n" type="number" min="0.01" step="0.01" value="${esc(lock.contracts)}"></label>
<label>Paid per contract, cents<input name="paid" type="number" min="1" max="99" step="0.01" value="${esc(lock.paid)}" placeholder="${past ? "last buy before the start" : "the ask now"}"></label>
<button type="submit">Show the lock</button></form>`;
  const card = lock.quote ? lockQuoteHtml(lock.quote) : '<p class="dim">Pick a game and a side.</p>';

  // the calculator: every figure on it is a count of the replay, scaled
  const base = Object.fromEntries(BROKER_OPTIONS.map((o) => [o.id, brokerBase(lockTallyOf(t, o.id, o.id === "pre_wide" ? "pre" : "all", "small"))]));
  const first = brokerRows(base[BROKER_OPTIONS[0].id], BROKER_DEFAULTS.adoption, BROKER_DEFAULTS.share, BROKER_DEFAULTS.commission);
  const perGame = (v: number) => Math.round(v / t.games);
  const calcRow = (k: keyof typeof first, label: string, small: string, money = false) =>
    `<tr><td class="lbl">${label}<small>${small}</small></td><td><b id="c-${k}">${money ? whole(first[k]) : num(first[k])}</b></td><td id="c-${k}-g">${money ? whole(perGame(first[k])) : num(perGame(first[k]))}</td></tr>`;
  const calc = `<div class="calc" id="calc" data-games="${t.games}" data-base="${esc(JSON.stringify(base))}">
<label>The lock<select id="c-option">${BROKER_OPTIONS.map((o) => `<option value="${o.id}">${esc(o.label)}</option>`).join("")}</select></label>
<label>Of 100 customers who could, how many lock<input id="c-adoption" type="number" min="0" max="100" step="1" value="${BROKER_DEFAULTS.adoption}"></label>
<label>Your share of the exchange's retail tickets, %<input id="c-share" type="number" min="0" max="100" step="1" value="${BROKER_DEFAULTS.share}"></label>
<label>Your commission per contract, cents<input id="c-commission" type="number" min="0" step="0.1" value="${BROKER_DEFAULTS.commission}"></label></div>
<div class="tbl"><table><tr><th>Over these ${num(t.games)} games</th><th>Total</th><th>Per game, mean</th></tr>
${calcRow("orders", "Sell orders added", "each one the customer's own, on the exchange's book")}
${calcRow("contracts", "Contracts sold in them", "new volume on the exchange")}
${calcRow("fees", "Exchange fees on them", `at ${esc(input.feeWords)}`, true)}
${calcRow("commission", "Your commission on them", "at the commission you put in", true)}
${calcRow("saved", "Customers who finish with their lock's cash instead of $0", "their team lost after they locked")}
${calcRow("returned", "Cash those customers keep", "instead of $0", true)}
</table></div>`;

  // the book: how deep and how tight it was, as this service read it
  const pre = input.book?.pre ?? null;
  const live = input.book?.live ?? null;
  const share = (v: number | null | undefined, digits = 0): string => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(digits)}%`);
  const bookLine = (label: string, x: BookFacts) =>
    `<tr><td class="lbl">${label}</td><td>${num(x.readings)}</td><td>${x.meanSpreadCents === null ? "–" : `${x.meanSpreadCents.toFixed(1)}¢`}</td><td>${share(x.depthShare[0])}</td><td><b>${share(x.depthShare[1])}</b></td><td>${share(x.depthShare[2])}</td><td>${share(x.roomShare, x.roomShare !== null && x.roomShare < 0.01 ? 2 : x.roomShare !== null && x.roomShare < 0.1 ? 1 : 0)}</td></tr>`;
  // said only while the count says it
  const room = Math.max(pre?.roomShare ?? 0, live?.roomShare ?? 0);
  const coveredAll = lockTallyOf(t, "live_back80", "all", "small");
  const bookHtml =
    pre || live
      ? `<p>The exchange's best bid and ask on every game's two winner contracts, read once a minute${input.book?.sinceMs ? ` since ${et(input.book.sinceMs)}` : ""}, while the price was between 5¢ and 95¢.</p>
<div class="tbl"><table><tr><th>When</th><th>Readings</th><th>Bid to ask, mean</th><th>100 or more<br><small>contracts at the best bid</small></th><th>1,000 or more</th><th>10,000 or more</th><th>An outside buyer could pay more<br><small>than this bid, covered on another exchange after every fee</small></th></tr>
${pre ? bookLine("Before the start", pre) : ""}${live ? bookLine("In play", live) : ""}</table></div>
<p>The mean retail ticket here is ${meanTicket}, a few dozen contracts. <span class="hl">A sale that size fills in full at the bid shown.</span>${coveredAll.atBook ? ` In the replay, ${pct(coveredAll.covered, coveredAll.atBook)} of the retail stake-back locks priced at a book reading had the whole sale's size at the best bid.` : ""}</p>
<p><b>The order stays on the exchange.</b> The last column asks whether someone outside could offer a customer more than the exchange's own bid and cover it on another US exchange that lists the same game. ${room < 0.05 ? "After every fee, almost never. On these markets the exchange's own book is the customer's best way out, so that is where Lock in sends the order." : "After every fee, in the share of readings shown; the rest of the time the exchange's own book is the customer's best way out."}</p>`
      : `<p class="dim">The book readings are not in yet. They start with the service's first minutes.</p>`;

  const heldShare = pct(back.held10, back.n);
  const rows = (
    [
      ["live_back80", "In play: stake back", "sells just enough to return the whole stake, 80% of the position or less; the rest rides at no cost", back],
      ["live_half", "In play: Max upside with half the stake back", "sells 40% once that returns half the stake; 60% rides", half],
      ["pre_wide", "Before the start: Max upside", "sells 40% at the last bid before the start; 60% rides to the full $1", wide],
    ] as Array<[OptionId, string, string, LockTally]>
  )
    .map(
      ([, name, rule, x]) =>
        `<tr><td class="lbl">${name}<small>${rule}</small></td><td><b>${num(x.n)}</b> · ${pct(x.n, x.eligible)}<small>of ${num(x.eligible)} retail tickets</small></td><td>${num(x.lost)}<small>had paid ${usd(x.lostStake)}, got $0</small></td><td><b class="ok">${usd(x.lostCash)}</b><small>instead of $0</small></td><td>${num(x.won)}</td><td>${usd(x.wonGaveUp)}<small>against riding to the full $1</small></td></tr>`,
    )
    .join("");

  const body = `${head}
${tools}
<div class="strip"><span>Games counted <b>${num(t.games)}</b> <small>${esc(leagues)}${span ? ` · ${span}` : ""}</small></span><span>Tickets opened <b>${num(all.n)}</b> <small>${usd(all.stake)} paid</small></span><span>Retail tickets, $${num(SMALL_USD)} or less <b>${num(retail.n)}</b> <small>${pct(retail.n, all.n)} of all · mean ${meanTicket}</small></span>${input.recording ? `<span>Being recorded now <b>${num(input.recording)}</b> <small>added when they finish</small></span>` : ""}</div>
<div class="kpis now">
<div><small>Retail tickets that finished at $0</small><b>${pct(retail.lost, retail.n)}</b><small>${num(retail.lost)} tickets · ${usd(retail.lostStake)} paid</small></div>
<div><small>Of those, ahead at some point</small><b>${pct(retail.lostAheadEver, retail.lost)}</b><small>${num(retail.lostAheadEver)} tickets · a bid on the book beat what they paid</small></div>
<div><small>Could have taken the whole stake back in play</small><b>${pct(back.n, back.eligible)}</b><small>${num(back.n)} tickets · the rest of the position riding at no cost</small></div>
<div><small>Of those, their team then lost</small><b>${num(back.lost)} tickets</b><small>paid ${usd(back.lostStake)}, got $0 · the lock returns ${usd(back.lostCash)}</small></div>
<div><small>For every 10 in 100 who lock in play</small><b>${num(Math.round(back.n / 10))} sell orders</b><small>${contracts(back.sold / 10)} contracts on the exchange's book</small></div>
</div>

<section data-stop id="s-problem"><h2>1 · Where customers are lost</h2>
${why("For a broker", `<p>A customer whose ticket goes to $0 has nothing left to trade with. ${pct(retail.lostAheadEver, retail.lost)} of them were ahead at some point in the game. That moment is what Lock in is for.</p>`)}
<p>Over these ${num(t.games)} games, customers opened ${num(retail.n)} tickets of $${num(SMALL_USD)} or less and paid ${usd(retail.stake)} for them. <span class="hl">${num(retail.lost)} of them, ${pct(retail.lost, retail.n)}, finished at $0</span>, having paid ${usd(retail.lostStake)}.</p>
<p><span class="hl">${num(retail.lostAheadEver)} of those losing tickets (${pct(retail.lostAheadEver, retail.lost)}) were ahead at some point</span>: after they bought, there was a bid on the exchange that would have paid them more than they put in, fees included. They had paid ${usd(retail.lostAheadStake)}. They were right for part of the game and still left with nothing.</p>
<p>Customers can sell today, and some do: ${pct(t.tape.live.sells, liveTrades)} of trades in play are a holder selling. What nobody shows them is the one sale that returns their stake and leaves the rest riding.</p>
</section>

<section data-stop id="s-what"><h2>2 · What Lock in is</h2>
${why("For a broker", "<p>You stay a broker. Nobody in this picture is the house: not you, not us. The order is one your customer could place by hand today. Lock in works it out and puts it one tap away.</p>")}
<p>One button on an open position. It shows three numbers: the cash now (the floor), what the position pays if the team wins (the cap), and how much of the stake that brings back. Pressing it places the customer's own sell order for part of the position on the exchange's book, at the bid that is there. The rest of the position stays theirs.</p>
<div class="tbl"><table class="who"><tr><th>Who</th><th>What they do</th></tr>
<tr><td class="lbl">The customer</td><td>Sells part of their own position, from their own account.</td></tr>
<tr><td class="lbl">The exchange</td><td>Matches the order against its book like any other, and earns its fee.</td></tr>
<tr><td class="lbl">The broker</td><td>Routes the order like any other, and earns its commission. It takes no side.</td></tr>
<tr><td class="lbl">Atticus</td><td>Works out the lock and the order to send. In this design it holds no customer money and takes no side.</td></tr></table></div>
<p>A sportsbook's cash-out is the house's price, and the house is on the other side of it. <span class="hl">Here the price is the market's bid and the buyer is whoever is bidding.</span></p>
</section>

<section data-stop id="s-ticket"><h2>3 · Two real tickets</h2>
${why("For a broker", "<p>These are two customers, off the tape. The first leaves with their stake instead of nothing. The second still wins, a little less. Both end the night with money in the account.</p>")}
${stories ? `<p>Both are trades on the exchange's tape, picked by rule: the ticket nearest $50, bought between 25¢ and 75¢, in the latest game that has one. The lock is taken at the first bid that returns the whole stake by selling 80% or less.</p><div class="opts">${stories}</div>` : '<p class="dim">No ticket of this size has reached stake back in the games counted so far.</p>'}
<h3 id="lock">Any ticket, at any moment</h3>
<p>Pick a finished game and a moment of it, or a game on the board now. The card is what Lock in would have shown on that position at that bid. Arithmetic on a public price; nothing here places an order.</p>
${form}
${card}
</section>

<section data-stop id="s-replay"><h2>4 · The same, on every retail ticket</h2>
${why("For a broker", `<p>${num(back.lost)} customers in these games left with $0 and would have left with their money back. Whether a customer who gets their stake back trades again sooner is the question a pilot answers. No public data can.</p>`)}
<p>Each ticket is followed from its purchase to the result, and each lock is taken the first time a real bid makes it possible. No hindsight picks the moment.</p>
<div class="tbl"><table><tr><th>The lock</th><th>Tickets that could take it</th><th>Their team then lost</th><th>The lock returns to those</th><th>Their team won</th><th>Winners give up</th></tr>${rows}</table></div>
<p><span class="hl">${pct(back.n, back.eligible)} of retail tickets could have taken their whole stake back in play</span>, on average ${mean(back.minutesSum, back.n)} minutes after the scheduled start, by selling ${mean(back.soldShareSum, back.n, 100)}% of the position. <span class="hl">${num(back.lost)} of those then lost</span>: ${usd(back.lostStake)} paid, $0 back. With the lock, ${usd(back.lostCash)} back. That is ${pct(back.lost, retail.lost)} of every retail ticket that finished at $0.</p>
<p>The chance does not last. Once the stake could come back, it stayed that way for ${mean(back.heldMinutesSum, back.n)} minutes on average before a lower bid was seen, and for ten minutes or more on ${heldShare} of tickets. A customer has to be shown it when it is there.</p>
<div class="note"><b>What it costs the winners.</b> The ${num(back.won)} who locked and then won would have collected ${usd(back.wonGaveUp)} less than by riding. A lock moves money from the games a customer wins to the games they lose. Over many games the two come close, and the difference is the exchange's fees and the spread. What changes is how many customers end a night with nothing.</div>
</section>

<section data-stop id="s-broker"><h2>5 · What it adds for a broker</h2>
${why("For a broker", "<p>Every lock is a sell order that would not otherwise be placed, on the exchange you already route to. Put in your own two numbers: the tape cannot tell us which tickets were yours or what you charge.</p>")}
<p>The counts are retail tickets on the whole exchange. The first box is an assumption: nobody knows how many customers lock until it is in front of them. A ticket can take one lock, so the three choices are alternatives, not a sum.</p>
${calc}
</section>

<section id="s-book"><h2>6 · The book can take it</h2>
${bookHtml}
</section>

<section data-stop id="s-pilot"><h2>7 · What a pilot would answer</h2>
${why("The ask", "<p>Step one needs no change to your app and nothing shown to a customer: fills only, with the account numbers scrambled. It turns the exchange-wide numbers on this page into yours.</p>")}
<p>Three things this page cannot know, because they are not public:</p>
<ul class="limits" style="font-size:15px;color:inherit">
<li><b>How many of your customers lock.</b> The 10 in 100 here is a placeholder.</li>
<li><b>Whether they come back.</b> Does a customer who got their stake back trade again sooner, and more often, than one who finished at $0? That needs account history.</li>
<li><b>Which of these tickets are yours.</b> The tape shows the whole exchange.</li></ul>
<p><b>Step one, in the shadow.</b> The same replay on your own customers' fills, account numbers scrambled. The tables on this page become yours, with who came back added. <b>Step two, live.</b> The button in front of a small share of customers, measured against the rest.</p>
</section>

<h2>Notes and limits</h2>
<ul class="limits">
<li><b>Whose trades.</b> The whole exchange: every broker and app that sends orders to it, and its market makers. The tape does not say which trades came from which.</li>
<li><b>What a ticket is.</b> A taker's buy between 5¢ and 95¢, followed to the result as if held. Some buys close a short, some buyers are market makers, and some holders sold before the end; none of that is visible. One person's three buys are three tickets.</li>
<li><b>A bid that was really there.</b> A lock is priced at the best bid of the book as it was read that minute, or at a taker's sale on the tape. Nothing is inferred from a buy. ${
    t.gamesWithBook === 0
      ? "These games were recorded before the book was kept beside the tape, so every lock here is priced at a taker's sale."
      : t.gamesWithBook === t.games
        ? "Every game here has book readings."
        : `${num(t.gamesWithBook)} of the ${num(t.games)} games have book readings; the others are priced at takers' sales only.`
  }</li>
<li><b>Retail.</b> A ticket that cost $${num(SMALL_USD)} or less. The larger ones are ${pct(all.n - retail.n, all.n, 1)} of tickets and ${pct(all.stake - retail.stake, all.stake)} of the money, and would move the book; they are in the full tables.</li>
<li><b>Fees.</b> The exchange's fee, ${esc(input.feeWords)}, on the buy and on each sale. A broker's commission is not public and is counted only where you put it in.</li>
<li><b>What this is not.</b> A forecast of how many customers lock, or of what a lock does to whether they come back.</li>
</ul>
<p><a href="${esc(detail)}">Every table behind these numbers</a>: all sizes, each league, each game, and how the result is read.</p>`;
  return page(input, body, true);
}

function page(input: ProspectInput, body: string, withGuide: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>Lock in on Crypto.com's exchange</title>
<style>
${SPORTS_PAGE_STYLE}
${LOCK_STYLE}
${PAGE_STYLE}
</style></head><body><main>
${body}
<footer><p><b>Source.</b> Crypto.com's public market-data API for its US exchange: trades and books per contract. No credentials are loaded and nothing here can place an order. Prepared by Atticus Trade, Inc. for ${esc(input.audience.name)}.</p></footer>
</main>${withGuide ? `<div id="guidebar"><button type="button" id="g-prev">Back</button><span id="g-count"></span><button type="button" id="g-next">Next</button><button type="button" id="g-close">Close the guide</button></div><script>${GUIDE_SCRIPT}</script>` : ""}</body></html>`;
}
