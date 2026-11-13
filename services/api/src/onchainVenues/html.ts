/** Server-rendered page. No framework, no external assets. */

import type { Board, BoardGame, BoardOutcome, Cell, CoverLeg, Lock } from "./board";
import { FEE_WORDS } from "./fees";
import { VENUES, VENUE_NAME, VENUE_SHORT, type Coverage, type FeedHealth, type Venue } from "./types";

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
const NONE = "·";
const c = (v: number | null | undefined, digits = 1): string => (v === null || v === undefined || !Number.isFinite(v) ? NONE : `${v.toFixed(digits)}¢`);
const signed = (v: number | null | undefined, digits = 1): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return NONE;
  const zero = Math.abs(v) < 0.5 * 10 ** -digits;
  return `${!zero && v > 0 ? "+" : !zero && v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}¢`;
};
const num = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? NONE : Math.round(v).toLocaleString("en-US"));
const usd = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? NONE : `$${Math.round(v).toLocaleString("en-US")}`);
const et = (iso: string | null | undefined): string => {
  const d = new Date(iso ?? "");
  if (Number.isNaN(d.getTime())) return esc(iso ?? NONE);
  return `${d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET`;
};
const age = (ms: number | null): string => (ms === null ? "" : ms < 90_000 ? `${Math.round(ms / 1000)}s old` : ms < 5_400_000 ? `${Math.round(ms / 60_000)}m old` : `${Math.round(ms / 3_600_000)}h old`);
const V = (v: Venue): string => VENUE_NAME[v];
const S = (v: Venue): string => VENUE_SHORT[v];

export const PAGE_STYLE = `:root{--ink:#111;--dim:#6b7280;--line:#e5e7eb;--k:#0a66c2;--hot:#b91c1c;--warm:#b45309;--ok:#047857}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;color:var(--ink);background:#fff}
main{max-width:1400px;margin:0 auto;padding:20px 16px 60px}h1{font-size:24px;margin:0 0 4px;letter-spacing:-.01em}h2{font-size:18px;margin:34px 0 8px}
p{margin:6px 0}.dim{color:var(--dim)}small{color:var(--dim);font-size:12px;display:block}.lead{font-size:16px;max-width:980px}
.strip{display:flex;flex-wrap:wrap;gap:10px 22px;margin:12px 0 4px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:#fafafa}.strip b{font-variant-numeric:tabular-nums}
.tbl{overflow-x:auto;margin:8px 0}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:14px}th{font-weight:600;text-align:left;color:var(--dim);font-size:12px;border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:bottom}
td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}td.n{white-space:nowrap}td small{display:block;color:var(--dim);font-size:11px}td.wrap{min-width:220px;font-size:13px}
tr.game td{background:#fafafa;padding-top:10px}tr.game small{display:block;margin-top:2px}
.ok{color:var(--ok)}.bad{color:var(--hot)}.warm{color:var(--warm)}.live{color:var(--hot);font-weight:600}.up{color:var(--ok);font-weight:600}
.tag{display:inline-block;font-size:10px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;padding:0 6px;border-radius:999px;background:#f3f4f6;color:var(--dim);margin-left:4px;vertical-align:middle}.tag.w{background:#fef3c7;color:var(--warm)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin:10px 0}.kpis div{border:1px solid var(--line);border-radius:8px;padding:10px 12px}.kpis b{display:block;font-size:17px;margin:2px 0;font-variant-numeric:tabular-nums}
details{margin:8px 0}summary{cursor:pointer;color:var(--k);font-size:13px}
.note{border-left:3px solid var(--line);padding:4px 12px;color:var(--dim);font-size:13px;margin:10px 0;max-width:980px}.note.w{border-color:var(--warm);color:var(--ink)}.limits{padding-left:18px;font-size:13px;color:var(--dim);margin:6px 0;max-width:980px}.limits li{margin:5px 0}.limits b{color:var(--ink)}
footer{margin-top:40px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:12px}
`;

// ---------------------------------------------------------------------------
// what each venue is, as each publishes it
// ---------------------------------------------------------------------------

interface Fact {
  venue: Venue;
  chain: string;
  held: string;
  out: string;
  fee: string;
  partner: string;
  source: string;
}
/** Read from each venue's own pages and the partner's on 12 and 13 November 2026. A venue can change any of it. */
export const VENUE_FACTS: Fact[] = [
  {
    venue: "polymarket",
    chain: "Polygon. Paid in pUSD, its own dollar token, since its exchange upgrade of 28 April 2026.",
    held: "$1 shares. One token for each outcome.",
    out: "Place the shares against the bids on its book, at any time.",
    fee: "Takers pay shares × 0.05 × p × (1 − p) on sports, at the trade, since 10 July 2026. Makers pay nothing.",
    partner: "In the partner's mapping, outcome by outcome. Books on the stream. Orders are supported.",
    source: "docs.polymarket.com/trading/fees",
  },
  {
    venue: "sx_bet",
    chain: "SX Network, its own chain. Paid in USDC.",
    held: "A bet at odds against a maker's offer, not a share. One book serves both outcomes of a market.",
    out: "Back the other outcome against a resting offer. Sized to match, the two bets pay the same whoever wins.",
    fee: "Nothing at the trade. 1% of the profit of a winning taker bet, at settlement. 5% on a parlay. Its rates can differ by account.",
    partner: "In the partner's mapping, with which outcome is which. Books on the stream. Orders are supported, except parlays and quarter lines.",
    source: "docs.sx.bet/developers/fees",
  },
  {
    venue: "limitless",
    chain: "Base. Paid in USDC.",
    held: "$1 shares, a Yes and a No token for each market. A football game is a group of markets: one for each team and one for the draw.",
    out: "Place the shares against the bids on its book, at any time.",
    fee: "Takers pay 5% × (1 − p) of the dollars traded, which is shares × 0.05 × p × (1 − p), on its current markets. Markets made before that change keep an older schedule (0.40% to 3.00% on a buy, 0.42% to 1.50% on an exit), which this page does not apply.",
    partner: "Not in the partner's mapping, by the partner's own page. Found from a list of its markets and tied to a game here by team names. Books on the stream. Orders are supported.",
    source: "docs.limitless.exchange/user-guide/fees",
  },
];

function factsHtml(): string {
  const rows = VENUE_FACTS.map(
    (f) =>
      `<tr><td class="n"><b>${esc(V(f.venue))}</b></td><td>${esc(f.chain)}</td><td>${esc(f.held)}</td><td>${esc(f.out)}</td><td>${esc(f.fee)}</td><td>${esc(f.partner)}</td><td class="n dim">${esc(f.source)}</td></tr>`,
  ).join("");
  return `<div class="tbl"><table><thead><tr><th>Venue</th><th>Chain and money</th><th>What is held</th><th>Getting out before the result</th><th>Taker fee</th><th>Through the partner</th><th>Fee source</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---------------------------------------------------------------------------
// live sections
// ---------------------------------------------------------------------------

function venueSummaryHtml(b: Board): string {
  const rows = b.venues
    .map((v) => {
      const sum = v.medianMidSum === null ? NONE : v.medianMidSum.toFixed(1);
      const off = v.medianMidSum !== null && Math.abs(v.medianMidSum - 100) > 6;
      return `<tr><td class="n"><b>${esc(V(v.venue))}</b></td><td class="n">${v.games}</td><td class="n">${v.books}</td><td class="n">${v.twoSided}</td><td class="n">${v.noBook}</td><td class="n">${c(v.medianSpread)}</td><td class="n">${usd(v.medianBidUsdNear)}</td><td class="n">${v.takes1000}</td><td class="n${off ? " warm" : ""}">${sum}</td><td class="n${v.medianGapToOthers !== null && v.medianGapToOthers > 6 ? " warm" : ""}">${c(v.medianGapToOthers)}</td><td class="n${v.crossed ? " bad" : ""}">${v.crossed}</td></tr>`;
    })
    .join("");
  return `<div class="tbl"><table><thead><tr><th>Venue</th><th>Games on the board</th><th>Outcome books</th><th>With a bid and an ask</th><th>Empty</th><th>Median spread</th><th>Median dollars within 2¢ of the best bid</th><th>Books that take 1,000 shares</th><th>Median sum of a game's mids</th><th>Median gap to the other venues' mids</th><th>Crossed books</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="note">The last three columns check the reading itself. A game's outcomes should add to about 100. The same outcome should be priced within a few cents on every venue that has real size. A crossed book (a bid at or over its ask) should not exist. A venue that fails one of these is thin, or is being read wrongly, and its figures on this page should not be used until it is known which. SX Bet's two outcomes come from one book, so they add to 100 by construction: for SX Bet the gap column is the check that counts.</p>`;
}

const legWords = (l: CoverLeg): string => `${esc(l.outcome)} on ${esc(S(l.venue))} at ${c(l.allInAsk, 2)}`;

function coverSummaryHtml(b: Board): string {
  const tiles = b.cover
    .map((s) => {
      const where = VENUES.filter((v) => s.legsOn[v] > 0)
        .map((v) => `${esc(S(v))} ${s.legsOn[v]}`)
        .join(", ");
      const share = s.withCover ? ` of ${s.withCover}` : "";
      return `<div><small>Holder on ${esc(V(s.home))}</small><b>${s.elsewhereBetter}${share}</b><small>positions where a cover with a leg on another venue locks more than leaving at home${s.medianBetterBy !== null ? `, by a median of ${c(s.medianBetterBy, 2)} a share` : ""}${where ? `. Legs bought on: ${where}` : ""}</small></div>`;
    })
    .join("");
  return `<div class="kpis">${tiles}</div>`;
}

function bestHtml(b: Board): string {
  if (!b.best.length) return `<p class="dim">Right now no position on the board has a cover on another venue that locks more than leaving at home.</p>`;
  const rows = b.best
    .map((x) => {
      const k = x.lock;
      return `<tr><td>${esc(x.game)}<small>${et(x.startsAt)}</small></td><td>${esc(x.outcome)}</td><td class="n">${esc(S(k.home))}</td><td class="n">${c(k.homeExit, 2)}</td><td class="wrap">${(k.cover?.legs ?? []).map(legWords).join("<br>")}</td><td class="n">${c(k.cover?.value, 2)}</td><td class="n up">${signed(k.betterBy, 2)}</td><td class="n">${num(k.cover?.shares)}</td></tr>`;
    })
    .join("");
  return `<div class="tbl"><table><thead><tr><th>Game</th><th>Holding</th><th>Held on</th><th>Leave at home</th><th>Cover: buy</th><th>Cover locks</th><th>Better by</th><th>Shares at those prices</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function cellHtml(cell: Cell | null): string {
  if (!cell) return `<td class="dim n">not listed</td>`;
  const tags = `${cell.matchedBy === "names" ? '<i class="tag w">by names</i>' : ""}${cell.executable === false ? '<i class="tag">no orders</i>' : ""}`;
  if (cell.error) return `<td class="dim">no book${tags}<small>${esc(cell.error)}</small></td>`;
  if (cell.bidCents === null && cell.askCents === null) return `<td class="dim n">empty book${tags}</td>`;
  const old = cell.ageMs !== null && cell.ageMs > 120_000;
  return `<td class="n"><b${cell.crossed ? ' class="bad"' : ""}>${cell.bidCents === null ? NONE : cell.bidCents.toFixed(1)} / ${cell.askCents === null ? NONE : cell.askCents.toFixed(1)}</b>${tags}<small>${num(cell.bidShares)} × ${num(cell.askShares)} shares</small><small>fee in: ${cell.allInBid === null ? NONE : cell.allInBid.toFixed(2)} / ${cell.allInAsk === null ? NONE : cell.allInAsk.toFixed(2)}</small>${cell.ageMs !== null ? `<small${old ? ' class="warm"' : ""}>${age(cell.ageMs)}</small>` : ""}</td>`;
}

function coverCell(o: BoardOutcome): string {
  const cover = o.locks[0]?.cover ?? null;
  const exits = o.locks.filter((k) => k.homeExit !== null);
  if (!cover && !exits.length) return `<td class="dim">${NONE}</td>`;
  const coverLine = cover ? `${cover.legs.map(legWords).join(" + ")}: locks <b>${c(cover.value, 2)}</b>` : `<span class="dim">no full cover on offer</span>`;
  const versus = exits
    .map((k: Lock) => `${esc(S(k.home))} ${c(k.homeExit, 2)}${k.betterBy !== null ? ` <span class="${k.betterBy > 0 && k.elsewhere ? "up" : "dim"}">(${signed(k.betterBy, 2)})</span>` : ""}`)
    .join(" · ");
  return `<td class="wrap">${coverLine}${versus ? `<small>leave at home: ${versus}</small>` : ""}</td>`;
}

function gameRows(g: BoardGame): string {
  const live = g.status === "LIVE";
  const head = `<tr class="game"><td colspan="6"><b>${esc(g.name)}</b>${live ? ' <span class="live">live</span>' : ""}<small>${esc([g.sport, g.competition].filter(Boolean).join(" · "))} · ${et(g.startsAt)} · ${esc(g.marketTitle)}</small></td></tr>`;
  const rows = g.outcomes
    .map((o) => `<tr><td>${esc(o.name)}${o.side ? `<small>${esc(o.side.toLowerCase())}</small>` : ""}</td>${VENUES.map((v) => cellHtml(o.cells[v])).join("")}<td class="n">${c(o.midGap)}</td>${coverCell(o)}</tr>`)
    .join("");
  return head + rows;
}

function boardHtml(games: BoardGame[]): string {
  if (!games.length) return "";
  return `<div class="tbl"><table><thead><tr><th>Outcome</th>${VENUES.map((v) => `<th>${esc(V(v))}<br>bid / ask</th>`).join("")}<th>Widest gap between mids</th><th>For a holder of this outcome: the cover, and leaving at home</th></tr></thead><tbody>${games.map(gameRows).join("")}</tbody></table></div>`;
}

function coverageHtml(coverage: Coverage[]): string {
  if (!coverage.length) return `<p class="dim">Nothing read yet.</p>`;
  const total = (pick: (x: Coverage) => number): number => coverage.reduce((s, x) => s + pick(x), 0);
  const row = (name: string, sub: string, x: { events: number; withWinner: number; on: Record<Venue, number>; onTwo: number; onThree: number }, bold = false): string =>
    `<tr><td>${bold ? `<b>${esc(name)}</b>` : esc(name)}${sub ? `<small>${esc(sub)}</small>` : ""}</td><td class="n">${x.events}</td><td class="n">${x.withWinner}</td>${VENUES.map((v) => `<td class="n">${x.on[v]}</td>`).join("")}<td class="n">${x.onTwo}</td><td class="n">${x.onThree}</td></tr>`;
  const all = {
    events: total((x) => x.events),
    withWinner: total((x) => x.withWinner),
    on: Object.fromEntries(VENUES.map((v) => [v, total((x) => x.on[v])])) as Record<Venue, number>,
    onTwo: total((x) => x.onTwo),
    onThree: total((x) => x.onThree),
  };
  const listed = coverage.filter((x) => VENUES.some((v) => x.on[v] > 0));
  const bare = coverage.length - listed.length;
  return `<div class="tbl"><table><thead><tr><th>Competition</th><th>Games read</th><th>With a winner market</th>${VENUES.map((v) => `<th>On ${esc(S(v))}</th>`).join("")}<th>On two or more</th><th>On all three</th></tr></thead><tbody>${row("All competitions", "", all, true)}${listed.map((x) => row(x.competition, x.sport, x)).join("")}</tbody></table></div>${bare ? `<p class="dim">${bare} more competition${bare === 1 ? "" : "s"} with games in the window and no winner market on any of the three.</p>` : ""}`;
}

function feedHtml(f: FeedHealth, hasFeed: boolean): string {
  if (!hasFeed) return `<p class="note w">The feed key is not set on this service (AGGREGATOR_KEY_ID and AGGREGATOR_PRIVATE_KEY_HEX), so nothing is read.</p>`;
  const lim =
    f.limitless.state === "listed"
      ? `${f.limitless.source === "venue" ? "read from Limitless's own public list of game markets, because the partner's list is refused to this key: " : ""}${f.limitless.markets} open markets listed, ${f.limitless.sports} of them sports, ${f.limitless.matched} tied to an outcome of a game here${f.limitless.detail ? ` (${esc(f.limitless.detail)})` : ""}`
      : f.limitless.state === "refused"
        ? `<span class="bad">the key is not allowed to read its list</span>`
        : f.limitless.state === "failed"
          ? `<span class="bad">its list did not answer</span> ${esc(f.limitless.detail ?? "")}`
          : "not read yet";
  const errs = Object.entries(f.books.errors)
    .map(([code, n]) => `${esc(code)} ${n}`)
    .join(", ");
  return `<ul class="limits">
<li><b>Catalog</b> ${f.discoveredAt ? `read ${et(f.discoveredAt)} in ${Math.round((f.discoveryMs ?? 0) / 1000)}s` : "first read under way"}. ${f.competitions} competitions, ${f.eventsInHorizon} games live or starting inside the window, ${f.eventsRead} of them read${f.eventsPending ? ` and <b>${f.eventsPending} still to read</b> (a pass reads a part of the catalog, soonest games first, so the board fills in over the first passes)` : ""}${f.eventsOverCap ? `. ${f.eventsOverCap} games on these venues are left off because the board is capped (soonest first)` : ""}.</li>
<li><b>Books</b> ${f.books.asked} asked for, ${f.books.read} read${f.books.empty ? ` (${f.books.empty} empty)` : ""}${f.books.ms !== null ? ` in ${(f.books.ms / 1000).toFixed(1)}s` : ""}${errs ? `. Not read: ${errs}` : ""}.</li>
<li><b>Limitless</b> ${lim}.</li>
<li><b>Key</b> ${f.capabilities.length ? `can: ${esc(f.capabilities.join(", "))}` : "capabilities not read"}.</li>
${f.notes.map((n) => `<li class="bad">${esc(n)}</li>`).join("")}
</ul>`;
}

export interface PageData {
  board: Board | null;
  coverage: Coverage[];
  unmatchedLimitless: string[];
  feed: FeedHealth;
  hasFeed: boolean;
  intervalSec: number;
  horizonHours: number;
}

export function renderOnchainHtml(d: PageData, opts: { refreshSec?: number } = {}): string {
  const b = d.board;
  const both = b ? b.games.filter((g) => g.venues.length >= 2) : [];
  const single = b ? b.games.filter((g) => g.venues.length === 1) : [];
  const waiting = !b ? `<p class="note w">${d.hasFeed ? "The first read is under way. The catalog is read slowly on purpose, so the first board can take a few minutes." : "Nothing to show: the feed key is not set."}</p>` : "";
  const names = d.feed.limitless.matched > 0 || (b?.games.some((g) => g.outcomes.some((o) => VENUES.some((v) => o.cells[v]?.matchedBy === "names"))) ?? false);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">${opts.refreshSec ? `<meta http-equiv="refresh" content="${opts.refreshSec}">` : ""}
<title>On-chain venues: ${VENUES.map((v) => esc(V(v))).join(", ")}</title>
<style>
${PAGE_STYLE}</style></head><body><main>
<h1>On-chain venues</h1>
<p class="lead">The same game's winner market on ${esc(V("polymarket"))}, ${esc(V("sx_bet"))} and ${esc(V("limitless"))}, side by side, with each venue's fee in. What each venue pays a holder to get out, and what a cover on the best of the three would lock instead. Read through ParlayX's data feed. Read only: nothing on this page can place an order.</p>
<div class="strip"><span>As of <b>${b ? et(b.at) : NONE}</b> <small>books every ${d.intervalSec}s</small></span><span>Games on the board <b>${b ? b.games.length : 0}</b> <small>on at least one of the three · live or starting within ${d.horizonHours} hours</small></span><span>On two venues or more <b>${b ? b.comparable : 0}</b> <small>the games that can be compared</small></span><span>Books read <b>${d.feed.books.read}</b> <small>of ${d.feed.books.asked} asked for</small></span></div>
${waiting}
<h2>1 · The three venues</h2>
<p>What each one is, in its own published terms, read on 12 and 13 November 2026. The fee column is what this page applies.</p>
${factsHtml()}

<h2>2 · What is on each venue right now</h2>
${b ? venueSummaryHtml(b) : `<p class="dim">Nothing read yet.</p>`}

<h2>3 · Leaving at home against a cover on the best venue</h2>
<p>For a holder of one outcome there are two ways to stop riding the game. Leave on the venue the position is on, at its best bid with its fee out. Or keep the position and buy every other outcome, each on whichever of the three asks least with its fee in: together they pay $1 whoever wins, so the cover locks 100¢ minus its cost. Each tile counts the positions where the cover has at least one leg on another venue and locks more.</p>
${b ? coverSummaryHtml(b) : ""}
${b ? bestHtml(b) : ""}
<ul class="limits">
<li><b>Best level only.</b> Every figure is at the best price, for the shares resting there. The last column is the size it holds for.</li>
<li><b>A cover is held to the result.</b> Leaving pays now. A cover pays when the game settles, and the money for it sits on the other venue, on another chain, until then.</li>
<li><b>Result rules are not checked yet.</b> A cover across two venues holds only if both settle the game the same way, including a game that is postponed, abandoned or void. That has not been read venue by venue.</li>
<li><b>SX Bet's fee is counted at its most.</b> 1% of the profit as if the bet wins. Its fee on a refund of freed stake is not counted.</li>
<li><b>Only the outcome tokens the mapping gives.</b> On a three-way game the cover is the other two outcomes. A "No" on the held outcome, where a venue has one (on SX Bet, the other side of the held outcome's own market), is not read as a cover.</li>
</ul>

<h2>4 · The board</h2>
<p>One game, one row for each outcome. Bid / ask in cents for $1 paid when the outcome wins, the shares at each, and the same two prices with the venue's fee in. SX Bet's offers at odds are turned into that shape. Fees: ${VENUES.map((v) => `${esc(S(v))} ${esc(FEE_WORDS[v])}`).join("; ")}.</p>
${names ? `<p class="note w">Rows tagged <i class="tag w">by names</i> were tied here by team names, not by the partner's mapping: a Limitless market tied to its game by the two team names and the start time, or a venue's listing brought in from a winner market of its own under the same game, each outcome to the team of the same name. Check the pairing before relying on such a row.</p>` : ""}
${b ? boardHtml(both) || `<p class="dim">No game is on two of the three venues right now.</p>` : ""}
${single.length ? `<details><summary>${single.length} game${single.length === 1 ? "" : "s"} on one venue only</summary>${boardHtml(single)}</details>` : ""}

<h2>5 · Where the three overlap</h2>
<p>By competition, over every game read in the window: how many have a winner market on each venue, and on more than one.</p>
${coverageHtml(d.coverage)}

<h2>6 · Limitless markets not tied to a game</h2>
${
  d.feed.limitless.state !== "listed"
    ? `<p class="dim">The Limitless list was not read (see the feed section).</p>`
    : d.unmatchedLimitless.length
      ? `<p>${d.unmatchedLimitless.length} of its sports markets could not be tied to a game on the board: a title this page does not read, a game outside the window, or a game the partner's catalog does not carry.</p><details><summary>Show them</summary><p class="dim">${d.unmatchedLimitless.slice(0, 300).map(esc).join("<br>")}</p></details>`
      : `<p class="dim">None.</p>`
}

<h2>7 · The feed</h2>
${feedHtml(d.feed, d.hasFeed)}
<footer>Internal. Prices are each venue's own book as the feed last published it. Nothing here is advice or an offer.</footer>
</main></body></html>`;
}
