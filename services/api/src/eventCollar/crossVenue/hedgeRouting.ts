/**
 * HEDGE ROUTING — which venue the writer's hedge goes to, judged on what it costs all in.
 *
 * The holder's position lives on one venue (Kalshi, ProphetX, Novig; Polymarket in principle).
 * The hedge can go to four (Kalshi's own No side, Polymarket's opposing token, ProphetX's
 * opposing strike through the aggregator's pod), of which EVENT_HEDGE_VENUES names the ones
 * offered tonight (hedgeVenuesFromEnv). On the night the
 * game is decided every one of these pays the same way, so the cheaper hedge is simply the cheaper
 * hedge. The venues differ only in the TAILS: a tie, a postponement past the venue's window, a
 * game called off without a result, a result the league corrects later. One venue voids and hands
 * collateral back; another pays each side $0.50; a third settles at the last fair price; a fourth
 * keeps the market open until the game is played. A hedge that settles one way while the holder's
 * position settles another leaves the writer short in that branch.
 *
 * So the route is chosen in six steps, all of them here or disclosed from here:
 *   1. a RULE TABLE per league per venue, four tail branches each, taken from the venues'
 *      published rule text and stored with the source and the sentence it came from. A cell the
 *      text did not confirm says so (confirmed: false) and is priced at its worst plausible
 *      reading. When a market's own text is in hand (Kalshi rules_secondary, Polymarket's
 *      description) it is parsed and overrides the table for that market.
 *   2. a COMPATIBILITY TEST branch by branch: the hedge must pay at least what we owe the holder
 *      in that branch. A hedge that pays while the holder is refunded passes as a windfall.
 *   3. where it fails, a PRICE: the expected shortfall (probability of the branch by league times
 *      the shortfall per contract) as a TAIL CHARGE in the same bps the quote's EV cost uses,
 *      added to that route's cost. The route is chosen on the ALL-IN cost.
 *   4. HARD GATES before price: the game match is verified (the pair), the book has depth for the
 *      whole size (the walk refused otherwise), the hedge venue's market stays open through the
 *      holder's lock, and the executor can actually send to the venue (the rails).
 *   5. execution stays IOC at or under the walked worst price (hedgeExecutor / liveHedge); this
 *      module only names the venue and the reason, which the receipt carries.
 *   6. the TERMS the holder sees name the tails in the holder's own venue's words (tailTerms).
 *
 * Pure. Money in integer cents per contract; probabilities as fractions; nothing here calls a venue.
 */

import type { HedgeRoute } from "./types";

export type SettlementVenue = "kalshi" | "polymarket" | "prophetx" | "novig";
export const SETTLEMENT_VENUES: readonly SettlementVenue[] = ["kalshi", "polymarket", "prophetx", "novig"];
export const VENUE_NAMES: Record<SettlementVenue, string> = { kalshi: "Kalshi", polymarket: "Polymarket", prophetx: "ProphetX", novig: "Novig" };

export const isSettlementVenue = (v: unknown): v is SettlementVenue => typeof v === "string" && (SETTLEMENT_VENUES as readonly string[]).includes(v);

export type TailBranch = "tie" | "postponed" | "abandoned" | "corrected";
export const TAIL_BRANCHES: readonly TailBranch[] = ["tie", "postponed", "abandoned", "corrected"];

/**
 * How a venue settles a moneyline in one tail branch.
 *   half      each side is paid $0.50
 *   void      the position is undone; collateral comes back
 *   fair      settled at the fair / last traded price when the disruption became known
 *   hold      the market stays open and settles on the game when it is played
 *   stands    (corrected results) the result as first announced stands
 *   resettle  (corrected results) the venue settles again on the corrected result
 */
export type TailTreatment = "half" | "void" | "fair" | "hold" | "stands" | "resettle";

export interface RuleCell {
  treatment: TailTreatment;
  /** for postponements: how long the venue waits before the treatment applies (within it the market holds) */
  windowHours?: number;
  /** true when the treatment was read from the venue's text for this league (or this market); false when inferred */
  confirmed: boolean;
  /** where the text was read */
  source: string;
  /** when it was read, ISO date */
  asOf: string;
  /** the venue's sentence, verbatim */
  excerpt: string;
}

export type RuleCells = Record<TailBranch, RuleCell>;

const KALSHI_SERIES_URL = (series: string) => `https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${series}&status=open`;
const PM_MARKET_URL = (slug: string) => `https://gamma-api.polymarket.com/markets?slug=${slug}`;
const PROPHETX_FOOTBALL = "https://prophethelp.zendesk.com/hc/en-us/articles/45512124637841-Football-Rules";
const NOVIG_NFL_WINNER = "https://ludlow-filings.s3.us-east-1.amazonaws.com/nfl-winner-anchor-cl-a.pdf";
const NOVIG_FVS = "https://support.novig.com/en/articles/16163706-what-is-fair-value-settlement-fvs";
const NOVIG_SETTLEMENT = "https://support.novig.com/en/articles/10336135-how-settlement-works-grading-disputes-and-voided-trades";
const READ = "2026-10-28";

const cell = (treatment: TailTreatment, confirmed: boolean, source: string, excerpt: string, windowHours?: number): RuleCell => ({
  treatment,
  ...(windowHours !== undefined ? { windowHours } : {}),
  confirmed,
  source,
  asOf: READ,
  excerpt,
});

const KALSHI_NFL_TIE = "If the game ends in a tie, the market will resolve to $0.50 for each team.";
const KALSHI_NFL_POSTPONED =
  "If the game is postponed but begins within 48 hours from its originally scheduled start time, the market will remain open and resolve based on the official final result. If the game is not started within 48 hours, the market will resolve to a fair price.";
const KALSHI_NBA_POSTPONED =
  "If the game is postponed but begins within 48 hours of its originally scheduled start time, the market will remain open and resolve based on the official final result. If the game is cancelled or not started within 48 hours of its originally scheduled start, all markets will resolve to a fair price.";
const KALSHI_MLB_POSTPONED =
  "If this game is postponed or delayed, the market will remain open and close after the rescheduled game has finished (within two days). If the game is cancelled or rescheduled to over two days away, the market will resolve to a fair price in accordance with the rules.";
const NOT_STATED = "not stated in the text read; priced at its worst plausible reading until a market's own text confirms it";

const PM_NBA = "If the game is postponed, this market will remain open until the game has been completed. If the game is canceled entirely, with no make-up game, this market will resolve 50-50.";
const PM_MLB =
  "If the game is postponed, this market will remain open until the game has been completed. If the game is canceled entirely, with no make-up game, or ends in a tie, this market will resolve 50-50.";
const PM_NFL_2022 = "If the game ends in a tie, this market will resolve 50-50. If the game is not completed by November 13 (11:59:59 PM ET), this market will resolve 50-50.";

const PX_TIE = "If, after the completion of overtime, the result remains tied, all orders on the outright event winner contract shall be void and collateral shall be returned to the applicable accounts.";
const PX_NFL_POSTPONED =
  "If an NFL event commences but is then postponed or abandoned, at least fifty-five (55) minutes of play must have elapsed for orders to be valid. If an event commences and is then suspended prior to fifty-five (55) minutes of play and the event is not completed within the same NFL weekly schedule window, defined as Thursday through Wednesday local stadium time all contracts whose outcomes have not been unequivocally determined shall be void and collateral shall be returned to the applicable accounts.";
const PX_RESETTLE = "ProphetX reserves the right to resettle contracts should additional official information become available.";

const NOVIG_TIE =
  "If the Governing Body records the game as ending in a tie, Contracts settle as a tie under the Payout Criterion, with the Member holding the YES side and the Member holding the NO side each receiving $0.50; a tie is a determined outcome and not a Void.";
const NOVIG_POSTPONED =
  "If the game does not Commence within the window, the Contract will settle to Void, unless the Exchange has formally rescheduled it or it begins within 48 hours of its original start time. [Void settles at Fair Value: the price the market was trading at immediately before the disrupting news became known.]";
const NOVIG_ABANDONED =
  "Absent an official winner or a tie determined on the field, the Contract settles to Void. [Void settles at Fair Value.]";

/**
 * The table. One row per venue per league we quote. Kalshi and Polymarket rows were read from
 * live market text on the date given; ProphetX from its Football Rules; Novig from its NFL winner
 * contract and its Fair Value Settlement article (a Novig void is a fair-value payout, not a
 * refund, so it is `fair` here). Leagues whose text was not read inherit the venue's stated
 * general rule with confirmed: false.
 */
const TABLE: Record<SettlementVenue, Record<string, RuleCells>> = {
  kalshi: {
    nfl: {
      tie: cell("half", true, KALSHI_SERIES_URL("KXNFLGAME"), KALSHI_NFL_TIE),
      postponed: cell("fair", true, KALSHI_SERIES_URL("KXNFLGAME"), KALSHI_NFL_POSTPONED, 48),
      abandoned: cell("fair", false, KALSHI_SERIES_URL("KXNFLGAME"), `${NOT_STATED} (Kalshi's basketball and baseball text says a cancelled game resolves to a fair price)`),
      corrected: cell("stands", false, KALSHI_SERIES_URL("KXNFLGAME"), NOT_STATED),
    },
    nba: {
      tie: cell("half", false, KALSHI_SERIES_URL("KXNBAGAME"), "no tie clause (the league plays overtime until a winner); Kalshi's football text pays $0.50 a side"),
      postponed: cell("fair", true, KALSHI_SERIES_URL("KXNBAGAME"), KALSHI_NBA_POSTPONED, 48),
      abandoned: cell("fair", true, KALSHI_SERIES_URL("KXNBAGAME"), KALSHI_NBA_POSTPONED),
      corrected: cell("stands", false, KALSHI_SERIES_URL("KXNBAGAME"), NOT_STATED),
    },
    mlb: {
      tie: cell("fair", false, KALSHI_SERIES_URL("KXMLBGAME"), "no tie clause; a game called tied is a game without a result, priced here as the cancelled case"),
      postponed: cell("fair", true, KALSHI_SERIES_URL("KXMLBGAME"), KALSHI_MLB_POSTPONED, 48),
      abandoned: cell("fair", true, KALSHI_SERIES_URL("KXMLBGAME"), KALSHI_MLB_POSTPONED),
      corrected: cell("stands", false, KALSHI_SERIES_URL("KXMLBGAME"), NOT_STATED),
    },
  },
  polymarket: {
    nfl: {
      tie: cell("half", false, PM_MARKET_URL("nfl-sunday-chargers-vs-falcons"), `${PM_NFL_2022} [2022 season text; this season's game markets confirm at quote time]`),
      postponed: cell("half", false, PM_MARKET_URL("nfl-sunday-chargers-vs-falcons"), `${PM_NFL_2022} [2022 season text; this season's game markets confirm at quote time]`, 24 * 7),
      abandoned: cell("half", false, PM_MARKET_URL("nfl-sunday-chargers-vs-falcons"), `${PM_NFL_2022} [2022 season text; this season's game markets confirm at quote time]`),
      corrected: cell("stands", false, PM_MARKET_URL("nfl-sunday-chargers-vs-falcons"), NOT_STATED),
    },
    nba: {
      tie: cell("half", false, PM_MARKET_URL("nba-mia-atl-2026-10-28"), "no tie clause (the league plays overtime until a winner); Polymarket's baseball text pays 50-50"),
      postponed: cell("hold", true, PM_MARKET_URL("nba-mia-atl-2026-10-28"), PM_NBA),
      abandoned: cell("half", true, PM_MARKET_URL("nba-mia-atl-2026-10-28"), PM_NBA),
      corrected: cell("stands", false, PM_MARKET_URL("nba-mia-atl-2026-10-28"), NOT_STATED),
    },
    mlb: {
      tie: cell("half", true, PM_MARKET_URL("mlb-mil-tb-2026-10-28"), PM_MLB),
      postponed: cell("hold", true, PM_MARKET_URL("mlb-mil-tb-2026-10-28"), PM_MLB),
      abandoned: cell("half", true, PM_MARKET_URL("mlb-mil-tb-2026-10-28"), PM_MLB),
      corrected: cell("stands", false, PM_MARKET_URL("mlb-mil-tb-2026-10-28"), NOT_STATED),
    },
  },
  prophetx: {
    nfl: {
      tie: cell("void", true, PROPHETX_FOOTBALL, PX_TIE),
      postponed: cell("void", true, PROPHETX_FOOTBALL, PX_NFL_POSTPONED, 24 * 7),
      abandoned: cell("void", true, PROPHETX_FOOTBALL, PX_NFL_POSTPONED),
      corrected: cell("resettle", true, PROPHETX_FOOTBALL, PX_RESETTLE),
    },
    nba: {
      tie: cell("void", false, PROPHETX_FOOTBALL, "no tie in the league; ProphetX voids ties where they occur"),
      postponed: cell("void", false, PROPHETX_FOOTBALL, `${NOT_STATED} (ProphetX's football text voids and returns collateral)`),
      abandoned: cell("void", false, PROPHETX_FOOTBALL, `${NOT_STATED} (ProphetX's football text voids and returns collateral)`),
      corrected: cell("resettle", false, PROPHETX_FOOTBALL, PX_RESETTLE),
    },
    mlb: {
      tie: cell("void", false, PROPHETX_FOOTBALL, `${NOT_STATED} (ProphetX voids ties where they occur)`),
      postponed: cell("void", false, PROPHETX_FOOTBALL, `${NOT_STATED} (ProphetX's football text voids and returns collateral)`),
      abandoned: cell("void", false, PROPHETX_FOOTBALL, `${NOT_STATED} (ProphetX's football text voids and returns collateral)`),
      corrected: cell("resettle", false, PROPHETX_FOOTBALL, PX_RESETTLE),
    },
  },
  novig: {
    nfl: {
      tie: cell("half", true, NOVIG_NFL_WINNER, NOVIG_TIE),
      postponed: cell("fair", true, `${NOVIG_NFL_WINNER} ; ${NOVIG_FVS}`, NOVIG_POSTPONED, 48),
      abandoned: cell("fair", true, `${NOVIG_NFL_WINNER} ; ${NOVIG_FVS}`, NOVIG_ABANDONED),
      corrected: cell("stands", false, NOVIG_NFL_WINNER, NOT_STATED),
    },
    nba: {
      tie: cell("half", false, NOVIG_NFL_WINNER, "no tie in the league; Novig's football contract pays $0.50 a side"),
      postponed: cell("fair", false, NOVIG_SETTLEMENT, "For most markets if an event is postponed and rescheduled within 48 hours the trades will still be considered active. [A void is paid at Fair Market Value.]", 48),
      abandoned: cell("fair", false, NOVIG_SETTLEMENT, "A trade is voided if the event is cancelled ... When a trade is voided, you will be paid out at the Fair Market Value."),
      corrected: cell("stands", false, NOVIG_SETTLEMENT, NOT_STATED),
    },
    mlb: {
      tie: cell("half", false, NOVIG_NFL_WINNER, `${NOT_STATED} (Novig's football contract pays $0.50 a side)`),
      postponed: cell("fair", false, NOVIG_SETTLEMENT, "For most markets if an event is postponed and rescheduled within 48 hours the trades will still be considered active. [A void is paid at Fair Market Value.]", 48),
      abandoned: cell("fair", false, NOVIG_SETTLEMENT, "A trade is voided if the event is cancelled ... When a trade is voided, you will be paid out at the Fair Market Value."),
      corrected: cell("stands", false, NOVIG_SETTLEMENT, NOT_STATED),
    },
  },
};

/** The table's row for a venue and league; an unknown league takes the NFL row with every cell unconfirmed. */
export function tableRules(venue: SettlementVenue, league: string): RuleCells {
  const row = TABLE[venue][league.toLowerCase()];
  if (row) return row;
  const base = TABLE[venue].nfl;
  const out = {} as RuleCells;
  for (const b of TAIL_BRANCHES) out[b] = { ...base[b], confirmed: false, excerpt: `${league}: no row read; ${base[b].excerpt}` };
  return out;
}

const sentenceAround = (text: string, re: RegExp): string | null => {
  const m = re.exec(text);
  if (!m) return null;
  const start = text.lastIndexOf(".", m.index) + 1;
  const end = text.indexOf(".", m.index + m[0].length);
  return text.slice(start, end < 0 ? undefined : end + 1).trim();
};

/**
 * Kalshi's rules_secondary for one market, read for the tails it names. Only sentences that are
 * there produce cells; the rest of the row stays the table's.
 */
export function kalshiTailCells(text: string | null | undefined, source: string, asOf: string): Partial<RuleCells> {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const out: Partial<RuleCells> = {};
  const tie = sentenceAround(t, /ends in a tie, the market will resolve to \$0\.50/i);
  if (tie) out.tie = { treatment: "half", confirmed: true, source, asOf, excerpt: tie };
  const hours = /within (\d+) hours/i.exec(t);
  const twoDays = /over two days/i.test(t);
  const postponedFair = sentenceAround(t, /(not started within \d+ hours|rescheduled to over two days away)[^.]*fair price/i);
  if (postponedFair) out.postponed = { treatment: "fair", windowHours: hours ? Number(hours[1]) : twoDays ? 48 : undefined, confirmed: true, source, asOf, excerpt: postponedFair };
  const cancelled = sentenceAround(t, /cancelled[^.]*fair price/i);
  if (cancelled) out.abandoned = { treatment: "fair", confirmed: true, source, asOf, excerpt: cancelled };
  return out;
}

/** Polymarket's market description, read the same way. */
export function polymarketTailCells(text: string | null | undefined, source: string, asOf: string): Partial<RuleCells> {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const out: Partial<RuleCells> = {};
  const tie = sentenceAround(t, /ends in a tie, this market will resolve 50-50/i);
  if (tie) out.tie = { treatment: "half", confirmed: true, source, asOf, excerpt: tie };
  const hold = sentenceAround(t, /postponed, this market will remain open until the game has been completed/i);
  if (hold) out.postponed = { treatment: "hold", confirmed: true, source, asOf, excerpt: hold };
  const deadline = sentenceAround(t, /not completed by [^.]*50-50/i);
  if (!hold && deadline) out.postponed = { treatment: "half", confirmed: true, source, asOf, excerpt: deadline };
  const cancelled = sentenceAround(t, /canceled entirely, with no make-up game[^.]*50-50/i);
  if (cancelled) out.abandoned = { treatment: "half", confirmed: true, source, asOf, excerpt: cancelled };
  return out;
}

/** The table's row with a market's own text laid over it. */
export function rulesFor(venue: SettlementVenue, league: string, fromText?: Partial<RuleCells>): RuleCells {
  const base = tableRules(venue, league);
  if (!fromText) return base;
  const out = { ...base };
  for (const b of TAIL_BRANCHES) if (fromText[b]) out[b] = fromText[b] as RuleCell;
  return out;
}

/**
 * How often each tail happens, per league, as a fraction of games. Operator estimates from league
 * history (ties: a few NFL games a decade of seasons; postponements past 48 hours: weather, mostly
 * baseball; games called off without a result; results the league later corrects), overridable
 * with EVENT_ROUTING_TAIL_PROBS as JSON of the same shape. Estimates, and said so on the record.
 */
export type TailProbabilities = Record<TailBranch, number>;
export const DEFAULT_TAIL_PROBABILITIES: Record<string, TailProbabilities> = {
  nfl: { tie: 0.004, postponed: 0.002, abandoned: 0.001, corrected: 0.0002 },
  nba: { tie: 0, postponed: 0.003, abandoned: 0.001, corrected: 0.0002 },
  mlb: { tie: 0.0005, postponed: 0.015, abandoned: 0.003, corrected: 0.0002 },
};

export function tailProbabilitiesFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, TailProbabilities> {
  const raw = (env.EVENT_ROUTING_TAIL_PROBS ?? "").trim();
  if (!raw) return DEFAULT_TAIL_PROBABILITIES;
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<TailProbabilities>>;
    const out: Record<string, TailProbabilities> = { ...DEFAULT_TAIL_PROBABILITIES };
    for (const [league, probs] of Object.entries(parsed)) {
      const base = out[league] ?? DEFAULT_TAIL_PROBABILITIES.nfl;
      const next = { ...base };
      for (const b of TAIL_BRANCHES) {
        const v = probs?.[b];
        if (typeof v === "number" && v >= 0 && v <= 1) next[b] = v;
      }
      out[league.toLowerCase()] = next;
    }
    return out;
  } catch {
    return DEFAULT_TAIL_PROBABILITIES;
  }
}

export function tailProbabilities(league: string, table: Record<string, TailProbabilities> = DEFAULT_TAIL_PROBABILITIES): TailProbabilities {
  return table[league.toLowerCase()] ?? table.nfl ?? DEFAULT_TAIL_PROBABILITIES.nfl;
}

/** The collar and its hedge, per holder contract, as the exposure arithmetic needs them. */
export interface TailTerms {
  floorCents: number;
  capCents: number;
  /** the market's mid for the holder's side, cents */
  markCents: number;
  /** No units bought per holder contract, milli (1000 = one No contract per contract) */
  hedgeUnitsPerContractMilli: number;
  /** what one No unit cost, cents (walked average) */
  hedgeAvgPriceCents: number;
}

type Outcome = "yes" | "no";
const PLAUSIBLE: Record<TailBranch, TailTreatment[]> = {
  tie: ["half", "void", "fair", "hold"],
  postponed: ["half", "void", "fair", "hold"],
  abandoned: ["half", "void", "fair", "hold"],
  corrected: ["stands", "resettle"],
};

/** What one No unit on the hedge venue pays under a treatment, cents. `hold` with the other side settled: sold at the mark. */
function hedgePays(t: TailTreatment, terms: TailTerms, announced: Outcome): number {
  switch (t) {
    case "half":
      return 50;
    case "void":
      return terms.hedgeAvgPriceCents;
    case "fair":
    case "hold":
      return 100 - terms.markCents;
    case "stands":
      return announced === "no" ? 100 : 0;
    case "resettle":
      return announced === "no" ? 0 : 100;
  }
}

/** What the holder's venue pays one contract under a treatment, cents; null when the position is voided or still open. */
function holderPaid(t: TailTreatment, terms: TailTerms, announced: Outcome): number | "void" | "hold" {
  switch (t) {
    case "half":
      return 50;
    case "void":
      return "void";
    case "fair":
      return terms.markCents;
    case "hold":
      return "hold";
    case "stands":
      return announced === "yes" ? 100 : 0;
    case "resettle":
      return announced === "yes" ? 0 : 100;
  }
}

/**
 * The writer's shortfall in one branch, cents per holder contract, never negative. The hedge was
 * bought for h x q; its contribution in the branch is h x (pays - q). We owe the holder the floor
 * top-up less the slice above the cap on what the venue paid them; a voided position owes nothing
 * and the lock is void with it; a position still open is hedged again at the mark.
 */
export function branchShortfallCents(holder: TailTreatment, hedge: TailTreatment, terms: TailTerms, announced: Outcome = "yes"): number {
  const h = terms.hedgeUnitsPerContractMilli / 1000;
  const q = terms.hedgeAvgPriceCents;
  const z = hedgePays(hedge, terms, announced);
  const y = holderPaid(holder, terms, announced);
  if (y === "hold") return Math.max(0, h * (100 - terms.markCents) - h * z);
  if (y === "void") return Math.max(0, h * (q - z));
  const owed = Math.max(terms.floorCents - y, 0) - Math.max(y - terms.capCents, 0);
  return Math.max(0, owed - h * (z - q));
}

/** Expected shortfall in a branch over the announced result (matters only for corrected results). */
function expectedBranchShortfall(holder: TailTreatment, hedge: TailTreatment, terms: TailTerms): number {
  const pYes = terms.markCents / 100;
  return pYes * branchShortfallCents(holder, hedge, terms, "yes") + (1 - pYes) * branchShortfallCents(holder, hedge, terms, "no");
}

export interface BranchVerdict {
  branch: TailBranch;
  holder: TailTreatment;
  hedge: TailTreatment;
  /** both cells read from venue text */
  confirmed: boolean;
  /** the treatments differ (or a cell is unconfirmed and was priced at its worst reading) */
  mismatch: boolean;
  /** fraction of games */
  probability: number;
  /** expected shortfall in the branch, cents per holder contract (before the probability) */
  shortfallCents: number;
  /** probability x shortfall, cents per holder contract */
  chargeCents: number;
  note: string;
}

export interface TailCharge {
  /** every branch passes with no shortfall */
  compatible: boolean;
  /** cents per holder contract, expected */
  chargeCentsPerContract: number;
  /** the charge in bps of the naked position's EV (mark x contracts), the quote's own unit */
  chargeBps: number;
  branches: BranchVerdict[];
  /** true when the hedge is the holder's own market (Kalshi position hedged on Kalshi's No side): identical by construction */
  sameContract: boolean;
}

/**
 * The compatibility test and its price. `sameContract` short-circuits: a hedge on the holder's own
 * market settles with it in every branch, nothing to charge.
 */
export function tailCharge(
  holderRules: RuleCells,
  hedgeRules: RuleCells,
  terms: TailTerms,
  probs: TailProbabilities,
  sameContract = false,
): TailCharge {
  const branches: BranchVerdict[] = [];
  let total = 0;
  for (const b of TAIL_BRANCHES) {
    const hc = holderRules[b];
    const gc = hedgeRules[b];
    const confirmed = hc.confirmed && gc.confirmed;
    let shortfall: number;
    let note: string;
    if (sameContract) {
      shortfall = 0;
      note = "the hedge is the holder's own market; it settles with the position";
    } else if (confirmed) {
      shortfall = expectedBranchShortfall(hc.treatment, gc.treatment, terms);
      note = hc.treatment === gc.treatment ? "both venues settle this the same way" : `${hc.treatment} against ${gc.treatment}`;
    } else {
      // an unconfirmed cell is priced at the worst plausible reading, so an unread rule is never free
      const hs = hc.confirmed ? [hc.treatment] : PLAUSIBLE[b];
      const gs = gc.confirmed ? [gc.treatment] : PLAUSIBLE[b];
      shortfall = 0;
      for (const x of hs) for (const y of gs) shortfall = Math.max(shortfall, expectedBranchShortfall(x, y, terms));
      note = `${!hc.confirmed ? "the holder's venue's rule" : "the hedge venue's rule"}${!hc.confirmed && !gc.confirmed ? "s" : ""} not confirmed from text; priced at the worst reading`;
    }
    const p = probs[b] ?? 0;
    const charge = p * shortfall;
    total += charge;
    branches.push({
      branch: b,
      holder: hc.treatment,
      hedge: gc.treatment,
      confirmed,
      mismatch: !sameContract && (hc.treatment !== gc.treatment || !confirmed),
      probability: p,
      shortfallCents: round2(shortfall),
      chargeCents: round4(charge),
      note,
    });
  }
  const bps = terms.markCents > 0 ? Math.round((total * 10_000) / terms.markCents) : 0;
  return {
    compatible: branches.every((v) => v.shortfallCents === 0),
    chargeCentsPerContract: round4(total),
    chargeBps: bps,
    branches,
    sameContract,
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** The hedge venue behind a route. */
export const hedgeVenueOf = (route: HedgeRoute): SettlementVenue => (route === "kalshi_self" ? "kalshi" : route === "prophetx" ? "prophetx" : route === "novig" ? "novig" : "polymarket");

/** The route that hedges on a venue. */
export const routeOfVenue = (venue: SettlementVenue): HedgeRoute | null => (venue === "kalshi" ? "kalshi_self" : venue === "polymarket" ? "polymarket" : venue === "prophetx" ? "prophetx" : venue === "novig" ? "novig" : null);

/** The holder's words for a route's venue. */
export const routeName = (route: HedgeRoute): string => (route === "kalshi_self" ? "Kalshi's own No side" : VENUE_NAMES[hedgeVenueOf(route)]);

/**
 * Which hedge venues are offered tonight. EVENT_HEDGE_VENUES names them (kalshi, polymarket,
 * prophetx, novig; comma separated, any case); unset or empty, every route is offered. A venue left out
 * is not priced, not shown and not sent to: the switch for a night when a venue is not yet a
 * partner's (Polymarket until the aggregator lists Poly US) or not to be shown on a recording.
 */
export function hedgeVenuesFromEnv(env: NodeJS.ProcessEnv = process.env): { routes: HedgeRoute[]; source: "env" | "default"; unknown: string[] } {
  const raw = (env.EVENT_HEDGE_VENUES ?? "").trim();
  if (!raw) return { routes: ["kalshi_self", "polymarket", "prophetx", "novig"], source: "default", unknown: [] };
  const routes: HedgeRoute[] = [];
  const unknown: string[] = [];
  for (const word of raw.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean)) {
    const route = word === "kalshi" || word === "kalshi_self" ? "kalshi_self" : word === "polymarket" || word === "poly" ? "polymarket" : word === "prophetx" || word === "prophet" ? "prophetx" : word === "novig" ? "novig" : null;
    if (!route) unknown.push(word);
    else if (!routes.includes(route)) routes.push(route);
  }
  return { routes, source: "env", unknown };
}

export interface RouteGates {
  /** the pairing was verified (same game, same sides) */
  gameMatch: boolean;
  /** the walk covered the whole size (a thin-book refusal fails this) */
  depth: boolean;
  /** the hedge venue's market stays open through the holder's lock (game start) */
  venueOpen: boolean;
  /** the executor can send to this venue now (live: a client and the rails; paper: always) */
  executable: boolean;
  /** words for whichever gate failed, if one did */
  detail?: string;
}

export interface RouteInput {
  route: HedgeRoute;
  /** the route priced (a refusal leaves evCostBps null) */
  ok: boolean;
  refusalCode?: string;
  refusalDetail?: string;
  /** the holder's EV cost on this route, bps */
  evCostBps: number | null;
  /** the collar and the hedge as quoted on this route, for the exposure arithmetic; absent on a refusal */
  hedge?: { unitsMilli: number; avgPriceCents: number; floorCents: number; capCents: number };
  /** the credit this route's book would pay the holder on the default tier, cents; the holder's own comparison */
  creditCents?: number | null;
  gates: Omit<RouteGates, "depth">;
  /** the hedge venue's rule row for this market (its own text laid over the table) */
  rules: RuleCells;
}

export interface RoutedRoute {
  route: HedgeRoute;
  hedgeVenue: SettlementVenue;
  ok: boolean;
  evCostBps: number | null;
  tailChargeBps: number | null;
  allInBps: number | null;
  /** what this venue's book would have paid the holder, cents; null when it refused or was not priced */
  creditCents: number | null;
  /** the collar this venue's book funded (floor and cap in cents); null on a refusal */
  terms: { floorCents: number; capCents: number } | null;
  compatible: boolean | null;
  sameContract: boolean;
  gates: RouteGates;
  /** the branches that differ or were priced unread, with their price */
  mismatches: BranchVerdict[];
  /** why this route is not the one, when it is not */
  refusal?: string;
}

export interface HedgeRouting {
  holderVenue: SettlementVenue;
  league: string;
  /** the route chosen, null when none passes */
  chosen: HedgeRoute | null;
  /** one sentence a holder can read */
  reason: string;
  routes: RoutedRoute[];
  /** the branch probabilities used, and that they are estimates */
  probabilities: TailProbabilities & { estimate: true };
  /** the holder's venue's rules, as the terms name them */
  holderRules: RuleCells;
  /** the tails in the holder's venue's words (step 6) */
  tails: TailTerm[];
}

export interface ChooseRouteInputs {
  holderVenue: SettlementVenue;
  league: string;
  holderRules: RuleCells;
  /** the market's mid for the holder's side, cents */
  markCents: number;
  contracts: number;
  routes: RouteInput[];
  probabilities: TailProbabilities;
  /** a route the caller insists on (an armed ticker the live executor can send to); judged like the rest, named in the reason */
  pinned?: HedgeRoute;
}

const bps = (n: number | null): string => (n === null ? "—" : `${n > 0 ? "+" : ""}${n} bps`);

/**
 * Steps 2 to 4 for every route, then the choice: the cheapest all-in cost among the routes that
 * pass every gate; ties go to Kalshi's own No side (same instrument as the board, zero basis). A
 * pinned route wins when it passes the gates, and the reason says what it cost against the other.
 */
export function chooseRoute(inputs: ChooseRouteInputs): HedgeRouting {
  const routes: RoutedRoute[] = inputs.routes.map((r) => {
    const hedgeVenue = hedgeVenueOf(r.route);
    const depth = r.ok || !/too_thin|book_empty/.test(r.refusalCode ?? "");
    const gates: RouteGates = { ...r.gates, depth };
    const failed = !gates.gameMatch ? "the game match is not verified" : !depth ? "the book cannot take the size" : !gates.venueOpen ? "the venue's market closes before the lock" : !gates.executable ? "the executor cannot send to this venue now" : null;
    if (failed) gates.detail = failed;
    const sameContract = inputs.holderVenue === hedgeVenue;
    const charge =
      r.ok && r.hedge && inputs.contracts > 0
        ? tailCharge(
            inputs.holderRules,
            r.rules,
            {
              floorCents: r.hedge.floorCents,
              capCents: r.hedge.capCents,
              markCents: inputs.markCents,
              hedgeUnitsPerContractMilli: Math.round(r.hedge.unitsMilli / inputs.contracts),
              hedgeAvgPriceCents: r.hedge.avgPriceCents,
            },
            inputs.probabilities,
            sameContract,
          )
        : null;
    const allIn = r.ok && r.evCostBps !== null && charge ? r.evCostBps + charge.chargeBps : null;
    return {
      route: r.route,
      hedgeVenue,
      ok: r.ok,
      evCostBps: r.evCostBps,
      tailChargeBps: charge ? charge.chargeBps : null,
      allInBps: allIn,
      creditCents: r.ok && typeof r.creditCents === "number" ? r.creditCents : null,
      terms: r.ok && r.hedge ? { floorCents: r.hedge.floorCents, capCents: r.hedge.capCents } : null,
      compatible: charge ? charge.compatible : null,
      sameContract,
      gates,
      mismatches: charge ? charge.branches.filter((b) => b.mismatch) : [],
      ...(!r.ok ? { refusal: r.refusalDetail ?? r.refusalCode ?? "refused" } : failed ? { refusal: failed } : {}),
    };
  });

  const passing = routes.filter((r) => r.ok && r.allInBps !== null && !r.gates.detail);
  // ties: the holder's own venue first (same instrument, zero basis), then the table's order
  const rank = (r: RoutedRoute) => (r.sameContract ? 0 : r.route === "kalshi_self" ? 1 : r.route === "prophetx" ? 2 : r.route === "novig" ? 3 : 4);
  const byAllIn = [...passing].sort((a, b) => (a.allInBps as number) - (b.allInBps as number) || rank(a) - rank(b));
  let chosen: RoutedRoute | null = null;
  let reason: string;
  const name = (r: RoutedRoute) => routeName(r.route);
  const costWords = (r: RoutedRoute) => `${bps(r.allInBps)} all in${r.tailChargeBps ? ` (${bps(r.evCostBps)} on the books, ${bps(r.tailChargeBps)} for the tails)` : ""}`;
  // the route not taken, named with why it was not: its refusal, or the gate it failed
  const otherWords = (r: RoutedRoute | undefined) => (r ? `${name(r)}: ${r.refusal ?? "refused"}` : "no other route was priced");
  // every route not taken, in one clause: the priced ones with their cost, the rest with why not
  const othersWords = (taken: RoutedRoute): string => {
    const rest = routes.filter((r) => r.route !== taken.route);
    if (rest.length === 0) return "no other route was priced";
    return rest
      .sort((a, b) => (a.allInBps ?? Number.POSITIVE_INFINITY) - (b.allInBps ?? Number.POSITIVE_INFINITY) || rank(a) - rank(b))
      .map((r) => (passing.includes(r) ? `${costWords(r)} on ${name(r)}` : otherWords(r)))
      .join("; ");
  };
  if (inputs.pinned) {
    const pinnedRoute = routes.find((r) => r.route === inputs.pinned) ?? null;
    if (pinnedRoute && passing.includes(pinnedRoute)) {
      chosen = pinnedRoute;
      const other = byAllIn.find((r) => r.route !== pinnedRoute.route);
      reason = other
        ? other.allInBps !== null && pinnedRoute.allInBps !== null && other.allInBps < pinnedRoute.allInBps
          ? `${name(pinnedRoute)}: the venue the hedge can be sent to tonight; ${costWords(pinnedRoute)} against ${othersWords(pinnedRoute)}, the difference ours to carry`
          : `${name(pinnedRoute)}: the venue the hedge can be sent to tonight, and the cheaper all in (${costWords(pinnedRoute)} against ${othersWords(pinnedRoute)})`
        : `${name(pinnedRoute)}: the venue the hedge can be sent to tonight; ${costWords(pinnedRoute)}; ${othersWords(pinnedRoute)}`;
    } else {
      reason = pinnedRoute
        ? `${name(pinnedRoute)} is pinned but ${pinnedRoute.refusal ?? "refused"}; nothing else can be sent`
        : "the pinned route was not priced";
    }
  } else if (byAllIn.length > 0) {
    chosen = byAllIn[0];
    const other = byAllIn[1] ?? routes.find((r) => r.route !== chosen?.route);
    const tails = chosen.mismatches.length === 0 ? (chosen.sameContract ? "the holder's own market, so every tail settles with the position" : "it settles like the holder's venue in every tail") : `${chosen.mismatches.map((m) => m.branch).join(", ")} priced in`;
    reason = other
      ? other.ok && other.allInBps !== null && !other.gates.detail
        ? `${name(chosen)}: cheaper all in, ${costWords(chosen)} against ${othersWords(chosen)}; ${tails}`
        : `${name(chosen)}: ${costWords(chosen)}; ${tails}; ${othersWords(chosen)}`
      : `${name(chosen)}: ${costWords(chosen)}; ${tails}`;
  } else {
    reason = routes.map((r) => otherWords(r)).join("; ") || "no route priced";
  }

  return {
    holderVenue: inputs.holderVenue,
    league: inputs.league,
    chosen: chosen?.route ?? null,
    reason,
    routes,
    probabilities: { ...inputs.probabilities, estimate: true },
    holderRules: inputs.holderRules,
    tails: tailTerms(inputs.holderVenue, inputs.holderRules),
  };
}

export interface TailTerm {
  branch: TailBranch;
  text: string;
}

const hoursWords = (h?: number): string => (h === undefined ? "the venue's window" : h % 24 === 0 && h > 48 ? `${h / 24} days` : `${h} hours`);

/**
 * Step 6: the tails in the holder's venue's words, as the terms. The protection settles on what
 * the venue pays the position; a venue that undoes the position undoes the protection with it.
 */
export function tailTerms(venue: SettlementVenue, rules: RuleCells): TailTerm[] {
  const V = VENUE_NAMES[venue];
  const settles = (t: TailTreatment, what: string): string => {
    switch (t) {
      case "half":
        return `${what}, ${V} pays each side $0.50 and the protection settles on that $0.50 like any other payout: the floor tops it up, the cap takes the slice above.`;
      case "void":
        return `${what}, ${V} voids the position and returns your stake; the protection is void with it and you keep the credit.`;
      case "fair":
        return `${what}, ${V} settles at the fair price when the news broke and the protection settles on that price: the floor tops it up, the cap takes the slice above.`;
      case "hold":
        return `${what}, ${V} keeps the market open until the game is played and the protection waits with it.`;
      case "stands":
        return `${what}, ${V} settles on the result as first announced; so does the protection.`;
      case "resettle":
        return `${what}, ${V} settles again on the corrected result; so does the protection.`;
    }
  };
  const p = rules.postponed;
  const postponedWhat =
    p.treatment === "hold" ? "If the game is postponed" : `If the game is postponed and not played within ${hoursWords(p.windowHours)} (played within it, nothing changes)`;
  return [
    { branch: "tie", text: settles(rules.tie.treatment, "If the game ends in a tie") },
    { branch: "postponed", text: settles(p.treatment, postponedWhat) },
    { branch: "abandoned", text: settles(rules.abandoned.treatment, "If the game is called off without an official result") },
    { branch: "corrected", text: settles(rules.corrected.treatment, "If the league later corrects the result") },
  ];
}
