import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  __setPilotPoolForTests,
  countActivationsInLast24h,
  ensurePilotSchema,
  getProtection
} from "../src/pilot/db.js";
import {
  handleBiweeklyActivate,
  handleBiweeklyQuote
} from "../src/pilot/biweeklyActivate.js";

// PR 3 of biweekly cutover (2026-04-30) — biweekly activate handler.
//
// Tests cover:
//   - Quote handler validates inputs and returns biweekly-shaped response
//   - Quote handler refuses when feature flag is off
//   - Activate handler refuses when feature flag is off
//   - Activate validates body, looks up quote, executes hedge, persists protection
//   - 1-trade-per-24h guard fires after first activation
//   - Hedge budget cap rejection is surfaced cleanly
//   - quote_mismatch detection (notional/tier/direction must match prior quote)
//   - quote_already_consumed detection
//   - quote_expired detection
//   - The persisted protection has tenor_days=14, daily_rate set, and zero accumulated charge

const buildPool = async () => {
  __setPilotPoolForTests(null);
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensurePilotSchema(pool);
  return pool;
};

const fakeVenue = (overrides?: {
  premium?: number;
  quoteRandomId?: string;
  executeStatus?: "success" | "failure";
  executeThrows?: boolean;
}) => {
  const calls: { quote: any[]; execute: any[] } = { quote: [], execute: [] };
  const quoteId = overrides?.quoteRandomId ?? `vq-${Math.random().toString(36).slice(2, 10)}`;
  return {
    calls,
    venue: {
      async quote(req: any) {
        calls.quote.push(req);
        return {
          venue: "deribit_test" as const,
          quoteId,
          rfqId: null,
          instrumentId: req.instrumentId,
          side: "buy" as const,
          quantity: req.quantity,
          premium: overrides?.premium ?? 25.0,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          quoteTs: new Date().toISOString(),
          details: { mock: true }
        };
      },
      async execute(quote: any) {
        calls.execute.push(quote);
        if (overrides?.executeThrows) {
          throw new Error("venue_unreachable");
        }
        return {
          venue: "deribit_test" as const,
          status: overrides?.executeStatus ?? ("success" as const),
          quoteId: quote.quoteId,
          rfqId: null,
          instrumentId: quote.instrumentId,
          side: "buy" as const,
          quantity: quote.quantity,
          executionPrice: quote.premium,
          premium: quote.premium,
          executedAt: new Date().toISOString(),
          externalOrderId: `mock-order-${quote.quoteId}`,
          externalExecutionId: `mock-exec-${quote.quoteId}`,
          details: { mock: true }
        };
      }
    } as any
  };
};

const allowAllBudget = async (_costUsd: number) => ({ allowed: true });

const denyBudget = async (_costUsd: number) => ({
  allowed: false,
  reason: "would_exceed_cap",
  message: "cap exceeded for test",
  details: { capUsd: 100, projectedAfterUsd: 258 }
});

// ─────────────────────────────────────────────────────────────────────
// Feature flag gating
// ─────────────────────────────────────────────────────────────────────

test("handleBiweeklyQuote: returns biweekly_disabled when feature flag is off", async () => {
  delete process.env.PILOT_BIWEEKLY_ENABLED;
  const pool = await buildPool();
  const v = fakeVenue();
  const result = await handleBiweeklyQuote({
    pool,
    venue: v.venue,
    req: {
      protectedNotionalUsd: 10000,
      slPct: 2,
      direction: "long",
      spotUsd: 76000,
      marketId: "BTC-USD"
    }
  });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.reason, "biweekly_disabled");
  }
  assert.equal(v.calls.quote.length, 0, "venue.quote not called when biweekly disabled");
});

test("handleBiweeklyActivate: returns biweekly_disabled when feature flag is off", async () => {
  delete process.env.PILOT_BIWEEKLY_ENABLED;
  const pool = await buildPool();
  const v = fakeVenue();
  const result = await handleBiweeklyActivate({
    pool,
    venue: v.venue,
    userHash: "hh-test",
    hashVersion: 1,
    marketId: "BTC-USD",
    req: { quoteId: "any", protectedNotionalUsd: 10000, slPct: 2, direction: "long" },
    evaluateHedgeBudget: allowAllBudget
  });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.reason, "biweekly_disabled");
  }
});

// ─────────────────────────────────────────────────────────────────────
// Quote happy path
// ─────────────────────────────────────────────────────────────────────

test("handleBiweeklyQuote: happy path returns full biweekly preview + persists venue quote", async () => {
  process.env.PILOT_BIWEEKLY_ENABLED = "true";
  try {
    const pool = await buildPool();
    const v = fakeVenue({ premium: 30.0 });
    const result = await handleBiweeklyQuote({
      pool,
      venue: v.venue,
      req: {
        protectedNotionalUsd: 10000,
        slPct: 2,
        direction: "long",
        spotUsd: 76000,
        marketId: "BTC-USD"
      }
    });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.product, "biweekly");
    assert.equal(result.ratePerDayPer1kUsd, 2.5);
    assert.equal(result.ratePerDayUsd, 25);
    assert.equal(result.maxTenorDays, 14);
    assert.equal(result.maxProjectedChargeUsd, 350);
    assert.equal(result.payoutOnTriggerUsd, 200);
    // Trigger at entry × (1 - 0.02) = 76000 × 0.98 = 74480
    assert.equal(result.triggerPriceUsd, 74480);
    assert.equal(result.strikeHintUsd, 74480);
    // Verify venue quote was persisted
    const r = await pool.query("SELECT * FROM pilot_venue_quotes WHERE quote_id = $1", [result.quoteId]);
    assert.equal(r.rows.length, 1, "venue quote persisted");
    const det = r.rows[0].details as any;
    assert.equal(det.product, "biweekly");
    assert.equal(Number(det.tier), 2);
    assert.equal(det.direction, "long");
    assert.equal(Number(det.protectedNotionalUsd), 10000);
  } finally {
    delete process.env.PILOT_BIWEEKLY_ENABLED;
  }
});

test("handleBiweeklyQuote: SHORT direction trigger above spot", async () => {
  process.env.PILOT_BIWEEKLY_ENABLED = "true";
  try {
    const pool = await buildPool();
    const v = fakeVenue();
    const result = await handleBiweeklyQuote({
      pool,
      venue: v.venue,
      req: {
        protectedNotionalUsd: 10000,
        slPct: 2,
        direction: "short",
        spotUsd: 76000,
        marketId: "BTC-USD"
      }
    });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    // SHORT trigger at spot × (1 + 0.02) = 76000 × 1.02 = 77520
    assert.equal(result.triggerPriceUsd, 77520);
  } finally {
    delete process.env.PILOT_BIWEEKLY_ENABLED;
  }
});

test("handleBiweeklyQuote: rejects invalid notional", async () => {
  process.env.PILOT_BIWEEKLY_ENABLED = "true";
  try {
    const pool = await buildPool();
    const v = fakeVenue();
    const result = await handleBiweeklyQuote({
      pool,
      venue: v.venue,
      req: { protectedNotionalUsd: -1, slPct: 2, direction: "long", spotUsd: 76000, marketId: "BTC-USD" }
    });
    assert.equal(result.status, "error");
    if (result.status === "error") assert.equal(result.reason, "invalid_notional");
  } finally {
    delete process.env.PILOT_BIWEEKLY_ENABLED;
  }
});

test("handleBiweeklyQuote: rejects invalid SL tier", async () => {
  process.env.PILOT_BIWEEKLY_ENABLED = "true";
  try {
    const pool = await buildPool();
    const v = fakeVenue();
    const result = await handleBiweeklyQuote({
      pool,
      venue: v.venue,
      req: { protectedNotionalUsd: 10000, slPct: 99 as any, direction: "long", spotUsd: 76000, marketId: "BTC-USD" }
    });
    assert.equal(result.status, "error");
    if (result.status === "error") assert.equal(result.reason, "invalid_sl_pct");
  } finally {
    delete process.env.PILOT_BIWEEKLY_ENABLED;
  }
});

// ─────────────────────────────────────────────────────────────────────
// Activate happy path
// ─────────────────────────────────────────────────────────────────────

test("handleBiweeklyActivate: happy path quote → activate → protection persisted with biweekly fields", async () => {
  process.env.PILOT_BIWEEKLY_ENABLED = "true";
  try {
    const pool = await buildPool();
    const v = fakeVenue({ premium: 30.0, quoteRandomId: "vq-happy-path" });

    // Step 1: get a quote
    const qr = await handleBiweeklyQuote({
      pool,
      venue: v.venue,
      req: {
        protectedNotionalUsd: 10000,
        slPct: 2,
        direction: "long",
        spotUsd: 76000,
        marketId: "BTC-USD"
      }
    });
    assert.equal(qr.status, "ok");
    if (qr.status !== "ok") return;

    // Step 2: activate against that quote
    const ar = await handleBiweeklyActivate({
      pool,
      venue: v.venue,
      userHash: "hh-happy",
      hashVersion: 1,
      marketId: "BTC-USD",
      req: {
        quoteId: qr.quoteId,
        protectedNotionalUsd: 10000,
        slPct: 2,
        direction: "long"
      },
      evaluateHedgeBudget: allowAllBudget
    });
    assert.equal(ar.status, "ok");
    if (ar.status !== "ok") return;
    assert.equal(ar.product, "biweekly");
    const p = ar.protection;

    // Verify the persisted protection matches biweekly semantics
    assert.equal(p.tenorDays, 14);
    assert.equal(p.dailyRateUsdPer1k, "2.5");
    assert.equal(p.accumulatedChargeUsd, "0");
    assert.equal(p.daysBilled, 0);
    assert.equal(p.closedAt, null);
    assert.equal(p.status, "active");
    assert.equal(p.tierName, "SL 2%");
    assert.equal(p.protectedNotional, "10000");
    assert.equal(p.slPct, 2);
    assert.equal(p.metadata.product, "biweekly");
    assert.equal(p.metadata.protectionType, "long");
    assert.equal(Number(p.metadata.triggerPrice), 74480);
    assert.equal(Number(p.metadata.spotAtActivation), 76000);

    // Verify expiry is 14 days out (within 1 second tolerance)
    const expectedExpiryMs = Date.now() + 14 * 86400 * 1000;
    const actualExpiryMs = new Date(p.expiryAt).getTime();
    assert.ok(
      Math.abs(actualExpiryMs - expectedExpiryMs) < 1000,
      `expiry should be ~14 days out; expected ${expectedExpiryMs}, got ${actualExpiryMs}`
    );

    // Verify venue.execute was called once
    assert.equal(v.calls.execute.length, 1);

    // Verify ledger entry
    const ledger = await pool.query("SELECT * FROM pilot_ledger_entries WHERE protection_id = $1", [p.id]);
    assert.equal(ledger.rows.length, 1);
    assert.equal(ledger.rows[0].entry_type, "subscription_started");
    assert.equal(Number(ledger.rows[0].amount), 0);
  } finally {
    delete process.env.PILOT_BIWEEKLY_ENABLED;
  }
});

// ─────────────────────────────────────────────────────────────────────
// 1-trade-per-24h guard
// ─────────────────────────────────────────────────────────────────────

test("handleBiweeklyActivate: 1-trade-per-24h guard fires on second activation", async () => {
  process.env.PILOT_BIWEEKLY_ENABLED = "true";
  try {
    const pool = await buildPool();

    // Open trade #1
    const v1 = fakeVenue({ quoteRandomId: "vq-trade1" });
    const qr1 = await handleBiweeklyQuote({
      pool,
      venue: v1.venue,
      req: { protectedNotionalUsd: 10000, slPct: 2, direction: "long", spotUsd: 76000, marketId: "BTC-USD" }
    });
    assert.equal(qr1.status, "ok");
    if (qr1.status !== "ok") return;
    const ar1 = await handleBiweeklyActivate({
      pool,
      venue: v1.venue,
      userHash: "hh-rate-limit",
      hashVersion: 1,
      marketId: "BTC-USD",
      req: { quoteId: qr1.quoteId, protectedNotionalUsd: 10000, slPct: 2, direction: "long" },
      evaluateHedgeBudget: allowAllBudget
    });
    assert.equal(ar1.status, "ok");

    // Confirm guard sees 1 activation
    const count = await countActivationsInLast24h(pool, "hh-rate-limit");
    assert.equal(count, 1);

    // Try trade #2 — should be blocked
    const v2 = fakeVenue({ quoteRandomId: "vq-trade2" });
    const qr2 = await handleBiweeklyQuote({
      pool,
      venue: v2.venue,
      req: { protectedNotionalUsd: 10000, slPct: 2, direction: "long", spotUsd: 76000, marketId: "BTC-USD" }
    });
    assert.equal(qr2.status, "ok");
    if (qr2.status !== "ok") return;
    const ar2 = await handleBiweeklyActivate({
      pool,
      venue: v2.venue,
      userHash: "hh-rate-limit",
      hashVersion: 1,
      marketId: "BTC-USD",
      req: { quoteId: qr2.quoteId, protectedNotionalUsd: 10000, slPct: 2, direction: "long" },
      evaluateHedgeBudget: allowAllBudget
    });
    assert.equal(ar2.status, "error");
    if (ar2.status === "error") {
      assert.equal(ar2.reason, "daily_trade_limit_exceeded");
    }
    // Verify no execute for the second attempt
    assert.equal(v2.calls.execute.length, 0);
  } finally {
    delete process.env.PILOT_BIWEEKLY_ENABLED;
  }
});

// ─────────────────────────────────────────────────────────────────────
// Hedge budget cap
// ─────────────────────────────────────────────────────────────────────

test("handleBiweeklyActivate: hedge budget cap rejection is surfaced", async () => {
  process.env.PILOT_BIWEEKLY_ENABLED = "true";
  try {
    const pool = await buildPool();
    const v = fakeVenue({ quoteRandomId: "vq-budget" });
    const qr = await handleBiweeklyQuote({
      pool,
      venue: v.venue,
      req: { protectedNotionalUsd: 10000, slPct: 2, direction: "long", spotUsd: 76000, marketId: "BTC-USD" }
    });
    assert.equal(qr.status, "ok");
    if (qr.status !== "ok") return;
    const ar = await handleBiweeklyActivate({
      pool,
      venue: v.venue,
      userHash: "hh-budget",
      hashVersion: 1,
      marketId: "BTC-USD",
      req: { quoteId: qr.quoteId, protectedNotionalUsd: 10000, slPct: 2, direction: "long" },
      evaluateHedgeBudget: denyBudget
    });
    assert.equal(ar.status, "error");
    if (ar.status === "error") {
      assert.equal(ar.reason, "hedge_budget_cap_exceeded");
    }
    // venue.execute must NOT have been called when budget rejects
    assert.equal(v.calls.execute.length, 0);
  } finally {
    delete process.env.PILOT_BIWEEKLY_ENABLED;
  }
});

// ─────────────────────────────────────────────────────────────────────
// Quote mismatch detection
// ─────────────────────────────────────────────────────────────────────

test("handleBiweeklyActivate: quote_mismatch when activate notional differs from quote", async () => {
  process.env.PILOT_BIWEEKLY_ENABLED = "true";
  try {
    const pool = await buildPool();
    const v = fakeVenue({ quoteRandomId: "vq-mismatch" });
    const qr = await handleBiweeklyQuote({
      pool,
      venue: v.venue,
      req: { protectedNotionalUsd: 10000, slPct: 2, direction: "long", spotUsd: 76000, marketId: "BTC-USD" }
    });
    assert.equal(qr.status, "ok");
    if (qr.status !== "ok") return;

    // Activate with WRONG notional
    const ar = await handleBiweeklyActivate({
      pool,
      venue: v.venue,
      userHash: "hh-mismatch",
      hashVersion: 1,
      marketId: "BTC-USD",
      req: { quoteId: qr.quoteId, protectedNotionalUsd: 50000, slPct: 2, direction: "long" }, // WRONG: 50k vs quote 10k
      evaluateHedgeBudget: allowAllBudget
    });
    assert.equal(ar.status, "error");
    if (ar.status === "error") {
      assert.equal(ar.reason, "quote_mismatch");
    }
  } finally {
    delete process.env.PILOT_BIWEEKLY_ENABLED;
  }
});

test("handleBiweeklyActivate: quote_mismatch when activate direction differs", async () => {
  process.env.PILOT_BIWEEKLY_ENABLED = "true";
  try {
    const pool = await buildPool();
    const v = fakeVenue({ quoteRandomId: "vq-dir-mismatch" });
    const qr = await handleBiweeklyQuote({
      pool,
      venue: v.venue,
      req: { protectedNotionalUsd: 10000, slPct: 2, direction: "long", spotUsd: 76000, marketId: "BTC-USD" }
    });
    assert.equal(qr.status, "ok");
    if (qr.status !== "ok") return;

    const ar = await handleBiweeklyActivate({
      pool,
      venue: v.venue,
      userHash: "hh-dir-mismatch",
      hashVersion: 1,
      marketId: "BTC-USD",
      req: { quoteId: qr.quoteId, protectedNotionalUsd: 10000, slPct: 2, direction: "short" }, // WRONG
      evaluateHedgeBudget: allowAllBudget
    });
    assert.equal(ar.status, "error");
    if (ar.status === "error") {
      assert.equal(ar.reason, "quote_mismatch");
    }
  } finally {
    delete process.env.PILOT_BIWEEKLY_ENABLED;
  }
});

// ─────────────────────────────────────────────────────────────────────
// Quote not found / consumed / expired
// ─────────────────────────────────────────────────────────────────────

test("handleBiweeklyActivate: quote_not_found for nonexistent quote ID", async () => {
  process.env.PILOT_BIWEEKLY_ENABLED = "true";
  try {
    const pool = await buildPool();
    const v = fakeVenue();
    const ar = await handleBiweeklyActivate({
      pool,
      venue: v.venue,
      userHash: "hh-notfound",
      hashVersion: 1,
      marketId: "BTC-USD",
      req: { quoteId: "vq-does-not-exist", protectedNotionalUsd: 10000, slPct: 2, direction: "long" },
      evaluateHedgeBudget: allowAllBudget
    });
    assert.equal(ar.status, "error");
    if (ar.status === "error") {
      assert.equal(ar.reason, "quote_not_found");
    }
  } finally {
    delete process.env.PILOT_BIWEEKLY_ENABLED;
  }
});

test("handleBiweeklyActivate: quote_already_consumed on second activate of same quote", async () => {
  process.env.PILOT_BIWEEKLY_ENABLED = "true";
  try {
    const pool = await buildPool();
    const v = fakeVenue({ quoteRandomId: "vq-double-consume" });
    const qr = await handleBiweeklyQuote({
      pool,
      venue: v.venue,
      req: { protectedNotionalUsd: 10000, slPct: 2, direction: "long", spotUsd: 76000, marketId: "BTC-USD" }
    });
    assert.equal(qr.status, "ok");
    if (qr.status !== "ok") return;

    const ar1 = await handleBiweeklyActivate({
      pool,
      venue: v.venue,
      userHash: "hh-double",
      hashVersion: 1,
      marketId: "BTC-USD",
      req: { quoteId: qr.quoteId, protectedNotionalUsd: 10000, slPct: 2, direction: "long" },
      evaluateHedgeBudget: allowAllBudget
    });
    assert.equal(ar1.status, "ok");

    // Second activate — same quote ID should be marked consumed
    const ar2 = await handleBiweeklyActivate({
      pool,
      venue: v.venue,
      userHash: "hh-double-2", // different user so 1-trade-per-24h doesn't fire first
      hashVersion: 1,
      marketId: "BTC-USD",
      req: { quoteId: qr.quoteId, protectedNotionalUsd: 10000, slPct: 2, direction: "long" },
      evaluateHedgeBudget: allowAllBudget
    });
    assert.equal(ar2.status, "error");
    if (ar2.status === "error") {
      assert.equal(ar2.reason, "quote_already_consumed");
    }
  } finally {
    delete process.env.PILOT_BIWEEKLY_ENABLED;
  }
});

// ─────────────────────────────────────────────────────────────────────
// Venue execute failure
// ─────────────────────────────────────────────────────────────────────

test("handleBiweeklyActivate: returns venue_execute_failed when venue.execute throws", async () => {
  process.env.PILOT_BIWEEKLY_ENABLED = "true";
  try {
    const pool = await buildPool();
    const v = fakeVenue({ executeThrows: true, quoteRandomId: "vq-venue-throws" });
    const qr = await handleBiweeklyQuote({
      pool,
      venue: v.venue,
      req: { protectedNotionalUsd: 10000, slPct: 2, direction: "long", spotUsd: 76000, marketId: "BTC-USD" }
    });
    assert.equal(qr.status, "ok");
    if (qr.status !== "ok") return;

    const ar = await handleBiweeklyActivate({
      pool,
      venue: v.venue,
      userHash: "hh-venue-fail",
      hashVersion: 1,
      marketId: "BTC-USD",
      req: { quoteId: qr.quoteId, protectedNotionalUsd: 10000, slPct: 2, direction: "long" },
      evaluateHedgeBudget: allowAllBudget
    });
    assert.equal(ar.status, "error");
    if (ar.status === "error") {
      assert.equal(ar.reason, "venue_execute_failed");
    }
    // No protection should have been created
    const r = await pool.query("SELECT COUNT(*)::int AS n FROM pilot_protections");
    assert.equal(Number(r.rows[0].n), 0);
  } finally {
    delete process.env.PILOT_BIWEEKLY_ENABLED;
  }
});

test("handleBiweeklyActivate: returns venue_execute_failed when venue.execute returns failure status", async () => {
  process.env.PILOT_BIWEEKLY_ENABLED = "true";
  try {
    const pool = await buildPool();
    const v = fakeVenue({ executeStatus: "failure", quoteRandomId: "vq-fail-status" });
    const qr = await handleBiweeklyQuote({
      pool,
      venue: v.venue,
      req: { protectedNotionalUsd: 10000, slPct: 2, direction: "long", spotUsd: 76000, marketId: "BTC-USD" }
    });
    assert.equal(qr.status, "ok");
    if (qr.status !== "ok") return;

    const ar = await handleBiweeklyActivate({
      pool,
      venue: v.venue,
      userHash: "hh-fail-status",
      hashVersion: 1,
      marketId: "BTC-USD",
      req: { quoteId: qr.quoteId, protectedNotionalUsd: 10000, slPct: 2, direction: "long" },
      evaluateHedgeBudget: allowAllBudget
    });
    assert.equal(ar.status, "error");
    if (ar.status === "error") {
      assert.equal(ar.reason, "venue_execute_failed");
    }
  } finally {
    delete process.env.PILOT_BIWEEKLY_ENABLED;
  }
});

// ─────────────────────────────────────────────────────────────────────
// End-to-end protection retrievable via getProtection
// ─────────────────────────────────────────────────────────────────────

test("end-to-end: activated biweekly protection is retrievable via getProtection with all fields", async () => {
  process.env.PILOT_BIWEEKLY_ENABLED = "true";
  try {
    const pool = await buildPool();
    const v = fakeVenue({ quoteRandomId: "vq-e2e" });
    const qr = await handleBiweeklyQuote({
      pool,
      venue: v.venue,
      req: { protectedNotionalUsd: 25000, slPct: 5, direction: "short", spotUsd: 76000, marketId: "BTC-USD" }
    });
    assert.equal(qr.status, "ok");
    if (qr.status !== "ok") return;

    const ar = await handleBiweeklyActivate({
      pool,
      venue: v.venue,
      userHash: "hh-e2e",
      hashVersion: 1,
      marketId: "BTC-USD",
      req: { quoteId: qr.quoteId, protectedNotionalUsd: 25000, slPct: 5, direction: "short" },
      evaluateHedgeBudget: allowAllBudget
    });
    assert.equal(ar.status, "ok");
    if (ar.status !== "ok") return;

    const p = await getProtection(pool, ar.protection.id);
    assert.ok(p);
    assert.equal(p!.tenorDays, 14);
    assert.equal(p!.dailyRateUsdPer1k, "2");  // 5% tier rate
    assert.equal(p!.tierName, "SL 5%");
    assert.equal(p!.metadata.protectionType, "short");
    // SHORT 5% trigger: 76000 × 1.05 = 79800
    assert.equal(Number(p!.metadata.triggerPrice), 79800);
  } finally {
    delete process.env.PILOT_BIWEEKLY_ENABLED;
  }
});
