import assert from "node:assert/strict";
import test from "node:test";

import { capRuleFromEnv, capRuleText, exceedProb, expTimeFromMs, normCdf, pickCap, type CapCandidate } from "../src/singleSide/twoSided/creditCollar/capRule";
import { fetchOkxListedTouchQuote, widestExecutableWing, type BookTopPx } from "../src/singleSide/twoSided/creditCollar/execution/okxListedTouchQuote";
import { quoteCollarFromSnapshot, type OkxListedSnapshot } from "../src/singleSide/twoSided/creditCollar/perpShadow/okxListedSnapshot";
import type { OkxChainInstrument } from "../src/singleSide/twoSided/creditCollar/execution/okxLivePlanner";

// ── the math ─────────────────────────────────────────────────────────────────

test("normCdf: symmetric, 0.5 at zero, known points", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.6449) - 0.95) < 1e-4);
  assert.ok(Math.abs(normCdf(-1.6449) - 0.05) < 1e-4);
  assert.ok(Math.abs(normCdf(2) + normCdf(-2) - 1) < 1e-9);
});

test("exceedProb: a cap 1σ out has ~16% odds; long counts up, short counts down; junk is null", () => {
  // σ√T = 5% ⟹ 45% vol over (5/45)^2 years
  const T = Math.pow(0.05 / 0.45, 2);
  const spot = 100_000;
  const up = exceedProb({ side: "long", spot, strike: spot * Math.exp(0.05 - 0.5 * 0.0025), ivAnnual: 0.45, yearsToExpiry: T });
  assert.ok(up != null && Math.abs(up - 0.1587) < 0.002, `1σ above: ${up}`);
  const down = exceedProb({ side: "short", spot, strike: spot * Math.exp(-0.05 - 0.5 * 0.0025), ivAnnual: 0.45, yearsToExpiry: T });
  assert.ok(down != null && Math.abs(down - 0.1587) < 0.002, `1σ below: ${down}`);
  const p47 = exceedProb({ side: "long", spot, strike: 104_700, ivAnnual: 0.45, yearsToExpiry: 4.6 / 365 }) ?? 0;
  const p34 = exceedProb({ side: "long", spot, strike: 103_400, ivAnnual: 0.45, yearsToExpiry: 4.6 / 365 }) ?? 0;
  assert.ok(p47 < 0.2 && p47 > 0.15, `the 4.7% weekly cap sits under a 20% target at 45% vol: ${p47}`);
  assert.ok(p34 > 0.2 && p34 < 0.3, `the 3.4% cap does not: ${p34}`);
  assert.equal(exceedProb({ side: "long", spot, strike: 105_000, ivAnnual: 0, yearsToExpiry: T }), null);
  assert.equal(exceedProb({ side: "long", spot, strike: 105_000, ivAnnual: 0.45, yearsToExpiry: 0 }), null);
  assert.equal(exceedProb({ side: "long", spot: 0, strike: 105_000, ivAnnual: 0.45, yearsToExpiry: T }), null);
});

test("expTimeFromMs: OKX YYMMDD in UTC", () => {
  assert.equal(expTimeFromMs(Date.UTC(2026, 8, 25, 8)), "260925");
  assert.equal(expTimeFromMs(Date.UTC(2027, 0, 1, 8)), "270101");
});

test("capRuleFromEnv: target 20% by default; widest and a custom fraction by env; junk falls back", () => {
  assert.deepEqual(capRuleFromEnv({}), { kind: "target", maxExceedProb: 0.2 });
  assert.deepEqual(capRuleFromEnv({ EP_CAP_RULE: "widest" }), { kind: "widest" });
  assert.deepEqual(capRuleFromEnv({ EP_CAP_EXCEED_PROB: "0.25" }), { kind: "target", maxExceedProb: 0.25 });
  assert.deepEqual(capRuleFromEnv({ EP_CAP_EXCEED_PROB: "5" }), { kind: "target", maxExceedProb: 0.2 });
  assert.ok(capRuleText({ kind: "target", maxExceedProb: 0.2 }).includes("20%"));
});

// ── the pick ─────────────────────────────────────────────────────────────────

// The live 2026-09-20 book, long, 7% floor: 85000 paid ~$170 at ~18% odds, 86000 paid $29 at ~12%.
const spot = 81_200;
const cands: CapCandidate[] = [
  { strike: 84_000, netUsdc: 260, exceedProb: 0.27 },
  { strike: 85_000, netUsdc: 170, exceedProb: 0.18 },
  { strike: 86_000, netUsdc: 29, exceedProb: 0.12 },
  { strike: 87_000, netUsdc: -3, exceedProb: 0.08 },
];

test("pickCap widest: the widest strike that pays, regardless of credit", () => {
  const r = pickCap(cands, spot, { kind: "widest" });
  assert.equal(r?.pick.strike, 86_000);
  assert.equal(r?.decidedBy, "widest");
});

test("pickCap target: the most credit among strikes under the odds ceiling — the $170 the widest rule left on the table", () => {
  const r = pickCap(cands, spot, { kind: "target", maxExceedProb: 0.2 });
  assert.equal(r?.pick.strike, 85_000);
  assert.equal(r?.decidedBy, "target");
  const tight = pickCap(cands, spot, { kind: "target", maxExceedProb: 0.15 });
  assert.equal(tight?.pick.strike, 86_000, "a tighter ceiling moves the cap out");
});

test("pickCap target: no qualifying strike, or no vols at all, falls back to widest and says so", () => {
  const none = pickCap(cands, spot, { kind: "target", maxExceedProb: 0.05 });
  assert.equal(none?.pick.strike, 86_000);
  assert.equal(none?.decidedBy, "widest");
  const blind = pickCap(cands.map((c) => ({ ...c, exceedProb: null })), spot, { kind: "target", maxExceedProb: 0.2 });
  assert.equal(blind?.pick.strike, 86_000);
  assert.equal(blind?.decidedBy, "widest");
  assert.equal(pickCap(cands.filter((c) => c.netUsdc <= 0), spot, { kind: "target", maxExceedProb: 0.2 }), null, "nothing pays ⟹ null, never a debit");
});

test("pickCap target: equal credit breaks toward the wider strike; shorts measure distance below spot", () => {
  const tie = pickCap([{ strike: 85_000, netUsdc: 50, exceedProb: 0.1 }, { strike: 86_000, netUsdc: 50, exceedProb: 0.08 }], spot, { kind: "target", maxExceedProb: 0.2 });
  assert.equal(tie?.pick.strike, 86_000);
  const short = pickCap([{ strike: 78_500, netUsdc: 90, exceedProb: 0.3 }, { strike: 78_000, netUsdc: 64, exceedProb: 0.19 }, { strike: 77_500, netUsdc: 10, exceedProb: 0.15 }], spot, { kind: "target", maxExceedProb: 0.2 });
  assert.equal(short?.pick.strike, 78_000);
});

test("pickCap minimum distance: closer strikes leave the choice; the rule picks from the paying strikes at or beyond the line", () => {
  // 4.5% of 81,200 is 3,654: 84,000 (3.4%) is out, 85,000 (4.7%) and 86,000 (5.9%) stay
  const t = pickCap(cands, spot, { kind: "target", maxExceedProb: 0.2 }, 0.045);
  assert.equal(t?.pick.strike, 85_000, "the most credit at or beyond 4.5% under the odds ceiling");
  assert.equal(t?.decidedBy, "target");
  assert.equal(t?.underMin, false);
  const w = pickCap(cands, spot, { kind: "widest" }, 0.045);
  assert.equal(w?.pick.strike, 86_000);
  assert.equal(w?.underMin, false);
  const loose = pickCap(cands, spot, { kind: "target", maxExceedProb: 0.3 }, 0.045);
  assert.equal(loose?.pick.strike, 85_000, "a looser ceiling cannot pull the cap back inside the line");
  const none = pickCap(cands, spot, { kind: "target", maxExceedProb: 0.2 }, 0);
  assert.equal(none?.pick.strike, 85_000, "0 is no floor: the same pick as before");
  assert.equal(none?.underMin, false);
});

test("pickCap minimum distance: when nothing at or beyond the line pays, the widest paying strike inside it is returned and flagged, never a closer one chosen by credit", () => {
  const r = pickCap(cands, spot, { kind: "target", maxExceedProb: 0.2 }, 0.07);
  assert.equal(r?.pick.strike, 86_000, "the widest that pays, not the 84,000 with the most credit");
  assert.equal(r?.decidedBy, "widest");
  assert.equal(r?.underMin, true, "flagged so the caller's guard refuses on the distance");
  const short = pickCap([{ strike: 78_500, netUsdc: 90, exceedProb: 0.3 }, { strike: 78_000, netUsdc: 64, exceedProb: 0.19 }, { strike: 77_500, netUsdc: 10, exceedProb: 0.15 }], spot, { kind: "target", maxExceedProb: 0.2 }, 0.045);
  assert.equal(short?.pick.strike, 77_500, "shorts measure the line below spot: 77,500 is 4.56% down, 78,000 only 3.9%");
  assert.equal(short?.underMin, false);
  assert.equal(pickCap(cands.filter((c) => c.netUsdc <= 0), spot, { kind: "widest" }, 0.045), null, "nothing pays anywhere ⟹ null");
});

test("capRuleText names the minimum distance when there is one", () => {
  assert.ok(capRuleText({ kind: "target", maxExceedProb: 0.2 }, 0.045).endsWith("never closer than 4.5% from price (refused when nothing at or beyond that pays)"));
  assert.ok(!capRuleText({ kind: "target", maxExceedProb: 0.2 }).includes("never closer"));
  assert.ok(capRuleText({ kind: "widest" }, 0.045).startsWith("the widest listed cap whose net credit is positive, never closer than 4.5%"));
});

// ── through the live quote path ──────────────────────────────────────────────

const friday = Date.UTC(2026, 8, 25, 8);
const now = Date.UTC(2026, 8, 20, 18);
const inst = (strike: number, optType: "call" | "put"): OkxChainInstrument => ({
  instId: `BTC-USD-260925-${strike}-${optType === "call" ? "C" : "P"}`,
  optType,
  strike,
  expiryMs: friday,
  ctValBtc: 0.01,
  tickSz: 0.0001,
  lotSz: 1,
  minSz: 1,
  state: "live",
});
// A 7% floor (75500-P at 0.0013) against three caps: the live 2026-09-20 shape where the widest
// paying strike (86000) left most of the credit behind.
const chain = [inst(75_500, "put"), inst(84_000, "call"), inst(85_000, "call"), inst(86_000, "call")];
const books: Record<string, BookTopPx> = {
  "BTC-USD-260925-75500-P": { bidPxBtc: 0.0012, askPxBtc: 0.0013 },
  "BTC-USD-260925-84000-C": { bidPxBtc: 0.0046, askPxBtc: 0.0047 },
  "BTC-USD-260925-85000-C": { bidPxBtc: 0.003, askPxBtc: 0.0031 },
  "BTC-USD-260925-86000-C": { bidPxBtc: 0.002, askPxBtc: 0.0021 },
};

test("widestExecutableWing: same candidates, rule decides; exceed odds ride on the pick", () => {
  const calls = chain.filter((c) => c.optType === "call");
  const size = { contracts: 123, ctValBtc: 0.01 };
  const T = (friday - now) / (365 * 86_400_000);
  const odds = (i: OkxChainInstrument) => exceedProb({ side: "long", spot, strike: i.strike, ivAnnual: 0.45, yearsToExpiry: T });
  const w = widestExecutableWing(calls, books, 0.0013, size, spot, 100_000, { kind: "widest" }, odds);
  assert.equal(w.pick?.inst.strike, 86_000);
  assert.equal(w.decidedBy, "widest");
  const t = widestExecutableWing(calls, books, 0.0013, size, spot, 100_000, { kind: "target", maxExceedProb: 0.2 }, odds);
  assert.equal(t.pick?.inst.strike, 85_000, `target picks the paying strike with the most credit under 20%: ${t.pick?.inst.strike}`);
  assert.equal(t.decidedBy, "target");
  assert.ok(t.pick!.exceedProb != null && t.pick!.exceedProb < 0.2 && t.pick!.exceedProb > 0.1);
  assert.ok(t.pick!.netUsdc > w.pick!.netUsdc, "and it pays more");
});

const okxRow = (c: OkxChainInstrument) => ({
  instId: c.instId,
  optType: c.optType === "call" ? "C" : "P",
  stk: String(c.strike),
  expTime: String(c.expiryMs),
  ctVal: "1",
  ctMult: "0.01",
  tickSz: "0.0001",
  lotSz: "1",
  minSz: "1",
  state: c.state,
});
const withOkx = async <T>(vols: Record<string, number> | null, run: () => Promise<T>): Promise<T> => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/public/instruments")) return new Response(JSON.stringify({ data: chain.map(okxRow) }), { status: 200 });
    if (u.includes("/public/opt-summary")) {
      if (!vols) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify({ code: "0", data: Object.entries(vols).map(([instId, v]) => ({ instId, markVol: String(v) })) }), { status: 200 });
    }
    const m = /instId=([^&]+)/.exec(u);
    const b = m ? books[decodeURIComponent(m[1])] : undefined;
    const data = [{ bids: b?.bidPxBtc != null ? [[String(b.bidPxBtc), "5"]] : [], asks: b?.askPxBtc != null ? [[String(b.askPxBtc), "5"]] : [] }];
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
};
const base = { side: "long" as const, spot, planPutStrike: 75_516, planCallStrike: 82_418, notionalUsdc: 100_000, contractsBtc: 1.23, nowMs: now, baseUrl: "https://okx.test", tenor: "weekly" as const, capGuard: { minCapPct: 0, maxCapPct: 0.08 } };
const vols = Object.fromEntries(chain.map((c) => [c.instId, 0.45]));

test("fetchOkxListedTouchQuote: the target rule writes the 85000 cap with its odds; widest (and a vol outage) writes 86000", async () => {
  const markVolsFor = async () => new Map(Object.entries(vols));
  const target = await withOkx(vols, () => fetchOkxListedTouchQuote({ ...base, capRule: { kind: "target", maxExceedProb: 0.2 }, markVolsFor }));
  assert.ok(target.ok, JSON.stringify(target));
  assert.equal(target.callStrike, 85_000);
  assert.equal(target.capRuleApplied, "target");
  assert.ok(target.capExceedProb != null && target.capExceedProb < 0.2);
  const widest = await withOkx(vols, () => fetchOkxListedTouchQuote({ ...base, capRule: { kind: "widest" }, markVolsFor }));
  assert.ok(widest.ok);
  assert.equal(widest.callStrike, 86_000);
  assert.equal(widest.capRuleApplied, "widest");
  assert.equal(widest.capExceedProb, null, "the widest rule reads no vols");
  const outage = await withOkx(null, () => fetchOkxListedTouchQuote({ ...base, capRule: { kind: "target", maxExceedProb: 0.2 }, markVolsFor: async () => null }));
  assert.ok(outage.ok);
  assert.equal(outage.callStrike, 86_000, "no vol ⟹ widest, never a guess");
  assert.equal(outage.capRuleApplied, "widest");
  assert.ok(target.creditUsdc > widest.creditUsdc, "the rule exists to stop leaving this on the table");
  const legacy = await withOkx(vols, () => fetchOkxListedTouchQuote({ ...base }));
  assert.ok(legacy.ok && legacy.callStrike === 86_000 && legacy.capRuleApplied === "widest", "no rule passed ⟹ the previous behaviour");
});

test("quoteCollarFromSnapshot: the same rule from a snapshot's mark vols; rungs carry their odds", () => {
  const snap: OkxListedSnapshot = {
    atMs: now,
    expiryMs: friday,
    weeklyExpiryMs: friday,
    chain,
    books: Object.fromEntries(Object.entries(books).map(([id, b]) => [id, { bids: b.bidPxBtc != null ? [{ pxBtc: b.bidPxBtc, contracts: 500 }] : [], asks: b.askPxBtc != null ? [{ pxBtc: b.askPxBtc, contracts: 500 }] : [] }])),
    booksMissing: 0,
    markVols: vols,
  };
  const geometry = { floorPct: 0.07, capPct: 0.015 };
  const t = quoteCollarFromSnapshot({ side: "long", spot, contracts: 123, geometry, maxCapPct: 0.08, expiryMs: friday, capRule: { kind: "target", maxExceedProb: 0.2 } }, snap);
  assert.ok(t.ok, JSON.stringify(t));
  assert.equal(t.sellStrike, 85_000);
  assert.equal(t.capRuleApplied, "target");
  assert.ok(t.capExceedProb != null && t.capExceedProb < 0.2);
  const w = quoteCollarFromSnapshot({ side: "long", spot, contracts: 123, geometry, maxCapPct: 0.08, expiryMs: friday }, snap);
  assert.ok(w.ok && w.sellStrike === 86_000 && w.capRuleApplied === "widest");
  assert.ok(w.capExceedProb != null, "a snapshot with vols reports the odds even under the widest rule");
  const pinned = quoteCollarFromSnapshot({ side: "long", spot, contracts: 123, geometry, maxCapPct: 0.08, expiryMs: friday, pinSellInstId: "BTC-USD-260925-84000-C" }, snap);
  assert.ok(pinned.ok && pinned.sellStrike === 84_000 && pinned.capExceedProb != null && pinned.capExceedProb > 0.2, "a rung above the ceiling still prices, with its odds");
  const blind = quoteCollarFromSnapshot({ side: "long", spot, contracts: 123, geometry, maxCapPct: 0.08, expiryMs: friday, capRule: { kind: "target", maxExceedProb: 0.2 } }, { ...snap, markVols: undefined });
  assert.ok(blind.ok && blind.sellStrike === 86_000 && blind.capRuleApplied === "widest" && blind.capExceedProb === null);
});
