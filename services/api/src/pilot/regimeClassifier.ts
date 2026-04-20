import { DeribitConnector } from "@foxify/connectors";
import type { V7Regime, V7RegimeSource, V7RegimeStatus } from "./types";
import { recordDvolSample } from "./pricingRegime";

export type RegimeThresholds = {
  calmBelow: number;
  stressAbove: number;
};

const DEFAULT_THRESHOLDS: RegimeThresholds = {
  calmBelow: 40,
  stressAbove: 65
};

const CACHE_TTL_MS = 60 * 1000;

let cachedRegime: { status: V7RegimeStatus; expiresAtMs: number } | null = null;
let deribitConnectorInstance: DeribitConnector | null = null;
let configuredThresholds: RegimeThresholds = { ...DEFAULT_THRESHOLDS };

export const configureRegimeClassifier = (params: {
  deribitConnector: DeribitConnector;
  thresholds?: Partial<RegimeThresholds>;
}): void => {
  deribitConnectorInstance = params.deribitConnector;
  if (params.thresholds) {
    configuredThresholds = {
      calmBelow: params.thresholds.calmBelow ?? DEFAULT_THRESHOLDS.calmBelow,
      stressAbove: params.thresholds.stressAbove ?? DEFAULT_THRESHOLDS.stressAbove
    };
  }
};

export const classifyRegime = (vol: number, thresholds?: RegimeThresholds): V7Regime => {
  const t = thresholds ?? configuredThresholds;
  if (vol < t.calmBelow) return "calm";
  if (vol > t.stressAbove) return "stress";
  return "normal";
};

const fetchDVOL = async (): Promise<{ dvol: number | null; timestamp: number | null }> => {
  if (!deribitConnectorInstance) return { dvol: null, timestamp: null };
  try {
    return await deribitConnectorInstance.getDVOL("BTC");
  } catch {
    return { dvol: null, timestamp: null };
  }
};

const fetchRVol = async (): Promise<{ rvol: number | null }> => {
  if (!deribitConnectorInstance) return { rvol: null };
  try {
    return await deribitConnectorInstance.getHistoricalVolatility("BTC");
  } catch {
    return { rvol: null };
  }
};

export const getCurrentRegime = async (params?: {
  forceRefresh?: boolean;
  thresholds?: RegimeThresholds;
}): Promise<V7RegimeStatus> => {
  const now = Date.now();
  if (!params?.forceRefresh && cachedRegime && cachedRegime.expiresAtMs > now) {
    return cachedRegime.status;
  }

  const thresholds = params?.thresholds ?? configuredThresholds;
  const [dvolResult, rvolResult] = await Promise.all([fetchDVOL(), fetchRVol()]);

  let regime: V7Regime;
  let source: V7RegimeSource;

  if (dvolResult.dvol !== null) {
    regime = classifyRegime(dvolResult.dvol, thresholds);
    source = "dvol";
    // Feed Design A's pricing-regime rolling window with each fresh
    // DVOL reading so quote-time pricing has up-to-date 1h-rolling
    // average available without each quote re-fetching.
    recordDvolSample(dvolResult.dvol);
  } else if (rvolResult.rvol !== null) {
    regime = classifyRegime(rvolResult.rvol, thresholds);
    source = "rvol";
    // RVOL is not a perfect proxy for DVOL but it's our best signal
    // when DVOL is unavailable. Record so pricing has *some* data.
    recordDvolSample(rvolResult.rvol);
  } else {
    regime = "normal";
    source = "rvol";
  }

  const previousRegime = cachedRegime?.status.regime ?? null;
  const regimeChanged = previousRegime !== null && previousRegime !== regime;

  const status: V7RegimeStatus = {
    regime,
    dvol: dvolResult.dvol,
    rvol: rvolResult.rvol,
    source,
    timestamp: new Date().toISOString()
  };

  cachedRegime = { status, expiresAtMs: now + CACHE_TTL_MS };

  if (regimeChanged) {
    console.log(
      `[RegimeClassifier] *** REGIME CHANGED: ${previousRegime} → ${regime} *** dvol=${dvolResult.dvol ?? "N/A"} rvol=${rvolResult.rvol ?? "N/A"}`
    );
  } else {
    console.log(
      `[RegimeClassifier] regime=${regime} source=${source} dvol=${dvolResult.dvol ?? "N/A"} rvol=${rvolResult.rvol ?? "N/A"}`
    );
  }

  return status;
};

export const __resetRegimeClassifierForTests = (): void => {
  cachedRegime = null;
  deribitConnectorInstance = null;
  configuredThresholds = { ...DEFAULT_THRESHOLDS };
};

export const __setCachedRegimeForTests = (status: V7RegimeStatus, ttlMs = CACHE_TTL_MS): void => {
  cachedRegime = { status, expiresAtMs: Date.now() + ttlMs };
};
