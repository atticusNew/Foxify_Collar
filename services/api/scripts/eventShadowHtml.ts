/**
 * Track record page — the public face of the event shadow run.
 *
 * Renders the replayed ledger: settled events marked against official Kalshi
 * results, the open book, and the honest aggregate (protection usually costs
 * a little; the floor is what it buys). Written for a partner reading it once:
 * the identity (we carry no outcome risk) leads, then what settled, then with
 * and without protection, then where it is cheap and rich. Our book line by
 * line (cap slices, floors, hedge legs, per league) is on the operator report.
 * "Our P&L" and "user", never "writer" and "holder", on the public page. Same
 * visual language as the demo and receipts pages. Server-rendered, no client JS.
 */

import type { RuleBook, ShadowPosition, ShadowSegment, ShadowSummary } from "../src/eventCollar/crossVenue/shadowLedger";
import type { HedgeReceiptSummary, HedgeStrategy } from "../src/eventCollar/crossVenue/hedgeExecutor";
import { PROTECTION_TIERS, type ProtectionTier } from "../src/eventCollar/crossVenue/types";
import { TIER_RULES } from "../src/eventCollar/crossVenue/collarSearch";

/** Public URL of the interactive demo, for the cross-link. */
function demoUrl(): string {
  return process.env.EVENT_SHADOW_DEMO_URL || "https://event.earnandprotect.xyz/";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shortEt(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "event time";
  const d = new Date(ms);
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
  const tm = d
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })
    .toLowerCase()
    .replace(" ", "");
  return `${day} ${tm} ET`;
}

export interface ShadowPageInput {
  atIso: string;
  summary: ShadowSummary;
  open: ShadowPosition[];
  settled: ShadowPosition[];
  /** the hedge trail, when the worker keeps one */
  hedges?: { strategy: HedgeStrategy; rfqVenues: string[]; summary: HedgeReceiptSummary };
}

/** One public line on hedge fills: how they are filled and how many. The receipts themselves are the operator's. */
function hedgeLine(h: NonNullable<ShadowPageInput["hedges"]>): string {
  const s = h.summary;
  const how = h.strategy === "rfq" ? "RFQ first, visible book as the fallback" : "at the visible book, at the terms quoted";
  const sim = s.receipts > 0 && s.simulated === s.receipts ? ", all simulated" : s.simulated > 0 ? `, ${s.simulated} simulated` : "";
  return `<div class="row"><span>hedge fills</span><b>${escapeHtml(how)} <i>${s.receipts} recorded${sim}</i></b></div>`;
}

const signedUsd = (c: number): string => (c < 0 ? `-${usd(-c)}` : usd(c));
const bpsPct = (bps: number | null, digits = 2): string => (bps === null ? "–" : `${(bps / 100).toFixed(digits)}%`);
/**
 * A slice with fewer events than this shows its counts and nothing else: four NFL games do not
 * make a percentage, and a page that prints one anyway is calling noise a finding.
 */
export const MIN_SLICE_EVENTS = 20;
const utcDay = (iso: string): string => iso.slice(0, 10);
/** Public words for a hedge route: how it was hedged, not where (the venue is the operator's). */
const ROUTE_WORDS: Record<string, string> = {
  kalshi_self: "hedged on the market's own No side",
  polymarket: "hedged cross-venue on the same game",
};

const SHADOW_CSS = `
:root{
  --bg:#f6f7f7; --card:#ffffff; --card2:#f2f4f4; --line:#e4e7e7;
  --ink:#050d0a; --dim:#5c6a64; --faint:#98a49e;
  --green:#00b67a; --green-deep:#014737; --green-wash:#e9f8f2; --warn:#b9862f;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;min-height:100vh}
.topbar{background:#050d0a}
.topbar .in{max-width:430px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:10px 16px}
.topbar .wordmark{color:#fff;font-weight:650;font-size:14px}
.topbar .wordmark span{color:#8f9c96;font-weight:400}
.wrap{max-width:430px;margin:0 auto;padding:14px 14px 40px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:12px;box-shadow:0 1px 2px rgba(5,13,10,.04)}
h1{font-size:19px;font-weight:650;letter-spacing:-.01em}
.sub{color:var(--dim);font-size:13px;margin-top:4px}
.bignums{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}
.bignum{flex:1;min-width:calc(50% - 5px);background:var(--card2);border-radius:10px;padding:12px;text-align:center}
.period{color:var(--dim);font-size:12px;margin-top:10px;font-variant-numeric:tabular-nums}
.bignum .n{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.bignum .n.green{color:var(--green)}
.bignum .l{color:var(--dim);font-size:11.5px;margin-top:2px}
h2{font-size:12px;color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;font-size:13.5px;color:var(--dim);font-variant-numeric:tabular-nums;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}
.row b{color:var(--ink);font-weight:650;text-align:right}
.row b i{color:var(--faint);font-style:normal;font-weight:500;font-size:12px}
.row b i.paid{display:block;margin-top:1px}
.row.settled b,.row.open b{white-space:nowrap;flex-shrink:0}
.tag{display:inline-block;background:var(--card2);color:var(--dim);border-radius:6px;padding:1px 6px;font-size:10.5px;font-weight:600;vertical-align:1px}
.tag.save{background:var(--green-wash);color:var(--green-deep)}
.back{display:inline-block;margin-top:2px;color:var(--green-deep);font-weight:600;font-size:13px;text-decoration:underline}
.read{color:var(--ink);font-size:13.5px;line-height:1.5;margin-top:6px}
.read b{font-weight:650}
table{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums;margin-top:6px}
th{text-align:right;color:var(--dim);font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;padding:5px 4px;border-bottom:1px solid var(--line);white-space:nowrap}
th:first-child,td:first-child{text-align:left}
td{padding:6px 4px;border-bottom:1px solid var(--line);color:var(--dim);text-align:right;white-space:nowrap}
td.hi{color:var(--ink);font-weight:650}
tr.base td{color:var(--ink)}
.tablewrap{overflow-x:auto}
.rule{color:var(--faint);font-size:11.5px;margin-top:6px;line-height:1.45}
footer{color:var(--faint);font-size:11.5px;line-height:1.55;padding:14px 4px 0}
footer b{color:var(--dim);font-weight:600}
@media(min-width:700px){.wrap,.topbar .in{max-width:520px}}
`;

/**
 * The lists show up to 25 rows. Taken straight off the top they are 25 Bitcoin strikes, because
 * strikes are many and settle hourly; the games disappear. Round-robin across leagues in the
 * order given (most recent first, or next to lock first) so every league on the book is visible.
 */
export function interleaveByLeague<T extends { league: string }>(items: readonly T[], limit: number): T[] {
  const byLeague = new Map<string, T[]>();
  for (const it of items) {
    const list = byLeague.get(it.league) ?? [];
    list.push(it);
    byLeague.set(it.league, list);
  }
  const queues = [...byLeague.values()];
  const out: T[] = [];
  for (let i = 0; out.length < limit && queues.some((q) => i < q.length); i += 1) {
    for (const q of queues) if (i < q.length && out.length < limit) out.push(q[i]);
  }
  return out;
}

/** "42 open · 17 crypto · 15 MLB · 10 NFL": the list's true shape, whatever 25 rows show. */
function leagueCountLine(items: ReadonlyArray<{ league: string }>, noun: string): string {
  if (items.length === 0) return "";
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.league, (counts.get(it.league) ?? 0) + 1);
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${n} ${l === "crypto" ? "crypto" : l.toUpperCase()}`);
  return `<div class="sub" style="margin:-4px 0 8px">${items.length} ${noun} · ${escapeHtml(parts.join(" · "))}</div>`;
}

export function renderShadowHtml(input: ShadowPageInput): string {
  const s = input.summary;
  const settledRows = interleaveByLeague(input.settled, 25)
    .map((p) => {
      const saved = p.result === "no";
      const tag = saved ? '<span class="tag save">floor paid</span>' : '<span class="tag">won, capped</span>';
      // The credit was paid at open and is inside the protected total; say so on every row,
      // or "capped" reads as the whole story.
      return (
        `<div class="row settled"><span>${escapeHtml(p.sideName)} ${tag}</span>` +
        `<b>${usd(p.protectedCents ?? 0)} <i>vs ${usd(p.nakedCents ?? 0)} naked</i>` +
        `<i class="paid">incl. ${usd(p.creditCents)} paid at open</i></b></div>`
      );
    })
    .join("");
  const openRows = interleaveByLeague(input.open, 25)
    .map(
      (p) =>
        `<div class="row open"><span>${escapeHtml(p.sideName)} · locks ${escapeHtml(shortEt(p.eventTimeIso))}</span>` +
        `<b>floor ${usd(p.floorCents * p.contracts + p.creditCents)} · up to ${usd(p.capCents * p.contracts + p.creditCents)}</b></div>`,
    )
    .join("");
  const realizedLine =
    s.settledCount === 0
      ? "no events settled yet"
      : s.deltaTotalCents >= 0
        ? `protection is AHEAD of naked by ${usd(s.deltaTotalCents)} across settled events`
        : `protection cost ${usd(-s.deltaTotalCents)} across settled events; the floor is what it buys`;
  const quotedLine =
    s.quotedAvgEvBps === null
      ? "not yet recorded"
      : s.quotedAvgEvBps < 0
        ? `${Math.abs(s.quotedAvgEvBps / 100).toFixed(1)}% better than naked, on average`
        : `${(s.quotedAvgEvBps / 100).toFixed(1)}% of expected value, on average`;
  // The bridge between "floor saves" and "protection cost": one sentence that holds both, with
  // the realized cost next to the quoted one so the reader can see the quote was honest.
  const bridgeLine = (() => {
    if (s.settledCount === 0) return "";
    const savePct = Math.round((100 * s.floorSaves) / s.settledCount);
    const saved = `Protection paid the floor on ${s.floorSaves} of ${s.settledCount} settled events (${savePct}%).`;
    if (s.deltaTotalCents >= 0) return `${saved} Across everyone it came out ${usd(s.deltaTotalCents)} ahead of holding unprotected.`;
    const realizedPct = s.nakedTotalCents > 0 ? `${((100 * -s.deltaTotalCents) / s.nakedTotalCents).toFixed(1)}% of what the same positions paid unprotected` : usd(-s.deltaTotalCents);
    const quoted = s.quotedAvgEvBps !== null && s.quotedAvgEvBps >= 0 ? `; ${(s.quotedAvgEvBps / 100).toFixed(1)}% was quoted up front` : "";
    // Realized is one sample and quoted is the expectation; when strikes on one coin dominate the
    // settled book they settle together, so a rally caps many at once and the two numbers part.
    const cryptoSettled = s.segments.byLeague.crypto?.settled ?? 0;
    const cluster =
      cryptoSettled * 2 > s.settledCount
        ? " Strikes on the same coin settle together, so a rally caps many at once and a drop pays many floors at once; the gap between the two closes as the book widens."
        : "";
    return `${saved} Across everyone it cost ${usd(-s.deltaTotalCents)}, ${realizedPct}${quoted}. Quoted is the expectation at the market's odds; realized is what this sample did.${cluster}`;
  })();
  const routeRows = Object.entries(s.routeSplit)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([route, n]) =>
        `<div class="row"><span>${escapeHtml(ROUTE_WORDS[route] ?? route)}</span><b>${n}</b></div>`,
    )
    .join("");
  const id = s.identity;
  const identityLine =
    id.settled === 0
      ? "Nothing has settled yet; the identity is checked on every settlement."
      : id.holds
        ? `On ${id.settled} settled events our P&L is ${signedUsd(id.writerPnlCents)} and the take booked is ${usd(id.takeBookedCents)}: a gap of ${signedUsd(id.gapCents)}${id.gapCents === 0 ? "" : " (hedge units round up, never down)"}. The hedge layer carried no outcome risk.`
        : `On ${id.settled} settled events our P&L is ${signedUsd(id.writerPnlCents)} against ${usd(id.takeBookedCents)} of take booked: a gap of ${signedUsd(id.gapCents)}, outside rounding. Something in the hedge did not cover; the operator report has the positions.`;
  // Small slices show counts only: EV cost needs MIN_SLICE_EVENTS opened, user Δ needs that many settled.
  const fewCell = '<td><i style="font-style:normal;color:var(--faint)">too few</i></td>';
  const segmentRows = (m: Record<string, ShadowSegment>, label: (k: string) => string): string =>
    Object.entries(m)
      .sort((a, b) => b[1].opened - a[1].opened)
      .map(
        ([k, r]) =>
          `<tr><td>${escapeHtml(label(k))}</td><td>${r.opened}</td><td>${r.settled}</td>` +
          (r.opened >= MIN_SLICE_EVENTS ? `<td class="hi">${escapeHtml(bpsPct(r.quotedAvgEvBps))}</td>` : fewCell) +
          (r.settled >= MIN_SLICE_EVENTS && r.holderDeltaBpsOfStake !== null ? `<td>${escapeHtml(bpsPct(r.holderDeltaBpsOfStake))}</td>` : fewCell) +
          `<td>${usd(r.creditsCents)}</td><td>${signedUsd(r.writerPnlCents)}</td></tr>`,
      )
      .join("");
  const routeSeg = segmentRows(s.segments.byRoute, (k) => ROUTE_WORDS[k] ?? k);
  const leagueSeg = segmentRows(s.segments.byLeague, (k) => k.toUpperCase());
  const richest = Object.entries(s.segments.byLeague)
    .filter(([, r]) => r.quotedAvgEvBps !== null && r.opened >= MIN_SLICE_EVENTS)
    .sort((a, b) => (b[1].quotedAvgEvBps ?? 0) - (a[1].quotedAvgEvBps ?? 0));
  const segmentLine =
    richest.length >= 2
      ? `Protection is cheapest on ${richest[richest.length - 1][0].toUpperCase()} (${bpsPct(richest[richest.length - 1][1].quotedAvgEvBps)} of expected value quoted) and richest on ${richest[0][0].toUpperCase()} (${bpsPct(richest[0][1].quotedAvgEvBps)}); the record-wide average is weighted by how many of each the scanner found, not by what a user would choose.`
      : "";
  const windowLine = s.firstOpenedAt
    ? `Recording since ${escapeHtml(s.firstOpenedAt.slice(0, 16).replace("T", " "))} UTC. Append-only; positions are never edited, only opened and settled.`
    : "The book is empty; it fills as the scanner finds quotable events.";

  const w = s.writer;
  // The rule comparison (what every proposed rule would have written) stays on the operator report; the public page does not mention it.
  const periodLine =
    s.firstOpenedAt && s.lastSettledAt
      ? `${utcDay(s.firstOpenedAt)} to ${utcDay(s.lastSettledAt)} UTC, first position opened to last settlement`
      : s.firstOpenedAt
        ? `since ${utcDay(s.firstOpenedAt)} UTC; nothing settled yet`
        : "no positions yet";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:," />
<title>Track record · Earn &amp; Protect · events</title>
<meta name="description" content="A continuous simulated run of the protection engine, marked against official results as events settle." />
<style>${SHADOW_CSS}</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="wordmark">Earn &amp; Protect <span>· track record</span></div>
</div></div>
<div class="wrap">
  <div class="card">
    <h1>Track record</h1>
    <div class="sub">A continuous simulated run. Every quotable event is protected at its live quoted terms, then marked against the official result when it settles. Live prices; nothing is bought.</div>
    <div class="bignums">
      <div class="bignum"><div class="n green">${s.settledCount}</div><div class="l">events settled</div></div>
      <div class="bignum"><div class="n">${s.floorSaves}</div><div class="l">floor saves</div></div>
      <div class="bignum"><div class="n green">${s.openCount}</div><div class="l">open now</div></div>
      <div class="bignum"><div class="n ${w.settledPnlCents >= 0 ? "green" : ""}">${signedUsd(w.settledPnlCents)}</div><div class="l">our P&amp;L, settled</div></div>
    </div>
    <div class="period">${escapeHtml(periodLine)}</div>
  </div>
  <div class="card">
    <h2>We carry no outcome risk</h2>
    <div class="sub" style="margin-bottom:8px">Leg for leg, what we earn on a settled event must equal the published take: the hedge pays the floor, the cap slice pays the hedge, and nothing depends on who won.</div>
    <div class="bignums">
      <div class="bignum"><div class="n ${id.holds ? "green" : ""}">${signedUsd(id.writerPnlCents)}</div><div class="l">our P&amp;L, settled</div></div>
      <div class="bignum"><div class="n">${usd(id.takeBookedCents)}</div><div class="l">take booked</div></div>
      <div class="bignum"><div class="n ${id.holds ? "green" : ""}">${signedUsd(id.gapCents)}</div><div class="l">gap${id.settled > 0 ? (id.holds ? " · holds" : " · check") : ""}</div></div>
    </div>
    <div class="read" style="margin-top:10px">${escapeHtml(identityLine)}</div>
  </div>
  <div class="card">
    <h2>Settled, most recent first</h2>
    ${leagueCountLine(input.settled, "settled")}
    ${settledRows || '<div class="row"><span>nothing settled yet</span><b>the book is young</b></div>'}
  </div>
  <div class="card">
    <h2>With and without protection</h2>
    ${bridgeLine ? `<div class="read" style="margin:0 0 8px">${escapeHtml(bridgeLine)}</div>` : ""}
    <div class="row"><span>with protection, settled total</span><b>${usd(s.protectedTotalCents)}</b></div>
    <div class="row"><span>without protection, settled total</span><b>${usd(s.nakedTotalCents)}</b></div>
    <div class="row"><span>realized</span><b>${escapeHtml(realizedLine)}</b></div>
    <div class="row"><span>quoted cost of protection</span><b>${escapeHtml(quotedLine)}</b></div>
    ${routeRows}
    ${s.voidCount > 0 ? `<div class="row"><span>voided (no official result)</span><b>${s.voidCount}</b></div>` : ""}
    ${input.hedges ? hedgeLine(input.hedges) : ""}
  </div>
  <div class="card">
    <h2>Where protection is cheap and where it is rich</h2>
    <div class="sub" style="margin-bottom:6px">The same book cut by how it was hedged and by league. EV cost is the quoted cost of protection at the market's own odds; user Δ is realized, protected minus naked, as a share of settled stake. Slices under ${MIN_SLICE_EVENTS} events show counts only.</div>
    <div class="tablewrap"><table>
      <tr><th>slice</th><th>opened</th><th>settled</th><th>EV cost</th><th>user Δ</th><th>credits</th><th>our P&amp;L</th></tr>
      ${routeSeg}${leagueSeg}
    </table></div>
    ${segmentLine ? `<div class="read">${escapeHtml(segmentLine)}</div>` : ""}
  </div>
  <div class="card">
    <h2>Open book</h2>
    ${leagueCountLine(input.open, "open")}
    ${openRows || '<div class="row"><span>no open positions</span><b>next scan fills the board</b></div>'}
    <a class="back" href="${demoUrl()}">back to the demo</a>
  </div>
  <footer>
    <b>Real:</b> live prices, quoted terms, official results. <b>Simulated:</b> the positions; no venue credentials, no wallets. ${escapeHtml(windowLine)} Rendered ${escapeHtml(input.atIso.slice(0, 16).replace("T", " "))} UTC. Demonstration, not an offer. <a class="back" href="/api/shadow">Raw JSON</a> <a class="back" href="/api/shadow/positions.csv">Positions (CSV)</a>
  </footer>
</div>
</body>
</html>`;
}

/** Plain-language names for the fee-rule counterfactuals recorded on each position. */
export const FEE_RULE_TEXT: Record<string, { name: string; rule: string }> = {
  share_only: {
    name: "share only",
    rule: "the published share of gross credit, waived when it rounds to nothing; no minimum",
  },
  min_25bps: {
    name: "share or 0.25% of stake",
    rule: "the published share of gross credit or 0.25% of the stake, whichever is larger; still waived when the share rounds to nothing",
  },
};

export interface ShadowReportInput {
  atIso: string;
  summary: ShadowSummary;
  /** the operator token the page was opened with, carried on its own links */
  token?: string | null;
}

/** One rule's line in a comparison table. `hi` marks the columns a reader compares first. */
function ruleTr(label: string, note: string, r: RuleBook, opts: { base?: boolean } = {}): string {
  const noteHtml = note ? ` <span class="tag">${escapeHtml(note)}</span>` : "";
  const holderBps = r.stakeSettledCents > 0 ? bpsPct((r.holderDeltaCents / r.stakeSettledCents) * 10_000) : "–";
  const writerBps = r.stakeSettledCents > 0 ? bpsPct((r.writerPnlCents / r.stakeSettledCents) * 10_000) : "–";
  return (
    `<tr${opts.base ? ' class="base"' : ""}>` +
    `<td>${escapeHtml(label)}${noteHtml}</td>` +
    `<td>${r.quoted}</td>` +
    `<td>${r.refused}</td>` +
    `<td>${r.settled}</td>` +
    `<td>${escapeHtml(bpsPct(r.quotedAvgEvBps))}</td>` +
    `<td>${usd(r.creditsCents)}</td>` +
    `<td>${usd(r.takeCents)}</td>` +
    `<td class="hi">${signedUsd(r.holderDeltaCents)}<br><i>${escapeHtml(holderBps)}</i></td>` +
    `<td class="hi">${signedUsd(r.writerPnlCents)}<br><i>${escapeHtml(writerBps)}</i></td>` +
    `</tr>`
  );
}

const RULE_HEAD =
  "<tr><th>rule</th><th>quoted</th><th>refused</th><th>settled</th><th>EV cost</th><th>credits</th><th>take</th><th>user Δ</th><th>our P&amp;L</th></tr>";

/**
 * OUR BOOK, LINE BY LINE — the operator's view of the identity: every leg that adds up to our P&L
 * on settled events, split by outcome and by league. Moved here from the public page so the track
 * record reads in one pass; the numbers are the same summary.
 */
function ourBookCard(s: ShadowSummary): string {
  const w = s.writer;
  const id = s.identity;
  const pnlBpsLine = w.settledPnlBpsOfStake === null ? "–" : `${(w.settledPnlBpsOfStake / 100).toFixed(2)}% of settled stake`;
  const evenLine =
    w.settledWhenHolderWon > 0 && w.settledWhenHolderLost > 0
      ? `${signedUsd(w.pnlWhenHolderWonCents)} on ${w.settledWhenHolderWon} user wins · ${signedUsd(w.pnlWhenHolderLostCents)} on ${w.settledWhenHolderLost} user losses`
      : w.settledWhenHolderWon > 0
        ? `${signedUsd(w.pnlWhenHolderWonCents)} on ${w.settledWhenHolderWon} user wins; no losses settled yet`
        : w.settledWhenHolderLost > 0
          ? `${signedUsd(w.pnlWhenHolderLostCents)} on ${w.settledWhenHolderLost} user losses; no wins settled yet`
          : "nothing settled yet";
  const leagueRows = Object.entries(w.byLeague)
    .sort((a, b) => b[1].settled + b[1].open - (a[1].settled + a[1].open))
    .map(
      ([league, r]) =>
        `<div class="row"><span>${escapeHtml(league.toUpperCase())} · ${r.settled} settled, ${r.open} open</span>` +
        `<b>${signedUsd(r.pnlCents)}${r.stakeCents > 0 ? ` <i>${((r.pnlCents / r.stakeCents) * 100).toFixed(2)}% of stake</i>` : ""}</b></div>`,
    )
    .join("");
  return `<div class="card">
    <h2>Our book, line by line</h2>
    <div class="sub" style="margin-bottom:8px">The other side of every settled event: what selling the protection and carrying the hedge netted. Leg for leg, the answer should not depend on who won; the gap on the track record is what is left after these lines.</div>
    <div class="row"><span>realized, settled events</span><b>${signedUsd(w.settledPnlCents)} <i>${escapeHtml(pnlBpsLine)}</i></b></div>
    <div class="row"><span>split by outcome</span><b>${escapeHtml(evenLine)}</b></div>
    <div class="row"><span>published take booked on those events</span><b>${usd(w.takeBookedCents)}</b></div>
    <div class="row"><span>cap slices kept (user won)</span><b>${usd(w.capSlicesKeptCents)}</b></div>
    <div class="row"><span>floors paid (user lost)</span><b>${signedUsd(-w.floorsPaidCents)}</b></div>
    <div class="row"><span>hedge payouts received</span><b>${usd(w.hedgePayoutsCents)}</b></div>
    <div class="row"><span>hedge cost paid</span><b>${signedUsd(-w.hedgeCostCents)}</b></div>
    <div class="row"><span>credits paid to users</span><b>${signedUsd(-w.creditsPaidCents)}</b></div>
    <div class="row"><span>hedge payouts minus hedge cost</span><b>${signedUsd(id.hedgeNetCents)} <i>${id.hedgeNetCents >= 0 ? "the hedge funded itself" : "the hedge fell short"}</i></b></div>
    <div class="row"><span>cap slices kept minus floors and credits paid</span><b>${signedUsd(id.holderLegsNetCents)}</b></div>
    <div class="row"><span>take locked on open positions</span><b>${usd(w.takeLockedOpenCents)} <i>realizes as they settle</i></b></div>
    ${leagueRows}
  </div>`;
}

/**
 * The rule comparison: every proposed pricing rule marked against the same
 * positions, same books, same results as the live book. Read across a row for
 * one rule; read down a column to compare rules. Nothing here was traded.
 */
export function renderShadowReportHtml(input: ShadowReportInput): string {
  const s = input.summary;
  const tq = input.token ? `?token=${encodeURIComponent(input.token)}` : "";
  const cf = s.counterfactuals;
  const period = cf.recordedSince
    ? `${utcDay(cf.recordedSince)} to ${utcDay(input.atIso)} UTC`
    : "not started; the next scan that quotes an event begins it";
  const settledLine =
    cf.baseline.settled === 0
      ? "None of these positions has settled yet, so the user and our-P&L columns are empty; quoted terms, EV cost, credits and take are already comparable."
      : `${cf.baseline.settled} of ${cf.positionsWithCounterfactuals} have settled against official results, so the user and our-P&L columns are realized on those.`;

  const tierRows = [
    ruleTr("live book", "what was quoted", cf.baseline, { base: true }),
    ...PROTECTION_TIERS.map((t: ProtectionTier) => ruleTr(`${t} tier`, "", cf.tiers[t])),
  ].join("");
  const tierRules = PROTECTION_TIERS.map(
    (t) => `<div class="row"><span>${t}</span><b style="font-weight:500;text-align:left">${escapeHtml(TIER_RULES[t])}</b></div>`,
  ).join("");

  const feeLabels = Object.keys(cf.feeRules);
  const feeRows = [
    ruleTr("live book", "what was quoted", cf.baseline, { base: true }),
    ...feeLabels.map((l) => ruleTr(FEE_RULE_TEXT[l]?.name ?? l, "", cf.feeRules[l as keyof typeof cf.feeRules])),
  ].join("");
  const feeRules = feeLabels
    .map(
      (l) =>
        `<div class="row"><span>${escapeHtml(FEE_RULE_TEXT[l]?.name ?? l)}</span><b style="font-weight:500;text-align:left">${escapeHtml(FEE_RULE_TEXT[l]?.rule ?? "")}</b></div>`,
    )
    .join("");
  const shareOnly = cf.feeRules["share_only" as keyof typeof cf.feeRules];
  const minRule = cf.feeRules["min_25bps" as keyof typeof cf.feeRules];
  const feeDeltaLine =
    shareOnly && minRule && shareOnly.quoted > 0
      ? minRule.takeCents - shareOnly.takeCents === 0
        ? "On these positions the minimum never bound: the share was already above 0.25% of stake every time, so both rules book the same take."
        : `The minimum adds ${usd(minRule.takeCents - shareOnly.takeCents)} of take across ${shareOnly.quoted} quotes and takes the same amount out of user credits; the collar itself is unchanged, so floors, caps and hedges match line for line.`
      : "";

  const capRows = cf.capacity
    .map((row) => {
      const fillRate = row.quoted + row.refused > 0 ? `${Math.round((row.quoted / (row.quoted + row.refused)) * 100)}%` : "–";
      return (
        `<tr${row.mult === 1 ? ' class="base"' : ""}>` +
        `<td>${row.mult}× size</td>` +
        `<td>${row.quoted}</td>` +
        `<td>${row.refused}</td>` +
        `<td>${fillRate}</td>` +
        `<td>${usd(row.stakeQuotedCents)}</td>` +
        `<td>${usd(row.grossCreditCents)}</td>` +
        `<td class="hi">${escapeHtml(bpsPct(row.grossBpsOfStake))}</td>` +
        `<td>${usd(row.takeCents)}</td>` +
        `<td>${escapeHtml(bpsPct(row.quotedAvgEvBps))}</td>` +
        `</tr>`
      );
    })
    .join("");
  const one = cf.capacity.find((c) => c.mult === 1);
  const top = cf.capacity[cf.capacity.length - 1];
  const capLine =
    one && top && one.quoted > 0
      ? top.quoted === 0
        ? `At ${top.mult}× the venues' books did not fund a single collar; the depth is not there yet at that size.`
        : `At ${top.mult}× the books still funded ${top.quoted} of ${top.quoted + top.refused} events, and gross credit per dollar staked ${
            (top.grossBpsOfStake ?? 0) >= (one.grossBpsOfStake ?? 0) ? "held" : "fell"
          } from ${bpsPct(one.grossBpsOfStake)} to ${bpsPct(top.grossBpsOfStake)}. That fall is the price of walking the book; an RFQ fill at one price is what removes it.`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:," />
<title>Rule comparison · Track record · Earn &amp; Protect</title>
<meta name="description" content="Every proposed pricing rule marked against the same positions, books and official results as the live shadow book." />
<style>${SHADOW_CSS}</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="wordmark">Earn &amp; Protect <span>· rule comparison</span></div>
</div></div>
<div class="wrap">
  <div class="card">
    <h1>What each rule would have done</h1>
    <div class="sub">The live book quotes one set of terms per event. Since shadow v2, every position also records what the other tiers, the other fee rule, and larger sizes would have written from the same venue books at the same second. When the event settles, every alternative is marked against the same official result. Same events, same books, same outcomes; only the rule differs.</div>
    <div class="bignums">
      <div class="bignum"><div class="n green">${cf.positionsWithCounterfactuals}</div><div class="l">positions compared</div></div>
      <div class="bignum"><div class="n">${cf.baseline.settled}</div><div class="l">of them settled</div></div>
    </div>
    <div class="period">${escapeHtml(period)}</div>
    <div class="read" style="margin-top:10px">${escapeHtml(settledLine)}</div>
  </div>

  ${ourBookCard(s)}

  <div class="card">
    <h2>Protection tiers</h2>
    <div class="sub" style="margin-bottom:6px">Three collars from one book. User Δ is protected minus naked across settled events; our P&amp;L is the other side after the hedge. Percentages are of settled stake.</div>
    <div class="tablewrap"><table>${RULE_HEAD}${tierRows}</table></div>
    <div class="rule">A tier that resolves to the same collar as another is recorded once and not counted as a refusal, so tier rows can total fewer quotes than the live book.</div>
    ${tierRules}
  </div>

  <div class="card">
    <h2>Fee rule</h2>
    <div class="sub" style="margin-bottom:6px">Same collar, different take. The fee rule only moves money between credit and take; floors, caps and hedges are held fixed so the difference is the fee and nothing else.</div>
    <div class="tablewrap"><table>${RULE_HEAD}${feeRows}</table></div>
    ${feeDeltaLine ? `<div class="read">${escapeHtml(feeDeltaLine)}</div>` : ""}
    ${feeRules}
  </div>

  <div class="card">
    <h2>Capacity</h2>
    <div class="sub" style="margin-bottom:6px">The default tier re-quoted at larger sizes from the same books. Gross credit per dollar of stake is the number to watch: if it falls as size rises, the book is being walked.</div>
    <div class="tablewrap"><table>
      <tr><th>size</th><th>quoted</th><th>refused</th><th>fill rate</th><th>stake</th><th>gross credit</th><th>gross / stake</th><th>take</th><th>EV cost</th></tr>
      ${capRows}
    </table></div>
    ${capLine ? `<div class="read">${escapeHtml(capLine)}</div>` : ""}
    <div class="rule">Stake is 100¢ × contracts at that size; 1× is the live position itself. Refused means the venues' books did not fund any collar at that size.</div>
  </div>

  <div class="card">
    <h2>How to read it</h2>
    <div class="read"><b>User Δ</b> is what protection did for the user against holding naked: negative is the usual cost of protection, positive means the floor paid more than the cap gave up. <b>Our P&amp;L</b> is what selling that protection and carrying the hedge netted; leg for leg it should not depend on who won. <b>EV cost</b> is the quoted expected cost of the collar as a share of stake, before anything settles. A rule that lifts our P&amp;L without moving user Δ much is a better rule; one that only shifts money from one column to the other is a fee.</div>
    <a class="back" href="/">Back to the track record</a> <a class="back" href="/api/shadow/report${tq}">Raw JSON</a> <a class="back" href="/api/shadow/positions.csv?scope=full${tq ? `&token=${encodeURIComponent(input.token as string)}` : ""}">Positions with every alternative (CSV)</a> <a class="back" href="/api/shadow/hedges${tq}">Hedge receipts (JSON)</a> <a class="back" href="/api/shadow/export${tq}">Full ledger (JSONL)</a>
  </div>
  <footer>
    Counterfactuals are computed at open from the venue books retained on the position and settled against the same official result as the live book. Nothing in the alternatives was traded. Rendered ${escapeHtml(input.atIso.slice(0, 16).replace("T", " "))} UTC. Demonstration, not an offer.
  </footer>
</div>
</body>
</html>`;
}
