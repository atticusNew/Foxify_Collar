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

import type { LastLegSummary, LockVsSellSummary } from "../src/eventCollar/crossVenue/lastLeg";
import { refusalWords } from "../src/eventCollar/crossVenue/parlayRetail";
import { ruleEvidenceLine, shortHash, summarizeRuleEvidence, type RuleEvidenceSummary } from "../src/eventCollar/crossVenue/ruleEvidence";
import type { RuleBook, ShadowPosition, ShadowSegment, ShadowSummary } from "../src/eventCollar/crossVenue/shadowLedger";
import type { VenueSlate } from "../src/eventCollar/crossVenue/venueSlate";
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
  /** positions the user left before the lock, most recent first */
  closed?: ShadowPosition[];
  /** the hedge trail, when the worker keeps one */
  hedges?: { strategy: HedgeStrategy; rfqVenues: string[]; summary: HedgeReceiptSummary };
  /** the parlay moment (lastLeg.ts); absent on instances with the last-leg shadow off */
  parlays?: ParlayCardInput;
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
.tag.changed{background:#fbf1dc;color:#7a5410}
.rulelink{color:var(--faint);font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;text-decoration:none;border-bottom:1px dotted var(--faint)}
.rulelink:hover{color:var(--dim)}
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

/**
 * The rule the result was judged under, on the row: the pinned hash links to the venue's own
 * text; a second read that differs is said out loud on its own line. Nothing when no rule was pinned.
 */
function ruleMark(p: Pick<ShadowPosition, "rule" | "ruleCheck">): { link: string; changed: boolean } {
  if (!p.rule) return { link: "", changed: false };
  const changed = p.ruleCheck?.unchanged === false;
  const words = p.ruleCheck?.unchanged === true ? "pinned at open, unchanged at settlement" : changed ? "pinned at open; the venue's text changed before settlement" : "pinned at open";
  const link = `<a class="rulelink" href="${escapeHtml(p.rule.sourceUrl)}" rel="noopener" title="sha256 ${escapeHtml(p.rule.sha256)} · ${words}">rule ${escapeHtml(shortHash(p.rule.sha256))}</a>`;
  return { link, changed };
}

export function renderShadowHtml(input: ShadowPageInput): string {
  const s = input.summary;
  const settledRows = interleaveByLeague(input.settled, 25)
    .map((p) => {
      const saved = p.result === "no";
      const tag = saved ? '<span class="tag save">floor paid</span>' : '<span class="tag">won, capped</span>';
      const rule = ruleMark(p);
      // The credit was paid at open and is inside the protected total; say so on every row,
      // or "capped" reads as the whole story.
      return (
        `<div class="row settled"><span>${escapeHtml(p.sideName)} ${tag}</span>` +
        `<b>${usd(p.protectedCents ?? 0)} <i>vs ${usd(p.nakedCents ?? 0)} naked</i>` +
        `<i class="paid">incl. ${usd(p.creditCents)} paid at open${rule.link ? ` · ${rule.link}` : ""}</i>` +
        // on its own line: beside the hash it pushes the row past the card on a phone
        `${rule.changed ? '<i class="paid"><span class="tag changed">rule text changed before settlement</span></i>' : ""}</b></div>`
      );
    })
    .join("");
  const ruleLine = ruleEvidenceLine(summarizeRuleEvidence(input.settled.map((p) => ({ id: p.ticker, rule: p.rule, check: p.ruleCheck }))), "position");
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
  const kindSeg = segmentRows(s.segments.byKind ?? {}, (k) => (k === "sports" ? "sports, all leagues" : k));
  // Sports first: the product lives on game positions; crypto strikes are the always-on filler that
  // keeps the record moving overnight. The card reads the sports slice on its own so a sports venue
  // sees its numbers without the crypto weighting.
  const sp = s.segments.byKind?.sports;
  const sportsLeagues = Object.keys(s.segments.byLeague)
    .filter((k) => k !== "crypto")
    .map((k) => k.toUpperCase())
    .sort();
  const sportsCard = (() => {
    if (!sp || sp.opened === 0) return "";
    const leagues = sportsLeagues.length > 0 ? sportsLeagues.join(" and ") : "sports";
    const evCell = sp.opened >= MIN_SLICE_EVENTS ? bpsPct(sp.quotedAvgEvBps) : "too few";
    const dCell = sp.settled >= MIN_SLICE_EVENTS && sp.holderDeltaBpsOfStake !== null ? bpsPct(sp.holderDeltaBpsOfStake) : "too few";
    const pnlLine =
      sp.settled > 0
        ? `On the ${sp.settled} settled, our P&L is ${signedUsd(sp.writerPnlCents)} against ${usd(sp.takeCents)} of take booked; users were paid ${usd(sp.creditsCents)} in credits at the tap.`
        : "Nothing has settled yet.";
    const sportsClosed = s.closed?.byKind?.sports?.closed ?? 0;
    const closedLine = sportsClosed > 0 ? ` ${sportsClosed} left before the game at live prices; see the early closes below.` : "";
    return `  <div class="card">
    <h2>Sports first</h2>
    <div class="sub" style="margin-bottom:8px">The product lives on game positions: ${escapeHtml(leagues)} here. Crypto strikes keep the record moving overnight and are shown separately below.</div>
    <div class="bignums">
      <div class="bignum"><div class="n green">${sp.settled}</div><div class="l">games settled</div></div>
      <div class="bignum"><div class="n">${sp.opened - sp.settled}</div><div class="l">open now</div></div>
      <div class="bignum"><div class="n">${escapeHtml(evCell)}</div><div class="l">quoted cost, of expected value</div></div>
      <div class="bignum"><div class="n">${escapeHtml(dCell)}</div><div class="l">realized, protected minus naked</div></div>
    </div>
    <div class="read" style="margin-top:10px">${escapeHtml(pnlLine + closedLine)}</div>
  </div>
`;
  })();
  // EARLY CLOSES: the other half of "terms lock at your tap". Leaving is a new trade at the live
  // books; the card shows what that paid against holding unprotected, what crossing the books
  // cost against the mid, and that our result on the way out is still the take.
  const closedCard = (() => {
    const c = s.closed;
    if (!c || (c.count === 0 && c.unpriced === 0)) return "";
    const rows = interleaveByLeague(input.closed ?? [], 10)
      .map((p) => {
        const mid = typeof p.closeYesMidCents === "number" ? `at ${p.closeYesMidCents}¢ mid` : "no live mid";
        return (
          `<div class="row settled"><span>${escapeHtml(p.sideName)} <span class="tag">left early</span></span>` +
          `<b>${usd(p.protectedCents ?? 0)} <i>vs ${usd(p.nakedCents ?? 0)} unprotected</i>` +
          `<i class="paid">${escapeHtml(mid)}, ${escapeHtml(shortEt(p.closedAt ?? ""))}</i></b></div>`
        );
      })
      .join("");
    const frictionPct = c.stakeCents > 0 && c.withMid > 0 ? ` (${((100 * c.unwindFrictionCents) / c.stakeCents).toFixed(2)}% of stake)` : "";
    const readLine =
      c.count === 0
        ? `${c.unpriced} scheduled exit${c.unpriced === 1 ? "" : "s"} found no depth on a leg and ran to settlement instead; nothing has closed early yet.`
        : `${c.count} position${c.count === 1 ? "" : "s"} left before the lock. Each exit was a new trade at the live books that second: the user's contracts sold into the bids, our other side sold into its bids, and the protection settled at what both fetched. ` +
          `They walked away with ${usd(c.protectedAtCloseCents)} against ${usd(c.nakedAtCloseCents)} had they never protected (${signedUsd(c.deltaCents)}). ` +
          (c.withMid > 0 ? `Crossing both books cost ${signedUsd(c.unwindFrictionCents)} against the mid${frictionPct}. ` : "") +
          `Our result on the way out is the take booked, ${usd(c.takeBookedCents)}: the user pays live prices on both legs, so we carry no price risk on the exit either.` +
          (c.unpriced > 0 ? ` ${c.unpriced} other scheduled exit${c.unpriced === 1 ? "" : "s"} found no depth on a leg and ran to settlement instead.` : "");
    return `  <div class="card">
    <h2>Closed early at live prices</h2>
    <div class="bignums">
      <div class="bignum"><div class="n green">${c.count}</div><div class="l">left before the lock</div></div>
      <div class="bignum"><div class="n ${c.deltaCents >= 0 ? "green" : ""}">${signedUsd(c.deltaCents)}</div><div class="l">protected minus unprotected, at the close</div></div>
      <div class="bignum"><div class="n">${c.withMid > 0 ? signedUsd(-c.unwindFrictionCents) : "–"}</div><div class="l">crossing the books, against the mid</div></div>
      <div class="bignum"><div class="n">${c.unpriced}</div><div class="l">exits with a leg unpriced</div></div>
    </div>
    <div class="read" style="margin-top:10px">${escapeHtml(readLine)}</div>
    ${rows ? `<div style="margin-top:8px">${rows}</div>` : ""}
  </div>
`;
  })();
  const richest = Object.entries(s.segments.byLeague)
    .filter(([, r]) => r.quotedAvgEvBps !== null && r.opened >= MIN_SLICE_EVENTS)
    .sort((a, b) => (b[1].quotedAvgEvBps ?? 0) - (a[1].quotedAvgEvBps ?? 0));
  const segmentLine =
    richest.length >= 2
      ? `Protection is cheapest on ${richest[richest.length - 1][0].toUpperCase()} (${bpsPct(richest[richest.length - 1][1].quotedAvgEvBps)} of expected value quoted) and richest on ${richest[0][0].toUpperCase()} (${bpsPct(richest[0][1].quotedAvgEvBps)}); the record-wide average is weighted by how many of each the scanner found, not by what a user would choose.`
      : "";
  const windowLine = s.firstOpenedAt
    ? `Recording since ${escapeHtml(s.firstOpenedAt.slice(0, 16).replace("T", " "))} UTC. Append-only; positions are never edited, only opened, closed early at live prices, and settled.`
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
${sportsCard}  <div class="card">
    <h2>Settled, most recent first</h2>
    ${leagueCountLine(input.settled, "settled")}
    ${settledRows || '<div class="row"><span>nothing settled yet</span><b>the book is young</b></div>'}
    ${ruleLine ? `<div class="read" style="margin-top:8px">${escapeHtml(ruleLine)} Each hash links to the venue's published text.</div>` : ""}
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
${closedCard}${input.parlays ? parlayMomentCard(input.parlays) : ""}  <div class="card">
    <h2>Where protection is cheap and where it is rich</h2>
    <div class="sub" style="margin-bottom:6px">The same book cut by how it was hedged and by league. EV cost is the quoted cost of protection at the market's own odds; user Δ is realized, protected minus naked, as a share of settled stake. Slices under ${MIN_SLICE_EVENTS} events show counts only.</div>
    <div class="tablewrap"><table>
      <tr><th>slice</th><th>opened</th><th>settled</th><th>EV cost</th><th>user Δ</th><th>credits</th><th>our P&amp;L</th></tr>
      ${kindSeg}${routeSeg}${leagueSeg}
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
    <b>Real:</b> live prices, quoted terms, official results. <b>Simulated:</b> the positions${input.parlays ? " and the parlay tickets" : ""}; no venue credentials, no wallets. ${escapeHtml(windowLine)} Rendered ${escapeHtml(input.atIso.slice(0, 16).replace("T", " "))} UTC. Demonstration, not an offer. <a class="back" href="/api/shadow">Raw JSON</a> <a class="back" href="/api/shadow/positions.csv">Positions (CSV)</a>${input.parlays ? ' <a class="back" href="/api/shadow/parlays">Parlays (JSON)</a>' : ""}
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
  /** the last-leg shadow (lastLeg.ts); absent on reports rendered before it existed */
  lastLeg?: { summary: LastLegSummary; enabled: boolean; stakeCents: number };
}

const pct1 = (x: number | null): string => (x === null ? "–" : `${x.toFixed(1)}%`);
const n1 = (x: number | null, unit = ""): string => (x === null ? "–" : `${x.toFixed(1)}${unit}`);

/**
 * LAST LEG — the parlay question, answered with numbers rather than instinct. Tickets are built
 * from the public combo-leg catalog (Polymarket publishes no list of real tickets), tracked leg by
 * leg, and quoted at the moment every leg but the last has hit. Everything about the prices and
 * results is real; the tickets are the only simulation, and the card says so.
 */
export function lastLegCard(input: NonNullable<ShadowReportInput["lastLeg"]>, token: string): string {
  const s = input.summary;
  if (!input.enabled) {
    return `<div class="card"><h2>Last leg</h2><div class="sub">The last-leg shadow is off on this instance (EVENT_LASTLEG_ENABLED=0).</div></div>`;
  }
  const decided = s.reachedLastLeg + s.busted;
  const reachLine =
    decided === 0
      ? "No ticket has been decided yet; the first slate with a late game will begin it."
      : `${s.reachedLastLeg} of ${decided} decided tickets reached the last leg with every other leg hit (${pct1(s.reachedPctOfDecided)}); ${s.busted} busted earlier.`;
  const attempted = s.quoted + s.refusedOnly;
  const quoteLine =
    s.reachedLastLeg === 0
      ? ""
      : attempted === 0
        ? s.windowMissed > 0
          ? `${s.windowMissed} reached the moment but the other legs' results landed too late to quote before the last game; the gap rule needs more room.`
          : "Tickets at the last leg are waiting for their window."
        : `At the moment, the venues funded a credit on ${s.quoted} of ${attempted} tickets quoted${s.windowMissed > 0 ? `; ${s.windowMissed} more reached it too late to quote` : ""}.`;
  const termsLine =
    s.quoted === 0
      ? ""
      : `On the quoted tickets the bettor kept ${pct1(s.avgFloorPctOfMark)} of the ticket's value on a miss (the floor), gave up everything above ${pct1(s.avgCapPctOfMark)} on a hit (the cap), and was paid ${usd(Math.round(s.avgCreditCents ?? 0))} up front on average (${n1(s.avgCreditBpsOfValue === null ? null : s.avgCreditBpsOfValue / 100, "%")} of the ticket's value), ${n1(s.avgMinutesToStartAtQuote === null ? null : s.avgMinutesToStartAtQuote / 60, "h")} before the last game. Quoted EV cost ${bpsPct(s.avgEvCostBps)} of the position.`;
  const st = s.settled;
  const settledLine =
    st.withProtection === 0
      ? "No protected ticket has settled yet."
      : `${st.withProtection} protected tickets settled: ${st.floorSaves} missed the last leg and the floor paid, ${st.capGiveups} hit it and gave up the cap${st.scalar ? `, ${st.scalar} settled partially` : ""}. Protected ${usd(st.protectedCents)} against ${usd(st.nakedCents)} naked (${signedUsd(st.deltaCents)}). Our side netted ${signedUsd(st.writerCents)} against ${usd(st.takeBookedCents)} of take booked: ${st.identityHolds ? "the identity holds" : "GAP, investigate"}.`;
  const refusals = Object.entries(s.refusalCodes)
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `<div class="row"><span>${escapeHtml(code)}</span><b>${n}</b></div>`)
    .join("");
  const sizeRows = s.bySize
    .map(
      (r) =>
        `<tr><td>${r.size} legs</td><td>${r.built}</td><td>${r.busted}</td><td>${r.reachedLastLeg}</td><td class="hi">${r.quoted}</td><td>${r.refusedOnly}</td><td>${r.settled}</td><td>${r.quoted ? `${usd(r.protectedCents)} / ${usd(r.nakedCents)}` : "–"}</td></tr>`,
    )
    .join("");
  const period = s.firstTicketAt ? `since ${utcDay(s.firstTicketAt)} UTC` : "not started";
  return `<div class="card">
    <h2>Last leg</h2>
    <div class="sub" style="margin-bottom:8px">Does "lock in your parlay before the last leg" fund a credit? Tickets of ${escapeHtml(s.bySize.map((r) => r.size).join(", ") || "2 to 5")} favourites at a $${(input.stakeCents / 100).toFixed(0)} stake are built from Polymarket's public combo-leg catalog the way a bettor builds them, tracked leg by leg, and when every leg but the last has hit the compressed position is quoted with the live book's collar on the last leg's own book. Prices, results and quotes are real; the tickets are simulated, because the venue publishes no list of real ones.</div>
    <div class="bignums">
      <div class="bignum"><div class="n">${s.tickets}</div><div class="l">tickets built</div></div>
      <div class="bignum"><div class="n">${s.reachedLastLeg}</div><div class="l">reached the last leg</div></div>
      <div class="bignum"><div class="n green">${s.quoted}</div><div class="l">funded a credit</div></div>
      <div class="bignum"><div class="n">${s.refusedOnly}</div><div class="l">refused every time</div></div>
    </div>
    <div class="period">${escapeHtml(period)} · ${s.open} in play · ${s.voided} voided</div>
    <div class="read" style="margin-top:10px">${escapeHtml(reachLine)}${quoteLine ? ` ${escapeHtml(quoteLine)}` : ""}</div>
    ${termsLine ? `<div class="read">${escapeHtml(termsLine)}</div>` : ""}
    <div class="read">${escapeHtml(settledLine)}</div>
    <div class="tablewrap" style="margin-top:8px"><table>
      <tr><th>ticket</th><th>built</th><th>busted</th><th>reached</th><th>quoted</th><th>refused</th><th>settled</th><th>protected / naked</th></tr>
      ${sizeRows || `<tr><td colspan="8">no tickets yet</td></tr>`}
    </table></div>
    ${refusals ? `<div class="rule">Refusals by reason across ${s.attempts} attempts:</div>${refusals}` : ""}
    <div class="rule">Busted means a leg other than the last lost, so no moment existed. Refused means the moment came and the last leg's book did not fund a positive credit at any floor/cap, or the mark sat outside the quotable band. Ticket value at the moment is contracts × the last leg's mark: what a cash-out at fair would pay.</div>
    <a class="back" href="/api/shadow/lastleg${token}">Tickets (JSON)</a> <a class="back" href="/api/shadow/lastleg.csv${token}">Tickets (CSV)</a>
  </div>`;
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

  ${input.lastLeg ? lastLegCard(input.lastLeg, tq) : ""}

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

// ── the parlay moment ─────────────────────────────────────────────────────────

export interface ParlayCardInput {
  lockVsSell: LockVsSellSummary;
  lastLeg: LastLegSummary;
  stakeCents: number;
  /** the legs' pinned rules and second reads (lastLeg.summarizeLegRules); absent on instances before 2026-10-11 */
  rules?: RuleEvidenceSummary;
}

/**
 * LOCK, SELL OR HOLD — the parlay moment on a public page (the record and every venue slate).
 * A bettor whose ticket has every pick in but the last has three choices; the card puts them
 * side by side, with the refusals counted and the identity checked, in the same words the
 * demo's Parlays tab uses. Tickets are the only simulation and the card says so.
 */
export function parlayMomentCard(input: ParlayCardInput): string {
  const lv = input.lockVsSell;
  const ll = input.lastLeg;
  const lvRows = lv.rows
    .slice(0, 12)
    .map((r) => {
      const when = `${Math.round(r.minutesToStart / 60)}h before`;
      const settled = r.lockPaidCents !== undefined && r.holdPaidCents !== undefined;
      const paid = settled
        ? `<td class="hi">${usd(r.lockPaidCents as number)}</td><td>${usd(r.sellCents)}</td><td>${usd(r.holdPaidCents as number)}</td>`
        : `<td colspan="3"><i style="font-style:normal;color:var(--faint)">${r.status === "last_leg" ? "last leg not played yet" : r.status}</i></td>`;
      return (
        `<tr><td class="hi">${r.size} legs · ${escapeHtml(r.lastLeg)}</td><td>${escapeHtml(when)}</td>` +
        `<td>${usd(r.sellCents)}</td><td>${usd(r.lockFloorCents)} to ${usd(r.lockCapCents)}</td><td class="hi">${usd(r.creditCents)}</td>${paid}</tr>`
      );
    })
    .join("");
  const lvLine = (() => {
    if (ll.tickets === 0) return "The parlay shadow has just started; tickets are being built from this week's slate.";
    if (lv.quoted === 0) {
      const reached = ll.reachedLastLeg > 0 ? `${ll.reachedLastLeg} reached the last leg and the books did not fund a credit yet.` : "None has reached the last leg yet; the first moments come when every earlier leg has hit and only the last game is left.";
      return `${ll.tickets} tickets built, ${ll.busted} busted on an earlier leg. ${reached}`;
    }
    const avgCredit = lv.quoted > 0 ? usd(Math.round(lv.creditsCents / lv.quoted)) : "–";
    const avgSell = lv.quoted > 0 ? usd(Math.round(lv.sellCents / lv.quoted)) : "–";
    const settledPart =
      lv.settled > 0
        ? ` On the ${lv.settled} settled, locking paid ${usd(lv.settledLockCents)} against ${usd(lv.settledSellCents)} for selling and ${usd(lv.settledHoldCents)} for holding; the lock beat the sell on ${lv.lockBeatSell}, and holding beat both on ${lv.holdBeatBoth}.`
        : "";
    return `${lv.quoted} tickets reached the last leg with a priced lock, on average ${avgCredit} paid at the tap on a ticket worth ${avgSell} at fair.${settledPart}`;
  })();
  // Refusals in the bettor's words: the moment came and the lock was not offered, counted not hidden.
  const refusalCounts = new Map<string, number>();
  for (const [code, n] of Object.entries(ll.refusalCodes)) {
    const words = refusalWords(code);
    refusalCounts.set(words, (refusalCounts.get(words) ?? 0) + n);
  }
  const refusalRows = [...refusalCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([words, n]) => `<div class="row"><span>${escapeHtml(words)}</span><b>${n}</b></div>`)
    .join("");
  const st = ll.settled;
  const identityLine =
    st.withProtection === 0
      ? "No locked ticket has settled yet; the identity is checked on every settlement."
      : `On ${st.withProtection} settled locked tickets our P&L is ${signedUsd(st.writerCents)} against ${usd(st.takeBookedCents)} of take booked: ${st.identityHolds ? "the identity holds, we carried no outcome risk on the last pick." : "a gap outside rounding; the operator report has the tickets."}`;
  return `  <div class="card">
    <h2>Lock, sell or hold: the parlay moment</h2>
    <div class="sub" style="margin-bottom:8px">A bettor whose parlay has every leg in but the last has three choices. Sell is a cash-out at fair (the ticket's value before any spread). Lock is the collar on the last leg: a floor, a cap, and a credit paid at the tap, hedged on the last leg's own book. Hold is the naked ticket. Tickets here are simulated from the public slate (2 to 5 favourites, $${(input.stakeCents / 100).toFixed(0)} stake); prices, results and quotes are real.</div>
    <div class="bignums">
      <div class="bignum"><div class="n">${ll.tickets}</div><div class="l">tickets built</div></div>
      <div class="bignum"><div class="n">${ll.reachedLastLeg}</div><div class="l">reached the last leg</div></div>
      <div class="bignum"><div class="n green">${lv.quoted}</div><div class="l">priced a lock</div></div>
      <div class="bignum"><div class="n green">${usd(lv.creditsCents)}</div><div class="l">paid at the tap</div></div>
    </div>
    <div class="read" style="margin-top:10px">${escapeHtml(lvLine)}</div>
    ${
      lvRows
        ? `<div class="tablewrap" style="margin-top:8px"><table>
      <tr><th>ticket · last leg</th><th>when</th><th>sell at fair</th><th>lock ends</th><th>paid now</th><th>lock paid</th><th>sell paid</th><th>hold paid</th></tr>
      ${lvRows}
    </table></div>`
        : ""
    }
    <div class="rule">Lock ends shows the two endings with the credit included. Paid columns fill when the last game settles. A ticket with two or more legs still open is never quoted: that would mean hedging the product of two games, and no book quotes it. Nothing is bought; the lock is priced from the live book the hedge would have been bought on.</div>
    ${refusalRows ? `<div class="rule" style="margin-top:8px">Lock not offered, and why, across ${ll.attempts} attempts:</div>${refusalRows}` : ""}
    <div class="read" style="margin-top:8px">${escapeHtml(identityLine)}</div>
    ${input.rules && input.rules.pinned > 0 ? `<div class="read" style="margin-top:6px">${escapeHtml(ruleEvidenceLine(input.rules, "leg"))} The full pins are in the parlays JSON.</div>` : ""}
  </div>
`;
}

// ── venue slate ───────────────────────────────────────────────────────────────

export interface SlatePageInput {
  atIso: string;
  slate: VenueSlate;
  /** leagues on the record that are on this slate, most settled first */
  leaguesOnRecord: string[];
  /** the record cut to the slate */
  summary: ShadowSummary;
  settled: ShadowPosition[];
  open: ShadowPosition[];
  /** the parlay moment: lock, sell or hold, side by side */
  lockVsSell: LockVsSellSummary;
  lastLeg: LastLegSummary;
  lastLegStakeCents: number;
  /** where the hedges are bought today, by name, in the order they are tried */
  hedgeVenues: string[];
  /** the interactive demo in the venue's brand */
  demoUrl: string;
  /** the slate's CSV, keyed */
  csvHref: string;
  /** the public record */
  recordUrl: string;
}

const joinWords = (xs: readonly string[]): string =>
  xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/**
 * VENUE SLATE PAGE: "what one Protect button would have done on your games". The public record's
 * numbers, cut to the venue's leagues, with the venue's name on it and the parlay moment as a lock
 * versus sell table. Reached only by a share key, so the name appears only where the operator sent
 * it. Same visual language as the record; server-rendered, no client JS.
 */
export function renderSlateHtml(input: SlatePageInput): string {
  const s = input.summary;
  const v = input.slate;
  const name = escapeHtml(v.name);
  const leagues = input.leaguesOnRecord.map((l) => l.toUpperCase());
  const leagueWords = leagues.length ? joinWords(leagues) : "the leagues you list";
  const hedgeWords = joinWords(input.hedgeVenues);
  const id = s.identity;
  const w = s.writer;
  const stakeSettled = s.protectedTotalCents + s.nakedTotalCents > 0 ? s.nakedTotalCents : 0;
  const creditsSettled = Object.values(s.segments.byLeague).reduce((a, r) => a + r.creditsCents, 0);
  const periodLine =
    s.firstOpenedAt && s.lastSettledAt
      ? `${utcDay(s.firstOpenedAt)} to ${utcDay(s.lastSettledAt)} UTC, first position opened to last settlement`
      : s.firstOpenedAt
        ? `since ${utcDay(s.firstOpenedAt)} UTC; nothing settled yet`
        : "no positions on these leagues yet";
  const quotedLine =
    s.quotedAvgEvBps === null
      ? "not yet recorded"
      : s.quotedAvgEvBps < 0
        ? `${Math.abs(s.quotedAvgEvBps / 100).toFixed(2)}% better than holding, on average`
        : `${(s.quotedAvgEvBps / 100).toFixed(2)}% of expected value, on average`;
  const realizedLine =
    s.settledCount === 0
      ? "nothing settled yet"
      : s.deltaTotalCents >= 0
        ? `protected users came out ${usd(s.deltaTotalCents)} ahead of holding`
        : `protection cost users ${usd(-s.deltaTotalCents)} across settled games (${stakeSettled > 0 ? ((100 * -s.deltaTotalCents) / stakeSettled).toFixed(2) : "–"}% of what the same positions paid unprotected); the floor is what it bought`;
  const saveLine =
    s.settledCount === 0
      ? "The first games on these leagues settle this week."
      : `Protection paid the floor on ${s.floorSaves} of ${s.settledCount} settled games (${Math.round((100 * s.floorSaves) / s.settledCount)}%). Those are the users who would otherwise have walked away with nothing.`;
  const identityLine =
    id.settled === 0
      ? "Nothing has settled on these leagues yet, so there is nothing to reconcile."
      : `On ${id.settled} settled games our P&L is ${signedUsd(id.writerPnlCents)} and the take booked is ${usd(id.takeBookedCents)}: a gap of ${signedUsd(id.gapCents)}. ${id.holds ? "We carried no outcome risk on your games." : "The gap is outside tolerance; see the record."}`;

  const fewCell = '<td><i style="font-style:normal;color:var(--faint)">too few</i></td>';
  const leagueRows = input.leaguesOnRecord
    .map((k) => {
      const r = s.segments.byLeague[k];
      if (!r) return "";
      const ev = r.opened >= MIN_SLICE_EVENTS ? `<td>${bpsPct(r.quotedAvgEvBps)}</td>` : fewCell;
      const d = r.settled >= MIN_SLICE_EVENTS && r.holderDeltaBpsOfStake !== null ? `<td>${bpsPct(r.holderDeltaBpsOfStake)}</td>` : fewCell;
      return `<tr><td class="hi">${escapeHtml(k.toUpperCase())}</td><td>${r.opened}</td><td>${r.settled}</td>${ev}${d}<td>${usd(r.creditsCents)}</td><td>${signedUsd(r.writerPnlCents)}</td></tr>`;
    })
    .join("");

  const settledRows = interleaveByLeague(input.settled, 12)
    .map((p) => {
      const saved = p.result === "no";
      const tag = saved ? '<span class="tag save">floor paid</span>' : '<span class="tag">won, capped</span>';
      return (
        `<div class="row settled"><span>${escapeHtml(p.sideName)} <span class="tag">${escapeHtml(p.league.toUpperCase())}</span> ${tag}</span>` +
        `<b>${usd(p.protectedCents ?? 0)} <i>vs ${usd(p.nakedCents ?? 0)} naked</i><i class="paid">incl. ${usd(p.creditCents)} paid at the tap</i></b></div>`
      );
    })
    .join("");
  const openRows = interleaveByLeague(input.open, 8)
    .map(
      (p) =>
        `<div class="row open"><span>${escapeHtml(p.sideName)} <span class="tag">${escapeHtml(p.league.toUpperCase())}</span> · locks ${escapeHtml(shortEt(p.eventTimeIso))}</span>` +
        `<b>floor ${usd(p.floorCents * p.contracts + p.creditCents)} · up to ${usd(p.capCents * p.contracts + p.creditCents)}</b></div>`,
    )
    .join("");

  const parlayCard = parlayMomentCard({ lockVsSell: input.lockVsSell, lastLeg: input.lastLeg, stakeCents: input.lastLegStakeCents });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<link rel="icon" href="data:," />
<title>Protection on the ${name} slate · Earn &amp; Protect</title>
<style>${SHADOW_CSS}</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="wordmark">Earn &amp; Protect <span>· prepared for ${name}</span></div>
</div></div>
<div class="wrap">
  <div class="card">
    <h1>Protection on the ${name} slate</h1>
    <div class="sub">What one Protect button would have done on ${escapeHtml(leagueWords)} games: every quotable game protected at its live quoted terms, then marked against the official result. Hedged leg for leg on ${escapeHtml(hedgeWords)}. Live prices; nothing was bought.</div>
    <div class="bignums">
      <div class="bignum"><div class="n green">${s.settledCount}</div><div class="l">games settled</div></div>
      <div class="bignum"><div class="n">${s.floorSaves}</div><div class="l">floor saves</div></div>
      <div class="bignum"><div class="n green">${usd(creditsSettled)}</div><div class="l">paid to users at the tap</div></div>
      <div class="bignum"><div class="n ${id.holds ? "green" : ""}">${signedUsd(w.settledPnlCents)}</div><div class="l">our P&amp;L = take booked</div></div>
    </div>
    <div class="period">${escapeHtml(periodLine)} · ${s.openCount} open now</div>
    <div class="read" style="margin-top:10px">${escapeHtml(saveLine)}</div>
  </div>
  <div class="card">
    <h2>What it costs, what it saves</h2>
    <div class="row"><span>quoted cost of protection</span><b>${escapeHtml(quotedLine)}</b></div>
    <div class="row"><span>realized</span><b>${escapeHtml(realizedLine)}</b></div>
    <div class="row"><span>with protection, settled total</span><b>${usd(s.protectedTotalCents)}</b></div>
    <div class="row"><span>without protection, settled total</span><b>${usd(s.nakedTotalCents)}</b></div>
    <div class="tablewrap" style="margin-top:8px"><table>
      <tr><th>league</th><th>opened</th><th>settled</th><th>EV cost</th><th>user Δ</th><th>credits</th><th>our P&amp;L</th></tr>
      ${leagueRows || '<tr><td colspan="7">no games on these leagues yet</td></tr>'}
    </table></div>
    <div class="rule">EV cost is the quoted cost of protection at the market's own odds; user Δ is realized, protected minus naked, as a share of settled stake. Slices under ${MIN_SLICE_EVENTS} games show counts only.</div>
  </div>
  <div class="card">
    <h2>We carry no outcome risk on your games</h2>
    <div class="sub" style="margin-bottom:8px">Leg for leg, what we earn on a settled game must equal the published take: the hedge pays the floor, the cap slice pays the hedge, and nothing depends on who won. Your ledger pays the user; the hedge pays your ledger.</div>
    <div class="bignums">
      <div class="bignum"><div class="n ${id.holds ? "green" : ""}">${signedUsd(id.writerPnlCents)}</div><div class="l">our P&amp;L, settled</div></div>
      <div class="bignum"><div class="n">${usd(id.takeBookedCents)}</div><div class="l">take booked</div></div>
      <div class="bignum"><div class="n ${id.holds ? "green" : ""}">${signedUsd(id.gapCents)}</div><div class="l">gap${id.settled > 0 ? (id.holds ? " · holds" : " · check") : ""}</div></div>
    </div>
    <div class="read" style="margin-top:10px">${escapeHtml(identityLine)}</div>
  </div>
${parlayCard}  <div class="card">
    <h2>Settled on your leagues, most recent first</h2>
    ${settledRows || '<div class="row"><span>nothing settled yet</span><b>the book is young</b></div>'}
  </div>
  <div class="card">
    <h2>Open now</h2>
    ${openRows || '<div class="row"><span>no open positions on these leagues</span><b>next scan fills the board</b></div>'}
  </div>
  <div class="card">
    <h2>See it in your app</h2>
    <div class="read">The same engine, inside a positions list in your colours: tap Protect on any row, see the floor, the cap and the credit priced live, accept, and watch the row reshape. One JSON quote in, one receipt out; your brand, your ledger, your official result.</div>
    <a class="back" href="${escapeHtml(input.demoUrl)}">Open the ${name} demo</a> <a class="back" href="${escapeHtml(input.recordUrl)}">Full public record</a> <a class="back" href="${escapeHtml(input.csvHref)}">Your slate (CSV)</a>
  </div>
  <footer>
    <b>Real:</b> live prices, quoted terms, hedge books, official results. <b>Simulated:</b> the positions and the parlay tickets; no venue credentials, nothing bought. The terms shown are the terms we would have had to hedge at that second. Rendered ${escapeHtml(input.atIso.slice(0, 16).replace("T", " "))} UTC. Prepared for ${name}; demonstration, not an offer.
  </footer>
</div>
</body>
</html>`;
}
