/**
 * The page made for DraftKings: Lock in on the game-winner contracts of its own exchange, from
 * the files that exchange publishes each day (dkex.ts, dkexRecord.ts). The same conversation as
 * the page made for a broker (prospectHtml.ts), for a reader that is the broker and the exchange
 * at once: where customers are lost, what a lock is to the customer, two real tickets, every
 * retail ticket, league by league, what it adds, and what its own records would answer.
 *
 * What it holds back is what the broker's page holds back: it says what a lock gives the
 * customer and that it is the customer's own order on the exchange, and not what order that is,
 * how it is sized or at what threshold. It names no other venue.
 *
 * What it must say, because these files are thinner than a tape: they do not give which way a
 * trade went, so that is read from the price; times are to the minute; there is no book. The
 * notes at the foot say each, with how far the reading was off where it could be checked.
 *
 * There is no price of the moment to read (the exchange publishes none), so the card takes the
 * price from the reader. Every other figure is read from the record.
 */

import type { FeeTerms } from "./analytics";
import { DKEX_SALE_UNDER } from "./dkex";
import { DKEX_FEE_WORDS, dkexLeague, type DkexRecord } from "./dkexRecord";
import { centsOf, lockTerms, netBid, stakeBackSold } from "./lockMath";
import { lockAtPrice, type LockOption, type LockQuote } from "./lockNow";
import { GUIDE_SCRIPT, PAGE_STYLE, READER_OPTION, brokerBase, type BrokerBase } from "./prospectHtml";
import { LOCK_STYLE, SMALL_USD, contracts, dollars, esc, et, mean, momentWords, num, pct, usd } from "./replayHtml";
import { SPORTS_PAGE_STYLE } from "./reportHtml";
import { LOCK_MAX_BID, LOCK_MIN_BID, lockTallyOf, openTallyOf, type LockTally, type OptionId, type ReplayCounts, type StoryRow } from "./tapeReplay";

export interface DraftKingsInput {
  audience: { name: string; short: string; base: string };
  key: string;
  /** null when the record is not there to read */
  record: DkexRecord | null;
  /** the ticket on the card, as the address gives it; "" for what was not given */
  ask: { contracts: string; paid: string; price: string };
}

/** The locks of the calculator: one a ticket can take, so they are alternatives. */
export const EXCHANGE_OPTIONS: ReadonlyArray<{ key: string; id: OptionId; label: string }> = [
  { key: "stake_back", id: "live_back80", label: "In play: stake back" },
  { key: "half_back", id: "live_half", label: "In play: half the stake back" },
  { key: "before_start", id: "pre_wide", label: "Before the start: Max upside" },
];
export const EXCHANGE_DEFAULTS = { adoption: 10, feeCents: 2 };
/** the leagues a story is told from, in this order: the first with a game that has a ticket of each kind */
export const STORY_LEAGUES = ["nfl", "nba", "nhl", "cfb", "mlb"];

export interface ExchangeRows {
  orders: number;
  contracts: number;
  fees: number;
  saved: number;
  returned: number;
}
/** What `adoption` in 100 of the retail holders who could lock comes to, with `feeCents` earned on each contract. The script on the page does this same sum. */
export function exchangeRows(b: BrokerBase, adoption: number, feeCents: number): ExchangeRows {
  const f = adoption / 100;
  return { orders: Math.round(b.orders * f), contracts: Math.round(b.contracts * f), fees: Math.round((b.contracts * f * feeCents) / 100), saved: Math.round(b.saved * f), returned: Math.round(b.returned * f) };
}

const optionBase = (c: ReplayCounts, id: OptionId): BrokerBase => brokerBase(lockTallyOf(c, id, id === "pre_wide" ? "pre" : "all", "small"));

/** The lost ticket and the won one of the latest game that has both, in the first league of STORY_LEAGUES that has such a game; else the latest of each. */
export function storiesToTell(stories: StoryRow[]): StoryRow[] {
  const pair = (rows: StoryRow[]): StoryRow[] | null => {
    for (const lost of rows) {
      if (lost.won) continue;
      const won = rows.find((s) => s.won && s.event === lost.event);
      if (won) return [lost, won];
    }
    return null;
  };
  for (const l of STORY_LEAGUES) {
    const found = pair(stories.filter((s) => s.league === l));
    if (found) return found;
  }
  return pair(stories) ?? [stories.find((s) => !s.won), stories.find((s) => s.won)].flatMap((s) => (s ? [s] : []));
}

/** "DraftKings'" and "Prospect's" */
const of = (name: string): string => (/s$/i.test(name) ? `${name}'` : `${name}'s`);
const day = (ymd: string): string => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
const why = (title: string, body: string): string => `<aside class="why"><b>${esc(title)}</b>${body}</aside>`;
const whole = (v: number): string => `$${v.toLocaleString("en-US")}`;
const cents = (price: number): string => `${num(price / 100, 2)}¢`;

/** A real ticket, told by what its holder had. Its lock is counted a cent under the trade it is taken at. */
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
<p class="dim">${esc(dkexLeague(st.league))} · ${esc(st.label)}</p>
<p>${et(st.openedMs)}: someone buys ${num(st.qty / 100, 2)} contracts of ${esc(st.team)} to win at ${cents(st.price)}. That is <b>${dollars(stake)}</b> with the fee.</p>
<p>${momentWords(st.atMs, st.startMs)} the contract trades at ${cents(st.bid + DKEX_SALE_UNDER)}. Lock in there, counted a cent lower at ${cents(st.bid)}: <b>${dollars(cash)}</b> back in cash, the whole stake, and ${dollars(cap - cash)} still to win.</p>
${end}
<p class="more"><a href="${esc(href)}">See every choice on this ticket</a></p></div>`;
}

/** The lock on a ticket at a price the reader gives: for each choice the cash now, the total if the side wins and the share of the stake back. */
export function ticketLockHtml(q: LockQuote): string {
  const head = `<div class="strip"><span>Position <b>${num(q.contracts, 2)} contracts at ${q.paidCents}¢</b> <small>paid ${dollars(q.stakeCents)} with the fee</small></span><span>Price now <b>${q.bidCents}¢</b></span><span>Riding with no lock <b>${dollars(q.fullWinCents)} or $0.00</b></span></div>`;
  const card = (o: LockOption): string => {
    const [name, words] = READER_OPTION[o.id];
    return `<div class="opt"><h3>${esc(name)}</h3><p class="dim">${esc(words)}</p>
<div class="three"><div><small>Cash now</small><b>${dollars(o.floorCents)}</b></div><div><small>Total if they win</small><b>${dollars(o.capCents)}</b></div><div><small>Stake returned</small><b>${o.backPercent}%</b></div></div>
<p>If the team loses: <b>${dollars(o.floorCents)}</b> instead of $0.00. If it wins: <b>${dollars(o.capCents)}</b> instead of ${dollars(q.fullWinCents)}.</p></div>`;
  };
  const open = q.bidCents * 100 >= LOCK_MIN_BID && q.bidCents * 100 <= LOCK_MAX_BID;
  const none = q.options.length
    ? ""
    : `<p class="lead">${
        !(q.paidCents > 0)
          ? "Say what was paid per contract, between 1¢ and 99¢."
          : !(q.bidCents > 0)
            ? "Say the price now, between 1¢ and 99¢."
            : !open
              ? `The price is ${q.bidCents}¢. Outside 5¢ to 95¢ the result is all but known and no lock is shown.`
              : "No lock can be shown on this position at this price."
      }</p>`;
  const from = q.stakeBackFromCents;
  const back = !q.options.length || from === undefined ? "" : from === null ? '<p class="dim">Stake back is not available on this position.</p>' : `<p class="dim">Stake back is not available at this price. On this position it opens at ${from}¢.</p>`;
  return `${head}${none}<div class="opts">${q.options.map(card).join("")}</div>${q.options.length ? `<p class="dim">Cash figures are after the fee, ${esc(DKEX_FEE_WORDS)}.</p>` : ""}${back}`;
}

/** The calculator's sum in the browser: exchangeRows, per league. */
export const EXCHANGE_SCRIPT = `(function(){var el=document.getElementById('dk-calc');if(!el)return;
var base=JSON.parse(el.getAttribute('data-base'));
var val=function(id,lo,hi){var v=Number(document.getElementById(id).value);return isFinite(v)?Math.max(lo,Math.min(hi,v)):lo};
var put=function(k,v,money){var n=Math.round(v).toLocaleString('en-US');document.getElementById('d-'+k).textContent=money?'$'+n:n};
var run=function(){var l=base[document.getElementById('d-league').value],b=l[document.getElementById('d-option').value],g=l.games||1,f=val('d-adoption',0,100)/100,c=val('d-fee',0,1000);
put('orders',b.orders*f);put('contracts',b.contracts*f);put('fees',b.contracts*f*c/100,1);put('saved',b.saved*f);put('returned',b.returned*f,1);
put('orders-g',b.orders*f/g);put('contracts-g',b.contracts*f/g);put('fees-g',b.contracts*f*c/100/g,1);put('saved-g',b.saved*f/g);put('returned-g',b.returned*f/g,1);
document.getElementById('d-games').textContent=l.games.toLocaleString('en-US')};
['d-league','d-option','d-adoption','d-fee'].forEach(function(id){var e=document.getElementById(id);e.oninput=run;e.onchange=run})})();`;

const DK_STYLE = `.strip.facts{grid-template-columns:1.2fr 1fr 1.2fr}.calc.four{grid-template-columns:1fr 1.2fr 1fr 1fr}`;

export function renderDraftKingsHtml(input: DraftKingsInput): string {
  const who = esc(input.audience.short);
  const whose = esc(of(input.audience.short));
  const head = `<h1>Lock in on ${who} Predictions</h1>
<p class="by">What DKeX's public trade files show · Prepared for ${esc(input.audience.name)} by Atticus</p>`;
  const rec = input.record;
  const t = rec?.report.all;
  if (!rec || !t || !t.games) return page(input, `${head}<p class="lead">The record of DKeX's games is not on this service yet.</p>`, false);

  const fee = rec.fee;
  const home = `${input.audience.base}?k=${encodeURIComponent(input.key)}`;
  const all = openTallyOf(t);
  const retail = openTallyOf(t, "all", "small");
  const back = lockTallyOf(t, "live_back80", "all", "small");
  // half the stake at 40% of the position and the whole stake at 80% need the same price
  const sameMoment = lockTallyOf(t, "live_half", "all", "small").n === back.n;
  const half = lockTallyOf(t, "live_half", "all", "small");
  const wide = lockTallyOf(t, "pre_wide", "pre", "small");
  const leagues = Object.entries(rec.report.byLeague).sort(([, a], [, b]) => openTallyOf(b, "all", "small").n - openTallyOf(a, "all", "small").n);
  const meanTicket = retail.n ? dollars(Math.round(retail.stake / retail.n / 10_000)) : "–";
  const span = `${day(rec.firstDay)} to ${day(rec.lastDay)}`;
  const h2 = (n: number, title: string): string => `<h2><span class="n">${n}</span>${title}</h2>`;
  const tools = `<div class="tools"><button type="button" id="g-start">Guide</button><button type="button" id="g-all">Show all notes</button><button type="button" onclick="window.print()">Print or save as PDF</button></div>`;
  const lead = `<p class="lead">Across ${num(t.games)} games on DKeX, ${pct(retail.lost, retail.n)} of retail tickets on a team to win finished at $0, and ${pct(retail.lostAheadEver, retail.lost)} of those were ahead at some point in the game. Lock in is one button that lets a customer take their stake back in cash, or part of it, and keep the rest of the position riding.</p>
<p class="sub dim">Every number here is worked out from the trades in the files DKeX publishes each day, through ${day(rec.lastDay)}, each ticket followed to the result. Nothing is simulated. The files do not say which way a trade went; that is read from its price, and the notes at the foot say how far that reading can be off.</p>`;

  const told = storiesToTell(rec.report.stories);
  const ticketHref = (s: StoryRow) => `${home}&n=${s.qty / 100}&paid=${s.price / 100}&price=${s.bid / 100}#lock`;
  const stories = told.map((s) => storyHtml(s, fee, ticketHref(s))).join("");

  // the card: the ticket the address names, else the first ticket told, else an ordinary one
  const first = told[0];
  const ask = {
    contracts: input.ask.contracts || (first ? String(first.qty / 100) : "100"),
    paid: input.ask.paid || (first ? String(first.price / 100) : "48"),
    price: input.ask.price || (first ? String(first.bid / 100) : "66"),
  };
  const quote = lockAtPrice(ask, fee);
  const form = `<form method="get" action="${esc(input.audience.base)}#lock" class="ask"><input type="hidden" name="k" value="${esc(input.key)}">
<label>Contracts held<input name="n" type="number" min="0.01" step="0.01" value="${esc(ask.contracts)}"></label>
<label>Paid per contract, cents<input name="paid" type="number" min="1" max="99" step="0.01" value="${esc(ask.paid)}"></label>
<label>Price now, cents<input name="price" type="number" min="1" max="99" step="0.01" value="${esc(ask.price)}"></label>
<button type="submit">Show the lock</button></form>`;

  // the calculator: every figure on it is a count of the replay, scaled
  const baseOf = (c: ReplayCounts & { games: number }) => ({ games: c.games, ...Object.fromEntries(EXCHANGE_OPTIONS.map((o) => [o.key, optionBase(c, o.id)])) });
  const base: Record<string, ReturnType<typeof baseOf>> = { all: baseOf(t), ...Object.fromEntries(leagues.map(([l, c]) => [l, baseOf(c)])) };
  const firstRows = exchangeRows(optionBase(t, EXCHANGE_OPTIONS[0].id), EXCHANGE_DEFAULTS.adoption, EXCHANGE_DEFAULTS.feeCents);
  const perGame = (v: number) => Math.round(v / t.games);
  const calcRow = (k: keyof ExchangeRows, label: string, small: string, money = false) =>
    `<tr><td class="lbl">${label}<small>${small}</small></td><td><b id="d-${k}">${money ? whole(firstRows[k]) : num(firstRows[k])}</b></td><td id="d-${k}-g">${money ? whole(perGame(firstRows[k])) : num(perGame(firstRows[k]))}</td></tr>`;
  const calc = `<div class="calc four" id="dk-calc" data-base="${esc(JSON.stringify(base))}">
<label>League<select id="d-league"><option value="all">Every league</option>${leagues.map(([l]) => `<option value="${esc(l)}">${esc(dkexLeague(l))}</option>`).join("")}</select></label>
<label>The lock<select id="d-option">${EXCHANGE_OPTIONS.map((o) => `<option value="${o.key}">${esc(o.label)}</option>`).join("")}</select></label>
<label>Of 100 customers who could, how many lock<input id="d-adoption" type="number" min="0" max="100" step="1" value="${EXCHANGE_DEFAULTS.adoption}"></label>
<label>What ${who} earns per contract, cents<input id="d-fee" type="number" min="0" step="0.1" value="${EXCHANGE_DEFAULTS.feeCents}"></label></div>
<div class="tbl narrow"><table><tr><th>Over <span id="d-games">${num(t.games)}</span> games</th><th>Total</th><th>Per game, mean</th></tr>
${calcRow("orders", "Orders from locks", "each one the customer's own, on DKeX")}
${calcRow("contracts", "Contracts traded in them", "volume on DKeX")}
${calcRow("fees", `${whose} earnings on them`, "at the figure put in above", true)}
${calcRow("saved", "Customers who finish with their lock's cash instead of $0", "their team lost after they locked")}
${calcRow("returned", "Cash those customers keep", "instead of $0", true)}
</table></div>`;

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

  const leagueRows = leagues
    .map(([l, c]) => {
      const r = openTallyOf(c, "all", "small");
      const b = lockTallyOf(c, "live_back80", "all", "small");
      return `<tr><td class="lbl">${esc(dkexLeague(l))}<small>${num(c.games)} games</small></td><td>${num(r.n)}<small>${usd(r.stake)} paid</small></td><td>${pct(r.lost, r.n)}</td><td>${pct(r.lostAheadEver, r.lost)}</td><td><b>${pct(b.n, b.eligible)}</b></td><td>${num(b.lost)}<small>${pct(b.lost, r.lost)} of those at $0</small></td><td><b class="ok">${usd(b.lostCash)}</b></td></tr>`;
    })
    .join("");

  const x = rec.exchange;
  const body = `${head}
${lead}
${tools}
<div class="strip facts"><span>Games counted <b>${num(t.games)}</b> <small>${leagues.length} leagues · files of ${span}</small></span><span>Tickets followed <b>${num(all.n)}</b> <small>${usd(all.stake)} paid</small></span><span>Retail tickets, $${num(SMALL_USD)} or less <b>${num(retail.n)}</b> <small>${pct(retail.n, all.n)} of all · mean ${meanTicket}</small></span></div>
<div class="kpis now">
<div><small>Retail tickets that finished at $0</small><b>${pct(retail.lost, retail.n)}</b><small>${num(retail.lost)} tickets · ${usd(retail.lostStake)} paid</small></div>
<div><small>Of those, ahead at some point</small><b>${pct(retail.lostAheadEver, retail.lost)}</b><small>${num(retail.lostAheadEver)} tickets · worth more than was paid, fees included</small></div>
<div><small>Could have taken the whole stake back in play</small><b>${pct(back.n, back.eligible)}</b><small>${num(back.n)} tickets · the rest of the position riding at no cost</small></div>
<div><small>Of those, their team then lost</small><b>${num(back.lost)} <i>tickets</i></b><small>paid ${usd(back.lostStake)}, got $0 · the lock returns ${usd(back.lostCash)}</small></div>
<div><small>For every 10 in 100 who lock in play</small><b>${num(Math.round(back.n / 10))} <i>orders</i></b><small>${contracts(back.sold / 10)} contracts on DKeX</small></div>
</div>

<section data-stop id="s-problem">${h2(1, "Where customers are lost")}
${why(`For ${who}`, `<p>A customer whose ticket goes to $0 has nothing left to trade with. ${pct(retail.lostAheadEver, retail.lost)} of them were ahead at some point in the game. That moment is what Lock in is for.</p>`)}
<p>Over these ${num(t.games)} games, ${num(retail.n)} tickets of $${num(SMALL_USD)} or less were opened on a team to win, for ${usd(retail.stake)}. <span class="hl">${num(retail.lost)} of them, ${pct(retail.lost, retail.n)}, finished at $0</span>, having paid ${usd(retail.lostStake)}.</p>
<p><span class="hl">${num(retail.lostAheadEver)} of those losing tickets (${pct(retail.lostAheadEver, retail.lost)}) were ahead at some point</span>: after they bought, the contract traded at a price at which the ticket was worth more than had been put in, fees included. They had paid ${usd(retail.lostAheadStake)}. They were right for part of the game and still left with nothing.</p>
</section>

<section data-stop id="s-what">${h2(2, "What Lock in is")}
${why(`For ${who}`, `<p>A sportsbook customer knows Cash Out. This is that moment on Predictions, at the exchange's own price. ${who} stays the broker and the exchange. Atticus takes no side of it.</p>`)}
<p>One button on an open position. It shows the customer three numbers: the cash they can take now (the floor), what the position pays in all if their team wins (the cap), and how much of what they paid that brings back. One tap takes it. The rest of the position stays theirs and keeps riding.</p>
<p>It is done on DKeX, from the customer's own account, at the market's price. <span class="hl">For ${who} it is one more order on its own exchange</span>, with the fee on it that every order carries.</p>
</section>

<section data-stop id="s-ticket">${h2(3, "Two real tickets")}
${why(`For ${who}`, "<p>These are two trades out of DKeX's own file. The first leaves with the stake instead of nothing. The second still wins, a little less. Both end the night with money in the account.</p>")}
${stories ? `<p>Both are trades in DKeX's Time &amp; Sales file, picked by a fixed rule and not by hand: the ticket nearest $50, bought between 25¢ and 75¢, in the latest game that has one of each. Lock in is taken at the first moment the whole stake could come back.</p><div class="opts">${stories}</div>` : '<p class="dim">No ticket of this size has reached stake back in the games counted so far.</p>'}
<h3 id="lock">Any ticket, at any price</h3>
<p>Put in a position and the contract's price now. The card is what Lock in would show the customer. Arithmetic on the numbers typed in; nothing here places an order.</p>
${form}
${ticketLockHtml(quote)}
</section>

<section data-stop id="s-replay">${h2(4, "The same, on every retail ticket")}
${why(`For ${who}`, `<p>${num(back.lost)} tickets in these games finished at $0 and would have finished with the money back. Whether a customer who gets their stake back trades again sooner is the question ${whose} own records answer. No public data can.</p>`)}
<p>Each ticket is followed from its purchase to the result, and each lock is taken the first moment a real price makes it possible. No hindsight picks the moment.${sameMoment ? " The first two rows become possible at the same price, so the same tickets could take either: they are two choices at one moment, not two groups of customers." : ""}</p>
<div class="tbl"><table><tr><th>The lock, and what it gives</th><th>Tickets that could take it</th><th>Their team then lost</th><th>The lock returns to those</th><th>Their team won</th><th>Winners give up</th></tr>${rows}</table></div>
<p><span class="hl">${pct(back.n, back.eligible)} of retail tickets could have taken their whole stake back in play</span>, on average ${mean(back.minutesSum, back.n)} minutes after the start, with ${kept(back)} of the position still riding. <span class="hl">${num(back.lost)} of those then lost</span>: ${usd(back.lostStake)} paid, $0 back. With the lock, ${usd(back.lostCash)} back. That is ${pct(back.lost, retail.lost)} of every retail ticket that finished at $0.</p>
<p>The chance does not last. Once the stake could come back, it stayed that way for ${mean(back.heldMinutesSum, back.n)} minutes on average before the price fell back, and for ten minutes or more on ${pct(back.held10, back.n)} of tickets. A customer has to be shown it when it is there.</p>
<div class="note"><b>What it costs the winners.</b> The ${num(back.won)} who locked and then won would have collected ${usd(back.wonGaveUp)} less than by riding. A lock moves money from the games a customer wins to the games they lose. Over many games the two come close, and the difference is the fees and the spread. What changes is how many customers end a night with nothing.</div>
</section>

<section data-stop id="s-leagues">${h2(5, "League by league")}
${why(`For ${who}`, "<p>A lock is only counted at a price that traded. A league with few trades in play shows fewer locks here than its customers would have had.</p>")}
<p>The same count, one league at a time, the busiest first. Retail tickets only.</p>
<div class="tbl"><table><tr><th>League</th><th>Retail tickets</th><th>Finished at $0</th><th>Of those, ahead at some point</th><th>Could take the whole stake back in play</th><th>Of those, their team then lost</th><th>The lock returns to those</th></tr>${leagueRows}</table></div>
</section>

<section data-stop id="s-adds">${h2(6, `What it adds for ${who}`)}
${why(`For ${who}`, `<p>Every lock is one more order on DKeX. The last box starts at the 2¢ a customer pays per contract; put in what ${who} earns on a contract in all.</p>`)}
<p>The counts are retail tickets on the whole exchange. The third box is an assumption, since nobody knows how many customers lock until it is in front of them. A ticket can take one lock, so the three choices are alternatives, not a sum.</p>
${calc}
</section>

<section data-stop id="s-pilot">${h2(7, `What ${whose} own records would answer`)}
${why("The ask", `<p>Step one needs no change to the product and nothing shown to a customer. It turns the public numbers on this page into ${whose} own.</p>`)}
<p>Four things this page cannot know, because the public files do not carry them:</p>
<ul class="asks">
<li><b>Which trades are customers'.</b> The files hold every member's trades, market makers' among them.</li>
<li><b>Which way each trade went.</b> Read here from the price. ${whose} records say it outright.</li>
<li><b>How many customers lock.</b> The 10 in 100 here is a placeholder.</li>
<li><b>Whether they come back.</b> Does a customer who got their stake back trade again sooner, and more often, than one who finished at $0? That needs account history.</li></ul>
<p>Two steps:</p>
<ol class="steps">
<li><b>In the shadow.</b> These same tables on ${whose} own records as customers trade, account numbers scrambled, with who came back added. Nothing changes in the product.</li>
<li><b>Live.</b> The button in front of a small share of customers, measured against the rest.</li></ol>
</section>

<h2>Notes and limits</h2>
<ul class="limits">
<li><b>Source.</b> DKeX's Time &amp; Sales, Daily Market and Daily Settlement files, ${num(rec.days)} days of them, ${span}. They are published a day after the trading day, so this page ends with the last one read.</li>
<li><b>What is covered.</b> Contracts on a team to win a game: ${num(x.winnerPrints)} of the ${num(x.prints)} trades in those files and ${pct(x.winnerContracts, x.contracts, 1)} of the contracts. Combos are ${pct(x.comboContracts, x.contracts)} of the contracts and are not covered, nor is any other market. A game is counted once both its contracts settled, one at $1.00 and one at $0.00: ${num(t.games)} of ${num(rec.listed)} listed.</li>
<li><b>Whose trades.</b> Every member of the exchange. The files do not say which trades are customers'.</li>
<li><b>Which way a trade went.</b> The files give a trade's minute, price and size, not which way it went. It is read from the price. Checked on 58 games of a public tape that does say: read this way, the tickets counted came out 12% under the true count, the share that could take the whole stake back 3 points under, the cash the lock returns to losing tickets 4 points under, and the share of losing tickets that had been ahead 2 points over.</li>
<li><b>What a ticket is.</b> A trade between 5¢ and 95¢ read as opening a position, followed to the result as if held. Some holders got out before the end; that is not visible. One person's three buys are three tickets.</li>
<li><b>Real prices.</b> Every lock is worked out one cent under a price that traded on that contract at that moment. The files carry no order book, so nothing is said here of the size behind a price.</li>
<li><b>Time.</b> Trades are stamped to the minute and kept in the file's order within it. A game's start is read from its contracts' maturity, which is thirty days after it.</li>
<li><b>Retail.</b> A ticket that cost $${num(SMALL_USD)} or less. The larger ones are ${pct(all.n - retail.n, all.n, 1)} of tickets and ${pct(all.stake - retail.stake, all.stake)} of the money, would move the price, and are left out of every figure below the top strip.</li>
<li><b>Fees.</b> The customer's fee, ${esc(DKEX_FEE_WORDS)}, is in every figure: on the purchase and again on the lock. Under 30¢ and over 94¢ the fee is less than that; 2¢ is counted there too. What ${who} earns beyond it is not public and is counted only where it is put in.</li>
<li><b>What this is not.</b> A forecast of how many customers lock, or of what a lock does to whether they come back.</li>
</ul>`;
  return page(input, body, true);
}

function page(input: DraftKingsInput, body: string, withGuide: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>Lock in on ${esc(input.audience.short)} Predictions · ${esc(input.audience.name)}</title>
<style>
${SPORTS_PAGE_STYLE}
${LOCK_STYLE}
${PAGE_STYLE}
${DK_STYLE}
</style></head><body><main>
${body}
<footer><p><b>Source.</b> DKeX's public daily files. Nothing on this page places an order. Prepared by Atticus Trade, Inc. for ${esc(input.audience.name)}.</p></footer>
</main>${withGuide ? `<div id="guidebar"><button type="button" id="g-prev">Back</button><span id="g-count"></span><button type="button" id="g-next">Next</button><button type="button" id="g-close">Close the guide</button></div><script>${GUIDE_SCRIPT}</script><script>${EXCHANGE_SCRIPT}</script>` : ""}</body></html>`;
}
