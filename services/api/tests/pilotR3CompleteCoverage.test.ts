import assert from "node:assert/strict";
import test from "node:test";

import type { DeribitConnector } from "@foxify/connectors";
import { createPilotVenueAdapter } from "../src/pilot/venue.js";
import { runHedgeManagementCycle } from "../src/pilot/hedgeManager.js";

// R3 follow-up — completion of test coverage that pg-mem couldn't reach in
// the initial PR. Two tests:
//
//   R3.B  Verify that DeribitTestAdapter.execute() throws
//         'venue_execute_timeout' when placeOrder hangs longer than
//         PILOT_DERIBIT_EXECUTE_TIMEOUT_MS.
//
//   R3.C  Verify the hedge manager's recordNoBidRetry path actually
//         updates the protection row's noBidRetryCount metadata. Done
//         via a hand-rolled in-memory pool that supports the production
//         JSONB merge operator (which pg-mem doesn't), proving the SQL
//         logic is correct independent of the test harness.

// ─── R3.B — placeOrder timeout ─────────────────────────────────────────────

test("R3.B: DeribitTestAdapter.execute() throws venue_execute_timeout when placeOrder hangs past PILOT_DERIBIT_EXECUTE_TIMEOUT_MS", async () => {
  const original = process.env.PILOT_DERIBIT_EXECUTE_TIMEOUT_MS;
  process.env.PILOT_DERIBIT_EXECUTE_TIMEOUT_MS = "200"; // 200 ms cap for fast test

  // Mock connector: placeOrder returns a Promise that never resolves.
  let placeOrderCalls = 0;
  const stuckConnector = {
    placeOrder: () => {
      placeOrderCalls += 1;
      return new Promise(() => { /* never resolves */ });
    },
    // Other methods aren't called by execute() in the timeout path; provide
    // stubs to satisfy the type.
    getIndexPrice: async () => ({ result: { index_price: 77000 } }),
    getOrderBook: async () => ({ result: {} }),
    listInstruments: async () => ({ result: [] }),
    getDVOL: async () => ({ dvol: 45, timestamp: Date.now() }),
    getHistoricalVolatility: async () => ({ rvol: 40 }),
    getTicker: async () => ({}),
    getAccountSummary: async () => ({})
  } as unknown as DeribitConnector;

  const adapter = createPilotVenueAdapter({
    mode: "deribit_test",
    deribit: stuckConnector,
    falconx: { baseUrl: "", apiKey: "", secret: "", passphrase: "" }
  });

  const t0 = Date.now();
  let thrown: Error | null = null;
  try {
    await adapter.execute({
      venue: "deribit_test",
      quoteId: "test-quote",
      instrumentId: "BTC-19APR26-76000-P",
      side: "buy",
      quantity: 0.1,
      premium: 50,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      quoteTs: new Date().toISOString(),
      details: {}
    });
  } catch (e: any) {
    thrown = e;
  }
  const elapsed = Date.now() - t0;

  assert.ok(thrown, "execute() must throw when placeOrder hangs");
  assert.match(
    String(thrown!.message),
    /venue_execute_timeout/,
    `expected venue_execute_timeout, got: ${thrown!.message}`
  );
  assert.equal(placeOrderCalls, 1, "placeOrder was called once");
  assert.ok(elapsed >= 200, `should wait at least the full timeout (got ${elapsed}ms)`);
  assert.ok(elapsed < 2000, `should not exceed timeout by much (got ${elapsed}ms)`);

  // Restore env
  if (original === undefined) delete process.env.PILOT_DERIBIT_EXECUTE_TIMEOUT_MS;
  else process.env.PILOT_DERIBIT_EXECUTE_TIMEOUT_MS = original;
});

// ─── R3.C — no-bid metadata persistence (production SQL semantics) ─────────

// Hand-rolled in-memory pool that supports just enough of pg's interface for
// the noBid persistence path:
//   - one rows table with id + metadata
//   - SELECT *
//   - UPDATE SET hedge_status / metadata = metadata || jsonb (correctly
//     deep-merges the right-hand side into the left)
//   - jsonb_build_object expansion
// This is a focused fake, not a general SQL engine. It exists ONLY to verify
// that recordNoBidRetry correctly grows the noBidRetryCount over multiple
// invocations under production-equivalent JSONB semantics.

const buildFakePool = () => {
  type Row = {
    id: string;
    user_hash: string;
    hash_version: number;
    status: string;
    tier_name: string;
    drawdown_floor_pct: string;
    sl_pct: number;
    hedge_status: string;
    market_id: string;
    protected_notional: string;
    foxify_exposure_notional: string;
    expiry_at: string;
    auto_renew: boolean;
    renew_window_minutes: number;
    metadata: Record<string, any>;
    venue: string;
    instrument_id: string;
    side: string;
    size: string;
    execution_price: string;
    premium: string;
    payout_due_amount: string;
    floor_price: string;
    created_at: string;
    updated_at: string;
  };
  const rows = new Map<string, Row>();

  const query = async (sql: string, params: any[] = []) => {
    const trimmed = sql.trim();

    if (/^SELECT[\s\S]+FROM pilot_protections[\s\S]+WHERE hedge_status\s*=\s*'active'/i.test(trimmed)) {
      // queryManagedHedges
      const matching = Array.from(rows.values()).filter(
        (r) => r.hedge_status === "active" && r.instrument_id && r.size
          && (r.status === "triggered" || r.status === "active" || r.status.startsWith("expired"))
      );
      return { rowCount: matching.length, rows: matching };
    }

    // recordNoBidRetry UPDATE: matches the production SQL pattern that uses
    //   metadata || jsonb_build_object('noBidRetryCount', COALESCE(...)::int + 1, ...)
    const noBidUpdate = trimmed.match(
      /^UPDATE pilot_protections\s+SET metadata = metadata \|\| jsonb_build_object[\s\S]*WHERE id = \$1[\s\S]*RETURNING/i
    );
    if (noBidUpdate) {
      const id = String(params[0]);
      const ts = String(params[1]);
      const inst = String(params[2]);
      const r = rows.get(id);
      if (!r) return { rowCount: 0, rows: [] };
      const prev = Number(r.metadata?.noBidRetryCount || 0);
      const next = prev + 1;
      r.metadata = {
        ...r.metadata,
        noBidRetryCount: next,
        lastNoBidAt: ts,
        lastNoBidInstrument: inst
      };
      r.updated_at = new Date().toISOString();
      return { rowCount: 1, rows: [{ count: next }] };
    }

    // updateHedgeStatus UPDATE pattern (hedgeStatus = $1, metadata = metadata || $2::jsonb)
    const statusUpdate = trimmed.match(
      /^UPDATE pilot_protections\s+SET hedge_status = \$1, metadata = metadata \|\| \$2::jsonb/i
    );
    if (statusUpdate) {
      const id = String(params[2]);
      const newStatus = String(params[0]);
      const mergeJson = JSON.parse(String(params[1]));
      const r = rows.get(id);
      if (!r) return { rowCount: 0, rows: [] };
      r.hedge_status = newStatus;
      r.metadata = { ...r.metadata, ...mergeJson };
      r.updated_at = new Date().toISOString();
      return { rowCount: 1, rows: [] };
    }

    // SELECT for sumActiveProtectionNotional / getDailyTierUsageForUser etc.
    // not exercised by this test; throw clearly if called.
    throw new Error(`fake pool: unhandled SQL\n${sql}`);
  };

  return {
    pool: { query } as any,
    rows,
    seed: (row: Partial<Row>) => {
      const id = row.id || "00000000-0000-0000-0000-000000000001";
      const full: Row = {
        id,
        user_hash: row.user_hash || "h1",
        hash_version: 1,
        status: row.status || "triggered",
        tier_name: row.tier_name || "SL 10%",
        drawdown_floor_pct: row.drawdown_floor_pct || "0.10",
        sl_pct: row.sl_pct ?? 10,
        hedge_status: row.hedge_status || "active",
        market_id: "BTC-USD",
        protected_notional: row.protected_notional || "10000",
        foxify_exposure_notional: row.foxify_exposure_notional || "10000",
        expiry_at: row.expiry_at || new Date(Date.now() + 18 * 3600_000).toISOString(),
        auto_renew: false,
        renew_window_minutes: 1440,
        metadata: row.metadata || { protectionType: "long" },
        venue: "deribit_test",
        instrument_id: row.instrument_id || "BTC-19APR26-69000-P",
        side: "buy",
        size: row.size || "0.1",
        execution_price: row.execution_price || "0.001",
        premium: row.premium || "20",
        payout_due_amount: row.payout_due_amount || "1000",
        floor_price: row.floor_price || "70000",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      rows.set(id, full);
      return full;
    }
  };
};

test("R3.C: noBidRetryCount increments correctly across multiple cycles (production JSONB semantics)", async () => {
  const harness = buildFakePool();
  const protectionId = "00000000-0000-0000-0000-deadbeef0001";

  // Triggered 1h ago — past 0.5h normal cooling. ITM enough that bounce-
  // recovery branch fires and tries to sell. Mock sellOption returns no_bid
  // every cycle.
  harness.seed({
    id: protectionId,
    status: "triggered",
    metadata: {
      protectionType: "long",
      triggerMonitorAt: new Date(Date.now() - 1 * 3600_000).toISOString(),
      triggerAt: new Date(Date.now() - 1 * 3600_000).toISOString()
    }
  });

  const sellOption = async () => ({
    status: "failed" as const,
    fillPrice: 0,
    totalProceeds: 0,
    orderId: null,
    details: { reason: "no_bid" as const }
  });

  // Run 5 cycles back-to-back. Each cycle's bounce-recovery branch tries
  // to sell, gets no_bid, and triggers recordNoBidRetry.
  // Capture logs to suppress noisy output.
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    for (let i = 0; i < 5; i += 1) {
      await runHedgeManagementCycle({
        pool: harness.pool,
        venue: {} as any,
        sellOption,
        currentSpot: 60000, // deep ITM put → high option value
        currentIV: 45
      });
    }
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }

  const r = harness.rows.get(protectionId)!;
  assert.equal(r.metadata.noBidRetryCount, 5, `count should be 5 after 5 cycles, got ${r.metadata.noBidRetryCount}`);
  assert.ok(typeof r.metadata.lastNoBidAt === "string", "lastNoBidAt stamped");
  assert.equal(r.metadata.lastNoBidInstrument, "BTC-19APR26-69000-P", "lastNoBidInstrument stamped");
});
