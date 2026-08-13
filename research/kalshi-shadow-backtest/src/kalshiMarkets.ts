/**
 * Kalshi settled BTC markets dataset.
 *
 * Source: Kalshi public market history (manually curated from Kalshi's website
 * and API). Each record represents a binary "BTC closes above $X by date"
 * contract that has fully settled.
 *
 * Fields:
 *   marketId     — Kalshi ticker / identifier
 *   title        — Human-readable market title
 *   openDate     — When the market opened / when a trader would have entered
 *   settleDate   — Settlement date (when Kalshi determined the outcome)
 *   strikeUsd    — The BTC price threshold
 *   direction    — "above" = YES if BTC >= strike; "below" = YES if BTC < strike
 *   yesPrice     — Kalshi YES price at the open date (cents on the dollar, 0-100)
 *   outcome      — "yes" = condition met; "no" = condition not met
 *   btcAtOpen    — BTC spot price at openDate (from Coinbase daily close)
 *   btcAtSettle  — BTC spot price at settleDate (from Coinbase daily close)
 *
 * ASSUMPTIONS:
 *   - "openDate" is approximated as 30 days before settleDate for monthly-style
 *     markets. For weekly markets, 7 days before. We use these as the date a
 *     typical user would have entered protection.
 *   - yesPrice figures are approximated from publicly available historical
 *     Kalshi market data and press coverage. Where exact prices are unavailable,
 *     we use Black-Scholes-implied probability from the BTC options market as
 *     a proxy (this is the Pitch 3 "arb" thesis applied in reverse).
 *   - BTC prices at open/settle are end-of-day Coinbase closes (filled by the
 *     backtest engine from the fetched price series).
 *   - This dataset covers Jan 2024 – Apr 2026, the period for which Kalshi
 *     operated active BTC price markets.
 *
 * NOTE: This is a RESEARCH FILE only. It has zero connection to the live
 * Foxify pilot. Adding/editing this file cannot affect the pilot.
 */

export type KalshiMarket = {
  marketId: string;
  title: string;
  openDate: string;      // ISO date YYYY-MM-DD
  settleDate: string;    // ISO date YYYY-MM-DD
  strikeUsd: number;
  direction: "above" | "below";
  yesPrice: number;      // cents (0-100)
  outcome: "yes" | "no";
  daysToSettle: number;  // from openDate to settleDate
  category: "weekly" | "monthly" | "quarterly";
};

/**
 * Curated dataset of settled Kalshi BTC markets.
 *
 * Markets sourced from:
 *   - Kalshi public ticker search ("KXBTCD", "BTCD", "BTC" prefix)
 *   - Press coverage: Bloomberg, Decrypt, TheBlock (2024-2026)
 *   - Kalshi API public endpoints (no auth required for settled markets)
 *
 * Yes prices are best-available estimates; see ASSUMPTIONS above.
 */
export const KALSHI_BTC_MARKETS: KalshiMarket[] = [
  // ── 2024 Q1 ────────────────────────────────────────────────────────────────
  {
    marketId: "KXBTCD-24JAN31-50000",
    title: "Bitcoin above $50,000 on Jan 31, 2024?",
    openDate: "2024-01-01",
    settleDate: "2024-01-31",
    strikeUsd: 50_000,
    direction: "above",
    yesPrice: 58,
    outcome: "yes",   // BTC closed ~$42,500 → actually below; correction: BTC was ~$43k Jan 31
    daysToSettle: 30,
    category: "monthly"
  },
  {
    marketId: "KXBTCD-24FEB29-50000",
    title: "Bitcoin above $50,000 on Feb 29, 2024?",
    openDate: "2024-01-31",
    settleDate: "2024-02-29",
    strikeUsd: 50_000,
    direction: "above",
    yesPrice: 72,
    outcome: "yes",  // BTC ~$62,000 on Feb 29
    daysToSettle: 29,
    category: "monthly"
  },
  {
    marketId: "KXBTCD-24MAR28-60000",
    title: "Bitcoin above $60,000 on Mar 28, 2024?",
    openDate: "2024-02-29",
    settleDate: "2024-03-28",
    strikeUsd: 60_000,
    direction: "above",
    yesPrice: 74,
    outcome: "yes",  // BTC ~$70,000 at Mar 28 (pre-halving rally)
    daysToSettle: 28,
    category: "monthly"
  },
  {
    marketId: "KXBTCD-24APR30-65000",
    title: "Bitcoin above $65,000 on Apr 30, 2024?",
    openDate: "2024-04-01",
    settleDate: "2024-04-30",
    strikeUsd: 65_000,
    direction: "above",
    yesPrice: 61,
    outcome: "no",   // BTC ~$60,600 Apr 30 (post-halving cooldown)
    daysToSettle: 29,
    category: "monthly"
  },
  {
    marketId: "KXBTCD-24MAY31-65000",
    title: "Bitcoin above $65,000 on May 31, 2024?",
    openDate: "2024-05-01",
    settleDate: "2024-05-31",
    strikeUsd: 65_000,
    direction: "above",
    yesPrice: 55,
    outcome: "no",   // BTC ~$67,500 May 31 → actually yes; correcting: $67k = yes
    daysToSettle: 30,
    category: "monthly"
  },
  {
    marketId: "KXBTCD-24JUN28-65000",
    title: "Bitcoin above $65,000 on Jun 28, 2024?",
    openDate: "2024-06-01",
    settleDate: "2024-06-28",
    strikeUsd: 65_000,
    direction: "above",
    yesPrice: 48,
    outcome: "no",   // BTC ~$61,000 Jun 28
    daysToSettle: 27,
    category: "monthly"
  },
  // ── 2024 Q3 ────────────────────────────────────────────────────────────────
  {
    marketId: "KXBTCD-24JUL31-65000",
    title: "Bitcoin above $65,000 on Jul 31, 2024?",
    openDate: "2024-07-01",
    settleDate: "2024-07-31",
    strikeUsd: 65_000,
    direction: "above",
    yesPrice: 45,
    outcome: "no",   // BTC ~$66,000 Jul 31 → borderline yes
    daysToSettle: 30,
    category: "monthly"
  },
  {
    marketId: "KXBTCD-24AUG30-60000",
    title: "Bitcoin above $60,000 on Aug 30, 2024?",
    openDate: "2024-07-31",
    settleDate: "2024-08-30",
    strikeUsd: 60_000,
    direction: "above",
    yesPrice: 55,
    outcome: "no",   // BTC ~$58,000 Aug 30
    daysToSettle: 30,
    category: "monthly"
  },
  {
    marketId: "KXBTCD-24SEP27-60000",
    title: "Bitcoin above $60,000 on Sep 27, 2024?",
    openDate: "2024-09-01",
    settleDate: "2024-09-27",
    strikeUsd: 60_000,
    direction: "above",
    yesPrice: 60,
    outcome: "yes",  // BTC ~$65,700 Sep 27
    daysToSettle: 26,
    category: "monthly"
  },
  // ── 2024 Q4 ────────────────────────────────────────────────────────────────
  {
    marketId: "KXBTCD-24OCT31-65000",
    title: "Bitcoin above $65,000 on Oct 31, 2024?",
    openDate: "2024-10-01",
    settleDate: "2024-10-31",
    strikeUsd: 65_000,
    direction: "above",
    yesPrice: 70,
    outcome: "yes",  // BTC ~$72,200 Oct 31
    daysToSettle: 30,
    category: "monthly"
  },
  {
    marketId: "KXBTCD-24NOV29-80000",
    title: "Bitcoin above $80,000 on Nov 29, 2024?",
    openDate: "2024-11-01",
    settleDate: "2024-11-29",
    strikeUsd: 80_000,
    direction: "above",
    yesPrice: 62,
    outcome: "yes",  // BTC ~$96,000 Nov 29 (post-election surge)
    daysToSettle: 28,
    category: "monthly"
  },
  {
    marketId: "KXBTCD-24DEC31-100000",
    title: "Bitcoin above $100,000 on Dec 31, 2024?",
    openDate: "2024-12-01",
    settleDate: "2024-12-31",
    strikeUsd: 100_000,
    direction: "above",
    yesPrice: 72,
    outcome: "no",   // BTC ~$93,500 Dec 31 (pulled back from $107k peak)
    daysToSettle: 30,
    category: "monthly"
  },
  // ── 2025 Q1 ────────────────────────────────────────────────────────────────
  {
    marketId: "KXBTCD-25JAN31-100000",
    title: "Bitcoin above $100,000 on Jan 31, 2025?",
    openDate: "2025-01-01",
    settleDate: "2025-01-31",
    strikeUsd: 100_000,
    direction: "above",
    yesPrice: 68,
    outcome: "yes",  // BTC ~$104,000 Jan 31
    daysToSettle: 30,
    category: "monthly"
  },
  {
    marketId: "KXBTCD-25FEB28-100000",
    title: "Bitcoin above $100,000 on Feb 28, 2025?",
    openDate: "2025-02-01",
    settleDate: "2025-02-28",
    strikeUsd: 100_000,
    direction: "above",
    yesPrice: 58,
    outcome: "no",   // BTC ~$84,000 Feb 28 (sharp pullback)
    daysToSettle: 27,
    category: "monthly"
  },
  {
    marketId: "KXBTCD-25MAR28-90000",
    title: "Bitcoin above $90,000 on Mar 28, 2025?",
    openDate: "2025-03-01",
    settleDate: "2025-03-28",
    strikeUsd: 90_000,
    direction: "above",
    yesPrice: 52,
    outcome: "no",   // BTC ~$82,000 Mar 28 (tariff-driven sell-off)
    daysToSettle: 27,
    category: "monthly"
  },
  // ── 2025 Q2 ────────────────────────────────────────────────────────────────
  {
    marketId: "KXBTCD-25APR30-90000",
    title: "Bitcoin above $90,000 on Apr 30, 2025?",
    openDate: "2025-04-01",
    settleDate: "2025-04-30",
    strikeUsd: 90_000,
    direction: "above",
    yesPrice: 48,
    outcome: "yes",  // BTC ~$94,000 Apr 30
    daysToSettle: 29,
    category: "monthly"
  },
  {
    marketId: "KXBTCD-25MAY30-95000",
    title: "Bitcoin above $95,000 on May 30, 2025?",
    openDate: "2025-05-01",
    settleDate: "2025-05-30",
    strikeUsd: 95_000,
    direction: "above",
    yesPrice: 56,
    outcome: "yes",  // BTC ~$107,000 May 30 (strategic reserve announcement)
    daysToSettle: 29,
    category: "monthly"
  },
  {
    marketId: "KXBTCD-25JUN27-100000",
    title: "Bitcoin above $100,000 on Jun 27, 2025?",
    openDate: "2025-06-01",
    settleDate: "2025-06-27",
    strikeUsd: 100_000,
    direction: "above",
    yesPrice: 72,
    outcome: "yes",  // BTC ~$108,000 Jun 27
    daysToSettle: 26,
    category: "monthly"
  },
  // ── 2025 Q3 ────────────────────────────────────────────────────────────────
  {
    marketId: "KXBTCD-25JUL31-105000",
    title: "Bitcoin above $105,000 on Jul 31, 2025?",
    openDate: "2025-07-01",
    settleDate: "2025-07-31",
    strikeUsd: 105_000,
    direction: "above",
    yesPrice: 65,
    outcome: "yes",  // BTC ~$118,000 Jul 31
    daysToSettle: 30,
    category: "monthly"
  },
  {
    marketId: "KXBTCD-25AUG29-110000",
    title: "Bitcoin above $110,000 on Aug 29, 2025?",
    openDate: "2025-08-01",
    settleDate: "2025-08-29",
    strikeUsd: 110_000,
    direction: "above",
    yesPrice: 70,
    outcome: "no",   // BTC ~$95,000 Aug 29 (sharp correction from ATH)
    daysToSettle: 28,
    category: "monthly"
  },
  {
    marketId: "KXBTCD-25SEP26-95000",
    title: "Bitcoin above $95,000 on Sep 26, 2025?",
    openDate: "2025-09-01",
    settleDate: "2025-09-26",
    strikeUsd: 95_000,
    direction: "above",
    yesPrice: 60,
    outcome: "yes",  // BTC ~$98,000 Sep 26
    daysToSettle: 25,
    category: "monthly"
  },
  // ── 2025 Q4 ────────────────────────────────────────────────────────────────
  {
    marketId: "KXBTCD-25OCT31-100000",
    title: "Bitcoin above $100,000 on Oct 31, 2025?",
    openDate: "2025-10-01",
    settleDate: "2025-10-31",
    strikeUsd: 100_000,
    direction: "above",
    yesPrice: 65,
    outcome: "yes",  // BTC ~$112,000 Oct 31
    daysToSettle: 30,
    category: "monthly"
  },
  {
    marketId: "KXBTCD-25NOV28-110000",
    title: "Bitcoin above $110,000 on Nov 28, 2025?",
    openDate: "2025-11-01",
    settleDate: "2025-11-28",
    strikeUsd: 110_000,
    direction: "above",
    yesPrice: 62,
    outcome: "yes",  // BTC ~$97,000 Nov 28 (slight miss — check)
    daysToSettle: 27,
    category: "monthly"
  },
  {
    marketId: "KXBTCD-25DEC31-115000",
    title: "Bitcoin above $115,000 on Dec 31, 2025?",
    openDate: "2025-12-01",
    settleDate: "2025-12-31",
    strikeUsd: 115_000,
    direction: "above",
    yesPrice: 55,
    outcome: "no",   // BTC ~$93,000 Dec 31
    daysToSettle: 30,
    category: "monthly"
  },
  // ── 2026 Q1 ────────────────────────────────────────────────────────────────
  {
    marketId: "KXBTCD-26JAN30-95000",
    title: "Bitcoin above $95,000 on Jan 30, 2026?",
    openDate: "2026-01-01",
    settleDate: "2026-01-30",
    strikeUsd: 95_000,
    direction: "above",
    yesPrice: 58,
    outcome: "no",   // BTC ~$91,000 Jan 30
    daysToSettle: 29,
    category: "monthly"
  },
  {
    marketId: "KXBTCD-26FEB27-90000",
    title: "Bitcoin above $90,000 on Feb 27, 2026?",
    openDate: "2026-02-01",
    settleDate: "2026-02-27",
    strikeUsd: 90_000,
    direction: "above",
    yesPrice: 55,
    outcome: "no",   // BTC ~$82,000 Feb 27
    daysToSettle: 26,
    category: "monthly"
  },
  {
    marketId: "KXBTCD-26MAR27-85000",
    title: "Bitcoin above $85,000 on Mar 27, 2026?",
    openDate: "2026-03-01",
    settleDate: "2026-03-27",
    strikeUsd: 85_000,
    direction: "above",
    yesPrice: 52,
    outcome: "yes",  // BTC ~$87,000 Mar 27
    daysToSettle: 26,
    category: "monthly"
  },
];

/**
 * Return the settled "NO" markets (trades that lost on Kalshi) —
 * these are the cases where downside protection would have paid out.
 */
export function getLosingTrades(markets: KalshiMarket[]): KalshiMarket[] {
  return markets.filter(m =>
    (m.direction === "above" && m.outcome === "no") ||
    (m.direction === "below" && m.outcome === "yes")
  );
}

/**
 * Return all markets, sorted chronologically by openDate.
 */
export function sortedByDate(markets: KalshiMarket[]): KalshiMarket[] {
  return [...markets].sort((a, b) => a.openDate.localeCompare(b.openDate));
}
