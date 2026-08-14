#!/usr/bin/env tsx
/**
 * WRAP DEMO SERVICE — the Atticus half of the two-surface demo (the venue half is the real
 * Hyperliquid UI plus the locally-rendered "Protect" toggle in demo/hl-protect-extension).
 *
 * What it does, all real:
 *   1. POSITION  — reads the REAL Hyperliquid position (clearinghouseState) for DEMO_HL_ADDRESS.
 *   2. QUOTE     — prices the REAL collar off the live OKX options book (same pricer, pass-through,
 *                  σ-floor, adaptive floor — the exact production solve), credit target scaled to
 *                  the micro notional ($80-per-$50k geometry).
 *   3. EXECUTE   — DEMO_EXECUTION=paper (default): model quote booked, clearly labeled PAPER.
 *                  okx_demo / okx_live: REAL hedge legs through the SAME production path as the
 *                  canary (band-capped IOC legs, unwind-on-partial, alerts) — real order IDs.
 *   4. CONTROL ROOM — GET /demo renders the Atticus-side page for the recording: position, quote,
 *                  leg-by-leg fills, stage timeline, live vesting bar.
 *
 * SAFETY RAILS (demoWrap.assessDemoWrap, all fail-closed):
 *   DEMO_ENABLED kill switch · hard micro cap DEMO_MAX_NOTIONAL_USDC (default $1k) · one wrap at a
 *   time · DEMO_MAX_WRAPS_PER_DAY · cooldown. okx_live additionally requires the full live-arming
 *   chain (LIVE_ENABLED=true + OKX_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY) — same as the canary.
 *
 * Run locally next to the browser doing the recording:
 *   DEMO_HL_ADDRESS=0x… npx tsx services/api/scripts/creditCollarDemoService.ts
 * okx demo-env legs:  DEMO_EXECUTION=okx_demo LIVE_ENABLED=true OKX_API_KEY=… OKX_API_SECRET=… OKX_API_PASSPHRASE=…
 * okx real legs:      DEMO_EXECUTION=okx_live LIVE_ENABLED=true OKX_EXECUTION_MODE=live OKX_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY …
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HyperliquidClient } from "../src/singleSide/twoSided/creditCollar/execution/perpVenues/hyperliquidClient";
import {
  assessDemoWrap,
  concludeWrapEarly,
  demoVestingStatus,
  failWrap,
  loadDemoWraps,
  newDemoWrap,
  paperLegsFromQuote,
  parseDemoGuardsFromEnv,
  pushStage,
  saveDemoWraps,
  scaledCreditTarget,
  type DemoLeg,
  type DemoWrapRecord
} from "../src/singleSide/twoSided/creditCollar/demoWrap";
import { buildLiveShadowInputs, type LiveShadowConfig } from "../src/singleSide/twoSided/creditCollar/shadowRunner";
import { solveAdaptiveCreditCollar, type PerpSide } from "../src/singleSide/twoSided/creditCollar/creditCollarPricer";
import { evaluateRegimeGate } from "../src/singleSide/twoSided/creditCollar/regimeGate";
import { OkxExecutionClient } from "../src/singleSide/twoSided/creditCollar/execution/okxExecutionClient";
import { buildOkxLiveExecutionHook } from "../src/singleSide/twoSided/creditCollar/execution/okxLiveRunner";
import { executionArmed, parseLiveGuardsFromEnv } from "../src/singleSide/twoSided/creditCollar/execution/liveGuards";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);
const round2 = (x: number) => +x.toFixed(2);

const port = num(process.env.DEMO_PORT, 8788);
const guards = parseDemoGuardsFromEnv(process.env);
const storePath = process.env.DEMO_STORE_PATH ?? "./logs/demo-wraps.json";
const allowReset = String(process.env.DEMO_ALLOW_RESET ?? "true").toLowerCase() === "true";
const coin = process.env.DEMO_COIN ?? "BTC";

// The account whose position is wrapped: explicit demo address > master address > the key's own.
const hl = new HyperliquidClient({
  privateKeyHex: process.env.HL_PRIVATE_KEY,
  masterAddress: process.env.DEMO_HL_ADDRESS ?? process.env.HL_MASTER_ADDRESS
});
const hlAccount = (): string | null => {
  try {
    return hl.accountAddress();
  } catch {
    return null;
  }
};

// Same pricing frame as the shadow/canary (config freeze) — notional is swapped in per wrap.
const baseCfg: LiveShadowConfig = {
  positionNotionalUsdc: 50_000, // replaced per wrap
  feeUsdc: num(process.env.HARNESS_FEE_USDC, 80),
  serviceFeeBps: 0,
  minServiceFeeUsdc: 0,
  tenorDays: num(process.env.HARNESS_TENOR_DAYS, 1),
  maxFloorPct: num(process.env.HARNESS_MAX_FLOOR_PCT, 0.06),
  nPositions: 1,
  tier0CapUsdc: 2_000_000,
  breaker: { warnBandPct: 100, haltBandPct: 100, resumeBandPct: 100, minGrossNotionalUsd: 0, maxAbsNetNotionalUsd: Number.MAX_SAFE_INTEGER },
  policy: { targetNetBandPct: 0.1, allowDirectionalBias: false, directionalTiltSigned: 0 },
  bullishWeight: 0,
  settlementWindowMin: 30,
  seed: 42,
  strikeGridUsdc: num(process.env.HARNESS_STRIKE_GRID_USDC, 250),
  minCapSigmaMult: num(process.env.HARNESS_MIN_CAP_SIGMA, 1.1),
  maxRetainedNetOfFeesUsdc: num(process.env.HARNESS_MAX_RETAINED_USDC, 2),
  hedgeVenue: "okx",
  adaptiveFloor: { enabled: true, maxFloorCapPct: num(process.env.SHADOW_ADAPTIVE_FLOOR_CAP, 0.1), stepPct: 0.005 }
};

const DAY_MS = 86_400_000;

/**
 * Paper-lane expiry: EXACTLY now + tenor (24h default) — matches the pricer's tenor, the shadow
 * model, and the product pitch. Snapping to a listed 08:00 UTC print is a LIVE-lane concern (the
 * real venue legs settle at the venue's daily print, and there the true expiry is shown).
 */
const paperExpiryMs = (nowMs: number, tenorDays: number): number => nowMs + tenorDays * DAY_MS;

type HlPositionRead = {
  coin: string;
  side: PerpSide;
  szBase: number;
  entryPx: number | null;
  markPx: number;
  notionalUsdc: number;
};

const readHlPosition = async (): Promise<HlPositionRead | null> => {
  const account = hlAccount();
  if (!account) return null;
  const [detail, mark] = await Promise.all([hl.positionDetail(account, coin), hl.midPx(coin)]);
  if (!detail) return null;
  const szBase = Math.abs(detail.szi);
  return {
    coin,
    side: detail.szi > 0 ? "long" : "short",
    szBase,
    entryPx: detail.entryPx,
    markPx: mark,
    notionalUsdc: round2(detail.positionValueUsd ?? szBase * mark)
  };
};

// ── Wrap flow ─────────────────────────────────────────────────────────────────

let wrapInFlight = false;

const doWrap = async (): Promise<{ status: number; body: unknown }> => {
  const nowMs = Date.now();
  const records = loadDemoWraps(storePath);

  let position: HlPositionRead | null;
  try {
    position = await readHlPosition();
  } catch (e) {
    return { status: 502, body: { ok: false, error: "position_read_failed", message: (e as Error).message } };
  }
  if (!position) {
    return { status: 409, body: { ok: false, error: "no_position", message: `no open ${coin} position on ${hlAccount() ?? "unset account (set DEMO_HL_ADDRESS)"}` } };
  }

  const permit = assessDemoWrap(guards, nowMs, position.notionalUsdc, records);
  if (!permit.ok) return { status: 409, body: { ok: false, error: "refused", message: permit.reason } };

  // okx lanes must clear the SAME arming chain as the canary before anything else happens.
  if (guards.executionMode !== "paper") {
    const liveGuards = parseLiveGuardsFromEnv(process.env, "okx");
    const armed = executionArmed(liveGuards);
    if (!armed.armed) return { status: 409, body: { ok: false, error: "not_armed", message: armed.reason } };
    if (guards.executionMode === "okx_live" && liveGuards.mode !== "live") {
      return { status: 409, body: { ok: false, error: "mode_mismatch", message: "DEMO_EXECUTION=okx_live but OKX_EXECUTION_MODE is not live" } };
    }
    if (guards.executionMode === "okx_demo" && liveGuards.mode !== "demo") {
      return { status: 409, body: { ok: false, error: "mode_mismatch", message: "DEMO_EXECUTION=okx_demo but OKX_EXECUTION_MODE=live — refusing (use DEMO_EXECUTION=okx_live intentionally)" } };
    }
  }

  const rec = newDemoWrap(`wrap-${nowMs}`, nowMs, "hyperliquid", hlAccount() ?? "?", position);
  records.push(rec);
  saveDemoWraps(records, storePath);
  const persist = () => saveDemoWraps(records, storePath);

  // 2) QUOTE — live OKX book, production solve, micro-scaled credit target.
  const built = await buildLiveShadowInputs({ ...baseCfg, positionNotionalUsdc: position.notionalUsdc });
  if (!built.ok) {
    failWrap(rec, Date.now(), `live pricing inputs unavailable: ${built.error} — ${built.message}`);
    persist();
    return { status: 502, body: { ok: false, error: built.error, message: built.message, wrap: rec } };
  }
  const { skew, spot, scaffoldConfig } = built.inputs;
  const targetCredit = scaledCreditTarget(baseCfg.feeUsdc, 50_000, position.notionalUsdc);
  const adaptive = solveAdaptiveCreditCollar(
    { side: position.side, spot, notionalUsdc: position.notionalUsdc, tenorDays: baseCfg.tenorDays, targetCreditUsdc: targetCredit, maxFloorPct: scaffoldConfig.maxFloorPct, referenceMode: "position" },
    skew,
    { ...(scaffoldConfig.spreadConfig ?? {}), pricingModel: "pass_through", operationFeeBps: 0, minOperationFeeUsdc: 0 },
    scaffoldConfig.adaptiveFloor
  );
  if (!adaptive.quote.ok) {
    failWrap(rec, Date.now(), `pricer declined: ${adaptive.quote.error} — ${adaptive.quote.message}`);
    persist();
    return { status: 409, body: { ok: false, error: adaptive.quote.error, message: adaptive.quote.message, wrap: rec } };
  }
  const q = adaptive.quote;
  rec.quote = {
    spot: round2(spot),
    putStrike: q.legs.putStrike,
    callStrike: q.legs.callStrike,
    floorPct: q.legs.floor_pct,
    capPct: q.legs.cap_pct,
    creditUsdc: q.economics.foxify_credit_usdc,
    floorPctUsed: adaptive.floorUsedPct,
    tenorDays: baseCfg.tenorDays
  };
  pushStage(rec, "quoted", Date.now(), `floor $${q.legs.putStrike} / cap $${q.legs.callStrike} · credit $${q.economics.foxify_credit_usdc}`);
  persist();

  // 3) EXECUTE.
  if (guards.executionMode === "paper") {
    const expiresAtMs = paperExpiryMs(nowMs, baseCfg.tenorDays);
    rec.legs = paperLegsFromQuote(q, expiresAtMs);
    rec.hedge = { venue: "okx_model", mode: "paper", netCreditUsdc: q.economics.foxify_credit_usdc, venueFeeUsdc: null, contracts: null, sizeNote: null };
    pushStage(rec, "hedge_locked", Date.now(), "PAPER lane — model quote off the live OKX book, no venue orders");
    pushStage(rec, "green_light", Date.now());
    rec.vesting = { fullCreditUsdc: q.economics.foxify_credit_usdc, startMs: Date.now(), endMs: expiresAtMs };
    pushStage(rec, "vesting", Date.now(), `$${q.economics.foxify_credit_usdc} vests linearly to ${new Date(expiresAtMs).toISOString()}`);
    rec.status = "active";
    persist();
    return { status: 200, body: { ok: true, wrap: rec } };
  }

  // okx_demo / okx_live — real hedge legs through the canary path, hard-forced to min clip count.
  rec.status = "executing";
  pushStage(rec, "hedge_executing", Date.now(), `real ${guards.executionMode.replace("okx_", "OKX ")} legs going out`);
  persist();
  const { OKX_API_KEY: k, OKX_API_SECRET: s, OKX_API_PASSPHRASE: p } = process.env;
  if (!k || !s || !p) {
    failWrap(rec, Date.now(), "missing OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE");
    persist();
    return { status: 409, body: { ok: false, error: "missing_credentials", message: rec.failReason, wrap: rec } };
  }
  const liveGuards = {
    ...parseLiveGuardsFromEnv(process.env, "okx"),
    windowUtc: "00:00",
    windowLatestUtc: "23:59",
    // Hedge in venue min-clip lots (0.01 BTC): enough to cover the micro position, capped at 5.
    canaryContracts: Math.min(5, Math.max(1, Math.round(position.szBase / 0.01)))
  };
  const hook = buildOkxLiveExecutionHook(
    { ...process.env, LIVE_DIRECTIONAL_DECISION: "auto" }, // demo wrap = the client's own decision; no partner gate
    {
      client: new OkxExecutionClient({ apiKey: k, secret: s, passphrase: p, mode: liveGuards.mode }),
      guards: liveGuards,
      paths: {
        windowState: `./logs/demo-live-window-${rec.id}.json`, // fresh window per wrap (multi-take recording)
        executions: "./logs/demo-live-executions.jsonl",
        alerts: "./logs/demo-live-alerts.jsonl",
        recon: "./logs/demo-live-recon.jsonl"
      }
    }
  );
  const trailing: number[] = []; // no local settle history — the gate runs on the live gauge only
  const gate = evaluateRegimeGate(trailing, { enabled: true }, null);
  const res = await hook.executeWindow({
    nowMs: Date.now(),
    spot,
    regime: { ...gate, regime: "elevated" }, // elevated shape ⟹ exactly ONE single at the position's side
    trendBias: position.side,
    solveSide: (side: PerpSide) =>
      side === position.side
        ? {
            ok: true as const,
            solved: {
              ref: rec.id,
              side,
              notionalUsdc: position.notionalUsdc,
              putStrike: q.legs.putStrike,
              callStrike: q.legs.callStrike,
              foxifyCreditUsdc: q.economics.foxify_credit_usdc,
              serviceFeeUsdc: 0,
              floorPctUsed: adaptive.floorUsedPct,
              protectiveLegMidUsdc: q.legs.floor_leg_mid_usdc,
              fundingLegMidUsdc: q.legs.funding_leg_mid_usdc
            }
          }
        : { ok: false as const, error: "wrong_side", message: "demo wraps only the client's actual side" }
  });
  if (res.newOpens.length === 0) {
    failWrap(rec, Date.now(), `hedge did not fill: ${res.summary}`);
    persist();
    return { status: 502, body: { ok: false, error: "hedge_not_filled", message: res.summary, wrap: rec } };
  }
  const pos = res.newOpens[0];
  const legs: DemoLeg[] = [
    { role: "sell_call_cap", instId: pos.liveMeta?.callInstId ?? null, orderId: pos.liveMeta?.clOrdPrefix ?? null, premiumUsdc: round2(pos.fundingLegPremiumUsdc ?? 0), real: true },
    { role: "buy_put_floor", instId: pos.liveMeta?.putInstId ?? null, orderId: pos.liveMeta?.clOrdPrefix ?? null, premiumUsdc: round2(-(pos.protectiveLegPremiumUsdc ?? 0)), real: true }
  ];
  rec.legs = legs;
  const hedgedBtc = (pos.liveMeta?.contracts ?? 0) * (pos.liveMeta?.ctValBtc ?? 0.01);
  rec.hedge = {
    venue: guards.executionMode,
    mode: guards.executionMode,
    netCreditUsdc: pos.foxifyCreditUsdc,
    venueFeeUsdc: pos.liveMeta?.venueFeeUsdc ?? null,
    contracts: pos.liveMeta?.contracts ?? null,
    sizeNote: hedgedBtc > position.szBase ? `hedge min clip: ${hedgedBtc} BTC hedged vs ${position.szBase} BTC position (venue lot = 0.01 BTC)` : null
  };
  pushStage(rec, "hedge_locked", Date.now(), `filled — net credit $${pos.foxifyCreditUsdc} · fees $${pos.liveMeta?.venueFeeUsdc ?? 0}`);
  pushStage(rec, "green_light", Date.now());
  rec.vesting = { fullCreditUsdc: pos.foxifyCreditUsdc, startMs: Date.now(), endMs: pos.expiresAtMs };
  pushStage(rec, "vesting", Date.now(), `$${pos.foxifyCreditUsdc} vests linearly to ${new Date(pos.expiresAtMs).toISOString()}`);
  rec.status = "active";
  persist();
  return { status: 200, body: { ok: true, wrap: rec } };
};

// ── State for the control room + extension chip ───────────────────────────────

const buildState = async () => {
  const nowMs = Date.now();
  let position: HlPositionRead | null = null;
  let positionError: string | null = null;
  try {
    position = await readHlPosition();
  } catch (e) {
    positionError = (e as Error).message;
  }
  const wraps = loadDemoWraps(storePath).map((r) => {
    if (r.status === "active" && r.vesting && r.concludedAtMs == null && nowMs >= r.vesting.endMs) {
      // Display-only conclusion: the tenor has run — fully vested.
      return { ...r, status: "concluded" as const, vestingStatus: demoVestingStatus(r, nowMs) };
    }
    return { ...r, vestingStatus: demoVestingStatus(r, nowMs) };
  });
  return {
    ok: true,
    guards: {
      enabled: guards.enabled,
      executionMode: guards.executionMode,
      maxPositionNotionalUsdc: guards.maxPositionNotionalUsdc,
      maxWrapsPerDay: guards.maxWrapsPerDay,
      cooldownMs: guards.cooldownMs
    },
    account: hlAccount(),
    coin,
    position,
    positionError,
    wraps,
    generatedAtIso: new Date(nowMs).toISOString()
  };
};

// ── Control room page ─────────────────────────────────────────────────────────

const CONTROL_ROOM_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atticus — Wrap Control Room</title>
<style>
  body{font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0d1117;color:#e6edf3}
  .wrap{max-width:980px;margin:0 auto;padding:20px}
  h1{font-size:18px;margin:0 0 4px} .sub{color:#8b949e;margin:0 0 16px}
  h2{font-size:14px;margin:22px 0 6px;color:#c9d1d9}
  .badge{display:inline-block;color:#fff;border-radius:999px;padding:3px 10px;font-weight:600;font-size:12px;margin-right:6px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:14px 0}
  .card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px}
  .card .k{color:#8b949e;font-size:12px} .card .v{font-size:20px;font-weight:700;margin-top:2px} .card .s{color:#8b949e;font-size:12px;margin-top:2px}
  table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #21262d} th{color:#8b949e;font-weight:600}
  .muted{color:#8b949e} a{color:#58a6ff}
  .timeline{list-style:none;margin:8px 0;padding:0}
  .timeline li{padding:6px 0 6px 22px;position:relative;border-left:2px solid #30363d;margin-left:8px}
  .timeline li:before{content:"";position:absolute;left:-6px;top:11px;width:10px;height:10px;border-radius:50%;background:#30363d}
  .timeline li.done:before{background:#2ea043} .timeline li.fail:before{background:#f85149}
  .timeline .t{color:#8b949e;font-size:11px} .timeline .n{color:#8b949e;font-size:12px}
  .bar{background:#21262d;border-radius:999px;height:14px;overflow:hidden;margin-top:6px}
  .bar>div{background:linear-gradient(90deg,#1f6feb,#2ea043);height:100%;width:0;transition:width .8s}
  .btn{background:#238636;border:1px solid #2ea043;color:#fff;border-radius:8px;padding:8px 16px;font-weight:600;cursor:pointer;font-size:13px}
  .btn[disabled]{opacity:.45;cursor:not-allowed}
  .btn.ghost{background:transparent;border-color:#30363d;color:#8b949e}
  .note{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:10px 14px;margin:10px 0;font-size:12px;color:#8b949e}
  .real{color:#2ea043;font-weight:700} .paper{color:#e3b341;font-weight:700}
</style></head><body><div class="wrap">
  <h1>Atticus — Wrap Control Room</h1>
  <p class="sub">The venue side is one toggle. This page is everything behind it — live position feed, live options pricing, hedge legs, credit vesting.</p>
  <div id="badges"></div>
  <div class="grid" id="cards"></div>
  <h2>Wrap timeline</h2>
  <ul class="timeline" id="timeline"><li class="muted">No wrap yet — flip the toggle on the venue side (or use the backup button below).</li></ul>
  <h2>Hedge legs</h2>
  <table><thead><tr><th>leg</th><th>instrument</th><th>order ref</th><th>premium</th><th>execution</th></tr></thead>
  <tbody id="legs"><tr><td colspan="5" class="muted">—</td></tr></tbody></table>
  <h2>Credit vesting</h2>
  <div id="vesting" class="muted">—</div>
  <div class="bar"><div id="vestbar"></div></div>
  <div style="margin-top:18px">
    <button class="btn" id="wrapBtn">Wrap now (backup trigger)</button>
    <button class="btn ghost" id="closeBtn">Close early (collect vested)</button>
    <button class="btn ghost" id="resetBtn">Reset demo</button>
    <span id="actionMsg" class="muted" style="margin-left:10px"></span>
  </div>
  <h2>History</h2>
  <table><thead><tr><th>id</th><th>position</th><th>credit</th><th>status</th></tr></thead>
  <tbody id="history"><tr><td colspan="4" class="muted">—</td></tr></tbody></table>
  <div class="note">Disclosure: the venue-side toggle is rendered locally by a browser extension to show placement — the venue is not (yet) a partner. Everything on this page is the live engine: real position reads, live options pricing, and (in okx modes) real hedge orders. Rails: kill switch, hard micro-notional cap, one wrap at a time, daily quota.</div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const badge = (t, c) => '<span class="badge" style="background:'+c+'">'+esc(t)+'</span>';
const card = (k, v, s) => '<div class="card"><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+'</div><div class="s">'+esc(s||"")+'</div></div>';
const fmt$ = (x) => (x==null?"—":(x<0?"−$":"$")+Math.abs(x).toFixed(2));
const stageLabel = {wrap_requested:"Wrap requested (toggle)",position_read:"Venue position read",quoted:"Collar priced (live OKX book)",hedge_executing:"Hedge legs executing",hedge_locked:"Hedge locked",green_light:"GREEN LIGHT — protection live",vesting:"Credit vesting",failed:"FAILED",concluded:"Concluded"};

const render = (st) => {
  const g = st.guards;
  const modeColor = g.executionMode==="okx_live"?"#9a1b1b":g.executionMode==="okx_demo"?"#9a6b00":"#0b5cab";
  $("badges").innerHTML =
    badge(g.enabled?"ARMED":"KILL SWITCH OFF", g.enabled?"#16794a":"#9a1b1b") +
    badge("mode: "+g.executionMode.toUpperCase().replace("_"," "), modeColor) +
    badge("micro cap $"+g.maxPositionNotionalUsdc, "#30363d") +
    badge("account "+(st.account? st.account.slice(0,6)+"…"+st.account.slice(-4) : "unset"), "#30363d");

  const p = st.position;
  const w = latestWrap(st);
  const q = w && w.quote;
  $("cards").innerHTML =
    card("Client position ("+(p?"Hyperliquid · live":"none")+")",
      p ? p.side.toUpperCase()+" "+p.szBase+" "+p.coin : (st.positionError?"read error":"no open "+st.coin),
      p ? "entry "+(p.entryPx?("$"+p.entryPx):"?")+" · mark $"+p.markPx.toFixed(1)+" · ≈$"+p.notionalUsdc : (st.positionError||"open a position to enable the toggle")) +
    card("Hedge quote", q ? fmt$(q.creditUsdc)+" credit" : "—",
      q ? "floor $"+q.putStrike+" ("+(q.floorPct*100).toFixed(1)+"%) · cap $"+q.callStrike+" ("+(q.capPct*100).toFixed(1)+"%)" : "priced on wrap") +
    card("Hedge venue", w && w.hedge ? w.hedge.venue.toUpperCase().replace("_"," ") : "—",
      w && w.hedge ? (w.hedge.sizeNote || (w.hedge.contracts!=null ? w.hedge.contracts+" × 0.01 BTC lots" : "model quote off the live book")) : "") +
    card("Status", w ? w.status.toUpperCase() : "IDLE", w && w.failReason ? w.failReason : "");

  if (w) {
    $("timeline").innerHTML = w.stages.map(s =>
      '<li class="'+(s.stage==="failed"?"fail":"done")+'"><b>'+esc(stageLabel[s.stage]||s.stage)+'</b> <span class="t">'+new Date(s.tsMs).toISOString().slice(11,19)+'Z</span>'+(s.note?'<div class="n">'+esc(s.note)+'</div>':'')+'</li>').join("");
    $("legs").innerHTML = w.legs.length ? w.legs.map(l =>
      '<tr><td>'+(l.role==="sell_call_cap"?"SELL call (cap)":"BUY put (floor)")+'</td><td>'+esc(l.instId||"—")+'</td><td>'+esc(l.orderId||"—")+'</td><td>'+fmt$(l.premiumUsdc)+'</td><td class="'+(l.real?"real":"paper")+'">'+(l.real?"REAL":"PAPER")+'</td></tr>').join("")
      : '<tr><td colspan="5" class="muted">—</td></tr>';
    const v = w.vestingStatus;
    if (v) {
      $("vesting").innerHTML = "<b>"+fmt$(v.vestedUsdc)+"</b> of "+fmt$(v.fullCreditUsdc)+" vested ("+(v.fraction*100).toFixed(1)+"%)"+(v.fullyVested?" — FULLY VESTED":" · "+Math.ceil(v.remainingMs/60000)+" min to full vest");
      $("vestbar").style.width = (v.fraction*100).toFixed(1)+"%";
    } else { $("vesting").textContent = w.status==="failed" ? "no vesting — wrap failed" : "—"; $("vestbar").style.width = "0"; }
  }
  $("history").innerHTML = (st.wraps||[]).slice().reverse().map(r =>
    '<tr><td>'+esc(r.id)+'</td><td>'+esc(r.position.side+" "+r.position.szBase+" "+r.position.coin)+'</td><td>'+fmt$(r.quote?r.quote.creditUsdc:null)+'</td><td>'+esc(r.status)+'</td></tr>').join("")
    || '<tr><td colspan="4" class="muted">—</td></tr>';
};
const latestWrap = (st) => (st.wraps && st.wraps.length ? st.wraps[st.wraps.length-1] : null);

const poll = async () => {
  try { render(await (await fetch("/demo/api/state")).json()); } catch (e) { /* keep last render */ }
};
$("wrapBtn").onclick = async () => {
  $("wrapBtn").disabled = true; $("actionMsg").textContent = "wrapping…";
  try {
    const r = await fetch("/demo/api/wrap", { method: "POST" });
    const j = await r.json();
    $("actionMsg").textContent = j.ok ? "wrap active" : (j.message || j.error || "refused");
  } catch (e) { $("actionMsg").textContent = "request failed: "+e; }
  $("wrapBtn").disabled = false; poll();
};
$("closeBtn").onclick = async () => {
  const r = await fetch("/demo/api/close", { method: "POST" });
  const j = await r.json();
  $("actionMsg").textContent = j.ok ? "closed early — collected $"+j.vested.vestedUsdc.toFixed(2)+" vested" : (j.message || "nothing to close");
  poll();
};
$("resetBtn").onclick = async () => {
  const r = await fetch("/demo/api/reset", { method: "POST" });
  const j = await r.json();
  $("actionMsg").textContent = j.ok ? "demo reset" : (j.message || "reset refused");
  poll();
};
poll(); setInterval(poll, 2000);
</script></body></html>`;

// ── HTTP server (permissive CORS — the extension's background worker calls in) ──

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(body, null, 2));
};

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/demo")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS });
      res.end(CONTROL_ROOM_HTML);
      return;
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/demo/api/state") {
      sendJson(res, 200, await buildState());
      return;
    }
    if (req.method === "POST" && url.pathname === "/demo/api/wrap") {
      if (wrapInFlight) {
        sendJson(res, 409, { ok: false, error: "in_flight", message: "a wrap request is already being processed" });
        return;
      }
      wrapInFlight = true;
      try {
        const out = await doWrap();
        sendJson(res, out.status, out.body);
      } finally {
        wrapInFlight = false;
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/demo/api/close") {
      // Voluntary early close (toggle OFF): collect vested-to-now, claw back the rest, unwind.
      const records = loadDemoWraps(storePath);
      const active = records.find((r) => r.status === "active");
      if (!active) {
        sendJson(res, 409, { ok: false, error: "nothing_active", message: "no active wrap to close" });
        return;
      }
      const v = concludeWrapEarly(active, Date.now());
      saveDemoWraps(records, storePath);
      sendJson(res, 200, { ok: true, wrap: active, vested: v });
      return;
    }
    if (req.method === "POST" && url.pathname === "/demo/api/reset") {
      if (!allowReset) {
        sendJson(res, 403, { ok: false, message: "reset disabled (DEMO_ALLOW_RESET=false)" });
        return;
      }
      saveDemoWraps([], storePath);
      sendJson(res, 200, { ok: true, message: "demo store cleared" });
      return;
    }
    sendJson(res, 404, { ok: false, error: "not_found" });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: "internal", message: (e as Error).message });
  }
});

server.listen(port, () => {
  console.error(`[demo] Wrap Control Room on http://localhost:${port}/demo`);
  console.error(`[demo] mode ${guards.executionMode.toUpperCase()} · kill switch ${guards.enabled ? "ARMED" : "OFF"} · micro cap $${guards.maxPositionNotionalUsdc} · account ${hlAccount() ?? "UNSET (set DEMO_HL_ADDRESS)"}`);
  if (guards.executionMode !== "paper") {
    const armed = executionArmed(parseLiveGuardsFromEnv(process.env, "okx"));
    console.error(`[demo] okx lane: ${armed.armed ? armed.reason : `NOT ARMED — ${armed.reason}`}`);
  }
});
