import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { actionCleared, verifyMessageText, verifyWalletSignature } from "../src/singleSide/twoSided/creditCollar/epVerify";
import { assessDemoWrap, newDemoWrap, parseDemoGuardsFromEnv, type DemoGuardsConfig, type DemoWrapRecord } from "../src/singleSide/twoSided/creditCollar/demoWrap";
import type { TosRegistry } from "../src/singleSide/twoSided/creditCollar/store/epStores";

const NOW = 1_800_000_000_000;
const TOS_V = "2026-08-draft";
// Deterministic test wallet (well-known throwaway key — never funded).
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const signer = privateKeyToAccount(KEY);
const ACCOUNT = signer.address;
const OTHER = "0x" + "9".repeat(40);

// ── the canonical message ─────────────────────────────────────────────────────

test("verify: the message names the wallet, the ToS version, and what the signature can NOT do", () => {
  const m = verifyMessageText(ACCOUNT, TOS_V);
  assert.match(m, new RegExp(`I control ${ACCOUNT}`));
  assert.match(m, /Terms of Service \(version 2026-08-draft\)/);
  assert.match(m, /cannot move funds/);
});

// ── signature verification ────────────────────────────────────────────────────

test("verify: a real signature from the wallet passes; anyone else's fails; garbage fails", async () => {
  const sig = await signer.signMessage({ message: verifyMessageText(ACCOUNT, TOS_V) });
  assert.deepEqual(await verifyWalletSignature(ACCOUNT, TOS_V, sig), { ok: true });
  // same signature claimed for a DIFFERENT wallet ⟹ refused (message embeds the account)
  const stolen = await verifyWalletSignature(OTHER, TOS_V, sig);
  assert.ok(!stolen.ok);
  // a signature over a DIFFERENT ToS version ⟹ refused (version bump forces re-sign)
  const staleVersion = await verifyWalletSignature(ACCOUNT, "v-next", sig);
  assert.ok(!staleVersion.ok);
  // garbage in ⟹ honest refusal, never a throw
  const junk = await verifyWalletSignature(ACCOUNT, TOS_V, "0xdeadbeef");
  assert.ok(!junk.ok && /signature/.test(junk.error));
  const empty = await verifyWalletSignature(ACCOUNT, TOS_V, "");
  assert.ok(!empty.ok);
});

// ── the action gate matrix ────────────────────────────────────────────────────

test("verify: actionCleared — gates off ⟹ cleared; each gate demands exactly its artifact", () => {
  const none: TosRegistry = {};
  const checkbox: TosRegistry = { [ACCOUNT.toLowerCase()]: { version: TOS_V, acceptedAtMs: NOW, country: null } };
  const signed: TosRegistry = { [ACCOUNT.toLowerCase()]: { version: TOS_V, acceptedAtMs: NOW, country: null, signature: "0xabc", signerVerified: true } };
  const staleSigned: TosRegistry = { [ACCOUNT.toLowerCase()]: { version: "old", acceptedAtMs: NOW, country: null, signature: "0xabc", signerVerified: true } };

  // neither gate ⟹ always cleared
  assert.ok(actionCleared(none, ACCOUNT, TOS_V, false, false).ok);
  // ToS gate only ⟹ checkbox acceptance suffices
  assert.ok(!actionCleared(none, ACCOUNT, TOS_V, false, true).ok);
  assert.ok(actionCleared(checkbox, ACCOUNT, TOS_V, false, true).ok);
  // signature gate ⟹ checkbox is NOT enough; signed acceptance is
  const needsSig = actionCleared(checkbox, ACCOUNT, TOS_V, true, true);
  assert.ok(!needsSig.ok && /verify_required/.test(needsSig.error));
  assert.ok(actionCleared(signed, ACCOUNT, TOS_V, true, true).ok);
  // a ToS bump invalidates even a signed acceptance
  const stale = actionCleared(staleSigned, ACCOUNT, TOS_V, true, true);
  assert.ok(!stale.ok && /tos_required/.test(stale.error));
  // signature gate alone (tosRequired=false) still demands the signed artifact
  assert.ok(!actionCleared(checkbox, ACCOUNT, TOS_V, true, false).ok);
  assert.ok(actionCleared(signed, ACCOUNT, TOS_V, true, false).ok);
});

// ── per-wallet daily quota + global breaker (public-demo fix) ─────────────────

const guards = (over: Partial<DemoGuardsConfig> = {}): DemoGuardsConfig => ({
  ...parseDemoGuardsFromEnv({}),
  maxPositionNotionalUsdc: 1_000,
  cooldownMs: 0,
  ...over
});

const wrapFor = (account: string, i: number): DemoWrapRecord =>
  newDemoWrap(`w-${account}-${i}`, NOW - (i + 1) * 60_000, "hyperliquid", account, {
    coin: "BTC",
    side: "long",
    szBase: 0.01,
    entryPx: 64_000,
    markPx: 64_500,
    notionalUsdc: 645
  });

test("quota: PER-WALLET — one user's churn never rations another wallet", () => {
  const heavy = Array.from({ length: 10 }, (_, i) => ({ ...wrapFor("0xaaa", i), status: "failed" as const }));
  // the heavy wallet is quota-blocked…
  const blocked = assessDemoWrap(guards({ maxWrapsPerDay: 10 }), NOW, 100, heavy, "0xaaa");
  assert.ok(!blocked.ok && /this wallet/.test((blocked as { reason: string }).reason));
  // …while a different wallet sails through the same store
  assert.deepEqual(assessDemoWrap(guards({ maxWrapsPerDay: 10 }), NOW, 100, heavy, "0xbbb"), { ok: true });
});

test("quota: the GLOBAL circuit breaker still fuses a runaway platform", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ ...wrapFor(`0xw${i}`, i), status: "failed" as const }));
  const res = assessDemoWrap(guards({ maxWrapsPerDay: 50, maxWrapsPerDayGlobal: 20 }), NOW, 100, many, "0xfresh");
  assert.ok(!res.ok && /circuit breaker/.test((res as { reason: string }).reason));
});

test("quota: renewals skip both quotas (protection cycles must never starve)", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ ...wrapFor("0xaaa", i), status: "failed" as const }));
  assert.deepEqual(assessDemoWrap(guards({ maxWrapsPerDay: 5, maxWrapsPerDayGlobal: 10 }), NOW, 100, many, "0xaaa", true), { ok: true });
});
