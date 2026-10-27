/**
 * Kalshi account administration — the tier read, the Advanced upgrade (granted or refused), the
 * balance per shard, the subaccounts, and the two transfers, each checked against the wire shape
 * Kalshi documents and signed with the account key. Driven by a fake fetch; nothing touches the
 * network and nothing places an order.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { constants, createPublicKey, generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import {
  KALSHI_SHARDS,
  KalshiAccountClient,
  KalshiApiError,
  TIER_RANK,
  dollarsToCentsFloor,
  shardForTicker,
} from "../src/eventCollar/crossVenue/kalshiAccount";

const creds = (() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return { apiKeyId: "key-1", privateKeyPem: pem, publicKey: createPublicKey(pem) };
})();
const BASE = "https://trade.example.test/trade-api/v2";

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeKalshi(routes: Record<string, (seen: Seen) => { status: number; body?: unknown }>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    const s: Seen = { method: (init?.method ?? "GET").toUpperCase(), path: u.pathname, headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    seen.push(s);
    const route = routes[`${s.method} ${s.path.replace("/trade-api/v2", "")}`];
    if (!route) return new Response(JSON.stringify({ code: "not_found", message: `no route ${s.method} ${s.path}` }), { status: 404 });
    const r = route(s);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { fetch: fetchImpl, seen };
}

const LIMITS_BASIC = { usage_tier: "basic", read: { refill_rate: 200, bucket_capacity: 600 }, write: { refill_rate: 100, bucket_capacity: 100 }, grants: [] };
const LIMITS_ADV = {
  usage_tier: "advanced",
  read: { refill_rate: 300, bucket_capacity: 900 },
  write: { refill_rate: 300, bucket_capacity: 900 },
  grants: [{ exchange_instance: "event_contract", level: "advanced", source: "manual" }],
};

test("kalshi account: the shard map and the ticker's shard; dollars floor to cents", () => {
  assert.equal(shardForTicker("KXNFLGAME-26OCT26DALDEN-DAL"), 0);
  assert.equal(shardForTicker("KXNBAGAME-26OCT27BKNBOS-BOS"), 3);
  assert.equal(shardForTicker("kxmlbgame-x"), 3);
  assert.equal(shardForTicker("KXBTCD-26AUG0607-T64599.99"), 0, "unknown prefixes are the catch-all");
  assert.match(KALSHI_SHARDS[3], /basketball/);
  assert.equal(dollarsToCentsFloor("123.456789"), 12345);
  assert.equal(dollarsToCentsFloor("0.5600"), 56);
  assert.equal(dollarsToCentsFloor(undefined), 0);
  assert.equal(dollarsToCentsFloor("junk"), 0);
  assert.ok(TIER_RANK.advanced > TIER_RANK.basic && TIER_RANK.prestige > TIER_RANK.prime);
});

test("kalshi account: the tier read is signed with the account key and says whether subaccounts can be created", async () => {
  const k = fakeKalshi({ "GET /account/limits": () => ({ status: 200, body: LIMITS_BASIC }) });
  const client = new KalshiAccountClient(creds, { base: BASE, fetchImpl: k.fetch, now: () => 1_760_000_000_000 });
  const tier = await client.tier();
  assert.equal(tier.usageTier, "basic");
  assert.equal(tier.canCreateSubaccounts, false);
  assert.deepEqual(tier.read, { refillRate: 200, bucketCapacity: 600 });
  const s = k.seen[0];
  assert.equal(s.headers["KALSHI-ACCESS-KEY"], "key-1");
  assert.equal(s.headers["KALSHI-ACCESS-TIMESTAMP"], "1760000000000");
  const ok = cryptoVerify("sha256", Buffer.from("1760000000000GET/trade-api/v2/account/limits"), { key: creds.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(s.headers["KALSHI-ACCESS-SIGNATURE"], "base64"));
  assert.ok(ok, "RSA-PSS over timestamp + method + path");

  const adv = fakeKalshi({ "GET /account/limits": () => ({ status: 200, body: LIMITS_ADV }) });
  const t2 = await new KalshiAccountClient(creds, { base: BASE, fetchImpl: adv.fetch }).tier();
  assert.equal(t2.canCreateSubaccounts, true);
  assert.deepEqual(t2.grants, [{ exchangeInstance: "event_contract", level: "advanced", source: "manual", expiresTs: null }]);
});

test("kalshi account: the upgrade — 201 grants Advanced for good and the tier is read back; 403 says what Kalshi wants first", async () => {
  let tier = LIMITS_BASIC;
  const granted = fakeKalshi({
    "POST /account/api_usage_level/upgrade": () => {
      tier = LIMITS_ADV;
      return { status: 201 };
    },
    "GET /account/limits": () => ({ status: 200, body: tier }),
  });
  const r = await new KalshiAccountClient(creds, { base: BASE, fetchImpl: granted.fetch }).upgradeToAdvanced();
  assert.equal(r.ok, true);
  assert.equal(r.status, 201);
  assert.equal(r.tier.usageTier, "advanced");
  assert.equal(r.tier.canCreateSubaccounts, true);
  assert.deepEqual(
    granted.seen.map((s) => `${s.method} ${s.path}`),
    ["POST /trade-api/v2/account/api_usage_level/upgrade", "GET /trade-api/v2/account/limits"],
  );

  const refused = fakeKalshi({
    "POST /account/api_usage_level/upgrade": () => ({ status: 403, body: { code: "forbidden", message: "no api orders" } }),
    "GET /account/limits": () => ({ status: 200, body: LIMITS_BASIC }),
  });
  const r2 = await new KalshiAccountClient(creds, { base: BASE, fetchImpl: refused.fetch }).upgradeToAdvanced();
  assert.equal(r2.ok, false);
  if (!r2.ok) {
    assert.equal(r2.status, 403);
    assert.match(r2.reason, /no API-created order among the account's last 100/);
    assert.equal(r2.tier?.usageTier, "basic");
  }

  const limited = fakeKalshi({
    "POST /account/api_usage_level/upgrade": () => ({ status: 429, body: { error: "too many requests" } }),
    "GET /account/limits": () => ({ status: 200, body: LIMITS_BASIC }),
  });
  const r3 = await new KalshiAccountClient(creds, { base: BASE, fetchImpl: limited.fetch }).upgradeToAdvanced();
  assert.equal(r3.ok, false);
  if (!r3.ok) assert.match(r3.reason, /rate limited/);
});

test("kalshi account: balance per shard and every subaccount's cash per shard, floored; the snapshot joins them", async () => {
  const k = fakeKalshi({
    "GET /account/limits": () => ({ status: 200, body: LIMITS_ADV }),
    "GET /portfolio/balance": () => ({
      status: 200,
      body: { balance: 25_000, balance_dollars: "250.00", portfolio_value: 25_000, updated_ts: 1, balance_breakdown: [{ exchange_index: 3, balance: "50.004" }, { exchange_index: 0, balance: "199.996" }] },
    }),
    "GET /portfolio/subaccounts/balances": () => ({
      status: 200,
      body: {
        subaccount_balances: [
          { subaccount_number: 1, exchange_index: 0, balance: "40.00", updated_ts: 5 },
          { subaccount_number: 0, exchange_index: 3, balance: "50.00", updated_ts: 4 },
          { subaccount_number: 0, exchange_index: 0, balance: "159.99", updated_ts: 3 },
        ],
      },
    }),
  });
  const s = await new KalshiAccountClient(creds, { base: BASE, fetchImpl: k.fetch }).snapshot();
  assert.equal(s.balanceCents, 25_000);
  assert.deepEqual(s.byShard, [
    { exchangeIndex: 0, cents: 19_999 },
    { exchangeIndex: 3, cents: 5_000 },
  ]);
  assert.deepEqual(s.subaccounts, [
    { subaccount: 0, exchangeIndex: 0, cents: 15_999, updatedTs: 3 },
    { subaccount: 0, exchangeIndex: 3, cents: 5_000, updatedTs: 4 },
    { subaccount: 1, exchangeIndex: 0, cents: 4_000, updatedTs: 5 },
  ]);
  assert.equal(s.tier.canCreateSubaccounts, true);
});

test("kalshi account: create a subaccount on a shard; move cash between subaccounts and between shards with the documented bodies; a refusal is an error with the venue's status", async () => {
  const k = fakeKalshi({
    "POST /portfolio/subaccounts": (s) => ({ status: 201, body: { subaccount_number: (s.body as { exchange_index: number }).exchange_index === 3 ? 1 : 1 } }),
    "POST /portfolio/subaccounts/transfer": () => ({ status: 200, body: {} }),
    "POST /portfolio/intra_exchange_instance_transfer": () => ({ status: 200, body: { transfer_id: "tr-9" } }),
  });
  const client = new KalshiAccountClient(creds, { base: BASE, fetchImpl: k.fetch, uuid: () => "11111111-2222-4333-8444-555555555555" });

  assert.deepEqual(await client.createSubaccount(), { subaccount: 1, exchangeIndex: 0 });
  assert.deepEqual(await client.createSubaccount(3), { subaccount: 1, exchangeIndex: 3 });
  assert.deepEqual(k.seen[0].body, { exchange_index: 0 });
  assert.deepEqual(k.seen[1].body, { exchange_index: 3 });

  assert.deepEqual(await client.transferBetweenSubaccounts({ from: 0, to: 1, cents: 5_000, exchangeIndex: 3 }), { clientTransferId: "11111111-2222-4333-8444-555555555555" });
  assert.deepEqual(k.seen[2].body, { client_transfer_id: "11111111-2222-4333-8444-555555555555", from_subaccount: 0, to_subaccount: 1, amount_cents: 5_000, exchange_index: 3 });

  assert.deepEqual(await client.transferBetweenShards({ fromShard: 0, toShard: 3, cents: 5_000 }), { transferId: "tr-9", clientTransferId: "11111111-2222-4333-8444-555555555555" });
  // cents travel as centicents, event contracts both ends, the primary both ends
  assert.deepEqual(k.seen[3].body, {
    client_transfer_id: "11111111-2222-4333-8444-555555555555",
    source: "event_contract",
    destination: "event_contract",
    amount: 500_000,
    source_exchange_shard: 0,
    destination_exchange_shard: 3,
    source_subaccount: 0,
    destination_subaccount: 0,
  });

  await assert.rejects(client.transferBetweenSubaccounts({ from: 1, to: 1, cents: 100 }), /two different subaccounts/);
  await assert.rejects(client.transferBetweenSubaccounts({ from: 0, to: 1, cents: 0 }), /positive whole number of cents/);
  await assert.rejects(client.transferBetweenShards({ fromShard: 3, toShard: 3, cents: 100 }), /two different shards/);
  await assert.rejects(client.transferBetweenShards({ fromShard: 0, toShard: 3, cents: 12.5 }), /positive whole number of cents/);

  const refusing = fakeKalshi({ "POST /portfolio/subaccounts": () => ({ status: 403, body: { code: "insufficient_tier", message: "advanced tier required" } }) });
  await assert.rejects(new KalshiAccountClient(creds, { base: BASE, fetchImpl: refusing.fetch }).createSubaccount(), (err: unknown) => {
    assert.ok(err instanceof KalshiApiError);
    assert.equal(err.status, 403);
    assert.match(err.message, /HTTP 403 POST \/portfolio\/subaccounts .*advanced tier required/);
    return true;
  });
});

test("kalshi account: the API keys are listed with their subaccount lock, minted (restricted when asked, private key passed through once) and revoked", async () => {
  const k = fakeKalshi({
    "GET /api_keys": () => ({
      status: 200,
      body: { api_keys: [{ api_key_id: "key-1", name: "service", scopes: ["read", "write"] }, { api_key_id: "key-pod", name: "parlayx-pod", scopes: ["read", "write"], subaccount: 1 }, { name: "junk without an id" }] },
    }),
    "POST /api_keys/generate": (seen) => ({ status: 201, body: { api_key_id: "key-new", key_type: (seen.body as { key_type: string }).key_type, private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" } }),
    "DELETE /api_keys/key-pod": () => ({ status: 204 }),
  });
  const client = new KalshiAccountClient(creds, { base: BASE, fetchImpl: k.fetch });

  assert.deepEqual(await client.listApiKeys(), [
    { apiKeyId: "key-1", name: "service", scopes: ["read", "write"], subaccount: null },
    { apiKeyId: "key-pod", name: "parlayx-pod", scopes: ["read", "write"], subaccount: 1 },
  ]);

  const minted = await client.generateApiKey({ name: " parlayx-pod ", subaccount: 1 });
  assert.deepEqual(k.seen[1].body, { name: "parlayx-pod", key_type: "rsa", subaccount: 1 }, "rsa by default, the subaccount restriction on the wire");
  assert.equal(minted.apiKeyId, "key-new");
  assert.equal(minted.subaccount, 1);
  assert.equal(minted.keyType, "rsa");
  assert.match(minted.privateKeyPem, /BEGIN PRIVATE KEY/);

  const whole = await client.generateApiKey({ name: "whole-account", keyType: "ed25519" });
  assert.deepEqual(k.seen[2].body, { name: "whole-account", key_type: "ed25519" }, "no subaccount field when unrestricted");
  assert.equal(whole.subaccount, null);
  assert.equal(whole.keyType, "ed25519");

  await client.deleteApiKey("key-pod");
  assert.equal(k.seen[3].method, "DELETE");
  assert.equal(k.seen[3].path, "/trade-api/v2/api_keys/key-pod");
  assert.ok(k.seen[3].headers["KALSHI-ACCESS-SIGNATURE"], "the revoke is signed like every call");

  await assert.rejects(client.generateApiKey({ name: "  " }), /needs a name/);
  await assert.rejects(client.generateApiKey({ name: "x", subaccount: 64 }), /subaccount must be 0-63/);
  await assert.rejects(client.deleteApiKey(" "), /needs a key id/);

  const empty = fakeKalshi({ "POST /api_keys/generate": () => ({ status: 201, body: { api_key_id: "k" } }) });
  await assert.rejects(new KalshiAccountClient(creds, { base: BASE, fetchImpl: empty.fetch }).generateApiKey({ name: "x" }), /returned no key/);
});
