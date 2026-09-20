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
 *      PERP_SHADOW_SETTLE_GRACE_MS (default 20m past expiry) · PERP_SHADOW_VOID_AFTER_MS (default 72h)
 *      EP_ADMIN_TOKEN (the demo's admin token) gates /report, /api/shadow/report, /api/shadow/export
 *      and the full CSV; fail-closed when unset.
 */

import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { PerpSide } from "../src/singleSide/twoSided/creditCollar/creditCollarPricer";
import { DEMO_CAP_PCT, DEMO_FLOOR_PCT, parseCapMode } from "../src/singleSide/twoSided/creditCollar/demoWrap";
import { capGuardFor, otherTenor, parseTenor } from "../src/singleSide/twoSided/creditCollar/perpTenor";
import { fetchOkxListedSnapshot } from "../src/singleSide/twoSided/creditCollar/perpShadow/okxListedSnapshot";
import {
  appendPerpShadowRecord,
  loadPerpShadow,
  perpLedgerStats,
  perpPositionsCsv,
  summarizePerpShadow,
  type PerpPath,
  type PerpPathTouch,
  type PerpShadowPosition,
  type PerpShadowSummary,
} from "../src/singleSide/twoSided/creditCollar/perpShadow/perpShadowLedger";
import {
  fetchHlCandles,
  fetchHlContext,
  fetchOkxDeliveryPrice,
  fetchOkxIndex,
  fetchOkxIndexCandlesAround,
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
const VOID_AFTER_MS = Number(process.env.PERP_SHADOW_VOID_AFTER_MS || 72 * 3_600_000);
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

const adminAuth = parseAdminAuthFromEnv(process.env);
const OPERATOR_PATHS = new Set(["/report", "/api/shadow/report", "/api/shadow/export"]);
const BOOT_MS = Date.now();

let lastScanAt: string | null = null;
let lastSettleAt: string | null = null;
let lastScanError: string | null = null;
let lastSettleError: string | null = null;
let consecutiveScanFailures = 0;
let scanning = false;

/** One quote per side from one snapshot; refusals are recorded, never hidden. */
async function scanTick(): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    const nowMs = Date.now();
    const hl = await fetchHlContext(COIN);
    if (!hl) throw new Error(`Hyperliquid returned no ${COIN} context`);
    const okxIndex = await fetchOkxIndex().catch(() => null);
    const snap = await fetchOkxListedSnapshot({ spot: hl.markPx, nowMs });
    if (snap.chain.length === 0) throw new Error("OKX chain has no live in-band options at the next daily expiry");
    const nowIso = new Date(nowMs).toISOString();
    for (const side of SIDES) {
      const rec = perpShadowQuote(
        {
          side,
          spot: hl.markPx,
          contracts: CONTRACTS,
          geometry: GEOMETRY,
          tenor: TENOR,
          capGuard: CAP_GUARD,
          otherTenorCapGuard: OTHER_TENOR_CAP_GUARD,
          take: TAKE,
          counterfactualMinTakeBps: CF_MIN_TAKE_BPS,
          okxIndex,
          fundingBpsPer8h: hl.fundingBpsPer8h,
          nowIso,
          id: `${nowIso.slice(0, 16).replace(/[-:T]/g, "")}-${side}`,
        },
        snap,
      );
      appendPerpShadowRecord(LEDGER_PATH, rec);
    }
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
async function settleTick(deps: { candles?: typeof fetchHlCandles; okxAround?: typeof fetchOkxIndexCandlesAround; delivery?: typeof fetchOkxDeliveryPrice } = {}): Promise<void> {
  try {
    const nowMs = Date.now();
    const { positions } = loadPerpShadow(LEDGER_PATH, REPLAY);
    const due = positions.filter((p) => p.status === "open" && Date.parse(p.expiryIso) + SETTLE_GRACE_MS <= nowMs);
    const byExpiry = new Map<string, PerpShadowPosition[]>();
    for (const p of due) byExpiry.set(p.expiryIso, [...(byExpiry.get(p.expiryIso) ?? []), p]);
    const nowIso = new Date(nowMs).toISOString();
    for (const [expiryIso, group] of byExpiry) {
      const expiryMs = Date.parse(expiryIso);
      const px = await (deps.delivery ?? fetchOkxDeliveryPrice)(expiryMs);
      if (px == null) {
        if (nowMs - expiryMs > VOID_AFTER_MS) {
          for (const p of group) appendPerpShadowRecord(LEDGER_PATH, { type: "void", at: nowIso, id: p.id, reason: "no delivery price published" });
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
        appendPerpShadowRecord(LEDGER_PATH, { type: "settle", at: nowIso, id: p.id, settleCents: Math.round(px * 100), source: "okx_delivery", path });
      }
    }
    lastSettleAt = nowIso;
    if (!lastSettleError?.startsWith("candles:")) lastSettleError = null;
  } catch (err) {
    lastSettleError = String(err instanceof Error ? err.message : err);
  }
}

function pageData(): { atIso: string; positions: PerpShadowPosition[]; summary: PerpShadowSummary } {
  const { positions, refusals } = loadPerpShadow(LEDGER_PATH, REPLAY);
  return { atIso: new Date().toISOString(), positions, summary: summarizePerpShadow(positions, refusals, REPLAY) };
}

function publicSummary(s: PerpShadowSummary): Omit<PerpShadowSummary, "counterfactuals"> & {
  counterfactuals: { recordedSince: string | null; positionsWithCounterfactuals: number };
} {
  const { counterfactuals, ...rest } = s;
  return {
    ...rest,
    counterfactuals: { recordedSince: counterfactuals.recordedSince, positionsWithCounterfactuals: counterfactuals.positionsWithCounterfactuals },
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
    terms: { geometry: GEOMETRY, tenor: TENOR, capMode: CAP_MODE, capGuard: CAP_GUARD, contracts: CONTRACTS, sizeBtc: CONTRACTS * OKX_LOT_BTC, sides: SIDES, take: TAKE, counterfactualMinTakeBps: CF_MIN_TAKE_BPS },
    lastScanAt,
    lastSettleAt,
    lastScanError,
    lastSettleError,
    consecutiveScanFailures,
    operatorViews: adminAuth.enabled,
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
      const strip = (p: PerpShadowPosition) => {
        const { counterfactuals: _cf, ...rest } = p;
        return rest;
      };
      sendJson(res, 200, { ok: true, at: atIso, summary: publicSummary(summary), settled: settled.map(strip), open: open.map(strip) });
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
          fundingRule: "the credit must clear what holding the perp costs over the cycle at the funding rate seen at open",
          feeRules: Object.fromEntries(Object.keys(summary.counterfactuals.feeRules).map((l) => [l, feeRuleText(l)])),
        },
        counterfactuals: summary.counterfactuals,
      });
      return;
    }
    if (url.pathname === "/report") {
      const { atIso, summary } = pageData();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderPerpShadowReportHtml({ atIso, summary, token: url.searchParams.get("token"), capGuard: CAP_GUARD, tenor: TENOR, capLadderRule: CAP_LADDER_RULE }));
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const { atIso, positions, summary } = pageData();
      const settled = positions.filter((p) => p.status === "settled").sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""));
      const open = positions.filter((p) => p.status === "open").sort((a, b) => a.expiryIso.localeCompare(b.expiryIso) || a.at.localeCompare(b.at));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderPerpShadowHtml({ atIso, summary, open, settled, sizeBtc: CONTRACTS * OKX_LOT_BTC, tenor: TENOR }));
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
      `[perp-shadow] listening on :${PORT} · ledger ${LEDGER_PATH} · ${CONTRACTS} lots ${SIDES.join("+")} · floor ${GEOMETRY.floorPct} · cap guard ${CAP_GUARD.minCapPct}–${CAP_GUARD.maxCapPct} · ${TENOR} · scan every ${Math.round(SCAN_MS / 60_000)}m · settle every ${Math.round(SETTLE_MS / 60_000)}m`,
    );
    void scanTick();
    void settleTick();
    setInterval(() => void scanTick(), SCAN_MS);
    setInterval(() => void settleTick(), SETTLE_MS);
  });
}

if (process.env.NODE_ENV !== "test") main();

export { server, scanTick, settleTick };
