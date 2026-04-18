/**
 * pilotLiveAnalysisAdmin.ts — Phase 0 of the 1-day-tenor investigation.
 *
 * Read-only analysis of the live pilot platform via its admin HTTP API.
 *
 * No platform code is modified. No platform side effects. The script:
 *   1. Hits the admin endpoints with x-admin-token, persisting raw JSON
 *      snapshots to docs/pilot-reports/raw-pilot-data/<UTC-timestamp>/.
 *   2. Optionally ingests Render log paste-ins from
 *      docs/pilot-reports/raw-logs/*.{log,txt} for hold-decision visibility
 *      (cooling holds, gap-extended holds, sub-threshold holds, no-bid retries,
 *      NEGATIVE_MARGIN events) which are not visible from the DB alone.
 *   3. Writes docs/pilot-reports/live_baseline_analysis.md — the human-
 *      readable Phase 0 deliverable.
 *
 * Required env vars:
 *   PILOT_ADMIN_TOKEN   — admin token (Render secret)
 *   PILOT_API_BASE      — e.g. https://foxify-pilot-new.onrender.com
 *
 * Usage:
 *   npx tsx services/api/scripts/pilotLiveAnalysisAdmin.ts
 *   npx tsx services/api/scripts/pilotLiveAnalysisAdmin.ts --no-write   # dry run
 *   npx tsx services/api/scripts/pilotLiveAnalysisAdmin.ts --logs-dir <path>
 *
 * Exit codes:
 *   0  — success
 *   1  — missing env vars or fetch failure
 *   2  — write failure
 */

import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// ─── Config ─────────────────────────────────────────────────────────────────

type CliArgs = {
  noWrite: boolean;
  logsDir: string;
  outDir: string;
  reportPath: string;
  apiBase: string;
  adminToken: string;
};

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../../..");

const parseArgs = (argv: string[]): CliArgs => {
  const apiBase = process.env.PILOT_API_BASE?.trim() || "";
  const adminToken = process.env.PILOT_ADMIN_TOKEN?.trim() || "";

  const args: CliArgs = {
    noWrite: false,
    logsDir: path.join(REPO_ROOT, "docs/pilot-reports/raw-logs"),
    outDir: path.join(REPO_ROOT, "docs/pilot-reports/raw-pilot-data"),
    reportPath: path.join(REPO_ROOT, "docs/pilot-reports/live_baseline_analysis.md"),
    apiBase,
    adminToken
  };

  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "--no-write") args.noWrite = true;
    else if (tok === "--logs-dir" && argv[i + 1]) { args.logsDir = path.resolve(argv[++i]); }
    else if (tok === "--out-dir" && argv[i + 1]) { args.outDir = path.resolve(argv[++i]); }
    else if (tok === "--report" && argv[i + 1]) { args.reportPath = path.resolve(argv[++i]); }
    else if (tok === "--api-base" && argv[i + 1]) { args.apiBase = argv[++i]; }
  }

  if (!args.apiBase) {
    throw new Error("missing_env:PILOT_API_BASE (e.g. https://foxify-pilot-new.onrender.com)");
  }
  if (!args.adminToken) {
    throw new Error("missing_env:PILOT_ADMIN_TOKEN");
  }
  return args;
};

// ─── HTTP ───────────────────────────────────────────────────────────────────

const adminFetch = async <T = unknown>(args: CliArgs, pathPart: string): Promise<T> => {
  const url = `${args.apiBase.replace(/\/+$/, "")}${pathPart}`;
  const res = await fetch(url, {
    headers: {
      "x-admin-token": args.adminToken,
      "content-type": "application/json"
    }
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!res.ok) {
    throw new Error(`http_${res.status} ${pathPart}: ${json?.reason || json?.message || text.slice(0, 200)}`);
  }
  return json as T;
};

const publicFetch = async <T = unknown>(args: CliArgs, pathPart: string): Promise<T> => {
  const url = `${args.apiBase.replace(/\/+$/, "")}${pathPart}`;
  const res = await fetch(url);
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!res.ok) {
    throw new Error(`http_${res.status} ${pathPart}: ${json?.reason || json?.message || text.slice(0, 200)}`);
  }
  return json as T;
};

// ─── Snapshot fetcher ───────────────────────────────────────────────────────

type Snapshot = {
  timestamp: string;
  health: any;
  monitorStatus: any;
  metricsActive: any;
  metricsAll: any;
  protectionsActive: any;
  protectionsAll: any;
  executionQuality: any;
  fetchErrors: Array<{ endpoint: string; error: string }>;
};

const fetchSnapshot = async (args: CliArgs): Promise<Snapshot> => {
  const ts = new Date().toISOString();
  const snap: Snapshot = {
    timestamp: ts,
    health: null,
    monitorStatus: null,
    metricsActive: null,
    metricsAll: null,
    protectionsActive: null,
    protectionsAll: null,
    executionQuality: null,
    fetchErrors: []
  };

  const tryFetch = async (key: keyof Snapshot, isPublic: boolean, pathPart: string) => {
    try {
      const data = isPublic ? await publicFetch(args, pathPart) : await adminFetch(args, pathPart);
      (snap as any)[key] = data;
    } catch (e: any) {
      snap.fetchErrors.push({ endpoint: pathPart, error: String(e?.message || e) });
    }
  };

  await Promise.all([
    tryFetch("health", true, "/pilot/health"),
    tryFetch("monitorStatus", false, "/pilot/monitor/status"),
    tryFetch("metricsActive", false, "/pilot/admin/metrics?scope=active"),
    tryFetch("metricsAll", false, "/pilot/admin/metrics?scope=all"),
    tryFetch("protectionsActive", false, "/pilot/protections?limit=200"),
    tryFetch("protectionsAll", false, "/pilot/protections/export?scope=all&limit=500&format=json&includeArchived=true"),
    tryFetch("executionQuality", false, "/pilot/admin/diagnostics/execution-quality?lookbackDays=30")
  ]);

  return snap;
};

const persistSnapshot = async (args: CliArgs, snap: Snapshot): Promise<string> => {
  const stamp = snap.timestamp.replace(/[:.]/g, "-");
  const dir = path.join(args.outDir, stamp);
  if (args.noWrite) return dir;
  await mkdir(dir, { recursive: true });
  const writeJson = async (name: string, data: unknown) => {
    await writeFile(path.join(dir, name), JSON.stringify(data, null, 2), "utf8");
  };
  await writeJson("health.json", snap.health);
  await writeJson("monitor-status.json", snap.monitorStatus);
  await writeJson("metrics-active.json", snap.metricsActive);
  await writeJson("metrics-all.json", snap.metricsAll);
  await writeJson("protections-active.json", snap.protectionsActive);
  await writeJson("protections-all.json", snap.protectionsAll);
  await writeJson("execution-quality.json", snap.executionQuality);
  await writeJson("fetch-summary.json", {
    timestamp: snap.timestamp,
    apiBase: args.apiBase,
    fetchErrors: snap.fetchErrors,
    counts: {
      protectionsActive: countList(snap.protectionsActive, "protections"),
      protectionsAllRows: countList(snap.protectionsAll, "rows"),
      executionQualityRecords: countList(snap.executionQuality, "records")
    }
  });
  return dir;
};

const countList = (envelope: any, key: string): number => {
  if (!envelope) return 0;
  const arr = Array.isArray(envelope[key]) ? envelope[key] : null;
  return arr ? arr.length : 0;
};

// ─── Log parser ─────────────────────────────────────────────────────────────

type LogStats = {
  filesIngested: string[];
  totalLines: number;
  uniqueLines: number;
  hedgeManager: {
    sellingByReason: Record<string, number>;
    sellResultByStatus: Record<string, number>;
    coolingHolds: number;
    gapExtendedCoolingHolds: number;
    otherHolds: number;
    cycleCount: number;
    sumScanned: number;
    sumTpSold: number;
    sumSalvaged: number;
    sumExpired: number;
    sumNoBidRetries: number;
    sumErrors: number;
  };
  optionSelection: {
    winners: number;
    negativeMarginWinners: number;
    overPremiumPenalties: number;
    candidatesScored: number;
    triggerStrikeUnavailable: number;
    sampleNegativeMarginWinners: string[];
  };
  triggerMonitor: {
    triggeredEvents: number;
    cycleCount: number;
    sumPriceErrors: number;
    consecutiveErrorWarnings: number;
  };
  autoRenew: {
    renewed: number;
    failed: number;
  };
};

const emptyStats = (): LogStats => ({
  filesIngested: [],
  totalLines: 0,
  uniqueLines: 0,
  hedgeManager: {
    sellingByReason: {},
    sellResultByStatus: {},
    coolingHolds: 0,
    gapExtendedCoolingHolds: 0,
    otherHolds: 0,
    cycleCount: 0,
    sumScanned: 0,
    sumTpSold: 0,
    sumSalvaged: 0,
    sumExpired: 0,
    sumNoBidRetries: 0,
    sumErrors: 0
  },
  optionSelection: {
    winners: 0,
    negativeMarginWinners: 0,
    overPremiumPenalties: 0,
    candidatesScored: 0,
    triggerStrikeUnavailable: 0,
    sampleNegativeMarginWinners: []
  },
  triggerMonitor: {
    triggeredEvents: 0,
    cycleCount: 0,
    sumPriceErrors: 0,
    consecutiveErrorWarnings: 0
  },
  autoRenew: {
    renewed: 0,
    failed: 0
  }
});

const parseInt0 = (v: string | undefined): number => {
  const n = Number(v ?? "0");
  return Number.isFinite(n) ? n : 0;
};

const ingestLogLine = (line: string, stats: LogStats): void => {
  if (line.includes("[HedgeManager]")) {
    let m = line.match(/Selling \(([^)]+)\):/);
    if (m) {
      stats.hedgeManager.sellingByReason[m[1]] = (stats.hedgeManager.sellingByReason[m[1]] || 0) + 1;
      return;
    }
    m = line.match(/Sell result: status=(\w+)/);
    if (m) {
      stats.hedgeManager.sellResultByStatus[m[1]] = (stats.hedgeManager.sellResultByStatus[m[1]] || 0) + 1;
      return;
    }
    if (/cooling_period:/.test(line)) { stats.hedgeManager.coolingHolds += 1; return; }
    if (/gap_extended_cooling:/.test(line)) { stats.hedgeManager.gapExtendedCoolingHolds += 1; return; }
    if (/^\s*\[HedgeManager\]\s+Hold:/.test(line)) { stats.hedgeManager.otherHolds += 1; return; }
    m = line.match(/Cycle complete: scanned=(\d+) tpSold=(\d+) salvaged=(\d+) expired=(\d+) noBid=(\d+) errors=(\d+)/);
    if (m) {
      stats.hedgeManager.cycleCount += 1;
      stats.hedgeManager.sumScanned += parseInt0(m[1]);
      stats.hedgeManager.sumTpSold += parseInt0(m[2]);
      stats.hedgeManager.sumSalvaged += parseInt0(m[3]);
      stats.hedgeManager.sumExpired += parseInt0(m[4]);
      stats.hedgeManager.sumNoBidRetries += parseInt0(m[5]);
      stats.hedgeManager.sumErrors += parseInt0(m[6]);
      return;
    }
  }
  if (line.includes("[OptionSelection]")) {
    if (/WINNER:/.test(line)) {
      stats.optionSelection.winners += 1;
      if (/NEGATIVE_MARGIN/.test(line)) {
        stats.optionSelection.negativeMarginWinners += 1;
        if (stats.optionSelection.sampleNegativeMarginWinners.length < 10) {
          stats.optionSelection.sampleNegativeMarginWinners.push(line.trim());
        }
      }
      return;
    }
    if (/OVER_PREMIUM/.test(line)) { stats.optionSelection.overPremiumPenalties += 1; return; }
    if (/^\s*\[OptionSelection\] score:/.test(line)) { stats.optionSelection.candidatesScored += 1; return; }
    if (/trigger_strike_unavailable/.test(line)) { stats.optionSelection.triggerStrikeUnavailable += 1; return; }
  }
  if (line.includes("[TriggerMonitor]")) {
    if (/TRIGGERED:/.test(line)) { stats.triggerMonitor.triggeredEvents += 1; return; }
    if (/consecutive price errors/.test(line)) { stats.triggerMonitor.consecutiveErrorWarnings += 1; return; }
    const m = line.match(/Cycle: scanned=\d+ triggered=\d+ priceErrors=(\d+)/);
    if (m) {
      stats.triggerMonitor.cycleCount += 1;
      stats.triggerMonitor.sumPriceErrors += parseInt0(m[1]);
      return;
    }
  }
  if (line.includes("[AutoRenew]")) {
    if (/Renewed \S+ → \S+/.test(line)) { stats.autoRenew.renewed += 1; return; }
    if (/FAILED/.test(line)) { stats.autoRenew.failed += 1; return; }
  }
};

const ingestLogsDir = async (logsDir: string): Promise<LogStats> => {
  const stats = emptyStats();
  if (!existsSync(logsDir)) return stats;
  const entries = await readdir(logsDir);
  const seen = new Set<string>();
  for (const name of entries.sort()) {
    if (!name.endsWith(".log") && !name.endsWith(".txt")) continue;
    if (name.toLowerCase() === "readme.md") continue;
    const full = path.join(logsDir, name);
    let body: string;
    try { body = await readFile(full, "utf8"); } catch { continue; }
    stats.filesIngested.push(name);
    for (const raw of body.split(/\r?\n/)) {
      stats.totalLines += 1;
      const line = raw.trim();
      if (!line) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      stats.uniqueLines += 1;
      ingestLogLine(line, stats);
    }
  }
  return stats;
};

// ─── DB-side analytics from snapshot ────────────────────────────────────────

type ProtectionRow = {
  id: string;
  status: string;
  tierName: string | null;
  slPct: number | null;
  hedgeStatus: string | null;
  protectedNotional: string;
  entryPrice: string | null;
  floorPrice: string | null;
  drawdownFloorPct: string;
  expiryAt: string;
  premium: string | null;
  autoRenew: boolean;
  payoutDueAmount: string | null;
  payoutSettledAmount: string | null;
  venue: string | null;
  instrumentId: string | null;
  side: string | null;
  size: string | null;
  executionPrice: string | null;
  createdAt: string;
  metadata?: Record<string, any> | null;
};

const numOrZero = (v: any): number => {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

type DbAnalytics = {
  sampleSize: {
    activeCount: number;
    allCount: number;
    earliestCreated: string | null;
    latestCreated: string | null;
    spanDays: number | null;
  };
  byTier: Record<string, {
    count: number;
    triggered: number;
    expiredOtm: number;
    expiredItm: number;
    activeNow: number;
    failed: number;
    cancelled: number;
    avgPremium: number;
    avgHedgeCost: number;
    avgSpread: number;
    avgMarginPct: number;
    negativeMarginCount: number;
    sumTpRecovery: number;
    tpSoldCount: number;
    avgTpRecoveryWhenSold: number;
    triggerRatePct: number;
    tpRatePct: number;
  }>;
  expirySelection: {
    bucketLessThan1d: number;
    bucket1d: number;
    bucket2d: number;
    bucket3d: number;
    bucketMoreThan3d: number;
    unknown: number;
  };
  strikeVsTrigger: {
    itm: number;       // strike >= trigger for puts (longs)
    otm: number;       // strike <  trigger for puts
    atTrigger: number; // strike == trigger
    unknown: number;
  };
  negativeMarginSamples: Array<{
    id: string;
    tier: string | null;
    premium: number;
    hedgeCost: number;
    spread: number;
    instrumentId: string | null;
  }>;
  hedgeStatusBreakdown: Record<string, number>;
  totals: {
    premiumCollected: number;
    hedgeCost: number;
    spread: number;
    payoutsDue: number;
    payoutsSettled: number;
    tpRecovery: number;
    netPnl: number;
  };
};

const TENOR_DAY_MS = 24 * 3600 * 1000;

const parseInstrumentExpiry = (instrumentId: string | null): number | null => {
  if (!instrumentId) return null;
  const m = String(instrumentId).match(/^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-(P|C)$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthMap: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
  };
  const month = monthMap[m[2]];
  if (month === undefined) return null;
  const year = 2000 + parseInt(m[3], 10);
  // Deribit options expire at 08:00 UTC
  return Date.UTC(year, month, day, 8, 0, 0);
};

const parseInstrumentStrike = (instrumentId: string | null): number | null => {
  if (!instrumentId) return null;
  const m = String(instrumentId).match(/-(\d+)-(P|C)$/);
  return m ? Number(m[1]) : null;
};

const analyseDb = (snap: Snapshot): DbAnalytics => {
  const allRows: ProtectionRow[] = [];
  const allWrap: any = snap.protectionsAll;
  if (allWrap && Array.isArray(allWrap.rows)) {
    for (const r of allWrap.rows) allRows.push(r as ProtectionRow);
  }
  const activeWrap: any = snap.protectionsActive;
  const activeArr: any[] = activeWrap && Array.isArray(activeWrap.protections) ? activeWrap.protections : [];

  // Build a map by id from `all`, fall back to `active`
  const byId = new Map<string, ProtectionRow>();
  for (const r of allRows) byId.set(r.id, r);
  for (const r of activeArr as ProtectionRow[]) {
    if (!byId.has(r.id)) byId.set(r.id, r);
  }
  const merged = Array.from(byId.values());

  // Sample size
  const created = merged.map((r) => Date.parse(String(r.createdAt))).filter((n) => Number.isFinite(n));
  const earliest = created.length ? new Date(Math.min(...created)).toISOString() : null;
  const latest = created.length ? new Date(Math.max(...created)).toISOString() : null;
  const spanDays = created.length ? (Math.max(...created) - Math.min(...created)) / (24 * 3600 * 1000) : null;

  const byTier: DbAnalytics["byTier"] = {};
  const ensureTier = (tier: string) => {
    if (!byTier[tier]) {
      byTier[tier] = {
        count: 0, triggered: 0, expiredOtm: 0, expiredItm: 0, activeNow: 0,
        failed: 0, cancelled: 0,
        avgPremium: 0, avgHedgeCost: 0, avgSpread: 0, avgMarginPct: 0,
        negativeMarginCount: 0, sumTpRecovery: 0, tpSoldCount: 0,
        avgTpRecoveryWhenSold: 0, triggerRatePct: 0, tpRatePct: 0
      };
    }
    return byTier[tier];
  };

  const expirySel = { bucketLessThan1d: 0, bucket1d: 0, bucket2d: 0, bucket3d: 0, bucketMoreThan3d: 0, unknown: 0 };
  const strikeRel = { itm: 0, otm: 0, atTrigger: 0, unknown: 0 };
  const hedgeStatusBreakdown: Record<string, number> = {};
  const negativeMarginSamples: DbAnalytics["negativeMarginSamples"] = [];

  let totalPremium = 0, totalHedge = 0, totalPayoutDue = 0, totalPayoutSettled = 0, totalTp = 0;
  let premiumCount = 0, hedgeCount = 0, spreadCount = 0;
  const sumByTier: Record<string, { premium: number; hedge: number; spread: number; marginPct: number; n: number }> = {};

  for (const r of merged) {
    const tier = r.tierName || (r.slPct ? `SL ${r.slPct}%` : "unknown");
    const ent = ensureTier(tier);
    ent.count += 1;
    if (r.status === "triggered") ent.triggered += 1;
    if (r.status === "expired_otm") ent.expiredOtm += 1;
    if (r.status === "expired_itm") ent.expiredItm += 1;
    if (r.status === "active") ent.activeNow += 1;
    if (r.status === "activation_failed") ent.failed += 1;
    if (r.status === "cancelled") ent.cancelled += 1;

    const hedgeStatus = r.hedgeStatus || "none";
    hedgeStatusBreakdown[hedgeStatus] = (hedgeStatusBreakdown[hedgeStatus] || 0) + 1;

    const premium = numOrZero(r.premium);
    const size = numOrZero(r.size);
    const execPx = numOrZero(r.executionPrice);
    const hedgeCost = size > 0 && execPx > 0 ? size * execPx : 0;
    const payoutDue = numOrZero(r.payoutDueAmount);
    const payoutSettled = numOrZero(r.payoutSettledAmount);

    totalPremium += premium;
    totalHedge += hedgeCost;
    totalPayoutDue += payoutDue;
    totalPayoutSettled += payoutSettled;

    if (premium > 0) premiumCount += 1;
    if (hedgeCost > 0) hedgeCount += 1;

    if (premium > 0 && hedgeCost > 0) {
      const spread = premium - hedgeCost;
      const marginPct = (spread / premium) * 100;
      spreadCount += 1;
      if (!sumByTier[tier]) sumByTier[tier] = { premium: 0, hedge: 0, spread: 0, marginPct: 0, n: 0 };
      sumByTier[tier].premium += premium;
      sumByTier[tier].hedge += hedgeCost;
      sumByTier[tier].spread += spread;
      sumByTier[tier].marginPct += marginPct;
      sumByTier[tier].n += 1;
      if (spread < 0) {
        ent.negativeMarginCount += 1;
        if (negativeMarginSamples.length < 10) {
          negativeMarginSamples.push({
            id: r.id, tier, premium, hedgeCost, spread,
            instrumentId: r.instrumentId
          });
        }
      }
    }

    // TP recovery from metadata.sellResult
    const sellResult = (r.metadata as any)?.sellResult;
    const tpProceeds = sellResult?.totalProceeds ? Number(sellResult.totalProceeds) : 0;
    if (tpProceeds > 0) {
      ent.sumTpRecovery += tpProceeds;
      ent.tpSoldCount += 1;
      totalTp += tpProceeds;
    }

    // Expiry-selection bucketing
    const instExp = parseInstrumentExpiry(r.instrumentId);
    const created = Date.parse(String(r.createdAt));
    if (instExp && Number.isFinite(created)) {
      const days = (instExp - created) / TENOR_DAY_MS;
      if (days < 0.85) expirySel.bucketLessThan1d += 1;
      else if (days < 1.5) expirySel.bucket1d += 1;
      else if (days < 2.5) expirySel.bucket2d += 1;
      else if (days < 3.5) expirySel.bucket3d += 1;
      else expirySel.bucketMoreThan3d += 1;
    } else {
      expirySel.unknown += 1;
    }

    // Strike vs trigger (puts only — longs)
    const strike = parseInstrumentStrike(r.instrumentId);
    const trigger = numOrZero(r.floorPrice);
    if (strike && trigger > 0 && r.instrumentId?.endsWith("-P")) {
      if (strike > trigger * 1.0005) strikeRel.itm += 1;
      else if (strike < trigger * 0.9995) strikeRel.otm += 1;
      else strikeRel.atTrigger += 1;
    } else if (r.instrumentId?.endsWith("-C")) {
      // Calls (shorts) — flip
      if (strike && trigger > 0) {
        if (strike < trigger * 0.9995) strikeRel.itm += 1;
        else if (strike > trigger * 1.0005) strikeRel.otm += 1;
        else strikeRel.atTrigger += 1;
      } else {
        strikeRel.unknown += 1;
      }
    } else {
      strikeRel.unknown += 1;
    }
  }

  for (const tier of Object.keys(byTier)) {
    const ent = byTier[tier];
    const sum = sumByTier[tier];
    if (sum && sum.n > 0) {
      ent.avgPremium = sum.premium / sum.n;
      ent.avgHedgeCost = sum.hedge / sum.n;
      ent.avgSpread = sum.spread / sum.n;
      ent.avgMarginPct = sum.marginPct / sum.n;
    }
    if (ent.tpSoldCount > 0) ent.avgTpRecoveryWhenSold = ent.sumTpRecovery / ent.tpSoldCount;
    if (ent.count > 0) {
      ent.triggerRatePct = (ent.triggered / ent.count) * 100;
      ent.tpRatePct = ent.triggered > 0 ? (ent.tpSoldCount / ent.triggered) * 100 : 0;
    }
  }

  return {
    sampleSize: {
      activeCount: activeArr.length,
      allCount: merged.length,
      earliestCreated: earliest,
      latestCreated: latest,
      spanDays
    },
    byTier,
    expirySelection: expirySel,
    strikeVsTrigger: strikeRel,
    negativeMarginSamples,
    hedgeStatusBreakdown,
    totals: {
      premiumCollected: totalPremium,
      hedgeCost: totalHedge,
      spread: totalPremium - totalHedge,
      payoutsDue: totalPayoutDue,
      payoutsSettled: totalPayoutSettled,
      tpRecovery: totalTp,
      netPnl: totalPremium - totalHedge - totalPayoutDue + totalTp
    }
  };
};

// ─── Report writer ──────────────────────────────────────────────────────────

const fmtUsd = (n: number): string => {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const fmtPct = (n: number): string => {
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}%`;
};
const fmtN = (n: number): string => Number.isFinite(n) ? String(n) : "—";

const renderTierTable = (db: DbAnalytics): string => {
  const tiers = Object.keys(db.byTier).sort();
  const lines: string[] = [];
  lines.push("| Tier | Count | Triggered | Trig Rate | Avg Prem | Avg Hedge | Avg Spread | Avg Margin% | Neg-Margin | TP Sold | TP Rate | Avg TP $ |");
  lines.push("|------|-------|-----------|-----------|----------|-----------|------------|-------------|------------|---------|---------|----------|");
  for (const t of tiers) {
    const e = db.byTier[t];
    lines.push(
      `| ${t} | ${e.count} | ${e.triggered} | ${fmtPct(e.triggerRatePct)} | ${fmtUsd(e.avgPremium)} | ${fmtUsd(e.avgHedgeCost)} | ${fmtUsd(e.avgSpread)} | ${fmtPct(e.avgMarginPct)} | ${e.negativeMarginCount} | ${e.tpSoldCount} | ${fmtPct(e.tpRatePct)} | ${fmtUsd(e.avgTpRecoveryWhenSold)} |`
    );
  }
  return lines.join("\n");
};

const renderReport = (params: {
  snapshotDir: string;
  snap: Snapshot;
  db: DbAnalytics;
  logs: LogStats;
}): string => {
  const { snapshotDir, snap, db, logs } = params;
  const generatedAt = new Date().toISOString();
  const apiHealth = snap.health?.status || "unknown";
  const monitorHealthy = snap.monitorStatus?.healthy ? "ok" : "degraded";
  const consecFails = snap.monitorStatus?.consecutiveFailures ?? "—";
  const errorList = snap.fetchErrors.length
    ? snap.fetchErrors.map((e) => `- \`${e.endpoint}\` — ${e.error}`).join("\n")
    : "_(none)_";

  const logHM = logs.hedgeManager;
  const logOS = logs.optionSelection;
  const logTM = logs.triggerMonitor;
  const logAR = logs.autoRenew;

  const negMarginLines = db.negativeMarginSamples.length
    ? db.negativeMarginSamples.map((s, i) => `${i + 1}. \`${s.id.slice(0, 8)}…\` ${s.tier} — premium ${fmtUsd(s.premium)} hedge ${fmtUsd(s.hedgeCost)} spread ${fmtUsd(s.spread)} instrument \`${s.instrumentId || "—"}\``).join("\n")
    : "_(none observed in this sample)_";

  const sampleNegMarginLogLines = logOS.sampleNegativeMarginWinners.length
    ? logOS.sampleNegativeMarginWinners.map((l) => "    " + l).join("\n")
    : "_(no NEGATIVE_MARGIN log lines found in paste-ins; logs may be missing or no events occurred)_";

  return `# Phase 0 — Live Pilot Baseline Analysis

**Generated:** ${generatedAt}
**API base:** \`${params.snap ? (snap as any)?.health?._base || (process.env.PILOT_API_BASE || "—") : "—"}\`
**Snapshot directory:** \`${path.relative(REPO_ROOT, snapshotDir)}/\`
**Tenor in code:** 1 day across all launched SL tiers (2 / 3 / 5 / 10).

---

## 1. Sample Size & Health

| Field | Value |
|---|---|
| Live API status | \`${apiHealth}\` |
| Monitor healthy | \`${monitorHealthy}\` |
| Consecutive failures | ${consecFails} |
| Active protections (DB) | ${db.sampleSize.activeCount} |
| All protections (DB, incl. archived) | ${db.sampleSize.allCount} |
| Earliest \`createdAt\` | ${db.sampleSize.earliestCreated || "—"} |
| Latest \`createdAt\` | ${db.sampleSize.latestCreated || "—"} |
| Span (days) | ${db.sampleSize.spanDays !== null ? db.sampleSize.spanDays.toFixed(1) : "—"} |

**Fetch errors during snapshot:**
${errorList}

> _Statistical caveat: this report reflects whatever the pilot has accumulated to date on testnet. Findings should be treated as directional, not statistically conclusive, until the live (post-KYC) pilot accumulates ≥ 50 trades._

---

## 2. Per-Tier Outcomes (DB-derived)

${renderTierTable(db)}

**Hedge-status breakdown across all protections:**

${Object.entries(db.hedgeStatusBreakdown).map(([k, v]) => `- \`${k}\`: ${v}`).join("\n") || "_(no records)_"}

**Realized totals across the sample:**

| Item | Amount |
|---|---|
| Premium collected | ${fmtUsd(db.totals.premiumCollected)} |
| Hedge cost | ${fmtUsd(db.totals.hedgeCost)} |
| Spread (premium − hedge) | ${fmtUsd(db.totals.spread)} |
| Payouts due | ${fmtUsd(db.totals.payoutsDue)} |
| Payouts settled | ${fmtUsd(db.totals.payoutsSettled)} |
| TP recovery (proceeds) | ${fmtUsd(db.totals.tpRecovery)} |
| **Net P&L (realized)** | **${fmtUsd(db.totals.netPnl)}** |

---

## 3. Option Selection — What Did the Algorithm Pick?

### 3.1 Expiry bucket of selected instrument vs createdAt

| Bucket | Count |
|---|---|
| < ~1 day (≤ 0.85d) | ${db.expirySelection.bucketLessThan1d} |
| ~1 day (0.85–1.5d) | ${db.expirySelection.bucket1d} |
| ~2 days (1.5–2.5d) | ${db.expirySelection.bucket2d} |
| ~3 days (2.5–3.5d) | ${db.expirySelection.bucket3d} |
| > 3 days | ${db.expirySelection.bucketMoreThan3d} |
| Unknown (couldn't parse) | ${db.expirySelection.unknown} |

> _The selection algorithm allows \`[now+12h, now+3d]\` for tenor=1. Any non-trivial count in the 2d / 3d buckets indicates the 1d strike was unavailable at the trigger band when the trade was placed and the algorithm fell back to a longer-dated option._

### 3.2 Strike vs trigger (selected instrument)

| Position | Count |
|---|---|
| ITM (strike beats trigger) | ${db.strikeVsTrigger.itm} |
| At trigger (within ±0.05%) | ${db.strikeVsTrigger.atTrigger} |
| OTM (strike worse than trigger) | ${db.strikeVsTrigger.otm} |
| Unknown | ${db.strikeVsTrigger.unknown} |

> _The ITM bonus only fires for \`drawdownFloorPct ≤ 0.025\` (i.e. 2% SL on puts). ITM count concentrated in the 2% tier confirms the bonus is working; ITM count in 3%/5%/10% would indicate the algo preferred ITM for cost reasons rather than the bonus._

### 3.3 Negative-margin trades observed

DB sample (premium < hedgeCost in completed activations):

${negMarginLines}

Log paste-ins (last NEGATIVE_MARGIN \`WINNER\` lines, max 10):

${sampleNegMarginLogLines}

---

## 4. Hedge Manager — TP & Hold Decisions

### 4.1 Outcomes (DB)

(Already covered per-tier in §2 — TP-sold count + avg recovery.)

### 4.2 Decisions (Render logs, paste-ins required)

> _If counts below are 0, either no log files have been pasted into \`docs/pilot-reports/raw-logs/\` yet, or the events did not occur in the pasted window. Outcome columns above remain authoritative regardless._

**Files ingested:** ${logs.filesIngested.length === 0 ? "_(none)_" : logs.filesIngested.map((f) => "`" + f + "`").join(", ")}
**Lines parsed:** ${logs.totalLines} total / ${logs.uniqueLines} unique

**Sell decisions by reason:**
${Object.entries(logHM.sellingByReason).length === 0 ? "_(none in paste-ins)_" : Object.entries(logHM.sellingByReason).map(([k, v]) => `- \`${k}\`: ${v}`).join("\n")}

**Sell results by status:**
${Object.entries(logHM.sellResultByStatus).length === 0 ? "_(none in paste-ins)_" : Object.entries(logHM.sellResultByStatus).map(([k, v]) => `- \`${k}\`: ${v}`).join("\n")}

**Hold decisions:**
- \`cooling_period\` holds: ${logHM.coolingHolds}
- \`gap_extended_cooling\` holds: ${logHM.gapExtendedCoolingHolds}
- Sub-threshold / other holds: ${logHM.otherHolds}

**Cycle aggregates (from \`Cycle complete:\` lines):**
- Cycles seen: ${logHM.cycleCount}
- Sum scanned: ${logHM.sumScanned}
- Sum tpSold: ${logHM.sumTpSold}
- Sum salvaged: ${logHM.sumSalvaged}
- Sum expired: ${logHM.sumExpired}
- Sum no-bid retries: ${logHM.sumNoBidRetries}
- Sum errors: ${logHM.sumErrors}

---

## 5. Trigger Monitor (Render logs)

- Triggered events seen: ${logTM.triggeredEvents}
- Cycle summaries seen: ${logTM.cycleCount}
- Sum price errors: ${logTM.sumPriceErrors}
- Consecutive-error warnings: ${logTM.consecutiveErrorWarnings}

---

## 6. Auto-Renew (Render logs)

- Renewed: ${logAR.renewed}
- Failed: ${logAR.failed}

---

## 7. Option Selection Activity (Render logs)

- \`WINNER:\` lines: ${logOS.winners}
- of which \`⚠ NEGATIVE_MARGIN\`: ${logOS.negativeMarginWinners}
- \`OVER_PREMIUM\` penalty events: ${logOS.overPremiumPenalties}
- Per-candidate \`score:\` lines: ${logOS.candidatesScored}
- \`trigger_strike_unavailable\` rejections: ${logOS.triggerStrikeUnavailable}

---

## 8. Methodological Notes

1. **DB visibility = outcomes only.** Hold decisions (cooling, gap-extended, sub-threshold) and rejected activations (\`trigger_strike_unavailable\`) only appear in Render logs. The §4.2/§5/§6/§7 sections require the operator to paste log lines into \`docs/pilot-reports/raw-logs/\`.
2. **Expiry bucketing uses createdAt vs parsed instrument expiry.** For renewals, \`createdAt\` is the new protection's creation time, not the original — the bucket reflects what was bought at that moment.
3. **Strike-vs-trigger uses parsed strike from \`instrument_id\` and \`floor_price\` from the protection record.** Both are ground truth.
4. **Negative-margin tally counts trades where realized \`premium − executionPrice × size < 0\`.** Quoted-but-unfilled NEGATIVE_MARGIN warnings live in logs only.
5. **TP recovery is read from \`metadata.sellResult.totalProceeds\`.** Values denominated in USD as recorded by the platform's sell path.
6. **The script is read-only.** No platform calls produce side effects. Snapshots persist to \`docs/pilot-reports/raw-pilot-data/<UTC-timestamp>/\`.

---

## 9. Open Questions Surfaced by This Report

_(Fill in after reviewing — left intentionally blank in the auto-generated draft.)_

- [ ] If expiry-bucket §3.1 shows substantial 2d/3d selections: investigate Phase 2 chain-availability data to confirm 1d strike was genuinely unavailable, or recommend tighter window in Phase 4 (deferred).
- [ ] If §3.2 shows ITM selections in 3%/5%/10% tiers: confirm whether the cost bias is driving these (no behavior change recommended yet).
- [ ] If §3.3 shows persistent negative-margin trades in any tier: flag for pricing review post-pilot (do not adjust during stabilization).
- [ ] If §4.2 cooling-hold count >> sub-threshold-hold count for triggered positions that ultimately did NOT sell: TP threshold may be too restrictive on 1-day tenor (defer to Phase 5, post-pilot).
- [ ] If §5 shows non-zero \`consecutive-error warnings\`: investigate price-feed reliability before live-flip.

---

_End of Phase 0 baseline._
`;
};

// ─── Main ───────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[phase0] api=${args.apiBase} no-write=${args.noWrite}`);

  console.log("[phase0] fetching admin snapshot...");
  const snap = await fetchSnapshot(args);
  if (snap.fetchErrors.length) {
    console.warn(`[phase0] fetch errors:`);
    for (const e of snap.fetchErrors) console.warn(`  - ${e.endpoint}: ${e.error}`);
  }

  console.log("[phase0] persisting snapshot...");
  const snapshotDir = await persistSnapshot(args, snap);
  console.log(`[phase0] snapshot dir: ${snapshotDir}`);

  console.log("[phase0] analysing DB-side outcomes...");
  const db = analyseDb(snap);

  console.log(`[phase0] ingesting Render log paste-ins from: ${args.logsDir}`);
  const logs = await ingestLogsDir(args.logsDir);
  console.log(`[phase0] log files ingested: ${logs.filesIngested.length} (${logs.uniqueLines} unique lines)`);

  const report = renderReport({ snapshotDir, snap, db, logs });

  if (args.noWrite) {
    console.log("---- REPORT (dry run, --no-write) ----");
    console.log(report);
    return;
  }

  await writeFile(args.reportPath, report, "utf8");
  console.log(`[phase0] report written: ${path.relative(REPO_ROOT, args.reportPath)}`);

  console.log(`[phase0] done. sample size: ${db.sampleSize.allCount} protections, ${db.sampleSize.activeCount} active.`);
};

main().catch((err) => {
  console.error(`[phase0] FAILED: ${err?.message || err}`);
  if (err?.stack) console.error(err.stack);
  process.exitCode = String(err?.message || "").startsWith("missing_env:") ? 1 : 2;
});
