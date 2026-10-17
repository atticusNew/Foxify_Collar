/**
 * EARN & PROTECT — public pages (Phase 3): the ToS page.
 *
 * The public live-book dashboard (/public) that used to live here was retired with the wallet-
 * collection demo: the embedded retail product has no book page, and the operator aggregates it
 * showed (capacity, execution mode, cohort fill) are admin information (GET /api/admin/status).
 *
 * The ToS page is a clearly-marked DRAFT skeleton: counsel owns the words; the version string is
 * injected by the service (EP_TOS_VERSION) and acceptance is recorded per wallet per version.
 */

export const EP_TOS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atticus — Terms of Service (__TOS_VERSION__)</title>
<style>
  :root{--bg:#0b0f14;--panel:#111722;--line:#1f2937;--text:#e8edf4;--muted:#8b98a9;--accent:#d9ab01}
  body{background:var(--bg);color:var(--text);font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,sans-serif;margin:0}
  .wrap{max-width:720px;margin:0 auto;padding:40px 20px 60px}
  h1{font-size:24px;font-weight:800} h2{font-size:16px;margin:24px 0 6px}
  p,li{color:var(--muted);font-size:14px} ul{padding-left:20px}
  .draft{background:rgba(217,171,1,.12);border:1px solid rgba(217,171,1,.4);color:var(--accent);border-radius:10px;padding:10px 14px;font-weight:700;font-size:13px;margin:16px 0}
  .v{color:var(--muted);font-size:12px}
</style>
</head>
<body><div class="wrap">
  <h1>Earn &amp; Protect — Terms of Service</h1>
  <div class="v">Version __TOS_VERSION__</div>
  <div class="draft">DRAFT — placeholder pending legal counsel. Acceptance is recorded per wallet per version; publishing a new version requires re-acceptance before any new protection cycle opens.</div>
  <h2>What the service does</h2>
  <p>Earn &amp; Protect reads your exchange position (read-only — you never sign, deposit, or share keys) and, while your toggle is on, hedges it with listed options: a hard floor is bought and a cap above it is sold, and the difference is your credit. You receive the published share of that credit, paid to your wallet at each cycle's conclusion.</p>
  <h2>What you accept</h2>
  <ul>
    <li>Protection terms are quoted from live order books and refused when the market cannot fund them.</li>
    <li>Credits vest through each cycle and pay at its conclusion (expiry or early close) — never upfront.</li>
    <li>The cap is the price of the floor: gains above the cap during a cycle are handed back at its conclusion, netted against your credit. If they exceed your credit the difference is a balance owed, and no new protection opens for that position until it is settled.</li>
    <li>You may release the cap at any time — including when the market touches it — by buying the cap leg back at the live listed price shown in the app. After a release every gain is yours; the floor stays.</li>
    <li>We keep a published share of the credit we source (waived when tiny). Our hedge is held leg for leg; we take no view on your position.</li>
    <li>Payouts go only to the wallet address that owns the protected position.</li>
    <li>The service is unavailable in the United States and sanctioned jurisdictions.</li>
    <li>Derivatives involve risk; nothing here is investment advice.</li>
  </ul>
  <h2>Counsel to complete</h2>
  <p>Jurisdiction, arbitration, liability limits, privacy/data handling, prohibited-use, and eligibility representations.</p>
</div></body>
</html>`;
