import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accrueWrapPayout,
  dailyOutflowUsdc,
  loadPayoutLedger,
  processPayoutLedger,
  requeuePayout,
  savePayoutLedger,
  transitionPayout,
  type PayoutEntry,
  type PayoutSender,
  type PayoutSendResult
} from "../src/singleSide/twoSided/creditCollar/settlement/payoutLedger";
import { parsePayoutRailFromEnv, simulatedPayoutSender } from "../src/singleSide/twoSided/creditCollar/settlement/usdcPayout";
import { newDemoWrap, type CyclePayable, type DemoWrapRecord } from "../src/singleSide/twoSided/creditCollar/demoWrap";

const NOW = 1_800_000_000_000;
const OWNER = "0x00000000000000000000000000000000000abc01";

const wrap = (id = "wrap-1", account = OWNER): DemoWrapRecord =>
  newDemoWrap(id, NOW - 3_600_000, "hyperliquid", account, {
    coin: "BTC",
    side: "long",
    szBase: 0.01,
    entryPx: 64_000,
    markPx: 64_500,
    notionalUsdc: 645
  });

const payable = (totalUsdc = 1.04, kind: CyclePayable["kind"] = "expiry"): CyclePayable => ({
  kind,
  creditUsdc: totalUsdc,
  floorPayoutUsdc: 0,
  totalUsdc
});

const entry = (over: Partial<PayoutEntry> = {}): PayoutEntry => {
  const es: PayoutEntry[] = [];
  const res = accrueWrapPayout(es, wrap(over.wrapId ?? "wrap-1"), payable(over.amountUsdc ?? 1.04), over.createdAtMs ?? NOW);
  if (!res.ok) throw new Error(res.reason);
  return Object.assign(res.entry, over);
};

/** Counting fake sender: succeeds unless told otherwise; records every (to, amount, key) call. */
const fakeSender = (outcomes: PayoutSendResult[] = []): PayoutSender & { calls: Array<{ to: string; amount: number; key: string }> } => {
  const calls: Array<{ to: string; amount: number; key: string }> = [];
  return {
    kind: "fake",
    calls,
    send: async (to, amount, key) => {
      calls.push({ to, amount, key });
      return outcomes.shift() ?? { ok: true, txHash: `tx-${key}`, confirmed: true };
    }
  };
};

// ── accrual ───────────────────────────────────────────────────────────────────

test("accrual: one entry per wrap, address derived from the record — never a parameter", () => {
  const es: PayoutEntry[] = [];
  const r = accrueWrapPayout(es, wrap(), payable(1.04), NOW);
  assert.ok(r.ok && r.created);
  assert.equal(es.length, 1);
  assert.equal(es[0].account, OWNER); // the verified position owner is the ONLY payable address
  assert.equal(es[0].amountUsdc, 1.04);
  assert.equal(es[0].status, "accrued");
});

test("accrual: idempotent — a second accrual for the same wrap returns the existing entry untouched", () => {
  const es: PayoutEntry[] = [];
  accrueWrapPayout(es, wrap(), payable(1.04), NOW);
  es[0].status = "confirmed"; // even a fully paid entry
  const again = accrueWrapPayout(es, wrap(), payable(99), NOW + 1);
  assert.ok(again.ok && !again.created);
  assert.equal(es.length, 1);
  assert.equal(es[0].amountUsdc, 1.04); // amount not overwritten
});

test("accrual: refuses non-address accounts and dust below one cent", () => {
  const es: PayoutEntry[] = [];
  const bad = accrueWrapPayout(es, wrap("wrap-x", "not-an-address"), payable(1.04), NOW);
  assert.ok(!bad.ok && /not a payable address/.test(bad.reason));
  const dust = accrueWrapPayout(es, wrap("wrap-y"), payable(0.004), NOW);
  assert.ok(!dust.ok && /nothing to pay/.test(dust.reason));
  assert.equal(es.length, 0);
});

// ── transitions (the double-pay guard) ────────────────────────────────────────

test("transitions: accrued→queued→paid→confirmed allowed; paying twice refused", () => {
  const e = entry();
  assert.equal(transitionPayout(e, "paid", NOW), false); // cannot skip the queue
  assert.equal(transitionPayout(e, "queued", NOW), true);
  assert.equal(transitionPayout(e, "paid", NOW), true);
  assert.equal(transitionPayout(e, "paid", NOW), false); // never pay twice
  assert.equal(transitionPayout(e, "queued", NOW), false); // never back to the queue
  assert.equal(transitionPayout(e, "confirmed", NOW), true);
  assert.equal(transitionPayout(e, "queued", NOW), false); // confirmed is terminal
});

// ── processing ────────────────────────────────────────────────────────────────

test("process: pays accrued entries once — a second pass never re-sends", async () => {
  const es = [entry()];
  const sender = fakeSender();
  const s1 = await processPayoutLedger(es, sender, NOW, { dailyCapUsdc: 250 });
  assert.equal(s1.sent, 1);
  assert.equal(s1.confirmed, 1);
  assert.equal(es[0].status, "confirmed");
  assert.equal(es[0].txHash, "tx-wrap-1");
  assert.equal(es[0].paidAtMs, NOW);
  assert.deepEqual(sender.calls, [{ to: OWNER, amount: 1.04, key: "wrap-1" }]);
  const s2 = await processPayoutLedger(es, sender, NOW + 60_000, { dailyCapUsdc: 250 });
  assert.equal(s2.sent, 0);
  assert.equal(sender.calls.length, 1); // idempotent — no double pay
});

test("process: per-day outflow cap defers what does not fit today", async () => {
  const es = [entry({ wrapId: "w1", amountUsdc: 200 }), entry({ wrapId: "w2", amountUsdc: 100 })];
  const sender = fakeSender();
  const s = await processPayoutLedger(es, sender, NOW, { dailyCapUsdc: 250 });
  assert.equal(s.sent, 1);
  assert.equal(s.deferred, 1);
  assert.equal(es[0].status, "confirmed");
  assert.equal(es[1].status, "accrued"); // still owed, waiting for tomorrow's window
  assert.match(es[1].notes[es[1].notes.length - 1], /daily outflow cap \$250/);
  // repeated passes the same day do not duplicate the deferral note
  await processPayoutLedger(es, sender, NOW + 60_000, { dailyCapUsdc: 250 });
  assert.equal(es[1].notes.filter((n) => /daily outflow cap/.test(n)).length, 1);
  // the NEXT UTC day the cap resets and the deferred entry pays
  const s3 = await processPayoutLedger(es, sender, NOW + 86_400_000, { dailyCapUsdc: 250 });
  assert.equal(s3.sent, 1);
  assert.equal(es[1].status, "confirmed");
});

test("process: cap counts what already left the wallet today", () => {
  const paidToday = entry({ wrapId: "w1", amountUsdc: 240 });
  paidToday.status = "confirmed";
  paidToday.paidAtMs = NOW - 3_600_000;
  paidToday.updatedAtMs = NOW - 3_600_000;
  assert.equal(dailyOutflowUsdc([paidToday], NOW), 240);
  assert.equal(dailyOutflowUsdc([paidToday], NOW + 86_400_000), 0); // next UTC day
});

test("process: retriable failure retries next pass; success clears it", async () => {
  const es = [entry()];
  const sender = fakeSender([{ ok: false, error: "rpc hiccup", retriable: true }]);
  const s1 = await processPayoutLedger(es, sender, NOW, { dailyCapUsdc: 250 });
  assert.equal(s1.failed, 1);
  assert.equal(es[0].status, "failed");
  assert.equal(es[0].retriable, true);
  const s2 = await processPayoutLedger(es, sender, NOW + 60_000, { dailyCapUsdc: 250 });
  assert.equal(s2.sent, 1);
  assert.equal(es[0].status, "confirmed");
  assert.equal(es[0].attempts, 2);
});

test("process: NON-retriable failure is parked — only a manual requeue re-arms it", async () => {
  const es = [entry()];
  const sender = fakeSender([{ ok: false, error: "unknown broadcast state", retriable: false }]);
  await processPayoutLedger(es, sender, NOW, { dailyCapUsdc: 250 });
  assert.equal(es[0].status, "failed");
  assert.equal(es[0].retriable, false);
  const s2 = await processPayoutLedger(es, sender, NOW + 60_000, { dailyCapUsdc: 250 });
  assert.equal(s2.sent + s2.failed, 0); // untouched — the tx may be on chain
  assert.equal(sender.calls.length, 1);
  // ops verified on-chain that nothing paid → requeue → next pass pays
  assert.equal(requeuePayout(es, "wrap-1", NOW + 120_000), true);
  assert.equal(es[0].status, "accrued");
  const s3 = await processPayoutLedger(es, sender, NOW + 180_000, { dailyCapUsdc: 250 });
  assert.equal(s3.sent, 1);
});

test("process: a sender that THROWS is treated as unknown — parked, not retried", async () => {
  const es = [entry()];
  const sender: PayoutSender = {
    kind: "boom",
    send: async () => {
      throw new Error("socket hang up");
    }
  };
  await processPayoutLedger(es, sender, NOW, { dailyCapUsdc: 250 });
  assert.equal(es[0].status, "failed");
  assert.equal(es[0].retriable, false);
  assert.match(es[0].notes[es[0].notes.length - 1], /manual verification required/);
});

test("process: stale queued rows (crash mid-send) are parked for manual verification, never auto-resent", async () => {
  const stale = entry();
  transitionPayout(stale, "queued", NOW - 60_000); // simulates a run that died between queue and send outcome
  const sender = fakeSender();
  const s = await processPayoutLedger([stale], sender, NOW, { dailyCapUsdc: 250 });
  assert.equal(s.skippedStale, 1);
  assert.equal(stale.status, "failed");
  assert.equal(stale.retriable, false);
  assert.equal(sender.calls.length, 0); // the money may already have moved — do not move it again
});

test("process: retriable retries stop at maxAttempts", async () => {
  const es = [entry()];
  const failures = Array.from({ length: 5 }, () => ({ ok: false as const, error: "rpc", retriable: true }));
  const sender = fakeSender(failures);
  for (let i = 0; i < 5; i++) await processPayoutLedger(es, sender, NOW + i * 1_000, { dailyCapUsdc: 250, maxAttempts: 3 });
  assert.equal(es[0].attempts, 3); // 1 initial + 2 retries, then held
  assert.equal(sender.calls.length, 3);
});

test("process: persists after queueing and after every outcome", async () => {
  const es = [entry()];
  const snapshots: string[] = [];
  await processPayoutLedger(es, fakeSender(), NOW, { dailyCapUsdc: 250, persist: (e) => snapshots.push(e[0].status) });
  assert.deepEqual(snapshots, ["queued", "confirmed"]);
});

// ── store round-trip ──────────────────────────────────────────────────────────

test("store: round-trips entries; missing/corrupt file ⟹ empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "payout-ledger-"));
  const path = join(dir, "ledger.json");
  assert.deepEqual(loadPayoutLedger(path), []);
  savePayoutLedger([entry()], path);
  const back = loadPayoutLedger(path);
  assert.equal(back.length, 1);
  assert.equal(back[0].account, OWNER);
  writeFileSync(path, "not json", "utf8");
  assert.deepEqual(loadPayoutLedger(path), []);
});

// ── rail config + simulated sender ────────────────────────────────────────────

test("rail: simulated is the default; arbitrum requires the FULL arming chain", () => {
  const sim = parsePayoutRailFromEnv({});
  assert.ok(sim.ok && sim.cfg.mode === "simulated" && sim.cfg.dailyCapUsdc === 250);
  const noConfirm = parsePayoutRailFromEnv({ PAYOUT_MODE: "arbitrum", PAYOUT_HOT_WALLET_KEY: "ab".repeat(32), ARBITRUM_RPC_URL: "https://rpc" });
  assert.ok(!noConfirm.ok && /PAYOUT_LIVE_CONFIRM/.test(noConfirm.error));
  const noKey = parsePayoutRailFromEnv({ PAYOUT_MODE: "arbitrum", PAYOUT_LIVE_CONFIRM: "I_UNDERSTAND_REAL_MONEY", ARBITRUM_RPC_URL: "https://rpc" });
  assert.ok(!noKey.ok && /PAYOUT_HOT_WALLET_KEY/.test(noKey.error));
  const full = parsePayoutRailFromEnv({
    PAYOUT_MODE: "arbitrum",
    PAYOUT_LIVE_CONFIRM: "I_UNDERSTAND_REAL_MONEY",
    PAYOUT_HOT_WALLET_KEY: "ab".repeat(32),
    ARBITRUM_RPC_URL: "https://rpc",
    PAYOUT_DAILY_CAP_USDC: "100"
  });
  assert.ok(full.ok && full.cfg.mode === "arbitrum" && full.cfg.dailyCapUsdc === 100);
  const typo = parsePayoutRailFromEnv({ PAYOUT_MODE: "live" });
  assert.ok(!typo.ok); // never a silent downgrade
});

test("rail: simulated sender pays only real addresses, deterministic tx ref", async () => {
  const s = simulatedPayoutSender();
  const ok = await s.send(OWNER, 1.04, "wrap-1");
  assert.deepEqual(ok, { ok: true, txHash: "sim-wrap-1", confirmed: true });
  const bad = await s.send("nope", 1.04, "wrap-2");
  assert.ok(!bad.ok && !bad.retriable);
});
