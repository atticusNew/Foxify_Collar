/**
 * Forward-settled shadow cycle — opens a steered batch now (settlement DEFERRED to real expiry) and
 * settles any positions that matured against the current verified oracle price. This produces REAL
 * payout economics over real price moves (the compressed-settle path always returned $0). Persists
 * the open-positions ledger + the settlement ledger across cycles (disk-backed).
 *
 * Openings track record (activation reliability) stays in the scorecard store; realized economics live
 * in the settlement ledger. Read/quote-only, paper, live tiers off.
 */

import { CreditCollarActivationScaffold } from "./activationScaffold";
import { computeInventory } from "./inventoryBalancer";
import { buildLiveShadowInputs, type LiveShadowConfig } from "./shadowRunner";
import type { ShadowScorecard } from "./shadowRunner";
import { settleMatured, aggregateSettlements, type OpenPosition, type SettlementAggregate, type SettlementLifecycleConfig } from "./forwardSettlement";
import { loadOpenPositions, saveOpenPositions, appendSettlements, loadSettlements } from "./forwardSettlementStore";
import { loadTickHistory, saveTickHistory, rollTickHistory, type RollConfig } from "./tickHistoryStore";
import { reconcileShadowLifecycle, type ShadowLifecycleReport } from "./lifecycleShadow";
import { loadLedger, saveLedger } from "./collateralStore";
import { reconcilePositions, type PartnerPositionFeed } from "./partnerReconciliation";
import { stepLifecycleBook, seedTracked, checkReopenCooldowns, type CoordinatorOutcome } from "./lifecycleCoordinator";
import { loadLifecycleStates, saveLifecycleStates, loadLifecycleHistory, saveLifecycleHistory, type TrackedPosition, type LifecycleHistory } from "./lifecycleStateStore";
import { assessBasis, type VenueMark } from "./basisGuard";
import { evaluateActivationGate, type ActivationGateConfig } from "./activationGate";
import type { PartnerPositionState } from "./barrierLifecycle";

export type ForwardCycleResult =
  | {
      ok: true;
      openingScorecard: ShadowScorecard;
      settledThisCycle: number;
      settledPayoutThisCycleUsdc: number;
      touchSettledThisCycle: number;
      europeanSettledThisCycle: number;
      deferred: number;
      openBookSize: number;
      settlePriceUsd: number | null;
      oracleVerified: boolean;
      lifecycle: ShadowLifecycleReport;
      /** Lifecycle-coordinator summary when a partner feed drives the FSM (null otherwise). */
      coordinator: CoordinatorOutcome["summary"] & { active: boolean; cherryPick: boolean } | null;
      /** Fail-closed open-gate decision for this cycle (enforced before any opens). */
      gate: { allowOpens: boolean; reasons: string[] };
      meta: { spotUsd: number; oracleSources: string[]; fetchErrors: unknown[] };
    }
  | { ok: false; error: string; message: string };

export type ForwardCycleConfig = LiveShadowConfig & {
  settlementHorizonMin?: number;
  /** Measured capital inputs (Deribit) so settled positions report P&L net of the IM they tied up. */
  capital?: import("./forwardSettlement").SettlementCapitalConfig;
  /**
   * Settlement model: touch-first / European-fallback. Touch is ON by default; persistTicks is the
   * anti-wick confirmation depth on the oracle tick stream; touchGapBps models slippage past the
   * barrier.
   */
  settlement?: SettlementLifecycleConfig;
  /**
   * Fail-closed OPEN gate (oracle-safe / collateral-ok / partner-feed-healthy / basis-safe). All guards
   * required by default. A closed gate halts opens for the cycle (a correct fail-closed decline).
   */
  activationGate?: ActivationGateConfig;
  /**
   * Rolling oracle tick history. When enabled, each cycle's verified median is appended to a disk-backed
   * window and used as the tick stream for BOTH settlement (touch detection) and the lifecycle overlay.
   * This is what lets the touch path actually engage on live data (the synthetic 2-tick stream never
   * confirms a touch). Default off ⟹ legacy synthetic ticks (European-only in practice).
   */
  rollingTickHistory?: { enabled: boolean } & RollConfig;
  /** Vesting/collateral/basis overlay params. */
  lifecycle?: {
    fullTenorMs?: number;          // tenor used for vesting (defaults to tenorDays)
    basisMaxBps?: number;          // basis tolerance (default 25)
    initialCollateralUsdc?: number; // posted collateral seed (default 250_000)
    minCollateralBufferUsdc?: number; // halt below this (default 25_000)
    /** Optional live partner-position feed; when set, the overlay reconciles the open book against it. */
    partnerFeed?: PartnerPositionFeed;
    maxStalenessMs?: number;       // partner-feed staleness tolerance (default 15_000)
    sizeTolerancePct?: number;     // partner size vs notional tolerance (default 0.02)
    /**
     * Drive the lifecycle FSM (orphan-cancel, close-SLA gap, breach forfeit) from the partner feed.
     * Only takes effect when partnerFeed is set. Default true when a feed is present.
     */
    driveLifecycle?: boolean;
    closeSlaMs?: number;           // max ms from close signal to confirmed perp close (default 30_000)
    reopenCooldownMs?: number;     // anti-churn cooldown for reopening a line (default 60_000)
    cherryPick?: { minPerSide?: number; maxGap?: number }; // asymmetric-compliance detector thresholds
  };
};

export const runForwardShadowCycle = async (
  cfg: ForwardCycleConfig,
  paths: { openPath?: string; ledgerPath?: string; tickHistoryPath?: string; lifecycleStatePath?: string; lifecycleHistoryPath?: string } = {}
): Promise<ForwardCycleResult> => {
  const built = await buildLiveShadowInputs(cfg);
  if (!built.ok) return { ok: false, error: built.error, message: built.message };
  const { skew, spot, scaffoldConfig, oracle, meta } = built.inputs;
  const now = oracle.nowMs;

  // Roll the real oracle tick history: append this cycle's verified median so the touch detector sees a
  // genuine price stream (not the synthetic same-price 2-tick window). Used for settlement + overlay.
  if (cfg.rollingTickHistory?.enabled) {
    const prev = loadTickHistory(paths.tickHistoryPath);
    const medianUsd = oracle.snapshot.priceUsd ?? spot;
    const rolled = rollTickHistory(prev, { tsMs: now, priceUsd: medianUsd }, now, cfg.rollingTickHistory);
    saveTickHistory(rolled, paths.tickHistoryPath);
    if (rolled.length > 0) {
      oracle.settlementTwapTicks = rolled;
      oracle.windowStartMs = rolled[0].tsMs;
      oracle.windowEndMs = now;
    }
  }

  // ── Setup: economic book, collateral ledger, lifecycle config ────────────────
  const priorOpen = loadOpenPositions(paths.openPath);
  const lcCfg = cfg.lifecycle ?? {};
  const minBuffer = lcCfg.minCollateralBufferUsdc ?? 25_000;
  let ledger = loadLedger(lcCfg.initialCollateralUsdc ?? 250_000, { minBufferUsdc: minBuffer });
  const driveLifecycle = !!lcCfg.partnerFeed && (lcCfg.driveLifecycle ?? true);

  // 1) Lifecycle COORDINATOR (when a partner feed drives the FSM): reconcile perp↔collar, run the state
  //    machine, allocate close-SLA gaps, and identify ORPHAN-CANCELS — all BEFORE economic settlement.
  let coordinator: CoordinatorOutcome | null = null;
  let coordinatorStates: Record<string, TrackedPosition> = {};
  let cancelledSet = new Set<string>();
  let partnerStates: Record<string, PartnerPositionState> | undefined;
  let partnerFeedHealthy = true;
  let cooldownFlags: string[] = [];
  let history: LifecycleHistory = { closeHistory: [], lastCloseByRef: {} };

  if (driveLifecycle && lcCfg.partnerFeed) {
    const priorStates = loadLifecycleStates(paths.lifecycleStatePath);
    history = loadLifecycleHistory(paths.lifecycleHistoryPath);
    const trackedOnly = Object.values(priorStates).filter((s) => !priorOpen.some((p) => p.ref === s.ref));
    const refsForFeed = [...priorOpen.map((p) => p.ref), ...trackedOnly.map((s) => s.ref)];
    try {
      const records = await lcCfg.partnerFeed.fetchPositions(refsForFeed);
      const rc = reconcilePositions(
        [
          ...priorOpen.map((p) => ({ ref: p.ref, notionalUsdc: p.notionalUsdc })),
          ...trackedOnly.map((s) => ({ ref: s.ref, notionalUsdc: s.notionalUsdc }))
        ],
        records,
        now,
        { maxStalenessMs: lcCfg.maxStalenessMs, sizeTolerancePct: lcCfg.sizeTolerancePct }
      );
      partnerStates = rc.byRef;
      partnerFeedHealthy = rc.summary.feedHealthy;
    } catch {
      partnerFeedHealthy = false; // feed failure ⟹ degraded (fail-closed; missing ⟹ assume open)
      partnerStates = {};
    }
    coordinator = stepLifecycleBook(
      priorStates,
      priorOpen,
      {
        nowMs: now,
        ticks: oracle.settlementTwapTicks,
        partnerStates: partnerStates ?? {},
        settlePriceUsd: oracle.snapshot.priceUsd ?? spot,
        ledger,
        closeHistory: history.closeHistory,
        lastCloseByRef: history.lastCloseByRef
      },
      {
        lifecycle: { persistTicks: cfg.settlement?.persistTicks ?? 3, closeSlaMs: lcCfg.closeSlaMs, reopenCooldownMs: lcCfg.reopenCooldownMs, sizeTolerancePct: lcCfg.sizeTolerancePct },
        vesting: cfg.settlement?.vesting,
        collateral: { minBufferUsdc: minBuffer },
        cherryPick: lcCfg.cherryPick
      }
    );
    ledger = coordinator.ledger;
    coordinatorStates = coordinator.states;
    cancelledSet = new Set(coordinator.cancelledRefs);
    history = { closeHistory: coordinator.closeHistory, lastCloseByRef: coordinator.lastCloseByRef };
  }

  // 1b) Basis (partner-vs-oracle, proxied by cross-venue oracle dispersion) — a FAIL-CLOSED gate on
  //     both settlement and opens. Computed before settlement so a wide basis defers settling.
  const basisMarks: VenueMark[] = oracle.snapshot.usableSamples.map((s) => ({ venue: s.source, priceUsd: s.priceUsd, tsMs: s.tsMs }));
  const basisAssess = assessBasis(oracle.snapshot.priceUsd ?? spot, basisMarks, lcCfg.basisMaxBps ?? 25);
  const basisSafe = basisAssess.safeToSettle;

  // 2) Economic settlement (touch-first / European). Orphan-cancelled positions are EXCLUDED — they're
  //    cancelled, not matured/touched, so they never get a normal settlement. Fail-closed on basis.
  const settleable = cancelledSet.size ? priorOpen.filter((p) => !cancelledSet.has(p.ref)) : priorOpen;
  const { settled, stillOpen, oracleVerified, settlePriceUsd, deferred, touchSettled, europeanSettled } = settleMatured(
    settleable,
    now,
    oracle,
    cfg.capital,
    { ...cfg.settlement, safeToSettle: basisSafe }
  );
  appendSettlements(settled, paths.ledgerPath);
  const settledPayout = settled.reduce((s, o) => s + o.payoutToFoxifyUsdc, 0);

  // 2b) FAIL-CLOSED OPEN GATE — every guard must pass before opening new protection this cycle.
  const gate = evaluateActivationGate(
    {
      oracleSafeForActivation: !!oracle.snapshot.safeForActivation,
      collateralHalted: ledger.haltNewProtection,
      partnerFeedHealthy,
      basisSafeToSettle: basisSafe
    },
    cfg.activationGate
  );

  // 3) Open a new steered batch (settlement DEFERRED to expiry).
  const scaffold = new CreditCollarActivationScaffold(scaffoldConfig, skew);
  const band = scaffoldConfig.policy.targetNetBandPct;
  const minGross = scaffoldConfig.breaker.minGrossNotionalUsd ?? 0;
  const horizonMs = (cfg.settlementHorizonMin ?? cfg.tenorDays * 1440) * 60_000;

  const newOpens: OpenPosition[] = [];
  let halted = 0;
  let rejected = 0;
  let peakRatio = 0;
  let peakNotional = 0;
  let serviceFee = 0;
  let credit = 0;
  let maxFloor = 0;
  let sumFloor = 0;
  const rej: Record<string, number> = {};

  // Fail-closed: a closed gate halts ALL opens this cycle (a correct decline; reasons surfaced below).
  if (!gate.allowOpens) halted = cfg.nPositions;

  for (let i = 0; gate.allowOpens && i < cfg.nPositions; i++) {
    const instr = scaffold.nextInstruction(cfg.positionNotionalUsdc);
    if (!instr.ok) {
      halted += 1;
      continue;
    }
    const rec = scaffold.activate({ ref: instr.ref, side: instr.side, notionalUsdc: cfg.positionNotionalUsdc, spot, instrument: "BTC-PERP", tsMs: now + i });
    if ("status" in rec && rec.status === "active") {
      newOpens.push({
        ref: rec.ref,
        side: rec.side,
        notionalUsdc: rec.notionalUsdc,
        spotAtEntry: spot,
        putStrike: rec.putStrike,
        callStrike: rec.callStrike,
        foxifyCreditUsdc: rec.foxifyCreditUsdc,
        serviceFeeUsdc: rec.serviceFeeUsdc,
        floorPctUsed: rec.floorPctUsed,
        openedAtMs: now,
        expiresAtMs: now + horizonMs
      });
      serviceFee += rec.serviceFeeUsdc;
      credit += rec.foxifyCreditUsdc;
      maxFloor = Math.max(maxFloor, rec.floorPctUsed);
      sumFloor += rec.floorPctUsed;
      const inv = computeInventory(scaffold.bookSnapshot(), band);
      peakNotional = Math.max(peakNotional, Math.abs(inv.netNotionalUsdc));
      if (inv.grossNotionalUsdc >= minGross) peakRatio = Math.max(peakRatio, inv.imbalanceRatio);
    } else if ("error" in rec) {
      rejected += 1;
      rej[rec.error] = (rej[rec.error] ?? 0) + 1;
    }
  }

  const openBook = [...stillOpen, ...newOpens];
  saveOpenPositions(openBook, paths.openPath);

  // 3a) Persist FSM state: surviving coordinator states + seed this cycle's new opens as "proposed".
  if (driveLifecycle) {
    const nextStates: Record<string, TrackedPosition> = { ...coordinatorStates };
    for (const p of newOpens) nextStates[p.ref] = seedTracked(p);
    saveLifecycleStates(nextStates, paths.lifecycleStatePath);
    cooldownFlags = checkReopenCooldowns(
      newOpens.map((p) => ({ ref: p.ref, openedAtMs: p.openedAtMs })),
      history.lastCloseByRef,
      lcCfg.reopenCooldownMs ?? 60_000
    ).map((f) => ("ref" in f && f.ref ? `${f.kind}:${f.ref}` : f.kind));
    saveLifecycleHistory(history, paths.lifecycleHistoryPath);
  }

  // 3b) Non-coordinator partner fetch (overlay-only reconciliation) when the FSM isn't driving.
  if (lcCfg.partnerFeed && !driveLifecycle) {
    try {
      const records = await lcCfg.partnerFeed.fetchPositions(openBook.map((p) => p.ref));
      const rec = reconcilePositions(openBook.map((p) => ({ ref: p.ref, notionalUsdc: p.notionalUsdc })), records, now, { maxStalenessMs: lcCfg.maxStalenessMs, sizeTolerancePct: lcCfg.sizeTolerancePct });
      partnerStates = rec.byRef;
      partnerFeedHealthy = rec.summary.feedHealthy;
    } catch {
      partnerFeedHealthy = false; // feed failure ⟹ degraded (fail-closed)
    }
  }

  // 4) Lifecycle overlay (basis + vesting view). When the coordinator is driving it owns gaps/orphans,
  //    so the overlay's modeled gap is suppressed (modeledTouchGapBps: 0) to avoid double-counting.
  const { report: lifecycle, ledger: ledgerAfter } = reconcileShadowLifecycle({
    open: openBook,
    nowMs: now,
    ticks: oracle.settlementTwapTicks,
    oracleMedianUsd: oracle.snapshot.priceUsd ?? spot,
    usableSamples: oracle.snapshot.usableSamples,
    ledger,
    tenorMs: lcCfg.fullTenorMs ?? cfg.tenorDays * 86_400_000,
    basisMaxBps: lcCfg.basisMaxBps ?? 25,
    persistTicks: 3,
    modeledTouchGapBps: driveLifecycle ? 0 : undefined,
    partnerStates,
    partnerFeedHealthy
  });
  // Merge coordinator + cooldown signals into the report flags (deduped at the source modules).
  if (coordinator) {
    for (const f of coordinator.flags) lifecycle.flags.push("ref" in f && f.ref ? `${f.kind}:${f.ref}` : f.kind);
    lifecycle.flags.push(...cooldownFlags);
  }
  // Surface a closed open-gate as flags (the fail-closed decline reasons).
  if (!gate.allowOpens) for (const r of gate.reasons) lifecycle.flags.push(`open_gate:${r}`);
  saveLedger(ledgerAfter);

  const openedNotional = newOpens.reduce((s, p) => s + p.notionalUsdc, 0);
  const openingScorecard: ShadowScorecard = {
    label: "tier0_shadow_paper_settled",
    mode: "shadow",
    oracle: { status: oracle.snapshot.status, priceUsd: oracle.snapshot.priceUsd, safeForActivation: oracle.snapshot.safeForActivation, signatureValid: oracleVerified },
    attempted: cfg.nPositions,
    opened: newOpens.length,
    openedNotionalUsdc: +openedNotional.toFixed(2),
    halted,
    rejected,
    rejectionsByReason: rej,
    peakNetExposureRatio: +peakRatio.toFixed(4),
    peakNetNotionalUsdc: +peakNotional.toFixed(2),
    maxFloorPctUsed: +maxFloor.toFixed(4),
    avgFloorPctUsed: newOpens.length > 0 ? +(sumFloor / newOpens.length).toFixed(4) : 0,
    serviceFeeAccruedUsdc: +serviceFee.toFixed(2),
    foxifyCreditAccruedUsdc: +credit.toFixed(2),
    // Settlement is DEFERRED to expiry → these stay 0 in the opening record; real economics are in the
    // settlement ledger (see /api/settlements). lifecycleComplete here = "this cycle's opens activated".
    settlements: 0,
    allSettledOracleVerified: oracleVerified,
    allReconciled: true,
    totalPayoutToFoxifyUsdc: 0,
    totalNetToFoxifyUsdc: 0,
    settlementPriceUsd: settlePriceUsd ?? 0,
    // "Complete" = the cycle behaved CORRECTLY: oracle verified AND we either opened positions OR
    // correctly DECLINED because the fail-closed OPEN GATE was shut (oracle-unsafe / collateral-halted /
    // partner-feed-degraded / basis-unsafe). Only oracle-unverified, or gate-open-but-zero-opens (a real
    // pricing/breaker signal), counts as incomplete.
    lifecycleComplete: oracleVerified && (newOpens.length > 0 || !gate.allowOpens),
    notes: [
      "Forward-settled: opens deferred to real expiry; settlement economics in the settlement ledger.",
      !gate.allowOpens ? `Cycle correctly declined to open (fail-closed gate: ${gate.reasons.join(", ")}).` : ""
    ].filter(Boolean)
  };

  return {
    ok: true,
    openingScorecard,
    settledThisCycle: settled.length,
    settledPayoutThisCycleUsdc: +settledPayout.toFixed(2),
    touchSettledThisCycle: touchSettled,
    europeanSettledThisCycle: europeanSettled,
    deferred,
    openBookSize: openBook.length,
    settlePriceUsd,
    oracleVerified,
    lifecycle,
    coordinator: coordinator ? { ...coordinator.summary, active: true, cherryPick: !!coordinator.cherryPickFlag } : null,
    gate,
    meta
  };
};

/** The realized-economics aggregate over the whole settlement ledger. */
export const loadSettlementAggregate = (ledgerPath?: string): SettlementAggregate => aggregateSettlements(loadSettlements(ledgerPath));
