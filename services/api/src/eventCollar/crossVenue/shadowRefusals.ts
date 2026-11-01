/**
 * REFUSALS ON THE RECORD — the other half of the board.
 *
 * The shadow opens a position for every event the engine will quote. The events it priced and
 * declined were, until now, dropped on the floor: the ledger only carries what was offered. A
 * record that shows only offers cannot answer the fair question "how often do you say no, and
 * why?", and that answer is the proof that the incentive is not to protect everything.
 *
 * Every scan hands back the candidates it quoted and refused (ScanState.refused). This module
 * keeps one entry per market: the first and last time it was refused, how many scans refused it,
 * and the engine's latest reason. A market the engine later quotes is no longer a refusal (it is
 * on the book), so the summary excludes anything the ledger holds. Kept as one small JSON file
 * beside the ledger; the public page and /api/shadow read the summary, the raw file stays with
 * the operator.
 *
 * Reasons are folded to a few plain phrases for the public page. The engine's codes stay on the
 * entries; the public words never name a venue.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RefusalEntry {
  ticker: string;
  kind: "sports" | "crypto";
  league: string;
  sideName: string;
  eventTimeIso: string;
  /** the engine's latest reason code */
  code: string;
  firstAt: string;
  lastAt: string;
  /** how many scans refused it */
  times: number;
}

export type RefusalMap = Record<string, RefusalEntry>;

/** What a scan reports for one refused candidate (eventProtectXDemoService.ScanRefusal). */
export interface ScanRefusalLike {
  ticker: string;
  kind: "sports" | "crypto";
  league: string;
  sideName: string;
  eventTimeIso: string;
  code: string;
}

/**
 * The public phrase for a reason code. Four buckets the reader can act on, plus "other":
 * the protection would cost too much, the credit would be pennies, no book could fund the other
 * side, the market was not one we protect (unmatched, too close to start, mark outside the range).
 */
export type RefusalReason = "too rich to offer" | "credit too small to offer" | "no book could fund it" | "not a market we protect" | "other";

export const REFUSAL_REASON_ORDER: readonly RefusalReason[] = ["too rich to offer", "credit too small to offer", "no book could fund it", "not a market we protect", "other"];

export function refusalReason(code: string): RefusalReason {
  if (code === "protection_too_rich") return "too rich to offer";
  if (code === "credit_too_small" || code === "credit_nonpositive") return "credit too small to offer";
  if (/_book_empty$|_book_too_thin$|^far_out_no_book$|^route_gated$|^route_not_offered$|^not_offered$/.test(code)) return "no book could fund it";
  if (/^no_matched_market$|^resolution_mismatch$|^market_too_close_to_start$|^mark_out_of_range$|^mark_disagreement$|^market_not_active$/.test(code)) return "not a market we protect";
  return "other";
}

export function loadRefusals(path: string): RefusalMap {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as RefusalMap) : {};
  } catch {
    return {};
  }
}

/** Write atomically: a crash mid-write never leaves a half file the next load would drop. */
export function saveRefusals(path: string, map: RefusalMap): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(map));
  renameSync(tmp, path);
}

/** Fold one scan's refusals into the map: new markets added, known ones re-stamped with the latest reason. */
export function recordScanRefusals(map: RefusalMap, refused: readonly ScanRefusalLike[], atIso: string): RefusalMap {
  for (const r of refused) {
    const prev = map[r.ticker];
    map[r.ticker] = prev
      ? { ...prev, code: r.code, lastAt: atIso, times: prev.times + 1, sideName: r.sideName, eventTimeIso: r.eventTimeIso }
      : { ticker: r.ticker, kind: r.kind, league: r.league, sideName: r.sideName, eventTimeIso: r.eventTimeIso, code: r.code, firstAt: atIso, lastAt: atIso, times: 1 };
  }
  return map;
}

export interface RefusalSummary {
  /** markets the engine priced and declined, and never later quoted */
  refused: number;
  /** markets the engine quoted (the ledger's positions) */
  offered: number;
  /** refused + offered: every market the engine priced */
  priced: number;
  /** refused as a share of priced, 0..100, null when nothing was priced */
  refusedPct: number | null;
  /** refusals by public reason, most common first, zero buckets dropped */
  byReason: Array<{ reason: RefusalReason; count: number }>;
  /** the same cut by kind */
  byKind: Record<string, { refused: number; offered: number }>;
  /** first refusal kept, null when none */
  since: string | null;
}

/**
 * The record's refusal figures. `offered` is every ticker the ledger holds (opened, closed early
 * or settled: each was a quote the engine made). A refused ticker the ledger also holds was
 * quoted on a later scan and is counted as offered, not refused.
 */
export function summarizeRefusals(map: RefusalMap, offered: ReadonlyArray<{ ticker: string; kind: string }>): RefusalSummary {
  const onBook = new Set(offered.map((p) => p.ticker));
  const byReasonCount = new Map<RefusalReason, number>();
  const byKind: Record<string, { refused: number; offered: number }> = {};
  const kindRow = (k: string): { refused: number; offered: number } => (byKind[k] ??= { refused: 0, offered: 0 });
  let since: string | null = null;
  let refused = 0;
  for (const e of Object.values(map)) {
    if (onBook.has(e.ticker)) continue;
    refused += 1;
    kindRow(e.kind).refused += 1;
    const reason = refusalReason(e.code);
    byReasonCount.set(reason, (byReasonCount.get(reason) ?? 0) + 1);
    if (since === null || e.firstAt < since) since = e.firstAt;
  }
  for (const p of offered) kindRow(p.kind).offered += 1;
  const offeredN = onBook.size;
  const priced = refused + offeredN;
  const byReason = REFUSAL_REASON_ORDER.map((reason) => ({ reason, count: byReasonCount.get(reason) ?? 0 }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
  return { refused, offered: offeredN, priced, refusedPct: priced > 0 ? Math.round((1000 * refused) / priced) / 10 : null, byReason, byKind, since };
}
