/** Server-rendered page. No framework, no external assets. Same conventions as the BTC curve page. */

import type { AllIn, GameRead, GapSeries, SlateRead, WindowTally } from "./analytics";
import { HOLDER_DEPTHS, type HolderReport, type HolderRow } from "./holder";
import type { ReportData } from "./report";
import { VENUE_NAME, VENUES, type Side, type Venue } from "./types";
import { pageLinksHtml, type PageLink } from "../btcCurve/pageLinks";

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const c = (v: number | null | undefined, digits = 1): string => (v === null || v === undefined || !Number.isFinite(v) ? "–" : `${v.toFixed(digits)}¢`);
const signed = (v: number | null | undefined, digits = 1): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  const z = Math.abs(v) < 0.5 * 10 ** -digits;
  return `${!z && v > 0 ? "+" : !z && v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}¢`;
};
const usd = (v: number | null | undefined, digits = 0): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "–" : `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const num = (v: number, digits = 0): string => v.toLocaleString("en-US", { maximumFractionDigits: digits });
const et = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return `${d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET`;
};
const etTime = (iso: string): string => et(iso).replace(/^.*?, /, "");
const LEAGUE = { nfl: "NFL", nba: "NBA", nhl: "NHL" } as Record<string, string>;
const V = (v: Venue): string => VENUE_NAME[v];
const short = (v: Venue): string => (v === "polymarket_us" ? "Poly US" : VENUE_NAME[v]);
const COUNT_WORD = ["none", "one", "two", "three", "four", "five", "six"];
const ALL_VENUES = `all ${COUNT_WORD[VENUES.length] ?? VENUES.length}`;
/** The fee as it applies now, in the venue's own terms: per contract, on winnings, or none. */
const feeWords = (q: AllIn): string =>
  q.feeFlatCents
    ? `fee ${q.feeFlatCents}¢ a contract`
    : q.feeGain
      ? `fee ${(q.feeGain * 100).toFixed(q.feeGain * 100 % 1 ? 1 : 0)}% of winnings`
      : q.feeTheta
        ? `fee ${(q.feeTheta * 100).toFixed(1)}%`
        : "no fee";
/** "A, B, C and D" over the venues on the page. */
const VENUE_LIST = `${VENUES.slice(0, -1).map((v) => VENUE_NAME[v]).join(", ")} and ${VENUE_NAME[VENUES[VENUES.length - 1]]}`;

function quoteCell(q: AllIn | null): string {
  if (!q) return '<td class="dim">not listed</td>';
  if (q.bidCents <= 0 && (q.askCents <= 0 || q.askCents >= 100)) return '<td class="dim">no book</td>';
  const p = (x: number) => (Number.isInteger(x) ? x.toFixed(0) : x.toFixed(2).replace(/0$/, ""));
  const depth = q.bidQty || q.askQty ? `<small>${num(q.bidQty)} × ${num(q.askQty)} · ${feeWords(q)}</small>` : `<small>${feeWords(q)}</small>`;
  return `<td><b>${q.bidCents > 0 ? p(q.bidCents) : "–"}</b> / <b>${q.askCents > 0 && q.askCents < 100 ? p(q.askCents) : "–"}</b>${depth}</td>`;
}

function gapCell(v: number | null): string {
  if (v === null) return '<td class="dim">–</td>';
  const cls = Math.abs(v) >= 2 ? "hot" : Math.abs(v) >= 1 ? "warm" : "";
  return `<td class="${cls}">${signed(v)}</td>`;
}

function hedgeCell(g: GameRead, side: Side): string {
  const h = g.sides[side].hedge;
  if (!h.cheapest || h.cheapestCents === null) return '<td class="dim">–</td>';
  const quoted = VENUES.filter((v) => h.costs[v] !== null).length;
  const saving = h.savingCents !== null && h.savingCents > 0 && h.cheapest !== "kalshi" ? ` · <b class="ok">saves ${c(h.savingCents, 2)}</b> vs Kalshi's own` : h.cheapest === "kalshi" ? " · Kalshi's own is cheapest" : "";
  return `<td class="hedge"><b>${short(h.cheapest)}</b> ${c(h.cheapestCents, 2)} all in${saving}<small>${quoted} venue${quoted > 1 ? "s" : ""} quote it · ${h.cheapestQty ? `${num(h.cheapestQty)} at the best level` : "depth not read"}</small></td>`;
}

function boardHtml(games: GameRead[]): string {
  if (!games.length) return '<p class="dim">No game on the board within the horizon.</p>';
  const head = `<tr><th>Game · side</th>${VENUES.map((v) => `<th>${esc(V(v))}<br><small>bid / ask · depth</small></th>`).join("")}<th>Consensus<br><small>de-vigged, mean</small></th>${VENUES.map((v) => `<th>${esc(short(v))}<br><small>− consensus</small></th>`).join("")}<th>Other side, cheapest<br><small>for a holder of this side</small></th></tr>`;
  const rows = games
    .map((g) => {
      const over = VENUES.filter((v) => g.overround[v] !== null)
        .map((v) => `${short(v)} ${c(g.overround[v], 1)}`)
        .join(" · ");
      const when = g.live ? '<b class="live">Live</b>' : g.startSource === "venue" ? etTime(g.startsAt) : `${et(g.startsAt).split(",")[0]}, time not listed`;
      const cross = g.crosses[0];
      const crossNote = cross ? ` · <span class="cross">cross: buy ${g.sides.away.code} on ${short(cross.awayOn)} ${c(cross.awayAllInAsk, 2)} + ${g.sides.home.code} on ${short(cross.homeOn)} ${c(cross.homeAllInAsk, 2)} = <b>${signed(cross.edgeCents, 2)}</b> on ${num(cross.qty)}</span>` : "";
      const header = `<tr class="game"><td colspan="${VENUES.length * 2 + 3}"><b>${esc(LEAGUE[g.league] ?? g.league)}</b> · ${esc(g.sides.away.name)} at ${esc(g.sides.home.name)} · ${when}<small>Both sides at all-in asks, minus 100: ${over || "–"}${g.tightest ? ` · tightest ${short(g.tightest)}` : ""}${crossNote}</small></td></tr>`;
      const sideRow = (side: Side) => {
        const s = g.sides[side];
        return `<tr><td class="lbl">${esc(s.code)} <small>${side}</small></td>${VENUES.map((v) => quoteCell(s.quotes[v])).join("")}<td>${c(s.consensusCents, 1)}</td>${VENUES.map((v) => gapCell(s.vsConsensus[v])).join("")}${hedgeCell(g, side)}</tr>`;
      };
      return `${header}${sideRow("away")}${sideRow("home")}`;
    })
    .join("");
  return `<div class="tbl"><table>${head}${rows}</table></div>`;
}

function crossesHtml(s: SlateRead, w: WindowTally): string {
  const now = s.crosses.length
    ? `<div class="tbl"><table><tr><th>Game</th><th>Buy away on</th><th>Buy home on</th><th>Two all-in asks</th><th>Locked per $1</th><th>Depth<br><small>smaller best level</small></th><th>Dollars</th></tr>${s.crosses
        .map(
          (x) =>
            `<tr><td class="lbl">${esc(LEAGUE[x.league] ?? x.league)} ${esc(x.label)}${x.live ? ' <b class="live">Live</b>' : ""}</td><td>${short(x.awayOn)} ${c(x.awayAllInAsk, 2)}</td><td>${short(x.homeOn)} ${c(x.homeAllInAsk, 2)}</td><td>${c(x.awayAllInAsk + x.homeAllInAsk, 2)}</td><td class="cross"><b>${signed(x.edgeCents, 2)}</b></td><td>${num(x.qty)}</td><td><b>${usd(x.usd, 0)}</b></td></tr>`,
        )
        .join("")}</table></div><p class="dim">Total at resting depth ${usd(s.crossUsd, 0)}. Cents per contract on the best levels only; the next level is wider.</p>`
    : '<p class="dim">No executable cross after both venues\' taker fees this snapshot: every game\'s two cheapest sides add to 100¢ or more.</p>';
  const window = w.snapshots
    ? `<div class="note"><b>Over the window:</b> a cross was open in ${w.snapshotsWithCross} of ${w.snapshots} snapshots${
        w.widestCross ? `; widest ${signed(w.widestCrossCents, 2)} per $1, ${esc(w.widestCross.label)}, ${short(w.widestCross.awayOn)} against ${short(w.widestCross.homeOn)}, ${et(new Date(w.widestCross.atMs).toISOString())}` : ""
      }.</div>`
    : "";
  return `${now}${window}`;
}

function hedgerHtml(s: SlateRead, w: WindowTally): string {
  const rows = s.venues
    .map(
      (t) =>
        `<tr><td class="lbl">${esc(V(t.venue))}</td><td>${t.listed} <small>${t.twoSided} two-sided</small></td><td>${c(t.meanOverround, 2)}</td><td>${t.tightestCount}</td><td>${t.hedgeQuoted}</td><td><b>${t.hedgeCheapest}</b></td><td>${t.venue === "kalshi" ? '<span class="dim">reference</span>' : c(t.meanSavingCents, 2)}</td><td>${c(t.meanAbsVsConsensus, 2)}</td></tr>`,
    )
    .join("");
  const share = (counts: Record<Venue, number>, total: number) => VENUES.map((v) => `${short(v)} <b>${total ? Math.round((counts[v] / total) * 100) : 0}%</b>`).join(" · ");
  const coverage = s.venues
    .filter((t) => t.listed && t.listed < s.games)
    .map((t) => `${V(t.venue)} lists ${t.listed} of the ${s.games} games and is tightest on ${t.tightestCount} of those ${t.listed}`)
    .join("; ");
  return `<div class="strip"><span>Sides with a choice of venue for the other side <b>${s.sidesWithChoice}</b> <small>of ${s.games * 2}</small></span><span>Routed off Kalshi <b>${s.sidesRoutedAway}</b> <small>${s.sidesWithChoice ? Math.round((s.sidesRoutedAway / s.sidesWithChoice) * 100) : 0}% · mean saving ${c(s.meanSavingRoutedCents, 2)} per $1</small></span></div>
${coverage ? `<p class="dim">Coverage differs: ${coverage}. Counts below are over the games each venue lists.</p>` : ""}
<div class="tbl"><table><tr><th>Venue</th><th>Games listed</th><th>Both sides, all in<br><small>mean over 100¢</small></th><th>Tightest book<br><small>games</small></th><th>Other side quoted<br><small>sides</small></th><th>Cheapest other side<br><small>sides</small></th><th>Saving when cheapest<br><small>vs Kalshi's own, mean</small></th><th>|vs consensus|<br><small>mean</small></th></tr>${rows}</table></div>
${
  w.readings
    ? `<div class="note"><b>Over the window:</b> ${num(w.readings)} readings (one side of one game in one snapshot, two or more venues quoting the other side). Cheapest: ${share(w.cheapest, w.readings)}. Mean saving when not Kalshi ${c(w.meanSavingRoutedCents, 2)} per $1.${
        w.liveReadings ? ` In play (${num(w.liveReadings)} readings): ${share(w.liveCheapest, w.liveReadings)}; mean saving ${c(w.liveMeanSavingRoutedCents, 2)}.` : " No in-play readings yet."
      }</div>`
    : ""
}`;
}

function spark(series: Array<[number, number]>, range: number): string {
  if (series.length < 2) return '<span class="dim">collecting</span>';
  const W = 160;
  const H = 28;
  const t0 = series[0][0];
  const t1 = series[series.length - 1][0];
  const span = Math.max(1, t1 - t0);
  const pts = series.map(([t, g]) => `${(((t - t0) / span) * W).toFixed(1)},${(H / 2 - (Math.max(-range, Math.min(range, g)) / range) * (H / 2 - 2)).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 ${W} ${H}" class="spark"><line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" class="zero"/><polyline points="${pts}"/></svg>`;
}

function gapsHtml(all: GapSeries[]): string {
  // one row per game: the home side's gap is the away side's mirror to within rounding
  const gaps = all.filter((g) => g.side === "away");
  if (!gaps.length) return '<p class="dim">Fills as snapshots accumulate, one per cycle.</p>';
  const by = (v: Venue) => gaps.filter((g) => g.venue === v);
  const strip = VENUES.filter((v) => v !== "kalshi")
    .map((v) => {
      const rows = by(v);
      if (!rows.length) return "";
      const mean = rows.reduce((a, r) => a + r.meanAbs, 0) / rows.length;
      const widest = rows.reduce((a, r) => (r.meanAbs > a.meanAbs ? r : a), rows[0]);
      const persistent = rows.filter((r) => r.meanAbs >= 1).length;
      return `<span>Kalshi − ${short(v)}, mean |gap| <b>${c(mean, 2)}</b> <small>${rows.length} games · widest ${esc(widest.label)} ${c(widest.meanAbs, 2)}</small></span><span>Games 1¢ or more apart on average <b>${persistent} of ${rows.length}</b> <small>persistent: quoting difference</small></span>`;
    })
    .join("");
  const range = Math.max(2, ...gaps.map((g) => g.max));
  const table = `<div class="tbl"><table><tr><th>Game <small>away side</small></th><th>Kalshi − venue</th><th>Window</th><th>Mean |gap|</th><th>Max |gap|</th><th>Last</th><th>n</th></tr>${[...gaps]
    .sort((a, b) => b.meanAbs - a.meanAbs)
    .map((g) => `<tr><td class="lbl">${esc(g.label)} <small>${esc(g.code)} wins</small></td><td>${short(g.venue)}</td><td>${spark(g.series, range)}</td><td>${c(g.meanAbs, 2)}</td><td>${c(g.max, 2)}</td>${gapCell(g.last)}<td class="dim">${g.points}</td></tr>`)
    .join("")}</table></div>`;
  return `<div class="strip">${strip}</div><details><summary>All ${gaps.length} game and venue pairs, with sparklines</summary>${table}</details>`;
}

const pct = (x: number | null | undefined): string => (x === null || x === undefined || !Number.isFinite(x) ? "–" : `${Math.round(x * 100)}%`);

function holderTable(rows: HolderRow[]): string {
  const shown = rows.filter((r) => r.readings || r.noBid);
  if (!shown.length) return '<p class="dim">No readings yet.</p>';
  const body = shown
    .map((r) => {
      const most = r.cheapestMost ? ` · most often cheapest ${short(r.cheapestMost.venue)} ${pct(r.cheapestMost.share)}` : "";
      return `<tr><td class="lbl">${esc(V(r.venue))}</td><td>${num(r.readings)}<small>${r.noBid ? `${num(r.noBid)} more with no bid` : "a bid every time"}</small></td><td><b>${c(r.saleCostCents, 2)}</b></td><td>${c(r.meanSpreadCents, 2)}</td><td>${pct(r.depthShare[1])}<small>${num(HOLDER_DEPTHS[0])} or more ${pct(r.depthShare[0])} · ${num(HOLDER_DEPTHS[2])} or more ${pct(r.depthShare[2])}</small></td><td><b>${pct(r.elsewhereShare)}</b><small>${r.meanSavingCents !== null ? `mean saving ${c(r.meanSavingCents, 2)}` : "no saving"}${most}</small></td><td><b>${pct(r.roomShare)}</b><small>${r.meanRoomCents !== null ? `mean room ${c(r.meanRoomCents, 2)}` : "never"}</small></td></tr>`;
    })
    .join("");
  return `<div class="tbl"><table><tr><th>Holder's venue</th><th>Readings<br><small>sides with a bid</small></th><th>Sale on its own book<br><small>consensus − all-in bid, mean</small></th><th>Spread<br><small>ask − bid, mean</small></th><th>Bid holds ${num(HOLDER_DEPTHS[1])} or more<br><small>contracts at the best bid</small></th><th>Other side cheaper elsewhere<br><small>share of readings with a choice</small></th><th>Room for a better bid<br><small>after every fee, share of readings</small></th></tr>${body}</table></div>`;
}

function holderHtml(h: HolderReport | undefined): string {
  if (!h || !h.snapshots) return '<p class="dim">Fills as snapshots accumulate, one per cycle.</p>';
  const leagues = Object.keys(h.byLeague);
  const byLeague = leagues.length
    ? `<details><summary>By league</summary>${leagues
        .map((l) => `<h3>${esc(LEAGUE[l] ?? l)} · before the start</h3>${holderTable(h.byLeague[l].pre)}<h3>${esc(LEAGUE[l] ?? l)} · in play</h3>${holderTable(h.byLeague[l].live)}`)
        .join("")}</details>`
    : "";
  return `<p class="dim">${num(h.snapshots)} snapshots${h.sinceMs ? ` since ${et(new Date(h.sinceMs).toISOString())}` : ""}. This count is kept on disk and does not roll off with the window.</p>
<h3>Before the start</h3>${holderTable(h.all.pre)}
<h3>In play</h3>${holderTable(h.all.live)}
${byLeague}`;
}

function tiles(d: ReportData): string {
  const s = d.slate;
  const w = d.window;
  const tightList = [...s.venues]
    .filter((t) => t.listed)
    .sort((a, b) => b.tightestCount - a.tightestCount)
    .map((t) => `${short(t.venue)} ${t.tightestCount} of ${t.listed}`)
    .join(" · ");
  const over = s.venues.filter((t) => t.listed).map((t) => `${short(t.venue)} ${c(t.meanOverround, 1)}`).join(" · ");
  const cheapestNow = [...s.venues].sort((a, b) => b.hedgeCheapest - a.hedgeCheapest)[0];
  const winShare = (counts: Record<Venue, number>, total: number) => {
    const best = VENUES.reduce((a, v) => (counts[v] > counts[a] ? v : a), VENUES[0]);
    return total ? `${short(best)} ${Math.round((counts[best] / total) * 100)}%` : "–";
  };
  const offs = s.venues.filter((t) => t.meanAbsVsConsensus !== null).sort((a, b) => (b.meanAbsVsConsensus as number) - (a.meanAbsVsConsensus as number));
  return `<div class="kpis now">
<div><small>Games with a choice of venue</small><b>${s.withTwo} of ${s.games}</b><small>${s.withAll} on ${ALL_VENUES} · ${s.live} live now</small></div>
<div><small>Tightest book, both sides all in</small><b>${tightList || "–"}</b><small>games tightest of games listed · mean over 100¢: ${over}</small></div>
<div><small>Cheapest other side, now</small><b>${s.sidesRoutedAway} of ${s.sidesWithChoice} sides off Kalshi</b><small>mean saving ${c(s.meanSavingRoutedCents, 2)} per $1${cheapestNow && cheapestNow.hedgeCheapest ? ` · ${short(cheapestNow.venue)} cheapest on ${cheapestNow.hedgeCheapest}` : ""}</small></div>
<div><small>Cheapest other side, over the window</small><b>${winShare(w.cheapest, w.readings)}</b><small>${num(w.readings)} readings · mean saving when not Kalshi ${c(w.meanSavingRoutedCents, 2)}${w.liveReadings ? ` · in play ${winShare(w.liveCheapest, w.liveReadings)}` : ""}</small></div>
<div><small>Executable crosses after fees</small><b>${s.crosses.length ? `${s.crosses.length} · ${usd(s.crossUsd, 0)}` : "none now"}</b><small>${w.snapshots ? `open in ${w.snapshotsWithCross} of ${w.snapshots} snapshots${w.widestCrossCents > 0 ? ` · widest ${signed(w.widestCrossCents, 2)}` : ""}` : "first cycle"}</small></div>
<div><small>Furthest off the consensus</small><b>${offs.length ? `${short(offs[0].venue)} ${c(offs[0].meanAbsVsConsensus, 2)}` : "–"}</b><small>mean |de-vigged mid − mean of venues|${offs.length > 1 ? ` · ${offs.slice(1).map((t) => `${short(t.venue)} ${c(t.meanAbsVsConsensus, 2)}`).join(" · ")}` : ""}</small></div>
</div>`;
}

/** The sports pages a host serves under its "Sports" link, each address carrying the host's key. With no host links the pages sit at the root. */
export function sportsPaths(links: PageLink[] | undefined): { board: string; replay: string; lock: string; token: string } {
  const href = links?.find((l) => l.label === "Sports")?.href ?? "/";
  const [path, query = ""] = href.split("?");
  const base = path.replace(/\/+$/, "");
  const q = query ? `?${query}` : "";
  return { board: `${base || "/"}${q}`, replay: `${base}/replay${q}`, lock: `${base}/lock${q}`, token: new URLSearchParams(query).get("k") ?? "" };
}

/** The line of links between the sports pages; `here` is shown, not linked. */
export function sportsNavHtml(links: PageLink[] | undefined, here: "board" | "replay" | "lock"): string {
  const p = sportsPaths(links);
  const items: Array<["board" | "replay" | "lock", string, string]> = [
    ["board", "The venues side by side", p.board],
    ["replay", "Lock in, replayed on real trades", p.replay],
    ["lock", "Lock in now", p.lock],
  ];
  return `<nav style="font-size:13px;margin:0 0 10px;color:#6b7280">${items.map(([id, label, href]) => (id === here ? `<b>${esc(label)}</b>` : `<a href="${esc(href)}">${esc(label)}</a>`)).join(" · ")}</nav>`;
}

/** The one stylesheet of the sports pages. */
export const SPORTS_PAGE_STYLE = `:root{--ink:#111;--dim:#6b7280;--line:#e5e7eb;--k:#0a66c2;--hot:#b91c1c;--warm:#b45309;--ok:#047857}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;color:var(--ink);background:#fff}
main{max-width:1400px;margin:0 auto;padding:20px 16px 60px}h1{font-size:24px;margin:0 0 4px;letter-spacing:-.01em}h2{font-size:18px;margin:34px 0 8px}h3{font-size:15px;margin:18px 0 6px}
p{margin:6px 0}.dim{color:var(--dim)}small{color:var(--dim);font-size:12px;display:block}.lead{font-size:16px}
.strip{display:flex;flex-wrap:wrap;gap:10px 22px;margin:12px 0 4px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:#fafafa}.strip b{font-variant-numeric:tabular-nums}
.tbl{overflow-x:auto;margin:8px 0}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:14px}th{font-weight:600;text-align:left;color:var(--dim);font-size:12px;border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:bottom;white-space:nowrap}
td{padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:top}td.lbl{font-weight:500}td small{display:block;color:var(--dim);font-size:11px}td.hedge{white-space:normal;min-width:190px;font-size:13px}
tr.game td{background:#fafafa;padding-top:10px;white-space:normal}tr.game small{display:block;margin-top:2px}
.hot{color:var(--hot);font-weight:600}.warm{color:var(--warm)}.cross{color:var(--ok)}.ok{color:var(--ok)}.bad{color:var(--hot)}.live{color:var(--hot);font-weight:600}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:8px 0}.kpis div{border:1px solid var(--line);border-radius:8px;padding:10px 12px}.kpis b{display:block;font-size:17px;margin:2px 0;font-variant-numeric:tabular-nums}.kpis.now{margin:14px 0 0}.kpis.now div{background:#fafafa}
.tag{display:inline-block;font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;padding:1px 7px;border-radius:999px;vertical-align:middle;margin-left:8px}.tag.ref{background:#f3f4f6;color:var(--dim)}.tag.eng{background:#e8f0fb;color:var(--k)}
.key{display:flex;flex-wrap:wrap;gap:8px 28px;font-size:13px;color:var(--dim);margin:10px 0 0}.key span{display:flex;gap:8px;align-items:baseline}.key .tag{margin:0}
svg.spark{width:160px;height:28px;display:block}svg.spark polyline{fill:none;stroke:var(--k);stroke-width:1.5}svg.spark .zero{stroke:var(--line)}
details{margin:8px 0}summary{cursor:pointer;color:var(--k);font-size:13px}
.note{border-left:3px solid var(--line);padding:4px 12px;color:var(--dim);font-size:13px;margin:10px 0}.limits{padding-left:18px;font-size:13px;color:var(--dim);margin:6px 0}.limits li{margin:5px 0}.limits b{color:var(--ink)}footer{margin-top:40px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:12px}
`;

export function renderReportHtml(d: ReportData, opts: { refreshSec?: number; links?: PageLink[] } = {}): string {
  const healthLine = Object.entries(d.health)
    .map(([k, h]) => `<span class="${h.ok ? "ok" : "bad"}">${esc(k)} ${h.ok ? `${h.ms}ms${h.detail ? ` (${esc(h.detail)})` : ""}` : esc(h.detail ?? "down")}</span>`)
    .join(" · ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">${opts.refreshSec ? `<meta http-equiv="refresh" content="${opts.refreshSec}">` : ""}
<title>Sports on the event venues: ${VENUES.map((v) => esc(V(v))).join(", ")}</title>
<style>
${SPORTS_PAGE_STYLE}</style></head><body><main>
${pageLinksHtml(opts.links, "Sports")}${sportsNavHtml(opts.links, "board")}<h1>Sports on the event venues</h1>
<p class="lead">The same game's winner market on ${esc(VENUE_LIST)}, side by side, after each venue's taker fee. Where the other side of a position is cheapest, what the venues disagree on, and what can be locked across them. Live from public market data. Read-only.</p>
<div class="strip"><span>As of <b>${et(d.at)}</b> <small>refresh ${d.intervalSec}s</small></span><span>Games on the board <b>${d.slate.games}</b> <small>NFL, NBA, NHL · next three days · ${d.slate.live} live</small></span><span>Window <b>${d.historyPoints}</b> snapshots <small>${d.windowHours ? `the last ${d.windowHours} hours · ` : ""}${d.collectingSince ? `${d.windowHours ? "collecting " : ""}since ${et(d.collectingSince)}` : "first cycle"}</small></span></div>
<div class="key"><span><i class="tag ref">Reference</i>what the venues show on their own: bid, ask, depth, each venue's fee, gaps over time</span><span><i class="tag eng">Engine</i>what reading every venue's book for the same game at once adds: all-in prices, the consensus and who sits off it, the cheapest other side for every position with the saving, the crosses in dollars</span></div>
${tiles(d)}
<p class="dim">If you hedge one venue's position on another, start at the last column of §1 and at §3. §2 is the part of the disagreement that locks. §5 asks the same from the side of a holder on each venue, over every snapshot kept.</p>

<h2>1 · The board <span class="tag ref">Reference</span><span class="tag eng">Engine</span></h2>
<p>One game, two rows: each team's "wins" contract on each venue, bid / ask with depth at the best level and the venue's taker fee as it applies now. Consensus: each venue's two mids scaled to sum to 100, averaged over the venues quoting both sides. The gap columns: each venue's scaled mid minus that mean. Last column, for a holder of this side: the other side's all-in ask (ask plus fee) on every venue, the cheapest named, and what it saves against Kalshi's own.</p>
${boardHtml(d.games)}

<h2>2 · Executable crosses, in dollars <span class="tag eng">Engine</span></h2>
<p>Buy the away side on one venue and the home side on another, both at all-in asks, when the two add to less than 100¢: the difference is locked whichever team wins, settlement being the same official result on every venue here. Depth is the smaller of the two best levels.</p>
${crossesHtml(d.slate, d.window)}

<h2>3 · The hedger's view of the venues <span class="tag eng">Engine</span></h2>
<p>Which venue's book is cheapest to take the other side of a position, all in, on the same games at the same moment. Each game contributes two sides. "Saving" is Kalshi's own other side minus the cheapest venue's, so Kalshi reads as the reference. Novig charges no fee before tip-off and 6% of p(1−p) once live, so its standing moves at the start. ProphetX takes 2% of a market's net winnings at settlement on NFL and NBA games, counted here in full as if the contract wins, and 3.5% of p(1−p) at the trade on NHL games. Crypto.com's exchange charges a fixed 2¢ a contract on every trade before expiry, whatever the price, so it costs most where a contract is cheap.</p>
${hedgerHtml(d.slate, d.window)}

<h2>4 · Gaps over time <span class="tag ref">Reference</span></h2>
<p>Kalshi's mid minus each other venue's mid on the away side, per game, every snapshot in the window; the home side is the mirror. Persistent gap: quoting difference. Flickering gap: latency.</p>
${gapsHtml(d.gaps)}

<h2>5 · A holder on each venue <span class="tag eng">Engine</span></h2>
<p>Someone holds one side of a game on a venue and wants out. One row per venue as the holder's venue. Sale on its own book: the consensus minus that venue's bid after its fee, so half its spread, its fee and any lean. Other side cheaper elsewhere: how often another venue's all-in ask on the other side beats that venue's own, and by how much. Room for a better bid: how often someone could take the holder's contract at that venue's bid, pay that venue's fee on it, buy the other side on the cheapest venue and still have something left, which is the most a better bid could add. A reading is one side of one game in one snapshot while the game is open (consensus between 5¢ and 95¢).</p>
${holderHtml(d.holder)}

<h2>Notes and limits</h2>
<ul class="limits">
<li><b>Games.</b> Kalshi's open game markets for NFL, NBA and NHL whose ET game date is today or within three days; a game is on the board when Kalshi lists both teams. Polymarket US is looked up by its event slug (league, away, home, date; team spellings per its own team list), Novig by both clubs' codes and the ET date of its start, ProphetX and Crypto.com by both clubs' names and the ET date of their start. A game another venue lists that Kalshi does not is not on the board.</li>
<li><b>Sides.</b> Kalshi: the team's own market, Yes. Polymarket US: one market per game, the long side the away team, the home side 1 minus it, sizes carried across. Novig: one market, two outcomes, every order a bid; a bid on one is the ask on the other. Novig contracts pay 1¢ and sizes are shown in $1 shares. ProphetX: one market, every order backs a club at American odds; the best odds on a club, as a price, are its ask, and its bid is 1 minus the other club's ask. Its sizes are dollars a taker can still put on at those odds, shown here as the $1 contracts those dollars buy; a level holding under $1, the venue's smallest order, is passed over. Crypto.com: each club has its own $1 contract with its own book, as on Kalshi; the two full-game winner contracts of the game's event are read, not its period or prop contracts.</li>
<li><b>Fees.</b> Taker only, c·p·(1−p) per $1: Kalshi 0.07 (series multiplier 1), Polymarket US the market's coefficient (0.095 at Tier 1), Novig 0.06 charged only once the game is live (0 before), ProphetX 0.035 on NHL games. On NFL and NBA games ProphetX charges nothing at the trade and takes 2% of the market's net winnings at settlement: a buy at p is shown at p plus 2% of (1−p), the most that fee can be, so a cross or a saving shown here holds whichever team wins. ProphetX's model and rate are read from its own fee estimator for each game every cycle. Crypto.com's exchange (the book behind OG and behind brokers that introduce customers to it) charges a broker's customer a fixed 2¢ per contract to open and 2¢ to close before expiry, nothing at settlement; its schedule also allows a price-weighted 0.07·p·(1−p) depending on the broker's connection, never more than the 2¢, and the page says in each cell which is counted. A broker's own commission on top is not public and is not counted. Kalshi rounds an order's fee up to the cent; ignored here. Maker rebates ignored.</li>
<li><b>Consensus.</b> Not a model and not a sharp line: the mean of the venues' own de-vigged mids. With two venues it is their midpoint and the gaps are symmetric. A venue off it is off its peers, which is a different claim from off fair value.</li>
<li><b>Settlement.</b> Every venue here settles game winners on the official league result; NHL winners include overtime and the shootout on each (ProphetX lists its regulation-only market separately; it is not read). Postponement, tie and abandonment handling differ by venue; a cross or a hedge across venues carries that tail, which is small and real. Crypto.com's is the widest: a game not completed within 48 hours of its scheduled start settles at the prior week's average price.</li>
<li><b>Timing.</b> The venues are read within one cycle, not at one instant; in play, a cent of gap can be a few seconds of latency. The window sections average that out; a single live row does not.</li>
<li><b>Depth.</b> Best level only. A cross or a saving is shown at that size; the next level is wider.</li>
</ul>

<footer>
<p><b>Sources.</b> Kalshi public market API (KXNFLGAME, KXNBAGAME, KXNHLGAME; markets, orderbooks, series fee) · Polymarket US public Retail API (gateway.polymarket.us; events by slug, books) · Novig public catalog (MONEY markets per league with best bids) · ProphetX public web endpoints (prophetx.co; events per league, winner market levels, fee estimator, commission rates) · Crypto.com public market-data API of its US exchange (api.crypto.com/fcm/v1/public; events per league, a game's contracts, books). No credentials loaded; nothing here can place an order.</p>
<p><b>Health this cycle.</b> ${healthLine}</p>
</footer></main></body></html>`;
}
