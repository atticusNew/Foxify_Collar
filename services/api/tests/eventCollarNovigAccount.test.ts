/**
 * The venue subaccount a trading key addresses (novigAccount.ts): money to and from the venue's
 * five-place decimals without rounding, the open body with a fresh SPKI public key, the transfer
 * body with its idempotency key, and the client against a fake venue: every call signed NOVIG-V3
 * by the management key over the exact bytes sent, the paths the docs give, a 202 read back until
 * Applied, a Rejected transfer's actual balance, the venue's error body. Nothing touches a venue
 * and nothing places an order.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import {
  NOVIG_TRADE_ENV,
  NovigAccountClient,
  centsToDecimal5,
  decimal5ToCents,
  fundBody,
  mintTradingKeypair,
  openSubaccountBody,
  parseSubaccount,
  parseTransfer,
} from "../src/eventCollar/crossVenue/novigAccount";
import { VenueApiError, canonicalString, signerFromPem } from "../src/eventCollar/crossVenue/venuePositions";

const mgmt = (() => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return { keyId: "2c9a7e1d-5b3f-4e8a-a6d0-9f1b3c5e7a24", pem, publicKey };
})();
const HOST = "https://api.paper.example.test";

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  rawBody: string;
  body: unknown;
}

function fakeVenue(routes: Record<string, (seen: Seen, n: number) => { status: number; body?: unknown }>): { client: NovigAccountClient; seen: Seen[] } {
  const seen: Seen[] = [];
  const counts = new Map<string, number>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const s: Seen = { method: (init?.method ?? "GET").toUpperCase(), path: u.pathname, headers: { ...((init?.headers ?? {}) as Record<string, string>) }, rawBody, body: rawBody ? JSON.parse(rawBody) : undefined };
    seen.push(s);
    const key = `${s.method} ${s.path}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ code: "NOT_FOUND", message: `no route ${key}` }), { status: 404 });
    const r = route(s, n);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { client: new NovigAccountClient({ host: HOST, signer: signerFromPem(mgmt.keyId, mgmt.pem), fetchImpl }), seen };
}

/** The request's NOVIG-V3 signature verifies with the management key over method, path, empty query and the exact body bytes. */
function assertSigned(s: Seen): void {
  assert.equal(s.headers["Novig-Key-Id"], mgmt.keyId);
  const ts = s.headers["Novig-Timestamp"];
  assert.match(ts, /^\d{13}$/);
  const canon = canonicalString({ timestampMs: ts, method: s.method, path: s.path, query: "", body: s.rawBody });
  assert.ok(cryptoVerify(null, Buffer.from(canon, "utf8"), mgmt.publicKey, Buffer.from(s.headers["Novig-Signature"], "base64")), `signature on ${s.method} ${s.path}`);
}

test("novig money: five-place decimals to cents and back, exactly; malformed amounts refuse", () => {
  assert.equal(decimal5ToCents("1234.50000"), 123450);
  assert.equal(decimal5ToCents("0.00000"), 0);
  assert.equal(decimal5ToCents("7.69"), 769);
  assert.equal(decimal5ToCents("250"), 25000);
  assert.equal(decimal5ToCents("-3.10000"), -310);
  assert.equal(centsToDecimal5(25000), "250.00000");
  assert.equal(centsToDecimal5(769), "7.69000");
  assert.equal(centsToDecimal5(5), "0.05000");
  assert.equal(centsToDecimal5(0), "0.00000");
  assert.equal(decimal5ToCents(centsToDecimal5(123456)), 123456);
  assert.throws(() => decimal5ToCents("12,50"), /not a decimal amount/);
  assert.throws(() => centsToDecimal5(12.5), /non-negative integer/);
  assert.throws(() => centsToDecimal5(-1), /non-negative integer/);
});

test("novig keys and bodies: a fresh Ed25519 keypair whose public half is an SPKI PEM; the open body carries label, key and algorithm; the fund body the five-place amount and the idempotency key", () => {
  const kp = mintTradingKeypair();
  assert.equal(kp.algorithm, "Ed25519");
  assert.match(kp.publicKeyPem, /^-----BEGIN PUBLIC KEY-----\n/);
  assert.match(kp.privateKeyPem, /^-----BEGIN PRIVATE KEY-----\n/);
  // the two halves belong together: the public half the venue stores verifies what the private half signs
  const priv = createPrivateKey(kp.privateKeyPem);
  const pub = createPublicKey(kp.publicKeyPem);
  assert.equal(priv.asymmetricKeyType, "ed25519");
  assert.deepEqual(createPublicKey(priv).export({ type: "spki", format: "der" }), pub.export({ type: "spki", format: "der" }));

  const open = openSubaccountBody({ label: " atticus hedge ", publicKeyPem: kp.publicKeyPem, algorithm: kp.algorithm });
  assert.deepEqual(Object.keys(open).sort(), ["algorithm", "label", "publicKey"]);
  assert.equal(open.label, "atticus hedge");
  assert.equal(open.algorithm, "Ed25519");
  assert.equal(open.publicKey, kp.publicKeyPem);
  assert.equal(openSubaccountBody({ label: "x", publicKeyPem: kp.publicKeyPem, algorithm: "Ed25519", expiresAt: "2027-01-01T00:00:00Z" }).expiresAt, "2027-01-01T00:00:00Z");
  assert.throws(() => openSubaccountBody({ label: "", publicKeyPem: kp.publicKeyPem, algorithm: "Ed25519" }), /label/);
  assert.throws(() => openSubaccountBody({ label: "x".repeat(65), publicKeyPem: kp.publicKeyPem, algorithm: "Ed25519" }), /label/);
  assert.throws(() => openSubaccountBody({ label: "x", publicKeyPem: kp.privateKeyPem, algorithm: "Ed25519" }), /SPKI/);

  assert.deepEqual(fundBody({ direction: "fund", amountCents: 25000, clientTransferId: "desk-1-topup-a" }), { direction: "fund", amount: "250.00000", clientTransferId: "desk-1-topup-a" });
  assert.deepEqual(fundBody({ direction: "defund", amountCents: 1, clientTransferId: "back-1" }), { direction: "defund", amount: "0.01000", clientTransferId: "back-1" });
  assert.throws(() => fundBody({ direction: "fund", amountCents: 0, clientTransferId: "a" }), /positive/);
  assert.throws(() => fundBody({ direction: "fund", amountCents: 100, clientTransferId: "" }), /clientTransferId/);
});

test("novig parse: a subaccount row and a transfer in our units; an unknown status reads as Requested", () => {
  assert.deepEqual(parseSubaccount({ keyId: "8f14e45f-1", label: "desk-1", balance: "1234.50000" }), { keyId: "8f14e45f-1", label: "desk-1", balance: "1234.50000", balanceCents: 123450 });
  assert.throws(() => parseSubaccount({ label: "x" }), /keyId/);
  const t = parseTransfer({ transferId: "c4a71f30-1", status: "Rejected", direction: "fund", amount: "250.00000", actualBalance: "40.00000", clientTransferId: "a", createdAt: "2026-09-09T14:22:03.118Z" });
  assert.equal(t.status, "Rejected");
  assert.equal(t.amountCents, 25000);
  assert.equal(t.actualBalanceCents, 4000);
  assert.equal(parseTransfer({ transferId: "x", status: "Something" }).status, "Requested");
  assert.equal(parseTransfer({ transferId: "x", status: "Applied", actualBalance: null }).actualBalanceCents, null);
});

test("novig client: open signs the exact body with the management key and returns the trading key id; list, balance, relabel hit the documented paths", async () => {
  const kp = mintTradingKeypair();
  const { client, seen } = fakeVenue({
    "POST /v3/account/subaccounts": (s) => {
      const b = s.body as { label: string; publicKey: string; algorithm: string };
      assert.equal(b.algorithm, "Ed25519");
      assert.equal(b.publicKey, kp.publicKeyPem);
      return { status: 201, body: { keyId: "8f14e45f-trade", label: b.label, balance: "0.00000" } };
    },
    "GET /v3/account/subaccounts": () => ({ status: 200, body: [{ keyId: "8f14e45f-trade", label: "atticus hedge", balance: "50.00000" }, { keyId: "b7c3a1e9-2", label: "desk-2", balance: "0.00000" }] }),
    "GET /v3/account/subaccounts/8f14e45f-trade/balance": () => ({ status: 200, body: { keyId: "8f14e45f-trade", balance: "50.00000" } }),
    "PATCH /v3/account/subaccounts/8f14e45f-trade": (s) => ({ status: 200, body: { keyId: "8f14e45f-trade", label: (s.body as { label: string }).label, balance: "50.00000" } }),
  });
  const opened = await client.openSubaccount({ label: "atticus hedge", publicKeyPem: kp.publicKeyPem, algorithm: kp.algorithm });
  assert.equal(opened.keyId, "8f14e45f-trade");
  assert.equal(opened.balanceCents, 0);
  assert.equal(seen[0].headers["content-type"], "application/json");
  assertSigned(seen[0]);
  // the body hash the signature covers is the hash of the bytes on the wire
  assert.equal(createHash("sha256").update(seen[0].rawBody).digest("hex"), createHash("sha256").update(JSON.stringify(seen[0].body)).digest("hex"));

  const rows = await client.listSubaccounts();
  assert.deepEqual(
    rows.map((r) => [r.keyId, r.label, r.balanceCents]),
    [
      ["8f14e45f-trade", "atticus hedge", 5000],
      ["b7c3a1e9-2", "desk-2", 0],
    ],
  );
  assertSigned(seen[1]);
  assert.equal(seen[1].rawBody, "");
  assert.equal(seen[1].headers["content-type"], undefined);

  assert.deepEqual(await client.balance("8f14e45f-trade"), { balance: "50.00000", balanceCents: 5000 });
  assert.equal((await client.relabel("8f14e45f-trade", "atticus hedge nba")).label, "atticus hedge nba");
  assert.deepEqual(
    seen.map((s) => `${s.method} ${s.path}`),
    ["POST /v3/account/subaccounts", "GET /v3/account/subaccounts", "GET /v3/account/subaccounts/8f14e45f-trade/balance", "PATCH /v3/account/subaccounts/8f14e45f-trade"],
  );
  for (const s of seen) assertSigned(s);
});

test("novig client: a transfer is accepted (202) and read back until Applied; a Rejected one carries the balance found; the venue's error body is the error", async () => {
  const { client, seen } = fakeVenue({
    "POST /v3/account/subaccounts/8f14e45f-trade/transfer": (s) => {
      assert.deepEqual(s.body, { direction: "fund", amount: "50.00000", clientTransferId: "demo-topup-1" });
      return { status: 202, body: { transferId: "c4a71f30-1", status: "Requested", direction: "fund", amount: "50.00000", actualBalance: null, clientTransferId: "demo-topup-1", createdAt: "2026-10-28T23:00:00.000Z" } };
    },
    "GET /v3/account/subaccounts/8f14e45f-trade/transfers/c4a71f30-1": (_s, n) => ({
      status: 200,
      body: { transferId: "c4a71f30-1", status: n < 3 ? "Requested" : "Applied", direction: "fund", amount: "50.00000", actualBalance: null, clientTransferId: "demo-topup-1" },
    }),
    "GET /v3/account/subaccounts/8f14e45f-trade/transfers/bad-1": () => ({ status: 200, body: { transferId: "bad-1", status: "Rejected", direction: "fund", amount: "500.00000", actualBalance: "40.00000" } }),
    "POST /v3/account/subaccounts/missing/transfer": () => ({ status: 404, body: { code: "SUBACCOUNT_NOT_FOUND", message: "no such subaccount" } }),
  });
  const sent = await client.fund("8f14e45f-trade", { direction: "fund", amountCents: 5000, clientTransferId: "demo-topup-1" });
  assert.equal(sent.status, "Requested");
  assertSigned(seen[0]);
  const slept: number[] = [];
  const done = await client.waitApplied("8f14e45f-trade", sent.transferId, { tries: 5, delayMs: 250, sleep: async (ms) => void slept.push(ms) });
  assert.equal(done.status, "Applied");
  assert.deepEqual(slept, [250, 250]);
  assert.equal(seen.filter((s) => s.path.endsWith("/transfers/c4a71f30-1")).length, 3);

  const bad = await client.transfer("8f14e45f-trade", "bad-1");
  assert.equal(bad.status, "Rejected");
  assert.equal(bad.actualBalanceCents, 4000);

  await assert.rejects(
    () => client.fund("missing", { direction: "fund", amountCents: 100, clientTransferId: "x" }),
    (err: unknown) => err instanceof VenueApiError && err.status === 404 && err.code === "SUBACCOUNT_NOT_FOUND",
  );
  for (const s of seen) assertSigned(s);
  assert.deepEqual(NOVIG_TRADE_ENV, { keyId: "NOVIG_TRADE_KEY_ID", pem: "NOVIG_TRADE_PRIVATE_KEY_PEM", host: "VENUE_API_HOST" });
});
