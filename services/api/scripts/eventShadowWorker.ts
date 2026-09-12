#!/usr/bin/env tsx
/**
 * EARN & PROTECT — EVENT SHADOW RUN (track-record service)
 *
 * Runs the same protection router as the public demo, continuously, and turns
 * it into an auditable history:
 *   - every SCAN interval, every quotable board row becomes one simulated
 *     position (one per market, ever; first priced quote wins),
 *   - every SETTLE interval, positions whose events have passed are marked
 *     against the official Kalshi result (floor or cap plus credit, versus
 *     the naked payout),
 *   - the append-only JSONL ledger is replayed on every page view; nothing
 *     is ever edited in place.
 *
 * What is real: venue prices, quoted terms, official results.
 * What is simulated: the positions. No venue credentials, no wallets; this
 * service is structurally unable to trade, deposit, or pay.
 *
 * ISOLATION: imports the demo's scanner with EVENT_X_EMBED=1 (no second demo
 * server starts). Nothing here touches the production Earn & Protect deploy.
 *
 * Run: npx tsx services/api/scripts/eventShadowWorker.ts
 * Env: EVENT_SHADOW_PORT (default 8793) · EVENT_SHADOW_LEDGER_PATH
 *      EVENT_SHADOW_SCAN_MS (default 5m) · EVENT_SHADOW_SETTLE_MS (default 10m)
 *      EVENT_SHADOW_SETTLE_GRACE_MS (default 3h) · EVENT_SHADOW_VOID_AFTER_MS (default 72h)
 *      plus the demo's EVENT_X_* scanner knobs (contracts, board rows, series)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  appendShadowRecord,
  loadShadowPositions,
  summarizeShadow,
  type ShadowPosition,
} from "../src/eventCollar/crossVenue/shadowLedger";
import { getMarketResult } from "../src/eventCollar/kalshiPublic";
import { renderShadowHtml } from "./eventShadowHtml";
import type { ScanState } from "./eventProtectXDemoService";

const PORT = Number(process.env.EVENT_SHADOW_PORT || process.env.PORT || 8793);
const LEDGER_PATH = process.env.EVENT_SHADOW_LEDGER_PATH || "/tmp/event-demo/shadow-ledger.jsonl";
const SCAN_MS = Number(process.env.EVENT_SHADOW_SCAN_MS || 5 * 60_000);
const SETTLE_MS = Number(process.env.EVENT_SHADOW_SETTLE_MS || 10 * 60_000);
/** wait this long past the event time before asking for a result (games run long) */
const SETTLE_GRACE_MS = Number(process.env.EVENT_SHADOW_SETTLE_GRACE_MS || 3 * 3_600_000);
/** an event with no official result after this long is voided (postponed, rebooked) */
const VOID_AFTER_MS = Number(process.env.EVENT_SHADOW_VOID_AFTER_MS || 72 * 3_600_000);

let scan: (() => Promise<ScanState>) | null = null;
let lastScanAt: string | null = null;
let lastSettleAt: string | null = null;
let lastScanError: string | null = null;

/** Open one simulated position for every quotable board row we have not seen. */
async function scanTick(): Promise<void> {
  if (!scan) return;
  try {
    const state = await scan();
    const seen = new Set(loadShadowPositions(LEDGER_PATH).map((p) => p.ticker));
    for (const { res, evBps } of state.rows) {
      const q = res.quote;
      if (!q.ok || seen.has(res.market.ticker)) continue;
      appendShadowRecord(LEDGER_PATH, {
        type: "open",
        at: new Date().toISOString(),
        ticker: res.market.ticker,
        kind: res.kind,
        league: res.league,
        sideName: res.sideName,
        eventTitle: res.eventTitle,
        eventTimeIso: res.eventTimeIso,
        contracts: q.contracts,
        markCents: res.markCents,
        floorCents: q.floorCents,
        capCents: q.capCents,
        creditCents: q.creditCents,
        evCostBps: evBps,
        route: res.route ?? "kalshi_self",
        feesCents: q.feesCents,
        takeCents: q.takeCents,
      });
      seen.add(res.market.ticker);
    }
    lastScanAt = new Date().toISOString();
    lastScanError = null;
  } catch (err) {
    // a failed scan skips one tick; the next one retries from scratch
    lastScanError = String(err instanceof Error ? err.message : err);
  }
}

/** Mark past events against their official results; void the unresolvable. */
async function settleTick(): Promise<void> {
  const now = Date.now();
  for (const p of loadShadowPositions(LEDGER_PATH)) {
    if (p.status !== "open") continue;
    const eventMs = Date.parse(p.eventTimeIso);
    if (!Number.isFinite(eventMs) || now < eventMs + SETTLE_GRACE_MS) continue;
    try {
      const r = await getMarketResult(p.ticker);
      if (r.result === "yes" || r.result === "no") {
        appendShadowRecord(LEDGER_PATH, {
          type: "settle",
          at: new Date().toISOString(),
          ticker: p.ticker,
          result: r.result,
        });
      } else if (now > eventMs + VOID_AFTER_MS) {
        appendShadowRecord(LEDGER_PATH, {
          type: "void",
          at: new Date().toISOString(),
          ticker: p.ticker,
          reason: `no official result ${Math.round(VOID_AFTER_MS / 3_600_000)}h after the event`,
        });
      }
    } catch {
      /* venue unreachable for this ticker; retried next tick */
    }
  }
  lastSettleAt = new Date().toISOString();
}

function pageData(): { atIso: string; positions: ShadowPosition[] } {
  return { atIso: new Date().toISOString(), positions: loadShadowPositions(LEDGER_PATH) };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/healthz") {
      sendJson(res, 200, {
        ok: true,
        service: "event-protect-shadow",
        positions: loadShadowPositions(LEDGER_PATH).length,
        lastScanAt,
        lastSettleAt,
        lastScanError,
      });
      return;
    }
    if (url.pathname === "/api/shadow") {
      const { atIso, positions } = pageData();
      const settled = positions
        .filter((p) => p.status === "settled")
        .sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""));
      const open = positions
        .filter((p) => p.status === "open")
        .sort((a, b) => a.eventTimeIso.localeCompare(b.eventTimeIso));
      sendJson(res, 200, { ok: true, at: atIso, summary: summarizeShadow(positions), settled, open });
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const { atIso, positions } = pageData();
      const settled = positions
        .filter((p) => p.status === "settled")
        .sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""));
      const open = positions
        .filter((p) => p.status === "open")
        .sort((a, b) => a.eventTimeIso.localeCompare(b.eventTimeIso));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderShadowHtml({ atIso, summary: summarizeShadow(positions), open, settled }));
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) });
  }
});

async function main(): Promise<void> {
  // Import the scanner WITHOUT starting the demo's server. This must be set
  // before the dynamic import so the module-load listen guard sees it.
  process.env.EVENT_X_EMBED = "1";
  const demo = await import("./eventProtectXDemoService");
  scan = demo.buildScan;
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[event-shadow] listening on :${PORT} · ledger ${LEDGER_PATH} · scan every ${Math.round(SCAN_MS / 60_000)}m · settle every ${Math.round(SETTLE_MS / 60_000)}m`,
    );
    void scanTick();
    void settleTick();
    setInterval(() => void scanTick(), SCAN_MS);
    setInterval(() => void settleTick(), SETTLE_MS);
  });
}

if (process.env.NODE_ENV !== "test") void main();

export { server, scanTick, settleTick };
