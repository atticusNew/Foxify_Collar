/**
 * The founder's brief for one meeting: what to say, the figures behind it, what they come to
 * for the reader's company under three stated cases, what is asked for, and what is not known.
 * An internal page (audiences.ts): never under a reader's key, never sent.
 *
 * Every figure is read from the same replay the reader's page shows, so the two agree whenever
 * they are opened. The words are the brief's own and are written to be read aloud or printed.
 * Unlike the reader's page it says how a lock is made: it is the company's own.
 */

import type { FeeTerms } from "./analytics";
import { CASES, MIN_GAMES, caseOf, perThousand, seasonOf, baseOf, type BriefBase, type CaseInput, type CaseResult } from "./brief";
import { MICRO_PER_CENT, centsOf, lockTerms, netBid, stakeBackSold } from "./lockMath";
import { PAGE_STYLE, type BookCount } from "./prospectHtml";
import { SMALL_USD, dollars, esc, et, league, mean, num, pct, usd, type RecordingRow } from "./replayHtml";
import { SPORTS_PAGE_STYLE } from "./reportHtml";
import { lockTallyOf, openTallyOf, type ReplayReport } from "./tapeReplay";

/** The meeting this brief is for. */
export const MEETING = { who: "Johnny Chen, CEO, Prospect Markets", when: "Tuesday 17 November 2026", reader: "Prospect", company: "Prospect Markets", readerPage: "/prospect" };

export interface BriefInput {
  base: string;
  key: string;
  /** the internal pages' line of links */
  nav: string;
  report: ReplayReport;
  recording: RecordingRow[];
  fee: FeeTerms;
  feeWords: string;
  book: BookCount | null;
  /** the case typed into the page */
  own: CaseInput;
}

const BRIEF_STYLE = `.warn{border-left:3px solid var(--warm);background:#fffaf0;border-radius:0 8px 8px 0;padding:12px 16px;margin:16px 0;max-width:780px;font-size:14.5px}
section>dl,section>.warn,section>h3{max-width:780px}dl.qa dt{font-weight:600;margin:14px 0 2px}dl.qa dd{margin:0;color:#374151}
ol.say,ul.say{padding-left:22px;margin:8px 0}ol.say li,ul.say li{margin:8px 0}
td.r,th.r{text-align:right}td.say{white-space:normal;min-width:260px;color:#374151}tr.total td{font-weight:600;background:#fafafa}tr.dimrow td{color:var(--dim)}
form.own{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:flex-end;margin:14px 0;padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:#fafafa}form.own label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--dim)}form.own input{font:inherit;font-size:15px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:#fff;width:150px}form.own button{font:inherit;padding:7px 14px;border:0;border-radius:6px;background:var(--k);color:#fff;cursor:pointer}
@media print{form.own button,nav{display:none!important}td.say{min-width:160px}section>dl,section>.warn,section>h3{max-width:none}}`;

const whole = (v: number): string => num(Math.round(v));
const cents = (micro: number): string => dollars(Math.round(micro / MICRO_PER_CENT));
const share = (v: number): string => `${(v * 100).toFixed(0)}%`;
const times = (v: number): string => `${num(v, 2)}×`;

export function renderBriefHtml(input: BriefInput): string {
  const { report: r, fee } = input;
  const t = r.all;
  const who = MEETING.reader;
  const h2 = (n: number, title: string): string => `<h2><span class="n">${n}</span>${title}</h2>`;
  const head = `${input.nav}<h1>${esc(who)} meeting brief</h1>
<p class="by">Internal. Not for sending. · ${esc(MEETING.who)} · ${esc(MEETING.when)}</p>
<p class="lead">What to say, the numbers behind it, what they are worth to ${esc(who)}, what we ask for, and what we do not know.</p>
<p class="sub dim">Every figure is worked out now from the same replay as ${esc(who)}'s page, so the two always agree. Read it again on Monday: the numbers move as games finish.</p>
<div class="tools"><button type="button" onclick="window.print()">Print or save as PDF</button></div>`;
  if (!t.games) return page(`${head}<p class="lead">No game has finished yet.</p>`);

  const all = openTallyOf(t);
  const retail = openTallyOf(t, "all", "small");
  const back = lockTallyOf(t, "live_back80", "all", "small");
  const half = lockTallyOf(t, "live_half", "all", "small");
  const base = baseOf(t, t.games, fee);
  const k = perThousand(base);
  const season = seasonOf(r, fee);
  const leagues = Object.entries(r.byLeague)
    .map(([l, x]) => `${league(l)} ${x.games}`)
    .join(" · ");
  const span = t.firstStartMs !== null && t.lastStartMs !== null ? `${et(t.firstStartMs)} to ${et(t.lastStartMs)}` : "";
  const recordingBy = new Map<string, number>();
  for (const g of input.recording) recordingBy.set(g.league, (recordingBy.get(g.league) ?? 0) + 1);
  const recordingWords = [...recordingBy].map(([l, n]) => `${league(l)} ${n}`).join(" · ");
  const meanTicket = retail.n ? cents(retail.stake / retail.n) : "–";
  const kept = back.n ? `${(100 - (back.soldShareSum / back.n) * 100).toFixed(0)}%` : "–";
  const deep = [input.book?.pre ? `${share(input.book.pre.deepShare)} before the start` : "", input.book?.live ? `${share(input.book.live.deepShare)} in play` : ""].filter(Boolean).join(", ");
  const thinNames = season.thin.map(league);
  const countedNames = season.counted.map(league);
  const thinNote = season.thin.length
    ? `<div class="warn"><b>${esc(thinNames.join(" and "))}: too few games to carry to a season.</b> ${season.leagues
        .filter((l) => l.thin)
        .map((l) => `${league(l.league)} rests on ${whole(l.sample.games)} ${l.sample.games === 1 ? "game" : "games"}`)
        .join("; ")}. Its figures are in sections 3 and 4, and it is left out of every season total and every case until ${MIN_GAMES} games are in. The totals in sections 5 and 6 rise when it is counted.</div>`
    : "";

  // 1 · the pitch
  const pitch = `<ol class="say">
<li>On the exchange ${esc(who)} sends orders to, <b>${pct(retail.lost, retail.n)} of retail tickets finish at $0</b>, and <b>${pct(retail.lostAheadEver, retail.lost)} of those were ahead</b> at some point in the game.</li>
<li>Lock in is one button on an open position. The customer takes the stake back in cash, or part of it, and the rest keeps riding.</li>
<li>It is the customer's own order on the exchange, at the market's price. Nobody is the house: not ${esc(who)}, not us.</li>
<li><b>${pct(back.n, back.eligible)} of retail tickets could have taken the whole stake back in play.</b> ${num(back.lost)} of those then lost, and would have left with their money and not with nothing.</li>
<li>The ask is a shadow step on ${esc(who)}'s own customers, with no change to the platform. It measures the one thing public data cannot: whether a customer who got their stake back trades again.</li>
</ol>`;

  // 3 · numbers to know
  const row = (label: string, figure: string, say: string): string => `<tr><td class="lbl">${label}</td><td><b>${figure}</b></td><td class="say">${say}</td></tr>`;
  const numbers = `<div class="tbl"><table><tr><th>What</th><th>Figure</th><th>How to say it, and what it rests on</th></tr>
${row("Games counted", num(t.games), `${esc(leagues)}${span ? `, ${esc(span)}` : ""}. A small sample, growing every night. The same rule is applied to every ticket.`)}
${row(`Retail tickets ($${num(SMALL_USD)} or less)`, num(retail.n), `${pct(retail.n, all.n)} of all tickets, ${usd(retail.stake)} paid, mean ${meanTicket}. The larger ones are left out because they would move the price.`)}
${row("Finished at $0", `${pct(retail.lost, retail.n)}`, `${num(retail.lost)} tickets, ${usd(retail.lostStake)} paid. More than half of retail tickets end with nothing.`)}
${row("Of those, ahead at some point", `${pct(retail.lostAheadEver, retail.lost)}`, `${num(retail.lostAheadEver)} tickets, ${usd(retail.lostAheadStake)} paid. "Ahead" means selling everything at a real price would have paid more than they put in, fees included.`)}
${row("Could take the whole stake back in play", `${pct(back.n, back.eligible)}`, `${num(back.n)} tickets, on average ${mean(back.minutesSum, back.n)} minutes after the scheduled start, with ${kept} of the position still riding.`)}
${row("Of those, their team then lost", num(back.lost), `${pct(back.lost, retail.n, 1)} of all retail tickets and ${pct(back.lost, retail.lost)} of the ones that finished at $0. They paid ${usd(back.lostStake)} and got $0. With the lock: ${usd(back.lostCash)} back.`)}
${row("How long the chance lasts", `${mean(back.heldMinutesSum, back.n)} min`, `On average, before the price fell back. Ten minutes or more on ${pct(back.held10, back.n)} of tickets. This is why it has to be a button shown at the moment, not something the customer works out.`)}
${row("What it costs the winners", usd(back.wonGaveUp), `${num(back.won)} locked and then won. They collect ${usd(back.wonGaveUp)} less than by riding, about ${back.won ? cents(back.wonGaveUp / back.won) : "–"} each. Say this before he asks. A lock moves money from the nights a customer wins to the nights they lose.`)}
${row("Half the stake back, in play", `${pct(half.n, half.eligible)}`, `${num(half.n)} tickets could take half or more back with 60% still riding. ${num(half.lost)} then lost and keep ${usd(half.lostCash)}.`)}
${row("One lock, on average", `${back.n ? num(back.sold / 100 / back.n, 1) : "–"} contracts`, `and ${back.n ? cents(back.fee / back.n) : "–"} in exchange fees at ${esc(input.feeWords)}. A lock is a small order.`)}
${deep ? row("Depth behind the best price", deep, "Share of readings with 1,000 contracts or more at the exchange's best price. A retail lock gets the price shown.") : ""}
</table></div>`;

  // 4 · per 1,000 tickets
  const unit = `<div class="tbl narrow"><table><tr><th>Of every 1,000 retail tickets</th><th class="r">Count</th><th>Money</th></tr>
<tr><td class="lbl">Finish at $0</td><td class="r"><b>${whole(k.lost)}</b></td><td>${usd(k.lostStake)} paid, nothing back</td></tr>
<tr><td class="lbl">Of those, were ahead at some point</td><td class="r">${whole(k.lostAhead)}</td><td></td></tr>
<tr><td class="lbl">Could take the whole stake back in play</td><td class="r"><b>${whole(k.locks)}</b></td><td></td></tr>
<tr><td class="lbl">Of those, the team then loses</td><td class="r"><b>${whole(k.saved)}</b></td><td>keep ${usd(k.savedCash)} and not $0</td></tr>
<tr><td class="lbl">Of those, the team then wins</td><td class="r">${whole(k.won)}</td><td>collect ${usd(k.wonGaveUp)} less than by riding</td></tr>
<tr><td class="lbl">If every one of them locked: contracts traded</td><td class="r">${whole(k.sold / 100)}</td><td>${usd(k.lockFee)} in exchange fees</td></tr>
${k.openFee === null ? "" : `<tr class="dimrow"><td class="lbl">For comparison: buying the 1,000 tickets</td><td class="r">${whole(k.qty / 100)}</td><td>${usd(k.openFee)} in exchange fees</td></tr>`}
</table></div>`;

  // 5 · a season at this rate
  const seasonRow = (name: string, b: BriefBase, sample: BriefBase | null, games: string, note: string, cls = ""): string =>
    `<tr${cls ? ` class="${cls}"` : ""}><td class="lbl">${name}</td><td class="r">${sample ? whole(sample.games) : ""}</td><td class="r">${sample && sample.games ? whole(sample.tickets / sample.games) : ""}</td><td class="r">${games}</td><td class="r">${whole(b.tickets)}</td><td class="r">${whole(b.locks)}</td><td class="r">${usd(b.lockFee)}</td><td>${note}</td></tr>`;
  const seasonTable = `<div class="tbl"><table><tr><th>League</th><th class="r">Games counted</th><th class="r">Retail tickets a game</th><th class="r">Regular-season games</th><th class="r">A season: retail tickets</th><th class="r">A season: could take the stake back</th><th class="r">Exchange fees if every one locked</th><th></th></tr>
${season.leagues.map((l) => seasonRow(league(l.league), l.season, l.sample, whole(l.seasonGames), l.thin ? "not counted: too few games" : "counted", l.thin ? "dimrow" : "")).join("")}
${seasonRow(`Total${countedNames.length ? `: ${esc(countedNames.join(" + "))}` : ""}`, season.total, null, "", "the whole exchange", "total")}
</table></div>`;

  // 6 · the cases
  const cases: Array<[string, CaseInput, CaseResult]> = [
    ["Bear", CASES.bear, caseOf(season.total, CASES.bear)],
    ["Base", CASES.base, caseOf(season.total, CASES.base)],
    ["Bull", CASES.bull, caseOf(season.total, CASES.bull)],
    ["Your own", input.own, caseOf(season.total, input.own)],
  ];
  const caseRow = (label: string, small: string, f: (c: CaseInput, x: CaseResult) => string, cls = ""): string =>
    `<tr${cls ? ` class="${cls}"` : ""}><td class="lbl">${label}${small ? `<small>${small}</small>` : ""}</td>${cases.map(([, c, x]) => `<td class="r">${f(c, x)}</td>`).join("")}</tr>`;
  const caseTable = `<div class="tbl"><table><tr><th>A regular season${countedNames.length ? ` of ${esc(countedNames.join(" and "))}` : ""}, winner markets</th>${cases.map(([name]) => `<th class="r">${name}</th>`).join("")}</tr>
${caseRow(`${esc(who)}'s share of the exchange's retail tickets`, "assumption", (c) => `${num(c.sharePct, 2)}%`, "dimrow")}
${caseRow("Of 100 customers who could lock, how many do", "assumption", (c) => num(c.adoptionPct, 2), "dimrow")}
${caseRow("The exchange's volume against today's", "assumption", (c) => times(c.growth), "dimrow")}
${caseRow(`${esc(who)}'s retail tickets`, "", (_c, x) => whole(x.tickets))}
${caseRow("Paid for them", "", (_c, x) => usd(x.stake))}
${caseRow("Exchange fees on buying them", `at ${esc(input.feeWords)}`, (_c, x) => (x.openFee === null ? "–" : usd(x.openFee)))}
${caseRow("Tickets that could take the stake back", "", (_c, x) => whole(x.couldLock))}
${caseRow("Locks taken", "", (_c, x) => `<b>${whole(x.locks)}</b>`)}
${caseRow("Contracts traded in those locks", "", (_c, x) => whole(x.contracts))}
${caseRow("Exchange fees on those locks", "the direct money", (_c, x) => `<b>${usd(x.lockFee)}</b>`)}
${caseRow("The same, a month", "over twelve months", (_c, x) => usd(x.lockFee / 12))}
${caseRow("Added to the fees on buying", "", (_c, x) => (x.lockFeeShare === null ? "–" : `+${(x.lockFeeShare * 100).toFixed(1)}%`))}
${caseRow(`Each 10% of the exchange fee that ${esc(who)} keeps`, "its share is not public", (_c, x) => usd(x.lockFee / 10))}
${caseRow("Tickets that end with the stake back and not $0", "the retention case", (_c, x) => `<b>${whole(x.saved)}</b>`)}
${caseRow("Cash those customers keep", "", (_c, x) => usd(x.savedCash))}
${caseRow("Winners who locked collect less by", "", (_c, x) => usd(x.wonGaveUp))}
</table></div>
<form method="get" action="${esc(input.base)}/brief#s-cases" class="own"><input type="hidden" name="k" value="${esc(input.key)}">
<label>Your own case: share of the exchange, %<input name="share" type="number" min="0" max="100" step="0.1" value="${input.own.sharePct}"></label>
<label>Of 100 who could, how many lock<input name="adoption" type="number" min="0" max="100" step="1" value="${input.own.adoptionPct}"></label>
<label>Exchange volume against today, times<input name="growth" type="number" min="0" max="100" step="0.1" value="${input.own.growth}"></label>
<button type="submit">Work it out</button></form>`;
  const [bear, mid, bull] = [cases[0][2], cases[1][2], cases[2][2]];
  const caseWords = `<ul class="say">
<li><b>The fees on locks are small.</b> ${usd(bear.lockFee)} to ${usd(bull.lockFee)} a season for the exchange across the three cases, ${usd(mid.lockFee)} in the base case, and ${esc(who)} keeps only part of that. Do not sell Lock in on fee volume.</li>
${mid.lockFeeShare === null ? "" : `<li><b>Locks add about ${(mid.lockFeeShare * 100).toFixed(1)}% to the exchange fees ${esc(who)}'s retail tickets already produce</b> in the base case, and ${bull.lockFeeShare === null ? "more" : `${(bull.lockFeeShare * 100).toFixed(1)}%`} in the bull case. Real, and not the reason to do it.</li>`}
<li><b>The case is the customers.</b> In the base case ${whole(mid.saved)} tickets a season end with the stake back and not $0, and ${usd(mid.savedCash)} stays in customers' accounts. What a customer who stays is worth to ${esc(who)} is ${esc(who)}'s number. Ask for it: it is the business case, and only they have it.</li>
<li><b>These are winner markets in ${esc(countedNames.join(" and ") || "the leagues counted")} only.</b> Spreads, totals, player markets, parlays, playoffs and every other sport are not in them. They are a floor, not the whole of what ${esc(who)} will carry.</li>
</ul>`;

  // 7 · what we charge
  const charge = `<p><b>What we sell.</b> A software licence for Lock in on ${esc(who)}'s platform: when to show it, how much to sell, the three numbers the customer sees, and the measurement of what it does to who comes back.</p>
<ol class="say">
<li><b>Shadow step: free.</b> Our proposal is 30 days. It costs ${esc(who)} nothing and changes nothing on the platform.</li>
<li><b>Live pilot: a flat monthly fee.</b> The button in front of a small share of customers.</li>
<li><b>Rollout: a flat platform fee that steps up in tiers with the number of locks a month.</b></li>
</ol>
<p><b>Why flat, and not a share of each trade.</b> Two reasons. We are not registered, and being paid per trade is a question for a lawyer before it is an offer (<code>docs/event-counsel-questions.md</code>). And the fees on locks are too small to share: ${usd(mid.lockFee / 12)} a month for the whole exchange fee in the base case.</p>
<p><b>The anchor to hold in your head.</b> In the base case the exchange's fees on ${esc(who)}'s locks are about ${usd(mid.lockFee / 12)} a month (${usd(bear.lockFee / 12)} bear, ${usd(bull.lockFee / 12)} bull), and ${esc(who)} keeps a part of that. Any licence fee above its part is paid for by customers who stay, not by fee volume. That is the argument to win, and the shadow step is what gives the evidence for it. This is why the first step is free.</p>
<p><b>On Tuesday, say the shape and not a number.</b> If pressed: "A flat monthly platform fee that steps up with usage. We put numbers on it once the shadow step shows your volume. The shadow step costs you nothing."</p>
<p><b>Do not commit to:</b> a price, exclusivity, a share of each trade, or a date for going live.</p>`;

  // 8 · lock in and selling out, on the ticket the reader's page tells
  const st = r.stories.find((s) => !s.won) ?? r.stories[0];
  let versus = "";
  if (st) {
    const pos = { qty: st.qty, price: st.price };
    const net = netBid(fee, st.bid);
    const sold = stakeBackSold(pos, net, fee);
    const terms = sold === null ? null : lockTerms(pos, sold, st.bid, fee);
    if (terms) {
      const cash = centsOf(terms.cash, "down");
      const cap = centsOf(terms.cap, "down");
      const full = centsOf(terms.fullWin, "down");
      const out = centsOf(pos.qty * net, "down");
      versus = `<p>The losing ticket on ${esc(who)}'s page: ${num(st.qty / 100, 2)} contracts of ${esc(st.team)} at ${num(st.price / 100, 2)}¢, ${dollars(centsOf(terms.stake, "up"))} paid. Later the price is ${num(st.bid / 100, 2)}¢.</p>
<div class="tbl narrow"><table><tr><th>At that moment</th><th class="r">Cash now</th><th class="r">If the team loses</th><th class="r">If the team wins</th><th>Still in the game</th></tr>
<tr><td class="lbl">Hold</td><td class="r">$0.00</td><td class="r">$0.00</td><td class="r">${dollars(full)}</td><td>yes, all of it</td></tr>
<tr><td class="lbl">Sell everything</td><td class="r">${dollars(out)}</td><td class="r">${dollars(out)}</td><td class="r">${dollars(out)}</td><td>no</td></tr>
<tr class="total"><td class="lbl">Lock in: stake back</td><td class="r">${dollars(cash)}</td><td class="r">${dollars(cash)}</td><td class="r">${dollars(cap)}</td><td>yes, ${num(terms.kept / 100, 2)} contracts, at no cost</td></tr>
</table></div>
<p class="dim">Behind it: Lock in sells ${num(terms.sold / 100, 2)} of the ${num(st.qty / 100, 2)} contracts at ${num(st.bid / 100, 2)}¢, just enough to return what was paid after the fee.</p>`;
    }
  }
  const liveTrades = t.tape.live.buys + t.tape.live.sells;
  const versusWords = `<ul class="say">
<li><b>The price is the same.</b> Both are at the market's price for a contract. Selling everything brings more cash now only because every contract is sold. It ends the position.</li>
<li><b>Lock in sells part.</b> Stake back sells just enough to return what was paid. From then on the worst case is break even and the rest of the position rides for free. The other choices sell 40%, 60% or 80%.</li>
<li><b>A sportsbook's cash-out is different again.</b> It is the house's price, with the house's margin, and the house is on the other side. Here the price is the market's and nobody is on the other side.</li>
<li><b>If he asks "is this just the customer selling part of the position?"</b> Yes. It is their own order. What is new is that it is one tap inside the platform, sized for them, shown at the moment it is possible (the chance lasts ${mean(back.heldMinutesSum, back.n)} minutes on average), and measured. Customers do get out by hand today: ${pct(t.tape.live.sells, liveTrades)} of trades in play are a holder's sale. Nothing shows them the part that returns the stake. Keep that figure for when he doubts the demand; it is not on his page.</li>
</ul>`;

  // 9 · integration
  const integration = `<h3>What exists today</h3>
<ul class="say">
<li><b>The figures.</b> The replay on the exchange's public trade tape. It runs by itself and grows every night.</li>
<li><b>The lock on any position at the exchange's live price:</b> the three numbers and the order behind them (<a href="${esc(input.base)}/lock?k=${encodeURIComponent(input.key)}">Lock in now</a>). This is what ${esc(who)}'s button would ask us for.</li>
<li><b>A member app that sends the customer's own order with their consent,</b> working in another exchange's test environment with no real money. It proves the order path. It is not the design proposed here.</li>
<li><b>A demonstration of the button inside a positions list</b> (event.earnandprotect.xyz). It shows simulated positions and a different, hedged shape. Show ${esc(who)}'s page first. Show the demonstration only if he asks what it looks like inside an app, and say what it is.</li>
</ul>
<h3>What does not exist</h3>
<ul class="say">
<li>Any connection to Crypto.com for orders or accounts. The design below does not need one.</li>
<li>Anything that reads ${esc(who)}'s customers' positions or fills.</li>
<li>A quote service with a key for a partner's app. The arithmetic is built; the service around it is a small piece of work.</li>
<li>A signed NDA, a lawyer's answer on how we may be paid, or an agreement.</li>
</ul>
<h3>The design to propose: their button, their order</h3>
<ol class="say">
<li>${esc(who)}'s app shows a Lock in line on an open position.</li>
<li>It asks us for the numbers, sending the contract, the contracts held and the price paid. We answer with the cash now, the total if the team wins, the share of the stake back, and the order that does it.</li>
<li>On the tap, ${esc(who)}'s app sends the customer's own order the way it sends every order.</li>
</ol>
<p>We never see a login, hold money or send an order. That is the least for their compliance to approve, and it keeps us a software supplier.</p>
<h3>The steps</h3>
<ol class="say">
<li><b>NDA,</b> before any of their data moves and before we say how a lock is sized.</li>
<li><b>Shadow step.</b> ${esc(who)} sends its fills with account numbers scrambled. We return the tables of ${esc(who)}'s page on ${esc(who)}'s own customers, with who came back added. Nothing changes on the platform.</li>
<li><b>Live pilot.</b> The button for a small share of customers, measured against the rest.</li>
<li><b>Rollout</b> and the licence.</li>
</ol>
<h3>What ${esc(who)} has to provide</h3>
<ul class="say">
<li><b>For the shadow step:</b> each fill (a scrambled account number, the contract, buy or sell, contracts, price, time), as a daily file or a feed, and the later activity of the same scrambled accounts.</li>
<li><b>For the live pilot:</b> where the line goes in the positions list, the order rules of the app, and one person on product and one on compliance.</li>
</ul>
<h3>What gets built after a yes</h3>
<ul class="say">
<li><b>Shadow step:</b> an intake for their file, and the replay that already exists run on it.</li>
<li><b>Live pilot:</b> the quote service with their key, and a report page for them.</li>
<li>Nothing is built before the meeting, on purpose. Their file format and their order rules are not known until they say.</li>
</ul>`;

  const ask = `<ol class="say">
<li><b>How is ${esc(who)} paid on an order:</b> a share of the exchange's fee, or a charge on top? This tells you what a lock is worth to them directly.</li>
<li><b>What is a customer who stays worth in a year, and how many first-time customers never come back?</b> His numbers are the business case.</li>
<li><b>Can a customer close part of a position in the app today, during a game?</b> With a limit price? In fractions of a contract?</li>
<li><b>Does a new feature in the app need Crypto.com's sign-off?</b> Its clearing firm guarantees ${esc(who)}'s brokerage. Who decides, and how long does it take?</li>
<li><b>Can fills with scrambled account numbers be shared under an NDA,</b> or does that need Crypto.com's consent too?</li>
<li><b>Is ${esc(who)} exclusive to Crypto.com's exchange,</b> and for how long?</li>
<li><b>Who owns this on their side:</b> product, and compliance?</li>
<li><b>What would make a shadow step a yes this month?</b></li>
</ol>`;

  const qa = `<dl class="qa">
<dt>"Is this not just selling part of the position?"</dt><dd>Yes, and it is the customer's own order. Section 8 has the rest of the answer.</dd>
<dt>"Why would we not build it ourselves?"</dt><dd>You can. What we bring is that it is built and measured on your exchange today, the rules for when to show it and how much to sell, and the measurement of whether customers come back. It is months you do not spend, in your first season.</dd>
<dt>"What does it cost?"</dt><dd>The shadow step is free. After that a flat monthly platform fee that steps up with usage. Numbers once the shadow step shows your volume.</dd>
<dt>"How many customers will use it?"</dt><dd>Nobody knows. The cases use 3, 10 and 25 in 100 of those who could, and they are assumptions. That is what a pilot measures.</dd>
<dt>"Will customers who lock trade more?"</dt><dd>We do not know and will not guess. Public data cannot say. The shadow step is built to answer exactly that.</dd>
<dt>"What do the winners lose?"</dt><dd>${usd(back.wonGaveUp)} across ${num(back.won)} tickets that locked and then won, about ${back.won ? cents(back.wonGaveUp / back.won) : "–"} each. Against ${usd(back.lostCash)} returned to ${num(back.lost)} that lost. It moves money from winning nights to losing ones. It does not create money.</dd>
<dt>"The sample is small."</dt><dd>Yes: ${num(t.games)} games so far, more every night, and one rule applied to every ticket with no picking. Every ticket on the page can be checked against the public tape.</dd>
<dt>"Are these our customers?"</dt><dd>No. They are the whole exchange, before ${esc(who)} opened to the public. The page says so. Step one makes them yours.</dd>
<dt>"Does this need Crypto.com?"</dt><dd>The order is an ordinary order from the customer's account. Whether a new feature needs their sign-off is yours to tell us.</dd>
<dt>"Are you registered?"</dt><dd>No. We supply software to a registered firm, and your app sends the order. How we may be paid is with a lawyer, which is why we propose a flat licence. <i>(Stop there.)</i></dd>
<dt>"Is it live anywhere?"</dt><dd>I have used it with real money, in small size, on other regulated venues since 15 October. A member version runs in a regulated exchange's test environment with no real money. A public simulated record has run since 12 September. Nothing has run on Crypto.com's exchange or with your customers. That is the pilot.</dd>
<dt>"Can we have it exclusively?"</dt><dd>Not something to answer on Tuesday. "Let us see what the shadow step shows first."</dd>
</dl>`;

  const hold = `<ul class="say">
<li><b>A retention percentage.</b> We have none. One outside figure you may cite, with its source: Optimove's study of 2.4 million new NFL bettors in the 2025/26 season found that 68% placed one cash bet only, and that losing the first bet lowered the chance of a second. Those are sportsbooks, not prediction markets. Say Optimove.</li>
<li><b>That anyone beats the exchange's price.</b> Measured after every fee, an outside bid has room in well under 1% of readings.</li>
<li><b>Other venues, hedging, anything across venues.</b> Not for this meeting.</li>
<li><b>ParlayX's terms or volumes.</b> Andrew made the introduction and you may name ParlayX. Nothing more.</li>
<li><b>"Guaranteed", "protect", "risk-free".</b></li>
<li><b>How a lock is sized,</b> beyond "enough to return the stake", before an NDA.</li>
<li><b>A price, exclusivity, a share of each trade, a date for going live.</b></li>
</ul>
<h3>Before Tuesday</h3>
<ul class="say">
<li>Monday: read this page and ${esc(who)}'s page again. The weekend's games will be in.${season.thin.length ? ` ${esc(thinNames.join(" and "))} is counted once ${MIN_GAMES} games are in, and the season totals rise with it.` : ""}</li>
<li>${input.recording.length ? `${num(input.recording.length)} games are being recorded now${recordingWords ? ` (${esc(recordingWords)})` : ""}.` : "No game is being recorded at this moment."}</li>
<li>${esc(who)}'s page is at <code>${esc(MEETING.readerPage)}</code> under its own key. Never send an address that starts with <code>${esc(input.base)}</code>.</li>
</ul>`;

  const body = `${head}
<div class="strip facts"><span>Games counted <b>${num(t.games)}</b> <small>${esc(leagues)}${span ? ` · ${esc(span)}` : ""}</small></span><span>Being recorded now <b>${num(input.recording.length)}</b> <small>${esc(recordingWords) || "none"}</small></span><span>Retail tickets <b>${num(retail.n)}</b> <small>${pct(retail.n, all.n)} of all · mean ${meanTicket}</small></span></div>
${thinNote}
<section>${h2(1, "The pitch, in five sentences")}${pitch}</section>
<section>${h2(2, "Who is in the room")}
<ul class="say">
<li><b>${esc(MEETING.company)} is a public company</b> (TSXV: MKT), not part of Crypto.com. It has the platform and the customers. Crypto.com's clearing firm holds the accounts and the money, and Crypto.com's exchange holds the book. Its US arm is a registered introducing broker; it calls itself a sports-native platform.</li>
<li><b>It opened to the public on 12 November 2026,</b> after an invitation-only start in September. The games on the page are the exchange's customers, almost none of them ${esc(who)}'s. Say so first.</li>
<li><b>Its product is a "second screen":</b> live data beside the market while the game is on. A button that appears in play fits that.</li>
<li><b>Other platforms send orders to the same exchange,</b> with the same contracts at the same prices. The line: "Everyone on this exchange has the same book. What does a customer get on ${esc(who)} that they do not get next door?" Do not name the others.</li>
<li><b>How ${esc(who)} is paid on an order is not public.</b> Ask (section 10).</li>
<li><b>No NDA is in place.</b></li>
</ul></section>
<section>${h2(3, "The numbers to know cold")}
<p>All retail, all from the replay. The third column is how to say each one.</p>${numbers}</section>
<section>${h2(4, "The model: every 1,000 retail tickets")}
<p>Whatever volume he gives you in tickets turns into these by multiplying. Nothing here is assumed.</p>${unit}</section>
<section>${h2(5, "A season at this rate")}
<p>Each league's rate per game, carried to its regular season. This is the whole exchange, before any share is taken.</p>${seasonTable}
<ul class="limits">
<li><b>Winner markets only.</b> No spreads, totals, player markets, parlays or futures. No playoffs. No other sport.</li>
<li><b>This month's rate.</b> The exchange's volume a year from now is not known. Section 6 lets you move it.</li>
<li><b>A league with fewer than ${MIN_GAMES} games is shown and not counted.</b> One prime-time game times a season is not a rate.</li>
</ul></section>
<section id="s-cases">${h2(6, `Three cases for ${esc(who)}`)}
<p>Three assumptions set each case. <b>None of them is data.</b> Nobody knows ${esc(who)}'s share a year from now, or how many customers lock. Use the cases to show a range, never as a forecast, and put in his numbers when he gives them.</p>${caseTable}${caseWords}</section>
<section>${h2(7, "What we charge")}${charge}</section>
<section>${h2(8, "Lock in and selling out")}${versus}${versusWords}</section>
<section>${h2(9, "Integration: what exists, what is needed, how to proceed")}${integration}</section>
<section>${h2(10, "Questions to ask him")}
<p>In order of what they are worth to you.</p>${ask}</section>
<section>${h2(11, "Questions he may ask")}${qa}</section>
<section>${h2(12, "Do not say, and before Tuesday")}${hold}</section>`;
  return page(body);
}

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>${esc(MEETING.reader)} meeting brief · internal</title>
<style>
${SPORTS_PAGE_STYLE}
${PAGE_STYLE}
${BRIEF_STYLE}
</style></head><body><main>
${body}
<footer><p><b>Internal.</b> Figures from the exchange's public trade tape through the replay; the cases add assumptions that are stated beside them. Atticus Trade, Inc.</p></footer>
</main></body></html>`;
}
