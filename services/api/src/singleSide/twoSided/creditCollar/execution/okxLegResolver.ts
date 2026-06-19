/**
 * OKX collar-leg resolver — picks the put/call instIds to hedge FROM THE ACTIVE ENVIRONMENT'S
 * instrument universe (demo and live list different strikes/expiries). The pure selection function
 * is unit-tested; the async resolver is deps-injected (instrument lister + book reader) so it works
 * against demo or live without code changes and is testable without a live venue.
 *
 * Fixes the `51001 Instrument ID … doesn't exist` failure that happens when legs are discovered from
 * the LIVE public chain but submitted into the DEMO keystore.
 */

import { parseOkxOption } from "../../okxProbe";

export type InstrumentLister = (instType: string, uly: string) => Promise<{ ok: boolean; data: Array<{ instId?: string; state?: string }> }>;
export type BookTopReader = (instId: string) => Promise<{ ok: boolean; data: Array<{ bids?: string[][]; asks?: string[][] }> }>;

export type SelectedCollarLegs = {
  expiryMs: number;
  expiryIso: string;
  putInstId: string;
  callInstId: string;
  putStrike: number;
  callStrike: number;
};

/**
 * Pure: from an instrument universe, pick the expiry nearest the target tenor and, within it, the
 * strikes nearest the put/call targets. Returns null if no usable put+call exist.
 */
export const selectCollarInstruments = (
  instIds: string[],
  opts: { nowMs: number; tenorDays: number; putTarget: number; callTarget: number }
): SelectedCollarLegs | null => {
  const parsed = instIds
    .map((instId) => ({ instId, p: parseOkxOption(instId) }))
    .filter((x): x is { instId: string; p: { strike: number; optType: "put" | "call"; expiryMs: number } } => x.p != null);
  if (parsed.length === 0) return null;

  const targetMs = opts.nowMs + opts.tenorDays * 86_400_000;
  const expiries = [...new Set(parsed.map((x) => x.p.expiryMs))].filter((e) => e > opts.nowMs);
  if (expiries.length === 0) return null;
  const expiryMs = expiries.sort((a, b) => Math.abs(a - targetMs) - Math.abs(b - targetMs))[0];

  const atExp = parsed.filter((x) => x.p.expiryMs === expiryMs);
  const pick = (optType: "put" | "call", target: number) =>
    atExp
      .filter((x) => x.p.optType === optType)
      .sort((a, b) => Math.abs(a.p.strike - target) - Math.abs(b.p.strike - target))[0];

  const put = pick("put", opts.putTarget);
  const call = pick("call", opts.callTarget);
  if (!put || !call) return null;

  return {
    expiryMs,
    expiryIso: new Date(expiryMs).toISOString(),
    putInstId: put.instId,
    callInstId: call.instId,
    putStrike: put.p.strike,
    callStrike: call.p.strike
  };
};

export type ResolvedCollarLegs = SelectedCollarLegs & { putAskBtc: number | null; callBidBtc: number | null };

/** Resolve legs (instIds + top-of-book quotes) from the active environment. Deps-injected. */
export const resolveCollarLegs = async (
  list: InstrumentLister,
  readBook: BookTopReader,
  opts: { nowMs: number; tenorDays: number; putTarget: number; callTarget: number; uly?: string }
): Promise<{ ok: boolean; error?: string; legs?: ResolvedCollarLegs }> => {
  const instr = await list("OPTION", opts.uly ?? "BTC-USD");
  if (!instr.ok) return { ok: false, error: "instruments_fetch_failed" };
  const ids = (instr.data ?? []).map((d) => String(d.instId ?? "")).filter(Boolean);
  const sel = selectCollarInstruments(ids, opts);
  if (!sel) return { ok: false, error: "no_matching_instruments_in_env" };

  const [pb, cb] = await Promise.all([readBook(sel.putInstId), readBook(sel.callInstId)]);
  const putAskBtc = pb.data?.[0]?.asks?.[0]?.[0] != null ? Number(pb.data[0].asks[0][0]) : null;
  const callBidBtc = cb.data?.[0]?.bids?.[0]?.[0] != null ? Number(cb.data[0].bids[0][0]) : null;
  return { ok: true, legs: { ...sel, putAskBtc, callBidBtc } };
};

/** Heuristic: does an OKX order/error message indicate the account hasn't activated options trading? */
export const isOptionsNotActivatedMsg = (msg: string | null | undefined): boolean => {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return m.includes("activate trading") || m.includes("options trading page") || m.includes("activate options");
};
