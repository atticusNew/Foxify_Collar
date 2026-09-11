/**
 * RESOLUTION WHITELIST — the core Tier 2 asset.
 *
 * A cross-venue hedge is only a hedge when both markets settle on verifiably
 * identical terms. This registry is deliberately narrow and human-curated:
 * every template names the venues' settlement basis, the known edge cases, and
 * the checks the matcher must enforce before a pair may quote. Anything not on
 * the list is refused with `resolution_mismatch` — approximate matches are how
 * cross-venue books die.
 *
 * NOT whitelisted (on purpose):
 *   - Crypto price events across venues: Kalshi settles on the CF Benchmarks
 *     BRTI while Polymarket price markets settle on other feeds; near the
 *     strike those can disagree. Tier 1 (listed-derivatives hedge) covers
 *     these correctly instead.
 *   - Elections: an AP call and official certification can diverge in time and
 *     in outcome-definition; each pairing needs market-by-market rules review
 *     before it can ever quote.
 */

export interface LeagueTemplate {
  league: string;
  kalshiSeries: string;
  pmSlugPrefix: string;
  /** Kalshi team codes with their Polymarket slug-code candidates, in order. */
  teamCodeAliases: Record<string, string[]>;
  /** shown to the holder verbatim in the hedge disclosure */
  parityNote: string;
  /** Polymarket sportsMarketType required for the winner pairing */
  pmMarketType: string;
}

/** MLB winner markets: one objective final result on both venues. */
const MLB_TEAMS: Record<string, string[]> = {
  ATL: ["atl"], BAL: ["bal"], BOS: ["bos"], CHC: ["chc"], CWS: ["cws", "chw"],
  CIN: ["cin"], CLE: ["cle"], COL: ["col"], DET: ["det"], HOU: ["hou"],
  KC: ["kc"], LAA: ["laa"], LAD: ["lad"], MIA: ["mia"], MIL: ["mil"],
  MIN: ["min"], NYM: ["nym"], NYY: ["nyy"], ATH: ["ath", "oak"], PHI: ["phi"],
  PIT: ["pit"], SD: ["sd"], SEA: ["sea"], SF: ["sf"], STL: ["stl"],
  TB: ["tb"], TEX: ["tex"], TOR: ["tor"], WSH: ["wsh", "was"], AZ: ["az", "ari"],
};

/** NFL winner markets: same discipline, weekly cadence. */
const NFL_TEAMS: Record<string, string[]> = {
  ARI: ["ari"], ATL: ["atl"], BAL: ["bal"], BUF: ["buf"], CAR: ["car"],
  CHI: ["chi"], CIN: ["cin"], CLE: ["cle"], DAL: ["dal"], DEN: ["den"],
  DET: ["det"], GB: ["gb"], HOU: ["hou"], IND: ["ind"], JAX: ["jax", "jac"],
  KC: ["kc"], LAC: ["lac"], LAR: ["lar", "la"], LV: ["lv"], MIA: ["mia"],
  MIN: ["min"], NE: ["ne"], NO: ["no"], NYG: ["nyg"], NYJ: ["nyj"],
  PHI: ["phi"], PIT: ["pit"], SEA: ["sea"], SF: ["sf"], TB: ["tb"],
  TEN: ["ten"], WSH: ["wsh", "was"],
};

export const LEAGUE_TEMPLATES: LeagueTemplate[] = [
  {
    league: "mlb",
    kalshiSeries: "KXMLBGAME",
    pmSlugPrefix: "mlb",
    teamCodeAliases: MLB_TEAMS,
    pmMarketType: "moneyline",
    parityNote:
      "both venues settle on the official MLB final result for this game; pairs are suspended when start times or postponement handling differ",
  },
  {
    league: "nfl",
    kalshiSeries: "KXNFLGAME",
    pmSlugPrefix: "nfl",
    teamCodeAliases: NFL_TEAMS,
    pmMarketType: "moneyline",
    parityNote:
      "both venues settle on the official NFL final result for this game; pairs are suspended when start times or postponement handling differ",
  },
];

export function templateForSeries(kalshiSeries: string): LeagueTemplate | null {
  return LEAGUE_TEMPLATES.find((t) => t.kalshiSeries === kalshiSeries) ?? null;
}
