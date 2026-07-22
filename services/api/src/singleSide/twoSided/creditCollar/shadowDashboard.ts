/**
 * Shadow dashboard — Phase A (read-only). A tiny status page + JSON API for the Tier-0 shadow:
 * shows the aggregate scorecard (track record) AND that shadow is RUNNING (liveness heartbeat).
 * Pure render + framework-agnostic request handler (zero deps); served by the shadow service via
 * node:http. Read-only: no activation, no settlement, no trading.
 */

import { aggregateShadowScorecards, type ShadowRunRecord, type ShadowAggregate, type ShadowAggregateConfig } from "./shadowAggregate";
import type { SettlementAggregate, OpenPosition, SettlementOutcome } from "./forwardSettlement";
import type { ShadowLifecycleReport } from "./lifecycleShadow";
import type { FoxifyView } from "./foxifyPerpView";
import type { RegimeStats } from "./regimeStats";

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
  foxify: FoxifyView | null;
  regime: RegimeStats | null;
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
  lifecycle: ShadowLifecycleReport | null = null,
  foxify: FoxifyView | null = null,
  regime: RegimeStats | null = null
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
    foxify,
    regime,
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
    ${card("Realized fee", `${a.economics.realizedServiceFeeBps} bps`, a.economics.totalServiceFeeUsdc > 0 ? `$${a.economics.totalServiceFeeUsdc} on $${a.economics.openedNotionalUsdc}` : "Atticus fee negotiated separately — not modeled")}
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
    ${card("Realized fee", `$${m.settlement.totalServiceFeeUsdc}`, m.settlement.totalServiceFeeUsdc > 0 ? `${m.settlement.realizedServiceFeeBps} bps gross` : "Atticus fee negotiated separately — not modeled")}
    ${card("Option fees (Bullish)", `$${m.settlement.totalOptionFeesUsdc}`, `net after fees+capital $${m.settlement.totalAtticusNetAfterFeesAndCapitalUsdc} (${m.settlement.netAfterFeesAndCapitalBps} bps)`)}
    ${card("Net after capital", `$${m.settlement.totalAtticusNetAfterCapitalUsdc}`, `${m.settlement.capitalAwareNetServiceFeeBps} bps · −$${m.settlement.totalCapitalCostUsdc} IM cost · peak IM $${m.settlement.peakShortLegMarginUsdc}`)}
    ${card("Net to Foxify", `$${m.settlement.totalNetToFoxifyUsdc}`, `credit $${m.settlement.totalCreditAccruedUsdc} + payout`)}
    ${card("Payout range", `$${m.settlement.worstPayoutUsdc} … $${m.settlement.bestPayoutUsdc}`, `avg $${m.settlement.avgPayoutPerPositionUsdc}`)}
  </div>`
      : `<p class="muted">No positions have matured + settled yet (forward settlement at expiry). Real payout economics appear here once the first batch reaches its horizon.</p>`
  }
  ${
    m.foxify && m.foxify.settledPositions > 0
      ? `<h2>Foxify view — matched perps + credit (modelled; live = partner-venue feed)</h2><div class="grid">
    ${card("Net perp P&L (flatness)", `$${m.foxify.netPerpPnlUsdc}`, `${m.foxify.netPerpPnlBps} bps — matched long/short net ⟹ ~0 (gross moved $${m.foxify.grossPerpPnlUsdc})`)}
    ${card("Net funding carry", `$${m.foxify.netFundingUsdc}`, `assumed perp funding spread across venues (0 unless venue rates set)`)}
    ${m.foxify.totalAssumedFeesUsdc > 0
      ? card("Credit covers fees?", m.foxify.creditCoversFees ? `YES (${m.foxify.creditCoverageRatio}×)` : `NO (${m.foxify.creditCoverageRatio}×)`, `credit $${m.foxify.totalCreditUsdc} vs modeled fees $${m.foxify.totalAssumedFeesUsdc} (?fee=${m.foxify.assumedPerpFeeUsdc})`)
      : card("Credit vs fees", "no fee assumed", `credit $${m.foxify.totalCreditUsdc} · awaiting the real per-trade cost — add ?fee=25 to model`)}
    ${card("Foxify all-in net", `$${m.foxify.foxifyAllInNetUsdc}`, `${m.foxify.foxifyAllInNetBps} bps — perps + funding + collar + credit − fees`)}
  </div>
  <p class="muted" style="margin:2px 0 0">Perp book by venue: ${m.foxify.venues.map((v) => `${esc(v.venue)} ${v.positions} (P&L $${v.perpPnlUsdc}, funding $${v.fundingUsdc})`).join(" · ")}</p>
  <table><thead><tr><th>recent (settle)</th><th>side</th><th>venue</th><th>entry → settle</th><th>move</th><th>perp P&L</th><th>funding</th><th>collar</th><th>credit</th><th>net</th></tr></thead><tbody>${
          m.foxify.recentPairs
            .flatMap((p) => [p.long, p.short].map((r) => ({ r, matched: p.matched })))
            .filter((x): x is { r: NonNullable<typeof x.r>; matched: boolean } => x.r != null)
            .map(
              ({ r: row, matched }) =>
                `<tr><td>${esc(row.settleIso.replace("T", " ").slice(0, 16))}</td><td>${row.side}${matched ? "" : " · SINGLE (directional)"}</td><td>${esc(row.venue)}</td><td>$${row.entryPriceUsd.toFixed(0)} → $${row.settlePriceUsd.toFixed(0)}</td><td>${(row.movePct * 100).toFixed(2)}%</td><td>$${row.perpPnlUsdc}</td><td>$${row.fundingUsdc}</td><td>$${row.collarPayoutUsdc}</td><td>$${row.creditUsdc}</td><td>$${row.foxifyNetUsdc}</td></tr>`
            )
            .join("") || `<tr><td colspan="10" class="muted">No matured pairs yet.</td></tr>`
        }</tbody></table>`
      : ""
  }
  ${
    m.regime && m.regime.days > 0
      ? `<h2>Regime & realized vol — is the credit clearing the bleed? (staggered daily P&L)</h2><div class="grid">
    ${card("Realized vol", `${m.regime.realizedDailyVolPct}%/day`, `${m.regime.realizedAnnualVolPct}% annualized (caps priced ~50%) · avg |move| ${(m.regime.avgAbsMovePct * 100).toFixed(2)}%`)}
    ${card(`Credit clears bleed? ${m.regime.creditClearsBleed ? "YES" : "NO"}`, money(m.regime.cumulativeNetUsdc), m.regime.cumulativeFeesUsdc > 0 ? `net = credit ${money(m.regime.cumulativeCreditUsdc)} + collar ${money(m.regime.cumulativeCollarUsdc)} − modeled fees ${money(m.regime.cumulativeFeesUsdc)}` : `net = credit ${money(m.regime.cumulativeCreditUsdc)} + collar ${money(m.regime.cumulativeCollarUsdc)} · no fee assumed (?fee=25 to model)`)}
    ${card("Avg day (Foxify net)", money(m.regime.avgDayNetUsdc), `${pct(m.regime.pctDaysPositive)} of days positive · ${m.regime.days} days`)}
    ${card("Day spread (smoothing)", `±${money(m.regime.dayNetStdUsdc)}`, `best ${money(m.regime.bestDayNetUsdc)} · worst ${money(m.regime.worstDayNetUsdc)} — staggering shrinks this`)}
    ${m.regime.gate ? card(`Regime gate: ${m.regime.gate.regime.toUpperCase()}`, m.regime.gate.regime === "calm" ? "open normally" : m.regime.gate.regime === "elevated" ? (m.regime.gate.openMultiplier === 0 ? "PAUSE (calm-only policy)" : `throttle ×${m.regime.gate.openMultiplier} + wider cap`) : "PAUSE opens", m.regime.gate.reason) : ""}
    ${m.regime.signal ? card("Signal hit-rate (day-level)", `${(m.regime.signal.dayHitRate * 100).toFixed(0)}% over ${m.regime.signal.days}d`, `P(edge>BE ${(m.regime.signal.breakevenUsed * 100).toFixed(0)}%) = ${(m.regime.signal.pAboveBreakeven * 100).toFixed(0)}% · 95% CI ${(m.regime.signal.ci95[0] * 100).toFixed(0)}–${(m.regime.signal.ci95[1] * 100).toFixed(0)}% — measures, not validates (~600d to separate 55% from BE)`) : ""}
  </div>
  <table><thead><tr><th>day</th><th>positions</th><th>realized vol</th><th>avg move</th><th>credit</th><th>collar</th><th>Foxify net</th></tr></thead><tbody>${
          m.regime.recentDays
            .map(
              (d) =>
                `<tr><td>${esc(d.dayIso)}</td><td>${d.positions}</td><td>${d.realizedVolPct}%</td><td>${(d.avgMovePct * 100).toFixed(2)}%</td><td>${money(d.creditUsdc)}</td><td>${money(d.collarUsdc)}</td><td>${money(d.netUsdc)}</td></tr>`
            )
            .join("") || `<tr><td colspan="7" class="muted">No settled days yet.</td></tr>`
        }</tbody></table>`
      : ""
  }
  ${
    m.lifecycle
      ? `<h2>Cross-venue lifecycle (live overlay)</h2><div class="grid">
    ${card("Basis", `${m.lifecycle.basisBps} bps`, m.lifecycle.basisWithinTolerance ? "within tolerance" : "⚠️ wide — defer settle")}
    ${card("Credit vesting", `${m.lifecycle.vestProgressPct}%`, `$${m.lifecycle.vestedCreditSoFarUsdc} of $${m.lifecycle.fullCreditUsdc} accrued`)}
    ${card("Collateral", `$${m.lifecycle.collateralAvailableUsdc}`, m.lifecycle.collateralHalted ? "⚠️ below buffer — HALT" : "available")}
    ${card("Barrier touches", String(m.lifecycle.barrierTouchesDetected), `gap→reserve $${m.lifecycle.gapToReserveUsdc} · →Foxify $${m.lifecycle.gapToFoxifyUsdc}`)}
    ${m.lifecycle.lockWatcher ? card("Lock watcher", m.lifecycle.lockWatcher.touchesEvaluated === 0 ? "armed" : `${m.lifecycle.lockWatcher.locksPermitted} lock / ${m.lifecycle.lockWatcher.locksDeferred} defer`, m.lifecycle.lockWatcher.touchesEvaluated === 0 ? "no touches this cycle — early unwind permits only when leg buyback ≤ unvested credit" : m.lifecycle.lockWatcher.decisions.map((d) => `${d.ref.slice(-6)} ${d.barrier}: cost $${d.unwindCostUsdc} vs unvested $${d.unvestedCreditUsdc} → ${d.permitted ? "LOCK" : d.lockEtaMs != null ? `defer ~${(d.lockEtaMs / 3_600_000).toFixed(1)}h` : "ride to expiry"}`).join(" · ")) : ""}
  </div>`
      : ""
  }
  <h2>Flags</h2>${flags}
  <h2>Recent sessions</h2>
  <table><thead><tr><th>time</th><th>opened</th><th>halt</th><th>rej</th><th>peakExp</th><th>fee</th><th>oracle</th><th>recon</th><th>lifecycle</th></tr></thead>
  <tbody>${rows || `<tr><td colspan="9" class="muted">No sessions yet.</td></tr>`}</tbody></table>
  <p class="sub" style="margin-top:16px"><a href="/simple">◱ Simple view</a> · <a href="/positions">◲ Positions</a> · JSON: <a href="/api/scorecard">/api/scorecard</a> · <a href="/api/health">/api/health</a></p>
</div></body></html>`;
};

// ── Simple view ───────────────────────────────────────────────────────────────
// A plain-English P&L + execution readout: who collects, who forfeits, who pays,
// and the proof Atticus is flat. Built entirely from the same model as the advanced page.

const money = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export const renderSimpleHtml = (m: DashboardModel): string => {
  const s = m.settlement;
  const f = m.foxify;
  const card = (label: string, value: string, sub = "", tone = "") =>
    `<div class="card"><div class="k">${esc(label)}</div><div class="v"${tone ? ` style="color:${tone}"` : ""}>${value}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</div>`;

  const body =
    !s || s.settledPositions === 0
      ? `<p class="muted">No positions have settled yet. Real per-trade P&L appears here once the first 24h batch matures.</p>`
      : (() => {
          const n = s.settledPositions;
          const per = (x: number) => `$${(x / n).toFixed(0)}/trade`;
          // Foxify side
          const creditTotal = s.totalCreditAccruedUsdc;
          const collarNet = s.totalPayoutToFoxifyUsdc; // − = Foxify gave back capped upside (net of floor received)
          const foxNet = f ? f.foxifyAllInNetUsdc : s.totalNetToFoxifyUsdc;
          const foxNetBps = f ? f.foxifyAllInNetBps : null;
          // Atticus side
          const atticusKeep = s.totalAtticusNetAfterFeesAndCapitalUsdc;
          const venueFees = s.totalOptionFeesUsdc;
          const paysOut = s.totalPayoutToFoxifyUsdc; // what the collar owes/returns
          const hedgeBack = s.totalHedgeReceiptUsdc; // the identical hedge leg
          const fees = f ? f.totalAssumedFeesUsdc : 0;
          const feeAssumed = fees > 0;
          const perp = f ? f.netPerpPnlUsdc : 0;
          const reconcile = feeAssumed
            ? `Foxify keeps = credit ${money(creditTotal)} ${collarNet < 0 ? "−" : "+"} collar ${money(Math.abs(collarNet))} − perp fees ${money(fees)} ${perp < 0 ? "−" : "+"} perps ${money(Math.abs(perp))} = ${money(foxNet)}`
            : `Foxify keeps = credit ${money(creditTotal)} ${collarNet < 0 ? "−" : "+"} collar ${money(Math.abs(collarNet))} ${perp < 0 ? "−" : "+"} perps ${money(Math.abs(perp))} = ${money(foxNet)} · no fee assumed — add ?fee=25 to model one`;
          return `
  <h2>Foxify — what they collect, forfeit, pay, and keep${feeAssumed ? ` (modeled fee $${f!.assumedPerpFeeUsdc}/trade)` : ""}</h2>
  <div class="grid">
    ${card("Foxify COLLECTS — credit", money(creditTotal), `${per(creditTotal)} · paid to Foxify`, "#16794a")}
    ${card("Foxify FORFEITS / receives — collar", money(collarNet), collarNet < 0 ? `${per(collarNet)} · capped upside given back on moves` : `${per(collarNet)} · floor protection received`, collarNet < 0 ? "#9a6b00" : "#16794a")}
    ${feeAssumed
      ? card("Foxify PAYS — perp fees", money(-fees), `${per(-fees)} · modeled at $${f!.assumedPerpFeeUsdc}/trade (?fee=${f!.assumedPerpFeeUsdc})`, "#9a6b00")
      : card("Foxify PAYS — perp fees", "not modeled", "awaiting Foxify's real number · add ?fee=25 to the URL to preview")}
    ${card("Foxify KEEPS — all-in net", money(foxNet), `${foxNetBps != null ? foxNetBps + " bps · " : ""}= credit − forfeits ${feeAssumed ? "− fees " : ""}+ perps`, foxNet >= 0 ? "#16794a" : "#9a1b1b")}
    ${card("Foxify perps", f ? money(perp) : "—", "matched long/short ⟹ ~flat (no directional bet)")}
  </div>
  <p class="muted" style="margin:2px 0 0">${esc(reconcile)}</p>
  <h2>Atticus — what it pays, passes through, and keeps</h2>
  <div class="grid">
    ${card("Atticus collar net", money(atticusKeep), `${s.netAfterFeesAndCapitalBps} bps · should be ~0 (flat by design) · Atticus's fee is negotiated separately on volume, NOT modeled here`, Math.abs(atticusKeep) < 1000 ? "#16794a" : "#9a6b00")}
    ${card("Atticus PAYS — venue option fees", money(venueFees), `${per(venueFees)} · funded by the collar, not Atticus's pocket`)}
    ${card("Atticus PASSES THROUGH — collar", `${money(paysOut)} ⟷ ${money(hedgeBack)}`, "collar owed ⟷ identical hedge pays it back")}
    ${card("Atticus FLAT?", s.bookHedgedNetBps === 0 ? "YES — 0 bps" : `${s.bookHedgedNetBps} bps`, "hedge nets the collar payout to zero ⟹ no market risk", s.bookHedgedNetBps === 0 ? "#16794a" : "#9a1b1b")}
  </div>
  <h2>Context</h2>
  <div class="grid">
    ${card("Settled trades", String(n), `avg held ${s.avgHeldHours}h`)}
    ${card("Cap hit", `${(s.pctCapBreached * 100).toFixed(1)}%`, "how often price passed the cap (Foxify forfeits upside)")}
    ${card("Floor hit", `${(s.pctFloorBreached * 100).toFixed(1)}%`, "how often price passed the floor (Foxify gets protection)")}
    ${card("Credit vs fees", f && f.totalAssumedFeesUsdc > 0 ? `${f.creditCoverageRatio}×` : "n/a", f && f.totalAssumedFeesUsdc > 0 ? `credit ${money(f.totalCreditUsdc)} vs modeled fees ${money(f.totalAssumedFeesUsdc)}` : "no fee assumed — ?fee=25 to model")}
    ${m.regime && m.regime.days > 0 ? card("Realized vol · clears bleed?", `${m.regime.realizedDailyVolPct}%/day · ${m.regime.creditClearsBleed ? "CLEARS" : "BLEEDS"}`, `cumulative net ${money(m.regime.cumulativeNetUsdc)} · ${(m.regime.pctDaysPositive * 100).toFixed(0)}% of days positive`, m.regime.creditClearsBleed ? "#16794a" : "#9a1b1b") : ""}
  </div>
  <div class="card" style="margin-top:14px">
    <div class="k">How to read this</div>
    <div class="s" style="font-size:13px;line-height:1.6">
      • <b>Foxify math (3 parts):</b> keeps = credit collected − collar forfeited − perp fees. All three matter — the fees are the line people forget.<br>
      • <b>Regime:</b> in calm tape the caps rarely breach, so forfeits are small and Foxify nets positive; in a sustained trend the caps breach often and the forfeits can exceed the net credit — that's a short-volatility trade, not free money.<br>
      • <b>Atticus</b> takes no market risk: whatever the collar owes, the identical hedge pays back (net $0). Atticus's fee is negotiated separately on volume and deliberately NOT modeled in these economics.
    </div>
  </div>`;
        })();

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30"><title>Credit-Collar Shadow — Simple</title>
<style>
  body{font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0d1117;color:#e6edf3}
  .wrap{max-width:980px;margin:0 auto;padding:20px}
  h1{font-size:18px;margin:0 0 4px} .sub{color:#8b949e;margin:0 0 16px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:10px 0}
  .card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px}
  .card .k{color:#8b949e;font-size:12px} .card .v{font-size:22px;font-weight:700;margin-top:2px} .card .s{color:#8b949e;font-size:12px;margin-top:2px}
  .muted{color:#8b949e} h2{font-size:14px;margin:22px 0 6px;color:#c9d1d9} a{color:#58a6ff} b{color:#e6edf3}
</style></head><body><div class="wrap">
  <h1>Credit-Collar Shadow — Simple P&L</h1>
  <p class="sub">Plain-English money flow · paper-settled · generated ${esc(m.generatedAtIso)}</p>
  <p class="sub"><a href="/">◲ Advanced view</a> · <a href="/positions">Positions</a> · JSON: <a href="/api/scorecard">/api/scorecard</a></p>
  ${body}
</div></body></html>`;
};

// ── Positions view ────────────────────────────────────────────────────────────
// Position-by-position breakout in plain words: entry, ceiling (cap), floor, what we SOLD the cap for,
// what we PAID for the floor, the net credit, the synthetic perp detail, and at settlement the result
// line (credit − forfeit − fee). The walkthrough page for G-20 / Foxify conversations.

export const renderPositionsHtml = (open: OpenPosition[], settled: SettlementOutcome[], nowMs: number, maxSettled = 20): string => {
  const pctOf = (strike: number, entry: number) => `${(((strike - entry) / entry) * 100).toFixed(1)}%`;
  const m$ = (x: number | undefined) => (x == null ? "—" : `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
  const dt = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";

  const openRows = open
    .sort((a, b) => b.openedAtMs - a.openedAtMs)
    .map((p) => {
      const capStrike = p.side === "long" ? p.callStrike : p.putStrike;
      const floorStrike = p.side === "long" ? p.putStrike : p.callStrike;
      const hrsLeft = Math.max(0, (p.expiresAtMs - nowMs) / 3_600_000).toFixed(1);
      return `<tr>
        <td>${esc(p.ref.slice(-8))}</td><td>${p.side.toUpperCase()} (perp: ${esc(p.venue ?? "synthetic")})</td>
        <td>$${p.spotAtEntry.toLocaleString("en-US", { maximumFractionDigits: 0 })}<br><span class="muted">${dt(p.openedAtMs)}</span></td>
        <td>$${capStrike.toLocaleString("en-US", { maximumFractionDigits: 0 })} <span class="muted">(${pctOf(capStrike, p.spotAtEntry)})</span></td>
        <td>$${floorStrike.toLocaleString("en-US", { maximumFractionDigits: 0 })} <span class="muted">(${pctOf(floorStrike, p.spotAtEntry)})</span></td>
        <td>${m$(p.fundingLegPremiumUsdc)}</td><td>${m$(p.protectiveLegPremiumUsdc)}</td>
        <td>${m$(p.openFeeUsdc)}</td>
        <td><b>${m$(p.foxifyCreditUsdc)}</b>${p.quoteMeta ? `<br><span class="muted">quoted ${m$(p.quoteMeta.quotedNetUsdc)} vs model ${m$(p.quoteMeta.modelNetUsdc)}</span>` : ""}</td>
        <td>${hrsLeft}h left</td>
      </tr>`;
    })
    .join("");

  const settledRows = [...settled]
    .sort((a, b) => b.settledAtMs - a.settledAtMs)
    .slice(0, maxSettled)
    .map((o) => {
      const breach = o.capBreached ? "CAP hit (gave back)" : o.floorBreached ? "FLOOR hit (protected)" : "no breach";
      const result = o.foxifyCreditUsdc + o.payoutToFoxifyUsdc;
      return `<tr>
        <td>${esc(o.ref.slice(-8))}</td><td>${o.side.toUpperCase()} (${esc(o.venue ?? "synthetic")})</td>
        <td>$${o.spotAtEntry.toLocaleString("en-US", { maximumFractionDigits: 0 })} → $${o.settlePriceUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}<br><span class="muted">${(o.movePct * 100).toFixed(2)}% · ${(o.heldMs / 3_600_000).toFixed(1)}h</span></td>
        <td>${m$(o.fundingLegPremiumUsdc)}</td><td>${m$(o.protectiveLegPremiumUsdc)}</td>
        <td>${m$(o.optionFeesUsdc)}</td>
        <td>${m$(o.foxifyCreditUsdc)}</td>
        <td>${esc(breach)}</td>
        <td>${m$(o.payoutToFoxifyUsdc)}</td>
        <td><b>${m$(result)}</b><br><span class="muted">credit ${o.payoutToFoxifyUsdc < 0 ? "−" : "+"} collar</span></td>
      </tr>`;
    })
    .join("");

  const totCredit = settled.reduce((s, o) => s + o.foxifyCreditUsdc, 0);
  const totCollar = settled.reduce((s, o) => s + o.payoutToFoxifyUsdc, 0);
  const capHits = settled.filter((o) => o.capBreached).length;
  const floorHits = settled.filter((o) => o.floorBreached).length;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30"><title>Positions</title>
<style>
  body{font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0d1117;color:#e6edf3}
  .wrap{max-width:1180px;margin:0 auto;padding:20px}
  h1{font-size:18px;margin:0 0 4px} .sub{color:#8b949e;margin:0 0 14px} h2{font-size:14px;margin:20px 0 6px;color:#c9d1d9}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #21262d;vertical-align:top} th{color:#8b949e;font-weight:600}
  .muted{color:#8b949e;font-size:12px} b{color:#e6edf3} a{color:#58a6ff}
  .strip{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:10px 14px;margin:10px 0;font-size:13px}
</style></head><body><div class="wrap">
  <h1>Positions — plain-words breakout</h1>
  <p class="sub"><a href="/">Advanced</a> · <a href="/simple">Simple P&L</a> · generated ${esc(new Date(nowMs).toISOString())}</p>
  <div class="strip"><b>Running results (${settled.length} settled):</b> credits collected ${m$(totCredit)} · collar net (givebacks/protection) ${m$(totCollar)} · cap hit ${capHits}× · floor hit ${floorHits}× · <b>net ${m$(totCredit + totCollar)}</b> before perp fees</div>
  <h2>Open positions (${open.length})</h2>
  <table><thead><tr><th>ref</th><th>side (perp)</th><th>entry @ opened</th><th>ceiling (cap)</th><th>floor (protection)</th><th>SOLD cap for</th><th>PAID for floor</th><th>venue fee</th><th>net credit</th><th>expires</th></tr></thead>
  <tbody>${openRows || `<tr><td colspan="10" class="muted">No open positions.</td></tr>`}</tbody></table>
  <h2>Settled (last ${Math.min(maxSettled, settled.length)})</h2>
  <table><thead><tr><th>ref</th><th>side</th><th>entry → settle</th><th>SOLD cap</th><th>PAID floor</th><th>venue fee</th><th>credit</th><th>breach</th><th>collar payout</th><th>result</th></tr></thead>
  <tbody>${settledRows || `<tr><td colspan="10" class="muted">Nothing settled yet.</td></tr>`}</tbody></table>
  <p class="sub" style="margin-top:12px">How to read: <b>net credit = SOLD − PAID − venue fee</b>. The collar SELLS the ceiling (collect premium) and BUYS the floor (pay premium); the hedge venue's trading fee is funded by the collar (never by Atticus, never deducted from the credit afterward). Anything the structure funds above the target passes to Foxify in full. At settlement: no breach ⟹ keep the credit · cap hit ⟹ give back gains above the ceiling (paid from that position's own perp gain) · floor hit ⟹ protection pays losses beyond the floor.</p>
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
  /** Foxify matched-perp + credit view over the settlement ledger. `feeUsdc` = ?fee= override (else env default). */
  foxifyView?: (feeUsdc?: number) => FoxifyView | null;
  /** Regime & realized-vol readout over the settlement ledger. `feeUsdc` = ?fee= override (else env default). */
  regimeStats?: (feeUsdc?: number) => RegimeStats | null;
  /** Open positions + settled outcomes for the plain-words positions view. */
  positions?: () => { open: OpenPosition[]; settled: SettlementOutcome[] };
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
  const [path, queryStr] = req.path.split("?");
  // Ad-hoc fee modeling: ?fee=25 re-renders every fee-dependent number with that per-position perp fee.
  // No fee assumed by default — dashboards show observed money only until the partner's real number lands.
  const feeParam = Number(new URLSearchParams(queryStr ?? "").get("fee"));
  const feeOverride = Number.isFinite(feeParam) && feeParam >= 0 && (queryStr ?? "").includes("fee=") ? feeParam : undefined;

  if (req.method !== "GET") return { statusCode: 405, contentType: "text/plain", body: "method not allowed" };
  if (path === "/healthz") return { statusCode: 200, contentType: "text/plain", body: "ok" }; // unauthenticated infra check

  if (deps.token) {
    const presented = (req.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (presented !== deps.token) return { statusCode: 401, contentType: "text/plain", body: "unauthorized" };
  }

  const settlement = deps.settlementAggregate ? deps.settlementAggregate() : null;
  const lifecycle = deps.lifecycleReport ? deps.lifecycleReport() : null;
  const foxify = deps.foxifyView ? deps.foxifyView(feeOverride) : null;
  const regime = deps.regimeStats ? deps.regimeStats(feeOverride) : null;
  const model = buildDashboardModel(deps.loadRecords(), deps.liveStatus(), now, deps.aggregateConfig, settlement, lifecycle, foxify, regime);

  if (path === "/" || path === "") return { statusCode: 200, contentType: "text/html; charset=utf-8", body: renderDashboardHtml(model) };
  if (path === "/simple") return { statusCode: 200, contentType: "text/html; charset=utf-8", body: renderSimpleHtml(model) };
  if (path === "/positions" && deps.positions) {
    const pos = deps.positions();
    return { statusCode: 200, contentType: "text/html; charset=utf-8", body: renderPositionsHtml(pos.open, pos.settled, now) };
  }
  if (path === "/api/positions" && deps.positions) {
    return { statusCode: 200, contentType: "application/json", body: JSON.stringify(deps.positions(), null, 2) };
  }
  if (path === "/api/scorecard") return { statusCode: 200, contentType: "application/json", body: JSON.stringify(model, null, 2) };
  if (path === "/api/settlements") return { statusCode: 200, contentType: "application/json", body: JSON.stringify(settlement ?? { settledPositions: 0 }, null, 2) };
  if (path === "/api/foxify") return { statusCode: 200, contentType: "application/json", body: JSON.stringify(foxify ?? { settledPositions: 0 }, null, 2) };
  if (path === "/api/regime") return { statusCode: 200, contentType: "application/json", body: JSON.stringify(regime ?? { settledPositions: 0 }, null, 2) };
  if (path === "/api/health") {
    return { statusCode: model.running ? 200 : 503, contentType: "application/json", body: JSON.stringify({ running: model.running, liveness: model.liveness, sessions: model.aggregate.sessions, verdict: model.aggregate.verdict }, null, 2) };
  }
  return { statusCode: 404, contentType: "text/plain", body: "not found" };
};
