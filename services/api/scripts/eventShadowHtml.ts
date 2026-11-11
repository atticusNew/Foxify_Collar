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
import { ruleDiff, ruleEvidenceLine, ruleStateLabel, shortHash, summarizeRuleEvidence, type RuleEvidenceSummary } from "../src/eventCollar/crossVenue/ruleEvidence";

/** The footer's three sentences, printed only when something on the page carries a pinned rule. */
export const RULE_CHECK_NOTE =
  "when a position opens we keep the venue's own rule text for that market and its fingerprint (sha256). When it settles we read the venue's text again and compare. " +
  "\u201cTerms held\u201d means the same words both times; \u201cvenue edited its rules\u201d means the venue changed the wording while the position was open, and the row opens to show the edit. " +
  "Payouts follow the venue's official result either way.";
import type { CashLegDue, RuleBook, ShadowPosition, ShadowSegment, ShadowSummary } from "../src/eventCollar/crossVenue/shadowLedger";
import type { RefusalSummary } from "../src/eventCollar/crossVenue/shadowRefusals";
import type { NettingReport } from "../src/eventCollar/crossVenue/shadowNetting";
import type { VenueSlate } from "../src/eventCollar/crossVenue/venueSlate";
import type { HedgeReceiptSummary, HedgeStrategy } from "../src/eventCollar/crossVenue/hedgeExecutor";
import type { PublicRealSummary } from "../src/eventCollar/crossVenue/realizedBook";
import { PROTECTION_TIERS, type ProtectionTier } from "../src/eventCollar/crossVenue/types";
import { TIER_RULES } from "../src/eventCollar/crossVenue/collarSearch";
import { REFERENCE_BOOK_WORDS } from "../src/eventCollar/crossVenue/venueBooks";
import type { HeldBooksStatus } from "../src/eventCollar/crossVenue/aggregatorHeldBooks";
import type { VenueBookOpen, VenueBreakdown, VenueCell, VenueInGame, VenuePrelock } from "../src/eventCollar/crossVenue/shadowVenues";
import type { AggregatorBookStatus } from "../src/eventCollar/crossVenue/aggregatorBooks";
import { mismatchWords, type LedgerFingerprintStatus } from "../src/eventCollar/crossVenue/ledgerFingerprint";
import { REFERENCE_PRINT_WORDS } from "../src/eventCollar/crossVenue/venuePrints";
import type { PilotReport } from "../src/eventCollar/crossVenue/pilotCheck";
import type { CapitalModel, CapitalShape } from "../src/eventCollar/crossVenue/capitalModel";

/** Public URL of the interactive demo, for the cross-link. */
function demoUrl(): string {
  return process.env.EVENT_SHADOW_DEMO_URL || "https://event.earnandprotect.xyz/";
}

export function escapeHtml(s: string): string {
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
  /** how often the engine priced an event and declined, and why (shadowRefusals.ts); absent on instances before refusals were kept */
  refusals?: RefusalSummary;
  /** our own real fills (realizedBook.publicRealSummary); absent or null while there is none, and the page then says nothing about them */
  real?: PublicRealSummary | null;
  /** the ledger's daily fingerprints (ledgerFingerprint.ts); absent or null where they are switched off */
  fingerprints?: LedgerFingerprintStatus | null;
}

/**
 * The real fills, beside the simulated run and labelled apart from it. Counts and cash only: no
 * venue is named here, and our result is shown only when every figure in it is on the record.
 */
function realFillsCard(r: PublicRealSummary): string {
  const plural = (n: number, one: string, many: string): string => `${intStr(n)} ${n === 1 ? one : many}`;
  const result =
    r.realizedCents === null
      ? `<div class="bignum"><div class="n">not yet</div><div class="l">our result</div></div>`
      : `<div class="bignum"><div class="n ${r.realizedCents >= 0 ? "green" : ""}">${signedUsd(r.realizedCents)}</div><div class="l">our result, ended locks</div></div>`;
  const rows = [
    `<div class="row"><span>real orders filled</span><b>${intStr(r.realFills)}</b></div>`,
    `<div class="row"><span>real locks open now</span><b>${intStr(r.open)}</b></div>`,
    r.leftEarly > 0 ? `<div class="row"><span>left early, hedge sold</span><b>${intStr(r.leftEarly)}</b></div>` : "",
    r.unresolved > 0 ? `<div class="row"><span>ended and not yet valued</span><b>${intStr(r.unresolved)}</b></div>` : "",
    r.receivedFromSalesCents > 0 ? `<div class="row"><span>received from real sales</span><b>${usd(r.receivedFromSalesCents)}</b></div>` : "",
    `<div class="row"><span>paid to holders, on the record</span><b>${usd(r.paidToHoldersCents)}</b></div>`,
    `<div class="row"><span>collected from holders, on the record</span><b>${usd(r.collectedFromHoldersCents)}</b></div>`,
  ]
    .filter(Boolean)
    .join("\n    ");
  const resultLine =
    r.realizedCents === null
      ? `Our result on the real locks is not shown yet: ${r.realizedWithheld ?? "it is not complete on the record"}.`
      : `Our result covers the ${plural(r.settled + r.leftEarly, "real lock that has ended", "real locks that have ended")}: what the hedge paid or sold for and what the terms collected from the holder, less what the fills cost and what the terms paid the holder.`;
  return `  <div class="card">
    <h2>Real fills</h2>
    <div class="sub" style="margin-bottom:8px">These are real fills in our own accounts: orders that were placed and filled with real money when a holder chose to lock in. The rest of this page is a simulated run.</div>
    <div class="bignums">
      <div class="bignum"><div class="n">${intStr(r.realLocks)}</div><div class="l">real locks</div></div>
      <div class="bignum"><div class="n">${intStr(r.settled)}</div><div class="l">settled</div></div>
      <div class="bignum"><div class="n">${usd(r.paidForFillsCents)}</div><div class="l">paid for the fills, fees in</div></div>
      ${result}
    </div>
    ${rows}
    <div class="read" style="margin-top:10px">${escapeHtml(resultLine)}</div>
  </div>
`;
}

/**
 * The ledger's fingerprint, small: the last closed day as it was published, what it covers, one
 * sentence on what it is and how to check it, one on what it does and does not show. A mismatch
 * is said first and in plain words. After a reset the card says the record was restarted and that
 * the earlier fingerprints are still on the list.
 */
export function fingerprintCard(fp: LedgerFingerprintStatus): string {
  const latest = fp.days[fp.days.length - 1];
  const lastRestart = fp.earlier[fp.earlier.length - 1]?.ended ?? null;
  const earlierDays = fp.earlier.reduce((n, c) => n + c.days.length, 0);
  const firstPublished = [...fp.earlier.flatMap((c) => c.days), ...fp.days].reduce<string | null>((min, d) => (min === null || d.publishedAt < min ? d.publishedAt : min), null);
  const alarm = fp.mismatch ? `<div class="read fpbad">${escapeHtml(mismatchWords(fp.mismatch.day))}</div>` : "";
  const restarted = lastRestart
    ? `The record was restarted on ${escapeHtml(utcDay(lastRestart.at))}: the earlier ledger was archived whole, not deleted, and the ${earlierDays} daily fingerprint${earlierDays === 1 ? "" : "s"} published for it ${earlierDays === 1 ? "stays" : "stay"} on the list.` +
      (lastRestart.intact ? "" : " That ledger did not match its published fingerprints when it was archived.")
    : "";
  const list = '<a class="back" href="/api/shadow/fingerprints">Every day\'s fingerprint (JSON)</a>';
  if (!latest) {
    const none =
      fp.state === "unread" && !fp.open
        ? "The ledger's fingerprint could not be read just now."
        : `No day of ${lastRestart ? "the new ledger" : "the ledger"} has closed yet. Its first fingerprint is published when the first line of a later day is written.`;
    return `  <div class="card">
    <h2>Ledger fingerprint</h2>
    ${alarm}<div class="read">${restarted ? `${restarted} ` : ""}${escapeHtml(none)}</div>
    ${list}
  </div>
`;
  }
  return `  <div class="card">
    <h2>Ledger fingerprint</h2>
    ${alarm}<div class="row"><span>last closed day</span><b>${escapeHtml(latest.day)} UTC</b></div>
    <div class="row"><span>covers, from the first line</span><b>${intStr(latest.lines)} lines · ${intStr(latest.bytes)} bytes</b></div>
    <div class="fp">sha256 ${escapeHtml(latest.sha256)}</div>
    <div class="read">This is a SHA-256 over every byte of the ledger up to the last line of that day, chained to the day before, so changing or removing any earlier line changes it and every later one; to check it, save it today and compare it later, or recompute it from a copy of the ledger.</div>
    <div class="read">It shows that the history has not been changed since each fingerprint was first published (this one on ${escapeHtml(utcDay(latest.publishedAt))}, the first on ${escapeHtml(utcDay(firstPublished ?? latest.publishedAt))}, so anything older is fixed only as of that day); it does not show that a line was true when it was written; and the full check needs the raw ledger, which carries private details, so it can be run by us and by anyone we give a copy to.</div>
    ${restarted ? `<div class="read">${restarted}</div>` : ""}${list}
  </div>
`;
}

/** One public line on hedge fills: how they are filled and how many. The receipts themselves are the operator's. */
function hedgeLine(h: NonNullable<ShadowPageInput["hedges"]>): string {
  const s = h.summary;
  const how =
    h.strategy === "rfq"
      ? "RFQ first, visible book as the fallback"
      : h.strategy === "live"
        ? "on the venue, never above the terms quoted"
        : "at the visible book, at the terms quoted";
  const sim = s.receipts > 0 && s.simulated === s.receipts ? ", all simulated" : s.simulated > 0 ? `, ${s.simulated} simulated` : "";
  return `<div class="row"><span>hedge fills</span><b>${escapeHtml(how)} <i>${s.receipts} recorded${sim}</i></b></div>`;
}

const signedUsd = (c: number): string => (c < 0 ? `-${usd(-c)}` : usd(c));
const intStr = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
/** A snapshot's age as the operator reads it: "48s", "4m", "2h"; only shown past the routes' 90s bound. */
const ageWord = (sec: number): string => (sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m` : `${Math.floor(sec / 3600)}h`);
const SHOW_AGE_FROM_SEC = 90;
const bpsPct = (bps: number | null, digits = 2): string => (bps === null ? "n/a" : `${(bps / 100).toFixed(digits)}%`);
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
  prophetx: "hedged cross-venue on the same game",
  novig: "hedged cross-venue on the same game",
  // a member's own sale: part of the position sold into the bid in their own account, nothing hedged
  member_sale: "the holder's own partial sale, nothing hedged",
};
/** the operator's short name for where a lock's other side went (the holders page) */
const ROUTE_SHORT: Record<string, string> = { kalshi_self: "Kalshi", polymarket: "Polymarket", prophetx: "ProphetX", novig: "Novig", member_sale: "own sale" };

export const SHADOW_CSS = `
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
a.tag.rule{text-decoration:none;border-bottom:1px dotted var(--faint)}
.ruledetail{margin:-2px 0 8px;padding:0 0 0 2px;font-size:12.5px;line-height:1.5;color:var(--dim)}
.ruledetail summary{cursor:pointer;color:var(--green-deep);font-weight:600;font-size:12px;list-style:none}
.ruledetail summary::before{content:"+ ";font-weight:700}
.ruledetail[open] summary::before{content:"\\2212  "}
.ruledetail p{margin-top:6px;white-space:normal}
.ruledetail .diff{color:var(--ink);background:var(--card2);border-radius:8px;padding:8px 10px}
.ruledetail del{background:#f6e3e3;color:#7a1c1c;text-decoration:line-through;border-radius:3px;padding:0 2px}
.ruledetail ins{background:var(--green-wash);color:var(--green-deep);text-decoration:none;border-radius:3px;padding:0 2px}
.ruledetail .fine{color:var(--faint);font-size:11px}
.ruledetail .fine code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px}
.back{display:inline-block;margin-top:2px;color:var(--green-deep);font-weight:600;font-size:13px;text-decoration:underline}
.read{color:var(--ink);font-size:13.5px;line-height:1.5;margin-top:6px}
.read b{font-weight:650}
.read.fpbad{color:#8a2a2a;font-weight:650;margin:0 0 8px}
.fp{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;word-break:break-all;color:var(--ink);background:var(--card2);border-radius:8px;padding:8px 10px;margin-top:6px}
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

const utcMinute = (iso: string): string => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/**
 * The edit, word for word, with long unchanged runs folded to their edges so the changed words
 * stand out. Cut words are struck, added words are marked; nothing is reflowed.
 */
function ruleDiffHtml(before: string, after: string): string {
  const CONTEXT = 6;
  return ruleDiff(before, after)
    .map((part, idx, all) => {
      if (part.kind === "cut") return `<del>${escapeHtml(part.text)}</del>`;
      if (part.kind === "add") return `<ins>${escapeHtml(part.text)}</ins>`;
      const words = part.text.split(" ");
      if (words.length <= CONTEXT * 2 + 2) return escapeHtml(part.text);
      const head = idx === 0 ? [] : words.slice(0, CONTEXT);
      const tail = idx === all.length - 1 ? [] : words.slice(-CONTEXT);
      return [head.join(" "), "…", tail.join(" ")].filter(Boolean).map(escapeHtml).join(" ");
    })
    .join(" ");
}

/**
 * The rule the result was judged under, said in plain words on the row: "terms held" links to
 * the venue's own text; "venue edited its rules" sits on its own line and opens to the edit
 * itself. The fingerprint stays in the tooltip and the JSON. Nothing when no rule was pinned.
 */
function ruleMark(p: Pick<ShadowPosition, "rule" | "ruleCheck">): { inline: string; changedLine: string; detail: string } {
  const none = { inline: "", changedLine: "", detail: "" };
  if (!p.rule) return none;
  const label = ruleStateLabel(p.ruleCheck);
  const fp = `fingerprint sha256 ${p.rule.sha256}`;
  if (label !== "venue edited its rules") {
    const when = label === "terms held" ? "read at open and again at settlement, same words" : "read at open";
    return { ...none, inline: ` · <a class="tag rule" href="${escapeHtml(p.rule.sourceUrl)}" rel="noopener" title="${escapeHtml(fp)}, ${when}">${label}</a>` };
  }
  const check = p.ruleCheck!;
  const canShow = Boolean(p.rule.text && check.text);
  const body = canShow
    ? `<p class="diff">${ruleDiffHtml(p.rule.text!, check.text!)}</p>`
    : `<p class="diff">At open the rules began: ${escapeHtml(p.rule.excerpt)}</p>`;
  const detail =
    `<details class="ruledetail"><summary>what the venue changed</summary>` +
    `<p>The venue reworded this market's rules after the position opened. The payout followed the venue's official result, as always. The wording at open is kept here; the venue's current text is at the link.</p>` +
    body +
    `<p class="fine">Read at open ${escapeHtml(utcMinute(p.rule.readAtIso))}, <code>${escapeHtml(shortHash(p.rule.sha256))}</code>; read again ${escapeHtml(utcMinute(check.readAtIso))}, <code>${escapeHtml(shortHash(check.sha256 ?? ""))}</code>. ` +
    `<a class="back" style="font-size:11px" href="${escapeHtml(p.rule.sourceUrl)}" rel="noopener">Venue's current text</a></p></details>`;
  return { inline: "", changedLine: `<i class="paid"><span class="tag rule" title="${escapeHtml(fp)} at open; different words at settlement">${label}</span></i>`, detail };
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
        `<b>${usd(p.protectedCents ?? 0)} <i>vs ${usd(p.nakedCents ?? 0)} without the lock</i>` +
        `<i class="paid">incl. ${usd(p.creditCents)} credited at lock in${rule.inline}</i>` +
        // on its own line: beside the credit it pushes the row past the card on a phone
        `${rule.changedLine}</b></div>${rule.detail}`
      );
    })
    .join("");
  const ruleLine = ruleEvidenceLine(summarizeRuleEvidence(input.settled.map((p) => ({ id: p.ticker, rule: p.rule, check: p.ruleCheck }))), "position");
  const rulesOnPage = Boolean(ruleLine) || (input.parlays?.rules?.pinned ?? 0) > 0;
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
        ? `the lock is AHEAD of holding without it by ${usd(s.deltaTotalCents)} across settled events`
        : `the lock cost ${usd(-s.deltaTotalCents)} across settled events; the floor is what it buys`;
  const quotedLine =
    s.quotedAvgEvBps === null
      ? "not yet recorded"
      : s.quotedAvgEvBps < 0
        ? `${Math.abs(s.quotedAvgEvBps / 100).toFixed(1)}% better than holding without the lock, on average`
        : `${(s.quotedAvgEvBps / 100).toFixed(1)}% of expected value, on average`;
  // The bridge between "floor saves" and "protection cost": one sentence that holds both, with
  // the realized cost next to the quoted one so the reader can see the quote was honest.
  const bridgeLine = (() => {
    if (s.settledCount === 0) return "";
    const savePct = Math.round((100 * s.floorSaves) / s.settledCount);
    const saved = `The lock paid the floor on ${s.floorSaves} of ${s.settledCount} settled events (${savePct}%).`;
    if (s.deltaTotalCents >= 0) return `${saved} Across all of them it came out ${usd(s.deltaTotalCents)} ahead of holding without the lock.`;
    const realizedPct = s.nakedTotalCents > 0 ? `${((100 * -s.deltaTotalCents) / s.nakedTotalCents).toFixed(1)}% of what the same positions paid without the lock` : usd(-s.deltaTotalCents);
    const quoted = s.quotedAvgEvBps !== null && s.quotedAvgEvBps >= 0 ? `; ${(s.quotedAvgEvBps / 100).toFixed(1)}% was quoted up front` : "";
    // Realized is one sample and quoted is the expectation; when strikes on one coin dominate the
    // settled book they settle together, so a rally caps many at once and the two numbers part.
    const cryptoSettled = s.segments.byLeague.crypto?.settled ?? 0;
    const cluster =
      cryptoSettled * 2 > s.settledCount
        ? " Strikes on the same coin settle together, so a rally caps many at once and a drop pays many floors at once; the gap between the two closes as the book widens."
        : "";
    return `${saved} Across all of them it cost ${usd(-s.deltaTotalCents)}, ${realizedPct}${quoted}. Quoted is the expectation at the market's odds; realized is what this sample did.${cluster}`;
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
        ? `On the ${sp.settled} settled, our P&L is ${signedUsd(sp.writerPnlCents)} against ${usd(sp.takeCents)} of take booked; the positions were credited ${usd(sp.creditsCents)} at lock in.`
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
      <div class="bignum"><div class="n">${escapeHtml(dCell)}</div><div class="l">realized, with the lock minus without</div></div>
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
          `<b>${usd(p.protectedCents ?? 0)} <i>vs ${usd(p.nakedCents ?? 0)} without the lock</i>` +
          `<i class="paid">${escapeHtml(mid)}, ${escapeHtml(shortEt(p.closedAt ?? ""))}</i></b></div>`
        );
      })
      .join("");
    const frictionPct = c.stakeCents > 0 && c.withMid > 0 ? ` (${((100 * c.unwindFrictionCents) / c.stakeCents).toFixed(2)}% of stake)` : "";
    const readLine =
      c.count === 0
        ? `${c.unpriced} scheduled exit${c.unpriced === 1 ? "" : "s"} found no depth on a leg and ran to settlement instead; nothing has closed early yet.`
        : `${c.count} position${c.count === 1 ? "" : "s"} left before the lock. Each exit was a new trade at the live books that second: the position's contracts sold into the bids, our other side sold into its bids, and the locked terms settled at what both fetched. ` +
          `They came out at ${usd(c.protectedAtCloseCents)} against ${usd(c.nakedAtCloseCents)} had they never been locked in (${signedUsd(c.deltaCents)}). ` +
          (c.withMid > 0 ? `Crossing both books cost ${signedUsd(c.unwindFrictionCents)} against the mid${frictionPct}. ` : "") +
          `Our result on the way out is the take booked, ${usd(c.takeBookedCents)}: the position pays live prices on both legs, so we carry no price risk on the exit either.` +
          (c.unpriced > 0 ? ` ${c.unpriced} other scheduled exit${c.unpriced === 1 ? "" : "s"} found no depth on a leg and ran to settlement instead.` : "");
    return `  <div class="card">
    <h2>Closed early at live prices</h2>
    <div class="bignums">
      <div class="bignum"><div class="n green">${c.count}</div><div class="l">left before the lock</div></div>
      <div class="bignum"><div class="n ${c.deltaCents >= 0 ? "green" : ""}">${signedUsd(c.deltaCents)}</div><div class="l">with the lock minus without, at the close</div></div>
      <div class="bignum"><div class="n">${c.withMid > 0 ? signedUsd(-c.unwindFrictionCents) : "n/a"}</div><div class="l">crossing the books, against the mid</div></div>
      <div class="bignum"><div class="n">${c.unpriced}</div><div class="l">exits with a leg unpriced</div></div>
    </div>
    <div class="read" style="margin-top:10px">${escapeHtml(readLine)}</div>
    ${rows ? `<div style="margin-top:8px">${rows}</div>` : ""}
  </div>
`;
  })();
  // OWN SALE AND BETTER BID, MEASURED. Each line that carries the measurement was also priced as
  // the user's own sale into their venue's bids and as our better bid with the other side bought
  // elsewhere, from the same books (shadowSaleAlternatives.ts). Counts and sums only: which venue
  // the other side was priced on is the operator's. Absent until a line carries the measurement.
  const saleCard = (() => {
    const m = s.counterfactuals?.sale;
    if (!m || m.lines === 0) return "";
    const o = m.ownSale;
    const b = m.betterBid;
    const pct = (bps: number | null): string => (bps === null ? "n/a" : `${(bps / 100).toFixed(2)}%`);
    const plural = (n: number, word: string): string => `${intStr(n)} ${word}${n === 1 ? "" : "s"}`;
    const moreOrLess = (cents: number): string => (cents >= 0 ? `${usd(cents)} more` : `${usd(-cents)} less`);
    const lines: string[] = [];
    lines.push(
      `Each of the ${plural(m.lines, "record line")} opened since ${m.recordedSince ? utcDay(m.recordedSince) : "the first"} UTC was also priced two other ways, from the same books at the same moment. ` +
        "Own sale: the user sells part of the position into their own venue's bids with their own sell button, after that venue's fee, level by level. " +
        "Better bid: we bid for those contracts above their venue's bid and buy the other side on another venue, so one of our two contracts pays $1 whichever side wins.",
    );
    if (b.compared === 0) lines.push("No line had another venue's book for the other side to price a better bid from.");
    else if (b.existed === 0)
      lines.push(`A better bid existed on none of the ${plural(b.compared, "line")} where another venue's book was read (the best of up to ${plural(b.mostVenues, "venue")} on a line): after both venues' fees, our take and the charge for the two venues settling differently, the prices left no room to pay more than the venue's own bid.`);
    else
      lines.push(
        `A better bid existed on ${intStr(b.existed)} of the ${plural(b.compared, "line")} where another venue's book was read (the best of up to ${plural(b.mostVenues, "venue")} on a line). ` +
          `It beat the user's own sell button by a median of ${usd(b.improvementMedianCents ?? 0)} (${pct(b.improvementMedianBpsOfStake)} of stake) and by ${usd(b.improvementTotalCents)} in total (${pct(b.improvementTotalBpsOfStake)} of the stake on those lines), ` +
          "after every venue fee, our take and a charge for the two venues settling a tie or a called-off game differently. Stake is $1 a contract on the whole position." +
          (b.existed < MIN_SLICE_EVENTS ? ` ${plural(b.existed, "line")} is a small sample: read it as a count, not as a rate.` : ""),
      );
    if (b.existed > 0) {
      const fee = b.restingBidFee ?? { makerSchedule: 0, takerFormula: b.existed };
      lines.push(
        "Our own bid is priced at the venue's fee for an order that rests on its book, which is lower than its fee for an order that takes from the book, and is charged only if the bid is filled." +
          (fee.takerFormula > 0 ? ` ${intStr(fee.takerFormula)} of these lines ${fee.takerFormula === 1 ? "was" : "were"} written before 11 November 2026 and priced our bid at the full fee, so ${fee.takerFormula === 1 ? "it understates" : "they understate"} the gain.` : "") +
          ` Where the venue's price steps or its own offer stopped our bid short of passing everything on, what was left over stays with us: ${usd(b.residualCents)} across these lines, shown here apart from our take of ${usd(b.takeCents)}.`,
      );
    }
    if (o.priced > 0)
      lines.push(
        `Against the lock this record wrote on the same line, the own sale paid the user a median of ${moreOrLess(o.vsCollarMedianCents ?? 0)} than the lock's floor (${pct(o.vsCollarMedianBpsOfStake)} of stake) and ${moreOrLess(o.vsCollarTotalCents)} in total across ${plural(o.priced, "line")} (${pct(o.vsCollarTotalBpsOfStake)} of stake): ` +
          `more on ${intStr(o.ahead)}, less on ${intStr(o.behind)}${o.level > 0 ? `, the same on ${intStr(o.level)}` : ""}. ` +
          "The amount sold is the amount the lock hedges, so the user's two results differ by the same sum either way and the floor is the like-for-like comparison." +
          (o.unpriced > 0 ? ` On ${plural(o.unpriced, "other line")} the own sale could not be priced from the books read, and nothing was measured.` : ""),
      );
    else lines.push(`On none of the ${plural(m.lines, "line")} could the user's own sale be priced from the books read, so nothing was measured.`);
    if (o.settled.lines > 0)
      lines.push(`On the ${plural(o.settled.lines, "line")} of those that ${o.settled.lines === 1 ? "has" : "have"} settled, the own sale would have returned ${usd(o.settled.ownSaleCents)}, against ${usd(o.settled.collarCents)} under the lock and ${usd(o.settled.untouchedCents)} left untouched, at the official result.`);
    return `  <div class="card">
    <h2>Own sale and better bid, measured</h2>
    <div class="sub" style="margin-bottom:8px">Measured on the book at the moment of each quote. Simulated: nothing was bought, nothing was sold and no bid was placed.</div>
    <div class="bignums">
      <div class="bignum"><div class="n green">${intStr(b.existed)}</div><div class="l">of ${intStr(b.compared)} lines had a better bid</div></div>
      <div class="bignum"><div class="n">${b.existed > 0 ? usd(b.improvementMedianCents ?? 0) : "none yet"}</div><div class="l">median gain over the sell button</div></div>
      <div class="bignum"><div class="n">${usd(b.improvementTotalCents)}</div><div class="l">total gain over the sell button</div></div>
      <div class="bignum"><div class="n">${o.priced > 0 ? signedUsd(o.vsCollarMedianCents ?? 0) : "none yet"}</div><div class="l">own sale against the lock's floor, median</div></div>
    </div>
    ${lines.map((l) => `<div class="read" style="margin-top:10px">${escapeHtml(l)}</div>`).join("\n    ")}
  </div>
`;
  })();
  // FLOW ONTO PUBLIC BOOKS: one total. Every protection buys its other side on a public book at
  // open, so the record is also a count of the contracts protection sent to those books. The page
  // says how many and what they cost, and does not cut the number by venue.
  const flowCard = (() => {
    const f = s.flow;
    if (!f || f.allTime.positions === 0) return "";
    const r = f.last30Days;
    const a = f.allTime;
    const sinceDay = a.since ? utcDay(a.since) : "the first position";
    const recentLine =
      r.positions === 0
        ? `No positions opened in the last ${f.windowDays} days.`
        : `In the last ${f.windowDays} days locks put ${intStr(r.contracts)} contracts on public books across ${r.positions} position${r.positions === 1 ? "" : "s"}: ${usd(r.hedgeNotionalCents)} of flow against ${usd(r.stakeCents)} of stake locked in.`;
    const allLine = ` Since ${sinceDay} UTC: ${intStr(a.contracts)} contracts across ${a.positions} positions, ${usd(a.hedgeNotionalCents)} of flow.`;
    const simLine = " Simulated here, like the positions; live, this is order flow onto the books that price the event, placed the second the user taps.";
    return `  <div class="card">
    <h2>Flow onto public books</h2>
    <div class="sub" style="margin-bottom:8px">Every lock buys its other side on a public book, leg for leg. One total; the record does not cut it by venue.</div>
    <div class="bignums">
      <div class="bignum"><div class="n green">${intStr(r.contracts)}</div><div class="l">contracts, last ${f.windowDays} days</div></div>
      <div class="bignum"><div class="n">${usd(r.hedgeNotionalCents)}</div><div class="l">paid for them, fees in</div></div>
      <div class="bignum"><div class="n">${intStr(a.contracts)}</div><div class="l">contracts since ${escapeHtml(sinceDay)}</div></div>
    </div>
    <div class="read" style="margin-top:10px">${escapeHtml(recentLine + allLine + simLine)}</div>
    <div class="rule">Before a route is written, every sports quote is priced on more than one regulated book, and refused when none can fund it. The route-by-route comparison, with other regulated books read as references, is in the operator report and available to any partner on request.</div>
  </div>
`;
  })();
  const richest = Object.entries(s.segments.byLeague)
    .filter(([, r]) => r.quotedAvgEvBps !== null && r.opened >= MIN_SLICE_EVENTS)
    .sort((a, b) => (b[1].quotedAvgEvBps ?? 0) - (a[1].quotedAvgEvBps ?? 0));
  const segmentLine =
    richest.length >= 2
      ? `The lock is cheapest on ${richest[richest.length - 1][0].toUpperCase()} (${bpsPct(richest[richest.length - 1][1].quotedAvgEvBps)} of expected value quoted) and richest on ${richest[0][0].toUpperCase()} (${bpsPct(richest[0][1].quotedAvgEvBps)}); the record-wide average is weighted by how many of each the scanner found, not by what a user would choose.`
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
  // WHAT PROTECTED TRADERS KEPT. The figure the industry does not publish, at the top of the page in
  // plain words: what the same positions returned with and without protection, who the floor paid,
  // that our side's result is the take and not the trader's loss, how often we said no and why, and
  // what leaving early paid. Every number is already on the page below; this block is where a
  // sceptic should be able to stop reading.
  const keptCard = (() => {
    const rf = input.refusals;
    const refusedCell = rf && rf.priced > 0 && rf.refusedPct !== null ? `${rf.refusedPct.toFixed(rf.refusedPct >= 10 ? 0 : 1)}%` : "n/a";
    const savesCell = s.settledCount > 0 ? `${Math.round((100 * s.floorSaves) / s.settledCount)}%` : "n/a";
    const lines: string[] = [];
    if (s.settledCount === 0) lines.push("Nothing has settled yet. This block fills as events settle against their official results.");
    else {
      lines.push(
        `Across ${intStr(s.settledCount)} settled events the same positions returned ${usd(s.protectedTotalCents)} with the lock and ${usd(s.nakedTotalCents)} without, marked at the official result. ` +
          (s.deltaTotalCents >= 0 ? `The lock came out ${usd(s.deltaTotalCents)} ahead.` : `The lock cost ${usd(-s.deltaTotalCents)}, ${s.nakedTotalCents > 0 ? `${((100 * -s.deltaTotalCents) / s.nakedTotalCents).toFixed(1)}% of the outcome without the lock` : "in total"}${s.quotedAvgEvBps !== null && s.quotedAvgEvBps >= 0 ? `; ${(s.quotedAvgEvBps / 100).toFixed(1)}% was quoted up front` : ""}. Quoted is the expectation at the market's odds; realized is what this sample did.`),
      );
      lines.push(`On ${intStr(s.floorSaves)} of those ${intStr(s.settledCount)} (${savesCell}) the pick lost and the floor paid. Those are the positions that would otherwise have ended at nothing.`);
      if (id.settled > 0)
        lines.push(
          id.holds
            ? `Our side netted ${signedUsd(id.writerPnlCents)} on them against ${usd(id.takeBookedCents)} of take booked. The hedge pays the floor, the slice above the cap pays the hedge; nothing we earn depends on who won, and nothing we earn is a trader's loss.`
            : `Our side netted ${signedUsd(id.writerPnlCents)} on them against ${usd(id.takeBookedCents)} of take booked, a gap outside rounding; the operator report has the positions.`,
        );
    }
    if (rf && rf.priced > 0) {
      const reasons = rf.byReason.map((r) => `${r.reason} ${intStr(r.count)}`).join(", ");
      lines.push(
        rf.refused === 0
          ? `Of ${intStr(rf.priced)} events the engine priced, none was refused.`
          : `Of ${intStr(rf.priced)} events the engine priced, ${intStr(rf.refused)} (${refusedCell}) were refused rather than offered${reasons ? `: ${reasons}` : ""}. A refusal is written down like an offer, so the record is the whole board.`,
      );
    }
    const c = s.closed;
    if (c && c.count > 0) lines.push(`${intStr(c.count)} positions were left before the game at live prices and came out at ${usd(c.protectedAtCloseCents)} against ${usd(c.nakedAtCloseCents)} without the lock; we carried no price risk on the exit.`);
    return `  <div class="card">
    <h2>What a locked position actually kept</h2>
    <div class="sub" style="margin-bottom:8px">The figure the industry does not publish: what the same positions returned with and without the lock, marked at the official result, and how often we said no.</div>
    <div class="bignums">
      <div class="bignum"><div class="n">${usd(s.protectedTotalCents)}</div><div class="l">with the lock, settled</div></div>
      <div class="bignum"><div class="n">${usd(s.nakedTotalCents)}</div><div class="l">without the lock, settled</div></div>
      <div class="bignum"><div class="n green">${savesCell}</div><div class="l">the pick lost, the floor paid</div></div>
      <div class="bignum"><div class="n">${refusedCell}</div><div class="l">of events priced were refused</div></div>
    </div>
    ${lines.map((l) => `<div class="read" style="margin-top:10px">${escapeHtml(l)}</div>`).join("\n    ")}
  </div>
`;
  })();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:," />
<title>Track record · Earn &amp; Protect · events</title>
<meta name="description" content="A continuous simulated run of the Lock in engine, marked against official results as events settle." />
<style>${SHADOW_CSS}</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="wordmark">Earn &amp; Protect <span>· track record</span></div>
</div></div>
<div class="wrap">
  <div class="card">
    <h1>Track record</h1>
    <div class="sub">A continuous simulated run. Every quotable event is locked in at its live quoted terms, then marked against the official result when it settles. ${input.real ? "Live prices; nothing in the run is bought. The real fills are counted apart, in the next card." : "Live prices; nothing is bought."}</div>
    <div class="bignums">
      <div class="bignum"><div class="n green">${s.settledCount}</div><div class="l">events settled</div></div>
      <div class="bignum"><div class="n">${s.floorSaves}</div><div class="l">floor saves</div></div>
      <div class="bignum"><div class="n green">${s.openCount}</div><div class="l">open now</div></div>
      <div class="bignum"><div class="n ${w.settledPnlCents >= 0 ? "green" : ""}">${signedUsd(w.settledPnlCents)}</div><div class="l">our P&amp;L, settled</div></div>
    </div>
    <div class="period">${escapeHtml(periodLine)}</div>
  </div>
${input.real ? realFillsCard(input.real) : ""}${keptCard}  <div class="card">
    <h2>We carry no outcome risk</h2>
    <div class="sub" style="margin-bottom:8px">Leg for leg, what we earn on a settled event must equal the published take: the hedge pays the floor, the cap slice pays the hedge, and nothing depends on who won.</div>
    <div class="bignums">
      <div class="bignum"><div class="n ${id.holds ? "green" : ""}">${signedUsd(id.writerPnlCents)}</div><div class="l">our P&amp;L, settled</div></div>
      <div class="bignum"><div class="n">${usd(id.takeBookedCents)}</div><div class="l">take booked</div></div>
      <div class="bignum"><div class="n ${id.holds ? "green" : ""}">${signedUsd(id.gapCents)}</div><div class="l">gap${id.settled > 0 ? (id.holds ? " · holds" : " · check") : ""}</div></div>
    </div>
    <div class="read" style="margin-top:10px">${escapeHtml(identityLine)}</div>
  </div>
${flowCard}${sportsCard}  <div class="card">
    <h2>Settled, most recent first</h2>
    ${leagueCountLine(input.settled, "settled")}
    ${settledRows || '<div class="row"><span>nothing settled yet</span><b>the book is young</b></div>'}
    ${ruleLine ? `<div class="read" style="margin-top:8px">${escapeHtml(ruleLine)}</div>` : ""}
  </div>
  <div class="card">
    <h2>With and without the lock</h2>
    ${bridgeLine ? `<div class="read" style="margin:0 0 8px">${escapeHtml(bridgeLine)}</div>` : ""}
    <div class="row"><span>with the lock, settled total</span><b>${usd(s.protectedTotalCents)}</b></div>
    <div class="row"><span>without the lock, settled total</span><b>${usd(s.nakedTotalCents)}</b></div>
    <div class="row"><span>realized</span><b>${escapeHtml(realizedLine)}</b></div>
    <div class="row"><span>quoted cost of the lock</span><b>${escapeHtml(quotedLine)}</b></div>
    ${routeRows}
    ${s.voidCount > 0 ? `<div class="row"><span>voided (no official result)</span><b>${s.voidCount}</b></div>` : ""}
    ${input.hedges ? hedgeLine(input.hedges) : ""}
  </div>
${saleCard}${closedCard}${input.parlays ? parlayMomentCard(input.parlays) : ""}  <div class="card">
    <h2>Where the lock is cheap and where it is rich</h2>
    <div class="sub" style="margin-bottom:6px">The same book cut by how it was hedged and by league. EV cost is the quoted cost of the lock at the market's own odds; user Δ is realized, with the lock minus without, as a share of settled stake. Slices under ${MIN_SLICE_EVENTS} events show counts only.</div>
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
${input.fingerprints ? fingerprintCard(input.fingerprints) : ""}  <footer>
    ${rulesOnPage ? `<b>How we check rules:</b> ${RULE_CHECK_NOTE}<br><br>` : ""}<b>Real:</b> live prices, quoted terms, official results. <b>Simulated:</b> the positions${input.parlays ? " and the parlay tickets" : ""}${input.real ? ". <b>Real fills:</b> counted apart, in their own card." : "; no venue credentials, no addresses."} ${escapeHtml(windowLine)} Rendered ${escapeHtml(input.atIso.slice(0, 16).replace("T", " "))} UTC. Demonstration, not an offer. <a class="back" href="/api/shadow">Raw JSON</a> <a class="back" href="/api/shadow/positions.csv">Positions (CSV)</a>${input.parlays ? ' <a class="back" href="/api/shadow/parlays">Parlays (JSON)</a>' : ""}
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
  /** the last-leg shadow (lastLeg.ts); absent on reports rendered before it existed */
  lastLeg?: { summary: LastLegSummary; enabled: boolean; stakeCents: number };
  /** netting measured on the same ledger (shadowNetting.ts); operator only, never on the record */
  netting?: NettingReport;
}

const pct1 = (x: number | null): string => (x === null ? "n/a" : `${x.toFixed(1)}%`);
const n1 = (x: number | null, unit = ""): string => (x === null ? "n/a" : `${x.toFixed(1)}${unit}`);

/**
 * LAST LEG — the parlay question, answered with numbers rather than instinct. Tickets are built
 * from the public combo-leg catalog (Polymarket publishes no list of real tickets), tracked leg by
 * leg, and quoted at the moment every leg but the last has hit. Everything about the prices and
 * results is real; the tickets are the only simulation, and the card says so.
 */
export function lastLegCard(input: NonNullable<ShadowReportInput["lastLeg"]>): string {
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
      : `On the quoted tickets the bettor kept ${pct1(s.avgFloorPctOfMark)} of the ticket's value on a miss (the floor), gave up everything above ${pct1(s.avgCapPctOfMark)} on a hit (the cap), and was credited ${usd(Math.round(s.avgCreditCents ?? 0))} at lock in on average (${n1(s.avgCreditBpsOfValue === null ? null : s.avgCreditBpsOfValue / 100, "%")} of the ticket's value), ${n1(s.avgMinutesToStartAtQuote === null ? null : s.avgMinutesToStartAtQuote / 60, "h")} before the last game. Quoted EV cost ${bpsPct(s.avgEvCostBps)} of the position.`;
  const st = s.settled;
  const settledLine =
    st.withProtection === 0
      ? "No locked ticket has settled yet."
      : `${st.withProtection} locked tickets settled: ${st.floorSaves} missed the last leg and the floor paid, ${st.capGiveups} hit it and gave up the cap${st.scalar ? `, ${st.scalar} settled partially` : ""}. With the lock ${usd(st.protectedCents)} against ${usd(st.nakedCents)} without (${signedUsd(st.deltaCents)}). Our side netted ${signedUsd(st.writerCents)} against ${usd(st.takeBookedCents)} of take booked: ${st.identityHolds ? "the identity holds" : "GAP, investigate"}.`;
  const refusals = Object.entries(s.refusalCodes)
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `<div class="row"><span>${escapeHtml(code)}</span><b>${n}</b></div>`)
    .join("");
  const sizeRows = s.bySize
    .map(
      (r) =>
        `<tr><td>${r.size} legs</td><td>${r.built}</td><td>${r.busted}</td><td>${r.reachedLastLeg}</td><td class="hi">${r.quoted}</td><td>${r.refusedOnly}</td><td>${r.settled}</td><td>${r.quoted ? `${usd(r.protectedCents)} / ${usd(r.nakedCents)}` : "n/a"}</td></tr>`,
    )
    .join("");
  const period = s.firstTicketAt ? `since ${utcDay(s.firstTicketAt)} UTC` : "not started";
  return `<div class="card">
    <h2>Last leg</h2>
    <div class="sub" style="margin-bottom:8px">Does "lock in your parlay before the last leg" fund a credit? Tickets of ${escapeHtml(s.bySize.map((r) => r.size).join(", ") || "2 to 5")} favourites at a $${(input.stakeCents / 100).toFixed(0)} stake are built from Polymarket's public combo-leg catalog the way a bettor builds them, tracked leg by leg, and when every leg but the last has hit the compressed position is quoted the way a single is: the engine's own quote on the last leg's game market, every hedge venue offered tonight read and the cheapest all-in route taken (legs are built only on games the engine lists). Prices, results and quotes are real; the tickets are simulated, because the venue publishes no list of real ones.</div>
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
      <tr><th>ticket</th><th>built</th><th>busted</th><th>reached</th><th>quoted</th><th>refused</th><th>settled</th><th>with the lock / without</th></tr>
      ${sizeRows || `<tr><td colspan="8">no tickets yet</td></tr>`}
    </table></div>
    ${refusals ? `<div class="rule">Refusals by reason across ${s.attempts} attempts:</div>${refusals}` : ""}
    <div class="rule">Busted means a leg other than the last lost, so no moment existed. Refused means the moment came and the last leg's book did not fund a positive credit at any floor/cap, or the mark sat outside the quotable band. Ticket value at the moment is contracts × the last leg's mark: what a cash-out at fair would pay.</div>
    <a class="back" href="/api/shadow/lastleg">Tickets (JSON)</a> <a class="back" href="/api/shadow/lastleg.csv">Tickets (CSV)</a>
  </div>`;
}

/** One rule's line in a comparison table. `hi` marks the columns a reader compares first. */
function ruleTr(label: string, note: string, r: RuleBook, opts: { base?: boolean } = {}): string {
  const noteHtml = note ? ` <span class="tag">${escapeHtml(note)}</span>` : "";
  const holderBps = r.stakeSettledCents > 0 ? bpsPct((r.holderDeltaCents / r.stakeSettledCents) * 10_000) : "n/a";
  const writerBps = r.stakeSettledCents > 0 ? bpsPct((r.writerPnlCents / r.stakeSettledCents) * 10_000) : "n/a";
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
  const pnlBpsLine = w.settledPnlBpsOfStake === null ? "n/a" : `${(w.settledPnlBpsOfStake / 100).toFixed(2)}% of settled stake`;
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
    <div class="sub" style="margin-bottom:8px">The other side of every settled event: what selling the lock and carrying the hedge netted. Leg for leg, the answer should not depend on who won; the gap on the track record is what is left after these lines. This card covers every settled position on the record (${w.settledWhenHolderWon + w.settledWhenHolderLost}); the rule tables below cover the ${s.counterfactuals.baseline.settled} settled since the alternatives were recorded.</div>
    <div class="row"><span>realized, all ${w.settledWhenHolderWon + w.settledWhenHolderLost} settled events</span><b>${signedUsd(w.settledPnlCents)} <i>${escapeHtml(pnlBpsLine)}</i></b></div>
    <div class="row"><span>split by outcome</span><b>${escapeHtml(evenLine)}</b></div>
    <div class="row"><span>published take booked on those events</span><b>${usd(w.takeBookedCents)}</b></div>
    <div class="row"><span>cap slices kept (user won)</span><b>${usd(w.capSlicesKeptCents)}</b></div>
    <div class="row"><span>floors paid (user lost)</span><b>${signedUsd(-w.floorsPaidCents)}</b></div>
    <div class="row"><span>hedge payouts received</span><b>${usd(w.hedgePayoutsCents)}</b></div>
    <div class="row"><span>hedge cost paid</span><b>${signedUsd(-w.hedgeCostCents)}</b></div>
    <div class="row"><span>credits paid at lock in</span><b>${signedUsd(-w.creditsPaidCents)}</b></div>
    <div class="row"><span>hedge payouts minus hedge cost</span><b>${signedUsd(id.hedgeNetCents)} <i>${id.hedgeNetCents >= 0 ? "the hedge funded itself" : "the hedge fell short"}</i></b></div>
    <div class="row"><span>cap slices kept minus floors and credits paid</span><b>${signedUsd(id.holderLegsNetCents)}</b></div>
    <div class="row"><span>take locked on open positions</span><b>${usd(w.takeLockedOpenCents)} <i>realizes as they settle</i></b></div>
    ${leagueRows}
  </div>`;
}

/**
 * NETTING, MEASURED. The two sides of one game on the record, matched on paper: what buying both
 * hedges paid above holding the matched dollar as cash. Operator card; the record itself still
 * hedges leg for leg and says nothing about netting. Numbers from shadowNetting.ts.
 */
function nettingCard(r: NettingReport): string {
  const s = r.summary;
  const cpd = (x: number | null): string => (x === null ? "n/a" : `${x.toFixed(1)}¢`);
  const lead =
    s.pairs === 0
      ? "No game has both sides on the record yet; the first pair forms when a scan opens the other side of a game already held."
      : `${s.pairs} games have both sides on the record (${s.singles} have one). Leg for leg those ${s.pairedPositions} hedges cost ${usd(s.legForLegCents)}; netted they would have cost ${usd(s.nettedCents)}, a saving of ${signedUsd(s.savingCents)} (${bpsPct(s.savingBpsOfLegForLeg)} of the hedge cost, ${bpsPct(s.savingBpsOfTake, 0)} of the ${usd(s.takeOnPairsCents)} of take booked on them).`;
  const windowLine =
    s.pairs === 0
      ? ""
      : s.sameWindow.pairs === 0
        ? `No pair had both sides priced within ${s.sameWindow.windowHours}h of each other, so every two-sided cost here carries the market's move between the two opens.`
        : `${s.sameWindow.pairs} pairs had both sides priced within ${s.sameWindow.windowHours}h of each other: on those the median two-sided cost is ${cpd(s.sameWindow.medianTwoSidedCostCentsPerUnit)} per netted dollar and the saving is ${signedUsd(s.sameWindow.savingCents)} on ${usd(s.sameWindow.legForLegCents)}. That is the number to quote; the rest of the pairs were priced a median ${n1(s.openedGapHours.median, "h")} apart and carry whatever the market did in between.`;
  const shareLine =
    s.pairs === 0
      ? ""
      : `${bpsPct(s.nettedShareBps, 0)} of the paired hedge units matched, because the shadow opens one position per market at one size: that share is the board's, not a user's. ${s.pairsNotSaving} of ${s.pairs} pairs would not have saved (the two books summed under a dollar at their opens).`;
  const leagueRows = Object.entries(s.byLeague)
    .sort((a, b) => b[1].pairs - a[1].pairs)
    .map(
      ([league, l]) =>
        `<div class="row"><span>${escapeHtml(league.toUpperCase())} · ${l.pairs} pairs, ${l.singles} single</span>` +
        `<b>${signedUsd(l.savingCents)} <i>of ${usd(l.legForLegCents)} · median ${escapeHtml(cpd(l.medianTwoSidedCostCentsPerUnit))} per dollar</i></b></div>`,
    )
    .join("");
  const pairRows = r.pairs
    .slice(0, 12)
    .map((p) => {
      const [a, b] = p.sides;
      return (
        `<tr><td class="hi">${escapeHtml(p.eventTitle)}</td>` +
        `<td>${escapeHtml(a.sideName)} ${a.unitCostCents.toFixed(1)}¢ · ${escapeHtml(b.sideName)} ${b.unitCostCents.toFixed(1)}¢</td>` +
        `<td class="hi">${p.twoSidedCostCentsPerUnit.toFixed(1)}¢</td>` +
        `<td>${p.openedGapHours.toFixed(1)}h</td>` +
        `<td>${usd(p.legForLegCents)}</td>` +
        `<td>${usd(p.nettedCents)}</td>` +
        `<td class="hi">${signedUsd(p.savingCents)}</td>` +
        `<td>${usd(p.takeCents)}</td>` +
        `<td>${p.identity.holds ? "holds" : "off"}</td></tr>`
      );
    })
    .join("");
  return `<div class="card">
    <h2>Netting, measured</h2>
    <div class="sub" style="margin-bottom:8px">A user locked in on one side of a game and a user locked in on the other are each other's hedge: the two hedge legs together pay a dollar whoever wins. The record buys both anyway, leg for leg; this card measures what it would have saved to hold the matched dollar as cash and buy only the residual. Nothing was netted.</div>
    <div class="bignums">
      <div class="bignum"><div class="n green">${s.pairs}</div><div class="l">games with both sides</div></div>
      <div class="bignum"><div class="n">${signedUsd(s.savingCents)}</div><div class="l">saving, all pairs</div></div>
      <div class="bignum"><div class="n">${escapeHtml(cpd(s.sameWindow.medianTwoSidedCostCentsPerUnit))}</div><div class="l">per netted dollar, same-window pairs</div></div>
      <div class="bignum"><div class="n ${s.identityHolds ? "green" : ""}">${s.identityHolds ? "holds" : "off"}</div><div class="l">pair identity, every pair</div></div>
    </div>
    <div class="read" style="margin-top:10px">${escapeHtml(lead)}</div>
    ${windowLine ? `<div class="read">${escapeHtml(windowLine)}</div>` : ""}
    ${shareLine ? `<div class="read">${escapeHtml(shareLine)}</div>` : ""}
    ${leagueRows}
    ${
      pairRows
        ? `<div class="tablewrap" style="margin-top:8px"><table>
      <tr><th>game</th><th>unit cost, each side</th><th>two-sided</th><th>opened apart</th><th>leg for leg</th><th>netted</th><th>saving</th><th>take</th><th>identity</th></tr>
      ${pairRows}
    </table></div>`
        : ""
    }
    <div class="rule">Unit cost is the hedge leg's cost, venue fees included, per $1 of payout, from the credit identity on the record. Two-sided is the two added: 100¢ would be a free dollar; what is above it is the spread and fees netting removes. Netted holds the matched units as cash at 100¢ and buys the residual at that side's own average, which is a ceiling on its cost, so the saving is a floor. Identity: our result on the pair, written out for each winner, equals the two takes plus the saving in both states.</div>
    <a class="back" href="/api/shadow/netting">Pairs (JSON)</a>
  </div>`;
}

/**
 * The rule comparison: every proposed pricing rule marked against the same
 * positions, same books, same results as the live book. Read across a row for
 * one rule; read down a column to compare rules. Nothing here was traded.
 */
export function renderShadowReportHtml(input: ShadowReportInput): string {
  const s = input.summary;
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
      const fillRate = row.quoted + row.refused > 0 ? `${Math.round((row.quoted / (row.quoted + row.refused)) * 100)}%` : "n/a";
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

  // ROUTING, MEASURED: the same sports positions forced onto each hedge route. The question it
  // answers is what a hedge that must run on the market's own No side costs, before any routing
  // policy is changed on the live record. Operator only.
  const routeCard = (() => {
    const r = cf.routes;
    if (!r || r.positions === 0) {
      return `  <div class="card">
    <h2>Routing, measured</h2>
    <div class="read">No sports position has carried both routes yet; the next scan that quotes a game begins it. Each new open records the default tier on the market's own No side and on the second book, from the same books at the same second.</div>
  </div>
`;
    }
    const refs = r.references ?? [];
    const rows = [
      ruleTr("live book", "the cheaper route, as written", r.live, { base: true }),
      ruleTr("kalshi only", "the market's own No side, every time", r.kalshiOnly),
      ruleTr("second book only", "cross-venue, every time", r.crossOnly),
      ...refs.map((ref) => ruleTr(REFERENCE_BOOK_WORDS[ref.id as keyof typeof REFERENCE_BOOK_WORDS] ?? ref.id, `listed ${ref.listed} of ${ref.positions}, read only`, ref)),
    ].join("");
    const refLines = refs
      .map((ref) => {
        const name = REFERENCE_BOOK_WORDS[ref.id as keyof typeof REFERENCE_BOOK_WORDS] ?? ref.id;
        const coverage = `${name} listed ${ref.listed} of the ${ref.positions} games it was read for`;
        if (ref.bothQuoted === 0) return `${coverage}${ref.listed > 0 ? ` and funded none of them at the live size` : ""}.`;
        const richer = ref.extraEvBps !== null && ref.extraEvBps > 0;
        return `${coverage} and funded ${ref.bothQuoted}; on those it quoted ${bpsPct(Math.abs(ref.extraEvBps ?? 0))} of expected value ${richer ? "more" : "less"} than the route written, credits ${signedUsd(ref.creditDeltaCents)} against the live book.`;
      })
      .join(" ");
    // Prints are yesterday's tape, so they are a sentence beside the table, never a row in it: a
    // row would read as a hedge priced there, and nothing could have been filled at a day-old print.
    const prints = r.prints ?? [];
    const printLines = prints
      .map((pr) => {
        const name = REFERENCE_PRINT_WORDS[pr.id as keyof typeof REFERENCE_PRINT_WORDS] ?? pr.id;
        const coverage = `${name} had printed the opposing side of ${pr.printed} of the ${pr.positions} games it was read for`;
        if (pr.printed === 0 || pr.avgGapCents === null) return `${coverage}.`;
        const dir = pr.avgGapCents > 0 ? "above" : pr.avgGapCents < 0 ? "below" : "level with";
        const gap = pr.avgGapCents === 0 ? "" : ` by ${Math.abs(pr.avgGapCents).toFixed(1)}¢ on average`;
        return `${coverage}; its last print there was ${dir} the price the live hedge paid${gap} (${pr.richer} richer, ${pr.cheaper} cheaper), about ${pr.avgDayContracts ?? 0} contracts traded that day, the print ${pr.avgAgeHours ?? 0} hours old at the quote. Yesterday's tape against today's book: a sign of where that venue trades, not a quote.`;
      })
      .join(" ");
    const split = Object.entries(r.liveRouteSplit)
      .map(([k, n]) => `${n} ${ROUTE_WORDS[k] ?? k}`)
      .join(", ");
    const extra =
      r.kalshiOnlyExtraEvBps === null
        ? ""
        : r.kalshiOnlyExtraEvBps > 0
          ? `On the ${r.bothQuoted} positions the market's own No side also funded, kalshi-only quoted ${bpsPct(r.kalshiOnlyExtraEvBps)} of expected value more than the route written, and users would have been paid ${signedUsd(r.kalshiOnlyCreditDeltaCents)} in credits against the live book.`
          : `On the ${r.bothQuoted} positions the market's own No side also funded, kalshi-only was no richer than the route written (${bpsPct(r.kalshiOnlyExtraEvBps)}), credits ${signedUsd(r.kalshiOnlyCreditDeltaCents)} against the live book.`;
    const refused =
      r.kalshiOnlyRefusedWhereLiveQuoted > 0
        ? ` ${r.kalshiOnlyRefusedWhereLiveQuoted} position${r.kalshiOnlyRefusedWhereLiveQuoted === 1 ? "" : "s"} the live route locked in would have been refused kalshi-only: that is coverage lost, not cost, and it is excluded from the pairwise numbers.`
        : "";
    return `  <div class="card">
    <h2>Routing, measured</h2>
    <div class="sub" style="margin-bottom:6px">${r.positions} sports positions since ${escapeHtml(utcDay(r.recordedSince ?? input.atIso))} UTC carry the default tier on both hedge routes from the same books at the same second. The live book wrote the cheaper one (${escapeHtml(split)}). Crypto strikes have one route and are left out.</div>
    <div class="tablewrap"><table>${RULE_HEAD}${rows}</table></div>
    <div class="read">${escapeHtml([extra + refused, refLines, printLines].filter(Boolean).join(" "))}</div>
    <div class="rule">Kalshi-only is what a hedge that must run on the market's own No side would have cost: the production shape for a US venue. The second book is a price reference until it can be filled on from here; the live record keeps choosing the cheaper route for the user until a routing rule is published.${
      refs.length > 0
        ? " Reference books are other regulated US exchanges listing the same games, read at the same second with their fees folded into the price and priced exactly like a hedge route. Nothing is filled on them; the rows measure what hedging there would have cost, which is what decides whether to onboard one."
        : ""
    }${
      prints.length > 0
        ? " Reference prints come from a regulated US exchange that publishes no live book, only every trade it matched the day before, in the CFTC's public format. The record keeps the opposing side's last print, its size and its age beside the price the live hedge paid; it is never priced as a route."
        : ""
    }</div>
  </div>
`;
  })();

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

  ${input.netting ? nettingCard(input.netting) : ""}

  ${input.lastLeg ? lastLegCard(input.lastLeg) : ""}

${routeCard}
  <div class="card">
    <h2>Lock in tiers</h2>
    <div class="sub" style="margin-bottom:6px">Three collars from one book. User Δ is with the lock minus without across settled events; our P&amp;L is the other side after the hedge. Percentages are of settled stake.</div>
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
    <div class="read"><b>User Δ</b> is what the lock did for the user against holding without it: negative is the usual cost of the lock, positive means the floor paid more than the cap gave up. <b>Our P&amp;L</b> is what selling that lock and carrying the hedge netted; leg for leg it should not depend on who won. <b>EV cost</b> is the quoted expected cost of the collar as a share of stake, before anything settles. A rule that lifts our P&amp;L without moving user Δ much is a better rule; one that only shifts money from one column to the other is a fee.</div>
    <a class="back" href="/">Back to the track record</a> <a class="back" href="/api/shadow/report">Raw JSON</a> <a class="back" href="/api/shadow/positions.csv?scope=full&amp;as=operator">Positions with every alternative (CSV)</a> <a class="back" href="/api/shadow/hedges">Hedge receipts (JSON)</a> <a class="back" href="/api/shadow/export">Full ledger (JSONL)</a> <a class="back" href="/venues">By venue, named (operator)</a>
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
    const avgCredit = lv.quoted > 0 ? usd(Math.round(lv.creditsCents / lv.quoted)) : "n/a";
    const avgSell = lv.quoted > 0 ? usd(Math.round(lv.sellCents / lv.quoted)) : "n/a";
    const settledPart =
      lv.settled > 0
        ? ` On the ${lv.settled} settled, locking paid ${usd(lv.settledLockCents)} against ${usd(lv.settledSellCents)} for selling and ${usd(lv.settledHoldCents)} for holding; the lock beat the sell on ${lv.lockBeatSell}, and holding beat both on ${lv.holdBeatBoth}.`
        : "";
    return `${lv.quoted} tickets reached the last leg with a priced lock, on average ${avgCredit} credited at lock in on a ticket worth ${avgSell} at fair.${settledPart}`;
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
    <div class="sub" style="margin-bottom:8px">A bettor whose parlay has every leg in but the last has three choices. Sell is a cash-out at fair (the ticket's value before any spread). Lock is the collar on the last leg: a floor, a cap, and a credit at lock in, hedged on whichever venue the router chose for the last leg's game, as a single is. Hold is the ticket with no lock. Tickets here are simulated from the public slate (2 to 5 favourites, $${(input.stakeCents / 100).toFixed(0)} stake); prices, results and quotes are real.</div>
    <div class="bignums">
      <div class="bignum"><div class="n">${ll.tickets}</div><div class="l">tickets built</div></div>
      <div class="bignum"><div class="n">${ll.reachedLastLeg}</div><div class="l">reached the last leg</div></div>
      <div class="bignum"><div class="n green">${lv.quoted}</div><div class="l">priced a lock</div></div>
      <div class="bignum"><div class="n green">${usd(lv.creditsCents)}</div><div class="l">credited at lock in</div></div>
    </div>
    <div class="read" style="margin-top:10px">${escapeHtml(lvLine)}</div>
    ${
      lvRows
        ? `<div class="tablewrap" style="margin-top:8px"><table>
      <tr><th>ticket · last leg</th><th>when</th><th>sell at fair</th><th>lock ends</th><th>credited at lock in</th><th>lock paid</th><th>sell paid</th><th>hold paid</th></tr>
      ${lvRows}
    </table></div>`
        : ""
    }
    <div class="rule">Lock ends shows the two endings with the credit included. Paid columns fill when the last game settles. A ticket with two or more legs still open is never quoted: that would mean hedging the product of two games, and no book quotes it. Nothing is bought; the lock is priced from the live book of the venue the hedge would have been sent to.</div>
    ${refusalRows ? `<div class="rule" style="margin-top:8px">Lock not offered, and why, across ${ll.attempts} attempts:</div>${refusalRows}` : ""}
    <div class="read" style="margin-top:8px">${escapeHtml(identityLine)}</div>
    ${input.rules && input.rules.pinned > 0 ? `<div class="read" style="margin-top:6px">${escapeHtml(ruleEvidenceLine(input.rules, "leg"))}</div>` : ""}
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
  /** where the hedges are bought today, by name, the ones this slate's record used first */
  hedgeVenues: string[];
  /**
   * Whether the page names them. A prospect's link says how many venues compete and no more
   * (EVENT_X_NAME_HEDGE_VENUES off, the default); the names are the operator's.
   */
  nameHedgeVenues: boolean;
  /** the interactive demo in the venue's brand */
  demoUrl: string;
  /** the slate's CSV, keyed */
  csvHref: string;
  /** the public record */
  recordUrl: string;
}

const joinWords = (xs: readonly string[]): string =>
  xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** Where the hedges go, in the slate's sentence: the names when the page may carry them, the count otherwise. */
export function slateHedgeWords(venues: readonly string[], named: boolean): string {
  if (named && venues.length > 0) return `on ${joinWords(venues)}`;
  if (venues.length <= 1) return "on a regulated venue's own book";
  return `on the best of ${venues.length} venues`;
}

/**
 * VENUE SLATE PAGE: "what one Lock in button would have done on your games". The public record's
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
  const hedgeWords = slateHedgeWords(input.hedgeVenues, input.nameHedgeVenues);
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
        ? `locked positions came out ${usd(s.deltaTotalCents)} ahead of holding`
        : `the lock cost ${usd(-s.deltaTotalCents)} across settled games${stakeSettled > 0 ? ` (${((100 * -s.deltaTotalCents) / stakeSettled).toFixed(2)}% of what the same positions paid without the lock)` : ""}; the floor is what it bought`;
  const saveLine =
    s.settledCount === 0
      ? "The first games on these leagues settle this week."
      : `The lock paid the floor on ${s.floorSaves} of ${s.settledCount} settled games (${Math.round((100 * s.floorSaves) / s.settledCount)}%). Those are the positions that would otherwise have ended at nothing.`;
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
        `<b>${usd(p.protectedCents ?? 0)} <i>vs ${usd(p.nakedCents ?? 0)} without the lock</i><i class="paid">incl. ${usd(p.creditCents)} credited at lock in</i></b></div>`
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
<title>Lock in on the ${name} slate · Earn &amp; Protect</title>
<style>${SHADOW_CSS}</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="wordmark">Earn &amp; Protect <span>· prepared for ${name}</span></div>
</div></div>
<div class="wrap">
  <div class="card">
    <h1>Lock in on the ${name} slate</h1>
    <div class="sub">What one Lock in button would have done on ${escapeHtml(leagueWords)} games: every quotable game locked in at its live quoted terms, then marked against the official result. Hedged leg for leg ${escapeHtml(hedgeWords)}. Live prices; nothing was bought.</div>
    <div class="bignums">
      <div class="bignum"><div class="n green">${s.settledCount}</div><div class="l">games settled</div></div>
      <div class="bignum"><div class="n">${s.floorSaves}</div><div class="l">floor saves</div></div>
      <div class="bignum"><div class="n green">${usd(creditsSettled)}</div><div class="l">credited at lock in</div></div>
      <div class="bignum"><div class="n ${id.holds ? "green" : ""}">${signedUsd(w.settledPnlCents)}</div><div class="l">our P&amp;L = take booked</div></div>
    </div>
    <div class="period">${escapeHtml(periodLine)} · ${s.openCount} open now</div>
    <div class="read" style="margin-top:10px">${escapeHtml(saveLine)}</div>
  </div>
  <div class="card">
    <h2>What it costs, what it saves</h2>
    <div class="row"><span>quoted cost of the lock</span><b>${escapeHtml(quotedLine)}</b></div>
    <div class="row"><span>realized</span><b>${escapeHtml(realizedLine)}</b></div>
    <div class="row"><span>with the lock, settled total</span><b>${usd(s.protectedTotalCents)}</b></div>
    <div class="row"><span>without the lock, settled total</span><b>${usd(s.nakedTotalCents)}</b></div>
    <div class="tablewrap" style="margin-top:8px"><table>
      <tr><th>league</th><th>opened</th><th>settled</th><th>EV cost</th><th>user Δ</th><th>credits</th><th>our P&amp;L</th></tr>
      ${leagueRows || '<tr><td colspan="7">no games on these leagues yet</td></tr>'}
    </table></div>
    <div class="rule">EV cost is the quoted cost of the lock at the market's own odds; user Δ is realized, with the lock minus without, as a share of settled stake. Slices under ${MIN_SLICE_EVENTS} games show counts only.</div>
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
    <div class="read">The same engine, inside a positions list in your colours: tap Lock in on any row, see the floor, the cap and the credit priced live, accept, and watch the row reshape. One JSON quote in, one receipt out; your brand, your ledger, your official result.</div>
    <a class="back" href="${escapeHtml(input.demoUrl)}">Open the ${name} demo</a> <a class="back" href="${escapeHtml(input.recordUrl)}">Full public record</a> <a class="back" href="${escapeHtml(input.csvHref)}">Your slate (CSV)</a>
  </div>
  <footer>
    <b>Real:</b> live prices, quoted terms, hedge books, official results. <b>Simulated:</b> the positions and the parlay tickets; no venue credentials, nothing bought. The terms shown are the terms we would have had to hedge at that second. Rendered ${escapeHtml(input.atIso.slice(0, 16).replace("T", " "))} UTC. Prepared for ${name}; demonstration, not an offer.
  </footer>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// HOLDERS — operator only. Who locked what, and what is owed each way, the page a pay run reads.
// ---------------------------------------------------------------------------

export interface HoldersPageInput {
  at: string;
  /** what the in-full button would record: payments outstanding on real locks that have ended */
  inFull?: { lines: number; toHoldersCents: number; fromHoldersCents: number; left: number };
  holders: Array<{
    holder: string;
    configured: boolean;
    locks: number;
    open: number;
    settled: number;
    outstanding: { toHolderCents: number; toWriterCents: number; netToHolderCents: number };
    positions: Array<{
      ticker: string;
      at: string;
      status: string;
      result?: string;
      eventTitle: string;
      sideName: string;
      eventTimeIso: string;
      contracts: number;
      entryCents: number | null;
      floorCents: number;
      capCents: number;
      creditCents: number;
      route: string;
      cash: CashLegDue[];
      ledger: string;
    }>;
  }>;
  totals: { locks: number; toHolderCents: number; toWriterCents: number };
  /** each lock ledger's daily fingerprints (ledgerFingerprint.ts), the shared ledger under holder null; absent where they are switched off */
  fingerprints?: Array<{ holder: string | null; status: LedgerFingerprintStatus }>;
}

/** The lock ledgers' fingerprints, one row each: operator only, since a ledger is named by its holder. */
function lockFingerprintsCard(list: NonNullable<HoldersPageInput["fingerprints"]>): string {
  if (list.length === 0) return "";
  const rows = list
    .map(({ holder, status: f }) => {
      const latest = f.days[f.days.length - 1];
      const state = f.mismatch ? `<b style="color:#8a2a2a">no longer matches ${escapeHtml(f.mismatch.day)}</b>` : f.state === "unread" ? "could not be read" : "matches";
      const href = `/api/shadow/fingerprints?as=operator&amp;ledger=lock${holder ? `&holder=${encodeURIComponent(holder)}` : ""}`;
      return `<tr><td><a class="back" href="${href}">${escapeHtml(holder ?? "shared key")}</a></td><td>${state}</td><td>${latest ? escapeHtml(latest.day) : "none closed yet"}</td><td>${latest ? intStr(latest.lines) : ""}</td><td>${latest ? intStr(latest.bytes) : ""}</td><td class="tk">${latest ? escapeHtml(latest.sha256) : ""}</td><td>${f.chain > 1 ? f.chain - 1 : ""}</td></tr>`;
    })
    .join("");
  return `  <div class="card">
    <h2>Lock ledger fingerprints</h2>
    <div class="read">Each lock ledger is fingerprinted like the record's: one SHA-256 per closed UTC day over every byte up to that day's last line, chained to the day before. Listed here and nowhere public. A lock reset moves lines out of a ledger, so it ends that ledger's chain and starts a new one; the earlier fingerprints stay on its list.</div>
    <div class="tablewrap"><table><tr><th>ledger</th><th>state</th><th>last closed day</th><th>lines</th><th>bytes</th><th>sha256</th><th>resets</th></tr>${rows}</table></div>
  </div>
`;
}

const CASH_LEG_WORDS: Record<string, string> = { credit: "credit", floor: "floor", handback: "above the cap", close: "left early" };

/** One cash leg as the pay run reads it: what is due, what moved, what is left, which way. */
function cashLegHtml(l: CashLegDue): string {
  const who = l.to === "holder" ? "to holder" : "to writer";
  const state = l.outstandingCents === 0 ? `<i class="paid">paid${l.paidAt ? ` ${escapeHtml(shortEt(l.paidAt))}` : ""}</i>` : l.paidCents > 0 ? `<i>${usd(l.paidCents)} paid · <b>${usd(l.outstandingCents)}</b> owed ${who}</i>` : `<i><b>${usd(l.outstandingCents)}</b> owed ${who}</i>`;
  return `<div class="leg"><span>${escapeHtml(CASH_LEG_WORDS[l.leg] ?? l.leg)}</span>${usd(l.dueCents)}${state}</div>`;
}

export function renderHoldersHtml(input: HoldersPageInput): string {
  const net = input.totals.toHolderCents - input.totals.toWriterCents;
  const sections = input.holders
    .map((h) => {
      const rows = h.positions
        .map((p) => {
          const owedToHolder = p.cash.filter((c) => c.to === "holder").reduce((s, c) => s + c.outstandingCents, 0);
          const owedToWriter = p.cash.filter((c) => c.to === "writer").reduce((s, c) => s + c.outstandingCents, 0);
          const standing = owedToHolder > 0 ? `<b class="owe">${usd(owedToHolder)}</b><i>owed to holder</i>` : owedToWriter > 0 ? `<b class="back">${usd(owedToWriter)}</b><i>owed back</i>` : `<b class="sq">square</b><i>every leg paid</i>`;
          const result = p.status === "settled" ? ` · ${p.result === "yes" ? `${escapeHtml(p.sideName)} won` : p.result === "no" ? `${escapeHtml(p.sideName)} lost` : escapeHtml(p.result ?? "")}` : p.status === "open" ? "" : ` · ${escapeHtml(p.status)}`;
          return `<tr class="${escapeHtml(p.status)}"><td class="g"><b>${escapeHtml(p.eventTitle)}</b><i>${escapeHtml(p.sideName)} · ${escapeHtml(shortEt(p.eventTimeIso))}${result}</i><i class="tk">${escapeHtml(p.ticker)}</i></td><td>${p.contracts}<i>${p.entryCents !== null ? `@ ${p.entryCents}¢` : ""}</i></td><td>${p.floorCents}¢ / ${p.capCents}¢<i>+${usd(p.creditCents)} credit</i></td><td>${escapeHtml(ROUTE_SHORT[p.route] ?? p.route)}<i>locked ${escapeHtml(shortEt(p.at))}</i></td><td class="legs">${p.cash.map(cashLegHtml).join("")}</td><td class="st">${standing}</td></tr>`;
        })
        .join("");
      const name = h.holder === "(shared)" ? "shared key" : h.holder;
      const o = h.outstanding;
      const line = o.toHolderCents === 0 && o.toWriterCents === 0 ? "square" : `${o.toHolderCents > 0 ? `${usd(o.toHolderCents)} owed to them` : ""}${o.toHolderCents > 0 && o.toWriterCents > 0 ? " · " : ""}${o.toWriterCents > 0 ? `${usd(o.toWriterCents)} owed back` : ""} · net ${o.netToHolderCents >= 0 ? "pay " : "collect "}${usd(Math.abs(o.netToHolderCents))}`;
      return `<div class="card holder">
    <div class="hh"><h2>${escapeHtml(name)}${h.configured ? "" : ' <small>key removed; history kept</small>'}</h2><span class="hs">${h.locks} lock${h.locks === 1 ? "" : "s"} · ${h.open} open · ${h.settled} settled</span></div>
    <div class="read">${escapeHtml(line)}</div>
    ${rows ? `<div class="tablewrap"><table><tr><th>game</th><th>size</th><th>floor / cap</th><th>hedged on</th><th>cash</th><th>standing</th></tr>${rows}</table></div>` : `<div class="rule">No locks yet.</div>`}
  </div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<link rel="icon" href="data:," />
<title>Holders · operator · Earn &amp; Protect</title>
<style>${SHADOW_CSS}
.wrap,.topbar .in{max-width:1100px}
@media(min-width:700px){.wrap,.topbar .in{max-width:1100px}}
td.g{text-align:left;white-space:normal;min-width:200px}
td i{display:block;color:var(--faint);font-style:normal;font-size:11px;font-weight:500}
td i.tk,td.tk{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px}
td.legs{text-align:left;min-width:220px}
.leg{display:grid;grid-template-columns:72px auto;column-gap:8px;font-size:12px;padding:2px 0}
.leg span{color:var(--faint)} .leg i{grid-column:2;color:var(--dim)} .leg i b{color:var(--ink)} .leg i.paid{color:var(--green-deep)}
td.st b{display:block;font-size:14px} td.st b.owe{color:#8a2a2a} td.st b.back{color:var(--warn)} td.st b.sq{color:var(--green-deep)}
tr.settled td{opacity:.86}
.hh{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.hh h2{margin-bottom:0;font-size:14px;text-transform:none;letter-spacing:0;color:var(--ink)} .hh h2 small{color:var(--faint);font-weight:500;text-transform:none;letter-spacing:0}
.hs{color:var(--dim);font-size:12px}
pre{background:var(--card2);border-radius:8px;padding:10px 12px;font-size:11.5px;overflow-x:auto;margin-top:8px}
</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="wordmark">Earn &amp; Protect <span>· holders · operator only</span></div>
</div></div>
<div class="wrap">
  <div class="card">
    <h1>Who locked what, and what is owed</h1>
    <div class="sub">Every lock on the record grouped by the key that took it. The credit is credited at lock in and owed to the holder from then; at settlement the floor is owed to them on a loss, and on a win above the cap the slice above it is owed back. Payments recorded with the cash route move each leg to paid and the holder's receipt follows. Aliases appear here and nowhere public.</div>
    <div class="bignums">
      <div class="bignum"><div class="n">${input.totals.locks}</div><div class="l">locks on the record</div></div>
      <div class="bignum"><div class="n${input.totals.toHolderCents > 0 ? "" : " green"}">${usd(input.totals.toHolderCents)}</div><div class="l">owed to holders</div></div>
      <div class="bignum"><div class="n">${usd(input.totals.toWriterCents)}</div><div class="l">owed back to the writer</div></div>
      <div class="bignum"><div class="n ${net > 0 ? "" : "green"}">${net >= 0 ? "" : "−"}${usd(Math.abs(net))}</div><div class="l">net ${net >= 0 ? "to pay out" : "to collect"}</div></div>
    </div>
  </div>
${sections}
${input.fingerprints ? lockFingerprintsCard(input.fingerprints) : ""}${
    input.inFull && input.inFull.lines > 0
      ? `  <div class="card">
    <h2>Real locks settled in full</h2>
    <div class="read">${input.inFull.lines} payment${input.inFull.lines === 1 ? " is" : "s are"} outstanding on real locks that have ended: ${usd(input.inFull.toHoldersCents)} to holders and ${usd(input.inFull.fromHoldersCents)} back from holders. If every one of them was made in full, press the button. It writes one line per payment, each at the amount the lock's terms owe, and the record page then shows them as paid and shows our result on the real locks. It cannot be undone: the ledger is append only.${input.inFull.left > 0 ? ` ${input.inFull.left} earlier lock${input.inFull.left === 1 ? "" : "s"} on a market that was locked again ${input.inFull.left === 1 ? "is" : "are"} left for the single route below.` : ""}</div>
    <form method="post" action="/api/shadow/cash/in-full" style="margin-top:10px"><button type="submit">Record all ${input.inFull.lines} as paid in full</button></form>
  </div>
`
      : ""
  }  <div class="card">
    <h2>Recording a payment</h2>
    <div class="read">Each payment is one line on the holder's ledger. Name the holder when the same game is locked by more than one.</div>
    <pre>curl -X POST "$SERVICE/api/shadow/cash" -H "x-admin-token: $TOKEN" -H "content-type: application/json" \\
  -d '{"ticker":"KX...","holder":"ann","leg":"credit","cents":150,"method":"venmo","ref":"..."}'</pre>
    <a class="back" href="/api/shadow/holders">Raw JSON</a> <a class="back" href="/venues">Venues</a> <a class="back" href="/healthz?as=operator">Status</a>
  </div>
  <footer>
    Operator view. Rendered ${escapeHtml(input.at.slice(0, 16).replace("T", " "))} UTC.
  </footer>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// VENUES — operator only. Every game on the record priced on every venue read, venues named.
// ---------------------------------------------------------------------------

export interface VenuesPageInput {
  breakdown: VenueBreakdown;
  pricingSource: { aggregator: AggregatorBookStatus | { configured: false }; notes: string[] };
  /** the held-books stream, when the worker holds one; null when the hold is off or the feed is */
  heldBooks?: HeldBooksStatus | null;
  windowDays: number;
}

/** A venue column's operator name, by id; the id itself when the window dropped the column. */
const venueNameOf = (b: VenueBreakdown, id: string): string => b.totals.find((t) => t.id === id)?.name ?? id;

/**
 * One read of one venue: credit, delta against the route written, EV cost, and for a reference its
 * best ask and depth, dated ("· 4m old") when the venue's snapshot was older than a route may price from.
 */
function venueReadHtml(c: VenueCell, written: boolean): string {
  if (!c.read) return "n/a";
  const age = c.ageSec !== null && c.ageSec > SHOW_AGE_FROM_SEC ? ` · ${ageWord(c.ageSec)} old` : "";
  const ask = c.bestAskCents !== null ? `<i>${c.bestAskCents}¢${c.depthShares !== null && c.depthShares > 0 ? ` × ${intStr(c.depthShares)}` : ""}${age}</i>` : "";
  const ids = venueListingHtml(c);
  if (c.creditCents === null) return `<span class="ref">${escapeHtml(c.refused ?? "refused")}</span>${ask}${ids}`;
  const delta = written || c.deltaCents === null ? "" : `<i class="${c.deltaCents > 0 ? "up" : c.deltaCents < 0 ? "dn" : ""}">${c.deltaCents > 0 ? "+" : ""}${usd(c.deltaCents)}</i>`;
  const ev = c.evCostBps === null ? "" : `<i>ev ${bpsPct(c.evCostBps)}</i>`;
  return `${usd(c.creditCents)}${delta}${ev}${ask}${ids}`;
}

/**
 * The listing a reference cell was read from, as ids: the venue's key (a strike id) when it has
 * one, else the aggregator's market id, with everything known in the tooltip. What to quote to
 * the feed about a "mapped, no book yet" instead of a game name.
 */
function venueListingHtml(c: VenueCell): string {
  const l = c.listing;
  if (!l) return "";
  const shown = l.key ?? l.marketId;
  const title = [`market ${l.marketId}`, l.key ? `key ${l.key}` : "", l.snapshotAtIso ? `snapshot ${l.snapshotAtIso}` : ""].filter(Boolean).join(" · ");
  return `<i class="tk" title="${escapeHtml(title)}">${escapeHtml(shown)}</i>`;
}

/**
 * A venue's cell: the open-time read, and under it the pre-lock read when the game has had one
 * ("T-2.0h") and the in-game read when it has had that ("T+20m"), each laid out the same way. The
 * written route's cell is highlighted at open; at the later reads the deltas are against that
 * same route as it priced then.
 */
function venueCellHtml(c: VenueCell, prelock: VenuePrelock | undefined, bookOpen: VenueBookOpen | undefined, inGame: VenueInGame | undefined, written: boolean): string {
  const open = venueReadHtml(c, written);
  if (!prelock && !bookOpen && !inGame) return `<td class="${written ? "hi" : ""}${!c.read || c.creditCents === null ? " ref" : ""}">${open}</td>`;
  const later = (read: VenuePrelock, label: string): string => {
    const pc = read.cells.find((x) => x.id === c.id);
    const body = read.unread !== null ? `<span class="ref">${escapeHtml(refusalWordForPage(read.unread))}</span>` : pc ? venueReadHtml(pc, written) : "n/a";
    return `<div class="rd pl"><b>${label}</b>${body}</div>`;
  };
  // in time order: the open-time read, the moment a held book opened, the fixed pre-lock read, then the in-game read
  const lines = [`<div class="rd">${open}</div>`];
  if (bookOpen) lines.push(later(bookOpen, `${bookOpen.opened.venue === c.id ? "opened" : "at open"} T-${bookOpen.hoursToLock}h`));
  if (prelock) lines.push(later(prelock, `T-${prelock.hoursToLock}h`));
  if (inGame) lines.push(later(inGame, `in play T+${inGame.minutesIn}m`));
  return `<td class="${written ? "hi" : ""}">${lines.join("")}</td>`;
}

/** the engine's structural refusal codes as the operator reads them on this page */
function refusalWordForPage(code: string): string {
  if (code === "market_too_close_to_start") return "too close to start";
  if (code === "market_not_active") return "market closed";
  if (code === "mark_out_of_range") return "odds out of range";
  if (code === "no_matched_market") return "no pairing";
  return code.replace(/_/g, " ");
}

export function renderVenuesHtml(input: VenuesPageInput): string {
  const b = input.breakdown;
  const ps = input.pricingSource.aggregator;
  const feedLine = ps.configured
    ? `The feed is on (${escapeHtml(ps.host)}, key …${escapeHtml(ps.keyIdTail)}, public key <code>${escapeHtml(ps.publicKeyHex)}</code>): ${ps.reads} reads since boot, ${ps.readsWithBooks} with books, ${ps.mappingMismatches} mapping mismatch${ps.mappingMismatches === 1 ? "" : "es"}${ps.lastError ? `; last error: ${escapeHtml(ps.lastError)}${/401|UNAUTHORIZED/i.test(ps.lastError) ? " (the partner rejects this key's signatures: compare the public key above with the one registered on their side, and the key id with the one issued)" : ""}` : ""}${ps.lastReadAt ? `; last read ${escapeHtml(shortEt(ps.lastReadAt))}` : ""}.`
    : "The feed is off: every book is read from its venue directly.";
  const originLine = `Of the ${b.positions} games in the window, ${b.origins.feed} priced from the feed, ${b.origins.direct} from the venues directly${b.origins.unknown > 0 ? `, ${b.origins.unknown} opened before the field existed (direct)` : ""}.`;

  const head = `<tr><th>game</th><th>side</th><th>locks</th><th>mark</th><th>written</th>${b.totals.map((t) => `<th>${escapeHtml(t.name)}${t.via === "feed" ? " <small>feed</small>" : ""}</th>`).join("")}</tr>`;
  const rows = b.rows
    .map((r) => {
      const origin = r.bookOrigins ? (r.bookOrigins.polymarket === "aggregator" || r.bookOrigins.kalshi === "aggregator" ? "feed" : "direct") : "";
      const routeName = r.route === "kalshi_self" ? "Kalshi" : "Polymarket";
      const mark = r.prelock && r.prelock.markCents !== null && r.prelock.markCents !== r.markCents ? `${r.markCents}¢<i>T-${r.prelock.hoursToLock}h ${r.prelock.markCents}¢</i>` : `${r.markCents}¢`;
      const openedTag = r.bookOpen ? ` · ${venueNameOf(b, r.bookOpen.opened.venue)} opened T-${r.bookOpen.hoursToLock}h${r.bookOpen.opened.caught === "at_hold" ? " (before the hold)" : ""}` : "";
      const inPlayTag = r.inGame
        ? r.inGame.unread !== null
          ? ` · in play T+${r.inGame.minutesIn}m: ${refusalWordForPage(r.inGame.unread)}`
          : ` · in play T+${r.inGame.minutesIn}m${r.inGame.markCents !== null ? ` mark ${r.inGame.markCents}¢` : ""}${r.inGame.protectedBook ? ` (${r.inGame.protectedBook.yesBidCents}/${r.inGame.protectedBook.yesAskCents})` : ""}`
        : "";
      return `<tr class="${r.status}"><td class="g"><b>${escapeHtml(r.eventTitle)}</b><i>${escapeHtml(r.league.toUpperCase())}${r.status !== "open" ? ` · ${escapeHtml(r.status)}` : ""}${origin ? ` · ${origin}` : ""}${r.prelock ? " · re-read" : ""}${escapeHtml(openedTag)}${escapeHtml(inPlayTag)}</i></td><td>${escapeHtml(r.sideName)}<i>${r.contracts} @ ${r.markCents}¢</i></td><td>${escapeHtml(shortEt(r.eventTimeIso))}</td><td>${mark}</td><td class="hi">${routeName}<i>floor ${r.floorCents}¢ · cap ${r.capCents}¢</i></td>${r.cells.map((c) => venueCellHtml(c, r.prelock, r.bookOpen, r.inGame, c.written)).join("")}</tr>`;
    })
    .join("");

  const totalsRows = b.totals
    .map(
      (t) =>
        `<tr><td class="g"><b>${escapeHtml(t.name)}</b><i>${t.via === "feed" ? "via the aggregator's feed" : "read directly"} · ${t.kind === "route" ? "hedge route" : "reference, never filled"}</i></td><td>${t.read}</td><td>${t.listed}</td><td>${t.quoted}</td><td>${t.kind === "route" ? t.written : "n/a"}</td><td class="hi">${t.best}</td><td>${t.avgDeltaCents === null ? "n/a" : `${t.avgDeltaCents > 0 ? "+" : ""}${usd(t.avgDeltaCents)}<i>over ${t.bothQuoted}</i>`}</td></tr>`,
    )
    .join("");

  // the pre-lock read, per venue, over the games that had one
  const prelockRows =
    b.prelock.read > 0
      ? b.totals
          .filter((t) => t.prelock.read > 0)
          .map(
            (t) =>
              `<tr><td class="g"><b>${escapeHtml(t.name)}</b><i>${t.via === "feed" ? "via the aggregator's feed" : "read directly"} · ${t.kind === "route" ? "hedge route" : "reference, never filled"}</i></td><td>${t.prelock.read}</td><td>${t.prelock.listed}</td><td>${t.prelock.quoted}</td><td class="hi">${t.prelock.best}</td><td>${t.prelock.avgDeltaCents === null ? "n/a" : `${t.prelock.avgDeltaCents > 0 ? "+" : ""}${usd(t.prelock.avgDeltaCents)}<i>over ${t.prelock.bothQuoted}</i>`}</td></tr>`,
          )
          .join("")
      : "";
  const prelockLine = (() => {
    if (b.prelock.read === 0 && b.prelock.unread === 0) return "No game has reached its pre-lock read yet; the first one inside the window begins this table.";
    const parts = [`${b.prelock.read} game${b.prelock.read === 1 ? "" : "s"} priced again before the lock${b.prelock.unread > 0 ? `; ${b.prelock.unread} could not be (the market had closed or the odds had left the range)` : ""}.`];
    const refs = b.totals.filter((t) => t.kind === "reference" && t.prelock.read > 0);
    for (const t of refs) {
      parts.push(
        `${t.name}${t.via === "feed" ? " (feed)" : ""} listed ${t.prelock.listed} of ${t.prelock.read} at the pre-lock read and would have funded ${t.prelock.quoted}; cheapest on ${t.prelock.best}${
          t.prelock.avgDeltaCents === null ? "" : `, ${t.prelock.avgDeltaCents >= 0 ? "+" : "-"}${usd(Math.abs(t.prelock.avgDeltaCents))} credit against the route written as it priced then, over ${t.prelock.bothQuoted}`
        }.`,
      );
    }
    return parts.join(" ");
  })();

  // the book-open read, per venue, over the games whose held book the record caught opening
  const bookOpenRows =
    b.bookOpen.read > 0
      ? b.totals
          .filter((t) => t.bookOpen.read > 0)
          .map(
            (t) =>
              `<tr><td class="g"><b>${escapeHtml(t.name)}</b><i>${t.via === "feed" ? "via the aggregator's feed" : "read directly"} · ${t.kind === "route" ? "hedge route" : "reference, never filled"}</i></td><td>${t.bookOpen.read}</td><td>${t.bookOpen.listed}</td><td>${t.bookOpen.quoted}</td><td class="hi">${t.bookOpen.best}</td><td>${t.bookOpen.avgDeltaCents === null ? "n/a" : `${t.bookOpen.avgDeltaCents > 0 ? "+" : ""}${usd(t.bookOpen.avgDeltaCents)}<i>over ${t.bookOpen.bothQuoted}</i>`}</td></tr>`,
          )
          .join("")
      : "";
  const bookOpenLine = (() => {
    const bo = b.bookOpen;
    const hb = input.heldBooks;
    const holding = hb ? ` The stream is ${hb.connected ? "connected" : "not connected"}${hb.stopped ? ` (stopped: ${hb.stopped})` : ""}, holding ${hb.held} book${hb.held === 1 ? "" : "s"}: ${hb.byPhase.open} open, ${hb.byPhase.empty} mapped with no book yet, ${hb.byPhase.not_yet_open} outside the feed's window, ${hb.byPhase.unavailable} unavailable, ${hb.byPhase.pending} pending${hb.byPhase.closed + hb.byPhase.stopped > 0 ? `, ${hb.byPhase.closed + hb.byPhase.stopped} ended` : ""}${hb.lastError ? `; last error: ${hb.lastError}` : ""}.` : "";
    if (bo.read === 0 && bo.unread === 0) return `No held book has opened yet; the first one begins this table.${holding}`;
    const parts = [
      `${bo.read + bo.unread} game${bo.read + bo.unread === 1 ? "" : "s"} caught a reference book opening: ${bo.live} seen live, ${bo.atHold} already open when the hold began${bo.avgHoursToLock === null ? "" : `; on average ${bo.avgHoursToLock}h before the lock${bo.avgHoursToLockLive !== null && bo.live > 0 ? ` (${bo.avgHoursToLockLive}h for the ones seen live)` : ""}`}${bo.unread > 0 ? `; ${bo.unread} could not then be priced (the market had closed or the odds had left the range)` : ""}.`,
    ];
    for (const t of b.totals.filter((t) => t.kind === "reference" && t.bookOpen.read > 0)) {
      parts.push(
        `${t.name}${t.via === "feed" ? " (feed)" : ""} listed ${t.bookOpen.listed} of ${t.bookOpen.read} at that moment and would have funded ${t.bookOpen.quoted}; cheapest on ${t.bookOpen.best}${
          t.bookOpen.avgDeltaCents === null ? "" : `, ${t.bookOpen.avgDeltaCents >= 0 ? "+" : "-"}${usd(Math.abs(t.bookOpen.avgDeltaCents))} credit against the route written as it priced then, over ${t.bookOpen.bothQuoted}`
        }.`,
      );
    }
    return parts.join(" ") + holding;
  })();

  // the in-game read, per venue, over the games that had one
  const inGameRows =
    b.inGame.read > 0
      ? b.totals
          .filter((t) => t.inGame.read > 0)
          .map(
            (t) =>
              `<tr><td class="g"><b>${escapeHtml(t.name)}</b><i>${t.via === "feed" ? "via the aggregator's feed" : "read directly"} · ${t.kind === "route" ? "hedge route" : "reference, never filled"}</i></td><td>${t.inGame.read}</td><td>${t.inGame.listed}</td><td>${t.inGame.quoted}</td><td class="hi">${t.inGame.best}</td><td>${t.inGame.avgDeltaCents === null ? "n/a" : `${t.inGame.avgDeltaCents > 0 ? "+" : ""}${usd(t.inGame.avgDeltaCents)}<i>over ${t.inGame.bothQuoted}</i>`}</td></tr>`,
          )
          .join("")
      : "";
  const inGameLine = (() => {
    const ig = b.inGame;
    if (ig.read === 0 && ig.unread === 0) return "No game has reached its in-game read yet; the first one priced in play begins this table.";
    const parts = [
      `${ig.read + ig.unread} game${ig.read + ig.unread === 1 ? "" : "s"} priced again in play${ig.avgMinutesIn === null ? "" : `, on average ${ig.avgMinutesIn} minutes after the start`}${ig.avgSpreadCents === null ? "" : `; the locked market's own spread averaged ${ig.avgSpreadCents}¢ then`}${ig.unread > 0 ? `; ${ig.unread} could not be priced (the market had closed on the result or the odds had left the range)` : ""}.`,
    ];
    const funded = b.totals.filter((t) => t.inGame.read > 0);
    for (const t of funded) {
      parts.push(
        `${t.name}${t.via === "feed" ? " (feed)" : ""} listed ${t.inGame.listed} of ${t.inGame.read} in play and would have funded ${t.inGame.quoted}; cheapest on ${t.inGame.best}${
          t.inGame.avgDeltaCents === null ? "" : `, ${t.inGame.avgDeltaCents >= 0 ? "+" : "-"}${usd(Math.abs(t.inGame.avgDeltaCents))} credit against the route written as it priced then, over ${t.inGame.bothQuoted}`
        }.`,
      );
    }
    return parts.join(" ");
  })();

  const richestLine = (() => {
    const quotedRefs = b.totals.filter((t) => t.kind === "reference" && t.quoted > 0);
    if (b.positions === 0) return "No sports game has been priced on more than one route yet; the next scan that quotes a game begins the table.";
    const parts = [`The record wrote ${b.totals.find((t) => t.id === "kalshi_self")?.written ?? 0} games on Kalshi's own No side and ${b.totals.find((t) => t.id === "polymarket")?.written ?? 0} cross-venue on Polymarket.`];
    for (const t of quotedRefs) {
      parts.push(
        `${t.name}${t.via === "feed" ? " (feed)" : ""} listed ${t.listed} of the ${t.read} games it was read for and would have funded ${t.quoted}; it was the cheapest lock on ${t.best}${
          t.avgDeltaCents === null ? "" : `, and on the ${t.bothQuoted} games both quoted it would have paid ${t.avgDeltaCents >= 0 ? "" : "-"}${usd(Math.abs(t.avgDeltaCents))} ${t.avgDeltaCents >= 0 ? "more" : "less"} credit per position than the route written`
        }.`,
      );
    }
    const readNotQuoted = b.totals.filter((t) => t.kind === "reference" && t.read > 0 && t.quoted === 0);
    for (const t of readNotQuoted) parts.push(`${t.name}${t.via === "feed" ? " (feed)" : ""} was read for ${t.read} games and listed ${t.listed}; none funded the live size.`);
    return parts.join(" ");
  })();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<link rel="icon" href="data:," />
<title>Venues · operator · Earn &amp; Protect</title>
<style>${SHADOW_CSS}
.wrap,.topbar .in{max-width:1180px}
@media(min-width:700px){.wrap,.topbar .in{max-width:1180px}}
td.g{text-align:left;white-space:normal;min-width:180px}
td i{display:block;color:var(--faint);font-style:normal;font-size:11px;font-weight:500}
td i.tk{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:var(--faint);opacity:.8}
td i.up{color:var(--green-deep)} td i.dn{color:#8a2a2a}
td.ref,td .ref{color:var(--faint)}
td .rd.pl{margin-top:4px;padding-top:3px;border-top:1px dashed var(--line,#ddd)}
td .rd.pl b{display:block;font-size:9px;font-weight:600;color:var(--faint);letter-spacing:.04em}
tr.settled td,tr.closed td{opacity:.72}
th small{display:block;font-size:9px;color:var(--faint);letter-spacing:.04em}
</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="wordmark">Earn &amp; Protect <span>· venues · operator only</span></div>
</div></div>
<div class="wrap">
  <div class="card">
    <h1>Where each game could have been hedged</h1>
    <div class="sub">Every sports position on the record is priced, at open, on both hedge routes and on every other venue the service read, from the same books at the same second. The record writes the cheaper route; the rest are measured and never filled. Each game is priced again the same way a fixed time before its lock, when every venue that will list it has; that read sits under the open-time read, never in its place. This page names the venues. It answers only to the operator token and is never published; the public record says "the market's own No side" and "reference book B".</div>
    <div class="bignums">
      <div class="bignum"><div class="n green">${b.positions}</div><div class="l">games priced, last ${input.windowDays} days</div></div>
      <div class="bignum"><div class="n">${b.origins.feed}</div><div class="l">priced from the feed</div></div>
      <div class="bignum"><div class="n">${b.totals.filter((t) => t.kind === "reference" && (t.quoted > 0 || t.prelock.quoted > 0)).length}</div><div class="l">other venues that funded a game</div></div>
      <div class="bignum"><div class="n">${b.prelock.read}</div><div class="l">priced again before the lock</div></div>
      <div class="bignum"><div class="n">${b.bookOpen.read + b.bookOpen.unread}</div><div class="l">caught a book opening</div></div>
      <div class="bignum"><div class="n">${b.inGame.read}</div><div class="l">priced again in play</div></div>
      <div class="bignum"><div class="n">${ps.configured ? "on" : "off"}</div><div class="l">aggregator feed</div></div>
    </div>
    <div class="read" style="margin-top:10px">${feedLine} ${escapeHtml(originLine)}</div>
    ${input.pricingSource.notes.length > 0 ? `<div class="rule">${escapeHtml(input.pricingSource.notes.join(" · "))}</div>` : ""}
  </div>

  <div class="card">
    <h2>By venue</h2>
    <div class="tablewrap"><table><tr><th>venue</th><th>read</th><th>listed</th><th>funded</th><th>written</th><th>cheapest</th><th>credit vs written</th></tr>${totalsRows}</table></div>
    <div class="read">${escapeHtml(richestLine)}</div>
    <div class="rule">Read: the venue was looked at for the game. Listed: it had a book on the opposing outcome. Funded: that book filled the default tier at the live size. Written: the record hedged there. Cheapest: its book made the lock cheapest in EV terms of every book that funded, which is how the record picks its route; a richer credit with a lower floor can lose on that measure. Credit vs written: on games both quoted, this venue's credit minus the credit written, averaged.</div>
  </div>

  <div class="card">
    <h2>By venue, at the pre-lock read</h2>
    ${prelockRows ? `<div class="tablewrap"><table><tr><th>venue</th><th>read</th><th>listed</th><th>funded</th><th>cheapest</th><th>credit vs written</th></tr>${prelockRows}</table></div>` : ""}
    <div class="read">${escapeHtml(prelockLine)}</div>
    <div class="rule">The same columns from the pre-lock read: the game priced again on every venue a fixed time before its lock, at the position's size and that moment's mark. Credit vs written here is against the route written as it priced at that same read, so both sides move with the game. Nothing on this table was filled; the terms written at open stand.</div>
  </div>

  <div class="card">
    <h2>By venue, the moment a book opened</h2>
    ${bookOpenRows ? `<div class="tablewrap"><table><tr><th>venue</th><th>read</th><th>listed</th><th>funded</th><th>cheapest</th><th>credit vs written</th></tr>${bookOpenRows}</table></div>` : ""}
    <div class="read">${escapeHtml(bookOpenLine)}</div>
    <div class="rule">For every open game inside the hold window the record keeps a subscription on the feed for each reference venue's book on the opposing outcome. The first time that book shows a level, the game is priced again on every venue at that second, exactly as at the pre-lock read. "Seen live" means the first level arrived while the subscription was held; "already open" means the book had levels at the hold's first snapshot, so the venue opened earlier than the hold window. Nothing on this table was filled.</div>
  </div>

  <div class="card">
    <h2>By venue, in play</h2>
    ${inGameRows ? `<div class="tablewrap"><table><tr><th>venue</th><th>read</th><th>listed</th><th>funded</th><th>cheapest</th><th>credit vs written</th></tr>${inGameRows}</table></div>` : ""}
    <div class="read">${escapeHtml(inGameLine)}</div>
    <div class="rule">The same columns a fixed number of minutes after the start, while the game is in play: which venues still carry a book on the opposing outcome, what the default tier would pay from those books at the position's size, and the locked market's own bid and ask at that minute (on each game's row). This is the measurement an in-play lock would need before anyone is offered it; the lock itself still closes 45 minutes before the start. Nothing on this table was filled, and the public record does not carry it.</div>
  </div>

  <div class="card">
    <h2>By game</h2>
    <div class="sub" style="margin-bottom:6px">Open games first, next to lock first; then settled, most recent first. Each venue cell is the credit the default tier would have paid from that book, the difference against the credit written, and for reference books the best ask on the opposing outcome and its visible depth in shares. A game that has had its pre-lock read shows that read under the open-time one, marked by the hours it was taken before the lock; a game whose held book was caught opening shows that read too, marked "opened" on the venue that opened; a game priced again in play shows that read last, marked by the minutes after the start.</div>
    <div class="tablewrap"><table>${head}${rows}</table></div>
    ${b.rows.length === 0 ? `<div class="read">Nothing in the window yet.</div>` : ""}
    <a class="back" href="/report">Rule comparison</a> <a class="back" href="/api/shadow/venues">Raw JSON</a> <a class="back" href="/api/shadow/venues.csv${input.windowDays !== 7 ? `?days=${input.windowDays}` : ""}">Every read with listing ids (CSV)</a> <a class="back" href="/api/shadow/venues/catalog?league=nba">What reference books A and D list for a league (JSON)</a> <a class="back" href="/healthz?as=operator">Status</a>
  </div>
  <footer>
    Operator view. Venue names appear here and nowhere public. Nothing on this page was traded except the route written. Rendered ${escapeHtml(b.atIso.slice(0, 16).replace("T", " "))} UTC.
  </footer>
</div>
</body>
</html>`;
}

/**
 * The pilot switch check as a page (pilotCheck.ts): one row per condition, the answer in words,
 * what was read, and what to confirm by hand. Operator only. Every word is the report's own; the
 * page adds none, so the JSON and the page cannot disagree.
 */
export function renderPilotCheckHtml(input: { report: PilotReport; at: string }): string {
  const r = input.report;
  const cls = (a: string): string => (a === "yes" ? "yes" : a === "no" ? "no" : "hand");
  const rows = r.items
    .map(
      (i) =>
        `<tr class="${cls(i.answer)}"><td class="n">${i.n}</td><td class="c"><b>${escapeHtml(i.condition)}</b><i>${escapeHtml(i.detail)}</i>${i.confirm ? `<i class="confirm">To confirm by hand: ${escapeHtml(i.confirm)}</i>` : ""}</td><td class="a"><b>${escapeHtml(i.answer)}</b></td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<link rel="icon" href="data:," />
<title>Pilot check · operator · Earn &amp; Protect</title>
<style>${SHADOW_CSS}
.wrap,.topbar .in{max-width:1000px}
@media(min-width:700px){.wrap,.topbar .in{max-width:1000px}}
td{white-space:normal;vertical-align:top;text-align:left}
td.n{color:var(--faint);width:28px}
td.c b{display:block;font-size:13.5px}
td.c i{display:block;color:var(--dim);font-style:normal;font-size:12px;font-weight:500;margin-top:4px;line-height:1.45}
td.c i.confirm{color:var(--ink)}
td.a{width:170px} td.a b{font-size:13px}
tr.yes td.a b{color:var(--green-deep)} tr.no td.a b{color:#8a2a2a} tr.hand td.a b{color:var(--warn)}
.overall{font-size:15px;font-weight:700;margin-top:10px}
.overall.no{color:#8a2a2a} .overall.yes{color:var(--green-deep)}
</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="wordmark">Earn &amp; Protect <span>· pilot check · operator only</span></div>
</div></div>
<div class="wrap">
  <div class="card">
    <h1>Before an outside holder</h1>
    <div class="sub">${escapeHtml(r.note)}</div>
    <div class="overall ${r.ready}">${escapeHtml(r.overall)}</div>
    <div class="rule">Read ${escapeHtml(shortEt(input.at))}. Settings are read when the service starts, so this is the service as it is running now.</div>
  </div>
  <div class="card">
    <div class="tablewrap"><table><tr><th>#</th><th>condition</th><th>answer</th></tr>${rows}</table></div>
    <a class="back" href="/api/shadow/pilot-check">Raw JSON</a> <a class="back" href="/holders">Holders</a> <a class="back" href="/healthz?as=operator">Status</a>
  </div>
</div>
</body>
</html>`;
}

/**
 * THE CAPITAL MODEL (capitalModel.ts), for the operator: what each settlement shape ties up of
 * our own money, read off the record's own lines and times. Operator only: it names hedge routes.
 */
export function renderCapitalHtml(input: { model: CapitalModel }): string {
  const m = input.model;
  const n = (x: number): string => x.toLocaleString("en-US");
  const lagWords = (h: number): string => (h === 0 ? "paid back at the result" : `paid back ${h} hours after the result`);
  const held = (mins: number | null): string => (mins === null ? "n/a" : mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`);
  const shapeRows = (name: string, s: CapitalShape): string =>
    s.byLag
      .map(
        (l, i) =>
          `<tr><td class="c">${i === 0 ? `<b>${escapeHtml(name)}</b>` : ""}<i>${escapeHtml(lagWords(l.lagHours))}</i></td>${l.atMultiple.map((x) => `<td>${usd(x.peakCents)}</td>`).join("")}<td>${usd(l.averageCents)}</td><td>${usd(l.nowCents)}</td><td class="when">${l.peakAt ? escapeHtml(shortEt(l.peakAt)) : "n/a"}</td></tr>`,
      )
      .join("");
  const zero = `<tr><td class="c"><b>Own sale</b><i>the holder sells in their own account</i></td>${m.collar.byLag[0].atMultiple.map(() => `<td>${usd(0)}</td>`).join("")}<td>${usd(0)}</td><td>${usd(0)}</td><td class="when">n/a</td></tr>`;
  const heads = m.collar.byLag[0].atMultiple.map((x) => `<th>${x.multiple === 1 ? "most out at once, record volume" : `at ${x.multiple} times`}</th>`).join("");
  const bb = m.betterBid;
  const measured =
    bb.linesMeasured === 0
      ? `<div class="read">Better bid, measured: no line carries the measurement yet. It is written on every new line once the own sale and better bid measurement is deployed, and this table gains a row from the first line that finds one.</div>`
      : bb.measured.lines === 0
        ? `<div class="read">Better bid, measured: ${n(bb.linesMeasured)} lines carry the measurement and none of them found a better bid.</div>`
        : `<div class="read">Better bid, measured: a better bid was found on ${n(bb.measured.lines)} of the ${n(bb.linesMeasured)} lines that carry the measurement. Those lines would have paid ${usd(bb.measured.outlayCents)} at the two venues in all, for a take of ${usd(bb.measured.takeCents)}.</div>`;
  const routes = m.collar.byRoute.map((r) => `<tr><td class="c"><b>${escapeHtml(r.route)}</b></td><td>${n(r.lines)}</td><td>${usd(r.peakCents)}</td></tr>`).join("");
  const since = m.record.since ? `since ${escapeHtml(shortEt(m.record.since))} (${n(m.record.days)} days)` : "no lines yet";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<link rel="icon" href="data:," />
<title>Capital · operator · Earn &amp; Protect</title>
<style>${SHADOW_CSS}
.wrap,.topbar .in{max-width:1000px}
@media(min-width:700px){.wrap,.topbar .in{max-width:1000px}}
td.c{white-space:normal;text-align:left;vertical-align:top}
td.c b{display:block;font-size:13.5px}
td.c i{display:block;color:var(--dim);font-style:normal;font-size:12px;font-weight:500;line-height:1.45}
td.when{color:var(--dim)}
ul.notes{margin:8px 0 0 18px;color:var(--ink);font-size:13px;line-height:1.55}
ul.notes li{margin-top:5px}
</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="wordmark">Earn &amp; Protect <span>· capital · operator only</span></div>
</div></div>
<div class="wrap">
  <div class="card">
    <h1>Our own money, by settlement shape</h1>
    <div class="sub">How much each shape would have had out at once on the record's own lines: when each opened, when it ended, and what it would have paid. Simulated, like the record. Nothing was bought.</div>
    <div class="rule">${n(m.record.counted)} lines counted, ${since}. Left out: ${n(m.record.voided)} voided, ${n(m.record.memberSales)} member sales (those are own sales already). Read ${escapeHtml(shortEt(m.at))}.</div>
  </div>
  <div class="card">
    <div class="tablewrap"><table><tr><th>shape</th>${heads}<th>average out</th><th>out now</th><th>the most was out</th></tr>
${zero}
${shapeRows("Better bid, ceiling", bb.ceiling)}
${bb.measured.lines > 0 ? shapeRows("Better bid, measured", bb.measured) : ""}
${shapeRows("Collar, our book", m.collar)}
    </table></div>
    ${measured}
  </div>
  <div class="card">
    <h1>How to read it</h1>
    <ul class="notes">
      <li><b>Own sale</b> uses none of our money. The holder sells part of the position to their own venue's bids. We pay nothing and are owed nothing.</li>
      <li><b>Better bid, ceiling</b> counts every one of the ${n(bb.ceiling.lines)} lines at $1 for each contract sold. A better bid cannot cost more: it is only made when the $1 the pair pays covers what the pair cost. Not every line has a better bid, so the true figure is lower. The pair is held until the game settles; a finished line had its money out for ${held(bb.ceiling.medianMinutesHeld)} at the median.</li>
      <li><b>Collar, our book</b> is today's shape with us as the writer: the hedge bought at lock in, venue fees included, plus the credit owed to the holder from lock in. ${n(m.collar.lines)} lines paid out ${usd(m.collar.outlayCents)} in all, for a take of ${usd(m.collar.takeCents)} over ${n(m.record.days)} days. On a win the cap slice is then owed to us by the holder, which this does not count as money out.</li>
      <li><b>Paid back after the result.</b> Venues pay some time after the result and the record does not measure how long. The second line of each shape assumes ${m.collar.byLag.length > 1 ? m.collar.byLag[1].lagHours : 24} hours. That is an assumption.</li>
      <li><b>At 10 and 100 times</b> every line is that many times larger and the timing is the same. It is the money needed if the order books hold that size at those prices, which this does not measure.</li>
      <li><b>One pool.</b> The figures treat all venues as one pot. Cash has to sit on each venue before the trade, so funding each venue for its own busiest moment takes more: ${usd(m.collar.sumOfRoutePeaksCents)} for the collar against ${usd(m.collar.byLag[0].peakCents)} pooled. A better bid needs cash on two venues for each line; that split is not modelled.</li>
      ${bb.ceiling.endEstimated > 0 ? `<li><b>Lines the holder left early</b> (${n(bb.ceiling.endEstimated)}) have no settlement time on the record. Under a better bid the pair would still be held, so each is counted until its game's start plus ${held(m.medianStartToSettleMinutes)}, the median from start to settlement on the lines that settled.</li>` : ""}
    </ul>
  </div>
  <div class="card">
    <h1>Collar, by hedge route</h1>
    <div class="sub">The most out at once on each route, paid back at the result.</div>
    <div class="tablewrap"><table><tr><th>route</th><th>lines</th><th>most out at once</th></tr>${routes}</table></div>
    <a class="back" href="/api/shadow/capital">Raw JSON</a> <a class="back" href="/pilot-check">Pilot check</a> <a class="back" href="/holders">Holders</a>
  </div>
</div>
</body>
</html>`;
}
