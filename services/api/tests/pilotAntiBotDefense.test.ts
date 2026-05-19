import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { createHmac } from "node:crypto";
import {
  verifyFoxifyTraderSignature,
  resolveClientFingerprint,
  fingerprintForLog
} from "../src/pilot/fingerprint";
import {
  __resetThrottleStoreForTests,
  checkOpposingProtectionBlock,
  checkActivateCooldown,
  recordActivate,
  recordQuote,
  recordTrigger,
  recordProtectionClose,
  computeQuoteParamsHash,
  getQuoteSurcharge,
  getThrottleStats
} from "../src/pilot/throttleStore";

beforeEach(() => __resetThrottleStoreForTests());

// ── Foxify signature verification (Layer 6) ──

test("verifyFoxifyTraderSignature: valid signature returns trader ID", () => {
  const secret = "test_shared_secret";
  const traderId = "fxy_trader_123";
  const ts = Math.floor(Date.now() / 1000);
  const method = "POST";
  const path = "/pilot/protections/quote";
  const sig = createHmac("sha256", secret).update(`${traderId}:${ts}:${method}:${path}`).digest("hex");

  const result = verifyFoxifyTraderSignature({
    traderId, timestampSec: ts, signature: sig, method, path, sharedSecret: secret
  });
  assert.equal(result, traderId);
});

test("verifyFoxifyTraderSignature: tampered signature rejected", () => {
  const secret = "test_shared_secret";
  const result = verifyFoxifyTraderSignature({
    traderId: "fxy_trader_123",
    timestampSec: Math.floor(Date.now() / 1000),
    signature: "0".repeat(64),
    method: "POST",
    path: "/pilot/protections/quote",
    sharedSecret: secret
  });
  assert.equal(result, null);
});

test("verifyFoxifyTraderSignature: stale timestamp rejected (replay protection)", () => {
  const secret = "test_shared_secret";
  const traderId = "fxy_trader_123";
  const staleTs = Math.floor(Date.now() / 1000) - 1000; // > 5min old
  const sig = createHmac("sha256", secret).update(`${traderId}:${staleTs}:POST:/x`).digest("hex");
  const result = verifyFoxifyTraderSignature({
    traderId, timestampSec: staleTs, signature: sig, method: "POST", path: "/x", sharedSecret: secret
  });
  assert.equal(result, null);
});

test("verifyFoxifyTraderSignature: missing inputs returns null gracefully", () => {
  assert.equal(verifyFoxifyTraderSignature({
    traderId: null, timestampSec: 1, signature: "x", method: "GET", path: "/", sharedSecret: "s"
  }), null);
  assert.equal(verifyFoxifyTraderSignature({
    traderId: "t", timestampSec: 1, signature: "x", method: "GET", path: "/", sharedSecret: ""
  }), null);
});

// ── Fingerprint resolution ──

const mockReq = (headers: Record<string, string>, ip = "1.2.3.4"): any => ({
  headers,
  ip,
  url: "/pilot/protections/quote",
  method: "POST"
});

test("resolveClientFingerprint: fallback to IP+UA when no headers", () => {
  const fp = resolveClientFingerprint(mockReq({ "user-agent": "Mozilla/5.0" }));
  assert.equal(fp.primaryLayer, "ip_ua_fallback");
  assert.ok(fp.combined.startsWith("ipu_"));
  assert.equal(fp.sources.foxifyTraderId, null);
  assert.equal(fp.sources.browserFingerprint, null);
});

test("resolveClientFingerprint: browser fingerprint header recognized", () => {
  const fp = resolveClientFingerprint(mockReq({
    "user-agent": "Mozilla/5.0",
    "x-atticus-client-fingerprint": "fp_abc123"
  }));
  assert.equal(fp.primaryLayer, "browser_fp");
  assert.ok(fp.combined.startsWith("fbp_"));
});

test("resolveClientFingerprint: session ID recognized when no browser FP", () => {
  const fp = resolveClientFingerprint(mockReq({
    "x-atticus-session-id": "sess_xyz"
  }));
  assert.equal(fp.primaryLayer, "session_id");
  assert.ok(fp.combined.startsWith("sid_"));
});

test("resolveClientFingerprint: same IP+UA produces same fingerprint", () => {
  const fp1 = resolveClientFingerprint(mockReq({ "user-agent": "X" }, "10.0.0.1"));
  const fp2 = resolveClientFingerprint(mockReq({ "user-agent": "X" }, "10.0.0.1"));
  assert.equal(fp1.combined, fp2.combined);
});

test("resolveClientFingerprint: different /24 networks produce different fingerprints", () => {
  // /24 truncation means 10.0.0.1 and 10.0.0.2 hash to the SAME fingerprint
  // (intentional privacy guard — same network = same fingerprint).
  // Different /24 networks produce different fingerprints.
  const fp1 = resolveClientFingerprint(mockReq({ "user-agent": "X" }, "10.0.0.1"));
  const fp2 = resolveClientFingerprint(mockReq({ "user-agent": "X" }, "10.1.0.1"));
  assert.notEqual(fp1.combined, fp2.combined);
});

test("resolveClientFingerprint: same /24 network DOES produce same fingerprint (privacy guard)", () => {
  const fp1 = resolveClientFingerprint(mockReq({ "user-agent": "X" }, "10.0.0.1"));
  const fp2 = resolveClientFingerprint(mockReq({ "user-agent": "X" }, "10.0.0.99"));
  assert.equal(fp1.combined, fp2.combined,
    "/24 IP truncation must collapse same-subnet IPs to same fingerprint");
});

test("fingerprintForLog: scrubs PII (no raw IPs/UAs)", () => {
  const fp = resolveClientFingerprint(mockReq({ "user-agent": "Mozilla" }, "1.2.3.4"));
  const safe = fingerprintForLog(fp);
  const json = JSON.stringify(safe);
  assert.ok(!json.includes("1.2.3.4"), "Raw IP must not appear in log");
  assert.ok(!json.includes("Mozilla"), "Raw UA must not appear in log");
  assert.ok(safe.combined.length > 0);
});

// ── Throttle store: Layer 1 opposing-perp block ──

test("Layer 1: opposing 2% protection block — same direction OK", () => {
  recordActivate({ fingerprint: "fp1", side: "long", slPct: 2, protectionId: "p1" });
  const verdict = checkOpposingProtectionBlock({
    fingerprint: "fp1",
    newSide: "long",
    slPct: 2
  });
  assert.equal(verdict.allowed, true, "Same-side 2% should be allowed");
});

test("Layer 1: opposing 2% protection block — opposite direction BLOCKED", () => {
  recordActivate({ fingerprint: "fp1", side: "long", slPct: 2, protectionId: "p1" });
  const verdict = checkOpposingProtectionBlock({
    fingerprint: "fp1",
    newSide: "short",
    slPct: 2
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "opposing_protection_active");
});

test("Layer 1: opposing block does NOT apply to non-2% tiers", () => {
  recordActivate({ fingerprint: "fp1", side: "long", slPct: 5, protectionId: "p1" });
  const verdict = checkOpposingProtectionBlock({
    fingerprint: "fp1",
    newSide: "short",
    slPct: 5
  });
  assert.equal(verdict.allowed, true, "5% tier opposite-side is currently allowed");
});

test("Layer 1: protection close releases the block", () => {
  recordActivate({ fingerprint: "fp1", side: "long", slPct: 2, protectionId: "p1" });
  recordProtectionClose({ fingerprint: "fp1", protectionId: "p1" });
  const verdict = checkOpposingProtectionBlock({
    fingerprint: "fp1",
    newSide: "short",
    slPct: 2
  });
  assert.equal(verdict.allowed, true, "After close, opposite-side is allowed");
});

// ── Throttle store: Layer 2 random-jitter cooldown ──

test("Layer 2: activate cooldown blocks rapid second activate", () => {
  const fixedRandom = () => 0.5; // deterministic 50% jitter = +135s
  const now = 1_000_000;
  recordActivate({ fingerprint: "fp1", nowMs: now, random: fixedRandom });

  const verdict = checkActivateCooldown({ fingerprint: "fp1", nowMs: now + 1000 });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "activate_cooldown");
  // 60s base + 0.5 * 270s jitter = 60s + 135s = 195s; 1s in = 194s left
  assert.ok(verdict.retryAfterMs! > 100_000 && verdict.retryAfterMs! < 200_000);
});

test("Layer 2: cooldown elapses and allows subsequent activate", () => {
  const now = 1_000_000;
  recordActivate({ fingerprint: "fp1", nowMs: now, random: () => 0 });
  // 60s + 0 jitter = 60s cooldown; +61s elapses
  const verdict = checkActivateCooldown({ fingerprint: "fp1", nowMs: now + 61_000 });
  assert.equal(verdict.allowed, true);
});

test("Layer 2: jitter actually varies the cooldown window", () => {
  const now = 1_000_000;
  recordActivate({ fingerprint: "fp1", nowMs: now, random: () => 0 });
  const v0 = checkActivateCooldown({ fingerprint: "fp1", nowMs: now + 1 });

  __resetThrottleStoreForTests();
  recordActivate({ fingerprint: "fp1", nowMs: now, random: () => 0.99 });
  const v99 = checkActivateCooldown({ fingerprint: "fp1", nowMs: now + 1 });

  // Higher random → longer cooldown
  assert.ok(v99.retryAfterMs! > v0.retryAfterMs!);
});

// ── Throttle store: Layer 3 trigger-induced cooldown ──

test("Layer 3: trigger cooldown lasts 4 hours", () => {
  const now = 1_000_000;
  recordTrigger({ fingerprint: "fp1", protectionId: "p1", nowMs: now });
  const v1h = checkActivateCooldown({ fingerprint: "fp1", nowMs: now + 3600_000 });
  assert.equal(v1h.allowed, false);
  assert.equal(v1h.reason, "trigger_cooldown_active");
});

test("Layer 3: trigger cooldown elapses after 4h", () => {
  const now = 1_000_000;
  recordTrigger({ fingerprint: "fp1", protectionId: "p1", nowMs: now });
  const v4h1s = checkActivateCooldown({ fingerprint: "fp1", nowMs: now + (4 * 3600_000) + 1000 });
  assert.equal(v4h1s.allowed, true);
});

// ── Throttle store: quote dedup ──

test("Quote dedup: same params within 30s = deduplicated", () => {
  const hash = computeQuoteParamsHash({
    protectedNotional: 50000, slPct: 2, protectionType: "long", marketId: "BTC-USD"
  });
  const r1 = recordQuote({ fingerprint: "fp1", paramsHash: hash, nowMs: 1000 });
  assert.equal(r1.deduplicated, false, "First quote not deduplicated");

  const r2 = recordQuote({ fingerprint: "fp1", paramsHash: hash, nowMs: 5000 });
  assert.equal(r2.deduplicated, true, "Same hash 4s later = deduplicated");
});

test("Quote dedup: same params after 30s = NOT deduplicated", () => {
  const hash = computeQuoteParamsHash({
    protectedNotional: 50000, slPct: 2, protectionType: "long", marketId: "BTC-USD"
  });
  recordQuote({ fingerprint: "fp1", paramsHash: hash, nowMs: 1000 });
  const r2 = recordQuote({ fingerprint: "fp1", paramsHash: hash, nowMs: 35_000 });
  assert.equal(r2.deduplicated, false);
});

test("computeQuoteParamsHash: different params → different hashes", () => {
  const a = computeQuoteParamsHash({
    protectedNotional: 50000, slPct: 2, protectionType: "long", marketId: "BTC-USD"
  });
  const b = computeQuoteParamsHash({
    protectedNotional: 50000, slPct: 2, protectionType: "short", marketId: "BTC-USD"
  });
  assert.notEqual(a, b, "Different side should produce different hash");
});

// ── Throttle store: Layer 4 surcharge ──

test("Layer 4: high quote-to-activate ratio triggers surcharge", () => {
  // Spam 51 unique quotes with no activates → ratio 51:0 → triggers surcharge
  for (let i = 0; i < 51; i++) {
    const hash = computeQuoteParamsHash({
      protectedNotional: 10000 + i, slPct: 2, protectionType: "long", marketId: "BTC-USD"
    });
    recordQuote({ fingerprint: "fp_bot", paramsHash: hash, nowMs: 1000 + i * 100 });
  }
  const surcharge = getQuoteSurcharge({ fingerprint: "fp_bot", nowMs: 50_000 });
  assert.equal(surcharge, 1.5, "Bot pattern should trigger 1.5x surcharge");
});

test("Layer 4: normal trader (no spam pattern) gets no surcharge", () => {
  // Just a few quotes
  for (let i = 0; i < 5; i++) {
    const hash = computeQuoteParamsHash({
      protectedNotional: 10000 + i, slPct: 2, protectionType: "long", marketId: "BTC-USD"
    });
    recordQuote({ fingerprint: "fp_human", paramsHash: hash, nowMs: 1000 + i * 60_000 });
  }
  const surcharge = getQuoteSurcharge({ fingerprint: "fp_human" });
  assert.equal(surcharge, 1.0);
});

// ── Diagnostics ──

test("Throttle stats correctly count active states", () => {
  // Use real Date.now() for test setup since getThrottleStats() reads
  // real time internally (not parameterizable). Test must align.
  const now = Date.now();
  recordActivate({ fingerprint: "fp1", nowMs: now });
  recordTrigger({ fingerprint: "fp2", protectionId: "p2", nowMs: now });
  recordActivate({ fingerprint: "fp3", side: "long", slPct: 2, protectionId: "p3", nowMs: now });

  const stats = getThrottleStats();
  assert.equal(stats.totalFingerprints, 3);
  assert.equal(stats.withActiveProtections, 1, "fp3 has active 2% protection");
  assert.ok(stats.withActiveCooldown >= 2, "fp1 and fp3 have activate cooldowns");
  assert.equal(stats.withTriggerCooldown, 1, "fp2 has trigger cooldown");
});
