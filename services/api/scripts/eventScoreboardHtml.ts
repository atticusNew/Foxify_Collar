/**
 * THE VENUE SCOREBOARD PAGE — /scoreboard on the shadow worker.
 *
 * The same table /api/shadow/scoreboard serves as JSON, rendered for a reader who wants to look
 * before downloading: one card per New York week with a row per venue (other side won on singles
 * and parlays, the winner's edge over the runner-up, what the venue's fee schedule charged,
 * how often it priced when asked), the week's totals and refusals above it, the fee schedules
 * and the methodology under it, and the JSON and CSV links at the top. Public and venue-named,
 * as the JSON is; nothing of the writer's book, and no writer-side words outside the methodology
 * (test-enforced, as on the JSON). Server-rendered, no script.
 */

import type { ScoreboardWeek, VenueScoreboard } from "../src/eventCollar/crossVenue/venueScoreboard";
import { escapeHtml, SHADOW_CSS } from "./eventShadowHtml";

const usd0 = (cents: number): string => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const num = (x: number): string => x.toLocaleString("en-US", { maximumFractionDigits: 2 });
const pct = (x: number | null): string => (x === null ? "n/a" : `${x}%`);
const cents = (x: number | null): string => (x === null ? "n/a" : `${x.toFixed(2)}¢`);
const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

function weekSummary(w: ScoreboardWeek): string {
  if (w.n === 0 && w.refusals.refused === 0) return "Nothing on the record this week.";
  const parts = [
    `${plural(w.n, "position")} (${w.singles.n} single${w.singles.n === 1 ? "" : "s"}, ${w.parlays.n} parlay${w.parlays.n === 1 ? "" : "s"}${w.parlays.unrouted > 0 ? `, ${w.parlays.unrouted} priced before the router` : ""})`,
    `${num(w.contracts)} contracts`,
    `${usd0(w.notionalCents)} of the other side bought`,
    w.taps > 0 ? `${plural(w.taps, "real tap")}` : "all simulated at live prices",
  ];
  const refusals =
    w.refusals.priced > 0
      ? ` Refused ${w.refusals.refused} of ${w.refusals.priced} markets priced (${pct(w.refusals.refusedPct)})${w.refusals.byReason.length > 0 ? `: ${w.refusals.byReason.map((r) => `${r.count} ${r.reason}`).join(", ")}` : ""}.`
      : "";
  return `${parts.join(" · ")}.${refusals}`;
}

function venueRows(sb: VenueScoreboard, w: ScoreboardWeek): string {
  const rows = sb.venues
    .map((venue) => {
      const s = w.singles.otherSide.find((x) => x.venue === venue);
      const p = w.parlays.otherSide.find((x) => x.venue === venue);
      const e = w.edge.byVenue.find((x) => x.venue === venue);
      const f = w.fees.byVenue.find((x) => x.venue === venue);
      const a = w.availability.byVenue.find((x) => x.venue === venue);
      if (!s && !p && !e && !f && !a) return "";
      const share = (x: { n: number; sharePct: number } | undefined): string => (x ? `<td class="hi">${x.sharePct}%<i>${plural(x.n, "win")}</i></td>` : `<td>n/a</td>`);
      const edge = e ? `<td class="hi">${cents(e.avgEdgeCentsPerContract)}<i>${e.avgEdgeAllInBps === null ? "" : `${e.avgEdgeAllInBps} bps all in · `}n ${e.n}</i></td>` : `<td>n/a</td>`;
      const fee = f ? `<td>${cents(f.avgFeeCentsPerContract)}<i>n ${f.n}</i></td>` : `<td>n/a</td>`;
      const avail = a ? `<td>${pct(a.pricedPct)}<i>${a.priced} of ${a.asked} asked</i></td>` : `<td>n/a</td>`;
      return `<tr><td class="v">${escapeHtml(venue)}</td>${share(s)}${share(p)}${edge}${fee}${avail}</tr>`;
    })
    .join("");
  if (!rows) return "";
  return `<div class="tablewrap"><table>
<tr><th>venue</th><th>singles<small>other side won</small></th><th>parlays<small>other side won</small></th><th>edge<small>vs runner-up, ¢/contract</small></th><th>fee<small>venue's schedule, ¢/contract</small></th><th>priced<small>when asked</small></th></tr>
${rows}</table></div>`;
}

function leagueLine(w: ScoreboardWeek): string {
  if (w.byLeague.length === 0) return "";
  const parts = w.byLeague.map((l) => {
    const venues = l.otherSide.map((v) => `${v.venue} ${v.sharePct}%`).join(", ");
    return `<b>${escapeHtml(l.league === "crypto" ? "crypto" : l.league.toUpperCase())}</b> ${plural(l.n, "position")}${venues ? ` (${escapeHtml(venues)})` : ""}`;
  });
  return `<div class="read leagues">By league: ${parts.join(" · ")}.</div>`;
}

export interface ScoreboardPageInput {
  scoreboard: VenueScoreboard;
  /** the weeks the page was asked for, so the JSON and CSV links ask for the same */
  weeks: number;
}

export function renderScoreboardHtml(input: ScoreboardPageInput): string {
  const sb = input.scoreboard;
  const q = input.weeks !== 8 ? `?weeks=${input.weeks}` : "";
  const latest = sb.weeks.find((w) => w.n > 0) ?? sb.weeks[0];
  const totals = sb.weeks.reduce(
    (t, w) => ({ n: t.n + w.n, taps: t.taps + w.taps, contracts: t.contracts + w.contracts, notionalCents: t.notionalCents + w.notionalCents, refused: t.refused + w.refusals.refused, priced: t.priced + w.refusals.priced }),
    { n: 0, taps: 0, contracts: 0, notionalCents: 0, refused: 0, priced: 0 },
  );
  const weekCards = sb.weeks
    .map(
      (w) => `<div class="card week">
    <h2>${escapeHtml(w.label)} <small>${escapeHtml(w.from)} to ${escapeHtml(w.to)}</small></h2>
    <div class="read">${escapeHtml(weekSummary(w))}</div>
    ${venueRows(sb, w)}
    ${leagueLine(w)}
  </div>`,
    )
    .join("\n");
  const feeRules = sb.feeRules.map((r) => `<div class="row fee"><span><b>${escapeHtml(r.venue)}</b></span><span class="t">${escapeHtml(r.rule)} <i>as of ${escapeHtml(r.asOf)}</i></span></div>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:," />
<title>Venue scoreboard · Earn &amp; Protect</title>
<style>${SHADOW_CSS}
.wrap,.topbar .in{max-width:980px}
@media(min-width:700px){.wrap,.topbar .in{max-width:980px}}
h2 small{display:inline;font-weight:500;text-transform:none;letter-spacing:0;color:var(--faint);margin-left:6px}
td.v{color:var(--ink);font-weight:650;min-width:90px}
td i{display:block;color:var(--faint);font-style:normal;font-size:11px;font-weight:500}
th small{display:block;font-size:9px;color:var(--faint);letter-spacing:.04em;text-transform:none}
.links{margin-top:12px;display:flex;gap:14px;flex-wrap:wrap}
.links a.back{margin:0}
.read.leagues{font-size:12.5px;color:var(--dim);margin-top:10px}
.row.fee{align-items:flex-start;justify-content:flex-start;font-size:13px}
.row.fee span:first-child{flex:0 0 96px}
.row.fee .t{flex:1;text-align:left;color:var(--dim)}
.row.fee .t i{color:var(--faint);font-style:normal;font-size:11.5px;white-space:nowrap}
.bignum{min-width:calc(25% - 8px)}
</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="wordmark">Earn &amp; Protect <span>· venue scoreboard</span></div>
</div></div>
<div class="wrap">
  <div class="card">
    <h1>Where the other side went, by week</h1>
    <div class="sub">Every locked position asks every venue the engine works with for the other side and goes to the cheapest all in, venue fees included. This is the record of which venue won, by how much, what its fee came to, and how often each venue priced at all. Weeks run Monday to Sunday, New York; this is the last ${input.weeks} week${input.weeks === 1 ? "" : "s"}. Computed from the record on each request; five minutes behind at most.</div>
    <div class="bignums">
      <div class="bignum"><div class="n green">${totals.n.toLocaleString("en-US")}</div><div class="l">positions, ${input.weeks} week${input.weeks === 1 ? "" : "s"}</div></div>
      <div class="bignum"><div class="n">${num(totals.contracts)}</div><div class="l">contracts locked in</div></div>
      <div class="bignum"><div class="n">${usd0(totals.notionalCents)}</div><div class="l">of the other side bought</div></div>
      <div class="bignum"><div class="n">${totals.priced > 0 ? `${Math.round((100 * totals.refused) / totals.priced)}%` : "n/a"}</div><div class="l">of markets priced were refused</div></div>
    </div>
    <div class="links">
      <a class="back" href="/api/shadow/scoreboard${q}">JSON</a>
      <a class="back" href="/api/shadow/scoreboard.csv${q}" download>Download CSV</a>
      <a class="back" href="/scoreboard?weeks=${input.weeks >= 26 ? 8 : 26}">${input.weeks >= 26 ? "Last 8 weeks" : "Last 26 weeks"}</a>
    </div>
    ${latest && latest.n > 0 ? `<div class="rule">Latest week with positions: ${escapeHtml(latest.label)}. ${escapeHtml(weekSummary(latest))}</div>` : ""}
  </div>

${weekCards}

  <div class="card">
    <h2>Fee schedules on the other side</h2>
    ${feeRules}
    <div class="rule">What each venue charges on the other side, as the engine folds it into that venue's book before the routes are compared. The fee column above is that schedule at the price the other side was bought at, times the units bought, per contract of the position, so it reads against the edge column. The edge is after fees.</div>
  </div>

  <div class="card">
    <h2>How to read this</h2>
    <div class="read">${escapeHtml(sb.methodology)}</div>
    <div class="rule">Columns in the CSV: one <code>all</code> row per week with the totals and refusals, then one row per venue with singles and parlays won (positions, contracts, share of contracts), edge (n, cents per contract, all-in bps), fee (n, cents per contract) and availability (asked, priced, percent). The JSON has the same by week with a by-league cut.</div>
  </div>
  <footer>
    Public. Venue names on purpose: this is the hedger's comparison of the venues for industry readers. Nothing of our own book is on this page. Rendered ${escapeHtml(sb.at.slice(0, 16).replace("T", " "))} UTC.
  </footer>
</div>
</body>
</html>`;
}
