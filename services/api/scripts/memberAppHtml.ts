/**
 * THE MEMBER APP PAGE: the hosted surface for the member venue (STX). A member opens it, connects
 * their own venue account once (the venue's consent page, in this tab), and sees their positions
 * on the games the service can protect, laid out as the venue's own portfolio lays them out, with
 * the Lock in line under each one exactly as the embed draws it. The lock is their own sale of
 * part of the position into the venue's bids: the cash lands in their venue balance, the rest
 * rides. Nothing hedged, no capital of ours, no fee.
 *
 * The page holds no token and no key. Its session is a cookie the service set (HttpOnly), which
 * the service turns into the member's holder alias; every call goes to this origin with that
 * cookie and the x-member-app header, and the service answers for this member alone.
 *
 * One file, no build step, no dependency: the HTML, the CSS in the venue's palette (the same
 * variables as the extension's `.ael-v-stx` skin, so the two surfaces read the same) and the
 * script that talks to /api/shadow/*.
 */

export interface MemberAppPageOptions {
  venueName: string;
  /** false when MEMBER_APP_* is not set on this service: the page says so and does nothing else */
  configured: boolean;
  /** the public record, linked in the foot */
  recordUrl: string;
  /** the venue's own web app, linked from the top bar so the member can get back to it */
  venueUrl?: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);

export function memberAppHtml(o: MemberAppPageOptions): string {
  const cfg = JSON.stringify({ venueName: o.venueName, configured: o.configured, recordUrl: o.recordUrl, venueUrl: o.venueUrl ?? null }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Lock in · ${esc(o.venueName)} positions</title>
<style>
${CSS}
</style>
</head>
<body class="ael-v-stx">
<header class="top">
  <div class="brand">${o.venueUrl ? `<a href="${esc(o.venueUrl)}" rel="noopener">${esc(o.venueName)}</a>` : `<span>${esc(o.venueName)}</span>`}<span class="sep">·</span><span class="app">Lock in</span></div>
  <nav class="tabs" aria-label="Sections"><span class="on">Portfolio</span></nav>
  <div class="acct" id="acct"></div>
</header>
<main id="main" class="main"><div class="ael-wait">Loading…</div></main>
<footer class="foot">
  <span>Protection by Atticus, a third party; not a product of ${esc(o.venueName)}. Every lock is written to a <a href="${esc(o.recordUrl)}" rel="noopener">public record</a> in neutral words.</span>
</footer>
<script>window.AEL_CFG = ${cfg};</script>
<script>
${JS}
</script>
</body>
</html>`;
}

const CSS = String.raw`
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  --ael-fg: #f4f4f4; --ael-fg-strong: #ffffff; --ael-soft: #d1d1d1; --ael-muted: #9a9a9a; --ael-dim: #818181; --ael-faint: #5c5c5c;
  --ael-bg: #141414; --ael-bg-deep: #0a0a0a; --ael-bg-raise: #1d1d1d; --ael-bg-hover: #262626;
  --ael-border: #2e2e2e; --ael-border-hover: #3a3a3a; --ael-divider: #262626;
  --ael-accent: #f9ae1c; --ael-accent-hover: #ffc91a; --ael-accent-ink: #1a1200; --ael-glow: #ffe233; --ael-accent-text: #ffc91a;
  --ael-accent-line: rgba(249, 174, 28, 0.6); --ael-accent-wash: rgba(249, 174, 28, 0.12); --ael-accent-wash-2: rgba(249, 174, 28, 0.16); --ael-accent-wash-3: rgba(249, 174, 28, 0.22);
  --ael-ring: rgba(255, 255, 255, 0.35); --ael-radius: 6px; --ael-radius-lg: 12px;
  background: #010101; color: var(--ael-fg);
  font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased; min-height: 100vh; display: flex; flex-direction: column;
}
a { color: inherit; }
.top { display: flex; align-items: center; gap: 28px; padding: 0 28px; height: 56px; border-bottom: 1px solid #1a1a1a; background: #010101; position: sticky; top: 0; z-index: 3; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 800; letter-spacing: 0.14em; color: var(--ael-accent); font-size: 15px; }
.brand a { color: inherit; text-decoration: none; }
.brand .sep { color: var(--ael-faint); font-weight: 400; letter-spacing: 0; }
.brand .app { color: var(--ael-fg); letter-spacing: 0; font-weight: 600; font-size: 14px; }
.tabs { display: flex; gap: 22px; font-size: 13px; color: var(--ael-muted); }
.tabs .on { color: var(--ael-fg-strong); font-weight: 600; position: relative; }
.tabs .on::after { content: ""; position: absolute; left: 0; right: 0; bottom: -19px; height: 2px; background: var(--ael-accent); }
.acct { margin-left: auto; display: flex; align-items: center; gap: 12px; font-size: 12.5px; color: var(--ael-muted); white-space: nowrap; }
.acct b { color: var(--ael-fg-strong); font-weight: 600; font-variant-numeric: tabular-nums; }
.acct a { color: var(--ael-muted); text-decoration: underline; text-underline-offset: 2px; }
.acct a:hover { color: var(--ael-fg-strong); }
.main { flex: 1; width: 100%; max-width: 860px; margin: 0 auto; padding: 26px 20px 40px; }
.foot { padding: 18px 28px 28px; font-size: 12px; color: var(--ael-dim); border-top: 1px solid #1a1a1a; text-align: center; }
.foot a { color: var(--ael-muted); }

h1 { font-size: 22px; font-weight: 700; margin: 0 0 4px; color: var(--ael-fg-strong); }
.sub { color: var(--ael-muted); font-size: 13px; margin: 0 0 18px; }
.note { font-size: 12.5px; color: var(--ael-soft); background: var(--ael-bg-raise); border: 1px solid var(--ael-border); border-radius: var(--ael-radius); padding: 9px 12px; margin: 0 0 16px; }
.note.err { border-color: rgba(255, 107, 107, 0.5); color: #ffb4b4; }
.note.ok { border-color: var(--ael-accent-line); }

/* the connect card: one thing to do */
.connect { max-width: 520px; margin: 48px auto 0; background: var(--ael-bg-raise); border: 1px solid var(--ael-border); border-radius: var(--ael-radius-lg); padding: 26px 28px 22px; }
.connect h2 { margin: 0 0 8px; font-size: 18px; color: var(--ael-fg-strong); }
.connect p { margin: 0 0 14px; color: var(--ael-soft); font-size: 13.5px; line-height: 1.5; }
.connect ul { margin: 0 0 16px; padding-left: 18px; color: var(--ael-muted); font-size: 12.5px; line-height: 1.6; }
.connect .ael-go { margin: 6px 0 10px; }

/* the portfolio: the venue's own rows, the Lock in line under each */
.rows { display: flex; flex-direction: column; }
.pos { padding: 14px 0 12px; border-bottom: 1px solid #1f1f1f; }
.pos-h { display: grid; grid-template-columns: 1fr auto auto auto; column-gap: 28px; align-items: start; }
.pos-h .name { font-size: 15px; font-weight: 700; color: var(--ael-fg-strong); }
.pos-h .ev { font-size: 12.5px; color: var(--ael-muted); margin-top: 3px; }
.pos-h .col { text-align: right; min-width: 72px; }
.pos-h .col small { display: block; font-size: 11px; color: var(--ael-dim); letter-spacing: 0.02em; }
.pos-h .col b { display: block; font-size: 14px; font-weight: 600; color: var(--ael-fg-strong); font-variant-numeric: tabular-nums; margin-top: 2px; }
.pos-h .col b.amber { color: var(--ael-accent); }
.pos .ael-row { margin-top: 10px; }
.empty { color: var(--ael-muted); font-size: 13.5px; padding: 30px 0; text-align: center; }
.status { font-size: 12px; color: var(--ael-dim); margin: 10px 0 0; text-align: right; }

/* the line, the panel and the slip: the extension's grammar, the venue's palette */
.ael-row { display: block; position: relative; max-width: 680px; padding: 0; color: var(--ael-fg); font-size: 14px; text-align: left; }
.ael-box { border: 1px solid var(--ael-accent-line); border-radius: var(--ael-radius); background: var(--ael-bg); overflow: hidden; transition: border-color 0.12s, background 0.12s; }
.ael-box:has(.ael-line-on) { border-color: var(--ael-accent); background: var(--ael-accent-wash); }
.ael-box:has(.ael-line-off), .ael-box:has(.ael-line-wait) { border-color: var(--ael-border); }
.ael-line { display: flex; align-items: center; gap: 12px; width: 100%; padding: 7px 10px 7px 7px; border: 0; background: transparent; color: var(--ael-fg); cursor: pointer; text-align: left; font: inherit; }
.ael-line:hover { background: var(--ael-accent-wash); }
.ael-line-off:hover, .ael-line-wait:hover { background: var(--ael-bg-raise); }
.ael-line-wait, .ael-line-off { cursor: default; }
.ael-tag { display: inline-flex; flex: none; align-items: center; gap: 6px; padding: 3px 10px 3px 7px; border-radius: 999px; border: 1px solid var(--ael-accent-line); background: var(--ael-accent-wash-2); color: var(--ael-fg-strong); font-size: 12.5px; font-weight: 600; line-height: 16px; white-space: nowrap; }
.ael-tag .ael-ic { width: 14px; height: 14px; color: var(--ael-glow); }
.ael-tag .ael-ic svg { width: 14px; height: 14px; }
.ael-tag svg path:last-child { stroke: var(--ael-bg); }
.ael-line-on .ael-tag { background: var(--ael-accent); border-color: var(--ael-accent); color: var(--ael-accent-ink); }
.ael-line-on .ael-tag .ael-ic { color: var(--ael-accent-ink); }
.ael-line-on .ael-tag svg path:last-child { stroke: var(--ael-accent); }
.ael-line-off .ael-tag, .ael-line-wait .ael-tag { padding: 3px 10px; background: var(--ael-bg-deep); border-color: var(--ael-border-hover); color: var(--ael-soft); }
.ael-ic { display: inline-flex; flex: none; width: 18px; height: 18px; align-items: center; justify-content: center; color: var(--ael-glow); }
.ael-ic svg { width: 16px; height: 16px; display: block; }
.ael-fact { flex: 1; min-width: 0; font-size: 14px; color: var(--ael-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ael-fact b { font-weight: 600; color: var(--ael-fg-strong); font-variant-numeric: tabular-nums; }
.ael-line-off .ael-fact, .ael-line-wait .ael-fact { color: var(--ael-muted); }
.ael-chev { flex: none; width: 16px; height: 16px; color: var(--ael-dim); transition: transform 0.18s ease; }
.ael-chev svg { width: 16px; height: 16px; display: block; }
.ael-line.ael-open .ael-chev { transform: rotate(180deg); color: var(--ael-muted); }
.ael-line.ael-flash { animation: ael-flash 0.7s ease-out; }
@keyframes ael-flash { 0%, 35% { background: var(--ael-accent); } 100% { background: transparent; } }
.ael-panel { display: none; padding: 2px 14px 12px; border-top: 1px solid var(--ael-divider); color: var(--ael-fg); font-size: 14px; }
.ael-panel.ael-on { display: block; animation: ael-open 0.18s ease-out; }
@keyframes ael-open { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.ael-ph { margin: 10px 0 6px; }
.ael-ph b { display: block; font-size: 14px; font-weight: 600; color: var(--ael-fg-strong); }
.ael-ph span { display: block; font-size: 12px; color: var(--ael-muted); margin-top: 3px; }
.ael-wait { font-size: 13px; color: var(--ael-muted); padding: 12px 0; line-height: 1.4; }
.ael-ledger { margin: 0; }
.ael-lr { display: flex; align-items: baseline; gap: 18px; padding: 9px 0; border-bottom: 1px solid var(--ael-divider); }
.ael-lr.ael-last { border-bottom: 0; }
.ael-lr .ael-l { flex: 1; min-width: 0; font-size: 14px; color: var(--ael-fg); }
.ael-lr .ael-l .ael-dim { color: var(--ael-muted); font-size: 12px; }
.ael-lr b { font-size: 15px; font-weight: 600; color: var(--ael-fg-strong); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ael-lr b .ael-dim { font-weight: 400; font-size: 12px; color: var(--ael-muted); }
.ael-lr s { width: 92px; font-size: 12px; color: var(--ael-muted); text-align: right; text-decoration: none; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ael-hero b { color: var(--ael-accent-text); }
.ael-go { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; height: 40px; padding: 0 16px; margin: 8px 0 10px; border: 0; border-radius: var(--ael-radius); background: var(--ael-accent); color: var(--ael-accent-ink); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.ael-go:hover { background: var(--ael-accent-hover); }
.ael-go:disabled { cursor: wait; }
.ael-go .ael-ic { width: 16px; height: 16px; color: var(--ael-accent-ink); }
.ael-go .ael-ic svg { width: 16px; height: 16px; }
.ael-go svg path:last-child { stroke: var(--ael-accent); }
.ael-go.ael-busy::before { content: ""; display: inline-block; width: 13px; height: 13px; border-radius: 50%; border: 2px solid var(--ael-ring); border-top-color: var(--ael-accent-ink); animation: ael-spin 0.8s linear infinite; }
@keyframes ael-spin { to { transform: rotate(360deg); } }
.ael-go.ael-quiet { display: inline-flex; width: auto; height: 36px; margin: 0; padding: 0 14px; background: var(--ael-bg-raise); color: var(--ael-fg-strong); font-size: 13px; }
.ael-go.ael-quiet:hover { background: var(--ael-bg-hover); }
.ael-go.ael-pillgo { display: inline-flex; width: auto; min-height: 36px; height: auto; margin: 0; padding: 7px 16px 7px 12px; border-radius: 999px; font-size: 14px; white-space: normal; text-align: left; }
.ael-offer-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 12px 0 2px; }
.ael-offer-acts .ael-links { margin-left: auto; font-size: 13px; color: var(--ael-muted); white-space: nowrap; }
.ael-tg { display: inline-flex; align-items: center; gap: 3px; color: var(--ael-muted); text-decoration: none; font-size: 13px; font-weight: 500; padding: 6px 2px; white-space: nowrap; cursor: pointer; background: none; border: 0; font-family: inherit; }
.ael-tg:hover, .ael-tg[aria-expanded="true"] { color: var(--ael-fg-strong); }
.ael-tgc { display: inline-flex; width: 14px; height: 14px; transition: transform 0.18s ease; }
.ael-tgc svg { width: 14px; height: 14px; display: block; }
.ael-tg[aria-expanded="true"] .ael-tgc { transform: rotate(180deg); }
.ael-details { margin: 10px 0 2px; padding-top: 8px; border-top: 1px solid var(--ael-divider); }
.ael-drows { display: grid; grid-template-columns: max-content 1fr; column-gap: 14px; row-gap: 7px; align-items: baseline; font-size: 12.5px; line-height: 1.45; margin: 0 0 8px; }
.ael-dl { color: var(--ael-muted); white-space: nowrap; }
.ael-dl .ael-tg { font-size: 12.5px; padding: 0; }
.ael-dv { color: var(--ael-soft); min-width: 0; overflow-wrap: anywhere; }
.ael-dv b { font-weight: 600; color: var(--ael-fg-strong); }
.ael-dv .ael-dim { color: var(--ael-muted); }
.ael-dv code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.ael-dwide { grid-column: 1 / -1; }
.ael-rgrid { display: flex; flex-direction: column; gap: 5px; font-size: 12px; line-height: 1.4; margin: 0 0 6px; }
.ael-rg { display: grid; grid-template-columns: 8.5em 1fr; column-gap: 10px; align-items: baseline; }
.ael-rg > span { color: var(--ael-muted); }
.ael-rg > b { font-weight: 500; color: var(--ael-soft); overflow-wrap: anywhere; }
.ael-dl.ael-dshape, .ael-dv.ael-dshape { align-self: center; margin-bottom: 3px; }
.ael-shape { display: inline-flex; border: 1px solid var(--ael-border); border-radius: 8px; padding: 2px; background: var(--ael-bg-deep); gap: 2px; max-width: 100%; }
.ael-shape-b { appearance: none; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--ael-muted); font: inherit; font-size: 12.5px; font-weight: 500; line-height: 1.2; padding: 5px 10px; cursor: pointer; white-space: nowrap; }
.ael-shape-b:hover { color: var(--ael-fg-strong); }
.ael-shape-b[aria-pressed="true"] { border-color: var(--ael-accent); background: var(--ael-accent-wash-2); color: var(--ael-fg-strong); font-weight: 600; }
.ael-fine { font-size: 12px; color: var(--ael-muted); text-align: left; margin: 0 0 4px; line-height: 1.4; }
.ael-fine.ael-err { color: #ffb4b4; }
.ael-how { font-size: 12.5px; color: var(--ael-soft); margin: 6px 0 6px; max-width: 70ch; line-height: 1.45; }
.ael-how p { margin: 0 0 6px; }
.ael-leave { margin: 12px 0 2px; padding: 10px 12px 8px; border: 1px solid var(--ael-border); border-radius: var(--ael-radius); background: var(--ael-bg-deep); }
.ael-leave-h { display: flex; align-items: baseline; gap: 10px; margin: 0 0 2px; }
.ael-leave-h b { font-size: 14px; font-weight: 600; color: var(--ael-fg-strong); }
.ael-leave-h span { font-size: 12px; color: var(--ael-muted); }
.ael-leave-acts { display: flex; align-items: center; gap: 8px; margin: 8px 0 8px; }
.ael-leave-acts .ael-go { margin: 0; flex: 1; }
.ael-leave-acts .ael-go.ael-quiet { flex: none; }
.ael-acts { display: flex; align-items: center; gap: 10px; margin: 10px 0 0; }
.ael-acts .ael-go.ael-quiet { flex: none; }
.ael-meta { font-size: 12px; color: var(--ael-muted); margin: 10px 0 4px; line-height: 1.4; }
@media (max-width: 640px) {
  .top { gap: 16px; padding: 0 14px; }
  .tabs { display: none; }
  .main { padding: 18px 12px 32px; }
  .pos-h { grid-template-columns: 1fr auto; row-gap: 8px; }
  .pos-h .col:nth-child(3) { display: none; }
}
`;

const JS = String.raw`
(() => {
  const CFG = window.AEL_CFG || {};
  const VN = CFG.venueName || "STX";
  const POLL_POS_MS = 15000, REQUOTE_MS = 60000;
  const TIER_ORDER = ["wide", "balanced", "tight"];
  const TIER_WORDS = { wide: "Max upside", balanced: "Balanced", tight: "Max floor" };
  const SHIELD = '<span class="ael-ic"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5 4.5 5.6v6.2c0 4.6 3.1 8.6 7.5 9.7 4.4-1.1 7.5-5.1 7.5-9.7V5.6L12 2.5z"/><path d="m8.8 12.2 2.1 2.1 4.3-4.6" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  const CHEV = '<span class="ael-chev"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></span>';
  const TGC = '<span class="ael-tgc"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></span>';
  const DISCLOSE = '<div class="ael-fine">Protection by Atticus, a third party; not a product of ' + VN + '.</div>';
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const usd = (c) => (c < 0 ? "-" : "") + "$" + (Math.abs(c) / 100).toFixed(2);
  const signed = (c) => (c >= 0 ? "+" : "-") + "$" + (Math.abs(c) / 100).toFixed(2);
  const cents = (c) => c + "\u00a2";
  const fmtAt = (iso) => { const d = new Date(iso); if (isNaN(d)) return ""; return d.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).replace(",", "") + " ET"; };
  const nickOf = (side) => { const w = String(side || "").trim().split(/\s+/); return w.length ? w[w.length - 1] : "Your side"; };
  const api = async (path, method, body) => {
    try {
      const r = await fetch(path, { method: method || "GET", credentials: "same-origin", cache: "no-store", headers: Object.assign({ accept: "application/json", "x-member-app": "1" }, body !== undefined ? { "content-type": "application/json" } : {}), body: body !== undefined ? JSON.stringify(body) : undefined });
      let json = null; try { json = await r.json(); } catch (e) { json = null; }
      return { ok: true, status: r.status, json };
    } catch (e) { return { ok: false, status: 0, json: null, error: String(e) }; }
  };
  const words = (p, fallback) => (p && (p.message || p.error)) || fallback;
  const refusalWords = (p) => {
    const code = p && (p.code || p.error);
    switch (code) {
      case "member_not_connected": return ["Not connected", "Connect your " + VN + " account first."];
      case "member_scope": return ["Reconnect " + VN, words(p, "Your connection does not allow orders.")];
      case "member_terms": return [VN + " terms", words(p, VN + " needs you to accept its terms first.")];
      case "member_ip": return ["Unavailable", words(p, VN + " refused the order from this service.")];
      case "not_held": return ["Unavailable", "This position is not in your " + VN + " account any more."];
      case "size": case "too_small": return ["Unavailable", words(p, "The position is too small to protect.")];
      case "no_bids": case "no_offers": return ["No bids", "No one is bidding for this side on " + VN + " right now."];
      case "market_too_close_to_start": return ["Unavailable", "This game starts too soon to protect."];
      case "market_not_active": return ["Unavailable", "This market is not open."];
      case "not_filled": return ["Not sold", VN + " filled none of it; nothing changed. Try again."];
      case "already_on_record": return ["Protected", "This market is already locked."];
      case "lock_in_flight": return ["One moment", "This position is being locked right now."];
      case "venue_unreachable": return ["Unavailable", VN + " could not be reached."];
      case "venue_refused": return ["Unavailable", words(p, VN + " refused the order.")];
      default: return ["Unavailable", words(p, "Protection isn't available on this position right now.")];
    }
  };

  const S = { member: null, positions: [], posAt: 0, posErr: null, st: new Map(), timers: [], busy: false, flash: null };
  const main = document.getElementById("main");
  const acct = document.getElementById("acct");
  const stateOf = (ticker) => { let st = S.st.get(ticker); if (!st) { st = { open: false, tier: null, quote: null, quoteAt: 0, details: false, rules: false, how: false, lock: null, rcpt: null, leave: false, leaveQ: null, busy: null, err: null, justNow: false, ms: 0 }; S.st.set(ticker, st); } return st; };

  // ---- the connect screen ----
  const connectHtml = (why) => {
    const m = S.member || {};
    const reason = m.reason === "grant_revoked" ? "Your " + VN + " connection was revoked. Connect again when you are ready." : m.reason === "account_pending" ? "Your " + VN + " account is still pending on their side; connect again once it is open." : m.reason === "refresh_failed" ? "Your " + VN + " connection lapsed. Connect again to continue." : "";
    return '<div class="connect"><h2>Protect your ' + esc(VN) + ' positions</h2>' +
      '<p>Connect your ' + esc(VN) + ' account once. You sign in on ' + esc(VN) + "'s own page and approve reading your portfolio and placing orders in your account. This page never sees your login or your keys.</p>" +
      "<ul><li>A lock sells part of a position into " + esc(VN) + "'s bids: the cash lands in your " + esc(VN) + " balance now, the rest rides to the game.</li><li>No one else is on the other side; nothing is hedged for you; no fee.</li><li>Leave early buys the same contracts back from " + esc(VN) + "'s offers.</li></ul>" +
      (reason ? '<div class="ael-fine">' + esc(reason) + "</div>" : "") +
      (why ? '<div class="ael-fine ael-err">' + esc(why) + "</div>" : "") +
      '<button type="button" class="ael-go" id="connect">' + SHIELD + "Connect " + esc(VN) + " account</button></div>";
  };
  const connect = async () => {
    const b = document.getElementById("connect");
    if (b) { b.disabled = true; b.classList.add("ael-busy"); b.textContent = "Opening " + VN + "…"; }
    const r = await api("/api/shadow/member/connect");
    if (r.ok && r.json && r.json.ok && r.json.url) { location.href = r.json.url; return; }
    main.innerHTML = connectHtml(r.status === 404 ? "This service is not set up for " + VN + " accounts." : words(r.json, "The service could not start the connection."));
    bind();
  };
  const disconnect = async () => {
    const r = await api("/api/shadow/member/disconnect", "POST", {});
    if (r.ok && r.json && r.json.member) S.member = r.json.member;
    S.positions = []; S.st.clear();
    render();
  };

  // ---- quotes and the slip ----
  const quoteFor = async (p, force) => {
    const st = stateOf(p.ticker);
    if (!force && st.quote && Date.now() - st.quoteAt < REQUOTE_MS) return;
    // the words of a close just done stay on the line a moment before the next offer takes it
    if (st.closedNow && Date.now() - st.closedNow.at < 8000) return;
    if (st.quoting) return;
    st.quoting = true;
    const r = await api("/api/shadow/quote?ticker=" + encodeURIComponent(p.ticker) + "&contracts=" + p.contracts + (p.entryCents != null ? "&entry=" + p.entryCents : "") + "&venue=stx");
    st.quoting = false;
    st.quoteAt = Date.now();
    st.quote = r.ok ? (r.json || { ok: false, code: "unavailable" }) : { ok: false, code: "venue_unreachable" };
    if (st.quote.ok && !st.tier) st.tier = st.quote.quote.tier;
    paintRow(p);
  };
  const tierOf = (st) => { const q = st.quote && st.quote.quote; if (!q) return null; return (q.tiers && q.tiers[st.tier]) || q; };
  const outcomes = (t) => ({ floor: t.floorTotalCents, cap: t.capTotalCents, cash: t.cashNowCents != null ? t.cashNowCents : t.creditCents || 0 });
  const slipRows = (nick, o, n, sale) => {
    return '<div class="ael-ledger">' +
      '<div class="ael-lr"><span class="ael-l">' + esc(nick) + ' win</span><b>' + usd(o.cap) + '</b><s>of ' + usd(n * 100) + '</s></div>' +
      '<div class="ael-lr ael-hero"><span class="ael-l">' + esc(nick) + ' lose</span><b>' + usd(o.floor) + '</b><s>instead of $0</s></div>' +
      '<div class="ael-lr ael-last"><span class="ael-l">In your ' + esc(VN) + ' balance' + (sale ? '' : ' now') + '</span><b>' + signed(o.cash) + '</b><s></s></div>' +
      "</div>";
  };
  const shapeHtml = (st) => {
    const q = st.quote.quote;
    const tiers = TIER_ORDER.filter((k) => q.tiers && q.tiers[k]);
    if (tiers.length < 2) return "";
    return '<div class="ael-dl ael-dshape">Shape</div><div class="ael-dv ael-dshape"><div class="ael-shape" role="group" aria-label="Shape">' + tiers.map((k) => '<button type="button" class="ael-shape-b" data-tier="' + k + '" aria-pressed="' + (st.tier === k) + '">' + TIER_WORDS[k] + "</button>").join("") + "</div></div>";
  };
  const rulesGrid = (p, t) => {
    const tails = (t && t.tails) || (p && p.tails) || [];
    if (!tails.length) return "";
    return '<div class="ael-rgrid">' + tails.map((t) => '<div class="ael-rg"><span>' + esc(t.branch === "tie" ? "tie" : t.branch === "postponed" ? "postponement" : t.branch === "abandoned" ? "called off" : t.branch === "corrected" ? "corrected result" : t.branch) + "</span><b>" + esc(t.text) + "</b></div>").join("") + "</div>";
  };
  const termsWords = (p) => {
    const r = p && p.rules; const first = r && (r.tie || r.postponed);
    return first && first.asOf ? VN + " rules read " + esc(first.asOf) + " · the sentences under Rules; checked again at settlement" : VN + "'s own rules for the riding contracts; checked again at settlement";
  };
  const saleWords = (ms, member) => {
    if (!ms) return "";
    const order = ms.orderId ? " · " + VN + " order <code>" + esc(String(ms.orderId).slice(0, 8)) + "…</code>" : "";
    return "<b>Sold " + ms.soldContracts + " of " + (ms.soldContracts + ms.keptContracts) + " at " + cents(ms.avgPriceCents) + "</b>" + order + " · " + ms.keptContracts + " still riding" + (ms.feeCents ? ' <span class="ael-dim">· ' + VN + " fee " + usd(ms.feeCents) + "</span>" : "");
  };
  const comparedWords = (c) => {
    if (!c) return "";
    if (!c.ok) return '<span class="ael-dim">The other venues could not be priced at the time' + (c.reason ? " (" + esc(c.reason) + ")" : "") + ".</span>";
    const who = c.chosenName || "Another venue";
    const of = c.priced > 1 ? " (best of " + c.priced + " venues)" : "";
    return "<b>" + esc(who) + esc(of) + "</b> would have paid " + usd(c.creditCents) + " now, then " + usd(c.floorTotalCents) + " or " + usd(c.capTotalCents) + ' <span class="ael-dim">· priced, nothing sent</span>';
  };
  const detailsHtml = (p, st, locked) => {
    const q = st.quote;
    const src = locked ? (st.rcpt || st.lock || {}) : q;
    const o = locked ? null : outcomes(tierOf(st));
    const t = locked ? null : tierOf(st);
    let rows = "";
    if (!locked) {
      rows += shapeHtml(st);
      rows += '<div class="ael-dl">Sale</div><div class="ael-dv">Sell <b>' + t.soldContracts + " of " + p.contracts + "</b> at about " + cents(t.avgPriceCents) + " into " + esc(VN) + "'s bids · " + t.keptContracts + " keep riding" + (t.depthLimited ? ' <span class="ael-dim">· the bids run out before the full shape</span>' : "") + "</div>";
      rows += '<div class="ael-dl"><button type="button" class="ael-tg" data-tg="how" aria-expanded="' + st.how + '">How' + TGC + "</button></div><div class=\"ael-dv\">" + (st.how ? '<div class="ael-how"><p>You sell ' + t.soldContracts + " of your " + p.contracts + " contracts into " + esc(VN) + "'s bids now, at the best prices there; " + usd(o.cash) + " lands in your " + esc(VN) + " balance. The other " + t.keptContracts + " ride to the game as they always did.</p><p>Lose, and you keep the " + usd(o.cash) + ". Win, and the riding contracts pay $1 each on top: " + usd(o.cap) + " all in. No one else is on the other side, nothing is hedged for you, and there is no fee.</p></div>" : '<span class="ael-dim">a partial sale of your own position</span>') + "</div>";
    } else {
      const ms = src.memberSale;
      if (ms) rows += '<div class="ael-dl">Sold</div><div class="ael-dv">' + saleWords(ms) + "</div>";
      if (ms) rows += '<div class="ael-dl">In your ' + esc(VN) + ' balance</div><div class="ael-dv"><b>' + usd(ms.cashNowCents) + '</b> <span class="ael-dim">· ' + esc(ms.status || "filled") + "</span></div>";
      if (ms) rows += '<div class="ael-dl">Still riding</div><div class="ael-dv"><b>' + ms.keptContracts + " contracts</b> · pay " + usd(ms.keptContracts * 100) + " on a win, $0 on a loss, as they always did</div>";
      if (src.memberBuyBack) rows += '<div class="ael-dl">Bought back</div><div class="ael-dv"><b>' + src.memberBuyBack.boughtContracts + " at " + cents(src.memberBuyBack.avgPriceCents) + "</b> · cost " + usd(src.memberBuyBack.costCents) + (src.memberBuyBack.orderId ? ' <span class="ael-dim">· ' + VN + " order <code>" + esc(String(src.memberBuyBack.orderId).slice(0, 8)) + "…</code></span>" : "") + "</div>";
      if (src.venueSettlement) rows += '<div class="ael-dl">' + esc(VN) + ' settled</div><div class="ael-dv"><b>' + esc(src.venueSettlement.result || "") + "</b>" + (src.venueSettlement.payoutCents != null ? " · " + usd(src.venueSettlement.payoutCents) + " on the riding contracts" : "") + "</div>";
    }
    // the offer's Compared follows the shape picked; a record's is the one priced at the sale
    const cmpRaw = locked ? src.compared : q.compared;
    const cmp = !locked && cmpRaw && cmpRaw.ok && cmpRaw.tiers && cmpRaw.tiers[st.tier] ? Object.assign({}, cmpRaw, cmpRaw.tiers[st.tier]) : cmpRaw;
    if (cmp) rows += '<div class="ael-dl">Compared</div><div class="ael-dv">' + comparedWords(cmp) + "</div>";
    rows += '<div class="ael-dl"><button type="button" class="ael-tg" data-tg="rules" aria-expanded="' + st.rules + '">Rules' + TGC + "</button></div><div class=\"ael-dv\">" + (st.rules ? "" : '<span class="ael-dim">tie · postponement · called off · corrected result</span>') + "</div>";
    if (st.rules) rows += '<div class="ael-dwide">' + rulesGrid(src, t) + "</div>";
    rows += '<div class="ael-dl">Terms</div><div class="ael-dv">' + termsWords(src) + "</div>";
    return '<div class="ael-details"><div class="ael-drows">' + rows + "</div></div>";
  };

  // ---- leaving early: the buy-back ----
  const leaveHtml = (p, st) => {
    const q = st.leaveQ;
    if (!q) return '<div class="ael-leave"><div class="ael-wait">Pricing the buy-back from ' + esc(VN) + "'s offers…</div></div>";
    if (!(q.ok && q.unwind && q.unwind.buyBack)) { const w = refusalWords(q); return '<div class="ael-leave"><div class="ael-ph"><b>' + esc(w[0] === "Unavailable" ? "Can't leave right now" : w[0]) + "</b><span>" + esc(w[1]) + '</span></div><div class="ael-leave-acts"><button type="button" class="ael-go ael-quiet" data-act="stay">Keep the protection</button></div></div>'; }
    const u = q.unwind, bb = u.buyBack;
    const net = u.closeNetCents;
    return '<div class="ael-leave"><div class="ael-leave-h"><b>Buy back ' + bb.contracts + " at " + cents(bb.avgPriceCents) + "</b><span>costs " + usd(bb.costCents) + (bb.contracts < bb.wantContracts ? " · only " + bb.contracts + " of " + bb.wantContracts + " offered" : "") + "</span></div>" +
      '<div class="ael-ledger"><div class="ael-lr"><span class="ael-l">Sold for</span><b>' + usd(u.cashNowCents) + '</b><s></s></div><div class="ael-lr ael-hero"><span class="ael-l">Net, after the buy-back</span><b>' + signed(net) + '</b><s>in your balance</s></div><div class="ael-lr ael-last"><span class="ael-l">Staying</span><b>' + usd(u.stayFloorCents) + " or " + usd(u.stayCapCents) + '</b><s></s></div></div>' +
      '<div class="ael-leave-acts"><button type="button" class="ael-go" data-act="leave">' + (st.busy === "leave" ? esc(st.busyWords || "Buying back…") : "Buy back " + bb.contracts + " at " + cents(bb.avgPriceCents)) + '</button><button type="button" class="ael-go ael-quiet" data-act="stay">Stay protected</button></div>' +
      '<div class="ael-fine">Your position is whole again and unprotected; the round trip\'s cost is the difference above.' + (q.lastIso ? " You can leave until " + esc(fmtAt(q.lastIso)) + "." : "") + "</div></div>";
  };

  // ---- one position's line and panel ----
  const lineHtml = (kind, tag, fact, open) => '<button type="button" class="ael-line ael-line-' + kind + (open ? " ael-open" : "") + '"><span class="ael-tag">' + (kind === "on" || kind === "offer" ? SHIELD : "") + "<b>" + tag + "</b></span><span class=\"ael-fact\">" + fact + "</span>" + (kind === "off" || kind === "wait" ? "" : CHEV) + "</button>";
  const rowHtml = (p) => {
    const st = stateOf(p.ticker);
    const nick = nickOf(p.side);
    const lock = p.lock && p.lock.status !== "closed" ? p.lock : null;
    let line, panel = "";
    if (lock && lock.status === "settled") {
      const won = lock.result === "win" || lock.result === "yes";
      line = lineHtml("on", "Settled", nick + (won ? " won: " : " lost: ") + "<b>" + usd(won ? lock.capTotalCents || lock.protectedCents : lock.floorTotalCents || lock.protectedCents) + "</b> all in", st.open);
      panel = st.open ? '<div class="ael-panel ael-on">' + detailsHtml(p, st, true) + DISCLOSE + "</div>" : "";
    } else if (lock) {
      const ms = lock.memberSale || {};
      line = lineHtml("on", "Protected", "<b>" + usd(lock.floorTotalCents) + "</b> or <b>" + usd(lock.capTotalCents) + "</b> · on " + esc(VN) + ".", st.open);
      if (st.open) {
        const meta = ["Locked " + esc(fmtAt(lock.at))];
        if (st.justNow && st.ms) meta.push("sold " + (st.ms < 100 ? "at once" : "in " + (st.ms / 1000).toFixed(1) + "s"));
        if (ms.requestedContracts != null && ms.soldContracts < ms.requestedContracts) meta.push(ms.soldContracts + " of the " + ms.requestedContracts + " asked sold; the rest rides");
        panel = '<div class="ael-panel ael-on">' + slipRows(nick, { floor: lock.floorTotalCents, cap: lock.capTotalCents, cash: ms.cashNowCents || 0 }, ms.soldContracts + ms.keptContracts, true) +
          (st.leave ? leaveHtml(p, st) : "") +
          (!st.leave ? '<div class="ael-acts ael-offer-acts"><button type="button" class="ael-go ael-quiet" data-act="leave-open">Leave early</button><span class="ael-links"><button type="button" class="ael-tg" data-tg="details" aria-expanded="' + st.details + '">Details' + TGC + "</button></span></div>" : "") +
          '<div class="ael-meta">' + meta.join(" · ") + "</div>" +
          (st.details ? detailsHtml(p, st, true) : "") + DISCLOSE + "</div>";
      }
    } else if (st.closedNow && !(st.quote && st.quote.ok)) {
      const c = st.closedNow;
      line = lineHtml("off", "Unprotected", "Protection removed · bought back " + c.contracts + " at " + cents(c.avgPriceCents) + " · net <b>" + signed(c.netCents) + "</b>", st.open);
      panel = st.open ? '<div class="ael-panel ael-on"><div class="ael-ph"><b>Your position is whole again</b><span>' + c.contracts + " bought back on " + esc(VN) + " for " + usd(c.costCents) + "; the sale had paid " + usd(c.cashCents) + ". Unprotected now; a new offer follows once the book is read again.</span></div>" + DISCLOSE + "</div>" : "";
    } else if (!st.quote) {
      line = lineHtml("wait", "Lock in", "Pricing from " + esc(VN) + "'s book…", false);
    } else if (!st.quote.ok) {
      const w = refusalWords(st.quote);
      line = lineHtml("off", w[0], esc(w[1]), false);
    } else {
      const t = tierOf(st), o = outcomes(t);
      line = lineHtml("offer", "Lock in", "Lose, and still get <b>" + usd(o.floor) + "</b>.", st.open);
      if (st.open) {
        const busy = st.busy === "lock";
        panel = '<div class="ael-panel ael-on">' + slipRows(nick, o, p.contracts, false) +
          '<div class="ael-offer-acts"><button type="button" class="ael-go ael-pillgo' + (busy ? " ael-busy" : "") + '" data-act="lock"' + (busy ? " disabled" : "") + ">" + (busy ? esc(st.busyWords || "Selling into the bid…") : SHIELD + "Lock in") + '</button><span class="ael-links"><button type="button" class="ael-tg" data-tg="details" aria-expanded="' + st.details + '">Details' + TGC + "</button></span></div>" +
          (st.err ? '<div class="ael-fine ael-err">' + esc(st.err) + "</div>" : "") +
          (st.details ? detailsHtml(p, st, false) : "") + DISCLOSE + "</div>";
      }
    }
    return '<div class="ael-box">' + line + panel + "</div>";
  };
  const paintRow = (p) => {
    const el = document.querySelector('[data-ticker="' + CSS.escape(p.ticker) + '"] .ael-row');
    if (!el) return;
    const html = rowHtml(p);
    if (el.innerHTML !== html) { el.innerHTML = html; bindRow(el, p); }
    if (S.flash === p.ticker) { S.flash = null; const l = el.querySelector(".ael-line"); if (l) l.classList.add("ael-flash"); }
  };
  const bindRow = (el, p) => {
    const st = stateOf(p.ticker);
    const line = el.querySelector(".ael-line");
    if (line && !line.classList.contains("ael-line-wait") && !line.classList.contains("ael-line-off")) line.onclick = () => { st.open = !st.open; if (st.open && p.lock && p.lock.status !== "closed" && !st.rcpt) loadReceipt(p); paintRow(p); };
    el.querySelectorAll("[data-tg]").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); const k = b.getAttribute("data-tg"); st[k] = !st[k]; paintRow(p); }; });
    el.querySelectorAll(".ael-shape-b").forEach((b) => { b.onclick = () => { st.tier = b.getAttribute("data-tier"); paintRow(p); }; });
    el.querySelectorAll("[data-act]").forEach((b) => {
      b.onclick = () => {
        const a = b.getAttribute("data-act");
        if (a === "lock") void lockIn(p);
        else if (a === "leave-open") { st.leave = true; st.leaveQ = null; paintRow(p); void leaveQuote(p); }
        else if (a === "stay") { st.leave = false; paintRow(p); }
        else if (a === "leave") void leaveNow(p);
      };
    });
  };
  const loadReceipt = async (p) => {
    const st = stateOf(p.ticker);
    const r = await api("/api/shadow/receipt?ticker=" + encodeURIComponent(p.ticker));
    if (r.ok && r.json && r.json.ok) { st.rcpt = r.json; paintRow(p); }
  };
  const lockIn = async (p) => {
    const st = stateOf(p.ticker);
    if (st.busy) return;
    st.busy = "lock"; st.err = null;
    const stages = ["Pricing from " + VN + "'s book…", "Selling into the bid…", "Writing the record…"];
    let i = 0; st.busyWords = stages[0]; paintRow(p);
    const tick = setInterval(() => { i = Math.min(i + 1, stages.length - 1); st.busyWords = stages[i]; paintRow(p); }, 900);
    const t0 = Date.now();
    const r = await api("/api/shadow/lock", "POST", { ticker: p.ticker, contracts: p.contracts, entryCents: p.entryCents, tier: st.tier || undefined, venue: "stx" });
    clearInterval(tick);
    st.busy = null;
    if (r.ok && r.json && r.json.ok) {
      st.justNow = true; st.ms = Date.now() - t0; st.rcpt = null; st.details = false;
      p.lock = { at: r.json.at, status: "open", contracts: r.json.contracts, floorCents: r.json.floorCents, capCents: r.json.capCents, creditCents: 0, route: "member_sale", floorTotalCents: r.json.floorTotalCents, capTotalCents: r.json.capTotalCents, memberSale: r.json.memberSale, compared: r.json.compared, tails: r.json.tails, rules: r.json.rules };
      st.lock = r.json; st.open = true; S.flash = p.ticker;
      paintRow(p);
      setTimeout(() => void loadPositions(true), 1500);
      return;
    }
    const w = refusalWords(r.json || { code: r.ok ? "unavailable" : "venue_unreachable" });
    st.err = w[1];
    if (r.json && r.json.code === "not_filled") st.quoteAt = 0;
    paintRow(p);
  };
  const leaveQuote = async (p) => {
    const st = stateOf(p.ticker);
    const r = await api("/api/shadow/unwind/quote?ticker=" + encodeURIComponent(p.ticker));
    st.leaveQ = r.ok ? (r.json || { ok: false }) : { ok: false, code: "venue_unreachable" };
    paintRow(p);
  };
  const leaveNow = async (p) => {
    const st = stateOf(p.ticker);
    if (st.busy) return;
    st.busy = "leave";
    const stages = ["Pricing the buy-back…", "Buying back on " + VN + "…", "Closing the record…"];
    let i = 0; st.busyWords = stages[0]; paintRow(p);
    const tick = setInterval(() => { i = Math.min(i + 1, stages.length - 1); st.busyWords = stages[i]; paintRow(p); }, 900);
    const r = await api("/api/shadow/unwind", "POST", { ticker: p.ticker });
    clearInterval(tick);
    st.busy = null;
    if (r.ok && r.json && r.json.ok) {
      const u = r.json.unwind || {}, bb = u.buyBack || {}, back = r.json.memberBuyBack || {};
      st.closedNow = { at: Date.now(), contracts: bb.contracts != null ? bb.contracts : back.boughtContracts || 0, avgPriceCents: bb.avgPriceCents != null ? bb.avgPriceCents : back.avgPriceCents || 0, costCents: bb.costCents != null ? bb.costCents : back.costCents || 0, cashCents: u.cashNowCents || 0, netCents: u.closeNetCents || 0 };
      st.leave = false; st.open = true; st.quote = null; st.quoteAt = 0; st.rcpt = null; st.lock = null;
      p.lock = null;
      paintRow(p);
      setTimeout(() => void loadPositions(true), 1500);
      return;
    }
    st.leaveQ = r.json || { ok: false, code: r.ok ? "unavailable" : "venue_unreachable" };
    paintRow(p);
  };

  // ---- the page ----
  const posHtml = (p) => {
    const sold = p.lock && p.lock.status === "open" && p.lock.memberSale && p.lock.memberSale.soldContracts > 0 ? p.lock.memberSale.soldContracts : 0;
    return '<div class="pos" data-ticker="' + esc(p.ticker) + '"><div class="pos-h"><div><div class="name">' + esc(p.side || "Position") + " to win</div><div class=\"ev\">" + esc(p.event || "") + (p.startsIso ? " · " + esc(fmtAt(p.startsIso)) : "") + "</div></div>" +
      '<div class="col"><small>Contracts</small><b>' + p.contracts + (sold ? ' <span style="color:var(--ael-muted);font-weight:400">· ' + sold + " sold</span>" : "") + "</b></div>" +
      '<div class="col"><small>Avg price</small><b>' + (p.entryCents != null ? "$" + (p.entryCents / 100).toFixed(2) : "—") + "</b></div>" +
      '<div class="col"><small>Pays</small><b class="amber">' + usd(p.payoutCents) + "</b></div></div>" +
      '<div class="ael-row">' + rowHtml(p) + "</div></div>";
  };
  const acctHtml = () => {
    const m = S.member;
    if (!(m && m.connected)) return "";
    return "<span>" + esc(VN) + " connected" + (m.since ? " " + esc(fmtAt(m.since)) : "") + '</span><a href="#" id="disconnect">Disconnect</a>';
  };
  const render = () => {
    acct.innerHTML = acctHtml();
    const d = document.getElementById("disconnect"); if (d) d.onclick = (e) => { e.preventDefault(); void disconnect(); };
    if (!CFG.configured) { main.innerHTML = '<div class="connect"><h2>Not set up</h2><p>This service is not set up for ' + esc(VN) + " accounts.</p></div>"; return; }
    const m = S.member;
    if (!m) { main.innerHTML = '<div class="ael-wait">Checking your ' + esc(VN) + " connection…</div>"; return; }
    if (!m.connected) { main.innerHTML = connectHtml(S.flashErr); S.flashErr = null; bind(); return; }
    const list = S.positions;
    main.innerHTML = "<h1>Portfolio</h1><p class=\"sub\">Your " + esc(VN) + " positions on games the service can protect. Open positions settle at $1.00 a contract on the official result; a lock sells part of one into " + esc(VN) + "'s bids now.</p>" +
      (S.flashOk && Date.now() < S.flashOkUntil ? '<div class="note ok">' + esc(S.flashOk) + "</div>" : "") +
      (S.posErr ? '<div class="note err">' + esc(S.posErr) + "</div>" : "") +
      (list.length ? '<div class="rows">' + list.map(posHtml).join("") + "</div>" : S.posAt ? '<div class="empty">No positions on games the service can protect right now. A Winner pick on a listed game shows here once it is in your ' + esc(VN) + " account.</div>" : '<div class="ael-wait">Reading your positions…</div>') +
      (S.posAt ? '<div class="status">Positions read ' + esc(fmtAt(new Date(S.posAt).toISOString())) + "</div>" : "");
    list.forEach((p) => { const el = document.querySelector('[data-ticker="' + CSS.escape(p.ticker) + '"] .ael-row'); if (el) bindRow(el, p); });
    list.forEach((p) => { if (!(p.lock && p.lock.status !== "closed") && p.ticker) void quoteFor(p, false); });
  };
  const bind = () => { const c = document.getElementById("connect"); if (c) c.onclick = () => void connect(); };
  const loadMember = async () => {
    const r = await api("/api/shadow/member");
    if (r.ok && r.json && r.json.member) S.member = r.json.member;
    else if (r.ok && r.status === 404) S.member = { configured: false, connected: false, reason: "member_app_off" };
    else S.member = { configured: true, connected: false, reason: "unreachable" };
  };
  const loadPositions = async (fresh) => {
    if (!(S.member && S.member.connected)) return;
    const r = await api("/api/shadow/positions" + (fresh ? "?fresh=1" : ""));
    if (r.ok && r.json && r.json.member) S.member = r.json.member;
    if (r.ok && r.json && r.json.ok) {
      const rows = (r.json.positions || []).filter((p) => p.venue === "stx" && p.ticker);
      const before = new Map(S.positions.map((p) => [p.ticker, p]));
      S.positions = rows.map((p) => { const prev = before.get(p.ticker); const st = stateOf(p.ticker); const was = prev && prev.lock && prev.lock.status !== "closed"; const is = p.lock && p.lock.status !== "closed"; if (was && !is && !st.closedNow) { st.quote = null; st.quoteAt = 0; } if (is && st.closedNow) st.closedNow = null; return p; });
      S.posAt = Date.now(); S.posErr = null;
    } else if (r.ok && r.json && r.json.error === "venue_read_failed") S.posErr = VN + " could not be read: " + (r.json.message || "");
    else if (!r.ok) S.posErr = "The service could not be reached.";
    if (!(S.member && S.member.connected)) { render(); return; }
    render();
  };
  const start = async () => {
    const q = new URLSearchParams(location.search);
    if (q.get("connected") === "1") { S.flashOk = "Your " + VN + " account is connected."; S.flashOkUntil = Date.now() + 20000; }
    if (q.get("error")) S.flashErr = q.get("error");
    if (q.has("connected") || q.has("error")) history.replaceState(null, "", location.pathname);
    await loadMember();
    render();
    await loadPositions(false);
    setInterval(() => void loadPositions(false), POLL_POS_MS);
    setInterval(() => S.positions.forEach((p) => { const st = stateOf(p.ticker); if (!(p.lock && p.lock.status !== "closed") && !st.busy && !st.open) void quoteFor(p, false); }), 5000);
  };
  void start();
})();
`;
