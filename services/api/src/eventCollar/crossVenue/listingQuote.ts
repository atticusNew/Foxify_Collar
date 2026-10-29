/**
 * LISTING QUOTE — a firm number beside a marketplace ask.
 *
 * A bet marketplace (WagerWire is the one in hand) lists open tickets for
 * sale: a sportsbook parlay whose hit legs are done and whose last leg is a
 * future still running, with a seller's ask and, usually, no bid. Such a
 * ticket is a single-market position on the last leg: a payout of $P when
 * the leg wins is P contracts paying 100c each. That is the shape the event
 * collar funds, and the one the last-leg shadow already quotes (lastLeg.ts).
 * This module puts that quote next to the ask: what the seller could lock
 * today, hedged leg for leg on the venue that lists the same future, versus
 * what they are asking and what the market says the ticket is worth.
 *
 * What is real: the listing as a person read it on the public page (book,
 * legs, legs remaining, ask, highest bid, payout, resolution date), the live
 * venue book on the remaining leg, the quoted terms. What is not read: anything
 * by machine from the marketplace. Its terms forbid automated access, so the
 * listings arrive hand-entered in a JSON file with the page URL and the time a
 * person read it. Nothing is bought; this module cannot trade.
 *
 * Only one remaining leg is quoted. Two remaining legs are a product of two
 * markets, which a leg-for-leg hedge does not replicate; those listings are
 * refused with `legs_remaining`, never approximated.
 *
 * Carry. A future resolves months out, and the hedge capital (the NO shares
 * bought today) sits until then. The live book has no time term because its
 * games settle within days; here a carry charge is added on the hedge outlay,
 * `carryBpsPerMonth` x months to resolution, and deducted from the credit.
 *
 * Which collar. The live book leads with its balanced tier and lets the user
 * adjust. A seller with an ask and no bid wants one number: the most they are
 * guaranteed. So of every collar the book funds on the same floor/cap grid
 * (lastLeg.lastLegCollars, the grid the live product selects its tiers from),
 * the one shown is the one with the highest worst case after carry,
 * floor x N + credit; ties go to the higher cap. On a long-shot leg that is
 * the low floor with the tight cap: nearly a sale, which is what the seller
 * came to do, with the upside they keep stated plainly.
 *
 * Credit identity (integer cents; N contracts = floor(payout / 100)):
 *   funding = (100 - cap) x N            the cap slice the holder sells
 *   gross   = funding - hedgeCost - fees
 *   take    = fee rule on gross (collarSearch.computeTake)
 *   carry   = ceil((hedgeCost + fees) x carryBpsPerMonth x months / 10_000)
 *   credit  = gross - take - carry       must clear the minimum-credit rule
 * Holder, protected: cap x N + credit when the leg wins; floor x N + credit
 * when it loses. The lock's worst case, floor x N + credit, is the number set
 * beside the ask. Writer, whoever wins: funding - hedgeCost - fees - credit
 * = take + carry. The writer's result is the published take plus the stated
 * carry and nothing on the outcome (asserted in the test against
 * shadowLedger.writerPayouts on both results). Odd cents of payout below one
 * contract ride unprotected and are reported as such.
 */

import type { MinimumCreditRule } from "./minimumCredit";
import { DEFAULT_MINIMUM_CREDIT, clearsMinimumCredit, minimumCreditCents, minimumCreditRuleFromEnv } from "./minimumCredit";
import { evCostBps } from "./collarSearch";
import { lastLegCollars } from "./lastLeg";
import { writerPayouts } from "./shadowLedger";
import type { CrossHedgeLeg, CrossRefusalCode, CrossSearchConfig, PmBook } from "./types";
import { DEFAULT_CROSS_CONFIG } from "./types";

// ── the listing, as a person read it ─────────────────────────────────────────

export interface ListingLeg {
  /** the pick, e.g. "Kansas City Chiefs" */
  label: string;
  /** the market, e.g. "26/27 Super Bowl Winner" */
  market: string;
}

export interface RemainingLeg extends ListingLeg {
  venue: "polymarket";
  /** Gamma event slug that lists this future; required when it is the only remaining leg */
  eventSlug?: string;
  /** substring of the market question that names this outcome, e.g. "Kansas City Chiefs" */
  outcome?: string;
  /** outcome index the ticket needs; 0 = Yes on a two-outcome market */
  side: 0 | 1;
}

export interface Listing {
  id: string;
  sourceUrl: string;
  /** when a person read the page, ISO */
  readAt: string;
  book: string;
  legsTotal: number;
  legsRemaining: number;
  listedPriceCents: number;
  highestBidCents: number | null;
  payoutCents: number;
  resolvesIso: string;
  hitLegs: ListingLeg[];
  remaining: RemainingLeg[];
  note?: string;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function parseLeg(raw: unknown, where: string): ListingLeg {
  const r = raw as Record<string, unknown>;
  if (!r || !isStr(r.label) || !isStr(r.market)) throw new Error(`${where}: a leg needs label and market`);
  return { label: r.label.trim(), market: r.market.trim() };
}

/** Validate hand-entered listings. Money must be integer cents; dates must parse. */
export function parseListings(raw: unknown): Listing[] {
  if (!Array.isArray(raw)) throw new Error("listings: expected an array");
  return raw.map((item, i) => {
    const r = item as Record<string, unknown>;
    const where = `listings[${i}]`;
    if (!isStr(r.id)) throw new Error(`${where}: id required`);
    if (!isStr(r.sourceUrl) || !/^https:\/\//.test(r.sourceUrl)) throw new Error(`${where}: sourceUrl must be an https URL`);
    if (!isStr(r.readAt) || Number.isNaN(Date.parse(r.readAt))) throw new Error(`${where}: readAt must be an ISO time`);
    if (!isStr(r.book)) throw new Error(`${where}: book required`);
    if (!isInt(r.legsTotal) || r.legsTotal < 1) throw new Error(`${where}: legsTotal must be a positive integer`);
    if (!isInt(r.legsRemaining) || r.legsRemaining < 1 || r.legsRemaining > r.legsTotal) throw new Error(`${where}: legsRemaining must be 1..legsTotal`);
    if (!isInt(r.listedPriceCents) || r.listedPriceCents <= 0) throw new Error(`${where}: listedPriceCents must be positive integer cents`);
    if (!(r.highestBidCents === null || (isInt(r.highestBidCents) && r.highestBidCents > 0))) throw new Error(`${where}: highestBidCents must be null or positive integer cents`);
    if (!isInt(r.payoutCents) || r.payoutCents <= 0) throw new Error(`${where}: payoutCents must be positive integer cents`);
    if (!isStr(r.resolvesIso) || Number.isNaN(Date.parse(r.resolvesIso))) throw new Error(`${where}: resolvesIso must be an ISO time`);
    const hitLegs = Array.isArray(r.hitLegs) ? r.hitLegs.map((l, j) => parseLeg(l, `${where}.hitLegs[${j}]`)) : [];
    const remaining = Array.isArray(r.remaining) ? r.remaining : [];
    if (remaining.length !== r.legsRemaining) throw new Error(`${where}: remaining has ${remaining.length} legs, legsRemaining says ${r.legsRemaining}`);
    if (hitLegs.length + remaining.length !== r.legsTotal) throw new Error(`${where}: hit + remaining legs must equal legsTotal`);
    const rem: RemainingLeg[] = remaining.map((l, j) => {
      const base = parseLeg(l, `${where}.remaining[${j}]`);
      const rl = l as Record<string, unknown>;
      if (rl.venue !== "polymarket") throw new Error(`${where}.remaining[${j}]: venue must be "polymarket"`);
      if (rl.side !== 0 && rl.side !== 1) throw new Error(`${where}.remaining[${j}]: side must be 0 or 1`);
      if (r.legsRemaining === 1 && (!isStr(rl.eventSlug) || !isStr(rl.outcome))) {
        throw new Error(`${where}.remaining[${j}]: the one remaining leg needs eventSlug and outcome`);
      }
      return { ...base, venue: "polymarket", eventSlug: isStr(rl.eventSlug) ? rl.eventSlug.trim() : undefined, outcome: isStr(rl.outcome) ? rl.outcome.trim() : undefined, side: rl.side };
    });
    return {
      id: r.id.trim(),
      sourceUrl: r.sourceUrl.trim(),
      readAt: new Date(r.readAt).toISOString(),
      book: r.book.trim(),
      legsTotal: r.legsTotal,
      legsRemaining: r.legsRemaining,
      listedPriceCents: r.listedPriceCents,
      highestBidCents: r.highestBidCents,
      payoutCents: r.payoutCents,
      resolvesIso: new Date(r.resolvesIso).toISOString(),
      hitLegs,
      remaining: rem,
      note: isStr(r.note) ? r.note.trim() : undefined,
    };
  });
}

// ── configuration ─────────────────────────────────────────────────────────────

export interface ListingQuoteConfig {
  search: CrossSearchConfig;
  minimum: MinimumCreditRule;
  /** carry on the hedge outlay, bps per month to resolution */
  carryBpsPerMonth: number;
}

export const DEFAULT_LISTING_CONFIG: ListingQuoteConfig = {
  search: DEFAULT_CROSS_CONFIG,
  minimum: DEFAULT_MINIMUM_CREDIT,
  carryBpsPerMonth: 50,
};

export function listingConfigFromEnv(env: NodeJS.ProcessEnv): ListingQuoteConfig {
  const n = Number(env.EVENT_LISTING_CARRY_BPS_PER_MONTH);
  return {
    search: DEFAULT_CROSS_CONFIG,
    minimum: minimumCreditRuleFromEnv(env),
    carryBpsPerMonth: Number.isFinite(n) && n >= 0 ? Math.round(n) : DEFAULT_LISTING_CONFIG.carryBpsPerMonth,
  };
}

// ── arithmetic ────────────────────────────────────────────────────────────────

/** A payout of P cents is floor(P / 100) contracts paying 100c; the odd cents ride unprotected. */
export function listingContracts(payoutCents: number): { contracts: number; unprotectedCents: number } {
  const contracts = Math.floor(payoutCents / 100);
  return { contracts, unprotectedCents: payoutCents - contracts * 100 };
}

/** Months of carry: whole 30-day months to resolution, at least one. */
export function monthsToResolution(nowMs: number, resolvesIso: string): number {
  const days = (Date.parse(resolvesIso) - nowMs) / 86_400_000;
  return Math.max(1, Math.ceil(days / 30));
}

/** The carry charge on the hedge outlay, rounded up (it is a cost to the holder). */
export function carryCents(hedgeOutlayCents: number, months: number, bpsPerMonth: number): number {
  return Math.ceil((hedgeOutlayCents * bpsPerMonth * months) / 10_000);
}

/** What the market says the ticket is worth: payout at the venue's price, to the cent. */
export function fairCents(contracts: number, markMilli: number): number {
  return Math.round((contracts * markMilli) / 10);
}

// ── the quote ─────────────────────────────────────────────────────────────────

export type ListingRefusalCode = CrossRefusalCode | "legs_remaining" | "market_closed";

export interface ListingMarketState {
  /** the remaining leg's price for the side the ticket needs, cents (the pricer's grid is in cents) */
  markCents: number;
  /** the same price in milli (1000 = $1), for the fair value shown beside the ask */
  markMilli: number;
  noBook: PmBook;
  noOutcome: string;
  closed: boolean;
  eventTitle: string;
  question: string;
}

export interface ListingLockTerms {
  ok: true;
  /** how this collar was chosen from the grid */
  rule: "highest worst case";
  floorCents: number;
  capCents: number;
  /** paid at the tap, after take and carry */
  creditCents: number;
  grossCreditCents: number;
  takeCents: number;
  carryCents: number;
  monthsCarried: number;
  feesCents: number;
  hedgeSharesMilli: number;
  hedgeCostCents: number;
  hedgeAvgPriceMilli: number;
  hedgeWorstPriceMilli: number;
  hedgeTokenId: string;
  /** floor x N + credit: what the holder has whatever happens */
  lockWorstCents: number;
  /** cap x N + credit: what the holder has when the leg hits */
  lockBestCents: number;
  evCostBps: number;
  candidatesConsidered: number;
}

export interface ListingRefusal {
  ok: false;
  code: ListingRefusalCode;
  detail: string;
}

export interface ListingQuoteRow {
  at: string;
  id: string;
  sourceUrl: string;
  readAt: string;
  book: string;
  legsTotal: number;
  legsRemaining: number;
  hitLegs: ListingLeg[];
  remaining: RemainingLeg[];
  resolvesIso: string;
  askCents: number;
  bidCents: number | null;
  payoutCents: number;
  contracts: number;
  unprotectedCents: number;
  /** null when the market could not be read */
  markCents: number | null;
  markMilli: number | null;
  fairCents: number | null;
  /** ask over fair, bps of fair; null without a mark */
  askVsFairBps: number | null;
  venue: string;
  marketTitle: string | null;
  quote: ListingLockTerms | ListingRefusal;
  /** the lock's worst case clears the ask; null when refused */
  lockBeatsAsk: boolean | null;
}

function baseRow(l: Listing, nowIso: string): Omit<ListingQuoteRow, "markCents" | "markMilli" | "fairCents" | "askVsFairBps" | "marketTitle" | "quote" | "lockBeatsAsk"> {
  const { contracts, unprotectedCents } = listingContracts(l.payoutCents);
  return {
    at: nowIso,
    id: l.id,
    sourceUrl: l.sourceUrl,
    readAt: l.readAt,
    book: l.book,
    legsTotal: l.legsTotal,
    legsRemaining: l.legsRemaining,
    hitLegs: l.hitLegs,
    remaining: l.remaining,
    resolvesIso: l.resolvesIso,
    askCents: l.listedPriceCents,
    bidCents: l.highestBidCents,
    payoutCents: l.payoutCents,
    contracts,
    unprotectedCents,
    venue: l.remaining[0]?.venue ?? "polymarket",
  };
}

/** A listing we cannot quote before reading any market: more than one leg left. */
export function refuseListing(l: Listing, nowIso: string, code: ListingRefusalCode, detail: string): ListingQuoteRow {
  return { ...baseRow(l, nowIso), markCents: null, markMilli: null, fairCents: null, askVsFairBps: null, marketTitle: null, quote: { ok: false, code, detail }, lockBeatsAsk: null };
}

/**
 * The event collar on the listing's payout, hedged on the remaining leg's NO
 * book, with carry to resolution; set beside the ask.
 */
export function quoteListing(l: Listing, state: ListingMarketState, nowMs: number, cfg: ListingQuoteConfig = DEFAULT_LISTING_CONFIG): ListingQuoteRow {
  const nowIso = new Date(nowMs).toISOString();
  if (l.legsRemaining !== 1) {
    return refuseListing(l, nowIso, "legs_remaining", `${l.legsRemaining} legs remain; a leg-for-leg hedge covers one market, not a product of ${l.legsRemaining}`);
  }
  const base = baseRow(l, nowIso);
  const fair = fairCents(base.contracts, state.markMilli);
  const askVsFairBps = fair > 0 ? Math.round(((l.listedPriceCents - fair) * 10_000) / fair) : null;
  const withMarket = { ...base, markCents: state.markCents, markMilli: state.markMilli, fairCents: fair, askVsFairBps, marketTitle: `${state.eventTitle}: ${state.question}` };
  if (state.closed) {
    return { ...withMarket, quote: { ok: false, code: "market_closed", detail: "the remaining leg's market is no longer accepting orders" }, lockBeatsAsk: null };
  }
  const months = monthsToResolution(nowMs, l.resolvesIso);
  const entryCents = base.contracts > 0 ? Math.ceil(l.listedPriceCents / base.contracts) : 0;
  const minutesToStart = (Date.parse(l.resolvesIso) - nowMs) / 60_000;
  const grid = lastLegCollars({ contracts: base.contracts, markCents: state.markCents, entryCents, minutesToStart, noBook: state.noBook, noOutcome: state.noOutcome, config: cfg.search });
  if (!grid.ok) return { ...withMarket, quote: { ok: false, code: grid.code, detail: grid.detail }, lockBeatsAsk: null };

  // Every collar the book funds, each with its own carry (the hedge outlay differs per collar).
  const candidates = grid.search.candidates;
  let best: ListingLockTerms | null = null;
  let bestCreditSeen = Number.NEGATIVE_INFINITY;
  let bestCreditPositive = false;
  for (const t of candidates) {
    const hedge = t.hedge as CrossHedgeLeg;
    const carry = carryCents(hedge.costCents + t.feesCents, months, cfg.carryBpsPerMonth);
    const credit = t.creditCents - carry;
    bestCreditSeen = Math.max(bestCreditSeen, credit);
    if (credit <= 0) continue;
    bestCreditPositive = true;
    if (!clearsMinimumCredit(credit, base.contracts, cfg.minimum)) continue;
    const lockWorst = t.floorCents * base.contracts + credit;
    const lockBest = t.capCents * base.contracts + credit;
    if (best && (lockWorst < best.lockWorstCents || (lockWorst === best.lockWorstCents && lockBest <= best.lockBestCents))) continue;
    best = {
      ok: true,
      rule: "highest worst case",
      floorCents: t.floorCents,
      capCents: t.capCents,
      creditCents: credit,
      grossCreditCents: t.grossCreditCents,
      takeCents: t.takeCents,
      carryCents: carry,
      monthsCarried: months,
      feesCents: t.feesCents,
      hedgeSharesMilli: hedge.sharesMilli,
      hedgeCostCents: hedge.costCents,
      hedgeAvgPriceMilli: hedge.avgPriceMilli,
      hedgeWorstPriceMilli: hedge.worstPriceMilli,
      hedgeTokenId: hedge.tokenId,
      lockWorstCents: lockWorst,
      lockBestCents: lockBest,
      evCostBps: evCostBps(state.markCents, t.floorCents, t.capCents, credit, base.contracts),
      candidatesConsidered: candidates.length,
    };
  }
  if (!best) {
    const monthWord = `${months} month${months === 1 ? "" : "s"}`;
    if (!bestCreditPositive) {
      return {
        ...withMarket,
        quote: { ok: false, code: "credit_nonpositive", detail: `carry for ${monthWord} to resolution eats the credit on every tier (best ${fmtUsd(bestCreditSeen)} after carry)` },
        lockBeatsAsk: null,
      };
    }
    return {
      ...withMarket,
      quote: { ok: false, code: "credit_too_small", detail: `best credit ${fmtUsd(bestCreditSeen)} after ${monthWord} of carry is under the minimum ${fmtUsd(minimumCreditCents(base.contracts, cfg.minimum))}` },
      lockBeatsAsk: null,
    };
  }
  return { ...withMarket, quote: best, lockBeatsAsk: best.lockWorstCents >= l.listedPriceCents };
}

// ── settlement ────────────────────────────────────────────────────────────────

export interface ListingSettlement {
  result: "yes" | "no";
  /** the ticket unprotected: payout or nothing */
  nakedCents: number;
  /** the locked ticket: cap or floor on every contract, plus the credit, plus the odd cents if the leg hit */
  protectedCents: number;
  /** what accepting the ask would have left the seller */
  askCents: number;
  writerCents: number;
  hedgePayoutCents: number;
}

/**
 * Mark a quoted listing against the official result. The writer's result is
 * take + carry on either outcome: writerPayouts derives the hedge outlay from
 * the identity (funding - credit - the writer's charge), so the charge passed
 * is the whole of what the writer keeps, take and carry together.
 */
export function settleListing(row: ListingQuoteRow, result: "yes" | "no"): ListingSettlement | null {
  if (!row.quote.ok) return null;
  const q = row.quote;
  const naked = result === "yes" ? row.payoutCents : 0;
  const per = result === "yes" ? q.capCents : q.floorCents;
  const protectedCents = per * row.contracts + q.creditCents + (result === "yes" ? row.unprotectedCents : 0);
  const w = writerPayouts(
    {
      contracts: row.contracts,
      floorCents: q.floorCents,
      capCents: q.capCents,
      creditCents: q.creditCents,
      takeCents: q.takeCents + q.carryCents,
      hedgeCostCents: q.hedgeCostCents + q.feesCents,
      hedgeUnitsMilli: q.hedgeSharesMilli,
    },
    result,
  );
  return { result, nakedCents: naked, protectedCents, askCents: row.askCents, writerCents: w.writerCents, hedgePayoutCents: w.hedgePayoutCents };
}

// ── the page ──────────────────────────────────────────────────────────────────

export function fmtUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

/** Whole dollars when there are no cents: "$3,825" not "$3,825.00". */
export function fmtUsdShort(cents: number): string {
  return cents % 100 === 0 ? fmtUsd(cents).slice(0, -3) : fmtUsd(cents);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtMonth = (iso: string): string => {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

function ticketName(r: ListingQuoteRow): string {
  return r.legsTotal === 1 ? `${r.book} single` : `${r.book} ${r.legsTotal}-leg parlay`;
}

const REFUSAL_WORDS: Record<ListingRefusalCode, string> = {
  legs_remaining: "two legs still running; we hedge one market, not a product of two, so no number rather than a guess",
  market_closed: "the venue has stopped taking orders on this future",
  mark_out_of_range: "the market prices this leg outside the 10c to 92c band we quote; under it the ticket is a lottery ticket and a floor would be nearly its whole value, over it there is little left to protect",
  pm_book_empty: "no one is offering the other side on the venue right now",
  pm_book_too_thin: "the venue's book is too shallow to hedge a ticket this size leg for leg",
  credit_nonpositive: "the hedge costs more than the cap slice funds; no credit to pay",
  credit_too_small: "a credit was funded but it is under our minimum",
  protection_too_rich: "the cheapest protection costs more than our ceiling in expected value",
  market_too_close_to_start: "too close to resolution",
  no_matched_market: "we found no venue market for this leg",
  resolution_mismatch: "the venue's market resolves on different terms than the ticket",
  kalshi_book_empty: "no one is offering the other side on the venue right now",
  kalshi_book_too_thin: "the venue's book is too shallow to hedge a ticket this size",
  prophetx_book_empty: "no one is offering the other side on ProphetX right now",
  prophetx_book_too_thin: "ProphetX's book is too shallow to hedge a ticket this size",
  route_not_offered: "this venue is not offered as a hedge venue tonight",
  far_out_no_book: "days from the start and no venue has a real book yet; priced again inside the window",
  mark_disagreement: "the market's own price has not settled: its side is a stub or sits far from the hedge venue's; priced again next scan",
  route_gated: "a hedge was priced but no venue could take it tonight: the market closes before the lock or the hedge cannot be sent there",
};

export interface ListingPageOptions {
  marketplace: string;
  contact?: string;
  /** the venue(s) the hedge is bought on, named once */
  hedgeVenues?: string[];
}

/**
 * The one-pager: every listing on one table, the quoted ones with the lock
 * beside the ask, the refused ones with the reason in plain words. No em
 * dashes; money in dollars and cents.
 */
export function listingsMarkdown(rows: readonly ListingQuoteRow[], atIso: string, opts: ListingPageOptions): string {
  const quoted = rows.filter((r) => r.quote.ok);
  const refused = rows.filter((r) => !r.quote.ok);
  const beat = quoted.filter((r) => r.lockBeatsAsk).length;
  const noBid = rows.filter((r) => r.bidCents === null).length;
  const venues = opts.hedgeVenues?.length ? opts.hedgeVenues.join(" and ") : "Polymarket";
  const lines: string[] = [];
  lines.push(`# ${rows.length} of your listings, priced`);
  lines.push("");
  lines.push(`Prepared for ${opts.marketplace}. Prices as of ${atIso.replace("T", " ").slice(0, 16)} UTC. Listings as a person read them on your public pages; nothing was read by machine and nothing was bought.`);
  lines.push("");
  const anyBid = rows.some((r) => r.bidCents !== null);
  lines.push(`**${quoted.length} of ${rows.length} quoted.** ${beat} of the ${quoted.length} locks pay more in their worst case than the seller is asking. ${noBid} of ${rows.length} listings show no bid.`);
  lines.push("");
  lines.push(`| Ticket | Last leg | Ask |${anyBid ? " High bid |" : ""} Fair now | Lock: worst / if it hits | Paid now |`);
  lines.push(`|---|---|---|${anyBid ? "---|" : ""}---|---|---|`);
  for (const r of rows) {
    const leg = r.remaining.map((x) => `${x.label}, ${x.market}`).join("; ");
    const ticket = `${ticketName(r)}, pays ${fmtUsdShort(r.payoutCents)}, ${fmtMonth(r.resolvesIso)}`;
    const bid = anyBid ? ` ${r.bidCents === null ? "none" : fmtUsd(r.bidCents)} |` : "";
    const fair = r.fairCents === null ? "n/a" : fmtUsd(r.fairCents);
    if (r.quote.ok) {
      const q = r.quote;
      const mark = r.lockBeatsAsk ? " (beats the ask)" : "";
      lines.push(`| ${ticket} | ${leg} | ${fmtUsd(r.askCents)} |${bid} ${fair} | ${fmtUsd(q.lockWorstCents)}${mark} / ${fmtUsd(q.lockBestCents)} | ${fmtUsd(q.creditCents)} |`);
    } else {
      lines.push(`| ${ticket} | ${leg} | ${fmtUsd(r.askCents)} |${bid} ${fair} | not quoted | none |`);
    }
  }
  lines.push("");
  lines.push(`Each ticket is a parlay whose hit legs are done and whose last leg is a future still running. That makes it one position on one market, which is the shape we protect. The lock is a firm floor and cap on that leg, hedged leg for leg on ${venues}, with a credit paid the moment the seller taps.`);
  lines.push("");
  lines.push("Pays: the ticket's full payout if the last leg hits, as listed, with the month it resolves. Fair now: payout times the venue's live price on that leg. Lock, worst: the floor on every dollar of payout plus the credit; the seller has at least this whatever happens. Lock, if it hits: the cap plus the credit. Paid now: the credit at the tap.");
  lines.push("");
  if (quoted.length) {
    lines.push("## Each quoted ticket");
    lines.push("");
    for (const r of quoted) {
      const q = r.quote as ListingLockTerms;
      const leg = r.remaining[0];
      const askWord = r.askVsFairBps === null ? "" : r.askVsFairBps >= 0 ? `${(r.askVsFairBps / 100).toFixed(0)}% above fair` : `${(-r.askVsFairBps / 100).toFixed(0)}% below fair`;
      lines.push(`**${ticketName(r)}, pays ${fmtUsd(r.payoutCents)} if ${leg.label} wins (${leg.market}).** Ask ${fmtUsd(r.askCents)}, ${askWord}; ${r.bidCents === null ? "no bid" : `high bid ${fmtUsd(r.bidCents)}`}. The market prices the leg at ${((r.markMilli as number) / 10).toFixed(1)}c, so the ticket is worth ${fmtUsd(r.fairCents as number)} tonight. Lock: floor ${q.floorCents}c, cap ${q.capCents}c on ${r.contracts.toLocaleString("en-US")} contracts, ${fmtUsd(q.creditCents)} paid now. The seller ends with ${fmtUsd(q.lockWorstCents)} if the leg misses and ${fmtUsd(q.lockBestCents)} if it hits${r.lockBeatsAsk ? `; the worst case is ${fmtUsd(q.lockWorstCents - r.askCents)} more than the ask` : ""}. Hedge: ${(q.hedgeSharesMilli / 1000).toLocaleString("en-US", { maximumFractionDigits: 0 })} shares of ${leg.label} NO at ${(q.hedgeAvgPriceMilli / 10).toFixed(1)}c average, ${fmtUsd(q.hedgeCostCents)} outlay carried ${q.monthsCarried} month${q.monthsCarried === 1 ? "" : "s"} (${fmtUsd(q.carryCents)}). Our take ${fmtUsd(q.takeCents)}, already netted out of the credit.${r.unprotectedCents ? ` The odd ${fmtUsd(r.unprotectedCents)} of payout rides unprotected.` : ""}`);
      lines.push("");
    }
  }
  if (refused.length) {
    lines.push("## Not quoted, and why");
    lines.push("");
    for (const r of refused) {
      const q = r.quote as ListingRefusal;
      const leg = r.remaining.map((x) => x.label).join(" and ");
      const fair = r.fairCents === null ? "" : ` The market prices the ticket at ${fmtUsd(r.fairCents)} against an ask of ${fmtUsd(r.askCents)}.`;
      lines.push(`- **${ticketName(r)}, ${leg}, ask ${fmtUsd(r.askCents)}:** ${REFUSAL_WORDS[q.code]}.${fair}`);
    }
    lines.push("");
  }
  lines.push("## What this is");
  lines.push("");
  lines.push("- The lock is a collar on the remaining leg: the seller sells the payout above the cap and buys a floor under it, in one tap, and is paid the difference now. We hedge every contract on the venue's book at the same moment, so we carry no outcome risk; we earn the stated take plus the stated carry, whoever wins.");
  lines.push("- Fair is the venue's price, not ours. Where the ask sits above fair, no buyer will come; where it sits below, the seller is giving value away. The lock's worst case is a number with a counterparty behind it.");
  lines.push("- A future resolves months out and the hedge sits until then, so the credit carries a time charge, shown on every row. The live book for games settling within days has none.");
  lines.push("- Every number here comes from a public page read by a person and a public order book read at the time stamped above. Prices move; the morning of a conversation we rerun the page.");
  lines.push("");
  lines.push(`When the legs resolve we mark every row against the official result: what the lock paid, what the ask would have paid, what the ticket did naked. The follow-up writes itself.${opts.contact ? ` ${opts.contact}` : ""}`);
  lines.push("");
  const out = lines.join("\n");
  if (out.includes("\u2014")) throw new Error("listing page: em dash in copy");
  return out;
}
