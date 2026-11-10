/**
 * THE LOCK WINDOW: when a position on a game can be locked in.
 *
 * Pre-game: from seven days out until 45 minutes before the start. That was the whole rule while
 * every hedge was paper.
 *
 * In play (on unless EVENT_X_IN_PLAY is 0, false, no or off): the window does not close at the
 * cutoff. It runs through the last 45 minutes and through the game itself, for
 * EVENT_X_IN_PLAY_HOURS (default 4) after the start. The market must still be active and its
 * odds in range, which the quote checks, so a decided game closes on its own.
 *
 * What makes a lock during a game safe is not this window but the order behind it. A real-money
 * lock buys its hedge first, a limit at the walked price, all or none (hedgeFirst.ts). A book
 * that moved between the read and the send fills nothing, and the holder is told nothing was
 * locked. The identity (the writer keeps the take either way) never depended on the mark, only on
 * the hedge being bought at or under the walked cost; hedge first makes that a precondition of
 * the lock instead of a hope after it.
 *
 * Pure: no env read at import, no clock but the one passed in.
 */

export const PROTECT_WINDOW_MINUTES = { min: 45, max: 7 * 24 * 60 } as const;
export type ProtectWindowWhy = "in_progress" | "too_close" | "far_out";

/** The pre-game window alone: open from seven days out until 45 minutes before the start. */
export function protectWindow(startIso: string, now: Date): { open: boolean; why?: ProtectWindowWhy; untilIso: string } {
  const startMs = new Date(startIso).getTime();
  const untilIso = new Date(startMs - PROTECT_WINDOW_MINUTES.min * 60_000).toISOString();
  const minutes = (startMs - now.getTime()) / 60_000;
  if (minutes <= 0) return { open: false, why: "in_progress", untilIso };
  if (minutes < PROTECT_WINDOW_MINUTES.min) return { open: false, why: "too_close", untilIso };
  if (minutes > PROTECT_WINDOW_MINUTES.max) return { open: false, why: "far_out", untilIso };
  return { open: true, untilIso };
}

/** In play is on unless the switch says off. */
export const inPlayFromEnv = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|false|no|off)$/i.test((env.EVENT_X_IN_PLAY ?? "").trim());

export const DEFAULT_IN_PLAY_HOURS = 4;
/** How long after the start a game stays lockable: EVENT_X_IN_PLAY_HOURS, default 4; a value that is not a positive number is the default. */
export function inPlayMaxMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const h = Number((env.EVENT_X_IN_PLAY_HOURS ?? "").trim() || DEFAULT_IN_PLAY_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : DEFAULT_IN_PLAY_HOURS) * 3_600_000;
}

export interface LockWindow {
  open: boolean;
  /** the game has started and is inside the in-play bound */
  live: boolean;
  /**
   * Open only because in play is on (inside the last 45 minutes, or under way): the pricers'
   * lead-time gate is set aside for this quote (shadowCounterfactuals.inPlayConfig).
   */
  pastCutoff: boolean;
  /** why not, when not open */
  why?: ProtectWindowWhy;
  /** when the window closes: the in-play bound after the start, or 45 minutes before it with in play off */
  untilIso: string;
}

/** The window a game can be locked in, in play included. */
export function lockWindow(startIso: string, now: Date, inPlay: boolean, inPlayMaxMs: number = DEFAULT_IN_PLAY_HOURS * 3_600_000): LockWindow {
  const w = protectWindow(startIso, now);
  if (!inPlay) return { open: w.open, live: false, pastCutoff: false, ...(w.why ? { why: w.why } : {}), untilIso: w.untilIso };
  const startMs = new Date(startIso).getTime();
  const untilIso = new Date(startMs + inPlayMaxMs).toISOString();
  if (w.open) return { open: true, live: false, pastCutoff: false, untilIso };
  // continuous: the last 45 minutes before the start stay open (not yet live), then the game is
  // quoted live until the bound
  if (w.why === "too_close") return { open: true, live: false, pastCutoff: true, untilIso };
  if (w.why === "in_progress" && now.getTime() - startMs <= inPlayMaxMs) return { open: true, live: true, pastCutoff: true, untilIso };
  return { open: false, live: false, pastCutoff: false, ...(w.why ? { why: w.why } : {}), untilIso };
}
