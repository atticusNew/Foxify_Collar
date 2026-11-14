/**
 * Listing mockup: how the Lock button sits on a marketplace listing card, and
 * the sheet a seller sees after the tap. Two phone frames, rendered from one
 * quoted row (listingQuote.ts) so the morning rerun keeps the numbers current.
 *
 * The card is a generic listing card in the host's colours: their legs, their
 * ask, their "Make bid"; ours is the one extra button and the sheet. Retail
 * copy on the phone is outcomes, never mechanics (no venue names, no "hedge");
 * the caption beside the frames speaks to the partner and may.
 *
 * Static HTML, no script, no network. Screenshot with headless Chrome for the
 * PNG that travels with the sheet.
 */

import type { ListingLockTerms, ListingQuoteRow } from "../src/eventCollar/crossVenue/listingQuote";
import { fmtUsd, fmtUsdShort } from "../src/eventCollar/crossVenue/listingQuote";

export interface ListingMockOptions {
  /** the marketplace's name on the shell */
  brand: string;
  accent?: string;
  accentInk?: string;
  /** when the sheet was priced, ISO; printed in the caption */
  atIso: string;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The row to draw: the one whose lock beats the ask, else the quoted row with the highest worst case. */
export function pickMockRow(rows: readonly ListingQuoteRow[]): ListingQuoteRow | null {
  const quoted = rows.filter((r): r is ListingQuoteRow & { quote: ListingLockTerms } => r.quote.ok);
  if (quoted.length === 0) return null;
  const beats = quoted.filter((r) => r.lockBeatsAsk);
  const pool = beats.length ? beats : quoted;
  return pool.reduce((a, b) => (b.quote.lockWorstCents > a.quote.lockWorstCents ? b : a));
}

export function renderListingMockHtml(row: ListingQuoteRow, opts: ListingMockOptions): string {
  if (!row.quote.ok) throw new Error("listing mock: the row must be quoted");
  const q = row.quote;
  const leg = row.remaining[0];
  const accent = opts.accent ?? "#02FDDD";
  const ink = opts.accentInk ?? "#0f1115";
  const brand = esc(opts.brand);
  const ticket = row.legsTotal === 1 ? `${esc(row.book)} Single` : `${esc(row.book)} ${row.legsTotal}-Leg Parlay`;
  const hit = row.hitLegs.map((l) => `<li class="hit"><span class="tick">&#x2713;</span><div><b>${esc(l.label)}</b><small>${esc(l.market)}</small></div></li>`).join("");
  const remaining = `<li class="live"><span class="dot"></span><div><b>${esc(leg.label)}</b><small>${esc(leg.market)}</small></div></li>`;
  const bid = row.bidCents === null ? "--" : fmtUsd(row.bidCents);
  const month = new Date(row.resolvesIso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const at = opts.atIso.replace("T", " ").slice(0, 16);
  const out = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${brand} · Lock on a listing</title>
<style>
:root{--bg:#0f1115;--card:#171a20;--card2:#1e222a;--line:#2a2f38;--ink:#f3f5f7;--dim:#9aa3ad;--faint:#6b7480;--accent:${accent};--accent-ink:${ink};--good:#3ddc97}
*{box-sizing:border-box}
body{margin:0;background:#e9ebee;font:15px/1.45 -apple-system,"Segoe UI",Inter,Helvetica,Arial,sans-serif;color:#1a1a1a}
.wrap{max-width:1180px;margin:0 auto;padding:36px 28px 44px}
h1{font-size:24px;margin:0 0 6px;color:#0a0a0a}
.sub{color:#444;margin:0 0 26px;max-width:860px}
.row{display:flex;gap:28px;align-items:flex-start;flex-wrap:wrap}
.phone{width:372px;background:var(--bg);color:var(--ink);border-radius:34px;padding:14px;box-shadow:0 18px 50px rgba(0,0,0,.25);position:relative;flex:none}
.screen{background:var(--bg);border-radius:24px;overflow:hidden;min-height:660px;position:relative}
.top{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px;border-bottom:1px solid var(--line)}
.brand{font-weight:800;letter-spacing:.2px;display:flex;align-items:center;gap:8px}
.brand i{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:7px;background:var(--accent);color:var(--accent-ink);font-style:normal;font-weight:900;font-size:13px}
.tab{color:var(--dim);font-size:12px}
.card{margin:14px;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px}
.kicker{display:flex;justify-content:space-between;color:var(--dim);font-size:12px;margin-bottom:6px}
.title{font-size:17px;font-weight:800;margin:0 0 10px}
.facts{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;margin:10px 0 12px}
.facts div{background:var(--card2);border-radius:10px;padding:8px 10px}
.facts small{display:block;color:var(--dim);font-size:11px}
.facts b{font-size:15px}
ul{list-style:none;margin:0;padding:0}
li{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid var(--line)}
li small{display:block;color:var(--dim);font-size:12px}
.tick{color:var(--good);font-weight:900;width:18px;text-align:center}
.dot{width:10px;height:10px;border-radius:50%;background:var(--accent);margin:6px 4px 0;box-shadow:0 0 0 4px rgba(2,253,221,.15)}
.btns{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
.btn{border:1px solid var(--line);background:var(--card2);color:var(--ink);border-radius:12px;padding:12px 10px;text-align:center;font-weight:700;font-size:14px}
.btn.lock{grid-column:1 / -1;background:var(--accent);color:var(--accent-ink);border-color:var(--accent);display:flex;flex-direction:column;align-items:center;gap:2px;padding:11px 14px;font-size:16px;font-weight:800}
.btn.lock small{font-weight:600;font-size:12px;opacity:.85}
.ours{position:absolute;right:-6px;top:-10px;background:#fff;color:#0a0a0a;font-size:11px;font-weight:800;padding:3px 8px;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.note{color:var(--faint);font-size:11px;padding:0 16px 14px}
.scrim{position:absolute;inset:0;background:rgba(0,0,0,.55)}
.sheet{position:absolute;left:0;right:0;bottom:0;background:var(--card);border-radius:22px 22px 0 0;padding:16px 16px 18px;border-top:1px solid var(--line)}
.grab{width:42px;height:4px;border-radius:2px;background:var(--line);margin:0 auto 12px}
.sheet h2{font-size:18px;margin:0 0 2px}
.sheet .lead{color:var(--dim);font-size:13px;margin:0 0 12px}
.ends{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0 0 12px}
.ends div{background:var(--card2);border-radius:12px;padding:10px 12px}
.ends small{display:block;color:var(--dim);font-size:11px;margin-bottom:2px}
.ends b{font-size:19px}
.now{display:flex;justify-content:space-between;align-items:center;background:rgba(2,253,221,.08);border:1px solid rgba(2,253,221,.35);border-radius:12px;padding:10px 12px;margin-bottom:12px}
.now b{color:var(--accent);font-size:17px}
.vs{color:var(--dim);font-size:13px;margin:0 0 12px}
.cta{background:var(--accent);color:var(--accent-ink);border-radius:12px;padding:13px;text-align:center;font-weight:800;font-size:15px}
.fine{color:var(--faint);font-size:11px;margin:10px 0 0;text-align:center}
.caption{flex:1;min-width:280px;max-width:380px;color:#222}
.caption h3{margin:0 0 8px;font-size:17px}
.caption p{margin:0 0 10px;font-size:14px;color:#333}
.caption .mono{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#fff;border:1px solid #d8dce1;border-radius:8px;padding:10px 12px;color:#222;overflow:auto}
.foot{color:#666;font-size:12px;margin-top:22px}
</style></head><body><div class="wrap">
<h1>The Lock on a listing</h1>
<p class="sub">Your listing card, your buttons. One more button, rendered by you from one JSON quote. After the tap, one sheet, ours: two endings and the credit at lock in. Numbers from the sheet priced ${esc(at)} UTC.</p>
<div class="row">
<div class="phone"><div class="screen">
  <div class="top"><div class="brand"><i>${brand.slice(0, 1)}</i>${brand}</div><div class="tab">Your listing</div></div>
  <div class="card">
    <div class="kicker"><span>${ticket}</span><span>1 leg remaining</span></div>
    <p class="title">Pays ${fmtUsd(row.payoutCents)}</p>
    <div class="facts">
      <div><small>Listed price</small><b>${fmtUsd(row.askCents)}</b></div>
      <div><small>Highest bid</small><b>${bid}</b></div>
      <div><small>Resolves</small><b>${esc(month)}</b></div>
      <div><small>Legs</small><b>${row.legsTotal} &middot; ${row.hitLegs.length} hit</b></div>
    </div>
    <ul>${hit}${remaining}</ul>
    <div class="btns">
      <div class="btn">Make bid</div>
      <div class="btn">Bet value</div>
      <div class="btn lock" style="position:relative"><span>Lock in ${fmtUsd(q.lockWorstCents)}</span><small>the least you end with &middot; ${fmtUsd(q.creditCents)} credited at lock in</small><span class="ours">ours</span></div>
    </div>
  </div>
  <div class="note">Demo. Simulated at live prices; nothing is bought.</div>
</div></div>

<div class="phone"><div class="screen">
  <div class="top"><div class="brand"><i>${brand.slice(0, 1)}</i>${brand}</div><div class="tab">Your listing</div></div>
  <div class="card" style="opacity:.5">
    <div class="kicker"><span>${ticket}</span><span>1 leg remaining</span></div>
    <p class="title">Pays ${fmtUsd(row.payoutCents)}</p>
    <ul>${remaining}</ul>
  </div>
  <div class="scrim"></div>
  <div class="sheet">
    <div class="grab"></div>
    <h2>Lock in ${fmtUsd(q.lockWorstCents)}</h2>
    <p class="lead">Keep the ticket. Whatever happens, you end with at least this.</p>
    <div class="ends">
      <div><small>If ${esc(leg.label)} win</small><b>${fmtUsd(q.lockBestCents)}</b><small>was ${fmtUsdShort(row.payoutCents)}</small></div>
      <div><small>If they don't</small><b>${fmtUsd(q.lockWorstCents)}</b><small>was $0</small></div>
    </div>
    <div class="now"><span>Credited at lock in</span><b>${fmtUsd(q.creditCents)}</b></div>
    <p class="vs">Your ask is ${fmtUsd(row.askCents)} with ${row.bidCents === null ? "no bids" : `a high bid of ${fmtUsd(row.bidCents)}`}. The lock's worst case is ${q.lockWorstCents >= row.askCents ? `${fmtUsd(q.lockWorstCents - row.askCents)} more than your ask` : `${fmtUsd(row.askCents - q.lockWorstCents)} under your ask, and it is locked at your tap`}.</p>
    <div class="cta">Lock in ${fmtUsd(q.lockWorstCents)} &middot; ${fmtUsd(q.creditCents)} credit</div>
    <p class="fine">Terms lock at your tap. The credit you see is the credit you get. Settles with your ticket.</p>
  </div>
</div></div>

<div class="caption">
  <h3>What you render</h3>
  <p>One GET per listing returns the quote; you draw one button from it. The sheet, the pricing and the settlement are ours. Nothing to pay, nothing to hold.</p>
  <div class="mono">GET /api/quote?listing=${esc(row.id)} &nbsp;(example shape)<br />&rarr; { "worstCents": ${q.lockWorstCents}, "bestCents": ${q.lockBestCents},<br />&nbsp;&nbsp;&nbsp;&nbsp;"creditCents": ${q.creditCents}, "floorCents": ${q.floorCents},<br />&nbsp;&nbsp;&nbsp;&nbsp;"capCents": ${q.capCents}, "contracts": ${row.contracts} }</div>
  <p style="margin-top:12px">The other side is bought on the venue that lists the leg in the same second the seller taps, so we carry no outcome risk; the take is stated on every quote and already netted out of the credit. Nothing for the seller to manage afterwards: it settles with the ticket.</p>
  <p class="foot">Mockup for ${brand}. Listing as read on your public page; prices as of ${esc(at)} UTC. The live demo with the same button on exchange positions: atticus-event-demo-cross-venue.onrender.com/?brand=${encodeURIComponent(opts.brand)}</p>
</div>
</div></div></body></html>`;
  if (/\u2014/.test(out)) throw new Error("listing mock: em dash in copy");
  return out;
}
