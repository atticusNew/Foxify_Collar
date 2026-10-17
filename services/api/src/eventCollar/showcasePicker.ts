/**
 * Showcase selection: the visitor lands on a real, live Kalshi BTC market with
 * a simulated holder position already on screen (the "land operating" pattern).
 *
 * Market choice: the most liquid active market whose mark sits inside the
 * quotable band with enough time left to tell the story.
 *
 * Entry price honesty: the simulated entry is a REAL earlier trade print from
 * Kalshi's public trades feed when one exists (labeled as such); otherwise the
 * current mark is used and the position is labeled as entered-now.
 */

import type { KalshiMarket, KalshiTrade } from "./types";
import { midCents } from "./kalshiPublic";

export interface ShowcasePosition {
  contracts: number;
  entryCents: number;
  entrySource: "real_print" | "entered_now";
  entryTime: string | null;
}

export interface ShowcaseSelection {
  market: KalshiMarket;
  markCents: number;
}

export interface ShowcasePickConfig {
  markLowerBoundCents: number;
  markUpperBoundCents: number;
  minMinutesToResolution: number;
  maxMinutesToResolution: number;
}

export const DEFAULT_PICK_CONFIG: ShowcasePickConfig = {
  markLowerBoundCents: 12,
  markUpperBoundCents: 90,
  minMinutesToResolution: 45,
  maxMinutesToResolution: 24 * 60,
};

/**
 * All quotable-band candidates, best first. The service walks this list until
 * one actually quotes a positive credit, so a market whose books cannot fund a
 * credit right now (or is running out of time) rotates to the next best one
 * instead of pinning the page to a refusal.
 */
export function rankShowcaseCandidates(
  markets: KalshiMarket[],
  now: Date,
  cfg: ShowcasePickConfig = DEFAULT_PICK_CONFIG,
): ShowcaseSelection[] {
  const candidates = markets
    .filter((m) => m.status === "active")
    .map((m) => ({ m, mark: midCents(m) }))
    .filter(({ m, mark }) => {
      const minutes = (new Date(m.closeTime).getTime() - now.getTime()) / 60_000;
      return (
        minutes >= cfg.minMinutesToResolution &&
        minutes <= cfg.maxMinutesToResolution &&
        mark >= cfg.markLowerBoundCents &&
        mark <= cfg.markUpperBoundCents &&
        m.yesBidCents > 0 &&
        m.yesAskCents < 100
      );
    });
  candidates.sort((a, b) => {
    // liquidity first, then tighter spread, then nearer resolution
    if (b.m.volume !== a.m.volume) return b.m.volume - a.m.volume;
    const spreadA = a.m.yesAskCents - a.m.yesBidCents;
    const spreadB = b.m.yesAskCents - b.m.yesBidCents;
    if (spreadA !== spreadB) return spreadA - spreadB;
    return new Date(a.m.closeTime).getTime() - new Date(b.m.closeTime).getTime();
  });
  return candidates.map(({ m, mark }) => ({ market: m, markCents: mark }));
}

export function pickShowcaseMarket(
  markets: KalshiMarket[],
  now: Date,
  cfg: ShowcasePickConfig = DEFAULT_PICK_CONFIG,
): ShowcaseSelection | null {
  return rankShowcaseCandidates(markets, now, cfg)[0] ?? null;
}

/**
 * Build the simulated holder position from real prints. Prefers the oldest
 * available print BELOW the current mark (the hero story: gains since entry),
 * else the oldest print, else entered-now at mark.
 */
export function buildShowcasePosition(
  trades: KalshiTrade[],
  markCents: number,
  contracts: number,
): ShowcasePosition {
  const usable = trades.filter((t) => t.priceCents > 0 && t.priceCents < 100);
  if (usable.length > 0) {
    // trades arrive newest first; walk from the oldest
    const oldestFirst = [...usable].reverse();
    const below = oldestFirst.find((t) => t.priceCents < markCents);
    const chosen = below ?? oldestFirst[0];
    return {
      contracts,
      entryCents: chosen.priceCents,
      entrySource: "real_print",
      entryTime: chosen.createdTime || null,
    };
  }
  return { contracts, entryCents: markCents, entrySource: "entered_now", entryTime: null };
}
