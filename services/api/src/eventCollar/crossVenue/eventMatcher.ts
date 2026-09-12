/**
 * Event matcher: pair one Kalshi sports market with the identical event on
 * Polymarket, gated by the resolution whitelist.
 *
 * Kalshi game tickers encode the fingerprint:
 *   KXMLBGAME-26SEP131420PITCHC-PIT
 *     -> yy=26 mon=SEP dd=13 time=1420(ET, optional) teams=PIT@CHC side=PIT
 * Polymarket game events encode the same fingerprint in the slug:
 *   mlb-pit-chc-2026-09-13
 *
 * The pairing is accepted only when: the league template whitelists the
 * series, the slug lookup returns a live moneyline market, the team split is
 * unambiguous against the league's team-code table, and the Kalshi side maps
 * positionally onto a Polymarket outcome that survives a name sanity check.
 * Anything else is refused - approximate matches are not hedges.
 */

import type { KalshiMarket } from "../types";
import type { LeagueTemplate } from "./resolutionWhitelist";
import { getEventMarketsBySlug } from "./polymarketPublic";
import type { MatchedPair, PmMarket } from "./types";

const MONTHS: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

export interface ParsedGameTicker {
  yy: string;
  dateIso: string; // YYYY-MM-DD (venue-local game date as encoded)
  /** start time HHMM as encoded in the ticker (ET), when present */
  hhmm: string | null;
  awayCode: string;
  homeCode: string;
  sideCode: string; // the team this Kalshi market's YES refers to
}

/** Split the concatenated team pair using the league's known team codes. */
export function splitTeamCodes(
  pair: string,
  teamCodes: string[],
): { away: string; home: string } | null {
  const matches: Array<{ away: string; home: string }> = [];
  for (let cut = 2; cut <= pair.length - 2; cut += 1) {
    const away = pair.slice(0, cut);
    const home = pair.slice(cut);
    if (teamCodes.includes(away) && teamCodes.includes(home)) {
      matches.push({ away, home });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

/** Parse a Kalshi game market ticker against a league template. */
export function parseGameTicker(
  ticker: string,
  template: LeagueTemplate,
): ParsedGameTicker | null {
  const m = new RegExp(
    `^${template.kalshiSeries}-(\\d{2})([A-Z]{3})(\\d{2})(\\d{4})?([A-Z]+)-([A-Z]+)$`,
  ).exec(ticker);
  if (!m) return null;
  const [, yy, mon, dd, hhmm, teams, sideCode] = m;
  const mm = MONTHS[mon];
  if (!mm) return null;
  const split = splitTeamCodes(teams, Object.keys(template.teamCodeAliases));
  if (!split) return null;
  if (sideCode !== split.away && sideCode !== split.home) return null;
  return {
    yy,
    dateIso: `20${yy}-${mm}-${dd}`,
    hhmm: hhmm ?? null,
    awayCode: split.away,
    homeCode: split.home,
    sideCode,
  };
}

/**
 * When the Kalshi ticker encodes a start time (ET), the Polymarket market's
 * gameStartTime must agree within tolerance. This is the doubleheader guard:
 * same teams, same date, different game must never pair.
 * ET is treated as UTC-4; the 150-minute tolerance also absorbs UTC-5 winters
 * while still rejecting a second game 4+ hours later.
 */
export function startTimesAgree(
  parsed: ParsedGameTicker,
  pmGameStartIso: string,
  toleranceMinutes = 150,
): boolean {
  if (!parsed.hhmm) return true; // no encoded time (e.g. NFL): nothing to check
  const hh = Number(parsed.hhmm.slice(0, 2));
  const mi = Number(parsed.hhmm.slice(2));
  const tickerUtc = new Date(`${parsed.dateIso}T00:00:00Z`).getTime() + ((hh + 4) * 60 + mi) * 60_000;
  const pmUtc = new Date(pmGameStartIso).getTime();
  if (Number.isNaN(pmUtc)) return false;
  return Math.abs(pmUtc - tickerUtc) / 60_000 <= toleranceMinutes;
}

/** Candidate Polymarket slugs for a parsed game (alias order preserved). */
export function candidateSlugs(parsed: ParsedGameTicker, template: LeagueTemplate): string[] {
  const aways = template.teamCodeAliases[parsed.awayCode] ?? [];
  const homes = template.teamCodeAliases[parsed.homeCode] ?? [];
  const slugs: string[] = [];
  for (const a of aways) {
    for (const h of homes) {
      slugs.push(`${template.pmSlugPrefix}-${a}-${h}-${parsed.dateIso}`);
    }
  }
  return slugs;
}

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

/**
 * Sanity check: the Kalshi side's display name must be a prefix of, or share a
 * distinguishing token with, the mapped Polymarket outcome. Positional mapping
 * (away/home order, cross-checked against start time) is primary; this guards
 * against a mis-ordered listing. Names too short to verify (e.g. "A's") defer
 * to the positional mapping instead of rejecting a valid pair.
 */
export function outcomeNameMatches(kalshiSubtitle: string, pmOutcome: string): boolean {
  const k = normalize(kalshiSubtitle);
  const p = normalize(pmOutcome);
  if (!k || !p) return false;
  if (p.startsWith(k) || k.startsWith(p)) return true;
  const kTokens = k.split(/\s+/).filter((t) => t.length >= 3);
  if (kTokens.length === 0) return true; // unverifiable: trust position + time
  // Token fallback must hit a DISTINGUISHING token: the leading city word is
  // shared by crosstown rivals (Chicago Cubs / Chicago White Sox) and proves
  // nothing, so it is excluded.
  const pWords = p.split(/\s+/);
  const pDistinguishing = new Set(pWords.slice(1));
  return kTokens.some((t) => pDistinguishing.has(t));
}

/** Pick the winner (moneyline) market from an event's markets. */
export function pickMoneyline(markets: PmMarket[], template: LeagueTemplate): PmMarket | null {
  const live = markets.filter(
    (m) =>
      m.sportsMarketType === template.pmMarketType &&
      m.active &&
      !m.closed &&
      m.outcomes.length === 2 &&
      m.tokenIds.length === 2,
  );
  return live[0] ?? null;
}

/**
 * Pair one Kalshi game market with its Polymarket twin. Returns null when no
 * whitelisted, verified pairing exists (the caller refuses honestly).
 */
export async function matchKalshiMarket(
  kalshi: KalshiMarket,
  template: LeagueTemplate,
  fetchImpl: typeof fetch = fetch,
): Promise<MatchedPair | null> {
  const parsed = parseGameTicker(kalshi.ticker, template);
  if (!parsed) return null;

  for (const slug of candidateSlugs(parsed, template)) {
    let markets: PmMarket[];
    try {
      markets = await getEventMarketsBySlug(slug, fetchImpl);
    } catch {
      continue;
    }
    const pm = pickMoneyline(markets, template);
    if (!pm) continue;
    if (!pm.gameStartTime) continue;
    if (!startTimesAgree(parsed, pm.gameStartTime)) continue;

    // Positional mapping: slug and Kalshi event code are both away-then-home,
    // and Polymarket sports outcomes list away first.
    const yesIndex = parsed.sideCode === parsed.awayCode ? 0 : 1;
    const noIndex = 1 - yesIndex;
    if (!outcomeNameMatches(kalshi.subtitle, pm.outcomes[yesIndex])) return null;

    return {
      league: template.league,
      kalshi,
      pm,
      pmYesOutcomeIndex: yesIndex,
      pmNoOutcomeIndex: noIndex,
      gameStartTime: pm.gameStartTime,
      parityNote: template.parityNote,
      fingerprint: `${template.league}:${parsed.awayCode}:${parsed.homeCode}:${parsed.dateIso}`,
    };
  }
  return null;
}
