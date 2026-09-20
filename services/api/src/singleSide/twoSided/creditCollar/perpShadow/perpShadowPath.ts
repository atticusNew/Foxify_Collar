/**
 * The price PATH between open and expiry, because the collar is a knock-out:
 * a cap touch at 03:00 ends the cycle even when the 08:00 print is back
 * between the wings. Settling on the print alone would call that position
 * "closed between" and miss the buyback the writer paid at the touch.
 *
 * Hyperliquid candles (the mark the product triggers on) give the touch and
 * its time; OKX index candles around that minute say whether the hedge
 * venue's clock saw the same touch (the two-clock gap). Pure functions here;
 * the fetches are injectable and live in perpShadowMarket.
 */

import type { PerpSide } from "../creditCollarPricer";

export interface Candle {
  /** open time, ms */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** candleSnapshot: [{ t, T, s, i, o, c, h, l, v, n }] with string prices */
export const parseHlCandles = (raw: unknown): Candle[] => {
  const rows = Array.isArray(raw) ? (raw as Array<{ t?: number; o?: string; h?: string; l?: string; c?: string }>) : [];
  return rows
    .map((r) => ({ t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) }))
    .filter((c) => Number.isFinite(c.t) && [c.o, c.h, c.l, c.c].every((x) => Number.isFinite(x) && x > 0))
    .sort((a, b) => a.t - b.t);
};

/** index-candles: { data: [[ts, o, h, l, c, confirm], ...] } newest first */
export const parseOkxIndexCandles = (raw: unknown): Candle[] => {
  const rows = (raw as { data?: string[][] })?.data ?? [];
  return rows
    .map((r) => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) }))
    .filter((c) => Number.isFinite(c.t) && [c.o, c.h, c.l, c.c].every((x) => Number.isFinite(x) && x > 0))
    .sort((a, b) => a.t - b.t);
};

export interface CapTouch {
  capStrikeCents: number;
  /** the candle that first reached the cap */
  atMs: number;
  /** the candle's extreme on the cap side (its high for a long's cap, its low for a short's) */
  hlPxCents: number;
}

/**
 * The first candle at or beyond each cap, strictly after `fromMs` (the open)
 * and at or before `toMs` (expiry). A long is knocked out when the HIGH
 * reaches its cap above; a short when the LOW reaches its cap below.
 */
export const firstTouches = (candles: Candle[], side: PerpSide, capStrikesCents: number[], fromMs: number, toMs: number): CapTouch[] => {
  const out: CapTouch[] = [];
  for (const cap of new Set(capStrikesCents)) {
    const capPx = cap / 100;
    for (const c of candles) {
      if (c.t < fromMs || c.t > toMs) continue;
      const hit = side === "long" ? c.h >= capPx : c.l <= capPx;
      if (hit) {
        out.push({ capStrikeCents: cap, atMs: c.t, hlPxCents: Math.round((side === "long" ? c.h : c.l) * 100) });
        break;
      }
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs);
};

/** Highest high and lowest low over [fromMs, toMs]; null when no candle falls inside. */
export const pathRange = (candles: Candle[], fromMs: number, toMs: number): { hiCents: number; loCents: number; candles: number } | null => {
  let hi = -Infinity;
  let lo = Infinity;
  let n = 0;
  for (const c of candles) {
    if (c.t < fromMs || c.t > toMs) continue;
    hi = Math.max(hi, c.h);
    lo = Math.min(lo, c.l);
    n += 1;
  }
  return n === 0 ? null : { hiCents: Math.round(hi * 100), loCents: Math.round(lo * 100), candles: n };
};

/**
 * Did the hedge venue's index reach the cap in the minutes around the
 * Hyperliquid touch? `okxPxCents` is the index's extreme on the cap side in
 * that window; `confirmed` compares it with the cap. Null when no OKX candle
 * covers the window (recorded as unknown, never guessed).
 */
export const okxConfirms = (
  okxCandles: Candle[],
  side: PerpSide,
  capStrikeCents: number,
  touchMs: number,
  windowMs = 3 * 60_000,
): { okxPxCents: number | null; confirmed: boolean | null; gapBps: number | null } => {
  const inWin = okxCandles.filter((c) => c.t >= touchMs - windowMs && c.t <= touchMs + windowMs);
  if (inWin.length === 0) return { okxPxCents: null, confirmed: null, gapBps: null };
  const ext = side === "long" ? Math.max(...inWin.map((c) => c.h)) : Math.min(...inWin.map((c) => c.l));
  const extCents = Math.round(ext * 100);
  const confirmed = side === "long" ? extCents >= capStrikeCents : extCents <= capStrikeCents;
  // how far the OKX extreme sat from the cap, bps of the cap (negative = did not reach it)
  const gap = ((side === "long" ? extCents - capStrikeCents : capStrikeCents - extCents) / capStrikeCents) * 10000;
  return { okxPxCents: extCents, confirmed, gapBps: +gap.toFixed(1) };
};

/** 1-minute candles for a day, 5-minute for anything longer (Hyperliquid caps a snapshot at 5000 rows). */
export const candleIntervalFor = (spanMs: number): "1m" | "5m" => (spanMs <= 36 * 3_600_000 ? "1m" : "5m");
