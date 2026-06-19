/**
 * Deribit collar-leg resolver — picks the put/call instruments to hedge from Deribit's option
 * universe (names like BTC-21JUN26-61000-C). Pure selection is unit-tested; the async resolver is
 * deps-injected (instrument lister + book reader) so it works against testnet or live and is
 * testable without a venue.
 */

const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/** Parse a Deribit BTC option name: BTC-DDMMMYY-STRIKE-C/P (e.g. BTC-21JUN26-61000-C). */
export const parseDeribitOptionName = (name: string): { strike: number; optType: "put" | "call"; expiryMs: number } | null => {
  const m = name.match(/^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-([CP])$/);
  if (!m) return null;
  const mo = MONTHS[m[2]];
  if (mo == null) return null;
  const expiryMs = Date.UTC(2000 + Number(m[3]), mo, Number(m[1]), 8, 0, 0); // Deribit options expire 08:00 UTC
  if (!Number.isFinite(expiryMs)) return null;
  return { strike: Number(m[4]), optType: m[5] === "C" ? "call" : "put", expiryMs };
};

export type SelectedDeribitLegs = {
  expiryMs: number;
  expiryIso: string;
  putInstrument: string;
  callInstrument: string;
  putStrike: number;
  callStrike: number;
};

/** Pure: nearest expiry to tenor + nearest strikes to targets. */
export const selectDeribitCollar = (
  names: string[],
  opts: { nowMs: number; tenorDays: number; putTarget: number; callTarget: number }
): SelectedDeribitLegs | null => {
  const parsed = names
    .map((name) => ({ name, p: parseDeribitOptionName(name) }))
    .filter((x): x is { name: string; p: { strike: number; optType: "put" | "call"; expiryMs: number } } => x.p != null);
  if (parsed.length === 0) return null;

  const targetMs = opts.nowMs + opts.tenorDays * 86_400_000;
  const expiries = [...new Set(parsed.map((x) => x.p.expiryMs))].filter((e) => e > opts.nowMs);
  if (expiries.length === 0) return null;
  const expiryMs = expiries.sort((a, b) => Math.abs(a - targetMs) - Math.abs(b - targetMs))[0];

  const atExp = parsed.filter((x) => x.p.expiryMs === expiryMs);
  const pick = (optType: "put" | "call", target: number) =>
    atExp.filter((x) => x.p.optType === optType).sort((a, b) => Math.abs(a.p.strike - target) - Math.abs(b.p.strike - target))[0];

  const put = pick("put", opts.putTarget);
  const call = pick("call", opts.callTarget);
  if (!put || !call) return null;

  return {
    expiryMs,
    expiryIso: new Date(expiryMs).toISOString(),
    putInstrument: put.name,
    callInstrument: call.name,
    putStrike: put.p.strike,
    callStrike: call.p.strike
  };
};

export type InstrumentLister = (currency: string, kind: string) => Promise<{ ok: boolean; result: Array<{ instrument_name?: string; is_active?: boolean }> | null }>;
export type BookReader = (instrumentName: string) => Promise<{ ok: boolean; result: { best_bid_price?: number; best_ask_price?: number } | null }>;

export type ResolvedDeribitLegs = SelectedDeribitLegs & { putAskBtc: number | null; callBidBtc: number | null };

export const resolveDeribitCollarLegs = async (
  list: InstrumentLister,
  readBook: BookReader,
  opts: { nowMs: number; tenorDays: number; putTarget: number; callTarget: number }
): Promise<{ ok: boolean; error?: string; legs?: ResolvedDeribitLegs }> => {
  const instr = await list("BTC", "option");
  if (!instr.ok) return { ok: false, error: "instruments_fetch_failed" };
  const names = (instr.result ?? []).filter((d) => d.is_active !== false).map((d) => String(d.instrument_name ?? "")).filter(Boolean);
  const sel = selectDeribitCollar(names, opts);
  if (!sel) return { ok: false, error: "no_matching_instruments" };

  const [pb, cb] = await Promise.all([readBook(sel.putInstrument), readBook(sel.callInstrument)]);
  const putAskBtc = pb.result?.best_ask_price != null ? Number(pb.result.best_ask_price) : null;
  const callBidBtc = cb.result?.best_bid_price != null ? Number(cb.result.best_bid_price) : null;
  return { ok: true, legs: { ...sel, putAskBtc, callBidBtc } };
};
