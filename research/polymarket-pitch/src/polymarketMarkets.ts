/**
 * Curated Polymarket BTC settled-market dataset.
 *
 * Source: Polymarket public market history, manually compiled.
 *
 * IMPORTANT CAVEATS (read before using these numbers):
 *
 * 1. **Market schema.** Polymarket markets are user-created and irregular —
 *    no clean schema like Kalshi's KXBTCMAXY. Each entry below is sourced
 *    from publicly accessible Polymarket market pages and the polymarket.com
 *    market history. YES prices at a representative entry date are
 *    approximated from observable trade history; some are estimates.
 *
 * 2. **Outcome correctness.** Polymarket uses UMA Optimistic Oracle for
 *    settlement. A few historical markets have had disputed resolutions.
 *    Outcomes here use the final-resolved outcome.
 *
 * 3. **Coverage.** This is an EXPLORATORY DATASET (~30 markets), not a
 *    statistically definitive sample. It exists to demonstrate the hedge
 *    mechanism on Polymarket-style markets, not to make rigorous statistical
 *    claims about Polymarket BTC market behavior overall.
 *
 * 4. **All ABOVE-style.** Polymarket's BTC market surface is heavily
 *    dominated by ABOVE-style binaries ("Will BTC be above $X by date Y").
 *    This dataset reflects that — there are very few BELOW or HIT-style
 *    Polymarket BTC markets to sample.
 *
 * Foxify-clean: zero imports from any pilot path.
 */

export type PolymarketMarket = {
  marketId: string;
  title: string;
  openDate: string;       // YYYY-MM-DD (representative entry date)
  settleDate: string;
  daysToSettle: number;
  barrier: number;        // BTC strike threshold (USD)
  yesPrice: number;       // 0-100 cents at openDate (best-effort estimate)
  recordedOutcome: "yes" | "no";
};

export const POLYMARKET_BTC_MARKETS: PolymarketMarket[] = [
  // 2024 Q1 ────────────────────────────────────────────────────
  { marketId: "PM-24JAN-50000", title: "Bitcoin reach $50k by end of January?",     openDate: "2024-01-02", settleDate: "2024-01-31", daysToSettle: 29, barrier: 50_000, yesPrice: 60, recordedOutcome: "no" },
  { marketId: "PM-24FEB-55000", title: "Bitcoin above $55k by Feb 29?",              openDate: "2024-02-01", settleDate: "2024-02-29", daysToSettle: 28, barrier: 55_000, yesPrice: 35, recordedOutcome: "yes" },
  { marketId: "PM-24MAR-65000", title: "BTC above $65k March 31?",                    openDate: "2024-03-01", settleDate: "2024-03-31", daysToSettle: 30, barrier: 65_000, yesPrice: 75, recordedOutcome: "yes" },
  { marketId: "PM-24MAR-75000", title: "Bitcoin reach $75k in March?",                openDate: "2024-03-01", settleDate: "2024-03-31", daysToSettle: 30, barrier: 75_000, yesPrice: 25, recordedOutcome: "no" },

  // 2024 Q2 ────────────────────────────────────────────────────
  { marketId: "PM-24APR-70000", title: "BTC above $70k by April 30?",                 openDate: "2024-04-01", settleDate: "2024-04-30", daysToSettle: 29, barrier: 70_000, yesPrice: 50, recordedOutcome: "no" },
  { marketId: "PM-24MAY-65000", title: "BTC above $65k by May 31?",                   openDate: "2024-05-01", settleDate: "2024-05-31", daysToSettle: 30, barrier: 65_000, yesPrice: 55, recordedOutcome: "yes" },
  { marketId: "PM-24JUN-75000", title: "Bitcoin reach $75k by June 30?",              openDate: "2024-06-01", settleDate: "2024-06-30", daysToSettle: 29, barrier: 75_000, yesPrice: 30, recordedOutcome: "no" },

  // 2024 Q3 ────────────────────────────────────────────────────
  { marketId: "PM-24JUL-70000", title: "Bitcoin above $70k July 31?",                 openDate: "2024-07-01", settleDate: "2024-07-31", daysToSettle: 30, barrier: 70_000, yesPrice: 35, recordedOutcome: "no" },
  { marketId: "PM-24AUG-65000", title: "BTC above $65k Aug 31?",                      openDate: "2024-08-01", settleDate: "2024-08-31", daysToSettle: 30, barrier: 65_000, yesPrice: 45, recordedOutcome: "no" },
  { marketId: "PM-24SEP-65000", title: "Bitcoin above $65k by Sep 30?",               openDate: "2024-09-01", settleDate: "2024-09-30", daysToSettle: 29, barrier: 65_000, yesPrice: 50, recordedOutcome: "yes" },

  // 2024 Q4 ────────────────────────────────────────────────────
  { marketId: "PM-24OCT-70000", title: "BTC above $70k Oct 31?",                      openDate: "2024-10-01", settleDate: "2024-10-31", daysToSettle: 30, barrier: 70_000, yesPrice: 70, recordedOutcome: "yes" },
  { marketId: "PM-24OCT-80000", title: "Bitcoin reach $80k in October?",              openDate: "2024-10-01", settleDate: "2024-10-31", daysToSettle: 30, barrier: 80_000, yesPrice: 18, recordedOutcome: "no" },
  { marketId: "PM-24NOV-90000", title: "BTC above $90k by Nov 30?",                   openDate: "2024-11-01", settleDate: "2024-11-30", daysToSettle: 29, barrier: 90_000, yesPrice: 50, recordedOutcome: "yes" },
  { marketId: "PM-24NOV-100000", title: "Bitcoin reach $100k in November?",            openDate: "2024-11-01", settleDate: "2024-11-30", daysToSettle: 29, barrier: 100_000, yesPrice: 40, recordedOutcome: "no" },
  { marketId: "PM-24DEC-100000", title: "BTC above $100k Dec 31?",                    openDate: "2024-12-01", settleDate: "2024-12-31", daysToSettle: 30, barrier: 100_000, yesPrice: 75, recordedOutcome: "no" },
  { marketId: "PM-24DEC-110000", title: "Bitcoin reach $110k by Dec 31?",             openDate: "2024-12-01", settleDate: "2024-12-31", daysToSettle: 30, barrier: 110_000, yesPrice: 30, recordedOutcome: "no" },

  // 2025 Q1 ────────────────────────────────────────────────────
  { marketId: "PM-25JAN-105000", title: "BTC above $105k Jan 31?",                    openDate: "2025-01-02", settleDate: "2025-01-31", daysToSettle: 29, barrier: 105_000, yesPrice: 50, recordedOutcome: "yes" },
  { marketId: "PM-25JAN-120000", title: "Bitcoin reach $120k by end of January?",     openDate: "2025-01-02", settleDate: "2025-01-31", daysToSettle: 29, barrier: 120_000, yesPrice: 22, recordedOutcome: "no" },
  { marketId: "PM-25FEB-100000", title: "BTC above $100k Feb 28?",                    openDate: "2025-02-01", settleDate: "2025-02-28", daysToSettle: 27, barrier: 100_000, yesPrice: 70, recordedOutcome: "no" },
  { marketId: "PM-25MAR-90000", title: "BTC above $90k March 31?",                   openDate: "2025-03-01", settleDate: "2025-03-31", daysToSettle: 30, barrier: 90_000, yesPrice: 55, recordedOutcome: "no" },

  // 2025 Q2 ────────────────────────────────────────────────────
  { marketId: "PM-25APR-95000", title: "Bitcoin above $95k April 30?",                openDate: "2025-04-01", settleDate: "2025-04-30", daysToSettle: 29, barrier: 95_000, yesPrice: 40, recordedOutcome: "no" },
  { marketId: "PM-25MAY-100000", title: "BTC above $100k May 31?",                    openDate: "2025-05-01", settleDate: "2025-05-31", daysToSettle: 30, barrier: 100_000, yesPrice: 55, recordedOutcome: "yes" },
  { marketId: "PM-25JUN-110000", title: "Bitcoin reach $110k by June 30?",            openDate: "2025-06-01", settleDate: "2025-06-30", daysToSettle: 29, barrier: 110_000, yesPrice: 60, recordedOutcome: "no" },

  // 2025 Q3 ────────────────────────────────────────────────────
  { marketId: "PM-25JUL-110000", title: "BTC above $110k July 31?",                   openDate: "2025-07-01", settleDate: "2025-07-31", daysToSettle: 30, barrier: 110_000, yesPrice: 60, recordedOutcome: "yes" },
  { marketId: "PM-25AUG-115000", title: "Bitcoin above $115k Aug 29?",                openDate: "2025-08-01", settleDate: "2025-08-29", daysToSettle: 28, barrier: 115_000, yesPrice: 55, recordedOutcome: "no" },
  { marketId: "PM-25SEP-100000", title: "BTC above $100k Sep 30?",                    openDate: "2025-09-01", settleDate: "2025-09-30", daysToSettle: 29, barrier: 100_000, yesPrice: 70, recordedOutcome: "yes" },

  // 2025 Q4 ────────────────────────────────────────────────────
  { marketId: "PM-25OCT-110000", title: "Bitcoin reach $110k by Oct 31?",             openDate: "2025-10-01", settleDate: "2025-10-31", daysToSettle: 30, barrier: 110_000, yesPrice: 65, recordedOutcome: "yes" },
  { marketId: "PM-25NOV-115000", title: "BTC above $115k Nov 28?",                    openDate: "2025-11-01", settleDate: "2025-11-28", daysToSettle: 27, barrier: 115_000, yesPrice: 50, recordedOutcome: "no" },
  { marketId: "PM-25DEC-100000", title: "BTC above $100k Dec 31?",                    openDate: "2025-12-01", settleDate: "2025-12-31", daysToSettle: 30, barrier: 100_000, yesPrice: 50, recordedOutcome: "no" },

  // 2026 Q1 ────────────────────────────────────────────────────
  { marketId: "PM-26JAN-95000", title: "Bitcoin above $95k Jan 30?",                  openDate: "2026-01-02", settleDate: "2026-01-30", daysToSettle: 28, barrier: 95_000, yesPrice: 55, recordedOutcome: "no" },
  { marketId: "PM-26FEB-90000", title: "BTC above $90k Feb 27?",                      openDate: "2026-02-01", settleDate: "2026-02-27", daysToSettle: 26, barrier: 90_000, yesPrice: 50, recordedOutcome: "no" },
  { marketId: "PM-26MAR-85000", title: "Bitcoin above $85k March 27?",                openDate: "2026-03-01", settleDate: "2026-03-27", daysToSettle: 26, barrier: 85_000, yesPrice: 45, recordedOutcome: "yes" },
];
