/**
 * Earn & Protect (perps) — the track record pages.
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

/**
 * A DASHBOARD, not a document: the perp track record reads like a trading desk's scorecard, the
 * format the facility ran on for weeks (dark, a grid of labelled numbers, tables with columns,
 * one line of prose per section). Palette is the perp demo's (Hyperliquid teal, mint accent) so
 * the demo and its record are visibly one product. The operator report shares these classes.
 */
export const SHADOW_CSS = `
:root{
  --bg:#0b1d23; --card:#0f2a31; --card2:#0c232a; --line:#1c3b43;
  --ink:#f1f6f4; --dim:#8fa6a3; --faint:#5f7874;
  --green:#2ebd85; --green-deep:#50d2c1; --green-wash:rgba(46,189,133,.14); --warn:#e3c34c; --bad:#ed7088; --gold:#d9ab01;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:14px/1.45 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;min-height:100vh;-webkit-font-smoothing:antialiased}
.topbar{background:rgba(11,29,35,.92);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5;backdrop-filter:blur(8px)}
.topbar .in{max-width:1040px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:12px 20px}
.topbar .wordmark{color:var(--ink);font-weight:700;font-size:15px}
.topbar .wordmark span{color:var(--dim);font-weight:500;font-size:11.5px;letter-spacing:.6px;margin-left:6px}
.topbar .wordmark span b{color:var(--gold);font-family:"Times New Roman",Times,serif;font-weight:400;font-size:14px;letter-spacing:.2px}
.topbar a{color:var(--dim);font-size:12.5px;text-decoration:none;margin-left:14px}
.topbar a:hover{color:var(--ink)}
.wrap{max-width:1040px;margin:0 auto;padding:22px 20px 48px}
h1{font-size:22px;font-weight:700;letter-spacing:-.2px}
.sub{color:var(--dim);font-size:13.5px;margin-top:6px;max-width:72em;line-height:1.55}
.pills{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.pill{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.5px;border-radius:999px;padding:3px 10px;border:1px solid var(--line);color:var(--dim);background:var(--card2)}
.pill.live{color:var(--green);border-color:rgba(46,189,133,.4);background:rgba(46,189,133,.1)}
.pill.mint{color:var(--green-deep);border-color:rgba(80,210,193,.35);background:rgba(80,210,193,.08)}
h2{font-size:14.5px;font-weight:700;margin:26px 0 10px;color:var(--ink);border-left:3px solid var(--green-deep);padding-left:9px}
h2 small{color:var(--dim);font-weight:500;font-size:12.5px;margin-left:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin:14px 0 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:12px;min-width:0;container-type:inline-size}
.grid .card{margin-bottom:0}
.k{color:var(--dim);font-size:11.5px;letter-spacing:.2px}
/* headline numbers size to their card: --w is the value's estimated width in em (set per value by the
   renderer), so a long dollar figure shrinks to fit and a short one keeps the full size */
.v{font-size:min(21px,calc(100cqi / var(--w,6)));font-weight:700;margin-top:3px;font-variant-numeric:tabular-nums;letter-spacing:-.02em;white-space:nowrap;overflow:hidden;text-overflow:clip;line-height:1.25;min-height:26px}
.v.green{color:var(--green)} .v.bad{color:var(--bad)} .v.mint{color:var(--green-deep)}
.s{color:var(--dim);font-size:11.5px;margin-top:3px;line-height:1.4}
.s b{color:var(--ink);font-weight:600}
/* legacy blocks (operator report): the same look, one accent */
.bignums{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap}
.bignum{flex:1;min-width:calc(25% - 8px);background:var(--card2);border:1px solid var(--line);border-radius:8px;padding:10px 12px;container-type:inline-size}
.bignum .n{font-size:min(21px,calc(100cqi / var(--w,6)));font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em;white-space:nowrap;overflow:hidden;line-height:1.25}
.bignum .n.green{color:var(--green)}
.bignum .l{color:var(--dim);font-size:11.5px;margin-top:2px}
.period{color:var(--dim);font-size:12px;margin-top:10px;font-variant-numeric:tabular-nums}
.row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;font-size:13px;color:var(--dim);font-variant-numeric:tabular-nums;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}
.row b{color:var(--ink);font-weight:600;text-align:right}
.row b i{color:var(--faint);font-style:normal;font-weight:500;font-size:12px}
.tag{display:inline-block;background:var(--card2);border:1px solid var(--line);color:var(--dim);border-radius:5px;padding:1px 6px;font-size:10.5px;font-weight:600;vertical-align:1px;white-space:nowrap}
.tag.save{background:var(--green-wash);color:var(--green);border-color:rgba(46,189,133,.35)}
.tag.warn{color:var(--warn);border-color:rgba(227,195,76,.4);background:rgba(227,195,76,.1)}
.back{display:inline-block;margin-top:2px;color:var(--green-deep);font-weight:600;font-size:13px;text-decoration:none;margin-right:14px}
.back:hover{text-decoration:underline}
.read{color:var(--dim);font-size:13px;line-height:1.55;margin-top:6px}
.read b{color:var(--ink);font-weight:600}
table{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums;margin-top:4px}
th{text-align:right;color:var(--dim);font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th:first-child,td:first-child{text-align:left}
td{padding:7px 8px;border-bottom:1px solid var(--line);color:var(--dim);text-align:right;white-space:nowrap}
td.hi{color:var(--ink);font-weight:600}
td.long{color:var(--green);font-weight:600} td.short{color:var(--bad);font-weight:600}
td.pos{color:var(--green)} td.neg{color:var(--bad)}
tr.base td{color:var(--ink)}
tbody tr:last-child td{border-bottom:0}
.tablewrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:4px 6px}
.rule{color:var(--faint);font-size:11.5px;margin-top:8px;line-height:1.45}
.bullets{list-style:none;color:var(--dim);font-size:13px;line-height:1.55}
.bullets li{padding:5px 0 5px 18px;position:relative}
.bullets li:before{content:"";position:absolute;left:2px;top:12px;width:6px;height:6px;border-radius:2px;background:var(--green-deep)}
.bullets b{color:var(--ink);font-weight:600}
footer{color:var(--faint);font-size:11.5px;line-height:1.6;padding:22px 2px 0;border-top:1px solid var(--line);margin-top:26px}
footer b{color:var(--dim);font-weight:600}
@media(max-width:560px){.wrap{padding:16px 12px 40px} .v{font-size:min(19px,calc(100cqi / var(--w,6)))} h1{font-size:20px} .topbar a{margin-left:10px}}
`;

const shortUtc = (iso: string): string => iso.slice(5, 16).replace("T", " ") + " UTC";
const px = (cents: number): string => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

export interface PerpShadowPageInput {
  atIso: string;
  summary: PerpShadowSummary;
  open: PerpShadowPosition[];
  settled: PerpShadowPosition[];
  /** closed early at live prices (flow mode) */
  closed?: PerpShadowPosition[];
  sizeBtc: number;
  /** the tenor the live product writes to; the record page says which expiry each cycle runs to */
  tenor?: EpTenor;
  /** flow mode's one-line rule (describeFlow), or null when the shadow is the fixed-size metronome */
  flow?: string | null;
}

const sideTd = (p: PerpShadowPosition): string => `<td class="${p.side}">${p.side === "long" ? "Long" : "Short"}</td>`;
const sizeTd = (p: PerpShadowPosition): string =>
  `<td class="hi">${usd(p.notionalCents)}${p.flow?.sizeClass ? ` <span class="tag">${p.flow.sizeClass}</span>` : ""}</td>`;
const signedTd = (cents: number | null | undefined, note = ""): string =>
  cents == null ? `<td>–</td>` : `<td class="${cents > 0 ? "pos" : cents < 0 ? "neg" : ""}">${signedUsd(cents)}${note}</td>`;

/** One settled position: what happened, in columns. */
function settledTr(p: PerpShadowPosition): string {
  const o = p.outcome;
  const result = !o
    ? "–"
    : o.floorSave
      ? '<span class="tag save">floor save</span>'
      : o.knockedOut
        ? '<span class="tag warn">knock-out</span>'
        : o.capExcessCents > 0
          ? `<span class="tag">past the cap</span> <i style="font-style:normal;color:var(--faint)">${usd(o.capExcessCents)} back</i>`
          : o.touchedAtIso
            ? '<span class="tag">touched</span>'
            : '<span class="tag">between</span>';
  return (
    `<tr><td>${shortUtc(p.settledAt ?? p.expiryIso)}</td>${sideTd(p)}${sizeTd(p)}` +
    `<td>${px(p.spotCents)} → ${p.settleCents != null ? px(p.settleCents) : "–"}</td>` +
    `<td>${px(p.floorStrikeCents)}</td><td>${px(p.capStrikeCents)}</td>` +
    `<td class="hi">${usd(p.creditCents)}</td><td>${result}</td>${signedTd(o?.deltaCents)}</tr>`
  );
}

/** One early close (flow mode): the position marked out at live prices. */
function closedTr(p: PerpShadowPosition): string {
  const co = p.closeOutcome;
  const v = p.closeValuation;
  return (
    `<tr><td>${shortUtc(p.closedAt ?? p.at)}</td>${sideTd(p)}${sizeTd(p)}` +
    `<td>${px(p.spotCents)} → ${v ? px(v.markCents) : "–"}</td>` +
    `<td>${px(p.floorStrikeCents)}</td><td>${px(p.capStrikeCents)}</td>` +
    `<td class="hi">${usd(p.creditCents)}</td>${signedTd(co?.deltaCents)}` +
    `<td>${co?.executionEdgeCents != null ? usd(Math.abs(co.executionEdgeCents)) : "legs unpriced"}</td></tr>`
  );
}

/** One open position: the terms it runs on and when it settles. */
function openTr(p: PerpShadowPosition): string {
  return (
    `<tr><td>${shortUtc(p.at)}</td>${sideTd(p)}${sizeTd(p)}<td>${px(p.spotCents)}</td>` +
    `<td>${px(p.floorStrikeCents)} <i style="font-style:normal;color:var(--faint)">${(p.floorPct * -100).toFixed(1)}%</i></td>` +
    `<td>${px(p.capStrikeCents)} <i style="font-style:normal;color:var(--faint)">+${(p.capPct * 100).toFixed(1)}%</i></td>` +
    `<td class="hi">${usd(p.creditCents)}</td><td>${p.flow?.closeAtIso ? `closes ${shortUtc(p.flow.closeAtIso)}` : shortUtc(p.expiryIso)}</td></tr>`
  );
}

/**
 * Estimated width of a headline value in em at the display weight, so the CSS can
 * size the type to the card (font-size = min(cap, 100cqi / --w)). Digits in a bold
 * tabular face sit near 0.6em; separators nearer 0.3em. Tags are ignored.
 */
export function fitEm(value: string): number {
  const text = value.replace(/<[^>]*>/g, "").replace(/&[a-z#0-9]+;/gi, "x");
  let em = 0;
  for (const ch of text) em += /[.,:;' ·–-]/.test(ch) ? 0.3 : /[a-z]/.test(ch) ? 0.55 : 0.62;
  return Math.max(1, Math.round(em * 100) / 100);
}
const fitStyle = (value: string): string => ` style="--w:${fitEm(value)}"`;

const kpi = (label: string, value: string, sub = "", tone: "" | "green" | "bad" | "mint" = ""): string =>
  `<div class="card"><div class="k">${label}</div><div class="v ${tone}"${fitStyle(value)}>${value}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`;
const bignum = (value: string, label: string, tone: "" | "green" = ""): string =>
  `<div class="bignum"><div class="n ${tone}"${fitStyle(value)}>${value}</div><div class="l">${label}</div></div>`;
const table = (head: string, rows: string): string => `<div class="tablewrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
const th = (...cols: string[]): string => cols.map((c) => `<th>${c}</th>`).join("");

/**
 * THE IDENTITY, as numbers. In plain mode the hedge is held leg for leg to expiry, so on every
 * settled position our P&L is the take booked at the quote and nothing else: no outcome risk.
 */
function identityKpis(s: PerpShadowSummary): string {
  const plain = s.capMode === "plain";
  const gap = s.writerCents - s.settledTakeCents;
  const holds = plain ? Math.abs(gap) <= Math.max(1, Math.round(s.settled * 0.5)) : true;
  const sub = !s.settled
    ? "starts with the first settled position"
    : plain
      ? `gap <b>${signedUsd(gap)}</b> on ${s.settled} settled · both legs held to expiry`
      : `knock-out buy-backs ${usd(s.knockoutDetail.buybackCents)} vs unvested credit kept ${usd(s.knockoutDetail.unvestedKeptCents)}`;
  return (
    kpi("our P&amp;L, settled", s.settled ? signedUsd(s.writerCents) : "–", sub, s.settled && holds ? "green" : "") +
    kpi("take booked at quote", s.settled ? usd(s.settledTakeCents) : "–", plain ? "our whole side: a published share of the credit" : "our side before buy-backs")
  );
}

function flowSections(s: PerpShadowSummary, rule: string | null | undefined): string {
  const f = s.flow;
  if (!f || !f.enabled) return "";
  const bk = f.book.latest;
  const saved = (a: number, b: number) => usd(Math.max(0, a - b));
  const sizeRows = (["small", "medium", "large"] as const)
    .map((k) => {
      const b = f.bySize[k];
      const words = k === "small" ? "small · under $25k" : k === "medium" ? "medium · $25k to $150k" : "large · over $150k";
      return `<tr><td>${words}</td><td class="hi">${b.positions}</td><td>${usd(b.notionalCents)}</td><td>${usd(b.creditCents)}</td><td>${b.refused ? `${b.refused}${f.depthRefusals[k] ? ` <i style="font-style:normal;color:var(--faint)">${f.depthRefusals[k]} for depth</i>` : ""}` : "–"}</td></tr>`;
    })
    .join("");
  const dayRows = f.notionalByDay.slice(0, 7).map((d) => `<tr><td>${d.day}</td><td class="hi">${d.positions}</td><td>${usd(d.notionalCents)}</td></tr>`).join("");
  const netting = bk
    ? `<div class="grid">
      ${kpi("open book", `${bk.positions} wraps`, `${bk.instruments} instruments · ${bk.expiries} expir${bk.expiries === 1 ? "y" : "ies"}`)}
      ${kpi("hedge legs, gross → net", `${bk.grossContracts} → ${bk.netContracts}`, bk.nettedShare == null ? "" : `<b>${(bk.nettedShare * 100).toFixed(0)}%</b> netted away`, "mint")}
      ${kpi("OKX fees saved", saved(bk.feeGrossCents, bk.feeNetCents), `of ${usd(bk.feeGrossCents)} leg for leg`, "green")}
      ${kpi("margin saved", saved(bk.marginGrossCents, bk.marginNetCents), `of ${usd(bk.marginGrossCents)} leg for leg · OKX simple, est.`, "green")}
      ${kpi(
        "slippage saved",
        bk.slippageGrossCents != null && bk.slippageNetCents != null ? saved(bk.slippageGrossCents, bk.slippageNetCents) : "–",
        bk.slippageGrossCents != null ? `of ${usd(bk.slippageGrossCents)} hedging each alone` : `${bk.unpricedInstruments} instrument${bk.unpricedInstruments === 1 ? "" : "s"} with no live book`,
        "green",
      )}
      ${f.book.avgNettedShare != null ? kpi("last 24h, average", `${(f.book.avgNettedShare * 100).toFixed(0)}% netted`, `${f.book.avgFeeSavedCents != null ? `fees ${usd(f.book.avgFeeSavedCents)}` : ""}${f.book.avgMarginSavedCents != null ? ` · margin ${usd(f.book.avgMarginSavedCents)}` : ""} per snapshot`) : ""}
    </div>`
    : `<div class="grid">${kpi("open book", "–", "first batch pending")}</div>`;
  const c = f.closes;
  const closes =
    c.done - c.unpriced > 0
      ? `<div class="grid">
      ${kpi("scheduled / done", `${c.scheduled} / ${c.done}`, c.unpriced ? `${c.unpriced} with a leg unpriced` : "")}
      ${kpi("protection vs unprotected", signedUsd(c.holderDeltaCents), "at the close, credit and collar unwound", c.holderDeltaCents >= 0 ? "green" : "bad")}
      ${kpi("unwind, crossing the book", signedUsd(c.unwindImmediateCents), `vs ${signedUsd(c.unwindPassiveCents)} at mids`)}
      ${kpi("execution edge", usd(Math.abs(c.executionEdgeCents)), "what working the legs keeps", "mint")}
    </div>`
      : `<div class="grid">${kpi("scheduled / done", `${c.scheduled} / ${c.done}`, "closes are valued at live prices as they fall due")}</div>`;
  return `
  <h2>Run as a book</h2>
  <div class="read">${escapeHtml(rule ?? "")}. Sizes, sides and arrival times are simulated; every price, fee and depth is the live OKX book at that second.</div>
  <div class="grid" style="grid-template-columns:minmax(280px,3fr) minmax(200px,2fr);align-items:start">
    <div>${table(th("by size", "wraps", "notional", "credit", "refused"), sizeRows)}</div>
    <div>${dayRows ? table(th("by day", "wraps", "notional"), dayRows) : ""}</div>
  </div>
  <h2>Netting the book</h2>
  ${netting}
  <div class="rule">Netted by exact instrument: a long's cap leg and a short's floor leg at the same strike and expiry cancel, and every wrap at the same strike aggregates into one order. Portfolio margin across strikes would be lower still; these are floors on the saving.</div>
  <h2>Early closes, at live prices</h2>
  ${closes}`;
}

export function renderPerpShadowHtml(input: PerpShadowPageInput): string {
  const s = input.summary;
  const period = s.firstAt ? `${utcDay(s.firstAt)} to ${utcDay(input.atIso)} UTC` : "not started; the first quote begins it";
  const cf = s.counterfactuals;
  const cfLine = cf.recordedSince ? `${cf.positionsWithCounterfactuals} positions since ${utcDay(cf.recordedSince)}` : "starts with the first quoted position";
  const plain = s.capMode === "plain";
  const cd = s.capDetail;
  const flowOn = !!s.flow?.enabled;
  const tenor = input.tenor ?? "weekly";
  const settledLine =
    s.settled === 0
      ? "Nothing has expired yet; the first print settles the first positions."
      : plain
        ? `${s.settled} settled: ${s.floorSaves} floor save${s.floorSaves === 1 ? "" : "s"}, ${cd.endedPastCap} ended past the cap (${usd(cd.capExcessCents)} of gains above it handed back against ${usd(
            cd.creditOnPastCapCents,
          )} of credit on those), ${s.settled - s.floorSaves - cd.endedPastCap} between the wings. ${cd.touched} touched the cap on the way.`
        : `${s.settled} settled: ${s.floorSaves} floor save${s.floorSaves === 1 ? "" : "s"}, ${s.knockouts} knocked out at the cap (paid what had vested, protection re-armed), ${
            s.settled - s.floorSaves - s.knockouts
          } ran to expiry between the wings.`;
  const refusalRows = Object.entries(s.refusalReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, n]) => `<tr><td>${escapeHtml(k.replace(/_/g, " "))}</td><td class="hi">${n}</td></tr>`)
    .join("");
  const settledRows = input.settled.slice(0, 15).map(settledTr).join("");
  const closedRows = (input.closed ?? []).slice(0, 10).map(closedTr).join("");
  const openRows = input.open.slice(0, 12).map(openTr).join("");
  const sizeSentence = flowOn
    ? "Wraps of every size, long and short, each priced from the live OKX book at its own size"
    : `The live product's collar, quoted every hour from the OKX book for a ${input.sizeBtc.toFixed(2)} BTC Hyperliquid position, long and short`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="120" />
<link rel="icon" href="data:," />
<title>Track record · Earn &amp; Protect</title>
<meta name="description" content="The Earn &amp; Protect collar quoted continuously from the live OKX book at the product's own terms, every position marked against the official delivery price. Simulated positions, real prices, real prints." />
<style>${SHADOW_CSS}</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="wordmark">Earn &amp; Protect <span>· track record · by <b>Atticus</b></span></div>
  <div><a href="${demoUrl()}">Demo</a><a href="/api/shadow">JSON</a><a href="/api/shadow/positions.csv">CSV</a></div>
</div></div>
<div class="wrap">
  <h1>Track record</h1>
  <div class="sub">${sizeSentence}, at the terms a user sees: a hard floor 6% out, the cap as far out as the book still pays, cash credit either way, written to ${
    tenor === "weekly" ? "the nearest Friday expiry at least three days out" : "the next daily expiry"
  }. Every position is settled on the Hyperliquid price path and OKX's official delivery print, protected versus unprotected. Positions are simulated; prices, fees, candles and prints are real.</div>
  <div class="pills">
    <span class="pill live">LIVE · ${escapeHtml(period)}</span>
    <span class="pill mint">${plain ? "plain collar · runs to expiry" : "knock-out · touch ends the cycle"}</span>
    <span class="pill">${tenor === "weekly" ? "weekly · Friday expiry" : "daily expiry"}</span>
    ${flowOn ? '<span class="pill">flow · run as a book</span>' : '<span class="pill">hourly · fixed size</span>'}
  </div>

  <div class="grid">
    ${kpi("positions quoted", String(s.positions), `${s.open} open · ${s.settled} settled${s.closed ? ` · ${s.closed} closed early` : ""}`, "green")}
    ${kpi("honest refusals", String(s.refusals), s.refusals ? "the market could not fund a credit" : "every quote funded")}
    ${kpi("cash credited", usd(s.creditCents), `${bpsPct(s.creditBpsOfNotional)} of notional`, "green")}
    ${kpi("protected notional", usd(s.notionalCents), `${s.bySide.long.positions} long · ${s.bySide.short.positions} short`)}
    ${kpi("protection vs unprotected", s.settled ? signedUsd(s.holderDeltaCents) : "–", s.settled ? "users' P&amp;L with the collar minus without, settled" : "settles with the first print", s.settled ? (s.holderDeltaCents >= 0 ? "green" : "bad") : "")}
    ${kpi("our take", usd(s.takeCents), "published share of the credit; waived when tiny")}
  </div>
  <div class="read" style="margin-top:12px">${escapeHtml(settledLine)}</div>

  <h2>We carry no outcome risk</h2>
  <div class="grid">
    ${identityKpis(s)}
    ${kpi("market funded", usd(s.grossCreditCents), `gross · OKX fees ${usd(s.venueFeeCents)}`)}
    ${kpi("venue spread paid", bpsPct(s.spreadCostBps), "of notional, mid vs touch: the number a better fill shrinks")}
  </div>

  <h2>The honest aggregate</h2>
  <div class="grid">
    ${kpi("cap distance written", s.avgCapPct === null ? "–" : `${(s.avgCapPct * 100).toFixed(1)}%`, "from price, average")}
    ${
      plain
        ? kpi("cap touched", s.settled ? `${cd.touched} of ${s.settled}` : "–", cd.avgHoursToTouch === null ? "nothing closes at a touch" : `avg ${cd.avgHoursToTouch}h in · nothing closed`) +
          kpi("ended past the cap", s.settled ? `${cd.endedPastCap} of ${s.settled}` : "–", cd.endedPastCap ? `${usd(cd.capExcessCents)} handed back vs ${usd(cd.creditOnPastCapCents)} credit` : "gains above the cap pay for the floor")
        : kpi("knock-outs", s.settled ? `${s.knockouts} of ${s.settled}` : "–", s.knockoutDetail.avgHoursToTouch === null ? "cap touched, cycle ended early" : `avg ${s.knockoutDetail.avgHoursToTouch}h in`)
    }
    ${kpi("funding at open", s.avgFundingBpsPer8h === null ? "–" : `${s.avgFundingBpsPer8h} bps/8h`, "Hyperliquid, average · not part of the credit")}
    ${kpi("basis at open", s.avgBasisBps === null ? "–" : `${s.avgBasisBps} bps`, "HL mark vs OKX index")}
    ${kpi("rule comparison", cf.positionsWithCounterfactuals ? String(cf.positionsWithCounterfactuals) : "–", `${escapeHtml(cfLine)} · report on request`)}
  </div>
  ${refusalRows ? `<h2>Why quotes were refused</h2>${table(th("reason", "count"), refusalRows)}` : ""}

  ${flowSections(s, input.flow)}

  ${
    settledRows
      ? `<h2>Settled <small>most recent first${input.settled.length > 15 ? ` · ${input.settled.length - 15} more in the CSV` : ""}</small></h2>
  ${table(th("settled", "side", "size", "open → settle", "floor", "cap", "credit", "result", "vs unprotected"), settledRows)}`
      : ""
  }
  ${closedRows ? `<h2>Closed early <small>at live prices, most recent first</small></h2>
  ${table(th("closed", "side", "size", "open → close", "floor", "cap", "credit", "vs unprotected", "unwind edge"), closedRows)}
  ${(input.closed ?? []).some((p) => p.closeOutcome?.deltaCents == null) ? `<div class="rule">A close marked <b>legs unpriced</b> fell due while the snapshot carried no live book for one of its legs. It is recorded as it was and never re-marked at a later price.</div>` : ""}` : ""}
  ${openRows ? `<h2>Open <small>next to settle first</small></h2>
  ${table(th("opened", "side", "size", "price", "floor", "cap", "credit", "settles"), openRows)}` : ""}

  <h2>How to read it</h2>
  <ul class="bullets">
    <li><b>Protection vs unprotected</b> is the user's P&amp;L with the collar and credit minus the P&amp;L of the bare position.</li>
    ${
      plain
        ? `<li><b>Floor save</b>: the floor clamped the loss. <b>Past the cap</b>: gains above the cap this cycle were handed back; they paid for the floor. <b>Touched</b>: price reached the cap on the Hyperliquid path; nothing closed. The whole credit is the user's in every case.</li>
    <li><b>Our take</b> is the published share of the net credit. Both legs are hedged leg for leg on OKX and held to expiry, so the take is our whole side: our P&amp;L equals the take booked.</li>`
        : `<li><b>Floor save</b>: the floor clamped the loss. <b>Knock-out</b>: price touched the cap, the cycle ended there, the user kept the position and every gain and was paid the credit vested to the touch.</li>
    <li><b>Our take</b> is the published share of the net credit; at a knock-out the short cap leg is bought back at the money, our cost against the unvested credit kept.</li>`
    }
    <li><b>Venue spread</b> is what crossing the OKX book costs versus mid; it is the number a better fill would shrink.</li>
  </ul>
  <div style="margin-top:14px"><a class="back" href="${demoUrl()}">Back to the demo</a><a class="back" href="/api/shadow">Raw JSON</a><a class="back" href="/api/shadow/positions.csv">Positions (CSV)</a></div>
  <footer>
    <b>What is real:</b> OKX option prices, depth and fees, Hyperliquid marks, candles and funding, OKX delivery prints. <b>What is simulated:</b> the positions${flowOn ? ", their sizes, sides, arrival times and close decisions" : ""}; no venue credentials, no wallets, nothing traded. Rendered ${escapeHtml(input.atIso.slice(0, 16).replace("T", " "))} UTC, refreshes every two minutes. Demonstration, not an offer.
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
  `<tr><th>rule</th><th>quoted</th><th>refused</th><th>cash / notional</th><th>cash</th><th>take</th><th>settled</th><th>floor</th><th>${plain ? "past the cap" : "knock-outs"}</th><th>user Δ</th><th>our P&amp;L</th></tr>`;

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
    ? `<tr><th>cap from price</th><th>quoted</th><th>refused</th><th>live pick</th><th>cash / notional</th><th>market odds past cap</th><th>settled</th><th>touched</th><th>past the cap</th><th>realized</th><th>handed back</th><th>release at touch</th><th>user Δ</th><th>OKX saw it</th></tr>`
    : `<tr><th>cap from price</th><th>quoted</th><th>refused</th><th>live pick</th><th>cash / notional</th><th>settled</th><th>knock-outs</th><th>rate</th><th>avg time to touch</th><th>buyback</th><th>our P&amp;L</th><th>OKX saw it</th></tr>`;

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
  // Venue reference: the identical collar read at Deribit and Bullish the second OKX quoted it.
  const vr = cf.venueReference;
  const venueRows = vr
    ? (Object.keys(vr) as Array<keyof typeof vr>)
        .map((v) => {
          const b = vr[v];
          const name = v === "deribit" ? "Deribit" : v === "bullish" ? "Bullish" : String(v);
          const vs = b.avgVsOkxBps == null ? "–" : `${b.avgVsOkxBps > 0 ? "+" : ""}${b.avgVsOkxBps.toFixed(2)} bps`;
          const vsC = b.avgVsOkxCents == null ? "" : ` <i style="color:var(--faint);font-style:normal">${signedUsd(b.avgVsOkxCents)}/BTC</i>`;
          return (
            `<tr><td>${name}</td><td>${b.read}</td><td>${b.priced}</td>` +
            `<td>${b.priced ? `${b.beatOkx} <i style="color:var(--faint);font-style:normal">${Math.round((b.beatOkx / b.priced) * 100)}%</i>` : "–"}</td>` +
            `<td class="hi">${vs}${vsC}</td>` +
            `<td>${b.buyAskPct == null ? "–" : `${b.buyAskPct}%`}</td><td>${b.sellBidPct == null ? "–" : `${b.sellBidPct}%`}</td><td>${b.errors}</td></tr>`
          );
        })
        .join("")
    : "";
  const venueRead = vr ? Object.values(vr).reduce((n, b) => n + b.read, 0) : 0;
  const venueLine = (() => {
    if (!vr || venueRead === 0) return "";
    const priced = (Object.entries(vr) as Array<[string, (typeof vr)[keyof typeof vr]]>).filter(([, b]) => b.priced > 0 && b.avgVsOkxBps != null);
    if (!priced.length) return "Neither reference venue had both sides resting on the legs OKX quoted; nothing to compare yet.";
    const best = priced.sort((a, b) => (b[1].avgVsOkxBps ?? -Infinity) - (a[1].avgVsOkxBps ?? -Infinity))[0];
    const name = best[0] === "deribit" ? "Deribit" : "Bullish";
    const bps = best[1].avgVsOkxBps as number;
    return bps > 0
      ? `${name} would have paid the holder ${bps.toFixed(2)} bps of spot more than OKX on average over ${best[1].priced} reads (beat OKX ${best[1].beatOkx} times): the number a FalconX quote should clear before it is accepted.`
      : `OKX's touch beat every reference on average (${name} was closest at ${bps.toFixed(2)} bps over ${best[1].priced} reads): pricing off OKX leaves nothing on the table so far.`;
  })();
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
      ${bignum(String(cf.positionsWithCounterfactuals), "positions compared", "green")}
      ${bignum(String(cf.baseline.settled), "of them settled")}
      ${plain ? bignum(String(cd.endedPastCap), "ended past the cap, live pick") : bignum(String(s.knockouts), "knock-outs, live cap")}
      ${bignum(s.settled ? signedUsd(s.writerCents) : "–", "writer's side, settled", s.writerCents >= 0 ? "green" : "")}
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

  ${
    venueRead > 0
      ? `<div class="card">
    <h2>Venue reference</h2>
    <div class="sub" style="margin-bottom:6px">The identical collar — buy the floor at the ask, sell the cap at the bid, same strikes, same expiry — read at Deribit and Bullish the second OKX quoted it. Positive means that venue would have paid the holder more. A reference for RFQ acceptance, not a price we quote.</div>
    <div class="tablewrap"><table>
      <tr><th>venue</th><th>read</th><th>both sides</th><th>beat OKX</th><th>vs OKX (net)</th><th>floor ask</th><th>cap bid</th><th>errors</th></tr>
      ${venueRows}
    </table></div>
    ${venueLine ? `<div class="read">${escapeHtml(venueLine)}</div>` : ""}
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
