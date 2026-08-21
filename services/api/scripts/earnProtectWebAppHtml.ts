/**
 * EARN & PROTECT — trader web app (Track 1 canonical surface).
 *
 * Deliberately thin: a positions page and a toggle, not a platform. Served by the demo service at
 * GET /app and consuming ONLY the public JSON API (the same routes a partner integration would
 * use — that is the point).
 *
 * BRANDING (white-label by design): Atticus is the engine behind the exchange, so this surface
 * dresses like the VENUE, not like us — today that means Hyperliquid's dark teal/mint look so the
 * page reads as an extension of the HL UI, with one subtle "Earn & Protect · by Atticus" mark.
 * Every brand decision lives in the :root CSS tokens below; skinning this for another exchange is
 * a variable swap, nothing more.
 *
 * Product rules enforced in this UI:
 *   - read-only wallet connect: paste an address; no signing, no deposits, no keys
 *   - ONE-NUMBER RULE: after a fill, the realized credit is the only unlabeled number
 *   - honest refusal copy (human line; full engine string on hover) — port of the extension chip
 *   - partial coverage stated plainly; payout history links to the tx
 *
 * TWO VARIANTS from one template (buildEpAppHtml):
 *   web      — the standalone page at /app
 *   miniapp  — the Telegram Mini App at /miniapp: telegram-web-app.js, ready()/expand(), haptic
 *              feedback on actions, account handed off by the bot via ?account=… (falls back to
 *              the paste flow — localStorage persists inside Telegram's WebView), compact layout.
 */

export const buildEpAppHtml = (variant: "web" | "miniapp"): string => {
  const miniapp = variant === "miniapp";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${miniapp ? "Earn & Protect" : "Atticus — Earn & Protect"}</title>
${miniapp ? '<script src="https://telegram.org/js/telegram-web-app.js"></script>' : ""}
<style>
  /* ── VENUE THEME TOKENS ──────────────────────────────────────────────────
     Skinned to feel native inside Hyperliquid (dark teal surfaces, mint
     accent, HL long/short green/red). White-labeling for another exchange =
     swap these values. The only Atticus mark is the subtle "by Atticus" tag. */
  :root{
    --bg:#0b1d23;           /* HL app background: deep blue-teal            */
    --panel:#0f2a31;        /* card surface                                  */
    --panel2:#0c232a;       /* inset surface                                 */
    --line:#1c3b43;         /* hairlines                                     */
    --text:#f1f6f4;--muted:#8fa6a3;
    --accent:#50d2c1;       /* HL mint — actions, highlights                 */
    --accent-ink:#04211d;   /* text on mint                                  */
    --good:#2ebd85;         /* HL long green                                 */
    --bad:#ed7088;          /* HL short red                                  */
    --radius:8px            /* HL uses tighter corners than our site         */
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font:14.5px/1.55 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:760px;margin:0 auto;padding:0 20px 60px}
  nav{position:sticky;top:0;z-index:10;background:rgba(11,29,35,.9);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
  .nav-in{max-width:760px;margin:0 auto;padding:0 20px;display:flex;align-items:center;justify-content:space-between;height:54px}
  .logo{font-weight:700;font-size:15px;letter-spacing:.2px}
  .logo .by{color:var(--muted);font-weight:500;font-size:11.5px;letter-spacing:.6px;margin-left:8px}
  .logo .by b{color:var(--accent);font-weight:600}
  .pill{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:4px 12px}
  h1{font-size:24px;font-weight:700;letter-spacing:-.2px;margin:28px 0 6px}
  .sub{color:var(--muted);font-size:14px;margin-bottom:22px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;margin-bottom:12px}
  .row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
  input[type=text]{flex:1;min-width:240px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;color:var(--text);padding:10px 13px;font:inherit;font-size:13.5px}
  input[type=text]:focus{outline:none;border-color:var(--accent)}
  .btn{background:var(--accent);color:var(--accent-ink);font-weight:700;padding:9px 17px;border-radius:6px;font-size:13.5px;border:0;cursor:pointer}
  .btn:hover{filter:brightness(1.08)} .btn.ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}
  .muted{color:var(--muted)} .small{font-size:12.5px} a{color:var(--accent);text-decoration:none}
  .pos-head{font-weight:700;font-size:14.5px} .pos-head small{color:var(--muted);font-weight:400}
  .pos-head .long{color:var(--good)} .pos-head .short{color:var(--bad)}
  .switch{width:44px;height:24px;border-radius:999px;background:#1e3d45;position:relative;cursor:pointer;transition:background .15s ease-out;flex:none}
  .switch .knob{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#8fa6a3;transition:left .15s cubic-bezier(.3,1.4,.6,1),background .15s ease-out}
  .switch.on{background:var(--accent)} .switch.on .knob{left:23px;background:var(--accent-ink)}
  .switch.busy{pointer-events:none}
  .switch.busy .knob{animation:pulse 1s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
  .spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(80,210,193,.25);border-top-color:var(--accent);border-radius:50%;margin-right:7px;vertical-align:-1.5px;animation:spinr .7s linear infinite}
  @keyframes spinr{to{transform:rotate(360deg)}}
  .chip{margin-top:12px;border-radius:6px;padding:10px 12px;font-size:13px;background:var(--panel2);border:1px solid var(--line);color:var(--muted);transition:all .3s}
  .chip.on{border-color:rgba(80,210,193,.45);color:var(--text)} .chip.bad{border-color:rgba(237,112,136,.45)} .chip b{color:var(--accent)}
  .terms{margin-top:10px;display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:12px;color:var(--muted)}
  .term{background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:8px 10px}
  .term b{display:block;color:var(--text);font-size:13px}
  .term b em{font-style:normal;color:var(--muted);font-size:11px;font-weight:500;margin-left:4px}
  .bar{background:#132e35;border:1px solid var(--line);border-radius:999px;height:10px;overflow:hidden;margin-top:10px}
  .bar>div{background:linear-gradient(90deg,#1b7f74,var(--accent));height:100%;width:0;min-width:7px;border-radius:999px;transition:width .8s;box-shadow:0 0 6px rgba(80,210,193,.5)}
  .unlock{margin-top:6px;font-size:12px;color:var(--muted)}
  .trust{margin-top:10px;font-size:11.5px;color:var(--muted)}
  .flash{display:none;background:var(--panel);border:1px solid rgba(80,210,193,.45);border-radius:6px;padding:10px 13px;font-size:13px;margin-bottom:12px}
  .flash.bad{border-color:rgba(237,112,136,.45)}
  /* Tap/hover tooltips (mobile-safe — no title attributes) */
  .tipwrap{position:relative;cursor:help}
  .tipwrap .tip{display:none;position:absolute;bottom:135%;left:50%;transform:translateX(-50%);width:240px;background:#081418;border:1px solid var(--line);border-radius:8px;padding:9px 11px;font-size:12px;font-weight:400;color:var(--text);line-height:1.5;z-index:30;box-shadow:0 10px 28px rgba(0,0,0,.55);text-align:left;text-transform:none;letter-spacing:0;white-space:normal}
  .tipwrap.tip-right .tip{left:auto;right:0;transform:none}
  .tipwrap:hover .tip,.tipwrap.open .tip{display:block}
  .info{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;border:1px solid rgba(80,210,193,.55);color:var(--accent);font-size:9.5px;margin-left:5px;vertical-align:1px}
  /* The Atticus lockup: title-case serif in Atticus gold, finch mark sized to the text (matches
     the brand asset: "Atticus" + finch outline, both #d9ab01). */
  .atticus-serif{font-family:"Times New Roman",Times,serif;font-weight:400;font-size:14px;letter-spacing:.2px;color:#d9ab01}
  .brand-img{height:13px;margin-left:5px;vertical-align:-1.5px}
  .brand-lockup{height:17px;margin-left:2px;vertical-align:-4px}
  /* Hedge receipt: the proof the protection is real — a quiet chip that reads as actionable */
  details.receipt{margin-top:10px}
  details.receipt summary{cursor:pointer;font-size:12px;color:var(--muted);list-style:none;display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:6px;padding:5px 11px;transition:border-color .15s,color .15s}
  details.receipt summary:hover,details.receipt[open] summary{border-color:rgba(80,210,193,.5);color:var(--text)}
  details.receipt summary::-webkit-details-marker{display:none}
  details.receipt summary:before{content:"▸";color:var(--accent);font-size:10px;transition:transform .15s}
  details.receipt[open] summary:before{transform:rotate(90deg)}
  /* How-it-works modal (keeps the page clean; the honest print is one tap away) */
  .modal-veil{display:none;position:fixed;inset:0;background:rgba(4,14,17,.7);backdrop-filter:blur(3px);z-index:50}
  .modal-veil.open{display:flex;align-items:center;justify-content:center;padding:18px}
  .modal{background:var(--panel);border:1px solid var(--line);border-radius:12px;max-width:460px;width:100%;padding:20px 22px;max-height:80vh;overflow-y:auto}
  .modal h3{font-size:15px;margin-bottom:12px}
  .modal ul{list-style:none;margin:0;padding:0}
  .modal li{padding:7px 0 7px 22px;position:relative;color:var(--muted);font-size:13px;line-height:1.5}
  .modal li:before{content:"";position:absolute;left:2px;top:13px;width:6px;height:6px;border-radius:2px;background:var(--accent)}
  .modal li b{color:var(--text)}
  .modal .btn{margin-top:14px}
  .receipt-tbl{width:100%;border-collapse:collapse;margin-top:8px;font-size:12px}
  .receipt-tbl td,.receipt-tbl th{padding:5px 6px;border-bottom:1px solid var(--line);text-align:left}
  .receipt-tbl th{color:var(--muted);font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px}
  .receipt-tbl code{font-size:11px;color:var(--text)}
  .tag-real{color:var(--good);font-weight:700;font-size:10.5px} .tag-sim{color:#e3c34c;font-weight:700;font-size:10.5px}
  /* Narrow screens (Telegram WebView, phones): stack the header, keep cards breathing */
  @media (max-width:560px){
    .nav-in{height:auto;min-height:48px;padding:8px 14px;flex-wrap:wrap;gap:6px}
    .logo{font-size:13.5px} .logo .by{font-size:10.5px;margin-left:5px}
    .pill{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;padding:3px 9px}
    .mode-pill{font-size:10px;padding:3px 8px;margin-right:5px}
    .wrap{padding:0 12px 44px}
    h1{font-size:20px} .sub{font-size:13px}
    .card{padding:13px 14px}
    .terms{grid-template-columns:1fr 1fr;gap:6px}
    .terms .term:first-child{grid-column:1 / -1}
    th,td{padding:6px 4px;font-size:12px}
  }
  .mode-pill{font-size:11px;font-weight:700;letter-spacing:.6px;border-radius:999px;padding:3.5px 11px;margin-right:8px}
  .mode-paper{background:rgba(217,171,1,.14);color:#e3c34c;border:1px solid rgba(217,171,1,.4)}
  .mode-demo{background:rgba(80,210,193,.1);color:var(--accent);border:1px solid rgba(80,210,193,.35)}
  .mode-live{background:rgba(46,189,133,.12);color:var(--good);border:1px solid rgba(46,189,133,.4)}
  .coverage{margin-top:10px;font-size:12.5px;color:var(--accent)}
  table{width:100%;border-collapse:collapse;margin-top:6px;font-size:13px}
  th,td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line)} th{color:var(--muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px}
  .status-paid{color:var(--good);font-weight:600} .status-accrued{color:var(--accent)} .status-failed{color:var(--bad)}
  h2{font-size:14px;font-weight:700;margin:24px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
  .foot{color:var(--muted);font-size:11.5px;margin-top:32px;border-top:1px solid var(--line);padding-top:16px}
  .badge{display:inline-block;font-size:10.5px;font-weight:700;border-radius:999px;padding:2.5px 9px;margin-left:8px;vertical-align:2px}
  .badge.founding{background:rgba(80,210,193,.12);color:var(--accent);border:1px solid rgba(80,210,193,.4)}
  .empty{color:var(--muted);font-size:13.5px;padding:6px 0}
</style>
</head>
<body>
<nav><div class="nav-in">
  <!-- Venue affiliation is DESCRIPTIVE ("for Hyperliquid" — where your positions live), not a
       partnership claim; swap the venue name per integration. The brand mark after "by" is
       injected by the service: the Atticus logo (EP_BRAND_LOGO_URL) or the wordmark fallback. -->
  <div class="logo">Earn &amp; Protect <span class="by">for <b>HYPERLIQUID</b> · by __BRAND_MARK__</span></div>
  <div style="display:flex;align-items:center">
    <span class="mode-pill tipwrap" id="modePill" style="display:none"></span>
    <div class="pill" id="connPill">not connected</div>
  </div>
</div></nav>
<div class="wrap">
  <header id="hero">
    <h1>One toggle. A hard floor. And it pays.</h1>
    <p class="sub">Paste your Hyperliquid address — read-only. Flip protection on; the options market pays you a daily credit.${""/* the no-keys detail lives on the input tooltip */}</p>
  </header>

  <div class="card" id="geoBanner" style="display:none;border-color:rgba(237,112,136,.45)">
    <b>Not available in your region.</b> <span class="muted small" id="geoMsg"></span>
  </div>

  <div class="card" id="connectCard">
    <div class="row">
      <input type="text" id="addrInput" placeholder="0x… your Hyperliquid address (read-only)" title="We only read positions from Hyperliquid's public API — no signing, no deposits, no keys. Payouts go only to this address." spellcheck="false">
      <button class="btn" id="connectBtn">View positions</button>
      <button class="btn ghost" id="forgetBtn" style="display:none">Forget</button>
    </div>
    <div class="small muted" id="connectMsg" style="margin-top:8px"></div>
  </div>

  <div class="card" id="verifyCard" style="display:none;border-color:rgba(80,210,193,.45)">
    <b>Verify your wallet</b> <span class="muted small">— one signature proves you own this address and signs the <a href="/tos" target="_blank" rel="noopener">Terms</a>. It cannot move funds. Needed once; then every surface (including Telegram) works.</span>
    <div class="row" style="margin-top:10px">
      <button class="btn" id="verifyBtn">Verify with wallet</button>
      <span class="small muted" id="verifyMsg"></span>
    </div>
  </div>

  <div class="flash" id="flash"></div>

  <div class="card" id="tosCard" style="display:none;border-color:rgba(80,210,193,.45)">
    <b>One step before protection:</b> <span class="muted small">accept the <a href="/tos" target="_blank" rel="noopener">Terms of Service</a> (<span id="tosVer"></span>). Recorded once per wallet per version.</span>
    <div class="row" style="margin-top:10px">
      <label class="small muted" style="flex:1;min-width:240px"><input type="checkbox" id="tosCheck"> I have read and accept the Terms of Service.</label>
      <button class="btn" id="tosBtn" disabled>Accept &amp; continue</button>
    </div>
  </div>

  <h2>Your positions <span class="small muted" id="cohortLine" style="text-transform:none;letter-spacing:0;font-weight:400"></span></h2>
  <div id="positions"><div class="empty">Connect an address to see your open positions.</div></div>

  <h2>Payouts</h2>
  <div class="card" style="padding-top:10px">
    <table><thead><tr><th>when</th><th>cycle</th><th>credit</th><th>status</th><th>tx</th></tr></thead>
    <tbody id="payouts"><tr><td colspan="5" class="empty">No payouts yet — credits land here at each cycle's conclusion.</td></tr></tbody></table>
  </div>

  <div class="foot">
    Priced live from listed markets · refused honestly when unfundable · <a href="#" id="howLink">How it works</a> · <a href="/tos" target="_blank" rel="noopener">Terms</a>
  </div>
</div>

<div class="modal-veil" id="howVeil"><div class="modal">
  <h3>How Earn &amp; Protect works</h3>
  <ul>
    <li><b>Read-only.</b> We read your positions from Hyperliquid's public API — no signing, no deposits, no keys. Payouts go only to your own wallet.</li>
    <li><b>Live-market pricing.</b> Every protection cycle is quoted from listed option order books at the moment you toggle. When the market can't fund a credit, we refuse and say why.</li>
    <li><b>Paid daily, never upfront.</b> Your credit unlocks through each daily cycle and pays automatically at its close.</li>
    <li><b>The cap ends the cycle, not your trade.</b> If price touches your cap, that cycle ends — you keep your position, every gain, and the unlocked credit; protection re-arms at the new price while the toggle stays on. You never owe anything.</li>
    <li><b>Honest economics.</b> We keep a published share of the credit we source (waived when tiny); founding wallets keep a reduced rate<span id="rateNote"></span>.</li>
    <li>Derivatives involve risk. Nothing here is investment advice.</li>
  </ul>
  <button class="btn ghost" id="howClose">Close</button>
</div></div>
<script>
const MINIAPP = ${miniapp ? "true" : "false"};
const TG = MINIAPP && window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
if (TG) { try { TG.ready(); TG.expand(); } catch (e) {} }
const haptic = (kind) => { if (TG && TG.HapticFeedback) { try { kind === "impact" ? TG.HapticFeedback.impactOccurred("medium") : TG.HapticFeedback.notificationOccurred(kind); } catch (e) {} } };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmt$ = (x) => x == null ? "—" : (x < 0 ? "−$" : "$") + Math.abs(x).toFixed(2);
const fmtPx = (x) => x == null ? "—" : "$" + Number(x).toLocaleString("en-US", { maximumFractionDigits: 1 });
const short = (a) => a ? a.slice(0,6) + "…" + a.slice(-4) : "";

// Honest refusal copy: ≤8 human words on the chip, the full engine string on hover.
const humanChip = (raw) => {
  const s = String(raw || "");
  const cd = s.match(/cooldown[^0-9]*(\\d+)s/i);
  if (cd) return "Next wrap in " + cd[1] + "s";
  if (/50\\d{3}|51\\d{3}|OK-ACCESS|API key|passphrase|network error|position_read_failed/i.test(s)) return "Our issue, not yours · nothing opened";
  if (/listed_credit_nonpositive|listed_book_empty|credit_infeasible|not_priceable|no executable/i.test(s)) return "No honest credit right now · nothing opened";
  if (/aborted_no_fill|aborted_unwound|pair unwound|did not fill|hedge_not_filled/i.test(s)) return "Couldn't fill at our quote · nothing opened";
  if (/minimum one lot|0\\.01 BTC lots|below_min_lot/i.test(s)) return "Below the 0.01 BTC minimum";
  if (/waitlist|founding cohort/i.test(s)) return "Founding cohort full · you're on the waitlist";
  if (/capacity.*in use|wallet_cap/i.test(s)) return "Your capacity is in use this cycle";
  if (/strike_concentration|already carries|unwindable|strike.*concentration/i.test(s)) return "That strike is crowded · try again shortly";
  if (/quota reached/i.test(s)) return "Daily limit reached";
  if (/hard cap|book notional cap|book is full/i.test(s)) return "Above the current cap · nothing opened";
  if (/already active|in flight|in_flight|being processed/i.test(s)) return "Already protected";
  if (/no open .* position|no live position|no_position/i.test(s)) return "No open position to protect";
  if (/allow-list|account_refused|not an address/i.test(s)) return "Account not enabled yet";
  if (/verify_required/i.test(s)) return "Verify your wallet first — one signature, one time";
  if (/close_locked/i.test(s)) return "Turn off from the device that turned protection on — it pays out on its own either way";
  if (/tos_required|Terms of Service/i.test(s)) return "Please accept the Terms first";
  if (/waitlisted|#\d+ in line/i.test(s)) { const m = s.match(/#(\d+) in line/); return m ? "Founding cohort full — you're #" + m[1] + " in line" : "Founding cohort full — you're on the waitlist"; }
  if (/geo_blocked|not available in your region|verify your location/i.test(s)) return "Not available in your region";
  if (/kill switch|demo disabled|paused/i.test(s)) return "Protection paused";
  if (/rate_limited/i.test(s)) return "Slow down a moment";
  return "Couldn't complete · nothing opened";
};

const stageLabel = {wrap_requested:"Requested",position_read:"Position read",quoted:"Priced off the live book",hedge_executing:"Hedge executing",hedge_locked:"Hedge locked",green_light:"Protection live",vesting:"Credit vesting",failed:"Refused",knocked_out:"Cap touched — cycle over",concluded:"Concluded"};

// "pays in 11h 26m" — the vesting bar's time axis.
const fmtDur = (ms) => {
  if (ms == null || ms <= 0) return "now";
  const h = Math.floor(ms / 3600000), m = Math.round((ms % 3600000) / 60000);
  return h > 0 ? h + "h " + m + "m" : m > 0 ? m + "m" : "<1m";
};
const tip = (trigger, text, right) => '<span class="tipwrap' + (right ? " tip-right" : "") + '">' + trigger + '<span class="tip">' + esc(text) + '</span></span>';
const infoTip = (text, right) => tip('<span class="info">i</span>', text, right);

// Mini App account handoff: the bot passes ?account=0x… on its launch buttons; localStorage keeps
// it for menu-button launches (no per-chat URL there). The paste flow remains the fallback.
const urlAccount = new URLSearchParams(location.search).get("account");
let account = (urlAccount && /^0x[0-9a-fA-F]{40}$/.test(urlAccount) ? urlAccount : "") || localStorage.getItem("ep_account") || "";
if (account) localStorage.setItem("ep_account", account);
let busy = false;

// One status writer: the connect-card line on web; a visible flash strip in the Mini App
// (where the connect card is hidden once an account is bound).
const setMsg = (t, isErr, working) => {
  const html = t ? (working ? '<span class="spin"></span>' : "") + esc(t) : "";
  $("connectMsg").innerHTML = html;
  const f = $("flash");
  if (MINIAPP) { f.innerHTML = html; f.style.display = t ? "" : "none"; f.className = "flash" + (isErr ? " bad" : ""); }
};

const setConn = () => {
  $("connPill").textContent = account ? short(account) + " · read-only" : "not connected";
  $("forgetBtn").style.display = account ? "" : "none";
  if (account) $("addrInput").value = account;
  // Mini App with a connected account: the connect card is noise — the pill carries the identity.
  if (MINIAPP) $("connectCard").style.display = account ? "none" : "";
};

const api = async (path, opts) => {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(path + sep + "account=" + encodeURIComponent(account), opts);
  return r.json();
};

const txLink = (h) => {
  if (!h) return "—";
  if (/^0x[0-9a-fA-F]{64}$/.test(h)) return '<a href="https://arbiscan.io/tx/' + h + '" target="_blank" rel="noopener">' + h.slice(0,10) + '…</a>';
  return '<span class="muted" title="' + esc(h) + '">simulated</span>';
};

// The latest wrap drives the position card chip; state is the engine's, never the click's.
const latestFor = (wraps) => wraps.length ? wraps[wraps.length - 1] : null;

const render = (positions, state) => {
  const el = $("positions");
  if (!account) { el.innerHTML = '<div class="empty">Connect an address to see your open positions.</div>'; return; }
  if (!positions || positions.length === 0) { el.innerHTML = '<div class="empty">No open perp positions on ' + esc(short(account)) + '.</div>'; return; }
  const w = state ? latestFor(state.wraps || []) : null;
  const founding = state && state.protection && state.protection.founding;
  const caps = state && state.caps;
  el.innerHTML = positions.map((p) => {
    const isWrapCoin = p.wrappable;
    const active = isWrapCoin && w && (w.status === "active" || w.status === "quoting" || w.status === "executing");
    const v = w && w.vestingStatus;
    const q = w && w.quote;
    let chip = "", terms = "", bar = "", coverage = "", receipt = "", tooltip = "";
    const legLabel = { sell_call_cap: "SELL call (cap)", buy_put_floor: "BUY put (floor)", sell_put_cap: "SELL put (cap)", buy_call_floor: "BUY call (floor)" };
    if (isWrapCoin && w && w.legs && w.legs.length && (w.status === "active" || w.status === "knocked_out")) {
      // Hedge receipt — the proof: real instruments, premiums, order refs. REAL = a venue order
      // stands behind the row; SIMULATED = a live-book model quote (paper lane), labeled honestly.
      receipt = '<details class="receipt"><summary>Hedge receipt — how this protection is built</summary><table class="receipt-tbl">' +
        '<thead><tr><th>leg</th><th>listed instrument</th><th>premium</th><th>order ref</th><th></th></tr></thead><tbody>' +
        w.legs.map((l) =>
          '<tr><td>' + (legLabel[l.role] || esc(l.role)) + '</td><td><code>' + esc((l.instId || "—").replace(" (model)", "")) + '</code></td><td>' + fmt$(l.premiumUsdc) + '</td><td><code>' + esc(l.orderId || "—") + '</code></td><td class="' + (l.real ? "tag-real" : "tag-sim") + '">' + (l.real ? "REAL" : "SIMULATED") + '</td></tr>'
        ).join("") +
        '</tbody></table><div class="trust" style="margin-top:6px">Sold premium funds the bought floor; the surplus is your credit. Every row reconciles against the venue\\u2019s own fill and settlement records.</div></details>';
    }
    if (isWrapCoin && w) {
      if (w.status === "active" && v && q) {
        const capStrike = q.capStrike ?? q.callStrike, floorStrike = q.floorStrike ?? q.putStrike;
        // Side-aware signs: a long's floor is below / cap above; a short mirrors.
        const floorSign = p.side === "long" ? "−" : "+", capSign = p.side === "long" ? "+" : "−";
        const foundingBadge = founding && caps
          ? tip('<span class="badge founding">FOUNDING RATE</span>',
              "You're one of our first " + caps.foundingWallets + " wallets, so you keep " + (100 - caps.foundingTakeRatePct * 100).toFixed(0) + "% of every credit instead of " + (100 - caps.takeRatePct * 100).toFixed(0) + "% — locked in for 12 months. And when our cut would be under 5\\u00a2, we skip it: you keep it all.")
          : "";
        chip = '<div class="chip on">EARNING · <b>' + fmt$(v.vestedUsdc) + '</b> of ' + fmt$(v.fullCreditUsdc) + ' unlocked' + foundingBadge + '</div>';
        terms = '<div class="terms">' +
          '<div class="term"><b>' + fmt$(q.creditUsdc) + '</b>today\\u2019s credit' + infoTip("Funded by the options market, not by us. Unlocks through the day and pays to this wallet automatically at the cycle's close — never upfront.") + '</div>' +
          '<div class="term"><b>' + fmtPx(floorStrike) + ' <em>' + floorSign + (q.floorPct * 100).toFixed(1) + '%</em></b>hard floor' + infoTip("Losses stop here. Struck " + floorSign + (q.floorPct * 100).toFixed(1) + "% from the price when protection started (" + fmtPx(q.spot) + "), not from your entry.") + '</div>' +
          '<div class="term"><b>' + fmtPx(capStrike) + ' <em>' + capSign + (q.capPct * 100).toFixed(1) + '%</em></b>cap — ends cycle' + infoTip("If the price touches " + fmtPx(capStrike) + ", this cycle ends early: you keep your position, every gain to the cap, and the credit unlocked to that moment. Protection re-arms automatically at the new price while the toggle stays on. You never owe anything.", true) + '</div>' +
          '</div>';
        const settleIso = w.vesting && w.vesting.endMs ? new Date(w.vesting.endMs).toUTCString().replace(":00 GMT", " UTC") : null;
        bar = '<div class="bar"><div style="width:' + (v.fraction * 100).toFixed(1) + '%"></div></div>' +
          '<div class="unlock">unlocks through the day · ' +
          tip(v.fullyVested ? "fully unlocked — pays at settlement" : "pays in " + fmtDur(v.remainingMs), settleIso ? "Settles at the listed expiry: " + settleIso + ". The credit lands in the payouts table below, then protection renews automatically." : "Pays at the cycle's close.") +
          '</div>';
        const note = w.hedge && w.hedge.sizeNote;
        if (note) coverage = '<div class="coverage">' + esc(note) + '</div>';
      } else if (w.status === "quoting" || w.status === "executing") {
        // Spinner + live seconds counter (server-truth: elapsed since the wrap request landed).
        chip = '<div class="chip on"><span class="spin"></span>Wrapping… ' +
          (w.status === "executing" ? "placing hedge legs" : "pricing the live options book") +
          ' <span class="els" data-ts="' + (w.createdAtMs || Date.now()) + '"></span></div>';
      } else if (w.status === "knocked_out") {
        const ko = w.knockout || {};
        chip = '<div class="chip">Cap $' + (ko.capStrike ?? "?") + ' touched — cycle over. You kept every gain to the cap' + (v ? ' + ' + fmt$(v.vestedUsdc) + ' credit' : '') + '. Re-arms automatically while the toggle is on.</div>';
      } else if (w.status === "concluded" && v) {
        chip = '<div class="chip">' + (v.fullyVested ? "Cycle complete — earned " + fmt$(v.fullCreditUsdc) + " in full" : "Closed early — kept " + fmt$(v.vestedUsdc) + " of " + fmt$(v.fullCreditUsdc)) + '</div>';
      } else if (w.status === "failed" && w.failReason) {
        chip = '<div class="chip bad" title="' + esc(w.failReason) + '">' + esc(humanChip(w.failReason)) + '</div>';
        tooltip = w.failReason;
      }
    }
    // The active toggle carries its unlocked/full numbers so turning OFF can state the consequence.
    const toggle = isWrapCoin
      ? '<div class="switch' + (active ? " on" : "") + (busy ? " busy" : "") + '" data-coin="' + esc(p.coin) + '" data-active="' + (active ? "1" : "0") + '"' +
        (active && v ? ' data-vested="' + v.vestedUsdc + '" data-full="' + v.fullCreditUsdc + '"' : "") +
        ' role="switch" aria-checked="' + (active ? "true" : "false") + '"><div class="knob"></div></div>'
      : '<span class="small muted">protection for ' + esc(p.coin) + ' coming soon</span>';
    return '<div class="card" title="' + esc(tooltip) + '">' +
      '<div class="row"><div class="pos-head"><span class="' + (p.side === "long" ? "long" : "short") + '">' + p.side.toUpperCase() + '</span> ' + p.szBase + ' ' + esc(p.coin) + ' <small>· ' + fmt$(p.notionalUsdc) + (p.entryPx ? ' · entry ' + fmtPx(p.entryPx) : '') + '</small></div>' + toggle + '</div>' +
      chip + terms + bar + coverage + receipt + '</div>';
  }).join("");
  for (const sw of el.querySelectorAll(".switch")) sw.addEventListener("click", onToggle);
};

// Mobile-safe tooltips: tap toggles, tapping elsewhere closes.
document.addEventListener("click", (ev) => {
  const wrap = ev.target.closest ? ev.target.closest(".tipwrap") : null;
  for (const t of document.querySelectorAll(".tipwrap.open")) if (t !== wrap) t.classList.remove("open");
  if (wrap) wrap.classList.toggle("open");
});

$("howLink").onclick = (e) => { e.preventDefault(); $("howVeil").classList.add("open"); };
$("howClose").onclick = () => $("howVeil").classList.remove("open");
$("howVeil").addEventListener("click", (e) => { if (e.target === $("howVeil")) $("howVeil").classList.remove("open"); });

// 1s ticker for the wrapping counter — reads server timestamps, never invents time.
setInterval(() => {
  for (const el of document.querySelectorAll(".els")) {
    const ts = Number(el.dataset.ts || 0);
    if (ts > 0) el.textContent = "· " + Math.max(0, Math.round((Date.now() - ts) / 1000)) + "s";
  }
}, 1000);

const renderPayouts = (state) => {
  const rows = (state && state.payouts || []).slice().reverse();
  $("payouts").innerHTML = rows.length
    ? rows.map((e) => '<tr><td>' + new Date(e.createdAtMs).toISOString().slice(0,16).replace("T"," ") + '</td><td>' + esc(e.reason.replace("_"," ")) + '</td><td><b>' + fmt$(e.amountUsdc) + '</b></td><td class="status-' + (e.status === "confirmed" || e.status === "paid" ? "paid" : e.status === "failed" ? "failed" : "accrued") + '">' + esc(e.status) + '</td><td>' + txLink(e.txHash) + '</td></tr>').join("")
    : '<tr><td colspan="5" class="empty">No payouts yet — credits land here at each cycle\\u2019s conclusion.</td></tr>';
};

const onToggle = async (ev) => {
  if (busy || !account) return;
  const sw = ev.currentTarget;
  const isOn = sw.dataset.active === "1";
  // Turning OFF is an early close with consequences — state them before acting.
  if (isOn) {
    const kept = Number(sw.dataset.vested || 0), full = Number(sw.dataset.full || 0);
    const msg = "Turn protection off now?\\n\\nYou keep " + fmt$(kept) + " already unlocked; the remaining " + fmt$(Math.max(0, full - kept)) + " returns to the market. Auto-renew turns off.";
    if (!window.confirm(msg)) return;
  }
  busy = true;
  haptic("impact");
  if (isOn) setMsg("Closing early — collecting what's unlocked…", false, true);
  // Immediate knob feedback: flip for the ATTEMPT, pulse while working; the next state render
  // corrects it if the engine refuses. A toggle that only moves on success reads as stuck.
  sw.classList.toggle("on", !isOn);
  sw.classList.add("busy");
  try {
    if (isOn) {
      const ctl = localStorage.getItem("ep_ctl_" + account.toLowerCase()) || "";
      const j = await api("/api/close?ctl=" + encodeURIComponent(ctl), { method: "POST" });
      setMsg(j.ok ? "Closed early — kept " + fmt$(j.vested.vestedUsdc) + " unlocked. Auto-renew off." : humanChip(j.message || j.error), !j.ok);
    } else {
      setMsg("Wrapping — pricing the live options book…", false, true);
      // Client-supplied idempotency key: a flaky network can never double-wrap.
      const idem = (MINIAPP ? "tma-" : "web-") + account.slice(2, 10) + "-" + Date.now().toString(36);
      const j = await api("/api/wrap", { method: "POST", headers: { "Idempotency-Key": idem } });
      if (j.ok && j.controlToken) localStorage.setItem("ep_ctl_" + account.toLowerCase(), j.controlToken);
      setMsg(j.ok ? "Protection live — credit pays at the cycle's close." : humanChip(j.message || j.error), !j.ok);
      if (!j.ok) $("connectMsg").title = String(j.message || j.error || "");
      haptic(j.ok ? "success" : "error");
    }
  } catch (e) {
    setMsg("Our issue, not yours · nothing opened", true);
    haptic("error");
  }
  busy = false;
  poll();
};

// Launch gates: geofence banner (reads stay open, actions are blocked server-side) + ToS card.
const checkGates = async () => {
  try {
    const geo = await (await fetch("/api/geo")).json();
    if (geo.ok && geo.enabled && !geo.allowed) {
      $("geoBanner").style.display = "";
      $("geoMsg").textContent = geo.message || "Protection actions are unavailable from your location.";
    } else $("geoBanner").style.display = "none";
  } catch (e) { /* leave as-is */ }
  if (!account) { $("tosCard").style.display = "none"; $("verifyCard").style.display = "none"; return; }
  try {
    const [tos, ver] = await Promise.all([api("/api/tos"), api("/api/verify")]);
    const needsSig = ver.ok && ver.required && !ver.verified;
    // Signature covers ToS too — never show both prompts.
    $("verifyCard").style.display = needsSig ? "" : "none";
    if (tos.ok && tos.required && !tos.accepted && !needsSig) {
      $("tosVer").textContent = tos.version;
      $("tosCard").style.display = "";
    } else $("tosCard").style.display = "none";
  } catch (e) { /* leave as-is */ }
};

// One-time wallet verification: personal_sign of the server's canonical message.
$("verifyBtn").onclick = async () => {
  if (!account) return;
  const eth = window.ethereum;
  if (!eth) { $("verifyMsg").textContent = "No wallet found — open this page inside your wallet's browser (MetaMask/Rabby), or use the Terms checkbox flow if signatures aren't required."; return; }
  try {
    $("verifyMsg").textContent = "Check your wallet…";
    const info = await api("/api/verify");
    if (!info.ok) { $("verifyMsg").textContent = humanChip(info.message || info.error); return; }
    const accounts = await eth.request({ method: "eth_requestAccounts" });
    const signer = (accounts && accounts[0] || "").toLowerCase();
    if (signer !== account.toLowerCase()) { $("verifyMsg").textContent = "Your wallet is on " + short(signer) + " — switch to " + short(account) + " and retry."; return; }
    const sig = await eth.request({ method: "personal_sign", params: [info.message, accounts[0]] });
    const out = await api("/api/verify?signature=" + encodeURIComponent(sig), { method: "POST" });
    $("verifyMsg").textContent = out.ok ? "Verified — you're set on every surface." : humanChip(out.message || out.error);
    haptic(out.ok ? "success" : "error");
    checkGates();
  } catch (e) {
    $("verifyMsg").textContent = (e && e.code === 4001) ? "Signature declined — nothing happened." : "Wallet error — try again.";
  }
};
$("tosCheck").onchange = () => { $("tosBtn").disabled = !$("tosCheck").checked; };
$("tosBtn").onclick = async () => {
  const j = await api("/api/tos/accept", { method: "POST" });
  setMsg(j.ok ? "Terms accepted (" + j.version + ") — you're set." : humanChip(j.message || j.error), !j.ok);
  checkGates();
};

// Mode pill: SIMULATED (paper) / DEMO VENUE (okx_demo) / LIVE (okx_live) — nobody should ever
// mistake a test surface for real money or vice versa.
const setModePill = (mode) => {
  const el = $("modePill");
  if (!mode) { el.style.display = "none"; return; }
  const m = mode === "okx_live" ? ["LIVE", "mode-live", "Real hedge orders on the listed venue. Credits are real."]
    : mode === "okx_demo" ? ["DEMO VENUE", "mode-demo", "Real order flow against the venue's demo environment — no real money."]
    : ["SIMULATED", "mode-paper", "Paper mode: quotes are live market prices, but no venue orders are placed and payouts are simulated."];
  el.style.display = "";
  el.className = "mode-pill tipwrap " + m[1];
  el.innerHTML = m[0] + '<span class="tip">' + m[2] + '</span>';
};

let pollTimer = null;
const poll = async () => {
  if (!account) return;
  try {
    const [pos, st] = await Promise.all([api("/api/positions"), api("/api/state")]);
    if (st && st.caps) {
      $("rateNote").textContent = " (" + (st.caps.foundingTakeRatePct * 100).toFixed(0) + "% vs " + (st.caps.takeRatePct * 100).toFixed(0) + "%, locked 12 months)";
      const wl = st.caps.waitlistLength ? " · waitlist " + st.caps.waitlistLength : "";
      const mine = st.protection && st.protection.waitlistPosition ? " · you're #" + st.protection.waitlistPosition + " in line" : "";
      $("cohortLine").textContent = "· founding cohort " + st.caps.walletsJoined + "/" + st.caps.foundingWallets + wl + mine;
    }
    if (st && st.guards) setModePill(st.guards.executionMode);
    $("hero").style.display = "none"; // connected: the app gets denser, the pitch gets out of the way
    render(pos.ok ? pos.positions : [], st.ok ? st : null);
    renderPayouts(st.ok ? st : null);
  } catch (e) { /* keep last render */ }
};

$("connectBtn").onclick = () => {
  const a = $("addrInput").value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) { $("connectMsg").textContent = "That's not an EVM address."; return; }
  account = a;
  localStorage.setItem("ep_account", a);
  $("connectMsg").textContent = "Connected read-only. We can see positions, never touch them.";
  setConn();
  checkGates();
  poll();
};
$("forgetBtn").onclick = () => {
  account = "";
  localStorage.removeItem("ep_account");
  $("addrInput").value = "";
  $("connectMsg").textContent = "";
  setConn();
  $("hero").style.display = "";
  $("modePill").style.display = "none";
  $("positions").innerHTML = '<div class="empty">Connect an address to see your open positions.</div>';
  renderPayouts(null);
};

setConn();
checkGates();
if (account) poll();
pollTimer = setInterval(poll, 5000);
setInterval(checkGates, 30000);
</script>
</body>
</html>`;
};

export const EP_WEB_APP_HTML = buildEpAppHtml("web");
export const EP_MINI_APP_HTML = buildEpAppHtml("miniapp");
