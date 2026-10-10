/**
 * Polymarket Combos — public reads only, no keys, nothing signed.
 *
 * WHAT IS PUBLIC, AND WHAT IS NOT. Polymarket's combinatorial RFQ API publishes
 * one unauthenticated endpoint: the catalog of markets that may be used as combo
 * legs (GET /v1/rfq/combo-markets, ordered by volume, paged). Combo tickets
 * themselves are per-user RFQ positions; there is no public list of live
 * tickets, no public combo order book, and the maker trade broadcast is
 * authenticated. So nothing here can see a real bettor's ticket. The last-leg
 * shadow (lastLeg.ts) builds representative tickets from this catalog the way
 * a bettor would, and this module supplies the two public facts it needs:
 *   - which markets can be legs, with their live YES/NO prices and position ids
 *   - each leg's game time and, later, its official resolution (Gamma API)
 *
 * Money: catalog prices arrive as decimal strings and are parsed EXACTLY to
 * integer milli units (1000 = $1) with the shared decimalToMilli; no float
 * enters a credit identity downstream.
 */

import { fetchJsonWithRetry } from "../kalshiPublic";
import { decimalToMilli, gammaBase, normalizeGammaTime } from "./polymarketPublic";

const DEFAULT_COMBOS_BASE = "https://combos-rfq-api.polymarket.com";

export function combosBase(): string {
  return process.env.PM_COMBOS_REST_BASE?.replace(/\/$/, "") || DEFAULT_COMBOS_BASE;
}

/** One market from the public combo-leg catalog. Index 0 is the venue's YES side, 1 its NO side. */
export interface ComboLegMarket {
  conditionId: string;
  slug: string;
  title: string;
  outcomes: [string, string];
  /** ERC-1155 position ids, [YES, NO] */
  positionIds: [string, string];
  /** live prices, milli, [YES, NO]; -1 when unreadable */
  pricesMilli: [number, number];
  volumeUsd: number;
  tags: string[];
  /** the league the slug names (its first token, e.g. "nfl"); "" when the slug has none */
  league: string;
  /** the game date the slug ends with (YYYY-MM-DD), or null: sports slugs carry it, long-dated markets do not */
  slugDate: string | null;
}

const SLUG_DATE = /-(\d{4}-\d{2}-\d{2})(?:-[a-z0-9]+)?$/;

/** Parse one catalog row; null when it lacks the two sides a leg needs. Exported for tests. */
export function parseComboMarket(raw: Record<string, unknown>): ComboLegMarket | null {
  const outcomes = Array.isArray(raw.outcomes) ? raw.outcomes.map(String) : [];
  const positionIds = Array.isArray(raw.position_ids) ? raw.position_ids.map(String) : [];
  const prices = Array.isArray(raw.outcome_prices) ? raw.outcome_prices.map((p) => decimalToMilli(p as string, false)) : [];
  const conditionId = String(raw.condition_id ?? "");
  const slug = String(raw.slug ?? "");
  if (!conditionId || !slug || outcomes.length !== 2 || positionIds.length !== 2 || prices.length !== 2) return null;
  if (raw.pending === true) return null; // not yet tradable as a leg
  const dateMatch = SLUG_DATE.exec(slug);
  return {
    conditionId,
    slug,
    title: String(raw.title ?? ""),
    outcomes: [outcomes[0], outcomes[1]],
    positionIds: [positionIds[0], positionIds[1]],
    pricesMilli: [prices[0], prices[1]],
    volumeUsd: Number(raw.volume ?? 0),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    league: slug.split("-")[0] ?? "",
    slugDate: dateMatch ? dateMatch[1] : null,
  };
}

/**
 * Page through the public catalog (100 per page, volume descending) up to
 * `maxPages`. The catalog mixes every topic; callers filter by league and date.
 */
export async function getComboMarkets(
  opts: { maxPages: number; fetchImpl?: typeof fetch },
): Promise<{ markets: ComboLegMarket[]; pagesFetched: number; exhausted: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const markets: ComboLegMarket[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let exhausted = false;
  while (pages < Math.max(1, opts.maxPages)) {
    const url = `${combosBase()}/v1/rfq/combo-markets?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const data = (await fetchJsonWithRetry(url, fetchImpl)) as { markets?: Record<string, unknown>[]; next_cursor?: string | null };
    pages += 1;
    for (const m of data.markets ?? []) {
      const parsed = parseComboMarket(m);
      if (parsed) markets.push(parsed);
    }
    if (!data.next_cursor) {
      exhausted = true;
      break;
    }
    cursor = data.next_cursor;
  }
  return { markets, pagesFetched: pages, exhausted };
}

/**
 * One leg's status from Gamma: when the game starts, whether it is a moneyline,
 * and once the venue has settled it, what the YES side is worth.
 *
 *   valueMilli   null while open; 1000 or 0 once resolved; a fraction when the
 *                venue settled it partially (the "scalar" case: a no-show, a
 *                50/50), which the ticket then carries as a factor.
 */
export interface ComboLegStatus {
  conditionId: string;
  slug: string;
  question: string;
  outcomes: string[];
  tokenIds: string[];
  /** live YES price, milli (the venue's first outcome); -1 when absent */
  yesPriceMilli: number;
  gameStartIso: string | null;
  sportsMarketType: string;
  closed: boolean;
  resolved: boolean;
  valueMilli: number | null;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Resolution rule, from the venue's own fields: `closed` and
 * `umaResolutionStatus === "resolved"` together mean the first outcome's price
 * is its settled value (1, 0, or a fraction). A closed market still awaiting
 * resolution is not resolved; its price is a proposal, not a result.
 */
export function legStatusFromGamma(raw: Record<string, unknown>): ComboLegStatus {
  const prices = asStringArray(raw.outcomePrices).map((p) => decimalToMilli(p, false));
  const closed = raw.closed === true;
  const resolved = closed && String(raw.umaResolutionStatus ?? "") === "resolved" && prices.length >= 1 && prices[0] >= 0;
  return {
    conditionId: String(raw.conditionId ?? ""),
    slug: String(raw.slug ?? ""),
    question: String(raw.question ?? ""),
    outcomes: asStringArray(raw.outcomes),
    tokenIds: asStringArray(raw.clobTokenIds),
    yesPriceMilli: prices[0] ?? -1,
    gameStartIso: normalizeGammaTime(raw.gameStartTime),
    sportsMarketType: String(raw.sportsMarketType ?? ""),
    closed,
    resolved,
    valueMilli: resolved ? Math.min(1000, Math.max(0, prices[0])) : null,
  };
}

/**
 * Gamma market by slug; null when the venue has no such market.
 *
 * Gamma's list endpoint drops a market from `GET /markets?slug=` the moment it
 * closes, so a leg whose game has been played reads as "no such market" there
 * and would never resolve. The second read asks for closed markets by name;
 * only when both are empty does the venue have no such market.
 */
export async function getComboLegStatus(slug: string, fetchImpl: typeof fetch = fetch): Promise<ComboLegStatus | null> {
  const base = `${gammaBase()}/markets?slug=${encodeURIComponent(slug)}`;
  for (const url of [base, `${base}&closed=true`]) {
    const data = (await fetchJsonWithRetry(url, fetchImpl)) as Array<Record<string, unknown>>;
    const row = Array.isArray(data) ? data[0] : undefined;
    if (row) return legStatusFromGamma(row);
  }
  return null;
}
