/**
 * Earn & Protect (perps) — the shadow record pages.
 *
 * Public: what was quoted from the live OKX book at the product's own terms
 * and what it did for the holder on the price path (a cap touch is a
 * knock-out) and against the official delivery print.
 * Operator (token): what every other rule would have written from the same
 * book — every cap distance, fee rule, larger sizes, the other tenor — settled on
 * the same path and print; where the knock-outs fell and what they cost.
 */

import type { CapGuard, EpTenor } from "../src/singleSide/twoSided/creditCollar/perpTenor";
import {
  type PerpCapRungBook,
  type PerpRuleBook,
  type PerpShadowPosition,
  type PerpShadowSummary,
} from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowLedger";
import { feeRuleText } from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowQuote";

function demoUrl(): string {
  return process.env.PERP_SHADOW_DEMO_URL || "https://earnandprotect.xyz";
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
export const usd = (cents: number): string => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const signedUsd = (c: number): string => (c < 0 ? `-${usd(-c)}` : usd(c));
/** bps to one decimal: perp collar credits are single-digit bps of notional at the daily, tens at the weekly */
export const bpsPct = (bps: number | null): string => (bps === null ? "–" : `${bps.toFixed(1)} bps`);
export const utcDay = (iso: string): string => iso.slice(0, 10);

/** Same visual language as the demo's public pages: light, one accent, tabular numbers. */
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

const shortUtc = (iso: string): string => iso.slice(5, 16).replace("T", " ") + " UTC";
const px = (cents: number): string => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

export interface PerpShadowPageInput {
  atIso: string;
  summary: PerpShadowSummary;
  open: PerpShadowPosition[];
  settled: PerpShadowPosition[];
  sizeBtc: number;
  /** the tenor the live product writes to; the record page says which expiry each cycle runs to */
  tenor?: EpTenor;
}

function positionRow(p: PerpShadowPosition): string {
  const o = p.outcome;
  const tag = o
    ? o.floorSave
      ? '<span class="tag save">floor</span>'
      : o.knockedOut
        ? '<span class="tag">knock-out</span>'
        : o.capExcessCents > 0
          ? '<span class="tag">past the cap</span>'
          : o.touchedAtIso
            ? '<span class="tag">touched</span>'
            : '<span class="tag">between</span>'
    : "";
  const right = o
    ? o.knockedOut
      ? `${signedUsd(o.deltaCents)} <i>paid at the touch${o.touchedAtIso ? ` ${shortUtc(o.touchedAtIso)}` : ""}</i>`
      : o.capExcessCents > 0
        ? `${signedUsd(o.deltaCents)} <i>vs naked · ${usd(o.capExcessCents)} above the cap handed back · settled ${px(p.settleCents ?? 0)}</i>`
        : `${signedUsd(o.deltaCents)} <i>vs naked · settled ${px(p.settleCents ?? 0)}</i>`
    : `${usd(p.creditCents)} <i>cash · expires ${shortUtc(p.expiryIso)}</i>`;
  return `<div class="row"><span>${p.side === "long" ? "Long" : "Short"} ${(p.contracts * p.ctValBtc).toFixed(2)} BTC at ${px(p.spotCents)} ${tag}<br/><i style="font-style:normal;color:var(--faint);font-size:11.5px">floor ${px(p.floorStrikeCents)} · cap ${px(p.capStrikeCents)} · ${shortUtc(p.at)}</i></span><b>${right}</b></div>`;
}

export function renderPerpShadowHtml(input: PerpShadowPageInput): string {
  const s = input.summary;
  const period = s.firstAt ? `${utcDay(s.firstAt)} to ${utcDay(input.atIso)} UTC` : "not started; the first quote begins it";
  const cf = s.counterfactuals;
  const cfLine = cf.recordedSince
    ? `${cf.positionsWithCounterfactuals} positions since ${utcDay(cf.recordedSince)} also record the alternative terms`
    : "starts with the first quoted position";
  const plain = s.capMode === "plain";
  const cd = s.capDetail;
  const settledLine =
    s.settled === 0
      ? "Nothing has expired yet; the first print settles the first positions."
      : plain
        ? `${s.settled} settled: ${s.floorSaves} floor save${s.floorSaves === 1 ? "" : "s"}, ${cd.endedPastCap} ended past the cap (${usd(cd.capExcessCents)} of gains above it handed back against ${usd(
            cd.creditOnPastCapCents,
          )} of credit on those), ${s.settled - s.floorSaves - cd.endedPastCap} between the wings. ${cd.touched} touched the cap on the way${
            cd.touched ? ` (a release was on offer; at the touch it would have cost ${usd(cd.releaseAtTouchCents)} in all)` : ""
          }. Protection ${s.holderDeltaCents >= 0 ? "added" : "cost"} ${usd(Math.abs(s.holderDeltaCents))} against holding naked; the writer's side is the take, ${signedUsd(s.writerCents)}, hedged leg for leg.`
        : `${s.settled} settled: ${s.floorSaves} floor save${s.floorSaves === 1 ? "" : "s"}, ${s.knockouts} knocked out at the cap (paid what had vested, protection re-armed), ${
            s.settled - s.floorSaves - s.knockouts
          } ran to expiry between the wings. Protection ${s.holderDeltaCents >= 0 ? "added" : "cost"} ${usd(Math.abs(s.holderDeltaCents))} against holding naked; the writer's side came to ${signedUsd(
            s.writerCents,
          )}.`;
  const refusalRows = Object.entries(s.refusalReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, n]) => `<div class="row"><span>${escapeHtml(k.replace(/_/g, " "))}</span><b>${n}</b></div>`)
    .join("");
  const openRows = input.open.slice(0, 6).map(positionRow).join("");
  const settledRows = input.settled.slice(0, 12).map(positionRow).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:," />
<title>Shadow record · Earn &amp; Protect</title>
<meta name="description" content="The Earn &amp; Protect collar quoted continuously from the live OKX book at the product's own terms, every position marked against the official delivery price. Simulated positions, real prices, real prints." />
<style>${SHADOW_CSS}</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="wordmark">Earn &amp; Protect <span>· shadow record</span></div>
</div></div>
<div class="wrap">
  <div class="card">
    <h1>What protection did, quote by quote</h1>
    <div class="sub">Every hour the live product's collar is quoted from the OKX book for a ${input.sizeBtc.toFixed(2)} BTC Hyperliquid position, long and short, at the terms a holder would see: a hard floor 6% out, the cap as far out as the book still pays, cash credit either way, written to ${
      (input.tenor ?? "weekly") === "weekly" ? "the nearest Friday expiry at least three days out" : "the next daily expiry"
    }. ${
      plain
        ? "The collar runs to expiry: every gain up to the cap is the holder's, gains above it this cycle pay for the floor, the full credit is theirs, and the cap can be released at any time at the live price. A touch closes nothing."
        : "A cap touch ends the cycle early: the holder keeps the position and every gain, is paid the credit vested to that moment, and protection re-arms."
    } Each position is settled on the Hyperliquid price path (did the cap get touched, and when) and OKX's official delivery print, protected versus naked. Positions are simulated; prices, fees, candles and prints are real.</div>
    <div class="bignums">
      <div class="bignum"><div class="n green">${s.positions}</div><div class="l">positions quoted</div></div>
      <div class="bignum"><div class="n">${s.refusals}</div><div class="l">honest refusals</div></div>
      <div class="bignum"><div class="n green">${usd(s.creditCents)}</div><div class="l">cash credited</div></div>
      <div class="bignum"><div class="n ${s.holderDeltaCents >= 0 ? "green" : ""}">${s.settled ? signedUsd(s.holderDeltaCents) : "–"}</div><div class="l">protection vs naked, settled</div></div>
    </div>
    <div class="period">${escapeHtml(period)}</div>
    <div class="read" style="margin-top:10px">${escapeHtml(settledLine)}</div>
  </div>

  <div class="card">
    <h2>The honest aggregate</h2>
    <div class="row"><span>protected notional</span><b>${usd(s.notionalCents)}</b></div>
    <div class="row"><span>cash to holders</span><b>${usd(s.creditCents)} <i>${bpsPct(s.creditBpsOfNotional)} of notional</i></b></div>
    <div class="row"><span>market funded</span><b>${usd(s.grossCreditCents)} <i>gross, before OKX fees ${usd(s.venueFeeCents)}</i></b></div>
    <div class="row"><span>our take</span><b>${usd(s.takeCents)}</b></div>
    <div class="row"><span>venue spread paid</span><b>${bpsPct(s.spreadCostBps)} <i>of notional, mid vs touch</i></b></div>
    <div class="row"><span>funding at open</span><b>${s.avgFundingBpsPer8h === null ? "–" : `${s.avgFundingBpsPer8h} bps / 8h`} <i>Hyperliquid, average</i></b></div>
    <div class="row"><span>basis at open</span><b>${s.avgBasisBps === null ? "–" : `${s.avgBasisBps} bps`} <i>HL mark vs OKX index</i></b></div>
    <div class="row"><span>cap distance written</span><b>${s.avgCapPct === null ? "–" : `${(s.avgCapPct * 100).toFixed(1)}%`} <i>from price, average</i></b></div>
    ${
      plain
        ? `<div class="row"><span>cap touched</span><b>${s.settled ? `${cd.touched} of ${s.settled}` : "–"} <i>${cd.avgHoursToTouch === null ? "a release on offer, nothing closed" : `avg ${cd.avgHoursToTouch}h in · release on offer`}</i></b></div>
    <div class="row"><span>ended past the cap</span><b>${s.settled ? `${cd.endedPastCap} of ${s.settled}` : "–"} <i>${cd.endedPastCap ? `${usd(cd.capExcessCents)} handed back vs ${usd(cd.creditOnPastCapCents)} credit` : "gains above the cap handed back"}</i></b></div>`
        : `<div class="row"><span>knock-outs</span><b>${s.settled ? `${s.knockouts} of ${s.settled}` : "–"} <i>${s.knockoutDetail.avgHoursToTouch === null ? "cap touched, cycle ended early" : `avg ${s.knockoutDetail.avgHoursToTouch}h in`}</i></b></div>`
    }
    <div class="row"><span>long / short</span><b>${s.bySide.long.positions} / ${s.bySide.short.positions}</b></div>
    <div class="row"><span>rule comparison</span><b>${escapeHtml(cfLine)} <i>report on request</i></b></div>
    ${refusalRows ? `<h2 style="margin-top:14px">Why quotes were refused</h2>${refusalRows}` : ""}
  </div>

  ${
    settledRows
      ? `<div class="card"><h2>Settled, most recent first</h2>${settledRows}${
          input.settled.length > 12 ? `<div class="rule">${input.settled.length - 12} more in the CSV.</div>` : ""
        }</div>`
      : ""
  }
  ${openRows ? `<div class="card"><h2>Open, next to expire</h2>${openRows}</div>` : ""}

  <div class="card">
    <h2>How to read it</h2>
    <div class="read">${
      plain
        ? `<b>Protection vs naked</b> is the holder's P&amp;L with the collar and credit minus the P&amp;L of the bare position. The floor clamps the loss side; the cap clamps the gain side for the cycle (<b>past the cap</b>: the gains above it were handed back, they paid for the floor); the whole credit is theirs. <b>Touched</b>: price reached the cap on the Hyperliquid path; nothing closed, and the holder could have released the cap at that moment for the buy-back price shown. <b>Our take</b> is the published share of the net credit; both legs are hedged leg for leg on OKX and held to expiry, so the take is the writer's whole side. <b>Venue spread</b> is what crossing the book costs versus mid; it is the number a better fill would shrink.`
        : `<b>Protection vs naked</b> is the holder's P&amp;L with the collar and credit minus the P&amp;L of the bare position. Ran to expiry: the floor clamps the loss side and the whole credit is theirs. <b>Knocked out</b>: price touched the cap on the Hyperliquid path, the cycle ended there, the holder kept the position and every gain and was paid the credit vested to the touch. <b>Our take</b> is the published share of the net credit; the floor leg is hedged leg for leg on OKX, and at a knock-out the short cap leg is bought back at the money, which is the writer's cost against the unvested credit kept. <b>Venue spread</b> is what crossing the book costs versus mid; it is the number a better fill would shrink.`
    }</div>
    <a class="back" href="${demoUrl()}">Try the live demo</a> <a class="back" href="/api/shadow">Raw JSON</a> <a class="back" href="/api/shadow/positions.csv">Positions (CSV)</a>
  </div>
  <footer>
    <b>What is real:</b> OKX option prices and fees, Hyperliquid marks, candles and funding, OKX delivery prints. <b>What is simulated:</b> the positions; no venue credentials, no wallets, nothing traded. Rendered ${escapeHtml(input.atIso.slice(0, 16).replace("T", " "))} UTC. Demonstration, not an offer.
  </footer>
</div>
</body>
</html>`;
}

// ── Operator report ────────────────────────────────────────────────────────

export interface PerpShadowReportInput {
  atIso: string;
  summary: PerpShadowSummary;
  token?: string | null;
  capGuard?: CapGuard;
  /** the tenor the live product writes to (the baseline row); the counterfactual is the other one */
  tenor?: EpTenor;
  /** the cap-ladder rule sentence (mode-aware), as the JSON report states it */
  capLadderRule?: string;
  /** the live cap rule sentence (capRuleText) */
  capRule?: string;
}

const ruleHead = (plain: boolean): string =>
  `<tr><th>rule</th><th>quoted</th><th>refused</th><th>cash / notional</th><th>cash</th><th>take</th><th>settled</th><th>floor</th><th>${plain ? "past the cap" : "knock-outs"}</th><th>holder Δ</th><th>writer</th></tr>`;

function ruleTr(name: string, note: string, b: PerpRuleBook, opts: { base?: boolean; plain?: boolean } = {}): string {
  const capCell = opts.plain
    ? `${b.capHits}${b.capExcessCents ? ` <i style="color:var(--faint);font-style:normal">${usd(b.capExcessCents)} back</i>` : ""}`
    : `${b.knockouts}${b.knockoutRatePct != null ? ` <i style="color:var(--faint);font-style:normal">${b.knockoutRatePct}%</i>` : ""}`;
  return (
    `<tr${opts.base ? ' class="base"' : ""}>` +
    `<td>${escapeHtml(name)}${note ? ` <span class="tag">${escapeHtml(note)}</span>` : ""}</td>` +
    `<td>${b.quoted}</td><td>${b.refused}</td>` +
    `<td class="hi">${escapeHtml(bpsPct(b.creditBpsOfNotional))}</td>` +
    `<td>${usd(b.creditCents)}</td><td>${usd(b.takeCents)}</td>` +
    `<td>${b.settled}</td><td>${b.floorSaves}</td><td>${capCell}</td>` +
    `<td>${b.settled ? signedUsd(b.holderDeltaCents) : "–"}</td><td>${b.settled ? signedUsd(b.writerCents) : "–"}</td>` +
    `</tr>`
  );
}

const ladderHead = (plain: boolean): string =>
  plain
    ? `<tr><th>cap from price</th><th>quoted</th><th>refused</th><th>live pick</th><th>cash / notional</th><th>market odds past cap</th><th>settled</th><th>touched</th><th>past the cap</th><th>realized</th><th>handed back</th><th>release at touch</th><th>holder Δ</th><th>OKX saw it</th></tr>`
    : `<tr><th>cap from price</th><th>quoted</th><th>refused</th><th>live pick</th><th>cash / notional</th><th>settled</th><th>knock-outs</th><th>rate</th><th>avg time to touch</th><th>buyback</th><th>writer</th><th>OKX saw it</th></tr>`;

function rungTr(r: PerpCapRungBook, guard?: CapGuard, plain = false): string {
  const under = guard ? r.capPct < guard.minCapPct - 1e-9 : r.underGuard > 0;
  const touches = r.okxConfirmedTouches + r.hlOnlyTouches;
  const tail = plain
    ? `<td>${r.predictedExceedPct == null ? "–" : `${r.predictedExceedPct}%`}</td>` +
      `<td>${r.settled}</td><td>${touches}</td><td>${r.capHits}</td>` +
      `<td>${r.realizedExceedPct == null ? "–" : `${r.realizedExceedPct}%`}</td>` +
      `<td>${r.capExcessCents ? usd(r.capExcessCents) : "–"}</td>` +
      `<td>${touches ? usd(r.buybackCents) : "–"}</td><td>${r.settled ? signedUsd(r.holderDeltaCents) : "–"}</td>` +
      `<td>${touches ? `${r.okxConfirmedTouches} / ${touches}` : "–"}</td>`
    : `<td>${r.settled}</td><td>${r.knockouts}</td><td>${r.knockoutRatePct == null ? "–" : `${r.knockoutRatePct}%`}</td>` +
      `<td>${r.avgHoursToTouch == null ? "–" : `${r.avgHoursToTouch}h`}</td>` +
      `<td>${r.knockouts ? usd(r.buybackCents) : "–"}</td><td>${r.settled ? signedUsd(r.writerCents) : "–"}</td>` +
      `<td>${r.knockouts ? `${r.okxConfirmedTouches} / ${r.okxConfirmedTouches + r.hlOnlyTouches}` : "–"}</td>`;
  return (
    `<tr${r.livePicks > 0 && r.livePicks >= (r.quoted + r.refused) / 2 ? ' class="base"' : ""}>` +
    `<td>${r.bucket}${under ? ' <span class="tag">under guard</span>' : ""}</td>` +
    `<td>${r.quoted}</td><td>${r.refused}</td><td>${r.livePicks}</td>` +
    `<td class="hi">${escapeHtml(bpsPct(r.creditBpsOfNotional))}</td>` +
    tail +
    `</tr>`
  );
}

export function renderPerpShadowReportHtml(input: PerpShadowReportInput): string {
  const s = input.summary;
  const cf = s.counterfactuals;
  const ko = s.knockoutDetail;
  const cd = s.capDetail;
  const plain = s.capMode === "plain";
  const tq = input.token ? `?token=${encodeURIComponent(input.token)}` : "";
  const period = cf.recordedSince ? `${utcDay(cf.recordedSince)} to ${utcDay(input.atIso)} UTC` : "not started; the first quoted position begins it";
  const ladderRows = cf.capLadder.map((r) => rungTr(r, input.capGuard, plain)).join("");
  const settledRungs = cf.capLadder.filter((r) => r.settled > 0);
  const bestWriter = settledRungs.length ? [...settledRungs].sort((a, b) => b.writerCents - a.writerCents)[0] : null;
  const bestHolder = settledRungs.length ? [...settledRungs].sort((a, b) => b.holderDeltaCents - a.holderDeltaCents)[0] : null;
  const ladderLine = plain
    ? bestHolder
      ? `Over settled positions the holder did best with the cap ${bestHolder.bucket} out (${signedUsd(bestHolder.holderDeltaCents)} vs naked, ${bestHolder.capHits} of ${bestHolder.settled} ended past the cap, ${usd(
          bestHolder.capExcessCents,
        )} handed back); the live pick averaged ${s.avgCapPct == null ? "–" : `${(s.avgCapPct * 100).toFixed(1)}%`}. A closer cap pays more cash up front and hands more back at the print; the release column is what buying the cap back at the touch would have cost. The writer's side is the take on every rung: the hedge is held leg for leg.`
      : "Rungs settle with the live position; touch and past-the-cap counts appear once positions expire."
    : bestWriter
      ? `Over settled positions the writer's side was best with the cap ${bestWriter.bucket} out (${signedUsd(bestWriter.writerCents)}, ${bestWriter.knockouts} knock-out${
          bestWriter.knockouts === 1 ? "" : "s"
        } in ${bestWriter.settled}); the live pick averaged ${s.avgCapPct == null ? "–" : `${(s.avgCapPct * 100).toFixed(1)}%`}. A closer cap pays more cash and gets touched more; the buyback column is what each touch cost.`
      : "Rungs settle with the live position; knock-out rates appear once positions expire.";
  const capCardLine =
    cd.touched === 0 && cd.endedPastCap === 0
      ? "No settled position has reached its cap yet."
      : `${cd.touched} of ${s.settled} settled positions touched the cap on the Hyperliquid path${cd.avgHoursToTouch != null ? `, ${cd.avgHoursToTouch}h in on average` : ""}; nothing closed. Releasing at the touch would have cost ${usd(
          cd.releaseAtTouchCents,
        )} in all (the cap leg at the money, priced from the nearest scan's ATM ask). ${cd.endedPastCap} ended past the cap at the print and handed back ${usd(cd.capExcessCents)} of gains above it against ${usd(
          cd.creditOnPastCapCents,
        )} of credit paid on those cycles${cd.endedPastCap ? `: ${cd.capExcessCents > cd.creditOnPastCapCents ? "the upside given up outweighed the credit on those" : "the credit covered the upside given up on those"}` : ""}. Of the touches Hyperliquid saw, the OKX index reached the cap on ${cd.okxConfirmed} and stayed short on ${cd.hlOnly}.`;
  const guardLine = input.capGuard
    ? input.capGuard.minCapPct > 0
      ? `Cap guard in force: the live product refuses a cap closer than ${(input.capGuard.minCapPct * 100).toFixed(1)}% and searches out to ${(input.capGuard.maxCapPct * 100).toFixed(1)}%.`
      : `No minimum cap distance: the live product writes the widest listed cap that pays (searched out to ${(input.capGuard.maxCapPct * 100).toFixed(1)}%) and shows the distance; the ladder below is what closer and wider rungs would have paid.`
    : "";
  const koLine =
    ko.knockouts === 0
      ? "No knock-outs settled yet."
      : `${ko.knockouts} knock-out${ko.knockouts === 1 ? "" : "s"} over ${ko.touchHours} distinct hour${ko.touchHours === 1 ? "" : "s"}; the busiest hour had ${ko.maxInOneHour}. Buybacks came to ${usd(
          ko.buybackCents,
        )} against ${usd(ko.unvestedKeptCents)} of unvested credit kept${ko.pricedBlind ? ` (${ko.pricedBlind} priced without an ATM reference, counted as $0)` : ""}. Of the touches Hyperliquid saw, the OKX index reached the cap on ${
          ko.okxConfirmed
        } and stayed short on ${ko.hlOnly}${ko.avgOkxGapBps != null ? `; OKX's extreme sat ${ko.avgOkxGapBps} bps ${ko.avgOkxGapBps >= 0 ? "past" : "short of"} the cap on average` : ""}.`;
  const fr = cf.fundingRule;
  const fundingLine =
    fr.judged === 0
      ? "No funding read yet."
      : `On ${fr.judged} quotes the credit came to ${usd(fr.creditCents)} against ${usd(fr.fundingCents)} of funding the holder pays over the cycle; on ${fr.wouldRefuse} (${Math.round(
          (fr.wouldRefuse / fr.judged) * 100,
        )}%) the credit did not clear it. Informational: funding is the perp's cost with or without protection, so the live product discloses it and never refuses on it (the refusal flag was retired 2026-09-20).`;
  const ss = s.sameStrike;
  const sameLine =
    ss.opens === 0
      ? ""
      : `${ss.sharedSellStrike} of ${ss.opens} opens landed on a funding strike already open on the book (most at once on one strike: ${ss.maxOpenOnOneStrike}). Those are the entries a single block RFQ would fill at one price.`;
  const feeLabels = Object.keys(cf.feeRules);
  const feeRows = [ruleTr("live book", "what was quoted", cf.baseline, { base: true, plain }), ...feeLabels.map((l) => ruleTr(feeRuleText(l).name, "", cf.feeRules[l], { plain }))].join("");
  const feeRules = feeLabels
    .map((l) => `<div class="row"><span>${escapeHtml(feeRuleText(l).name)}</span><b style="font-weight:500;text-align:left">${escapeHtml(feeRuleText(l).rule)}</b></div>`)
    .join("");
  const capRows = cf.capacity
    .map((row) => {
      const fill = row.quoted + row.refused > 0 ? `${Math.round((row.quoted / (row.quoted + row.refused)) * 100)}%` : "–";
      return (
        `<tr${row.mult === 1 ? ' class="base"' : ""}>` +
        `<td>${row.mult}× size</td><td>${row.quoted}</td><td>${row.refused}</td><td>${fill}</td>` +
        `<td>${usd(row.notionalCents)}</td><td>${usd(row.creditCents)}</td>` +
        `<td class="hi">${escapeHtml(bpsPct(row.creditBpsOfNotional))}</td>` +
        `<td>${escapeHtml(bpsPct(row.avgSpreadCostBps))}</td><td>${usd(row.takeCents)}</td>` +
        `</tr>`
      );
    })
    .join("");
  const liveTenor: EpTenor = input.tenor ?? "weekly";
  const tenorLabels = Object.keys(cf.tenors);
  const tenorRows = [
    ruleTr("live book", `${cf.baseline.quoted ? `next ${liveTenor}` : ""}`, cf.baseline, { base: true, plain }),
    ...tenorLabels.map((l) => ruleTr(`${l}${cf.tenors[l].avgDays != null ? ` · ${cf.tenors[l].avgDays}d` : ""}`, "", cf.tenors[l], { plain })),
  ].join("");
  const floorRows = (cf.floorLadder ?? [])
    .map((r) => {
      const capCell = plain
        ? `${r.capHits}${r.capExcessCents ? ` <i style="color:var(--faint);font-style:normal">${usd(r.capExcessCents)} back</i>` : ""}`
        : `${r.knockouts}${r.knockoutRatePct != null ? ` <i style="color:var(--faint);font-style:normal">${r.knockoutRatePct}%</i>` : ""}`;
      return (
        `<tr${r.livePicks > 0 ? ' class="base"' : ""}>` +
        `<td>${(r.floorPct * 100).toFixed(0)}%${r.livePicks > 0 ? ' <span class="tag">live</span>' : ""}</td>` +
        `<td>${r.quoted}</td><td>${r.refused}</td>` +
        `<td>${r.avgCapPct == null ? "–" : `${(r.avgCapPct * 100).toFixed(1)}%`}</td>` +
        `<td>${r.predictedExceedPct == null ? "–" : `${r.predictedExceedPct}%`}</td>` +
        `<td class="hi">${escapeHtml(bpsPct(r.creditBpsOfNotional))}</td><td>${usd(r.creditCents)}</td>` +
        `<td>${r.settled}</td><td>${r.floorSaves}</td><td>${capCell}</td>` +
        `<td>${r.settled ? signedUsd(r.holderDeltaCents) : "–"}</td>` +
        `</tr>`
      );
    })
    .join("");
  const floorLive = (cf.floorLadder ?? []).find((r) => r.livePicks > 0 && r.quoted > 0);
  const floorBest = (cf.floorLadder ?? []).filter((r) => r.quoted > 0).sort((a, b) => (b.creditBpsOfNotional ?? -1) - (a.creditBpsOfNotional ?? -1))[0];
  const floorLine =
    floorLive && floorBest
      ? floorBest.floorPct === floorLive.floorPct
        ? `The live ${(floorLive.floorPct * 100).toFixed(0)}% floor pays the most cash per dollar protected of the depths tried (${bpsPct(floorLive.creditBpsOfNotional)}).`
        : `A ${(floorBest.floorPct * 100).toFixed(0)}% floor pays ${bpsPct(floorBest.creditBpsOfNotional)} of notional against ${bpsPct(floorLive.creditBpsOfNotional)} at the live ${(floorLive.floorPct * 100).toFixed(0)}%${
            floorBest.avgCapPct != null && floorLive.avgCapPct != null ? `, with the cap at ${(floorBest.avgCapPct * 100).toFixed(1)}% against ${(floorLive.avgCapPct * 100).toFixed(1)}%` : ""
          }. A deeper floor is cheaper, so the cap rule can spend the difference on credit; whether it is worth the extra downside is the holder column once enough cycles have settled.`
      : "";
  // The counterfactual floor RULE judged on each quote's ladder: which depth it would have written to.
  const frule = cf.floorRule;
  const floorRuleLine =
    frule && frule.judged > 0
      ? `Floor rule (${frule.rule ?? "—"}) judged on ${frule.judged} quote${frule.judged === 1 ? "" : "s"}: ` +
        Object.entries(frule.picks)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${k} × ${n}`)
          .join(", ") +
        `; agrees with the live depth ${frule.agreesWithLive}/${frule.judged}.`
      : "";
  const weeklyBook = liveTenor === "weekly" ? cf.baseline : cf.tenors.weekly;
  const dailyBook = liveTenor === "daily" ? cf.baseline : cf.tenors.daily;
  const tenorLine =
    weeklyBook && dailyBook && weeklyBook.quoted > 0 && dailyBook.quoted > 0
      ? `The same collar at the weekly pays ${bpsPct(weeklyBook.creditBpsOfNotional)} of notional in cash against ${bpsPct(
          dailyBook.creditBpsOfNotional,
        )} at the daily: one-day options a few percent out are worth ticks, so most of the daily's gross goes to venue fees. The weekly is where the credit is real${
          liveTenor === "weekly" ? " and is the live tenor" : ""
        }; it also holds the position through a week of funding and a week of chances to touch the cap.`
      : "";
  const one = cf.capacity.find((c) => c.mult === 1);
  const top = cf.capacity[cf.capacity.length - 1];
  const capLine =
    one && top && one.quoted > 0
      ? top.quoted === 0
        ? `At ${top.mult}× the visible depth did not fund a single collar; the book is not there at that size.`
        : `At ${top.mult}× the book still funded ${top.quoted} of ${top.quoted + top.refused} quotes and cash per dollar protected ${
            (top.creditBpsOfNotional ?? 0) >= (one.creditBpsOfNotional ?? 0) ? "held" : "fell"
          } from ${bpsPct(one.creditBpsOfNotional)} to ${bpsPct(top.creditBpsOfNotional)}; the spread paid went from ${bpsPct(one.avgSpreadCostBps)} to ${bpsPct(
            top.avgSpreadCostBps,
          )}. That gap is what an RFQ at one price is for.`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:," />
<title>Rule comparison · Shadow record · Earn &amp; Protect</title>
<style>${SHADOW_CSS}</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="wordmark">Earn &amp; Protect <span>· rule comparison</span></div>
</div></div>
<div class="wrap">
  <div class="card">
    <h1>What each rule would have done</h1>
    <div class="sub">Every position records what every listed cap distance, the other fee rule, larger sizes and the other tenor would have written from the same OKX snapshot at the same second. At expiry every alternative is settled on the same Hyperliquid path and the same delivery print${
      plain
        ? " (the collar runs to expiry: gains above the cap are handed back, a touch on the path is recorded as a release on offer with its price)"
        : " (a cap touch is a knock-out: the cycle ends, the short cap leg is bought back at the money)"
    }. Same positions, same book, same path; only the rule differs.</div>
    <div class="bignums">
      <div class="bignum"><div class="n green">${cf.positionsWithCounterfactuals}</div><div class="l">positions compared</div></div>
      <div class="bignum"><div class="n">${cf.baseline.settled}</div><div class="l">of them settled</div></div>
      ${plain ? `<div class="bignum"><div class="n">${cd.endedPastCap}</div><div class="l">ended past the cap, live pick</div></div>` : `<div class="bignum"><div class="n">${s.knockouts}</div><div class="l">knock-outs, live cap</div></div>`}
      <div class="bignum"><div class="n ${s.writerCents >= 0 ? "green" : ""}">${s.settled ? signedUsd(s.writerCents) : "–"}</div><div class="l">writer's side, settled</div></div>
    </div>
    <div class="period">${escapeHtml(period)}</div>
  </div>

  <div class="card">
    <h2>Cap distance</h2>
    <div class="sub" style="margin-bottom:6px">${escapeHtml(
      input.capLadderRule ??
        (plain
          ? "The live floor held fixed; the funding wing moved to every listed strike in the band. Each rung is settled on the same path and print, so how often it was touched, how often it ended past the cap and how much upside was handed back are measured per distance. The live rule takes the widest rung that pays."
          : "The live floor held fixed; the funding wing moved to every listed strike in the band. Each rung is settled on the same path, so the knock-out rate and what each touch cost are measured per distance. The live rule takes the widest rung that pays."),
    )}</div>
    <div class="tablewrap"><table>${ladderHead(plain)}${ladderRows}</table></div>
    <div class="read">${escapeHtml(ladderLine)}</div>
    ${input.capRule ? `<div class="rule">Live cap rule: ${escapeHtml(input.capRule)}. "Market odds past cap" is the mean market-implied chance at open (the rung's OKX mark vol, zero drift); "realized" is the share of settled cycles that ended past it — the rule is checked against that column, per rung.</div>` : ""}
    ${guardLine ? `<div class="rule">${escapeHtml(guardLine)} ${plain ? "Release at touch" : "Buyback"} is the ATM ask the nearest scan saw, scaled to the time left at the touch; OKX saw it = the OKX index reached the cap within ±3 minutes of the Hyperliquid touch.</div>` : ""}
  </div>

  ${
    plain
      ? `<div class="card">
    <h2>The cap</h2>
    <div class="row"><span>touched on the path</span><b>${cd.touched} <i>of ${s.settled} settled · nothing closed</i></b></div>
    <div class="row"><span>time to touch</span><b>${cd.avgHoursToTouch == null ? "–" : `${cd.avgHoursToTouch}h`} <i>average from open</i></b></div>
    <div class="row"><span>release at the touch</span><b>${cd.touched ? usd(cd.releaseAtTouchCents) : "–"} <i>what keeping the upside would have cost, in all</i></b></div>
    <div class="row"><span>ended past the cap</span><b>${cd.endedPastCap} <i>of ${s.settled} settled</i></b></div>
    <div class="row"><span>handed back</span><b>${cd.endedPastCap ? usd(cd.capExcessCents) : "–"} <i>vs ${usd(cd.creditOnPastCapCents)} credit on those cycles</i></b></div>
    <div class="row"><span>two clocks</span><b>${cd.touched ? `${cd.okxConfirmed} confirmed · ${cd.hlOnly} HL only` : "–"} <i>OKX index vs cap at the touch</i></b></div>
    <div class="read">${escapeHtml(capCardLine)}</div>
  </div>`
      : `<div class="card">
    <h2>Knock-outs</h2>
    <div class="row"><span>knocked out</span><b>${ko.knockouts} <i>of ${s.settled} settled</i></b></div>
    <div class="row"><span>time to touch</span><b>${ko.avgHoursToTouch == null ? "–" : `${ko.avgHoursToTouch}h`} <i>average from open</i></b></div>
    <div class="row"><span>clustering</span><b>${ko.knockouts ? `${ko.maxInOneHour} in one hour` : "–"} <i>${ko.touchHours} hour${ko.touchHours === 1 ? "" : "s"} with a touch</i></b></div>
    <div class="row"><span>buybacks</span><b>${ko.knockouts ? usd(ko.buybackCents) : "–"} <i>vs ${usd(ko.unvestedKeptCents)} unvested kept</i></b></div>
    <div class="row"><span>two clocks</span><b>${ko.knockouts ? `${ko.okxConfirmed} confirmed · ${ko.hlOnly} HL only` : "–"} <i>${ko.avgOkxGapBps == null ? "OKX index vs cap at the touch" : `OKX ${ko.avgOkxGapBps} bps vs cap`}</i></b></div>
    <div class="read">${escapeHtml(koLine)}</div>
  </div>`
  }

  <div class="card">
    <h2>Does the math make sense</h2>
    <div class="row"><span>credit vs funding</span><b>${fr.judged ? `${fr.wouldRefuse} of ${fr.judged} below funding` : "–"} <i>credit ≤ the cycle's funding cost · disclosed, never refused</i></b></div>
    <div class="row"><span>same funding strike</span><b>${ss.opens ? `${ss.sharedSellStrike} of ${ss.opens}` : "–"} <i>already open on the book</i></b></div>
    <div class="read">${escapeHtml(fundingLine)}${sameLine ? ` ${escapeHtml(sameLine)}` : ""}</div>
  </div>

  ${
    floorRows
      ? `<div class="card">
    <h2>Floor depth</h2>
    <div class="sub" style="margin-bottom:6px">The collar re-quoted with the floor at each depth, the cap re-found by the live cap rule at each, same size, expiry and instant; settled on the same path. Deeper floors are cheaper, so they buy a closer cap or more cash — the trade is downside kept against cash paid.</div>
    <div class="tablewrap"><table>
      <tr><th>floor</th><th>quoted</th><th>refused</th><th>cap found</th><th>market odds past cap</th><th>cash / notional</th><th>cash</th><th>settled</th><th>floor used</th><th>${plain ? "past the cap" : "knock-outs"}</th><th>holder Δ</th></tr>
      ${floorRows}
    </table></div>
    ${floorLine ? `<div class="read">${escapeHtml(floorLine)}</div>` : ""}
    ${floorRuleLine ? `<div class="read">${escapeHtml(floorRuleLine)}</div>` : ""}
  </div>`
      : ""
  }

  <div class="card">
    <h2>Fee rule</h2>
    <div class="sub" style="margin-bottom:6px">Same collar, different split. Floors, caps and hedges are held fixed; only the take and the holder's cash move.</div>
    <div class="tablewrap"><table>${ruleHead(plain)}${feeRows}</table></div>
    ${feeRules}
  </div>

  <div class="card">
    <h2>Tenor</h2>
    <div class="sub" style="margin-bottom:6px">The live geometry at the other tenor's expiry from the same snapshot (the daily when the product is weekly, and the reverse). Quoted terms only: the other tenor settles on a different print, so holder and writer columns stay empty here by design.</div>
    <div class="tablewrap"><table>${ruleHead(plain)}${tenorRows}</table></div>
    ${tenorLine ? `<div class="read">${escapeHtml(tenorLine)}</div>` : ""}
  </div>

  <div class="card">
    <h2>Capacity</h2>
    <div class="sub" style="margin-bottom:6px">The live shape re-quoted at larger sizes, each wing walked down the visible depth. Cash per dollar protected and the spread paid are the numbers to watch.</div>
    <div class="tablewrap"><table>
      <tr><th>size</th><th>quoted</th><th>refused</th><th>fill rate</th><th>notional</th><th>cash</th><th>cash / notional</th><th>spread paid</th><th>take</th></tr>
      ${capRows}
    </table></div>
    ${capLine ? `<div class="read">${escapeHtml(capLine)}</div>` : ""}
    <div class="rule">1× is the live position. Refused means the visible depth did not cover the size or the walked credit was not positive after fees.</div>
  </div>

  <div class="card">
    <a class="back" href="/">Back to the shadow record</a> <a class="back" href="/api/shadow/report${tq}">Raw JSON</a> <a class="back" href="/api/shadow/positions.csv?scope=full${tq ? `&token=${encodeURIComponent(input.token as string)}` : ""}">Positions with every alternative (CSV)</a> <a class="back" href="/api/shadow/export${tq}">Full ledger (JSONL)</a>
  </div>
  <footer>Counterfactuals are computed at open from the OKX snapshot retained with the position and settled on the same Hyperliquid path and OKX delivery print as the live book. Nothing in the alternatives was traded. Rendered ${escapeHtml(input.atIso.slice(0, 16).replace("T", " "))} UTC.</footer>
</div>
</body>
</html>`;
}
