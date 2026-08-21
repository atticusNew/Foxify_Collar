import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newDb } from "pg-mem";
import {
  ensureEpSchema,
  jsonStores,
  migrateJsonToPostgres,
  postgresStores,
  reconcileOpenWraps,
  type EpStorePaths,
  type EpStores
} from "../src/singleSide/twoSided/creditCollar/store/epStores";
import { newDemoWrap, type DemoWrapRecord } from "../src/singleSide/twoSided/creditCollar/demoWrap";
import type { PayoutEntry } from "../src/singleSide/twoSided/creditCollar/settlement/payoutLedger";

const NOW = 1_800_000_000_000;

const tmpPaths = (): EpStorePaths => {
  const dir = mkdtempSync(join(tmpdir(), "ep-stores-"));
  return {
    wraps: join(dir, "wraps.json"),
    protection: join(dir, "protection.json"),
    ledger: join(dir, "ledger.json"),
    registry: join(dir, "wallets.json"),
    runtime: join(dir, "runtime.json"),
    tos: join(dir, "tos.json"),
    waitlist: join(dir, "waitlist.json")
  };
};

const memPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensureEpSchema(pool);
  return pool;
};

const wrap = (id: string, account = "0x" + "a".repeat(40), status: DemoWrapRecord["status"] = "active"): DemoWrapRecord => ({
  ...newDemoWrap(id, NOW, "hyperliquid", account, {
    coin: "BTC",
    side: "long",
    szBase: 0.01,
    entryPx: 64_000,
    markPx: 64_500,
    notionalUsdc: 645
  }),
  status
});

const entry = (id: string): PayoutEntry => ({
  id,
  wrapId: id,
  account: "0x" + "a".repeat(40),
  amountUsdc: 1.04,
  reason: "expiry",
  creditUsdc: 1.04,
  floorPayoutUsdc: 0,
  status: "accrued",
  attempts: 0,
  retriable: false,
  txHash: null,
  createdAtMs: NOW,
  updatedAtMs: NOW,
  paidAtMs: null,
  notes: []
});

// Both backends must satisfy the same contract — run one suite over each.
const contract = (name: string, build: () => Promise<EpStores>) => {
  test(`${name}: wraps round-trip preserving order and full record shape`, async () => {
    const s = await build();
    assert.deepEqual(await s.loadWraps(), []);
    const w1 = wrap("w-1");
    w1.vesting = { fullCreditUsdc: 1.04, startMs: NOW, endMs: NOW + 86_400_000 };
    const w2 = wrap("w-2", "0x" + "b".repeat(40), "knocked_out");
    await s.saveWraps([w1, w2]);
    const back = await s.loadWraps();
    assert.equal(back.length, 2);
    assert.equal(back[0].id, "w-1");
    assert.equal(back[0].vesting!.fullCreditUsdc, 1.04);
    assert.equal(back[1].status, "knocked_out");
    // mutate-and-save (the domain's load-all/save-all shape)
    back[0].status = "concluded";
    await s.saveWraps(back);
    assert.equal((await s.loadWraps())[0].status, "concluded");
  });

  test(`${name}: prefs, ledger, registry, runtime round-trip`, async () => {
    const s = await build();
    await s.savePrefs({ ["0x" + "a".repeat(40)]: { on: true, sinceMs: NOW } });
    assert.equal((await s.loadPrefs())["0x" + "a".repeat(40)].on, true);
    await s.saveLedger([entry("w-1")]);
    const led = await s.loadLedger();
    assert.equal(led.length, 1);
    assert.equal(led[0].amountUsdc, 1.04);
    await s.saveRegistry({ ["0x" + "a".repeat(40)]: { joinedAtMs: NOW } });
    assert.equal((await s.loadRegistry())["0x" + "a".repeat(40)].joinedAtMs, NOW);
    assert.equal((await s.loadRuntime()).paused, false); // default
    await s.saveRuntime({ paused: true, pausedReason: "test", updatedAtMs: NOW });
    const rt = await s.loadRuntime();
    assert.equal(rt.paused, true);
    assert.equal(rt.pausedReason, "test");
    // ToS acceptances (versioned — a new version requires re-acceptance)
    assert.deepEqual(await s.loadTos(), {});
    await s.saveTos({ ["0x" + "a".repeat(40)]: { version: "2026-08-draft", acceptedAtMs: NOW, country: "SG" } });
    const tos = await s.loadTos();
    assert.equal(tos["0x" + "a".repeat(40)].version, "2026-08-draft");
    assert.equal(tos["0x" + "a".repeat(40)].country, "SG");
    // signed acceptance round-trips (the public-demo verification artifact)
    await s.saveTos({ ["0x" + "b".repeat(40)]: { version: "v2", acceptedAtMs: NOW, country: null, signature: "0xsig", signerVerified: true } });
    assert.equal((await s.loadTos())["0x" + "b".repeat(40)].signerVerified, true);
    // waitlist: ordered, round-trips
    assert.deepEqual(await s.loadWaitlist(), []);
    await s.saveWaitlist([{ account: "0x" + "c".repeat(40), joinedAtMs: NOW }, { account: "0x" + "d".repeat(40), joinedAtMs: NOW + 1 }]);
    const wl = await s.loadWaitlist();
    assert.equal(wl.length, 2);
    assert.equal(wl[0].account, "0x" + "c".repeat(40)); // first-come order preserved
  });

  test(`${name}: clearAll empties everything`, async () => {
    const s = await build();
    await s.saveWraps([wrap("w-1")]);
    await s.saveLedger([entry("w-1")]);
    await s.saveRegistry({ ["0x" + "a".repeat(40)]: { joinedAtMs: NOW } });
    await s.clearAll();
    assert.deepEqual(await s.loadWraps(), []);
    assert.deepEqual(await s.loadLedger(), []);
    assert.deepEqual(await s.loadRegistry(), {});
  });
};

contract("json stores", async () => jsonStores(tmpPaths()));
contract("postgres stores", async () => postgresStores(await memPool()));

// ── Migration ─────────────────────────────────────────────────────────────────

test("migration: JSON state lands in Postgres; refuses a non-empty target without force", async () => {
  const paths = tmpPaths();
  const json = jsonStores(paths);
  await json.saveWraps([wrap("w-1"), wrap("w-2", "0x" + "b".repeat(40), "concluded")]);
  await json.savePrefs({ ["0x" + "a".repeat(40)]: { on: true, sinceMs: NOW } });
  await json.saveLedger([entry("w-1")]);
  await json.saveRegistry({ ["0x" + "a".repeat(40)]: { joinedAtMs: NOW } });

  const pool = await memPool();
  const summary = await migrateJsonToPostgres(paths, pool);
  assert.deepEqual(summary, { wraps: 2, prefs: 1, payouts: 1, wallets: 1 });
  const pg = postgresStores(pool);
  assert.equal((await pg.loadWraps()).length, 2);
  assert.equal((await pg.loadLedger())[0].id, "w-1");

  // second run refuses (money records must never be silently replaced)
  await assert.rejects(() => migrateJsonToPostgres(paths, pool), /already holds/);
  // force replaces
  const forced = await migrateJsonToPostgres(paths, pool, true);
  assert.equal(forced.wraps, 2);
});

// ── Boot reconcile ────────────────────────────────────────────────────────────

test("reconcile: agreement is silent; missing venue legs and untracked venue positions alert", () => {
  const active = wrap("w-1");
  active.hedge = { venue: "okx_live", mode: "okx_live", netCreditUsdc: 0.2, venueFeeUsdc: 0.1, contracts: 2, sizeNote: null };
  active.legs = [
    { role: "sell_call_cap", instId: "BTC-USD-260820-65500-C", orderId: "x", premiumUsdc: 0.3, real: true },
    { role: "buy_put_floor", instId: "BTC-USD-260820-60600-P", orderId: "x", premiumUsdc: -0.1, real: true }
  ];
  const venue = [
    { instId: "BTC-USD-260820-65500-C", pos: -2 },
    { instId: "BTC-USD-260820-60600-P", pos: 2 }
  ];
  assert.deepEqual(reconcileOpenWraps([active], venue), []);

  // venue lost a leg ⟹ MISSING alert
  const missing = reconcileOpenWraps([active], [venue[0]]);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /MISSING position on BTC-USD-260820-60600-P/);

  // venue holds something no wrap claims ⟹ UNTRACKED alert
  const untracked = reconcileOpenWraps([active], [...venue, { instId: "BTC-USD-260820-70000-C", pos: -1 }]);
  assert.equal(untracked.length, 1);
  assert.match(untracked[0], /UNTRACKED option position BTC-USD-260820-70000-C/);
});

test("reconcile: paper wraps and concluded wraps are skipped", () => {
  const paper = wrap("w-1");
  paper.hedge = { venue: "okx_model", mode: "paper", netCreditUsdc: 0.2, venueFeeUsdc: 0.1, contracts: 1, sizeNote: null };
  paper.legs = [{ role: "sell_call_cap", instId: "BTC-USD-260820-65500-C (model)", orderId: null, premiumUsdc: 0.3, real: false }];
  assert.deepEqual(reconcileOpenWraps([paper], []), []);
  const done = wrap("w-2", "0x" + "b".repeat(40), "concluded");
  assert.deepEqual(reconcileOpenWraps([done], []), []);
});
