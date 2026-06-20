/**
 * Partner-feed factory — builds a read-only PartnerPositionFeed from configuration so the live
 * coordination loop is connectable WITHOUT code changes. Foxify (or a thin adapter in front of their
 * partner exchange) exposes a read-only endpoint returning the CANONICAL position shape; setting
 * PARTNER_FEED_URL connects it. No URL ⟹ no feed ⟹ the coordinator stays dormant (safe default).
 *
 * CANONICAL CONTRACT (what the endpoint must return) — an array, or { positions: [...] }, of:
 *   { ref: string, isOpen: boolean, sizeUsd: number, markPriceUsd: number|null, tsMs?: number }
 * `ref` must equal our position ref (the venue clOrdId/label must be mapped to it). tsMs defaults to
 * fetch time if omitted. Anything malformed is dropped — reconciliation then fails-closed (missing ⟹
 * assume still open), so a bad feed never cancels collars or pays protection.
 */

import { RestPartnerFeed, type PartnerPositionFeed, type PartnerPositionRecord } from "./partnerReconciliation";

const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Pure canonical parser: venue payload → PartnerPositionRecord[]. Drops malformed rows. */
export const parseCanonicalPartnerRecords = (raw: unknown, nowMs: number): PartnerPositionRecord[] => {
  const rows: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { positions?: unknown[] }).positions)
      ? ((raw as { positions: unknown[] }).positions)
      : [];
  const out: PartnerPositionRecord[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.ref !== "string" || !r.ref) continue;
    if (typeof r.isOpen !== "boolean") continue;
    const sizeUsd = asNum(r.sizeUsd);
    if (sizeUsd == null) continue;
    const tsMs = asNum(r.tsMs);
    out.push({
      ref: r.ref,
      isOpen: r.isOpen,
      sizeUsd,
      markPriceUsd: asNum(r.markPriceUsd),
      tsMs: tsMs ?? nowMs
    });
  }
  return out;
};

export type PartnerFeedEnv = {
  PARTNER_FEED_URL?: string;
  /** Optional bearer token sent as Authorization on each request. */
  PARTNER_FEED_TOKEN?: string;
  PARTNER_FEED_TIMEOUT_MS?: string;
};

/** Build a RestPartnerFeed from env, or null when PARTNER_FEED_URL is unset (coordinator stays off). */
export const buildPartnerFeedFromEnv = (env: PartnerFeedEnv = process.env): PartnerPositionFeed | null => {
  const base = env.PARTNER_FEED_URL;
  if (!base || !base.trim()) return null;
  const timeoutMs = Number(env.PARTNER_FEED_TIMEOUT_MS ?? "6000");
  const token = env.PARTNER_FEED_TOKEN;
  const urlFor = (refs: string[]) => `${base}${base.includes("?") ? "&" : "?"}refs=${encodeURIComponent(refs.join(","))}`;
  const fetcher = async (url: string): Promise<unknown> => {
    const res = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(Number.isFinite(timeoutMs) ? timeoutMs : 6000)
    });
    return res.json();
  };
  return new RestPartnerFeed(urlFor, parseCanonicalPartnerRecords, fetcher);
};
