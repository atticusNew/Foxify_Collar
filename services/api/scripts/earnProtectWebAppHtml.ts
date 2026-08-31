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
 * LIVE-REPLICA LANDING (retail): the visitor lands INSIDE the operating product — a live public
 * (showcase) BTC position loads on arrival with live pricing ticking; the protection toggle
 * renders on the position card exactly as the live product. Flipping it runs a SIMULATION LANE:
 * the full lifecycle (quote → executing → active → vesting) fed by a real live preview quote,
 * never the real wrap path (server-side showcase guards stay armed). One quiet persistent
 * honesty label: "simulation · live pricing". The nav carries dApp-standard Connect chrome —
 * swapping in the visitor's own address (public data, no signing) is the conversion action the
 * funnel measures (lookers). Mobile-first: designed at 390px, expands up.
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
<title>${miniapp ? "Earn & Protect" : "Atticus · Earn & Protect"}</title>
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
  /* INSTITUTIONAL skin (EP_SKIN=institutional): deep navy + fresh blue, harmonizing with an
     enterprise-custody world without copying anyone's exact brand hexes. Retail (HL) is default. */
  body.inst{
    --bg:#0a1220;--panel:#101b30;--panel2:#0d1728;--line:#1e2c47;
    --muted:#8b9ab5;--accent:#4f8df9;--accent-ink:#061225
  }
  body.inst nav{background:rgba(10,18,32,.92)}
  /* INST layout: the MODEL-A-HOLDING card leads (treasury lane); the trading-address lookup demotes.
     Flex ordering only — DOM (and the retail skin) untouched. */
  body.inst .wrap{display:flex;flex-direction:column}
  body.inst #hero{order:-40}
  body.inst #previewCard{order:-30}
  /* INST is model-first and minimal: no address lookup (proof lives as a quiet link under the
     model result; viewing mode is reachable only through it). The connect modal never opens. */
  body.inst #connectCard{display:none}
  body{background:var(--bg);color:var(--text);font:14.5px/1.55 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:760px;margin:0 auto;padding:0 20px 60px}
  nav{position:sticky;top:0;z-index:10;background:rgba(11,29,35,.9);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
  .nav-in{max-width:760px;margin:0 auto;padding:0 20px;display:flex;align-items:center;justify-content:space-between;height:54px}
  .logo{font-weight:700;font-size:15px;letter-spacing:.2px}
  .logo .by{color:var(--muted);font-weight:500;font-size:11.5px;letter-spacing:.6px;margin-left:8px}
  .logo .by b{color:var(--accent);font-weight:600}
  /* Live venue price — HL-native texture: always-visible mark, quiet tick color on change */
  .px{font-size:12px;color:var(--muted);margin-right:10px;font-variant-numeric:tabular-nums;white-space:nowrap}
  .px b{color:var(--text);font-weight:600;transition:color .5s}
  .px.up b{color:var(--good)} .px.down b{color:var(--bad)}
  h1{font-size:24px;font-weight:700;letter-spacing:-.2px;margin:28px 0 6px}
  .sub{color:var(--muted);font-size:14px;margin-bottom:22px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;margin-bottom:12px;transition:border-color .25s}
  .card:hover{border-color:rgba(80,210,193,.28)}
  .row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
  input[type=text]{flex:1;min-width:240px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;color:var(--text);padding:10px 13px;font:inherit;font-size:13.5px}
  input[type=text]:focus{outline:none;border-color:var(--accent)}
  .btn{background:var(--accent);color:var(--accent-ink);font-weight:700;padding:9px 17px;border-radius:6px;font-size:13.5px;border:0;cursor:pointer}
  .btn:hover{filter:brightness(1.08)} .btn.ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}
  .muted{color:var(--muted)} .small{font-size:12.5px} a{color:var(--accent);text-decoration:none}
  /* Position header: side + compact notional lead; the raw size/entry demote to a quiet sub-line.
     The row NEVER wraps — the toggle is the product and it owns the top-right, always. */
  .pos-row{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:nowrap}
  .pos-head{font-weight:700;font-size:15.5px;min-width:0}
  .pos-head .long{color:var(--good)} .pos-head .short{color:var(--bad)}
  .pos-sub{color:var(--muted);font-weight:400;font-size:12px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  /* The toggle is the one accent-colored control on the card — sized like the key feature it is. */
  .switch{width:52px;height:28px;border-radius:999px;background:#1e3d45;position:relative;cursor:pointer;transition:background .15s ease-out,box-shadow .2s;flex:none}
  .switch .knob{position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#8fa6a3;transition:left .15s cubic-bezier(.3,1.4,.6,1),background .15s ease-out}
  .switch.on{background:var(--accent);box-shadow:0 0 14px rgba(80,210,193,.35)} .switch.on .knob{left:27px;background:var(--accent-ink)}
  .switch.busy{pointer-events:none}
  .switch.busy .knob{animation:pulse 1s ease-in-out infinite}
  /* One-time coach bubble: standard product-tour grammar — caret points up at the toggle,
     right-aligned beneath it. Dies on first flip, never returns. */
  .coach{position:relative;display:flex;align-items:center;gap:8px;margin:12px 0 2px auto;width:max-content;background:#081418;border:1px solid var(--line);border-radius:8px;padding:8px 6px 8px 13px;font-size:12.5px;color:var(--text);box-shadow:0 10px 26px rgba(0,0,0,.5)}
  .coach:before{content:"";position:absolute;top:-6px;right:19px;width:10px;height:10px;background:#081418;border-left:1px solid var(--line);border-top:1px solid var(--line);transform:rotate(45deg)}
  .coach .coach-x{color:var(--muted);cursor:pointer;padding:2px 8px;font-size:14px;line-height:1}
  /* Credit hero: one number owns the active card; its label rides the blank space beside it. */
  .cred{margin-top:12px;display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
  .cred .cred-num{font-size:26px;font-weight:700;letter-spacing:-.4px;color:var(--accent);font-variant-numeric:tabular-nums}
  .cred .cred-sub{font-size:12px;color:var(--muted)}
  /* Live-data dot on the card eyebrow: this is a live position on this address, wordlessly. */
  .livedot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent);margin-right:7px;vertical-align:1px;animation:lpulse 2s ease-in-out infinite}
  @keyframes lpulse{0%,100%{opacity:1}50%{opacity:.35}}
  /* Price rail — a RANGE INSTRUMENT, not a bar: end ticks mark floor (loss end, red) and cap
     (upside end, mint); the live mark is a white dot with its price + "live" tag riding it. */
  .rail{margin-top:14px}
  .rail-track{position:relative;height:10px;border-radius:999px;background:#132e35;border:1px solid var(--line);margin-top:28px}
  .rail-tick{position:absolute;top:-5px;width:3px;height:20px;border-radius:2px}
  .rail-tick.tfloor{background:var(--bad)} .rail-tick.tcap{background:var(--accent)}
  .rail-px{position:absolute;top:0;width:10px;height:10px;border-radius:50%;background:#fff;transform:translateX(-5px);box-shadow:0 0 8px rgba(255,255,255,.55);transition:left 1.2s linear}
  .rail-pxlab{position:absolute;top:-24px;left:50%;transform:translateX(-50%);font-size:11px;color:var(--text);font-variant-numeric:tabular-nums;white-space:nowrap}
  .rail-pxlab em{font-style:normal;color:var(--accent);font-size:9px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;margin-left:3px}
  .rail-ends{display:flex;justify-content:space-between;margin-top:9px;font-size:11.5px;color:var(--muted)}
  .rail-ends b{color:var(--text);font-size:12.5px}
  /* Inline mini vesting bar: exactly one full-width horizontal element on the card (the rail). */
  .minibar{display:inline-block;width:56px;height:6px;border-radius:999px;background:#132e35;border:1px solid var(--line);vertical-align:1px;margin-right:8px;overflow:hidden}
  .minibar>span{display:block;height:100%;background:linear-gradient(90deg,#1b7f74,var(--accent));border-radius:999px}
  /* Settlement ticket: numbers over sentences when a cycle concludes. */
  .ticket{margin-top:12px;border:1px solid var(--line);border-radius:8px;padding:12px 14px;background:var(--panel2)}
  .ticket .t-title{font-size:12px;color:var(--muted);margin-bottom:8px}
  .ticket .t-figs{display:flex;gap:28px}
  .ticket .t-fig b{display:block;font-size:17px;font-variant-numeric:tabular-nums}
  .ticket .t-fig span{font-size:11px;color:var(--muted)}
  .ticket .t-sub{font-size:11.5px;color:var(--muted);margin-top:8px}
  /* Full-width conversion CTA under the simulation payoff moment. */
  .cta{display:block;width:100%;margin-top:14px;padding:12px;font-size:14px;border-radius:8px;text-align:center}
  /* Accent discipline: while the card CTA is on screen, the nav Connect demotes to outline. */
  .connbtn.ghosted{background:transparent;color:var(--accent);border:1px solid rgba(80,210,193,.5)}
  /* Dismissible geo notice. */
  .geo-x{float:right;color:var(--muted);cursor:pointer;font-size:16px;line-height:1;padding:0 2px 4px 10px}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
  .spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(80,210,193,.25);border-top-color:var(--accent);border-radius:50%;margin-right:7px;vertical-align:-1.5px;animation:spinr .7s linear infinite}
  @keyframes spinr{to{transform:rotate(360deg)}}
  /* Nav connect — dApp-standard upper-right chrome. Opens the address flow (public data, no
     signing); swapping in the visitor's own address is the conversion action. */
  .connbtn{background:var(--accent);color:var(--accent-ink);font-weight:700;font-size:12.5px;border:0;border-radius:999px;padding:6.5px 15px;cursor:pointer;white-space:nowrap}
  .connbtn:hover{filter:brightness(1.08)}
  .connbtn.connected{background:transparent;color:var(--muted);border:1px solid var(--line);font-weight:600;font-size:12px;padding:5.5px 13px}
  body.inst #connPill{background:transparent;color:var(--muted);border:1px solid var(--line);font-weight:600;font-size:12px;cursor:default}
  /* The simulation lane's one honesty label: quiet, persistent, unmistakable. */
  .simlabel{font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);margin-top:12px}
  .simlabel:before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#e3c34c;margin-right:6px;vertical-align:1px}
  /* Landing skeleton — the app boots into a live position, never an empty entry gate. */
  .skl{height:12px;border-radius:6px;background:linear-gradient(90deg,var(--panel2) 25%,#16333b 50%,var(--panel2) 75%);background-size:200% 100%;animation:shim 1.2s linear infinite;margin:12px 0}
  @keyframes shim{to{background-position:-200% 0}}
  /* Preview controls — same texture as the position card (segmented side, $ amount, terms grid) */
  .seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
  .seg button{background:var(--panel2);color:var(--muted);border:0;padding:8px 16px;font-size:12.5px;font-weight:700;cursor:pointer;letter-spacing:.3px}
  .seg button.on{background:rgba(80,210,193,.14);color:var(--accent)}
  .pv-amt{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:8px;background:var(--panel2);padding:0 4px 0 12px}
  .pv-amt>span{color:var(--muted);font-size:13.5px}
  .pv-amt input{background:transparent;border:0;outline:0;color:var(--text);font-size:13.5px;font-weight:600;padding:8px 8px 8px 3px;width:88px}
  .chip{margin-top:12px;border-radius:6px;padding:10px 12px;font-size:13px;background:var(--panel2);border:1px solid var(--line);color:var(--muted);transition:all .3s}
  /* Lifecycle status chips: one line always — parallel copy plus a nowrap belt, so the card
     never jumps between one- and two-line states as the message changes. */
  .chip.oneline{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
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
  .tipwrap .tip{display:none;position:absolute;bottom:135%;left:50%;transform:translateX(-50%);width:240px;max-width:70vw;background:#081418;border:1px solid var(--line);border-radius:8px;padding:9px 11px;font-size:12px;font-weight:400;color:var(--text);line-height:1.5;z-index:30;box-shadow:0 10px 28px rgba(0,0,0,.55);text-align:left;text-transform:none;letter-spacing:0;white-space:normal}
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
    .mode-pill{font-size:10px;padding:3px 8px;margin-right:5px}
    .wrap{padding:0 12px 44px}
    h1{font-size:20px} .sub{font-size:13px}
    .card{padding:13px 14px}
    .terms{grid-template-columns:1fr 1fr;gap:6px}
    .terms .term:first-child{grid-column:1 / -1}
    th,td{padding:6px 4px;font-size:12px}
  }
  /* 390px-first: the header must hold logo · live mark · Connect on ONE line. */
  @media (max-width:420px){
    .logo .by{display:none}
    .nav-in{flex-wrap:nowrap}
    .px{margin-right:7px}
    .connbtn{padding:6px 12px;font-size:12px}
  }
  .mode-pill{font-size:11px;font-weight:700;letter-spacing:.6px;border-radius:999px;padding:3.5px 11px;margin-right:8px}
  .mode-paper{background:rgba(217,171,1,.14);color:#e3c34c;border:1px solid rgba(217,171,1,.4)}
  .mode-demo{background:rgba(80,210,193,.1);color:var(--accent);border:1px solid rgba(80,210,193,.35)}
  .mode-live{background:rgba(46,189,133,.12);color:var(--good);border:1px solid rgba(46,189,133,.4)}
  .coverage{margin-top:10px;font-size:12.5px;color:var(--accent)}
  table{width:100%;border-collapse:collapse;margin-top:6px;font-size:13px}
  th,td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line)} th{color:var(--muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px}
  .status-paid{color:var(--good);font-weight:600} .status-accrued{color:var(--accent)} .status-failed{color:var(--bad)}
  /* HL grammar: chrome stays muted, brand pulses in small strokes — a vertical mint bar, not
     colored text. Sentence case: the honesty label is the only element allowed to shout. */
  h2{font-size:14.5px;font-weight:700;margin:24px 0 8px;color:var(--text);border-left:3px solid var(--accent);padding-left:9px}
  .foot{color:var(--muted);font-size:11.5px;margin-top:32px;border-top:1px solid var(--line);padding-top:16px}
  .badge{display:inline-block;font-size:10.5px;font-weight:700;border-radius:999px;padding:2.5px 9px;margin-left:8px;vertical-align:2px}
  .badge.founding{background:rgba(80,210,193,.12);color:var(--accent);border:1px solid rgba(80,210,193,.4)}
  .empty{color:var(--muted);font-size:13.5px;padding:6px 0}
  /* Pre-connect intro trio + demonstration toggle panel (retail) */
  .trio{color:var(--muted);font-size:13px;padding:4px 0}
  .trio b{color:var(--text)}
  .credit-hero b{font-size:19px;letter-spacing:-.3px}
  .demo-vest div{transition:width 2.4s cubic-bezier(.2,.7,.3,1)}
</style>
</head>
<body>
<nav><div class="nav-in">
  <!-- Venue affiliation is DESCRIPTIVE ("for Hyperliquid" — where your positions live), not a
       partnership claim; swap the venue name per integration. The brand mark after "by" is
       injected by the service: the Atticus logo (EP_BRAND_LOGO_URL) or the wordmark fallback. -->
  <div class="logo">Earn &amp; Protect <span class="by">__BRAND_LINE__ <b>__BRAND_FOR__</b> · by __BRAND_MARK__</span></div>
  <div style="display:flex;align-items:center">
    <span class="px" id="pxPill" style="display:none">BTC <b id="pxVal">—</b></span>
    <span class="mode-pill tipwrap" id="modePill" style="display:none"></span>
    <button type="button" class="connbtn" id="connPill">Connect</button>
  </div>
</div></nav>
<div class="wrap">
  <header id="hero">
    <h1 id="heroH1">One toggle. A hard floor. <span style="color:var(--accent)">And it pays.</span></h1>
    <p class="sub" id="heroSub">Look up any Hyperliquid address. Flip protection on. Get paid daily.</p>
  </header>

  <div class="card" id="geoBanner" style="display:none">
    <span class="geo-x" id="geoX" role="button" aria-label="dismiss">×</span>
    <b id="geoTitle">Not available in your region.</b> <span class="muted small" id="geoMsg"></span>
  </div>

  <!-- Pre-connect intro (retail fallback only): shown when the operating landing cannot load —
       a visitor should land inside the product, not on a brochure. -->
  <div class="card" id="introTrio" style="display:none">
    <div class="trio"><b>Floor</b> · hard price under your position.</div>
    <div class="trio"><b>Credit</b> · funded by the options market, never by you.</div>
    <div class="trio"><b>Cap</b> · a touch pays vested credit, re-arms. New floor. New credit.</div>
  </div>

  <!-- Preview: a hypothetical size off the live book. Preview-only by construction —
       wrapping always requires a live venue-read position. -->
  <div class="card" id="previewCard" style="display:none">
    <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px">
      <span class="small muted" id="pvHeader">What a position would earn. Live quote · nothing opens.</span>
      <a href="#" id="pvClear" class="small" style="display:none;color:var(--muted);text-decoration:none;border-bottom:1px dotted var(--line)">clear</a>
    </div>
    <div class="row" style="align-items:center">
      <div class="seg" id="pvSeg"><button type="button" class="on" data-side="long">Long</button><button type="button" data-side="short">Short</button></div>
      <div class="pv-amt"><span>$</span><input id="pvUsd" value="100,000" inputmode="numeric" title="Position size in USD" aria-label="Position size in USD"></div>
      <span class="small muted" id="pvNoun">position</span>
      <button class="btn" id="pvBtn">Preview credit</button>
    </div>
    <div id="pvOut"></div>
    <div class="small muted" id="refRow" style="display:none;margin-top:12px"><a href="#" id="refLink" style="color:var(--accent);text-decoration:none">The same engine is pricing a live nine-figure reference position right now. View it →</a></div>
  </div>

  <div class="card" id="verifyCard" style="display:none;border-color:rgba(80,210,193,.45)">
    <b>Verify your wallet</b> <span class="muted small">One signature proves you own this address and signs the <a href="/tos" target="_blank" rel="noopener">Terms</a>. It cannot move funds. Needed once; then you can manage protection from any device (including Telegram).</span>
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

  <h2><span id="posTitle">Your positions</span> <span class="small muted" id="cohortLine" style="font-weight:400"></span></h2>
  <div class="card" id="watchStrip" style="display:none;border-color:rgba(80,210,193,.35)">
    <b id="wsTitle">Live position · public address</b> <span class="muted small" id="wsBody">Read-only, live pricing. Flip the toggle to see protection at work (simulation · nothing opens). Connect your address to see your own positions.</span>
    <a href="#" id="nextWhale" class="small" style="display:none;color:var(--accent);text-decoration:none;margin-left:6px">view another position →</a>
    <a href="#" id="stopViewing" class="small" style="display:none;color:var(--accent);text-decoration:none;margin-left:10px">stop viewing ×</a>
  </div>
  <div id="positions"><div class="empty">Look up an address to see its open positions.</div></div>

  <h2 id="payoutsH">Payouts</h2>
  <div class="card" id="payoutsCard" style="padding-top:10px">
    <table><thead><tr><th>when</th><th>cycle</th><th>credit</th><th>status</th><th>tx</th></tr></thead>
    <tbody id="payouts"><tr><td colspan="5" class="empty">Credits land here at each cycle's close.</td></tr></tbody></table>
  </div>

  <div class="foot">
    Priced live from listed markets · refused honestly when unfundable · __LINK_TG____LINK_X__<a href="#" id="howLink">How it works</a> · <a href="/tos" target="_blank" rel="noopener">Terms</a>
  </div>
</div>

<div class="modal-veil" id="howVeil"><div class="modal">
  <h3>How Earn &amp; Protect works</h3>
  <ul id="howList">
    <li><b>Read-only.</b> We read your positions from Hyperliquid's public API. No signing, no deposits, no keys. Payouts go only to your own wallet.</li>
    <li><b>Live-market pricing.</b> Every protection cycle is quoted from listed option order books at the moment you toggle. When the market can't fund a credit, we refuse and say why.</li>
    <li><b>Paid daily, never upfront.</b> Your credit unlocks through each daily cycle and pays automatically at its close.</li>
    <li><b>The cap ends the cycle, not your trade.</b> If price touches your cap, that cycle ends: you keep your position, every gain, and the unlocked credit; protection re-arms at the new price while the toggle stays on. You never owe anything.</li>
    <li><b>Honest economics.</b> We keep a published share of the credit we source (waived when tiny); founding wallets keep a reduced rate<span id="rateNote"></span>.</li>
    <li>Derivatives involve risk. Nothing here is investment advice.</li>
  </ul>
  <button class="btn ghost" id="howClose">Close</button>
</div></div>

<!-- Close confirmation (in-app, both real and sim paths): the native browser confirm is
     off-brand and lets Chrome inject its own "suppress dialogs" control. This dialog is the
     money-consequence moment, so it always shows and always states the numbers. -->
<div class="modal-veil" id="cfmVeil"><div class="modal">
  <h3>Turn protection off?</h3>
  <div class="small muted" id="cfmBody" style="line-height:1.6"></div>
  <div class="row" style="margin-top:16px">
    <button class="btn" id="cfmYes">Turn off</button>
    <button class="btn ghost" id="cfmNo">Keep protection</button>
  </div>
</div></div>

<!-- Connect modal (retail): the address-paste flow behind the nav's Connect chrome. HL's own
     lookup grammar — an ADDRESS is public data, never a "wallet". No keys, no signing. -->
<div class="modal-veil" id="connVeil"><div class="modal" id="connectCard">
  <h3>Connect · read-only</h3>
  <div class="row">
    <input type="text" id="addrInput" placeholder="0x… your Hyperliquid address" title="An address is public data: the same thing you'd paste into an explorer. We read positions, never touch them. Find yours in the Hyperliquid app: top right, starts with 0x." spellcheck="false">
    <button class="btn" id="connectBtn">Look up</button>
    <button class="btn ghost" id="forgetBtn" style="display:none">Disconnect</button>
  </div>
  <div class="small muted" style="margin-top:10px">Public data. Read-only. No keys, no signing, no deposits. Payouts only ever to the address.
    <span class="tipwrap"><span class="info">i</span><span class="tip">Hyperliquid&#39;s safety docs are right: never share keys or sign unknown transactions. We ask for neither. An address is public data, the same thing you&#39;d paste into Hypurrscan. Find yours in the Hyperliquid app: top right, starts with 0x.</span></span>
  </div>
  <div class="small muted" id="connectMsg" style="margin-top:8px"></div>
  <button class="btn ghost" id="connClose" style="margin-top:14px">Close</button>
</div></div>
<script>
const MINIAPP = ${miniapp ? "true" : "false"};
const TG = MINIAPP && window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
if (TG) { try { TG.ready(); TG.expand(); } catch (e) {} }
const haptic = (kind) => { if (TG && TG.HapticFeedback) { try { kind === "impact" ? TG.HapticFeedback.impactOccurred("medium") : TG.HapticFeedback.notificationOccurred(kind); } catch (e) {} } };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmt$ = (x) => x == null ? "—" : (x < 0 ? "−$" : "$") + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPx = (x) => x == null ? "—" : "$" + Number(x).toLocaleString("en-US", { maximumFractionDigits: 1 });
// Compact notional: whale numbers never wrap the position row ($132.4M, not $132,421,439.09).
const fmtC = (x) => x == null ? "—" : x >= 1e9 ? "$" + (x / 1e9).toFixed(2) + "B" : x >= 1e6 ? "$" + (x / 1e6).toFixed(1) + "M" : "$" + Math.round(x).toLocaleString("en-US");
const fmtSz = (x) => Number(x).toLocaleString("en-US", { maximumFractionDigits: 2 });
const short = (a) => a ? a.slice(0,6) + "…" + a.slice(-4) : "";
// One-time coach mark state: dies on first flip (or explicit dismiss), never returns.
const coachDone = () => { try { return localStorage.getItem("ep_coach_v1") === "1"; } catch (e) { return true; } };
const markCoachDone = () => { try { localStorage.setItem("ep_coach_v1", "1"); } catch (e) { /* private mode */ } };

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
  if (/verify_required/i.test(s)) return "Verify your wallet first · one signature, one time";
  if (/close_locked/i.test(s)) return "Turn off from the device that turned protection on · it pays out on its own either way";
  if (/close_unwind_failed|couldn't close the hedge cleanly/i.test(s)) return "Couldn't close cleanly right now · you're still protected · try again shortly";
  if (/tos_required|Terms of Service/i.test(s)) return "Please accept the Terms first";
  if (/waitlisted|#\d+ in line/i.test(s)) { const m = s.match(/#(\d+) in line/); return m ? "Founding cohort full · you're #" + m[1] + " in line" : "Founding cohort full · you're on the waitlist"; }
  if (/showcase_wallet|public wallet on watch/i.test(s)) return "Public wallet · watching only";
  if (/invalid_size/i.test(s)) return "Preview sizes up to $500M · try a smaller amount";
  if (/geo_blocked|not available in your region|verify your location/i.test(s)) return "Not available in your region";
  if (/kill switch|demo disabled|paused/i.test(s)) return "Protection paused";
  if (/rate_limited/i.test(s)) return "Slow down a moment";
  return "Couldn't complete · nothing opened";
};

const stageLabel = {wrap_requested:"Requested",position_read:"Position read",quoted:"Priced off the live book",hedge_executing:"Hedge executing",hedge_locked:"Hedge locked",green_light:"Protection live",vesting:"Credit vesting",failed:"Refused",knocked_out:"Cap touched · cycle over",concluded:"Concluded"};

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
// WATCH mode: a public leaderboard wallet on display — everything renders (positions, live
// pricing), every action is disabled. Ownership is asserted by pasting, never by watching.
// Watching only ever starts from a click THIS session — a stored address alone never enters it.
let watching = false;
let watchWallets = [];
let userEntered = false; // an address typed or chip-clicked in this session (vs restored storage)
// LANDING (retail): the visitor arrives inside the operating product — a live public BTC
// position with the toggle — never an empty address gate. Their own stored address always wins.
let booting = false;        // skeleton phase: showcase set loading on first paint
let landingFailed = false;  // no live showcase available — fall back to the connect-first page
let autoLanded = false;     // this session landed on the showcase address automatically
let landTried = 0;          // showcase wallets tried this session (dead-position failover)
// SIMULATION LANE state: full lifecycle visuals (quote → executing → active → vesting) fed by a
// REAL live preview quote — never the real wrap path (server guards on showcase wallets stay
// armed regardless). Keyed by address so the 5s poll re-render can't undo a running simulation.
const sims = {};
const simFor = (a) => (a && sims[a.toLowerCase()]) || null;
const simVest = (s) => {
  const now = Date.now();
  const total = Math.max(1, s.endMs - s.vestStartMs);
  const fraction = Math.min(1, Math.max(0, (now - s.vestStartMs) / total));
  return { fraction, vestedUsdc: (s.quote ? s.quote.creditUsdc : 0) * fraction, remainingMs: Math.max(0, s.endMs - now) };
};
const PV_MAX_USD = 500000000; // server's preview sanity ceiling — mirrored for whale-size requests
let lastPos = [];      // freshest poll payloads — instant re-renders for the simulation lane
let lastState = null;
// SKIN: "retail" (HL, default) or "institutional" (partner demo instances). The institutional
// register: counterparties and treasuries, never whales; viewing, never watching; no retail promos.
const SKIN = "__SKIN__";
const INST = SKIN === "institutional";
if (INST) {
  document.body.classList.add("inst");
  $("heroH1").innerHTML = 'Institutional asset protection. <span style="color:var(--accent)">One action.</span>';
  $("heroSub").textContent = "A hard floor and a daily credit on custodied holdings and trading positions. Read-only: assets never move.";
  // Treasury lane leads: the model card is the primary, always-open flow at treasury scale.
  $("previewCard").style.display = "";
  $("pvHeader").textContent = "Model a holding · live market pricing. Nothing opens, nothing is stored.";
  $("pvUsd").value = "10,000,000";
  $("pvNoun").textContent = "holding";
  // Proof lives as one quiet link under the model result; loading/errors surface on the link itself.
  $("refRow").style.display = "";
  $("refLink").onclick = async (e) => {
    e.preventDefault();
    const l = $("refLink");
    const orig = l.textContent;
    if (watchWallets.length === 0) {
      l.textContent = "pricing a live reference position…";
      const ok = await fetchShowcase(0);
      if (!ok) {
        l.textContent = "No live reference available right now · try again shortly.";
        setTimeout(() => { l.textContent = orig; }, 4000);
        return;
      }
      l.textContent = orig;
    }
    watchWallet(0);
  };
  $("wsTitle").textContent = "Viewing a public reference position";
  $("wsBody").textContent = "Read-only, live pricing on a real position. Look up a client address to see theirs.";
  $("nextWhale").textContent = "view another position →";
  // Institutional How-it-works: exposure sources stated honestly (vault-side reads = the pilot).
  $("howList").innerHTML =
    '<li><b>Read-only.</b> Exposure is read from public venue APIs. No keys, no deposits, no custody movement. Direct vault-side balance integration is scoped in the design-partner pilot.</li>' +
    '<li><b>Live-market pricing.</b> Every protection cycle is priced from listed option order books at the moment of activation. When the market cannot fund a credit, we refuse and say why.</li>' +
    '<li><b>Delta neutral by construction.</b> Every protection is hedged leg for leg on listed options (OKX today; FalconX block execution as volume nets up). Revenue is a published fee on credits, never trading P&amp;L.</li>' +
    '<li><b>Paid daily, never upfront.</b> The credit vests through each cycle and settles automatically at its close, only to the holder\\u2019s address.</li>' +
    '<li><b>The cap ends the cycle, not the holding.</b> A cap touch concludes that cycle: the holder keeps the assets, gains, and vested credit; protection re-arms automatically.<span id="rateNote" style="display:none"></span></li>' +
    '<li>Derivatives involve risk. Nothing here is investment advice.</li>';
}
let verifyOffered = false; // surfaced when a close is refused cross-device — optional path to manage from anywhere

// One status writer: the flash strip in the main flow (the connect flow now lives in a modal,
// so action feedback must land on the page itself), mirrored into the modal's message line.
const setMsg = (t, isErr, working) => {
  const html = t ? (working ? '<span class="spin"></span>' : "") + esc(t) : "";
  $("connectMsg").innerHTML = html;
  const f = $("flash");
  f.innerHTML = html;
  f.style.display = t ? "" : "none";
  f.className = "flash" + (isErr ? " bad" : "");
};

const setConn = () => {
  // Nav chrome: dApp-standard Connect, upper right. The showcase landing still reads "Connect" —
  // swapping in the visitor's own address IS the conversion action. INST keeps a quiet status pill.
  const pill = $("connPill");
  pill.classList.remove("connected");
  pill.classList.remove("ghosted");
  if (INST) pill.textContent = watching ? short(account) + " · viewing" : "not connected";
  else if (account && !watching) {
    pill.textContent = short(account) + " · read-only";
    pill.classList.add("connected");
  } else pill.textContent = "Connect";
  $("forgetBtn").style.display = account && !watching ? "" : "none";
  if (account && !watching) $("addrInput").value = account;
  // INST: the model card IS the home screen — visible whenever not in viewing mode.
  if (INST) $("previewCard").style.display = watching ? "none" : "";
  // WATCH chrome: header + strip state the mode; no owner-only sections for a public address
  // (payouts/consent are meaningless for a wallet that isn't yours).
  $("posTitle").textContent = watching
    ? (INST ? "Viewing · " + short(account) + " · public reference" : "Positions")
    : booting && !account ? "Positions" : "Your positions";
  $("cohortLine").style.display = watching || INST ? "none" : "";
  $("watchStrip").style.display = INST && watching ? "" : "none";
  $("nextWhale").style.display = INST && watching && watchWallets.length > 1 ? "" : "none";
  $("stopViewing").style.display = INST && watching ? "" : "none";
  // Owner-only sections never show empty to a visitor. The retail landing shows the positions
  // block from the first paint (skeleton, then the live showcase card) — never an empty gate;
  // the intro trio survives only as the fallback when no live showcase is available.
  const noOwnerSections = (INST && !watching) || (!INST && !account && !booting);
  // The showcase landing drops the section heading entirely — the card is self-describing
  // (identity rides its eyebrow); a heading over one card is furniture.
  $("posTitle").parentElement.style.display = noOwnerSections || (!INST && watching) ? "none" : "";
  $("positions").style.display = noOwnerSections ? "none" : "";
  $("payoutsH").style.display = watching || INST || !account ? "none" : "";
  $("payoutsCard").style.display = watching || INST || !account ? "none" : "";
  $("introTrio").style.display = !INST && !account && landingFailed ? "" : "none";
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

// ONE builder for the ACTIVE protection card — the simulation is a live replica, so the real
// wrap and the sim render identical markup: a credit hero (one number owns the card), the
// floor–price–cap rail (one picture answers "where am I protected, where's price now"), and the
// vesting line. o.sim only changes tooltip wording and the ticker hooks.
const activeBody = (o) => {
  const lo = Math.min(o.floorStrike, o.capStrike), hi = Math.max(o.floorStrike, o.capStrike);
  const railPos = (px) => Math.min(94, Math.max(6, ((px - lo) / Math.max(1, hi - lo)) * 100)).toFixed(1);
  const pctOf = (strike) => ((strike - o.quoteSpot) / o.quoteSpot) * 100;
  const sign = (x) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(1) + "%";
  const startWord = o.sim ? "when this simulation started" : "when protection started";
  const leftIsFloor = o.floorStrike <= o.capStrike;
  // Dollar strikes are what people scan; the struck-% detail lives in the tooltips. A tooltip's
  // direction follows the rail's GEOMETRY: the right-end label opens leftward, the left-end
  // label opens centered — for longs and shorts alike (shorts put the cap on the left).
  const floorLab = '<span><b>' + fmtPx(o.floorStrike) + '</b> floor' +
    infoTip("Losses stop here. Struck " + sign(pctOf(o.floorStrike)) + " from the live price " + startWord + " (" + fmtPx(o.quoteSpot) + ").", !leftIsFloor) + '</span>';
  const capLab = '<span><b>' + fmtPx(o.capStrike) + '</b> cap' +
    infoTip("Touching " + fmtPx(o.capStrike) + " (" + sign(pctOf(o.capStrike)) + ") ends the cycle early: " + (o.sim ? "the holder keeps" : "you keep") + " the position, every gain to the cap, and the credit unlocked to that moment. Protection re-arms automatically while the toggle stays on.", leftIsFloor) + '</span>';
  const px = o.livePx != null ? o.livePx : o.quoteSpot;
  const creditTip = o.sim
    ? "Funded by the options market, never by the holder. In the live product the credit unlocks through the day and pays automatically at the cycle's close, never upfront."
    : "Funded by the options market, not by us. Unlocks through the day and pays to this wallet automatically at the cycle's close, never upfront.";
  // Floor tick = loss end (red), cap tick = upside end (mint) — the only color on the rail.
  const tickL = '<div class="rail-tick ' + (leftIsFloor ? "tfloor" : "tcap") + '" style="left:-1px"></div>';
  const tickR = '<div class="rail-tick ' + (leftIsFloor ? "tcap" : "tfloor") + '" style="right:-1px"></div>';
  return '<div class="cred"><b class="cred-num' + (o.sim ? ' sim-cred' : '') + '">' + fmt$(o.creditUsdc) + '</b>' +
      '<span class="cred-sub">today\\u2019s credit' + infoTip(creditTip) + (o.badge || "") + '</span></div>' +
    '<div class="rail" data-lo="' + lo + '" data-hi="' + hi + '">' +
      '<div class="rail-track">' + tickL + tickR +
        '<div class="rail-px" style="left:' + railPos(px) + '%"><span class="rail-pxlab"><span class="rail-pxval">' + fmtPx(px) + '</span><em>live</em></span></div>' +
      '</div>' +
      '<div class="rail-ends">' + (leftIsFloor ? floorLab + capLab : capLab + floorLab) + '</div>' +
    '</div>' +
    // Two anchored sides: static text left, the amount pinned right ("$7.22 unlocked"). A
    // right-aligned number grows LEFTWARD into the empty middle, so nothing on the line ever
    // moves as the credit vests — no reserved gap, one line at 390px.
    '<div class="unlock" style="margin-top:12px;display:flex;justify-content:space-between;align-items:center;gap:10px;white-space:nowrap">' +
      '<span><span class="minibar"><span class="' + (o.sim ? "sim-fill" : "") + '" style="width:' + (o.fraction * 100).toFixed(2) + '%"></span></span>' +
        tip(o.fullyVested ? "pays at settlement" : '<span class="' + (o.sim ? "sim-eta" : "") + '">pays in ' + fmtDur(o.remainingMs) + '</span>', o.settleTip) + '</span>' +
      '<span><b class="' + (o.sim ? "sim-vested" : "") + '" style="color:var(--accent);font-variant-numeric:tabular-nums">' + fmt$(o.vestedUsdc) + '</b> unlocked</span>' +
    '</div>';
};

const render = (positions, state) => {
  const el = $("positions");
  // The 5s poll rebuilds this HTML; an open tooltip must survive the rebuild or every tip dies
  // mid-read (worst on phones, where reading takes longer than the poll interval).
  const prevOpenTip = el.querySelector(".tipwrap.open .tip");
  const prevOpenText = prevOpenTip ? prevOpenTip.textContent : null;
  if (!account) { el.innerHTML = '<div class="empty">Look up an address to see its open positions.</div>'; return; }
  // WATCH mode shows only the wrappable (BTC) position — the one the chip advertised. A fund
  // wallet's dozen other coins are noise around the demo.
  if (watching) positions = (positions || []).filter((p) => p.wrappable);
  if (!positions || positions.length === 0) {
    el.innerHTML = '<div class="empty">' + (watching ? "No open BTC position on this address right now." : "No open perp positions on " + esc(short(account)) + ".") + '</div>';
    return;
  }
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
      receipt = '<details class="receipt"><summary>Hedge receipt · how this protection is built</summary><table class="receipt-tbl">' +
        '<thead><tr><th>leg</th><th>listed instrument</th><th>premium</th><th>order ref</th><th></th></tr></thead><tbody>' +
        w.legs.map((l) =>
          '<tr><td>' + (legLabel[l.role] || esc(l.role)) + '</td><td><code>' + esc((l.instId || "—").replace(" (model)", "")) + '</code></td><td>' + fmt$(l.premiumUsdc) + '</td><td><code>' + esc(l.orderId || "—") + '</code></td><td class="' + (l.real ? "tag-real" : "tag-sim") + '">' + (l.real ? "REAL" : "SIMULATED") + '</td></tr>'
        ).join("") +
        '</tbody></table><div class="trust" style="margin-top:6px">Sold premium funds the bought floor; the surplus is your credit. Every row reconciles against the venue\\u2019s own fill and settlement records.</div></details>';
    }
    if (isWrapCoin && w) {
      if (w.status === "active" && v && q) {
        const capStrike = q.capStrike ?? q.callStrike, floorStrike = q.floorStrike ?? q.putStrike;
        const foundingBadge = founding && caps && !INST
          ? " " + tip('<span class="badge founding">FOUNDING RATE</span>',
              "You're one of our first " + caps.foundingWallets + " wallets, so you keep " + (100 - caps.foundingTakeRatePct * 100).toFixed(0) + "% of every credit instead of " + (100 - caps.takeRatePct * 100).toFixed(0) + "%, locked in for 12 months. And when our cut would be under 5\\u00a2, we skip it: you keep it all.")
          : "";
        const settleIso = w.vesting && w.vesting.endMs ? new Date(w.vesting.endMs).toUTCString().replace(":00 GMT", " UTC") : null;
        terms = activeBody({
          creditUsdc: q.creditUsdc, floorStrike, capStrike, quoteSpot: q.spot, livePx: p.markPx,
          vestedUsdc: v.vestedUsdc, fraction: v.fraction, remainingMs: v.remainingMs, fullyVested: v.fullyVested,
          settleTip: settleIso ? "Settles at the listed expiry: " + settleIso + ". The credit lands in the payouts table below, then protection renews automatically." : "Pays at the cycle's close.",
          sim: false, badge: foundingBadge
        });
        const note = w.hedge && w.hedge.sizeNote;
        if (note) coverage = '<div class="coverage">' + esc(note) + '</div>';
      } else if (w.status === "quoting" || w.status === "executing") {
        // Spinner + live seconds counter (server-truth: elapsed since the wrap request landed).
        chip = '<div class="chip on oneline"><span class="spin"></span>' +
          (w.status === "executing" ? "Placing hedge legs" : "Pricing the live book") +
          ' <span class="els" data-ts="' + (w.createdAtMs || Date.now()) + '"></span></div>';
      } else if (w.status === "knocked_out") {
        const ko = w.knockout || {};
        chip = '<div class="chip">Cap $' + (ko.capStrike ?? "?") + ' touched · cycle over. You kept every gain to the cap' + (v ? ' + ' + fmt$(v.vestedUsdc) + ' credit' : '') + '. Re-arms automatically while the toggle is on.</div>';
      } else if (w.status === "concluded" && v) {
        chip = '<div class="chip">' + (v.fullyVested ? "Cycle complete · earned " + fmt$(v.fullCreditUsdc) + " in full" : "Closed early · kept " + fmt$(v.vestedUsdc) + " of " + fmt$(v.fullCreditUsdc)) + '</div>';
      } else if (w.status === "failed" && w.failReason) {
        chip = '<div class="chip bad" title="' + esc(w.failReason) + '">' + esc(humanChip(w.failReason)) + '</div>';
        tooltip = w.failReason;
      }
    }
    // INST viewing keeps the would-be protection terms panel (filled async by renderWatchTerms).
    if (watching && INST) terms = '<div id="watchTerms"><div class="small muted" style="margin-top:10px"><span class="spin"></span>pricing protection on this position…</div></div>';
    // SIMULATION LANE (retail showcase): the toggle renders and behaves exactly as the live
    // product — flipping it walks the full lifecycle (quote → executing → active → vesting) on a
    // REAL live preview quote, never the wrap path. One quiet persistent honesty label.
    const s = !INST && watching && isWrapCoin ? simFor(account) : null;
    if (s) {
      const simLabel = '<div class="simlabel">simulation · live pricing</div>';
      if (s.phase === "quoting") {
        chip = simLabel + '<div class="chip on oneline"><span class="spin"></span>Pricing the live book <span class="els" data-ts="' + s.startedMs + '"></span></div>';
      } else if (s.phase === "executing") {
        chip = simLabel + '<div class="chip on oneline"><span class="spin"></span>Placing hedge legs <span class="els" data-ts="' + s.startedMs + '"></span></div>';
      } else if (s.phase === "refused") {
        // The refusal is REAL — the live pricing engine declined; no simulation label needed.
        chip = '<div class="chip bad" title="' + esc(s.reason || "") + '">' + esc(humanChip(s.reason)) + '</div>';
      } else if (s.phase === "closing") {
        chip = simLabel + '<div class="chip on oneline"><span class="spin"></span>Unwinding hedge legs <span class="els" data-ts="' + s.startedMs + '"></span></div>';
      } else if (s.phase === "closed") {
        // Settlement ticket: numbers over sentences — the result, trade-close style.
        chip = simLabel + '<div class="ticket"><div class="t-title">Closed early</div><div class="t-figs">' +
          '<div class="t-fig"><b style="color:var(--accent)">' + fmt$(s.keptUsdc) + '</b><span>kept · unlocked credit</span></div>' +
          '<div class="t-fig"><b style="color:var(--muted)">' + fmt$(Math.max(0, s.fullUsdc - s.keptUsdc)) + '</b><span>returned to the market</span></div>' +
          '</div></div>';
      } else if (s.phase === "knocked") {
        chip = simLabel + '<div class="ticket"><div class="t-title">Cap ' + fmtPx(s.capStrike) + ' touched · cycle over</div><div class="t-figs">' +
          '<div class="t-fig"><b style="color:var(--accent)">' + fmt$(s.keptUsdc) + '</b><span>credit kept + every gain to the cap</span></div>' +
          '</div><div class="t-sub"><span class="spin"></span>re-arming at the new price…</div></div>';
      } else if (s.phase === "active" && s.quote) {
        const sq = s.quote;
        const vsim = simVest(s);
        const settleIsoS = s.endMs ? new Date(s.endMs).toUTCString().replace(":00 GMT", " UTC") : null;
        chip = simLabel;
        terms = activeBody({
          creditUsdc: sq.creditUsdc, floorStrike: sq.floorStrike, capStrike: sq.capStrike,
          quoteSpot: sq.spot, livePx: lastMarkPx != null ? lastMarkPx : p.markPx,
          vestedUsdc: vsim.vestedUsdc, fraction: vsim.fraction, remainingMs: vsim.remainingMs, fullyVested: false,
          settleTip: settleIsoS ? "The live cycle settles at the listed expiry: " + settleIsoS + "." : "Pays at the cycle's close.",
          sim: true, badge: ""
        });
        coverage = '<button type="button" class="btn cta connOpen">Connect your address</button>' +
          '<div class="small muted" style="margin-top:7px;text-align:center">Your position works the same way. Public data · no keys · no signing.</div>';
      }
    }
    const simOn = s != null && (s.phase === "quoting" || s.phase === "executing" || s.phase === "active" || s.phase === "knocked");
    const simBusy = s != null && (s.phase === "quoting" || s.phase === "executing" || s.phase === "closing");
    // The active toggle carries its unlocked/full numbers so turning OFF can state the consequence.
    const toggle = watching
      ? (INST
        ? '<span class="small muted">Viewing</span>'
        : '<div class="switch' + (simOn ? " on" : "") + (simBusy ? " busy" : "") + '" data-sim="1" role="switch" aria-checked="' + (simOn ? "true" : "false") + '"><div class="knob"></div></div>')
      : isWrapCoin
      ? '<div class="switch' + (active ? " on" : "") + (busy ? " busy" : "") + '" data-coin="' + esc(p.coin) + '" data-active="' + (active ? "1" : "0") + '"' +
        (active && v ? ' data-vested="' + v.vestedUsdc + '" data-full="' + v.fullCreditUsdc + '"' : "") +
        ' role="switch" aria-checked="' + (active ? "true" : "false") + '"><div class="knob"></div></div>'
      : '<span class="small muted">protection for ' + esc(p.coin) + ' coming soon</span>';
    // One-time coach bubble: caret points at the toggle; gone forever after the first flip.
    const coach = !INST && watching && !s && !coachDone()
      ? '<div class="coach">Try it · nothing opens <span class="coach-x" role="button" aria-label="dismiss">×</span></div>'
      : "";
    // The card is self-describing on the landing: identity rides a quiet eyebrow, not a heading;
    // the pulsing dot says "live position on this address" without a word.
    const eyebrow = !INST && watching
      ? '<div class="small muted" style="margin-bottom:9px"><span class="livedot"></span>' + short(account) + ' · public · read-only</div>'
      : "";
    return '<div class="card" title="' + esc(tooltip) + '">' + eyebrow +
      '<div class="pos-row"><div class="pos-head"><span class="' + (p.side === "long" ? "long" : "short") + '">' + p.side.toUpperCase() + '</span> ' + esc(p.coin) + ' · ' + fmtC(p.notionalUsdc) +
      '<div class="pos-sub">' + fmtSz(p.szBase) + ' ' + esc(p.coin) + (p.entryPx ? ' · entry ' + fmtPx(p.entryPx) : '') + '</div></div>' + toggle + '</div>' +
      coach + chip + terms + bar + coverage + receipt + '</div>';
  }).join("");
  // Accent discipline: one accent-filled control per screen — while the card CTA is up, the
  // nav Connect demotes to outline.
  const sAct = !INST && watching && (() => { const ss = simFor(account); return ss != null && ss.phase === "active"; })();
  if (!INST) $("connPill").classList.toggle("ghosted", !!sAct);
  for (const sw of el.querySelectorAll(".switch")) sw.addEventListener("click", onToggle);
  positionTips(el);
  if (prevOpenText) {
    for (const wrp of el.querySelectorAll(".tipwrap")) {
      const t = wrp.querySelector(".tip");
      if (t && t.textContent === prevOpenText) { wrp.classList.add("open"); break; }
    }
  }
  if (watching && INST && positions[0]) void renderWatchTerms(positions[0]);
};

// Instant re-render from the freshest poll payload — the simulation lane must move the moment
// the visitor acts, never on the next 5s tick.
const renderNow = () => { if (account && (lastPos.length || lastState)) render(lastPos, lastState); };
// Connect modal: the address-paste flow behind the nav chrome and every "Connect your address" link.
const openConnect = () => {
  if (INST) return;
  $("connVeil").classList.add("open");
  positionTips($("connectCard"));
  setTimeout(() => $("addrInput").focus(), 60);
};
document.addEventListener("click", (ev) => {
  const a = ev.target.closest ? ev.target.closest(".connOpen") : null;
  if (!a) return;
  ev.preventDefault();
  openConnect();
});
// In-app close confirmation (shared by the real close and the sim unwind): our visual language,
// our copy, and no browser-injected "suppress dialogs" chrome. Resolves true on "Turn off".
const confirmClose = (bodyHtml) => new Promise((resolve) => {
  $("cfmBody").innerHTML = bodyHtml;
  $("cfmVeil").classList.add("open");
  const done = (v) => {
    $("cfmVeil").classList.remove("open");
    $("cfmYes").onclick = null;
    $("cfmNo").onclick = null;
    $("cfmVeil").onclick = null;
    resolve(v);
  };
  $("cfmYes").onclick = () => done(true);
  $("cfmNo").onclick = () => done(false);
  $("cfmVeil").onclick = (e) => { if (e.target === $("cfmVeil")) done(false); };
});
// Fast count-up when the credit first lands — one micro-interaction; the number is the star.
const countUp = (el, target) => {
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 500);
    el.textContent = fmt$(target * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};
// The simulation lane driver: same lifecycle the live engine walks, priced by the REAL live
// preview quote (/api/preview) — the wrap path is never touched, and the server refuses every
// action on a showcased address regardless.
const simStart = async () => {
  const key = account.toLowerCase();
  markCoachDone();
  const p = (lastPos || []).find((x) => x.wrappable);
  if (!p) return;
  sims[key] = { phase: "quoting", startedMs: Date.now() };
  renderNow();
  haptic("impact");
  try {
    const usd = Math.min(Math.round(p.notionalUsdc), PV_MAX_USD);
    const j = await api("/api/preview?side=" + encodeURIComponent(p.side) + "&usd=" + usd);
    if (!sims[key] || sims[key].phase !== "quoting") return; // toggled off mid-quote
    if (!j.ok) {
      sims[key] = { phase: "refused", reason: String(j.message || j.error || "") };
      renderNow();
      setTimeout(() => { if (sims[key] && sims[key].phase === "refused") { delete sims[key]; renderNow(); } }, 8000);
      return;
    }
    sims[key] = { phase: "executing", startedMs: sims[key].startedMs, quote: j };
    renderNow();
    setTimeout(() => {
      const cur = sims[key];
      if (!cur || cur.phase !== "executing") return;
      sims[key] = { phase: "active", quote: j, vestStartMs: Date.now(), endMs: j.expiryMs && j.expiryMs > Date.now() ? j.expiryMs : Date.now() + 86400000 };
      renderNow();
      const heroNum = document.querySelector(".sim-cred");
      if (heroNum) countUp(heroNum, j.creditUsdc);
      haptic("success");
    }, 1400);
  } catch (e) {
    sims[key] = { phase: "refused", reason: "network error" };
    renderNow();
    setTimeout(() => { if (sims[key] && sims[key].phase === "refused") { delete sims[key]; renderNow(); } }, 8000);
  }
};
const simToggle = async () => {
  const key = account.toLowerCase();
  const s = sims[key];
  if (s && (s.phase === "quoting" || s.phase === "executing" || s.phase === "closing")) return;
  if (s && (s.phase === "refused" || s.phase === "closed" || s.phase === "knocked")) { delete sims[key]; renderNow(); return; }
  if (s && s.phase === "active" && s.quote) {
    // The UNWIND lane: turning off early has real consequences in the live product — state them,
    // then walk the same close path visuals (unwinding → settlement ticket → clean card).
    const preview = simVest(s);
    const ok = await confirmClose(
      'You keep <b style="color:var(--accent)">' + fmt$(preview.vestedUsdc) + '</b> already unlocked · the remaining ' + fmt$(Math.max(0, s.quote.creditUsdc - preview.vestedUsdc)) + ' returns to the market · auto-renew turns off.' +
      '<div class="simlabel" style="margin-top:12px">simulation · live pricing</div>'
    );
    if (!ok) return;
    // Re-read after the dialog: the sim may have knocked out or been cleared while it was open.
    const cur = sims[key];
    if (!cur || cur.phase !== "active" || !cur.quote) return;
    const vs = simVest(cur);
    const kept = vs.vestedUsdc, full = cur.quote.creditUsdc;
    sims[key] = { phase: "closing", startedMs: Date.now(), keptUsdc: kept, fullUsdc: full };
    renderNow();
    haptic("impact");
    setTimeout(() => {
      const cur = sims[key];
      if (!cur || cur.phase !== "closing") return;
      sims[key] = { phase: "closed", keptUsdc: kept, fullUsdc: full };
      renderNow();
      setTimeout(() => { const c2 = sims[key]; if (c2 && c2.phase === "closed") { delete sims[key]; renderNow(); } }, 7000);
    }, 1600);
    return;
  }
  void simStart();
};
// Coach mark dismiss (delegated — the mark is re-rendered by every poll until dismissed).
document.addEventListener("click", (ev) => {
  const x = ev.target.closest ? ev.target.closest(".coach-x") : null;
  if (!x) return;
  markCoachDone();
  renderNow();
});
// "see how" microlinks (next to any credit figure) open the how-it-works modal in place.
document.addEventListener("click", (ev) => {
  const a = ev.target.closest ? ev.target.closest(".howMini") : null;
  if (!a) return;
  ev.preventDefault();
  $("howVeil").classList.add("open");
});
// Why the credit exists, adjacent to where skepticism fires: at the credit number itself.
const whyLine = '<div class="small muted" style="margin-top:6px">The options market pays for the capped upside · <a href="#" class="howMini" style="color:var(--accent);text-decoration:none">see how</a>.</div>';
// Thin-market honesty note: when the live book funds under 2 bps/day, say why the number is small
// — otherwise an honest quote on a cheap-vol weekend reads as a broken product.
const thinNote = (creditUsdc, protectedUsd) =>
  protectedUsd > 0 && (creditUsdc / protectedUsd) * 10000 < 2
    ? '<div class="small muted" style="margin-top:6px">Quiet options market right now · credits are thin. Quotes re-price continuously.</div>'
    : '';

// The watch card's whole point: what Earn & Protect WOULD pay on this real position, right now.
// Priced full-size through the preview engine (no capacity clip — same rule as the preview, so a
// $95M position never renders a $1 credit). Quotes are free; cached so the 5s poll never spams
// the pricer.
let watchQuoteCache = { addr: "", atMs: 0, html: "" };
const renderWatchTerms = async (p) => {
  const box = $("watchTerms");
  if (!box) return;
  if (watchQuoteCache.addr === account && Date.now() - watchQuoteCache.atMs < 60000) {
    box.innerHTML = watchQuoteCache.html;
    positionTips(box);
    return;
  }
  try {
    // Mirror of the server's preview sanity ceiling: a position larger than the cap gets its
    // first $500M priced with an honest label — viewing must never error for being impressive.
    const reqUsd = Math.min(Math.round(p.notionalUsdc), PV_MAX_USD);
    const clamped = p.notionalUsdc > PV_MAX_USD;
    const j = await api("/api/preview?side=" + encodeURIComponent(p.side) + "&usd=" + reqUsd);
    if (!j.ok) { box.innerHTML = '<div class="small muted" style="margin-top:10px">' + esc(humanChip(j.message || j.error)) + '</div>'; return; }
    const fPct = ((j.floorStrike - j.spot) / j.spot) * 100, cPct = ((j.capStrike - j.spot) / j.spot) * 100;
    const pctSign = (x) => (x >= 0 ? "+" : "\\u2212") + Math.abs(x).toFixed(1) + "%";
    const html =
      '<div class="small muted" style="margin-top:10px">' + (INST ? 'What protection would pay on this position today:' : 'If this trader flipped the toggle right now:') + '</div>' +
      '<div class="terms">' +
        '<div class="term credit-hero"><b style="color:var(--accent)">' + fmt$(j.creditUsdc) + '</b>today\\u2019s credit \\u00b7 repeats while on</div>' +
        '<div class="term"><b>' + fmtPx(j.floorStrike) + ' <em>' + pctSign(fPct) + '</em></b>hard floor</div>' +
        '<div class="term"><b>' + fmtPx(j.capStrike) + ' <em>' + pctSign(cPct) + '</em></b>cap \\u00b7 ends cycle</div>' +
      '</div>' +
      whyLine +
      thinNote(j.creditUsdc, Math.min(p.notionalUsdc, PV_MAX_USD)) +
      '<div class="small muted" style="margin-top:8px">' + (clamped ? 'Terms shown for the first ' + fmt$(PV_MAX_USD) + ' of this position. ' : '') + 'Live market quote \\u00b7 nothing opens, nothing is stored. Look up a client address to see theirs.</div>';
    watchQuoteCache = { addr: account, atMs: Date.now(), html };
    const boxNow = $("watchTerms");
    if (boxNow) { boxNow.innerHTML = html; positionTips(boxNow); }
  } catch (e) {
    const boxNow = $("watchTerms");
    if (boxNow) boxNow.innerHTML = "";
  }
};

// Mobile-safe tooltips: tap toggles, tapping elsewhere closes. Every tip is PRE-POSITIONED
// while still invisible (measured with visibility:hidden after each render), so the moment
// hover or tap reveals it, it is already fully on screen — no flash, no jump, ever.
const positionTips = (root) => {
  for (const wrap of (root || document).querySelectorAll(".tipwrap")) {
    const tipEl = wrap.querySelector(".tip");
    if (!tipEl) continue;
    tipEl.style.marginLeft = "";
    tipEl.style.right = "";
    tipEl.style.visibility = "hidden";
    tipEl.style.display = "block";
    const r = tipEl.getBoundingClientRect();
    tipEl.style.display = "";
    tipEl.style.visibility = "";
    if (!r.width) continue; // hidden ancestor (e.g. closed modal): position when it opens
    const pad = 14;
    let dx = 0;
    if (r.left < pad) dx = pad - r.left;
    else if (r.right > window.innerWidth - pad) dx = window.innerWidth - pad - r.right;
    if (dx) {
      // Right-anchored tips ignore margin-left; shift them via their right offset instead.
      if (wrap.classList.contains("tip-right")) tipEl.style.right = -dx + "px";
      else tipEl.style.marginLeft = dx + "px";
    }
  }
};
window.addEventListener("resize", () => positionTips(document));
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
  // Every price rail's marker rides the freshest live mark (sim and real cards alike).
  if (lastMarkPx != null) {
    for (const r of document.querySelectorAll(".rail")) {
      const lo = Number(r.dataset.lo), hi = Number(r.dataset.hi);
      if (!(hi > lo)) continue;
      const m = r.querySelector(".rail-px");
      if (m) m.style.left = Math.min(94, Math.max(6, ((lastMarkPx - lo) / (hi - lo)) * 100)).toFixed(1) + "%";
      const lab = r.querySelector(".rail-pxval");
      if (lab) lab.textContent = fmtPx(lastMarkPx);
    }
  }
  // An active simulation vests in real time, exactly as the live card does — same clock, same math.
  const s = simFor(account);
  if (s && s.phase === "active" && s.quote) {
    const vsim = simVest(s);
    const v = document.querySelector(".sim-vested");
    if (v) v.textContent = fmt$(vsim.vestedUsdc);
    const f = document.querySelector(".sim-fill");
    if (f) f.style.width = (vsim.fraction * 100).toFixed(2) + "%";
    const e2 = document.querySelector(".sim-eta");
    if (e2) e2.textContent = "pays in " + fmtDur(vsim.remainingMs);
    // KNOCKOUT on a REAL cap touch: only actual market motion triggers it — the most
    // misunderstood mechanic, demonstrated honestly, then re-armed like the live product.
    if (lastMarkPx != null) {
      const touched = s.quote.side === "long" ? lastMarkPx >= s.quote.capStrike : lastMarkPx <= s.quote.capStrike;
      if (touched) {
        sims[account.toLowerCase()] = { phase: "knocked", capStrike: s.quote.capStrike, keptUsdc: vsim.vestedUsdc };
        renderNow();
        haptic("success");
        setTimeout(() => {
          const c = simFor(account);
          if (c && c.phase === "knocked") void simStart();
        }, 6000);
      }
    }
  }
}, 1000);

const renderPayouts = (state) => {
  const rows = (state && state.payouts || []).slice().reverse();
  $("payouts").innerHTML = rows.length
    ? rows.map((e) => '<tr><td>' + new Date(e.createdAtMs).toISOString().slice(0,16).replace("T"," ") + '</td><td>' + esc(e.reason.replace("_"," ")) + '</td><td><b style="color:var(--accent)">' + fmt$(e.amountUsdc) + '</b></td><td class="status-' + (e.status === "confirmed" || e.status === "paid" ? "paid" : e.status === "failed" ? "failed" : "accrued") + '">' + esc(e.status) + '</td><td>' + txLink(e.txHash) + '</td></tr>').join("")
    : '<tr><td colspan="5" class="empty">Credits land here at each cycle\\u2019s close.</td></tr>';
};

const onToggle = async (ev) => {
  const swSim = ev.currentTarget;
  if (swSim.dataset.sim === "1") { void simToggle(); return; }
  if (busy || !account || watching) return;
  const sw = ev.currentTarget;
  const isOn = sw.dataset.active === "1";
  // Turning OFF is an early close with consequences — state them before acting.
  if (isOn) {
    const kept = Number(sw.dataset.vested || 0), full = Number(sw.dataset.full || 0);
    const ok = await confirmClose(
      'You keep <b style="color:var(--accent)">' + fmt$(kept) + '</b> already unlocked · the remaining ' + fmt$(Math.max(0, full - kept)) + ' returns to the market · auto-renew turns off.'
    );
    if (!ok) return;
  }
  busy = true;
  haptic("impact");
  if (isOn) setMsg("Closing early · collecting what's unlocked…", false, true);
  // Immediate knob feedback: flip for the ATTEMPT, pulse while working; the next state render
  // corrects it if the engine refuses. A toggle that only moves on success reads as stuck.
  sw.classList.toggle("on", !isOn);
  sw.classList.add("busy");
  try {
    if (isOn) {
      const ctl = localStorage.getItem("ep_ctl_" + account.toLowerCase()) || "";
      const j = await api("/api/close?ctl=" + encodeURIComponent(ctl), { method: "POST" });
      // Context-aware fallback: a failed CLOSE must never read like a failed open.
      const closeFail = humanChip(j.message || j.error);
      setMsg(j.ok ? "Closed early · kept " + fmt$(j.vested.vestedUsdc) + " unlocked. Auto-renew off."
        : (closeFail === "Couldn't complete · nothing opened" ? "Couldn't turn off · nothing changed. It pays out on its own at the cycle's close." : closeFail), !j.ok);
      if (!j.ok && (j.error || "") === "close_locked") {
        // Cross-device close: offer the optional one-time wallet verification as the owner's path.
        verifyOffered = true;
        revealGate("verify");
      }
    } else {
      setMsg("Wrapping · pricing the live options book…", false, true);
      // Client-supplied idempotency key: a flaky network can never double-wrap.
      const idem = (MINIAPP ? "tma-" : "web-") + account.slice(2, 10) + "-" + Date.now().toString(36);
      const j = await api("/api/wrap", { method: "POST", headers: { "Idempotency-Key": idem } });
      if (j.ok && j.controlToken) localStorage.setItem("ep_ctl_" + account.toLowerCase(), j.controlToken);
      setMsg(j.ok ? "Protection live · credit pays at the cycle's close." : humanChip(j.message || j.error), !j.ok);
      if (!j.ok) $("connectMsg").title = String(j.message || j.error || "");
      // Gate-at-action: the engine said what it needs — surface exactly that card, right now.
      if (!j.ok && /tos_required/i.test(String(j.error || ""))) revealGate("tos");
      if (!j.ok && /verify_required/i.test(String(j.error || ""))) revealGate("verify");
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
// The banner is informational, so it is dismissible; the acknowledgment persists per
// mode+country, and enforcement stays server-side at the moment of action regardless.
let geoAckKey = "";
const geoAcked = (k) => { try { return localStorage.getItem(k) === "1"; } catch (e) { return false; } };
$("geoX").onclick = () => {
  try { if (geoAckKey) localStorage.setItem(geoAckKey, "1"); } catch (e) { /* private mode */ }
  $("geoBanner").style.display = "none";
};
const checkGates = async () => {
  try {
    const geo = await (await fetch("/api/geo")).json();
    if (geo.ok && geo.enabled && !geo.allowed) {
      geoAckKey = "ep_geo_ack_" + String(geo.mode || "") + "_" + String(geo.country || "");
      $("geoBanner").style.display = geoAcked(geoAckKey) ? "none" : "";
      if (geo.mode === "notice") {
        $("geoBanner").style.borderColor = "rgba(217,171,1,.5)";
        $("geoTitle").textContent = "Restricted region notice.";
        $("geoMsg").textContent = "You appear to be accessing from a restricted region" + (geo.country && geo.country !== "LOCAL" ? " (" + geo.country + ")" : "") + ". The live product will not be available there; the demo is open to explore.";
      } else {
        $("geoBanner").style.borderColor = "rgba(237,112,136,.45)";
        $("geoTitle").textContent = "Not available in your region.";
        $("geoMsg").textContent = geo.message || "Protection actions are unavailable from your location.";
      }
    } else $("geoBanner").style.display = "none";
  } catch (e) { /* leave as-is */ }
  // Gates live at the ACTION, not the view (trading-platform grammar: look at everything, the
  // rules appear when you commit). Cards are revealed by revealGate() on an engine refusal and
  // hidden here only when they can no longer apply.
  if (!account || watching) { $("tosCard").style.display = "none"; $("verifyCard").style.display = "none"; }
};

// Reveal a consent/verify card at the moment an action asked for it — never before.
const revealGate = async (kind) => {
  if (!account || watching) return;
  if (kind === "tos") {
    try {
      const tos = await api("/api/tos");
      if (tos.ok) $("tosVer").textContent = tos.version;
    } catch (e) { /* version label best-effort */ }
    $("tosCard").style.display = "";
    $("tosCard").scrollIntoView({ behavior: "smooth", block: "center" });
  } else {
    $("verifyCard").style.display = "";
    $("verifyCard").scrollIntoView({ behavior: "smooth", block: "center" });
  }
};

// One-time wallet verification: personal_sign of the server's canonical message.
$("verifyBtn").onclick = async () => {
  if (!account) return;
  const eth = window.ethereum;
  if (!eth) { $("verifyMsg").textContent = "No wallet found · open this page inside your wallet's browser (MetaMask/Rabby), or use the Terms checkbox flow if signatures aren't required."; return; }
  try {
    $("verifyMsg").textContent = "Check your wallet…";
    const info = await api("/api/verify");
    if (!info.ok) { $("verifyMsg").textContent = humanChip(info.message || info.error); return; }
    const accounts = await eth.request({ method: "eth_requestAccounts" });
    const signer = (accounts && accounts[0] || "").toLowerCase();
    if (signer !== account.toLowerCase()) { $("verifyMsg").textContent = "Your wallet is on " + short(signer) + " · switch to " + short(account) + " and retry."; return; }
    const sig = await eth.request({ method: "personal_sign", params: [info.message, accounts[0]] });
    const out = await api("/api/verify?signature=" + encodeURIComponent(sig), { method: "POST" });
    $("verifyMsg").textContent = out.ok ? "Verified · you're set on every surface." : humanChip(out.message || out.error);
    haptic(out.ok ? "success" : "error");
    if (out.ok) $("verifyCard").style.display = "none";
  } catch (e) {
    $("verifyMsg").textContent = (e && e.code === 4001) ? "Signature declined · nothing happened." : "Wallet error · try again.";
  }
};
$("tosCheck").onchange = () => { $("tosBtn").disabled = !$("tosCheck").checked; };
$("tosBtn").onclick = async () => {
  const j = await api("/api/tos/accept", { method: "POST" });
  setMsg(j.ok ? "Terms accepted (" + j.version + ") · flip protection on." : humanChip(j.message || j.error), !j.ok);
  if (j.ok) $("tosCard").style.display = "none";
};

// Mode pill: SIMULATED (paper) / DEMO VENUE (okx_demo) / LIVE (okx_live) — nobody should ever
// mistake a test surface for real money or vice versa.
const setModePill = (mode) => {
  const el = $("modePill");
  if (!mode) { el.style.display = "none"; return; }
  const m = mode === "okx_live" ? ["LIVE", "mode-live", "Real hedge orders on the listed venue. Credits are real."]
    : mode === "okx_demo" ? ["DEMO VENUE", "mode-demo", "Real order flow against the venue's demo environment · no real money."]
    : ["SIMULATED", "mode-paper", "Paper mode: quotes are live market prices, but no venue orders are placed and payouts are simulated."];
  el.style.display = "";
  el.className = "mode-pill tipwrap " + m[1];
  el.innerHTML = m[0] + '<span class="tip">' + m[2] + '</span>';
};

let pollTimer = null;
let lastMarkPx = null;
let pxFlashT = null;
const setMarkPx = (px) => {
  if (px == null) return;
  const el = $("pxPill");
  el.style.display = "";
  $("pxVal").textContent = fmtPx(px);
  if (lastMarkPx != null && px !== lastMarkPx) {
    el.classList.remove("up", "down");
    void el.offsetWidth; // restart the color transition
    el.classList.add(px > lastMarkPx ? "up" : "down");
    // Flash, then settle back to neutral — a persistent red mark reads as an alert, not a tick.
    clearTimeout(pxFlashT);
    pxFlashT = setTimeout(() => el.classList.remove("up", "down"), 900);
  }
  lastMarkPx = px;
};
const poll = async () => {
  if (!account) return;
  try {
    const [pos, st] = await Promise.all([api("/api/positions"), api("/api/state")]);
    if (st) setMarkPx(st.marketPxUsd);
    // Server truth: a showcased address entered THIS session (paste/landing) is WATCHING. The
    // same address restored from storage lands fresh instead — watching is never ambient state.
    if (st && st.showcase === true && !watching) {
      if (userEntered) {
        watching = true;
        setConn();
        checkGates();
      } else {
        localStorage.removeItem("ep_account");
        account = "";
        setConn();
        if (!INST) { void landShowcase(); return; }
        $("hero").style.display = "";
        $("positions").innerHTML = '<div class="empty">Look up an address to see its open positions.</div>';
        return;
      }
    }
    if (pos && pos.ok) lastPos = pos.positions || [];
    if (st && st.ok) lastState = st;
    // Landing failover: a showcase wallet whose BTC position just closed is a dead landing —
    // advance to the next validated wallet (once each) instead of parking on an empty card.
    if (!INST && watching && autoLanded && pos && pos.ok && lastPos.filter((x) => x.wrappable).length === 0 && landTried < watchWallets.length) {
      const next = landTried;
      landTried += 1;
      void watchWallet(next, false);
      return;
    }
    if (st && st.caps && !watching) {
      $("rateNote").textContent = " (" + (st.caps.foundingTakeRatePct * 100).toFixed(0) + "% vs " + (st.caps.takeRatePct * 100).toFixed(0) + "%, locked 12 months)";
      const wl = st.caps.waitlistLength ? " · waitlist " + st.caps.waitlistLength : "";
      const mine = st.protection && st.protection.waitlistPosition ? " · you're #" + st.protection.waitlistPosition + " in line" : "";
      // Cohort framing: a founding wallet sees its own member number (a badge, not a gauge);
      // everyone else sees the live count only when the server says it reads as momentum
      // (EP_SHOW_COHORT_COUNT), otherwise the honest scarcity line without a numerator.
      const rank = st.protection && st.protection.foundingRank;
      const cohort = rank
        ? "· founding member #" + rank + " · rate locked 12 months"
        : st.caps.showCohortCount
          ? "· founding cohort " + st.caps.walletsJoined + "/" + st.caps.foundingWallets
          : "· founding rate · limited to the first " + st.caps.foundingWallets + " wallets";
      $("cohortLine").textContent = cohort + wl + mine;
    }
    // Watch mode never shows the execution-mode badge: nothing can execute for a watched wallet,
    // and "SIMULATED" next to a live quote tars real pricing as fake.
    if (st && st.guards) setModePill(watching ? null : st.guards.executionMode);
    $("hero").style.display = "none"; // connected: the app gets denser, the pitch gets out of the way
    render(pos.ok ? pos.positions : [], st.ok ? st : null);
    renderPayouts(st.ok ? st : null);
  } catch (e) { /* keep last render */ }
};

let pvSide = "long";
const pvSetSide = (side) => {
  pvSide = side;
  for (const x of document.querySelectorAll("#pvSeg button")) x.classList.toggle("on", x.dataset.side === side);
};
for (const b of document.querySelectorAll("#pvSeg button")) {
  b.onclick = () => pvSetSide(b.dataset.side);
}
$("pvClear").onclick = (e) => {
  e.preventDefault();
  $("pvOut").innerHTML = "";
  $("pvUsd").value = INST ? "10,000,000" : "100,000";
  pvSetSide("long");
  $("pvClear").style.display = "none";
};
$("pvBtn").onclick = async () => {
  const usd = parseFloat($("pvUsd").value.replace(/[$,\\s]/g, ""));
  if (!(usd > 0)) { $("pvOut").innerHTML = '<div class="small muted" style="margin-top:8px">Enter a position size in dollars, e.g. 2,000.</div>'; return; }
  $("pvOut").innerHTML = '<div class="small muted" style="margin-top:10px"><span class="spin"></span>Pricing off the live option book…</div>';
  try {
    const j = await api("/api/preview?side=" + pvSide + "&usd=" + encodeURIComponent(usd));
    $("pvClear").style.display = "";
    if (!j.ok) { $("pvOut").innerHTML = '<div class="chip bad">' + esc(humanChip(j.message || j.error)) + '</div>'; return; }
    // Same terms grid as the real position card — the preview should look like the product.
    const fPct = ((j.floorStrike - j.spot) / j.spot) * 100;
    const cPct = ((j.capStrike - j.spot) / j.spot) * 100;
    const sign = (x) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(1) + "%";
    $("pvOut").innerHTML =
      '<div class="terms">' +
        '<div class="term credit-hero"><b style="color:var(--accent)">' + fmt$(j.creditUsdc) + '</b>today\\u2019s credit' + (j.founding && !INST ? ' <span class="badge founding">FOUNDING RATE</span>' : '') + '</div>' +
        '<div class="term"><b>' + fmtPx(j.floorStrike) + ' <em>' + sign(fPct) + '</em></b>hard floor</div>' +
        '<div class="term"><b>' + fmtPx(j.capStrike) + ' <em>' + sign(cPct) + '</em></b>cap \\u00b7 ends cycle</div>' +
      '</div>' +
      whyLine +
      thinNote(j.creditUsdc, j.protectedUsd) +
      '<div class="small muted" style="margin-top:8px">' +
        'For a ' + fmt$(j.protectedUsd) + ' ' + (INST && j.side === "long" ? "holding" : esc(j.side)) + ' (' + esc(String(j.coveredBtc)) + ' BTC at ' + fmtPx(j.spot) + ', sized to whole option lots).' +
        (j.exceedsCurrentCap ? (INST ? ' Executable size is established in the design-partner pilot.' : ' Early access may protect part of this \\u00b7 capacity grows with the book.') : '') +
      '</div>';
    // INST: the one-action moment, framed as a MOCK CLIENT-INTERFACE PANEL so it is unmistakable
    // that this widget is what appears in the partner's product. Clearly labeled a demonstration.
    if (INST) {
      const brandName = (document.querySelector(".logo b") || { textContent: "PARTNER" }).textContent;
      $("pvOut").insertAdjacentHTML("beforeend",
        '<div style="margin-top:14px;border:1px solid var(--line);border-radius:8px;overflow:hidden">' +
          '<div style="background:var(--panel2);padding:6px 12px;font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--line)">How this appears in a ' + esc(brandName) + ' client interface \\u00b7 demonstration</div>' +
          '<div style="padding:12px 14px">' +
            '<div class="row" style="align-items:center;justify-content:space-between">' +
              '<div><b>Protect &amp; Earn</b><div class="small muted">BTC holding \\u00b7 ' + fmt$(j.protectedUsd) + '</div></div>' +
              '<div class="switch" id="demoSwitch" role="switch" aria-checked="false"><div class="knob"></div></div>' +
            '</div>' +
            '<div id="demoActive" style="display:none">' +
              '<div class="chip on">PROTECTION ACTIVE <span class="muted">(demonstration)</span> \\u00b7 the credit vests through the cycle and settles at its close</div>' +
              '<div class="bar"><div style="width:28%"></div></div>' +
              '<div class="unlock">unlocks through the day \\u00b7 pays automatically at the cycle\\u2019s close</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="small muted" style="margin-top:8px">One action in production. Vault integration in the design-partner pilot enables this for custodied holdings.</div>');
      $("demoSwitch").onclick = () => {
        const on = $("demoSwitch").classList.toggle("on");
        $("demoSwitch").setAttribute("aria-checked", String(on));
        $("demoActive").style.display = on ? "" : "none";
        haptic("impact");
      };
    }
  } catch (e) {
    $("pvClear").style.display = "";
    $("pvOut").innerHTML = '<div class="small muted" style="margin-top:8px">Couldn\\u2019t reach the pricer \\u00b7 try again in a moment.</div>';
  }
};

// Connect modal chrome: the nav button opens the paste flow; connecting an own address exits
// the showcase landing — that swap is the conversion action the funnel measures.
$("connPill").onclick = () => { if (!INST) openConnect(); };
$("connClose").onclick = () => $("connVeil").classList.remove("open");
$("connVeil").addEventListener("click", (e) => { if (e.target === $("connVeil")) $("connVeil").classList.remove("open"); });
$("addrInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("connectBtn").click(); });
$("connectBtn").onclick = () => {
  const a = $("addrInput").value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) { $("connectMsg").textContent = "That's not an EVM address."; return; }
  // A pasted showcased address is still WATCHING (mode follows the address, not the entry path);
  // the server's state payload confirms on the first poll for addresses the landing didn't load.
  userEntered = true;
  autoLanded = false;
  watching = watchWallets.some((w) => w.address.toLowerCase() === a.toLowerCase());
  account = a;
  if (!watching) localStorage.setItem("ep_account", a); // never store someone else's wallet as "yours"
  $("connectMsg").textContent = watching ? "" : "Read-only. We can see positions, never touch them.";
  $("connVeil").classList.remove("open");
  setConn();
  checkGates();
  poll();
};
$("forgetBtn").onclick = () => {
  watching = false;
  account = "";
  localStorage.removeItem("ep_account");
  $("addrInput").value = "";
  $("connectMsg").textContent = "";
  $("connVeil").classList.remove("open");
  $("modePill").style.display = "none";
  lastPos = [];
  lastState = null;
  renderPayouts(null);
  setConn();
  // Disconnecting returns the visitor to the operating landing, never to an empty gate.
  if (!INST) void landShowcase();
  else {
    $("hero").style.display = "";
    $("positions").innerHTML = '<div class="empty">Look up an address to see its open positions.</div>';
  }
};

// Showcase set: live public wallets validated by the server against open BTC positions.
const fetchShowcase = async (attempt) => {
  try {
    const j = await api("/api/showcase");
    if (j.ok && j.wallets && j.wallets.length) { watchWallets = j.wallets; return true; }
  } catch (e) { /* retry below */ }
  if ((attempt || 0) < 3) {
    await new Promise((r) => setTimeout(r, ((attempt || 0) + 1) * 5000));
    return fetchShowcase((attempt || 0) + 1);
  }
  return false;
};
let watchIdx = 0;
const watchWallet = async (i, scroll) => {
  watchIdx = i;
  userEntered = true;
  watching = true;
  account = watchWallets[i].address;
  $("hero").style.display = "none";
  if (INST) $("previewCard").style.display = "none";
  setConn();
  checkGates();
  await poll();
  // Motion cue (explicit navigation only): the result renders below the fold — go to it.
  if (scroll !== false) $("positions").scrollIntoView({ behavior: "smooth", block: "start" });
};
$("nextWhale").onclick = (e) => {
  e.preventDefault();
  if (watchWallets.length > 1) watchWallet((watchIdx + 1) % watchWallets.length);
};
// INST viewing exit: back to the model-first home state (no lookup card exists on this skin).
$("stopViewing").onclick = (e) => {
  e.preventDefault();
  watching = false;
  account = "";
  setConn();
  $("hero").style.display = "";
  $("modePill").style.display = "none";
  $("positions").innerHTML = '<div class="empty">Look up an address to see its open positions.</div>';
  renderPayouts(null);
  window.scrollTo({ top: 0, behavior: "smooth" });
};

// LAND OPERATING (retail): boot straight into a live public BTC position — skeleton first,
// showcase card seconds later. A visitor's own stored address always wins over the landing.
const landShowcase = async () => {
  if (account || INST) return;
  booting = true;
  landingFailed = false;
  setConn();
  $("hero").style.display = "none";
  $("positions").innerHTML = '<div class="card"><div class="skl" style="width:45%"></div><div class="skl" style="width:75%"></div><div class="skl" style="width:60%"></div></div>';
  const ok = await fetchShowcase(0);
  booting = false;
  if (account) return; // the visitor connected while the landing loaded
  if (!ok || watchWallets.length === 0) {
    // No live showcase — fall back to the connect-first page rather than a dead card.
    landingFailed = true;
    $("hero").style.display = "";
    setConn();
    return;
  }
  autoLanded = true;
  landTried = 1;
  await watchWallet(0, false);
};

// Live HL mark in the header from the FIRST paint — no address required. Once an account
// connects, the state poll owns the ticker and this quietly stands down.
const pollPx = async () => {
  if (account) return;
  try {
    const j = await api("/api/px");
    if (j.ok) setMarkPx(j.pxUsd);
  } catch (e) { /* keep last value */ }
};
pollPx();
setInterval(pollPx, 15000);

setConn();
checkGates();
if (account) poll();
else void landShowcase();
pollTimer = setInterval(poll, 5000);
setInterval(checkGates, 30000);
</script>
</body>
</html>`;
};

export const EP_WEB_APP_HTML = buildEpAppHtml("web");
export const EP_MINI_APP_HTML = buildEpAppHtml("miniapp");
