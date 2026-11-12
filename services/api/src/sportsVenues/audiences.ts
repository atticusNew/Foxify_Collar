/**
 * Pages made for one reader outside the company. Each has its own address on the service and its
 * own key, so the key of one page opens nothing else: not the service's own pages, not another
 * reader's page. The service's own key does not open them either.
 *
 * A new reader is a new entry here and a key in the environment. The page itself
 * (prospectHtml.ts) is written for a broker onto Crypto.com's exchange; a reader of another kind
 * needs its own words.
 */

import { timingSafeEqual } from "node:crypto";

export interface Audience {
  id: string;
  /** where the page sits on the service */
  base: string;
  /** the environment variable holding its key */
  keyEnv: string;
  /** who it is for, as the page says it */
  name: string;
}

export const AUDIENCES: readonly Audience[] = [{ id: "prospect", base: "/prospect", keyEnv: "PROSPECT_PAGE_KEY", name: "Prospect Markets" }];

/** a key shorter than this can be guessed: the page stays off */
export const AUDIENCE_KEY_MIN = 16;

export type AudienceState = Audience & ({ key: string; off?: undefined } | { key?: undefined; off: string });

/** The page is on only with a key of its own: set, long enough, and not a key that opens something else on the service. */
export function audienceState(a: Audience, key: string | undefined, otherKeys: readonly string[]): AudienceState {
  const k = (key ?? "").trim();
  if (!k) return { ...a, off: "its key is not set" };
  if (k.length < AUDIENCE_KEY_MIN) return { ...a, off: `its key is shorter than ${AUDIENCE_KEY_MIN} characters` };
  if (otherKeys.includes(k)) return { ...a, off: "its key is the same as another key of this service" };
  return { ...a, key: k };
}

export function keyMatches(given: string | null, key: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The audience a path belongs to, and the path under its base. */
export function audienceOf(states: readonly AudienceState[], pathname: string): { state: AudienceState; sub: string } | null {
  for (const state of states) {
    if (pathname === state.base || pathname.startsWith(`${state.base}/`)) return { state, sub: pathname.slice(state.base.length).replace(/\/$/, "") || "/" };
  }
  return null;
}
