/** The two Lock in pages of the sports service: the replay over real trades, and the lock on a position now. Server-rendered, no script. */

import { pageLinksHtml, type PageLink } from "../btcCurve/pageLinks";
import { MICRO_PER_DOLLAR, TIER_SHARE } from "./lockMath";
import type { LockChoice, LockQuote } from "./lockNow";
import { SPORTS_PAGE_STYLE, sportsNavHtml, sportsPaths } from "./reportHtml";
import { BACK_SHARE, HALF_BACK_PERCENT, LIVE_OPTIONS, OPENED, PRE_OPTIONS, SMALL_STAKE_MICRO, lockTallyOf, openTallyOf, type Bucket, type LockTally, type OptionId, type ReplayCounts, type ReplayGameRow, type ReplayReport, type ReplayTotals } from "./tapeReplay";

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const num = (v: number, digits = 0): string => v.toLocaleString("en-US", { maximumFractionDigits: digits });
const usd = (micro: number): string => `${micro < 0 ? "−" : ""}$${Math.round(Math.abs(micro) / MICRO_PER_DOLLAR).toLocaleString("en-US")}`;
const dollars = (cents: number): string => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const contracts = (qty: number): string => num(Math.round(qty / 100));
const pct = (part: number, whole: number, digits = 0): string => (whole > 0 ? `${((part / whole) * 100).toFixed(digits)}%` : "–");
const et = (ms: number): string => `${new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET`;
const LEAGUE = { nfl: "NFL", nba: "NBA", nhl: "NHL" } as Record<string, string>;
const league = (l: string): string => LEAGUE[l] ?? l.toUpperCase();
const SMALL_USD = Math.round(SMALL_STAKE_MICRO / MICRO_PER_DOLLAR);

export const OPTION_NAME: Record<OptionId, string> = {
  pre_wide: "Max upside",
  pre_balanced: "Balanced",
  pre_tight: "Max floor",
  live_half: "Max upside, half back",
  live_back80: "Stake back, 20% or more rides",
  live_back60: "Stake back, 40% or more rides",
  live_back40: "Stake back, 60% or more rides",
};
export const OPTION_RULE: Record<OptionId, string> = {
  pre_wide: `sells ${TIER_SHARE.wide}% at the last bid before the start`,
  pre_balanced: `sells ${TIER_SHARE.balanced}% at the last bid before the start`,
  pre_tight: `sells ${TIER_SHARE.tight}% at the last bid before the start`,
  live_half: `sells ${TIER_SHARE.wide}% the first time that returns ${HALF_BACK_PERCENT}% of the stake or more`,
  live_back80: `sells just enough to return the stake, the first time that is ${BACK_SHARE.live_back80}% of the position or less`,
  live_back60: `the same, the first time it is ${BACK_SHARE.live_back60}% or less`,
  live_back40: `the same, the first time it is ${BACK_SHARE.live_back40}% or less`,
};

const mean = (sum: number, n: number, scale = 1, digits = 0): string => (n > 0 ? ((sum / n) * scale).toFixed(digits) : "–");

function preTable(c: ReplayCounts, bucket: Bucket | "all"): string {
  const rows = PRE_OPTIONS.map((id) => {
    const t = lockTallyOf(c, id, "pre", bucket);
    const net = t.lostCash - t.wonGaveUp;
    return `<tr><td class="lbl">${esc(OPTION_NAME[id])}<small>${esc(OPTION_RULE[id])}</small></td><td>${num(t.n)}<small>of ${num(t.eligible)} opened before the start</small></td><td><b>${mean(t.backShareSum, t.n, 100)}%</b><small>of the stake, mean</small></td><td>${num(t.lost)}<small>${pct(t.lost, t.n)} of them · had paid ${usd(t.lostStake)}</small></td><td><b class="ok">${usd(t.lostCash)}</b><small>instead of $0</small></td><td>${num(t.won)}<small>${pct(t.won, t.n)} of them</small></td><td>${usd(t.wonGaveUp)}<small>against riding to the full $1</small></td><td>${usd(net)}</td><td>${usd(t.fee)}<small>on ${contracts(t.sold)} contracts sold</small></td></tr>`;
  }).join("");
  return `<div class="tbl"><table><tr><th>Option</th><th>Positions locked</th><th>Floor</th><th>Their side lost</th><th>Kept by those</th><th>Their side won</th><th>Given up by those</th><th>Kept less given up</th><th>Exchange fees on the sales</th></tr>${rows}</table></div>`;
}

function liveTable(c: ReplayCounts, bucket: Bucket | "all"): string {
  const rows = LIVE_OPTIONS.map((id) => {
    const t = lockTallyOf(c, id, "all", bucket);
    const split = OPENED.map((o) => {
      const x = lockTallyOf(c, id, o, bucket);
      return `${o === "pre" ? "opened before the start" : "opened in play"} ${num(x.n)} (${pct(x.n, x.eligible)})`;
    }).join(" · ");
    const net = t.lostCash - t.wonGaveUp;
    return `<tr><td class="lbl">${esc(OPTION_NAME[id])}<small>${esc(OPTION_RULE[id])}</small></td><td><b>${num(t.n)}</b> · ${pct(t.n, t.eligible)}<small>of ${num(t.eligible)} positions · ${split}</small></td><td>${mean(t.soldShareSum, t.n, 100)}%<small>floor ${mean(t.backShareSum, t.n, 100)}% of the stake</small></td><td>${mean(t.minutesSum, t.n)} min<small>after the scheduled start, mean</small></td><td><b>${num(t.lost)}</b> · ${pct(t.lost, t.n)}<small>had paid ${usd(t.lostStake)} and got $0</small></td><td><b class="ok">${usd(t.lostCash)}</b><small>instead of $0</small></td><td>${num(t.won)}<small>${pct(t.won, t.n)} of them</small></td><td>${usd(t.wonGaveUp)}<small>against riding to the full $1</small></td><td>${usd(net)}</td><td>${usd(t.fee)}<small>on ${contracts(t.sold)} contracts sold</small></td></tr>`;
  }).join("");
  return `<div class="tbl"><table><tr><th>Option</th><th>Positions that reached it</th><th>Sold, mean</th><th>When</th><th>Their side then lost</th><th>Kept by those</th><th>Their side won</th><th>Given up by those</th><th>Kept less given up</th><th>Exchange fees on the sales</th></tr>${rows}</table></div>`;
}

function addsTable(t: ReplayTotals): string {
  const traded = OPENED.reduce((a, o) => a + t.tape[o].buyQty + t.tape[o].sellQty, 0);
  const row = (id: OptionId) => {
    const x = lockTallyOf(t, id);
    const tenth = (v: number) => v / 10;
    return `<tr><td class="lbl">${esc(OPTION_NAME[id])}<small>${PRE_OPTIONS.includes(id) ? "before the start" : "in play"}</small></td><td>${num(x.n)}<small>${contracts(x.sold)} contracts</small></td><td><b>${num(Math.round(tenth(x.n)))}</b> sell orders<small>${contracts(tenth(x.sold))} contracts</small></td><td>${usd(tenth(x.fee))}</td><td>${pct(tenth(x.sold), traded, 1)}</td><td>${t.games ? num(Math.round(tenth(x.n) / t.games)) : "–"} orders<small>${t.games ? contracts(tenth(x.sold) / t.games) : "–"} contracts</small></td></tr>`;
  };
  return `<div class="tbl"><table><tr><th>Option</th><th>Every holder who could<br><small>locks, contracts sold</small></th><th>For every 10 in 100 who lock</th><th>Exchange fees on those<br><small>at the fee counted</small></th><th>Share of the contracts traded<br><small>on the same games</small></th><th>Per game</th></tr>${[...PRE_OPTIONS, ...LIVE_OPTIONS].map(row).join("")}</table></div>`;
}

function positionsTable(r: ReplayReport): string {
  const row = (label: string, t: ReplayTotals) => {
    const pre = openTallyOf(t, "pre");
    const live = openTallyOf(t, "live");
    const all = openTallyOf(t);
    const liveTrades = t.tape.live.buys + t.tape.live.sells;
    return `<tr><td class="lbl">${esc(label)}</td><td>${num(t.games)}</td><td>${num(t.trades)}</td><td><b>${num(all.n)}</b><small>${num(pre.n)} before the start · ${num(live.n)} in play (${pct(live.n, all.n)})</small></td><td>${contracts(all.qty)}<small>${pct(live.qty, all.qty)} in play</small></td><td>${usd(all.stake)}</td><td><b>${num(all.lost)}</b> · ${pct(all.lost, all.n)}<small>had paid ${usd(all.lostStake)}</small></td><td>${num(t.tape.live.sells)} · ${pct(t.tape.live.sells, liveTrades)}<small>of trades in play · ${num(t.tape.pre.sells)} before the start</small></td></tr>`;
  };
  return `<div class="tbl"><table><tr><th>League</th><th>Games</th><th>Trades</th><th>Positions opened<br><small>taker buys, 5¢ to 95¢</small></th><th>Contracts</th><th>Paid<br><small>price and fee</small></th><th>Finished at $0</th><th>Sold by hand<br><small>takers' sales</small></th></tr>${Object.entries(r.byLeague)
    .map(([l, t]) => row(league(l), t))
    .join("")}${Object.keys(r.byLeague).length > 1 ? row("All", r.all) : ""}</table></div>`;
}

function gamesTable(rows: ReplayGameRow[], counted: boolean): string {
  if (!rows.length) return "";
  return `<div class="tbl"><table><tr><th>Game</th><th>Start</th><th>Result</th><th>Trades</th><th>Positions</th><th>Bids a lock could be priced at</th></tr>${rows
    .map(
      (g) =>
        `<tr><td class="lbl">${esc(league(g.league))} · ${esc(g.label)}<small>${esc(g.event)}</small></td><td>${et(g.startMs)}</td><td>${counted ? `${esc(g.winnerName)} won` : '<span class="dim">no result on the tape</span>'}</td><td>${num(g.trades)}</td><td>${num(g.positions)}</td><td>${num(g.bookPoints + g.salePoints)}<small>${g.bookPoints ? `${num(g.bookPoints)} book readings · ` : "no book readings · "}${num(g.salePoints)} takers' sales</small></td></tr>`,
    )
    .join("")}</table></div>`;
}

export interface RecordingRow {
  event: string;
  label: string;
  league: string;
  startMs: number;
  trades: number;
  inPlay: boolean;
}

export function renderReplayHtml(r: ReplayReport, recording: RecordingRow[], opts: { refreshSec?: number; links?: PageLink[]; feeWords?: string } = {}): string {
  const t = r.all;
  const all = openTallyOf(t);
  const pre = openTallyOf(t, "pre");
  const live = openTallyOf(t, "live");
  const back = lockTallyOf(t, "live_back80");
  const half = lockTallyOf(t, "live_half");
  const wide = lockTallyOf(t, "pre_wide");
  const liveTrades = t.tape.live.buys + t.tape.live.sells;
  const leagues = Object.entries(r.byLeague)
    .map(([l, x]) => `${league(l)} ${x.games}`)
    .join(" · ");
  const inPlayNow = recording.filter((g) => g.inPlay).length;
  const fee = opts.feeWords ?? "2¢ a contract";
  const empty = !t.games;
  const body = empty
    ? `<p class="lead">No game has closed yet. A game is counted once it is over and its result is on the tape, about four and a half hours after its start. ${recording.length ? `${num(recording.length)} game${recording.length === 1 ? " is" : "s are"} being recorded now.` : "The first games are picked up on the next cycle."}</p>`
    : `<div class="strip"><span>Games counted <b>${num(t.games)}</b> <small>${esc(leagues)}${t.firstStartMs !== null && t.lastStartMs !== null ? ` · ${et(t.firstStartMs)} to ${et(t.lastStartMs)}` : ""}</small></span><span>Positions opened <b>${num(all.n)}</b> <small>${num(pre.n)} before the start · ${num(live.n)} in play</small></span><span>Paid for them <b>${usd(all.stake)}</b> <small>${contracts(all.qty)} contracts</small></span><span>Finished at $0 <b>${num(all.lost)}</b> <small>${pct(all.lost, all.n)} · had paid ${usd(all.lostStake)}</small></span><span>Being recorded now <b>${num(recording.length)}</b> <small>${inPlayNow} in play</small></span></div>
<div class="kpis now">
<div><small>In play: the whole stake could have come back</small><b>${pct(back.n, back.eligible)} of positions</b><small>${num(back.n)} of ${num(back.eligible)} · by selling 80% or less, the rest riding at no cost</small></div>
<div><small>Of those, their side then lost</small><b>${pct(back.lost, back.n)} · ${num(back.lost)} positions</b><small>paid ${usd(back.lostStake)}, got $0 · the lock returns ${usd(back.lostCash)}</small></div>
<div><small>In play: Max upside with half the stake back</small><b>${pct(half.n, half.eligible)} of positions</b><small>sells 40%, 60% rides · ${num(half.lost)} then lost and would have kept ${usd(half.lostCash)}</small></div>
<div><small>Before the start: Max upside</small><b>${mean(wide.backShareSum, wide.n, 100)}% of the stake as a floor</b><small>sells 40%, 60% rides to the full $1 · ${num(wide.lost)} lost and would have kept ${usd(wide.lostCash)}</small></div>
<div><small>Holders already sell by hand</small><b>${pct(t.tape.live.sells, liveTrades)} of trades in play</b><small>${num(t.tape.live.sells)} takers' sales, ${contracts(t.tape.live.sellQty)} contracts</small></div>
<div><small>For every 10 in 100 who lock in play</small><b>${num(Math.round(back.n / 10))} sell orders</b><small>${contracts(back.sold / 10)} contracts · ${usd(back.fee / 10)} in exchange fees</small></div>
</div>

<h2>1 · The positions</h2>
<p>Every taker buy on a game's two winner contracts at a price between 5¢ and 95¢: that many contracts, at that price, at that moment. Paid is the price plus the exchange fee to open, ${esc(fee)}. Each is followed to the result as if held: the tape carries no account, so a holder who sold before the end is still counted to the end, and one person's three buys are three positions.</p>
${positionsTable(r)}

<h2>2 · Before the start</h2>
<p>A position opened before the scheduled start, locked at the last bid of the hour before it. The lock is the holder's own sale of part of the position, in the three sizes the product offers. The cash from the sale, after the exchange fee, is the floor: theirs whatever happens. The contracts kept ride to the full $1.</p>
${preTable(t, "all")}
<div class="note"><b>Before the start there is rarely a gain to lock.</b> Of ${num(pre.atStart)} positions with a bid to read at the start, ${num(pre.aheadAtStart)} (${pct(pre.aheadAtStart, pre.atStart, 1)}) could have sold everything for more than they paid after both fees. A lock before the start does one thing: it turns "all or nothing" into a floor and a cap. Which of the three is a choice of how much to keep riding.</div>

<h2>3 · In play</h2>
<p>Every position, opened before or during the game, followed from the scheduled start or from when it was opened, whichever is later, while the bid on its side was between 5¢ and 95¢. Each option is taken at the first bid that makes it possible. Stake back sells the fewest contracts whose cash covers everything the position cost; what is left rides at no cost. The first two rows are the same moment, the bid a quarter above what was paid after both fees, with two choices: sell 40% and hold half the stake, or sell about 80% and hold all of it.</p>
${liveTable(t, "all")}
<div class="note"><b>How to read "kept less given up".</b> A lock moves money from the games a holder wins to the games they lose. Over enough games the two come close and the difference is the fees and the spread. Over a few nights it swings with which sides won, in either direction, and is not the product's edge.</div>

<h2>4 · What it adds in orders</h2>
<p>Every lock is a sell order on the exchange's own book, from the holder's own account, that would not otherwise have been placed. The first column is every holder who could have locked doing so; nobody should plan on that. The others scale it to 10 in 100. A position can take one option, so the rows are alternatives, not a sum. A broker's own commission on those orders is not public and is not counted.</p>
${addsTable(t)}

<h2>5 · The same, cut finer</h2>
<details><summary>Stakes of $${num(SMALL_USD)} or less only</summary><p class="dim">${num(openTallyOf(t, "all", "small").n)} of the ${num(all.n)} positions, ${usd(openTallyOf(t, "all", "small").stake)} of the ${usd(all.stake)} paid. The dollar columns above are carried by a few large tickets; these are the retail-size ones.</p><h3>Before the start</h3>${preTable(t, "small")}<h3>In play</h3>${liveTable(t, "small")}</details>
${Object.entries(r.byLeague)
  .map(([l, x]) => `<details><summary>${esc(league(l))} only · ${x.games} game${x.games === 1 ? "" : "s"}</summary><h3>Before the start</h3>${preTable(x, "all")}<h3>In play</h3>${liveTable(x, "all")}</details>`)
  .join("")}
<details><summary>The ${num(r.games.length)} games counted</summary>${gamesTable(r.games, true)}</details>`;
  const recordingHtml = recording.length
    ? `<details><summary>${num(recording.length)} game${recording.length === 1 ? "" : "s"} being recorded now</summary><div class="tbl"><table><tr><th>Game</th><th>Start</th><th>Trades kept so far</th></tr>${recording
        .map((g) => `<tr><td class="lbl">${esc(league(g.league))} · ${esc(g.label)}${g.inPlay ? ' <b class="live">In play</b>' : ""}</td><td>${et(g.startMs)}</td><td>${num(g.trades)}</td></tr>`)
        .join("")}</table></div></details>`
    : "";
  const noResult = r.noResult.length ? `<details><summary>${num(r.noResult.length)} game${r.noResult.length === 1 ? "" : "s"} closed with no result, not counted</summary>${gamesTable(r.noResult, false)}</details>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">${opts.refreshSec ? `<meta http-equiv="refresh" content="${opts.refreshSec}">` : ""}
<title>Lock in, replayed on real trades</title>
<style>
${SPORTS_PAGE_STYLE}</style></head><body><main>
${pageLinksHtml(opts.links, "Sports")}${sportsNavHtml(opts.links, "replay")}<h1>Lock in, replayed on real trades</h1>
<p class="lead">Crypto.com's exchange publishes every trade on its game contracts: the time, the size, the price, and whether the taker bought or sold. Each buy is a real position someone opened, through whichever broker or app they use. This page follows every one of them to the final whistle and works out what Lock in would have shown and done, at bids that were really on the book. No position here is simulated. Read-only.</p>
${body}
${recordingHtml}${noResult}

<h2>Notes and limits</h2>
<ul class="limits">
<li><b>Whose trades.</b> The whole exchange: every broker and app that sends orders to it, and its market makers. The tape does not say which trades came from which. A broker's own share of these positions is a question for that broker.</li>
<li><b>What a position is.</b> A taker's buy. Some buys close a short rather than open a long, some buyers are market makers, and some holders sold before the end; none of that is visible. Buys under 5¢ or over 95¢ (${num(t.outside)} here) are on the tape and are not counted as positions.</li>
<li><b>A bid that was really there.</b> A lock is priced at one of two things on the position's own contract: the best bid of the book as this service read it that minute, with its size, or a taker's sale on the tape, which is someone selling that many at that price at that moment. Nothing is inferred from a buy. ${t.games ? `${num(t.gamesWithBook)} of the ${num(t.games)} games have book readings; the others, recorded before this service kept the book beside the tape, are priced at takers' sales only, which are fewer before the start.` : ""}</li>
<li><b>"First" is the rule.</b> In play each option is taken the first time it is possible. A holder who waited may have got more back, or lost the chance. Nothing here uses hindsight to pick the moment.</li>
<li><b>Sizes.</b> A lock sells at the best bid. For a retail-size ticket that is what would happen. A large ticket would walk the book and get less than shown; the fold in section 5 leaves the large ones out.</li>
<li><b>The start.</b> The exchange's scheduled start. A game tips off a few minutes after it, so the first minutes "in play" are the last minutes before.</li>
<li><b>Fees.</b> The exchange's fee as the sports page counts it, ${esc(fee)}, on the buy that opened the position and on each sale. A broker's own commission is not public and is not counted.</li>
<li><b>The result.</b> Read from the tape: the side whose last trade printed at 97¢ or more while the other's was at 50¢ or less, or whose opponent's last trade printed at 3¢ or less while its own was at 50¢ or more. Read once the game's tape has been quiet for half an hour and four and a half hours have passed since the start. A game with no such result is listed and not counted.</li>
<li><b>What this is not.</b> A count of how many holders would lock, or of what a lock does to whether they come back. The first needs the product in front of them and the second needs a broker's account data.</li>
</ul>
<footer><p><b>Source.</b> Crypto.com public market-data API of its US exchange (api.crypto.com/fcm/v1/public; trades and books per contract). The exchange stops publishing a finished game's contracts within a few days of the game; the trades are kept here from the moment a game is listed. No credentials loaded; nothing here can place an order.</p></footer>
</main></body></html>`;
}

// ---------------------------------------------------------------------------
// Lock in now
// ---------------------------------------------------------------------------

function optionCard(q: LockQuote, o: LockQuote["options"][number]): string {
  // stake back that sells more than the 80% the replay counts it at: said on the card, with the bid at which it is counted
  const thin =
    o.id === "back" && q.stakeBackOpensAtCents !== undefined
      ? `<p class="dim">Only ${num(o.kept, 2)} of ${num(q.contracts, 2)} contracts are left riding. The replay page counts stake back once it sells 80% or less: ${q.stakeBackOpensAtCents === null ? "no bid up to 95¢ does that on this position" : `on this position, from a bid of ${q.stakeBackOpensAtCents}¢`}.</p>`
      : "";
  const depth = o.covered ? `The bid holds ${num(q.bidQty)} contracts: enough for this sale.` : `The bid holds ${num(q.bidQty)} contracts: the rest of this sale would fill lower than shown.`;
  return `<div class="opt"><h3>${esc(o.name)}</h3>
<p class="dim">Sell ${num(o.sold, 2)} of ${num(q.contracts, 2)} contracts (${o.soldPercent}%) at ${q.bidCents}¢. Keep ${num(o.kept, 2)} riding.</p>
<div class="three"><div><small>Floor · cash now</small><b>${dollars(o.floorCents)}</b></div><div><small>Cap · if ${esc(q.team)} win</small><b>${dollars(o.capCents)}</b></div><div><small>Back on what you paid</small><b>${o.backPercent}%</b></div></div>
<p>If ${esc(q.team)} lose you keep <b>${dollars(o.floorCents)}</b> instead of $0.00. If they win you get <b>${dollars(o.capCents)}</b> instead of ${dollars(q.fullWinCents)}.</p>
<p class="dim">${dollars(o.feeCents)} exchange fee on the sale, already taken out. ${depth}</p>${thin}</div>`;
}

export function renderLockHtml(input: { choices: LockChoice[]; quote: LockQuote | null; selected: string; contracts: string; paid: string; at: string | null; refreshSec?: number; links?: PageLink[] }): string {
  const paths = sportsPaths(input.links);
  const q = input.quote;
  const options = input.choices.map((c) => `<option value="${esc(c.value)}"${c.value === input.selected ? " selected" : ""}>${c.inPlay ? "In play · " : ""}${esc(c.label)} · bid ${c.bidCents}¢</option>`).join("");
  const form = `<form method="get" action="${esc(paths.lock.split("?")[0])}" class="ask">${paths.token ? `<input type="hidden" name="k" value="${esc(paths.token)}">` : ""}
<label>Position<select name="game">${options}</select></label>
<label>Contracts held<input name="n" type="number" min="0.01" step="0.01" value="${esc(input.contracts)}"></label>
<label>Paid per contract, cents<input name="paid" type="number" min="1" max="99" step="0.01" value="${esc(input.paid)}" placeholder="the ask now"></label>
<button type="submit">Show the lock</button></form>`;
  let body: string;
  if (!input.choices.length) body = '<p class="dim">Crypto.com shows no bid on any game on the board right now.</p>';
  else if (!q) body = '<p class="dim">Pick a position.</p>';
  else {
    const head = `<div class="strip"><span>${esc(league(q.league))} · ${esc(q.label)} <b>${esc(q.team)} to win</b> <small>${q.inPlay ? "in play" : q.startsAt ? `starts ${et(Date.parse(q.startsAt))}` : "start not listed"}</small></span><span>Book now <b>${q.bidCents}¢ / ${q.askCents > 0 && q.askCents < 100 ? `${q.askCents}¢` : "–"}</b> <small>${num(q.bidQty)} at the bid</small></span><span>Position <b>${num(q.contracts, 2)} contracts at ${q.paidCents}¢</b> <small>${q.paidAssumed ? "no price given: the ask now · " : ""}paid ${dollars(q.stakeCents)} with the fee</small></span><span>Riding with no lock <b>${dollars(q.fullWinCents)} or $0.00</b></span></div>`;
    // stake back not shown at this bid: where it appears, and where the replay counts it
    const from = q.stakeBackFromCents;
    const at80 = q.stakeBackOpensAtCents;
    const back =
      from === undefined
        ? ""
        : from === null
          ? '<p class="dim">Stake back is not available on this position: no bid up to 95¢ returns what was paid with anything left riding.</p>'
          : `<p class="dim">Stake back is not available at this bid: returning what was paid would take the whole position or more. ${
              at80 === from
                ? `It appears at ${from}¢: from there, selling 80% or less returns everything paid and the rest rides at no cost.`
                : `It appears at ${from}¢, where it sells nearly all of the position. ${at80 == null ? "No bid up to 95¢ returns what was paid by selling 80% or less, which is where the replay page counts it." : `From ${at80}¢ it sells 80% or less and the rest rides at no cost, which is where the replay page counts it.`}`
            }</p>`;
    body = `${head}${q.note ? `<p class="lead">${esc(q.note)}</p>` : ""}<div class="opts">${q.options.map((o) => optionCard(q, o)).join("")}</div>${back}`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">${input.refreshSec ? `<meta http-equiv="refresh" content="${input.refreshSec}">` : ""}
<title>Lock in now, from the live bid</title>
<style>
${SPORTS_PAGE_STYLE}
form.ask{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:flex-end;margin:14px 0;padding:12px;border:1px solid var(--line);border-radius:8px;background:#fafafa}form.ask label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dim)}form.ask select,form.ask input{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:#fff;max-width:520px}form.ask input{width:150px}form.ask button{font:inherit;font-weight:600;padding:7px 16px;border:0;border-radius:6px;background:var(--k);color:#fff;cursor:pointer}
.opts{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin:12px 0}.opt{border:1px solid var(--line);border-radius:8px;padding:12px 14px}.opt h3{margin:0 0 4px}
.three{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:10px 0}.three div{background:#fafafa;border-radius:6px;padding:8px 10px}.three b{display:block;font-size:19px;font-variant-numeric:tabular-nums}
</style></head><body><main>
${pageLinksHtml(input.links, "Sports")}${sportsNavHtml(input.links, "lock")}<h1>Lock in now</h1>
<p class="lead">A position on Crypto.com's exchange, and what Lock in would show on it this minute: the holder's own sale of part of it at the bid on the book. Floor, cash now and cap, after the exchange fee. Arithmetic on a public bid; nothing here places an order.</p>
${form}
${body}
<footer><p>${input.at ? `Book as of ${et(Date.parse(input.at))}. ` : ""}Before the start the three sizes the product offers are shown. In play, stake back comes first when the bid is high enough for it. It is shown whenever it leaves something riding; the replay page counts it only once it sells 80% or less. A sale larger than the bid's size would fill part of it lower than shown.</p></footer>
</main></body></html>`;
}
