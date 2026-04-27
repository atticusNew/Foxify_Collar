/**
 * Parameter sweep: explore the (sizing, width, OTM) space to find Shield
 * configurations that deliver sharper differentiation from Standard.
 *
 * Goal: empirically test whether we can hit
 *   Standard: ~14% fee, ~33% median recovery   (current)
 *   Shield:   ~20-22% fee, ~45-50% median recovery   (user's target)
 *
 * Without this, the existing 14%/19% fee, 33%/42% median recovery split
 * may not justify a two-tier product.
 *
 * Run: npx tsx src/_tierSweep.ts
 */
import { mkdir } from "node:fs/promises";
import { KALSHI_BTC_MARKETS } from "./kalshiMarkets.js";
import { fetchBtcDailyPrices, getPriceOnDate, buildCloseSeries } from "./fetchBtcPrices.js";
import { realizedVol30d } from "./math.js";
import { quoteTier, settleTier, TIER_CONFIGS, type TierConfig, type TierName } from "./hedgeEngine.js";
import { deriveKalshiOutcome } from "./kalshiEventTypes.js";

const BET_SIZE_USD = 100;

type SweepConfig = {
  label: string;
  longOtmFromSpotFrac: number;
  spreadWidthFrac: number;
  sizingMultiplier: number;
};

const SHIELD_CANDIDATES: SweepConfig[] = [
  { label: "Shield (current)   1%-OTM, 6% width, 7×",  longOtmFromSpotFrac: 0.01, spreadWidthFrac: 0.06, sizingMultiplier: 7.0 },
  { label: "Shield+sizing      1%-OTM, 6% width, 8×",  longOtmFromSpotFrac: 0.01, spreadWidthFrac: 0.06, sizingMultiplier: 8.0 },
  { label: "Shield+sizing      1%-OTM, 6% width, 9×",  longOtmFromSpotFrac: 0.01, spreadWidthFrac: 0.06, sizingMultiplier: 9.0 },
  { label: "Shield wider       1%-OTM, 8% width, 7×",  longOtmFromSpotFrac: 0.01, spreadWidthFrac: 0.08, sizingMultiplier: 7.0 },
  { label: "Shield wider       1%-OTM, 8% width, 8×",  longOtmFromSpotFrac: 0.01, spreadWidthFrac: 0.08, sizingMultiplier: 8.0 },
  { label: "Shield ATM         ATM,    6% width, 7×",  longOtmFromSpotFrac: 0.0,  spreadWidthFrac: 0.06, sizingMultiplier: 7.0 },
  { label: "Shield ATM+wider   ATM,    8% width, 7×",  longOtmFromSpotFrac: 0.0,  spreadWidthFrac: 0.08, sizingMultiplier: 7.0 },
  { label: "Shield ATM+wider   ATM,    8% width, 8×",  longOtmFromSpotFrac: 0.0,  spreadWidthFrac: 0.08, sizingMultiplier: 8.0 },
  { label: "Shield ATM+wider   ATM,    8% width, 9×",  longOtmFromSpotFrac: 0.0,  spreadWidthFrac: 0.08, sizingMultiplier: 9.0 },
  { label: "Shield ATM+widest  ATM,    10% width, 7×", longOtmFromSpotFrac: 0.0,  spreadWidthFrac: 0.10, sizingMultiplier: 7.0 },
  { label: "Shield ATM+widest  ATM,    10% width, 8×", longOtmFromSpotFrac: 0.0,  spreadWidthFrac: 0.10, sizingMultiplier: 8.0 },
];

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main() {
  await mkdir("output", { recursive: true });
  const priceMap = await fetchBtcDailyPrices("2023-11-01", "2026-04-26");
  const allCloses = buildCloseSeries(priceMap, "2023-11-01", "2026-04-26");
  const closePrices = allCloses.map(d => d.price);
  const closeDates = allCloses.map(d => d.date);

  const baseCfg = TIER_CONFIGS["shield"]; // we'll override the geometry fields per candidate

  console.log(
    "Configuration".padEnd(45) + " | " +
    "Fee%".padStart(6) + " | " +
    "MedRec%".padStart(8) + " | " +
    "AvgRec%".padStart(8) + " | " +
    "Best$".padStart(6) + " | " +
    "Median$ on $40".padStart(15)
  );
  console.log("-".repeat(105));

  for (const cand of SHIELD_CANDIDATES) {
    // Build a synthetic TierConfig
    const cfg: TierConfig = {
      ...baseCfg,
      longOtmFromSpotFrac: cand.longOtmFromSpotFrac,
      spreadWidthFrac: cand.spreadWidthFrac,
      sizingMultiplier: cand.sizingMultiplier,
    };
    // Temporarily inject into TIER_CONFIGS so quoteTier picks it up
    (TIER_CONFIGS as any)["shield"] = cfg;

    const fees: number[] = [];
    const recsAdverse: number[] = [];
    const savesAdverse: number[] = [];

    for (const market of KALSHI_BTC_MARKETS) {
      if (market.eventType === "HIT") continue;
      const btcAtOpen = getPriceOnDate(priceMap, market.openDate);
      const btcAtSettle = getPriceOnDate(priceMap, market.settleDate);
      if (!btcAtOpen || !btcAtSettle) continue;
      const openIdx = closeDates.indexOf(market.openDate);
      const rvol = openIdx >= 5 ? realizedVol30d(closePrices, openIdx) : 0.55;
      const derivedOutcome = deriveKalshiOutcome(market.eventType, market.barrier, btcAtSettle, btcAtOpen);
      const quote = quoteTier({
        tier: "shield" as TierName, eventType: market.eventType,
        userDirection: market.userDirection, barrier: market.barrier,
        yesPrice: market.yesPrice, betSizeUsd: BET_SIZE_USD,
        btcAtOpen, rvol, tenorDays: market.daysToSettle,
      });
      if (!quote.hedgeable) continue;
      const outcome = settleTier({
        quote, eventType: market.eventType, userDirection: market.userDirection,
        yesPrice: market.yesPrice, betSizeUsd: BET_SIZE_USD,
        kalshiOutcome: derivedOutcome, btcAtOpen, btcAtSettle,
      });
      fees.push(quote.feePctOfStake * 100);
      // BTC-adverse losing market check
      const isLoss = outcome.kalshiPnlUsd < 0;
      const adverse = (quote.instrument === "put" && (btcAtSettle - btcAtOpen) / btcAtOpen < 0)
                   || (quote.instrument === "call" && (btcAtSettle - btcAtOpen) / btcAtOpen > 0);
      if (isLoss && adverse) {
        recsAdverse.push(outcome.recoveryPctOfStake * 100);
        savesAdverse.push(outcome.userSavedUsd);
      }
    }

    const avgFee = fees.reduce((s, v) => s + v, 0) / fees.length;
    const medRec = median(recsAdverse);
    const avgRec = recsAdverse.reduce((s, v) => s + v, 0) / recsAdverse.length;
    const bestSave = Math.max(...savesAdverse);
    const medianSaveOn40 = (medRec * 40 / 100).toFixed(2);

    console.log(
      cand.label.padEnd(45) + " | " +
      `${avgFee.toFixed(1)}%`.padStart(6) + " | " +
      `${medRec.toFixed(1)}%`.padStart(8) + " | " +
      `${avgRec.toFixed(1)}%`.padStart(8) + " | " +
      `$${bestSave.toFixed(2)}`.padStart(6) + " | " +
      `$${medianSaveOn40}`.padStart(15)
    );
  }
}
main();
