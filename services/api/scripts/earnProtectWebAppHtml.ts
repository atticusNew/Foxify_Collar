/**
 * EARN & PROTECT — trader web app (Track 1 canonical surface).
 *
 * Deliberately thin: a positions page and a toggle, not a platform. Served by the demo service at
 * GET /app and consuming ONLY the public JSON API (the same routes a partner integration would
 * use — that is the point). Brand matches site/index.html (dark, yellow accent).
 *
 * Product rules enforced in this UI:
 *   - read-only wallet connect: paste an address; no signing, no deposits, no keys
 *   - ONE-NUMBER RULE: after a fill, the realized credit is the only unlabeled number
 *   - honest refusal copy (human line; full engine string on hover) — port of the extension chip
 *   - partial coverage stated plainly; payout history links to the tx
 */

export const EP_WEB_APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atticus — Earn & Protect</title>
<style>
  :root{--bg:#0b0f14;--panel:#111722;--panel2:#0e141d;--line:#1f2937;--text:#e8edf4;--muted:#8b98a9;--accent:#d9ab01;--good:#2ea043;--bad:#f85149;--radius:14px}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:760px;margin:0 auto;padding:0 20px 60px}
  nav{position:sticky;top:0;z-index:10;background:rgba(11,15,20,.85);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
  .nav-in{max-width:760px;margin:0 auto;padding:0 20px;display:flex;align-items:center;justify-content:space-between;height:58px}
  .logo{font-weight:800;letter-spacing:2.5px;font-size:15px}.logo b{color:var(--accent)}
  .kicker{color:var(--accent);font-weight:700;font-size:11.5px;letter-spacing:2px;text-transform:uppercase}
  .pill{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:4px 12px}
  h1{font-size:26px;font-weight:800;letter-spacing:-.3px;margin:30px 0 6px}
  .sub{color:var(--muted);font-size:14.5px;margin-bottom:24px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;margin-bottom:14px}
  .row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
  input[type=text]{flex:1;min-width:240px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;color:var(--text);padding:11px 14px;font:inherit;font-size:14px}
  input[type=text]:focus{outline:none;border-color:var(--accent)}
  .btn{background:var(--accent);color:#171200;font-weight:700;padding:10px 18px;border-radius:10px;font-size:14px;border:0;cursor:pointer}
  .btn:hover{filter:brightness(1.08)} .btn.ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}
  .muted{color:var(--muted)} .small{font-size:12.5px} a{color:var(--accent);text-decoration:none}
  .pos-head{font-weight:700;font-size:15px} .pos-head small{color:var(--muted);font-weight:400}
  .switch{width:46px;height:26px;border-radius:999px;background:#26303e;position:relative;cursor:pointer;transition:background .25s;flex:none}
  .switch .knob{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#98a3b3;transition:all .25s}
  .switch.on{background:var(--accent)} .switch.on .knob{left:23px;background:#171200}
  .switch.busy{opacity:.55;pointer-events:none}
  .chip{margin-top:12px;border-radius:10px;padding:11px 13px;font-size:13.5px;background:var(--panel2);border:1px solid var(--line);color:var(--muted);transition:all .3s}
  .chip.on{border-color:rgba(217,171,1,.45);color:var(--text)} .chip.bad{border-color:rgba(248,81,73,.4)} .chip b{color:var(--accent)}
  .terms{margin-top:10px;display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:12.5px;color:var(--muted)}
  .term{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:9px 11px}
  .term b{display:block;color:var(--text);font-size:13.5px}
  .bar{background:#1a212d;border-radius:999px;height:10px;overflow:hidden;margin-top:10px}
  .bar>div{background:linear-gradient(90deg,#8a6d00,var(--accent));height:100%;width:0;transition:width .8s}
  .coverage{margin-top:10px;font-size:12.5px;color:var(--accent)}
  table{width:100%;border-collapse:collapse;margin-top:6px;font-size:13px}
  th,td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line)} th{color:var(--muted);font-weight:600;font-size:12px}
  .status-paid{color:var(--good);font-weight:600} .status-accrued{color:var(--accent)} .status-failed{color:var(--bad)}
  h2{font-size:15px;font-weight:700;margin:26px 0 8px}
  .foot{color:var(--muted);font-size:11.5px;margin-top:34px;border-top:1px solid var(--line);padding-top:16px}
  .badge{display:inline-block;font-size:11px;font-weight:700;border-radius:999px;padding:2.5px 10px;margin-left:8px;vertical-align:2px}
  .badge.founding{background:rgba(217,171,1,.15);color:var(--accent);border:1px solid rgba(217,171,1,.4)}
  .empty{color:var(--muted);font-size:13.5px;padding:6px 0}
</style>
</head>
<body>
<nav><div class="nav-in">
  <div class="logo">ATTICUS <b>·</b> <span class="kicker">Earn &amp; Protect</span></div>
  <div class="pill" id="connPill">not connected</div>
</div></nav>
<div class="wrap">
  <h1>One toggle. A hard floor. And it pays.</h1>
  <p class="sub">Paste your Hyperliquid address — we only <b>read</b> your positions (no signing, no deposits, no keys). Flip protection on and the credit the options market funds is paid to your wallet at each daily cycle's close.</p>

  <div class="card" id="connectCard">
    <div class="row">
      <input type="text" id="addrInput" placeholder="0x… your Hyperliquid address (read-only)" spellcheck="false">
      <button class="btn" id="connectBtn">View positions</button>
      <button class="btn ghost" id="forgetBtn" style="display:none">Forget</button>
    </div>
    <div class="small muted" id="connectMsg" style="margin-top:8px"></div>
  </div>

  <h2>Your positions</h2>
  <div id="positions"><div class="empty">Connect an address to see your open positions.</div></div>

  <h2>Payouts</h2>
  <div class="card" style="padding-top:10px">
    <table><thead><tr><th>when</th><th>cycle</th><th>credit</th><th>status</th><th>tx</th></tr></thead>
    <tbody id="payouts"><tr><td colspan="5" class="empty">No payouts yet — credits land here at each cycle's conclusion.</td></tr></tbody></table>
  </div>

  <div class="foot">
    Protection terms are quoted from live listed order books at the moment of the toggle and refused honestly when the market can't fund them.
    Credits vest through each daily cycle and are paid at its conclusion. If the market touches your cap, that cycle ends — you keep your position,
    every gain to the cap, and the credit vested to the touch; protection re-arms at the new price while the toggle stays on.
    We keep a published share of the credit we source (waived when tiny); founding wallets keep a reduced rate<span id="rateNote"></span>.
    Derivatives involve risk. Nothing here is investment advice.
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmt$ = (x) => x == null ? "—" : (x < 0 ? "−$" : "$") + Math.abs(x).toFixed(2);
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
  if (/strike.*concentration|strike_concentration/i.test(s)) return "That strike is crowded · try again shortly";
  if (/quota reached/i.test(s)) return "Daily limit reached";
  if (/hard cap|book notional cap|book is full/i.test(s)) return "Above the current cap · nothing opened";
  if (/already active|in flight|in_flight|being processed/i.test(s)) return "Already protected";
  if (/no open .* position|no live position|no_position/i.test(s)) return "No open position to protect";
  if (/allow-list|account_refused|not an address/i.test(s)) return "Account not enabled yet";
  if (/kill switch|demo disabled|paused/i.test(s)) return "Protection paused";
  if (/rate_limited/i.test(s)) return "Slow down a moment";
  return "Couldn't complete · nothing opened";
};

const stageLabel = {wrap_requested:"Requested",position_read:"Position read",quoted:"Priced off the live book",hedge_executing:"Hedge executing",hedge_locked:"Hedge locked",green_light:"Protection live",vesting:"Credit vesting",failed:"Refused",knocked_out:"Cap touched — cycle over",concluded:"Concluded"};

let account = localStorage.getItem("ep_account") || "";
let busy = false;

const setConn = () => {
  $("connPill").textContent = account ? short(account) + " · read-only" : "not connected";
  $("forgetBtn").style.display = account ? "" : "none";
  if (account) $("addrInput").value = account;
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
  el.innerHTML = positions.map((p) => {
    const isWrapCoin = p.wrappable;
    const active = isWrapCoin && w && (w.status === "active" || w.status === "quoting" || w.status === "executing");
    const v = w && w.vestingStatus;
    const q = w && w.quote;
    let chip = "", terms = "", bar = "", coverage = "", tooltip = "";
    if (isWrapCoin && w) {
      if (w.status === "active" && v) {
        chip = '<div class="chip on">EARNING · <b>' + fmt$(v.vestedUsdc) + '</b> of ' + fmt$(v.fullCreditUsdc) + ' vested' + (founding ? '<span class="badge founding">FOUNDING RATE</span>' : '') + '</div>';
        if (q) terms = '<div class="terms"><div class="term"><b>' + fmt$(q.creditUsdc) + '</b>cycle credit</div><div class="term"><b>$' + (q.floorStrike ?? q.putStrike) + '</b>hard floor</div><div class="term"><b>$' + (q.capStrike ?? q.callStrike) + '</b>cap (ends cycle)</div></div>';
        bar = '<div class="bar"><div style="width:' + (v.fraction * 100).toFixed(1) + '%"></div></div>';
        const note = w.hedge && w.hedge.sizeNote;
        if (note) coverage = '<div class="coverage">' + esc(note) + '</div>';
      } else if (w.status === "quoting" || w.status === "executing") {
        chip = '<div class="chip on">Wrapping… pricing the live options book</div>';
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
    const toggle = isWrapCoin
      ? '<div class="switch' + (active ? " on" : "") + (busy ? " busy" : "") + '" data-coin="' + esc(p.coin) + '" data-active="' + (active ? "1" : "0") + '" role="switch" aria-checked="' + (active ? "true" : "false") + '"><div class="knob"></div></div>'
      : '<span class="small muted">protection for ' + esc(p.coin) + ' coming soon</span>';
    return '<div class="card" title="' + esc(tooltip) + '">' +
      '<div class="row"><div class="pos-head">' + p.side.toUpperCase() + ' ' + p.szBase + ' ' + esc(p.coin) + ' <small>· ' + fmt$(p.notionalUsdc) + (p.entryPx ? ' · entry $' + p.entryPx : '') + '</small></div>' + toggle + '</div>' +
      chip + terms + bar + coverage + '</div>';
  }).join("");
  for (const sw of el.querySelectorAll(".switch")) sw.addEventListener("click", onToggle);
};

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
  busy = true;
  sw.classList.add("busy");
  try {
    if (isOn) {
      const j = await api("/api/close", { method: "POST" });
      $("connectMsg").textContent = j.ok ? "Closed early — kept " + fmt$(j.vested.vestedUsdc) + " vested. Auto-renew off." : humanChip(j.message || j.error);
    } else {
      // Client-supplied idempotency key: a flaky network can never double-wrap.
      const idem = "web-" + account.slice(2, 10) + "-" + Date.now().toString(36);
      const j = await api("/api/wrap", { method: "POST", headers: { "Idempotency-Key": idem } });
      $("connectMsg").textContent = j.ok ? "Protection live — credit pays at the cycle's close." : humanChip(j.message || j.error);
      if (!j.ok) $("connectMsg").title = String(j.message || j.error || "");
    }
  } catch (e) {
    $("connectMsg").textContent = "Our issue, not yours · nothing opened";
  }
  busy = false;
  poll();
};

let pollTimer = null;
const poll = async () => {
  if (!account) return;
  try {
    const [pos, st] = await Promise.all([api("/api/positions"), api("/api/state")]);
    if (st && st.caps) $("rateNote").textContent = " (" + (st.caps.foundingTakeRatePct * 100).toFixed(0) + "% vs " + (st.caps.takeRatePct * 100).toFixed(0) + "%, locked 12 months)";
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
  poll();
};
$("forgetBtn").onclick = () => {
  account = "";
  localStorage.removeItem("ep_account");
  $("addrInput").value = "";
  $("connectMsg").textContent = "";
  setConn();
  $("positions").innerHTML = '<div class="empty">Connect an address to see your open positions.</div>';
  renderPayouts(null);
};

setConn();
if (account) poll();
pollTimer = setInterval(poll, 5000);
</script>
</body>
</html>`;
