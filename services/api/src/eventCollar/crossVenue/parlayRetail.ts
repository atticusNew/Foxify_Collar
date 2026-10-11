/**
 * PARLAYS, RETAIL SHAPE — the last-leg shadow's tickets as a bettor's app would list them.
 *
 * The shadow (lastLeg.ts) builds simulated parlay tickets from the public game markets,
 * tracks every pick against the official result, and at the moment every pick but the last
 * has hit it prices a lock on the last pick: a floor, a cap, a credit paid at the tap, hedged
 * leg for leg on the last pick's own book. This module turns those tickets into what the
 * demo's Parlays tab and the public record show. Three states on a row:
 *
 *   two or more picks open    the lock is not offered yet ("unlocks at your last pick"):
 *                             protecting a ticket with two open legs would mean hedging the
 *                             product of two games, and no book quotes that
 *   one pick open             the lock, priced from the live book at the moment: "Lock in
 *                             $floor · $credit paid now", or the honest reason it was refused
 *   settled or busted         what the ticket paid against what the lock would have paid
 *
 * Retail words only: no hedge legs, no take, no token ids. Ticket picks are `picks` (the
 * public word, and `legs` is a hedge word on the retail tripwire). Money is integer cents.
 */

import type { LastLegSummary, LastLegTicket, LockVsSellSummary } from "./lastLeg";
import { compressedContracts, summarizeLegRules } from "./lastLeg";
import { pickWords } from "./pickWords";
import type { RuleEvidenceSummary } from "./ruleEvidence";

/** Why the lock was not offered, in the bettor's words (outcomes, never mechanics: no "hedge" on the phone). Keys are CrossRefusalCode. */
export const PARLAY_REFUSAL_WORDS: Readonly<Record<string, string>> = {
  credit_nonpositive: "the market could not fund a credit on the last pick",
  protection_too_rich: "protection would have cost more than our ceiling",
  credit_too_small: "the credit fell under our minimum",
  pm_book_empty: "no one is offering the other side of the last pick right now",
  pm_book_too_thin: "not enough on offer for the size",
  kalshi_book_empty: "no one is offering the other side right now",
  kalshi_book_too_thin: "not enough on offer for the size",
  market_too_close_to_start: "too close to the start",
  mark_out_of_range: "odds outside the range we protect",
  no_matched_market: "no verified pairing for the last pick",
  resolution_mismatch: "settlement rules did not match",
};

export const refusalWords = (code: string): string => PARLAY_REFUSAL_WORDS[code] ?? code.replace(/_/g, " ");

/** The same refusals at row length: one short clause after "No lock right now:"; the full words sit a tap away. */
export const PARLAY_REFUSAL_SHORT: Readonly<Record<string, string>> = {
  credit_nonpositive: "market could not fund a credit",
  protection_too_rich: "protection too costly",
  credit_too_small: "credit under our minimum",
  pm_book_empty: "other side not on offer",
  pm_book_too_thin: "not enough on offer",
  kalshi_book_empty: "other side not on offer",
  kalshi_book_too_thin: "not enough on offer",
  market_too_close_to_start: "too close to kickoff",
  mark_out_of_range: "odds outside our range",
  no_matched_market: "no verified pairing",
  resolution_mismatch: "settlement rules differ",
};

export const refusalShort = (code: string): string => PARLAY_REFUSAL_SHORT[code] ?? refusalWords(code);

export type ParlayPickState = "hit" | "miss" | "open" | "partial";

export interface ParlayPick {
  /** the side the bettor needs, in a bettor's words: "Cowboys", "Brighton & Hove Albion to win" */
  outcome: string;
  /** the rest of the matchup, to read after the outcome: "vs Buccaneers", "at Padres"; "" when the venue names no opponent */
  versus: string;
  /** the game as the venue titles it */
  game: string;
  league: string;
  startsIso: string;
  state: ParlayPickState;
  /**
   * The venue's rule text the pick settles under: its sha256 as pinned when the ticket was built,
   * the public URL that shows the text, and whether the second read at resolution matched (null
   * while open). Null when the venue published no rule; absent on tickets before 2026-10-11.
   */
  rule?: { sha256: string; sourceUrl: string; unchanged: boolean | null } | null;
}

export type ParlayState = "open" | "last_pick" | "busted" | "settled" | "void";

/** The lock as it was priced at the moment: the two endings with the credit inside, and the credit itself. */
export interface ParlayLock {
  quotedAt: string;
  /** how long before the last game the lock was priced */
  hoursBefore: number;
  /** the ticket's fair value at the moment: what a cash-out at fair would have paid */
  worthCents: number;
  /** if the last pick misses, credit included */
  floorTotalCents: number;
  /** if the last pick hits, credit included */
  capTotalCents: number;
  creditCents: number;
}

export interface ParlayResult {
  hit: boolean | "partial";
  /** the ticket on its own, cents */
  ticketPaidCents: number;
  /** the locked ticket, cents; null when no lock was priced */
  lockPaidCents: number | null;
}

export interface ParlayTicket {
  id: string;
  builtAt: string;
  stakeCents: number;
  size: number;
  /** what the ticket pays if every pick hits, cents, on whole contracts: the same basis as the lock's two endings and the settled lines */
  paysCents: number;
  picks: ParlayPick[];
  picksOpen: number;
  state: ParlayState;
  /** the earliest open pick's start; null when nothing is open */
  nextStartIso: string | null;
  lock: ParlayLock | null;
  /** at the last pick without a lock: the reason in plain words; null before the first attempt */
  lockRefused: string | null;
  /** the same reason at row length; null when lockRefused is */
  lockRefusedShort: string | null;
  result: ParlayResult | null;
  /** when the ticket left play: settled, busted or voided */
  decidedAt: string | null;
}

export interface ParlaySummary {
  tickets: number;
  inPlay: number;
  atLastPick: number;
  locksPriced: number;
  /** reached the last pick, attempted, never a priced lock */
  refusedOnly: number;
  busted: number;
  voided: number;
  /** credits that would have been paid at the tap, across priced locks */
  creditsCents: number;
  /** across settled tickets that had a lock: what each choice paid */
  settled: {
    count: number;
    withLock: number;
    lockPaidCents: number;
    sellPaidCents: number;
    holdPaidCents: number;
    lockBeatSell: number;
    holdBeatBoth: number;
    floorSaves: number;
    capGiveups: number;
    /** our P&L on settled locked tickets equals the take booked; null until one settles */
    identityHolds: boolean | null;
  };
  /** refusals by reason, in the bettor's words */
  refusals: Record<string, number>;
  firstTicketAt: string | null;
}

export interface ParlayPayload {
  summary: ParlaySummary;
  tickets: ParlayTicket[];
  /** the legs' pinned rules and second reads across every ticket on the record */
  rules: RuleEvidenceSummary;
}

const pickState = (value: number | undefined): ParlayPickState =>
  value === undefined ? "open" : value >= 1000 ? "hit" : value <= 0 ? "miss" : "partial";

const stateOf = (t: LastLegTicket): ParlayState => (t.status === "last_leg" ? "last_pick" : t.status);

/** The refusal a bettor is told: the code seen most often on this ticket. */
function mostCommonRefusal(refusals: Record<string, number>): string | null {
  let best: string | null = null;
  let n = 0;
  for (const [code, count] of Object.entries(refusals)) {
    if (count > n) {
      best = code;
      n = count;
    }
  }
  return best;
}

export function retailParlayTicket(t: LastLegTicket): ParlayTicket {
  const picks: ParlayPick[] = t.legs.map((l) => {
    const w = pickWords(l.outcome, l.title);
    return {
      outcome: w.outcome,
      versus: w.versus,
      game: l.title,
      league: l.league,
      startsIso: l.gameStartIso,
      state: pickState(t.legValues[l.conditionId]),
      // only legs built since pins existed carry the key, so older tickets read exactly as before
      ...(l.rule !== undefined ? { rule: l.rule ? { sha256: l.rule.sha256, sourceUrl: l.rule.sourceUrl, unchanged: t.legRuleChecks?.[l.conditionId]?.unchanged ?? null } : null } : {}),
    };
  });
  const open = picks.filter((p) => p.state === "open");
  const nextStartIso = open.length ? open.map((p) => p.startsIso).sort()[0] : null;
  const q = t.quote;
  const lock: ParlayLock | null =
    q && q.ok && q.floorCents !== undefined && q.capCents !== undefined && q.creditCents !== undefined
      ? {
          quotedAt: q.at,
          hoursBefore: Math.round((q.minutesToStart / 60) * 10) / 10,
          worthCents: q.ticketValueCents,
          floorTotalCents: q.floorCents * q.contracts + q.creditCents,
          capTotalCents: q.capCents * q.contracts + q.creditCents,
          creditCents: q.creditCents,
        }
      : null;
  const state = stateOf(t);
  const o = t.outcome;
  const result: ParlayResult | null =
    state === "settled" && o
      ? { hit: o.result === "yes" ? true : o.result === "no" ? false : "partial", ticketPaidCents: o.nakedCents, lockPaidCents: o.protectedCents }
      : state === "busted"
        ? { hit: false, ticketPaidCents: 0, lockPaidCents: null }
        : null;
  const refusedCode = lock === null && state === "last_pick" && t.attempts > 0 ? mostCommonRefusal(t.refusals) : null;
  return {
    id: t.ticketId,
    builtAt: t.at,
    stakeCents: t.stakeCents,
    size: t.size,
    paysCents: compressedContracts(t.sharesMilli, 1000) * 100,
    picks,
    picksOpen: open.length,
    state,
    nextStartIso,
    lock,
    lockRefused: refusedCode === null ? null : refusalWords(refusedCode),
    lockRefusedShort: refusedCode === null ? null : refusalShort(refusedCode),
    result,
    decidedAt: t.settledAt ?? t.bustedAt ?? (state === "void" ? (t.lastAttemptAt ?? null) : null),
  };
}

const IN_PLAY_RANK: Record<ParlayState, number> = { last_pick: 0, open: 1, settled: 2, busted: 2, void: 3 };

/**
 * The list a bettor would scroll: tickets at the last pick first (a priced lock before a
 * refused one), then open tickets by their next game, then the decided ones most recent
 * first, capped so the tab stays a positions list and not an archive.
 */
export function retailParlays(tickets: readonly LastLegTicket[], lastLeg: LastLegSummary, lockVsSell: LockVsSellSummary, decidedLimit = 12): ParlayPayload {
  const rows = tickets.map(retailParlayTicket);
  const rules = summarizeLegRules(tickets);
  const inPlay = rows
    .filter((r) => r.state === "open" || r.state === "last_pick")
    .sort((a, b) => {
      if (IN_PLAY_RANK[a.state] !== IN_PLAY_RANK[b.state]) return IN_PLAY_RANK[a.state] - IN_PLAY_RANK[b.state];
      if ((a.lock === null) !== (b.lock === null)) return a.lock === null ? 1 : -1;
      return (a.nextStartIso ?? "").localeCompare(b.nextStartIso ?? "") || a.id.localeCompare(b.id);
    });
  const decided = rows
    .filter((r) => r.state === "settled" || r.state === "busted" || r.state === "void")
    .sort((a, b) => (b.decidedAt ?? b.builtAt).localeCompare(a.decidedAt ?? a.builtAt))
    .slice(0, Math.max(0, decidedLimit));
  const refusals: Record<string, number> = {};
  for (const [code, n] of Object.entries(lastLeg.refusalCodes)) {
    const words = refusalWords(code);
    refusals[words] = (refusals[words] ?? 0) + n;
  }
  const st = lastLeg.settled;
  return {
    summary: {
      tickets: lastLeg.tickets,
      inPlay: inPlay.length,
      atLastPick: rows.filter((r) => r.state === "last_pick").length,
      locksPriced: lastLeg.quoted,
      refusedOnly: lastLeg.refusedOnly,
      busted: lastLeg.busted,
      voided: lastLeg.voided,
      creditsCents: lastLeg.creditsCents,
      settled: {
        count: st.count,
        withLock: st.withProtection,
        lockPaidCents: lockVsSell.settledLockCents,
        sellPaidCents: lockVsSell.settledSellCents,
        holdPaidCents: lockVsSell.settledHoldCents,
        lockBeatSell: lockVsSell.lockBeatSell,
        holdBeatBoth: lockVsSell.holdBeatBoth,
        floorSaves: st.floorSaves,
        capGiveups: st.capGiveups,
        identityHolds: st.withProtection > 0 ? st.identityHolds : null,
      },
      refusals,
      firstTicketAt: lastLeg.firstTicketAt,
    },
    tickets: [...inPlay, ...decided],
    rules,
  };
}
