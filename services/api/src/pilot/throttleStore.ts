/**
 * Per-fingerprint throttle store (WS#3 of Bundle C cutover).
 *
 * In-process LRU map keyed on fingerprint, used for anti-bot defenses:
 *   - Random-jitter activate cooldown (60-360s, prevents scripted timing)
 *   - Trigger-induced 4h fingerprint cooldown (Layer 3 of opposing-perp defense)
 *   - Quote dedup via content hash (Layer 2)
 *   - Quote/activate ratio surveillance (for Layer 4 surcharge detection)
 *   - Concurrent open count per fingerprint
 *
 * In-process is fine for the single-Render-instance pilot. Upgrade
 * path to Redis when multi-instance.
 *
 * Privacy: state expires at TTL boundaries; nothing persisted beyond
 * memory; restart loses state (acceptable for pilot scale).
 */

const MAX_FINGERPRINT_KEYS = 10_000;
const QUOTE_HASH_RETENTION_MS = 60 * 60 * 1000; // 1 hour for ratio analysis
const ACTIVATE_COOLDOWN_MIN_MS = 60_000; // 60s base
const ACTIVATE_COOLDOWN_JITTER_RANGE_MS = 270_000; // +0..270s = 60..330s total
const TRIGGER_INDUCED_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h after trigger
const QUOTE_DEDUP_TTL_MS = 30_000; // 30s — cached quote returned during this window
const SURCHARGE_PATTERN_DURATION_MS = 24 * 60 * 60 * 1000; // 24h surcharge once detected

export type FingerprintState = {
  combined: string;
  lastQuoteAtMs: number | null;
  lastActivateAtMs: number | null;
  /** Cooldown imposed by last activate; expires at this absolute ms */
  nextActivateAllowedAtMs: number | null;
  /** Cooldown imposed by trigger event; expires at this absolute ms */
  nextActivateAllowedAfterTriggerMs: number | null;
  /** Quote params hashes seen in last hour, for ratio analysis */
  quoteHashes: Array<{ hash: string; ms: number }>;
  /** Activate count in last hour */
  activateTimesMs: number[];
  /** Currently active 2% protections (regardless of side) — used for opposite-side block */
  active2PctProtections: Array<{ side: "long" | "short"; protectionId: string; openedMs: number }>;
  /** Surcharge applied due to suspicious pattern; expires at this absolute ms */
  surchargeUntilMs: number | null;
  /** When this fingerprint was first seen (for LRU eviction priority) */
  createdAtMs: number;
  /** Last time this fingerprint was touched (for LRU) */
  lastTouchAtMs: number;
};

const store = new Map<string, FingerprintState>();

const newState = (combined: string, nowMs: number): FingerprintState => ({
  combined,
  lastQuoteAtMs: null,
  lastActivateAtMs: null,
  nextActivateAllowedAtMs: null,
  nextActivateAllowedAfterTriggerMs: null,
  quoteHashes: [],
  activateTimesMs: [],
  active2PctProtections: [],
  surchargeUntilMs: null,
  createdAtMs: nowMs,
  lastTouchAtMs: nowMs
});

const evictLruIfFull = (): void => {
  if (store.size < MAX_FINGERPRINT_KEYS) return;
  // Find oldest lastTouchAtMs and evict
  let oldestKey: string | null = null;
  let oldestMs = Infinity;
  for (const [k, v] of store) {
    if (v.lastTouchAtMs < oldestMs) {
      oldestMs = v.lastTouchAtMs;
      oldestKey = k;
    }
  }
  if (oldestKey) store.delete(oldestKey);
};

const getOrCreate = (fp: string, nowMs: number): FingerprintState => {
  const existing = store.get(fp);
  if (existing) {
    existing.lastTouchAtMs = nowMs;
    return existing;
  }
  evictLruIfFull();
  const fresh = newState(fp, nowMs);
  store.set(fp, fresh);
  return fresh;
};

const purgeExpiredQuoteHashes = (s: FingerprintState, nowMs: number): void => {
  const cutoff = nowMs - QUOTE_HASH_RETENTION_MS;
  s.quoteHashes = s.quoteHashes.filter((q) => q.ms >= cutoff);
  s.activateTimesMs = s.activateTimesMs.filter((t) => t >= cutoff);
};

// ── Public API ──

export type ThrottleVerdict = {
  allowed: boolean;
  reason: string | null;
  retryAfterMs: number | null;
  surchargeMultiplier: number;
};

const ALLOWED_OK: ThrottleVerdict = {
  allowed: true, reason: null, retryAfterMs: null, surchargeMultiplier: 1.0
};

/**
 * Layer 1 — opposing-perp defense.
 *
 * Block a new 2% protection if the fingerprint already has an active
 * 2% on the OPPOSITE side. Same direction is fine; only opposing is blocked.
 */
export const checkOpposingProtectionBlock = (params: {
  fingerprint: string;
  newSide: "long" | "short";
  slPct: number;
  nowMs?: number;
}): ThrottleVerdict => {
  if (params.slPct !== 2) return ALLOWED_OK; // Layer 1 currently 2%-only
  const nowMs = params.nowMs ?? Date.now();
  const s = getOrCreate(params.fingerprint, nowMs);
  const opposing = s.active2PctProtections.find(
    (p) => p.side !== params.newSide
  );
  if (opposing) {
    return {
      allowed: false,
      reason: "opposing_protection_active",
      retryAfterMs: null,
      surchargeMultiplier: 1.0
    };
  }
  return ALLOWED_OK;
};

/**
 * Layer 2 — random-jitter activate cooldown.
 *
 * After any activate, impose a base 60s + random 0-270s jitter cooldown
 * before next activate from same fingerprint. Throws off scripted timing.
 */
export const checkActivateCooldown = (params: {
  fingerprint: string;
  nowMs?: number;
}): ThrottleVerdict => {
  const nowMs = params.nowMs ?? Date.now();
  const s = getOrCreate(params.fingerprint, nowMs);

  // Layer 3: trigger-induced cooldown
  if (s.nextActivateAllowedAfterTriggerMs !== null && s.nextActivateAllowedAfterTriggerMs > nowMs) {
    return {
      allowed: false,
      reason: "trigger_cooldown_active",
      retryAfterMs: s.nextActivateAllowedAfterTriggerMs - nowMs,
      surchargeMultiplier: 1.0
    };
  }

  // Layer 2: jitter cooldown from prior activate
  if (s.nextActivateAllowedAtMs !== null && s.nextActivateAllowedAtMs > nowMs) {
    return {
      allowed: false,
      reason: "activate_cooldown",
      retryAfterMs: s.nextActivateAllowedAtMs - nowMs,
      surchargeMultiplier: 1.0
    };
  }

  return ALLOWED_OK;
};

/**
 * Layer 4 — pattern-detect surcharge.
 *
 * Returns the surcharge multiplier (1.0 = no surcharge, 1.5 = 50% surcharge)
 * to apply to a new quote. Surcharge is in effect when a suspicious
 * pattern was detected within the last 24h.
 */
export const getQuoteSurcharge = (params: {
  fingerprint: string;
  nowMs?: number;
}): number => {
  const nowMs = params.nowMs ?? Date.now();
  const s = getOrCreate(params.fingerprint, nowMs);
  if (s.surchargeUntilMs !== null && s.surchargeUntilMs > nowMs) {
    return 1.5;
  }
  return 1.0;
};

/**
 * Record an activate event. Sets the next-activate cooldown.
 */
export const recordActivate = (params: {
  fingerprint: string;
  side?: "long" | "short";
  slPct?: number;
  protectionId?: string;
  nowMs?: number;
  /**
   * Random function — injectable for deterministic tests.
   * Returns a value in [0, 1).
   */
  random?: () => number;
}): void => {
  const nowMs = params.nowMs ?? Date.now();
  const random = params.random ?? Math.random;
  const s = getOrCreate(params.fingerprint, nowMs);
  purgeExpiredQuoteHashes(s, nowMs);

  s.lastActivateAtMs = nowMs;
  s.activateTimesMs.push(nowMs);

  // Layer 2: random-jitter cooldown
  const jitterMs = Math.floor(random() * ACTIVATE_COOLDOWN_JITTER_RANGE_MS);
  s.nextActivateAllowedAtMs = nowMs + ACTIVATE_COOLDOWN_MIN_MS + jitterMs;

  // Track active 2% protections for opposite-side block
  if (params.slPct === 2 && params.side && params.protectionId) {
    s.active2PctProtections.push({
      side: params.side,
      protectionId: params.protectionId,
      openedMs: nowMs
    });
  }
};

/**
 * Record a quote event. Used for quote/activate ratio surveillance and
 * dedup window.
 *
 * Returns true if quote was deduplicated (same params seen recently).
 */
export const recordQuote = (params: {
  fingerprint: string;
  paramsHash: string;
  nowMs?: number;
}): { deduplicated: boolean; suspicionDetected: boolean } => {
  const nowMs = params.nowMs ?? Date.now();
  const s = getOrCreate(params.fingerprint, nowMs);
  purgeExpiredQuoteHashes(s, nowMs);

  s.lastQuoteAtMs = nowMs;

  // Dedup check: same params hash within QUOTE_DEDUP_TTL_MS = dedup
  const recentSameHash = s.quoteHashes.find(
    (q) => q.hash === params.paramsHash && q.ms >= nowMs - QUOTE_DEDUP_TTL_MS
  );
  const deduplicated = !!recentSameHash;
  if (!deduplicated) {
    s.quoteHashes.push({ hash: params.paramsHash, ms: nowMs });
  }

  // Suspicion check: pattern matches surcharge criteria?
  // Currently: > 50:1 quote-to-activate ratio over last 50+ quotes
  let suspicionDetected = false;
  if (s.quoteHashes.length >= 50) {
    const ratio = s.quoteHashes.length / Math.max(1, s.activateTimesMs.length);
    if (ratio > 50) {
      suspicionDetected = true;
      s.surchargeUntilMs = nowMs + SURCHARGE_PATTERN_DURATION_MS;
    }
  }

  return { deduplicated, suspicionDetected };
};

/**
 * Record a trigger event for a protection owned by this fingerprint.
 * Imposes the 4h post-trigger cooldown (Layer 3).
 */
export const recordTrigger = (params: {
  fingerprint: string;
  protectionId: string;
  nowMs?: number;
}): void => {
  const nowMs = params.nowMs ?? Date.now();
  const s = getOrCreate(params.fingerprint, nowMs);
  s.nextActivateAllowedAfterTriggerMs = nowMs + TRIGGER_INDUCED_COOLDOWN_MS;
  // Remove triggered protection from active list
  s.active2PctProtections = s.active2PctProtections.filter(
    (p) => p.protectionId !== params.protectionId
  );
};

/**
 * Record a protection close (expiry, manual close, etc.). Removes from
 * active list so opposite-side block can be lifted.
 */
export const recordProtectionClose = (params: {
  fingerprint: string;
  protectionId: string;
  nowMs?: number;
}): void => {
  const nowMs = params.nowMs ?? Date.now();
  const s = getOrCreate(params.fingerprint, nowMs);
  s.active2PctProtections = s.active2PctProtections.filter(
    (p) => p.protectionId !== params.protectionId
  );
};

/**
 * Diagnostic snapshot of a fingerprint's state. Used by admin endpoint
 * /pilot/admin/diagnostics/fingerprint/:fp.
 */
export const getFingerprintDiagnostics = (fingerprint: string): FingerprintState | null => {
  return store.get(fingerprint) ? { ...store.get(fingerprint)! } : null;
};

/**
 * Aggregate stats for /pilot/admin/diagnostics/fingerprint-stats.
 */
export const getThrottleStats = (): {
  totalFingerprints: number;
  withActiveCooldown: number;
  withTriggerCooldown: number;
  withSurcharge: number;
  withActiveProtections: number;
} => {
  const nowMs = Date.now();
  let withActiveCooldown = 0;
  let withTriggerCooldown = 0;
  let withSurcharge = 0;
  let withActiveProtections = 0;
  for (const s of store.values()) {
    if (s.nextActivateAllowedAtMs !== null && s.nextActivateAllowedAtMs > nowMs) withActiveCooldown++;
    if (s.nextActivateAllowedAfterTriggerMs !== null && s.nextActivateAllowedAfterTriggerMs > nowMs) withTriggerCooldown++;
    if (s.surchargeUntilMs !== null && s.surchargeUntilMs > nowMs) withSurcharge++;
    if (s.active2PctProtections.length > 0) withActiveProtections++;
  }
  return {
    totalFingerprints: store.size,
    withActiveCooldown,
    withTriggerCooldown,
    withSurcharge,
    withActiveProtections
  };
};

/**
 * Test helper — clear store between tests.
 */
export const __resetThrottleStoreForTests = (): void => {
  store.clear();
};

/**
 * Compute a stable hash for quote dedup. Includes the parameters that
 * uniquely identify a "same quote": notional, sl, direction, asset.
 */
export const computeQuoteParamsHash = (params: {
  protectedNotional: number;
  slPct: number;
  protectionType: string;
  marketId: string;
}): string => {
  const canonical = `${params.protectedNotional}|${params.slPct}|${params.protectionType}|${params.marketId}`;
  // Quick hash; doesn't need to be cryptographic — just stable
  let hash = 0;
  for (let i = 0; i < canonical.length; i++) {
    hash = ((hash << 5) - hash) + canonical.charCodeAt(i);
    hash |= 0;
  }
  return `qh_${(hash >>> 0).toString(36)}`;
};
