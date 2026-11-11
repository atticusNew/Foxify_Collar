/**
 * The BTC pairs page: a minimal trading UI. Three compact tables (the 15-minute window, the
 * next close, the 5 PM ET daily), both venues' books at each strike, the gap, a clean score,
 * the realized-vol model, the bands between the strikes, the index's regime, and one Launch
 * button per tenor that sends the picked pair to the trader's engine (or opens his page with
 * it). Server-rendered; the body re-fetches itself every cycle. No framework, no external
 * assets. No em dashes in copy.
 */

import type { Band, BookFailure, EpisodeSummary, HorizonSet, LegRead, LockEpisodesReport, PairsReport, PairLeg, Regime, StrikePair } from "./pairs";
import { pairId } from "./pairs";
import { pageLinksHtml, type PageLink } from "./pageLinks";

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const c = (v: number | null | undefined, digits = 1): string => (v === null || v === undefined || !Number.isFinite(v) ? "–" : `${v.toFixed(digits)}¢`);
const signed = (v: number | null | undefined, digits = 1): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  const z = Math.abs(v) < 0.5 * 10 ** -digits;
  return `${!z && v > 0 ? "+" : !z && v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}¢`;
};
const usd = (v: number | null | undefined, digits = 0): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "–" : `$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const num = (v: number, digits = 0): string => v.toLocaleString("en-US", { maximumFractionDigits: digits });
const et = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return `${d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET`;
};
const etTime = (iso: string): string => et(iso).replace(/^.*?, /, "");
const px = (x: number): string => (Number.isInteger(x) ? x.toFixed(0) : x.toFixed(2).replace(/0$/, ""));
const PLACE = { below: "below", atm: "at the money", above: "above" } as const;
const V = (v: string) => (v === "kalshi" ? "K" : "P");
const left = (sec: number): string => (sec >= 5400 ? `${Math.round(sec / 60)} min` : sec >= 600 ? `${Math.floor(sec / 60)} min` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`);

/** "Next close" is the hour closing soonest; when that is the 5 PM ET contract (Kalshi lists it in the same series), say so. */
export const horizonLabel = (h: "fifteen" | "hourly" | "daily", settlesAt: string): string => {
  if (h === "fifteen") return "Next 15 minutes, up or down";
  if (h === "daily") return "Daily, 5 PM ET";
  const hour = Number(new Date(settlesAt).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }));
  return hour === 17 ? "Next close, the 5 PM ET contract" : "Hourly, next close";
};

/** The label the Launch button carries for a pair: the strike and where it sits. */
export function pickLabel(p: StrikePair): string {
  return p.horizon === "fifteen" ? `${usd(p.strike, p.strike % 1 ? 2 : 0)} price to beat` : `${usd(p.strike)} ${PLACE[p.place]}`;
}

/** A venue whose book did not answer: why, in plain words, and the listing's price marked as such. No URL: that stays in the JSON. */
function noBookCell(e: BookFailure): string {
  const bid = e.listing && e.listing.bidCents > 0 ? px(e.listing.bidCents) : "–";
  const ask = e.listing && e.listing.askCents > 0 && e.listing.askCents < 100 ? px(e.listing.askCents) : "–";
  return `<td class="dim nobook">${esc(e.reason)}${e.listing ? `<small>listing price ${bid} / ${ask}, no size</small>` : ""}</td>`;
}

const secs = (v: number): string => `${Math.round(v)}s`;

/**
 * One book's age in a line: when we read it, how long the venue's cache had held that copy, and
 * the venue's own stamp, each named for what it is. A venue that stamps nothing is said to.
 */
export function readLine(r: LegRead | null): string {
  if (!r) return "";
  const cache = r.cacheAgeSec !== null ? ` · ${secs(r.cacheAgeSec)} in the venue's cache` : "";
  const stamp = r.venueAgeSec !== null ? `venue stamp ${secs(r.venueAgeSec)} old` : "venue stamp not given";
  return `read ${secs(r.fetchAgeSec)} ago${cache} · ${stamp}`;
}

function legCell(l: PairLeg | null, failed?: BookFailure): string {
  if (failed) return noBookCell(failed);
  if (!l) return '<td class="dim">not listed</td>';
  const bid = l.bidCents > 0 ? px(l.bidCents) : "–";
  const ask = l.askCents > 0 && l.askCents < 100 ? px(l.askCents) : "–";
  const depth = l.bidQty || l.askQty ? `${num(l.bidQty)} × ${num(l.askQty)}` : "depth not read";
  const age = readLine(l.read);
  return `<td><a href="${esc(l.url)}" target="_blank" rel="noopener"><b>${bid}</b> / <b>${ask}</b></a><small>${depth}</small>${age ? `<small class="age">${esc(age)}</small>` : ""}</td>`;
}

function spark(series: Array<[number, number]> | undefined): string {
  if (!series || series.length < 2) return "";
  const W = 90;
  const H = 18;
  const vals = series.map(([, g]) => g);
  const lim = Math.max(1, ...vals.map((v) => Math.abs(v)));
  const x = (i: number) => (i / (series.length - 1)) * W;
  const y = (v: number) => H / 2 - (v / lim) * (H / 2 - 1);
  const pts = series.map(([, g], i) => `${x(i).toFixed(1)},${y(g).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><line class="zero" x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}"/><polyline points="${pts}"/></svg>`;
}

const STALE_TAG = '<span class="tag">stale read</span>';

/** A gap on a stale read is shown, muted and tagged, and never coloured as an edge: part of it is the age of the read. */
function gapCell(p: StrikePair): string {
  if (p.gapCents === null) return '<td class="dim">–</td>';
  const stale = p.freshness === "stale";
  const cls = stale ? "stale" : Math.abs(p.gapCents) >= 2 ? "hot" : Math.abs(p.gapCents) >= 1 ? "warm" : "";
  const h = p.persistence;
  return `<td class="${cls}">${signed(p.gapCents, 1)}${stale ? STALE_TAG : ""}${h ? `<small>${spark(h.series)}${Math.round(h.sameSign * 100)}% same sign · ${h.n}</small>` : ""}</td>`;
}

function bothCell(p: StrikePair): string {
  const l = p.lock;
  if (!l) return '<td class="dim">–</td>';
  const stale = p.freshness === "stale";
  return `<td${stale ? ' class="stale"' : ""}>${l.edgeCents > 0 ? `<b${stale ? "" : ' class="ok"'}>locks ${c(l.edgeCents, 2)}</b>` : `<b>${c(l.costCents, 2)}</b>`}${stale ? STALE_TAG : ""}<small>Yes ${V(l.yesOn)} ${px(l.yesAtCents)} + No ${V(l.noOn)} ${px(l.noAtCents)} + fees ${c(l.feesCents, 2)}${l.qty ? ` · ${num(l.qty)}` : ""}</small></td>`;
}

function scoreCell(p: StrikePair): string {
  // a failed book says why in its own venue's cell; the reading would only repeat it
  if (p.errors.length) return '<td class="dim">–<small>not scored without both books</small></td>';
  if (p.score === null) return `<td class="dim">–<small>${esc(p.reading)}</small></td>`;
  const cls = p.score >= 70 ? "ok" : p.score >= 40 ? "warm" : "hot";
  return `<td><b class="${cls} big">${p.score}</b><small>${esc(p.reading)}</small></td>`;
}

/** The realized-vol model against the venues' mid: where the model and the books disagree is where a view pays. */
function modelCell(p: StrikePair): string {
  if (p.modelCents === null) return '<td class="dim">–<small>no index history yet</small></td>';
  const mids = [p.kalshi, p.poly].map((l) => (l && l.bidCents > 0 && l.askCents > 0 && l.askCents < 100 ? (l.bidCents + l.askCents) / 2 : null)).filter((v): v is number => v !== null);
  const mid = mids.length ? mids.reduce((a, v) => a + v, 0) / mids.length : null;
  const diff = mid !== null ? Math.round((p.modelCents - mid) * 10) / 10 : null;
  const cls = diff === null ? "" : Math.abs(diff) >= 10 ? "hot" : Math.abs(diff) >= 5 ? "warm" : "";
  return `<td><b class="${cls}">${p.modelCents.toFixed(0)}%</b><small>${diff === null ? "venues not two-sided" : `${diff > 0 ? "+" : ""}${diff.toFixed(1)} on the mids`}</small></td>`;
}

function useCell(p: StrikePair): string {
  if (p.errors.length) return '<td class="act"></td>';
  const id = pairId(p);
  return `<td class="act"><button type="button" class="use" data-id="${esc(id)}" data-horizon="${p.horizon}" title="make this the pair the Launch button sends">use</button></td>`;
}

/** The range between two strikes, the way the ladder lets a trader buy it: Yes just below plus No just above. */
function bandRow(b: Band, cols: number): string {
  const implied =
    b.impliedCents === null
      ? "venues not two-sided on both strikes"
      : `venues imply <b>${b.impliedCents.toFixed(1)}¢</b>${b.impliedKalshiCents !== null && b.impliedPolyCents !== null ? ` <span class="dim">(K ${b.impliedKalshiCents.toFixed(1)} / P ${b.impliedPolyCents.toFixed(1)})</span>` : ""}`;
  const model = b.modelCents !== null ? ` · model <b>${b.modelCents.toFixed(0)}%</b>` : "";
  const width = `${usd(b.widthUsd)} wide${b.sigmas !== null ? `, ${b.sigmas.toFixed(1)}σ` : ""}`;
  let own = "";
  if (b.cost) {
    const [y, n] = b.cost.legs;
    const edge = b.edgeCents !== null ? (b.edgeCents > 0 ? ` · <b class="ok">cross ${c(b.edgeCents, 1)}</b>` : ` · costs ${c(Math.abs(b.edgeCents), 1)} over the mids`) : "";
    own = ` · own it for <b>${c(b.cost.costCents, 1)}</b>: Yes ${V(y.venue)} ${px(y.priceCents)} + No ${V(n.venue)} ${px(n.priceCents)} + fees ${c(b.cost.feesCents, 1)}${b.cost.qty ? ` · ${num(b.cost.qty)}` : ""}${edge}`;
  }
  return `<tr class="band"><td colspan="${cols}"><span class="lbl">Band ${usd(b.lower)} to ${usd(b.upper)}</span> <span class="dim">${width}</span> · ${implied}${model}${own}</td></tr>`;
}

function table(s: HorizonSet, spotUsd: number, bestId: string | null): string {
  const fifteen = s.horizon === "fifteen";
  // the one-row window has no use button while its row is the default pick; on a stale read it is not, and sending it is the trader's call
  const act = !fifteen || s.pairs.some((p) => p.freshness === "stale" && !p.errors.length);
  const head = `<tr><th>${fifteen ? "Price to beat" : "Strike"}</th><th>Kalshi<br><small>Yes bid / ask · size</small></th><th>Polymarket US<br><small>Yes bid / ask · size</small></th><th>K − P<br><small>mids · window</small></th><th>Both sides<br><small>after fees</small></th><th>Clean<br><small>0 to 100</small></th><th>Model<br><small>realized vol</small></th>${act ? '<th class="act"></th>' : ""}</tr>`;
  const cols = act ? 8 : 7;
  const rows: string[] = [];
  s.pairs.forEach((p, i) => {
    const id = pairId(p);
    const rel = p.strike - spotUsd;
    const relTxt = Math.abs(rel) < 1 ? "at spot" : fifteen ? `BRTI ${rel < 0 ? "+" : "−"}${usd(Math.abs(rel))} ${rel < 0 ? "above" : "below"}` : `${rel > 0 ? "+" : "−"}${usd(Math.abs(rel))}`;
    const best = bestId !== null && id === bestId;
    const sig = s.sigmaUsd && !fifteen ? ` · ${(Math.abs(rel) / s.sigmaUsd).toFixed(1)}σ` : "";
    if (i > 0 && s.bands[i - 1]) rows.push(bandRow(s.bands[i - 1], cols));
    const failedOn = (venue: "kalshi" | "polymarket_us") => p.errors.find((e) => e.venue === venue);
    rows.push(
      `<tr class="${p.place === "atm" && !fifteen ? "atm" : ""}${best ? " best" : ""}" data-id="${esc(id)}" data-label="${esc(pickLabel(p))}${p.freshness === "stale" ? " · stale read" : ""}"${p.errors.length ? " data-nolaunch" : ""}><td class="lbl"><b>${usd(p.strike, fifteen && p.strike % 1 ? 2 : 0)}</b><small>${fifteen ? relTxt : `${PLACE[p.place]} · ${relTxt}${sig}`}${best ? ' · <span class="ok">cleanest</span>' : ""}</small></td>${legCell(p.kalshi, failedOn("kalshi"))}${legCell(p.poly, failedOn("polymarket_us"))}${gapCell(p)}${bothCell(p)}${scoreCell(p)}${modelCell(p)}${act ? useCell(p) : ""}</tr>`,
    );
  });
  const missing = !s.venues.kalshi ? '<p class="warn">Kalshi lists no contract at this close; Polymarket US stands alone.</p>' : !s.venues.poly ? '<p class="warn">Polymarket US lists no contract at this close; Kalshi stands alone.</p>' : "";
  return `${missing}<div class="tbl"><table>${head}${rows.join("")}</table></div>`;
}

/** Why a tenor has nothing for Launch to send. */
function noPickReason(s: HorizonSet): string {
  if (s.pairs.some((p) => p.errors.length)) return "a book is not answering";
  if (s.pairs.some((p) => p.freshness === "stale")) return "read too old to judge";
  return "nothing two-sided";
}

const span = (sec: number): string => (sec < 120 ? `${num(sec, 1)}s` : `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`);

/**
 * The tenor's lock episodes today, one line, always with the label that says what the dollars
 * are: cents times contracts seen on the book, nothing traded. Shown with no window open too:
 * the day's count does not go away between windows.
 */
function episodesLine(e: EpisodeSummary | undefined, all: LockEpisodesReport | undefined): string {
  if (!e || !all) return "";
  const label = `<small>${esc(all.label)}. An episode is one pair showing a lock on ${all.minCycles} or more cycles, both reads fresh, until a fresh read shows it gone.</small>`;
  if (!e.episodes) return `<p class="epi">Lock episodes today (UTC): <b>none</b>${label}</p>`;
  const last = e.recent[0];
  const latest = last
    ? ` · latest ${last.open ? "began" : "ended"} ${etTime(last.open ? last.startedAt : last.endedAt)} at ${usd(last.strike, last.strike % 1 ? 2 : 0)}: ${span(last.durationSec)}, at least ${c(last.minLockCents, 2)} on ${num(last.minQty, 0)} contracts`
    : "";
  return `<p class="epi">Lock episodes today (UTC): <b>${e.episodes}</b>${e.open ? ` (${e.open} still open)` : ""} · median ${span(e.medianDurationSec ?? 0)} · longest ${span(e.longestDurationSec ?? 0)} · total <b>${usd(e.totalValueCents / 100, 2)}</b>${latest}${label}</p>`;
}

function regimeChip(r: Regime | null): string {
  if (!r) return '<span>Regime <b>–</b><small>reading the index</small></span>';
  const cls = r.label === "expanding" ? "hot" : r.label === "contained" ? "ok" : "";
  const parts: string[] = [];
  if (r.m15) parts.push(`15 min: range ${usd(r.m15.rangeUsd)}, net ${r.m15.netUsd >= 0 ? "+" : "−"}${usd(Math.abs(r.m15.netUsd))}${r.m15.volPct !== null ? `, ${r.m15.volPct.toFixed(0)}% realized` : ""}`);
  if (r.m60) parts.push(`hour: range ${usd(r.m60.rangeUsd)}${r.m60.volPct !== null ? `, ${r.m60.volPct.toFixed(0)}% realized` : ""}`);
  return `<span>Regime <b class="${cls}">${r.label ?? "–"}</b><small>${esc(parts.join(" · ") || "not enough index prints yet")}</small></span>`;
}

/** The part of the page that changes every cycle. */
export function renderPairsBody(d: PairsReport): string {
  // the bundle lists pairs on a stale read last, so a stale first entry means none can be judged: nothing is called cleanest
  const cleanest = d.bundle[0] && d.bundle[0].freshness !== "stale" ? d.bundle[0] : null;
  const bestId = cleanest ? pairId(cleanest) : null;
  const health = Object.entries(d.health)
    .map(([k, h]) => `<span class="${h.ok ? "ok" : "bad"}">${esc(k)} ${h.ok ? `${h.ms}ms` : esc(h.detail ?? "down")}</span>`)
    .join(" · ");
  const block = (s: HorizonSet | null, horizon: "fifteen" | "hourly" | "daily", title: string, none: string) => {
    const episodes = episodesLine(d.lockEpisodes?.[horizon], d.lockEpisodes);
    if (!s) return `<section data-horizon="${horizon}"><h2>${title}</h2><p class="dim">${none}</p>${episodes}</section>`;
    const grid = s.stepUsd ? ` · ${usd(s.stepUsd)} grid` : "";
    const sigma = s.sigmaUsd ? ` · 1σ to close ${usd(s.sigmaUsd)}` : "";
    const bound = ` · a read older than ${s.staleAfterSec}s is stale`;
    const pick = s.pairs.find((p) => pairId(p) === s.pick) ?? null;
    return `<section data-horizon="${horizon}" data-pick="${esc(s.pick ?? "")}"><div class="h"><h2>${horizonLabel(s.horizon, s.settlesAt)} <span class="meta">closes ${et(s.settlesAt)} · ${left(s.secondsToClose)} left${grid}${sigma}${bound}</span></h2><div class="launch"><button type="button" class="go" data-horizon="${horizon}"${s.pick ? "" : " disabled"}>Launch</button><span class="picklabel">${pick ? esc(pickLabel(pick)) : esc(noPickReason(s))}</span><small class="status" data-status="${horizon}"></small></div></div>${table(s, d.spotUsd, bestId)}${episodes}</section>`;
  };
  return `<div class="strip"><span>BRTI <b>${usd(d.spotUsd, 0)}</b><small>${esc(d.spotSource)} · ${etTime(d.at)}</small></span>${
    cleanest
      ? `<span>Cleanest now <b>${usd(cleanest.strike, cleanest.horizon === "fifteen" && cleanest.strike % 1 ? 2 : 0)}</b><small>${horizonLabel(cleanest.horizon, cleanest.settlesAt)} · ${cleanest.horizon === "fifteen" ? "price to beat" : PLACE[cleanest.place]} · score ${cleanest.score}</small></span>`
      : `<span>Cleanest now <b>–</b><small>${d.bundle[0] ? "every two-sided pair is on a stale read" : "no strike two-sided on both"}</small></span>`
  }${regimeChip(d.regime)}<span class="right"><small>refresh ${d.intervalSec}s · ${d.historyPoints} readings · ${health}</small></span></div>
${block(d.fifteen, "fifteen", "Next 15 minutes, up or down", "No 15-minute window open on either venue (the next opens on the quarter hour).")}
${block(d.hourly, "hourly", "Hourly, next close", "No contract closes within 90 minutes on either venue.")}
${block(d.daily, "daily", "Daily, 5 PM ET", "No daily contract within 36 hours (none is listed on Fridays; the weekly takes that close).")}`;
}

export function renderPairsHtml(d: PairsReport, opts: { token?: string; base?: string; launchUrl?: string; launchMode?: "send" | "open"; links?: PageLink[] } = {}): string {
  const base = (opts.base ?? "").replace(/\/$/, "");
  const q = opts.token ? `?k=${encodeURIComponent(opts.token)}&` : "?";
  const mode = opts.launchMode === "open" ? "open" : "send";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>BTC pairs</title>
<style>
:root{--ink:#111;--dim:#6b7280;--line:#e5e7eb;--k:#0a66c2;--hot:#b91c1c;--warm:#b45309;--ok:#047857;--best:#f0fdf4;--pick:#eff6ff}
*{box-sizing:border-box}body{margin:0;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;color:var(--ink);background:#fff}
main{max-width:1240px;margin:0 auto;padding:14px 16px 40px}header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}h1{font-size:18px;margin:0;letter-spacing:-.01em}h1 small{display:inline;color:var(--dim);font-weight:400;font-size:13px;margin-left:8px}
.h{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin:22px 0 6px}h2{font-size:15px;margin:0}.meta{font-size:12px;font-weight:400;color:var(--dim);margin-left:8px}
.launch{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.launch .picklabel{font-size:13px;font-variant-numeric:tabular-nums}.launch small{display:inline;min-width:120px}
.dim{color:var(--dim)}small{color:var(--dim);font-size:11px;display:block}.warn{color:var(--warm);font-size:12px;margin:4px 0}
.strip{display:flex;flex-wrap:wrap;gap:8px 22px;align-items:center;margin:10px 0 2px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:#fafafa}.strip b{font-variant-numeric:tabular-nums;font-size:16px}.strip .right{margin-left:auto}.strip .right small{display:inline}
.tbl{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th{font-weight:600;text-align:left;color:var(--dim);font-size:11px;border-bottom:1px solid var(--line);padding:4px 8px;vertical-align:bottom;white-space:nowrap}
td{padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:top}td.lbl b{font-size:15px}td small{white-space:normal;max-width:210px}td a{color:inherit;text-decoration:none;border-bottom:1px dotted var(--dim)}tr.atm td{background:#fafafa}tr.best td{background:var(--best)}tr.picked td{background:var(--pick)}tr.picked td.lbl b{color:var(--k)}
tr.band td{padding:4px 8px 4px 18px;font-size:12px;color:var(--ink);background:#fff;white-space:normal;border-bottom:1px dashed var(--line)}tr.band .lbl{font-weight:600}
.big{font-size:17px}.hot{color:var(--hot);font-weight:600}.warm{color:var(--warm)}.ok{color:var(--ok)}.bad{color:var(--hot)}
td.nobook{white-space:normal;max-width:230px;font-size:12px}
.epi{font-size:12px;margin:6px 0 0;font-variant-numeric:tabular-nums}.epi small{margin-top:1px}
td.stale,td.stale b{color:var(--dim);font-weight:400}.tag{display:inline-block;margin-left:6px;padding:0 5px;border:1px solid var(--warm);border-radius:4px;color:var(--warm);font-size:10px;font-weight:600;line-height:15px;vertical-align:middle;white-space:nowrap}
td.act{text-align:right}.go{background:var(--k);color:#fff;border:0;border-radius:7px;padding:7px 16px;font:600 13px inherit;cursor:pointer}.go:hover{filter:brightness(1.08)}.go:disabled{opacity:.5;cursor:default}.use{background:#fff;color:var(--k);border:1px solid var(--line);border-radius:7px;padding:5px 9px;font:500 12px inherit;cursor:pointer}tr.picked .use{background:var(--k);color:#fff;border-color:var(--k)}
svg.spark{width:90px;height:18px;display:inline-block;vertical-align:middle;margin-right:6px}svg.spark polyline{fill:none;stroke:var(--k);stroke-width:1.2}svg.spark .zero{stroke:var(--line)}
details{margin:14px 0 0;font-size:12px;color:var(--dim)}summary{cursor:pointer;color:var(--k)}details p{margin:6px 0}details code{background:#f3f4f6;padding:1px 5px;border-radius:4px;color:var(--ink)}
.engine{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}.engine input[type=url]{flex:1;min-width:260px;font:13px inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px}.engine button{font:500 12px inherit;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:#fff;cursor:pointer}.engine label.mode{display:inline-flex;align-items:center;gap:4px;color:var(--ink)}
.limits{padding-left:18px;margin:6px 0}.limits li{margin:4px 0}footer{margin-top:18px;color:var(--dim);font-size:11px}
@media (max-width:760px){td.lbl,th:first-child{position:sticky;left:0;background:#fff;z-index:1}td.act,th.act{position:sticky;right:0;background:#fff;z-index:1;box-shadow:-6px 0 8px -6px rgba(0,0,0,.15)}tr.atm td.lbl,tr.atm td.act{background:#fafafa}tr.best td.lbl,tr.best td.act{background:var(--best)}tr.picked td.lbl,tr.picked td.act{background:var(--pick)}td small{white-space:nowrap;max-width:none}td.lbl small{white-space:normal;max-width:70px}tr.band td{position:static;white-space:normal}.h{align-items:flex-start}}
</style></head><body><main>
${pageLinksHtml(opts.links, "BTC pairs")}<header><h1>BTC pairs <small>Kalshi and Polymarket US · same strike, same close, same index · read-only</small></h1><span class="dim" style="font-size:12px">Launch hands the picked pair to your engine; nothing here places an order.</span></header>
<div id="body">${renderPairsBody(d)}</div>
<details><summary>Engine endpoint and the API</summary>
<div class="engine"><label for="engine">Engine</label><input id="engine" type="url" placeholder="https://your-engine.example/btc-pair" value="${esc(opts.launchUrl ?? "")}"><label class="mode"><input type="radio" name="mode" value="send"${mode === "send" ? " checked" : ""}> send (POST JSON)</label><label class="mode"><input type="radio" name="mode" value="open"${mode === "open" ? " checked" : ""}> open (your page, pair in the URL)</label><button type="button" id="engine-save">Save</button><button type="button" id="engine-test">Test</button><span id="engine-status"></span></div>
<p>One Launch per tenor. It sends the tenor's picked pair: the cleanest scored strike by default, or the row whose <code>use</code> you pressed. <b>send</b> does <code>POST</code> with JSON <code>{ type: "atticus.btc_pair", version: 1, at, spotUsd, index: "BRTI", pair, set, bands, regime }</code>: <code>pair</code> carries <code>horizon</code> (fifteen, hourly, daily), <code>place</code>, <code>strike</code>, <code>settlesAt</code>, both legs (<code>kalshi.id</code> is the Kalshi ticker, <code>poly.id</code> the Polymarket US market slug; bid, ask, sizes, fee coefficient, url, and <code>read</code>: when the book was fetched, the venue's stamp, and the ages in seconds when the pair was priced), <code>gapCents</code>, <code>spreadCents</code>, <code>depth</code>, <code>lock</code>, <code>persistence</code>, <code>score</code>, <code>modelCents</code>, <code>errors</code> (books that did not answer; that venue's leg is then <code>null</code>), <code>freshness</code> (fresh, stale or null) with <code>staleAfterSec</code>; <code>set</code> the tenor (<code>secondsToClose</code>, <code>stepUsd</code>, <code>sigmaUsd</code>, <code>pick</code>); <code>bands</code> the ranges between the tenor's strikes with the two legs each (<code>side</code> yes or no, <code>venue</code>, <code>id</code>, <code>priceCents</code>, <code>qty</code>, <code>feeCents</code>), what the venues imply, the model, the cost and the edge; <code>regime</code> the index's last 15 and 60 minutes. Test sends <code>{ type: "atticus.btc_pair.ping" }</code>. The endpoint must allow cross-origin POST from this page. <b>open</b> opens your URL in a new tab with <code>atticus=btc_pair&amp;id=&lt;Kalshi ticker&gt;&amp;horizon=&amp;strike=&amp;settlesAt=&amp;kalshi=&amp;poly=&amp;src=&lt;this page's /api/pair URL for it&gt;</code> (add the token to <code>src</code> if this page has one); your page pulls the JSON from <code>src</code>.</p>
<p><code>GET ${esc(base)}/api/pairs</code> everything · <code>GET ${esc(base)}/api/bundle</code> ranked pairs as launch payloads · <code>GET ${esc(base)}/api/pair?horizon=fifteen|hourly|daily&amp;place=below|atm|above|pick</code> or <code>?id=&lt;Kalshi ticker | Polymarket US slug&gt;</code> one pair · <code>GET ${esc(base)}/api/episodes</code> the lock episodes kept · <code>GET ${esc(base)}/api/replay?edge=1&amp;size=10&amp;lag=0,10,30&amp;days=1</code> what a rule would have captured from the stored cycles if you were that many seconds slow (paper only; at most 7 days and 4 lags a request) · <code>GET ${esc(base)}/api/stream</code> server-sent events, one <code>pairs</code> event per cycle${opts.token ? " (add <code>k=</code> the token to each)" : ""}.</p>
<ul class="limits">
<li>Both venues settle on the BRTI 60-second average into the close and list the same grid ($100 hourly, $250 daily), so a row is one contract with two books. The 15-minute window is one contract per venue, Up when BRTI closes at or above the price to beat (the BRTI average before the window opened; both venues print the same number). Polymarket US skips the 5 PM ET hour (its daily owns it) and lists no daily on Fridays.</li>
<li>At the money is the listed strike nearest BRTI this cycle; one each way is the ladder's own next strike. K − P is Kalshi's mid minus Polymarket US's; the sparkline and "same sign" cover the window.</li>
<li>Both sides: Yes at one venue's ask plus No at 100 minus the other's Yes bid, plus both taker fees (Kalshi 0.07, Polymarket US the market's coefficient, 0.095 at Tier 1); under 100¢ locks. Size is the thinner level.</li>
<li>Band: Yes just below plus No just above. One leg pays whatever happens, both pay inside, so the band costs the lower Yes ask minus the upper Yes bid plus fees per $1 paid inside; each leg is taken on the venue that sells it cheapest. "Venues imply" is the lower mid minus the upper mid; "model" is a normal move at the trailing hour's realized vol over the time to the close; "costs over the mids" is the premium paid to own the range against what the venues themselves say it is worth.</li>
<li>Model: the probability BRTI settles at or above the strike under that same realized-vol normal. It is a yardstick from the index's own recent movement, not an options smile; where it sits far from the venues' mids is where a view pays or where the venues know something the last hour does not.</li>
<li>Regime: the last 15 minutes' realized vol against the last hour's. Under 0.7 contained, over 1.4 expanding. A contained market favours owning the band; an expanding one favours the wings.</li>
<li>Clean: 40% tightness (both spreads summed, 10¢ scores nothing), 30% depth (thinnest best level, 200 contracts full), 30% agreement of mids (5¢ apart scores nothing). Scored only when both venues are two-sided. It ranks tradability; K − P, Both sides and the bands carry the edge.</li>
<li>A book that does not answer is that row's problem only. Its venue's cells say why in plain words (Polymarket US answers "not found" for a new contract's book for a few minutes after it opens), the row shows the other venue's book, and it has no gap, no lock, no score and no Launch. A price marked "listing price, no size" comes from the venue's listing, not its book, and is never priced. The address that was asked is in the JSON under <code>errors</code>, not here.</li>
<li>Under each book: when it was read (our clock), how long the venue's cache had already held that copy where the venue says, and the venue's own stamp on the book where it gives one. All three are as of the reading shown, not as of now. Kalshi's orderbook carries no stamp, so it says "not given". Polymarket US stamps the book's last change, so a quiet book shows an old stamp on a new copy.</li>
<li>Stale read: when either book's copy (our read plus the time the venue's cache had held it) is older than the tenor's bound, 15 seconds on the 15-minute window and 30 on the hourly and daily, the row still shows both books but K − P and Both sides are tagged and greyed, the gap is left out of the window, and the row is not what Launch sends by default (its <code>use</code> button still works). The bounds are a judgment from two short samples, not a tested threshold: Polymarket US's public book came from a cache that holds a copy up to 30 seconds, while Kalshi's book moved several times in that span. Score and edge stay separate: a stale read says nothing about the score.</li>
<li>Lock episode: the same pair (the same contract on both venues, bought the same way round) showing a lock after fees above zero on two or more cycles, every one of them on fresh reads. It runs from the first cycle that showed it to the last; a fresh read with no lock ends it, and so does the contract closing. A cycle on a stale read or a book that did not answer shows nothing either way: it is not counted and does not end the episode, so one standing lock is one episode however often the cached copy ages past the bound. A lock that flips direction starts a new one. Its dollars are the smallest lock seen times the smallest size seen (the thinner of the two top-of-book levels), so they are a floor on what was on the book, measured, with no order placed; they are not what a trader would have captured. The page reads every ${d.intervalSec} seconds, so an episode's length is known to that grain, and on the 15-minute window the 15-second bound against a 30-second cache means about every third cycle cannot be judged: a lock that went and came back inside such a cycle is counted as one episode. Cycles inside one cache life read the same Polymarket US copy, so a two-cycle episode is two Kalshi reads against one Polymarket US snapshot: it shows Kalshi's side held, not that the other did.</li>
<li>Venues are read within one cycle, not at one instant. Kalshi links open the series page unless the deploy sets the event URL pattern.</li>
</ul>
<footer>Kalshi public market API (KXBTCD, KXBTC15M) · Polymarket US public Retail API (gateway.polymarket.us) · BRTI prints from the same gateway. No credentials loaded.</footer>
</details>
</main>
<script>
(function(){
  var BASE=${JSON.stringify(base)},Q=${JSON.stringify(q)},every=${Math.max(5, d.intervalSec)}*1000,body=document.getElementById('body');
  var KEY='atticus.pairs.engine',MKEY='atticus.pairs.mode',input=document.getElementById('engine'),estat=document.getElementById('engine-status');
  var picks={};
  var saved=null,savedMode=null;try{saved=localStorage.getItem(KEY);savedMode=localStorage.getItem(MKEY)}catch(e){}
  if(saved)input.value=saved;
  if(savedMode==='send'||savedMode==='open'){var r=document.querySelector('input[name=mode][value='+savedMode+']');if(r)r.checked=true}
  function engine(){return (input.value||'').trim()}
  function mode(){var m=document.querySelector('input[name=mode]:checked');return m&&m.value==='open'?'open':'send'}
  function q(s){return '"'+String(s).replace(/"/g,'')+'"'}
  function applyPicks(){body.querySelectorAll('section[data-horizon]').forEach(function(sec){
    var h=sec.getAttribute('data-horizon'),id=picks[h],row=id?sec.querySelector('tr[data-id='+q(id)+']'):null;
    if(row&&row.hasAttribute('data-nolaunch'))row=null;
    if(!row){id=sec.getAttribute('data-pick')||'';row=id?sec.querySelector('tr[data-id='+q(id)+']'):null;delete picks[h]}
    sec.querySelectorAll('tr.picked').forEach(function(t){t.classList.remove('picked')});
    var lab=sec.querySelector('.picklabel'),go=sec.querySelector('button.go');
    if(row){row.classList.add('picked');if(lab)lab.textContent=row.getAttribute('data-label')||'';if(go)go.disabled=false}
  })}
  function tick(){fetch(BASE+'/fragment'+Q+'t='+Date.now(),{cache:'no-store'}).then(function(r){return r.ok?r.text():null}).then(function(h){
    if(!h)return;var keep={};body.querySelectorAll('[data-status]').forEach(function(s){if(s.textContent)keep[s.getAttribute('data-status')]=s.textContent});
    body.innerHTML=h;Object.keys(keep).forEach(function(k){var s=body.querySelector('[data-status='+q(k)+']');if(s)s.textContent=keep[k]});applyPicks();
  }).catch(function(){})}
  setInterval(tick,every);applyPicks();
  function post(url,payload){return fetch(url,{method:'POST',mode:'cors',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})}
  function withQuery(url,params){var u=url+(url.indexOf('?')<0?'?':'&')+Object.keys(params).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(params[k])}).join('&');window.open(u,'_blank','noopener');return u}
  function stamp(){return new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit',second:'2-digit'})}
  document.getElementById('engine-save').onclick=function(){try{localStorage.setItem(KEY,engine());localStorage.setItem(MKEY,mode())}catch(e){}estat.textContent='saved: '+mode()};
  document.getElementById('engine-test').onclick=function(){var u=engine();if(!u){estat.textContent='set a URL first';return}
    if(mode()==='open'){withQuery(u,{atticus:'ping',at:new Date().toISOString()});estat.textContent='opened your page with atticus=ping';return}
    estat.textContent='sending…';post(u,{type:'atticus.btc_pair.ping',at:new Date().toISOString()}).then(function(r){estat.textContent='engine answered '+r.status}).catch(function(e){estat.textContent='could not reach it: '+(e&&e.message||e)})};
  document.addEventListener('change',function(e){if(e.target&&e.target.name==='mode'){try{localStorage.setItem(MKEY,mode())}catch(x){}}});
  document.addEventListener('click',function(e){
    var b=e.target.closest?e.target.closest('button.go,button.use'):null;if(!b)return;
    var h=b.getAttribute('data-horizon');
    if(b.classList.contains('use')){picks[h]=b.getAttribute('data-id');applyPicks();return}
    var sec=body.querySelector('section[data-horizon='+q(h)+']'),row=sec?sec.querySelector('tr.picked'):null,id=row?row.getAttribute('data-id'):(sec?sec.getAttribute('data-pick'):'');
    var st=body.querySelector('[data-status='+q(h)+']'),u=engine();
    if(!id){if(st)st.textContent='nothing to send';return}
    if(!u){if(st)st.textContent='set the engine URL below';document.querySelector('details').open=true;input.focus();return}
    b.disabled=true;if(st)st.textContent='fetching pair…';
    fetch(BASE+'/api/pair'+Q+'id='+encodeURIComponent(id),{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('pair '+r.status);return r.json()})
      .then(function(p){
        if(mode()==='open'){
          var src=location.origin+BASE+'/api/pair?id='+encodeURIComponent(id);
          withQuery(u,{atticus:'btc_pair',id:id,horizon:p.pair.horizon,strike:String(p.pair.strike),settlesAt:p.pair.settlesAt,kalshi:(p.pair.kalshi&&p.pair.kalshi.id)||'',poly:(p.pair.poly&&p.pair.poly.id)||'',src:src});
          if(st)st.textContent='opened your page · '+stamp();return null}
        if(st)st.textContent='posting…';return post(u,p).then(function(r){if(st)st.textContent='engine answered '+r.status+' · '+stamp()})})
      .catch(function(err){if(st)st.textContent='failed: '+(err&&err.message||err)})
      .then(function(){b.disabled=false});
  });
})();
</script></body></html>`;
}
