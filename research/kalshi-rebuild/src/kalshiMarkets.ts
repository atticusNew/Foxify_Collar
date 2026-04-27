/**
 * Kalshi BTC settled markets dataset (rebuild package, multi-archetype).
 *
 * SCOPE EXPANSION VS PRIOR PACKAGE:
 *   The prior package (research/kalshi-shadow-backtest/) held 27 markets
 *   all of `direction: "above"` archetype. The rebuild expands to all three
 *   archetypes Kalshi actually trades on BTC:
 *     ABOVE — KXBTC2025100, KXBTCD-* style "Will BTC be above $X by date Y"
 *     BELOW — KXBTCMINY-* style "Will BTC go below $X" / "How low?"
 *     HIT   — KXBTCMAX150-* style "When will BTC hit $X" first-to-touch
 *
 *   Range-bin events (KXBTCMAXY) decompose into a chain of ABOVE markets at
 *   adjacent strikes — for backtest purposes we model them as ABOVE markets
 *   for the relevant strike per row.
 *
 * USER DIRECTION FIELD:
 *   Each row carries `userDirection: "yes" | "no"`. This is the bet the
 *   notional user placed. For ABOVE markets we typically set userDirection
 *   = "yes" (the dominant Kalshi flow on bullish BTC markets), and for
 *   BELOW markets we typically set "yes" too (user betting the down-target
 *   is hit). For HIT we also set "yes". When pitching, we'll show stats
 *   per (event_type × userDirection) cell so prospects can see all four
 *   quadrants.
 *
 * APPROXIMATION FLAGS:
 *   - yesPrice: best-effort historical mid from press coverage / public
 *     Kalshi snapshots. Some are interpolated from BS-implied probability
 *     where Kalshi historical books are unavailable.
 *   - HIT settlement is approximated at expiry close (true HIT is path-
 *     dependent; see kalshiEventTypes.ts notes).
 *
 * ISOLATION:
 *   This file imports nothing from any pilot path. Foxify-clean.
 */

import type { EventType, UserDirection } from "./kalshiEventTypes.js";

export type KalshiMarket = {
  marketId: string;
  title: string;
  openDate: string;          // YYYY-MM-DD
  settleDate: string;
  daysToSettle: number;
  eventType: EventType;
  barrier: number;           // strike threshold in USD
  userDirection: UserDirection;
  yesPrice: number;          // cents 0-100 at openDate
  /** True (path-dependent for HIT) outcome from public settlement; left as-is. */
  recordedOutcome: "yes" | "no";
  category: "weekly" | "monthly" | "quarterly";
};

export const KALSHI_BTC_MARKETS: KalshiMarket[] = [
  // ── ABOVE archetype (carried forward from prior package, USERDIRECTION = YES) ──
  // 27 markets covering Jan 2024 – Mar 2026. Outcomes via derived-from-price
  // convention at runtime (4 of these had recorded-vs-derived mismatches).
  { marketId: "KXBTCD-24JAN31-50000", title: "Bitcoin above $50,000 on Jan 31, 2024?",  openDate: "2024-01-01", settleDate: "2024-01-31", daysToSettle: 30, eventType: "ABOVE", barrier: 50_000,  userDirection: "yes", yesPrice: 58, recordedOutcome: "yes", category: "monthly" },
  { marketId: "KXBTCD-24FEB29-50000", title: "Bitcoin above $50,000 on Feb 29, 2024?",  openDate: "2024-01-31", settleDate: "2024-02-29", daysToSettle: 29, eventType: "ABOVE", barrier: 50_000,  userDirection: "yes", yesPrice: 72, recordedOutcome: "yes", category: "monthly" },
  { marketId: "KXBTCD-24MAR28-60000", title: "Bitcoin above $60,000 on Mar 28, 2024?",  openDate: "2024-02-29", settleDate: "2024-03-28", daysToSettle: 28, eventType: "ABOVE", barrier: 60_000,  userDirection: "yes", yesPrice: 74, recordedOutcome: "yes", category: "monthly" },
  { marketId: "KXBTCD-24APR30-65000", title: "Bitcoin above $65,000 on Apr 30, 2024?",  openDate: "2024-04-01", settleDate: "2024-04-30", daysToSettle: 29, eventType: "ABOVE", barrier: 65_000,  userDirection: "yes", yesPrice: 61, recordedOutcome: "no",  category: "monthly" },
  { marketId: "KXBTCD-24MAY31-65000", title: "Bitcoin above $65,000 on May 31, 2024?",  openDate: "2024-05-01", settleDate: "2024-05-31", daysToSettle: 30, eventType: "ABOVE", barrier: 65_000,  userDirection: "yes", yesPrice: 55, recordedOutcome: "no",  category: "monthly" },
  { marketId: "KXBTCD-24JUN28-65000", title: "Bitcoin above $65,000 on Jun 28, 2024?",  openDate: "2024-06-01", settleDate: "2024-06-28", daysToSettle: 27, eventType: "ABOVE", barrier: 65_000,  userDirection: "yes", yesPrice: 48, recordedOutcome: "no",  category: "monthly" },
  { marketId: "KXBTCD-24JUL31-65000", title: "Bitcoin above $65,000 on Jul 31, 2024?",  openDate: "2024-07-01", settleDate: "2024-07-31", daysToSettle: 30, eventType: "ABOVE", barrier: 65_000,  userDirection: "yes", yesPrice: 45, recordedOutcome: "no",  category: "monthly" },
  { marketId: "KXBTCD-24AUG30-60000", title: "Bitcoin above $60,000 on Aug 30, 2024?",  openDate: "2024-07-31", settleDate: "2024-08-30", daysToSettle: 30, eventType: "ABOVE", barrier: 60_000,  userDirection: "yes", yesPrice: 55, recordedOutcome: "no",  category: "monthly" },
  { marketId: "KXBTCD-24SEP27-60000", title: "Bitcoin above $60,000 on Sep 27, 2024?",  openDate: "2024-09-01", settleDate: "2024-09-27", daysToSettle: 26, eventType: "ABOVE", barrier: 60_000,  userDirection: "yes", yesPrice: 60, recordedOutcome: "yes", category: "monthly" },
  { marketId: "KXBTCD-24OCT31-65000", title: "Bitcoin above $65,000 on Oct 31, 2024?",  openDate: "2024-10-01", settleDate: "2024-10-31", daysToSettle: 30, eventType: "ABOVE", barrier: 65_000,  userDirection: "yes", yesPrice: 70, recordedOutcome: "yes", category: "monthly" },
  { marketId: "KXBTCD-24NOV29-80000", title: "Bitcoin above $80,000 on Nov 29, 2024?",  openDate: "2024-11-01", settleDate: "2024-11-29", daysToSettle: 28, eventType: "ABOVE", barrier: 80_000,  userDirection: "yes", yesPrice: 62, recordedOutcome: "yes", category: "monthly" },
  { marketId: "KXBTCD-24DEC31-100000", title: "Bitcoin above $100,000 on Dec 31, 2024?", openDate: "2024-12-01", settleDate: "2024-12-31", daysToSettle: 30, eventType: "ABOVE", barrier: 100_000, userDirection: "yes", yesPrice: 72, recordedOutcome: "no",  category: "monthly" },
  { marketId: "KXBTCD-25JAN31-100000", title: "Bitcoin above $100,000 on Jan 31, 2025?", openDate: "2025-01-01", settleDate: "2025-01-31", daysToSettle: 30, eventType: "ABOVE", barrier: 100_000, userDirection: "yes", yesPrice: 68, recordedOutcome: "yes", category: "monthly" },
  { marketId: "KXBTCD-25FEB28-100000", title: "Bitcoin above $100,000 on Feb 28, 2025?", openDate: "2025-02-01", settleDate: "2025-02-28", daysToSettle: 27, eventType: "ABOVE", barrier: 100_000, userDirection: "yes", yesPrice: 58, recordedOutcome: "no",  category: "monthly" },
  { marketId: "KXBTCD-25MAR28-90000",  title: "Bitcoin above $90,000 on Mar 28, 2025?",  openDate: "2025-03-01", settleDate: "2025-03-28", daysToSettle: 27, eventType: "ABOVE", barrier: 90_000,  userDirection: "yes", yesPrice: 52, recordedOutcome: "no",  category: "monthly" },
  { marketId: "KXBTCD-25APR30-90000",  title: "Bitcoin above $90,000 on Apr 30, 2025?",  openDate: "2025-04-01", settleDate: "2025-04-30", daysToSettle: 29, eventType: "ABOVE", barrier: 90_000,  userDirection: "yes", yesPrice: 48, recordedOutcome: "yes", category: "monthly" },
  { marketId: "KXBTCD-25MAY30-95000",  title: "Bitcoin above $95,000 on May 30, 2025?",  openDate: "2025-05-01", settleDate: "2025-05-30", daysToSettle: 29, eventType: "ABOVE", barrier: 95_000,  userDirection: "yes", yesPrice: 56, recordedOutcome: "yes", category: "monthly" },
  { marketId: "KXBTCD-25JUN27-100000", title: "Bitcoin above $100,000 on Jun 27, 2025?", openDate: "2025-06-01", settleDate: "2025-06-27", daysToSettle: 26, eventType: "ABOVE", barrier: 100_000, userDirection: "yes", yesPrice: 72, recordedOutcome: "yes", category: "monthly" },
  { marketId: "KXBTCD-25JUL31-105000", title: "Bitcoin above $105,000 on Jul 31, 2025?", openDate: "2025-07-01", settleDate: "2025-07-31", daysToSettle: 30, eventType: "ABOVE", barrier: 105_000, userDirection: "yes", yesPrice: 65, recordedOutcome: "yes", category: "monthly" },
  { marketId: "KXBTCD-25AUG29-110000", title: "Bitcoin above $110,000 on Aug 29, 2025?", openDate: "2025-08-01", settleDate: "2025-08-29", daysToSettle: 28, eventType: "ABOVE", barrier: 110_000, userDirection: "yes", yesPrice: 70, recordedOutcome: "no",  category: "monthly" },
  { marketId: "KXBTCD-25SEP26-95000",  title: "Bitcoin above $95,000 on Sep 26, 2025?",  openDate: "2025-09-01", settleDate: "2025-09-26", daysToSettle: 25, eventType: "ABOVE", barrier: 95_000,  userDirection: "yes", yesPrice: 60, recordedOutcome: "yes", category: "monthly" },
  { marketId: "KXBTCD-25OCT31-100000", title: "Bitcoin above $100,000 on Oct 31, 2025?", openDate: "2025-10-01", settleDate: "2025-10-31", daysToSettle: 30, eventType: "ABOVE", barrier: 100_000, userDirection: "yes", yesPrice: 65, recordedOutcome: "yes", category: "monthly" },
  { marketId: "KXBTCD-25NOV28-110000", title: "Bitcoin above $110,000 on Nov 28, 2025?", openDate: "2025-11-01", settleDate: "2025-11-28", daysToSettle: 27, eventType: "ABOVE", barrier: 110_000, userDirection: "yes", yesPrice: 62, recordedOutcome: "yes", category: "monthly" },
  { marketId: "KXBTCD-25DEC31-115000", title: "Bitcoin above $115,000 on Dec 31, 2025?", openDate: "2025-12-01", settleDate: "2025-12-31", daysToSettle: 30, eventType: "ABOVE", barrier: 115_000, userDirection: "yes", yesPrice: 55, recordedOutcome: "no",  category: "monthly" },
  { marketId: "KXBTCD-26JAN30-95000",  title: "Bitcoin above $95,000 on Jan 30, 2026?",  openDate: "2026-01-01", settleDate: "2026-01-30", daysToSettle: 29, eventType: "ABOVE", barrier: 95_000,  userDirection: "yes", yesPrice: 58, recordedOutcome: "no",  category: "monthly" },
  { marketId: "KXBTCD-26FEB27-90000",  title: "Bitcoin above $90,000 on Feb 27, 2026?",  openDate: "2026-02-01", settleDate: "2026-02-27", daysToSettle: 26, eventType: "ABOVE", barrier: 90_000,  userDirection: "yes", yesPrice: 55, recordedOutcome: "no",  category: "monthly" },
  { marketId: "KXBTCD-26MAR27-85000",  title: "Bitcoin above $85,000 on Mar 27, 2026?",  openDate: "2026-03-01", settleDate: "2026-03-27", daysToSettle: 26, eventType: "ABOVE", barrier: 85_000,  userDirection: "yes", yesPrice: 52, recordedOutcome: "yes", category: "monthly" },

  // ── ABOVE archetype, USER DIRECTION = NO  (samples — bearish bets) ──────────
  // Same underlying markets, NO side. We sample 5 high-volume months where
  // Kalshi NO would have been a meaningful position.
  { marketId: "KXBTCD-24DEC31-100000-NO", title: "BTC above $100k Dec 31 2024 — NO bet",  openDate: "2024-12-01", settleDate: "2024-12-31", daysToSettle: 30, eventType: "ABOVE", barrier: 100_000, userDirection: "no",  yesPrice: 72, recordedOutcome: "no",  category: "monthly" },
  { marketId: "KXBTCD-25FEB28-100000-NO", title: "BTC above $100k Feb 28 2025 — NO bet",  openDate: "2025-02-01", settleDate: "2025-02-28", daysToSettle: 27, eventType: "ABOVE", barrier: 100_000, userDirection: "no",  yesPrice: 58, recordedOutcome: "no",  category: "monthly" },
  { marketId: "KXBTCD-25NOV28-110000-NO", title: "BTC above $110k Nov 28 2025 — NO bet",  openDate: "2025-11-01", settleDate: "2025-11-28", daysToSettle: 27, eventType: "ABOVE", barrier: 110_000, userDirection: "no",  yesPrice: 62, recordedOutcome: "yes", category: "monthly" },
  { marketId: "KXBTCD-25DEC31-115000-NO", title: "BTC above $115k Dec 31 2025 — NO bet",  openDate: "2025-12-01", settleDate: "2025-12-31", daysToSettle: 30, eventType: "ABOVE", barrier: 115_000, userDirection: "no",  yesPrice: 55, recordedOutcome: "no",  category: "monthly" },
  { marketId: "KXBTCD-24NOV29-80000-NO",  title: "BTC above $80k Nov 29 2024 — NO bet",   openDate: "2024-11-01", settleDate: "2024-11-29", daysToSettle: 28, eventType: "ABOVE", barrier: 80_000,  userDirection: "no",  yesPrice: 62, recordedOutcome: "yes", category: "monthly" },

  // ── BELOW archetype (KXBTCMINY-style) — "How low?" / "Will BTC drop below $X?" ──
  // Curated from public Kalshi snapshots and press coverage. Where exact YES
  // price is unavailable we use BS-implied probability proxies.
  { marketId: "KXBTCMINY-24FEB-40000",  title: "Will BTC drop below $40,000 by Feb 29 2024?",  openDate: "2024-01-31", settleDate: "2024-02-29", daysToSettle: 29, eventType: "BELOW", barrier: 40_000,  userDirection: "yes", yesPrice: 22, recordedOutcome: "no",  category: "monthly" },
  { marketId: "KXBTCMINY-24MAY-55000",  title: "Will BTC drop below $55,000 by May 31 2024?",  openDate: "2024-05-01", settleDate: "2024-05-31", daysToSettle: 30, eventType: "BELOW", barrier: 55_000,  userDirection: "yes", yesPrice: 28, recordedOutcome: "no",  category: "monthly" },
  { marketId: "KXBTCMINY-24AUG-50000",  title: "Will BTC drop below $50,000 by Aug 30 2024?",  openDate: "2024-07-31", settleDate: "2024-08-30", daysToSettle: 30, eventType: "BELOW", barrier: 50_000,  userDirection: "yes", yesPrice: 30, recordedOutcome: "no",  category: "monthly" },
  { marketId: "KXBTCMINY-25FEB-85000",  title: "Will BTC drop below $85,000 by Feb 28 2025?", openDate: "2025-02-01", settleDate: "2025-02-28", daysToSettle: 27, eventType: "BELOW", barrier: 85_000,  userDirection: "yes", yesPrice: 35, recordedOutcome: "yes", category: "monthly" },
  { marketId: "KXBTCMINY-25MAR-80000",  title: "Will BTC drop below $80,000 by Mar 28 2025?", openDate: "2025-03-01", settleDate: "2025-03-28", daysToSettle: 27, eventType: "BELOW", barrier: 80_000,  userDirection: "yes", yesPrice: 30, recordedOutcome: "no",  category: "monthly" },
  { marketId: "KXBTCMINY-25NOV-95000",  title: "Will BTC drop below $95,000 by Nov 28 2025?", openDate: "2025-11-01", settleDate: "2025-11-28", daysToSettle: 27, eventType: "BELOW", barrier: 95_000,  userDirection: "yes", yesPrice: 32, recordedOutcome: "yes", category: "monthly" },
  { marketId: "KXBTCMINY-25DEC-90000",  title: "Will BTC drop below $90,000 by Dec 31 2025?", openDate: "2025-12-01", settleDate: "2025-12-31", daysToSettle: 30, eventType: "BELOW", barrier: 90_000,  userDirection: "yes", yesPrice: 25, recordedOutcome: "no",  category: "monthly" },
  { marketId: "KXBTCMINY-26JAN-85000",  title: "Will BTC drop below $85,000 by Jan 30 2026?", openDate: "2026-01-01", settleDate: "2026-01-30", daysToSettle: 29, eventType: "BELOW", barrier: 85_000,  userDirection: "yes", yesPrice: 28, recordedOutcome: "no",  category: "monthly" },
  { marketId: "KXBTCMINY-26FEB-80000",  title: "Will BTC drop below $80,000 by Feb 27 2026?", openDate: "2026-02-01", settleDate: "2026-02-27", daysToSettle: 26, eventType: "BELOW", barrier: 80_000,  userDirection: "yes", yesPrice: 35, recordedOutcome: "no",  category: "monthly" },

  // BELOW archetype, USER DIRECTION = NO (user betting BTC will NOT drop below)
  { marketId: "KXBTCMINY-25FEB-85000-NO", title: "BTC below $85k Feb 28 2025 — NO bet", openDate: "2025-02-01", settleDate: "2025-02-28", daysToSettle: 27, eventType: "BELOW", barrier: 85_000, userDirection: "no",  yesPrice: 35, recordedOutcome: "yes", category: "monthly" },
  { marketId: "KXBTCMINY-25NOV-95000-NO", title: "BTC below $95k Nov 28 2025 — NO bet", openDate: "2025-11-01", settleDate: "2025-11-28", daysToSettle: 27, eventType: "BELOW", barrier: 95_000, userDirection: "no",  yesPrice: 32, recordedOutcome: "yes", category: "monthly" },
  { marketId: "KXBTCMINY-26FEB-80000-NO", title: "BTC below $80k Feb 27 2026 — NO bet", openDate: "2026-02-01", settleDate: "2026-02-27", daysToSettle: 26, eventType: "BELOW", barrier: 80_000, userDirection: "no",  yesPrice: 35, recordedOutcome: "no",  category: "monthly" },

  // ── HIT archetype (KXBTCMAX-style) — "When will BTC hit $X?" first-to-touch ──
  // Backtest approximation: settlement = "did BTC's daily close approach K
  // from the open side at any time during the window". For our daily-close
  // dataset we proxy this with "did S_settle reach barrier within tolerance".
  { marketId: "KXBTCMAX-24Q1-150000",  title: "Will BTC hit $150,000 by Mar 31 2024?",  openDate: "2024-01-15", settleDate: "2024-03-31", daysToSettle: 76, eventType: "HIT", barrier: 150_000, userDirection: "yes", yesPrice: 12, recordedOutcome: "no",  category: "quarterly" },
  { marketId: "KXBTCMAX-24Q4-100000",  title: "Will BTC hit $100,000 by Dec 31 2024?",  openDate: "2024-10-01", settleDate: "2024-12-31", daysToSettle: 91, eventType: "HIT", barrier: 100_000, userDirection: "yes", yesPrice: 65, recordedOutcome: "yes", category: "quarterly" },
  { marketId: "KXBTCMAX-25Q1-120000",  title: "Will BTC hit $120,000 by Mar 31 2025?",  openDate: "2025-01-01", settleDate: "2025-03-31", daysToSettle: 89, eventType: "HIT", barrier: 120_000, userDirection: "yes", yesPrice: 35, recordedOutcome: "no",  category: "quarterly" },
  { marketId: "KXBTCMAX-25Q3-150000",  title: "Will BTC hit $150,000 by Sep 30 2025?",  openDate: "2025-07-01", settleDate: "2025-09-30", daysToSettle: 91, eventType: "HIT", barrier: 150_000, userDirection: "yes", yesPrice: 22, recordedOutcome: "no",  category: "quarterly" },
  { marketId: "KXBTCMAX-25Q4-130000",  title: "Will BTC hit $130,000 by Dec 31 2025?",  openDate: "2025-10-01", settleDate: "2025-12-31", daysToSettle: 91, eventType: "HIT", barrier: 130_000, userDirection: "yes", yesPrice: 28, recordedOutcome: "no",  category: "quarterly" },
  { marketId: "KXBTCMAX-26Q1-110000",  title: "Will BTC hit $110,000 by Mar 31 2026?",  openDate: "2026-01-01", settleDate: "2026-03-31", daysToSettle: 89, eventType: "HIT", barrier: 110_000, userDirection: "yes", yesPrice: 32, recordedOutcome: "no",  category: "quarterly" },
];

/** Convenience: split markets by event type. */
export function marketsByEventType(): Record<EventType, KalshiMarket[]> {
  const out: Record<EventType, KalshiMarket[]> = { ABOVE: [], BELOW: [], HIT: [] };
  for (const m of KALSHI_BTC_MARKETS) out[m.eventType].push(m);
  return out;
}

/** Convenience: split markets by event type AND direction. */
export function marketsByQuadrant(): Record<string, KalshiMarket[]> {
  const out: Record<string, KalshiMarket[]> = {};
  for (const m of KALSHI_BTC_MARKETS) {
    const k = `${m.eventType}/${m.userDirection}`;
    if (!out[k]) out[k] = [];
    out[k].push(m);
  }
  return out;
}
