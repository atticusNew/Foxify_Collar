/**
 * RETAIL VIEW — the non-admin JSON contract on the retail skin.
 *
 * A realistic /api/state payload (operator fields, hedge legs, gross/take economics, rule
 * internals, raw venue errors) goes in; what comes out must carry the product and nothing else.
 * The forbidden-substring sweep is the guard that matters: it fails the moment a new internal
 * field rides a retail response, wherever it is nested.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RETAIL_HIDDEN_KEYS, retailClean, retailReason, retailRedact, retailRefusal } from "../src/singleSide/twoSided/creditCollar/retailView";

const stateFixture = () => ({
  ok: true,
  guards: { enabled: true, paused: false, pausedReason: null, executionMode: "paper", maxPositionNotionalUsdc: 2400, maxWrapsPerDay: 6, cooldownMs: 60000, maxBookNotionalUsdc: 50000, maxActiveWraps: 40 },
  caps: { subAccountCapitalUsdc: 10000, marginPerWrapRate: 0.12, usableMarginUsdc: 6000, bookCapUsdc: 50000, perWalletCapUsdc: 2400, perStrikeCapPct: 0.3, takeRatePct: 0.2 },
  simulated: true,
  account: "0xabc",
  coin: "BTC",
  showcase: false,
  marketPxUsd: 115_432.5,
  position: { coin: "BTC", side: "long", szBase: 0.05, entryPx: 114_000, markPx: 115_432.5, notionalUsdc: 5771.6 },
  positionError: null,
  wraps: [
    {
      id: "wrap-1",
      createdAtMs: 1,
      capMode: "plain",
      clientVenue: "hyperliquid",
      account: "0xabc",
      position: { coin: "BTC", side: "long", szBase: 0.05, entryPx: 114_000, markPx: 115_000, notionalUsdc: 5750 },
      quote: { spot: 115_000, putStrike: 108_000, callStrike: 120_000, floorPct: 0.06, capPct: 0.043, creditUsdc: 41.2, quotedCreditUsdc: 42.1, floorStrike: 108_000, capStrike: 120_000, floorPctUsed: 0.0608, tenorDays: 5, tenor: "weekly", fundingUsdc: 3.1, capExceedProb: 0.18, capRule: "target" },
      hedge: { venue: "okx_model", mode: "paper", netCreditUsdc: 51.5, venueFeeUsdc: 1.2, contracts: 5, sizeNote: "protecting 0.05 of 0.053 BTC (5 × 0.01); remainder unwrapped" },
      legs: [
        { role: "sell_call_cap", instId: "BTC-USD-260926-120000-C (model)", side: "sell", contracts: 5, premiumUsdc: 60, orderId: "paper-1", real: false },
        { role: "buy_put_floor", instId: "BTC-USD-260926-108000-P (model)", side: "buy", contracts: 5, premiumUsdc: 8.5, orderId: "paper-2", real: false }
      ],
      vesting: { fullCreditUsdc: 41.2, startMs: 1, endMs: 500_000 },
      stages: [
        { kind: "quoted", atMs: 2, note: "listed OKX book: BTC-USD-260926-120000-C bid 0.0005 · net $51.50 after fees" },
        { kind: "hedge_locked", atMs: 3, note: "paper model quote" }
      ],
      status: "active",
      failReason: null,
      capTouch: null,
      release: null,
      owed: null,
      unwind: { id: "u1", phase: "passive", legs: [{ instId: "BTC-USD-260926-120000-C" }] },
      idempotencyKey: "web-abc-1",
      economics: { grossCreditUsdc: 51.5, atticusTakeUsdc: 10.3, takeRatePct: 0.2, founding: false },
      wrappedNotionalUsdc: 5750
    },
    {
      id: "wrap-0",
      createdAtMs: 0,
      account: "0xabc",
      status: "failed",
      failReason: "wrap refused: listed_credit_nonpositive — call bid under put ask on OKX (BTC-USD-260919-118000-C)",
      quote: null,
      hedge: null,
      legs: [],
      vesting: null,
      stages: []
    }
  ],
  payouts: [{ id: "p1", amountUsdc: 12.5, reason: "expiry", status: "paid", txHash: "sim-0001", createdAtMs: 9, paidAtMs: 10 }],
  protection: { autoRenew: true, on: true, accountsOn: 3 },
  gates: { tosRequired: false, signatureRequired: false, cleared: true },
  release: { available: true, costUsdc: 300, premiumUsdc: 296, feeUsdc: 4, instId: "BTC-USD-260926-120000-C", source: "okx_book" },
  owed: { balanceUsdc: 0, items: [] },
  capMode: "plain"
});

test("retail view: operator fields are gone wherever they nest; the product survives", () => {
  const out = retailRedact(stateFixture()) as Record<string, unknown>;
  const s = JSON.stringify(out);
  // gone
  for (const k of ["legs", "hedge", "economics", "instId", "orderId", "grossCreditUsdc", "takeRatePct", "executionMode", "subAccountCapitalUsdc", "bookCapUsdc", "capExceedProb", "capRule", "idempotencyKey", "unwind", "clientVenue", "fundingUsdc", "premiumUsdc", "feeUsdc", "source", "note", "positionError"]) {
    assert.ok(!s.includes(`"${k}"`), `${k} must not ride a retail response`);
  }
  // kept
  const w = (out.wraps as Array<Record<string, unknown>>)[0];
  const q = w.quote as Record<string, unknown>;
  assert.equal(q.creditUsdc, 41.2);
  assert.equal(q.quotedCreditUsdc, 42.1);
  assert.equal(q.floorStrike, 108_000);
  assert.equal(q.capStrike, 120_000);
  assert.equal(q.tenor, "weekly");
  assert.deepEqual(w.vesting, { fullCreditUsdc: 41.2, startMs: 1, endMs: 500_000 });
  assert.equal(w.status, "active");
  assert.equal(w.coverageNote, "protecting 0.05 of 0.053 BTC (5 × 0.01); remainder unwrapped", "the coverage note is lifted out of the dropped hedge block");
  assert.deepEqual((w.stages as Array<Record<string, unknown>>)[0], { kind: "quoted", atMs: 2 }, "stage notes (venue text) are dropped, kinds and times stay");
  assert.equal(out.simulated, true, "the one honesty flag travels");
  assert.deepEqual(out.caps, { perWalletCapUsdc: 2400 }, "capacity: the per-wallet clip only");
  assert.deepEqual(out.guards, { enabled: true, paused: false, pausedReason: null });
  assert.deepEqual(out.protection, { autoRenew: true, on: true, accountsOn: 3 });
  assert.equal((out.release as Record<string, unknown>).costUsdc, 300);
  assert.equal((out.payouts as Array<Record<string, unknown>>)[0].txHash, "sim-0001");
  assert.equal((out.position as Record<string, unknown>).markPx, 115_432.5, "the live mark stays: the rail needs it");
});

test("retail view: a failed wrap's engine reason becomes the retail sentence", () => {
  const out = retailRedact(stateFixture()) as { wraps: Array<{ failReason: string | null }> };
  assert.equal(out.wraps[1].failReason, "No honest credit right now · nothing opened.");
  assert.equal(out.wraps[0].failReason, null);
});

test("retail view: the forbidden-substring sweep is clean on the redacted state and dirty on the raw one", () => {
  assert.equal(retailClean(retailRedact(stateFixture())).ok, true);
  const raw = retailClean(stateFixture());
  assert.ok(!raw.ok, "the raw payload names venues, instruments and lanes");
});

test("retail view: error bodies keep the codes the client acts on and collapse everything else", () => {
  const behaviour = ["tos_required", "verify_required", "close_locked", "release_locked", "price_moved", "already_released", "rate_limited", "account_refused", "no_position", "nothing_active", "showcase_wallet", "geo_blocked", "invalid_size", "owed_outstanding", "in_flight"];
  for (const c of behaviour) {
    const r = retailRedact({ ok: false, error: c, message: "raw engine text mentioning OKX_API_KEY and paper" }) as { error: string; message: string };
    assert.equal(r.error, c, `${c} is a client behaviour code`);
    assert.ok(!/OKX|paper|_KEY/.test(r.message), `${c}: the raw message never leaves`);
    assert.ok(r.message.length > 8, `${c}: a real sentence`);
  }
  const owed = retailRedact({ ok: false, error: "owed_outstanding", owedUsdc: 12.4, carryCapUsdc: 9.36, message: "wrap refused: $12.40 from past cycles is still owed on this account, more than we carry ($9.36, 3 cycles of this credit) — it settles from gains before protection can restart" }) as { message: string; owedUsdc: number; carryCapUsdc: number };
  assert.equal(owed.message, "$12.40 from past cycles settles from your credits first \u00b7 it\u2019s more than we carry forward right now, so protection restarts once it\u2019s settled.");
  assert.ok(!/owed|cycles of this credit/.test(owed.message), "never 'owed', never the carry formula, on the retail surface");
  assert.equal(owed.owedUsdc, 12.4, "the amount travels as a number too");
  assert.equal(owed.carryCapUsdc, 9.36, "so does what we carry");
  const legacy = retailRedact({ ok: false, error: "owed_outstanding", owedUsdc: 12.4, message: "$12.40 from a settled cycle is still owed on this account — settle it before protection can restart" }) as { message: string };
  assert.equal(legacy.message, owed.message, "the no-carry (EP_OWED_CARRY_CYCLES=0) refusal reads the same");
  const byShape = retailRedact({ ok: false, error: "refused", message: "wrap refused: $3.00 from past cycles is still owed on this account, more than we carry ($0.00, 0 cycles of this credit)" }) as { error: string; message: string };
  assert.equal(byShape.error, "owed_outstanding", "the free-text reason maps by shape");
  // operator codes collapse
  for (const [code, msg] of [
    ["missing_credentials", "missing OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE"],
    ["mode_mismatch", "DEMO_EXECUTION=okx_live but OKX_EXECUTION_MODE is not live"],
    ["position_read_failed", "fetch failed: api.hyperliquid.xyz ECONNRESET"],
    ["wrap_timeout", "the venue did not answer in time — nothing opened; try again in a minute"],
    ["internal", "Cannot read properties of undefined (reading 'bid')"],
    ["admin_required", "admin surfaces disabled — set EP_ADMIN_TOKEN"]
  ]) {
    const r = retailRedact({ ok: false, error: code, message: msg }) as { error: string; message: string };
    assert.equal(r.error, "unavailable", `${code} collapses to a generic code`);
    assert.equal(r.message, "Our issue, not yours · nothing opened.");
  }
  const notArmed = retailRedact({ ok: false, error: "not_armed", message: "OKX_LIVE_CONFIRM must equal I_UNDERSTAND_REAL_MONEY" }) as { error: string; message: string };
  assert.deepEqual(notArmed, { ok: false, error: "paused", message: "Protection is paused right now." });
  const noCredit = retailRedact({ ok: false, error: "cap_too_close", message: "widest paying cap is 3.93% away; nothing wider pays a credit on this book" }) as { error: string; message: string };
  assert.deepEqual(noCredit, { ok: false, error: "no_credit", message: "No honest credit right now · nothing opened." });
  const fill = retailRedact({ ok: false, error: "hedge_not_filled", message: "wrap refused: aborted_no_fill — the OKX IOC did not fill", wrap: { id: "w", legs: [{ instId: "x" }], failReason: "aborted_no_fill" } }) as { error: string; message: string; wrap: Record<string, unknown> };
  assert.equal(fill.error, "no_fill");
  assert.equal(fill.message, "Couldn\u2019t fill at our quote · nothing opened.");
  assert.equal(fill.wrap.failReason, "Couldn\u2019t fill at our quote · nothing opened.");
  assert.ok(!("legs" in fill.wrap));
});

test("retail view: free-text reasons map by shape and never echo", () => {
  assert.equal(retailReason("wrap refused: cooldown 42s"), "Next protection in 42s");
  assert.equal(retailReason("wrap refused: daily quota reached (6/6)"), "Daily limit reached · try again tomorrow.");
  assert.equal(retailReason("wrap refused: book notional cap $50000 reached"), "Above the current capacity · nothing opened.");
  assert.equal(retailReason("wrap refused: this position is 0.005 BTC; OKX options trade in 0.01 BTC lots (minimum one lot)"), "Below the 0.01 BTC minimum.");
  assert.equal(retailReason("wrap refused: cap strike $70500 already carries $1364.29 of the book (limit 30% of $2047.64) — a knockout there must stay unwindable on the screen"), "That level is crowded right now · try again shortly.");
  assert.equal(retailReason("kill switch: DEMO_ENABLED=false"), "Protection is paused right now.");
  assert.equal(retailReason("missing OKX_API_KEY"), "Our issue, not yours · nothing opened.");
  assert.equal(retailReason(null), null);
  assert.equal(retailReason(""), null);
  assert.deepEqual(retailRefusal("strike_concentration", "anything"), { error: "try_later", message: "That level is crowded right now · try again shortly." });
  assert.deepEqual(retailRefusal("close_unwind_failed", "couldn't close the hedge cleanly right now"), { error: "close_retry", message: "Couldn\u2019t turn off cleanly right now · you\u2019re still protected · try again shortly." });
});

test("retail view: the hidden-key list itself names no client-needed field", () => {
  for (const k of ["creditUsdc", "floorStrike", "capStrike", "markPx", "notionalUsdc", "vesting", "status", "payouts", "txHash", "controlToken", "coverageNote", "expiryMs", "tenor", "protectedUsd", "spot", "side", "capTouch", "release", "owed", "simulated", "perWalletCapUsdc", "exceedsCurrentCap", "kind", "reason"]) {
    assert.ok(!RETAIL_HIDDEN_KEYS.has(k), `${k} is a retail field`);
  }
});
