/**
 * Bitnomial HUPO (hashrate option) selection — scaffolding for the LIVE hashprice FLOOR (a put on the
 * HUP hashrate future). Given the live HUPO option books (from probeBitnomialBooks(["HUPO"])), pick
 * the put nearest the miner's target hashprice strike + target expiry, and return its live top-of-book.
 *
 * ⚠ SYMBOLOGY: the exact HUPO symbol format must be CONFIRMED from a live capture
 * (`npm run miner-protect:bitnomial` during 8:30–2:30 CT). `parseHupoSymbol` below is a best-effort
 * parser for two plausible formats; the selector accepts an injected `parser` so the confirmed format
 * drops into ONE place with no other changes. Selection logic itself is format-agnostic + tested.
 */

import type { BitnomialBook } from "./bitnomialPricefeed";

/** CME-style futures month codes (as in HUP futures like "HUPZ26" → Z = December). */
export const MONTH_CODE: Record<string, number> = { F: 0, G: 1, H: 2, J: 3, K: 4, M: 5, N: 6, Q: 7, U: 8, V: 9, X: 10, Z: 11 };

export type ParsedHupoSymbol = { optType: "put" | "call"; strike: number; expiryMs: number };

/**
 * Best-effort HUPO symbol parser (VERIFY against live symbols). Handles:
 *   - "HUPZ26-100-P"  (base + monthcode + yy + "-" strike "-" C/P)
 *   - "HUPZ26P100"    (base + monthcode + yy + C/P + strike)
 * Expiry is approximated to mid-late in the contract month (refine to the real termination date once
 * confirmed). Returns null when the symbol doesn't match (so unknown formats are skipped, not guessed).
 */
export const parseHupoSymbol = (symbol: string): ParsedHupoSymbol | null => {
  const s = String(symbol).toUpperCase();
  let code: string, yy: number, strike: number, cp: string;
  let mm = s.match(/^HUPO?([FGHJKMNQUVXZ])(\d{2})-(\d+(?:\.\d+)?)-([CP])$/);
  if (mm) { code = mm[1]; yy = Number(mm[2]); strike = Number(mm[3]); cp = mm[4]; }
  else {
    mm = s.match(/^HUPO?([FGHJKMNQUVXZ])(\d{2})([CP])(\d+(?:\.\d+)?)$/);
    if (!mm) return null;
    code = mm[1]; yy = Number(mm[2]); cp = mm[3]; strike = Number(mm[4]);
  }
  const month = MONTH_CODE[code];
  if (month == null || !Number.isFinite(yy) || !(strike > 0)) return null;
  // Approx expiry: ~last week of the contract month (real termination ≈ 2 trading days before last Fri).
  const expiryMs = Date.UTC(2000 + yy, month, 25, 14, 30, 0);
  return { optType: cp === "P" ? "put" : "call", strike, expiryMs };
};

export type HashpriceFloorPut = {
  symbol: string;
  strike: number;          // hashprice strike (USD per PH/s/day, HUP units)
  expiry_ms: number;
  best_ask: number | null; // live option ask (premium) — the floor's cost
  best_bid: number | null;
};

/**
 * Select the live hashprice floor put: nearest expiry to `targetExpiryMs`, then strike nearest
 * `targetStrikeUsdPerPhDay` (the miner's breakeven hashprice × 1000, since HUP is per-PH). Only
 * considers puts with a live quote. Pure; `parser` injectable for the confirmed symbology.
 */
export const selectHashpriceFloorPut = (
  books: Record<string, BitnomialBook>,
  opts: { targetStrikeUsdPerPhDay: number; targetExpiryMs: number; parser?: (s: string) => ParsedHupoSymbol | null; nowMs?: number }
): HashpriceFloorPut | null => {
  const parse = opts.parser ?? parseHupoSymbol;
  const now = opts.nowMs ?? Date.now();
  const cands = Object.entries(books)
    .map(([symbol, book]) => { const p = parse(symbol); return p ? { symbol, book, ...p } : null; })
    .filter((x): x is { symbol: string; book: BitnomialBook; optType: "put" | "call"; strike: number; expiryMs: number } =>
      x != null && x.optType === "put" && x.expiryMs > now && (x.book.best_ask != null || x.book.best_bid != null));
  if (!cands.length) return null;
  const nearestExp = cands.reduce((a, b) => (Math.abs(b.expiryMs - opts.targetExpiryMs) < Math.abs(a.expiryMs - opts.targetExpiryMs) ? b : a)).expiryMs;
  const sameExp = cands.filter((c) => c.expiryMs === nearestExp);
  const best = sameExp.reduce((a, b) => (Math.abs(b.strike - opts.targetStrikeUsdPerPhDay) < Math.abs(a.strike - opts.targetStrikeUsdPerPhDay) ? b : a));
  return { symbol: best.symbol, strike: best.strike, expiry_ms: best.expiryMs, best_ask: best.book.best_ask, best_bid: best.book.best_bid };
};
