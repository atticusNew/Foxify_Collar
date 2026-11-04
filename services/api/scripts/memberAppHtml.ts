/**
 * THE MEMBER APP PAGE: the hosted surface for the member venue (STX). A member opens it, connects
 * their own venue account once (the venue's consent page, in this tab), and sees their portfolio
 * as the venue lays it out, with the Lock in line under each position the service can protect,
 * exactly as the embed draws it. The lock is their own sale of part of the position into the
 * venue's bids: the cash lands in their venue balance, the rest rides. Nothing hedged, no capital
 * of ours, no fee.
 *
 * Three tabs. Portfolio: the balance the sale lands in, every open position (the protectable ones
 * with the line, the others muted with the reason, so nothing the venue shows is missing here).
 * Games: what the venue lists that the service protects, with a link to buy on the venue (this
 * page never buys for anyone). History: this member's past locks and their receipts.
 *
 * The page holds no token and no key. Its session is a cookie the service set (HttpOnly), which
 * the service turns into the member's holder alias; every call goes to this origin with that
 * cookie and the x-member-app header, and the service answers for this member alone. It can live
 * on a phone's home screen (manifest under /app/), and re-reads the account whenever it comes
 * back into view, so a buy on the venue shows here on return.
 *
 * One file, no build step, no dependency: the HTML, the CSS in the venue's palette (the same
 * variables as the extension's `.ael-v-stx` skin, so the two surfaces read the same) and the
 * script that talks to /api/shadow/*. The marks are served beside it under /app/.
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
  const venueMark = `<img class="vmark" src="/app/stx.png" alt="${esc(o.venueName)}">`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#010101">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="apple-mobile-web-app-title" content="Lock in">
<link rel="manifest" href="/app/manifest.webmanifest">
<link rel="icon" type="image/png" sizes="192x192" href="/app/icon-192.png">
<link rel="apple-touch-icon" href="/app/icon-180.png">
<title>Lock in · ${esc(o.venueName)} positions</title>
<style>
${CSS}
</style>
</head>
<body class="ael-v-stx">
<header class="top">
  <div class="brand">${o.venueUrl ? `<a class="venue" href="${esc(o.venueUrl)}" rel="noopener" aria-label="${esc(o.venueName)}">${venueMark}</a>` : `<span class="venue">${venueMark}</span>`}<span class="sep" aria-hidden="true"></span><span class="app"><img src="/app/bird.png" alt="">Lock in</span></div>
  <div class="acct" id="acct"></div>
</header>
<nav class="tabs" id="tabs" aria-label="Sections" hidden></nav>
<main id="main" class="main"><div class="ael-wait">Loading…</div></main>
<footer class="foot">
  <div class="foot-l">Protection by <img class="amark" src="/app/atticus.png" alt="Atticus">, a third party; not a product of ${esc(o.venueName)}.</div>
  <div class="foot-r"><a href="${esc(o.recordUrl)}" rel="noopener">Public record</a><span class="dot">·</span><button type="button" class="lnk" id="about-tg" aria-expanded="false">How this works</button><span id="disconnect-foot" hidden><span class="dot">·</span><button type="button" class="lnk" id="disconnect-foot-btn">Disconnect ${esc(o.venueName)}</button></span></div>
  <div class="about" id="about" hidden>
    <p>A lock sells part of a position you hold on ${esc(o.venueName)} into ${esc(o.venueName)}'s own bids, in your own account, at that moment's price. The cash lands in your ${esc(o.venueName)} balance right away; the rest of the position rides to the game as it always did. Win, and the riding contracts still pay. Lose, and you keep the cash.</p>
    <p>No one is on the other side of a lock, nothing is hedged for you, and there is no fee. Leave early buys the same contracts back from ${esc(o.venueName)}'s offers. Every order is placed in your account under the consent you gave on ${esc(o.venueName)}'s own page and shows in your ${esc(o.venueName)} orders; you can revoke that consent there at any time. This page never holds your money, your login or your keys. Every lock is written to a <a href="${esc(o.recordUrl)}" rel="noopener">public record</a> in neutral words, with no account ids.</p>
  </div>
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
  --ael-ring: rgba(255, 255, 255, 0.35); --ael-radius: 8px; --ael-radius-lg: 14px;
  background: #010101; color: var(--ael-fg);
  font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased; min-height: 100vh; display: flex; flex-direction: column;
  padding-bottom: env(safe-area-inset-bottom);
}
a { color: inherit; }
button { font: inherit; }
button, a { -webkit-tap-highlight-color: transparent; }
img { display: block; }

/* the top bar: the venue's mark, our bird and the word, the account */
.top { display: flex; align-items: center; gap: 18px; padding: 0 20px; height: 56px; border-bottom: 1px solid #1a1a1a; background: #010101; position: sticky; top: 0; z-index: 4; padding-top: env(safe-area-inset-top); }
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.brand .venue { display: inline-flex; align-items: center; text-decoration: none; }
.brand .vmark { height: 22px; width: auto; }
.brand .sep { width: 1px; height: 20px; background: #2c2c2c; }
.brand .app { display: inline-flex; align-items: center; gap: 7px; color: var(--ael-fg-strong); font-weight: 600; font-size: 15px; letter-spacing: 0.01em; white-space: nowrap; }
.brand .app img { height: 18px; width: auto; }
.acct { margin-left: auto; display: flex; align-items: center; gap: 14px; font-size: 13px; color: var(--ael-muted); white-space: nowrap; min-width: 0; }
.acct .who { display: inline-flex; align-items: center; gap: 8px; color: var(--ael-soft); min-width: 0; }
.acct .who img { width: 22px; height: 22px; border-radius: 50%; background: var(--ael-bg-raise); }
.acct .who b { font-weight: 600; color: var(--ael-fg-strong); overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
.acct a, .acct .lnk { color: var(--ael-muted); text-decoration: none; background: none; border: 0; padding: 6px 0; cursor: pointer; font-size: 13px; }
.acct a:hover, .acct .lnk:hover { color: var(--ael-fg-strong); }
.acct .back { display: inline-flex; align-items: center; gap: 5px; padding: 6px 10px; border: 1px solid var(--ael-border); border-radius: 999px; color: var(--ael-soft); }
.acct .back:hover { border-color: var(--ael-border-hover); color: var(--ael-fg-strong); }
.acct .back svg { width: 12px; height: 12px; }

/* the tabs: a row under the bar; a segmented bar on a phone */
.tabs { display: flex; gap: 26px; padding: 0 max(20px, calc((100% - 720px) / 2)); border-bottom: 1px solid #1a1a1a; background: #010101; position: sticky; top: calc(56px + env(safe-area-inset-top)); z-index: 3; }
.tabs[hidden] { display: none; }
.tabs button { position: relative; background: none; border: 0; color: var(--ael-muted); font-size: 14px; font-weight: 500; padding: 14px 0 12px; cursor: pointer; }
.tabs button:hover { color: var(--ael-fg-strong); }
.tabs button[aria-selected="true"] { color: var(--ael-fg-strong); font-weight: 600; }
.tabs button[aria-selected="true"]::after { content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: var(--ael-accent); border-radius: 2px 2px 0 0; }
.tabs .n { display: inline-block; min-width: 18px; margin-left: 6px; padding: 0 5px; border-radius: 999px; background: var(--ael-bg-raise); color: var(--ael-soft); font-size: 11px; font-weight: 600; line-height: 18px; text-align: center; }
.tabs button[aria-selected="true"] .n { background: var(--ael-accent); color: var(--ael-accent-ink); }

.main { flex: 1; width: 100%; max-width: 760px; margin: 0 auto; padding: 22px 20px 44px; }
.foot { padding: 18px 20px 26px; font-size: 12.5px; color: var(--ael-dim); border-top: 1px solid #1a1a1a; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; max-width: 760px; margin: 0 auto; width: 100%; }
.foot-l { display: inline; line-height: 1.7; }
.foot .amark { height: 14px; width: auto; display: inline-block; vertical-align: middle; position: relative; top: -1px; margin: 0 2px; }
.foot-r { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; }
.foot a { color: var(--ael-muted); }
.foot .dot { color: var(--ael-faint); }
.foot .lnk { background: none; border: 0; padding: 0; color: var(--ael-muted); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; font-size: 12.5px; }
.foot .lnk:hover, .foot a:hover { color: var(--ael-fg-strong); }
.about { flex-basis: 100%; color: var(--ael-muted); font-size: 12.5px; line-height: 1.5; max-width: 70ch; }
.about p { margin: 6px 0; }
.about[hidden] { display: none; }

h1 { font-size: 22px; font-weight: 700; margin: 0 0 14px; color: var(--ael-fg-strong); letter-spacing: -0.01em; }
h2.grp { font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ael-dim); margin: 26px 0 6px; }
.sub { color: var(--ael-muted); font-size: 13.5px; margin: -6px 0 16px; line-height: 1.5; }
.note { font-size: 13px; color: var(--ael-soft); background: var(--ael-bg-raise); border: 1px solid var(--ael-border); border-radius: var(--ael-radius); padding: 10px 12px; margin: 0 0 14px; display: flex; align-items: center; gap: 12px; }
.note.err { border-color: rgba(255, 107, 107, 0.5); color: #ffb4b4; }
.note.ok { border-color: var(--ael-accent-line); }
.note .ael-go { margin: 0; width: auto; height: 32px; font-size: 13px; flex: none; }

/* the balance strip: what the sale lands in */
.bal { display: flex; align-items: baseline; gap: 10px 16px; flex-wrap: wrap; padding: 12px 14px; margin: 0 0 18px; border: 1px solid var(--ael-border); border-radius: var(--ael-radius); background: var(--ael-bg-raise); font-size: 13px; color: var(--ael-muted); }
.bal b { font-size: 18px; font-weight: 700; color: var(--ael-fg-strong); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.bal .av { font-variant-numeric: tabular-nums; }
.bal .pulse b { color: var(--ael-accent-text); animation: ael-pulse 1.4s ease-out; }
@keyframes ael-pulse { 0% { color: var(--ael-glow); } 100% { color: var(--ael-accent-text); } }
.bal .r { margin-left: auto; }
.bal .who { display: none; align-items: center; gap: 7px; color: var(--ael-soft); flex-basis: 100%; margin-bottom: -2px; }
.bal .who img { width: 20px; height: 20px; border-radius: 50%; background: var(--ael-bg-raise); }
.bal .who b { font-size: 13px; color: var(--ael-fg-strong); font-weight: 600; }
.foot #disconnect-foot { display: none; }
@media (max-width: 640px) { .foot #disconnect-foot:not([hidden]) { display: inline-flex; align-items: center; gap: 8px; } }
.bal .lnk { background: none; border: 0; padding: 0; color: var(--ael-soft); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; font-size: 13px; }

/* the connect card: one thing to do */
.connect { max-width: 520px; margin: 40px auto 0; background: var(--ael-bg-raise); border: 1px solid var(--ael-border); border-radius: var(--ael-radius-lg); padding: 26px 26px 20px; }
.connect h2 { margin: 0 0 8px; font-size: 19px; color: var(--ael-fg-strong); }
.connect p { margin: 0 0 14px; color: var(--ael-soft); font-size: 14px; line-height: 1.5; }
.connect ul { margin: 0 0 16px; padding-left: 18px; color: var(--ael-muted); font-size: 13px; line-height: 1.6; }
.connect .ael-go { margin: 6px 0 10px; height: 44px; }

/* the portfolio: the venue's own rows, the Lock in line under each */
.rows { display: flex; flex-direction: column; }
.pos { padding: 16px 0 14px; border-bottom: 1px solid #1c1c1c; }
.pos:last-child { border-bottom: 0; }
.pos-h { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
.pos-h .name { font-size: 16px; font-weight: 700; color: var(--ael-fg-strong); letter-spacing: -0.01em; }
.pos-h .pays { margin-left: auto; font-size: 15px; font-weight: 700; color: var(--ael-accent); font-variant-numeric: tabular-nums; white-space: nowrap; }
.pos-h .pays small { font-weight: 500; font-size: 12px; color: var(--ael-dim); margin-right: 5px; }
.pos .meta { font-size: 13px; color: var(--ael-muted); margin-top: 3px; display: flex; flex-wrap: wrap; gap: 0 6px; align-items: baseline; }
.pos .meta b { font-weight: 600; color: var(--ael-soft); font-variant-numeric: tabular-nums; }
.pos .meta .sold { color: var(--ael-accent-text); }
.pos .meta .d { color: var(--ael-faint); }
.pos .meta .until { color: var(--ael-dim); }
.pos.muted .name { color: var(--ael-soft); }
.pos.muted .pays { color: var(--ael-muted); }
.pos .ael-row { margin-top: 11px; }
.empty { color: var(--ael-muted); font-size: 14px; padding: 28px 0; text-align: center; line-height: 1.5; }
.status { font-size: 12px; color: var(--ael-dim); margin: 12px 0 0; text-align: right; }

/* the games: what the venue lists that we protect */
.game { padding: 14px 0 12px; border-bottom: 1px solid #1c1c1c; }
.game-h { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.game-h b { font-size: 15px; font-weight: 700; color: var(--ael-fg-strong); }
.game-h span { font-size: 12.5px; color: var(--ael-muted); }
.game-h .until { margin-left: auto; font-size: 12px; color: var(--ael-dim); white-space: nowrap; }
.sides { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.side { display: flex; align-items: center; gap: 12px; padding: 9px 12px; border: 1px solid var(--ael-border); border-radius: var(--ael-radius); background: var(--ael-bg); }
.side .sn { flex: 1; min-width: 0; font-size: 14px; color: var(--ael-fg); }
.side .sn small { display: block; font-size: 12px; color: var(--ael-muted); margin-top: 2px; }
.side .sn small b { color: var(--ael-soft); font-weight: 600; }
.side .buy { display: inline-flex; align-items: center; gap: 6px; flex: none; padding: 7px 12px; border-radius: 999px; border: 1px solid var(--ael-accent-line); background: var(--ael-accent-wash-2); color: var(--ael-fg-strong); font-size: 13px; font-weight: 600; text-decoration: none; white-space: nowrap; }
.side .buy:hover { background: var(--ael-accent-wash-3); }
.side .buy svg { width: 12px; height: 12px; }
.side .have { flex: none; font-size: 12.5px; color: var(--ael-accent-text); font-weight: 600; white-space: nowrap; }
.side .have a { color: inherit; }

/* history */
.hist { padding: 14px 0 12px; border-bottom: 1px solid #1c1c1c; }
.hist .meta { font-size: 12.5px; color: var(--ael-muted); margin: 0 0 8px; }
.hist .meta b { color: var(--ael-soft); font-weight: 600; }

/* the line, the panel and the slip: the extension's grammar, the venue's palette */
.ael-row { display: block; position: relative; max-width: 680px; padding: 0; color: var(--ael-fg); font-size: 14px; text-align: left; }
.ael-box { border: 1px solid var(--ael-accent-line); border-radius: var(--ael-radius); background: var(--ael-bg); overflow: hidden; transition: border-color 0.12s, background 0.12s; }
.ael-box:has(.ael-line-on) { border-color: var(--ael-accent); background: var(--ael-accent-wash); }
.ael-box:has(.ael-line-off), .ael-box:has(.ael-line-wait) { border-color: var(--ael-border); background: transparent; }
.ael-line { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 44px; padding: 8px 12px 8px 8px; border: 0; background: transparent; color: var(--ael-fg); cursor: pointer; text-align: left; font: inherit; }
.ael-line:hover { background: var(--ael-accent-wash); }
.ael-line-off:hover, .ael-line-wait:hover { background: transparent; }
.ael-line-wait, .ael-line-off { cursor: default; }
.ael-tag { display: inline-flex; flex: none; align-items: center; gap: 6px; padding: 4px 11px 4px 8px; border-radius: 999px; border: 1px solid var(--ael-accent-line); background: var(--ael-accent-wash-2); color: var(--ael-fg-strong); font-size: 12.5px; font-weight: 600; line-height: 16px; white-space: nowrap; }
.ael-tag .ael-ic { width: 14px; height: 14px; color: var(--ael-glow); }
.ael-tag .ael-ic svg { width: 14px; height: 14px; }
.ael-tag svg path:last-child { stroke: var(--ael-bg); }
.ael-line-on .ael-tag { background: var(--ael-accent); border-color: var(--ael-accent); color: var(--ael-accent-ink); }
.ael-line-on .ael-tag .ael-ic { color: var(--ael-accent-ink); }
.ael-line-on .ael-tag svg path:last-child { stroke: var(--ael-accent); }
.ael-line-off .ael-tag, .ael-line-wait .ael-tag { padding: 4px 11px; background: var(--ael-bg-deep); border-color: var(--ael-border-hover); color: var(--ael-soft); }
.ael-ic { display: inline-flex; flex: none; width: 18px; height: 18px; align-items: center; justify-content: center; color: var(--ael-glow); }
.ael-ic svg { width: 16px; height: 16px; display: block; }
.ael-fact { flex: 1; min-width: 0; font-size: 14px; color: var(--ael-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hist .ael-fact { white-space: normal; line-height: 1.35; }
.ael-fact b { font-weight: 600; color: var(--ael-fg-strong); font-variant-numeric: tabular-nums; }
.ael-line-off .ael-fact, .ael-line-wait .ael-fact { color: var(--ael-muted); white-space: normal; }
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
.ael-ph span { display: block; font-size: 12.5px; color: var(--ael-muted); margin-top: 3px; line-height: 1.45; }
.ael-wait { font-size: 13px; color: var(--ael-muted); padding: 12px 0; line-height: 1.4; }
.ael-ledger { margin: 0; }
.ael-lr { display: flex; align-items: baseline; gap: 14px; padding: 10px 0; border-bottom: 1px solid var(--ael-divider); }
.ael-lr.ael-last { border-bottom: 0; }
.ael-lr .ael-l { flex: 1; min-width: 0; font-size: 14px; color: var(--ael-fg); }
.ael-lr .ael-l .ael-dim { color: var(--ael-muted); font-size: 12px; }
.ael-lr b { font-size: 15px; font-weight: 600; color: var(--ael-fg-strong); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ael-lr b .ael-dim { font-weight: 400; font-size: 12px; color: var(--ael-muted); }
.ael-lr s { width: 88px; font-size: 12px; color: var(--ael-muted); text-align: right; text-decoration: none; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ael-hero b { color: var(--ael-accent-text); }
.ael-go { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; height: 44px; padding: 0 16px; margin: 8px 0 10px; border: 0; border-radius: var(--ael-radius); background: var(--ael-accent); color: var(--ael-accent-ink); font: inherit; font-size: 15px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.ael-go:hover { background: var(--ael-accent-hover); }
.ael-go:disabled { cursor: wait; }
.ael-go .ael-ic { width: 16px; height: 16px; color: var(--ael-accent-ink); }
.ael-go .ael-ic svg { width: 16px; height: 16px; }
.ael-go svg path:last-child { stroke: var(--ael-accent); }
.ael-go.ael-busy::before { content: ""; display: inline-block; width: 13px; height: 13px; border-radius: 50%; border: 2px solid var(--ael-ring); border-top-color: var(--ael-accent-ink); animation: ael-spin 0.8s linear infinite; }
@keyframes ael-spin { to { transform: rotate(360deg); } }
.ael-go.ael-quiet { display: inline-flex; width: auto; height: 40px; margin: 0; padding: 0 14px; background: var(--ael-bg-raise); color: var(--ael-fg-strong); font-size: 14px; }
.ael-go.ael-quiet:hover { background: var(--ael-bg-hover); }
.ael-go.ael-pillgo { display: inline-flex; width: auto; min-height: 44px; height: auto; margin: 0; padding: 9px 20px 9px 14px; border-radius: 999px; font-size: 15px; white-space: normal; text-align: left; }
.ael-offer-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 12px 0 2px; }
.ael-offer-acts .ael-links { margin-left: auto; font-size: 13.5px; color: var(--ael-muted); white-space: nowrap; }
.ael-tg { display: inline-flex; align-items: center; gap: 3px; color: var(--ael-muted); text-decoration: none; font-size: 13.5px; font-weight: 500; padding: 8px 2px; white-space: nowrap; cursor: pointer; background: none; border: 0; font-family: inherit; }
.ael-tg:hover, .ael-tg[aria-expanded="true"] { color: var(--ael-fg-strong); }
.ael-tgc { display: inline-flex; width: 14px; height: 14px; transition: transform 0.18s ease; }
.ael-tgc svg { width: 14px; height: 14px; display: block; }
.ael-tg[aria-expanded="true"] .ael-tgc { transform: rotate(180deg); }
.ael-details { margin: 10px 0 2px; padding-top: 8px; border-top: 1px solid var(--ael-divider); }
.ael-drows { display: grid; grid-template-columns: max-content 1fr; column-gap: 14px; row-gap: 8px; align-items: baseline; font-size: 13px; line-height: 1.45; margin: 0 0 8px; }
.ael-dl { color: var(--ael-muted); white-space: nowrap; }
.ael-dl .ael-tg { font-size: 13px; padding: 0; }
.ael-dv { color: var(--ael-soft); min-width: 0; overflow-wrap: anywhere; }
.ael-dv b { font-weight: 600; color: var(--ael-fg-strong); }
.ael-dv .ael-dim { color: var(--ael-muted); }
.ael-dv code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.ael-dwide { grid-column: 1 / -1; }
.ael-rgrid { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; line-height: 1.4; margin: 0 0 6px; }
.ael-rg { display: grid; grid-template-columns: 8.5em 1fr; column-gap: 10px; align-items: baseline; }
.ael-rg > span { color: var(--ael-muted); }
.ael-rg > b { font-weight: 500; color: var(--ael-soft); overflow-wrap: anywhere; }
.ael-shape-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 12px 0 0; }
.ael-shape-row > span { font-size: 12.5px; color: var(--ael-muted); }
.ael-shape { display: inline-flex; border: 1px solid var(--ael-border); border-radius: 10px; padding: 3px; background: var(--ael-bg-deep); gap: 2px; max-width: 100%; }
.ael-shape-b { appearance: none; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--ael-muted); font: inherit; font-size: 13px; font-weight: 500; line-height: 1.2; padding: 7px 12px; cursor: pointer; white-space: nowrap; min-height: 34px; }
.ael-shape-b:hover { color: var(--ael-fg-strong); }
.ael-shape-b[aria-pressed="true"] { border-color: var(--ael-accent); background: var(--ael-accent-wash-2); color: var(--ael-fg-strong); font-weight: 600; }
.ael-fine { font-size: 12.5px; color: var(--ael-muted); text-align: left; margin: 0 0 4px; line-height: 1.45; }
.ael-fine.ael-err { color: #ffb4b4; }
.ael-fine.ael-warn { color: var(--ael-accent-text); }
.ael-how { font-size: 13px; color: var(--ael-soft); margin: 6px 0 6px; max-width: 70ch; line-height: 1.5; }
.ael-how p { margin: 0 0 6px; }
.ael-leave { margin: 12px 0 2px; padding: 10px 12px 8px; border: 1px solid var(--ael-border); border-radius: var(--ael-radius); background: var(--ael-bg-deep); }
.ael-leave-h { display: flex; align-items: baseline; gap: 10px; margin: 0 0 2px; flex-wrap: wrap; }
.ael-leave-h b { font-size: 14px; font-weight: 600; color: var(--ael-fg-strong); }
.ael-leave-h span { font-size: 12.5px; color: var(--ael-muted); }
.ael-leave-acts { display: flex; align-items: center; gap: 8px; margin: 8px 0 8px; }
.ael-leave-acts .ael-go { margin: 0; flex: 1; }
.ael-leave-acts .ael-go.ael-quiet { flex: none; }
.ael-acts { display: flex; align-items: center; gap: 10px; margin: 10px 0 0; }
.ael-acts .ael-go.ael-quiet { flex: none; }
.ael-meta { font-size: 12.5px; color: var(--ael-muted); margin: 10px 0 4px; line-height: 1.45; }
.ael-meta b { color: var(--ael-soft); font-weight: 600; }
@media (max-width: 640px) {
  .top { gap: 12px; padding-left: 14px; padding-right: 14px; height: 52px; }
  .brand .vmark { height: 19px; }
  .brand .app { font-size: 14px; }
  .brand .app img { height: 16px; }
  .acct { gap: 10px; }
  .acct .who b { display: none; }
  .acct #disconnect { display: none; }
  .acct .back .l { display: none; }
  .acct .back { padding: 6px 10px; }
  .bal .who { display: inline-flex; }
  .tabs { top: calc(52px + env(safe-area-inset-top)); gap: 0; padding: 8px 14px; }
  .tabs button { flex: 1; padding: 9px 0; border-radius: 8px; font-size: 13.5px; }
  .tabs button[aria-selected="true"] { background: var(--ael-bg-raise); }
  .tabs button[aria-selected="true"]::after { display: none; }
  .main { padding: 16px 14px 32px; }
  h1 { font-size: 20px; margin-bottom: 12px; }
  .bal { padding: 11px 12px; }
  .bal b { font-size: 17px; }
  .bal .r { font-size: 12px; }
  .pos { padding: 14px 0 12px; }
  .pos-h .name { font-size: 15px; }
  .pos-h .pays { font-size: 14px; }
  .ael-lr s { width: 72px; }
  .ael-offer-acts .ael-go.ael-pillgo { flex: 1; justify-content: center; }
  .ael-drows { grid-template-columns: 1fr; row-gap: 3px; }
  .ael-drows .ael-dl { margin-top: 6px; }
  .ael-drows .ael-dl:first-child { margin-top: 0; }
  .ael-leave-acts { flex-wrap: wrap; }
  .ael-leave-acts .ael-go.ael-quiet { flex: 1; }
  .foot { flex-direction: column; align-items: flex-start; gap: 8px; }
  .foot-r { margin-left: 0; }
  .side { flex-wrap: wrap; }
  .side .buy, .side .have { margin-left: auto; }
}
`;

const JS = String.raw`
(() => {
  const CFG = window.AEL_CFG || {};
  const VN = CFG.venueName || "STX";
  const POLL_POS_MS = 15000, REQUOTE_MS = 60000, POLL_ACCT_MS = 30000;
  const TIER_ORDER = ["wide", "balanced", "tight"];
  const TIER_WORDS = { wide: "Max upside", balanced: "Balanced", tight: "Max floor" };
  const TIER_KEY = "ael_tier";
  const SHIELD = '<span class="ael-ic"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5 4.5 5.6v6.2c0 4.6 3.1 8.6 7.5 9.7 4.4-1.1 7.5-5.1 7.5-9.7V5.6L12 2.5z"/><path d="m8.8 12.2 2.1 2.1 4.3-4.6" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  const CHEV = '<span class="ael-chev"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></span>';
  const TGC = '<span class="ael-tgc"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></span>';
  const OUT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3H3v10h10v-3M9 3h4v4M13 3 7 9"/></svg>';
  const DISCLOSE = '<div class="ael-fine">Protection by Atticus, a third party; not a product of ' + VN + '.</div>';
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const usd = (c) => (c < 0 ? "-" : "") + "$" + (Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const signed = (c) => (c >= 0 ? "+" : "-") + "$" + (Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const cents = (c) => c + "\u00a2";
  const fmtAt = (iso) => { const d = new Date(iso); if (isNaN(d)) return ""; return d.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).replace(",", "") + " ET"; };
  const fmtClock = (iso) => { const d = new Date(iso); if (isNaN(d)) return ""; return d.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }); };
  const fmtDay = (iso) => { const d = new Date(iso); if (isNaN(d)) return ""; return d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" }); };
  const nickOf = (side) => { const w = String(side || "").trim().split(/\s+/); return w.length ? w[w.length - 1] : "Your side"; };
  const minsTo = (iso) => Math.round((Date.parse(iso) - Date.now()) / 60000);
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
      case "member_ip": return ["Not sent", VN + " refused the order from our server's address; our allow-list on " + VN + " isn't set yet. Nothing was sold. We're on it."];
      case "not_held": return ["Unavailable", "This position is not in your " + VN + " account any more."];
      case "size": case "too_small": return ["Unavailable", words(p, "The position is too small to protect.")];
      case "no_bids": case "no_offers": return ["No bids", "No one is bidding for this side on " + VN + " right now."];
      case "market_too_close_to_start": return ["Too close", "This game starts too soon; locks close " + (S.cutoff || 45) + " minutes before the start."];
      case "market_not_active": return ["In play", "The game has started; protection is pre-game only."];
      case "not_offered": return ["Not listed", "This game isn't listed for protection."];
      case "not_filled": return ["Not sold", VN + " filled none of it; nothing changed. Try again."];
      case "already_on_record": return ["Protected", "This market is already locked."];
      case "lock_in_flight": return ["One moment", "This position is being locked right now."];
      case "venue_unreachable": return ["Unavailable", VN + " could not be reached."];
      case "venue_refused": return ["Unavailable", words(p, VN + " refused the order.")];
      default: return ["Unavailable", words(p, "Protection isn't available on this position right now.")];
    }
  };
  const reasonWords = (p) => {
    switch (p.reason) {
      case "parlay": return ["Parlay", "Protection on parlays is coming; this one rides as it is."];
      case "league_not_covered": return ["Not covered", "This league isn't covered yet."];
      case "market_not_covered": return ["Not covered", "Only game-winner positions can be protected."];
      case "no_protectable_market": return ["Not listed", "This game isn't listed for protection."];
      case "market_unknown": return ["Unavailable", VN + " didn't describe this market."];
      case "market_lookup_failed": return ["Unavailable", VN + " didn't describe this market just now."];
      default: return ["Unavailable", "Protection isn't available on this position."];
    }
  };

  const S = { tab: "portfolio", member: null, account: null, acctAt: 0, positions: [], posAt: 0, posErr: null, cutoff: 45, games: null, gamesErr: null, history: null, st: new Map(), flash: null, flashOk: null, flashOkUntil: 0, flashErr: null, pulse: 0 };
  const main = document.getElementById("main");
  const acct = document.getElementById("acct");
  const tabs = document.getElementById("tabs");
  const savedTier = (() => { try { const t = localStorage.getItem(TIER_KEY); return TIER_ORDER.includes(t) ? t : null; } catch (e) { return null; } })();
  const rememberTier = (t) => { try { localStorage.setItem(TIER_KEY, t); } catch (e) {} };
  const stateOf = (ticker) => { let st = S.st.get(ticker); if (!st) { st = { open: false, tier: savedTier || "balanced", quote: null, quoteAt: 0, details: false, rules: false, how: false, lock: null, rcpt: null, leave: false, leaveQ: null, busy: null, err: null, justNow: false, ms: 0, cashAfter: null }; S.st.set(ticker, st); } return st; };

  // ---- the connect screen ----
  const connectHtml = (why) => {
    const m = S.member || {};
    const reason = m.reason === "grant_revoked" ? "Your " + VN + " connection was revoked. Connect again when you are ready." : m.reason === "account_pending" ? "Your " + VN + " account is still pending on their side; connect again once it is open." : m.reason === "refresh_failed" ? "Your " + VN + " connection lapsed. Connect again to continue." : "";
    return '<div class="connect"><h2>Protect your ' + esc(VN) + ' positions</h2>' +
      '<p>Connect your ' + esc(VN) + ' account once. You sign in on ' + esc(VN) + "'s own page and approve reading your portfolio and placing orders in your account. This page never sees your login or your keys.</p>" +
      "<ul><li>A lock sells part of a position into " + esc(VN) + "'s bids: the cash lands in your " + esc(VN) + " balance now, the rest rides to the game.</li><li>No one else is on the other side; nothing is hedged for you; no fee.</li><li>Leave early buys the same contracts back from " + esc(VN) + "'s offers.</li></ul>" +
      (reason ? '<div class="ael-fine">' + esc(reason) + "</div>" : "") +
      (why ? '<div class="ael-fine ael-err">' + esc(why) + "</div>" : "") +
      '<button type="button" class="ael-go" id="connect">' + SHIELD + "Connect " + esc(VN) + " account</button>" + DISCLOSE + "</div>";
  };
  const connect = async () => {
    const b = document.getElementById("connect") || document.getElementById("reconnect");
    if (b) { b.disabled = true; b.classList.add("ael-busy"); b.textContent = "Opening " + VN + "…"; }
    const r = await api("/api/shadow/member/connect");
    if (r.ok && r.json && r.json.ok && r.json.url) { location.href = r.json.url; return; }
    main.innerHTML = connectHtml(r.status === 404 ? "This service is not set up for " + VN + " accounts." : words(r.json, "The service could not start the connection."));
    bind();
  };
  const disconnect = async () => {
    const r = await api("/api/shadow/member/disconnect", "POST", {});
    if (r.ok && r.json && r.json.member) S.member = r.json.member;
    S.positions = []; S.account = null; S.games = null; S.history = null; S.st.clear();
    render();
  };

  // ---- quotes and the slip ----
  const quoteFor = async (p, force) => {
    const st = stateOf(p.ticker);
    if (!force && st.quote && Date.now() - st.quoteAt < REQUOTE_MS) return;
    if (st.closedNow && Date.now() - st.closedNow.at < 8000) return;
    if (st.quoting) return;
    st.quoting = true;
    const r = await api("/api/shadow/quote?ticker=" + encodeURIComponent(p.ticker) + "&contracts=" + p.contracts + (p.entryCents != null ? "&entry=" + p.entryCents : "") + "&venue=stx");
    st.quoting = false;
    st.quoteAt = Date.now();
    st.quote = r.ok ? (r.json || { ok: false, code: "unavailable" }) : { ok: false, code: "venue_unreachable" };
    if (st.quote.ok && !(st.quote.quote.tiers && st.quote.quote.tiers[st.tier])) st.tier = st.quote.quote.tier;
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
    return '<div class="ael-shape-row"><span>Shape</span><div class="ael-shape" role="group" aria-label="Shape">' + tiers.map((k) => '<button type="button" class="ael-shape-b" data-tier="' + k + '" aria-pressed="' + (st.tier === k) + '">' + TIER_WORDS[k] + "</button>").join("") + "</div></div>";
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
  const saleWords = (ms) => {
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
  const detailsHtml = (p, st, locked, src0) => {
    const q = st.quote;
    const src = locked ? (src0 || st.rcpt || st.lock || p.lock || {}) : q;
    const o = locked ? null : outcomes(tierOf(st));
    const t = locked ? null : tierOf(st);
    let rows = "";
    if (!locked) {
      rows += '<div class="ael-dl">Sale</div><div class="ael-dv">Sell <b>' + t.soldContracts + " of " + p.contracts + "</b> at about " + cents(t.avgPriceCents) + " into " + esc(VN) + "'s bids · " + t.keptContracts + " keep riding</div>";
      rows += '<div class="ael-dl"><button type="button" class="ael-tg" data-tg="how" aria-expanded="' + st.how + '">How' + TGC + "</button></div><div class=\"ael-dv\">" + (st.how ? '<div class="ael-how"><p>You sell ' + t.soldContracts + " of your " + p.contracts + " contracts into " + esc(VN) + "'s bids now, at the best prices there; " + usd(o.cash) + " lands in your " + esc(VN) + " balance. The other " + t.keptContracts + " ride to the game as they always did.</p><p>Lose, and you keep the " + usd(o.cash) + ". Win, and the riding contracts pay $1 each on top: " + usd(o.cap) + " all in. No one else is on the other side, nothing is hedged for you, and there is no fee.</p></div>" : '<span class="ael-dim">a partial sale of your own position</span>') + "</div>";
    } else {
      const ms = src.memberSale;
      if (ms) rows += '<div class="ael-dl">Sold</div><div class="ael-dv">' + saleWords(ms) + "</div>";
      if (ms) rows += '<div class="ael-dl">In your ' + esc(VN) + ' balance</div><div class="ael-dv"><b>' + usd(ms.cashNowCents) + '</b> <span class="ael-dim">· ' + esc(ms.status || "filled") + "</span></div>";
      if (ms) rows += '<div class="ael-dl">Still riding</div><div class="ael-dv"><b>' + ms.keptContracts + " contracts</b> · pay " + usd(ms.keptContracts * 100) + " on a win, $0 on a loss, as they always did</div>";
      if (src.memberBuyBack) rows += '<div class="ael-dl">Bought back</div><div class="ael-dv"><b>' + src.memberBuyBack.boughtContracts + " at " + cents(src.memberBuyBack.avgPriceCents) + "</b> · cost " + usd(src.memberBuyBack.costCents) + (src.memberBuyBack.orderId ? ' <span class="ael-dim">· ' + VN + " order <code>" + esc(String(src.memberBuyBack.orderId).slice(0, 8)) + "…</code></span>" : "") + "</div>";
      if (src.venueSettlement) rows += '<div class="ael-dl">' + esc(VN) + ' settled</div><div class="ael-dv"><b>' + esc(src.venueSettlement.result || "") + "</b>" + (src.venueSettlement.payoutCents != null ? " · " + usd(src.venueSettlement.payoutCents) + " on the riding contracts" : "") + "</div>";
    }
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
  const lineHtml = (kind, tag, fact, open) => '<button type="button" class="ael-line ael-line-' + kind + (open ? " ael-open" : "") + '"' + (kind === "off" || kind === "wait" ? ' tabindex="-1"' : "") + '><span class="ael-tag">' + (kind === "on" || kind === "offer" ? SHIELD : "") + "<b>" + tag + "</b></span><span class=\"ael-fact\">" + fact + "</span>" + (kind === "off" || kind === "wait" ? "" : CHEV) + "</button>";
  const timing = (p) => {
    if (!p.startsIso) return null;
    const m = minsTo(p.startsIso);
    if (m <= 0) return ["In play", "The game has started; protection is pre-game only."];
    if (m < (S.cutoff || 45)) return ["Too close", "Starts in " + m + " min; locks close " + (S.cutoff || 45) + " minutes before the start."];
    return null;
  };
  const rowHtml = (p) => {
    const st = stateOf(p.ticker || p.id);
    const nick = nickOf(p.side);
    const lock = p.lock && p.lock.status !== "closed" ? p.lock : null;
    let line, panel = "";
    if (!p.ticker) {
      const w = reasonWords(p);
      return '<div class="ael-box">' + lineHtml("off", esc(w[0]), esc(w[1]), false) + "</div>";
    }
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
        if (st.cashAfter != null) meta.push("<b>" + signed(ms.cashNowCents || 0) + "</b> in your " + esc(VN) + " balance · now <b>" + usd(st.cashAfter) + "</b>");
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
    } else if (timing(p) && !(st.quote && st.quote.ok)) {
      const w = timing(p);
      line = lineHtml("off", w[0], esc(w[1]), false);
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
          shapeHtml(st) +
          (t.depthLimited ? '<div class="ael-fine ael-warn" style="margin-top:8px">Only ' + t.soldContracts + " of the " + Math.round(p.contracts * (TIER_ORDER.indexOf(st.tier) + 2) / 5) + " this shape would sell can sell at this price right now; the rest rides.</div>" : "") +
          '<div class="ael-offer-acts"><button type="button" class="ael-go ael-pillgo' + (busy ? " ael-busy" : "") + '" data-act="lock"' + (busy ? " disabled" : "") + ">" + (busy ? esc(st.busyWords || "Selling into the bid…") : SHIELD + "Lock in") + '</button><span class="ael-links"><button type="button" class="ael-tg" data-tg="details" aria-expanded="' + st.details + '">Details' + TGC + "</button></span></div>" +
          (st.err ? '<div class="ael-fine ael-err">' + esc(st.err) + "</div>" : "") +
          (st.details ? detailsHtml(p, st, false) : "") + DISCLOSE + "</div>";
      }
    }
    return '<div class="ael-box">' + line + panel + "</div>";
  };
  const rowEl = (p) => document.querySelector('[data-pos="' + CSS.escape(p.ticker || p.id) + '"] .ael-row');
  const paintRow = (p) => {
    const el = rowEl(p);
    if (!el) return;
    const html = rowHtml(p);
    if (el.innerHTML !== html) { el.innerHTML = html; bindRow(el, p); }
    const head = el.parentElement && el.parentElement.querySelector(".pos-h-wrap");
    if (head) { const h = posHead(p); if (head.innerHTML !== h) head.innerHTML = h; }
    if (S.flash === p.ticker) { S.flash = null; const l = el.querySelector(".ael-line"); if (l) l.classList.add("ael-flash"); }
  };
  const bindRow = (el, p) => {
    const st = stateOf(p.ticker || p.id);
    const line = el.querySelector(".ael-line");
    if (line && !line.classList.contains("ael-line-wait") && !line.classList.contains("ael-line-off")) line.onclick = () => { st.open = !st.open; if (st.open && p.lock && p.lock.status !== "closed" && !st.rcpt) loadReceipt(p); paintRow(p); };
    el.querySelectorAll("[data-tg]").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); const k = b.getAttribute("data-tg"); st[k] = !st[k]; paintRow(p); }; });
    el.querySelectorAll(".ael-shape-b").forEach((b) => { b.onclick = () => { st.tier = b.getAttribute("data-tier"); rememberTier(st.tier); paintRow(p); }; });
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
      st.justNow = true; st.ms = Date.now() - t0; st.rcpt = null; st.details = false; st.cashAfter = null;
      p.lock = { at: r.json.at, status: "open", contracts: r.json.contracts, floorCents: r.json.floorCents, capCents: r.json.capCents, creditCents: 0, route: "member_sale", floorTotalCents: r.json.floorTotalCents, capTotalCents: r.json.capTotalCents, memberSale: r.json.memberSale, compared: r.json.compared, tails: r.json.tails, rules: r.json.rules };
      st.lock = r.json; st.open = true; S.flash = p.ticker;
      paintRow(p);
      setTimeout(() => void loadPositions(true), 1500);
      setTimeout(async () => { await loadAccount(true); const a = S.account; if (a && a.balance && a.balance.accountCents != null) { st.cashAfter = a.balance.accountCents; S.pulse = Date.now(); paintBalance(); paintRow(p); } }, 1200);
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
      st.leave = false; st.open = true; st.quote = null; st.quoteAt = 0; st.rcpt = null; st.lock = null; st.cashAfter = null;
      p.lock = null;
      paintRow(p);
      setTimeout(() => void loadPositions(true), 1500);
      setTimeout(() => { void loadAccount(true).then(() => { S.pulse = Date.now(); paintBalance(); }); }, 1200);
      S.history = null;
      return;
    }
    st.leaveQ = r.json || { ok: false, code: r.ok ? "unavailable" : "venue_unreachable" };
    paintRow(p);
  };

  // ---- the portfolio ----
  const posHead = (p) => {
    const sold = p.lock && p.lock.status === "open" && p.lock.memberSale && p.lock.memberSale.soldContracts > 0 ? p.lock.memberSale.soldContracts : 0;
    const tm = p.ticker ? timing(p) : null;
    const until = p.ticker && p.startsIso && !tm && !(p.lock && p.lock.status !== "closed") ? '<span class="d">·</span><span class="until">Lock in until ' + esc(fmtClock(Date.parse(p.startsIso) - (S.cutoff || 45) * 60000)) + "</span>" : "";
    const what = p.reason === "parlay" ? esc(p.side || p.event || "Parlay") : esc(p.side || "Position") + " to win";
    return '<div class="pos-h"><div class="name">' + what + '</div><div class="pays"><small>pays</small>' + usd(p.payoutCents) + "</div></div>" +
      '<div class="meta"><b>' + p.contracts + "</b> contracts" + (sold ? '<span class="d">·</span><span class="sold">' + sold + " sold</span>" : "") + (p.entryCents != null ? '<span class="d">·</span>avg ' + cents(p.entryCents) : "") + (p.event ? '<span class="d">·</span>' + esc(p.event) : "") + (p.startsIso ? '<span class="d">·</span>' + esc(fmtAt(p.startsIso)) : "") + until + "</div>";
  };
  const posHtml = (p) => '<div class="pos' + (p.ticker ? "" : " muted") + '" data-pos="' + esc(p.ticker || p.id) + '"><div class="pos-h-wrap">' + posHead(p) + '</div><div class="ael-row">' + rowHtml(p) + "</div></div>";
  const balanceHtml = () => {
    const a = S.account;
    if (!a) return '<div class="bal"><span>' + esc(VN) + ' balance</span><span class="ael-dim">reading…</span></div>';
    if (a.balanceScope === false) return '<div class="bal"><span>' + esc(VN) + ' balance</span><span>not shared with this page yet</span><span class="r"><button type="button" class="lnk" id="reconnect">Reconnect to show it</button></span></div>';
    const b = a.balance || {};
    const pulse = Date.now() - S.pulse < 2000 ? " pulse" : "";
    const m = S.member || {};
    const who = m.connected ? '<span class="who">' + (m.avatarUrl ? '<img src="' + esc(m.avatarUrl) + '" alt="">' : "") + "<b>" + (m.handle ? "@" + esc(m.handle) : esc(VN) + " account") + "</b></span>" : "";
    return '<div class="bal">' + who + '<span class="' + pulse.trim() + '">' + esc(VN) + ' balance <b>' + (b.accountCents != null ? usd(b.accountCents) : "—") + "</b></span>" + (b.availableCents != null && b.availableCents !== b.accountCents ? '<span class="av">available ' + usd(b.availableCents) + "</span>" : "") + '<span class="r">' + (b.atIso ? "read " + esc(fmtAt(b.atIso)) : "") + "</span></div>";
  };
  const paintBalance = () => { const el = document.getElementById("bal"); if (el) { el.innerHTML = balanceHtml(); const rc = document.getElementById("reconnect"); if (rc) rc.onclick = () => void connect(); } };
  const portfolioHtml = () => {
    const list = S.positions;
    const live = list.filter((p) => p.ticker && p.lock && p.lock.status !== "closed");
    const offer = list.filter((p) => p.ticker && !(p.lock && p.lock.status !== "closed") && !timing(p));
    const rest = list.filter((p) => !p.ticker || (!(p.lock && p.lock.status !== "closed") && timing(p)));
    return "<h1>Portfolio</h1>" +
      '<div id="bal">' + balanceHtml() + "</div>" +
      (S.flashOk && Date.now() < S.flashOkUntil ? '<div class="note ok">' + esc(S.flashOk) + "</div>" : "") +
      (S.posErr ? '<div class="note err">' + esc(S.posErr) + "</div>" : "") +
      (list.length ? '<div class="rows">' + live.concat(offer).map(posHtml).join("") + "</div>" + (rest.length ? '<h2 class="grp">Not protectable right now</h2><div class="rows">' + rest.map(posHtml).join("") + "</div>" : "") : S.posAt ? '<div class="empty">No open positions in your ' + esc(VN) + " account. Buy a game winner on " + esc(VN) + " and it shows here with its Lock in line; the Games tab lists the ones this service protects.</div>" : '<div class="ael-wait">Reading your positions…</div>') +
      (S.posAt ? '<div class="status">Positions read ' + esc(fmtAt(new Date(S.posAt).toISOString())) + "</div>" : "");
  };

  // ---- the games ----
  const gamesHtml = () => {
    if (S.gamesErr) return "<h1>Games</h1>" + '<div class="note err">' + esc(S.gamesErr) + "</div>";
    if (!S.games) return "<h1>Games</h1>" + '<div class="ael-wait">Reading what ' + esc(VN) + " lists…</div>";
    const g = S.games.games || [];
    const byEvent = new Map();
    g.forEach((x) => { const k = (x.event || "") + "|" + (x.startIso || ""); if (!byEvent.has(k)) byEvent.set(k, []); byEvent.get(k).push(x); });
    const vurl = S.games.venueUrl || CFG.venueUrl;
    let html = "<h1>Games</h1>" + '<p class="sub">Games this service can protect that ' + esc(VN) + " lists right now. Buy a winner on " + esc(VN) + "; back here, the position carries its Lock in line.</p>";
    if (!g.length) return html + '<div class="empty">Nothing protectable on ' + esc(VN) + " right now. Games appear here once both " + esc(VN) + " and this service list them.</div>";
    byEvent.forEach((sides, k) => {
      const first = sides[0];
      html += '<div class="game"><div class="game-h"><b>' + esc(first.event) + "</b><span>" + esc(fmtAt(first.startIso)) + "</span>" + (first.startIso ? '<span class="until">Lock in until ' + esc(fmtClock(Math.min(Date.parse(first.startIso) - (S.cutoff || 45) * 60000, first.untilIso ? Date.parse(first.untilIso) : Infinity))) + "</span>" : "") + '</div><div class="sides">' +
        sides.map((s) => {
          const v = s.venue || {};
          const priceWords = v.bestBidCents != null ? "<b>" + cents(v.bestBidCents) + "</b> bid on " + esc(VN) + (v.floorFromCents != null ? " · a Max floor lock keeps about <b>" + cents(v.floorFromCents) + "</b> a contract on a loss" : "") : "no bid on " + esc(VN) + " yet";
          const act = s.held ? '<span class="have"><a href="#" data-tab="portfolio">In your portfolio</a></span>' : v.url ? '<a class="buy" href="' + esc(v.url) + '" rel="noopener">Buy on ' + esc(VN) + OUT + "</a>" : vurl ? '<a class="buy" href="' + esc(vurl) + '" rel="noopener">Open ' + esc(VN) + OUT + "</a>" : "";
          return '<div class="side"><div class="sn">' + esc(s.side) + " to win<small>" + priceWords + "</small></div>" + act + "</div>";
        }).join("") + "</div></div>";
    });
    html += '<div class="status">' + esc(VN) + " read " + esc(fmtAt(S.games.readAt)) + "</div>";
    return html;
  };

  // ---- the history ----
  const histWords = (r) => {
    const nick = nickOf(r.side);
    if (r.status === "settled") { const won = r.result === "yes" || r.result === "win"; return ["Settled", nick + (won ? " won · " : " lost · ") + "<b>" + usd(won ? (r.capTotalCents || r.protectedCents || 0) : (r.floorTotalCents || r.protectedCents || 0)) + "</b> all in"]; }
    if (r.status === "closed") { const bb = r.memberBuyBack; return ["Left early", "net <b>" + signed(r.closeNetCents || 0) + "</b>" + (bb ? " · bought back " + bb.boughtContracts + " at " + cents(bb.avgPriceCents) : "")]; }
    if (r.status === "void") return ["Void", "the game was called off; the sale stands, the riding contracts were settled by " + VN];
    return ["Protected", "<b>" + usd(r.floorTotalCents || 0) + "</b> or <b>" + usd(r.capTotalCents || 0) + "</b>"];
  };
  const historyHtml = () => {
    if (!S.history) return "<h1>History</h1>" + '<div class="ael-wait">Reading your record…</div>';
    const past = S.history.filter((r) => r.status !== "open");
    let html = "<h1>History</h1>";
    if (!past.length) return html + '<div class="empty">No past locks yet. Settled and closed locks live here with their receipts; open ones are on Portfolio.</div>';
    html += '<div class="rows">' + past.map((r) => {
      const st = stateOf("h:" + r.ticker + ":" + r.at);
      const w = histWords(r);
      const ms = r.memberSale || {};
      return '<div class="hist" data-pos="' + esc("h:" + r.ticker + ":" + r.at) + '"><div class="meta"><b>' + esc(r.side) + " to win</b> · " + esc(r.event || "") + (r.eventTimeIso ? " · " + esc(fmtDay(r.eventTimeIso)) : "") + (ms.soldContracts != null ? " · sold " + ms.soldContracts + " of " + (ms.soldContracts + ms.keptContracts) : "") + '</div><div class="ael-row"><div class="ael-box">' + lineHtml("on", w[0], w[1], st.open) + (st.open ? '<div class="ael-panel ael-on">' + detailsHtml({ contracts: r.contracts }, st, true, r) + '<div class="ael-meta">Locked ' + esc(fmtAt(r.at)) + (r.closedAt ? " · left " + esc(fmtAt(r.closedAt)) : r.settledAt ? " · settled " + esc(fmtAt(r.settledAt)) : "") + "</div>" + DISCLOSE + "</div>" : "") + "</div></div></div>";
    }).join("") + "</div>";
    return html;
  };
  const bindHistory = () => {
    S.history && S.history.forEach((r) => {
      const key = "h:" + r.ticker + ":" + r.at;
      const el = document.querySelector('[data-pos="' + CSS.escape(key) + '"]');
      if (!el) return;
      const st = stateOf(key);
      const line = el.querySelector(".ael-line");
      if (line) line.onclick = () => { st.open = !st.open; render(); };
      el.querySelectorAll("[data-tg]").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); st[b.getAttribute("data-tg")] = !st[b.getAttribute("data-tg")]; render(); }; });
    });
  };

  // ---- the frame ----
  const acctHtml = () => {
    const m = S.member;
    const back = CFG.venueUrl ? '<a class="back" href="' + esc(CFG.venueUrl) + '" rel="noopener"><span><span class="l">Back to </span>' + esc(VN) + "</span>" + OUT + "</a>" : "";
    if (!(m && m.connected)) return back;
    const who = '<span class="who">' + (m.avatarUrl ? '<img src="' + esc(m.avatarUrl) + '" alt="">' : "") + (m.handle ? "<b>@" + esc(m.handle) + "</b>" : '<b>' + esc(VN) + " connected</b>") + "</span>";
    return who + '<button type="button" class="lnk" id="disconnect">Disconnect</button>' + back;
  };
  const tabsHtml = () => {
    const live = S.positions.filter((p) => p.ticker && p.lock && p.lock.status !== "closed").length;
    const past = S.history ? S.history.filter((r) => r.status !== "open").length : 0;
    const games = S.games ? (S.games.games || []).length : 0;
    return [["portfolio", "Portfolio", live], ["games", "Games", games], ["history", "History", past]].map(([k, w, n]) => '<button type="button" role="tab" data-tab="' + k + '" aria-selected="' + (S.tab === k) + '">' + w + (n ? '<span class="n">' + n + "</span>" : "") + "</button>").join("");
  };
  const render = () => {
    acct.innerHTML = acctHtml();
    const d = document.getElementById("disconnect"); if (d) d.onclick = (e) => { e.preventDefault(); void disconnect(); };
    const df = document.getElementById("disconnect-foot"); if (df) { df.hidden = !(S.member && S.member.connected); const b = document.getElementById("disconnect-foot-btn"); if (b) b.onclick = () => void disconnect(); }
    if (!CFG.configured) { tabs.hidden = true; main.innerHTML = '<div class="connect"><h2>Not set up</h2><p>This service is not set up for ' + esc(VN) + " accounts.</p></div>"; return; }
    const m = S.member;
    if (!m) { tabs.hidden = true; main.innerHTML = '<div class="ael-wait">Checking your ' + esc(VN) + " connection…</div>"; return; }
    if (!m.connected) { tabs.hidden = true; main.innerHTML = connectHtml(S.flashErr); S.flashErr = null; bind(); return; }
    tabs.hidden = false; tabs.innerHTML = tabsHtml();
    tabs.querySelectorAll("[data-tab]").forEach((b) => { b.onclick = () => showTab(b.getAttribute("data-tab")); });
    if (S.tab === "games") { main.innerHTML = gamesHtml(); main.querySelectorAll("[data-tab]").forEach((a) => { a.onclick = (e) => { e.preventDefault(); showTab(a.getAttribute("data-tab")); }; }); return; }
    if (S.tab === "history") { main.innerHTML = historyHtml(); bindHistory(); return; }
    main.innerHTML = portfolioHtml();
    const rc = document.getElementById("reconnect"); if (rc) rc.onclick = () => void connect();
    S.positions.forEach((p) => { const el = rowEl(p); if (el) bindRow(el, p); });
    S.positions.forEach((p) => { if (p.ticker && !(p.lock && p.lock.status !== "closed") && !timing(p)) void quoteFor(p, false); });
  };
  const showTab = (t) => {
    S.tab = t;
    try { history.replaceState(null, "", location.pathname + (t === "portfolio" ? "" : "#" + t)); } catch (e) {}
    render();
    if (t === "games" && !S.games) void loadGames();
    if (t === "history" && !S.history) void loadHistory();
    window.scrollTo({ top: 0 });
  };
  const bind = () => { const c = document.getElementById("connect"); if (c) c.onclick = () => void connect(); };
  const loadMember = async () => {
    const r = await api("/api/shadow/member");
    if (r.ok && r.json && r.json.member) S.member = r.json.member;
    else if (r.ok && r.status === 404) S.member = { configured: false, connected: false, reason: "member_app_off" };
    else S.member = { configured: true, connected: false, reason: "unreachable" };
  };
  const loadAccount = async (fresh) => {
    if (!(S.member && S.member.connected)) return;
    const r = await api("/api/shadow/member/account" + (fresh ? "?fresh=1" : ""));
    if (r.ok && r.json && r.json.ok) { S.account = r.json; S.acctAt = Date.now(); if (r.json.member) S.member = r.json.member; }
    else if (r.ok && r.json && r.json.member) S.member = r.json.member;
  };
  const loadPositions = async (fresh) => {
    if (!(S.member && S.member.connected)) return;
    const r = await api("/api/shadow/positions" + (fresh ? "?fresh=1" : ""));
    if (r.ok && r.json && r.json.member) S.member = r.json.member;
    if (r.ok && r.json && r.json.ok) {
      if (r.json.cutoffMinutes) S.cutoff = r.json.cutoffMinutes;
      const rows = (r.json.positions || []).filter((p) => p.venue === "stx");
      const before = new Map(S.positions.map((p) => [p.ticker || p.id, p]));
      S.positions = rows.map((p) => { const key = p.ticker || p.id; const prev = before.get(key); const st = stateOf(key); const was = prev && prev.lock && prev.lock.status !== "closed"; const is = p.lock && p.lock.status !== "closed"; if (was && !is && !st.closedNow) { st.quote = null; st.quoteAt = 0; } if (is && st.closedNow) st.closedNow = null; return p; });
      S.posAt = Date.now(); S.posErr = null;
    } else if (r.ok && r.json && r.json.error === "venue_read_failed") S.posErr = VN + " could not be read: " + (r.json.message || "");
    else if (!r.ok) S.posErr = "The service could not be reached.";
    if (S.tab === "portfolio" || !(S.member && S.member.connected)) render(); else { tabs.innerHTML = tabsHtml(); tabs.querySelectorAll("[data-tab]").forEach((b) => { b.onclick = () => showTab(b.getAttribute("data-tab")); }); }
  };
  const loadGames = async () => {
    const r = await api("/api/shadow/member/games");
    if (r.ok && r.json && r.json.ok) { S.games = r.json; S.gamesErr = null; }
    else S.gamesErr = r.ok ? words(r.json, VN + " could not be read.") : "The service could not be reached.";
    if (S.tab === "games") render(); else { tabs.innerHTML = tabsHtml(); tabs.querySelectorAll("[data-tab]").forEach((b) => { b.onclick = () => showTab(b.getAttribute("data-tab")); }); }
  };
  const loadHistory = async () => {
    const r = await api("/api/shadow/member/history");
    if (r.ok && r.json && r.json.ok) S.history = r.json.records || [];
    if (S.tab === "history") render(); else { tabs.innerHTML = tabsHtml(); tabs.querySelectorAll("[data-tab]").forEach((b) => { b.onclick = () => showTab(b.getAttribute("data-tab")); }); }
  };
  const refreshAll = async (fresh) => {
    if (!(S.member && S.member.connected)) { await loadMember(); render(); if (!(S.member && S.member.connected)) return; }
    await Promise.all([loadAccount(fresh), loadPositions(fresh)]);
    if (S.tab === "portfolio") paintBalance();
    if (S.games) void loadGames();
    if (S.history) void loadHistory();
  };
  const start = async () => {
    const q = new URLSearchParams(location.search);
    if (q.get("connected") === "1") { S.flashOk = "Your " + VN + " account is connected."; S.flashOkUntil = Date.now() + 20000; }
    if (q.get("error")) S.flashErr = q.get("error");
    if (q.has("connected") || q.has("error") || q.has("source")) history.replaceState(null, "", location.pathname + location.hash);
    if (location.hash === "#games" || location.hash === "#history") S.tab = location.hash.slice(1);
    await loadMember();
    render();
    await Promise.all([loadAccount(false), loadPositions(false)]);
    if (S.tab === "portfolio") paintBalance();
    void loadHistory();
    void loadGames();
    setInterval(() => void loadPositions(false), POLL_POS_MS);
    setInterval(() => { void loadAccount(false).then(() => { if (S.tab === "portfolio") paintBalance(); }); }, POLL_ACCT_MS);
    setInterval(() => S.positions.forEach((p) => { const st = stateOf(p.ticker || p.id); if (p.ticker && !(p.lock && p.lock.status !== "closed") && !st.busy && !st.open && !timing(p)) void quoteFor(p, false); }), 5000);
    // back from the venue (a buy, a look at the balance) or from the home screen: read again at once
    let last = Date.now();
    const back = () => { if (document.visibilityState === "visible" && Date.now() - last > 2500) { last = Date.now(); void refreshAll(true); } };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    window.addEventListener("pageshow", (e) => { if (e.persisted) back(); });
  };
  const aboutTg = document.getElementById("about-tg"), about = document.getElementById("about");
  if (aboutTg && about) aboutTg.onclick = () => { const on = about.hidden; about.hidden = !on; aboutTg.setAttribute("aria-expanded", String(on)); };
  void start();
})();
`;
