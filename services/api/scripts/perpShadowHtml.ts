/**
 * Earn & Protect (perps) — the shadow record pages.
 *
 * Public: what was quoted from the live OKX book at the product's own terms
 * and what it did for the holder against the official delivery print.
 * Operator (token): what every other rule would have written from the same
 * book — tiers, fee rule, larger sizes — marked against the same print.
 */

import {
  PERP_TIERS,
  PERP_TIER_RULES,
  type PerpRuleBook,
  type PerpShadowPosition,
  type PerpShadowSummary,
  type PerpTier,
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
/** bps to one decimal: perp collar credits are single-digit bps of notional at the daily tenor */
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
}

function positionRow(p: PerpShadowPosition): string {
  const o = p.outcome;
  const tag = o ? (o.floorSave ? '<span class="tag save">floor</span>' : o.capHit ? '<span class="tag">cap</span>' : '<span class="tag">between</span>') : "";
  const right = o
    ? `${signedUsd(o.deltaCents)} <i>vs naked · settled ${px(p.settleCents ?? 0)}</i>`
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
  const settledLine =
    s.settled === 0
      ? "Nothing has expired yet; the first daily print settles the first positions."
      : `${s.settled} settled: ${s.floorSaves} floor save${s.floorSaves === 1 ? "" : "s"}, ${s.capHits} capped, ${s.settled - s.floorSaves - s.capHits} closed between. Protection ${
          s.holderDeltaCents >= 0 ? "added" : "cost"
        } ${usd(Math.abs(s.holderDeltaCents))} against holding naked; the writer kept ${usd(s.writerCents)}.`;
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
    <div class="sub">Every hour the live product's collar is quoted from the OKX book for a ${input.sizeBtc.toFixed(2)} BTC Hyperliquid position, long and short, at the terms a holder would see: floor 6% below, cap as wide as the book funds, cash credit either way. When the options expire, each position is marked against OKX's official delivery price, protected versus naked. Positions are simulated; prices, fees and prints are real.</div>
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
    <div class="read"><b>Protection vs naked</b> is the holder's P&amp;L with the collar and credit minus the P&amp;L of the bare position, at the official print. Negative is the usual cost of protection; positive means the floor paid more than the cap gave up. <b>Our take</b> is the published share of the net credit and is the writer's whole result: the hedge legs are the holder's terms bought and sold on OKX, so the outcome cancels leg for leg. <b>Venue spread</b> is what crossing the book costs versus mid; it is the number a better fill would shrink.</div>
    <a class="back" href="${demoUrl()}">Try the live demo</a> <a class="back" href="/api/shadow">Raw JSON</a> <a class="back" href="/api/shadow/positions.csv">Positions (CSV)</a>
  </div>
  <footer>
    <b>What is real:</b> OKX option prices and fees, Hyperliquid marks and funding, OKX delivery prints. <b>What is simulated:</b> the positions; no venue credentials, no wallets, nothing traded. Rendered ${escapeHtml(input.atIso.slice(0, 16).replace("T", " "))} UTC. Demonstration, not an offer.
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
}

const RULE_HEAD = `<tr><th>rule</th><th>quoted</th><th>refused</th><th>cash / notional</th><th>cash</th><th>take</th><th>settled</th><th>floor</th><th>cap</th><th>holder Δ</th><th>writer</th></tr>`;

function ruleTr(name: string, note: string, b: PerpRuleBook, opts: { base?: boolean } = {}): string {
  return (
    `<tr${opts.base ? ' class="base"' : ""}>` +
    `<td>${escapeHtml(name)}${note ? ` <span class="tag">${escapeHtml(note)}</span>` : ""}</td>` +
    `<td>${b.quoted}</td><td>${b.refused}</td>` +
    `<td class="hi">${escapeHtml(bpsPct(b.creditBpsOfNotional))}</td>` +
    `<td>${usd(b.creditCents)}</td><td>${usd(b.takeCents)}</td>` +
    `<td>${b.settled}</td><td>${b.floorSaves}</td><td>${b.capHits}</td>` +
    `<td>${b.settled ? signedUsd(b.holderDeltaCents) : "–"}</td><td>${b.settled ? signedUsd(b.writerCents) : "–"}</td>` +
    `</tr>`
  );
}

export function renderPerpShadowReportHtml(input: PerpShadowReportInput): string {
  const cf = input.summary.counterfactuals;
  const tq = input.token ? `?token=${encodeURIComponent(input.token)}` : "";
  const period = cf.recordedSince ? `${utcDay(cf.recordedSince)} to ${utcDay(input.atIso)} UTC` : "not started; the first quoted position begins it";
  const tierRows = [ruleTr("live book", "what was quoted", cf.baseline, { base: true }), ...PERP_TIERS.map((t: PerpTier) => ruleTr(`${t} tier`, "", cf.tiers[t]))].join("");
  const tierRules = PERP_TIERS.map(
    (t) => `<div class="row"><span>${t}</span><b style="font-weight:500;text-align:left">${escapeHtml(PERP_TIER_RULES[t])}</b></div>`,
  ).join("");
  const feeLabels = Object.keys(cf.feeRules);
  const feeRows = [ruleTr("live book", "what was quoted", cf.baseline, { base: true }), ...feeLabels.map((l) => ruleTr(feeRuleText(l).name, "", cf.feeRules[l]))].join("");
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
  const tenorLabels = Object.keys(cf.tenors);
  const tenorRows = [
    ruleTr("live book", `${cf.baseline.quoted ? "next daily" : ""}`, cf.baseline, { base: true }),
    ...tenorLabels.map((l) => ruleTr(`${l}${cf.tenors[l].avgDays != null ? ` · ${cf.tenors[l].avgDays}d` : ""}`, "", cf.tenors[l])),
  ].join("");
  const weekly = cf.tenors.weekly;
  const tenorLine =
    weekly && weekly.quoted > 0 && cf.baseline.quoted > 0
      ? `The same collar at the weekly pays ${bpsPct(weekly.creditBpsOfNotional)} of notional in cash against ${bpsPct(
          cf.baseline.creditBpsOfNotional,
        )} at the daily: one-day options a few percent out are worth ticks, so most of the daily's gross goes to venue fees. The weekly is where the credit is real; it also holds the position through a week of funding.`
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
    <div class="sub">Every position records what the other tiers, the other fee rule and larger sizes would have written from the same OKX snapshot at the same second; at expiry every alternative is marked against the same delivery print. Same positions, same book, same print; only the rule differs.</div>
    <div class="bignums">
      <div class="bignum"><div class="n green">${cf.positionsWithCounterfactuals}</div><div class="l">positions compared</div></div>
      <div class="bignum"><div class="n">${cf.baseline.settled}</div><div class="l">of them settled</div></div>
    </div>
    <div class="period">${escapeHtml(period)}</div>
  </div>

  <div class="card">
    <h2>Protection tiers</h2>
    <div class="sub" style="margin-bottom:6px">Three geometries from one book. Cash / notional is the holder's credit per dollar protected; holder Δ is protected minus naked over settled positions.</div>
    <div class="tablewrap"><table>${RULE_HEAD}${tierRows}</table></div>
    ${tierRules}
  </div>

  <div class="card">
    <h2>Fee rule</h2>
    <div class="sub" style="margin-bottom:6px">Same collar, different split. Floors, caps and hedges are held fixed; only the take and the holder's cash move.</div>
    <div class="tablewrap"><table>${RULE_HEAD}${feeRows}</table></div>
    ${feeRules}
  </div>

  <div class="card">
    <h2>Tenor</h2>
    <div class="sub" style="margin-bottom:6px">The live geometry at the next weekly expiry from the same snapshot. Quoted terms only: a weekly settles on a different print, so holder and writer columns stay empty here by design.</div>
    <div class="tablewrap"><table>${RULE_HEAD}${tenorRows}</table></div>
    ${tenorLine ? `<div class="read">${escapeHtml(tenorLine)}</div>` : ""}
  </div>

  <div class="card">
    <h2>Capacity</h2>
    <div class="sub" style="margin-bottom:6px">The live tier re-quoted at larger sizes, each wing walked down the visible depth. Cash per dollar protected and the spread paid are the numbers to watch.</div>
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
  <footer>Counterfactuals are computed at open from the OKX snapshot retained with the position and settled against the same delivery print as the live book. Nothing in the alternatives was traded. Rendered ${escapeHtml(input.atIso.slice(0, 16).replace("T", " "))} UTC.</footer>
</div>
</body>
</html>`;
}
