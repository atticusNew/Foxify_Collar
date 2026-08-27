#!/usr/bin/env tsx
/**
 * WRAP DEMO SERVICE — the Atticus half of the two-surface demo (the venue half is the real
 * Hyperliquid UI plus the locally-rendered "Protect" toggle in demo/hl-protect-extension).
 *
 * What it does, all real:
 *   1. POSITION  — reads the REAL Hyperliquid position (clearinghouseState) for DEMO_HL_ADDRESS.
 *   2. QUOTE     — listed OKX lots (floor, never round up). Credit = call bid − put ask − OKX fees
 *                  (pass-through, Atticus fee 0). No $80/$50k Foxify target. Cap stays off ATM.
 *   3. EXECUTE   — DEMO_EXECUTION=paper (default): listed-book quote, clearly labeled PAPER.
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
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HyperliquidClient } from "../src/singleSide/twoSided/creditCollar/execution/perpVenues/hyperliquidClient";
import { parseBrandAllowlist, resolveBrandFor } from "../src/singleSide/twoSided/creditCollar/epBranding";
import {
  assessDemoWrap,
  assessUnderlying,
  capTouched,
  concludeWrapEarly,
  coverOkxLots,
  cyclePayable,
  demoPlanStrikes,
  demoVestingStatus,
  DEMO_CAP_PCT,
  DEMO_FLOOR_PCT,
  failWrap,
  knockoutWrap,
  newDemoWrap,
  OKX_OPTION_LOT_BTC,
  paperLegsFromQuote,
  parseDemoGuardsFromEnv,
  pushStage,
  renewalStaggerOffsetMs,
  wrapCapStrike,
  wrapExposureUsdc,
  wrapRefuseFromLive,
  concludeAtExpiry,
  renewalDecision,
  type DemoLeg,
  type DemoWrapRecord
} from "../src/singleSide/twoSided/creditCollar/demoWrap";
import {
  accrueWrapPayout,
  processPayoutLedger,
  type PayoutSender
} from "../src/singleSide/twoSided/creditCollar/settlement/payoutLedger";
import { buildPayoutSender, parsePayoutRailFromEnv } from "../src/singleSide/twoSided/creditCollar/settlement/usdcPayout";
import { unwindLiveCollar } from "../src/singleSide/twoSided/creditCollar/execution/okxLiveUnwind";
import {
  applyTake,
  assessCohort,
  assessStrikeConcentration,
  deriveCaps,
  parseCapsInputsFromEnv,
  partialWrapSizing,
  registerWallet,
  takeRateFor,
  type StrikeExposure
} from "../src/singleSide/twoSided/creditCollar/capsConfig";
import {
  ensureEpSchema,
  jsonStores,
  postgresStores,
  reconcileOpenWraps,
  type EpStores,
  type EpStorePaths
} from "../src/singleSide/twoSided/creditCollar/store/epStores";
import {
  adminAuthorized,
  buildAlertRaiser,
  parseAdminAuthFromEnv,
  parseAlertSinkFromEnv,
  stalledLoops,
  tokenBucketLimiter,
  type LoopPulse
} from "../src/singleSide/twoSided/creditCollar/epSafety";
import { assessGeofence, buildCountryResolver, parseGeofenceFromEnv } from "../src/singleSide/twoSided/creditCollar/epGeofence";
import { emptyFunnel, funnelSummary, parseInternalAccounts, recordLooker, recordPageLoad, type FunnelState } from "../src/singleSide/twoSided/creditCollar/epFunnel";
import { parseLeaderboardTop, parseShowcaseOverride, type ShowcaseWallet } from "../src/singleSide/twoSided/creditCollar/epShowcase";
import { actionCleared, closeAllowed, verifyMessageText, verifyWalletSignature } from "../src/singleSide/twoSided/creditCollar/epVerify";
import { EP_MINI_APP_HTML, EP_WEB_APP_HTML } from "./earnProtectWebAppHtml";
import { EP_PUBLIC_DASHBOARD_HTML, EP_TOS_HTML } from "./earnProtectPublicPagesHtml";
import { Pool } from "pg";
import { type PerpSide } from "../src/singleSide/twoSided/creditCollar/creditCollarPricer";
import { evaluateRegimeGate } from "../src/singleSide/twoSided/creditCollar/regimeGate";
import { OkxExecutionClient } from "../src/singleSide/twoSided/creditCollar/execution/okxExecutionClient";
import { fetchOkxListedTouchQuote } from "../src/singleSide/twoSided/creditCollar/execution/okxListedTouchQuote";
import { buildOkxLiveExecutionHook } from "../src/singleSide/twoSided/creditCollar/execution/okxLiveRunner";
import { executionArmed, parseLiveGuardsFromEnv } from "../src/singleSide/twoSided/creditCollar/execution/liveGuards";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);
const round2 = (x: number) => +x.toFixed(2);

const port = num(process.env.DEMO_PORT ?? process.env.PORT, 8788); // PORT: hosted platforms (Render) inject it
/** The single-SVG brand lockup (drop-in — see scripts/assets/README.md). */
const BRAND_LOCKUP_PATH = join(dirname(fileURLToPath(import.meta.url)), "assets", "atticus-lockup.svg");
const guards = parseDemoGuardsFromEnv(process.env);
const storePath = process.env.DEMO_STORE_PATH ?? "./logs/demo-wraps.json";
const allowReset = String(process.env.DEMO_ALLOW_RESET ?? "true").toLowerCase() === "true";
const coin = process.env.DEMO_COIN ?? "BTC";

// Auto-renew: protection is a STATE — while an account's toggle is on, expired wraps re-quote and
// re-wrap at the morning book; unfundable books are honest skip-days retried on a throttle.
const autoRenew = String(process.env.DEMO_AUTO_RENEW ?? "true").toLowerCase() === "true";
const renewRetryMs = num(process.env.DEMO_RENEW_RETRY_MS, 900_000); // skip-day retry throttle (15 min)
const renewCheckMs = num(process.env.DEMO_RENEW_CHECK_MS, 60_000);
// Staggered renewals (decision 7): every daily option shares one fixing, so renewals are spread
// across a per-account anchor window instead of batching the whole book onto one tick/strike.
const renewStaggerMs = num(process.env.DEMO_RENEW_STAGGER_MS, 1_800_000); // 30 min window
// Design B knockout monitor + payout rail.
const knockoutCheckMs = num(process.env.DEMO_KNOCKOUT_CHECK_MS, 15_000);
const payoutCheckMs = num(process.env.DEMO_PAYOUT_CHECK_MS, 60_000);
const payoutRail = parsePayoutRailFromEnv(process.env);

// ── Phase 2: caps-as-formulas, stores, safety ─────────────────────────────────

// Formula-derived caps (decision 4). Explicit DEMO_MAX_* envs still override for dev pinning.
const capsInputs = parseCapsInputsFromEnv(process.env);
const bookCapOverridden = process.env.DEMO_MAX_BOOK_NOTIONAL_USDC != null;
const walletCapOverridden = process.env.DEMO_MAX_NOTIONAL_USDC != null;

// Storage: DATABASE_URL ⟹ Postgres (production); otherwise the Phase 1 JSON files (dev default).
const storePaths: EpStorePaths = {
  wraps: storePath,
  protection: process.env.DEMO_PROTECTION_STORE_PATH ?? "./logs/demo-protection.json",
  ledger: process.env.DEMO_PAYOUT_LEDGER_PATH ?? "./logs/demo-payout-ledger.json",
  registry: process.env.EP_WALLET_REGISTRY_PATH ?? "./logs/ep-wallets.json",
  runtime: process.env.EP_RUNTIME_PATH ?? "./logs/ep-runtime.json",
  tos: process.env.EP_TOS_STORE_PATH ?? "./logs/ep-tos.json",
  waitlist: process.env.EP_WAITLIST_PATH ?? "./logs/ep-waitlist.json",
  funnel: process.env.EP_FUNNEL_PATH ?? "./logs/ep-funnel.json"
};
const pgPool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }) : null;
const stores: EpStores = pgPool ? postgresStores(pgPool) : jsonStores(storePaths);

// Top-of-funnel counters (who LOOKED, not just who wrapped) — in-memory, flushed by a boot-started
// timer. Distinguishes a reach problem from a conversion problem during launch. The operator's own
// test wallets (EP_INTERNAL_ACCOUNTS, comma-separated) are flagged and kept OUT of headline counts.
let funnelState: FunnelState = emptyFunnel();
let funnelDirty = false;
const internalAccounts = parseInternalAccounts(process.env.EP_INTERNAL_ACCOUNTS);

// ── Showcase (watch mode): live public wallets from HL's leaderboard ─────────
// Candidates come from EP_SHOWCASE_ADDRESSES (curated) or the public leaderboard (top account
// values), validated against LIVE open BTC positions, cached, and — critically — action-guarded:
// a showcased address can be WATCHED by anyone but never wrapped/closed/toggled by anyone.
const SHOWCASE_TTL_MS = 30 * 60_000;
let showcaseCache: { atMs: number; wallets: ShowcaseWallet[] } = { atMs: 0, wallets: [] };
let showcaseRefreshing = false;
const showcaseSet = new Set<string>(); // lowercase addresses currently on display

const refreshShowcase = async (): Promise<void> => {
  if (showcaseRefreshing) return;
  showcaseRefreshing = true;
  try {
    let candidates = parseShowcaseOverride(process.env.EP_SHOWCASE_ADDRESSES);
    if (candidates.length === 0) {
      const res = await fetch("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard");
      if (res.ok) candidates = parseLeaderboardTop(await res.text(), 25).map((c) => c.address);
    }
    const wallets: ShowcaseWallet[] = [];
    for (const addr of candidates) {
      if (wallets.length >= 3) break;
      try {
        const pos = await readHlPosition(addr);
        if (pos) wallets.push({ address: addr, side: pos.side, szBase: pos.szBase, notionalUsdc: pos.notionalUsdc });
      } catch {
        /* unreadable candidate — skip */
      }
    }
    // Empty result keeps the PREVIOUS set (serve stale over serving nothing) unless we never had one.
    if (wallets.length > 0 || showcaseCache.wallets.length === 0) {
      showcaseCache = { atMs: Date.now(), wallets };
      showcaseSet.clear();
      for (const w of wallets) showcaseSet.add(w.address);
    } else {
      showcaseCache = { ...showcaseCache, atMs: Date.now() };
    }
  } catch (e) {
    console.error(`[demo] showcase refresh failed: ${(e as Error).message}`);
  } finally {
    showcaseRefreshing = false;
  }
};
const isShowcase = (account: string): boolean => showcaseSet.has(account.toLowerCase());

// Safety rails: admin auth, per-IP rate limits, alert fan-out, loop watchdog.
const adminAuth = parseAdminAuthFromEnv(process.env);
const raiseAlert = buildAlertRaiser(parseAlertSinkFromEnv(process.env));
const readLimiter = tokenBucketLimiter(num(process.env.EP_RATE_READS_PER_MIN, 120), 60_000);
const actionLimiter = tokenBucketLimiter(num(process.env.EP_RATE_ACTIONS_PER_MIN, 12), 60_000);
const loopPulses: Record<string, LoopPulse> = {
  renewal: { name: "renewal", lastRunMs: 0, intervalMs: renewCheckMs },
  monitor: { name: "monitor", lastRunMs: 0, intervalMs: knockoutCheckMs },
  payout: { name: "payout", lastRunMs: 0, intervalMs: payoutCheckMs }
};
let okxQuoteFailStreak = 0;

// Kill switch: DEMO_ENABLED (env, boot-time) AND the runtime pause flag (admin endpoint, persisted).
// Both pause NEW wraps + renewals only — conclusions, knockouts, and payouts always keep running.
let runtimePaused = false;
let runtimePausedReason: string | null = null;

// Phase 3 launch gates: geofence (blocks ACTIONS from US + sanctioned IPs, fail-closed) and the
// versioned ToS acceptance step. Both default OFF for dev; production turns them on via env.
const geofence = parseGeofenceFromEnv(process.env);
const resolveCountry = buildCountryResolver(geofence);
const tosVersion = process.env.EP_TOS_VERSION ?? "2026-08-draft";
const tosRequired = String(process.env.EP_TOS_REQUIRED ?? "false").toLowerCase() === "true";
// Public-demo hardening: actions (wrap/close/protection) require a one-time wallet signature
// that doubles as SIGNED ToS acceptance. Viewing never requires anything.
const requireActionSig = String(process.env.EP_REQUIRE_ACTION_SIG ?? "false").toLowerCase() === "true";
// Close gate (default ON, zero friction): early close needs the control token issued to the
// client that opened protection — or a signer-verified wallet, or the admin. EP_CLOSE_GATE=false disarms.
const closeGate = String(process.env.EP_CLOSE_GATE ?? "true").toLowerCase() === "true";
// Cohort count display: OFF by default — clients show the scarcity line ("first N wallets")
// without the live numerator until the fill reads as momentum. The real count stays in the
// payload (never faked, just not headlined); flip EP_SHOW_COHORT_COUNT=true to display it.
const showCohortCount = String(process.env.EP_SHOW_COHORT_COUNT ?? "false").toLowerCase() === "true";
// Acquisition aids (preview tab + watch chips): ON for the demo phase, one env flip removes them
// when the platform matures. Grammar (lookup copy, safety line) is permanent; aids are seasonal.
const demoAids = String(process.env.EP_DEMO_AIDS ?? "true").toLowerCase() === "true";
const setProtection = async (account: string, on: boolean): Promise<void> => {
  const prefs = await stores.loadPrefs();
  const key = account.toLowerCase();
  if (on) prefs[key] = { ...(prefs[key] ?? { sinceMs: Date.now() }), on: true, sinceMs: prefs[key]?.on ? prefs[key].sinceMs : Date.now() };
  else if (prefs[key]) prefs[key] = { ...prefs[key], on: false };
  await stores.savePrefs(prefs);
};

/**
 * Effective guards for a wrap at the current spot: book + per-wallet caps come from the caps
 * formulas (decision 4) unless the legacy DEMO_MAX_* envs pin them explicitly (dev).
 */
const effectiveGuards = (spotUsd: number) => {
  const derived = deriveCaps(capsInputs, spotUsd);
  return {
    guards: {
      ...guards,
      maxBookNotionalUsdc: bookCapOverridden ? guards.maxBookNotionalUsdc : derived.bookCapUsdc,
      maxPositionNotionalUsdc: walletCapOverridden ? guards.maxPositionNotionalUsdc : derived.perWalletCapUsdc
    },
    derived
  };
};

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

// ── Stage A: multi-client accounts ────────────────────────────────────────────
// DEMO_ALLOWED_ACCOUNTS: comma-separated extra HL addresses that may wrap through this service
// ("*" = any address — pilot open mode; book caps still bound total exposure). The primary
// (DEMO_HL_ADDRESS) is always allowed. Every wrap/close/state call may carry ?account=0x…;
// omitted ⟹ the primary, so the extension and existing flows are unchanged.
const allowedAccounts = (process.env.DEMO_ALLOWED_ACCOUNTS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const accountAllowed = (a: string): boolean => {
  const primary = (hlAccount() ?? "").toLowerCase();
  const c = a.toLowerCase();
  return c === primary || allowedAccounts.includes("*") || allowedAccounts.includes(c);
};
const resolveAccount = (raw: string | null): { ok: true; account: string } | { ok: false; message: string } => {
  const account = (raw ?? hlAccount() ?? "").trim();
  if (!account) return { ok: false, message: "no account — set DEMO_HL_ADDRESS or pass ?account=0x…" };
  if (!/^0x[0-9a-fA-F]{40}$/.test(account)) return { ok: false, message: `not an address: ${account}` };
  if (!accountAllowed(account)) return { ok: false, message: `account ${account} is not on the allow-list (DEMO_ALLOWED_ACCOUNTS)` };
  return { ok: true, account };
};

const floorPct = num(process.env.DEMO_FLOOR_PCT, DEMO_FLOOR_PCT);
const capPct = num(process.env.DEMO_CAP_PCT, DEMO_CAP_PCT);

const DAY_MS = 86_400_000;

type HlPositionRead = {
  coin: string;
  side: PerpSide;
  szBase: number;
  entryPx: number | null;
  markPx: number;
  notionalUsdc: number;
};

// Freshest HL mark seen by any loop — lets /api/state carry a live price even when the account
// has no open position (the header ticker). Refreshed by position reads and the 15s monitor tick.
let lastHlMark: number | null = null;

const readHlPosition = async (account?: string | null): Promise<HlPositionRead | null> => {
  const acct = account ?? hlAccount();
  if (!acct) return null;
  const [detail, mark] = await Promise.all([hl.positionDetail(acct, coin), hl.midPx(coin)]);
  if (Number.isFinite(mark) && mark > 0) lastHlMark = mark;
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

// Per-account in-flight lock: different clients may wrap concurrently; one client is serialized.
// Timestamped + self-healing: an upstream hang (venue fetch without a response) must never brick
// a wallet forever (production incident: a stuck lock refused every wrap as "already processed"
// with nothing in the store). Stale locks are ignored after WRAP_LOCK_STALE_MS, and the wrap
// request itself is raced against a hard timeout so the client always gets an honest answer.
const wrapsInFlight = new Map<string, number>();
const WRAP_LOCK_STALE_MS = 3 * 60_000;
const WRAP_REQUEST_TIMEOUT_MS = num(process.env.EP_WRAP_TIMEOUT_MS, 150_000);
const wrapLocked = (key: string): boolean => {
  const t = wrapsInFlight.get(key);
  if (t == null) return false;
  if (Date.now() - t >= WRAP_LOCK_STALE_MS) {
    console.error(`[demo] clearing STALE wrap lock for ${key} (held ${Math.round((Date.now() - t) / 1000)}s)`);
    wrapsInFlight.delete(key);
    return false;
  }
  return true;
};
const withTimeout = async <T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const doWrap = async (account: string, renewal = false, idempotencyKey: string | null = null): Promise<{ status: number; body: unknown }> => {
  const nowMs = Date.now();
  const records = await stores.loadWraps();

  // Idempotent wrap requests: a client retry with the same key returns the ORIGINAL outcome —
  // a flaky network can never open two wraps.
  if (idempotencyKey) {
    const prior = records.find((r) => r.account.toLowerCase() === account.toLowerCase() && r.idempotencyKey === idempotencyKey);
    if (prior) {
      return prior.status === "failed"
        ? { status: 409, body: { ok: false, error: "refused", message: prior.failReason, wrap: prior, idempotentReplay: true } }
        : { status: 200, body: { ok: true, wrap: prior, idempotentReplay: true } };
    }
  }

  // Kill switch (env) + runtime pause (admin endpoint): new wraps stop; conclusions/payouts don't.
  if (runtimePaused) {
    return { status: 409, body: { ok: false, error: "paused", message: `protection paused${runtimePausedReason ? ` — ${runtimePausedReason}` : ""} — existing wraps conclude and pay normally` } };
  }

  // Action gate (Phase 3 + public-demo hardening): current ToS version accepted, and — when the
  // signature gate is armed — proven by a one-time wallet signature. A ToS bump stops renewals
  // until one re-acceptance in any client (honest: renewals resume immediately after).
  if (tosRequired || requireActionSig) {
    const tos = await stores.loadTos();
    const cleared = actionCleared(tos, account, tosVersion, requireActionSig, tosRequired);
    if (!cleared.ok) {
      const err = cleared.error.startsWith("verify_required") ? "verify_required" : "tos_required";
      return { status: 409, body: { ok: false, error: err, message: cleared.error } };
    }
  }

  let position: HlPositionRead | null;
  try {
    position = await readHlPosition(account);
  } catch (e) {
    return { status: 502, body: { ok: false, error: "position_read_failed", message: (e as Error).message } };
  }
  if (!position) {
    return { status: 409, body: { ok: false, error: "no_position", message: `no open ${coin} position on ${account}` } };
  }

  // Formula caps at this spot (decision 4) + founding cohort / waitlist (50 wallets).
  const { guards: guardsEff, derived } = effectiveGuards(position.markPx);
  const registry = await stores.loadRegistry();
  const cohort = assessCohort(registry, account, derived.maxWallets);
  if (!cohort.ok) {
    // Cohort full: enroll first-come on the waitlist (idempotent) and say WHERE they stand.
    const waitlist = await stores.loadWaitlist();
    let pos = waitlist.findIndex((w) => w.account.toLowerCase() === account.toLowerCase());
    if (pos < 0) {
      waitlist.push({ account: account.toLowerCase(), joinedAtMs: nowMs });
      await stores.saveWaitlist(waitlist);
      pos = waitlist.length - 1;
    }
    return { status: 409, body: { ok: false, error: "waitlisted", message: `${cohort.reason} — you're #${pos + 1} in line; capacity grows with capital`, waitlistPosition: pos + 1 } };
  }

  // Partial wraps (decision 6): wrap min(position, remaining per-wallet cap), floored to whole
  // lots — an oversized position is covered partially with honest copy, never refused.
  const isOpenRec = (r: DemoWrapRecord) => r.status === "quoting" || r.status === "executing" || r.status === "active";
  const walletOpenNotionalUsdc = records
    .filter((r) => r.account.toLowerCase() === account.toLowerCase() && isOpenRec(r))
    .reduce((s, r) => s + wrapExposureUsdc(r), 0);
  const sizing = partialWrapSizing(position.szBase, position.notionalUsdc, derived.perWalletCapUsdc, walletOpenNotionalUsdc, position.markPx);
  if (!sizing.ok) {
    const err = /minimum one lot/.test(sizing.reason) ? "below_min_lot" : "wallet_cap";
    return { status: 409, body: { ok: false, error: err, message: sizing.reason } };
  }
  const cover = { ok: true as const, coveredBtc: sizing.coveredBtc, lots: sizing.lots, remainderBtc: +Math.max(0, position.szBase - sizing.coveredBtc).toFixed(8) };
  const coveredNotionalUsdc = sizing.coveredNotionalUsdc;
  const sizeNote = sizing.coverageNote;

  const permit = assessDemoWrap(guardsEff, nowMs, coveredNotionalUsdc, records, account, renewal);
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

  const rec = newDemoWrap(`wrap-${nowMs}`, nowMs, "hyperliquid", account, position);
  if (renewal) rec.stages[0].note = "auto-renewal — protection stayed on through expiry";
  if (idempotencyKey) rec.idempotencyKey = idempotencyKey;
  rec.wrappedNotionalUsdc = coveredNotionalUsdc; // the book carries the HEDGED exposure, not the raw position
  records.push(rec);
  await stores.saveWraps(records);
  const persist = () => stores.saveWraps(records);

  // 2) QUOTE — listed OKX lots. Credit = executable touch net of OKX fees. No $80/$50k target.
  const spot = position.markPx;
  const hedgeNotionalUsdc = round2(cover.coveredBtc * spot);
  const plan = demoPlanStrikes(spot, position.side, floorPct, capPct);
  const listed = await fetchOkxListedTouchQuote({
    side: position.side,
    spot,
    planPutStrike: plan.putStrike,
    planCallStrike: plan.callStrike,
    notionalUsdc: hedgeNotionalUsdc,
    contractsBtc: cover.coveredBtc,
    nowMs: Date.now()
  });
  if (!listed.ok) {
    okxQuoteFailStreak = /listed_book_empty|chain|fetch|network/i.test(listed.error) ? okxQuoteFailStreak + 1 : 0;
    if (okxQuoteFailStreak >= 3)
      raiseAlert("okx_connectivity", `OKX quote path failing (${okxQuoteFailStreak} consecutive): ${listed.error}`, undefined, { dedupeKey: "okx_quote_path" });
    failWrap(rec, Date.now(), `wrap refused: ${listed.error} — ${listed.message}`);
    await persist();
    return { status: 409, body: { ok: false, error: listed.error, message: listed.message, wrap: rec } };
  }
  okxQuoteFailStreak = 0;

  // Per-strike concentration (decision 4): the sold wing must stay unwindable on the screen if a
  // cluster of same-strike wraps knocks out together.
  const capStrikeListed = position.side === "long" ? listed.callStrike : listed.putStrike;
  const openExposures: StrikeExposure[] = records
    .filter((r) => r.id !== rec.id && isOpenRec(r) && r.quote != null)
    .map((r) => ({ capStrike: wrapCapStrike(r)!, notionalUsdc: wrapExposureUsdc(r) }));
  const conc = assessStrikeConcentration(
    openExposures,
    { capStrike: capStrikeListed, notionalUsdc: coveredNotionalUsdc },
    capsInputs.perStrikeCapPct,
    capsInputs.perStrikeFloorLots,
    spot
  );
  if (!conc.ok) {
    failWrap(rec, Date.now(), conc.reason);
    await persist();
    return { status: 409, body: { ok: false, error: "strike_concentration", message: conc.reason, wrap: rec } };
  }

  // Spread take (decision 3): the trader is quoted and paid the NET credit; the split is recorded
  // and published honestly. Founding wallets keep their locked rate for 12 months.
  const joinedAtMs = cohort.joinedAtMs ?? nowMs; // a new wallet joins the cohort with THIS wrap
  const rate = takeRateFor(capsInputs, joinedAtMs, nowMs);
  const q = {
    legs: {
      putStrike: listed.putStrike,
      callStrike: listed.callStrike,
      floor_pct: listed.floorPct,
      cap_pct: listed.capPct,
      // Side-aware roles: long buys the put / sells the call; short mirrors (buys call, sells put).
      floor_leg_mid_usdc: position.side === "long" ? listed.putMidUsdc : listed.callMidUsdc,
      funding_leg_mid_usdc: position.side === "long" ? listed.callMidUsdc : listed.putMidUsdc
    },
    economics: { foxify_credit_usdc: listed.creditUsdc }
  };
  const floorStrike = position.side === "long" ? listed.putStrike : listed.callStrike;
  const capStrike = position.side === "long" ? listed.callStrike : listed.putStrike;
  const floorUsedPct = listed.floorPct;
  const tenorDays = Math.max(1 / 24, (listed.expiryMs - Date.now()) / DAY_MS);
  // The trader is quoted the NET credit (gross minus the published take). One-number rule: every
  // surface shows this number; the gross/split lives in rec.economics for the honest breakdown.
  const quotedSplit = applyTake(q.economics.foxify_credit_usdc, rate.ratePct, capsInputs.deMinimisUsdc, rate.founding);
  rec.quote = {
    spot: round2(spot),
    putStrike: q.legs.putStrike,
    callStrike: q.legs.callStrike,
    floorPct: q.legs.floor_pct,
    capPct: q.legs.cap_pct,
    creditUsdc: quotedSplit.traderCreditUsdc,
    quotedCreditUsdc: quotedSplit.traderCreditUsdc, // kept as labeled history once the fill lands
    floorStrike,
    capStrike,
    floorPctUsed: floorUsedPct,
    tenorDays: +tenorDays.toFixed(2)
  };
  rec.economics = {
    grossCreditUsdc: q.economics.foxify_credit_usdc,
    atticusTakeUsdc: quotedSplit.atticusTakeUsdc,
    takeRatePct: quotedSplit.appliedRatePct,
    founding: rate.founding
  };
  pushStage(
    rec,
    "quoted",
    Date.now(),
    `floor $${floorStrike} / cap $${capStrike} · credit $${quotedSplit.traderCreditUsdc}` +
      (quotedSplit.atticusTakeUsdc > 0
        ? ` (market sourced $${q.economics.foxify_credit_usdc}; we keep ${(quotedSplit.appliedRatePct * 100).toFixed(0)}%${rate.founding ? " founding rate" : ""})`
        : ` (market sourced $${q.economics.foxify_credit_usdc}; our cut waived under $${capsInputs.deMinimisUsdc.toFixed(2)})`) +
      ` · listed OKX ${listed.putInstId} / ${listed.callInstId} touch` +
      (sizeNote ? ` · ${sizeNote}` : "")
  );
  await persist();

  // 3) EXECUTE.
  if (guards.executionMode === "paper") {
    const expiresAtMs = listed.expiryMs;
    rec.legs = paperLegsFromQuote(q, expiresAtMs, position.side);
    rec.hedge = { venue: "okx_model", mode: "paper", netCreditUsdc: q.economics.foxify_credit_usdc, venueFeeUsdc: listed.venueFeeUsdc, contracts: cover.lots, sizeNote };
    pushStage(rec, "hedge_locked", Date.now(), "PAPER lane — listed OKX touch quote, no venue orders");
    pushStage(rec, "green_light", Date.now());
    rec.vesting = { fullCreditUsdc: quotedSplit.traderCreditUsdc, startMs: Date.now(), endMs: expiresAtMs };
    pushStage(rec, "vesting", Date.now(), `$${quotedSplit.traderCreditUsdc} vests linearly to ${new Date(expiresAtMs).toISOString()}`);
    rec.status = "active";
    registerWallet(registry, account, nowMs);
    await stores.saveRegistry(registry);
    await persist();
    return { status: 200, body: { ok: true, wrap: rec } };
  }

  // okx_demo / okx_live — real hedge legs; size is FLOORED lots (never round up).
  rec.status = "executing";
  pushStage(rec, "hedge_executing", Date.now(), `real ${guards.executionMode.replace("okx_", "OKX ")} legs going out`);
  await persist();
  const { OKX_API_KEY: k, OKX_API_SECRET: s, OKX_API_PASSPHRASE: p } = process.env;
  if (!k || !s || !p) {
    failWrap(rec, Date.now(), "missing OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE");
    await persist();
    return { status: 409, body: { ok: false, error: "missing_credentials", message: rec.failReason, wrap: rec } };
  }
  const liveGuards = {
    ...parseLiveGuardsFromEnv(process.env, "okx"),
    windowUtc: "00:00",
    windowLatestUtc: "23:59",
    // Exact covered lots (already ≥ 1). Pins the plan to floor(sz/0.01), never USD-round up.
    canaryContracts: cover.lots
  };
  const hook = buildOkxLiveExecutionHook(
    // demo wrap = the client's own decision (no partner gate) + hard guarantee: never fill worse
    // than the credit quoted to the client — a breach unwinds instead of booking.
    { ...process.env, LIVE_DIRECTIONAL_DECISION: "auto", LIVE_ENFORCE_QUOTE_FLOOR: "true" },
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
              notionalUsdc: hedgeNotionalUsdc,
              putStrike: q.legs.putStrike,
              callStrike: q.legs.callStrike,
              foxifyCreditUsdc: q.economics.foxify_credit_usdc,
              serviceFeeUsdc: 0,
              floorPctUsed: floorUsedPct,
              // Band anchors = the EXACT listed touches the credit was computed from (6dp), not
              // cent-rounded display mids — the executor buys/sells at the validated prices.
              protectiveLegMidUsdc: listed.protectiveTouchUsdc,
              fundingLegMidUsdc: listed.fundingTouchUsdc
            }
          }
        : { ok: false as const, error: "wrong_side", message: "demo wraps only the client's actual side" }
  });
  if (res.newOpens.length === 0) {
    failWrap(rec, Date.now(), wrapRefuseFromLive(String(res.summary ?? "hedge did not fill"), res.venueErrors ?? []));
    if (/unwound|unwind/i.test(String(res.summary ?? ""))) {
      raiseAlert("unwind_event", `wrap ${rec.id} aborted with an unwind: ${rec.failReason}`);
    }
    await persist();
    return { status: 502, body: { ok: false, error: "hedge_not_filled", message: rec.failReason, wrap: rec } };
  }
  const pos = res.newOpens[0];
  // Side-aware roles: for a long the call is sold (cap) and the put bought (floor); a short mirrors.
  const legs: DemoLeg[] =
    position.side === "long"
      ? [
          { role: "sell_call_cap", instId: pos.liveMeta?.callInstId ?? null, orderId: pos.liveMeta?.clOrdPrefix ?? null, premiumUsdc: round2(pos.fundingLegPremiumUsdc ?? 0), real: true },
          { role: "buy_put_floor", instId: pos.liveMeta?.putInstId ?? null, orderId: pos.liveMeta?.clOrdPrefix ?? null, premiumUsdc: round2(-(pos.protectiveLegPremiumUsdc ?? 0)), real: true }
        ]
      : [
          { role: "sell_put_cap", instId: pos.liveMeta?.putInstId ?? null, orderId: pos.liveMeta?.clOrdPrefix ?? null, premiumUsdc: round2(pos.fundingLegPremiumUsdc ?? 0), real: true },
          { role: "buy_call_floor", instId: pos.liveMeta?.callInstId ?? null, orderId: pos.liveMeta?.clOrdPrefix ?? null, premiumUsdc: round2(-(pos.protectiveLegPremiumUsdc ?? 0)), real: true }
        ];
  rec.legs = legs;
  const hedgedBtc = (pos.liveMeta?.contracts ?? 0) * (pos.liveMeta?.ctValBtc ?? 0.01);
  rec.hedge = {
    venue: guards.executionMode,
    mode: guards.executionMode,
    netCreditUsdc: pos.foxifyCreditUsdc,
    venueFeeUsdc: pos.liveMeta?.venueFeeUsdc ?? null,
    contracts: pos.liveMeta?.contracts ?? null,
    sizeNote:
      sizeNote ??
      (hedgedBtc > position.szBase + 1e-8
        ? `protecting ${cover.coveredBtc} of ${position.szBase} BTC (${cover.lots} × 0.01)`
        : null)
  };
  // ONE-NUMBER RULE: after the fill, every surface shows the trader's REALIZED credit (net of the
  // published take); the quote survives only as labeled history ("quoted → filled").
  const realizedSplit = applyTake(pos.foxifyCreditUsdc, rate.ratePct, capsInputs.deMinimisUsdc, rate.founding);
  const quotedCredit = rec.quote?.creditUsdc ?? realizedSplit.traderCreditUsdc;
  if (rec.quote) rec.quote.creditUsdc = realizedSplit.traderCreditUsdc;
  rec.economics = {
    grossCreditUsdc: pos.foxifyCreditUsdc,
    atticusTakeUsdc: realizedSplit.atticusTakeUsdc,
    takeRatePct: realizedSplit.appliedRatePct,
    founding: rate.founding
  };
  const beatQuote = realizedSplit.traderCreditUsdc > quotedCredit + 0.005;
  pushStage(
    rec,
    "hedge_locked",
    Date.now(),
    beatQuote
      ? `filled — net credit $${realizedSplit.traderCreditUsdc} (quoted $${quotedCredit}, price improvement passed through) · fees $${pos.liveMeta?.venueFeeUsdc ?? 0}`
      : `filled — net credit $${realizedSplit.traderCreditUsdc} · fees $${pos.liveMeta?.venueFeeUsdc ?? 0}`
  );
  pushStage(rec, "green_light", Date.now());
  rec.vesting = { fullCreditUsdc: realizedSplit.traderCreditUsdc, startMs: Date.now(), endMs: pos.expiresAtMs };
  pushStage(rec, "vesting", Date.now(), `$${realizedSplit.traderCreditUsdc} vests linearly to ${new Date(pos.expiresAtMs).toISOString()}`);
  rec.status = "active";
  registerWallet(registry, account, nowMs);
  await stores.saveRegistry(registry);
  await persist();
  return { status: 200, body: { ok: true, wrap: rec } };
};

// ── State for the control room + extension chip ───────────────────────────────

const buildState = async (account?: string, all = false) => {
  const nowMs = Date.now();
  const acct = account ?? hlAccount();
  let position: HlPositionRead | null = null;
  let positionError: string | null = null;
  try {
    position = await readHlPosition(acct);
  } catch (e) {
    positionError = (e as Error).message;
  }
  const decorate = (r: DemoWrapRecord) => {
    if (r.status === "active" && r.vesting && r.concludedAtMs == null && nowMs >= r.vesting.endMs) {
      // Display-only conclusion: the tenor has run — fully vested.
      return { ...r, status: "concluded" as const, vestingStatus: demoVestingStatus(r, nowMs) };
    }
    return { ...r, vestingStatus: demoVestingStatus(r, nowMs) };
  };
  const allWraps = (await stores.loadWraps()).map(decorate);
  // Default view = the requested account only (the extension's chip must never show another
  // client's wrap). ?all=1 = the whole book for the ops view.
  const wraps = all ? allWraps : allWraps.filter((r) => r.account.toLowerCase() === (acct ?? "").toLowerCase());
  const open = allWraps.filter((r) => r.status === "quoting" || r.status === "executing" || r.status === "active");
  const [ledger, prefs, registry, waitlist, tosReg] = await Promise.all([stores.loadLedger(), stores.loadPrefs(), stores.loadRegistry(), stores.loadWaitlist(), stores.loadTos()]);
  const paidStatuses = new Set(["paid", "confirmed"]);
  const refSpot = position?.markPx ?? open.find((r) => r.quote)?.quote?.spot ?? 0;
  const derived = deriveCaps(capsInputs, refSpot);
  return {
    ok: true,
    guards: {
      enabled: guards.enabled && !runtimePaused,
      paused: runtimePaused,
      pausedReason: runtimePausedReason,
      executionMode: guards.executionMode,
      maxPositionNotionalUsdc: walletCapOverridden ? guards.maxPositionNotionalUsdc : derived.perWalletCapUsdc,
      maxWrapsPerDay: guards.maxWrapsPerDay,
      cooldownMs: guards.cooldownMs,
      maxBookNotionalUsdc: bookCapOverridden ? guards.maxBookNotionalUsdc : derived.bookCapUsdc,
      maxActiveWraps: guards.maxActiveWraps
    },
    // Formula-derived capacity (decision 4) — published so every client shows the same truth.
    caps: {
      subAccountCapitalUsdc: capsInputs.subAccountCapitalUsdc,
      marginPerWrapRate: capsInputs.marginPerWrapRate,
      usableMarginUsdc: derived.usableMarginUsdc,
      bookCapUsdc: derived.bookCapUsdc,
      perWalletCapUsdc: derived.perWalletCapUsdc,
      perStrikeCapPct: derived.perStrikeCapPct,
      foundingWallets: capsInputs.foundingWallets,
      walletsJoined: Object.keys(registry).length,
      waitlistLength: waitlist.length,
      takeRatePct: capsInputs.takeRatePct,
      foundingTakeRatePct: capsInputs.foundingTakeRatePct,
      showCohortCount
    },
    account: acct,
    coin,
    // Server truth for WATCH mode: a showcased address is watching no matter how it was entered
    // (chip, paste, URL, storage) — the client must never infer ownership from the entry path.
    showcase: acct != null ? isShowcase(acct) : false,
    // Live venue mark for the header ticker — the account's own read when present, else the
    // freshest mark any loop has seen. Null only before the first successful HL read.
    marketPxUsd: position?.markPx ?? lastHlMark,
    position,
    positionError,
    wraps,
    book: {
      accounts: [...new Set(allWraps.map((r) => r.account))].length,
      openWraps: open.length,
      openNotionalUsdc: round2(open.reduce((s, r) => s + wrapExposureUsdc(r), 0)),
      totalWraps: allWraps.length,
      creditsPaidUsdc: round2(ledger.filter((e) => paidStatuses.has(e.status)).reduce((s, e) => s + e.amountUsdc, 0))
    },
    // The account's payout history — amounts, cycle reason, status, tx reference.
    payouts: ledger
      .filter((e) => e.account.toLowerCase() === (acct ?? "").toLowerCase())
      .map((e) => ({ id: e.id, amountUsdc: e.amountUsdc, reason: e.reason, status: e.status, txHash: e.txHash, createdAtMs: e.createdAtMs, paidAtMs: e.paidAtMs })),
    protection: {
      autoRenew,
      on: acct != null ? prefs[acct.toLowerCase()]?.on === true : false,
      accountsOn: Object.values(prefs).filter((p) => p.on).length,
      founding: acct != null ? registry[acct.toLowerCase()] != null : false,
      // Join order within the cohort ("founding member #N") — personal, shown regardless of the
      // public count flag: #1 is a badge, not a fill gauge.
      foundingRank: (() => {
        const key = acct?.toLowerCase();
        const mine = key != null ? registry[key] : undefined;
        if (key == null || mine == null) return null;
        return 1 + Object.entries(registry).filter(([k, v]) => v.joinedAtMs < mine.joinedAtMs || (v.joinedAtMs === mine.joinedAtMs && k < key)).length;
      })(),
      waitlistPosition: acct != null ? (() => { const i = waitlist.findIndex((w) => w.account === acct.toLowerCase()); return i < 0 ? null : i + 1; })() : null
    },
    // Gate status so clients render the right prompt (checkbox vs signature) without guessing.
    gates: {
      tosRequired,
      signatureRequired: requireActionSig,
      cleared: acct != null ? actionCleared(tosReg, acct, tosVersion, requireActionSig, tosRequired).ok : false
    },
    generatedAtIso: new Date(nowMs).toISOString()
  };
};

// ── Auto-renew loop ───────────────────────────────────────────────────────────
// Every cycle, for each opted-in account: persist natural expiries, then re-wrap. Skip-days
// (book can't fund a credit) probe the quote FIRST so refusals don't spam failed records —
// only a real wrap attempt (quote said yes) writes to the store.

const renewalTick = async (): Promise<void> => {
  loopPulses.renewal.lastRunMs = Date.now();
  if (!autoRenew || !guards.enabled || runtimePaused) return; // pause stops renewals; conclusions run in the monitor
  const prefs = await stores.loadPrefs();
  for (const [key, pref] of Object.entries(prefs)) {
    if (!pref.on || wrapLocked(key)) continue;
    try {
      const records = await stores.loadWraps();
      const mine = records.filter((r) => r.account.toLowerCase() === key);
      const latest = mine.length ? mine[mine.length - 1] : null;
      const nowMs = Date.now();
      // Staggered renewals (decision 7): each account re-wraps at its own anchor after the fixing.
      const action = renewalDecision(pref, latest, nowMs, renewRetryMs, renewalStaggerOffsetMs(key, renewStaggerMs));
      if (action === "none") continue;

      if (action === "expire_and_renew" && latest && concludeAtExpiry(latest, nowMs)) {
        await stores.saveWraps(records);
        // Settle the concluded cycle (idempotent — the monitor loop may have beaten us to it).
        try {
          await accrueConclusion(latest, await hl.midPx(coin));
        } catch {
          await accrueConclusion(latest, null);
        }
        console.error(`[demo] auto-renew: ${latest.id} expired fully vested — re-wrapping ${key}`);
      }

      // Throttle stamp before the attempt so a crash can't hot-loop the venue.
      prefs[key] = { ...pref, lastRenewAttemptMs: nowMs };
      await stores.savePrefs(prefs);

      const position = await readHlPosition(key);
      if (!position) {
        // Position is gone — protection has nothing to attach to. Disarm and say so.
        prefs[key] = { ...prefs[key], on: false };
        await stores.savePrefs(prefs);
        console.error(`[demo] auto-renew: no open ${coin} position on ${key} — protection off`);
        continue;
      }
      const cover = coverOkxLots(position.szBase);
      if (!cover.ok) continue; // below one lot — retry next throttle window
      const renewPlan = demoPlanStrikes(position.markPx, position.side, floorPct, capPct);
      const probe = await fetchOkxListedTouchQuote({
        side: position.side,
        spot: position.markPx,
        planPutStrike: renewPlan.putStrike,
        planCallStrike: renewPlan.callStrike,
        notionalUsdc: round2(cover.coveredBtc * position.markPx),
        contractsBtc: cover.coveredBtc,
        nowMs
      });
      if (!probe.ok) {
        console.error(`[demo] auto-renew: ${key} skip-day — ${probe.error} (retry in ${Math.round(renewRetryMs / 60000)}m)`);
        continue;
      }
      wrapsInFlight.set(key, Date.now());
      try {
        const out = await withTimeout(
          doWrap(key, true),
          WRAP_REQUEST_TIMEOUT_MS,
          { status: 504, body: { ok: false, error: "wrap_timeout", message: "renewal attempt timed out — retrying next tick" } }
        );
        const ok = (out.body as { ok?: boolean }).ok === true;
        console.error(`[demo] auto-renew: ${key} ${ok ? "re-wrapped" : `refused — ${(out.body as { message?: string }).message ?? "?"}`}`);
      } finally {
        wrapsInFlight.delete(key);
      }
    } catch (e) {
      console.error(`[demo] auto-renew error for ${key}: ${(e as Error).message}`);
    }
  }
};

// ── Cycle settlement → payout ledger ──────────────────────────────────────────
// Every concluded cycle (expiry / knockout / early close) accrues exactly one ledger entry for the
// verified position owner. Credit is paid at conclusion, never upfront (decision 2).

const accrueConclusion = async (rec: DemoWrapRecord, settlePx: number | null): Promise<void> => {
  const payable = cyclePayable(rec, settlePx);
  if (!payable) return;
  const ledger = await stores.loadLedger();
  const res = accrueWrapPayout(ledger, rec, payable, Date.now());
  if (!res.ok) {
    console.error(`[demo] payout not accrued for ${rec.id}: ${res.reason}`);
    return;
  }
  if (res.created) {
    await stores.saveLedger(ledger);
    console.error(`[demo] payout accrued: ${rec.id} → $${res.entry.amountUsdc} (${payable.kind}) to ${rec.account}`);
  }
};

// ── Design B knockout monitor ─────────────────────────────────────────────────
// Mark-price watcher over every active wrap: a TOUCH of the cap (no buffer) closes both hedge legs
// (okx lanes: the existing order-book unwind; paper: bookkeeping), marks the wrap knocked_out, and
// settles vested-to-touch. Re-arm happens on the next renewal tick while the toggle stays on.
// Runs even when the kill switch is off — conclusions and payouts never pause.

type KnockoutUnwind = { ok: boolean; valueUsdc: number | null; note: string };

const knockoutUnwindLegs = async (rec: DemoWrapRecord, markPx: number): Promise<KnockoutUnwind> => {
  if (guards.executionMode === "paper") return { ok: true, valueUsdc: null, note: "paper — no venue legs to unwind" };
  const { OKX_API_KEY: k, OKX_API_SECRET: s, OKX_API_PASSPHRASE: p } = process.env;
  if (!k || !s || !p) return { ok: false, valueUsdc: null, note: "missing OKX credentials for the knockout unwind" };
  const putInstId = rec.legs.find((l) => l.role === "buy_put_floor" || l.role === "sell_put_cap")?.instId;
  const callInstId = rec.legs.find((l) => l.role === "sell_call_cap" || l.role === "buy_call_floor")?.instId;
  const contracts = rec.hedge?.contracts;
  if (!putInstId || !callInstId || contracts == null) {
    return { ok: false, valueUsdc: null, note: "wrap record is missing leg instruments/contracts — cannot unwind blindly" };
  }
  const rep = await unwindLiveCollar(
    new OkxExecutionClient({ apiKey: k, secret: s, passphrase: p, mode: parseLiveGuardsFromEnv(process.env, "okx").mode }),
    { side: rec.position.side, putInstId, callInstId, contracts, ctValBtc: OKX_OPTION_LOT_BTC },
    // checkVenueFirst: this is a RETRY context — never re-close an already-flat leg (live
    // incident: unconfirmed fills + reduceOnly not binding on options ⟹ accumulated longs).
    // dust/fire-sale lines: a near-worthless long protective residue with no bid is written off
    // (bounded at zero, settles at expiry) instead of paging the operator every retry forever.
    {
      spotUsd: markPx,
      clOrdPrefix: `ko${Date.now().toString(36)}`,
      checkVenueFirst: true,
      dustMaxUsd: num(process.env.EP_UNWIND_DUST_MAX_USD, 20),
      fireSaleMaxUsd: num(process.env.EP_UNWIND_FIRESALE_MAX_USD, 50)
    }
  );
  return { ok: rep.complete, valueUsdc: rep.unwindValueUsdc, note: rep.notes.join("; ") || rep.outcome };
};

// Knockout unwind retry budget: fast for the first attempts, then 15-minute backoff. Retries are
// idempotent and quiet; the ALERT for a wedged unwind fires once per wrap per cooldown (below),
// not once per attempt — a stuck condition pages the operator, it does not machine-gun them.
const knockoutTries = new Map<string, { n: number; lastMs: number }>();
// Underlying-gone guard state: wrapId → consecutive gone readings; checked once a minute.
const underlyingGoneStreak = new Map<string, number>();
let lastUnderlyingCheckMs = 0;
const KNOCKOUT_FAST_TRIES = 3;
const KNOCKOUT_BACKOFF_MS = 15 * 60_000;
const UNWIND_ALERT_COOLDOWN_MS = num(process.env.EP_UNWIND_ALERT_COOLDOWN_MS, 6 * 60 * 60_000);
const knockoutRetryDue = (wrapId: string, nowMs: number): boolean => {
  const t = knockoutTries.get(wrapId);
  if (!t || t.n < KNOCKOUT_FAST_TRIES) return true;
  return nowMs - t.lastMs >= KNOCKOUT_BACKOFF_MS;
};

const monitorTick = async (): Promise<void> => {
  loopPulses.monitor.lastRunMs = Date.now();
  try {
    // Read the mark BEFORE loading the store so no other tick can mutate records mid-await.
    const mark = await hl.midPx(coin);
    if (Number.isFinite(mark) && mark > 0) lastHlMark = mark;
    const nowMs = Date.now();
    const records = await stores.loadWraps();
    let dirty = false;
    for (const rec of records) {
      if (rec.status !== "active" || !rec.vesting) continue;
      const cap = wrapCapStrike(rec);
      // Knockout only while the option lives — past the fixing it is expiry settlement instead.
      if (cap != null && nowMs < rec.vesting.endMs && capTouched(rec.position.side, cap, mark)) {
        if (!knockoutRetryDue(rec.id, nowMs)) continue; // backoff window — operator is paged
        const tries = knockoutTries.get(rec.id) ?? { n: 0, lastMs: 0 };
        knockoutTries.set(rec.id, { n: tries.n + 1, lastMs: nowMs });
        const unwound = await knockoutUnwindLegs(rec, mark);
        if (!unwound.ok) {
          // Legs could not be fully closed: the wrap stays as-is; venue-truth checks make the
          // retry idempotent; after the fast tries it backs off to 15m and keeps retrying
          // QUIETLY — the alert fires once per wrap per cooldown, not once per attempt.
          raiseAlert(
            "unwind_event",
            `knockout unwind INCOMPLETE for ${rec.id} (attempt ${tries.n + 1}) — ${unwound.note}`,
            { wrapId: rec.id },
            { dedupeKey: `unwind_incomplete:${rec.id}`, dedupeMs: UNWIND_ALERT_COOLDOWN_MS }
          );
          continue;
        }
        knockoutTries.delete(rec.id);
        knockoutWrap(rec, nowMs, mark, unwound.valueUsdc);
        dirty = true;
        await accrueConclusion(rec, null);
        raiseAlert("unwind_event", `KNOCKOUT ${rec.id}: cap $${cap} touched at mark $${mark} — legs closed, cycle settled`, { wrapId: rec.id });
        console.error(`[demo] KNOCKOUT ${rec.id}: cap $${cap} touched at mark $${mark} — cycle over, re-arms at new spot on the next renewal tick`);
        continue;
      }
      // Staggered natural expiry: conclude + settle once past the fixing plus this account's anchor.
      if (nowMs >= rec.vesting.endMs + renewalStaggerOffsetMs(rec.account, renewStaggerMs) && concludeAtExpiry(rec, nowMs)) {
        dirty = true;
        accrueConclusion(rec, mark);
        console.error(`[demo] expiry settled: ${rec.id} — payable accrued to the ledger`);
      }
    }
    // ── Underlying-gone guard (once a minute): protection ends when there is nothing left to
    // protect. Closing the HL position mid-cycle concludes the wrap with VESTED-ONLY credit —
    // otherwise "open minimal position → wrap → close position" farms credits risk-free. Two
    // consecutive gone readings are required (one flaky venue read never ends a real cycle).
    if (nowMs - lastUnderlyingCheckMs >= 60_000) {
      lastUnderlyingCheckMs = nowMs;
      const activeAccounts = [...new Set(records.filter((r) => r.status === "active" && r.vesting).map((r) => r.account.toLowerCase()))];
      for (const account of activeAccounts) {
        let venuePos: HlPositionRead | null;
        try {
          venuePos = await readHlPosition(account);
        } catch {
          continue; // HL read failed — never advance the streak on an error
        }
        for (const rec of records) {
          if (rec.status !== "active" || !rec.vesting || rec.account.toLowerCase() !== account) continue;
          const check = assessUnderlying(rec.position.side, venuePos, underlyingGoneStreak.get(rec.id) ?? 0);
          if (!check.gone) {
            underlyingGoneStreak.delete(rec.id);
            continue;
          }
          underlyingGoneStreak.set(rec.id, check.streak);
          if (!check.confirmed) continue;
          // Live lanes: real legs must unwind BEFORE the books settle (same rule as early close);
          // reuse the knockout retry budget so a wedged unwind backs off instead of hammering.
          if (rec.hedge && rec.hedge.mode !== "paper") {
            if (!knockoutRetryDue(rec.id, nowMs)) continue;
            const tries = knockoutTries.get(rec.id) ?? { n: 0, lastMs: 0 };
            knockoutTries.set(rec.id, { n: tries.n + 1, lastMs: nowMs });
            const unwound = await knockoutUnwindLegs(rec, mark);
            if (!unwound.ok) {
              raiseAlert(
                "unwind_event",
                `underlying-gone unwind INCOMPLETE for ${rec.id} — ${unwound.note}`,
                { wrapId: rec.id },
                { dedupeKey: `unwind_incomplete:${rec.id}`, dedupeMs: UNWIND_ALERT_COOLDOWN_MS }
              );
              continue;
            }
            knockoutTries.delete(rec.id);
          }
          concludeWrapEarly(rec, nowMs);
          underlyingGoneStreak.delete(rec.id);
          dirty = true;
          await accrueConclusion(rec, null);
          raiseAlert("unwind_event", `UNDERLYING GONE ${rec.id}: HL position closed mid-cycle — wrap concluded early, vested credit accrued`, { wrapId: rec.id });
          console.error(`[demo] underlying gone: ${rec.id} — position closed on HL mid-cycle; concluded with vested-only credit`);
        }
      }
    }
    if (dirty) await stores.saveWraps(records);
  } catch (e) {
    console.error(`[demo] knockout/settlement tick error: ${(e as Error).message}`);
  }
};

// ── Payout loop ───────────────────────────────────────────────────────────────
// Pays accrued ledger entries through the configured rail (simulated by default; Arbitrum USDC only
// behind the full PAYOUT_MODE=arbitrum arming chain). Idempotency + the per-day outflow cap live in
// processPayoutLedger; this loop only feeds it.

let payoutSender: PayoutSender | null = null;

const payoutTick = async (): Promise<void> => {
  loopPulses.payout.lastRunMs = Date.now();
  if (!payoutRail.ok) return; // refused at boot, logged there
  try {
    const ledger = await stores.loadLedger();
    if (!ledger.some((e) => e.status === "accrued" || e.status === "queued" || (e.status === "failed" && e.retriable))) return;
    payoutSender ??= await buildPayoutSender(payoutRail.cfg);
    const summary = await processPayoutLedger(ledger, payoutSender, Date.now(), {
      dailyCapUsdc: payoutRail.cfg.dailyCapUsdc,
      persist: (es) => stores.saveLedger(es)
    });
    if (summary.sent || summary.failed || summary.deferred || summary.skippedStale) {
      console.error(
        `[demo] payouts: ${summary.sent} sent (${summary.confirmed} confirmed) · ${summary.deferred} deferred (daily cap) · ` +
          `${summary.failed} failed · ${summary.skippedStale} stale-parked`
      );
    }
    if (summary.failed > 0 || summary.skippedStale > 0) {
      raiseAlert("payout_failed", `${summary.failed} payout send(s) failed, ${summary.skippedStale} stale-parked — check the ledger`, undefined, {
        dedupeKey: "payout_failures" // counts change per tick — one page per window, the ledger holds the detail
      });
    }
  } catch (e) {
    console.error(`[demo] payout tick error: ${(e as Error).message}`);
    raiseAlert("payout_failed", `payout tick threw: ${(e as Error).message}`);
  }
};

// ── Watchdog + margin-utilization pause ───────────────────────────────────────

const utilizationPausePct = num(process.env.EP_UTILIZATION_PAUSE_PCT, 1.0); // 1.0 = the book cap itself
const utilizationWarnPct = num(process.env.EP_UTILIZATION_WARN_PCT, 0.8);

const watchdogTick = async (): Promise<void> => {
  try {
    for (const p of stalledLoops(Object.values(loopPulses), Date.now())) {
      raiseAlert(
        "loop_stalled",
        `${p.name} loop has not run for ${Math.round((Date.now() - p.lastRunMs) / 1000)}s (interval ${Math.round(p.intervalMs / 1000)}s)`,
        undefined,
        { dedupeKey: `loop:${p.name}` } // the seconds counter changes every tick — key on the loop, not the message
      );
    }
    // Margin utilization: modeled as open notional × margin rate vs usable margin (the real PM
    // per-wrap margin is measured in Phase 3 and recalibrates this). Warn at 80%, auto-pause at
    // the configured line — conclusions and payouts keep running.
    const records = await stores.loadWraps();
    const open = records.filter((r) => r.status === "quoting" || r.status === "executing" || r.status === "active");
    const openNotional = open.reduce((s, r) => s + wrapExposureUsdc(r), 0);
    const spotRef = open.find((r) => r.quote)?.quote?.spot ?? 0;
    const derived = deriveCaps(capsInputs, spotRef);
    const utilization = derived.bookCapUsdc > 0 ? openNotional / derived.bookCapUsdc : 0;
    if (utilization >= utilizationPausePct && !runtimePaused) {
      runtimePaused = true;
      runtimePausedReason = `margin utilization ${(utilization * 100).toFixed(0)}% ≥ pause line ${(utilizationPausePct * 100).toFixed(0)}%`;
      await stores.saveRuntime({ paused: true, pausedReason: runtimePausedReason, updatedAtMs: Date.now() });
      raiseAlert("margin_utilization", `AUTO-PAUSED new wraps: ${runtimePausedReason}`);
    } else if (utilization >= utilizationWarnPct) {
      raiseAlert(
        "margin_utilization",
        `margin utilization at ${(utilization * 100).toFixed(0)}% of the book cap ($${round2(openNotional)} / $${derived.bookCapUsdc})`,
        undefined,
        { dedupeKey: "utilization_warn" } // the percentage moves every tick — one warning per window
      );
    }
  } catch (e) {
    console.error(`[demo] watchdog tick error: ${(e as Error).message}`);
  }
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
  <h2>Book (all accounts)</h2>
  <table><thead><tr><th>id</th><th>account</th><th>position</th><th>credit</th><th>status</th></tr></thead>
  <tbody id="history"><tr><td colspan="5" class="muted">—</td></tr></tbody></table>
  <div class="note">Disclosure: the venue-side toggle is rendered locally by a browser extension to show placement — the venue is not (yet) a partner. Everything on this page is the live engine: real position reads, live options pricing, and (in okx modes) real hedge orders. Rails: kill switch, hard micro-notional cap, one wrap at a time, daily quota.</div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const badge = (t, c) => '<span class="badge" style="background:'+c+'">'+esc(t)+'</span>';
const card = (k, v, s) => '<div class="card"><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+'</div><div class="s">'+esc(s||"")+'</div></div>';
const fmt$ = (x) => (x==null?"—":(x<0?"−$":"$")+Math.abs(x).toFixed(2));
const stageLabel = {wrap_requested:"Wrap requested (toggle)",position_read:"Venue position read",quoted:"Collar priced (live OKX book)",hedge_executing:"Hedge legs executing",hedge_locked:"Hedge locked",green_light:"GREEN LIGHT — protection live",vesting:"Credit vesting",failed:"FAILED",knocked_out:"KNOCKED OUT — cap touched, cycle over",concluded:"Concluded"};

const render = (st) => {
  const g = st.guards;
  const modeColor = g.executionMode==="okx_live"?"#9a1b1b":g.executionMode==="okx_demo"?"#9a6b00":"#0b5cab";
  $("badges").innerHTML =
    badge(g.enabled?"ARMED":"KILL SWITCH OFF", g.enabled?"#16794a":"#9a1b1b") +
    badge("mode: "+g.executionMode.toUpperCase().replace("_"," "), modeColor) +
    badge("per-wrap cap $"+g.maxPositionNotionalUsdc, "#30363d") +
    badge("account "+(st.account? st.account.slice(0,6)+"…"+st.account.slice(-4) : "unset"), "#30363d") +
    (st.book ? badge("book: "+st.book.openWraps+" open · $"+st.book.openNotionalUsdc+" / $"+g.maxBookNotionalUsdc, "#30363d") : "") +
    (st.protection && st.protection.autoRenew ? badge("auto-renew: "+(st.protection.on?"ON":"off")+(st.protection.accountsOn>1?" ("+st.protection.accountsOn+" accts)":""), st.protection.on?"#16794a":"#30363d") : "");

  const p = st.position;
  const w = latestWrap(st);
  const q = w && w.quote;
  $("cards").innerHTML =
    card("Client position ("+(p?"Hyperliquid · live":"none")+")",
      p ? p.side.toUpperCase()+" "+p.szBase+" "+p.coin : (st.positionError?"read error":"no open "+st.coin),
      p ? "entry "+(p.entryPx?("$"+p.entryPx):"?")+" · mark $"+p.markPx.toFixed(1)+" · ≈$"+p.notionalUsdc : (st.positionError||"open a position to enable the toggle")) +
    card("Hedge quote",
      q ? fmt$(q.creditUsdc)+(q.quotedCreditUsdc!=null && Math.abs(q.creditUsdc-q.quotedCreditUsdc)>0.005 ? " filled" : " credit") : "—",
      q ? ((q.quotedCreditUsdc!=null && Math.abs(q.creditUsdc-q.quotedCreditUsdc)>0.005 ? "quoted "+fmt$(q.quotedCreditUsdc)+" · improvement passed through · " : "")
          +"floor $"+(q.floorStrike??q.putStrike)+" ("+(q.floorPct*100).toFixed(1)+"%) · cap $"+(q.capStrike??q.callStrike)+" ("+(q.capPct*100).toFixed(1)+"%)") : "priced on wrap") +
    card("Hedge venue", w && w.hedge ? w.hedge.venue.toUpperCase().replace("_"," ") : "—",
      w && w.hedge ? (w.hedge.sizeNote || (w.hedge.contracts!=null ? w.hedge.contracts+" × 0.01 BTC lots" : "model quote off the live book")) : "") +
    card("Status", w ? w.status.toUpperCase() : "IDLE", w && w.failReason ? w.failReason : "");

  if (w) {
    $("timeline").innerHTML = w.stages.map(s =>
      '<li class="'+(s.stage==="failed"?"fail":"done")+'"><b>'+esc(stageLabel[s.stage]||s.stage)+'</b> <span class="t">'+new Date(s.tsMs).toISOString().slice(11,19)+'Z</span>'+(s.note?'<div class="n">'+esc(s.note)+'</div>':'')+'</li>').join("");
    const legLabel = {sell_call_cap:"SELL call (cap)", buy_put_floor:"BUY put (floor)", sell_put_cap:"SELL put (cap)", buy_call_floor:"BUY call (floor)"};
    $("legs").innerHTML = w.legs.length ? w.legs.map(l =>
      '<tr><td>'+(legLabel[l.role]||esc(l.role))+'</td><td>'+esc(l.instId||"—")+'</td><td>'+esc(l.orderId||"—")+'</td><td>'+fmt$(l.premiumUsdc)+'</td><td class="'+(l.real?"real":"paper")+'">'+(l.real?"REAL":"PAPER")+'</td></tr>').join("")
      : '<tr><td colspan="5" class="muted">—</td></tr>';
    const v = w.vestingStatus;
    if (v) {
      $("vesting").innerHTML = "<b>"+fmt$(v.vestedUsdc)+"</b> of "+fmt$(v.fullCreditUsdc)+" vested ("+(v.fraction*100).toFixed(1)+"%)"+(v.fullyVested?" — FULLY VESTED":" · "+Math.ceil(v.remainingMs/60000)+" min to full vest");
      $("vestbar").style.width = (v.fraction*100).toFixed(1)+"%";
    } else { $("vesting").textContent = w.status==="failed" ? "no vesting — wrap failed" : "—"; $("vestbar").style.width = "0"; }
  }
  $("history").innerHTML = (st.wraps||[]).slice().reverse().map(r =>
    '<tr><td>'+esc(r.id)+'</td><td>'+esc(r.account ? r.account.slice(0,6)+"…"+r.account.slice(-4) : "—")+'</td><td>'+esc(r.position.side+" "+r.position.szBase+" "+r.position.coin)+'</td><td>'+fmt$(r.quote?r.quote.creditUsdc:null)+'</td><td>'+esc(r.status)+'</td></tr>').join("")
    || '<tr><td colspan="5" class="muted">—</td></tr>';
};
// Cards/timeline follow the PRIMARY account's latest wrap; the book table shows every account.
const latestWrap = (st) => {
  const mine = (st.wraps||[]).filter((r) => !st.account || (r.account||"").toLowerCase() === st.account.toLowerCase());
  return mine.length ? mine[mine.length-1] : null;
};

// Admin token rides the page URL (?token=…) and is forwarded on every call.
const tok = new URLSearchParams(location.search).get("token");
const withTok = (p) => tok ? p + (p.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(tok) : p;
const poll = async () => {
  try { render(await (await fetch(withTok("/demo/api/state?all=1"))).json()); } catch (e) { /* keep last render */ }
};
$("wrapBtn").onclick = async () => {
  $("wrapBtn").disabled = true; $("actionMsg").textContent = "wrapping…";
  try {
    const r = await fetch(withTok("/demo/api/wrap"), { method: "POST" });
    const j = await r.json();
    $("actionMsg").textContent = j.ok ? "wrap active" : (j.message || j.error || "refused");
  } catch (e) { $("actionMsg").textContent = "request failed: "+e; }
  $("wrapBtn").disabled = false; poll();
};
$("closeBtn").onclick = async () => {
  const r = await fetch(withTok("/demo/api/close"), { method: "POST" });
  const j = await r.json();
  $("actionMsg").textContent = j.ok ? "closed early — collected $"+j.vested.vestedUsdc.toFixed(2)+" vested" : (j.message || "nothing to close");
  poll();
};
$("resetBtn").onclick = async () => {
  const r = await fetch(withTok("/demo/api/reset"), { method: "POST" });
  const j = await r.json();
  $("actionMsg").textContent = j.ok ? "demo reset" : (j.message || "reset refused");
  poll();
};
poll(); setInterval(poll, 2000);
</script></body></html>`;

// ── HTTP server (permissive CORS — the extension's background worker calls in) ──
// ONE JSON API for every client (decision 8 + partner-ready): the web app, the Telegram bot, the
// extension, and a future partner all consume the same routes. `/api/*` is canonical;
// `/demo/api/*` is a permanent alias so existing surfaces keep working. See docs/earn-protect-api.md.

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Idempotency-Key, X-Admin-Token, Authorization"
};

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(body, null, 2));
};

const sendHtml = (res: ServerResponse, html: string) => {
  // no-store: app pages must NEVER be cached — a stale client after a deploy sends stale
  // requests and misreads new errors (production bug: cached JS lost the close token AND
  // showed the wrong refusal copy).
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...CORS_HEADERS });
  res.end(html);
};

const clientIp = (req: IncomingMessage): string =>
  String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  // Canonical route: /demo/api/X → /api/X (alias kept for the extension + Phase 1 surfaces).
  const route = url.pathname.replace(/^\/demo\/api\//, "/api/");
  const ip = clientIp(req);
  const isAdmin = adminAuthorized(adminAuth, req.headers, url.searchParams.get("token"));
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    // ── Pages ──
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/app" || url.pathname === "/miniapp")) {
      recordPageLoad(funnelState, url.pathname === "/miniapp" ? "miniapp" : "app", Date.now());
      funnelDirty = true;
      // Brand mark after "by": the single-SVG Atticus lockup when the asset exists (pixel-perfect
      // brand file, served by us at /assets/atticus-lockup.svg — no third-party host), otherwise
      // the live-text fallback: "Atticus" in gold serif + the finch image (EP_BRAND_LOGO_URL
      // overrides the finch; non-https ⟹ text only).
      // replaceAll — the placeholder may legitimately appear in comments too (bug caught live:
      // .replace() hit a comment first and left the visible slot as literal text).
      let brandMark: string;
      if (existsSync(BRAND_LOCKUP_PATH)) {
        brandMark = `<img class="brand-lockup" src="/assets/atticus-lockup.svg" alt="Atticus">`;
      } else {
        const logoUrl = (process.env.EP_BRAND_LOGO_URL ?? "https://i.ibb.co/Sw0KQJYV/finchsmall.png").trim();
        const finch = /^https:\/\//.test(logoUrl) ? `<img class="brand-img" src="${logoUrl.replace(/"/g, "")}" alt="">` : "";
        brandMark = `<span class="atticus-serif">Atticus</span>${finch}`;
      }
      const tgLink = (process.env.EP_SUPPORT_TELEGRAM ?? "").trim();
      const xLink = (process.env.EP_SOCIAL_X ?? "").trim();
      sendHtml(
        res,
        (url.pathname === "/miniapp" ? EP_MINI_APP_HTML : EP_WEB_APP_HTML)
          .replaceAll("__BRAND_MARK__", brandMark)
          // White-label venue slot: "for HYPERLIQUID" by default; a partner demo instance sets
          // EP_BRAND_FOR=FIREBLOCKS (and optionally EP_BRAND_LINE="built for"). Per-recipient
          // demo links can override with ?brand=… but ONLY for names pre-approved in
          // EP_BRAND_ALLOWLIST (fail closed to the env default) — partner names never appear
          // on the public instance unless the founder configured them.
          .replaceAll(
            "__BRAND_FOR__",
            resolveBrandFor(
              process.env.EP_BRAND_FOR ?? "HYPERLIQUID",
              url.searchParams.get("brand"),
              parseBrandAllowlist(process.env.EP_BRAND_ALLOWLIST)
            ).replace(/[<>&"]/g, "")
          )
          .replaceAll("__BRAND_LINE__", (process.env.EP_BRAND_LINE ?? "for").replace(/[<>&"]/g, ""))
          .replaceAll("__SKIN__", process.env.EP_SKIN === "institutional" ? "institutional" : "retail")
          .replaceAll("__DEMO_AIDS__", demoAids ? "true" : "false")
          .replaceAll("__LINK_TG__", /^https:\/\//.test(tgLink) ? `<a href="${tgLink.replace(/"/g, "")}" target="_blank" rel="noopener">Support / Telegram</a> · ` : "")
          .replaceAll("__LINK_X__", /^https:\/\//.test(xLink) ? `<a href="${xLink.replace(/"/g, "")}" target="_blank" rel="noopener">X</a> · ` : "")
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/assets/atticus-lockup.svg") {
      if (!existsSync(BRAND_LOCKUP_PATH)) {
        sendJson(res, 404, { ok: false, error: "not_found" });
        return;
      }
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600", ...CORS_HEADERS });
      res.end(readFileSync(BRAND_LOCKUP_PATH));
      return;
    }
    if (req.method === "GET" && url.pathname === "/demo") {
      // Ops surface: admin-gated (open ?token=… links keep working for the recording browser).
      if (!isAdmin) {
        sendJson(res, 403, { ok: false, error: "admin_required", message: "control room requires EP_ADMIN_TOKEN (pass ?token=…)" });
        return;
      }
      sendHtml(res, CONTROL_ROOM_HTML);
      return;
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/tos") {
      sendHtml(res, EP_TOS_HTML.replace(/__TOS_VERSION__/g, tosVersion));
      return;
    }
    if (req.method === "GET" && url.pathname === "/public") {
      recordPageLoad(funnelState, "public", Date.now());
      funnelDirty = true;
      sendHtml(res, EP_PUBLIC_DASHBOARD_HTML);
      return;
    }

    // ── Rate limits: reads generous, actions tight; admin exempt ──
    const isAction = req.method === "POST" && /^\/api\/(wrap|close|protection|tos\/accept)$/.test(route);
    const isRead = req.method === "GET" && route.startsWith("/api/");
    if (!isAdmin && ((isAction && !actionLimiter.allow(ip, Date.now())) || (isRead && !readLimiter.allow(ip, Date.now())))) {
      sendJson(res, 429, { ok: false, error: "rate_limited", message: "too many requests — slow down" });
      return;
    }

    // WATCH-mode guard (one gate for every action): a showcased public wallet can be viewed by
    // anyone and acted on by NO ONE — wrapping a stranger's position would spend real hedge
    // capital nobody asked for. Watching is a lookup, never ownership.
    if (isAction) {
      const acctParam = url.searchParams.get("account");
      if (acctParam && isShowcase(acctParam)) {
        sendJson(res, 403, { ok: false, error: "showcase_wallet", message: "this is a public wallet on watch — look up your own address to protect it" });
        return;
      }
    }

    // ── Geofence (Phase 3): trading ACTIONS are blocked for US + sanctioned IPs, fail-closed
    // when the location cannot be verified. Reads stay open.
    let geoCountry: string | null = null;
    if (geofence.enabled && (isAction || route === "/api/geo")) {
      geoCountry = await resolveCountry(req.headers, ip);
      // notice mode: banner only (demo posture); enforce mode: actions actually block.
      if (isAction && geofence.mode === "enforce") {
        const verdict = assessGeofence(geofence, geoCountry);
        if (!verdict.allowed) {
          sendJson(res, 451, { ok: false, error: "geo_blocked", message: verdict.reason });
          return;
        }
      }
    }
    if (req.method === "GET" && route === "/api/geo") {
      const verdict = assessGeofence(geofence, geofence.enabled ? geoCountry : null);
      sendJson(res, 200, { ok: true, enabled: geofence.enabled, mode: geofence.mode, allowed: verdict.allowed, country: verdict.country, ...(verdict.allowed ? {} : { message: (verdict as { reason: string }).reason }) });
      return;
    }

    // ── ToS (Phase 3): versioned acceptance; wrap refuses without the CURRENT version ──
    if (req.method === "GET" && route === "/api/tos") {
      const acct = resolveAccount(url.searchParams.get("account"));
      if (!acct.ok) {
        sendJson(res, 403, { ok: false, error: "account_refused", message: acct.message });
        return;
      }
      const tos = await stores.loadTos();
      const acc = tos[acct.account.toLowerCase()];
      sendJson(res, 200, {
        ok: true,
        required: tosRequired,
        version: tosVersion,
        accepted: acc?.version === tosVersion,
        acceptedVersion: acc?.version ?? null,
        acceptedAtMs: acc?.acceptedAtMs ?? null,
        url: "/tos"
      });
      return;
    }
    if (req.method === "POST" && route === "/api/tos/accept") {
      // Checkbox acceptance — enough when only the ToS gate is armed. When the SIGNATURE gate is
      // armed, actions additionally need /api/verify (checkbox acceptance is preserved, not lost).
      const acct = resolveAccount(url.searchParams.get("account"));
      if (!acct.ok) {
        sendJson(res, 403, { ok: false, error: "account_refused", message: acct.message });
        return;
      }
      const tos = await stores.loadTos();
      const prior = tos[acct.account.toLowerCase()];
      tos[acct.account.toLowerCase()] = {
        version: tosVersion,
        acceptedAtMs: Date.now(),
        country: geofence.enabled ? geoCountry ?? (await resolveCountry(req.headers, ip)) : null,
        signature: prior?.version === tosVersion ? prior.signature ?? null : null,
        signerVerified: prior?.version === tosVersion ? prior.signerVerified === true : false
      };
      await stores.saveTos(tos);
      sendJson(res, 200, { ok: true, version: tosVersion, accepted: true, signatureRequired: requireActionSig });
      return;
    }
    if (req.method === "GET" && route === "/api/verify") {
      // The canonical message the wallet must sign + this wallet's verification status.
      const acct = resolveAccount(url.searchParams.get("account"));
      if (!acct.ok) {
        sendJson(res, 403, { ok: false, error: "account_refused", message: acct.message });
        return;
      }
      const tos = await stores.loadTos();
      const acc = tos[acct.account.toLowerCase()];
      sendJson(res, 200, {
        ok: true,
        required: requireActionSig,
        verified: acc?.version === tosVersion && acc.signerVerified === true,
        version: tosVersion,
        message: verifyMessageText(acct.account, tosVersion)
      });
      return;
    }
    if (req.method === "POST" && route === "/api/verify") {
      // One-time wallet verification: EIP-191 signature over the canonical message = proof of
      // control + SIGNED ToS acceptance. Wallet-scoped and stored server-side, so the Telegram
      // bot works for this wallet afterwards without ever signing again.
      const acct = resolveAccount(url.searchParams.get("account"));
      if (!acct.ok) {
        sendJson(res, 403, { ok: false, error: "account_refused", message: acct.message });
        return;
      }
      const signature = String(url.searchParams.get("signature") ?? "").trim();
      const verdict = await verifyWalletSignature(acct.account, tosVersion, signature);
      if (!verdict.ok) {
        sendJson(res, 400, { ok: false, error: "bad_signature", message: verdict.error });
        return;
      }
      const tos = await stores.loadTos();
      tos[acct.account.toLowerCase()] = {
        version: tosVersion,
        acceptedAtMs: Date.now(),
        country: geofence.enabled ? geoCountry ?? (await resolveCountry(req.headers, ip)) : null,
        signature,
        signerVerified: true
      };
      await stores.saveTos(tos);
      sendJson(res, 200, { ok: true, verified: true, version: tosVersion });
      return;
    }

    // ── Public live-book stats (aggregates only — never per-user data) ──
    if (req.method === "GET" && route === "/api/stats") {
      const [records, ledger, registry] = await Promise.all([stores.loadWraps(), stores.loadLedger(), stores.loadRegistry()]);
      const open = records.filter((r) => r.status === "quoting" || r.status === "executing" || r.status === "active");
      const paid = ledger.filter((e) => e.status === "paid" || e.status === "confirmed");
      const spotRef = open.find((r) => r.quote)?.quote?.spot ?? records.slice().reverse().find((r) => r.quote)?.quote?.spot ?? 0;
      const derived = deriveCaps(capsInputs, spotRef);
      const priced = records.filter((r) => r.quote != null && (r.hedge?.contracts ?? 0) > 0);
      sendJson(res, 200, {
        ok: true,
        executionMode: guards.executionMode,
        wraps: {
          total: priced.length,
          active: open.length,
          expiries: records.filter((r) => r.status === "concluded" && r.concludedAtMs != null && r.vesting != null && r.concludedAtMs >= r.vesting.endMs).length,
          knockouts: records.filter((r) => r.status === "knocked_out").length,
          earlyCloses: records.filter((r) => r.status === "concluded" && r.concludedAtMs != null && r.vesting != null && r.concludedAtMs < r.vesting.endMs).length
        },
        notional: {
          openUsdc: round2(open.reduce((s, r) => s + wrapExposureUsdc(r), 0)),
          lifetimeWrappedUsdc: round2(priced.reduce((s, r) => s + wrapExposureUsdc(r), 0))
        },
        credits: {
          paidUsdc: round2(paid.reduce((s, e) => s + e.amountUsdc, 0)),
          paidCount: paid.length
        },
        capacity: {
          bookCapUsdc: derived.bookCapUsdc,
          utilizationPct: derived.bookCapUsdc > 0 ? +((open.reduce((s, r) => s + wrapExposureUsdc(r), 0) / derived.bookCapUsdc) * 100).toFixed(1) : 0,
          foundingWallets: capsInputs.foundingWallets,
          walletsJoined: Object.keys(registry).length,
          waitlistLength: (await stores.loadWaitlist()).length,
          showCohortCount
        },
        generatedAtIso: new Date().toISOString()
      });
      return;
    }

    // ── Trader API (account-scoped) ──
    if (req.method === "GET" && route === "/api/state") {
      const wantAll = url.searchParams.get("all") === "1";
      const acct = resolveAccount(url.searchParams.get("account"));
      if (!acct.ok) {
        // The ADMIN whole-book view needs no account (production bug: the control room rendered
        // empty on deploys without a default DEMO_HL_ADDRESS because this 403'd first).
        if (wantAll && isAdmin) {
          sendJson(res, 200, await buildState(undefined, true));
          return;
        }
        sendJson(res, 403, { ok: false, error: "account_refused", message: acct.message });
        return;
      }
      if (wantAll && !isAdmin && adminAuth.token != null) {
        sendJson(res, 403, { ok: false, error: "admin_required", message: "whole-book state requires the admin token" });
        return;
      }
      // Funnel: only EXPLICIT account params count as a look — the env-default account (control
      // room, extension fallback) polling itself is not a visitor. A showcased wallet being
      // viewed is a WATCH, never a looker: watching a whale is not a wallet we reached.
      if (url.searchParams.get("account")) {
        if (isShowcase(acct.account)) recordPageLoad(funnelState, "watch", Date.now());
        else if (!recordLooker(funnelState, acct.account, Date.now())) { /* invalid address — ignored */ }
        funnelDirty = true;
      }
      sendJson(res, 200, await buildState(acct.account, wantAll));
      return;
    }
    if (req.method === "GET" && route === "/api/positions") {
      const acct = resolveAccount(url.searchParams.get("account"));
      if (!acct.ok) {
        sendJson(res, 403, { ok: false, error: "account_refused", message: acct.message });
        return;
      }
      if (url.searchParams.get("account")) {
        if (isShowcase(acct.account)) recordPageLoad(funnelState, "watch", Date.now());
        else if (!recordLooker(funnelState, acct.account, Date.now())) { /* invalid address — ignored */ }
        funnelDirty = true;
      }
      const [positions, mids] = await Promise.all([hl.allPositions(acct.account), hl.allMids()]);
      sendJson(res, 200, {
        ok: true,
        account: acct.account,
        positions: positions.map((p) => {
          const mark = Number(mids[p.coin]);
          return {
            coin: p.coin,
            side: p.szi > 0 ? "long" : "short",
            szBase: Math.abs(p.szi),
            entryPx: p.entryPx,
            markPx: Number.isFinite(mark) ? mark : null,
            notionalUsdc: round2(p.positionValueUsd ?? Math.abs(p.szi) * (Number.isFinite(mark) ? mark : 0)),
            // Only the service coin is wrappable today (OKX listed BTC options).
            wrappable: p.coin === coin
          };
        })
      });
      return;
    }
    if (req.method === "GET" && route === "/api/quote") {
      // Indicative pre-wrap quote (probe only, nothing opens, nothing is stored).
      const acct = resolveAccount(url.searchParams.get("account"));
      if (!acct.ok) {
        sendJson(res, 403, { ok: false, error: "account_refused", message: acct.message });
        return;
      }
      const position = await readHlPosition(acct.account);
      if (!position) {
        sendJson(res, 409, { ok: false, error: "no_position", message: `no open ${coin} position on ${acct.account}` });
        return;
      }
      const { derived } = effectiveGuards(position.markPx);
      const sizing = partialWrapSizing(position.szBase, position.notionalUsdc, derived.perWalletCapUsdc, 0, position.markPx);
      if (!sizing.ok) {
        sendJson(res, 409, { ok: false, error: "not_wrappable", message: sizing.reason });
        return;
      }
      const plan = demoPlanStrikes(position.markPx, position.side, floorPct, capPct);
      const probe = await fetchOkxListedTouchQuote({
        side: position.side,
        spot: position.markPx,
        planPutStrike: plan.putStrike,
        planCallStrike: plan.callStrike,
        notionalUsdc: sizing.coveredNotionalUsdc,
        contractsBtc: sizing.coveredBtc,
        nowMs: Date.now()
      });
      if (!probe.ok) {
        sendJson(res, 409, { ok: false, error: probe.error, message: probe.message });
        return;
      }
      const registry = await stores.loadRegistry();
      const rate = takeRateFor(capsInputs, registry[acct.account.toLowerCase()]?.joinedAtMs ?? Date.now(), Date.now());
      const split = applyTake(probe.creditUsdc, rate.ratePct, capsInputs.deMinimisUsdc, rate.founding);
      sendJson(res, 200, {
        ok: true,
        indicative: true, // executable truth is the post-fill number (one-number rule)
        side: position.side,
        creditUsdc: split.traderCreditUsdc,
        grossCreditUsdc: probe.creditUsdc,
        takeRatePct: split.appliedRatePct,
        founding: rate.founding,
        floorStrike: position.side === "long" ? probe.putStrike : probe.callStrike,
        capStrike: position.side === "long" ? probe.callStrike : probe.putStrike,
        expiryMs: probe.expiryMs,
        coveredBtc: sizing.coveredBtc,
        coverageNote: sizing.coverageNote
      });
      return;
    }
    if (req.method === "GET" && route === "/api/showcase") {
      // Watch-mode chips: up to 3 live public wallets. Stale-while-revalidate — never block a
      // page render on a 36MB leaderboard fetch.
      if (!demoAids) {
        sendJson(res, 200, { ok: true, wallets: [] });
        return;
      }
      if (Date.now() - showcaseCache.atMs > SHOWCASE_TTL_MS) void refreshShowcase();
      sendJson(res, 200, { ok: true, wallets: showcaseCache.wallets });
      return;
    }
    if (req.method === "GET" && route === "/api/px") {
      // Public live mark for the header ticker — visible BEFORE any address is connected (the
      // pre-connect visitor reading floor/cap percentages is exactly who needs the reference).
      const mark = lastHlMark ?? (await hl.midPx(coin).catch(() => null));
      sendJson(res, mark != null && mark > 0 ? 200 : 503, { ok: mark != null && mark > 0, coin, pxUsd: mark });
      return;
    }
    if (req.method === "GET" && route === "/api/preview") {
      // No-address preview: the full value proposition (credit, floor, cap) priced off the REAL
      // listed book for a hypothetical position — value first, wallet second. Preview-only by
      // construction: wrapping still requires a live venue-read position (anti-fraud foundation).
      // Pricing is the SAME live-book path a wrap uses (plan → listed probe → take) but for the
      // FULL requested size — the preview sells the product's true economics, not today's book
      // capital. The per-wallet capacity clip still applies to REAL wraps; when the previewed
      // size exceeds it, the response flags it so the client can add one soft, numberless line
      // (never a math lesson, never a silent clip that reads as broken pricing — both were tried).
      const side: PerpSide = url.searchParams.get("side") === "short" ? "short" : "long";
      const mark = lastHlMark ?? (await hl.midPx(coin).catch(() => null));
      if (mark == null || !(mark > 0)) {
        sendJson(res, 503, { ok: false, error: "no_price", message: "live price unavailable — try again in a moment" });
        return;
      }
      // USD notional is the native input (traders think in $); sizeBtc kept as a legacy alias.
      const usdParam = url.searchParams.get("usd");
      const sizeBtc = usdParam != null ? Number(usdParam) / mark : Number(url.searchParams.get("sizeBtc") ?? "0.02");
      const requestedUsd = round2(sizeBtc * mark);
      // Sanity ceiling only (typo protection for the typed preview) — NOT a risk limit: quotes are
      // indicative and open nothing. Set above any realistic leaderboard position after a live
      // $124M whale tripped the old $100M cap and watch mode showed a failure on the first click.
      if (!Number.isFinite(sizeBtc) || sizeBtc <= 0 || requestedUsd > 500_000_000) {
        sendJson(res, 400, { ok: false, error: "invalid_size", message: "position size must be a positive USD amount (≤ $500M)" });
        return;
      }
      const { derived } = effectiveGuards(mark);
      // Full size, whole lots only (requestedUsd as its own cap ⟹ lot rounding is the only trim).
      const sizing = partialWrapSizing(sizeBtc, requestedUsd, requestedUsd, 0, mark);
      if (!sizing.ok) {
        sendJson(res, 409, { ok: false, error: "not_wrappable", message: sizing.reason });
        return;
      }
      const plan = demoPlanStrikes(mark, side, floorPct, capPct);
      const probe = await fetchOkxListedTouchQuote({
        side,
        spot: mark,
        planPutStrike: plan.putStrike,
        planCallStrike: plan.callStrike,
        notionalUsdc: sizing.coveredNotionalUsdc,
        contractsBtc: sizing.coveredBtc,
        nowMs: Date.now()
      });
      if (!probe.ok) {
        sendJson(res, 409, { ok: false, error: probe.error, message: probe.message });
        return;
      }
      // A fresh wallet joining now gets the founding rate while the cohort has room — mirror /api/quote.
      const rate = takeRateFor(capsInputs, Date.now(), Date.now());
      const split = applyTake(probe.creditUsdc, rate.ratePct, capsInputs.deMinimisUsdc, rate.founding);
      recordPageLoad(funnelState, "preview", Date.now());
      funnelDirty = true;
      sendJson(res, 200, {
        ok: true,
        preview: true, // hypothetical position — nothing opens, nothing is stored
        indicative: true,
        side,
        requestedUsd,
        protectedUsd: sizing.coveredNotionalUsdc,
        coveredBtc: sizing.coveredBtc,
        perWalletCapUsdc: derived.perWalletCapUsdc,
        // True ⟹ a real wrap today would protect part of this while early capacity fills.
        exceedsCurrentCap: sizing.coveredNotionalUsdc > derived.perWalletCapUsdc,
        spot: mark,
        creditUsdc: split.traderCreditUsdc,
        takeRatePct: split.appliedRatePct,
        founding: rate.founding,
        floorStrike: side === "long" ? probe.putStrike : probe.callStrike,
        capStrike: side === "long" ? probe.callStrike : probe.putStrike,
        expiryMs: probe.expiryMs,
        coverageNote: sizing.coverageNote
      });
      return;
    }
    if (req.method === "GET" && route === "/api/protection") {
      const acct = resolveAccount(url.searchParams.get("account"));
      if (!acct.ok) {
        sendJson(res, 403, { ok: false, error: "account_refused", message: acct.message });
        return;
      }
      const prefs = await stores.loadPrefs();
      sendJson(res, 200, { ok: true, account: acct.account, on: prefs[acct.account.toLowerCase()]?.on === true });
      return;
    }
    if (req.method === "POST" && route === "/api/wrap") {
      const acct = resolveAccount(url.searchParams.get("account"));
      if (!acct.ok) {
        sendJson(res, 403, { ok: false, error: "account_refused", message: acct.message });
        return;
      }
      const key = acct.account.toLowerCase();
      if (wrapLocked(key)) {
        sendJson(res, 409, { ok: false, error: "in_flight", message: `a wrap for ${acct.account} is already being processed` });
        return;
      }
      const idem = String(req.headers["idempotency-key"] ?? url.searchParams.get("idem") ?? "").trim() || null;
      wrapsInFlight.set(key, Date.now());
      try {
        const out = await withTimeout(
          doWrap(acct.account, false, idem),
          WRAP_REQUEST_TIMEOUT_MS,
          { status: 504, body: { ok: false, error: "wrap_timeout", message: "the venue did not answer in time — nothing opened; try again in a minute" } }
        );
        // Toggle ON is a state: a SUCCESSFUL wrap arms auto-renew for this account (refusals don't —
        // the daily quota can't be laundered through the renewal lane by toggling once).
        if ((out.body as { ok?: boolean }).ok === true) {
          await setProtection(acct.account, true);
          // Issue (or re-issue to the wrapping client) the account's close-gate control token.
          const prefs = await stores.loadPrefs();
          const pk = acct.account.toLowerCase();
          if (!prefs[pk]?.controlToken) {
            prefs[pk] = { ...(prefs[pk] ?? { on: true, sinceMs: Date.now() }), controlToken: randomUUID() };
            await stores.savePrefs(prefs);
          }
          (out.body as Record<string, unknown>).controlToken = prefs[pk].controlToken;
        }
        sendJson(res, out.status, out.body);
      } finally {
        wrapsInFlight.delete(key);
      }
      return;
    }
    if (req.method === "POST" && route === "/api/close") {
      // Voluntary early close (toggle OFF): collect vested-to-now, claw back the rest, unwind.
      const acct = resolveAccount(url.searchParams.get("account"));
      if (!acct.ok) {
        sendJson(res, 403, { ok: false, error: "account_refused", message: acct.message });
        return;
      }
      // Owner-only when the signature gate is armed: a stranger must never force someone's
      // early close (clawback griefing) just by knowing their address.
      if (requireActionSig || tosRequired) {
        const cleared = actionCleared(await stores.loadTos(), acct.account, tosVersion, requireActionSig, tosRequired);
        if (!cleared.ok) {
          const err = cleared.error.startsWith("verify_required") ? "verify_required" : "tos_required";
          sendJson(res, 409, { ok: false, error: err, message: cleared.error });
          return;
        }
      }
      // Close gate: only the opening client (control token), a verified wallet, or the admin may
      // force an early close — a stranger with the address cannot trigger a clawback.
      if (closeGate && !isAdmin) {
        const [prefsG, tosG] = await Promise.all([stores.loadPrefs(), stores.loadTos()]);
        const kG = acct.account.toLowerCase();
        const provided = String(req.headers["x-ep-control"] ?? url.searchParams.get("ctl") ?? "").trim();
        if (!closeAllowed(prefsG[kG], tosG[kG], tosVersion, provided)) {
          sendJson(res, 403, { ok: false, error: "close_locked", message: "protection can only be turned off from the device that turned it on (or a verified wallet) — it concludes and pays on its own at the cycle's close" });
          return;
        }
      }
      // Toggle OFF always disarms auto-renew, whether or not something is active right now.
      await setProtection(acct.account, false);
      const records = await stores.loadWraps();
      const active = records.find((r) => r.status === "active" && r.account.toLowerCase() === acct.account.toLowerCase());
      if (!active) {
        sendJson(res, 409, { ok: false, error: "nothing_active", message: `no active wrap to close on ${acct.account} (auto-renew off)` });
        return;
      }
      // LIVE lanes: the venue legs must actually unwind BEFORE the books settle (live finding:
      // early close settled the ledger but left real option legs open). Incomplete unwind ⟹
      // honest refusal — the wrap stays fully hedged and can be closed again or ride to expiry.
      if (active.hedge && active.hedge.mode !== "paper") {
        const mark = await hl.midPx(coin).catch(() => active.quote?.spot ?? 0);
        const unwound = await knockoutUnwindLegs(active, mark);
        if (!unwound.ok) {
          await setProtection(acct.account, true); // don't strand auto-renew off on a failed close
          raiseAlert(
            "unwind_event",
            `early-close unwind INCOMPLETE for ${active.id}: ${unwound.note}`,
            { wrapId: active.id },
            { dedupeKey: `unwind_incomplete:${active.id}`, dedupeMs: UNWIND_ALERT_COOLDOWN_MS }
          );
          sendJson(res, 502, { ok: false, error: "close_unwind_failed", message: "couldn't close the hedge cleanly right now — you're still protected; try again in a minute or let the cycle conclude on its own" });
          return;
        }
      }
      const v = concludeWrapEarly(active, Date.now());
      await stores.saveWraps(records);
      // Early close is a cycle conclusion: the vested credit accrues to the payout ledger.
      await accrueConclusion(active, null);
      sendJson(res, 200, { ok: true, wrap: active, vested: v });
      return;
    }

    // ── Admin API ──
    if (route.startsWith("/api/admin/") || route === "/api/reset") {
      if (!isAdmin) {
        sendJson(res, 403, { ok: false, error: "admin_required", message: adminAuth.enabled ? "bad admin token" : "admin surfaces disabled — set EP_ADMIN_TOKEN" });
        return;
      }
    }
    if (req.method === "POST" && route === "/api/admin/pause") {
      // The runtime kill switch: pauses NEW wraps + renewals; conclusions/knockouts/payouts run on.
      const paused = url.searchParams.get("paused") !== "false";
      runtimePaused = paused;
      runtimePausedReason = paused ? url.searchParams.get("reason") ?? "paused by admin" : null;
      await stores.saveRuntime({ paused, pausedReason: runtimePausedReason, updatedAtMs: Date.now() });
      if (paused) raiseAlert("paused", `new wraps + renewals PAUSED: ${runtimePausedReason}`);
      else console.error(`[demo] admin: resumed new wraps + renewals`);
      sendJson(res, 200, { ok: true, paused, reason: runtimePausedReason });
      return;
    }
    if (req.method === "GET" && route === "/api/admin/status") {
      const [records, ledger, registry] = await Promise.all([stores.loadWraps(), stores.loadLedger(), stores.loadRegistry()]);
      const open = records.filter((r) => r.status === "quoting" || r.status === "executing" || r.status === "active");
      sendJson(res, 200, {
        ok: true,
        stores: stores.kind,
        paused: runtimePaused,
        pausedReason: runtimePausedReason,
        executionMode: guards.executionMode,
        openWraps: open.length,
        openNotionalUsdc: round2(open.reduce((s, r) => s + wrapExposureUsdc(r), 0)),
        wallets: Object.keys(registry).length,
        payoutBacklog: ledger.filter((e) => e.status === "accrued" || e.status === "queued").length,
        payoutFailures: ledger.filter((e) => e.status === "failed").length,
        loops: Object.values(loopPulses).map((p) => ({ name: p.name, lastRunMs: p.lastRunMs, intervalMs: p.intervalMs })),
        // Top of funnel: who LOOKED (distinct addresses that viewed positions/state) vs who
        // wrapped — tells reach problems apart from conversion problems. Admin-only. Headline
        // counts exclude EP_INTERNAL_ACCOUNTS (the operator's own testing).
        funnel: funnelSummary(funnelState, new Set(Object.keys(registry)), Date.now(), internalAccounts)
      });
      return;
    }
    if (req.method === "POST" && route === "/api/admin/funnel/reset") {
      // Targeted counter reset for a clean measurement window — wraps/ledger/registry untouched.
      funnelState = emptyFunnel();
      funnelDirty = false;
      await stores.saveFunnel(funnelState);
      sendJson(res, 200, { ok: true, message: "funnel counters cleared (lookers + page loads + previews + watches)" });
      return;
    }
    if (req.method === "POST" && (route === "/api/reset" || route === "/api/admin/reset")) {
      if (!allowReset) {
        sendJson(res, 403, { ok: false, message: "reset disabled (DEMO_ALLOW_RESET=false)" });
        return;
      }
      await stores.clearAll();
      runtimePaused = false;
      runtimePausedReason = null;
      sendJson(res, 200, { ok: true, message: "store cleared (wraps + prefs + payout ledger + wallet registry + runtime flags)" });
      return;
    }
    sendJson(res, 404, { ok: false, error: "not_found" });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: "internal", message: (e as Error).message });
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

const bootReconcile = async (): Promise<void> => {
  // Reconcile open wraps against live OKX option positions (okx lanes with credentials only —
  // paper wraps have no venue legs). Mismatches alert; a human decides what they mean.
  const { OKX_API_KEY: k, OKX_API_SECRET: s, OKX_API_PASSPHRASE: p } = process.env;
  if (guards.executionMode === "paper" || !k || !s || !p) return;
  try {
    const client = new OkxExecutionClient({ apiKey: k, secret: s, passphrase: p, mode: parseLiveGuardsFromEnv(process.env, "okx").mode });
    const [records, venue] = await Promise.all([stores.loadWraps(), client.getPositions("OPTION")]);
    const venuePositions = (venue.data ?? []).map((v: { instId?: string; pos?: string }) => ({ instId: String(v.instId ?? ""), pos: Number(v.pos ?? 0) }));
    const issues = reconcileOpenWraps(records, venuePositions);
    if (issues.length === 0) console.error(`[demo] boot reconcile: store and venue agree (${venuePositions.length} venue option position(s))`);
    else for (const issue of issues) raiseAlert("reconcile_mismatch", issue);
  } catch (e) {
    raiseAlert("okx_connectivity", `boot reconcile failed: ${(e as Error).message}`);
  }
};

server.listen(port, () => {
  void (async () => {
    if (pgPool) {
      await ensureEpSchema(pgPool);
      console.error(`[demo] stores: POSTGRES (DATABASE_URL)`);
    } else {
      console.error(`[demo] stores: JSON files (set DATABASE_URL for Postgres)`);
    }
    // Restore the persisted pause flag so a restart can't silently re-open a paused book.
    const runtime = await stores.loadRuntime();
    runtimePaused = runtime.paused;
    runtimePausedReason = runtime.pausedReason;
    if (runtimePaused) console.error(`[demo] runtime: PAUSED — ${runtimePausedReason ?? "no reason recorded"}`);
    // Top-of-funnel counters: restore, then flush at most once a minute when dirty.
    funnelState = await stores.loadFunnel();
    // Showcase prefetch (non-blocking): the first visitor should see chips, not a spinner.
    if (demoAids) void refreshShowcase();
    setInterval(() => {
      if (!funnelDirty) return;
      funnelDirty = false;
      void stores.saveFunnel(funnelState).catch((e) => console.error(`[demo] funnel save failed: ${(e as Error).message}`));
    }, 60_000);
    await bootReconcile();

    const refCaps = deriveCaps(capsInputs, 0);
    console.error(`[demo] Trader app on http://localhost:${port}/app · Control Room on http://localhost:${port}/demo${adminAuth.token ? "?token=…" : ""}`);
    console.error(`[demo] mode ${guards.executionMode.toUpperCase()} · kill switch ${guards.enabled ? "ARMED" : "OFF"} · account ${hlAccount() ?? "UNSET (set DEMO_HL_ADDRESS)"}`);
    console.error(
      `[demo] caps (formulas): capital $${capsInputs.subAccountCapitalUsdc} × ${(1 - capsInputs.headroomPct) * 100}% usable ÷ ${(capsInputs.marginPerWrapRate * 100).toFixed(0)}% margin ⟹ book cap $${refCaps.bookCapUsdc}` +
        ` · per-wallet $${round2(refCaps.bookCapUsdc / capsInputs.targetWallets)} (floor 1 lot) · per-strike ≤${(capsInputs.perStrikeCapPct * 100).toFixed(0)}% · cohort ${capsInputs.foundingWallets} wallets` +
        ` · take ${(capsInputs.takeRatePct * 100).toFixed(0)}%/${(capsInputs.foundingTakeRatePct * 100).toFixed(0)}% founding, $0 under $${capsInputs.deMinimisUsdc.toFixed(2)}`
    );
    console.error(`[demo] admin: ${adminAuth.token ? "token auth ON" : adminAuth.enabled ? "DEV MODE (no token)" : "DISABLED — set EP_ADMIN_TOKEN"} · rate limits: reads ${num(process.env.EP_RATE_READS_PER_MIN, 120)}/min, actions ${num(process.env.EP_RATE_ACTIONS_PER_MIN, 12)}/min per IP`);
    console.error(
      `[demo] launch gates: geofence ${geofence.enabled ? `ON (blocked: ${geofence.blockedCountries.join(",")}; unknown ⟹ ${geofence.failOpen ? "allow" : "REFUSE"})` : "off (EP_GEOFENCE=true to arm)"}` +
        ` · ToS ${tosRequired ? `REQUIRED v${tosVersion}` : `off (EP_TOS_REQUIRED=true to arm; v${tosVersion})`}` +
        ` · action signature ${requireActionSig ? "REQUIRED (owner-only actions)" : "off (EP_REQUIRE_ACTION_SIG=true to arm)"} · public dashboard /public`
    );
    if (allowedAccounts.length > 0) console.error(`[demo] multi-client: ${allowedAccounts.includes("*") ? "ANY account (book caps bound exposure)" : `${allowedAccounts.length} extra account(s) allowed`}`);
    console.error(`[demo] auto-renew ${autoRenew ? `ON — expiries re-wrap while the toggle stays on (skip-day retry ${Math.round(renewRetryMs / 60000)}m, stagger window ${Math.round(renewStaggerMs / 60000)}m)` : "OFF (DEMO_AUTO_RENEW=false)"}`);
    if (autoRenew) setInterval(() => void renewalTick(), renewCheckMs);
    console.error(`[demo] knockout monitor ON — mark-touch of the cap ends the cycle (check every ${Math.round(knockoutCheckMs / 1000)}s; runs through the kill switch)`);
    setInterval(() => void monitorTick(), knockoutCheckMs);
    setInterval(() => void watchdogTick(), Math.max(30_000, knockoutCheckMs * 2));
    if (!payoutRail.ok) {
      console.error(`[demo] payout rail REFUSED — ${payoutRail.error}; accrued entries will queue until the rail is armed`);
    } else if (payoutRail.cfg.mode === "arbitrum" && guards.executionMode === "paper") {
      console.error(`[demo] payout rail REFUSED — PAYOUT_MODE=arbitrum with DEMO_EXECUTION=paper would pay real USDC for paper wraps; use the simulated rail`);
    } else {
      console.error(`[demo] payout rail ${payoutRail.cfg.mode.toUpperCase()} — daily outflow cap $${payoutRail.cfg.dailyCapUsdc} (check every ${Math.round(payoutCheckMs / 1000)}s)`);
      setInterval(() => void payoutTick(), payoutCheckMs);
    }
    if (guards.executionMode !== "paper") {
      const armed = executionArmed(parseLiveGuardsFromEnv(process.env, "okx"));
      console.error(`[demo] okx lane: ${armed.armed ? armed.reason : `NOT ARMED — ${armed.reason}`}`);
    }
  })();
});
