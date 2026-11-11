/**
 * THE USER TERMS: which version is in force, and who has accepted it, on the record.
 *
 * Before anyone other than the operator holds a lock, they accept the user terms, and the
 * acceptance is a line in an append-only file: who, which version, when, and how. The terms
 * themselves are a document the company publishes (counsel writes it; this code does not). Two
 * settings put a version in force:
 *
 *   EVENT_SHADOW_TERMS_VERSION   the version's label, as printed on the document (2026-11-20, v1)
 *   EVENT_SHADOW_TERMS_URL       where that version can be read (https)
 *
 *   both set     that version is in force: a holder with no acceptance of it on the record is
 *                refused at the quote and at the tap, in plain words, with the link
 *   neither set  no terms are in force; every lock behaves as it did before these settings
 *   one set, or one unreadable   not guessed at: the terms count as in force and no holder can
 *                accept (there is nothing sound to accept), so every holder is refused until it
 *                is corrected. The note says which setting.
 *
 * WHO MUST ACCEPT. Every caller with a name: a holder with their own key, a member on the hosted
 * page, and the operator acting for a holder by name. The shared key and the operator acting for
 * nobody are the operator's own demonstration and are not asked.
 *
 * HOW AN ACCEPTANCE IS MADE. The holder's own tap (their key, or the hosted page's session):
 * POST /api/shadow/terms/accept {version}. The version sent has to be the one in force, so a
 * holder cannot accept a version they were not shown. Or the operator, for a holder who accepted
 * another way (a signed copy): the same route with the operator's token, the holder's alias and
 * `how`, the sentence that says what was received. That line is marked `by: "operator"`.
 *
 * WHAT IS NEVER BLOCKED. Reading one's own record and receipts, and leaving a lock early: a
 * holder who has not accepted a newer version can always see and close what they hold.
 *
 * A new version means a new acceptance: lines for an older version stay on the file and stop
 * counting. Nothing is ever edited or removed.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const TERMS_VERSION_ENV = "EVENT_SHADOW_TERMS_VERSION";
export const TERMS_URL_ENV = "EVENT_SHADOW_TERMS_URL";

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export interface TermsInForce {
  /** a version is required of every named holder (also when it cannot be read: nobody can accept, everyone named is refused) */
  required: boolean;
  /** the version and where to read it; null when none is in force, or when the settings could not be read */
  terms: { version: string; url: string } | null;
  notes: string[];
}

export function termsInForceFromEnv(env: NodeJS.ProcessEnv = process.env): TermsInForce {
  const version = (env[TERMS_VERSION_ENV] ?? "").trim();
  const rawUrl = (env[TERMS_URL_ENV] ?? "").trim();
  if (!version && !rawUrl) return { required: false, terms: null, notes: [] };
  const notes: string[] = [];
  if (!version) notes.push(`${TERMS_URL_ENV} is set and ${TERMS_VERSION_ENV} is not; no holder can accept until both are set`);
  else if (!VERSION_RE.test(version)) notes.push(`${TERMS_VERSION_ENV} has to be 1 to 40 of letters, digits, dot, dash and underscore; no holder can accept until it is corrected`);
  let url: string | null = null;
  if (!rawUrl) notes.push(`${TERMS_VERSION_ENV} is set and ${TERMS_URL_ENV} is not; no holder can accept until both are set`);
  else {
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== "https:" || u.username || u.password) throw new Error("not https");
      url = u.toString();
    } catch {
      notes.push(`${TERMS_URL_ENV} has to be an https address with no login in it; no holder can accept until it is corrected`);
    }
  }
  if (notes.length > 0 || url === null) return { required: true, terms: null, notes };
  return { required: true, terms: { version, url }, notes };
}

export interface TermsAcceptance {
  type: "terms_accepted";
  at: string;
  holder: string;
  version: string;
  url: string;
  /** who made the line: the holder's own tap, or the operator recording an acceptance received another way */
  by: "holder" | "operator";
  /** the operator's sentence saying what was received (a signed copy, an email); required of `by: "operator"` */
  how?: string;
  /** the browser the tap came from, as it named itself, cut short; the holder's own taps only */
  userAgent?: string;
}

export function appendTermsAcceptance(path: string, record: TermsAcceptance): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

export function loadTermsAcceptances(path: string): TermsAcceptance[] {
  if (!existsSync(path)) return [];
  const out: TermsAcceptance[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as TermsAcceptance;
      if (r && r.type === "terms_accepted" && typeof r.holder === "string" && typeof r.version === "string" && typeof r.at === "string" && (r.by === "holder" || r.by === "operator")) out.push(r);
    } catch {
      // a torn line is skipped, never repaired; a holder whose only line is torn is asked again
    }
  }
  return out;
}

/** This holder's first acceptance of this version, or null. Older versions do not count. */
export function acceptanceOf(records: readonly TermsAcceptance[], holder: string, version: string): TermsAcceptance | null {
  return records.find((r) => r.holder === holder && r.version === version) ?? null;
}

export type TermsStanding =
  /** no terms are in force, or this caller is not asked (the shared key, the operator acting for nobody) */
  | { asked: false }
  | { asked: true; accepted: true; version: string; url: string; at: string; by: "holder" | "operator" }
  /** `terms` is null when the settings could not be read: there is nothing sound to accept */
  | { asked: true; accepted: false; terms: { version: string; url: string } | null };

/** Where this caller stands. `holder` is the alias the lock is made for; null is the shared key, or the operator acting for nobody. */
export function termsStanding(inForce: TermsInForce, records: readonly TermsAcceptance[], holder: string | null): TermsStanding {
  if (!inForce.required || holder === null) return { asked: false };
  if (!inForce.terms) return { asked: true, accepted: false, terms: null };
  const a = acceptanceOf(records, holder, inForce.terms.version);
  return a ? { asked: true, accepted: true, version: a.version, url: a.url, at: a.at, by: a.by } : { asked: true, accepted: false, terms: inForce.terms };
}

/** What a holder is told when they have not accepted: one code, one sentence, and the link when there is one. */
export const TERMS_NOT_ACCEPTED = { error: "terms_not_accepted", code: "terms_not_accepted" } as const;
export const termsRefusalMessage = (terms: { version: string; url: string } | null): string =>
  terms ? "Read and accept the terms to lock in." : "Lock in is not open right now: the terms are being updated.";

export type AcceptRequest = { ok: true; version: string; how: string | null } | { ok: false; error: string };

/** The body of an acceptance: the version shown (it has to be the one in force), and the operator's `how`. */
export function parseAcceptRequest(body: unknown, inForce: TermsInForce, by: "holder" | "operator"): AcceptRequest {
  if (!inForce.required) return { ok: false, error: "no terms are in force on this service" };
  if (!inForce.terms) return { ok: false, error: "the terms on this service cannot be accepted right now" };
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const version = typeof b.version === "string" ? b.version.trim() : "";
  if (version !== inForce.terms.version) return { ok: false, error: `version has to be the one in force, ${inForce.terms.version}` };
  const how = typeof b.how === "string" ? b.how.trim().replace(/\s+/g, " ").slice(0, 300) : "";
  if (by === "operator" && how.length < 8) return { ok: false, error: "how is required: one sentence saying what was received from the holder and when (a signed copy by email on a date)" };
  return { ok: true, version, how: by === "operator" ? how : null };
}

/** For the pilot check: of the holders with a key in force, who has accepted the version in force and who has not. */
export function termsOnRecordFor(inForce: TermsInForce, records: readonly TermsAcceptance[], holders: readonly string[]): { version: string | null; holders: number; missing: string[]; notes: string[] } | null {
  if (!inForce.required) return null;
  const version = inForce.terms?.version ?? null;
  const missing = holders.filter((h) => version === null || !acceptanceOf(records, h, version));
  return { version, holders: holders.length - missing.length, missing, notes: inForce.notes };
}
