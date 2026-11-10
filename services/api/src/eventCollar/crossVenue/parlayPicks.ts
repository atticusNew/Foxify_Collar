/**
 * PARLAY PICKS — a venue's parlay ticket read as the games it names, and where each stands.
 *
 * The engine protects a parlay at its last pick only (lastLeg.ts): once every other pick has hit,
 * the ticket is one position on the last game, paying what the parlay pays if that pick hits and
 * nothing if it misses, and it is locked in like any single. Before that no hedge is placed: a
 * ticket with two picks open has no one market to buy the other side of.
 *
 * The extension reads the ticket off the venue's card: the club codes, each pick's opponent and
 * game day when the card is expanded, the stake and what it pays. This module turns those codes
 * into the service's markets (the week's open game markets, and the markets settled since the
 * ticket could have been placed, which carry the results) and says for each pick whether it is
 * open, won or lost, and for the ticket whether it is at its last pick. The same judgment is made
 * again at the tap, on the service's own read, before a lock is written.
 *
 * Nothing here prices anything. The words are the holder's: pick, hit, miss; no hedge mechanics.
 */

import { parseGameTicker } from "./eventMatcher";
import { LEAGUE_TEMPLATES, templateForSeries, type LeagueTemplate } from "./resolutionWhitelist";

/** One pick as the client read it off the card: the club's code, its opponent's and the game day when shown. */
export interface PickQuery {
  code: string;
  opp?: string;
  /** the venue's day word: Mon … Sun, Today, Tomorrow */
  day?: string;
}

/** One market the picks are resolved against: an open game market this week, or one settled recently with its result. */
export interface PickMarket {
  ticker: string;
  league: string;
  sideName: string;
  title: string;
  /** kickoff, ISO; null when the pairing did not know it (an open market) or the venue printed none */
  startIso: string | null;
  settled: boolean;
  /** the official result on a settled market; "" while not yet official */
  result?: "yes" | "no" | "";
}

export type PickState = "open" | "won" | "lost" | "unknown";

export interface PickView {
  code: string;
  opp: string | null;
  ticker: string | null;
  sideName: string | null;
  eventTitle: string | null;
  league: string | null;
  startsIso: string | null;
  state: PickState;
  /** the game has started and the result is not official yet */
  live?: true;
  /** why the pick could not be placed on one market, when it could not */
  why?: string;
}

export type PicksState = "open" | "last_pick" | "busted" | "won" | "unknown";

export interface PicksView {
  picks: PickView[];
  /** picks still open */
  open: number;
  /** the one open pick, once every other pick has hit */
  lastPick: PickView | null;
  state: PicksState;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CODE_RE = /^[A-Z]{2,5}$/;

/**
 * The client's picks as one query string: `SEA:CHI:Mon,BAL:JAX:Thu` (code, then the opponent and
 * the day when the card showed them; `SEA,BAL` when it did not). Null when it is not that shape;
 * at most twelve picks, as the venues cap a ticket.
 */
export function parsePickQueries(raw: string | null | undefined): PickQuery[] | null {
  const items = String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!items.length || items.length > 12) return null;
  const out: PickQuery[] = [];
  for (const item of items) {
    const [code, opp, day] = item.split(":").map((s) => s.trim());
    if (!CODE_RE.test(code.toUpperCase())) return null;
    const q: PickQuery = { code: code.toUpperCase() };
    if (opp) {
      if (!CODE_RE.test(opp.toUpperCase())) return null;
      q.opp = opp.toUpperCase();
    }
    if (day) {
      const d = day[0].toUpperCase() + day.slice(1).toLowerCase();
      if (!DAYS.includes(d) && d !== "Today" && d !== "Tomorrow" && d !== "Tonight") return null;
      q.day = d;
    }
    out.push(q);
  }
  return out;
}

/** The two codes name one club in this league (the venue's spelling may differ from Kalshi's: WSH and WAS, JAC and JAX). */
function sameClub(t: LeagueTemplate, a: string, b: string): boolean {
  if (a === b) return true;
  const na = t.teamNames[a];
  return Boolean(na) && na === t.teamNames[b];
}

const templateOf = (ticker: string): LeagueTemplate | null => templateForSeries(ticker.slice(0, ticker.indexOf("-")));

/** The ET calendar date (YYYY-MM-DD) of an instant: the venue prints its days in ET, as Kalshi's tickers carry them. */
export function etDateOf(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
const weekdayOfIsoDate = (dateIso: string): string => DAYS[new Date(`${dateIso}T12:00:00Z`).getUTCDay()];

/**
 * Place every pick on one market and say where it stands. A pick is placed when exactly one market
 * fits its code (and its opponent and day, when the card showed them); two games that fit, or
 * none, leave the pick unknown with the reason, never a guess at the opponent's or next week's game.
 */
export function resolvePicks(queries: readonly PickQuery[], markets: readonly PickMarket[], now: Date = new Date()): PicksView {
  const nowMs = now.getTime();
  const today = etDateOf(nowMs);
  const tomorrow = etDateOf(nowMs + 86_400_000);
  const picks: PickView[] = queries.map((q) => {
    const fits = markets.filter((m) => {
      const t = templateOf(m.ticker);
      const p = t ? parseGameTicker(m.ticker, t) : null;
      if (!t || !p) return false;
      if (!sameClub(t, p.sideCode, q.code)) return false;
      const other = p.sideCode === p.awayCode ? p.homeCode : p.awayCode;
      if (q.opp && !sameClub(t, other, q.opp)) return false;
      if (q.day) {
        const want = q.day === "Today" || q.day === "Tonight" ? weekdayOfIsoDate(today) : q.day === "Tomorrow" ? weekdayOfIsoDate(tomorrow) : q.day;
        if (weekdayOfIsoDate(p.dateIso) !== want) return false;
      }
      return true;
    });
    const base: PickView = { code: q.code, opp: q.opp ?? null, ticker: null, sideName: null, eventTitle: null, league: null, startsIso: null, state: "unknown" };
    if (!fits.length) return { ...base, why: "no listed game fits this pick" };
    if (fits.length > 1) return { ...base, why: `${fits.length} games fit this pick; the card's legs say which` };
    const m = fits[0];
    const view: PickView = { ...base, ticker: m.ticker, sideName: m.sideName, eventTitle: m.title, league: m.league, startsIso: m.startIso };
    if (m.settled) {
      if (m.result === "yes") return { ...view, state: "won" };
      if (m.result === "no") return { ...view, state: "lost" };
      return { ...view, why: "the game is over; the official result is not posted yet" };
    }
    const started = m.startIso ? Date.parse(m.startIso) <= nowMs : false;
    return started ? { ...view, state: "open", live: true } : { ...view, state: "open" };
  });
  const open = picks.filter((p) => p.state === "open");
  const lost = picks.some((p) => p.state === "lost");
  const unknown = picks.some((p) => p.state === "unknown");
  const state: PicksState = lost ? "busted" : unknown ? "unknown" : open.length === 0 ? "won" : open.length === 1 ? "last_pick" : "open";
  return { picks, open: open.length, lastPick: state === "last_pick" ? open[0] : null, state };
}

/**
 * The checks a parlay lock must pass, on the service's own read of the picks at the tap: the
 * ticket is at its last pick, that pick is the market being locked, and the size is at most what
 * the ticket pays (one contract per payout dollar). With in play on (lockWindow.ts) the last
 * pick's game may be under way: the ticket is still one position on that game, and whether the
 * books fund a lock on it now is the quote's question. With it off the pick must not have started.
 */
export function verifyParlayLock(
  view: PicksView,
  ticker: string,
  contracts: number,
  stakeCents: number,
  payoutCents: number,
  opts: { inPlay?: boolean } = {},
): { ok: true } | { ok: false; code: string; message: string } {
  if (view.state === "busted") return { ok: false, code: "parlay_busted", message: "A pick on this parlay missed; there is nothing left to protect." };
  if (view.state === "won") return { ok: false, code: "parlay_settled", message: "Every pick on this parlay has hit; it is settled, not open." };
  if (view.state === "unknown") {
    const why = view.picks.find((p) => p.state === "unknown")?.why ?? "a pick could not be placed on a game";
    return { ok: false, code: "parlay_pick_unknown", message: `A pick on this parlay could not be read: ${why}.` };
  }
  if (view.state === "open") return { ok: false, code: "parlay_not_last_pick", message: `Protection opens at the last pick; ${view.open} picks are still open.` };
  if (!view.lastPick || view.lastPick.ticker !== ticker) return { ok: false, code: "parlay_not_last_pick", message: "The market being locked is not this parlay's last open pick." };
  if (view.lastPick.live && !opts.inPlay) return { ok: false, code: "parlay_in_play", message: "The last pick's game has started." };
  if (!(payoutCents > stakeCents && stakeCents > 0)) return { ok: false, code: "parlay_size", message: "The parlay's stake and payout do not read as a ticket." };
  if (Math.round(contracts * 100) > payoutCents) return { ok: false, code: "parlay_size", message: "The size is more than the parlay pays." };
  return { ok: true };
}

/**
 * The record's view of the picks behind a last-pick lock: what each earlier pick was and that it
 * hit, and the last pick the lock stands on. Holder's words only; no venue ids, no hedge fields.
 */
export interface ParlayRecord {
  picks: Array<{ ticker: string; sideName: string; eventTitle: string; state: "won" | "open" }>;
  stakeCents: number;
  payoutCents: number;
}

export function parlayRecordOf(view: PicksView, stakeCents: number, payoutCents: number): ParlayRecord {
  return {
    picks: view.picks.map((p) => ({ ticker: p.ticker ?? p.code, sideName: p.sideName ?? p.code, eventTitle: p.eventTitle ?? "", state: p.state === "open" ? "open" : "won" })),
    stakeCents,
    payoutCents,
  };
}

/** The leagues whose series the picks are read from: every template the whitelist carries. */
export const PICK_SERIES: ReadonlyArray<{ league: string; series: string }> = LEAGUE_TEMPLATES.map((t) => ({ league: t.league, series: t.kalshiSeries }));
