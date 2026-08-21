/**
 * EARN & PROTECT — public pages (Phase 3): the live-book dashboard and the ToS page.
 *
 * The dashboard is read-only AGGREGATES ONLY (wraps, notional, credits paid, capacity) — never a
 * wallet address, never a per-user number. It exists so partners and investors can watch the book
 * breathe without an account.
 *
 * The ToS page is a clearly-marked DRAFT skeleton: counsel owns the words; the version string is
 * injected by the service (EP_TOS_VERSION) and acceptance is recorded per wallet per version.
 */

export const EP_PUBLIC_DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atticus — Live Book</title>
<style>
  :root{--bg:#0b0f14;--panel:#111722;--line:#1f2937;--text:#e8edf4;--muted:#8b98a9;--accent:#d9ab01;--radius:14px}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,sans-serif}
  .wrap{max-width:860px;margin:0 auto;padding:0 20px 60px}
  nav{border-bottom:1px solid var(--line)}
  .nav-in{max-width:860px;margin:0 auto;padding:0 20px;display:flex;align-items:center;justify-content:space-between;height:58px}
  .logo{font-weight:800;letter-spacing:2.5px;font-size:15px}.logo b{color:var(--accent)}
  .kicker{color:var(--accent);font-weight:700;font-size:11.5px;letter-spacing:2px;text-transform:uppercase}
  h1{font-size:24px;font-weight:800;margin:30px 0 6px}
  .sub{color:var(--muted);font-size:14px;margin-bottom:24px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px}
  .card .k{color:var(--muted);font-size:12px;letter-spacing:.5px;text-transform:uppercase}
  .card .v{font-size:26px;font-weight:800;margin-top:6px}
  .card .s{color:var(--muted);font-size:12px;margin-top:4px}
  .accent{color:var(--accent)}
  .foot{color:var(--muted);font-size:11.5px;margin-top:34px;border-top:1px solid var(--line);padding-top:16px}
</style>
</head>
<body>
<nav><div class="nav-in">
  <div class="logo">ATTICUS <b>·</b> <span class="kicker">Live Book</span></div>
  <div class="kicker" id="mode"></div>
</div></nav>
<div class="wrap">
  <h1>Earn &amp; Protect — live book</h1>
  <p class="sub">Read-only aggregates, refreshed every few seconds. No per-user data is ever shown here.</p>
  <div class="grid" id="cards"></div>
  <div class="foot">Every wrap is a real credit collar on listed BTC options; every credit is auditable to an exchange fill. Refusals are honest — when the market can't fund a credit, nothing opens. Nothing on this page is investment advice.</div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const fmt$ = (x) => "$" + Number(x ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
const card = (k, v, s) => '<div class="card"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="s">' + (s || "") + '</div></div>';
const poll = async () => {
  try {
    const st = await (await fetch("/api/stats")).json();
    if (!st.ok) return;
    $("mode").textContent = st.executionMode === "okx_live" ? "LIVE" : st.executionMode.toUpperCase();
    $("cards").innerHTML =
      card("Credits paid", '<span class="accent">' + fmt$(st.credits.paidUsdc) + '</span>', st.credits.paidCount + " payouts, paid daily") +
      card("Active wraps", st.wraps.active, fmt$(st.notional.openUsdc) + " protected right now") +
      card("Lifetime wrapped", fmt$(st.notional.lifetimeWrappedUsdc), st.wraps.total + " wraps priced") +
      card("Cycles concluded", st.wraps.expiries + st.wraps.knockouts + st.wraps.earlyCloses,
           st.wraps.expiries + " expiries · " + st.wraps.knockouts + " cap touches · " + st.wraps.earlyCloses + " early closes") +
      card("Book utilization", st.capacity.utilizationPct + "%", "of " + fmt$(st.capacity.bookCapUsdc) + " capacity") +
      card("Founding cohort", st.capacity.walletsJoined + " / " + st.capacity.foundingWallets,
           (st.capacity.waitlistLength ? st.capacity.waitlistLength + " on the waitlist — " : "") + "capacity grows with capital");
  } catch (e) { /* keep last render */ }
};
poll(); setInterval(poll, 5000);
</script>
</body>
</html>`;

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
  <p>Earn &amp; Protect reads your exchange position (read-only — you never sign, deposit, or share keys) and, while your toggle is on, hedges it with listed options. You receive the published share of the credit the options market funds, paid to your wallet at each daily cycle's conclusion.</p>
  <h2>What you accept</h2>
  <ul>
    <li>Protection terms are quoted from live order books and refused when the market cannot fund them.</li>
    <li>Credits vest through each cycle and pay at its conclusion (expiry, cap touch, or early close) — never upfront.</li>
    <li>If the market touches your cap, that protection cycle ends; you keep your position, gains to the cap, and the vested credit; protection re-arms while the toggle stays on.</li>
    <li>We keep a published share of the credit we source (waived when tiny). You never owe us anything.</li>
    <li>Payouts go only to the wallet address that owns the protected position.</li>
    <li>The service is unavailable in the United States and sanctioned jurisdictions.</li>
    <li>Derivatives involve risk; nothing here is investment advice.</li>
  </ul>
  <h2>Counsel to complete</h2>
  <p>Jurisdiction, arbitration, liability limits, privacy/data handling, prohibited-use, and eligibility representations.</p>
</div></body>
</html>`;
