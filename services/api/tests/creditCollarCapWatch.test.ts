import test from "node:test";
import assert from "node:assert/strict";
import {
  capDistanceBps,
  capHeadroom,
  capWatchConfigFromEnv,
  capWatchState,
  DEFAULT_CAP_WATCH,
  expTimeOf,
  fetchOkxMarkVols,
  reserveAlertUsdcFor,
  summarizeCapWatch,
  type CapWatchWrap,
  type HeadroomInput
} from "../src/singleSide/twoSided/creditCollar/capWatch";

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 19, 12);

const base: HeadroomInput = {
  side: "long",
  capStrike: 83_000,
  floorStrike: 75_200,
  markPx: 80_000,
  nowMs: T0,
  expiryMs: T0 + 20 * H,
  coveredBtc: 0.03,
  fullCreditUsdc: 6.0,
  vestedUsdc: 1.5,
  takeUsdc: 1.5,
  capLegIv: 0.55,
  floorLegIv: 0.6,
  capLegAskBtc: 0.0012
};

test("cap watch: distance is measured on the profit side; the state follows the near line", () => {
  assert.equal(capDistanceBps("long", 83_000, 80_000), 375);
  assert.equal(capDistanceBps("short", 77_000, 80_000), 375);
  assert.equal(capDistanceBps("long", 83_000, 83_000), 0);
  assert.equal(capDistanceBps("long", 83_000, 83_100), -12);
  assert.equal(capDistanceBps("short", 77_000, 76_900), -13);
  assert.equal(capWatchState(375, DEFAULT_CAP_WATCH), "calm");
  assert.equal(capWatchState(35, DEFAULT_CAP_WATCH), "near");
  assert.equal(capWatchState(0, DEFAULT_CAP_WATCH), "touched");
  assert.equal(capWatchState(-12, DEFAULT_CAP_WATCH), "touched");
});

test("cap watch: headroom prices the buy-back AT the cap from the mark vol; unvested credit, our take and the floor recovery pay for it", () => {
  const h = capHeadroom(base, DEFAULT_CAP_WATCH);
  assert.equal(h.state, "calm");
  assert.equal(h.priced, "mark_vol");
  assert.equal(h.vestedUsdc, 1.5);
  assert.equal(h.unvestedUsdc, 4.5);
  assert.equal(h.takeUsdc, 1.5);
  assert.equal(h.hoursLeft, 20);
  // ATM call, 20h, 55% vol on 0.03 BTC at 83,000: ≈ 0.4·S·σ·√T·size ≈ $22 of time value, plus the half-spread.
  assert.ok(h.buybackAtTouchUsdc > 18 && h.buybackAtTouchUsdc < 30, `ATM time value in the expected range, got ${h.buybackAtTouchUsdc}`);
  assert.ok(h.floorRecoveryUsdc >= 0 && h.floorRecoveryUsdc < 1, "a floor 9% under the cap with 20h left is worth cents, and the spread floor eats it");
  assert.equal(h.headroomUsdc, +(h.unvestedUsdc + h.takeUsdc + h.floorRecoveryUsdc - h.buybackAtTouchUsdc).toFixed(2));
  assert.ok(h.headroomUsdc < 0, "with 20h of time value left a knock-out now costs the writer");
  assert.equal(h.reserveUsdc, +(-h.headroomUsdc).toFixed(2), "the shortfall is the reserve");

  // Late in the cycle the time value has decayed and the credit is mostly vested: the reserve shrinks toward the unvested line.
  const late = capHeadroom({ ...base, nowMs: T0 + 19 * H, vestedUsdc: 5.7 }, DEFAULT_CAP_WATCH);
  assert.ok(late.buybackAtTouchUsdc < h.buybackAtTouchUsdc / 3, "√(time left): 1h of ATM value is a fraction of 20h");
  assert.ok(late.reserveUsdc < h.reserveUsdc);

  // Bigger vol, bigger buy-back; the floor recovery grows too but never outruns the sold leg.
  const hot = capHeadroom({ ...base, capLegIv: 1.1, floorLegIv: 1.1 }, DEFAULT_CAP_WATCH);
  assert.ok(hot.buybackAtTouchUsdc > h.buybackAtTouchUsdc * 1.8);
  assert.ok(hot.floorRecoveryUsdc < hot.buybackAtTouchUsdc);
});

test("cap watch: no vol ⟹ the live ask stands in; no ask either ⟹ unpriced with a zero reserve (unknown, never 'safe')", () => {
  const ask = capHeadroom({ ...base, capLegIv: null, floorLegIv: null }, DEFAULT_CAP_WATCH);
  assert.equal(ask.priced, "live_ask");
  // 0.0012 BTC × 0.03 BTC × $80,000 = $2.88, plus the $1 spread floor.
  assert.equal(ask.buybackAtTouchUsdc, 3.88);
  assert.equal(ask.floorRecoveryUsdc, 0, "recovery is only priced when the buy-back is priced from vol");
  assert.equal(ask.headroomUsdc, +(4.5 + 1.5 - 3.88).toFixed(2));
  const none = capHeadroom({ ...base, capLegIv: null, floorLegIv: null, capLegAskBtc: null }, DEFAULT_CAP_WATCH);
  assert.equal(none.priced, "unpriced");
  assert.equal(none.buybackAtTouchUsdc, 0);
  assert.equal(none.reserveUsdc, 0);
  const expired = capHeadroom({ ...base, nowMs: base.expiryMs + 1 }, DEFAULT_CAP_WATCH);
  assert.equal(expired.priced, "live_ask", "past expiry there is no time value to price; the ask (if any) is what is left");
});

test("cap watch: a short's cap sits below — the sold PUT is bought back at the money", () => {
  const s = capHeadroom({ ...base, side: "short", capStrike: 77_000, floorStrike: 84_800 }, DEFAULT_CAP_WATCH);
  assert.equal(s.distanceBps, 375);
  assert.equal(s.priced, "mark_vol");
  const l = capHeadroom(base, DEFAULT_CAP_WATCH);
  // ATM put at 77,000 vs ATM call at 83,000 with the same vol: value scales with the strike, so the short's buy-back is a little cheaper.
  assert.ok(s.buybackAtTouchUsdc < l.buybackAtTouchUsdc && s.buybackAtTouchUsdc > l.buybackAtTouchUsdc * 0.85);
});

test("cap watch: config from env — defaults, overrides, junk ignored; the retired working-order keys change nothing", () => {
  assert.deepEqual(capWatchConfigFromEnv({}), DEFAULT_CAP_WATCH);
  const c = capWatchConfigFromEnv({ EP_CAP_NEAR_BPS: "50", EP_HEADROOM_ALERT_BPS: "150", EP_PRETOUCH_WORKING_ORDER: "1", EP_PRETOUCH_RECALL_BPS: "40" });
  assert.equal(c.nearBps, 50);
  assert.equal(c.reserveAlertBps, 150);
  assert.equal(reserveAlertUsdcFor(c, 2_400), 36, "150 bps of a $2,400 wrap");
  assert.ok(!("workingOrders" in c) && !("recallBps" in c), "item 6: nothing rests on the venue; the keys are gone from the config");
  assert.equal(capWatchConfigFromEnv({ EP_PRETOUCH_NEAR_BPS: "40" }).nearBps, 40, "the old near-line key is still read");
  const junk = capWatchConfigFromEnv({ EP_CAP_NEAR_BPS: "lots", EP_HEADROOM_ALERT_BPS: "-4" });
  assert.equal(junk.nearBps, 35);
  assert.equal(junk.reserveAlertBps, 300);
  assert.equal(reserveAlertUsdcFor(junk, 2_400), 72, "the default line: 300 bps, above an ATM weekly cap leg's ~200–250 bps");
  assert.equal(reserveAlertUsdcFor(junk, -5), 0);
});

test("cap watch: the book roll-up sums reserves, counts near / touched, names the worst priced wrap", () => {
  const w = (id: string, headroomUsdc: number, state: "calm" | "near" | "touched", priced: "mark_vol" | "unpriced"): CapWatchWrap => ({
    wrapId: id,
    account: "0xabc",
    side: "long",
    capStrike: 83_000,
    headroom: {
      state,
      distanceBps: state === "calm" ? 300 : state === "near" ? 20 : -3,
      vestedUsdc: 1,
      unvestedUsdc: 5,
      takeUsdc: 1,
      buybackAtTouchUsdc: 6 - headroomUsdc,
      floorRecoveryUsdc: 0,
      headroomUsdc,
      reserveUsdc: Math.max(0, -headroomUsdc),
      priced,
      hoursLeft: 10
    },
    updatedAtMs: T0
  });
  const s = summarizeCapWatch([w("a", -12.5, "near", "mark_vol"), w("b", 3, "calm", "mark_vol"), w("c", 0, "touched", "unpriced"), w("d", -2, "calm", "mark_vol")]);
  assert.deepEqual(s, { wraps: 4, near: 1, touched: 1, reserveUsdc: 14.5, headroomUsdc: -11.5, unpriced: 1, worst: { wrapId: "a", headroomUsdc: -12.5 } });
  assert.deepEqual(summarizeCapWatch([]), { wraps: 0, near: 0, touched: 0, reserveUsdc: 0, headroomUsdc: 0, unpriced: 0, worst: null });
});

test("cap watch: OKX mark vols come from the public option summary for the leg's expiry; bad payloads throw, never guess", async () => {
  assert.equal(expTimeOf("BTC-USD-260920-83000-C"), "260920");
  assert.equal(expTimeOf("BTC-USD-260925-77000-P"), "260925");
  assert.equal(expTimeOf("BTC-USDT-SWAP"), null);
  const calls: string[] = [];
  const fetchOk = async (url: string) => {
    calls.push(url);
    return {
      status: 200,
      json: async () => ({ code: "0", data: [{ instId: "BTC-USD-260920-83000-C", markVol: "0.5512" }, { instId: "BTC-USD-260920-75000-P", markVol: "0.61" }, { instId: "BTC-USD-260920-90000-C", markVol: "" }] })
    };
  };
  const vols = await fetchOkxMarkVols("260920", fetchOk);
  assert.equal(calls[0], "https://www.okx.com/api/v5/public/opt-summary?uly=BTC-USD&expTime=260920");
  assert.equal(vols.get("BTC-USD-260920-83000-C"), 0.5512);
  assert.equal(vols.get("BTC-USD-260920-75000-P"), 0.61);
  assert.equal(vols.has("BTC-USD-260920-90000-C"), false, "an empty vol is not a vol");
  await assert.rejects(fetchOkxMarkVols("260920", async () => ({ status: 503, json: async () => ({}) })), /HTTP 503/);
  await assert.rejects(fetchOkxMarkVols("260920", async () => ({ status: 200, json: async () => ({ code: "51001", msg: "bad" }) })), /code 51001/);
});
