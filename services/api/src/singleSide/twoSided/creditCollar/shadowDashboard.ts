/**
 * Shadow dashboard — Phase A (read-only). A tiny status page + JSON API for the Tier-0 shadow:
 * shows the aggregate scorecard (track record) AND that shadow is RUNNING (liveness heartbeat).
 * Pure render + framework-agnostic request handler (zero deps); served by the shadow service via
 * node:http. Read-only: no activation, no settlement, no trading.
 */

import { aggregateShadowScorecards, type ShadowRunRecord, type ShadowAggregate, type ShadowAggregateConfig } from "./shadowAggregate";
import type { SettlementAggregate } from "./forwardSettlement";
import type { ShadowLifecycleReport } from "./lifecycleShadow";

/** In-process liveness reported by the running shadow loop. */
export type ShadowLiveStatus = {
  loopActive: boolean;
  intervalMs: number;
  startedAtMs: number;
  cyclesRun: number;
  lastRunAtMs: number | null;
  lastRunOk: boolean | null;
  lastError: string | null;
};

export type DashboardModel = {
  running: boolean;
  liveness: {
    state: "RUNNING" | "STALE" | "DOWN" | "STARTING";
    intervalMs: number;
    cyclesRun: number;
    startedAtIso: string;
    lastRunAtIso: string | null;
    lastRunAgoSec: number | null;
    nextExpectedSec: number | null;
    lastRunOk: boolean | null;
    lastError: string | null;
  };
  aggregate: ShadowAggregate;
  settlement: SettlementAggregate | null;
  lifecycle: ShadowLifecycleReport | null;
  recentSessions: Array<{
    tsIso: string;
    opened: number;
    attempted: number;
    halted: number;
    rejected: number;
    peakExposurePct: number;
    serviceFeeUsdc: number;
    oracleVerified: boolean;
    reconciled: boolean;
    lifecycleComplete: boolean;
  }>;
  generatedAtIso: string;
};

const round1 = (x: number) => +x.toFixed(1);

export const buildDashboardModel = (
  records: ShadowRunRecord[],
  status: ShadowLiveStatus,
  nowMs: number,
  aggCfg: ShadowAggregateConfig = {},
  settlement: SettlementAggregate | null = null,
  lifecycle: ShadowLifecycleReport | null = null
): DashboardModel => {
  const aggregate = aggregateShadowScorecards(records, aggCfg);
  const lastRunAgoMs = status.lastRunAtMs != null ? nowMs - status.lastRunAtMs : null;
  // RUNNING if a cycle happened within 2.5× the interval; STARTING before the first cycle.
  let state: DashboardModel["liveness"]["state"];
  if (!status.loopActive) state = "DOWN";
  else if (status.lastRunAtMs == null) state = "STARTING";
  else if (lastRunAgoMs != null && lastRunAgoMs <= status.intervalMs * 2.5) state = "RUNNING";
  else state = "STALE";
  const running = state === "RUNNING" || state === "STARTING";
  const nextExpectedMs = status.lastRunAtMs != null ? status.lastRunAtMs + status.intervalMs - nowMs : null;

  const recent = [...records]
    .sort((a, b) => b.tsMs - a.tsMs)
    .slice(0, 15)
    .map((r) => ({
      tsIso: new Date(r.tsMs).toISOString(),
      opened: r.scorecard.opened,
      attempted: r.scorecard.attempted,
      halted: r.scorecard.halted,
      rejected: r.scorecard.rejected,
      peakExposurePct: round1(r.scorecard.peakNetExposureRatio * 100),
      serviceFeeUsdc: r.scorecard.serviceFeeAccruedUsdc,
      oracleVerified: r.scorecard.allSettledOracleVerified,
      reconciled: r.scorecard.allReconciled,
      lifecycleComplete: r.scorecard.lifecycleComplete
    }));

  return {
    running,
    liveness: {
      state,
      intervalMs: status.intervalMs,
      cyclesRun: status.cyclesRun,
      startedAtIso: new Date(status.startedAtMs).toISOString(),
      lastRunAtIso: status.lastRunAtMs != null ? new Date(status.lastRunAtMs).toISOString() : null,
      lastRunAgoSec: lastRunAgoMs != null ? Math.round(lastRunAgoMs / 1000) : null,
      nextExpectedSec: nextExpectedMs != null ? Math.round(nextExpectedMs / 1000) : null,
      lastRunOk: status.lastRunOk,
      lastError: status.lastError
    },
    aggregate,
    settlement,
    lifecycle,
    recentSessions: recent,
    generatedAtIso: new Date(nowMs).toISOString()
  };
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const badge = (text: string, color: string) => `<span class="badge" style="background:${color}">${esc(text)}</span>`;

const verdictColor = (v: ShadowAggregate["verdict"]) =>
  v === "TRACK_RECORD_CLEAN" ? "#16794a" : v === "WATCH" ? "#9a6b00" : v === "NO_DATA" ? "#0b5cab" : "#9a1b1b";
const liveColor = (s: DashboardModel["liveness"]["state"]) => (s === "RUNNING" ? "#16794a" : s === "STARTING" ? "#0b5cab" : s === "STALE" ? "#9a6b00" : "#9a1b1b");

export const renderDashboardHtml = (m: DashboardModel): string => {
  const a = m.aggregate;
  const rows = m.recentSessions
    .map(
      (r) => `<tr>
        <td>${esc(r.tsIso.replace("T", " ").replace(".000Z", "Z"))}</td>
        <td>${r.opened}/${r.attempted}</td>
        <td>${r.halted}</td>
        <td>${r.rejected}</td>
        <td>${r.peakExposurePct}%</td>
        <td>$${r.serviceFeeUsdc}</td>
        <td>${r.oracleVerified ? "✓" : "✗"}</td>
        <td>${r.reconciled ? "✓" : "✗"}</td>
        <td>${r.lifecycleComplete ? "✓" : "✗"}</td>
      </tr>`
    )
    .join("");
  const flags = a.flags.length ? `<ul class="flags">${a.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : `<p class="muted">No flags.</p>`;
  const card = (label: string, value: string, sub = "") => `<div class="card"><div class="k">${esc(label)}</div><div class="v">${value}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30"><title>Credit-Collar Shadow</title>
<style>
  body{font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0d1117;color:#e6edf3}
  .wrap{max-width:980px;margin:0 auto;padding:20px}
  h1{font-size:18px;margin:0 0 4px} .sub{color:#8b949e;margin:0 0 16px}
  .badge{display:inline-block;color:#fff;border-radius:999px;padding:3px 10px;font-weight:600;font-size:12px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:14px 0}
  .card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px}
  .card .k{color:#8b949e;font-size:12px} .card .v{font-size:20px;font-weight:700;margin-top:2px} .card .s{color:#8b949e;font-size:12px;margin-top:2px}
  table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #21262d} th{color:#8b949e;font-weight:600}
  .muted{color:#8b949e} .flags{color:#e3b341;margin:6px 0 0 18px} h2{font-size:14px;margin:22px 0 6px;color:#c9d1d9}
  a{color:#58a6ff}
</style></head><body><div class="wrap">
  <h1>Credit-Collar Tier-0 Shadow</h1>
  <p class="sub">Read-only · paper-settled · live tiers OFF · auto-refresh 30s · generated ${esc(m.generatedAtIso)}</p>
  <div>
    ${badge(m.liveness.state, liveColor(m.liveness.state))}
    ${badge("verdict: " + a.verdict.replace(/_/g, " "), verdictColor(a.verdict))}
  </div>
  ${a.verdict === "NO_DATA" ? `<p class="muted" style="margin-top:10px">Warming up — the first shadow cycle runs on boot (~15–20s of live quotes). The scorecard fills once sessions are recorded; this page auto-refreshes.</p>` : ""}
  <div class="grid">
    ${card("Shadow", m.running ? "RUNNING" : m.liveness.state, m.liveness.lastRunAgoSec != null ? `last run ${m.liveness.lastRunAgoSec}s ago` : "no run yet")}
    ${card("Cycles run", String(m.liveness.cyclesRun), m.liveness.nextExpectedSec != null ? `next in ~${Math.max(0, m.liveness.nextExpectedSec)}s` : "")}
    ${card("Sessions", String(a.sessions), "in track record")}
    ${card("Open rate", pct(a.positions.openRate), `${a.positions.opened}/${a.positions.attempted} positions`)}
    ${card("Oracle verified", pct(a.oracle.allVerifiedRate), `healthy ${pct(a.oracle.healthyRate)}`)}
    ${card("Reconciled", pct(a.reconciliation.allReconciledRate), `${a.reconciliation.sessionsWithDrift} w/ drift`)}
    ${card("Lifecycle complete", pct(a.lifecycleCompleteRate), "")}
    ${card("Peak exposure", `${(a.exposure.maxPeakNetExposureRatio * 100).toFixed(1)}%`, `avg ${(a.exposure.avgPeakNetExposureRatio * 100).toFixed(1)}%`)}
    ${card("Floor used", `${(a.floor.avgFloorPctUsed * 100).toFixed(1)}%`, `max ${(a.floor.maxFloorPctUsed * 100).toFixed(1)}% (deeper = calmer regime)`)}
    ${card("Realized fee", `${a.economics.realizedServiceFeeBps} bps`, `$${a.economics.totalServiceFeeUsdc} on $${a.economics.openedNotionalUsdc}`)}
    ${card("Capital-aware net", `${a.capital.capitalAwareNetServiceFeeBps} bps`, `−${a.capital.capitalCostBps} bps IM drag (measured ${(a.capital.shortOptionImFraction * 100).toFixed(1)}%/notional, PM ${a.capital.portfolioMarginNettingFactor})`)}
    ${card("Credit accrued", `$${a.economics.totalCreditAccruedUsdc}`, `net to Foxify $${a.economics.totalNetToFoxifyUsdc}`)}
  </div>
  <h2>Realized settlement economics (forward-settled at real expiry price)</h2>
  ${
    m.settlement && m.settlement.settledPositions > 0
      ? `<div class="grid">
    ${card("Settled", String(m.settlement.settledPositions), `avg held ${m.settlement.avgHeldHours}h`)}
    ${card("Atticus option net (hedged)", `$${m.settlement.totalAtticusOptionNetUsdc}`, `${m.settlement.bookHedgedNetBps} bps — back-to-back hedge receipt nets the Foxify payout ⟹ ~0`)}
    ${card("Book payout (un-hedged view)", `${m.settlement.bookNetPayoutBps} bps`, `$${m.settlement.totalPayoutToFoxifyUsdc} Foxify-facing only — swings at real tenor; not Atticus risk`)}
    ${card("Floor paid", pct(m.settlement.pctFloorBreached), `cap hit ${pct(m.settlement.pctCapBreached)}`)}
    ${card("Realized fee", `$${m.settlement.totalServiceFeeUsdc}`, `${m.settlement.realizedServiceFeeBps} bps gross`)}
    ${card("Option fees (Bullish)", `$${m.settlement.totalOptionFeesUsdc}`, `net after fees+capital $${m.settlement.totalAtticusNetAfterFeesAndCapitalUsdc} (${m.settlement.netAfterFeesAndCapitalBps} bps)`)}
    ${card("Net after capital", `$${m.settlement.totalAtticusNetAfterCapitalUsdc}`, `${m.settlement.capitalAwareNetServiceFeeBps} bps · −$${m.settlement.totalCapitalCostUsdc} IM cost · peak IM $${m.settlement.peakShortLegMarginUsdc}`)}
    ${card("Net to Foxify", `$${m.settlement.totalNetToFoxifyUsdc}`, `credit $${m.settlement.totalCreditAccruedUsdc} + payout`)}
    ${card("Payout range", `$${m.settlement.worstPayoutUsdc} … $${m.settlement.bestPayoutUsdc}`, `avg $${m.settlement.avgPayoutPerPositionUsdc}`)}
  </div>`
      : `<p class="muted">No positions have matured + settled yet (forward settlement at expiry). Real payout economics appear here once the first batch reaches its horizon.</p>`
  }
  ${
    m.lifecycle
      ? `<h2>Cross-venue lifecycle (live overlay)</h2><div class="grid">
    ${card("Basis", `${m.lifecycle.basisBps} bps`, m.lifecycle.basisWithinTolerance ? "within tolerance" : "⚠️ wide — defer settle")}
    ${card("Credit vesting", `${m.lifecycle.vestProgressPct}%`, `$${m.lifecycle.vestedCreditSoFarUsdc} of $${m.lifecycle.fullCreditUsdc} accrued`)}
    ${card("Collateral", `$${m.lifecycle.collateralAvailableUsdc}`, m.lifecycle.collateralHalted ? "⚠️ below buffer — HALT" : "available")}
    ${card("Barrier touches", String(m.lifecycle.barrierTouchesDetected), `gap→reserve $${m.lifecycle.gapToReserveUsdc} · →Foxify $${m.lifecycle.gapToFoxifyUsdc}`)}
  </div>`
      : ""
  }
  <h2>Flags</h2>${flags}
  <h2>Recent sessions</h2>
  <table><thead><tr><th>time</th><th>opened</th><th>halt</th><th>rej</th><th>peakExp</th><th>fee</th><th>oracle</th><th>recon</th><th>lifecycle</th></tr></thead>
  <tbody>${rows || `<tr><td colspan="9" class="muted">No sessions yet.</td></tr>`}</tbody></table>
  <p class="sub" style="margin-top:16px">JSON: <a href="/api/scorecard">/api/scorecard</a> · <a href="/api/health">/api/health</a></p>
</div></body></html>`;
};

// ── Framework-agnostic request handler ────────────────────────────────────────

export type DashboardResponse = { statusCode: number; contentType: string; body: string };

export type DashboardDeps = {
  loadRecords: () => ShadowRunRecord[];
  liveStatus: () => ShadowLiveStatus;
  aggregateConfig?: ShadowAggregateConfig;
  /** Realized-economics aggregate over the settlement ledger (forward settlement). */
  settlementAggregate?: () => SettlementAggregate;
  /** Latest cross-venue lifecycle overlay report (vesting/collateral/basis). */
  lifecycleReport?: () => ShadowLifecycleReport | null;
  /** Optional read-only bearer token. If set, /api/* and / require it. */
  token?: string;
  nowMs?: () => number;
};

export const handleDashboardRequest = (
  req: { method: string; path: string; authorization?: string },
  deps: DashboardDeps
): DashboardResponse => {
  const now = deps.nowMs ? deps.nowMs() : Date.now();
  const path = req.path.split("?")[0];

  if (req.method !== "GET") return { statusCode: 405, contentType: "text/plain", body: "method not allowed" };
  if (path === "/healthz") return { statusCode: 200, contentType: "text/plain", body: "ok" }; // unauthenticated infra check

  if (deps.token) {
    const presented = (req.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (presented !== deps.token) return { statusCode: 401, contentType: "text/plain", body: "unauthorized" };
  }

  const settlement = deps.settlementAggregate ? deps.settlementAggregate() : null;
  const lifecycle = deps.lifecycleReport ? deps.lifecycleReport() : null;
  const model = buildDashboardModel(deps.loadRecords(), deps.liveStatus(), now, deps.aggregateConfig, settlement, lifecycle);

  if (path === "/" || path === "") return { statusCode: 200, contentType: "text/html; charset=utf-8", body: renderDashboardHtml(model) };
  if (path === "/api/scorecard") return { statusCode: 200, contentType: "application/json", body: JSON.stringify(model, null, 2) };
  if (path === "/api/settlements") return { statusCode: 200, contentType: "application/json", body: JSON.stringify(settlement ?? { settledPositions: 0 }, null, 2) };
  if (path === "/api/health") {
    return { statusCode: model.running ? 200 : 503, contentType: "application/json", body: JSON.stringify({ running: model.running, liveness: model.liveness, sessions: model.aggregate.sessions, verdict: model.aggregate.verdict }, null, 2) };
  }
  return { statusCode: 404, contentType: "text/plain", body: "not found" };
};
