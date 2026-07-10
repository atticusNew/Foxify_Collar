/**
 * G-20 Telegram quote handling (pure). Parses the agreed strict one-line reply format and decides
 * accept/pass against the model credit. The bot script wraps this with the Telegram Bot API; keeping the
 * parse + decision pure makes the money-relevant logic testable without any network.
 *
 * Agreed reply format (day-one checklist):   RFQ-7 BID 78 ASK 96 VALID 60
 * Tolerated variations: case-insensitive, "RFQ#7"/"RFQ 7", decimals, negative nets, reordered BID/ASK,
 * missing VALID (default 60s). Anything else ⟹ null (never guess about money).
 */

export type ParsedQuote = { ref: string; bidUsdc: number; askUsdc: number | null; validSec: number };

export const parseQuoteReply = (text: string): ParsedQuote | null => {
  const t = text.trim();
  const refMatch = /rfq[\s#-]*(\d+)/i.exec(t);
  if (!refMatch) return null;
  const bidMatch = /bid\s+(-?\d+(?:\.\d+)?)/i.exec(t);
  if (!bidMatch) return null;
  const askMatch = /ask\s+(-?\d+(?:\.\d+)?)/i.exec(t);
  const validMatch = /valid\s+(\d+)/i.exec(t);
  const bid = Number(bidMatch[1]);
  if (!Number.isFinite(bid)) return null;
  return {
    ref: `RFQ-${refMatch[1]}`,
    bidUsdc: bid,
    askUsdc: askMatch ? Number(askMatch[1]) : null,
    validSec: validMatch ? Number(validMatch[1]) : 60
  };
};

export type QuoteDecision = { action: "done" | "pass"; reason: string };

/**
 * Accept if G-20's NET bid (what they pay us for the structure) is within tolerance of the model credit.
 * `maxDiscountPct` (default 0.25): how far below our modeled fundable credit we'll still trade — the venue
 * is allowed a spread, but not an arbitrary one. A bid ABOVE model is always accepted (better than model).
 */
export const decideQuote = (bidUsdc: number, modelCreditUsdc: number, maxDiscountPct = 0.25): QuoteDecision => {
  if (!(modelCreditUsdc > 0)) {
    return bidUsdc > 0
      ? { action: "done", reason: `no model benchmark; positive net $${bidUsdc.toFixed(2)} accepted` }
      : { action: "pass", reason: `no model benchmark and non-positive net $${bidUsdc.toFixed(2)}` };
  }
  const floor = modelCreditUsdc * (1 - maxDiscountPct);
  if (bidUsdc >= floor) {
    const vsModel = bidUsdc - modelCreditUsdc;
    return { action: "done", reason: `bid $${bidUsdc.toFixed(2)} ≥ floor $${floor.toFixed(2)} (model $${modelCreditUsdc.toFixed(2)}, ${vsModel >= 0 ? "+" : ""}$${vsModel.toFixed(2)} vs model)` };
  }
  return { action: "pass", reason: `bid $${bidUsdc.toFixed(2)} < floor $${floor.toFixed(2)} (model $${modelCreditUsdc.toFixed(2)} − ${(maxDiscountPct * 100).toFixed(0)}% tolerance)` };
};
