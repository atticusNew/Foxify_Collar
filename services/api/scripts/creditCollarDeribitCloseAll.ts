#!/usr/bin/env tsx
/**
 * Deribit CLOSE-ALL — flattens every open position (option + future) with market close orders so the
 * testnet book is clean before a PM-netting measurement. Lists positions first, then closes each.
 *
 * SAFETY: defaults to TESTNET. Real money requires BOTH
 *   DERIBIT_EXECUTION_MODE=live  AND  DERIBIT_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY
 *
 *   DERIBIT_CLIENT_ID=... DERIBIT_CLIENT_SECRET=... \
 *   npm --silent --workspace services/api run deribit:close-all | jq .
 */

import { DeribitExecutionClient, type DeribitMode } from "../src/singleSide/twoSided/creditCollar/execution/deribitExecutionClient";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const clientId = process.env.DERIBIT_CLIENT_ID;
  const clientSecret = process.env.DERIBIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("[deribit-close-all] missing DERIBIT_CLIENT_ID / DERIBIT_CLIENT_SECRET");
    process.exit(2);
  }
  const requested = (process.env.DERIBIT_EXECUTION_MODE ?? "testnet").toLowerCase();
  let mode: DeribitMode = "testnet";
  if (requested === "live") {
    if (process.env.DERIBIT_LIVE_CONFIRM !== "I_UNDERSTAND_REAL_MONEY") {
      console.error("[deribit-close-all] LIVE refused: set DERIBIT_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY. Staying off.");
      process.exit(3);
    }
    mode = "live";
    console.error("[deribit-close-all] ⚠️ LIVE (real money) mode — closing REAL positions.");
  } else {
    console.error("[deribit-close-all] TESTNET mode (test.deribit.com).");
  }

  const client = new DeribitExecutionClient({ clientId, clientSecret, mode });
  console.error(`[deribit-close-all] REST base: ${client.restBase}`);
  const auth = await client.authCheck();
  if (!auth.ok) {
    console.error(`[deribit-close-all] AUTH FAILED: ${auth.message} — run deribit:auth-probe.`);
    process.exit(8);
  }

  const currency = process.env.DERIBIT_CCY ?? "BTC";
  const closed: Array<Record<string, unknown>> = [];
  for (const kind of ["option", "future"]) {
    const pos = await client.getPositions(currency, kind);
    const open = (pos.result ?? []).filter((p) => p.size != null && Math.abs(Number(p.size)) > 0);
    console.error(`[deribit-close-all] ${kind}: ${open.length} open position(s)`);
    for (const p of open) {
      const inst = String(p.instrument_name ?? "");
      if (!inst) continue;
      const r = await client.closePosition(inst, "market");
      closed.push({ instrument: inst, size: p.size, kind, ok: r.ok, code: r.code, msg: r.msg, orderId: r.result?.order?.order_id ?? null });
      console.error(`[deribit-close-all] close ${inst} (size ${p.size}) → ${r.ok ? "ok ✓" : `FAIL ${r.code} ${r.msg}`}`);
      await sleep(300);
    }
  }

  // Verify flat.
  await sleep(500);
  let remaining = 0;
  for (const kind of ["option", "future"]) {
    const pos = await client.getPositions(currency, kind);
    remaining += (pos.result ?? []).filter((p) => p.size != null && Math.abs(Number(p.size)) > 0).length;
  }

  process.stdout.write(JSON.stringify({ mode, currency, closedCount: closed.length, remainingOpen: remaining, closed }, null, 2) + "\n");
  console.error(`[deribit-close-all] done — closed ${closed.length}, remaining open ${remaining}.`);
  if (remaining > 0) process.exit(1);
};

main().catch((e) => {
  console.error("[deribit-close-all] fatal:", e);
  process.exit(1);
});
