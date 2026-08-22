import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newDb } from "pg-mem";
import { emptyFunnel, funnelSummary, parseInternalAccounts, recordLooker, recordPageLoad, dayKey } from "../src/singleSide/twoSided/creditCollar/epFunnel";
import { ensureEpSchema, jsonStores, postgresStores, type EpStorePaths } from "../src/singleSide/twoSided/creditCollar/store/epStores";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const ADDR_A = "0x" + "a".repeat(40);
const ADDR_B = "0x" + "b".repeat(40);

test("funnel: lookers are recorded per distinct address with view counts and first/last seen", () => {
  const f = emptyFunnel();
  assert.equal(recordLooker(f, ADDR_A.toUpperCase(), NOW), true); // case-normalized
  assert.equal(recordLooker(f, ADDR_A, NOW + 1000), true);
  assert.equal(recordLooker(f, ADDR_B, NOW + 2000), true);
  assert.equal(recordLooker(f, "not-an-address", NOW), false); // garbage never pollutes the store
  assert.equal(Object.keys(f.lookers).length, 2);
  assert.equal(f.lookers[ADDR_A].views, 2);
  assert.equal(f.lookers[ADDR_A].firstMs, NOW);
  assert.equal(f.lookers[ADDR_A].lastMs, NOW + 1000);
});

test("funnel: summary separates lookers from wrappers — the conversion gap", () => {
  const f = emptyFunnel();
  recordLooker(f, ADDR_A, NOW - 2 * DAY); // looked 2 days ago
  recordLooker(f, ADDR_B, NOW - 3600_000); // looked an hour ago, never wrapped
  const s = funnelSummary(f, new Set([ADDR_A]), NOW); // A wrapped, B did not
  assert.equal(s.distinctLookers, 2);
  assert.equal(s.lookers24h, 1);
  assert.equal(s.lookers7d, 2);
  assert.equal(s.lookedNeverWrapped, 1);
  assert.equal(s.recentLookers[0].account, ADDR_B); // newest first
  assert.equal(s.recentLookers[0].wrapped, false);
  assert.equal(s.recentLookers[1].wrapped, true);
});

test("funnel: internal accounts (operator's own wallets) are flagged and excluded from headline counts", () => {
  const f = emptyFunnel();
  recordLooker(f, ADDR_A, NOW - 1000); // the operator, testing constantly
  recordLooker(f, ADDR_A, NOW - 500);
  recordLooker(f, ADDR_B, NOW); // a real visitor
  const internal = parseInternalAccounts(` ${ADDR_A.toUpperCase()} , not-an-address `); // messy env input
  assert.deepEqual([...internal], [ADDR_A]);
  const s = funnelSummary(f, new Set([ADDR_A]), NOW, internal);
  assert.equal(s.distinctLookers, 1, "operator excluded from the headline");
  assert.equal(s.lookers24h, 1);
  assert.equal(s.lookedNeverWrapped, 1, "the real visitor hasn't wrapped");
  assert.equal(s.internalLookers, 1);
  const mine = s.recentLookers.find((r) => r.account === ADDR_A);
  assert.equal(mine?.internal, true, "still visible in the log, flagged");
  assert.equal(s.recentLookers.find((r) => r.account === ADDR_B)?.internal, false);
});

test("funnel: page loads bucket by UTC day, summarize the last 7, prune beyond 30", () => {
  const f = emptyFunnel();
  recordPageLoad(f, "app", NOW - 40 * DAY); // will be pruned by the next record
  recordPageLoad(f, "app", NOW - 2 * DAY);
  recordPageLoad(f, "app", NOW);
  recordPageLoad(f, "miniapp", NOW);
  recordPageLoad(f, "public", NOW);
  assert.equal(f.pageLoads[dayKey(NOW - 40 * DAY)], undefined, "days beyond retention are pruned");
  const s = funnelSummary(f, new Set(), NOW);
  assert.equal(s.pageLoads7d.length, 7);
  const today = s.pageLoads7d[6];
  assert.equal(today.day, dayKey(NOW));
  assert.equal(today.total, 3);
  assert.deepEqual(today.byPage, { app: 1, miniapp: 1, public: 1 });
  assert.equal(s.pageLoads7d[4].total, 1); // the 2-days-ago load
});

test("funnel store: json and postgres backends roundtrip the same state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-funnel-"));
  const paths: EpStorePaths = {
    wraps: join(dir, "w.json"),
    protection: join(dir, "p.json"),
    ledger: join(dir, "l.json"),
    registry: join(dir, "r.json"),
    runtime: join(dir, "rt.json"),
    tos: join(dir, "t.json"),
    waitlist: join(dir, "wl.json"),
    funnel: join(dir, "f.json")
  };
  const f = emptyFunnel();
  recordLooker(f, ADDR_A, NOW);
  recordPageLoad(f, "app", NOW);

  const json = jsonStores(paths);
  await json.saveFunnel(f);
  assert.deepEqual(await json.loadFunnel(), f);

  const db = newDb({ autoCreateForeignKeyIndices: true });
  const pool = new (db.adapters.createPg()).Pool();
  await ensureEpSchema(pool);
  const pg = postgresStores(pool);
  assert.deepEqual(await pg.loadFunnel(), emptyFunnel(), "empty table reads as an empty funnel");
  await pg.saveFunnel(f);
  assert.deepEqual(await pg.loadFunnel(), f);
});
