/**
 * OKX liquidity probe — READ-ONLY, public market data (NO API keys required).
 *
 * Fetches OKX BTC option quotes for the put + call nearest a target strike/expiry,
 * converts BTC-quoted premiums to USDC/BTC (×spot), and reports bid/ask/spread/depth.
 *
 * Strictly additive + isolated: does NOT touch the LiquidChainCache, venue routing, or
 * any execution path. OKX is a MEASUREMENT here, not a routing/trading venue. Coin-margined
 * `BTC-USD-…` options only (premium in BTC, like Deribit) — the deepest, most liquid book;
 * the `_UM` (unified/stable-margin) variants are excluded from the probe.
 */

const OKX_BASE = process.env.OKX_REST_BASE ?? "https://www.okx.com";

export type OkxFetcher = (url: string) => Promise<unknown>;

const defaultFetcher: OkxFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  return res.json();
};

export type OkxLegQuote = {
  instId: string;
  strike: number;
  opt_type: "put" | "call";
  expiry_iso: string;
  days_to_expiry: number;
  bid_btc: number | null;
  ask_btc: number | null;
  bid_usdc_per_btc: number | null;
  ask_usdc_per_btc: number | null;
  mid_usdc_per_btc: number | null;
  spread_pct: number | null;
  bid_size: number | null;   // OKX contracts (≈0.01 BTC each — confirm multiplier)
  ask_size: number | null;
};

/** Parse a coin-margined OKX option instId: BTC-USD-YYMMDD-STRIKE-C/P. Excludes _UM. */
export const parseOkxOption = (instId: string): { strike: number; optType: "put" | "call"; expiryMs: number } | null => {
  const m = instId.match(/^BTC-USD-(\d{2})(\d{2})(\d{2})-(\d+)-([CP])$/);
  if (!m) return null;
  const expiryMs = Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3]), 8, 0, 0); // OKX options expire 08:00 UTC
  if (!Number.isFinite(expiryMs)) return null;
  return { strike: Number(m[4]), optType: m[5] === "C" ? "call" : "put", expiryMs };
};

export const okxProbe = async (opts: {
  spot: number;
  putStrike: number;
  callStrike: number;
  tenorDays: number;
  nowMs?: number;
  fetcher?: OkxFetcher;
}): Promise<{ ok: boolean; error?: string; expiry_iso?: string; legs: OkxLegQuote[] }> => {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const now = opts.nowMs ?? Date.now();
  try {
    const instrResp = (await fetcher(`${OKX_BASE}/api/v5/public/instruments?instType=OPTION&uly=BTC-USD`)) as { data?: Array<{ instId?: string }> };
    const all = (instrResp.data ?? [])
      .map((d) => ({ instId: String(d.instId ?? ""), parsed: parseOkxOption(String(d.instId ?? "")) }))
      .filter((x): x is { instId: string; parsed: { strike: number; optType: "put" | "call"; expiryMs: number } } => x.parsed != null);
    if (all.length === 0) return { ok: false, error: "no_okx_btc_usd_options_parsed", legs: [] };

    // Nearest future expiry to the target tenor.
    const targetMs = now + opts.tenorDays * 86_400_000;
    const expiries = [...new Set(all.map((a) => a.parsed.expiryMs))].filter((e) => e > now);
    if (expiries.length === 0) return { ok: false, error: "no_future_okx_expiry", legs: [] };
    const expiry = expiries.sort((a, b) => Math.abs(a - targetMs) - Math.abs(b - targetMs))[0];
    const atExp = all.filter((a) => a.parsed.expiryMs === expiry);
    const pickNearest = (optType: "put" | "call", target: number) =>
      atExp.filter((a) => a.parsed.optType === optType).sort((a, b) => Math.abs(a.parsed.strike - target) - Math.abs(b.parsed.strike - target))[0];

    const legs: OkxLegQuote[] = [];
    for (const [optType, target] of [["put", opts.putStrike], ["call", opts.callStrike]] as const) {
      const inst = pickNearest(optType, target);
      if (!inst) continue;
      const book = (await fetcher(`${OKX_BASE}/api/v5/market/books?instId=${inst.instId}&sz=1`)) as { data?: Array<{ bids?: string[][]; asks?: string[][] }> };
      const top = book.data?.[0];
      const bidBtc = top?.bids?.[0]?.[0] != null ? Number(top.bids[0][0]) : null;
      const askBtc = top?.asks?.[0]?.[0] != null ? Number(top.asks[0][0]) : null;
      const bidSz = top?.bids?.[0]?.[1] != null ? Number(top.bids[0][1]) : null;
      const askSz = top?.asks?.[0]?.[1] != null ? Number(top.asks[0][1]) : null;
      const bidU = bidBtc != null ? bidBtc * opts.spot : null;
      const askU = askBtc != null ? askBtc * opts.spot : null;
      const mid = bidU != null && askU != null ? (bidU + askU) / 2 : null;
      const spread = bidU != null && askU != null && mid != null && mid > 0 ? (askU - bidU) / mid : null;
      legs.push({
        instId: inst.instId, strike: inst.parsed.strike, opt_type: optType,
        expiry_iso: new Date(expiry).toISOString(), days_to_expiry: +((expiry - now) / 86_400_000).toFixed(2),
        bid_btc: bidBtc, ask_btc: askBtc,
        bid_usdc_per_btc: bidU != null ? +bidU.toFixed(2) : null,
        ask_usdc_per_btc: askU != null ? +askU.toFixed(2) : null,
        mid_usdc_per_btc: mid != null ? +mid.toFixed(2) : null,
        spread_pct: spread != null ? +spread.toFixed(4) : null,
        bid_size: bidSz, ask_size: askSz
      });
    }
    return { ok: true, expiry_iso: new Date(expiry).toISOString(), legs };
  } catch (e) {
    return { ok: false, error: (e as Error).message, legs: [] };
  }
};
