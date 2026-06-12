/**
 * Short-dated IV calibration — validates the backtest's DVOL→short-tenor IV proxy with REAL options.
 *
 * The backtest derives implied touch from DVOL (a 30-day index). This script pulls Deribit's actual
 * near-1-day ATM option chain right now, reads the real mark IV, and compares it to DVOL — giving the
 * true current DVOL→1d-IV ratio and the regime's assumed term-structure multiplier. It also shows the
 * implied touch probability computed from DVOL vs from the real 1d IV, so we can see how much (if any)
 * the proxy biases the edge. One live data point (current regime), but REAL.
 *
 * Usage: npm --workspace services/api run calibrate:short-iv -- --trigger 0.03 --target-hours 24
 */

import { impliedTouchProb } from "../src/singleSide/twoSided/feeRecoveryBacktest";
import { classifyRegime } from "../src/singleSide/twoSided/featureFlag";

const DERIBIT = process.env.DERIBIT_REST_BASE ?? "https://www.deribit.com";

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const getJson = async (path: string): Promise<any> => {
  const res = await fetch(`${DERIBIT}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`deribit_http_${res.status}`);
  return res.json();
};

const main = async () => {
  const trigger = Number(arg("trigger", "0.03"));
  const targetHours = Number(arg("target-hours", "24"));
  const now = Date.now();

  // 1. Spot + current DVOL.
  const idx = await getJson(`/api/v2/public/get_index_price?index_name=btc_usd`);
  const spot = Number(idx.result?.index_price);
  const dvolResp = await getJson(`/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${now - 3_600_000}&end_timestamp=${now}&resolution=60`);
  const dvolRows = dvolResp.result?.data ?? [];
  const dvol = Number(dvolRows[dvolRows.length - 1]?.[4]); // close of latest bar (percent)
  if (!(spot > 0) || !(dvol > 0)) throw new Error("missing spot or dvol");
  const regime = classifyRegime(dvol);

  // 2. Find the listed expiry nearest to now + targetHours.
  const insts = (await getJson(`/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false`)).result as Array<{ instrument_name: string; strike: number; option_type: string; expiration_timestamp: number }>;
  const targetMs = now + targetHours * 3_600_000;
  const expiries = [...new Set(insts.map((i) => i.expiration_timestamp))].filter((e) => e > now).sort((a, b) => Math.abs(a - targetMs) - Math.abs(b - targetMs));
  const expiry = expiries[0];
  const expiryHours = (expiry - now) / 3_600_000;

  // 3. ATM call + put at that expiry → read mark_iv from each order book.
  const atExpiry = insts.filter((i) => i.expiration_timestamp === expiry);
  const pick = (type: "call" | "put") => atExpiry.filter((i) => i.option_type === type).sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
  const callInst = pick("call"); const putInst = pick("put");
  const markIvOf = async (name?: string): Promise<number | null> => {
    if (!name) return null;
    const ob = await getJson(`/api/v2/public/get_order_book?instrument_name=${name}`);
    const iv = Number(ob.result?.mark_iv);
    return Number.isFinite(iv) && iv > 0 ? iv : null;
  };
  const [callIv, putIv] = await Promise.all([markIvOf(callInst?.instrument_name), markIvOf(putInst?.instrument_name)]);
  const ivs = [callIv, putIv].filter((x): x is number => x != null);
  if (ivs.length === 0) throw new Error("no mark_iv available on near-1d ATM options");
  const atmIv1d = ivs.reduce((s, x) => s + x, 0) / ivs.length; // percent

  // 4. Compare. DVOL and mark_iv are both in percent.
  const ratio = atmIv1d / dvol;
  const tenorYears = (expiryHours * 3_600_000) / (365 * 86_400_000);
  const touchFromDvol = impliedTouchProb(trigger, dvol / 100, tenorYears);
  const touchFromReal = impliedTouchProb(trigger, atmIv1d / 100, tenorYears);
  const assumedMult: Record<string, number> = { calm: 0.9, moderate: 1.0, elevated: 1.2, stress: 1.4 };

  const report = {
    as_of: new Date(now).toISOString(),
    spot: +spot.toFixed(2),
    dvol_30d: +dvol.toFixed(2),
    regime,
    nearest_expiry_iso: new Date(expiry).toISOString(),
    expiry_hours: +expiryHours.toFixed(1),
    atm_call: callInst ? { instrument: callInst.instrument_name, strike: callInst.strike, mark_iv: callIv } : null,
    atm_put: putInst ? { instrument: putInst.instrument_name, strike: putInst.strike, mark_iv: putIv } : null,
    atm_iv_1d_pct: +atmIv1d.toFixed(2),
    real_dvol_to_1d_ratio: +ratio.toFixed(3),
    backtest_assumed_multiplier_for_regime: assumedMult[regime],
    trigger,
    implied_touch_from_dvol: +touchFromDvol.toFixed(4),
    implied_touch_from_real_1d_iv: +touchFromReal.toFixed(4),
    verdict: ratio > assumedMult[regime] * 1.1
      ? `Real 1d IV is HIGHER than the backtest assumed (${ratio.toFixed(2)}× vs ${assumedMult[regime]}×) → backtest UNDERSTATES implied touch → real Foxify edge is SMALLER than shown.`
      : ratio < assumedMult[regime] * 0.9
        ? `Real 1d IV is LOWER than assumed (${ratio.toFixed(2)}× vs ${assumedMult[regime]}×) → backtest OVERSTATES implied touch → real Foxify edge is LARGER than shown.`
        : `Real 1d IV ≈ backtest assumption (${ratio.toFixed(2)}× vs ${assumedMult[regime]}×) → DVOL proxy is fair in this regime.`
  };
  console.log(JSON.stringify(report, null, 2));
};

main().catch((e) => { console.error(`[calibrate] failed: ${(e as Error).message}`); process.exit(1); });
