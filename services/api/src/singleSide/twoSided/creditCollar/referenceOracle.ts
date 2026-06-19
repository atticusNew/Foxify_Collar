/**
 * Reference-price oracle core — Phase A (pure, offline, default-off). Builds to the canonical §6
 * spec: ONE signed, timestamped, multi-source median feed serving BOTH Foxify's perp marks/stops
 * and collar settlement, so basis risk ≈ 0. Two outputs from one pipeline:
 *   - streaming median  → marks/stops (with tick-persistence on triggers, anti-wick)
 *   - settlement TWAP   → 15–30 min window struck at Bullish's daily option-expiry time
 *
 * Manipulation resistance + integrity:
 *   - freshness: drop samples older than freshnessMaxMs (default 5s)
 *   - MAD outlier rejection (median absolute deviation, relative floor)
 *   - hard min sources: fail-CLOSED below minSources (default 3) → halt new activations / freeze
 *   - full sample + signature persistence so Foxify can INDEPENDENTLY recompute and audit
 *
 * This is the pure core (no I/O). Production wires it to feedAggregator + resolvePriceSnapshot
 * (Bullish + Deribit + 2–3 CEXs); those existing files are NOT modified. Default-off: shadow-prove
 * reproducibility, manipulation-resistance, and degradation before any capital.
 */

import { createSign, createVerify, generateKeyPairSync } from "node:crypto";

export type PriceSample = {
  source: string;
  priceUsd: number;
  tsMs: number;
};

export type OracleConfig = {
  freshnessMaxMs?: number;     // default 5000 — drop samples older than this
  minSources?: number;         // default 3 — hard floor; below this = fail-closed for activation
  madK?: number;               // default 5 — reject |x − median| > madK × MAD
  madRelFloorPct?: number;     // default 0.001 (0.1%) — MAD floor so a tight cluster still rejects fliers
};

export type OracleStatus = "healthy" | "degraded" | "halt";

export type OracleSnapshot = {
  asOfMs: number;
  status: OracleStatus;
  /** Median of usable sources. null only when nothing usable. */
  priceUsd: number | null;
  /** True iff usable sources ≥ minSources — the gate for opening new protection. */
  safeForActivation: boolean;
  usedSources: string[];
  droppedStale: string[];
  droppedOutliers: string[];
  config: Required<OracleConfig>;
  /** The exact usable samples that produced priceUsd — persisted for independent recomputation. */
  usableSamples: PriceSample[];
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const withDefaults = (c: OracleConfig = {}): Required<OracleConfig> => ({
  freshnessMaxMs: c.freshnessMaxMs ?? 5000,
  minSources: c.minSources ?? 3,
  madK: c.madK ?? 5,
  madRelFloorPct: c.madRelFloorPct ?? 0.001
});

/**
 * Aggregate raw samples into a signed-able snapshot: freshness drop → MAD outlier rejection →
 * min-source fail-closed. Pure + deterministic. `status`:
 *   healthy  : usable ≥ minSources (price valid; activation allowed)
 *   degraded : usable == minSources−1 (price for marks only; activation FROZEN)
 *   halt     : usable < minSources−1 (no trustworthy price; fail-closed)
 */
export const aggregateOracle = (samples: PriceSample[], nowMs: number, config: OracleConfig = {}): OracleSnapshot => {
  const cfg = withDefaults(config);

  const droppedStale: string[] = [];
  const fresh = samples.filter((s) => {
    const ok = Number.isFinite(s.priceUsd) && s.priceUsd > 0 && nowMs - s.tsMs <= cfg.freshnessMaxMs && nowMs - s.tsMs >= 0;
    if (!ok) droppedStale.push(s.source);
    return ok;
  });

  // MAD outlier rejection around the tentative median.
  const droppedOutliers: string[] = [];
  let usable: PriceSample[] = fresh;
  if (fresh.length >= 2) {
    const med = median(fresh.map((s) => s.priceUsd));
    const mad = median(fresh.map((s) => Math.abs(s.priceUsd - med)));
    const threshold = Math.max(cfg.madK * mad, med * cfg.madRelFloorPct);
    usable = fresh.filter((s) => {
      const ok = Math.abs(s.priceUsd - med) <= threshold;
      if (!ok) droppedOutliers.push(s.source);
      return ok;
    });
  }

  const usableCount = usable.length;
  const priceUsd = usableCount >= 1 ? median(usable.map((s) => s.priceUsd)) : null;

  let status: OracleStatus;
  if (usableCount >= cfg.minSources) status = "healthy";
  else if (usableCount === cfg.minSources - 1) status = "degraded";
  else status = "halt";

  return {
    asOfMs: nowMs,
    status,
    priceUsd: priceUsd != null ? +priceUsd.toFixed(2) : null,
    safeForActivation: usableCount >= cfg.minSources,
    usedSources: usable.map((s) => s.source),
    droppedStale,
    droppedOutliers,
    config: cfg,
    usableSamples: usable.map((s) => ({ ...s }))
  };
};

// ── Settlement TWAP ──────────────────────────────────────────────────────────

export type OracleTick = { tsMs: number; priceUsd: number };

/**
 * Time-weighted average of the streaming median over [windowStartMs, windowEndMs]. Each tick's price
 * is weighted by the time until the next tick (last tick weighted to the window end). Pure.
 * The settlement window (15–30 min) is struck at Bullish's daily expiry time in production.
 */
export const computeSettlementTwap = (
  ticks: OracleTick[],
  windowStartMs: number,
  windowEndMs: number
): { ok: true; twapUsd: number; ticksUsed: number; windowMs: number } | { ok: false; error: string } => {
  if (!(windowEndMs > windowStartMs)) return { ok: false, error: "invalid_window" };
  const inWindow = ticks
    .filter((t) => t.tsMs >= windowStartMs && t.tsMs <= windowEndMs && Number.isFinite(t.priceUsd) && t.priceUsd > 0)
    .sort((a, b) => a.tsMs - b.tsMs);
  if (inWindow.length === 0) return { ok: false, error: "no_ticks_in_window" };

  let weighted = 0;
  let totalDt = 0;
  for (let i = 0; i < inWindow.length; i++) {
    const t = inWindow[i];
    const nextMs = i + 1 < inWindow.length ? inWindow[i + 1].tsMs : windowEndMs;
    const dt = Math.max(0, nextMs - t.tsMs);
    weighted += t.priceUsd * dt;
    totalDt += dt;
  }
  // Degenerate (single tick at window end): fall back to simple mean.
  const twap = totalDt > 0 ? weighted / totalDt : inWindow.reduce((s, t) => s + t.priceUsd, 0) / inWindow.length;
  return { ok: true, twapUsd: +twap.toFixed(2), ticksUsed: inWindow.length, windowMs: windowEndMs - windowStartMs };
};

// ── Trigger tick-persistence (anti-wick) ─────────────────────────────────────

/**
 * Confirm a stop/trigger only if the streaming price stays beyond the barrier for `persistTicks`
 * CONSECUTIVE ticks — so a single manipulated wick doesn't fire it. Pure.
 *   down trigger: price <= barrier ; up trigger: price >= barrier.
 */
export const confirmTrigger = (
  ticks: OracleTick[],
  barrierUsd: number,
  side: "down" | "up",
  persistTicks: number
): { triggered: boolean; firstConfirmTsMs: number | null; maxRun: number } => {
  let run = 0;
  let maxRun = 0;
  let firstConfirm: number | null = null;
  for (const t of ticks) {
    const beyond = side === "down" ? t.priceUsd <= barrierUsd : t.priceUsd >= barrierUsd;
    if (beyond) {
      run += 1;
      maxRun = Math.max(maxRun, run);
      if (run >= persistTicks && firstConfirm == null) firstConfirm = t.tsMs;
    } else {
      run = 0;
    }
  }
  return { triggered: firstConfirm != null, firstConfirmTsMs: firstConfirm, maxRun };
};

// ── Audit: deterministic canonicalization + ASYMMETRIC (ECDSA) signature ──────
//
// The settlement oracle snapshot decides who pays whom — it needs NON-REPUDIATION, so it is signed
// ASYMMETRICALLY (ECDSA P-256). Atticus signs with a PRIVATE key; Foxify (or any third party) verifies
// with the PUBLIC key, CANNOT forge a snapshot, and Atticus CANNOT later repudiate a price it signed.
// (HMAC is deliberately NOT used here: it is symmetric, so a shared-secret holder could forge — fine
// for two-party API auth like FOXIFY_API_KEY_HMAC_SECRET, wrong for a settlement source-of-truth.)

/** Canonical, stable string for a snapshot so the signature is reproducible by Foxify. */
export const canonicalizeSnapshot = (snap: OracleSnapshot): string => {
  const samples = [...snap.usableSamples]
    .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.tsMs - b.tsMs))
    .map((s) => `${s.source}:${s.priceUsd}:${s.tsMs}`)
    .join(",");
  return [
    `asOf=${snap.asOfMs}`,
    `status=${snap.status}`,
    `price=${snap.priceUsd}`,
    `safe=${snap.safeForActivation}`,
    `samples=[${samples}]`
  ].join("|");
};

/** Generate an ECDSA P-256 keypair (PEM). Atticus keeps the private key; Foxify gets the public key. */
export const generateOracleKeyPair = (): { privateKeyPem: string; publicKeyPem: string } => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
};

/** Atticus signs a snapshot with its PRIVATE key (ECDSA/SHA-256). Returns a hex DER signature. */
export const signSnapshot = (snap: OracleSnapshot, privateKeyPem: string): string => {
  const signer = createSign("SHA256");
  signer.update(canonicalizeSnapshot(snap));
  signer.end();
  return signer.sign(privateKeyPem, "hex");
};

/** Anyone verifies with the PUBLIC key — cannot forge, and the signer cannot repudiate. */
export const verifySnapshot = (snap: OracleSnapshot, signatureHex: string, publicKeyPem: string): boolean => {
  try {
    const verifier = createVerify("SHA256");
    verifier.update(canonicalizeSnapshot(snap));
    verifier.end();
    return verifier.verify(publicKeyPem, signatureHex, "hex");
  } catch {
    return false;
  }
};

/**
 * Independent recomputation: re-aggregate from the PERSISTED usable samples and confirm the price
 * reproduces AND the ECDSA signature validates against Atticus's PUBLIC key — what Foxify (or an
 * auditor) runs to verify a settlement wasn't tampered with, without any secret that could forge.
 */
export const recomputeAndVerify = (
  persisted: { snapshot: OracleSnapshot; signatureHex: string },
  publicKeyPem: string
): { reproduced: boolean; signatureValid: boolean; recomputedPriceUsd: number | null } => {
  const snap = persisted.snapshot;
  const re = aggregateOracle(snap.usableSamples, snap.asOfMs, snap.config);
  const reproduced = re.priceUsd === snap.priceUsd && re.status === snap.status;
  const signatureValid = verifySnapshot(snap, persisted.signatureHex, publicKeyPem);
  return { reproduced, signatureValid, recomputedPriceUsd: re.priceUsd };
};
