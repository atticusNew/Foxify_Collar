/**
 * REAL-ONLY HOLDERS: the people whose lock must have a real hedge behind it, or not exist.
 *
 * The lock path has two endings that both answer "locked" (hedgeFirst.lockMode): where the order
 * would truly leave, the hedge is bought first and the lock is written behind the fill; anywhere
 * else (the strategy is not live, the kill switch is on, sending is off, the hedge venue has no
 * key, the game is not armed) the record is written and the hedge is filled on paper. The second
 * is right for the operator's own demonstration and wrong for anyone else: they would read
 * "locked" with nothing bought.
 *
 * EVENT_SHADOW_REAL_ONLY_HOLDERS names the holders for whom the second ending is a refusal:
 *
 *   ann,bob     those holder aliases (the names in EVENT_SHADOW_HOLDER_KEYS)
 *   *           every caller: each holder, the shared key, and the operator acting by hand
 *   unset       nobody; every lock behaves as it did before this setting existed
 *
 * For a holder named here:
 *   - a quote on a position whose hedge would not truly be sent says so, instead of offering a lock
 *   - a tap there is refused in plain words and nothing is written (one line on the pending trail)
 *   - leaving early from a lock that holds a real hedge is refused unless the sale will truly be
 *     sent, and nothing is closed on the record when the venue sold nothing
 *
 * An entry that is not an alias and not `*` is not guessed at: the setting is read as `*`, the
 * safe side, and the note says which entry. An alias with no key is kept (the operator can act
 * for a holder by name) and noted. Adding an outside user is therefore two settings and no code:
 * their key in EVENT_SHADOW_HOLDER_KEYS, their alias here.
 *
 * A member's own sale (memberSale.ts) is outside this: it is written from the venue's fills and
 * from nothing else, so it is real by construction.
 */

import { EXPOSURE_VENUE_NAMES } from "./exposureCaps";
import type { HedgeVenue } from "./hedgeExecutor";
import type { LockMode } from "./hedgeFirst";
import { HOLDER_ALIAS_RE } from "./lockGate";

export const REAL_ONLY_ENV = "EVENT_SHADOW_REAL_ONLY_HOLDERS";

export interface RealOnlyHolders {
  /** `*`, or an entry that could not be read: every caller */
  all: boolean;
  /** the aliases named, lower case, in the order given, each once */
  holders: string[];
  notes: string[];
}

export function realOnlyHoldersFromEnv(env: NodeJS.ProcessEnv = process.env, knownHolders: readonly string[] = []): RealOnlyHolders {
  const holders: string[] = [];
  const notes: string[] = [];
  let all = false;
  for (const raw of (env[REAL_ONLY_ENV] ?? "").split(/[,\s]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") {
      all = true;
      continue;
    }
    if (!HOLDER_ALIAS_RE.test(entry)) {
      all = true;
      notes.push(`${REAL_ONLY_ENV}: "${entry.slice(0, 24)}" is neither a holder alias (2-24 of a-z 0-9 _ -) nor *; read as *, so every caller is real-only until it is corrected`);
      continue;
    }
    if (holders.includes(entry)) continue;
    holders.push(entry);
    if (!knownHolders.includes(entry)) notes.push(`${REAL_ONLY_ENV}: ${entry} has no key in EVENT_SHADOW_HOLDER_KEYS; kept, and it applies when the operator acts for ${entry}`);
  }
  return { all, holders, notes };
}

/** Is this caller real-only? `holder` is the alias the lock is made for; null is the shared key, or the operator acting for nobody. */
export function isRealOnly(cfg: RealOnlyHolders, holder: string | null): boolean {
  return cfg.all || (holder !== null && cfg.holders.includes(holder));
}

/** The holders with a key who are not real-only: for each, a tap can still write a lock with nothing bought. */
export function notRealOnly(cfg: RealOnlyHolders, knownHolders: readonly string[]): string[] {
  return cfg.all ? [] : knownHolders.filter((h) => !cfg.holders.includes(h));
}

export type NotRealWhy = Extract<LockMode, { real: false }>["why"] | "no_intent";

/** Why the order would not truly leave, for the operator. A holder is never shown this. */
export function notRealReason(why: NotRealWhy, venue?: HedgeVenue): string {
  switch (why) {
    case "not_live":
      return "the hedge strategy is not live (EVENT_HEDGE_STRATEGY), so no hedge is bought before the lock is written";
    case "kill_switch":
      return "the kill switch is on (EVENT_HEDGE_KILL_SWITCH)";
    case "dry_run":
      return "sending is off (EVENT_HEDGE_LIVE_SEND is not yes)";
    case "no_client":
      return `there is no key to send with on ${venue ? EXPOSURE_VENUE_NAMES[venue] : "the hedge venue"}`;
    case "not_armed":
      return "this game is not armed (EVENT_HEDGE_LIVE_TICKERS)";
    case "no_intent":
      return "the hedge order could not be built from the books read";
  }
}

/** What a real-only holder is told when the hedge would not truly be bought. No venue, no setting: those are the operator's. */
export const LOCK_NOT_OPEN = { code: "lock_not_open", message: "Lock in is not open on this position right now. Nothing was locked." } as const;
/** What a real-only holder is told when the hedge behind their lock could not truly be sold. */
export const LEAVE_NOT_OPEN = { code: "leave_not_open", message: "Leaving early is not open on this position right now. Your lock stands as it is." } as const;
/** What a real-only holder is told when the sale went out and sold nothing. */
export const LEAVE_NOT_SOLD = { code: "leave_not_sold", message: "The price moved before the other side sold. Nothing was closed; your lock stands. Try again." } as const;
