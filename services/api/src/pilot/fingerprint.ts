import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

/**
 * Per-trader fingerprint resolution (WS#3 of Bundle C cutover).
 *
 * Combines several signals into a stable per-trader identifier used by
 * the anti-bot defense (throttleStore) to enforce per-trader rules even
 * though the pilot is single-tenant at the database level.
 *
 * Layered identity (best signal wins):
 *
 *   1. Foxify trader binding (X-Foxify-Trader-ID + signature) — strongest;
 *      survives browser rotation and IP rotation. Requires Foxify
 *      integration (see docs/foxify-pilot-bundle-c/08_FOXIFY_LAYER6_INTEGRATION_SPEC.md).
 *
 *   2. Browser fingerprint (X-Atticus-Client-Fingerprint header from the
 *      widget) — sourced from FingerprintJS or equivalent client library.
 *      Stable for same browser/device; defeated by browser rotation.
 *
 *   3. Persistent session ID (X-Atticus-Session-ID cookie/localStorage) —
 *      survives tab close; cleared by manual cookie wipe.
 *
 *   4. Network identity (IP subnet + truncated User-Agent) — fallback
 *      when no client cooperation; weakest signal but always available.
 *
 * The combined fingerprint is SHA-256 of all available layer values
 * concatenated, deterministic and prefix-stable. Anti-bot rules enforce
 * against this combined fingerprint regardless of which layers are
 * present.
 *
 * Privacy: no PII stored; no raw IPs logged; no fingerprints persisted
 * beyond throttle-window TTLs (15 minutes for activation cooldown,
 * 24 hours for trigger cooldown).
 */

export type FingerprintSources = {
  foxifyTraderId: string | null;
  browserFingerprint: string | null;
  sessionId: string | null;
  ipSubnet: string | null;
  userAgentHash: string | null;
};

export type FingerprintResolution = {
  /** Combined SHA-256 fingerprint, prefixed with strongest layer */
  combined: string;
  /** Which layer dominated (for observability) */
  primaryLayer: "foxify_trader" | "browser_fp" | "session_id" | "ip_ua_fallback";
  /** Raw sources captured (for debug logging; never persisted as-is) */
  sources: FingerprintSources;
};

const FOXIFY_SHARED_SECRET_ENV = "PILOT_FOXIFY_SHARED_SECRET";
const FOXIFY_TIMESTAMP_TOLERANCE_SEC = 300; // ±5 minutes per spec

/**
 * Verify the Foxify trader signature using the shared HMAC secret.
 * Returns the trader ID if valid, null if invalid/missing.
 *
 * Canonical signing string (per spec):
 *   ${X-Foxify-Trader-ID}:${X-Foxify-Timestamp}:${request-method}:${request-path}
 */
export const verifyFoxifyTraderSignature = (params: {
  traderId: string | null;
  timestampSec: number | null;
  signature: string | null;
  method: string;
  path: string;
  sharedSecret: string;
  nowSec?: number;
}): string | null => {
  const { traderId, timestampSec, signature, method, path, sharedSecret } = params;
  const nowSec = params.nowSec ?? Math.floor(Date.now() / 1000);

  if (!traderId || !timestampSec || !signature || !sharedSecret) return null;

  // Replay protection: timestamp must be within tolerance window
  if (Math.abs(nowSec - timestampSec) > FOXIFY_TIMESTAMP_TOLERANCE_SEC) {
    return null;
  }

  const canonical = `${traderId}:${timestampSec}:${method}:${path}`;
  const expected = createHmac("sha256", sharedSecret)
    .update(canonical)
    .digest("hex");

  // Constant-time compare
  let match = false;
  try {
    const a = Buffer.from(signature, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return null;
    match = timingSafeEqual(a, b);
  } catch {
    return null;
  }
  return match ? traderId : null;
};

/**
 * Truncate IP to a /24 (IPv4) or /48 (IPv6) prefix to capture network
 * identity without persisting full IPs (light privacy guard).
 */
const truncateIp = (rawIp: string | undefined): string | null => {
  if (!rawIp || typeof rawIp !== "string") return null;
  const ip = rawIp.trim();
  if (!ip) return null;
  // IPv4
  const v4 = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
  if (v4) return `${v4[1]}.0/24`;
  // IPv6 — first 3 hextets = /48 prefix
  const v6Parts = ip.split(":");
  if (v6Parts.length >= 3) {
    return `${v6Parts.slice(0, 3).join(":")}::/48`;
  }
  return ip; // give up; use raw
};

/**
 * Hash a user-agent string into a short stable token.
 * Doesn't persist the raw UA; just a hash usable for fingerprint diff.
 */
const hashUserAgent = (ua: string | undefined): string | null => {
  if (!ua || typeof ua !== "string") return null;
  return createHash("sha256").update(ua).digest("hex").slice(0, 16);
};

/**
 * Extract a header value safely as a string (handles array-style headers
 * by taking the first value).
 */
const getHeader = (req: FastifyRequest, name: string): string | null => {
  const v = req.headers[name.toLowerCase()];
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v[0]?.toString() ?? null;
  return v.toString();
};

const getClientIp = (req: FastifyRequest): string | undefined => {
  // Trust proxy headers if PILOT_TRUST_PROXY=true
  if (process.env.PILOT_TRUST_PROXY === "true") {
    const xff = getHeader(req, "x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
  }
  return req.ip;
};

/**
 * Resolve the per-trader fingerprint for an incoming request. Combines
 * up to 4 identity layers; produces a deterministic combined hash.
 */
export const resolveClientFingerprint = (req: FastifyRequest): FingerprintResolution => {
  // Layer 1: Foxify trader binding (signed)
  const sharedSecret = process.env[FOXIFY_SHARED_SECRET_ENV] || "";
  const foxifyTraderIdRaw = getHeader(req, "x-foxify-trader-id");
  const foxifyTimestampRaw = getHeader(req, "x-foxify-timestamp");
  const foxifySignatureRaw = getHeader(req, "x-foxify-trader-signature");
  const foxifyTraderId = sharedSecret
    ? verifyFoxifyTraderSignature({
        traderId: foxifyTraderIdRaw,
        timestampSec: foxifyTimestampRaw ? Number(foxifyTimestampRaw) : null,
        signature: foxifySignatureRaw,
        method: req.method,
        path: req.url.split("?")[0],
        sharedSecret
      })
    : null;

  // Layer 2: Browser fingerprint header (from FingerprintJS in widget)
  const browserFingerprint = getHeader(req, "x-atticus-client-fingerprint");

  // Layer 3: Persistent session ID
  const sessionId = getHeader(req, "x-atticus-session-id");

  // Layer 4: IP subnet + UA hash fallback
  const ipSubnet = truncateIp(getClientIp(req));
  const userAgentHash = hashUserAgent(getHeader(req, "user-agent") ?? undefined);

  const sources: FingerprintSources = {
    foxifyTraderId,
    browserFingerprint,
    sessionId,
    ipSubnet,
    userAgentHash
  };

  let primaryLayer: FingerprintResolution["primaryLayer"];
  let prefix: string;
  if (foxifyTraderId) {
    primaryLayer = "foxify_trader";
    prefix = "fxt";
  } else if (browserFingerprint) {
    primaryLayer = "browser_fp";
    prefix = "fbp";
  } else if (sessionId) {
    primaryLayer = "session_id";
    prefix = "sid";
  } else {
    primaryLayer = "ip_ua_fallback";
    prefix = "ipu";
  }

  // Combined hash uses ALL available signals so two requests from the
  // same trader through different layer-2/3 signals still tie back via
  // any shared layer.
  const components = [
    foxifyTraderId || "",
    browserFingerprint || "",
    sessionId || "",
    ipSubnet || "",
    userAgentHash || ""
  ];
  const combined = `${prefix}_${createHash("sha256").update(components.join("|")).digest("hex").slice(0, 32)}`;

  return { combined, primaryLayer, sources };
};

/**
 * Scrub a fingerprint resolution for safe logging (no PII).
 */
export const fingerprintForLog = (fp: FingerprintResolution): {
  combined: string;
  primaryLayer: string;
  hasFoxifyTrader: boolean;
  hasBrowserFp: boolean;
  hasSessionId: boolean;
  hasIpUa: boolean;
} => ({
  combined: fp.combined,
  primaryLayer: fp.primaryLayer,
  hasFoxifyTrader: fp.sources.foxifyTraderId !== null,
  hasBrowserFp: fp.sources.browserFingerprint !== null,
  hasSessionId: fp.sources.sessionId !== null,
  hasIpUa: fp.sources.ipSubnet !== null
});
