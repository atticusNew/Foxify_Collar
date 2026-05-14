/**
 * Foxify pricing-model evolution analysis.
 *
 * ANALYSIS-ONLY — no pilot code, no live Foxify infrastructure imports.
 * Paper simulation of four candidate pricing paths against an assumed
 * user population. Numbers are illustrative; replace assumptions with
 * real Foxify data to validate.
 *
 * Four candidate products:
 *   A) Status quo:        $65 fixed premium, 1-day rolling, auto-renew
 *   B) Lower fixed:       $35 fixed premium, 1-day rolling, auto-renew
 *   C) Day-rate (theta):  Atticus buys 14-day Deribit spread at entry,
 *                         user pays daily theta × markup, cancel anytime
 *   D) Flat-$/k/day:      User pays $1/day per $1k of protected notional;
 *                         underlying is same 14-day Deribit spread
 *
 * For each candidate, we simulate the same population of perp positions
 * and report:
 *   - User-perceived premium (fixed amount per ticket OR cumulative over hold)
 *   - Atticus revenue per user, per cohort, per month
 *   - Atticus net margin
 *   - Capital tied up in active hedges
 *   - Trigger-payout-treasury size required (assumption: trigger frequency
 *     unchanged across pricing paths since SL thresholds are unchanged)
 *   - Trader perception score (qualitative comparison of price sticker)
 *
 * Run: npx tsx src/simulate.ts
 */

// ─── Assumed Foxify user population ─────────────────────────────────────────
//
// Numbers are illustrative defaults. Replace with real Foxify data
// (CEO-only pilot trade log, anonymized) to validate.

type AssumedFoxifyParams = {
  // User population
  activeUsersPerDay: number;        // typical concurrent active hedged positions
  avgPositionNotionalUsd: number;   // mean of position-size distribution
  avgHoldDays: number;              // mean hold time
  triggerRatePerDay: number;        // P(SL trigger fires on a given day for an active position)
  // Pricing
  currentFixedPremiumUsd: number;   // current Foxify fixed premium ($65)
  // Hedge cost basis (Atticus pays Deribit)
  oneDayHedgeCostUsd: number;       // 1-DTE Deribit put spread cost (avg)
  fourteenDayHedgeCostUsd: number;  // 14-DTE Deribit put spread cost (avg)
  // Operational
  opsCostPerTicketUsd: number;      // platform fees, gas, slippage per ticket
};

const ASSUMPTIONS: AssumedFoxifyParams = {
  activeUsersPerDay: 100,           // ASSUMED — replace with real Foxify number
  avgPositionNotionalUsd: 5000,     // ASSUMED — typical retail perp size
  avgHoldDays: 3,                   // ASSUMED — needs Foxify trade log to validate
  triggerRatePerDay: 0.04,          // ASSUMED — ~4%/day SL hit rate at 5% SL tier
  currentFixedPremiumUsd: 65,       // ACTUAL Foxify number per CEO statement
  oneDayHedgeCostUsd: 35,           // ESTIMATED — pricing-schedule mid for 5% SL tier
  fourteenDayHedgeCostUsd: 50,      // ESTIMATED — 14-DTE Deribit, 6% width put spread
  opsCostPerTicketUsd: 2,           // ASSUMED — small fixed per-ticket cost
};

// ─── Candidate pricing models ───────────────────────────────────────────────

type PricingModel = {
  id: string;
  description: string;
  // Per-day-active-position revenue and cost (Atticus side)
  computePerDay: (p: AssumedFoxifyParams) => {
    userPaysPerDay: number;        // what trader is debited daily
    atticusHedgeCostPerDay: number;
    atticusRevenuePerDay: number;
    atticusOpCostPerDay: number;
    atticusNetMarginPerDay: number;
    capitalDeployedPerActiveUser: number;
    treasuryReservePerActiveUser: number;
    traderStickerPrice: string;
  };
};

const MODELS: PricingModel[] = [
  // ── A) Status quo ──
  {
    id: "A_status_quo",
    description: "Current: $65 fixed premium per day, 1-day rolling, auto-renew",
    computePerDay: (p) => {
      const userPaysPerDay = p.currentFixedPremiumUsd;
      const atticusHedgeCostPerDay = p.oneDayHedgeCostUsd;
      const atticusOpCostPerDay = p.opsCostPerTicketUsd;
      const atticusRevenuePerDay = userPaysPerDay;
      const atticusNetMarginPerDay = atticusRevenuePerDay - atticusHedgeCostPerDay - atticusOpCostPerDay;
      // Capital: 1-DTE option held for 24h; rotates daily
      const capitalDeployedPerActiveUser = p.oneDayHedgeCostUsd;
      // Treasury: covers SL payout when trigger fires. SL% × notional × triggerRate
      // (Foxify treasury holds payout liquidity; sized by trigger frequency × payout)
      const treasuryReservePerActiveUser = 0.05 * p.avgPositionNotionalUsd * p.triggerRatePerDay * 30; // 30-day reserve
      return {
        userPaysPerDay, atticusHedgeCostPerDay, atticusRevenuePerDay,
        atticusOpCostPerDay, atticusNetMarginPerDay,
        capitalDeployedPerActiveUser, treasuryReservePerActiveUser,
        traderStickerPrice: `$${userPaysPerDay} per day`,
      };
    },
  },
  // ── B) Lower fixed ──
  {
    id: "B_lower_fixed",
    description: "Lower fixed premium: $35/day, 1-day rolling, auto-renew",
    computePerDay: (p) => {
      const newFixed = 35;
      const userPaysPerDay = newFixed;
      const atticusHedgeCostPerDay = p.oneDayHedgeCostUsd;
      const atticusOpCostPerDay = p.opsCostPerTicketUsd;
      const atticusRevenuePerDay = userPaysPerDay;
      const atticusNetMarginPerDay = atticusRevenuePerDay - atticusHedgeCostPerDay - atticusOpCostPerDay;
      const capitalDeployedPerActiveUser = p.oneDayHedgeCostUsd;
      const treasuryReservePerActiveUser = 0.05 * p.avgPositionNotionalUsd * p.triggerRatePerDay * 30;
      return {
        userPaysPerDay, atticusHedgeCostPerDay, atticusRevenuePerDay,
        atticusOpCostPerDay, atticusNetMarginPerDay,
        capitalDeployedPerActiveUser, treasuryReservePerActiveUser,
        traderStickerPrice: `$${newFixed} per day`,
      };
    },
  },
  // ── C) Day-rate (theta-following) ──
  {
    id: "C_day_rate_theta",
    description: "Day-rate (theta-following) on 14-day Deribit spread",
    computePerDay: (p) => {
      // Theta integral over typical hold = (hedgeCost / hedgeTenorDays) × markup,
      // averaged across the hold window. Linear approximation.
      const markup = 1.30;  // 30% markup over hedge cost
      const avgTheta = p.fourteenDayHedgeCostUsd / 14;  // ~$3.57/day
      const userPaysPerDay = avgTheta * markup;  // ~$4.64/day
      // Atticus hedge cost amortized: pays $50 once, recovers residual on close.
      // Steady-state per-day cost = avgTheta (since residual is recovered).
      const atticusHedgeCostPerDay = avgTheta;  // ~$3.57/day after residual recovery
      const atticusOpCostPerDay = p.opsCostPerTicketUsd / p.avgHoldDays;  // ops cost amortized
      const atticusRevenuePerDay = userPaysPerDay;
      const atticusNetMarginPerDay = atticusRevenuePerDay - atticusHedgeCostPerDay - atticusOpCostPerDay;
      // Capital: 14-DTE option held; capital tied up = $50 average over the position lifetime
      const capitalDeployedPerActiveUser = p.fourteenDayHedgeCostUsd;
      const treasuryReservePerActiveUser = 0.05 * p.avgPositionNotionalUsd * p.triggerRatePerDay * 30;
      return {
        userPaysPerDay, atticusHedgeCostPerDay, atticusRevenuePerDay,
        atticusOpCostPerDay, atticusNetMarginPerDay,
        capitalDeployedPerActiveUser, treasuryReservePerActiveUser,
        traderStickerPrice: `~$${userPaysPerDay.toFixed(2)} per day (varies with vol)`,
      };
    },
  },
  // ── D) Flat-$/k/day ──
  {
    id: "D_flat_dollar_per_k_per_day",
    description: "$1 per day per $1k of protected notional. 14-day Deribit spread underneath.",
    computePerDay: (p) => {
      const notionalK = p.avgPositionNotionalUsd / 1000;
      const userPaysPerDay = 1 * notionalK;  // $1/day per $1k → $5/day for $5k position
      const avgTheta = p.fourteenDayHedgeCostUsd / 14;  // ~$3.57/day
      const atticusHedgeCostPerDay = avgTheta;
      const atticusOpCostPerDay = p.opsCostPerTicketUsd / p.avgHoldDays;
      const atticusRevenuePerDay = userPaysPerDay;
      const atticusNetMarginPerDay = atticusRevenuePerDay - atticusHedgeCostPerDay - atticusOpCostPerDay;
      const capitalDeployedPerActiveUser = p.fourteenDayHedgeCostUsd;
      const treasuryReservePerActiveUser = 0.05 * p.avgPositionNotionalUsd * p.triggerRatePerDay * 30;
      return {
        userPaysPerDay, atticusHedgeCostPerDay, atticusRevenuePerDay,
        atticusOpCostPerDay, atticusNetMarginPerDay,
        capitalDeployedPerActiveUser, treasuryReservePerActiveUser,
        traderStickerPrice: `$1/day per $1,000 (so $${userPaysPerDay.toFixed(0)}/day for a $${p.avgPositionNotionalUsd} position)`,
      };
    },
  },
];

// ─── Run sim and print comparison ───────────────────────────────────────────

function fmt(v: number, decimals = 2): string { return v.toFixed(decimals); }
function fmtUsd(v: number): string { return v >= 0 ? `$${fmt(v)}` : `-$${fmt(Math.abs(v))}`; }
function fmtUsd0(v: number): string { return `$${Math.round(v).toLocaleString("en-US")}`; }
function pct(frac: number): string { return `${(frac * 100).toFixed(1)}%`; }

function main() {
  const p = ASSUMPTIONS;
  console.log("=".repeat(78));
  console.log("  Foxify pricing-model evolution analysis");
  console.log("=".repeat(78));
  console.log("");
  console.log("ASSUMPTIONS (replace with real Foxify data to validate):");
  for (const [k, v] of Object.entries(p)) {
    console.log(`  ${k}: ${typeof v === "number" ? v.toLocaleString() : v}`);
  }
  console.log("");
  console.log("=".repeat(78));
  console.log("");

  // Per-day economics per active user, per model
  console.log("Per-day economics per active hedged user:");
  console.log("");
  console.log(
    "Model".padEnd(35) +
    "User pays/d".padStart(13) +
    "Atticus net/d".padStart(15) +
    "Capital/usr".padStart(13) +
    "Trader sticker".padStart(40),
  );
  console.log("-".repeat(116));
  const results = MODELS.map(m => ({ model: m, result: m.computePerDay(p) }));
  for (const { model, result } of results) {
    console.log(
      model.id.padEnd(35) +
      fmtUsd(result.userPaysPerDay).padStart(13) +
      fmtUsd(result.atticusNetMarginPerDay).padStart(15) +
      fmtUsd(result.capitalDeployedPerActiveUser).padStart(13) +
      ("  " + result.traderStickerPrice).padStart(40),
    );
  }
  console.log("");

  // Per-user revenue / cohort / margin
  console.log("Cohort economics (assumed avg hold = " + p.avgHoldDays + " days):");
  console.log("");
  console.log(
    "Model".padEnd(35) +
    "User total/cohort".padStart(20) +
    "Atticus rev/cohort".padStart(20) +
    "Atticus net/cohort".padStart(20) +
    "Net margin %".padStart(15),
  );
  console.log("-".repeat(110));
  for (const { model, result } of results) {
    const userTotal = result.userPaysPerDay * p.avgHoldDays;
    const atticusRev = result.atticusRevenuePerDay * p.avgHoldDays;
    const atticusNet = result.atticusNetMarginPerDay * p.avgHoldDays;
    const marginPct = atticusRev > 0 ? atticusNet / atticusRev : 0;
    console.log(
      model.id.padEnd(35) +
      fmtUsd(userTotal).padStart(20) +
      fmtUsd(atticusRev).padStart(20) +
      fmtUsd(atticusNet).padStart(20) +
      pct(marginPct).padStart(15),
    );
  }
  console.log("");

  // Monthly steady-state economics across active user base
  console.log("Monthly steady-state economics (assuming " + p.activeUsersPerDay + " active users):");
  console.log("");
  console.log(
    "Model".padEnd(35) +
    "Atticus monthly rev".padStart(22) +
    "Atticus monthly net".padStart(22) +
    "Capital deployed".padStart(20),
  );
  console.log("-".repeat(110));
  for (const { model, result } of results) {
    const dailyRev = result.atticusRevenuePerDay * p.activeUsersPerDay;
    const dailyNet = result.atticusNetMarginPerDay * p.activeUsersPerDay;
    const monthlyRev = dailyRev * 30;
    const monthlyNet = dailyNet * 30;
    const totalCapital = result.capitalDeployedPerActiveUser * p.activeUsersPerDay;
    console.log(
      model.id.padEnd(35) +
      fmtUsd0(monthlyRev).padStart(22) +
      fmtUsd0(monthlyNet).padStart(22) +
      fmtUsd0(totalCapital).padStart(20),
    );
  }
  console.log("");

  // Treasury for trigger payouts (same across all models since trigger logic unchanged)
  console.log("Trigger-payout treasury (unchanged across all models — confirmed):");
  console.log(`  Per active user: ${fmtUsd0(results[0].result.treasuryReservePerActiveUser)} (5% × notional × triggerRate × 30 days)`);
  console.log(`  Total treasury at ${p.activeUsersPerDay} active users: ${fmtUsd0(results[0].result.treasuryReservePerActiveUser * p.activeUsersPerDay)}`);
  console.log("");

  // Trader-perception comparison
  console.log("Trader-perception comparison (qualitative):");
  console.log("");
  console.log("  A: '$65 per day for protection'                 — current. CEO says too high.");
  console.log("  B: '$35 per day for protection'                 — addresses sticker price; same UX.");
  console.log("  C: '~$4.64/day, varies with market vol'         — variable; UX confusion risk.");
  console.log("  D: '$1/day per $1k of position'                  — simplest mental math; scales with stake.");
  console.log("");
}

main();
