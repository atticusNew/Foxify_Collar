/**
 * MARK-GAP GUARD — no cross-venue route priced off a mark the hedge venue does not believe.
 *
 * The collar is set around the protected market's own mark (the mid of its Yes bid and ask) and
 * the hedge is bought on the second venue. Days before a game the market's own book is often a
 * stub: a 1¢ bid and a 99¢ ask, or a 45/55 straddle nobody has traded, while the second venue
 * already prices the same side at 77¢. Priced off the stub's 50¢ mid, the collar's floor and cap
 * sit far from the game's real odds and the credit written against the cap slice is $9 to $17 of
 * pure overpayment: the EV figure looks fine because it is measured against the same wrong mark.
 * The far-out guard does not catch it when the feed supplied the second venue's book, because a
 * book was supplied; the problem is the mark, not the book.
 *
 * The rule, two tests, either refuses: a sports quote routed to the second venue is refused when
 * the market's own Yes spread is wider than `spreadCents` (the mid of a stub is not a mark), or
 * when the mark differs from the price the second venue's best No ask implies for the same side
 * (100 − ask) by more than `gapCents`. Refused is a refusal with its own code: the board does not
 * carry the row, the scan does not open it, and the next scan prices it again; the row opens the
 * moment the market's own book tightens around a price the hedge venue agrees with.
 *
 * Pure: takes what the quote already knows, returns a verdict.
 */

import type { HedgeRoute, PmBook } from "./types";

export interface MarkGapGuardRule {
  /** refuse when |mark − implied| exceeds this many cents; 0 turns the gap test off */
  gapCents: number;
  /** refuse when the market's own Yes ask − Yes bid exceeds this many cents; 0 turns the spread test off */
  spreadCents: number;
}

export const DEFAULT_MARK_GAP_GUARD: MarkGapGuardRule = { gapCents: 8, spreadCents: 20 };

function centsFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
}

export function markGapGuardFromEnv(env: NodeJS.ProcessEnv): MarkGapGuardRule {
  return {
    gapCents: centsFromEnv(env.EVENT_X_MARK_GAP_CENTS, DEFAULT_MARK_GAP_GUARD.gapCents),
    spreadCents: centsFromEnv(env.EVENT_X_MARK_SPREAD_CENTS, DEFAULT_MARK_GAP_GUARD.spreadCents),
  };
}

export interface MarkGapGuardInputs {
  kind: "sports" | "crypto";
  /** the route the quote chose; null when every route refused */
  route: HedgeRoute | null;
  /** the mark the collar was set around (the market's own Yes mid), in cents */
  markCents: number;
  /** the market's own Yes bid and ask, in cents */
  yesBidCents: number;
  yesAskCents: number;
  /** the second venue's No book the hedge was priced from (best ask first); absent when the venue was unreachable */
  pmNoBook: PmBook | undefined;
}

export type MarkGapVerdict =
  | { refuse: false }
  | {
      refuse: true;
      code: "mark_disagreement";
      detail: string;
      /** the market's own Yes ask − Yes bid */
      spreadCents: number;
      /** the Yes price the second venue's best No ask implies (100 − ask); null when it had no ask */
      impliedCents: number | null;
      /** |mark − implied|; null when no ask */
      gapCents: number | null;
    };

/** the Yes price the second venue's best No ask implies, in whole cents; null when the book has no ask */
export function impliedYesCents(pmNoBook: PmBook | undefined): number | null {
  const best = pmNoBook?.asks[0];
  if (!best || !Number.isFinite(best.priceMilli)) return null;
  return Math.round((1000 - best.priceMilli) / 10);
}

export function markGapVerdict(inputs: MarkGapGuardInputs, rule: MarkGapGuardRule = DEFAULT_MARK_GAP_GUARD): MarkGapVerdict {
  if (inputs.kind !== "sports" || inputs.route !== "polymarket") return { refuse: false };
  if (rule.gapCents <= 0 && rule.spreadCents <= 0) return { refuse: false };
  const spreadCents = Number.isFinite(inputs.yesAskCents) && Number.isFinite(inputs.yesBidCents) ? inputs.yesAskCents - inputs.yesBidCents : 0;
  const impliedCents = impliedYesCents(inputs.pmNoBook);
  const gapCents = impliedCents === null ? null : Math.abs(inputs.markCents - impliedCents);

  const tooWide = rule.spreadCents > 0 && spreadCents > rule.spreadCents;
  const tooFar = rule.gapCents > 0 && gapCents !== null && gapCents > rule.gapCents;
  if (!tooWide && !tooFar) return { refuse: false };

  const parts: string[] = [];
  if (tooWide) parts.push(`the market's own side is ${inputs.yesBidCents}/${inputs.yesAskCents} (${spreadCents}¢ wide; the limit is ${rule.spreadCents}¢), so its ${inputs.markCents}¢ mid is a placeholder, not a price`);
  if (tooFar) parts.push(`the market marks ${inputs.markCents}¢ and the hedge venue implies ${impliedCents}¢ for the same side (${gapCents}¢ apart; the limit is ${rule.gapCents}¢)`);
  return {
    refuse: true,
    code: "mark_disagreement",
    spreadCents,
    impliedCents,
    gapCents,
    detail: `${parts.join("; ")}; a collar set around that mark would overpay, so it is priced again next scan`,
  };
}
