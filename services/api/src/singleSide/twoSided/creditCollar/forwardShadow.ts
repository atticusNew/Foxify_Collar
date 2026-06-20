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
import { settleMatured, aggregateSettlements, type OpenPosition, type SettlementAggregate } from "./forwardSettlement";
import { loadOpenPositions, saveOpenPositions, appendSettlements, loadSettlements } from "./forwardSettlementStore";
import { reconcileShadowLifecycle, type ShadowLifecycleReport } from "./lifecycleShadow";
import { loadLedger, saveLedger } from "./collateralStore";
import { reconcilePositions, type PartnerPositionFeed } from "./partnerReconciliation";

export type ForwardCycleResult =
  | {
      ok: true;
      openingScorecard: ShadowScorecard;
      settledThisCycle: number;
      settledPayoutThisCycleUsdc: number;
      deferred: number;
      openBookSize: number;
      settlePriceUsd: number | null;
      oracleVerified: boolean;
      lifecycle: ShadowLifecycleReport;
      meta: { spotUsd: number; oracleSources: string[]; fetchErrors: unknown[] };
    }
  | { ok: false; error: string; message: string };

export type ForwardCycleConfig = LiveShadowConfig & {
  settlementHorizonMin?: number;
  /** Measured capital inputs (Deribit) so settled positions report P&L net of the IM they tied up. */
  capital?: import("./forwardSettlement").SettlementCapitalConfig;
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
  };
};

export const runForwardShadowCycle = async (
  cfg: ForwardCycleConfig,
  paths: { openPath?: string; ledgerPath?: string } = {}
): Promise<ForwardCycleResult> => {
  const built = await buildLiveShadowInputs(cfg);
  if (!built.ok) return { ok: false, error: built.error, message: built.message };
  const { skew, spot, scaffoldConfig, oracle, meta } = built.inputs;
  const now = oracle.nowMs;

  // 1) Settle matured positions at the current ECDSA-verified TWAP (real later price).
  const open = loadOpenPositions(paths.openPath);
  const { settled, stillOpen, oracleVerified, settlePriceUsd, deferred } = settleMatured(open, now, oracle, cfg.capital);
  appendSettlements(settled, paths.ledgerPath);
  const settledPayout = settled.reduce((s, o) => s + o.payoutToFoxifyUsdc, 0);

  // 2) Open a new steered batch (settlement DEFERRED to expiry).
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

  for (let i = 0; i < cfg.nPositions; i++) {
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

  // 3) Lifecycle overlay: exercise vesting + collateral + basis over the live open book.
  const lcCfg = cfg.lifecycle ?? {};
  const minBuffer = lcCfg.minCollateralBufferUsdc ?? 25_000;
  const ledger0 = loadLedger(lcCfg.initialCollateralUsdc ?? 250_000, { minBufferUsdc: minBuffer });

  // Optional: reconcile the open book against a live partner-position feed (read-only, independent).
  let partnerStates: Record<string, import("./barrierLifecycle").PartnerPositionState> | undefined;
  let partnerFeedHealthy = true;
  if (lcCfg.partnerFeed) {
    try {
      const records = await lcCfg.partnerFeed.fetchPositions(openBook.map((p) => p.ref));
      const rec = reconcilePositions(openBook.map((p) => ({ ref: p.ref, notionalUsdc: p.notionalUsdc })), records, now, { maxStalenessMs: lcCfg.maxStalenessMs, sizeTolerancePct: lcCfg.sizeTolerancePct });
      partnerStates = rec.byRef;
      partnerFeedHealthy = rec.summary.feedHealthy;
    } catch {
      partnerFeedHealthy = false; // feed failure ⟹ degraded (fail-closed)
    }
  }

  const { report: lifecycle, ledger: ledger1 } = reconcileShadowLifecycle({
    open: openBook,
    nowMs: now,
    ticks: oracle.settlementTwapTicks,
    oracleMedianUsd: oracle.snapshot.priceUsd ?? spot,
    usableSamples: oracle.snapshot.usableSamples,
    ledger: ledger0,
    tenorMs: lcCfg.fullTenorMs ?? cfg.tenorDays * 86_400_000,
    basisMaxBps: lcCfg.basisMaxBps ?? 25,
    persistTicks: 3,
    partnerStates,
    partnerFeedHealthy
  });
  saveLedger(ledger1);

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
    lifecycleComplete: newOpens.length > 0,
    notes: ["Forward-settled: opens deferred to real expiry; settlement economics in the settlement ledger."]
  };

  return {
    ok: true,
    openingScorecard,
    settledThisCycle: settled.length,
    settledPayoutThisCycleUsdc: +settledPayout.toFixed(2),
    deferred,
    openBookSize: openBook.length,
    settlePriceUsd,
    oracleVerified,
    lifecycle,
    meta
  };
};

/** The realized-economics aggregate over the whole settlement ledger. */
export const loadSettlementAggregate = (ledgerPath?: string): SettlementAggregate => aggregateSettlements(loadSettlements(ledgerPath));
