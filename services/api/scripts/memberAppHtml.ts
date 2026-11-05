/**
 * THE MEMBER APP PAGE: the hosted surface for the member venue (STX). A member opens it, connects
 * their own venue account once (the venue's consent page, in this tab), and sees their portfolio
 * as the venue lays it out, with the Lock in line under each position the service can protect,
 * exactly as the embed draws it. The lock is their own sale of part of the position into the
 * venue's bids: the cash lands in their venue balance, the rest rides. Nothing hedged, no capital
 * of ours, no fee.
 *
 * Three tabs. Portfolio: the balance the sale lands in, every open position (the protectable ones
 * with the line, the others muted with the reason and, for a combination, its legs, so nothing
 * the venue shows is missing here). Games: what the venue lists that the service protects, by
 * day, with a link to buy on the venue (this page never buys for anyone). History: this member's
 * past locks and their receipts.
 *
 * The page holds no token and no key. Its session is a cookie the service set (HttpOnly), which
 * the service turns into the member's holder alias; every call goes to this origin with that
 * cookie and the x-member-app header, and the service answers for this member alone. It can live
 * on a phone's home screen (manifest under /app/), and re-reads the account whenever it comes
 * back into view, so a buy on the venue shows here on return.
 *
 * Painting is keyed: the header is drawn once per identity, each row is patched in place only
 * when its own words change, lists are reconciled by key, so a poll never repaints the page or
 * reloads an image, and the scroll position and an open panel stay where they were.
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
<div class="ptr" id="ptr" aria-hidden="true"><span class="ptr-i"></span><span class="ptr-t">Pull to refresh</span></div>
<header class="top">
  <div class="brand">${o.venueUrl ? `<a class="venue" href="${esc(o.venueUrl)}" rel="noopener" aria-label="${esc(o.venueName)}">${venueMark}</a>` : `<span class="venue">${venueMark}</span>`}<span class="sep" aria-hidden="true"></span><span class="app"><img src="/app/bird.png" alt="">Lock in</span></div>
  <div class="acct" id="acct"></div>
</header>
<nav class="tabs" id="tabs" aria-label="Sections" hidden></nav>
<main id="main" class="main"><div class="ael-wait">Loading…</div></main>
<footer class="foot">
  <div class="foot-l"><span class="fd">Protection by <img class="amark" src="/app/atticus.png" alt="Atticus">, a third party; not a product of ${esc(o.venueName)}.</span><span class="fm"><img class="amark" src="/app/atticus.png" alt="Atticus"><span>Third-party protection; not a product of ${esc(o.venueName)}.</span></span></div>
  <div class="foot-r"><a href="/app/privacy">Privacy</a><span class="dot">·</span><button type="button" class="lnk" id="about-tg">How it works</button><span id="disconnect-foot" hidden><span class="dot">·</span><button type="button" class="lnk" id="disconnect-foot-btn">Disconnect<span class="fd"> ${esc(o.venueName)}</span></button></span></div>
</footer>
<!-- how it works: the one place the page explains itself; opened from the foot and the empty portfolio -->
<div class="sheet" id="how" hidden role="dialog" aria-modal="true" aria-labelledby="how-h">
  <div class="sheet-c">
    <button type="button" class="x" aria-label="Close">×</button>
    <h2 id="how-h">How Lock in works</h2>
    <ol class="steps">
      <li><div><b>Buy a side on ${esc(o.venueName)}</b><small>A game winner, any size. It shows here with its Lock in line.</small></div></li>
      <li><div><b>Tap Lock in</b><small>Part of the position sells into ${esc(o.venueName)}'s bids, in your own account. The cash lands in your ${esc(o.venueName)} balance now.</small></div></li>
      <li><div><b>Keep the floor, win or lose</b><small>Lose, and the cash is yours. Win, and the rest still pays. Leave early buys it back any time before it settles.</small></div></li>
    </ol>
    <p>No one is on the other side of a lock, nothing is hedged for you, and there is no fee. Every order is placed under the consent you gave on ${esc(o.venueName)}'s own page and shows in your ${esc(o.venueName)} orders; you can revoke it there at any time. This page never holds your money, your login or your keys.</p>
    <p>Every lock is priced against every venue this service reads and filled where you hold the position, on ${esc(o.venueName)}; the record keeps what the others would have paid. Every lock is written to a public record in neutral words, with no account ids.</p>
    <div class="links"><a href="/app/privacy">Privacy</a><a href="${esc(o.recordUrl)}" rel="noopener">Public record</a></div>
  </div>
</div>
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
<script>window.AEL_CFG = ${cfg};</script>
<script>
${JS}
</script>
</body>
</html>`;
}

export interface PrivacyPageOptions {
  venueName: string;
  recordUrl: string;
  /** the page's URL, for the way back */
  appUrl: string;
  /** who to write to for removal; the sentence is left out when unset */
  contact?: string;
}

/** THE PRIVACY PAGE: what the page reads, writes, stores and never holds, in plain words, in the same skin. Linked from the foot and named on the venue's app registration. */
export function memberPrivacyHtml(o: PrivacyPageOptions): string {
  const V = esc(o.venueName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#010101">
<link rel="icon" type="image/png" sizes="192x192" href="/app/icon-192.png">
<title>Privacy · Lock in for ${V}</title>
<style>
${CSS}
.doc { max-width: 680px; margin: 0 auto; padding: 8px 0 20px; }
.doc h1 { margin-bottom: 4px; }
.doc .when { font-size: 12.5px; color: var(--ael-dim); margin: 0 0 22px; }
.doc h2 { font-size: 15px; font-weight: 700; color: var(--ael-fg-strong); margin: 22px 0 6px; }
.doc p { margin: 0 0 10px; color: var(--ael-soft); font-size: 14.5px; line-height: 1.6; }
.doc p b { color: var(--ael-fg-strong); font-weight: 600; }
.doc ul { margin: 0 0 10px; padding-left: 20px; color: var(--ael-soft); font-size: 14.5px; line-height: 1.6; }
.doc .back { display: inline-flex; align-items: center; gap: 6px; margin: 26px 0 0; padding: 9px 14px; border: 1px solid var(--ael-border); border-radius: 999px; color: var(--ael-soft); text-decoration: none; font-size: 13.5px; }
.doc .back:hover { border-color: var(--ael-border-hover); color: var(--ael-fg-strong); }
</style>
</head>
<body class="ael-v-stx">
<header class="top">
  <div class="brand"><a class="venue" href="${esc(o.appUrl)}" aria-label="Lock in"><img class="vmark" src="/app/stx.png" alt="${V}"></a><span class="sep" aria-hidden="true"></span><span class="app"><img src="/app/bird.png" alt="">Lock in</span></div>
</header>
<main class="main"><article class="doc">
<h1>Privacy</h1>
<p class="when">How the Lock in page for ${V} handles what it reads.</p>

<h2>What this page reads from ${V}</h2>
<p>With your consent, given on ${V}'s own page: your ${V} user id, account id, handle and avatar; your balance; your open positions; and your orders. Positions and balance are read when you open the page and kept for at most fifteen seconds.</p>

<h2>What it writes</h2>
<p>Only the orders you tap: <b>one sell</b> for part of a position you hold, and, if you choose to leave early, <b>one buy</b> of the same contracts. Nothing else is ever placed. Every order is attributed to this app in your ${V} order history.</p>

<h2>What it stores</h2>
<ul>
<li>The connection token ${V} issues, sealed (AES-GCM) on our server and deleted when you disconnect here or revoke the app on ${V}.</li>
<li>A record of each lock: the market, the size, the prices, the times.</li>
</ul>
<p>It never stores your ${V} login, a payment method or money. <b>Your funds stay in your ${V} account at all times.</b></p>

<h2>The public record</h2>
<p>Each lock is also written to a <a href="${esc(o.recordUrl)}" rel="noopener">public record</a> in neutral words (the market, the size, the prices) with no account id, handle or name.</p>

<h2>Who else sees it</h2>
<p>No one. No analytics, no advertising, nothing sold or shared. Pricing a lock reads other venues' public order books; none of your data is sent to them.</p>

<h2>Your session</h2>
<p>A random id in an HttpOnly cookie, kept 180 days, so the page knows which connection is yours. No tracking cookies.</p>

<h2>Your control</h2>
<p>Disconnect on the page, or revoke the app on ${V}; either ends our access at once and deletes the token.${o.contact ? ` Write to <a href="mailto:${esc(o.contact)}">${esc(o.contact)}</a> to have lock records that name your alias removed from our server; the public record keeps its neutral entries.` : ""}</p>

<h2>Who we are</h2>
<p>Atticus, a third party. This is not a product of ${V}.</p>
<a class="back" href="${esc(o.appUrl)}">← Back to Lock in</a>
</article></main>
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
  /* the edge: a hairline that reads on the page's black and on a raised or amber-washed panel alike; controls and the balance strip carry it (the grey border above vanishes on both) */
  --ael-edge: rgba(255, 255, 255, 0.13); --ael-edge-hover: rgba(255, 255, 255, 0.24);
  --ael-accent: #f9ae1c; --ael-accent-hover: #ffc91a; --ael-accent-ink: #1a1200; --ael-glow: #ffe233; --ael-accent-text: #ffc91a;
  --ael-accent-line: rgba(249, 174, 28, 0.6); --ael-accent-wash: rgba(249, 174, 28, 0.12); --ael-accent-wash-2: rgba(249, 174, 28, 0.16); --ael-accent-wash-3: rgba(249, 174, 28, 0.22);
  --ael-live: #ff5c5c; --ael-parlay: #b48cff; --ael-parlay-wash: rgba(180, 140, 255, 0.14); --ael-parlay-line: rgba(180, 140, 255, 0.45);
  --ael-ring: rgba(255, 255, 255, 0.35); --ael-radius: 8px; --ael-radius-lg: 14px;
  background: #010101; color: var(--ael-fg);
  font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased; min-height: 100vh; display: flex; flex-direction: column;
  padding-bottom: env(safe-area-inset-bottom); overscroll-behavior-y: contain;
}
a { color: inherit; }
button { font: inherit; }
button, a { -webkit-tap-highlight-color: transparent; }
:focus-visible { outline: 2px solid var(--ael-accent); outline-offset: 2px; border-radius: 6px; }
:focus:not(:focus-visible) { outline: 0; }
img { display: block; }

/* pull to refresh */
.ptr { position: fixed; top: 0; left: 0; right: 0; height: 0; overflow: hidden; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 12.5px; color: var(--ael-muted); background: #010101; z-index: 6; transition: height 0.15s ease-out; }
.ptr.ptr-on { height: 44px; }
.ptr-i { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--ael-border-hover); border-top-color: var(--ael-accent); }
.ptr.ptr-busy .ptr-i { animation: ael-spin 0.8s linear infinite; }
.ptr.ptr-ready .ptr-i { border-color: var(--ael-accent); }

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
.acct .back { display: inline-flex; align-items: center; gap: 5px; padding: 6px 10px; border: 1px solid var(--ael-edge); border-radius: 999px; color: var(--ael-soft); }
.acct .back:hover { border-color: var(--ael-edge-hover); color: var(--ael-fg-strong); }
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
.foot { padding: 18px 20px 28px; font-size: 12.5px; color: var(--ael-dim); border-top: 1px solid #1a1a1a; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 18px; max-width: 760px; margin: 0 auto; width: 100%; }
.foot-l { display: inline; line-height: 1.7; color: var(--ael-dim); }
.foot .fm { display: none; }
.foot-r a, .foot-r button.lnk { color: var(--ael-muted); text-decoration: none; font-size: 12.5px; background: none; border: 0; padding: 0; cursor: pointer; font: inherit; }
.foot-r a:hover, .foot-r button.lnk:hover { color: var(--ael-soft); text-decoration: underline; text-underline-offset: 2px; }
.foot .amark { height: 14px; width: auto; display: inline-block; vertical-align: middle; position: relative; top: -1px; margin: 0 2px; }
.foot-r { margin-left: auto; display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
.foot-r a, .foot-r .lnk { white-space: nowrap; }
.foot a { color: var(--ael-muted); }
.foot .dot { color: var(--ael-faint); }
.foot #disconnect-foot { display: none; }

/* the three steps: the empty portfolio's words (How it works carries the same three with a line under each) */
.tsteps { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 0; padding: 0; list-style: none; counter-reset: s; flex: 1; min-width: 0; }
.tsteps li { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ael-muted); white-space: nowrap; }
.tsteps li::before { counter-increment: s; content: counter(s); flex: none; width: 20px; height: 20px; border-radius: 50%; background: var(--ael-accent-wash-2); border: 1px solid var(--ael-accent-line); color: var(--ael-accent-text); font-size: 11.5px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.tsteps li b { color: var(--ael-fg-strong); font-weight: 600; }
.empty .tsteps { justify-content: center; margin: 0 0 14px; }
.empty p { margin: 0; }

/* how it works: a card in the middle on a desk, a sheet from the bottom on a phone */
.sheet { position: fixed; inset: 0; z-index: 8; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(0, 0, 0, 0.62); }
.sheet[hidden] { display: none; }
.sheet-c { position: relative; width: 100%; max-width: 520px; max-height: calc(100vh - 40px); overflow: auto; background: var(--ael-bg-raise); border: 1px solid var(--ael-edge); border-radius: var(--ael-radius-lg); padding: 22px 22px 18px; color: var(--ael-soft); font-size: 14px; line-height: 1.5; animation: ael-pop 0.2s ease-out; }
.sheet-c h2 { margin: 0 0 16px; font-size: 19px; color: var(--ael-fg-strong); padding-right: 36px; }
.sheet-c .x { position: absolute; top: 12px; right: 12px; width: 32px; height: 32px; padding: 0; border-radius: 50%; border: 1px solid var(--ael-edge); background: transparent; color: var(--ael-muted); font-size: 18px; line-height: 1; cursor: pointer; }
.sheet-c .x:hover { color: var(--ael-fg-strong); border-color: var(--ael-edge-hover); }
.sheet-c .steps { margin-bottom: 16px; }
.sheet-c p { margin: 0 0 10px; color: var(--ael-muted); font-size: 13px; }
.sheet-c .links { display: flex; gap: 16px; margin-top: 12px; font-size: 13px; }
.sheet-c .links a { color: var(--ael-soft); }
@keyframes ael-up { from { transform: translateY(24px); opacity: 0; } to { transform: none; opacity: 1; } }
@media (max-width: 640px) { .foot #disconnect-foot:not([hidden]) { display: inline-flex; align-items: center; gap: 6px; } }

h1 { font-size: 22px; font-weight: 700; margin: 0 0 14px; color: var(--ael-fg-strong); letter-spacing: -0.01em; display: flex; align-items: baseline; gap: 12px; }
h1 small { font-size: 13px; font-weight: 500; color: var(--ael-dim); margin-left: auto; }
h2.grp { font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ael-dim); margin: 26px 0 6px; }
h2.grp[hidden] { display: none; }
.sub { color: var(--ael-muted); font-size: 13.5px; margin: -6px 0 16px; line-height: 1.5; }
.sub b { color: var(--ael-soft); font-weight: 600; }
.sub.help { margin-top: -8px; padding: 8px 12px; border-left: 2px solid var(--ael-edge); color: var(--ael-soft); font-size: 13px; }
.sub.help[hidden] { display: none; }
/* the i beside a heading: one tap for what a word means, nothing on the page until then; dim, amber once open */
.qm { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; margin-left: -4px; border: 0; border-radius: 50%; background: transparent; color: var(--ael-dim); cursor: pointer; align-self: center; }
.qm svg { width: 17px; height: 17px; display: block; }
.qm:hover { color: var(--ael-soft); }
.qm[aria-expanded="true"] { color: var(--ael-accent-text); }
.sub.help { border-left-color: var(--ael-accent-line); }
@media (pointer: coarse) { .qm { width: 32px; height: 32px; margin-left: -8px; } }
.note { font-size: 13px; color: var(--ael-soft); background: var(--ael-bg-raise); border: 1px solid var(--ael-border); border-radius: var(--ael-radius); padding: 10px 12px; margin: 0 0 14px; display: flex; align-items: center; gap: 12px; }
.note.err { border-color: rgba(255, 107, 107, 0.5); color: #ffb4b4; }
.note.ok { border-color: var(--ael-accent-line); }
.note .x { margin-left: auto; background: none; border: 0; color: var(--ael-dim); font-size: 18px; line-height: 1; padding: 2px 4px; cursor: pointer; flex: none; }
.note .x:hover { color: var(--ael-fg-strong); }
.note .ael-go { margin: 0; width: auto; height: 32px; font-size: 13px; flex: none; }
.note p { margin: 0; line-height: 1.5; }
.note .hs b { color: var(--ael-fg-strong); font-weight: 600; }

/* the balance strip: what the sale lands in */
.bal { display: flex; align-items: baseline; gap: 10px 16px; flex-wrap: wrap; padding: 12px 14px; margin: 0 0 18px; border: 1px solid var(--ael-edge); border-radius: var(--ael-radius); background: var(--ael-bg-raise); font-size: 13px; color: var(--ael-muted); }
.bal b { font-size: 18px; font-weight: 700; color: var(--ael-fg-strong); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.bal .av { font-variant-numeric: tabular-nums; }
.bal .pulse b { color: var(--ael-accent-text); animation: ael-pulse 1.4s ease-out; }
@keyframes ael-pulse { 0% { color: var(--ael-glow); } 100% { color: var(--ael-accent-text); } }
.bal .r { margin-left: auto; font-size: 12px; color: var(--ael-dim); }
.bal .who { display: none; align-items: center; gap: 7px; color: var(--ael-soft); flex-basis: 100%; margin-bottom: -2px; }
.bal .who img { width: 20px; height: 20px; border-radius: 50%; background: var(--ael-bg-raise); }
.bal .who b { font-size: 13px; color: var(--ael-fg-strong); font-weight: 600; }
.bal .lnk { background: none; border: 0; padding: 0; color: var(--ael-soft); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; font-size: 13px; }

/* the connect card: one thing to do, and what happens when you do it */
.connect { max-width: 520px; margin: 32px auto 0; background: var(--ael-bg-raise); border: 1px solid var(--ael-border); border-radius: var(--ael-radius-lg); padding: 26px 26px 20px; }
.connect h2 { margin: 0 0 8px; font-size: 19px; color: var(--ael-fg-strong); }
.connect p { margin: 0 0 14px; color: var(--ael-soft); font-size: 14px; line-height: 1.5; }
.connect .ael-go { margin: 6px 0 14px; height: 46px; }
.steps { display: flex; flex-direction: column; gap: 10px; margin: 0 0 18px; padding: 0; list-style: none; counter-reset: s; }
.steps li { display: flex; gap: 12px; align-items: flex-start; font-size: 13.5px; color: var(--ael-soft); line-height: 1.45; }
.steps li::before { counter-increment: s; content: counter(s); flex: none; width: 22px; height: 22px; border-radius: 50%; background: var(--ael-accent-wash-2); border: 1px solid var(--ael-accent-line); color: var(--ael-accent-text); font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; margin-top: 1px; }
.steps li b { color: var(--ael-fg-strong); font-weight: 600; }
.steps li small { display: block; color: var(--ael-muted); font-size: 12.5px; margin-top: 2px; }
.perm { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 0; }
.perm span { font-size: 11.5px; padding: 3px 8px; border-radius: 999px; background: var(--ael-bg-deep); border: 1px solid var(--ael-border); color: var(--ael-muted); }
.whyw { font-size: 12.5px; color: var(--ael-muted); margin: 0 0 16px; line-height: 1.5; padding: 10px 12px; border-left: 2px solid var(--ael-accent-line); background: var(--ael-bg); border-radius: 0 var(--ael-radius) var(--ael-radius) 0; }
.whyw b { color: var(--ael-soft); font-weight: 600; }
.connecting { text-align: center; padding: 48px 26px 40px; }
.connecting .spin { width: 44px; height: 44px; margin: 0 auto 16px; border-radius: 50%; border: 3px solid var(--ael-border-hover); border-top-color: var(--ael-accent); animation: ael-spin 0.9s linear infinite; }
.connecting .ok { width: 44px; height: 44px; margin: 0 auto 16px; border-radius: 50%; background: var(--ael-accent); display: flex; align-items: center; justify-content: center; animation: ael-pop 0.35s ease-out; }
.connecting .ok svg { width: 24px; height: 24px; }
@keyframes ael-pop { from { transform: scale(0.6); opacity: 0; } to { transform: none; opacity: 1; } }
.connecting h2 { margin: 0 0 6px; }
.connecting p { margin: 0; color: var(--ael-muted); }
.denied { display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px; margin: 0 0 16px; border: 1px solid rgba(255, 107, 107, 0.4); background: rgba(255, 92, 92, 0.08); border-radius: var(--ael-radius); font-size: 13.5px; color: var(--ael-soft); line-height: 1.5; }
.denied svg { width: 18px; height: 18px; flex: none; margin-top: 2px; color: #ff8a8a; }
.denied b { color: var(--ael-fg-strong); display: block; }

/* skeletons while the first read lands */
.sk { border-radius: 6px; background: linear-gradient(90deg, #161616 25%, #1f1f1f 37%, #161616 63%); background-size: 400% 100%; animation: ael-sk 1.4s ease infinite; }
@keyframes ael-sk { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }
.skrow { padding: 16px 0 14px; border-bottom: 1px solid #1c1c1c; }
.skrow .sk { height: 14px; margin: 0 0 10px; }
.skrow .sk.a { width: 46%; height: 17px; }
.skrow .sk.b { width: 70%; }
.skrow .sk.c { width: 100%; height: 46px; border-radius: var(--ael-radius); margin: 12px 0 0; }

/* the portfolio: the venue's own rows, the Lock in line under each */
.rows { display: flex; flex-direction: column; }
.pos { padding: 16px 0 14px; border-bottom: 1px solid #1c1c1c; }
.pos:last-child { border-bottom: 0; }
.pos-h { display: flex; align-items: center; gap: 12px; }
.mark { flex: none; width: 36px; height: 36px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; letter-spacing: 0.02em; color: #fff; background: #333; text-shadow: 0 1px 0 rgba(0, 0, 0, 0.3); }
.mark.sm { width: 30px; height: 30px; font-size: 11px; }
.mark.parlay { background: var(--ael-parlay-wash); border: 1px solid var(--ael-parlay-line); color: var(--ael-parlay); }
.mark.parlay svg { width: 16px; height: 16px; }
.pos-t { flex: 1; min-width: 0; }
.pos-t .name { font-size: 16px; font-weight: 700; color: var(--ael-fg-strong); letter-spacing: -0.01em; line-height: 1.25; }
.pos-t .name small { font-weight: 500; font-size: 13px; color: var(--ael-muted); margin-left: 5px; }
.pos-t .evt { font-size: 13px; color: var(--ael-muted); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pos-t .evt b { font-weight: 500; color: var(--ael-soft); }
.pos .pays { flex: none; text-align: right; font-size: 15px; font-weight: 700; color: var(--ael-fg-strong); font-variant-numeric: tabular-nums; white-space: nowrap; }
.pos .pays small { display: block; font-weight: 500; font-size: 11px; color: var(--ael-dim); letter-spacing: 0.04em; text-transform: uppercase; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 0 48px; }
.chip { display: inline-flex; align-items: center; gap: 4px; height: 24px; font-size: 12px; line-height: 1; padding: 0 8px; border-radius: 6px; background: var(--ael-bg-raise); border: 1px solid var(--ael-border); color: var(--ael-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.chip b { font-weight: 600; color: var(--ael-soft); }
.chip.sold { border-color: var(--ael-accent-line); background: var(--ael-accent-wash); color: var(--ael-accent-text); }
.chip.sold b { color: var(--ael-accent-text); }
.chip.until { color: var(--ael-dim); }
.ael-panel .chips { margin: 0 0 12px; }
.live-tag { display: inline-flex; align-items: center; gap: 5px; color: var(--ael-soft); font-weight: 500; }
.live-tag i { width: 7px; height: 7px; border-radius: 50%; background: #e5484d; box-shadow: 0 0 0 3px rgba(229, 72, 77, 0.18); animation: ael-live 1.6s ease-in-out infinite; }
@keyframes ael-live { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
.ael-fine.ael-live { color: var(--ael-muted); }
.chip.until svg { width: 11px; height: 11px; }
.chip.price { background: var(--ael-bg-deep); border-color: var(--ael-accent-line); color: var(--ael-fg-strong); font-weight: 700; font-size: 12.5px; padding: 0 9px; }
.chip.price small { font-weight: 500; font-size: 10.5px; color: var(--ael-dim); letter-spacing: 0.04em; text-transform: uppercase; }
.chip.floor { color: var(--ael-soft); }
.chip.floor b { color: var(--ael-accent-text); }
.chip.lg { background: transparent; color: var(--ael-dim); font-weight: 600; letter-spacing: 0.06em; font-size: 10.5px; padding: 0 6px; height: 20px; }
.pos.muted .pos-t .name { color: var(--ael-soft); }
.pos.muted .pays { color: var(--ael-muted); }
.pos.muted .mark:not(.parlay) { filter: saturate(0.35); opacity: 0.85; }
.pos.muted .chip { color: var(--ael-dim); }
.pos .ael-row { margin: 11px 0 0 48px; }
.empty { color: var(--ael-muted); font-size: 14px; padding: 26px 18px; text-align: center; line-height: 1.5; border: 1px dashed var(--ael-border); border-radius: var(--ael-radius-lg); margin: 4px 0 0; }
.empty a { color: var(--ael-accent-text); }
.status { font-size: 12px; color: var(--ael-dim); margin: 12px 0 0; text-align: right; }

/* a combination's legs */
.legs { display: flex; flex-direction: column; margin: 0 0 4px; }
.leg { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--ael-divider); font-size: 13.5px; }
.leg:last-child { border-bottom: 0; }
.leg .ld { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--ael-faint); }
.leg .ld.live { background: var(--ael-live); box-shadow: 0 0 0 3px rgba(255, 92, 92, 0.18); }
.leg .ld.won { background: var(--ael-accent); }
.leg .ld.lost { background: var(--ael-border-hover); }
.leg .ln { flex: 1; min-width: 0; color: var(--ael-fg); }
.leg .ln small { display: block; color: var(--ael-muted); font-size: 12px; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.leg .ls { flex: none; font-size: 11.5px; color: var(--ael-muted); text-transform: uppercase; letter-spacing: 0.05em; }
.leg .ls.live { color: var(--ael-live); }
.leg .ls.won { color: var(--ael-accent-text); }
.leg .ls.lost { color: var(--ael-live); }
.leg .ls.void { color: var(--ael-dim); }
.leg .lp { flex: none; font-size: 12.5px; color: var(--ael-soft); font-variant-numeric: tabular-nums; letter-spacing: 0; text-transform: none; }
.leg .lp.dim { color: var(--ael-faint); }
.leg .ls .lp { color: inherit; opacity: 0.85; margin-left: 2px; }
.legs-h { font-size: 12px; color: var(--ael-dim); margin: 8px 0 2px; letter-spacing: 0.04em; text-transform: uppercase; }

/* the games: what the venue lists that we protect, by day */
.gbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0 0 18px; }
.gbar .f { font-size: 12.5px; padding: 6px 11px; border-radius: 999px; border: 1px solid var(--ael-edge); background: transparent; color: var(--ael-muted); cursor: pointer; }
.gbar .f:hover { color: var(--ael-fg-strong); border-color: var(--ael-edge-hover); }
.gbar .f[aria-pressed="true"] { background: var(--ael-bg-raise); border-color: var(--ael-edge-hover); color: var(--ael-fg-strong); font-weight: 600; }
.gbar .n { margin-left: auto; font-size: 12px; color: var(--ael-dim); }
.day { margin: 0 0 8px; }
.day-h { position: sticky; top: calc(56px + 45px + env(safe-area-inset-top)); z-index: 2; background: #010101; padding: 10px 0 8px; font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ael-dim); display: flex; align-items: baseline; gap: 10px; }
.day-h small { font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--ael-faint); }
.day-h small.n { margin-left: auto; min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--ael-bg-raise); color: var(--ael-soft); font-size: 11px; font-weight: 600; line-height: 18px; text-align: center; }
.game { position: relative; padding: 14px 0 14px 14px; border-bottom: 1px solid #1c1c1c; }
.game::before { content: ""; position: absolute; left: 0; top: 16px; bottom: 16px; width: 3px; border-radius: 3px; background: transparent; }
.game.held::before { background: var(--ael-accent); }
.game-h { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.game-h .lg { flex: none; }
.game-h b { font-size: 15px; font-weight: 700; color: var(--ael-fg-strong); }
.game-h .gt { font-size: 12.5px; color: var(--ael-muted); display: inline-flex; align-items: center; gap: 5px; }
.game-h .gt svg { width: 12px; height: 12px; color: var(--ael-dim); }
.game-h .until { margin-left: auto; font-size: 12px; color: var(--ael-dim); white-space: nowrap; }
.sides { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.side { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--ael-border); border-radius: var(--ael-radius); background: var(--ael-bg); }
.side.held { border-color: var(--ael-accent-line); background: var(--ael-accent-wash); }
.side .mk { position: relative; flex: none; display: inline-flex; }
.side .mk i { position: absolute; right: -3px; bottom: -3px; width: 14px; height: 14px; border-radius: 50%; background: var(--ael-bg-deep); border: 1px solid var(--ael-border-hover); color: var(--ael-soft); font: 700 8.5px/12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-style: normal; text-align: center; }
.side .sn { flex: 1; min-width: 0; font-size: 14.5px; font-weight: 600; color: var(--ael-fg-strong); }
.side .sn small { display: block; font-size: 12px; font-weight: 400; color: var(--ael-muted); margin-top: 1px; }
.side .px { display: inline-flex; align-items: center; gap: 6px; flex: none; }
.side .buy { display: inline-flex; align-items: center; gap: 6px; flex: none; padding: 8px 13px; border-radius: 999px; border: 1px solid var(--ael-accent-line); background: var(--ael-accent-wash-2); color: var(--ael-fg-strong); font-size: 13px; font-weight: 600; text-decoration: none; white-space: nowrap; }
.side .buy:hover { background: var(--ael-accent-wash-3); }
.side .buy svg { width: 12px; height: 12px; }
.side .have { flex: none; display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; color: var(--ael-accent-text); white-space: nowrap; padding: 6px 10px; border-radius: 999px; border: 1px solid var(--ael-accent-line); text-decoration: none; }
.side .have svg { width: 12px; height: 12px; }
.more { display: block; width: 100%; margin: 16px 0 0; height: 42px; border: 1px solid var(--ael-edge); border-radius: var(--ael-radius); background: transparent; color: var(--ael-soft); font-size: 14px; cursor: pointer; }
.more:hover { border-color: var(--ael-edge-hover); color: var(--ael-fg-strong); }

/* history */
.hist { padding: 14px 0 12px; border-bottom: 1px solid #1c1c1c; }
.hist .pos-h { margin-bottom: 10px; }
.hist .pos-t .name { font-size: 15px; }

/* the toast: one line, at the foot */
.toast { position: fixed; left: 50%; bottom: calc(22px + env(safe-area-inset-bottom)); transform: translateX(-50%) translateY(8px); background: var(--ael-bg-raise); border: 1px solid var(--ael-accent-line); color: var(--ael-fg-strong); font-size: 14px; padding: 11px 16px; border-radius: 999px; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5); z-index: 7; opacity: 0; transition: opacity 0.2s, transform 0.2s; white-space: nowrap; }
.toast b { color: var(--ael-accent-text); font-variant-numeric: tabular-nums; }
.toast { display: inline-flex; align-items: center; gap: 9px; }
.toast .tt { min-width: 0; }
.toast .tk { flex: none; width: 16px; height: 16px; border-radius: 50%; background: var(--ael-accent); position: relative; }
.toast .tk::after { content: ""; position: absolute; left: 5px; top: 2px; width: 4px; height: 8px; border: solid #050505; border-width: 0 2px 2px 0; transform: rotate(45deg); }
.bal .delta { display: inline-block; margin-left: 8px; padding: 2px 8px; border-radius: 999px; font-size: 12.5px; font-weight: 600; color: var(--ael-accent-text); background: var(--ael-accent-wash, rgba(245, 158, 11, 0.14)); border: 1px solid var(--ael-accent-line); font-variant-numeric: tabular-nums; animation: ael-rise 0.35s ease-out; vertical-align: 2px; }
.bal .delta.neg { color: var(--ael-soft); background: var(--ael-bg); border-color: var(--ael-border); }
@keyframes ael-rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.toast.on { opacity: 1; transform: translateX(-50%); }
.toast[hidden] { display: none; }

/* the line, the panel and the slip: the extension's grammar, the venue's palette */
.ael-row { display: block; position: relative; max-width: 680px; padding: 0; color: var(--ael-fg); font-size: 14px; text-align: left; }
.ael-box { border: 1px solid var(--ael-accent-line); border-radius: var(--ael-radius); background: var(--ael-bg); overflow: hidden; transition: border-color 0.12s, background 0.12s; }
.ael-box:has(.ael-line-on) { border-color: var(--ael-accent); background: var(--ael-accent-wash); }
.ael-box:has(.ael-line-off), .ael-box:has(.ael-line-wait) { border-color: var(--ael-border); background: transparent; }
.ael-box:has(.t-parlay) { border-color: var(--ael-parlay-line); background: var(--ael-parlay-wash); }
.ael-line { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 44px; padding: 8px 12px 8px 8px; border: 0; background: transparent; color: var(--ael-fg); cursor: pointer; text-align: left; font: inherit; }
.ael-line:hover { background: var(--ael-accent-wash); }
.ael-line-off:hover, .ael-line-wait:hover { background: transparent; }
.ael-line-wait, .ael-line-off:not(.t-parlay):not(.t-hist) { cursor: default; }
.ael-line-off.t-hist:hover { background: var(--ael-bg-raise); }
.ael-tag { display: inline-flex; flex: none; align-items: center; gap: 6px; padding: 4px 11px 4px 8px; border-radius: 999px; border: 1px solid var(--ael-accent-line); background: var(--ael-accent-wash-2); color: var(--ael-fg-strong); font-size: 12.5px; font-weight: 600; line-height: 16px; white-space: nowrap; }
.ael-tag .ael-ic { width: 14px; height: 14px; color: var(--ael-glow); }
.ael-tag .ael-ic svg { width: 14px; height: 14px; }
.ael-tag svg path:last-child { stroke: var(--ael-bg); }
.ael-line-on .ael-tag { background: var(--ael-accent); border-color: var(--ael-accent); color: var(--ael-accent-ink); }
.ael-line-on .ael-tag .ael-ic { color: var(--ael-accent-ink); }
.ael-line-on .ael-tag svg path:last-child { stroke: var(--ael-accent); }
.ael-line-off .ael-tag, .ael-line-wait .ael-tag { padding: 4px 11px; background: var(--ael-bg-deep); border-color: var(--ael-border-hover); color: var(--ael-soft); }
.ael-line-off.t-live .ael-tag::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--ael-live); box-shadow: 0 0 0 3px rgba(255, 92, 92, 0.2); }
.ael-line-off.t-close .ael-tag { color: var(--ael-muted); }
.ael-line-off.t-parlay .ael-tag { background: var(--ael-parlay-wash); border-color: var(--ael-parlay-line); color: var(--ael-parlay); }
.ael-line-off.t-parlay:hover { background: var(--ael-parlay-wash); }
.ael-ic { display: inline-flex; flex: none; width: 18px; height: 18px; align-items: center; justify-content: center; color: var(--ael-glow); }
.ael-ic svg { width: 16px; height: 16px; display: block; }
.ael-fact { flex: 1; min-width: 0; font-size: 14px; color: var(--ael-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hist .ael-fact { white-space: normal; line-height: 1.35; }
.ael-fact b { font-weight: 600; color: var(--ael-fg-strong); font-variant-numeric: tabular-nums; }
.ael-fact .ael-dim { color: var(--ael-muted); font-size: 12.5px; }
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
/* the quiet button (Leave early, Stay protected): outlined, so it reads as a button on the amber panel and on the plain row alike, under the filled Lock in and above the plain Details link */
.ael-go.ael-quiet { display: inline-flex; width: auto; height: 40px; margin: 0; padding: 0 14px; border: 1px solid var(--ael-edge); background: transparent; color: var(--ael-fg-strong); font-size: 14px; }
.ael-go.ael-quiet:hover { border-color: var(--ael-edge-hover); background: var(--ael-bg-raise); }
.ael-go.ael-pillgo { display: inline-flex; width: auto; min-height: 44px; height: auto; margin: 0; padding: 9px 20px 9px 14px; border-radius: 999px; font-size: 15px; white-space: normal; text-align: left; }
.ael-offer-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 12px 0 2px; }
.ael-offer-acts .ael-links { margin-left: auto; font-size: 13.5px; color: var(--ael-muted); white-space: nowrap; }
.ael-offer-acts.ael-tight { margin-top: 6px; }
.ael-offer-acts.ael-tight .ael-fine { margin: 0; }
.ael-tg { display: inline-flex; align-items: center; gap: 3px; min-height: 36px; color: var(--ael-muted); text-decoration: none; font-size: 13.5px; font-weight: 500; padding: 8px 2px; white-space: nowrap; cursor: pointer; background: none; border: 0; font-family: inherit; }
@media (pointer: coarse) { .ael-tg, .gbar .f, .acct .lnk, .note .x { min-height: 44px; } .ael-dl .ael-tg { min-height: 36px; } }
/* touch: the foot links keep a 44px target but the words stay centred on one baseline (a blockified anchor otherwise sits at the top of its box while buttons centre theirs); the row's extra height is pulled back so the rhythm stays tight */
@media (pointer: coarse) { .foot-r a, .foot-r .lnk { display: inline-flex; align-items: center; min-height: 44px; } .foot-r { margin-top: -12px; margin-bottom: -14px; } }
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
.ael-shape { display: inline-flex; border: 1px solid var(--ael-edge); border-radius: 10px; padding: 3px; background: var(--ael-bg-deep); gap: 2px; max-width: 100%; }
.ael-shape-b { appearance: none; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--ael-muted); font: inherit; font-size: 13px; font-weight: 500; line-height: 1.2; padding: 7px 12px; cursor: pointer; white-space: nowrap; min-height: 34px; text-align: center; }
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
  .tabs button[aria-selected="true"] { background: var(--ael-bg-raise); box-shadow: inset 0 0 0 1px var(--ael-edge); }
  .tabs button[aria-selected="true"]::after { display: none; }
  .day-h { top: calc(52px + 53px + env(safe-area-inset-top)); }
  .main { padding: 16px 14px 32px; }
  h1 { font-size: 20px; margin-bottom: 12px; }
  /* the balance stays in view while the rows scroll, one line: who, then the figure; the credit lands where the eye already is */
  .bal { position: sticky; top: calc(52px + 53px + env(safe-area-inset-top)); z-index: 2; padding: 9px 12px; gap: 8px 10px; flex-wrap: nowrap; align-items: center; margin-bottom: 14px; box-shadow: 0 10px 18px -12px rgba(0, 0, 0, 0.9); }
  .bal .who { flex-basis: auto; margin: 0; min-width: 0; }
  .bal .who b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 34vw; }
  .bal .fig { margin-left: auto; white-space: nowrap; font-size: 12px; }
  .bal b { font-size: 16px; }
  .bal .av, .bal .r { display: none; }
  .bal .delta { margin-left: 6px; padding: 1px 7px; font-size: 12px; }
  .pos { padding: 14px 0 12px; }
  .pos-t .name { font-size: 15px; }
  .pos .pays { font-size: 14px; }
  .chips, .pos .ael-row { margin-left: 0; }
  .ael-lr s { width: 72px; }
  .ael-offer-acts .ael-go.ael-pillgo { flex: 1; justify-content: center; }
  .ael-drows { grid-template-columns: 1fr; row-gap: 3px; }
  .ael-drows .ael-dl { margin-top: 6px; }
  .ael-drows .ael-dl:first-child { margin-top: 0; }
  .ael-leave-acts { flex-wrap: wrap; }
  .ael-leave-acts .ael-go.ael-quiet { flex: 1; }
  /* the shape: the label on its own line, the three choices in three equal cells across the panel; a nowrap pill row overflowed the panel's edge on older Safari, where the system font runs wider */
  .ael-shape-row { flex-direction: column; align-items: stretch; gap: 6px; }
  .ael-shape { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); width: 100%; box-sizing: border-box; }
  .ael-shape-b { min-width: 0; padding: 7px 4px; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; }
  /* three short centred lines, each one line from 320px up: the mark, the disclosure, the links */
  .foot { flex-direction: column; align-items: center; text-align: center; gap: 4px; padding: 16px 14px calc(24px + env(safe-area-inset-bottom)); font-size: 12px; }
  .foot .fd { display: none; }
  .foot .fm { display: flex; flex-direction: column; align-items: center; gap: 5px; white-space: nowrap; }
  .foot .fm .amark { height: 15px; margin: 0 0 1px; top: 0; opacity: 0.9; }
  .foot-r { margin-left: 0; justify-content: center; flex-wrap: nowrap; gap: 6px; font-size: 12px; }
  .foot-r a, .foot-r button.lnk { font-size: 12px; }
  .sheet { align-items: flex-end; padding: 0; }
  .sheet-c { max-width: none; max-height: 88vh; border-radius: 16px 16px 0 0; border-bottom: 0; padding: 20px 18px calc(18px + env(safe-area-inset-bottom)); animation: ael-up 0.22s ease-out; }
  .game { padding-left: 12px; }
  /* the filter bar is one row (it scrolls sideways if it ever has to; the count is on the tab); a tile is the mark, the name and the action on one row, the two price chips under them, at every width */
  .gbar { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; margin: 0 -14px 16px; padding: 0 14px; }
  .gbar::-webkit-scrollbar { display: none; }
  .gbar .f { flex: none; }
  .gbar .n { display: none; }
  .side { flex-wrap: wrap; row-gap: 8px; column-gap: 10px; }
  .side .sn { flex: 1; min-width: 0; }
  .side .buy, .side .have { order: 3; flex: none; margin-left: auto; }
  .side .px { order: 4; flex-basis: 100%; flex-wrap: wrap; }
  .connect { margin-top: 14px; padding: 22px 18px 16px; }
  .toast { max-width: calc(100% - 28px); border-radius: 14px; bottom: calc(24px + env(safe-area-inset-bottom)); padding: 10px 14px; font-size: 13.5px; }
  .toast .tt { white-space: normal; text-align: left; line-height: 1.35; }
}
@media (max-width: 400px) {
  .ael-fact { white-space: normal; line-height: 1.3; }
  .ael-line { gap: 10px; padding: 8px 10px 8px 7px; }
  .ael-tag { padding: 4px 9px 4px 7px; font-size: 12px; gap: 5px; }
  .ael-line-off .ael-tag, .ael-line-wait .ael-tag { padding: 4px 9px; }
  .pos-t .name { font-size: 14.5px; }
  .pos .pays { font-size: 13.5px; }
  .ael-lr s { width: 64px; }
}
@media (max-width: 360px) {
  .acct .back span { display: none; }
  .acct .back { padding: 6px 8px; }
  .brand .app { display: none; }
}
`;

const JS = String.raw`
(() => {
  const CFG = window.AEL_CFG || {};
  const VN = CFG.venueName || "STX";
  const POLL_POS_MS = 15000, REQUOTE_MS = 60000, REQUOTE_LIVE_MS = 5000, POLL_ACCT_MS = 30000;
  const TIER_ORDER = ["wide", "balanced", "tight"];
  const TIER_WORDS = { wide: "Max upside", balanced: "Balanced", tight: "Max floor" };
  const HS_KEY = "ael_hs_tip";
  const SHIELD = '<span class="ael-ic"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5 4.5 5.6v6.2c0 4.6 3.1 8.6 7.5 9.7 4.4-1.1 7.5-5.1 7.5-9.7V5.6L12 2.5z"/><path d="m8.8 12.2 2.1 2.1 4.3-4.6" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  const CHEV = '<span class="ael-chev"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></span>';
  const TGC = '<span class="ael-tgc"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></span>';
  const OUT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3H3v10h10v-3M9 3h4v4M13 3 7 9"/></svg>';
  const CLOCK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.5V8l2.4 1.6"/></svg>';
  const INFO = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.4"/><path d="M8 7.2v4"/><path d="M8 4.9v.2"/></svg>';
  const TICK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>';
  const LAYERS = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5 14 5.5 8 8.5 2 5.5z"/><path d="m2 8.5 6 3 6-3"/><path d="m2 11.5 6 3 6-3"/></svg>';
  const WARN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5 1.8 13.5h12.4z"/><path d="M8 6.5v3.2M8 11.6v.2"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="#1a1200" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  const DISCLOSE = '<div class="ael-fine">Protection by Atticus, a third party; not a product of ' + VN + '.</div>';
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const usd = (c) => (c < 0 ? "-" : "") + "$" + (Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const signed = (c) => (c >= 0 ? "+" : "-") + "$" + (Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const cents = (c) => c + "\u00a2";
  const TZ = "America/New_York";
  const fmtAt = (iso) => { const d = new Date(iso); if (isNaN(d)) return ""; return d.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: TZ }).replace(",", "") + " ET"; };
  const fmtClock = (iso) => { const d = new Date(iso); if (isNaN(d)) return ""; return d.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ }); };
  const fmtDay = (iso) => { const d = new Date(iso); if (isNaN(d)) return ""; return d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: TZ }); };
  const dayKey = (iso) => { const d = new Date(iso); if (isNaN(d)) return ""; return d.toLocaleDateString("en-CA", { timeZone: TZ }); };
  const dayLabel = (key) => {
    const today = dayKey(new Date().toISOString());
    const tomorrow = dayKey(new Date(Date.now() + 86400000).toISOString());
    if (key === today) return ["Today", ""];
    if (key === tomorrow) return ["Tomorrow", ""];
    const d = new Date(key + "T12:00:00-05:00");
    return [d.toLocaleDateString("en-US", { weekday: "long", timeZone: TZ }), d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ })];
  };
  const ago = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); if (s < 8) return "just now"; if (s < 60) return s + "s ago"; const m = Math.round(s / 60); if (m < 60) return m + " min ago"; return fmtClock(new Date(ms).toISOString()); };
  const nickOf = (side) => { const w = String(side || "").trim().split(/\s+/); return w.length ? w[w.length - 1] : "Your side"; };
  const minsTo = (iso) => Math.round((Date.parse(iso) - Date.now()) / 60000);
  const initials = (name) => { const w = String(name || "").replace(/[^A-Za-z0-9 ]/g, "").trim().split(/\s+/).filter(Boolean); if (!w.length) return "?"; if (w.length === 1) return w[0].slice(0, 3).toUpperCase(); return w.map((x) => x[0]).join("").slice(0, 3).toUpperCase(); };
  const hue = (name) => { let h = 0; for (const ch of String(name || "")) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
  const markHtml = (name, cls) => '<span class="mark' + (cls ? " " + cls : "") + '" style="background:hsl(' + hue(name) + ' 38% 32%)">' + esc(initials(name)) + "</span>";
  const PARLAY_MARK = '<span class="mark parlay">' + LAYERS + "</span>";
  /** the other club, from the venue's "Away at Home" title and our side: "at Home" or "vs Away" */
  const opponentWords = (side, event) => {
    const e = String(event || ""), s = String(side || "");
    if (!e || !s) return e;
    const at = e.indexOf(" at ");
    if (at < 0) return e;
    const away = e.slice(0, at).trim(), home = e.slice(at + 4).trim();
    if (away === s || away.endsWith(s) || s.endsWith(away)) return "at " + home;
    if (home === s || home.endsWith(s) || s.endsWith(home)) return "vs " + away;
    return e;
  };
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
      case "market_not_active": return S.inPlay ? ["Final", words(p, "This game is over.")] : ["In play", "The game has started; protection is pre-game only."];
      case "market_suspended": return ["Paused", words(p, VN + " has paused this market for the moment; try again in a few seconds.")];
      case "not_offered": return ["Not listed", "This game isn't listed for protection."];
      case "not_filled": return ["Not sold", VN + " filled none of it; nothing changed. Try again."];
      case "already_on_record": return ["Protected", "This market is already locked."];
      case "lock_in_flight": return ["One moment", "This position is being locked right now."];
      case "venue_unreachable": return ["Unavailable", VN + " could not be reached."];
      case "combo_quotes_unavailable": return ["Not yet", VN + " isn't quoting combo tickets yet."];
      case "combo_missed": return ["Missed", "A leg missed; the ticket has settled its way."];
      case "combo_settling": return ["All hit", "Every leg hit; " + VN + " is settling it."];
      case "quote_lapsed": return ["Quote lapsed", VN + "'s quote lapsed before the tap reached it; nothing was sold."];
      case "combo_no_buyback": return ["Stays to settlement", "A combo lock has nothing to buy back from."];
      case "venue_refused": return ["Unavailable", words(p, VN + " refused the order.")];
      default: return ["Unavailable", words(p, "Protection isn't available on this position right now.")];
    }
  };
  const reasonWords = (p) => {
    switch (p.reason) {
      case "parlay": return ["Parlay", "Rides to settlement on " + VN + ".", "parlay"];
      case "league_not_covered": return ["Not covered", "This league isn't covered yet.", ""];
      case "market_not_covered": return ["Not covered", "Only game-winner positions can be protected.", ""];
      case "no_protectable_market": return ["Not listed", "This game isn't listed for protection.", ""];
      case "market_unknown": return ["Unavailable", VN + " didn't describe this market.", ""];
      case "market_lookup_failed": return ["Unavailable", VN + " didn't describe this market just now.", ""];
      default: return ["Unavailable", "Protection isn't available on this position.", ""];
    }
  };

  const S = { tab: "portfolio", screen: "", member: null, account: null, acctAt: 0, positions: [], posAt: 0, posErr: null, cutoff: 45, inPlay: false, games: null, gamesErr: null, gLeague: "all", gAll: false, history: null, st: new Map(), flash: null, flashOk: null, flashOkUntil: 0, flashErr: null, pulse: 0, delta: null, connecting: false, hsTip: false };
  const main = document.getElementById("main");
  const acct = document.getElementById("acct");
  const tabs = document.getElementById("tabs");
  const toastEl = document.getElementById("toast");
  // every row opens on Max upside; a shape picked on one row carries to the rows opened after it this visit, and no further (a remembered Max floor had been greeting members as the default)
  let pickedTier = "wide";
  const rememberTier = (t) => { pickedTier = t; };
  const stateOf = (ticker) => { let st = S.st.get(ticker); if (!st) { st = { open: false, tier: pickedTier, quote: null, quoteAt: 0, details: false, rules: false, how: false, lock: null, rcpt: null, leave: false, leaveQ: null, busy: null, err: null, justNow: false, ms: 0, cashAfter: null }; S.st.set(ticker, st); } return st; };
  const standalone = () => (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
  const phone = () => window.matchMedia && window.matchMedia("(max-width: 640px)").matches;

  // ---- keyed painting: patch what changed, keep the rest ----
  // compared against the last string written, not the browser's own serialisation of it (which
  // differs: entities, attribute order), so an unchanged row is never touched
  const setHtml = (el, html) => { if (el && el.__h !== html) { el.innerHTML = html; el.__h = html; return true; } return false; };
  /** reconcile a container's children with a list: one child per key, in order; new children are made, stale ones removed, kept ones patched in place */
  const syncList = (container, items, keyOf, cls, patch) => {
    if (!container) return;
    const have = new Map();
    for (const el of Array.from(container.children)) have.set(el.getAttribute("data-k"), el);
    let i = 0;
    for (const it of items) {
      const k = keyOf(it);
      let el = have.get(k);
      if (!el) { el = document.createElement("div"); el.className = cls; el.setAttribute("data-k", k); }
      have.delete(k);
      patch(el, it);
      if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
      i++;
    }
    have.forEach((el) => el.remove());
  };
  let toastT = 0;
  const toast = (html) => {
    if (!toastEl) return;
    toastEl.innerHTML = '<span class="tk" aria-hidden="true"></span><span class="tt">' + html + "</span>"; toastEl.hidden = false;
    requestAnimationFrame(() => toastEl.classList.add("on"));
    clearTimeout(toastT);
    toastT = setTimeout(() => { toastEl.classList.remove("on"); setTimeout(() => { toastEl.hidden = true; }, 250); }, 3600);
  };

  // ---- the connect screen ----
  const connectHtml = (why) => {
    const m = S.member || {};
    const reason = m.reason === "grant_revoked" ? "Your " + VN + " connection was revoked. Connect again when you are ready." : m.reason === "account_pending" ? "Your " + VN + " account is still pending on their side; connect again once it is open." : m.reason === "refresh_failed" ? "Your " + VN + " connection lapsed. Connect again to continue." : "";
    return '<div class="connect"><h2>Protect your ' + esc(VN) + ' positions</h2>' +
      '<p>A lock sells part of a position you hold into ' + esc(VN) + "'s bids, in your own account: the cash lands in your " + esc(VN) + " balance now, the rest rides to the game. No one else is on the other side, nothing is hedged for you, no fee.</p>" +
      (why ? '<div class="denied">' + WARN + "<div><b>" + esc(VN) + " didn't connect</b>" + esc(why) + " Nothing is connected; your account is untouched.</div></div>" : "") +
      (reason ? '<div class="ael-fine" style="margin-bottom:12px">' + esc(reason) + "</div>" : "") +
      '<ol class="steps">' +
        "<li><div><b>Sign in on " + esc(VN) + "</b><small>" + esc(VN) + "'s own page, in this tab. This page never sees your login.</small></div></li>" +
        "<li><div><b>Allow once</b><small>One approve screen lists five permissions. Tap Allow.</small>" +
          '<div class="perm"><span>read profile</span><span>read balance</span><span>read portfolio</span><span>read orders</span><span>place orders</span></div></div></li>' +
        "<li><div><b>Back here, with your positions</b><small>Each one the service can protect carries its Lock in line.</small></div></li>" +
      "</ol>" +
      '<div class="whyw"><b>Why place orders?</b> A lock is a sell order for part of your position, placed in your account at the price you see. Nothing else is ever placed, and you can revoke this on ' + esc(VN) + " at any time.</div>" +
      '<button type="button" class="ael-go" id="connect">' + SHIELD + "Connect " + esc(VN) + " account</button>" + DISCLOSE + "</div>";
  };
  const connectingHtml = (done) => '<div class="connect connecting">' + (done ? '<div class="ok">' + CHECK + "</div><h2>" + esc(VN) + " connected</h2><p>Reading your positions…</p>" : '<div class="spin"></div><h2>Connecting your ' + esc(VN) + " account…</h2><p>One moment.</p>") + "</div>";
  const connect = async () => {
    const b = document.getElementById("connect") || document.getElementById("reconnect");
    if (b) { b.disabled = true; b.classList.add("ael-busy"); b.textContent = "Opening " + VN + "…"; }
    const r = await api("/api/shadow/member/connect");
    if (r.ok && r.json && r.json.ok && r.json.url) { location.href = r.json.url; return; }
    S.screen = ""; S.flashErr = r.status === 404 ? "This service is not set up for " + VN + " accounts." : words(r.json, "The service could not start the connection.");
    render();
  };
  const disconnect = async () => {
    const r = await api("/api/shadow/member/disconnect", "POST", {});
    if (r.ok && r.json && r.json.member) S.member = r.json.member;
    S.positions = []; S.account = null; S.games = null; S.history = null; S.st.clear(); S.posAt = 0;
    render();
  };

  // ---- quotes and the slip ----
  const quoteFor = async (p, force) => {
    const st = stateOf(p.ticker);
    // a combo's quote is a request to the venue's makers, not a book read: never every few seconds
    if (!force && st.quote && Date.now() - st.quoteAt < (isLive(p) && st.quote.ok && !p.combo ? REQUOTE_LIVE_MS : REQUOTE_MS)) return;
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
  const wantOf = (st, contracts) => Math.round(contracts * (TIER_ORDER.indexOf(st.tier) + 2) / 5);
  // a combo's two ends are the ticket's, not a club's: every leg in, or one out
  const slipRows = (nick, o, n, sale, combo) => {
    return '<div class="ael-ledger">' +
      '<div class="ael-lr"><span class="ael-l">' + (combo ? "All legs hit" : esc(nick) + " win") + '</span><b>' + usd(o.cap) + '</b><s>of ' + usd(n * 100) + '</s></div>' +
      '<div class="ael-lr ael-hero"><span class="ael-l">' + (combo ? "A leg misses" : esc(nick) + " lose") + '</span><b>' + usd(o.floor) + '</b><s>instead of $0</s></div>' +
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
    if (!c.ok) return '<span class="ael-dim">The other venues could not be priced at the time' + (c.reason ? " (" + esc(c.reason) + ")" : "") + "; the sale fills on " + esc(VN) + " either way.</span>";
    const who = c.chosenName || "Another venue";
    const of = c.priced > 1 ? " (best of " + c.priced + " venues)" : "";
    return "<b>" + esc(who) + esc(of) + "</b> would have paid " + usd(c.creditCents) + " now, then " + usd(c.floorTotalCents) + " or " + usd(c.capTotalCents) + ' <span class="ael-dim">· priced for the record, nothing sent; your position is on ' + esc(VN) + ", so the sale fills there</span>";
  };
  const detailsHtml = (p, st, locked, src0) => {
    const q = st.quote;
    const src = locked ? (src0 || st.rcpt || st.lock || p.lock || {}) : q;
    const o = locked ? null : outcomes(tierOf(st));
    const t = locked ? null : tierOf(st);
    let rows = "";
    if (!locked) {
      rows += '<div class="ael-dl">Sale</div><div class="ael-dv">Sell <b>' + t.soldContracts + " of " + p.contracts + "</b> at about " + cents(t.avgPriceCents) + (p.combo ? " to " + esc(VN) + "'s makers · " : " into " + esc(VN) + "'s bids · ") + t.keptContracts + " keep riding</div>";
      rows += '<div class="ael-dl"><button type="button" class="ael-tg" data-tg="how" aria-expanded="' + st.how + '">How' + TGC + "</button></div><div class=\"ael-dv\">" + (st.how ? '<div class="ael-how"><p>You sell ' + t.soldContracts + " of your " + p.contracts + " contracts " + (p.combo ? "to " + esc(VN) + "'s makers now, at the price they quoted for this ticket; " : "into " + esc(VN) + "'s bids now, at the best prices there; ") + usd(o.cash) + " lands in your " + esc(VN) + " balance. The other " + t.keptContracts + " ride to the game as they always did.</p><p>Lose, and you keep the " + usd(o.cash) + ". Win, and the riding contracts pay $1 each on top: " + usd(o.cap) + " all in. No one else is on the other side, nothing is hedged for you, and there is no fee.</p><p>The same protection is priced against every other venue this service reads, for the record (under Elsewhere); the order itself fills on " + esc(VN) + ", where you hold the position.</p>" + (q.live ? "<p>The game is on, so the price moves. You never get less than the price shown; if the bid moves away first, fewer or none sell and the row says so." + (Number(q.inPlayDelaySec) > 0 ? " " + esc(VN) + " holds in-play orders " + Number(q.inPlayDelaySec) + "s before they can match." : "") + "</p>" : "") + "</div>" : '<span class="ael-dim">a partial sale of your own position</span>') + "</div>";
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
    // a combo has no twin on another venue to price against: no Elsewhere row
    if (cmp && !p.combo) rows += '<div class="ael-dl">Elsewhere</div><div class="ael-dv">' + comparedWords(cmp) + "</div>";
    // a combo settles under the venue's own combo rules, one sentence; a single has the league's tails behind Rules
    if (p.combo) rows += '<div class="ael-dl">Rules</div><div class="ael-dv">' + esc((src && src.comboNote) || (VN + " settles the riding contracts by its own combo rules: a voided leg drops out and the ticket re-prices. The contracts you sold stay sold.")) + "</div>";
    else {
      rows += '<div class="ael-dl"><button type="button" class="ael-tg" data-tg="rules" aria-expanded="' + st.rules + '">Rules' + TGC + "</button></div><div class=\"ael-dv\">" + (st.rules ? "" : '<span class="ael-dim">tie · postponement · called off · corrected result</span>') + "</div>";
      if (st.rules) rows += '<div class="ael-dwide">' + rulesGrid(src, t) + "</div>";
    }
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
      // no note column in this narrower box: a fixed-width note ("in your balance") ran past the box's edge on a phone
      '<div class="ael-ledger"><div class="ael-lr"><span class="ael-l">Sold for</span><b>' + usd(u.cashNowCents) + '</b></div><div class="ael-lr ael-hero"><span class="ael-l">Net to your ' + esc(VN) + ' balance</span><b>' + signed(net) + '</b></div><div class="ael-lr ael-last"><span class="ael-l">Staying</span><b>' + usd(u.stayFloorCents) + " or " + usd(u.stayCapCents) + "</b></div></div>" +
      '<div class="ael-leave-acts"><button type="button" class="ael-go" data-act="leave">' + (st.busy === "leave" ? esc(st.busyWords || "Buying back…") : "Buy back " + bb.contracts + " at " + cents(bb.avgPriceCents)) + '</button><button type="button" class="ael-go ael-quiet" data-act="stay">Stay protected</button></div>' +
      '<div class="ael-fine">Whole again, unprotected · the net above is the round trip' + (q.lastIso ? " · until " + esc(fmtAt(q.lastIso)) : isLive(p) ? " · live price, never more than shown" : "") + "</div></div>";
  };

  // ---- one position's line and panel ----
  const inertLine = (kind, tone) => kind === "wait" || (kind === "off" && tone !== "parlay" && tone !== "hist");
  const lineHtml = (kind, tag, fact, open, tone) => '<button type="button" class="ael-line ael-line-' + kind + (open ? " ael-open" : "") + (tone ? " t-" + tone : "") + '"' + (inertLine(kind, tone) ? ' tabindex="-1"' : "") + '><span class="ael-tag">' + (kind === "on" || kind === "offer" ? SHIELD : "") + "<b>" + tag + "</b></span><span class=\"ael-fact\">" + fact + "</span>" + (inertLine(kind, tone) ? "" : CHEV) + "</button>";
  // the game is on and the service locks in play: the row quotes every few seconds and says so
  const isLive = (p) => !!(S.inPlay && p.ticker && p.startsIso && Date.parse(p.startsIso) <= Date.now());
  const timing = (p) => {
    if (!p.startsIso || S.inPlay) return null;
    const m = minsTo(p.startsIso);
    if (m <= 0) return ["In play", "The game has started; protection is pre-game only.", "live"];
    if (m < (S.cutoff || 45)) return ["Too close", "Starts in " + m + " min; locks close " + (S.cutoff || 45) + " minutes before the start.", "close"];
    return null;
  };
  const legsHtml = (p) => {
    const legs = p.legs || [];
    if (!legs.length) return "";
    const word = { live: "Live", won: "Hit", lost: "Missed", void: "Void" };
    return '<div class="legs-h">' + legs.length + " legs</div><div class=\"legs\">" + legs.map((l) => {
      const done = l.state === "won" || l.state === "lost" || l.state === "void";
      const sub = (l.event ? esc(opponentWords(l.side, l.event)) : "") + (done ? (l.event ? " · " : "") + "Final" : l.startsIso ? (l.event ? " · " : "") + esc(fmtAt(l.startsIso)) : "");
      const right = l.state === "pending" ? (l.priceCents != null ? '<span class="lp">' + cents(l.priceCents) + "</span>" : '<span class="lp dim">—</span>')
        : '<span class="ls ' + esc(l.state) + '">' + word[l.state] + (l.state === "live" && l.priceCents != null ? ' <span class="lp">' + cents(l.priceCents) + "</span>" : "") + "</span>";
      return '<div class="leg"><span class="ld ' + esc(l.state) + '"></span><span class="ln">' + esc(l.side) + (sub ? "<small>" + sub + "</small>" : "") + "</span>" + right + "</div>";
    }).join("") + "</div>";
  };
  // the word budget: a closed row is the tag, one figure and at most six words; a helper line inside an open
  // panel is one line at 375px (about 45 characters); anything longer belongs under Details or in How it works
  const rowHtml = (p) => {
    const st = stateOf(p.ticker || p.id);
    const nick = nickOf(p.side);
    const lock = p.lock && p.lock.status !== "closed" ? p.lock : null;
    let line, panel = "";
    if (!p.ticker) {
      const w = reasonWords(p);
      if (w[2] === "parlay") {
        const legs = p.legs || [], n = legs.length;
        const hit = legs.filter((l) => l.state === "won").length, live = legs.filter((l) => l.state === "live").length, lost = legs.filter((l) => l.state === "lost");
        const nextIso = legs.filter((l) => l.state === "pending" && l.startsIso).map((l) => l.startsIso).sort()[0];
        let fact;
        if (!n) fact = esc(w[1]);
        else if (lost.length) fact = "<b>Missed</b> · " + esc(lost.map((l) => nickOf(l.side)).join(", "));
        else if (hit === n) fact = "<b>All " + n + " hit</b> · settles on " + esc(VN);
        else if (live) fact = "<b>" + live + " live</b> · " + hit + " of " + n + " hit";
        else if (hit) fact = "<b>" + hit + " of " + n + " hit</b>" + (nextIso ? " · next " + esc(fmtAt(nextIso)) : "");
        else fact = "<b>" + n + " legs</b>" + (nextIso ? " · first tips " + esc(fmtAt(nextIso)) : "");
        // one line under the legs; the why lives behind Details, like every other row
        const why = st.details ? '<div class="ael-details"><div class="ael-drows"><div class="ael-dl">Why</div><div class="ael-dv">' + esc(VN) + "'s combo market has no bids to sell into, so a combo cannot be partly sold the way a single pick can.</div>" + '<div class="ael-dl">Last pick</div><div class="ael-dv">Protecting the last open pick on its own is a separate step; it is not on this page yet.</div></div></div>' : "";
        return '<div class="ael-box">' + lineHtml("off", esc(w[0]), fact, st.open, "parlay") + (st.open && n ? '<div class="ael-panel ael-on">' + chipsHtml(p) + legsHtml(p) + '<div class="ael-offer-acts ael-tight"><span class="ael-fine">Rides to settlement on ' + esc(VN) + '.</span><span class="ael-links"><button type="button" class="ael-tg" data-tg="details" aria-expanded="' + st.details + '">Details' + TGC + "</button></span></div>" + why + DISCLOSE + "</div>" : "") + "</div>";
      }
      return '<div class="ael-box">' + lineHtml("off", esc(w[0]), esc(w[1]), false, w[2]) + "</div>";
    }
    if (lock && lock.status === "settled") {
      const won = lock.result === "win" || lock.result === "yes";
      line = lineHtml("on", "Settled", (p.combo ? (won ? "All legs hit: " : "A leg missed: ") : nick + (won ? " won: " : " lost: ")) + "<b>" + usd(won ? lock.capTotalCents || lock.protectedCents : lock.floorTotalCents || lock.protectedCents) + "</b> all in", st.open);
      panel = st.open ? '<div class="ael-panel ael-on">' + chipsHtml(p) + detailsHtml(p, st, true) + DISCLOSE + "</div>" : "";
    } else if (lock) {
      const ms = lock.memberSale || {};
      line = lineHtml("on", "Protected", "<b>" + usd(lock.floorTotalCents) + "</b> or <b>" + usd(lock.capTotalCents) + "</b>" + '<span class="ael-dim"> · locked</span>', st.open);
      if (st.open) {
        const meta = ["Locked " + esc(fmtAt(lock.at))];
        if (st.justNow && st.ms) meta.push("sold " + (st.ms < 100 ? "at once" : "in " + (st.ms / 1000).toFixed(1) + "s"));
        if (ms.requestedContracts != null && ms.soldContracts < ms.requestedContracts) meta.push(ms.soldContracts + " of the " + ms.requestedContracts + " asked sold; the rest rides");
        if (st.cashAfter != null) meta.push("<b>" + signed(ms.cashNowCents || 0) + "</b> in your " + esc(VN) + " balance · now <b>" + usd(st.cashAfter) + "</b>");
        // a combo lock has nothing to buy back from (no offers on a combo market): no Leave early, the legs in its place
        panel = '<div class="ael-panel ael-on">' + chipsHtml(p) + (p.combo ? legsHtml(p) : "") + slipRows(nick, { floor: lock.floorTotalCents, cap: lock.capTotalCents, cash: ms.cashNowCents || 0 }, ms.soldContracts + ms.keptContracts, true, p.combo) +
          (st.leave && !p.combo ? leaveHtml(p, st) : "") +
          (!st.leave || p.combo ? '<div class="ael-acts ael-offer-acts">' + (p.combo ? '<span class="ael-fine">Stays to settlement.</span>' : '<button type="button" class="ael-go ael-quiet" data-act="leave-open">Leave early</button>') + '<span class="ael-links"><button type="button" class="ael-tg" data-tg="details" aria-expanded="' + st.details + '">Details' + TGC + "</button></span></div>" : "") +
          '<div class="ael-meta">' + meta.join(" · ") + "</div>" +
          (st.details ? detailsHtml(p, st, true) : "") + DISCLOSE + "</div>";
      }
    } else if (st.closedNow && !(st.quote && st.quote.ok)) {
      // the row closes on the leave; this line holds the receipt until the fresh offer takes its place
      const c = st.closedNow;
      line = lineHtml("off", "Unprotected", "Bought back " + c.contracts + " at " + cents(c.avgPriceCents) + " · net <b>" + signed(c.netCents) + "</b>", false);
    } else if (timing(p) && !(st.quote && st.quote.ok)) {
      const w = timing(p);
      line = lineHtml("off", w[0], esc(w[1]), false, w[2]);
    } else if (!st.quote) {
      line = lineHtml("wait", "Lock in", p.combo ? "Asking " + esc(VN) + "'s makers for a bid…" : "Pricing from " + esc(VN) + "'s book…", false);
    } else if (!st.quote.ok) {
      const w = refusalWords(st.quote);
      line = lineHtml("off", w[0], esc(w[1]), false, w[0] === "In play" ? "live" : w[0] === "Too close" || w[0] === "Paused" ? "close" : "");
    } else {
      const t = tierOf(st), o = outcomes(t);
      const takers = p.combo ? "makers" : "bids";
      const limited = t.depthLimited ? ' <span class="ael-dim">· ' + VN + "'s " + takers + " take " + t.soldContracts + " of " + wantOf(st, p.contracts) + "</span>" : "";
      const live = !!st.quote.live, delay = live ? Number(st.quote.inPlayDelaySec) || 0 : 0;
      line = lineHtml("offer", "Lock in", "Still get <b>" + usd(o.floor) + "</b> if " + (p.combo ? "a leg misses." : esc(nick) + " lose.") + limited, st.open);
      if (st.open) {
        const busy = st.busy === "lock";
        panel = '<div class="ael-panel ael-on">' + chipsHtml(p) + (p.combo ? legsHtml(p) : "") + slipRows(nick, o, p.contracts, false, p.combo) +
          shapeHtml(st) +
          (p.combo ? '<div class="ael-fine" style="margin-top:8px">Bid from ' + esc(VN) + "'s makers · the rest rides to settlement</div>" : "") +
          (live ? '<div class="ael-fine ael-live" style="margin-top:8px">Live price · never less than shown</div>' : "") +
          (t.depthLimited ? '<div class="ael-fine ael-warn" style="margin-top:8px">' + esc(VN) + "'s " + takers + " take " + t.soldContracts + " of " + wantOf(st, p.contracts) + " · the rest rides</div>" : "") +
          '<div class="ael-offer-acts"><button type="button" class="ael-go ael-pillgo' + (busy ? " ael-busy" : "") + '" data-act="lock"' + (busy ? " disabled" : "") + ">" + (busy ? esc(st.busyWords || "Selling into the bid…") : SHIELD + "Lock in") + '</button><span class="ael-links"><button type="button" class="ael-tg" data-tg="details" aria-expanded="' + st.details + '">Details' + TGC + "</button></span></div>" +
          (st.err ? '<div class="ael-fine ael-err">' + esc(st.err) + "</div>" : "") +
          (st.details ? detailsHtml(p, st, false) : "") + DISCLOSE + "</div>";
      }
    }
    return '<div class="ael-box">' + line + panel + "</div>";
  };
  const posKey = (p) => p.ticker || p.id;
  const rowEl = (p) => document.querySelector('.pos[data-k="' + CSS.escape(posKey(p)) + '"] .ael-row');
  const paintRow = (p) => {
    const el = rowEl(p);
    if (!el) return;
    if (setHtml(el, rowHtml(p))) bindRow(el, p);
    const head = el.parentElement && el.parentElement.querySelector(".pos-h-wrap");
    if (head) setHtml(head, posHead(p));
    if (S.flash && S.flash === p.ticker) { S.flash = null; const l = el.querySelector(".ael-line"); if (l) l.classList.add("ael-flash"); }
  };
  const bindRow = (el, p) => {
    const st = stateOf(posKey(p));
    const line = el.querySelector(".ael-line");
    if (line && !line.classList.contains("ael-line-wait") && !(line.classList.contains("ael-line-off") && !line.classList.contains("t-parlay"))) line.onclick = () => { st.open = !st.open; if (st.open && p.lock && p.lock.status !== "closed" && !st.rcpt && p.ticker) loadReceipt(p); paintRow(p); };
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
    const delay = st.quote && st.quote.live ? Number(st.quote.inPlayDelaySec) || 0 : 0;
    const stages = p.combo ? ["Asking " + VN + "'s makers…", "Taking the quote…", "Writing the record…"] : ["Pricing from " + VN + "'s book…", delay ? "In " + VN + "'s " + delay + "s in-play hold…" : "Selling into the bid…", delay ? "Selling into the bid…" : "Writing the record…"];
    let i = 0; st.busyWords = stages[0]; paintRow(p);
    const tick = setInterval(() => { i = Math.min(i + 1, stages.length - 1); st.busyWords = stages[i]; paintRow(p); }, delay ? Math.max(900, (delay * 1000) / 2) : 900);
    const t0 = Date.now();
    const r = await api("/api/shadow/lock", "POST", { ticker: p.ticker, contracts: p.contracts, entryCents: p.entryCents, tier: st.tier || undefined, venue: "stx" });
    clearInterval(tick);
    st.busy = null;
    if (r.ok && r.json && r.json.ok) {
      st.justNow = true; st.ms = Date.now() - t0; st.rcpt = null; st.details = false; st.cashAfter = null;
      p.lock = { at: r.json.at, status: "open", contracts: r.json.contracts, floorCents: r.json.floorCents, capCents: r.json.capCents, creditCents: 0, route: "member_sale", floorTotalCents: r.json.floorTotalCents, capTotalCents: r.json.capTotalCents, memberSale: r.json.memberSale, compared: r.json.compared, tails: r.json.tails, rules: r.json.rules, comboNote: r.json.comboNote };
      st.lock = r.json; st.open = true; S.flash = p.ticker;
      paintRow(p); paintTabs();
      const ms = r.json.memberSale || {};
      toast("Locked in · <b>" + signed(ms.cashNowCents || 0) + "</b> to your " + esc(VN) + " balance");
      setTimeout(() => void loadPositions(true), 1500);
      setTimeout(async () => { await loadAccount(true); const a = S.account; if (a && a.balance && a.balance.accountCents != null) { st.cashAfter = a.balance.accountCents; creditBalance(ms.cashNowCents || 0); paintRow(p); } }, 1200);
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
      // the row folds to its line and forgets what was open in the panel, so the offer that follows opens clean
      st.leave = false; st.open = false; st.details = false; st.rules = false; st.how = false; st.quote = null; st.quoteAt = 0; st.rcpt = null; st.lock = null; st.cashAfter = null;
      p.lock = null;
      paintRow(p); paintTabs();
      toast("Left early · <b>" + signed(st.closedNow.netCents) + "</b> net to your " + esc(VN) + " balance");
      setTimeout(() => void loadPositions(true), 1500);
      setTimeout(() => { void loadAccount(true).then(() => creditBalance(-(st.closedNow.costCents || 0))); }, 1200);
      S.history = null; void loadHistory();
      return;
    }
    st.leaveQ = r.json || { ok: false, code: r.ok ? "unavailable" : "venue_unreachable" };
    paintRow(p);
  };

  // ---- the portfolio ----
  const posHead = (p) => {
    const parlay = p.reason === "parlay";
    const sold = p.lock && p.lock.status === "open" && p.lock.memberSale && p.lock.memberSale.soldContracts > 0 ? p.lock.memberSale.soldContracts : 0;
    const tm = p.ticker ? timing(p) : null;
    const legs = p.legs || [];
    const name = parlay ? esc((legs.length ? legs.length + "-leg " : "") + "Combo") : esc(p.side || "Position") + "<small>to win</small>";
    const live = isLive(p);
    const evt = parlay ? (legs.length ? esc(legs.map((l) => nickOf(l.side)).join(" · ")) : esc(p.event || "")) : "<b>" + esc(opponentWords(p.side, p.event)) + "</b>" + (live ? ' · <span class="live-tag"><i></i>Live</span>' : p.startsIso ? " · " + esc(fmtAt(p.startsIso)) : "");
    return '<div class="pos-h">' + (parlay ? PARLAY_MARK : markHtml(p.side)) + '<div class="pos-t"><div class="name">' + name + '</div><div class="evt">' + evt + '</div></div><div class="pays"><small>pays</small>' + usd(p.payoutCents) + "</div></div>";
  };
  // the figures behind the row: contracts, what was sold, the average, a parlay's payout and legs' date, the lock window; shown inside the open panel, never on the closed row
  const chipsHtml = (p) => {
    const parlay = p.reason === "parlay";
    const sold = p.lock && p.lock.status === "open" && p.lock.memberSale && p.lock.memberSale.soldContracts > 0 ? p.lock.memberSale.soldContracts : 0;
    const tm = p.ticker ? timing(p) : null;
    const legs = p.legs || [];
    const chips = ['<span class="chip"><b>' + p.contracts + "</b> contracts</span>"];
    if (sold) chips.push('<span class="chip sold"><b>' + sold + "</b> sold</span>");
    if (p.entryCents != null) chips.push('<span class="chip">avg <b>' + cents(p.entryCents) + "</b></span>");
    if (parlay && p.multiplier) chips.push('<span class="chip"><b>' + (Math.round(p.multiplier * 100) / 100) + "×</b> payout</span>");
    // the legs' first tip-off when the legs were placed; else the ticket's own date, which STX sets to its last leg
    if (parlay && p.startsIso) chips.push('<span class="chip">' + (legs.some((l) => l.startsIso) ? "first leg " : "last leg ") + esc(fmtAt(p.startsIso)) + "</span>");
    if (p.ticker && p.startsIso && !tm && !(p.lock && p.lock.status !== "closed")) chips.push('<span class="chip until">' + CLOCK + (S.inPlay ? (isLive(p) ? "Lock in while the game is on" : "Lock in before or during the game") : "Lock in until " + esc(fmtClock(Date.parse(p.startsIso) - (S.cutoff || 45) * 60000))) + "</span>");
    return '<div class="chips">' + chips.join("") + "</div>";
  };
  const patchPos = (el, p) => {
    if (!el.firstChild) el.innerHTML = '<div class="pos-h-wrap"></div><div class="ael-row"></div>';
    el.classList.toggle("muted", !p.ticker);
    setHtml(el.querySelector(".pos-h-wrap"), posHead(p));
    const row = el.querySelector(".ael-row");
    if (setHtml(row, rowHtml(p))) bindRow(row, p);
  };
  const balanceHtml = () => {
    const a = S.account;
    const m = S.member || {};
    const who = m.connected ? '<span class="who">' + (m.avatarUrl ? '<img src="' + esc(m.avatarUrl) + '" alt="">' : "") + "<b>" + (m.handle ? "@" + esc(m.handle) : esc(VN) + " account") + "</b></span>" : "";
    if (!a) return '<div class="bal">' + who + '<span>' + esc(VN) + ' balance</span><span class="sk" style="width:90px;height:18px"></span></div>';
    if (a.balanceScope === false) return '<div class="bal">' + who + '<span>' + esc(VN) + ' balance</span><span>not shared with this page yet</span><span class="r"><button type="button" class="lnk" id="reconnect">Reconnect to show it</button></span></div>';
    const b = a.balance || {};
    const pulse = Date.now() - S.pulse < 2000 ? " pulse" : "";
    const delta = S.delta && Date.now() - S.delta.at < 6000 ? '<span class="delta' + (S.delta.cents < 0 ? " neg" : "") + '">' + signed(S.delta.cents) + "</span>" : "";
    return '<div class="bal">' + who + '<span class="fig' + pulse + '">' + esc(VN) + ' balance <b id="bal-fig">' + (b.accountCents != null ? usd(b.accountCents) : "—") + "</b>" + delta + "</span>" + (b.availableCents != null && b.availableCents !== b.accountCents ? '<span class="av">available ' + usd(b.availableCents) + "</span>" : "") + '<span class="r" id="bal-at"></span></div>';
  };
  const stampBalance = () => { const a = document.getElementById("bal-at"); if (a) a.textContent = S.acctAt ? "updated " + ago(S.acctAt) : ""; };
  const paintBalance = () => { const el = document.getElementById("bal"); if (el && setHtml(el, balanceHtml())) { const rc = document.getElementById("reconnect"); if (rc) rc.onclick = () => void connect(); } stampBalance(); };
  // the balance after a lock or a buy-back: the figure counts from where it was to where it is, a signed badge beside it for a few seconds
  const creditBalance = (cents) => {
    const a = S.account, b = a && a.balance;
    if (!b || b.accountCents == null || !cents) return;
    S.delta = { cents, at: Date.now() }; S.pulse = Date.now();
    paintBalance();
    const fig = document.getElementById("bal-fig");
    const to = b.accountCents, from = to - cents, t0 = performance.now(), ms = 650;
    const step = (t) => { const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3); if (fig && fig.isConnected) fig.textContent = usd(Math.round(from + (to - from) * e)); if (k < 1) requestAnimationFrame(step); };
    if (fig) requestAnimationFrame(step);
    setTimeout(() => { S.delta = null; paintBalance(); }, 6200);
  };
  const hsTipHtml = () => '<div class="note" id="hs-tip"><div class="hs"><p><b>Add Lock in to your home screen</b> for one tap back here after a buy on ' + esc(VN) + ". " + (/iPhone|iPad/.test(navigator.userAgent) ? "Tap Share, then <b>Add to Home Screen</b>." : "Open the browser menu, then <b>Add to Home screen</b>.") + '</p></div><button type="button" class="x" aria-label="Dismiss">×</button></div>';
  // the three steps: the empty portfolio's words (and the top of How it works, in the page's own HTML)
  const TSTEPS = '<ol class="tsteps"><li><span><b>Buy a side</b> on ' + esc(VN) + "</span></li><li><span><b>Tap Lock in</b> here</span></li><li><span><b>Keep the floor</b>, win or lose</span></li></ol>";
  const skeleton = (n) => { let h = ""; for (let i = 0; i < n; i++) h += '<div class="skrow"><div class="sk a"></div><div class="sk b"></div><div class="sk c"></div></div>'; return h; };
  const portfolioScaffold = () => {
    main.innerHTML = "<h1>Portfolio</h1>" + '<div id="bal"></div><div id="notes"></div><div id="grp-live" class="rows"></div><h2 class="grp" id="grp-rest-h" hidden>Not protectable</h2><div id="grp-rest" class="rows"></div><div id="empty"></div><div class="status" id="pos-at"></div>';
    paintBalance();
  };
  const syncPortfolio = () => {
    if (S.screen !== "portfolio") return;
    paintBalance();
    const list = S.positions;
    const live = list.filter((p) => p.ticker && p.lock && p.lock.status !== "closed");
    const byStart = (a, b) => (isLive(b) - isLive(a)) || (Date.parse(a.startsIso || 0) || 0) - (Date.parse(b.startsIso || 0) || 0);
    const offer = list.filter((p) => p.ticker && !(p.lock && p.lock.status !== "closed") && !timing(p)).sort(byStart);
    const rest = list.filter((p) => !p.ticker || (!(p.lock && p.lock.status !== "closed") && timing(p)));
    let notes = "";
    if (S.flashOk && Date.now() < S.flashOkUntil) notes += '<div class="note ok">' + esc(S.flashOk) + "</div>";
    if (S.posErr) notes += '<div class="note err">' + esc(S.posErr) + "</div>";
    if (S.hsTip) notes += hsTipHtml();
    if (setHtml(document.getElementById("notes"), notes)) { const x = document.querySelector("#hs-tip .x"); if (x) x.onclick = () => { S.hsTip = false; try { localStorage.setItem(HS_KEY, "1"); } catch (e) {} syncPortfolio(); }; }
    syncList(document.getElementById("grp-live"), live.concat(offer), posKey, "pos", patchPos);
    document.getElementById("grp-rest-h").hidden = !rest.length;
    syncList(document.getElementById("grp-rest"), rest, posKey, "pos", patchPos);
    const empty = document.getElementById("empty");
    if (setHtml(empty, list.length ? "" : S.posAt ? '<div class="empty">' + TSTEPS + "<p>No open positions in your " + esc(VN) + ' account yet · <a href="#games" data-tab="games">see the games</a> · <a href="#" id="empty-how">how it works</a></p></div>' : skeleton(3))) {
      empty.querySelectorAll("[data-tab]").forEach((a) => { a.onclick = (e) => { e.preventDefault(); showTab("games"); }; });
      const eh = document.getElementById("empty-how"); if (eh) eh.onclick = (e) => { e.preventDefault(); openHow(); };
    }
    setHtml(document.getElementById("pos-at"), S.posAt ? "Positions updated " + esc(ago(S.posAt)) : "");
    offer.forEach((p) => void quoteFor(p, false));
  };

  // ---- the games ----
  const gameKey = (g) => g.event + "|" + g.startIso;
  const gamesScaffold = () => {
    // one line; what the two chips mean sits behind the ? beside the heading
    main.innerHTML = '<h1>Games<button type="button" class="qm" id="g-help" aria-expanded="false" aria-label="What bid and floor mean">' + INFO + "</button></h1>" + '<p class="sub">Buy a side on ' + esc(VN) + ". It lands here with its Lock in line.</p>" + '<p class="sub help" id="g-help-p" hidden><b>Bid</b> is ' + esc(VN) + "'s best bid right now. <b>Floor</b> is what a Max floor lock keeps per contract on a loss.</p>" + '<div class="gbar" id="gbar"></div><div id="glist"></div><div id="gmore"></div><div class="status" id="g-at"></div>';
    const h = document.getElementById("g-help"), hp = document.getElementById("g-help-p");
    if (h && hp) h.onclick = () => { hp.hidden = !hp.hidden; h.setAttribute("aria-expanded", String(!hp.hidden)); };
  };
  const leagueWord = (l) => String(l || "").toUpperCase();
  const syncGames = () => {
    if (S.screen !== "games") return;
    const G = S.games;
    const glist = document.getElementById("glist");
    if (S.gamesErr) { setHtml(glist, '<div class="note err">' + esc(S.gamesErr) + "</div>"); return; }
    if (!G) { setHtml(glist, skeleton(3)); return; }
    const all = G.games || [];
    const leagues = Array.from(new Set(all.map((g) => g.league))).sort();
    const heldN = all.filter((g) => g.held).length;
    const bar = (leagues.length > 1 ? [["all", "All"]].concat(leagues.map((l) => [l, leagueWord(l)])) : []).concat(heldN ? [["held", "Portfolio"]] : []);
    if (setHtml(document.getElementById("gbar"), bar.length ? bar.map(([k, w]) => '<button type="button" class="f" data-f="' + esc(k) + '" aria-pressed="' + (S.gLeague === k) + '">' + esc(w) + "</button>").join("") + '<span class="n">' + all.length + " games</span>" : "")) {
      document.querySelectorAll("#gbar [data-f]").forEach((b) => { b.onclick = () => { S.gLeague = b.getAttribute("data-f"); S.gAll = false; syncGames(); window.scrollTo({ top: 0 }); }; });
    }
    const filtered = all.filter((g) => S.gLeague === "all" || (S.gLeague === "held" ? g.held : g.league === S.gLeague));
    // by game, then by day; held games first within a day
    const byGame = new Map();
    for (const g of filtered) { const k = gameKey(g); if (!byGame.has(k)) byGame.set(k, []); byGame.get(k).push(g); }
    const games = Array.from(byGame.values()).map((sides) => ({ key: gameKey(sides[0]), sides, held: sides.some((s) => s.held), day: dayKey(sides[0].startIso), startIso: sides[0].startIso }));
    games.sort((a, b) => a.day.localeCompare(b.day) || (b.held - a.held) || Date.parse(a.startIso) - Date.parse(b.startIso) || a.key.localeCompare(b.key));
    const days = Array.from(new Set(games.map((g) => g.day)));
    const shownDays = S.gAll || days.length <= 2 ? days : days.slice(0, 2);
    const hidden = games.filter((g) => !shownDays.includes(g.day)).length;
    const dayItems = shownDays.map((d) => ({ day: d, games: games.filter((g) => g.day === d) }));
    if (!games.length) { setHtml(glist, '<div class="empty">' + (all.length ? "Nothing here under this filter." : "Nothing protectable on " + esc(VN) + " right now. Games appear here once both " + esc(VN) + " and this service list them.") + "</div>"); setHtml(document.getElementById("gmore"), ""); return; }
    if (glist.firstChild && glist.firstChild.className !== "day") glist.innerHTML = "";
    syncList(glist, dayItems, (d) => d.day, "day", (el, d) => {
      if (!el.firstChild) el.innerHTML = '<div class="day-h"></div><div class="dgames"></div>';
      const [w, sub] = dayLabel(d.day);
      setHtml(el.querySelector(".day-h"), esc(w) + (sub ? "<small>" + esc(sub) + "</small>" : "") + '<small class="n">' + d.games.length + "</small>");
      syncList(el.querySelector(".dgames"), d.games, (g) => g.key, "game", (gel, g) => {
        gel.classList.toggle("held", g.held);
        const first = g.sides[0];
        const until = S.inPlay ? null : first.startIso ? Math.min(Date.parse(first.startIso) - (S.cutoff || 45) * 60000, first.untilIso ? Date.parse(first.untilIso) : Infinity) : null;
        const html = '<div class="game-h"><span class="chip lg">' + esc(leagueWord(first.league)) + "</span><b>" + esc(first.event) + '</b><span class="gt">' + CLOCK + esc(fmtAt(first.startIso)) + "</span>" + (until ? '<span class="until">Lock in until ' + esc(fmtClock(until)) + "</span>" : "") + '</div><div class="sides">' +
          g.sides.map((s) => {
            const v = s.venue || {};
            const px = v.bestBidCents != null ? '<span class="chip price"><small>bid</small>' + cents(v.bestBidCents) + "</span>" + (v.floorFromCents != null ? '<span class="chip floor">floor ≈ <b>' + cents(v.floorFromCents) + "</b></span>" : "") : v.lastCents != null ? '<span class="chip">last ' + cents(v.lastCents) + "</span>" : '<span class="chip">no bid yet</span>';
            const act = s.held ? '<a class="have" href="#" data-tab="portfolio">' + TICK + "Held</a>" : v.url ? '<a class="buy" href="' + esc(v.url) + '" target="_blank" rel="noopener">Buy on ' + esc(VN) + OUT + "</a>" : "";
            return '<div class="side' + (s.held ? " held" : "") + '"><span class="mk">' + markHtml(s.side, "sm") + (s.home === true ? '<i title="home">H</i>' : s.home === false ? '<i title="away">A</i>' : "") + '</span><div class="sn">' + esc(s.side) + "<small>" + (s.opponent ? (s.home === false ? "at " : "vs ") + esc(s.opponent) : "") + '</small></div><div class="px">' + px + "</div>" + act + "</div>";
          }).join("") + "</div>";
        if (setHtml(gel, html)) gel.querySelectorAll("[data-tab]").forEach((a) => { a.onclick = (e) => { e.preventDefault(); showTab("portfolio"); }; });
      });
    });
    if (setHtml(document.getElementById("gmore"), hidden ? '<button type="button" class="more" id="gmore-b">Show ' + hidden + " more " + (hidden === 1 ? "game" : "games") + " on later days</button>" : "")) { const b = document.getElementById("gmore-b"); if (b) b.onclick = () => { S.gAll = true; syncGames(); }; }
    setHtml(document.getElementById("g-at"), G.readAt ? esc(VN) + " updated " + esc(ago(Date.parse(G.readAt))) : "");
  };

  // ---- the history ----
  const histWords = (r) => {
    const nick = nickOf(r.side);
    if (r.status === "settled") { const won = r.result === "yes" || r.result === "win"; return ["Settled", nick + (won ? " won · " : " lost · ") + "<b>" + usd(won ? (r.capTotalCents || r.protectedCents || 0) : (r.floorTotalCents || r.protectedCents || 0)) + "</b> all in", won ? "on" : "off"]; }
    if (r.status === "closed") { const bb = r.memberBuyBack; return ["Left early", "net <b>" + signed(r.closeNetCents || 0) + "</b>" + (bb ? " · bought back " + bb.boughtContracts + " at " + cents(bb.avgPriceCents) : ""), "off"]; }
    if (r.status === "void") return ["Void", "the game was called off; the sale stands, the riding contracts were settled by " + VN, "off"];
    return ["Protected", "<b>" + usd(r.floorTotalCents || 0) + "</b> or <b>" + usd(r.capTotalCents || 0) + "</b>", "on"];
  };
  const histKey = (r) => "h:" + r.ticker + ":" + r.at;
  const historyScaffold = () => { main.innerHTML = "<h1>History</h1>" + '<div id="hlist" class="rows"></div><div id="hempty"></div>'; };
  const syncHistory = () => {
    if (S.screen !== "history") return;
    const hlist = document.getElementById("hlist");
    if (!S.history) { setHtml(document.getElementById("hempty"), skeleton(2)); return; }
    const past = S.history.filter((r) => r.status !== "open");
    setHtml(document.getElementById("hempty"), past.length ? "" : '<div class="empty">No past locks yet.<br>Settled and closed locks live here with their receipts; open ones are on Portfolio.</div>');
    syncList(hlist, past, histKey, "hist", (el, r) => {
      const st = stateOf(histKey(r));
      const w = histWords(r);
      const ms = r.memberSale || {};
      const chips = [];
      if (ms.soldContracts != null) chips.push('<span class="chip sold"><b>' + ms.soldContracts + "</b> of " + (ms.soldContracts + ms.keptContracts) + " sold</span>");
      if (r.tier) chips.push('<span class="chip">' + esc(TIER_WORDS[r.tier] || r.tier) + "</span>");
      chips.push('<span class="chip">locked ' + esc(fmtDay(r.at)) + "</span>");
      const html = '<div class="pos-h">' + markHtml(r.side) + '<div class="pos-t"><div class="name">' + esc(r.side) + '<small>to win</small></div><div class="evt"><b>' + esc(opponentWords(r.side, r.event)) + "</b>" + (r.eventTimeIso ? " · " + esc(fmtAt(r.eventTimeIso)) : "") + "</div></div></div>" +
        '<div class="chips">' + chips.join("") + "</div>" +
        '<div class="ael-row"><div class="ael-box">' + lineHtml(w[2], w[0], w[1], st.open, w[2] === "off" ? "hist" : "") + (st.open ? '<div class="ael-panel ael-on">' + detailsHtml({ contracts: r.contracts }, st, true, r) + '<div class="ael-meta">Locked ' + esc(fmtAt(r.at)) + (r.closedAt ? " · left " + esc(fmtAt(r.closedAt)) : r.settledAt ? " · settled " + esc(fmtAt(r.settledAt)) : "") + "</div>" + DISCLOSE + "</div>" : "") + "</div></div>";
      if (setHtml(el, html)) {
        const line = el.querySelector(".ael-line");
        if (line) line.onclick = () => { st.open = !st.open; syncHistory(); };
        el.querySelectorAll("[data-tg]").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); st[b.getAttribute("data-tg")] = !st[b.getAttribute("data-tg")]; syncHistory(); }; });
      }
    });
  };

  // ---- the frame ----
  let acctKey = null;
  const paintAcct = () => {
    const m = S.member || {};
    const key = [Boolean(m.connected), m.handle || "", m.avatarUrl || ""].join("|");
    if (key === acctKey) return;
    acctKey = key;
    const back = CFG.venueUrl ? '<a class="back" href="' + esc(CFG.venueUrl) + '" rel="noopener"><span><span class="l">Back to </span>' + esc(VN) + "</span>" + OUT + "</a>" : "";
    acct.innerHTML = (m.connected ? '<span class="who">' + (m.avatarUrl ? '<img src="' + esc(m.avatarUrl) + '" alt="">' : "") + (m.handle ? "<b>@" + esc(m.handle) + "</b>" : '<b>' + esc(VN) + " connected</b>") + '</span><button type="button" class="lnk" id="disconnect">Disconnect</button>' : "") + back;
    const d = document.getElementById("disconnect"); if (d) d.onclick = (e) => { e.preventDefault(); void disconnect(); };
    const df = document.getElementById("disconnect-foot"); if (df) { df.hidden = !m.connected; const b = document.getElementById("disconnect-foot-btn"); if (b) b.onclick = () => void disconnect(); }
  };
  const tabsHtml = () => {
    const live = S.positions.filter((p) => p.ticker && p.lock && p.lock.status !== "closed").length;
    const past = S.history ? S.history.filter((r) => r.status !== "open").length : 0;
    const games = S.games ? new Set((S.games.games || []).map(gameKey)).size : 0;
    return [["portfolio", "Portfolio", live], ["games", "Games", games], ["history", "History", past]].map(([k, w, n]) => '<button type="button" role="tab" data-tab="' + k + '" aria-selected="' + (S.tab === k) + '">' + w + (n ? '<span class="n">' + n + "</span>" : "") + "</button>").join("");
  };
  const paintTabs = () => { if (setHtml(tabs, tabsHtml())) tabs.querySelectorAll("[data-tab]").forEach((b) => { b.onclick = () => showTab(b.getAttribute("data-tab")); }); };
  const screenOf = () => {
    if (!CFG.configured) return "off";
    const m = S.member;
    if (!m) return "checking";
    if (!m.connected) return "connect";
    if (S.connecting) return "connecting";
    return S.tab;
  };
  const render = () => {
    paintAcct();
    const screen = screenOf();
    const connected = S.member && S.member.connected && !S.connecting;
    tabs.hidden = !connected;
    if (connected) paintTabs();
    if (screen !== S.screen) {
      S.screen = screen;
      if (screen === "off") main.innerHTML = '<div class="connect"><h2>Not set up</h2><p>This service is not set up for ' + esc(VN) + " accounts.</p></div>";
      else if (screen === "checking") main.innerHTML = skeleton(2);
      else if (screen === "connect") { main.innerHTML = connectHtml(S.flashErr); S.flashErr = null; const c = document.getElementById("connect"); if (c) c.onclick = () => void connect(); }
      else if (screen === "connecting") main.innerHTML = connectingHtml(false);
      else if (screen === "portfolio") portfolioScaffold();
      else if (screen === "games") gamesScaffold();
      else if (screen === "history") historyScaffold();
    }
    if (screen === "portfolio") syncPortfolio();
    else if (screen === "games") syncGames();
    else if (screen === "history") syncHistory();
  };
  const showTab = (t) => {
    S.tab = t;
    try { history.replaceState(null, "", location.pathname + (t === "portfolio" ? "" : "#" + t)); } catch (e) {}
    render();
    if (t === "games" && !S.games) void loadGames();
    if (t === "history" && !S.history) void loadHistory();
    window.scrollTo({ top: 0 });
  };
  const loadMember = async () => {
    const r = await api("/api/shadow/member");
    if (r.ok && r.json && r.json.member) S.member = r.json.member;
    else if (r.ok && r.status === 404) S.member = { configured: false, connected: false, reason: "member_app_off" };
    else S.member = { configured: true, connected: false, reason: "unreachable" };
  };
  const loadAccount = async (fresh) => {
    if (!(S.member && S.member.connected)) return;
    const r = await api("/api/shadow/member/account" + (fresh ? "?fresh=1" : ""));
    if (r.ok && r.json && r.json.ok) { S.account = r.json; S.acctAt = Date.now(); if (r.json.member) S.member = r.json.member; paintAcct(); }
    else if (r.ok && r.json && r.json.member) { S.member = r.json.member; paintAcct(); }
  };
  const loadPositions = async (fresh) => {
    if (!(S.member && S.member.connected)) return;
    const r = await api("/api/shadow/positions" + (fresh ? "?fresh=1" : ""));
    if (r.ok && r.json && r.json.member) S.member = r.json.member;
    if (r.ok && r.json && r.json.ok) {
      if (r.json.cutoffMinutes) S.cutoff = r.json.cutoffMinutes;
      S.inPlay = !!r.json.inPlay;
      const rows = (r.json.positions || []).filter((p) => p.venue === "stx");
      const before = new Map(S.positions.map((p) => [posKey(p), p]));
      S.positions = rows.map((p) => { const key = posKey(p); const prev = before.get(key); const st = stateOf(key); const was = prev && prev.lock && prev.lock.status !== "closed"; const is = p.lock && p.lock.status !== "closed"; if (was && !is && !st.closedNow) { st.quote = null; st.quoteAt = 0; } if (is && st.closedNow) st.closedNow = null; return p; });
      S.posAt = Date.now(); S.posErr = null;
    } else if (r.ok && r.json && r.json.error === "venue_read_failed") S.posErr = VN + " could not be read: " + (r.json.message || "");
    else if (!r.ok) S.posErr = "The service could not be reached.";
    if (S.connecting) { S.connecting = false; main.innerHTML = connectingHtml(true); S.screen = "connecting-done"; await new Promise((res) => setTimeout(res, 900)); }
    render();
  };
  const loadGames = async () => {
    const r = await api("/api/shadow/member/games");
    if (r.ok && r.json && r.json.ok) { S.games = r.json; S.gamesErr = null; }
    else S.gamesErr = r.ok ? words(r.json, VN + " could not be read.") : "The service could not be reached.";
    render();
  };
  const loadHistory = async () => {
    const r = await api("/api/shadow/member/history");
    if (r.ok && r.json && r.json.ok) S.history = r.json.records || [];
    render();
  };
  const refreshAll = async (fresh) => {
    if (!(S.member && S.member.connected)) { await loadMember(); render(); if (!(S.member && S.member.connected)) return; }
    await Promise.all([loadAccount(fresh), loadPositions(fresh), S.games ? loadGames() : Promise.resolve(), S.history ? loadHistory() : Promise.resolve()]);
    render();
  };

  // ---- pull to refresh (a phone, at the top) ----
  const ptr = document.getElementById("ptr");
  (() => {
    let y0 = null, pulling = false;
    const T = 72;
    document.addEventListener("touchstart", (e) => { if (window.scrollY <= 0 && e.touches.length === 1) { y0 = e.touches[0].clientY; pulling = false; } else y0 = null; }, { passive: true });
    document.addEventListener("touchmove", (e) => {
      if (y0 === null) return;
      const dy = e.touches[0].clientY - y0;
      if (dy > 12 && window.scrollY <= 0) { pulling = true; ptr.classList.add("ptr-on"); ptr.classList.toggle("ptr-ready", dy > T); ptr.querySelector(".ptr-t").textContent = dy > T ? "Release to refresh" : "Pull to refresh"; }
    }, { passive: true });
    document.addEventListener("touchend", async () => {
      if (y0 === null) return;
      const ready = ptr.classList.contains("ptr-ready");
      y0 = null;
      if (!pulling) return;
      if (!ready) { ptr.classList.remove("ptr-on", "ptr-ready"); return; }
      ptr.classList.add("ptr-busy"); ptr.querySelector(".ptr-t").textContent = "Refreshing…";
      await refreshAll(true);
      ptr.classList.remove("ptr-on", "ptr-ready", "ptr-busy");
    }, { passive: true });
  })();

  const start = async () => {
    const q = new URLSearchParams(location.search);
    if (q.get("connected") === "1") S.connecting = true;
    if (q.get("error")) S.flashErr = q.get("error");
    if (q.has("connected") || q.has("error") || q.has("source")) history.replaceState(null, "", location.pathname + location.hash);
    if (location.hash === "#games" || location.hash === "#history") S.tab = location.hash.slice(1);
    try { S.hsTip = phone() && !standalone() && !localStorage.getItem(HS_KEY); } catch (e) { S.hsTip = false; }
    await loadMember();
    if (S.connecting && !(S.member && S.member.connected)) S.connecting = false;
    render();
    await Promise.all([loadAccount(false), loadPositions(false)]);
    void loadHistory();
    void loadGames();
    setInterval(() => void loadPositions(false), POLL_POS_MS);
    setInterval(() => void loadAccount(false).then(paintBalance), POLL_ACCT_MS);
    setInterval(() => { if (S.screen === "portfolio") S.positions.forEach((p) => { const st = stateOf(posKey(p)); if (p.ticker && !(p.lock && p.lock.status !== "closed") && !st.busy && !st.open && !timing(p)) void quoteFor(p, false); }); }, 5000);
    // the relative stamps, without repainting anything else
    setInterval(() => { stampBalance(); const b = document.getElementById("pos-at"); if (b && S.posAt) b.textContent = "Positions updated " + ago(S.posAt); const g = document.getElementById("g-at"); if (g && S.games && S.games.readAt) g.textContent = VN + " updated " + ago(Date.parse(S.games.readAt)); }, 10000);
    // back from the venue (a buy, a look at the balance) or from the home screen: read again at once
    let last = Date.now();
    const back = () => { if (document.visibilityState === "visible" && Date.now() - last > 2500) { last = Date.now(); void refreshAll(true); } };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    window.addEventListener("pageshow", (e) => { if (e.persisted) back(); });
  };
  // how it works: one sheet; the foot and the empty portfolio open it; ×, the backdrop or Esc close it
  const how = document.getElementById("how");
  let howFrom = null;
  const openHow = () => { if (!how) return; howFrom = document.activeElement; how.hidden = false; document.body.style.overflow = "hidden"; const x = how.querySelector(".x"); if (x) x.focus(); };
  const closeHow = () => { if (!how || how.hidden) return; how.hidden = true; document.body.style.overflow = ""; if (howFrom && howFrom.focus) howFrom.focus(); howFrom = null; };
  if (how) {
    how.addEventListener("click", (e) => { if (e.target === how || e.target.closest(".x")) closeHow(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeHow(); });
  }
  const aboutTg = document.getElementById("about-tg");
  if (aboutTg) aboutTg.onclick = openHow;
  void start();
})();
`;
