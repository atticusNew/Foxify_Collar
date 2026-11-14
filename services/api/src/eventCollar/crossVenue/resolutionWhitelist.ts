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
  /**
   * Kalshi team code → the club's canonical full name ("Oklahoma City Thunder").
   * Both venues abbreviate differently (Kalshi's subtitle is the city, "Oklahoma
   * City"; Polymarket's outcome is the nickname, "Thunder", or the full name),
   * so each side is verified against this name rather than against each other.
   */
  teamNames: Record<string, string>;
  /** shown to the holder verbatim in the hedge disclosure */
  parityNote: string;
  /** Polymarket sportsMarketType required for the winner pairing */
  pmMarketType: string;
}

/** One club: Kalshi code → [Polymarket slug codes in order, canonical full name]. */
type TeamTable = Record<string, [string[], string]>;

const aliasesOf = (t: TeamTable): Record<string, string[]> =>
  Object.fromEntries(Object.entries(t).map(([code, [aliases]]) => [code, aliases]));
const namesOf = (t: TeamTable): Record<string, string> =>
  Object.fromEntries(Object.entries(t).map(([code, [, name]]) => [code, name]));

/** MLB winner markets: one objective final result on both venues. */
const MLB_TEAMS: TeamTable = {
  ATL: [["atl"], "Atlanta Braves"], BAL: [["bal"], "Baltimore Orioles"],
  BOS: [["bos"], "Boston Red Sox"], CHC: [["chc"], "Chicago Cubs"],
  CWS: [["cws", "chw"], "Chicago White Sox"], CIN: [["cin"], "Cincinnati Reds"],
  CLE: [["cle"], "Cleveland Guardians"], COL: [["col"], "Colorado Rockies"],
  DET: [["det"], "Detroit Tigers"], HOU: [["hou"], "Houston Astros"],
  KC: [["kc"], "Kansas City Royals"], LAA: [["laa"], "Los Angeles Angels"],
  LAD: [["lad"], "Los Angeles Dodgers"], MIA: [["mia"], "Miami Marlins"],
  MIL: [["mil"], "Milwaukee Brewers"], MIN: [["min"], "Minnesota Twins"],
  NYM: [["nym"], "New York Mets"], NYY: [["nyy"], "New York Yankees"],
  ATH: [["ath", "oak"], "Athletics"], PHI: [["phi"], "Philadelphia Phillies"],
  PIT: [["pit"], "Pittsburgh Pirates"], SD: [["sd"], "San Diego Padres"],
  SEA: [["sea"], "Seattle Mariners"], SF: [["sf"], "San Francisco Giants"],
  STL: [["stl"], "St. Louis Cardinals"], TB: [["tb"], "Tampa Bay Rays"],
  TEX: [["tex"], "Texas Rangers"], TOR: [["tor"], "Toronto Blue Jays"],
  WSH: [["wsh", "was"], "Washington Nationals"], AZ: [["az", "ari"], "Arizona Diamondbacks"],
};

/**
 * NFL winner markets: same discipline, weekly cadence. Kalshi uses WAS and JAC
 * in its game tickers (verified live 2026-09); the WSH/JAX keys are kept so a
 * ticker written either way still parses.
 */
const NFL_TEAMS: TeamTable = {
  ARI: [["ari"], "Arizona Cardinals"], ATL: [["atl"], "Atlanta Falcons"],
  BAL: [["bal"], "Baltimore Ravens"], BUF: [["buf"], "Buffalo Bills"],
  CAR: [["car"], "Carolina Panthers"], CHI: [["chi"], "Chicago Bears"],
  CIN: [["cin"], "Cincinnati Bengals"], CLE: [["cle"], "Cleveland Browns"],
  DAL: [["dal"], "Dallas Cowboys"], DEN: [["den"], "Denver Broncos"],
  DET: [["det"], "Detroit Lions"], GB: [["gb"], "Green Bay Packers"],
  HOU: [["hou"], "Houston Texans"], IND: [["ind"], "Indianapolis Colts"],
  JAC: [["jax", "jac"], "Jacksonville Jaguars"], JAX: [["jax", "jac"], "Jacksonville Jaguars"],
  KC: [["kc"], "Kansas City Chiefs"], LAC: [["lac"], "Los Angeles Chargers"],
  LAR: [["lar", "la"], "Los Angeles Rams"], LV: [["lv"], "Las Vegas Raiders"],
  MIA: [["mia"], "Miami Dolphins"], MIN: [["min"], "Minnesota Vikings"],
  NE: [["ne"], "New England Patriots"], NO: [["no"], "New Orleans Saints"],
  NYG: [["nyg"], "New York Giants"], NYJ: [["nyj"], "New York Jets"],
  PHI: [["phi"], "Philadelphia Eagles"], PIT: [["pit"], "Pittsburgh Steelers"],
  SEA: [["sea"], "Seattle Seahawks"], SF: [["sf"], "San Francisco 49ers"],
  TB: [["tb"], "Tampa Bay Buccaneers"], TEN: [["ten"], "Tennessee Titans"],
  WAS: [["was", "wsh"], "Washington Commanders"], WSH: [["was", "wsh"], "Washington Commanders"],
};

/**
 * NBA winner markets: one objective final result on both venues, no
 * doubleheaders. Polymarket slug codes verified against the 2025-26 season
 * (`nba-{away}-{home}-{date}`, all 30 clubs); Kalshi tickers verified against
 * the 2026-27 opening slate (KXNBAGAME-26OCT20OKCSAS-SAS, no start time
 * encoded). Codes Kalshi has not yet shown live carry the common alternate
 * spellings as extra keys, exactly as NFL does for WAS/WSH.
 */
const NBA_TEAMS: TeamTable = {
  ATL: [["atl"], "Atlanta Hawks"], BOS: [["bos"], "Boston Celtics"],
  BKN: [["bkn"], "Brooklyn Nets"], BRK: [["bkn"], "Brooklyn Nets"],
  CHA: [["cha"], "Charlotte Hornets"], CHI: [["chi"], "Chicago Bulls"],
  CLE: [["cle"], "Cleveland Cavaliers"], DAL: [["dal"], "Dallas Mavericks"],
  DEN: [["den"], "Denver Nuggets"], DET: [["det"], "Detroit Pistons"],
  GSW: [["gsw"], "Golden State Warriors"], GS: [["gsw"], "Golden State Warriors"],
  HOU: [["hou"], "Houston Rockets"], IND: [["ind"], "Indiana Pacers"],
  LAC: [["lac"], "Los Angeles Clippers"], LAL: [["lal"], "Los Angeles Lakers"],
  MEM: [["mem"], "Memphis Grizzlies"], MIA: [["mia"], "Miami Heat"],
  MIL: [["mil"], "Milwaukee Bucks"], MIN: [["min"], "Minnesota Timberwolves"],
  NOP: [["nop"], "New Orleans Pelicans"], NO: [["nop"], "New Orleans Pelicans"],
  NYK: [["nyk"], "New York Knicks"], NY: [["nyk"], "New York Knicks"],
  OKC: [["okc"], "Oklahoma City Thunder"], ORL: [["orl"], "Orlando Magic"],
  PHI: [["phi"], "Philadelphia 76ers"], PHX: [["phx"], "Phoenix Suns"],
  PHO: [["phx"], "Phoenix Suns"], POR: [["por"], "Portland Trail Blazers"],
  SAC: [["sac"], "Sacramento Kings"], SAS: [["sas"], "San Antonio Spurs"],
  SA: [["sas"], "San Antonio Spurs"], TOR: [["tor"], "Toronto Raptors"],
  UTA: [["uta"], "Utah Jazz"], UTAH: [["uta"], "Utah Jazz"],
  WAS: [["was"], "Washington Wizards"], WSH: [["was"], "Washington Wizards"],
};

/**
 * NHL winner markets: one objective final result on both venues (overtime and the shootout
 * count, so no tie in the regular season), no doubleheaders. Kalshi codes read from the live
 * 2026-27 slate on 2026-11-02 (KXNHLGAME-26NOV08PITANA-PIT: no start time encoded, like NFL);
 * Polymarket slug codes read from the same week's game markets (`nhl-{away}-{home}-{date}`,
 * all 32 clubs: cal, lak, las, mon, utah where Kalshi has CGY, LA, VGK, MTL, UTA). The common
 * alternate spellings ride as extra keys, as WAS/WSH does for NFL.
 */
const NHL_TEAMS: TeamTable = {
  ANA: [["ana"], "Anaheim Ducks"], BOS: [["bos"], "Boston Bruins"],
  BUF: [["buf"], "Buffalo Sabres"], CAR: [["car"], "Carolina Hurricanes"],
  CBJ: [["cbj"], "Columbus Blue Jackets"], CGY: [["cal", "cgy"], "Calgary Flames"],
  CAL: [["cal", "cgy"], "Calgary Flames"], CHI: [["chi"], "Chicago Blackhawks"],
  COL: [["col"], "Colorado Avalanche"], DAL: [["dal"], "Dallas Stars"],
  DET: [["det"], "Detroit Red Wings"], EDM: [["edm"], "Edmonton Oilers"],
  FLA: [["fla"], "Florida Panthers"], LA: [["lak", "la"], "Los Angeles Kings"],
  LAK: [["lak", "la"], "Los Angeles Kings"], MIN: [["min"], "Minnesota Wild"],
  MTL: [["mon", "mtl"], "Montreal Canadiens"], MON: [["mon", "mtl"], "Montreal Canadiens"],
  NJ: [["nj", "njd"], "New Jersey Devils"], NJD: [["nj", "njd"], "New Jersey Devils"],
  NSH: [["nsh"], "Nashville Predators"], NYI: [["nyi"], "New York Islanders"],
  NYR: [["nyr"], "New York Rangers"], OTT: [["ott"], "Ottawa Senators"],
  PHI: [["phi"], "Philadelphia Flyers"], PIT: [["pit"], "Pittsburgh Penguins"],
  SEA: [["sea"], "Seattle Kraken"], SJ: [["sj", "sjs"], "San Jose Sharks"],
  SJS: [["sj", "sjs"], "San Jose Sharks"], STL: [["stl"], "St. Louis Blues"],
  TB: [["tb", "tbl"], "Tampa Bay Lightning"], TBL: [["tb", "tbl"], "Tampa Bay Lightning"],
  TOR: [["tor"], "Toronto Maple Leafs"], UTA: [["utah", "uta"], "Utah Mammoth"],
  UTAH: [["utah", "uta"], "Utah Mammoth"], VAN: [["van"], "Vancouver Canucks"],
  VGK: [["las", "vgk", "veg"], "Vegas Golden Knights"], VEG: [["las", "vgk", "veg"], "Vegas Golden Knights"],
  WPG: [["wpg"], "Winnipeg Jets"], WSH: [["wsh", "was"], "Washington Capitals"],
  WAS: [["wsh", "was"], "Washington Capitals"],
};

export const LEAGUE_TEMPLATES: LeagueTemplate[] = [
  {
    league: "mlb",
    kalshiSeries: "KXMLBGAME",
    pmSlugPrefix: "mlb",
    teamCodeAliases: aliasesOf(MLB_TEAMS),
    teamNames: namesOf(MLB_TEAMS),
    pmMarketType: "moneyline",
    parityNote:
      "both venues settle on the official MLB final result for this game; pairs are suspended when start times or postponement handling differ",
  },
  {
    league: "nfl",
    kalshiSeries: "KXNFLGAME",
    pmSlugPrefix: "nfl",
    teamCodeAliases: aliasesOf(NFL_TEAMS),
    teamNames: namesOf(NFL_TEAMS),
    pmMarketType: "moneyline",
    parityNote:
      "both venues settle on the official NFL final result for this game; pairs are suspended when start times or postponement handling differ",
  },
  {
    league: "nba",
    kalshiSeries: "KXNBAGAME",
    pmSlugPrefix: "nba",
    teamCodeAliases: aliasesOf(NBA_TEAMS),
    teamNames: namesOf(NBA_TEAMS),
    pmMarketType: "moneyline",
    parityNote:
      "both venues settle on the official NBA final result for this game; pairs are suspended when start times or postponement handling differ",
  },
  {
    league: "nhl",
    kalshiSeries: "KXNHLGAME",
    pmSlugPrefix: "nhl",
    teamCodeAliases: aliasesOf(NHL_TEAMS),
    teamNames: namesOf(NHL_TEAMS),
    pmMarketType: "moneyline",
    parityNote:
      "both venues settle on the official NHL final result for this game, overtime and shootout included; pairs are suspended when start times or postponement handling differ",
  },
];

export function templateForSeries(kalshiSeries: string): LeagueTemplate | null {
  return LEAGUE_TEMPLATES.find((t) => t.kalshiSeries === kalshiSeries) ?? null;
}
