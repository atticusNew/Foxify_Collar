/**
 * VENUE SLATE — the shadow record cut to one venue's games.
 *
 * A sports venue lists Chiefs to win on Sunday; so do the books the shadow
 * already prices and settles on. The event is the thing protected, the venue's
 * own order book is never an input to the terms (the hedge book is), so a
 * venue's "report" needs nothing from the venue: the leagues it lists, taken
 * from its public page, and the record filtered to them.
 *
 * Slates are configured by the operator (EVENT_SHADOW_SLATES) and the pages
 * are reached by a share key (EVENT_SHADOW_SLATE_KEY) or the operator token,
 * never from the public record: a prospect's name is rendered only on a link
 * the operator chose to send, the same posture as the embed's brand allowlist.
 *
 * Config shape, one slate per semicolon:
 *   wiremarkets=Wire Markets:nfl,nba,mlb,nhl,epl;sporttrade=Sporttrade:nfl,nba
 * The slug is the URL (/slate/<slug>), the name is what the page says, the
 * leagues are matched case-insensitively against the record's league field.
 * An empty league list means every sports league on the record.
 */

import type { ShadowPosition } from "./shadowLedger";

export interface VenueSlate {
  /** URL slug: lower-case letters, digits, dashes */
  slug: string;
  /** the venue's display name */
  name: string;
  /** lower-case league codes; empty = all sports leagues */
  leagues: string[];
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function parseVenueSlates(raw: string | undefined): VenueSlate[] {
  const out: VenueSlate[] = [];
  const seen = new Set<string>();
  for (const part of (raw ?? "").split(";")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const slug = entry.slice(0, eq).trim().toLowerCase();
    if (!SLUG_RE.test(slug) || seen.has(slug)) continue;
    const rest = entry.slice(eq + 1);
    const colon = rest.indexOf(":");
    const name = (colon >= 0 ? rest.slice(0, colon) : rest).trim();
    if (!name) continue;
    const leagues = (colon >= 0 ? rest.slice(colon + 1) : "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    seen.add(slug);
    out.push({ slug, name, leagues: [...new Set(leagues)] });
  }
  return out;
}

export function findVenueSlate(slates: readonly VenueSlate[], slug: string | null | undefined): VenueSlate | null {
  const want = (slug ?? "").trim().toLowerCase();
  if (!want) return null;
  return slates.find((s) => s.slug === want) ?? null;
}

/** Is this league on the slate? Sports only; crypto strikes are never a venue's games. */
export function onSlate(slate: VenueSlate, p: Pick<ShadowPosition, "kind" | "league">): boolean {
  if (p.kind !== "sports") return false;
  if (slate.leagues.length === 0) return true;
  return slate.leagues.includes(p.league.toLowerCase());
}

export function slatePositions(slate: VenueSlate, positions: readonly ShadowPosition[]): ShadowPosition[] {
  return positions.filter((p) => onSlate(slate, p));
}

/** The leagues the record actually has for this slate, most settled first: what the page can show. */
export function slateLeaguesOnRecord(slate: VenueSlate, positions: readonly ShadowPosition[]): string[] {
  const counts = new Map<string, number>();
  for (const p of positions) {
    if (!onSlate(slate, p)) continue;
    const k = p.league.toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + (p.status === "settled" ? 1 : 0));
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
}

/**
 * Share-key check for slate pages. Constant-time compare; an unset key means
 * no slate page can be opened without the operator token (fail closed).
 */
export function slateKeyOk(configured: string | undefined, presented: string | null | undefined): boolean {
  const want = (configured ?? "").trim();
  const got = (presented ?? "").trim();
  if (!want || !got || want.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i += 1) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
