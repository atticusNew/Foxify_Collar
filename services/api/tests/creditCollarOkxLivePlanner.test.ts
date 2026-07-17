import assert from "node:assert/strict";
import test from "node:test";
import {
  parseOkxChain,
  nextStandardDailyExpiryMs,
  contractsForNotional,
  premiumUsd,
  bandCappedLimitPxBtc,
  fillWithinBand,
  planLiveCollar,
  type OkxChainInstrument
} from "../src/singleSide/twoSided/creditCollar/execution/okxLivePlanner";

// ── Fixtures: a listed OKX daily chain around spot 100k, expiry 2026-07-20 08:00 UTC ─────────────
const now = Date.UTC(2026, 6, 19, 8, 20, 0); // 2026-07-19 08:20 UTC (just after the window)
const expiry = Date.UTC(2026, 6, 20, 8, 0, 0);
const farExpiry = Date.UTC(2026, 6, 21, 8, 0, 0);

const inst = (strike: number, optType: "put" | "call", expiryMs = expiry, over: Partial<OkxChainInstrument> = {}): OkxChainInstrument => ({
  instId: `BTC-USD-${new Date(expiryMs).toISOString().slice(2, 10).replace(/-/g, "")}-${strike}-${optType === "call" ? "C" : "P"}`,
  optType,
  strike,
  expiryMs,
  ctValBtc: 0.01,
  tickSz: 0.0001,
  lotSz: 1,
  minSz: 1,
  state: "live",
  ...over
});

const chain: OkxChainInstrument[] = [
  inst(93000, "put"), inst(94000, "put"), inst(95000, "put"), inst(98000, "put"), inst(99000, "put"),
  inst(101000, "call"), inst(102000, "call"), inst(103000, "call"), inst(105000, "call"), inst(107000, "call"),
  inst(94000, "put", farExpiry), inst(102000, "call", farExpiry)
];

const baseInput = {
  side: "long" as const,
  spot: 100_000,
  notionalUsdc: 50_000,
  putStrike: 94_000,   // 6% floor
  callStrike: 102_000, // 2% cap
  protectiveMidUsdc: 60,
  fundingMidUsdc: 145,
  modelContractsBtc: 0.5,
  nowMs: now
};

// ── parseOkxChain ─────────────────────────────────────────────────────────────

test("parseOkxChain: parses valid rows, drops malformed", () => {
  const parsed = parseOkxChain([
    { instId: "BTC-USD-260720-94000-P", optType: "P", stk: "94000", expTime: String(expiry), ctVal: "0.01", tickSz: "0.0001", lotSz: "1", minSz: "1", state: "live" },
    { instId: "", optType: "C", stk: "100000", expTime: String(expiry), ctVal: "0.01" }, // no instId
    { instId: "BTC-USD-260720-95000-X", optType: "X", stk: "95000", expTime: String(expiry), ctVal: "0.01" }, // bad type
    { instId: "BTC-USD-260720-96000-C", optType: "C", stk: "0", expTime: String(expiry), ctVal: "0.01" } // bad strike
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].optType, "put");
  assert.equal(parsed[0].strike, 94000);
  assert.equal(parsed[0].ctValBtc, 0.01);
});

// ── expiry snap ───────────────────────────────────────────────────────────────

test("nextStandardDailyExpiryMs: at the 08:15 window the next 08:00 ≥12h out is tomorrow (~24h tenor)", () => {
  const at0815 = Date.UTC(2026, 6, 19, 8, 15, 0);
  assert.equal(nextStandardDailyExpiryMs(at0815), Date.UTC(2026, 6, 20, 8, 0, 0));
});

test("nextStandardDailyExpiryMs: late-evening run skips the too-close morning fixing", () => {
  const at2100 = Date.UTC(2026, 6, 19, 21, 0, 0); // next 08:00 is 11h out < 12h ⟹ the one after
  assert.equal(nextStandardDailyExpiryMs(at2100), Date.UTC(2026, 6, 21, 8, 0, 0));
});

// ── contract rounding ─────────────────────────────────────────────────────────

test("contractsForNotional: 50k at 100k spot = 50 contracts of 0.01 BTC, notional exact", () => {
  const s = contractsForNotional(50_000, 100_000, 0.01);
  assert.equal(s.contracts, 50);
  assert.equal(s.contractsBtc, 0.5);
  assert.equal(s.effectiveNotionalUsdc, 50_000);
});

test("contractsForNotional: rounding recomputes the honest effective notional", () => {
  const s = contractsForNotional(50_000, 61_804, 0.01); // 80.9 contracts → 81
  assert.equal(s.contracts, 81);
  assert.equal(s.effectiveNotionalUsdc, +(81 * 0.01 * 61_804).toFixed(2));
});

test("premiumUsd: px × contracts × ctVal × spot", () => {
  assert.equal(premiumUsd(0.0012, 50, 0.01, 100_000), 60); // 0.0012 BTC/BTC × 0.5 BTC × 100k
});

// ── band-capped limit prices ──────────────────────────────────────────────────

test("bandCappedLimitPxBtc: buy crosses to the touch when inside the band", () => {
  // model mid 0.0010, band 25% ⟹ cap 0.00125; ask 0.0011 inside ⟹ limit = ask
  assert.equal(bandCappedLimitPxBtc("buy", 0.001, 0.0011, 0.25, 0.0001), 0.0011);
});

test("bandCappedLimitPxBtc: buy is CAPPED at the band when the ask is worse", () => {
  // ask 0.0016 > cap 0.00125 ⟹ rest at the band edge floored to tick (0.0012) — cannot fill outside the band
  assert.equal(bandCappedLimitPxBtc("buy", 0.001, 0.0016, 0.25, 0.0001), 0.0012);
});

test("bandCappedLimitPxBtc: sell floors at the band when the bid is worse", () => {
  // model mid 0.0010, band 25% ⟹ floor 0.00075; bid 0.0005 below ⟹ rest at 0.00075 ceiled to tick 0.0008
  assert.equal(bandCappedLimitPxBtc("sell", 0.001, 0.0005, 0.25, 0.0001), 0.0008);
});

test("bandCappedLimitPxBtc: sell hits the bid when inside the band", () => {
  assert.equal(bandCappedLimitPxBtc("sell", 0.001, 0.0009, 0.25, 0.0001), 0.0009);
});

test("bandCappedLimitPxBtc: never returns zero/negative (tick floor)", () => {
  assert.ok(bandCappedLimitPxBtc("sell", 0.00005, 0.00001, 0.5, 0.0001) >= 0.0001);
});

test("fillWithinBand: classifies fills against the band", () => {
  assert.ok(fillWithinBand("buy", 0.00124, 0.001, 0.25));
  assert.ok(!fillWithinBand("buy", 0.00126, 0.001, 0.25));
  assert.ok(fillWithinBand("sell", 0.00076, 0.001, 0.25));
  assert.ok(!fillWithinBand("sell", 0.00074, 0.001, 0.25));
});

// ── planLiveCollar ────────────────────────────────────────────────────────────

test("planLiveCollar: long side maps buy-put + sell-call at the listed strikes", () => {
  const r = planLiveCollar(chain, baseInput);
  assert.ok(r.ok);
  const p = r.ok ? r.plan : null!;
  assert.equal(p.expiryMs, expiry);
  assert.equal(p.contracts, 50);
  assert.equal(p.effectiveNotionalUsdc, 50_000);
  assert.equal(p.protective.action, "buy");
  assert.equal(p.protective.optType, "put");
  assert.equal(p.protective.listedStrike, 94_000);
  assert.equal(p.funding.action, "sell");
  assert.equal(p.funding.optType, "call");
  assert.equal(p.funding.listedStrike, 102_000);
  // model px in BTC/BTC: 60 USDC / 0.5 BTC / 100k = 0.0000012? No: 60/0.5=120 USD per BTC /100k = 0.0012
  assert.equal(p.protective.modelMidPxBtc, 0.0012);
  assert.equal(p.funding.modelMidPxBtc, 0.0029);
});

test("planLiveCollar: short side mirrors (buy call ceiling, sell put floor)", () => {
  const r = planLiveCollar(chain, { ...baseInput, side: "short", putStrike: 98_000, callStrike: 105_000, protectiveMidUsdc: 40, fundingMidUsdc: 120 });
  assert.ok(r.ok);
  const p = r.ok ? r.plan : null!;
  assert.equal(p.protective.optType, "call");
  assert.equal(p.protective.listedStrike, 105_000);
  assert.equal(p.funding.optType, "put");
  assert.equal(p.funding.listedStrike, 98_000);
});

test("planLiveCollar: snaps to the nearest listed strike and records drift", () => {
  const r = planLiveCollar(chain, { ...baseInput, putStrike: 94_400 }); // nearest listed put = 94000, drift 0.4% of spot
  assert.ok(r.ok);
  const p = r.ok ? r.plan : null!;
  assert.equal(p.protective.listedStrike, 94_000);
  assert.equal(p.protective.strikeDriftPct, 0.004);
});

test("planLiveCollar: excessive strike drift fails closed", () => {
  const sparse = chain.filter((c) => c.optType === "call" ? c.strike >= 105_000 : true); // no calls below 105k
  const r = planLiveCollar(sparse, baseInput); // solver wants 102k call, nearest is 105k ⟹ 3% drift
  assert.ok(!r.ok);
  assert.equal(!r.ok ? r.error : "", "strike_drift_too_large");
});

test("planLiveCollar: missing expiry fails closed", () => {
  const r = planLiveCollar(chain.filter((c) => c.expiryMs !== expiry), baseInput);
  assert.ok(!r.ok);
  assert.equal(!r.ok ? r.error : "", "expiry_not_listed");
});

test("planLiveCollar: non-live instruments are ignored", () => {
  const suspended = chain.map((c) => ({ ...c, state: "suspend" }));
  const r = planLiveCollar(suspended, baseInput);
  assert.ok(!r.ok);
  assert.equal(!r.ok ? r.error : "", "expiry_not_listed");
});

test("planLiveCollar: funding strike snapped through spot fails closed", () => {
  // Only call listed at expiry is 99,500 — below spot ⟹ inverted collar rejected. Drift 2.5%... use tighter:
  const weird = [inst(94000, "put"), inst(99500, "call")];
  const r = planLiveCollar(weird, { ...baseInput, callStrike: 100_250, maxStrikeDriftPct: 0.01 });
  assert.ok(!r.ok);
  assert.equal(!r.ok ? r.error : "", "funding_strike_through_spot");
});

test("planLiveCollar: zero-contract size fails closed", () => {
  const r = planLiveCollar(chain, { ...baseInput, notionalUsdc: 400 }); // 0.004 BTC → 0 contracts
  assert.ok(!r.ok);
  assert.equal(!r.ok ? r.error : "", "size_rounds_to_zero");
});
