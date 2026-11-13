/**
 * Limitless's own public list of game markets, for when the partner refuses its copy of the
 * list to the key this page holds. Public market data: no key, no account.
 *
 * Only the grouped game markets are read (football: one group a game, one market for each team
 * and one for the draw, each a Yes and a No token). A child's Yes token is "this pick wins", so
 * which outcome it is can be read from its title. Its single two-team markets are left out: the
 * list does not say in a field which team its Yes token is, and that is not guessed.
 *
 * What comes back is the partner list's shape, with a child titled the way the partner titles
 * it ("UEFA NL, Belgium vs Italy: Belgium"), so the same reader ties both to a game.
 *
 * Read on 13 November 2026: GET /markets/active?tradeType=group&automationType=sports&page=N&limit=25
 * answers { data: [group], totalMarketsCount }, 25 a page at most, an empty page past the end.
 * A child carries the match's start (metadata.startMatchTimestampInUTC, in seconds) and its own
 * close (expirationTimestamp, in milliseconds), which is a day after the start on nearly all.
 * Not verified: that the partner's stream takes a child's own slug as the market id. If it does
 * not, every Limitless book comes back as an error and the page says so.
 */

import type { LimitlessGameMarket } from "./feed";

export const LIMITLESS_PUBLIC_HOST = "https://api.limitless.exchange";
const PAGE = 25;
const MAX_PAGES = 20;

interface PublicChild {
  title?: unknown;
  slug?: unknown;
  tokens?: { yes?: unknown; no?: unknown };
  expirationTimestamp?: unknown;
  expired?: unknown;
  metadata?: { startMatchTimestampInUTC?: unknown };
}
interface PublicGroup {
  title?: unknown;
  categories?: unknown;
  markets?: unknown;
}

const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** One group of the venue's list as the markets the partner's list would carry for it. */
export function groupToMarkets(group: PublicGroup): LimitlessGameMarket[] {
  const game = text(group.title);
  if (!game || !Array.isArray(group.markets)) return [];
  const categories = Array.isArray(group.categories) ? group.categories.filter((c): c is string => typeof c === "string") : [];
  const out: LimitlessGameMarket[] = [];
  for (const child of group.markets as PublicChild[]) {
    const pick = text(child?.title);
    const slug = text(child?.slug);
    const yes = text(child?.tokens?.yes);
    const no = text(child?.tokens?.no);
    const closes = Number(child?.expirationTimestamp);
    // the match's start, in seconds, by the venue's own field
    const starts = Number(child?.metadata?.startMatchTimestampInUTC);
    if (!pick || !slug || !yes || !no || child.expired === true) continue;
    out.push({
      marketSlug: slug,
      title: `${game}: ${pick}`,
      // asked for as sports, so said to be sports whatever the venue's own label is
      categories: [...categories, "Sports"],
      ...(Number.isFinite(closes) && closes > 0 ? { expiresAt: new Date(closes).toISOString() } : {}),
      ...(Number.isFinite(starts) && starts > 0 ? { startsAt: new Date(starts * 1000).toISOString() } : {}),
      outcomes: [{ name: "Yes", tokenId: yes }, { name: "No", tokenId: no }],
    });
  }
  return out;
}

export async function readLimitlessPublicGames(opts: { fetchImpl?: typeof fetch; host?: string; pauseMs?: number; timeoutMs?: number } = {}): Promise<LimitlessGameMarket[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const host = (opts.host ?? LIMITLESS_PUBLIC_HOST).replace(/\/+$/, "");
  const out: LimitlessGameMarket[] = [];
  let seen = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    if (page > 1 && opts.pauseMs !== 0) await new Promise((res) => setTimeout(res, opts.pauseMs ?? 300));
    const r = await fetchImpl(`${host}/markets/active?tradeType=group&automationType=sports&page=${page}&limit=${PAGE}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
    if (!r.ok) throw new Error(`Limitless public list ${r.status}`);
    const body = (await r.json()) as { data?: unknown; totalMarketsCount?: unknown };
    const groups = Array.isArray(body?.data) ? (body.data as PublicGroup[]) : [];
    if (!groups.length) break;
    for (const g of groups) out.push(...groupToMarkets(g));
    seen += groups.length;
    const total = Number(body.totalMarketsCount);
    if (Number.isFinite(total) && seen >= total) break;
  }
  return out;
}
