/**
 * Tier-0 SHADOW activation runner — Phase A (DEFAULT-OFF, paper-settled end-to-end). Exercises the
 * FULL lifecycle with zero capital so the operator can watch it before any live tier:
 *   instruction stream (steer net flat) → shadow activate (ExposureBreaker + EV guardrail + tier cap
 *   + manufactured-pair rejection) → settle on the ECDSA reference oracle (verified + TWAP) →
 *   venue-vs-ledger reconciliation → scorecard.
 *
 * `runShadowSession` is PURE (oracle snapshot, skew, leg-spread injected) → deterministic + testable.
 * `runLiveShadowSession` assembles the inputs from live public quotes (read/quote-only) + the
 * multi-source oracle. NOTHING here trades; settlement is paper. Live tiers stay off (liveEnabled=false).
 */

import { CreditCollarActivationScaffold, type ScaffoldConfig, type ActivationRecord, type SettlementRecord } from "./activationScaffold";
import { computeInventory, type InventoryPolicy, type ExposureBreakerConfig } from "./inventoryBalancer";
import {
  aggregateOracle,
  signSnapshot,
  generateOracleKeyPair,
  type OracleSnapshot,
  type OracleTick,
  type PriceSample
} from "./referenceOracle";
import type { SkewCurve, AtticusSpreadConfig, AdaptiveFloorConfig } from "./creditCollarPricer";

export type ShadowSessionDeps = {
  scaffoldConfig: ScaffoldConfig;
  skew: SkewCurve;
  spot: number;
  oracle: {
    snapshot: OracleSnapshot;
    signatureHex: string;
    publicKeyPem: string;
    settlementTwapTicks: OracleTick[];
    windowStartMs: number;
    windowEndMs: number;
  };
  nPositions: number;
  positionNotionalUsdc: number;
  instrument?: string;
  seed: number;
};

export type ShadowScorecard = {
  label: "tier0_shadow_paper_settled";
  mode: "shadow";
  oracle: { status: OracleSnapshot["status"]; priceUsd: number | null; safeForActivation: boolean; signatureValid: boolean };
  attempted: number;
  opened: number;
  openedNotionalUsdc: number;
  halted: number;
  rejected: number;
  rejectionsByReason: Record<string, number>;
  peakNetExposureRatio: number;
  peakNetNotionalUsdc: number;
  maxFloorPctUsed: number;             // deepest floor the solver needed (regime signal: calm ⟹ deeper)
  avgFloorPctUsed: number;
  serviceFeeAccruedUsdc: number;       // Atticus margin booked across opened positions
  foxifyCreditAccruedUsdc: number;     // credit accrued to held balance (netted at settlement)
  settlements: number;
  allSettledOracleVerified: boolean;
  allReconciled: boolean;
  totalPayoutToFoxifyUsdc: number;
  totalNetToFoxifyUsdc: number;        // credit + payout netted
  settlementPriceUsd: number;
  lifecycleComplete: boolean;          // every opened position reached a settled+reconciled state
  notes: string[];
};

const round2 = (x: number) => +x.toFixed(2);

/**
 * Run one full shadow session (open a steered batch → settle all on the oracle TWAP → reconcile).
 * Pure + deterministic. Settlement is COMPRESSED (all positions settle at the session window) so the
 * whole lifecycle is observable without waiting for real expiries — clearly a shadow convenience.
 */
export const runShadowSession = (deps: ShadowSessionDeps): ShadowScorecard => {
  const scaffold = new CreditCollarActivationScaffold(deps.scaffoldConfig, deps.skew);
  const band = deps.scaffoldConfig.policy.targetNetBandPct;
  const nowMs = deps.oracle.snapshot.asOfMs;

  const opened: ActivationRecord[] = [];
  const rejectionsByReason: Record<string, number> = {};
  let halted = 0;
  let rejected = 0;
  let peakNetExposureRatio = 0;
  let peakNetNotionalUsdc = 0;

  for (let i = 0; i < deps.nPositions; i++) {
    const instr = scaffold.nextInstruction(deps.positionNotionalUsdc);
    if (!instr.ok) {
      halted += 1;
      continue;
    }
    const rec = scaffold.activate({
      ref: instr.ref,
      side: instr.side,
      notionalUsdc: deps.positionNotionalUsdc,
      spot: deps.spot,
      instrument: deps.instrument,
      tsMs: nowMs + i
    });
    if ("status" in rec && rec.status === "active") {
      opened.push(rec);
      const inv = computeInventory(scaffold.bookSnapshot(), band);
      peakNetNotionalUsdc = Math.max(peakNetNotionalUsdc, Math.abs(inv.netNotionalUsdc));
      // Ratio is only meaningful once the book is material (a 1–2 position book is ~100% by construction).
      const minGross = deps.scaffoldConfig.breaker.minGrossNotionalUsd ?? 0;
      if (inv.grossNotionalUsdc >= minGross) peakNetExposureRatio = Math.max(peakNetExposureRatio, inv.imbalanceRatio);
    } else if ("error" in rec) {
      rejected += 1;
      rejectionsByReason[rec.error] = (rejectionsByReason[rec.error] ?? 0) + 1;
    }
  }

  // Settle every opened position on the ECDSA oracle TWAP (paper). Reconcile against paper legs.
  let settlements = 0;
  let allVerified = true;
  let allReconciled = true;
  let totalPayout = 0;
  let totalNet = 0;
  let settlementPriceUsd = 0;
  for (const rec of opened) {
    const result = scaffold.settle({
      ref: rec.ref,
      side: rec.side,
      notionalUsdc: rec.notionalUsdc,
      spotAtEntry: deps.spot,
      putStrike: rec.putStrike,
      callStrike: rec.callStrike,
      foxifyCreditUsdc: rec.foxifyCreditUsdc,
      settlementTwapTicks: deps.oracle.settlementTwapTicks,
      windowStartMs: deps.oracle.windowStartMs,
      windowEndMs: deps.oracle.windowEndMs,
      signedSnapshot: { snapshot: deps.oracle.snapshot, signatureHex: deps.oracle.signatureHex },
      oraclePublicKeyPem: deps.oracle.publicKeyPem,
      venueLegs: [
        { ref: rec.ref, kind: "put", venue: "paper", filled: true },
        { ref: rec.ref, kind: "call", venue: "paper", filled: true }
      ]
    });
    if ("status" in result && result.status === "settled") {
      settlements += 1;
      settlementPriceUsd = result.settlementPriceUsd;
      if (!result.oracleVerified) allVerified = false;
      if (!result.reconciliation.matched) allReconciled = false;
      totalPayout += result.payoutToFoxifyUsdc;
      totalNet += result.netToFoxifyUsdc;
    } else {
      allVerified = false;
      allReconciled = false;
    }
  }

  const serviceFeeAccrued = opened.reduce((s, r) => s + r.serviceFeeUsdc, 0);
  const foxifyCreditAccrued = opened.reduce((s, r) => s + r.foxifyCreditUsdc, 0);
  const maxFloorPctUsed = opened.reduce((m, r) => Math.max(m, r.floorPctUsed), 0);
  const avgFloorPctUsed = opened.length > 0 ? opened.reduce((s, r) => s + r.floorPctUsed, 0) / opened.length : 0;

  return {
    label: "tier0_shadow_paper_settled",
    mode: "shadow",
    oracle: {
      status: deps.oracle.snapshot.status,
      priceUsd: deps.oracle.snapshot.priceUsd,
      safeForActivation: deps.oracle.snapshot.safeForActivation,
      signatureValid: allVerified && opened.length > 0
    },
    attempted: deps.nPositions,
    opened: opened.length,
    openedNotionalUsdc: round2(opened.reduce((s, r) => s + r.notionalUsdc, 0)),
    halted,
    rejected,
    rejectionsByReason,
    peakNetExposureRatio: +peakNetExposureRatio.toFixed(4),
    peakNetNotionalUsdc: round2(peakNetNotionalUsdc),
    maxFloorPctUsed: +maxFloorPctUsed.toFixed(4),
    avgFloorPctUsed: +avgFloorPctUsed.toFixed(4),
    serviceFeeAccruedUsdc: round2(serviceFeeAccrued),
    foxifyCreditAccruedUsdc: round2(foxifyCreditAccrued),
    settlements,
    allSettledOracleVerified: allVerified,
    allReconciled,
    totalPayoutToFoxifyUsdc: round2(totalPayout),
    totalNetToFoxifyUsdc: round2(totalNet),
    settlementPriceUsd: round2(settlementPriceUsd),
    lifecycleComplete: opened.length > 0 && settlements === opened.length && allVerified && allReconciled,
    notes: [
      "Tier-0 SHADOW: paper-settled end-to-end, ZERO capital, live tiers off (liveEnabled=false).",
      "Activation gated by ExposureBreaker (fail-closed) + EV guardrail + tier cap + manufactured-pair rejection.",
      "Settlement on the ECDSA-signed reference oracle TWAP, verified + reconciled (paper legs).",
      "Settlement is COMPRESSED to the session window so the full lifecycle is observable now."
    ]
  };
};

// ── Live wrapper: assemble shadow inputs from live public quotes + the multi-source oracle ────────

export type LiveShadowConfig = {
  positionNotionalUsdc: number;
  feeUsdc: number;
  serviceFeeBps: number;
  minServiceFeeUsdc: number;
  tenorDays: number;
  maxFloorPct: number;
  nPositions: number;
  tier0CapUsdc: number;
  breaker: ExposureBreakerConfig;
  policy: InventoryPolicy;
  bullishWeight: number;
  settlementWindowMin: number;
  seed: number;
  adaptiveFloor?: AdaptiveFloorConfig;
  /** Strike grid snap in USDC for the solver. Finer (e.g. 250) lets the cap sit nearer the credit target ⟹ wider cap. */
  strikeGridUsdc?: number;
  /** Credit-target mode (pass_through): ceiling on credit handed to Foxify; bounded overshoot → Atticus margin. */
  maxFoxifyCreditUsdc?: number;
  oraclePrivateKeyPem?: string;
  oraclePublicKeyPem?: string;
  /**
   * Force a single hedge venue for pricing/execution/fees (e.g. "okx" for the Foxify-OKX mirror): filters
   * the captured option dataset to this venue so the skew, routing, leg-spreads AND the fee schedule all
   * reflect that one venue — "as close to identical to live execution as the paper shadow gets." When unset,
   * the prior multi-venue blend (skew across venues, cost-routed spreads) is used.
   */
  hedgeVenue?: "bullish" | "okx" | "deribit";
};

export type LiveShadowResult =
  | { ok: true; scorecard: ShadowScorecard; meta: { spotUsd: number; oracleSources: string[]; fetchErrors: unknown[] } }
  | { ok: false; error: string; message: string };

export type LiveShadowInputs = {
  skew: SkewCurve;
  legSpread: NonNullable<AtticusSpreadConfig["legHalfSpreadUsdcPerBtc"]>;
  spot: number;
  scaffoldConfig: ScaffoldConfig;
  oracle: { snapshot: OracleSnapshot; signatureHex: string; publicKeyPem: string; settlementTwapTicks: OracleTick[]; windowStartMs: number; windowEndMs: number; nowMs: number };
  meta: { spotUsd: number; oracleSources: string[]; fetchErrors: unknown[] };
};

/**
 * Assemble the live shadow inputs (real wing-spread skew + leg-spread; real multi-source ECDSA oracle).
 * Shared by the compressed one-shot session and the forward-settled cycle. Read/quote-only.
 */
export const buildLiveShadowInputs = async (cfg: LiveShadowConfig): Promise<{ ok: true; inputs: LiveShadowInputs } | { ok: false; error: string; message: string }> => {
  const { buildDataset } = await import("./pricingHarness/capture");
  const { captureLive } = await import("./pricingHarness/liveFetchers");
  const { fetchSpotSamples } = await import("./pricingHarness/spotFeeds");
  const { recommendRouting } = await import("./pricingHarness/routing");
  const { buildSkewFromCapture, buildLegSpreadFromCapture } = await import("./pricingHarness/report");

  const wing = { floorPcts: [0.03, 0.04, 0.05], capPcts: [0.01, 0.015, 0.02, 0.025], tenorsDays: [cfg.tenorDays, 2, 7], dailyMaxHours: 30 };
  const clips = [cfg.positionNotionalUsdc];
  const live = await captureLive(wing);
  const dataset = buildDataset(live.optionSnapshots, live.perpSnapshots, wing, clips);
  dataset.dailyListing.bullish = dataset.dailyListing.bullish || live.bullishDailyListingObserved;

  // Force a single hedge venue (e.g. OKX for the Foxify mirror): filter the option set so skew, routing,
  // and leg-spreads all reflect that venue's live book rather than a multi-venue blend.
  if (cfg.hedgeVenue) {
    dataset.options = dataset.options.filter((o) => o.venue === cfg.hedgeVenue);
    if (dataset.options.length === 0) {
      return { ok: false, error: "no_quotes_on_hedge_venue", message: `no live option quotes captured on ${cfg.hedgeVenue} this cycle` };
    }
  }

  const { skew, ok: skewOk } = buildSkewFromCapture(dataset, cfg.tenorDays);
  if (!skewOk) return { ok: false, error: "skew_under_determined", message: "not enough live IV points to build the skew curve" };
  const routing = recommendRouting(dataset.options, cfg.tenorDays, { bullishWeight: cfg.bullishWeight, materialMarginPct: 0.2 });
  const legSpread: NonNullable<AtticusSpreadConfig["legHalfSpreadUsdcPerBtc"]> = buildLegSpreadFromCapture(dataset, cfg.tenorDays, routing);

  const spotFeed = await fetchSpotSamples();
  const nowMs = Date.now();
  const snapshot = aggregateOracle(spotFeed.samples as PriceSample[], nowMs);
  if (snapshot.priceUsd == null) return { ok: false, error: "oracle_unavailable", message: "no usable oracle price from spot feeds" };
  const keys = cfg.oraclePrivateKeyPem && cfg.oraclePublicKeyPem
    ? { privateKeyPem: cfg.oraclePrivateKeyPem, publicKeyPem: cfg.oraclePublicKeyPem }
    : generateOracleKeyPair();
  const signatureHex = signSnapshot(snapshot, keys.privateKeyPem);
  const windowStartMs = nowMs - cfg.settlementWindowMin * 60_000;
  const settlementTwapTicks: OracleTick[] = [
    { tsMs: windowStartMs, priceUsd: snapshot.priceUsd },
    { tsMs: nowMs, priceUsd: snapshot.priceUsd }
  ];

  const scaffoldConfig: ScaffoldConfig = {
    tiers: [{ tier: 0, maxDailyNotionalUsdc: cfg.tier0CapUsdc, live: false }],
    policy: cfg.policy,
    breaker: cfg.breaker,
    serviceFeeBps: cfg.serviceFeeBps,
    minServiceFeeUsdc: cfg.minServiceFeeUsdc,
    maxFloorPct: cfg.maxFloorPct,
    tenorDays: cfg.tenorDays,
    feeUsdc: cfg.feeUsdc,
    adaptiveFloor: cfg.adaptiveFloor,
    liveEnabled: false,
    spreadConfig: {
      fillMode: "touch",
      legHalfSpreadUsdcPerBtc: legSpread,
      feeVenue: cfg.hedgeVenue === "okx" ? "okx" : "bullish",
      ...(cfg.strikeGridUsdc != null ? { strikeGridUsdc: cfg.strikeGridUsdc } : {}),
      ...(cfg.maxFoxifyCreditUsdc != null ? { maxFoxifyCreditUsdc: cfg.maxFoxifyCreditUsdc } : {})
    }
  };

  return {
    ok: true,
    inputs: {
      skew,
      legSpread,
      spot: snapshot.priceUsd,
      scaffoldConfig,
      oracle: { snapshot, signatureHex, publicKeyPem: keys.publicKeyPem, settlementTwapTicks, windowStartMs, windowEndMs: nowMs, nowMs },
      meta: { spotUsd: snapshot.priceUsd, oracleSources: snapshot.usedSources, fetchErrors: [...live.errors, ...spotFeed.errors] }
    }
  };
};

/**
 * Run one COMPRESSED shadow session (open + settle-at-entry). Kept for the one-shot CLI; the service
 * uses the forward-settled cycle for real payout economics.
 */
export const runLiveShadowSession = async (cfg: LiveShadowConfig): Promise<LiveShadowResult> => {
  const built = await buildLiveShadowInputs(cfg);
  if (!built.ok) return { ok: false, error: built.error, message: built.message };
  const { skew, spot, scaffoldConfig, oracle, meta } = built.inputs;

  const scorecard = runShadowSession({
    scaffoldConfig,
    skew,
    spot,
    oracle: { snapshot: oracle.snapshot, signatureHex: oracle.signatureHex, publicKeyPem: oracle.publicKeyPem, settlementTwapTicks: oracle.settlementTwapTicks, windowStartMs: oracle.windowStartMs, windowEndMs: oracle.windowEndMs },
    nPositions: cfg.nPositions,
    positionNotionalUsdc: cfg.positionNotionalUsdc,
    instrument: "BTC-PERP",
    seed: cfg.seed
  });

  return {
    ok: true,
    scorecard,
    meta
  };
};
