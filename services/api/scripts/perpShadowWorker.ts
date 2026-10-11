#!/usr/bin/env tsx
/**
 * EARN & PROTECT — PERP SHADOW RUN (track-record service)
 *
 * Quotes the live product's collar from the OKX listed book at the demo's
 * own terms, continuously, and turns it into an auditable history:
 *   - every SCAN interval, one simulated position per side (long, short) at a
 *     fixed size, priced exactly as /api/preview prices it (nearest in-band
 *     protective wing with an ask; widest in-band funding wing whose credit
 *     clears OKX fees, refused under the cap guard), plus what every other
 *     rule would have written from the same snapshot (every listed cap
 *     distance, fee rule, larger sizes walked down the depth, the other tenor),
 *   - every SETTLE interval, positions past expiry are settled on the PATH:
 *     Hyperliquid candles from open to expiry say whether and when each cap
 *     (the live one and every rung's) was touched — the collar is a
 *     knock-out — and OKX index candles around each touch say whether the
 *     hedge venue's clock saw it too; the print is OKX's official delivery
 *     price for that expiry,
 *   - the append-only JSONL ledger is replayed on every page view.
 *
 * What is real: OKX option prices and fees, Hyperliquid marks, candles and
 * funding, delivery prints. What is simulated: the positions. No credentials,
 * no wallets; structurally unable to trade.
 *
 * Run: npx tsx services/api/scripts/perpShadowWorker.ts
 * Env: PERP_SHADOW_PORT (default 8795) · PERP_SHADOW_LEDGER_PATH
 *      PERP_SHADOW_SCAN_MS (default 60m) · PERP_SHADOW_SETTLE_MS (default 15m)
 *      PERP_SHADOW_SIZE_BTC (default 0.03 = 3 OKX lots) · PERP_SHADOW_SIDES (long,short)
 *      DEMO_FLOOR_PCT / DEMO_CAP_PCT (the live shape, default 0.06 / 0.015)
 *      EP_TENOR (weekly default; `daily` opts out) · EP_MIN_CAP_PCT / EP_CAP_MAX_PCT (+ _WEEKLY): the cap guard, as the demo
 *      EP_CAP_MODE (plain default: the collar runs to expiry, gains above the cap are handed back, a touch is a
 *                   release opportunity; `knockout` settles a touch as the end of the cycle, the previous rule)
 *      EP_TAKE_RATE (default 0.20) · EP_DE_MINIMIS_USDC (default 0.05)
 *      PERP_SHADOW_MIN_TAKE_BPS (live minimum, default 0 = none, as the product today)
 *      PERP_SHADOW_CF_MIN_TAKE_BPS (the fee-floor counterfactual, default 5)
 *      PERP_SHADOW_SETTLE_GRACE_MS (default 20m past expiry) · PERP_SHADOW_HL_PRINT_AFTER_MS (default 24h: when
 *      OKX's print is still unreadable this long after expiry, the Hyperliquid mark at the expiry minute settles
 *      the group, recorded as hl_mark) · PERP_SHADOW_VOID_AFTER_MS (default 7d: void only when neither source printed)
 *      OPERATIONS (perpShadowOps.ts): the watchdog raises settlement_stalled (an open position past expiry by
 *      PERP_SHADOW_SETTLE_STALL_MS, default 6h), quote_stalled, netting_stale and venue_payload_drift (the real
 *      parsers read the live OKX and Hyperliquid payloads every hour); alarms go to the EP alert sink
 *      (ALERT_WEBHOOK_URL, TELEGRAM_BOT_TOKEN + TELEGRAM_ALERT_CHAT_ID, EP_ALERTS_PATH), once per condition per
 *      PERP_SHADOW_ALARM_COOLDOWN_MS (default 6h), and show on /healthz. After each expiry settles, the Friday
 *      review (one row: said vs seen, hand-back vs take, cumulative, flags) is posted on the same sink and
 *      recorded in the ledger so a restart never posts it twice; EP_FRIDAY_HANDBACK_SHARE (default 0.5) and
 *      EP_FRIDAY_MIN_SETTLED (default 100) set the flags.
 *      CAP ODDS (capRule.ts): every quote records where the cap odds would sit on implied over realized vol
 *      (PERP_SHADOW_RV_DAYS of hourly Hyperliquid candles, default 30; EP_CAP_ODDS_SLOPE, default 0.2, inside the
 *      10-30% band); EP_CAP_ODDS_ADAPT=1 applies it to the live strike, otherwise it is measured only.
 *      RFQ (rfqRoute.ts): every quote records the net a desk would have to beat for the collar to route to RFQ
 *      (EP_RFQ_SIZE_THRESHOLD_USD, EP_RFQ_MIN_IMPROVEMENT_BPS, EP_RFQ_TIE_USD).
 *      EP_ADMIN_TOKEN (the demo's admin token) gates /report, /api/shadow/report, /api/shadow/export,
 *      /api/shadow/reset and the full CSV; fail-closed when unset.
 *      PERP_SHADOW_FLOW=1 runs the shadow as a BOOK (perpShadowFlow.ts): hourly batches of wraps to a
 *      daily notional target (PERP_SHADOW_DAILY_NOTIONAL_USD, default $2M), lognormal sizes
 *      (PERP_SHADOW_MEDIAN_USD 15000, PERP_SHADOW_SIZE_SIGMA 1.4, PERP_SHADOW_MAX_USD 750000), a side
 *      mix (PERP_SHADOW_LONG_SHARE 0.7), early closes at live prices (PERP_SHADOW_CLOSE_SHARE 0.3),
 *      every wrap priced at its own size by walking the book, and a netted book snapshot after every
 *      batch (gross vs net legs, fees, margin, slippage). Off: the metronome above.
 *      POST /api/shadow/reset (operator) archives the ledger beside itself and opens a fresh book.
 */

import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { PerpSide } from "../src/singleSide/twoSided/creditCollar/creditCollarPricer";
import { DEMO_CAP_PCT, DEMO_FLOOR_PCT, parseCapMode } from "../src/singleSide/twoSided/creditCollar/demoWrap";
import { capGuardFor, otherTenor, parseTenor } from "../src/singleSide/twoSided/creditCollar/perpTenor";
import { adaptCapOdds, applyCapOdds, capRuleFromEnv, capRuleText, DEFAULT_CAP_EXCEED_PROB, DEFAULT_CAP_ODDS_SLOPE, realizedVolAnnual, type CapOddsAdvice } from "../src/singleSide/twoSided/creditCollar/capRule";
import { packageFor, rfqConfigFromEnv } from "../src/singleSide/twoSided/creditCollar/rfqRoute";
import { buildAlertRaiser, parseAlertSinkFromEnv } from "../src/singleSide/twoSided/creditCollar/epSafety";
import {
  DEFAULT_FRIDAY_CONFIG,
  DEFAULT_SETTLE_STALL_MS,
  driftAlarm,
  feeShare,
  fridayMessage,
  fridayReview,
  hlPrintAtExpiry,
  publicCapLadder,
  watchdog,
  type DriftCheck,
  type FridayReviewConfig,
  type PerpOpsAlarm,
} from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowOps";
import { atmReference, fetchOkxListedSnapshot } from "../src/singleSide/twoSided/creditCollar/perpShadow/okxListedSnapshot";
import { bullishLegReader, deribitLegReader, readVenueReference } from "../src/singleSide/twoSided/creditCollar/perpShadow/venueReference";
import {
  appendPerpShadowRecord,
  loadPerpShadow,
  loadPerpShadowRecords,
  perpLedgerStats,
  perpPositionsCsv,
  plannedIdsIn,
  summarizePerpShadow,
  type PerpPath,
  type PerpPathTouch,
  type PerpShadowPosition,
  type PerpShadowSummary,
} from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowLedger";
import { buildBook, closeAtIso, describeFlow, flowConfigFromEnv, heldInstIds, hourKey, planHourBatch, summarizeFlow, valueClose } from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowFlow";
import { archiveLedgerFile } from "../src/singleSide/twoSided/creditCollar/perpShadow/ledgerArchive";
import {
  fetchHlCandles,
  fetchHlContext,
  fetchOkxDeliveryHistory,
  fetchOkxDeliveryPrice,
  fetchOkxIndex,
  fetchOkxIndexCandlesAround,
  readableDeliveryPrints,
} from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowMarket";
import { candleIntervalFor, firstTouches, okxConfirms, pathRange, type Candle } from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowPath";
import { feeRuleText, perpShadowQuote, type PerpTakeConfig } from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowQuote";
import { adminAuthorized, parseAdminAuthFromEnv } from "../src/singleSide/twoSided/creditCollar/epSafety";
import { renderPerpShadowHtml, renderPerpShadowReportHtml } from "./perpShadowHtml";

const PORT = Number(process.env.PERP_SHADOW_PORT || process.env.PORT || 8795);
const LEDGER_PATH = process.env.PERP_SHADOW_LEDGER_PATH || "/tmp/perp-shadow/ledger.jsonl";
const SCAN_MS = Number(process.env.PERP_SHADOW_SCAN_MS || 60 * 60_000);
const SETTLE_MS = Number(process.env.PERP_SHADOW_SETTLE_MS || 15 * 60_000);
const SETTLE_GRACE_MS = Number(process.env.PERP_SHADOW_SETTLE_GRACE_MS || 20 * 60_000);
const HL_PRINT_AFTER_MS = Number(process.env.PERP_SHADOW_HL_PRINT_AFTER_MS || 24 * 3_600_000);
const VOID_AFTER_MS = Number(process.env.PERP_SHADOW_VOID_AFTER_MS || 7 * 24 * 3_600_000);
const SETTLE_STALL_MS = Number(process.env.PERP_SHADOW_SETTLE_STALL_MS || DEFAULT_SETTLE_STALL_MS);
const ALARM_COOLDOWN_MS = Number(process.env.PERP_SHADOW_ALARM_COOLDOWN_MS || 6 * 3_600_000);
const OPS_MS = Number(process.env.PERP_SHADOW_OPS_MS || 5 * 60_000);
const DRIFT_MS = Number(process.env.PERP_SHADOW_DRIFT_MS || 60 * 60_000);
const RV_DAYS = Number(process.env.PERP_SHADOW_RV_DAYS || 30);
const CAP_ODDS_ADAPT = /^(1|true|on)$/i.test(String(process.env.EP_CAP_ODDS_ADAPT ?? "0"));
const CAP_ODDS_SLOPE = Number(process.env.EP_CAP_ODDS_SLOPE || DEFAULT_CAP_ODDS_SLOPE);
const RFQ_CFG = rfqConfigFromEnv(process.env);
const FRIDAY_CFG: FridayReviewConfig = {
  capExceedProb: DEFAULT_FRIDAY_CONFIG.capExceedProb,
  handBackShareOfTake: Number(process.env.EP_FRIDAY_HANDBACK_SHARE || DEFAULT_FRIDAY_CONFIG.handBackShareOfTake),
  minSettledForFlags: Number(process.env.EP_FRIDAY_MIN_SETTLED || DEFAULT_FRIDAY_CONFIG.minSettledForFlags),
};
const alertSink = parseAlertSinkFromEnv(process.env);
const raiseAlert = buildAlertRaiser(alertSink);
const SIZE_BTC = Number(process.env.PERP_SHADOW_SIZE_BTC || 0.03);
const OKX_LOT_BTC = 0.01;
const CONTRACTS = Math.max(1, Math.round(SIZE_BTC / OKX_LOT_BTC));
const SIDES: PerpSide[] = String(process.env.PERP_SHADOW_SIDES || "long,short")
  .split(",")
  .map((s) => s.trim())
  .filter((s): s is PerpSide => s === "long" || s === "short");
const numEnv = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
// The live shape and guard, read the way the demo reads them so the shadow prices the product.
const GEOMETRY = { floorPct: numEnv(process.env.DEMO_FLOOR_PCT, DEMO_FLOOR_PCT), capPct: numEnv(process.env.DEMO_CAP_PCT, DEMO_CAP_PCT) };
const TENOR = parseTenor(process.env.EP_TENOR);
const CAP_MODE = parseCapMode(process.env.EP_CAP_MODE);
const CAP_GUARD = capGuardFor(TENOR, process.env, CAP_MODE);
const CAP_RULE = capRuleFromEnv(process.env);
FRIDAY_CFG.capExceedProb = CAP_RULE.kind === "target" ? CAP_RULE.maxExceedProb : DEFAULT_CAP_EXCEED_PROB;
const OTHER_TENOR_CAP_GUARD = capGuardFor(otherTenor(TENOR), process.env, CAP_MODE);
const REPLAY = { capMode: CAP_MODE };
const CAP_LADDER_RULE =
  CAP_MODE === "plain"
    ? "the live floor held fixed, the funding wing moved to every listed strike in the band; each rung settled on the same Hyperliquid path and print, so it shows how often it was touched (a release on offer), how often it ended past the cap and how much upside was handed back"
    : "the live floor held fixed, the funding wing moved to every listed strike in the band; each rung settled on the same Hyperliquid path, so it shows its own knock-out rate and buyback cost";
const COIN = process.env.PERP_SHADOW_COIN || "BTC";
const TAKE: PerpTakeConfig = {
  shareRate: Number(process.env.EP_TAKE_RATE || 0.2),
  minTakeBpsOfNotional: Number(process.env.PERP_SHADOW_MIN_TAKE_BPS || 0),
  deMinimisCents: Math.round(Number(process.env.EP_DE_MINIMIS_USDC || 0.05) * 100),
};
const CF_MIN_TAKE_BPS = Number(process.env.PERP_SHADOW_CF_MIN_TAKE_BPS || 5);
// Venue reference (venueReference.ts): the same two legs read at Deribit and Bullish the second OKX
// quotes them — a measurement for the operator report, never the price. PERP_SHADOW_VENUE_REF=0 turns it off.
const VENUE_REF = !/^(0|false|off)$/i.test(String(process.env.PERP_SHADOW_VENUE_REF ?? "1"));
const venueReaders = { deribit: deribitLegReader(), bullish: bullishLegReader() };
// Flow mode (perpShadowFlow.ts): the shadow as a book rather than a metronome.
const FLOW = flowConfigFromEnv(process.env);

const adminAuth = parseAdminAuthFromEnv(process.env);
const OPERATOR_PATHS = new Set(["/report", "/api/shadow/report", "/api/shadow/export", "/api/shadow/reset"]);
const BOOT_MS = Date.now();

let lastScanAt: string | null = null;
let lastSettleAt: string | null = null;
let lastScanError: string | null = null;
let lastSettleError: string | null = null;
let consecutiveScanFailures = 0;
let scanning = false;
let activeAlarms: PerpOpsAlarm[] = [];
let lastDriftChecks: DriftCheck[] = [];
let lastDriftAt: string | null = null;
let lastCapOdds: CapOddsAdvice | null = null;

/** Realized vol for the cap odds: hourly Hyperliquid closes over RV_DAYS. Null on any failure; the rule then keeps its base odds. */
async function realizedVolNow(nowMs: number): Promise<number | null> {
  try {
    const candles = await fetchHlCandles(COIN, nowMs - RV_DAYS * 86_400_000, nowMs, "1h");
    return realizedVolAnnual(candles, 3_600_000);
  } catch {
    return null;
  }
}

/** One quote per side from one snapshot; refusals are recorded, never hidden. */
async function scanTick(): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    const nowMs = Date.now();
    const hl = await fetchHlContext(COIN);
    if (!hl) throw new Error(`Hyperliquid returned no ${COIN} context`);
    const okxIndex = await fetchOkxIndex().catch(() => null);
    // The book's own legs ride along whatever their expiry or distance from spot, so the netting
    // snapshot after this batch marks every open leg at a live book instead of its last quote.
    const held = heldInstIds(loadPerpShadow(LEDGER_PATH, REPLAY).positions);
    const snap = await fetchOkxListedSnapshot({ spot: hl.markPx, nowMs, heldInstIds: held });
    if (snap.chain.length === 0) throw new Error("OKX chain has no live in-band options at the next daily expiry");
    const nowIso = new Date(nowMs).toISOString();
    // Implied over realized: the ATM call's OKX mark vol against RV_DAYS of hourly Hyperliquid closes.
    const atm = atmReference(snap, hl.markPx);
    const impliedVol = atm.callInstId ? (snap.markVols?.[atm.callInstId] ?? null) : null;
    const capOdds = adaptCapOdds({ baseProb: CAP_RULE.kind === "target" ? CAP_RULE.maxExceedProb : DEFAULT_CAP_EXCEED_PROB, impliedVolAnnual: impliedVol, realizedVolAnnual: await realizedVolNow(nowMs), slope: CAP_ODDS_SLOPE });
    lastCapOdds = capOdds;
    const capRuleNow = CAP_ODDS_ADAPT ? applyCapOdds(CAP_RULE, capOdds) : CAP_RULE;
    const stampOpen = (r: ReturnType<typeof perpShadowQuote>) => {
      if (r.type !== "open") return;
      r.capOdds = { baseProb: capOdds.baseProb, adviceProb: capOdds.adviceProb, applied: CAP_ODDS_ADAPT, impliedVolAnnual: capOdds.impliedVolAnnual, realizedVolAnnual: capOdds.realizedVolAnnual, ratio: capOdds.ratio, reason: capOdds.reason };
      const pkg = packageFor(
        { side: r.side, contracts: r.contracts, ctValBtc: r.ctValBtc, notionalCents: r.notionalCents, expiryIso: r.expiryIso, floorStrikeCents: r.floorStrikeCents, capStrikeCents: r.capStrikeCents, bookNetCreditCents: r.netCreditCents },
        RFQ_CFG,
      );
      r.rfq = { bookNetCents: pkg.bookNetCents, beatBookNetCents: pkg.beatBookNetCents };
    };
    const common = {
      spot: hl.markPx,
      geometry: GEOMETRY,
      tenor: TENOR,
      capGuard: CAP_GUARD,
      capRule: capRuleNow,
      otherTenorCapGuard: OTHER_TENOR_CAP_GUARD,
      take: TAKE,
      counterfactualMinTakeBps: CF_MIN_TAKE_BPS,
      okxIndex,
      fundingBpsPer8h: hl.fundingBpsPer8h,
      nowIso,
    };
    if (FLOW.enabled) {
      // The hour's batch is re-plannable from its key; whatever the ledger already has from it is skipped.
      const key = hourKey(nowMs);
      const seen = plannedIdsIn(loadPerpShadowRecords(LEDGER_PATH));
      const ctValBtc = snap.chain[0]?.ctValBtc ?? 0.01;
      for (const plan of planHourBatch(key, hl.markPx, ctValBtc, FLOW)) {
        if (seen.has(plan.id)) continue;
        const rec = perpShadowQuote({ ...common, side: plan.side, contracts: plan.contracts, id: plan.id, fillMode: "walk" }, snap);
        if (rec.type === "open") {
          rec.flow = { sizeClass: plan.sizeClass, targetUsd: plan.targetUsd, closeAtIso: closeAtIso(rec.at, rec.expiryIso, plan.closeAtFrac) };
          // the venue reference is a per-leg read at two venues; keep it to the first wrap of the hour so a batch is not 40 round-trips
          if (VENUE_REF && plan.id.endsWith("-f1")) {
            rec.venueReference = await readVenueReference(
              { buyInstId: rec.buyInstId, sellInstId: rec.sellInstId, buyPxBtc: rec.buyPxBtc, sellPxBtc: rec.sellPxBtc, spot: hl.markPx },
              venueReaders,
            ).catch(() => null);
          }
        } else {
          rec.id = plan.id;
          rec.sizeClass = plan.sizeClass;
        }
        stampOpen(rec);
        appendPerpShadowRecord(LEDGER_PATH, rec);
      }
    } else {
      for (const side of SIDES) {
        const rec = perpShadowQuote({ ...common, side, contracts: CONTRACTS, id: `${nowIso.slice(0, 16).replace(/[-:T]/g, "")}-${side}` }, snap);
        if (rec.type === "open" && VENUE_REF) {
          rec.venueReference = await readVenueReference(
            { buyInstId: rec.buyInstId, sellInstId: rec.sellInstId, buyPxBtc: rec.buyPxBtc, sellPxBtc: rec.sellPxBtc, spot: hl.markPx },
            venueReaders,
          ).catch(() => null);
        }
        stampOpen(rec);
        appendPerpShadowRecord(LEDGER_PATH, rec);
      }
    }
    // The book after this batch, netted by exact instrument at this snapshot's depth.
    const open = loadPerpShadow(LEDGER_PATH, REPLAY).positions.filter((p) => p.status === "open");
    if (open.length > 0) appendPerpShadowRecord(LEDGER_PATH, buildBook(open, snap, hl.markPx, nowIso));
    lastScanAt = nowIso;
    lastScanError = null;
    consecutiveScanFailures = 0;
  } catch (err) {
    lastScanError = String(err instanceof Error ? err.message : err);
    consecutiveScanFailures += 1;
  } finally {
    scanning = false;
  }
}

/**
 * The path a group of positions at one expiry ran on: Hyperliquid candles
 * from the earliest open to expiry, once per expiry, then each position's
 * caps (live + every rung) checked for a first touch. Each touch asks the
 * OKX index around that minute whether the hedge venue saw it too.
 */
const buildPath = async (p: PerpShadowPosition, candles: Candle[], interval: "1m" | "5m", okxFetch: typeof fetchOkxIndexCandlesAround): Promise<PerpPath | null> => {
  const openMs = Date.parse(p.at);
  const expiryMs = Date.parse(p.expiryIso);
  const range = pathRange(candles, openMs, expiryMs);
  if (!range) return null;
  const caps = [p.capStrikeCents, ...(p.counterfactuals?.capLadder ?? []).map((r) => r.capStrikeCents)];
  const touches: PerpPathTouch[] = [];
  for (const t of firstTouches(candles, p.side, caps, openMs, expiryMs)) {
    let okx = { okxPxCents: null as number | null, confirmed: null as boolean | null, gapBps: null as number | null };
    try {
      okx = okxConfirms(await okxFetch(t.atMs), p.side, t.capStrikeCents, t.atMs);
    } catch {
      // unknown stays unknown
    }
    touches.push({
      capStrikeCents: t.capStrikeCents,
      atIso: new Date(t.atMs).toISOString(),
      hlPxCents: t.hlPxCents,
      okxPxCents: okx.okxPxCents,
      okxConfirmed: okx.confirmed,
      okxGapBps: okx.gapBps,
    });
  }
  return { source: "hl_candles", interval, candles: range.candles, hiCents: range.hiCents, loCents: range.loCents, touches };
};

/** Settle every expired position on its path and the official delivery print; void what never prints. */
async function settleTick(
  deps: { candles?: typeof fetchHlCandles; okxAround?: typeof fetchOkxIndexCandlesAround; delivery?: typeof fetchOkxDeliveryPrice; hl?: typeof fetchHlContext; snapshot?: typeof fetchOkxListedSnapshot } = {},
): Promise<void> {
  try {
    const nowMs = Date.now();
    const { positions } = loadPerpShadow(LEDGER_PATH, REPLAY);
    // Early closes fall due before expiry and are valued at LIVE prices: the mark now, the two legs now.
    const closing = positions.filter((p) => p.status === "open" && p.flow?.closeAtIso && Date.parse(p.flow.closeAtIso) <= nowMs && Date.parse(p.expiryIso) > nowMs);
    if (closing.length > 0) {
      const hl = await (deps.hl ?? fetchHlContext)(COIN);
      if (hl) {
        // A close is valued at the legs it holds; they may sit at an expiry the quoting chain has
        // rolled past or a strike outside the band, so the snapshot fetches them by name.
        const snap = await (deps.snapshot ?? fetchOkxListedSnapshot)({ spot: hl.markPx, nowMs, heldInstIds: heldInstIds(closing), altTenors: false }).catch(() => null);
        const nowIso = new Date(nowMs).toISOString();
        for (const p of closing) {
          const valuation = snap
            ? valueClose(p, snap, hl.markPx)
            : { markCents: Math.round(hl.markPx * 100), legs: { floorBidBtc: null, floorAskBtc: null, capBidBtc: null, capAskBtc: null }, unwindImmediateCents: null, unwindPassiveCents: null };
          appendPerpShadowRecord(LEDGER_PATH, { type: "close", at: nowIso, id: p.id, valuation });
        }
      }
    }
    const due = positions.filter((p) => p.status === "open" && Date.parse(p.expiryIso) + SETTLE_GRACE_MS <= nowMs);
    const byExpiry = new Map<string, PerpShadowPosition[]>();
    for (const p of due) byExpiry.set(p.expiryIso, [...(byExpiry.get(p.expiryIso) ?? []), p]);
    const nowIso = new Date(nowMs).toISOString();
    let settledSomething = false;
    for (const [expiryIso, group] of byExpiry) {
      const expiryMs = Date.parse(expiryIso);
      let px: number | null = null;
      let source: "okx_delivery" | "hl_mark" = "okx_delivery";
      try {
        px = await (deps.delivery ?? fetchOkxDeliveryPrice)(expiryMs);
      } catch (err) {
        lastSettleError = `delivery: ${String(err instanceof Error ? err.message : err)}`;
      }
      if (px == null && nowMs - expiryMs > HL_PRINT_AFTER_MS) {
        // SECOND SOURCE before any void: the Hyperliquid mark at the expiry minute (the product's own
        // price, 0.6 bps from the OKX index on this record). Marked hl_mark on every row it settles.
        try {
          const around = await (deps.candles ?? fetchHlCandles)(COIN, expiryMs - 30 * 60_000, expiryMs + 60_000, "1m");
          px = hlPrintAtExpiry(around, expiryMs, 60_000);
          if (px != null) source = "hl_mark";
        } catch (err) {
          lastSettleError = `hl print: ${String(err instanceof Error ? err.message : err)}`;
        }
      }
      if (px == null) {
        if (nowMs - expiryMs > VOID_AFTER_MS) {
          for (const p of group) appendPerpShadowRecord(LEDGER_PATH, { type: "void", at: nowIso, id: p.id, reason: "no delivery price published by OKX and no Hyperliquid mark at expiry" });
        }
        continue;
      }
      const startMs = Math.min(...group.map((p) => Date.parse(p.at)));
      const interval = candleIntervalFor(expiryMs - startMs);
      let candles: Candle[] = [];
      try {
        candles = await (deps.candles ?? fetchHlCandles)(COIN, startMs, expiryMs, interval);
      } catch (err) {
        lastSettleError = `candles: ${String(err instanceof Error ? err.message : err)}`;
      }
      for (const p of group) {
        const path = candles.length ? await buildPath(p, candles, interval, deps.okxAround ?? fetchOkxIndexCandlesAround) : null;
        appendPerpShadowRecord(LEDGER_PATH, { type: "settle", at: nowIso, id: p.id, settleCents: Math.round(px * 100), source, path });
      }
      settledSomething = true;
    }
    lastSettleAt = nowIso;
    if (!lastSettleError?.startsWith("candles:")) lastSettleError = null;
    if (settledSomething || byExpiry.size === 0) postFridayReviews(nowIso);
  } catch (err) {
    lastSettleError = String(err instanceof Error ? err.message : err);
  }
}

/**
 * The Friday review: one row per expiry that has settled and has not been posted. Goes to the
 * alert sink and is recorded in the ledger (type review) so a restart posts nothing twice.
 */
function postFridayReviews(nowIso: string): void {
  const { positions, reviewed } = loadPerpShadow(LEDGER_PATH, REPLAY);
  for (const row of fridayReview(positions, FRIDAY_CFG)) {
    if (reviewed.has(row.expiryIso)) continue;
    // every position at this expiry must be past open before its row is final
    if (positions.some((p) => p.expiryIso === row.expiryIso && p.status === "open")) continue;
    raiseAlert("friday_review", fridayMessage(row), { expiryIso: row.expiryIso, flags: row.flags }, { dedupeKey: `friday:${row.expiryIso}`, dedupeMs: 365 * 86_400_000 });
    appendPerpShadowRecord(LEDGER_PATH, { type: "review", at: nowIso, expiryIso: row.expiryIso });
  }
}

/** The watchdog: who has gone quiet, what is overdue. Every alarm is raised once per cooldown and shown on /healthz. */
function opsTick(nowMs = Date.now()): PerpOpsAlarm[] {
  const { positions, books } = loadPerpShadow(LEDGER_PATH, REPLAY);
  const lastBook = books.length ? Date.parse(books[books.length - 1].at) : null;
  const alarms = watchdog({
    nowMs,
    positions,
    lastScanAtMs: lastScanAt ? Date.parse(lastScanAt) : null,
    lastSettleAtMs: lastSettleAt ? Date.parse(lastSettleAt) : null,
    lastScanError,
    lastSettleError,
    consecutiveScanFailures,
    lastBookAtMs: lastBook,
    flowEnabled: FLOW.enabled,
    scanMs: SCAN_MS,
    settleGraceMs: SETTLE_GRACE_MS,
    settleStallMs: SETTLE_STALL_MS,
    bootMs: BOOT_MS,
  });
  const drift = driftAlarm(lastDriftChecks);
  if (drift) alarms.push(drift);
  for (const a of alarms) raiseAlert(a.kind, a.message, a.data, { dedupeKey: a.key, dedupeMs: ALARM_COOLDOWN_MS });
  activeAlarms = alarms;
  return alarms;
}

/**
 * Venue payload drift: the real parsers read the live payloads and must find what they expect.
 * The October 2026 rename of delivered instruments (BTC-USD_UM) would have failed this on day one.
 */
async function driftTick(
  deps: { delivery?: typeof fetchOkxDeliveryHistory; hl?: typeof fetchHlContext; candles?: typeof fetchHlCandles; index?: typeof fetchOkxIndex } = {},
): Promise<DriftCheck[]> {
  const nowMs = Date.now();
  const checks: DriftCheck[] = [];
  const run = async (name: string, f: () => Promise<{ ok: boolean; detail: string }>) => {
    try {
      checks.push({ name, ...(await f()) });
    } catch (err) {
      checks.push({ name, ok: false, detail: String(err instanceof Error ? err.message : err) });
    }
  };
  await run("okx_delivery_history", async () => {
    const n = readableDeliveryPrints(await (deps.delivery ?? fetchOkxDeliveryHistory)());
    return { ok: n > 0, detail: n > 0 ? `${n} readable prints` : "no row parsed to a date code and a price" };
  });
  await run("hl_context", async () => {
    const hl = await (deps.hl ?? fetchHlContext)(COIN);
    return { ok: !!hl && hl.markPx > 0, detail: hl ? `mark ${hl.markPx}` : "no mark" };
  });
  await run("hl_candles", async () => {
    const c = await (deps.candles ?? fetchHlCandles)(COIN, nowMs - 2 * 3_600_000, nowMs, "1m");
    return { ok: c.length > 0, detail: `${c.length} candles in the last 2h` };
  });
  await run("okx_index", async () => {
    const px = await (deps.index ?? fetchOkxIndex)();
    return { ok: px != null && px > 0, detail: px != null ? `index ${px}` : "no index" };
  });
  lastDriftChecks = checks;
  lastDriftAt = new Date(nowMs).toISOString();
  return checks;
}

function pageData(): { atIso: string; positions: PerpShadowPosition[]; summary: PerpShadowSummary } {
  const { positions, refusals, books } = loadPerpShadow(LEDGER_PATH, REPLAY);
  const summary = summarizePerpShadow(positions, refusals, REPLAY);
  summary.flow = summarizeFlow(positions, refusals, books, FLOW);
  return { atIso: new Date().toISOString(), positions, summary };
}

function publicSummary(s: PerpShadowSummary, positions: PerpShadowPosition[]): Omit<PerpShadowSummary, "counterfactuals"> & {
  counterfactuals: { recordedSince: string | null; positionsWithCounterfactuals: number };
  capLadder: ReturnType<typeof publicCapLadder>;
  fridays: ReturnType<typeof fridayReview>;
  feeShare: ReturnType<typeof feeShare>;
  capOdds: { adaptApplied: boolean; latest: CapOddsAdvice | null };
} {
  const { counterfactuals, ...rest } = s;
  return {
    ...rest,
    counterfactuals: { recordedSince: counterfactuals.recordedSince, positionsWithCounterfactuals: counterfactuals.positionsWithCounterfactuals },
    capLadder: publicCapLadder(counterfactuals),
    fridays: fridayReview(positions, FRIDAY_CFG),
    feeShare: feeShare(s),
    capOdds: { adaptApplied: CAP_ODDS_ADAPT, latest: lastCapOdds },
  };
}

function healthBody(): Record<string, unknown> {
  const { positions } = loadPerpShadow(LEDGER_PATH, REPLAY);
  return {
    ok: true,
    service: "earn-protect-perp-shadow",
    uptimeMs: Date.now() - BOOT_MS,
    positions: positions.length,
    open: positions.filter((p) => p.status === "open").length,
    ledger: { path: LEDGER_PATH, ...perpLedgerStats(LEDGER_PATH) },
    terms: { geometry: GEOMETRY, tenor: TENOR, capMode: CAP_MODE, capGuard: CAP_GUARD, capRule: CAP_RULE, contracts: CONTRACTS, sizeBtc: CONTRACTS * OKX_LOT_BTC, sides: SIDES, take: TAKE, counterfactualMinTakeBps: CF_MIN_TAKE_BPS },
    flow: FLOW.enabled ? { ...FLOW, rule: describeFlow(FLOW) } : { enabled: false },
    lastScanAt,
    lastSettleAt,
    lastScanError,
    lastSettleError,
    consecutiveScanFailures,
    operatorViews: adminAuth.enabled,
    // operations: what is wrong right now, where it would be sent, what the parsers last read
    alarms: activeAlarms.map((a) => ({ kind: a.kind, message: a.message })),
    alertSink: { webhook: !!alertSink.webhookUrl, telegram: !!alertSink.telegram, path: alertSink.path, cooldownMs: ALARM_COOLDOWN_MS },
    drift: { at: lastDriftAt, checks: lastDriftChecks },
    settlement: { graceMs: SETTLE_GRACE_MS, hlPrintAfterMs: HL_PRINT_AFTER_MS, voidAfterMs: VOID_AFTER_MS, stallMs: SETTLE_STALL_MS },
    capOdds: { adaptApplied: CAP_ODDS_ADAPT, slope: CAP_ODDS_SLOPE, realizedVolDays: RV_DAYS, latest: lastCapOdds },
    rfq: RFQ_CFG,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const operator = adminAuthorized(adminAuth, req.headers, url.searchParams.get("token"));
  try {
    if (OPERATOR_PATHS.has(url.pathname) && !operator) {
      sendJson(res, 403, { ok: false, error: adminAuth.enabled ? "bad admin token" : "operator views disabled — set EP_ADMIN_TOKEN" });
      return;
    }
    if (url.pathname === "/healthz") {
      sendJson(res, 200, healthBody());
      return;
    }
    if (url.pathname === "/api/shadow/reset") {
      // FRESH START, ARCHIVE NOT DELETE: the ledger is renamed beside itself with a UTC stamp (still
      // exportable, still append-only, now closed) and the next scan opens a new book under the rules
      // in force. Operator only; POST, or GET with confirm=reset from a browser.
      if (!(req.method === "POST" || (req.method === "GET" && url.searchParams.get("confirm") === "reset"))) {
        sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "POST /api/shadow/reset?token=… or GET …&confirm=reset" });
        return;
      }
      const atIso = new Date().toISOString();
      const archived = [archiveLedgerFile(LEDGER_PATH, atIso)].filter((a) => a.archivedTo).map((a) => ({ from: a.path, to: a.archivedTo }));
      void scanTick();
      sendJson(res, 200, {
        ok: true,
        at: atIso,
        archived,
        message: "perp shadow ledger archived; a fresh book opens with the next scan",
        rules: { capMode: CAP_MODE, tenor: TENOR, geometry: GEOMETRY, capRule: capRuleText(CAP_RULE), flow: FLOW.enabled ? describeFlow(FLOW) : "off (metronome)" },
      });
      return;
    }
    if (url.pathname === "/api/shadow/export") {
      const stats = perpLedgerStats(LEDGER_PATH);
      if (!stats.exists) {
        res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "content-length": 0, "cache-control": "no-store" });
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-length": statSync(LEDGER_PATH).size,
        "content-disposition": `attachment; filename="perp-shadow-ledger-${new Date().toISOString().slice(0, 10)}.jsonl"`,
        "cache-control": "no-store",
      });
      createReadStream(LEDGER_PATH).pipe(res);
      return;
    }
    if (url.pathname === "/api/shadow/positions.csv") {
      const full = operator && url.searchParams.get("scope") === "full";
      const csv = perpPositionsCsv(loadPerpShadow(LEDGER_PATH, REPLAY).positions, full ? "full" : "public", REPLAY);
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="perp-shadow-positions${full ? "-full" : ""}-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "no-store",
      });
      res.end(csv);
      return;
    }
    if (url.pathname === "/api/shadow") {
      const { atIso, positions, summary } = pageData();
      const settled = positions.filter((p) => p.status === "settled").sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""));
      const open = positions.filter((p) => p.status === "open").sort((a, b) => a.expiryIso.localeCompare(b.expiryIso) || a.at.localeCompare(b.at));
      const closed = positions.filter((p) => p.status === "closed").sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
      const strip = (p: PerpShadowPosition) => {
        const { counterfactuals: _cf, ...rest } = p;
        return rest;
      };
      sendJson(res, 200, { ok: true, at: atIso, summary: publicSummary(summary, positions), settled: settled.map(strip), open: open.map(strip), closed: closed.map(strip) });
      return;
    }
    if (url.pathname === "/api/shadow/fridays") {
      const { atIso, positions } = pageData();
      sendJson(res, 200, { ok: true, at: atIso, config: FRIDAY_CFG, fridays: fridayReview(positions, FRIDAY_CFG) });
      return;
    }
    if (url.pathname === "/api/shadow/ops") {
      sendJson(res, 200, { ok: true, at: new Date().toISOString(), alarms: opsTick(), drift: { at: lastDriftAt, checks: lastDriftChecks } });
      return;
    }
    if (url.pathname === "/api/shadow/report") {
      const { atIso, summary } = pageData();
      sendJson(res, 200, {
        ok: true,
        at: atIso,
        period: { recordedSince: summary.counterfactuals.recordedSince, renderedAt: atIso },
        rules: {
          capMode: CAP_MODE,
          settlement:
            CAP_MODE === "plain"
              ? "the collar runs to expiry: the exit is clamped at the floor and the cap; gains above the cap are handed back (they paid for the floor); the full credit is the holder's; a touch on the path closes nothing and is recorded with what a release would have cost; the writer is flat leg for leg and keeps the take"
              : "a cap touch on the path ends the cycle: the credit vested to the touch is paid, the short cap leg is bought back at the money at the writer's cost",
          capLadder: CAP_LADDER_RULE,
          capGuard: CAP_GUARD,
          capRule: capRuleText(CAP_RULE),
          venueReference: VENUE_REF
            ? "the same two legs read at Deribit and Bullish the second OKX quoted them (buy the floor at the ask, sell the cap at the bid, same strikes, same expiry); positive = that venue would have paid the holder more; a reference for FalconX RFQ acceptance, not a price we quote"
            : "off (PERP_SHADOW_VENUE_REF=0)",
          fundingRule: "informational: how often the credit fails to clear what holding the perp costs over the cycle at the funding rate seen at open; the live product does not refuse on it (funding is the perp's cost, paid with or without protection)",
          flow: FLOW.enabled ? describeFlow(FLOW) : "off: one long and one short at a fixed size every scan",
          book: "after every batch the open book is netted by exact instrument (same strike, expiry, type): gross legs vs net legs, OKX taker fees gross vs net, OKX simple short-option margin gross vs net, book-walk slippage of hedging each wrap alone vs one order per instrument at that snapshot's depth. Exact-instrument netting only, so the savings are lower bounds; portfolio margin across strikes would be lower still",
          earlyCloses: "a scheduled share of wraps closes before expiry at LIVE prices: the perp at the Hyperliquid mark, the collar unwound at the OKX book crossing the spread (immediate) and at mids (passive); passive minus immediate is the execution edge the unwind queue works for; legs with no live book are recorded unpriced, never guessed",
          feeRules: Object.fromEntries(Object.keys(summary.counterfactuals.feeRules).map((l) => [l, feeRuleText(l)])),
        },
        counterfactuals: summary.counterfactuals,
      });
      return;
    }
    if (url.pathname === "/report") {
      const { atIso, summary } = pageData();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderPerpShadowReportHtml({ atIso, summary, token: url.searchParams.get("token"), capGuard: CAP_GUARD, tenor: TENOR, capLadderRule: CAP_LADDER_RULE, capRule: capRuleText(CAP_RULE) }));
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const { atIso, positions, summary } = pageData();
      const settled = positions.filter((p) => p.status === "settled").sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""));
      const open = positions.filter((p) => p.status === "open").sort((a, b) => a.expiryIso.localeCompare(b.expiryIso) || a.at.localeCompare(b.at));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      const closed = positions.filter((p) => p.status === "closed").sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
      res.end(
        renderPerpShadowHtml({
          atIso,
          summary,
          open,
          settled,
          closed,
          sizeBtc: CONTRACTS * OKX_LOT_BTC,
          tenor: TENOR,
          flow: FLOW.enabled ? describeFlow(FLOW) : null,
          capLadder: publicCapLadder(summary.counterfactuals),
          fridays: fridayReview(positions, FRIDAY_CFG),
          feeShare: feeShare(summary),
          fridayConfig: FRIDAY_CFG,
          capOdds: { adaptApplied: CAP_ODDS_ADAPT, latest: lastCapOdds },
          alarms: activeAlarms,
        }),
      );
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) });
  }
});

function main(): void {
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[perp-shadow] listening on :${PORT} · ledger ${LEDGER_PATH} · ${FLOW.enabled ? `flow: ${describeFlow(FLOW)}` : `${CONTRACTS} lots ${SIDES.join("+")}`} · floor ${GEOMETRY.floorPct} · cap guard ${CAP_GUARD.minCapPct}–${CAP_GUARD.maxCapPct} · ${TENOR} · scan every ${Math.round(SCAN_MS / 60_000)}m · settle every ${Math.round(SETTLE_MS / 60_000)}m`,
    );
    void scanTick();
    void settleTick();
    void driftTick().then(() => opsTick());
    setInterval(() => void scanTick(), SCAN_MS);
    setInterval(() => void settleTick(), SETTLE_MS);
    setInterval(() => opsTick(), OPS_MS);
    setInterval(() => void driftTick(), DRIFT_MS);
  });
}

if (process.env.NODE_ENV !== "test") main();

export { server, scanTick, settleTick, opsTick, driftTick, postFridayReviews };
