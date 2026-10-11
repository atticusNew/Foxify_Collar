/**
 * LAST-LEG SHADOW — does "lock in your parlay before the last leg" fund a credit?
 *
 * The question. A parlay (Polymarket "Combo") is a long shot at ticket time and
 * protection on it cannot pay: the floor is almost certainly needed and the cap
 * slice is almost never collected. But once every leg but one has hit, the
 * ticket is a single-market position on the final game at the final game's
 * odds, which is exactly the shape the event collar funds. This module measures
 * that moment: how often tickets reach it, what the venues would have paid at
 * it, how often they refuse, and what the protected ticket then did against the
 * naked one.
 *
 * What is real: the public combo-leg catalog and its prices, each leg's game
 * time and official resolution, the final leg's live NO book, the quoted terms.
 * What is simulated: the tickets. Polymarket publishes no list of live combo
 * tickets (polymarketCombos.ts), so tickets are built here the way a bettor
 * builds them: 2 to 5 favourites across distinct games, a fixed stake, the
 * latest-starting game as the last leg, and no game on more than a few
 * undecided tickets at once. Nothing is bought; this module cannot trade.
 *
 * The compressed position. A ticket of S shares (1 share pays $1 when every leg
 * wins) whose decided legs settled to a product P (1 when all won outright; a
 * fraction when the venue settled a leg partially, e.g. a no-show at its last
 * fair price) is, with one leg left, S x P contracts of that leg paying 100c
 * each. Protection is quoted on those contracts with the same collar search as
 * the live book (collarSearch.ts), hedged by buying the final leg's NO on its
 * own CLOB book, leg for leg.
 *
 * Credit identity (unchanged from the event collar; only the position is new):
 *   funding = (100 - cap) x contracts ; gross = funding - hedge - fees ;
 *   credit  = gross - take. Protected payoff: cap x contracts + credit when the
 *   last leg wins, floor x contracts + credit when it loses; a partially settled
 *   last leg pays its value clamped to [floor, cap] (a collar on a value).
 *   The writer's result is the published take, whoever won (writerPayouts).
 *
 * Money is integer cents, milli shares and milli prices throughout.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { type CollarSearchResult, enumerateCollars, refuseUnfunded, selectTiers } from "./collarSearch";
import { walkPmAsks } from "./crossVenuePricer";
import { pickWords } from "./pickWords";
import type { ComboLegMarket, ComboLegStatus } from "./polymarketCombos";
import { gammaBase } from "./polymarketPublic";
import { checkRule, gammaRuleText, gammaRuleUrl, pinRule, summarizeRuleEvidence, type RuleCheck, type RuleEvidence, type RuleEvidenceSummary } from "./ruleEvidence";
import { writerPayouts } from "./shadowLedger";
import type { CollarTerms, CrossHedgeLeg, CrossRefusal, CrossSearchConfig, PmBook, ProtectionTier, TakeRule } from "./types";

// ── configuration ─────────────────────────────────────────────────────────────

export interface LastLegConfig {
  enabled: boolean;
  tickMs: number;
  /** the bettor's stake per ticket, cents */
  stakeCents: number;
  /** ticket sizes to build, legs per ticket */
  legCounts: number[];
  /** new tickets per size per tick, while under maxOpen */
  ticketsPerSize: number;
  /** ceiling on tickets that have not reached an outcome */
  maxOpen: number;
  /** ceiling on undecided tickets that share one game: one upset must not empty the whole board */
  maxPerGame: number;
  /** a leg is a favourite priced inside this band, milli */
  favMinMilli: number;
  favMaxMilli: number;
  /** the last leg starts at least this long after the latest other leg, so results are in before it kicks off */
  minGapMs: number;
  /** legs start within this horizon */
  windowMs: number;
  /** every leg starts at least this far out when the ticket is built */
  minLeadMs: number;
  /** slug prefixes accepted as sports leagues */
  leagues: string[];
  /** pages of the public combo catalog read per tick (100 markets each) */
  catalogPages: number;
  /** a ticket with legs still unresolved this long after its last start is voided */
  voidAfterMs: number;
}

export const DEFAULT_LAST_LEG_CONFIG: LastLegConfig = {
  enabled: true,
  tickMs: 10 * 60_000,
  stakeCents: 2_000,
  legCounts: [2, 3, 4, 5],
  ticketsPerSize: 2,
  maxOpen: 40,
  maxPerGame: 3,
  favMinMilli: 550,
  favMaxMilli: 900,
  minGapMs: 4 * 3_600_000,
  windowMs: 72 * 3_600_000,
  minLeadMs: 2 * 3_600_000,
  leagues: ["nfl", "nba", "mlb", "nhl", "cfb", "ncaaf", "cbb", "ncaab", "wnba", "epl", "ucl", "lal", "bun", "sea", "lig", "mls"],
  catalogPages: 30,
  voidAfterMs: 72 * 3_600_000,
};

const numOr = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
};

export function lastLegConfigFromEnv(env: NodeJS.ProcessEnv): LastLegConfig {
  const d = DEFAULT_LAST_LEG_CONFIG;
  const counts = (env.EVENT_LASTLEG_LEG_COUNTS ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 2 && n <= 10);
  const leagues = (env.EVENT_LASTLEG_LEAGUES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const favMin = Math.min(999, Math.max(1, numOr(env.EVENT_LASTLEG_FAV_MIN_MILLI, d.favMinMilli)));
  return {
    enabled: env.EVENT_LASTLEG_ENABLED === undefined ? d.enabled : !/^(0|false|off|no)$/i.test(env.EVENT_LASTLEG_ENABLED.trim()),
    tickMs: Math.max(60_000, numOr(env.EVENT_LASTLEG_TICK_MS, d.tickMs)),
    stakeCents: Math.max(100, Math.round(numOr(env.EVENT_LASTLEG_STAKE_CENTS, d.stakeCents))),
    legCounts: counts.length ? [...new Set(counts)].sort((a, b) => a - b) : d.legCounts,
    ticketsPerSize: Math.max(0, Math.round(numOr(env.EVENT_LASTLEG_TICKETS_PER_SIZE, d.ticketsPerSize))),
    maxOpen: Math.max(1, Math.round(numOr(env.EVENT_LASTLEG_MAX_OPEN, d.maxOpen))),
    maxPerGame: Math.max(1, Math.round(numOr(env.EVENT_LASTLEG_MAX_PER_GAME, d.maxPerGame))),
    favMinMilli: favMin,
    favMaxMilli: Math.min(999, Math.max(favMin, numOr(env.EVENT_LASTLEG_FAV_MAX_MILLI, d.favMaxMilli))),
    minGapMs: Math.max(0, numOr(env.EVENT_LASTLEG_MIN_GAP_MS, d.minGapMs)),
    windowMs: Math.max(3_600_000, numOr(env.EVENT_LASTLEG_WINDOW_MS, d.windowMs)),
    minLeadMs: Math.max(0, numOr(env.EVENT_LASTLEG_MIN_LEAD_MS, d.minLeadMs)),
    leagues: leagues.length ? leagues : d.leagues,
    catalogPages: Math.min(100, Math.max(1, Math.round(numOr(env.EVENT_LASTLEG_CATALOG_PAGES, d.catalogPages)))),
    voidAfterMs: Math.max(3_600_000, numOr(env.EVENT_LASTLEG_VOID_AFTER_MS, d.voidAfterMs)),
  };
}

// ── tickets ───────────────────────────────────────────────────────────────────

/** One leg as the bettor picked it: `side` is the catalog outcome index they are on. */
export interface TicketLeg {
  conditionId: string;
  slug: string;
  title: string;
  league: string;
  side: 0 | 1;
  /** the outcome the bettor needs, by name */
  outcome: string;
  /** that outcome's price when the ticket was built, milli */
  priceMilli: number;
  /** CLOB token ids for the bettor's side and the opposing side (the hedge instrument) */
  yesTokenId: string;
  noTokenId: string;
  gameStartIso: string;
  /** the venue's rule text pinned when the ticket was built (sha256, source URL, excerpt); null when none was published; absent before 2026-10-11 */
  rule?: RuleEvidence | null;
}

/** A leg eligible for a ticket: catalog row joined with its Gamma status, the favourite side chosen. */
export interface LegCandidate extends TicketLeg {
  gameStartMs: number;
  volumeUsd: number;
}

export interface LastLegTicketRecord {
  type: "ticket";
  at: string;
  ticketId: string;
  stakeCents: number;
  /** legs in start order; the last is the last leg */
  legs: TicketLeg[];
  /** the ticket's indicative price: the legs' prices multiplied, milli (a maker's quote would sit wider) */
  comboPriceMilli: number;
  /** shares the stake buys at that price, milli (1000 = one $1-paying share) */
  sharesMilli: number;
}

/** One leg's official resolution, as the venue settled it: 1000, 0, or a fraction. */
export interface LastLegLegRecord {
  type: "leg";
  at: string;
  ticketId: string;
  conditionId: string;
  valueMilli: number;
  /** the rule text read again at resolution, against the pin; absent before 2026-10-11 */
  ruleCheck?: RuleCheck;
}

/** One attempt to quote protection at the moment; a quote or an honest refusal, both kept. */
export interface LastLegMomentRecord {
  type: "moment";
  at: string;
  ticketId: string;
  minutesToStart: number;
  /** product of the decided legs' values, milli */
  decidedProductMilli: number;
  /** the compressed position: contracts of the last leg paying 100c each */
  contracts: number;
  markCents: number;
  /** what the bettor paid per contract: the floor that protects their stake sits at or above it */
  entryCents: number;
  /** the ticket's fair value at the moment on the contracts basis, cents (what a cash-out at fair would pay) */
  ticketValueCents: number;
  ok: boolean;
  code?: CrossRefusal["code"];
  detail?: string;
  floorCents?: number;
  capCents?: number;
  creditCents?: number;
  grossCreditCents?: number;
  takeCents?: number;
  takeRule?: TakeRule;
  tier?: ProtectionTier;
  evCostBps?: number;
  hedgeSharesMilli?: number;
  hedgeCostCents?: number;
  feesCents?: number;
  hedgeTokenId?: string;
  candidatesConsidered?: number;
}

export interface LastLegVoidRecord {
  type: "void";
  at: string;
  ticketId: string;
  reason: string;
}

export type LastLegRecord = LastLegTicketRecord | LastLegLegRecord | LastLegMomentRecord | LastLegVoidRecord;

export type LastLegStatus = "open" | "busted" | "last_leg" | "settled" | "void";

export interface LastLegOutcome {
  result: "yes" | "no" | "scalar";
  lastLegValueMilli: number;
  /** the ticket with no protection, cents (contracts basis when quoted, ticket basis otherwise) */
  nakedCents: number;
  /** null when the ticket was never quoted */
  protectedCents: number | null;
  deltaCents: number | null;
  /** the writer's net on the quoted terms; null when never quoted or settled scalar */
  writerCents: number | null;
  hedgePayoutCents: number | null;
}

export interface LastLegTicket extends Omit<LastLegTicketRecord, "type"> {
  size: number;
  status: LastLegStatus;
  legValues: Record<string, number>;
  /** per leg (by conditionId), the rule text read again at resolution against the pin */
  legRuleChecks?: Record<string, RuleCheck>;
  /** product of resolved legs' values other than the last leg, milli */
  decidedProductMilli: number;
  attempts: number;
  refusals: Record<string, number>;
  lastAttemptAt?: string;
  /** the first priced quote; the terms the ticket is settled on */
  quote?: LastLegMomentRecord;
  bustedAt?: string;
  settledAt?: string;
  voidReason?: string;
  outcome?: LastLegOutcome;
}

const HASH_LEN = 12;

/** A leg in a bettor's words: "Cowboys vs Buccaneers", "Brighton & Hove Albion to win"; an unparsed title rides after a dot. */
export function legWords(leg: Pick<TicketLeg, "outcome" | "title">): string {
  const w = pickWords(leg.outcome, leg.title);
  if (!w.versus) return w.outcome;
  return /^(vs|at) /.test(w.versus) ? `${w.outcome} ${w.versus}` : `${w.outcome} · ${w.versus}`;
}

/** Deterministic ticket id from its legs and sides: the same ticket is never built twice. */
export function ticketIdFor(legs: ReadonlyArray<Pick<TicketLeg, "conditionId" | "side">>): string {
  const key = legs
    .map((l) => `${l.conditionId}:${l.side}`)
    .sort()
    .join("|");
  return `ll_${createHash("sha1").update(key).digest("hex").slice(0, HASH_LEN)}`;
}

/** The legs' prices multiplied, milli; never below 1. */
export function comboPriceMilli(pricesMilli: readonly number[]): number {
  let p = 1;
  for (const x of pricesMilli) p *= Math.max(0, x) / 1000;
  return Math.max(1, Math.round(p * 1000));
}

/** Shares the stake buys at the ticket price, milli, rounded down (the bettor never gets a free fraction). */
export function sharesFor(stakeCents: number, priceMilli: number): number {
  return Math.floor((stakeCents * 10_000) / Math.max(1, priceMilli));
}

/** The ticket's value at a given factor, cents: shares x factor x $1, rounded down. */
export function ticketValueCents(sharesMilli: number, factorMilli: number): number {
  return Math.floor((sharesMilli * factorMilli) / 10_000);
}

/** The compressed position: contracts of the last leg paying 100c each, rounded down. */
export function compressedContracts(sharesMilli: number, decidedProductMilli: number): number {
  return Math.floor((sharesMilli * decidedProductMilli) / 1_000_000);
}

/**
 * Join catalog rows with their Gamma status into eligible legs: a sports
 * moneyline in an accepted league, starting inside the window, with one side
 * priced as a favourite. The bettor's side is the favourite; its opposing CLOB
 * token is the hedge instrument.
 */
export function legCandidates(
  rows: ReadonlyArray<{ market: ComboLegMarket; status: ComboLegStatus | null }>,
  cfg: LastLegConfig,
  nowMs: number,
): LegCandidate[] {
  const out: LegCandidate[] = [];
  for (const { market, status } of rows) {
    if (!status || !status.gameStartIso || status.resolved || status.closed) continue;
    if (!cfg.leagues.includes(market.league)) continue;
    if (status.sportsMarketType && status.sportsMarketType !== "moneyline") continue;
    if (status.tokenIds.length !== 2) continue;
    const startMs = Date.parse(status.gameStartIso);
    if (!Number.isFinite(startMs) || startMs < nowMs + cfg.minLeadMs || startMs > nowMs + cfg.windowMs) continue;
    const inBand = (p: number): boolean => p >= cfg.favMinMilli && p <= cfg.favMaxMilli;
    const side: 0 | 1 | null = inBand(market.pricesMilli[0]) ? 0 : inBand(market.pricesMilli[1]) ? 1 : null;
    if (side === null) continue;
    out.push({
      conditionId: market.conditionId,
      slug: market.slug,
      title: market.title,
      league: market.league,
      side,
      outcome: market.outcomes[side],
      priceMilli: market.pricesMilli[side],
      yesTokenId: status.tokenIds[side],
      noTokenId: status.tokenIds[1 - side],
      gameStartIso: new Date(startMs).toISOString(),
      rule: pinRule({ venue: "polymarket", marketId: market.slug, ruleText: gammaRuleText(status), sourceUrl: gammaRuleUrl(market.slug, gammaBase()), readAtIso: new Date(nowMs).toISOString() }),
      gameStartMs: startMs,
      volumeUsd: market.volumeUsd,
    });
  }
  return out;
}

/**
 * Build tickets the way a bettor would, deterministically: for each size, the
 * latest-starting eligible game is the last leg and the biggest markets that
 * finish before it (start at least minGap earlier) fill the other legs. The
 * next ticket of that size moves to the next-latest last leg. Tickets already
 * on the ledger are never rebuilt, and `ticketsPerSize` is a ceiling on the
 * undecided tickets of each size: a new one is built only once an earlier one
 * has settled, busted or voided, so the record is not filled with near-copies
 * of the same slate every tick. `maxPerGame` caps how many undecided tickets
 * may share one game: the biggest market would otherwise sit on every ticket,
 * and one upset would bust the whole board in one tick.
 */
export function buildTickets(
  cands: readonly LegCandidate[],
  cfg: LastLegConfig,
  existing: readonly Pick<LastLegTicket, "ticketId" | "status" | "legs">[],
  nowIso: string,
  room: number,
): LastLegTicketRecord[] {
  const out: LastLegTicketRecord[] = [];
  const byStart = [...cands].sort((a, b) => a.gameStartMs - b.gameStartMs || b.volumeUsd - a.volumeUsd);
  const seen = new Set(existing.map((t) => t.ticketId));
  const undecidedBySize = new Map<number, number>();
  const gameUses = new Map<string, number>();
  for (const t of existing) {
    if (t.status !== "open" && t.status !== "last_leg") continue;
    undecidedBySize.set(t.legs.length, (undecidedBySize.get(t.legs.length) ?? 0) + 1);
    for (const l of t.legs) gameUses.set(l.conditionId, (gameUses.get(l.conditionId) ?? 0) + 1);
  }
  const hasRoom = (c: LegCandidate): boolean => (gameUses.get(c.conditionId) ?? 0) < cfg.maxPerGame;
  for (const n of cfg.legCounts) {
    let made = undecidedBySize.get(n) ?? 0;
    for (let i = byStart.length - 1; i >= 0 && made < cfg.ticketsPerSize && out.length < room; i -= 1) {
      const last = byStart[i];
      if (!hasRoom(last)) continue;
      const others = byStart
        .filter((c) => c.conditionId !== last.conditionId && hasRoom(c) && c.gameStartMs + cfg.minGapMs <= last.gameStartMs)
        .sort((a, b) => b.volumeUsd - a.volumeUsd)
        .slice(0, n - 1)
        .sort((a, b) => a.gameStartMs - b.gameStartMs);
      if (others.length < n - 1) continue;
      const legs = [...others, last];
      const id = ticketIdFor(legs);
      if (seen.has(id)) continue;
      seen.add(id);
      for (const l of legs) gameUses.set(l.conditionId, (gameUses.get(l.conditionId) ?? 0) + 1);
      const price = comboPriceMilli(legs.map((l) => l.priceMilli));
      out.push({
        type: "ticket",
        at: nowIso,
        ticketId: id,
        stakeCents: cfg.stakeCents,
        legs: legs.map(({ gameStartMs: _g, volumeUsd: _v, ...leg }) => leg),
        comboPriceMilli: price,
        sharesMilli: sharesFor(cfg.stakeCents, price),
      });
      made += 1;
    }
  }
  return out;
}

// ── the moment: quoting the compressed position ───────────────────────────────

export interface LastLegQuoteInputs {
  contracts: number;
  markCents: number;
  entryCents: number;
  minutesToStart: number;
  noBook: PmBook;
  noOutcome: string;
  config: CrossSearchConfig;
}

export type LastLegQuote =
  | (CollarTerms & { ok: true; tier: ProtectionTier; tiers: Partial<Record<ProtectionTier, CollarTerms>>; candidatesConsidered: number })
  | CrossRefusal;

/**
 * The event collar on the compressed position, hedged on the last leg's NO
 * book. Same grid, same fee rule, same tiers as the live book; the only
 * difference is that the contracts came from a ticket.
 */
export function quoteLastLeg(input: LastLegQuoteInputs): LastLegQuote {
  const grid = lastLegCollars(input);
  if (!grid.ok) return grid;
  const sel = selectTiers(grid.search.candidates, input.entryCents, input.config.defaultTier);
  return { ok: true, ...sel.terms, tier: sel.tier, tiers: sel.tiers, candidatesConsidered: grid.search.candidates.length };
}

/**
 * Every collar the last leg's NO book funds on the compressed position, before
 * tier selection; the eligibility refusals are the same as the quote's.
 * listingQuote.ts reads the whole grid because a seller beside an ask wants
 * the highest guaranteed outcome, not the balanced tier.
 */
export function lastLegCollars(input: LastLegQuoteInputs): { ok: true; search: CollarSearchResult } | CrossRefusal {
  const cfg = input.config;
  if (input.contracts < 1) {
    return { ok: false, code: "credit_nonpositive", detail: "the compressed position is under one contract; nothing to protect" };
  }
  if (input.minutesToStart < cfg.minMinutesToStart) {
    return {
      ok: false,
      code: "market_too_close_to_start",
      detail: `the last game starts in ${Math.max(0, Math.round(input.minutesToStart))}m; pre-game protection needs at least ${cfg.minMinutesToStart}m`,
    };
  }
  if (input.markCents < cfg.markLowerBoundCents || input.markCents > cfg.markUpperBoundCents) {
    return {
      ok: false,
      code: "mark_out_of_range",
      detail: `the last leg's mark ${input.markCents}c is outside the quotable ${cfg.markLowerBoundCents}c-${cfg.markUpperBoundCents}c band`,
    };
  }
  if (input.noBook.asks.length === 0) {
    return { ok: false, code: "pm_book_empty", detail: `no executable asks on the opposing outcome (${input.noOutcome})` };
  }
  const minSharesMilli = Math.max(1, input.noBook.minOrderSizeShares) * 1000;
  const search = enumerateCollars({
    markCents: input.markCents,
    contracts: input.contracts,
    config: cfg,
    hedgeFor: (digitalCents) => {
      const sharesMilli = Math.max(digitalCents * 10, minSharesMilli);
      const walk = walkPmAsks(input.noBook.asks, sharesMilli);
      if (!walk) return { ok: false };
      const hedgeCostCents = Math.ceil(walk.costMicroUsd / 10_000);
      const feesCents = cfg.hedgeFeeFlatCents + Math.ceil((hedgeCostCents * cfg.hedgeFeeBps) / 10_000);
      const hedge: CrossHedgeLeg = {
        action: "buy",
        venue: "polymarket",
        outcome: input.noOutcome,
        tokenId: input.noBook.tokenId,
        sharesMilli,
        avgPriceMilli: walk.avgPriceMilli,
        worstPriceMilli: walk.worstPriceMilli,
        costCents: hedgeCostCents,
      };
      return { ok: true, costCents: hedgeCostCents, feesCents, hedge };
    },
  });
  if (search.candidates.length === 0) {
    return refuseUnfunded(search, cfg, {
      shortfall: "the last leg's live book cannot fund a positive credit on any quotable floor/cap right now",
      thin: "pm_book_too_thin",
      thinDetail: "the last leg's book lacks the depth to hedge this ticket leg-for-leg",
      none: "no quotable floor/cap combination for this ticket",
    });
  }
  return { ok: true, search };
}

/** A moment record from a quote attempt, every field the ledger needs to settle it later. */
export function momentRecord(
  base: Pick<LastLegMomentRecord, "at" | "ticketId" | "minutesToStart" | "decidedProductMilli" | "contracts" | "markCents" | "entryCents">,
  q: LastLegQuote,
): LastLegMomentRecord {
  const ticketValue = base.contracts * base.markCents;
  if (!q.ok) return { type: "moment", ...base, ticketValueCents: ticketValue, ok: false, code: q.code, detail: q.detail };
  const hedge = q.hedge as CrossHedgeLeg;
  return {
    type: "moment",
    ...base,
    ticketValueCents: ticketValue,
    ok: true,
    floorCents: q.floorCents,
    capCents: q.capCents,
    creditCents: q.creditCents,
    grossCreditCents: q.grossCreditCents,
    takeCents: q.takeCents,
    takeRule: q.takeRule,
    tier: q.tier,
    evCostBps: q.evCostBps,
    hedgeSharesMilli: hedge.sharesMilli,
    hedgeCostCents: hedge.costCents,
    feesCents: q.feesCents,
    hedgeTokenId: hedge.tokenId,
    candidatesConsidered: q.candidatesConsidered,
  };
}

// ── ledger ────────────────────────────────────────────────────────────────────

export function appendLastLegRecord(path: string, record: LastLegRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

/** The protected payoff per contract for the last leg's settled value: cap on a win, floor on a loss, clamped in between. */
export function protectedPerContract(valueMilli: number, floorCents: number, capCents: number): number {
  if (valueMilli >= 1000) return capCents;
  if (valueMilli <= 0) return floorCents;
  return Math.min(capCents, Math.max(floorCents, Math.round(valueMilli / 10)));
}

function statusOf(t: LastLegTicket): LastLegStatus {
  if (t.status === "void") return "void";
  const lastId = t.legs[t.legs.length - 1].conditionId;
  const others = t.legs.slice(0, -1);
  for (const leg of others) {
    const v = t.legValues[leg.conditionId];
    if (v !== undefined && v <= 0) return "busted";
  }
  const allResolved = t.legs.every((l) => t.legValues[l.conditionId] !== undefined);
  if (allResolved) return "settled";
  const lastResolved = t.legValues[lastId] !== undefined;
  if (lastResolved && t.legValues[lastId] <= 0) return "busted"; // the last game settled first and lost: no moment ever existed
  const othersResolved = others.every((l) => t.legValues[l.conditionId] !== undefined);
  return othersResolved && !lastResolved ? "last_leg" : "open";
}

function decidedProduct(t: LastLegTicket): number {
  let p = 1;
  for (const leg of t.legs.slice(0, -1)) {
    const v = t.legValues[leg.conditionId];
    if (v !== undefined) p *= v / 1000;
  }
  return Math.max(0, Math.round(p * 1000));
}

function settle(t: LastLegTicket, at: string): LastLegTicket {
  const lastId = t.legs[t.legs.length - 1].conditionId;
  const v = t.legValues[lastId];
  const result: LastLegOutcome["result"] = v >= 1000 ? "yes" : v <= 0 ? "no" : "scalar";
  const product = decidedProduct(t);
  if (!t.quote) {
    const naked = ticketValueCents(t.sharesMilli, Math.round((product * v) / 1000));
    return {
      ...t,
      status: "settled",
      settledAt: at,
      outcome: { result, lastLegValueMilli: v, nakedCents: naked, protectedCents: null, deltaCents: null, writerCents: null, hedgePayoutCents: null },
    };
  }
  const q = t.quote;
  const contracts = q.contracts;
  const naked = Math.floor((contracts * v) / 10);
  const protectedCents = protectedPerContract(v, q.floorCents as number, q.capCents as number) * contracts + (q.creditCents as number);
  let writerCents: number | null = null;
  let hedgePayoutCents: number | null = null;
  if (result !== "scalar") {
    const w = writerPayouts(
      {
        contracts,
        floorCents: q.floorCents as number,
        capCents: q.capCents as number,
        creditCents: q.creditCents as number,
        takeCents: q.takeCents as number,
        hedgeCostCents: (q.hedgeCostCents ?? 0) + (q.feesCents ?? 0),
        hedgeUnitsMilli: q.hedgeSharesMilli,
      },
      result,
    );
    writerCents = w.writerCents;
    hedgePayoutCents = w.hedgePayoutCents;
  }
  return {
    ...t,
    status: "settled",
    settledAt: at,
    outcome: { result, lastLegValueMilli: v, nakedCents: naked, protectedCents, deltaCents: protectedCents - naked, writerCents, hedgePayoutCents },
  };
}

/** Replay the JSONL into current tickets. Unreadable lines are skipped, never fatal. */
export function loadLastLegTickets(path: string): LastLegTicket[] {
  if (!existsSync(path)) return [];
  return replayLastLeg(readFileSync(path, "utf8").split("\n"));
}

export function replayLastLeg(lines: readonly string[]): LastLegTicket[] {
  const byId = new Map<string, LastLegTicket>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: LastLegRecord;
    try {
      rec = JSON.parse(trimmed) as LastLegRecord;
    } catch {
      continue;
    }
    if (rec.type === "ticket") {
      if (byId.has(rec.ticketId) || rec.legs.length < 2) continue;
      const { type: _t, ...fields } = rec;
      byId.set(rec.ticketId, { ...fields, size: rec.legs.length, status: "open", legValues: {}, decidedProductMilli: 1000, attempts: 0, refusals: {} });
      continue;
    }
    const t = byId.get(rec.ticketId);
    if (!t || t.status === "settled" || t.status === "void" || t.status === "busted") continue;
    if (rec.type === "leg") {
      if (!t.legs.some((l) => l.conditionId === rec.conditionId) || t.legValues[rec.conditionId] !== undefined) continue;
      const next: LastLegTicket = {
        ...t,
        legValues: { ...t.legValues, [rec.conditionId]: Math.min(1000, Math.max(0, rec.valueMilli)) },
        ...(rec.ruleCheck ? { legRuleChecks: { ...(t.legRuleChecks ?? {}), [rec.conditionId]: rec.ruleCheck } } : {}),
      };
      next.decidedProductMilli = decidedProduct(next);
      const status = statusOf(next);
      if (status === "settled") byId.set(rec.ticketId, settle(next, rec.at));
      else if (status === "busted") byId.set(rec.ticketId, { ...next, status, bustedAt: rec.at });
      else byId.set(rec.ticketId, { ...next, status });
    } else if (rec.type === "moment") {
      const refusals = rec.ok ? t.refusals : { ...t.refusals, [rec.code ?? "unknown"]: (t.refusals[rec.code ?? "unknown"] ?? 0) + 1 };
      byId.set(rec.ticketId, {
        ...t,
        attempts: t.attempts + 1,
        refusals,
        lastAttemptAt: rec.at,
        quote: t.quote ?? (rec.ok ? rec : undefined), // first priced quote wins
      });
    } else if (rec.type === "void") {
      byId.set(rec.ticketId, { ...t, status: "void", voidReason: rec.reason });
    }
  }
  return [...byId.values()];
}

// ── summary ───────────────────────────────────────────────────────────────────

export interface LastLegSizeRow {
  size: number;
  built: number;
  busted: number;
  /** tickets whose other legs all hit, so the moment opened */
  reachedLastLeg: number;
  quoted: number;
  /** reached the moment, attempts made, never a priced quote */
  refusedOnly: number;
  settled: number;
  /** across settled tickets that were quoted */
  protectedCents: number;
  nakedCents: number;
}

export interface LastLegSummary {
  tickets: number;
  open: number;
  busted: number;
  reachedLastLeg: number;
  /** reached / (reached + busted), the share of decided tickets that got to the moment */
  reachedPctOfDecided: number | null;
  quoted: number;
  refusedOnly: number;
  /** the other legs hit but resolved too late to quote before the last game started */
  windowMissed: number;
  attempts: number;
  refusalCodes: Record<string, number>;
  /** across first quotes */
  avgMinutesToStartAtQuote: number | null;
  avgCreditCents: number | null;
  /** credit as bps of the ticket's fair value at the moment */
  avgCreditBpsOfValue: number | null;
  /** floor and cap as a share of the last leg's mark: what the bettor keeps on a miss, what they give up on a hit */
  avgFloorPctOfMark: number | null;
  avgCapPctOfMark: number | null;
  avgEvCostBps: number | null;
  /** across quoted moments: fair value of the tickets, credits offered, take booked */
  ticketValueAtQuoteCents: number;
  creditsCents: number;
  takeCents: number;
  settled: {
    count: number;
    withProtection: number;
    floorSaves: number;
    capGiveups: number;
    scalar: number;
    protectedCents: number;
    nakedCents: number;
    deltaCents: number;
    writerCents: number;
    takeBookedCents: number;
    /** writer P&L equals the take booked, within 1c per settled ticket */
    identityHolds: boolean;
  };
  bySize: LastLegSizeRow[];
  firstTicketAt: string | null;
  lastMomentAt: string | null;
  voided: number;
}

const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Every leg on the record with its pinned rule and, once resolved, the second read: the evidence line on the record page. */
export function summarizeLegRules(tickets: readonly LastLegTicket[]): RuleEvidenceSummary {
  return summarizeRuleEvidence(tickets.flatMap((t) => t.legs.map((l) => ({ id: l.slug, rule: l.rule, check: t.legRuleChecks?.[l.conditionId] }))));
}

export function summarizeLastLeg(tickets: readonly LastLegTicket[]): LastLegSummary {
  const sizes = new Map<number, LastLegSizeRow>();
  const row = (n: number): LastLegSizeRow => {
    let r = sizes.get(n);
    if (!r) {
      r = { size: n, built: 0, busted: 0, reachedLastLeg: 0, quoted: 0, refusedOnly: 0, settled: 0, protectedCents: 0, nakedCents: 0 };
      sizes.set(n, r);
    }
    return r;
  };
  const refusalCodes: Record<string, number> = {};
  const lead: number[] = [];
  const credits: number[] = [];
  const creditBps: number[] = [];
  const floorPct: number[] = [];
  const capPct: number[] = [];
  const ev: number[] = [];
  let attempts = 0;
  let open = 0;
  let busted = 0;
  let reached = 0;
  let quoted = 0;
  let refusedOnly = 0;
  let windowMissed = 0;
  let voided = 0;
  let valueAtQuote = 0;
  let creditsSum = 0;
  let takeSum = 0;
  let firstTicketAt: string | null = null;
  let lastMomentAt: string | null = null;
  const settled = { count: 0, withProtection: 0, floorSaves: 0, capGiveups: 0, scalar: 0, protectedCents: 0, nakedCents: 0, deltaCents: 0, writerCents: 0, takeBookedCents: 0 };

  for (const t of tickets) {
    const r = row(t.size);
    r.built += 1;
    if (!firstTicketAt || t.at < firstTicketAt) firstTicketAt = t.at;
    if (t.lastAttemptAt && (!lastMomentAt || t.lastAttemptAt > lastMomentAt)) lastMomentAt = t.lastAttemptAt;
    attempts += t.attempts;
    for (const [code, n] of Object.entries(t.refusals)) refusalCodes[code] = (refusalCodes[code] ?? 0) + n;
    if (t.status === "void") voided += 1;
    if (t.status === "open") open += 1;
    if (t.status === "busted") {
      busted += 1;
      r.busted += 1;
    }
    // Reached the moment: the other legs all hit, whether it is still waiting, quoted, or settled since.
    const reachedMoment = t.status === "last_leg" || (t.status === "settled" && t.decidedProductMilli > 0) || t.attempts > 0;
    if (reachedMoment) {
      reached += 1;
      r.reachedLastLeg += 1;
    }
    if (t.quote) {
      quoted += 1;
      r.quoted += 1;
      const q = t.quote;
      lead.push(q.minutesToStart);
      credits.push(q.creditCents as number);
      if (q.ticketValueCents > 0) creditBps.push(((q.creditCents as number) * 10_000) / q.ticketValueCents);
      floorPct.push(((q.floorCents as number) * 100) / q.markCents);
      capPct.push(((q.capCents as number) * 100) / q.markCents);
      ev.push(q.evCostBps as number);
      valueAtQuote += q.ticketValueCents;
      creditsSum += q.creditCents as number;
      takeSum += q.takeCents as number;
    } else if (t.attempts > 0 && (t.status === "settled" || t.status === "void")) {
      refusedOnly += 1;
      r.refusedOnly += 1;
    } else if (t.attempts === 0 && t.status === "settled" && t.decidedProductMilli > 0) {
      // The other legs hit, but their results landed too late to quote before the last game: the gap rule was too short.
      windowMissed += 1;
    }
    if (t.status === "settled" && t.outcome) {
      settled.count += 1;
      r.settled += 1;
      if (t.outcome.protectedCents !== null && t.quote) {
        settled.withProtection += 1;
        settled.protectedCents += t.outcome.protectedCents;
        settled.nakedCents += t.outcome.nakedCents;
        settled.deltaCents += t.outcome.deltaCents ?? 0;
        r.protectedCents += t.outcome.protectedCents;
        r.nakedCents += t.outcome.nakedCents;
        if (t.outcome.result === "no") settled.floorSaves += 1;
        else if (t.outcome.result === "yes") settled.capGiveups += 1;
        else settled.scalar += 1;
        if (t.outcome.writerCents !== null) {
          settled.writerCents += t.outcome.writerCents;
          settled.takeBookedCents += t.quote.takeCents as number;
        }
      }
    }
  }
  const decided = reached + busted;
  return {
    tickets: tickets.length,
    open,
    busted,
    reachedLastLeg: reached,
    reachedPctOfDecided: decided > 0 ? Math.round((reached / decided) * 1000) / 10 : null,
    quoted,
    refusedOnly,
    windowMissed,
    attempts,
    refusalCodes,
    avgMinutesToStartAtQuote: avg(lead),
    avgCreditCents: avg(credits),
    avgCreditBpsOfValue: avg(creditBps),
    avgFloorPctOfMark: avg(floorPct),
    avgCapPctOfMark: avg(capPct),
    avgEvCostBps: avg(ev),
    ticketValueAtQuoteCents: valueAtQuote,
    creditsCents: creditsSum,
    takeCents: takeSum,
    settled: {
      ...settled,
      identityHolds: Math.abs(settled.writerCents - settled.takeBookedCents) <= Math.max(1, settled.withProtection - settled.scalar),
    },
    bySize: [...sizes.values()].sort((a, b) => a.size - b.size),
    firstTicketAt,
    lastMomentAt,
    voided,
  };
}

/** One row per ticket, integer cents. */
export function lastLegCsv(tickets: readonly LastLegTicket[]): string {
  const head = [
    "ticket_id", "built_at", "size", "stake_cents", "combo_price_milli", "shares_milli", "legs", "last_leg", "last_leg_start", "status",
    "decided_product_milli", "attempts", "refusals", "quoted_at", "minutes_to_start", "contracts", "mark_cents", "entry_cents", "ticket_value_cents",
    "floor_cents", "cap_cents", "credit_cents", "take_cents", "tier", "ev_cost_bps", "hedge_shares_milli", "hedge_cost_cents",
    "result", "last_leg_value_milli", "naked_cents", "protected_cents", "delta_cents", "writer_cents",
  ];
  const cell = (v: unknown): string => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [...tickets]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((t) => {
      const last = t.legs[t.legs.length - 1];
      const q = t.quote;
      const o = t.outcome;
      return [
        t.ticketId, t.at, t.size, t.stakeCents, t.comboPriceMilli, t.sharesMilli, t.legs.map((l) => `${l.slug}/${l.outcome}`).join(" + "), last.slug, last.gameStartIso, t.status,
        t.decidedProductMilli, t.attempts, Object.entries(t.refusals).map(([k, n]) => `${k}:${n}`).join(";"), q?.at, q?.minutesToStart, q?.contracts, q?.markCents, q?.entryCents, q?.ticketValueCents,
        q?.floorCents, q?.capCents, q?.creditCents, q?.takeCents, q?.tier, q?.evCostBps, q?.hedgeSharesMilli, q?.hedgeCostCents,
        o?.result, o?.lastLegValueMilli, o?.nakedCents, o?.protectedCents, o?.deltaCents, o?.writerCents,
      ]
        .map(cell)
        .join(",");
    });
  return [head.join(","), ...rows].join("\n") + "\n";
}

// ── lock versus sell ──────────────────────────────────────────────────────────

/**
 * The bettor's three choices at the moment, side by side. SELL is a cash-out at
 * fair: the ticket's value on the contracts basis (contracts x mark), what a
 * marketplace would pay before its spread. LOCK is the collar: the two endings
 * (floor x contracts + credit, cap x contracts + credit) and the credit paid at
 * the tap. HOLD is the naked ticket. Only tickets with a priced quote appear;
 * settled rows carry what each choice actually paid.
 */
export interface LockVsSellRow {
  ticketId: string;
  quotedAt: string;
  size: number;
  /** the last leg as the bettor would read it: outcome and game */
  lastLeg: string;
  league: string;
  minutesToStart: number;
  contracts: number;
  markCents: number;
  sellCents: number;
  lockFloorCents: number;
  lockCapCents: number;
  creditCents: number;
  status: LastLegStatus;
  result?: LastLegOutcome["result"];
  /** settled only: what each choice paid */
  lockPaidCents?: number;
  holdPaidCents?: number;
}

export interface LockVsSellSummary {
  rows: LockVsSellRow[];
  quoted: number;
  settled: number;
  /** across quoted rows */
  sellCents: number;
  lockFloorCents: number;
  lockCapCents: number;
  creditsCents: number;
  /** across settled rows: what each choice paid */
  settledSellCents: number;
  settledLockCents: number;
  settledHoldCents: number;
  /** settled rows where the lock beat the sell, and where the hold beat both */
  lockBeatSell: number;
  holdBeatBoth: number;
}

export function lockVersusSell(tickets: readonly LastLegTicket[]): LockVsSellSummary {
  const rows: LockVsSellRow[] = [];
  for (const t of tickets) {
    const q = t.quote;
    if (!q || !q.ok || q.floorCents === undefined || q.capCents === undefined || q.creditCents === undefined) continue;
    const last = t.legs[t.legs.length - 1];
    const o = t.outcome;
    const settled = t.status === "settled" && o && o.protectedCents !== null;
    rows.push({
      ticketId: t.ticketId,
      quotedAt: q.at,
      size: t.size,
      lastLeg: legWords(last),
      league: last.league,
      minutesToStart: q.minutesToStart,
      contracts: q.contracts,
      markCents: q.markCents,
      sellCents: q.ticketValueCents,
      lockFloorCents: q.floorCents * q.contracts + q.creditCents,
      lockCapCents: q.capCents * q.contracts + q.creditCents,
      creditCents: q.creditCents,
      status: t.status,
      ...(o ? { result: o.result } : {}),
      ...(settled ? { lockPaidCents: o.protectedCents as number, holdPaidCents: o.nakedCents } : {}),
    });
  }
  rows.sort((a, b) => b.quotedAt.localeCompare(a.quotedAt));
  const s: LockVsSellSummary = {
    rows,
    quoted: rows.length,
    settled: 0,
    sellCents: 0,
    lockFloorCents: 0,
    lockCapCents: 0,
    creditsCents: 0,
    settledSellCents: 0,
    settledLockCents: 0,
    settledHoldCents: 0,
    lockBeatSell: 0,
    holdBeatBoth: 0,
  };
  for (const r of rows) {
    s.sellCents += r.sellCents;
    s.lockFloorCents += r.lockFloorCents;
    s.lockCapCents += r.lockCapCents;
    s.creditsCents += r.creditCents;
    if (r.lockPaidCents !== undefined && r.holdPaidCents !== undefined) {
      s.settled += 1;
      s.settledSellCents += r.sellCents;
      s.settledLockCents += r.lockPaidCents;
      s.settledHoldCents += r.holdPaidCents;
      if (r.lockPaidCents > r.sellCents) s.lockBeatSell += 1;
      if (r.holdPaidCents > r.lockPaidCents && r.holdPaidCents > r.sellCents) s.holdBeatBoth += 1;
    }
  }
  return s;
}

// ── the tick ──────────────────────────────────────────────────────────────────

/** Everything the tick touches outside itself, injected so the tick is testable without a venue. */
export interface LastLegIo {
  nowMs: () => number;
  catalog: () => Promise<{ markets: ComboLegMarket[]; pagesFetched: number; exhausted: boolean }>;
  legStatus: (slug: string) => Promise<ComboLegStatus | null>;
  noBook: (tokenId: string) => Promise<PmBook>;
  load: () => LastLegTicket[];
  append: (record: LastLegRecord) => void;
}

export interface LastLegTickReport {
  legsChecked: number;
  legsResolved: number;
  momentsAttempted: number;
  momentsQuoted: number;
  ticketsBuilt: number;
  candidates: number;
  catalogPages: number;
  voided: number;
  /** per-leg or per-ticket failures; the tick continues past each */
  errors: string[];
}

/**
 * One pass: resolve legs, quote the tickets at their moment, void the stale,
 * build new tickets while there is room. Every venue failure is recorded and
 * stepped over; the ledger is only ever appended to.
 */
export async function runLastLegTick(io: LastLegIo, cfg: LastLegConfig, search: CrossSearchConfig): Promise<LastLegTickReport> {
  const report: LastLegTickReport = { legsChecked: 0, legsResolved: 0, momentsAttempted: 0, momentsQuoted: 0, ticketsBuilt: 0, candidates: 0, catalogPages: 0, voided: 0, errors: [] };
  const nowMs = io.nowMs();
  const nowIso = new Date(nowMs).toISOString();
  const statusCache = new Map<string, ComboLegStatus | null>();
  const status = async (slug: string): Promise<ComboLegStatus | null> => {
    if (!statusCache.has(slug)) statusCache.set(slug, await io.legStatus(slug));
    return statusCache.get(slug) ?? null;
  };

  // 1) Resolve legs on every ticket still in play.
  let tickets = io.load();
  for (const t of tickets) {
    if (t.status !== "open" && t.status !== "last_leg") continue;
    for (const leg of t.legs) {
      if (t.legValues[leg.conditionId] !== undefined) continue;
      if (Date.parse(leg.gameStartIso) > nowMs) continue; // not started: nothing to resolve yet
      report.legsChecked += 1;
      try {
        const s = await status(leg.slug);
        if (s?.resolved && s.valueMilli !== null) {
          // Gamma values the venue's first outcome; the bettor's leg is worth that or its complement.
          const valueMilli = leg.side === 0 ? s.valueMilli : 1000 - s.valueMilli;
          io.append({ type: "leg", at: nowIso, ticketId: t.ticketId, conditionId: leg.conditionId, valueMilli, ruleCheck: checkRule(leg.rule, gammaRuleText(s), nowIso) });
          report.legsResolved += 1;
        }
      } catch (err) {
        report.errors.push(`leg ${leg.slug}: ${String(err instanceof Error ? err.message : err)}`);
      }
    }
  }

  // 2) Quote the moment on tickets whose other legs have all hit and whose last game is still ahead.
  tickets = io.load();
  for (const t of tickets) {
    if (t.status !== "last_leg" || t.quote) continue;
    const last = t.legs[t.legs.length - 1];
    const minutesToStart = (Date.parse(last.gameStartIso) - nowMs) / 60_000;
    if (minutesToStart < search.minMinutesToStart) continue; // the window has closed; the ticket runs to settlement unquoted
    report.momentsAttempted += 1;
    try {
      const s = await status(last.slug);
      const markCents = s && s.yesPriceMilli >= 0 ? Math.round((last.side === 0 ? s.yesPriceMilli : 1000 - s.yesPriceMilli) / 10) : -1;
      if (!s || markCents < 0 || s.closed) {
        io.append(
          momentRecord(
            { at: nowIso, ticketId: t.ticketId, minutesToStart, decidedProductMilli: t.decidedProductMilli, contracts: 0, markCents: Math.max(0, markCents), entryCents: 0 },
            { ok: false, code: "pm_book_empty", detail: s?.closed ? "the last leg's market has closed" : "the last leg's market is not readable right now" },
          ),
        );
        continue;
      }
      const contracts = compressedContracts(t.sharesMilli, t.decidedProductMilli);
      const entryCents = contracts > 0 ? Math.ceil(t.stakeCents / contracts) : 0;
      const noBook = await io.noBook(last.noTokenId);
      const q = quoteLastLeg({ contracts, markCents, entryCents, minutesToStart, noBook, noOutcome: s.outcomes[1 - last.side] ?? "the other side", config: search });
      io.append(momentRecord({ at: nowIso, ticketId: t.ticketId, minutesToStart, decidedProductMilli: t.decidedProductMilli, contracts, markCents, entryCents }, q));
      if (q.ok) report.momentsQuoted += 1;
    } catch (err) {
      report.errors.push(`moment ${t.ticketId}: ${String(err instanceof Error ? err.message : err)}`);
    }
  }

  // 3) Void tickets whose legs never resolved.
  tickets = io.load();
  for (const t of tickets) {
    if (t.status !== "open" && t.status !== "last_leg") continue;
    const lastStart = Math.max(...t.legs.map((l) => Date.parse(l.gameStartIso)));
    if (nowMs > lastStart + cfg.voidAfterMs) {
      io.append({ type: "void", at: nowIso, ticketId: t.ticketId, reason: `legs unresolved ${Math.round(cfg.voidAfterMs / 3_600_000)}h after the last start` });
      report.voided += 1;
    }
  }

  // 4) Build new tickets while there is room.
  tickets = io.load();
  const inPlay = tickets.filter((t) => t.status === "open" || t.status === "last_leg").length;
  const room = cfg.maxOpen - inPlay;
  if (cfg.ticketsPerSize > 0 && room > 0) {
    try {
      const cat = await io.catalog();
      report.catalogPages = cat.pagesFetched;
      const today = new Date(nowMs).toISOString().slice(0, 10);
      const horizon = new Date(nowMs + cfg.windowMs).toISOString().slice(0, 10);
      const rows: Array<{ market: ComboLegMarket; status: ComboLegStatus | null }> = [];
      for (const m of cat.markets) {
        if (!cfg.leagues.includes(m.league) || !m.slugDate || m.slugDate < today || m.slugDate > horizon) continue;
        try {
          rows.push({ market: m, status: await status(m.slug) });
        } catch (err) {
          report.errors.push(`catalog ${m.slug}: ${String(err instanceof Error ? err.message : err)}`);
        }
      }
      const cands = legCandidates(rows, cfg, nowMs);
      report.candidates = cands.length;
      const built = buildTickets(cands, cfg, tickets, nowIso, room);
      for (const rec of built) io.append(rec);
      report.ticketsBuilt = built.length;
    } catch (err) {
      report.errors.push(`catalog: ${String(err instanceof Error ? err.message : err)}`);
    }
  }
  return report;
}
