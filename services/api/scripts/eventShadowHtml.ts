/**
 * Shadow record page — the public face of the event shadow run.
 *
 * Renders the replayed ledger: settled events marked against official Kalshi
 * results, the open book, and the honest aggregate (protection usually costs
 * a little; the floor is what it buys). Same visual language as the demo and
 * receipts pages. Server-rendered, no client JS.
 */

import type { ShadowPosition, ShadowSummary } from "../src/eventCollar/crossVenue/shadowLedger";

/** Public URL of the interactive demo, for the cross-link. */
function demoUrl(): string {
  return process.env.EVENT_SHADOW_DEMO_URL || "https://event.earnandprotect.xyz";
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
}

export function renderShadowHtml(input: ShadowPageInput): string {
  const s = input.summary;
  const settledRows = input.settled
    .slice(0, 25)
    .map((p) => {
      const saved = p.result === "no";
      const tag = saved ? '<span class="tag save">floor paid</span>' : '<span class="tag">won, capped</span>';
      return (
        `<div class="row"><span>${escapeHtml(p.sideName)} ${tag}</span>` +
        `<b>${usd(p.protectedCents ?? 0)} <i>vs ${usd(p.nakedCents ?? 0)} naked</i></b></div>`
      );
    })
    .join("");
  const openRows = input.open
    .slice(0, 25)
    .map(
      (p) =>
        `<div class="row"><span>${escapeHtml(p.sideName)} · locks ${escapeHtml(shortEt(p.eventTimeIso))}</span>` +
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
  const routeRows = Object.entries(s.routeSplit)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([route, n]) =>
        `<div class="row"><span>${route === "kalshi_self" ? "hedged on the market's own No side (Kalshi)" : "hedged cross-venue (Polymarket)"}</span><b>${n}</b></div>`,
    )
    .join("");
  const windowLine = s.firstOpenedAt
    ? `Recording since ${escapeHtml(s.firstOpenedAt.slice(0, 16).replace("T", " "))} UTC. Append-only; positions are never edited, only opened and settled.`
    : "The book is empty; it fills as the scanner finds quotable events.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:," />
<title>Shadow record · Earn &amp; Protect · events</title>
<meta name="description" content="A continuous simulated run of the protection engine, marked against official results as events settle." />
<style>
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
.bignums{display:flex;gap:10px;margin-top:14px}
.bignum{flex:1;background:var(--card2);border-radius:10px;padding:12px;text-align:center}
.bignum .n{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.bignum .n.green{color:var(--green)}
.bignum .l{color:var(--dim);font-size:11.5px;margin-top:2px}
h2{font-size:12px;color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;font-size:13.5px;color:var(--dim);font-variant-numeric:tabular-nums;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}
.row b{color:var(--ink);font-weight:650;text-align:right}
.row b i{color:var(--faint);font-style:normal;font-weight:500;font-size:12px}
.tag{display:inline-block;background:var(--card2);color:var(--dim);border-radius:6px;padding:1px 6px;font-size:10.5px;font-weight:600;vertical-align:1px}
.tag.save{background:var(--green-wash);color:var(--green-deep)}
.back{display:inline-block;margin-top:2px;color:var(--green-deep);font-weight:600;font-size:13px;text-decoration:underline}
footer{color:var(--faint);font-size:11.5px;line-height:1.55;padding:14px 4px 0}
footer b{color:var(--dim);font-weight:600}
@media(min-width:700px){.wrap,.topbar .in{max-width:480px}}
</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="wordmark">Earn &amp; Protect <span>· shadow record</span></div>
</div></div>
<div class="wrap">
  <div class="card">
    <h1>Shadow record</h1>
    <div class="sub">A continuous simulated run of the protection engine. Every quotable event is protected at its live quoted terms, then marked against the official result when the market settles. Simulated fills at live venue quotes; nothing is bought.</div>
    <div class="bignums">
      <div class="bignum"><div class="n green">${s.settledCount}</div><div class="l">events settled</div></div>
      <div class="bignum"><div class="n">${s.floorSaves}</div><div class="l">floor saves</div></div>
      <div class="bignum"><div class="n green">${s.openCount}</div><div class="l">open now</div></div>
    </div>
  </div>
  <div class="card">
    <h2>Settled, most recent first</h2>
    ${settledRows || '<div class="row"><span>nothing settled yet</span><b>the book is young</b></div>'}
  </div>
  <div class="card">
    <h2>The honest aggregate</h2>
    <div class="row"><span>with protection, settled total</span><b>${usd(s.protectedTotalCents)}</b></div>
    <div class="row"><span>without protection, settled total</span><b>${usd(s.nakedTotalCents)}</b></div>
    <div class="row"><span>realized</span><b>${escapeHtml(realizedLine)}</b></div>
    <div class="row"><span>quoted cost of protection</span><b>${escapeHtml(quotedLine)}</b></div>
    ${routeRows}
    ${s.voidCount > 0 ? `<div class="row"><span>voided (no official result)</span><b>${s.voidCount}</b></div>` : ""}
  </div>
  <div class="card">
    <h2>Open book</h2>
    ${openRows || '<div class="row"><span>no open positions</span><b>next scan fills the board</b></div>'}
    <a class="back" href="${demoUrl()}">back to the live board</a>
  </div>
  <footer>
    <b>What is real:</b> the venues' live prices, the quoted terms, and the official results. <b>What is simulated:</b> the positions; no venue credentials, no wallets. Protection usually costs a little; the floor saves are what it buys. ${escapeHtml(windowLine)} Rendered ${escapeHtml(input.atIso.slice(0, 16).replace("T", " "))} UTC. Demonstration, not an offer. <a class="back" href="/api/shadow">Raw JSON</a>
  </footer>
</div>
</body>
</html>`;
}
