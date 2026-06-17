/**
 * Auto-activator — opens on GO, skips on WAIT, counts results. Injected service + clock.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ProtectionAutoActivator } from "../src/singleSide/twoSided/protection/protectionAutoActivator";
import type { ActivateParams, ActivateResult } from "../src/singleSide/twoSided/protection/protectionService";
import type { ProtectionCover } from "../src/singleSide/twoSided/protection/protectionLifecycle";

const fakeCover = (id: string): ProtectionCover => ({
  id, foxify_ref: null, created_at_ms: 0, side: "long", spot_at_entry: 100000, trigger_pct: 0.03,
  barrier_price: 97000, tenor_ms: 86_400_000, expires_at_ms: 0, payout_usdc: 60, premium_usdc: 12,
  hedge_cost_usdc: 11, ops_fee_usdc: 1, implied_touch: 0.18, signal: "GO", mode: "shadow", status: "active"
});

test("tick opens when activate succeeds (GO)", async () => {
  const calls: ActivateParams[] = [];
  const service = { activate: async (p: ActivateParams): Promise<ActivateResult> => { calls.push(p); return { ok: true, cover: fakeCover("c1"), reused: false }; } };
  const aa = new ProtectionAutoActivator({ service, params: { side: "long", triggerPct: 0.03, tenorDays: 1, payoutUsdc: 60 }, now: () => 12345 });
  await aa.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].requireGo, true);          // defaults to require GO
  assert.equal(calls[0].foxifyRef, "auto-12345");
  assert.equal(aa.status().opened, 1);
});

test("tick skips when signal not GO", async () => {
  const service = { activate: async (): Promise<ActivateResult> => ({ ok: false, error: "signal_not_go", message: "WAIT", signal: "WAIT" }) };
  const aa = new ProtectionAutoActivator({ service, params: { side: "long", triggerPct: 0.03, tenorDays: 1, payoutUsdc: 60 } });
  await aa.tick();
  const s = aa.status();
  assert.equal(s.opened, 0);
  assert.equal(s.skipped, 1);
  assert.equal(s.last_result, "signal_not_go");
});

test("tick counts errors and never throws", async () => {
  const service = { activate: async (): Promise<ActivateResult> => { throw new Error("boom"); } };
  const aa = new ProtectionAutoActivator({ service, params: { side: "long", triggerPct: 0.03, tenorDays: 1, payoutUsdc: 60 } });
  const r = await aa.tick();
  assert.equal(r, null);
  assert.equal(aa.status().errors, 1);
});

test("reused activation counts as skipped", async () => {
  const service = { activate: async (): Promise<ActivateResult> => ({ ok: true, cover: fakeCover("c1"), reused: true }) };
  const aa = new ProtectionAutoActivator({ service, params: { side: "long", triggerPct: 0.03, tenorDays: 1, payoutUsdc: 60 } });
  await aa.tick();
  assert.equal(aa.status().skipped, 1);
  assert.equal(aa.status().opened, 0);
});
