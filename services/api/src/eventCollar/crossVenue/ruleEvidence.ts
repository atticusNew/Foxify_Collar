/**
 * Settlement evidence: the venue's own rule text, pinned when a position opens
 * and read again when it settles.
 *
 * A result on this record is only as good as the rule it was settled under.
 * "Wins the game originally scheduled for Oct 19" and "wins the game" are
 * different contracts the day a game is postponed; a tie paying $0.50 is a
 * line in the secondary rules, not the headline. So every position carries the
 * sha256 of the rule text the venue published at open, the public URL the text
 * was read from (a click shows the same text), and a short excerpt. At
 * settlement the text is read again and compared, and the record says
 * "unchanged" or "changed", never silently either.
 *
 * Pure. No venue calls; the adapters pass the text in. Nothing here changes a
 * payout: evidence is attached to a result, it does not decide one.
 */

import { createHash } from "node:crypto";

export type RuleVenue = "kalshi" | "polymarket";

export interface RuleEvidence {
  venue: RuleVenue;
  /** the venue's own key: a Kalshi ticker, a Polymarket slug */
  marketId: string;
  /** the public read the text came from; the same request shows the same text */
  sourceUrl: string;
  /** sha256 of the normalized rule text, hex */
  sha256: string;
  /** normalized text length, bytes */
  bytes: number;
  readAtIso: string;
  /** the opening of the normalized text, so the record reads without a fetch */
  excerpt: string;
}

/** The second read, at settlement, against the pin. */
export interface RuleCheck {
  readAtIso: string;
  /** hash of the text as read at settlement; null when the venue returned no text */
  sha256: string | null;
  /** null when nothing could be compared: no pin at open, or no text at settlement */
  unchanged: boolean | null;
}

export const RULE_EXCERPT_CHARS = 200;

/**
 * One text, one hash: line endings, runs of spaces and surrounding whitespace
 * do not count as a change; a word does.
 */
export const normalizeRuleText = (text: string | null | undefined): string =>
  String(text ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

/** sha256 of the normalized text; null for empty text (nothing is never hashed into evidence). */
export const ruleHash = (text: string | null | undefined): string | null => {
  const n = normalizeRuleText(text);
  if (!n) return null;
  return createHash("sha256").update(n, "utf8").digest("hex");
};

/** "9f41c2…b7e0": the hash as a page prints it. */
export const shortHash = (hex: string): string => (hex.length <= 12 ? hex : `${hex.slice(0, 6)}…${hex.slice(-4)}`);

/** Pin the rule as published now. Null when the venue published no text: a missing rule is recorded as missing. */
export function pinRule(input: { venue: RuleVenue; marketId: string; ruleText: string | null | undefined; sourceUrl: string; readAtIso: string }): RuleEvidence | null {
  const n = normalizeRuleText(input.ruleText);
  const sha256 = ruleHash(n);
  if (!sha256) return null;
  return {
    venue: input.venue,
    marketId: input.marketId,
    sourceUrl: input.sourceUrl,
    sha256,
    bytes: Buffer.byteLength(n, "utf8"),
    readAtIso: input.readAtIso,
    excerpt: n.length > RULE_EXCERPT_CHARS ? `${n.slice(0, RULE_EXCERPT_CHARS - 1).trimEnd()}…` : n,
  };
}

/** Read again at settlement and compare to the pin. */
export function checkRule(pinned: RuleEvidence | null | undefined, ruleTextNow: string | null | undefined, readAtIso: string): RuleCheck {
  const sha256 = ruleHash(ruleTextNow);
  return { readAtIso, sha256, unchanged: pinned && sha256 ? pinned.sha256 === sha256 : null };
}

// ── Venue text and URLs ──────────────────────────────────────────────────────

/**
 * Kalshi publishes the rule in two parts: `rules_primary` (the resolving sentence) and
 * `rules_secondary` (ties, postponements, the source of truth). Both decide a result, so both
 * are pinned.
 */
export const kalshiRuleText = (m: { rulesPrimary?: string | null; rulesSecondary?: string | null }): string =>
  [m.rulesPrimary, m.rulesSecondary].map((s) => normalizeRuleText(s)).filter(Boolean).join("\n");

/** The public market read the rule text comes from. */
export const kalshiRuleUrl = (ticker: string, base: string): string => `${base.replace(/\/$/, "")}/markets/${encodeURIComponent(ticker)}`;

/**
 * Polymarket's Gamma market carries the rule as `description` and names the source of truth
 * as `resolutionSource`; both are pinned, the source on its own line.
 */
export const gammaRuleText = (m: { description?: string | null; resolutionSource?: string | null }): string => {
  const d = normalizeRuleText(m.description);
  const src = normalizeRuleText(m.resolutionSource);
  return [d, src ? `Resolution source: ${src}` : ""].filter(Boolean).join("\n");
};

/** Gamma's by-slug read, which answers for open and closed markets alike. */
export const gammaRuleUrl = (slug: string, base: string): string => `${base.replace(/\/$/, "")}/markets/slug/${encodeURIComponent(slug)}`;

// ── The record's one line ────────────────────────────────────────────────────

export interface RuleEvidenceSummary {
  /** positions or legs on the record (settled only when `settledOnly`) */
  total: number;
  /** carried a pinned rule at open */
  pinned: number;
  /** read again at settlement with a hash on both sides */
  compared: number;
  unchanged: number;
  changed: number;
  /** pinned at open, but the venue returned no text when read again */
  unreadable: number;
  /** keys (ticker or slug) whose rule text changed between open and settlement */
  changedIds: string[];
}

/** Fold the pins and checks into the counts the page prints. Pure. */
export function summarizeRuleEvidence(items: ReadonlyArray<{ id: string; rule: RuleEvidence | null | undefined; check: RuleCheck | null | undefined }>): RuleEvidenceSummary {
  const out: RuleEvidenceSummary = { total: items.length, pinned: 0, compared: 0, unchanged: 0, changed: 0, unreadable: 0, changedIds: [] };
  for (const it of items) {
    if (!it.rule) continue;
    out.pinned += 1;
    if (!it.check) continue;
    if (it.check.sha256 == null) {
      out.unreadable += 1;
      continue;
    }
    out.compared += 1;
    if (it.check.unchanged) out.unchanged += 1;
    else {
      out.changed += 1;
      out.changedIds.push(it.id);
    }
  }
  return out;
}

/** The sentence under a settled list. Plain words; no claim a click cannot check. */
export function ruleEvidenceLine(s: RuleEvidenceSummary, noun: "position" | "leg"): string {
  if (s.pinned === 0) return "";
  const plural = (n: number) => (n === 1 ? noun : `${noun}s`);
  const parts = [`Settled against the venue's own rule text: ${s.pinned} of ${s.total} ${plural(s.total)} carry the rule pinned at open (sha256)`];
  if (s.compared > 0) parts.push(`${s.compared} read again at settlement, ${s.unchanged} unchanged${s.changed > 0 ? `, ${s.changed} changed` : ""}`);
  if (s.unreadable > 0) parts.push(`${s.unreadable} could not be read again`);
  return `${parts.join("; ")}.`;
}
