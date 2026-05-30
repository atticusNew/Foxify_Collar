/**
 * Live cell pricing — replaces the 1.07 fudge in runCellSweep with real
 * per-leg ask from live orderbook observations (PR C2 follow-up).
 *
 * Reads /tmp/two_sided_smile.json (produced by probeDeribitSmile.ts) which
 * contains:
 *   - smile fit (a0, a1, a2) for IV at any strike
 *   - per-strike bid/ask/mid observations
 *
 * For any (strike, optionType, tenor) request, returns the live-realistic
 * ASK price by:
 *   1. Looking up the strike's direct observation (preferred — uses real ask)
 *   2. Falling back to: BS_fair(strike, T, smile_iv(strike)) × (1 + estimated_spread/2)
 *      where estimated_spread is interpolated from nearby strikes' spread%
 *
 * The result is "what would Atticus actually pay" rather than "what would BS
 * theoretical predict."
 */

import * as fs from "node:fs/promises";
import { bsPut, bsCall } from "./coreEngine";
import { evaluateSmile, type SmileFit } from "./smileModel";

type SmileObservation = { strike: number; ivAnnual: number };
type SpreadObservation = { strike: number; optionType: "put" | "call"; bidUsdcPerBtc: number; askUsdcPerBtc: number; midUsdcPerBtc: number };

export type LiveSmileData = {
  generatedAt: string;
  spotAtPull: number;
  fit: SmileFit;
  smileObservations: SmileObservation[];
  spreadObservations: SpreadObservation[];
};

let _cache: LiveSmileData | null = null;

export const loadLiveSmileData = async (path = "/tmp/two_sided_smile.json"): Promise<LiveSmileData | null> => {
  if (_cache) return _cache;
  try {
    const raw = await fs.readFile(path, "utf8");
    _cache = JSON.parse(raw) as LiveSmileData;
    return _cache;
  } catch {
    return null;
  }
};

export const __resetLiveSmileCache = (): void => {
  _cache = null;
};

const RFR = 0.045;

/**
 * Returns the realistic live ASK price in USDC/BTC for a given strike/option/tenor.
 * Falls back to BS+flat 1.07 fudge if no live data available.
 */
export const livePerLegAskUsdcPerBtc = (
  liveData: LiveSmileData | null,
  spot: number,
  strike: number,
  optionType: "put" | "call",
  tenorDays: number,
  regimeMarkup = 1.0  // applied on top for high-vol regime widening
): number => {
  const T = tenorDays / 365;

  // Path 1: Direct observation match (best — actual ask)
  if (liveData) {
    const direct = liveData.spreadObservations.find(
      (s) => s.strike === strike && s.optionType === optionType
    );
    if (direct) {
      // Use the actual ask, scaled by regime markup (live data is calm regime)
      return direct.askUsdcPerBtc * regimeMarkup;
    }
  }

  // Path 2: smile-fit IV + BS fair + observed average spread
  if (liveData) {
    const ivFromSmile = evaluateSmile(liveData.fit, strike);
    if (ivFromSmile != null) {
      const bs = optionType === "put"
        ? bsPut(spot, strike, T, RFR, ivFromSmile)
        : bsCall(spot, strike, T, RFR, ivFromSmile);
      // Average ask-over-mid ratio across all observations of same option type
      const sameType = liveData.spreadObservations.filter((s) => s.optionType === optionType);
      const avgAskOverMid = sameType.length > 0
        ? sameType.reduce((s, o) => s + (o.midUsdcPerBtc > 0 ? o.askUsdcPerBtc / o.midUsdcPerBtc : 1.0), 0) / sameType.length
        : 1.15; // conservative fallback
      return bs * avgAskOverMid * regimeMarkup;
    }
  }

  // Path 3: pure BS + 1.07 fudge fallback (legacy)
  const sigma = 0.36;
  const bs = optionType === "put"
    ? bsPut(spot, strike, T, RFR, sigma)
    : bsCall(spot, strike, T, RFR, sigma);
  return bs * 1.07 * regimeMarkup;
};

/**
 * Returns the realistic slippage haircut for selling the leg at TP exit.
 * Wider bid-ask = more slip on the sell side.
 */
export const liveSlippageHaircut = (
  liveData: LiveSmileData | null,
  strike: number,
  optionType: "put" | "call",
  contractsBtc: number
): number => {
  if (!liveData) return 0.85;
  const sameType = liveData.spreadObservations.filter((s) => s.optionType === optionType);
  if (sameType.length === 0) return 0.85;
  // Find closest-strike observation
  const closest = sameType.reduce((best, o) =>
    Math.abs(o.strike - strike) < Math.abs(best.strike - strike) ? o : best
  );
  const spread = closest.midUsdcPerBtc > 0
    ? (closest.askUsdcPerBtc - closest.bidUsdcPerBtc) / closest.midUsdcPerBtc
    : 0.15;
  // Higher spread → worse slip on close. Linear interp: 5% spread = 0.92 slip, 30% spread = 0.65 slip
  const slip = Math.max(0.65, Math.min(0.95, 0.95 - spread * 1.5));
  return slip;
};
