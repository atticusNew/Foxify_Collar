/**
 * VENUE REFERENCE — the same two legs, read at Deribit and Bullish the second OKX quotes them.
 *
 * OKX is where the shadow's collar is priced and where the demo hedges. The live product will
 * RFQ FalconX, who hedge on Deribit (the deepest BTC options book), and we are onboarded at
 * Bullish, who say they beat Deribit often. Neither is an execution venue here; both are a
 * REFERENCE: what would the identical collar (buy the floor at the ask, sell the cap at the bid,
 * same strikes, same expiry, same instant) have paid at each? Recorded on every open record so the
 * operator report can say, on measured numbers, whether pricing off OKX leaves credit on the table
 * and what a FalconX quote should be held against.
 *
 * All reads are public and unsigned. Prices are normalised to USD per 1 BTC of option:
 *   OKX     price in BTC × index          (BTC-USD-YYMMDD-STRIKE-C)
 *   Deribit price in BTC × underlying     (BTC-DDMMMYY-STRIKE-C, /public/ticker)
 *   Bullish price in USDC                 (BTC-USDC-YYYYMMDD-STRIKE-C, /orderbook/hybrid)
 * A missing side is null, never zero. Every fetch is injectable; tests run on fixtures.
 */

export type RefVenue = "deribit" | "bullish";
export const REF_VENUES: readonly RefVenue[] = ["deribit", "bullish"] as const;

export interface VenueLegTop {
  instrument: string;
  /** USD cents per 1 BTC of option; null when the side has no resting order */
  bidCents: number | null;
  askCents: number | null;
}

export interface VenueRef {
  ok: boolean;
  error?: string;
  /** the floor leg we BUY (its ask matters) */
  buy: VenueLegTop | null;
  /** the cap leg we SELL (its bid matters) */
  sell: VenueLegTop | null;
  /** sell bid − buy ask at this venue, USD cents per BTC; null when either side is missing */
  netCents: number | null;
  /** venue net − OKX net, cents per BTC (positive: this venue would have paid the holder more) */
  vsOkxCents: number | null;
  /** the same, in bps of spot */
  vsOkxBps: number | null;
}

export interface PerpVenueReference {
  /** OKX's touch on the same legs, cents per BTC, as quoted */
  okx: { buyAskCents: number; sellBidCents: number; netCents: number };
  venues: Record<RefVenue, VenueRef>;
}

// ── instrument names ─────────────────────────────────────────────────────────

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export interface OkxLeg {
  yymmdd: string;
  strike: number;
  cp: "C" | "P";
}

/** BTC-USD-260925-110000-C → { yymmdd: "260925", strike: 110000, cp: "C" } */
export const parseOkxInstId = (instId: string): OkxLeg | null => {
  const m = /^BTC-USD-(\d{6})-(\d+(?:\.\d+)?)-([CP])$/.exec(instId);
  if (!m) return null;
  const strike = Number(m[2]);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return { yymmdd: m[1], strike, cp: m[3] as "C" | "P" };
};

const strikeText = (k: number): string => (Number.isInteger(k) ? String(k) : String(k).replace(/\.?0+$/, ""));

/** Deribit: BTC-25SEP26-110000-C (no leading zero on the day) */
export const deribitInstrument = (leg: OkxLeg): string => {
  const yy = leg.yymmdd.slice(0, 2);
  const mm = Number(leg.yymmdd.slice(2, 4));
  const dd = Number(leg.yymmdd.slice(4, 6));
  return `BTC-${dd}${MONTHS[mm - 1]}${yy}-${strikeText(leg.strike)}-${leg.cp}`;
};

/** Bullish: BTC-USDC-20260925-110000-C */
export const bullishSymbol = (leg: OkxLeg): string => `BTC-USDC-20${leg.yymmdd}-${strikeText(leg.strike)}-${leg.cp}`;

// ── parsers (pure) ───────────────────────────────────────────────────────────

const pos = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const cents = (usd: number | null): number | null => (usd == null ? null : Math.round(usd * 100));

/** /api/v2/public/ticker → { result: { best_bid_price, best_ask_price (BTC), underlying_price } } */
export const parseDeribitTicker = (raw: unknown, instrument: string): VenueLegTop | null => {
  const r = (raw as { result?: { best_bid_price?: number; best_ask_price?: number; underlying_price?: number; index_price?: number } })?.result;
  if (!r) return null;
  const under = pos(r.underlying_price) ?? pos(r.index_price);
  if (under == null) return null;
  const bid = pos(r.best_bid_price);
  const ask = pos(r.best_ask_price);
  return { instrument, bidCents: cents(bid == null ? null : bid * under), askCents: cents(ask == null ? null : ask * under) };
};

/** /trading-api/v1/markets/{symbol}/orderbook/hybrid → { bids: [{price}], asks: [{price}] } in USDC */
export const parseBullishBook = (raw: unknown, instrument: string): VenueLegTop | null => {
  const b = raw as { bids?: Array<{ price?: string | number }>; asks?: Array<{ price?: string | number }> } | null;
  if (!b || (!Array.isArray(b.bids) && !Array.isArray(b.asks))) return null;
  return { instrument, bidCents: cents(pos(b.bids?.[0]?.price)), askCents: cents(pos(b.asks?.[0]?.price)) };
};

// ── fetchers (injectable) ────────────────────────────────────────────────────

export type LegReader = (leg: OkxLeg) => Promise<VenueLegTop | null>;

export const deribitLegReader =
  (base = process.env.DERIBIT_REST_BASE || "https://www.deribit.com", f: typeof fetch = fetch): LegReader =>
  async (leg) => {
    const instrument = deribitInstrument(leg);
    const res = await f(`${base}/api/v2/public/ticker?instrument_name=${encodeURIComponent(instrument)}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`Deribit ticker HTTP ${res.status}`);
    return parseDeribitTicker(await res.json(), instrument);
  };

export const bullishLegReader =
  (base = process.env.BULLISH_REST_BASE || "https://api.exchange.bullish.com", f: typeof fetch = fetch): LegReader =>
  async (leg) => {
    const instrument = bullishSymbol(leg);
    const res = await f(`${base}/trading-api/v1/markets/${encodeURIComponent(instrument)}/orderbook/hybrid`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 404) return { instrument, bidCents: null, askCents: null }; // not listed there
    if (!res.ok) throw new Error(`Bullish orderbook HTTP ${res.status}`);
    return parseBullishBook(await res.json(), instrument);
  };

// ── the reference ────────────────────────────────────────────────────────────

export interface VenueReferenceInputs {
  buyInstId: string;
  sellInstId: string;
  /** OKX touch prices in BTC, as quoted (the buy leg's ask, the sell leg's bid) */
  buyPxBtc: number;
  sellPxBtc: number;
  /** the price the BTC prices are converted at (the same spot the quote used) */
  spot: number;
}

const refOf = (buy: VenueLegTop | null, sell: VenueLegTop | null, okxNetCents: number, spot: number): VenueRef => {
  const netCents = buy?.askCents != null && sell?.bidCents != null ? sell.bidCents - buy.askCents : null;
  const vsOkxCents = netCents == null ? null : netCents - okxNetCents;
  return {
    ok: true,
    buy,
    sell,
    netCents,
    vsOkxCents,
    vsOkxBps: vsOkxCents == null || spot <= 0 ? null : +((vsOkxCents / 100 / spot) * 10000).toFixed(2),
  };
};

/**
 * Read both legs at every reference venue. A venue that fails to read is recorded as such; it
 * never fails the quote (the reference is a measurement, the OKX quote is the product).
 */
export const readVenueReference = async (
  inp: VenueReferenceInputs,
  readers: Partial<Record<RefVenue, LegReader>> = { deribit: deribitLegReader(), bullish: bullishLegReader() },
): Promise<PerpVenueReference | null> => {
  const buyLeg = parseOkxInstId(inp.buyInstId);
  const sellLeg = parseOkxInstId(inp.sellInstId);
  if (!buyLeg || !sellLeg || inp.spot <= 0) return null;
  const okx = {
    buyAskCents: Math.round(inp.buyPxBtc * inp.spot * 100),
    sellBidCents: Math.round(inp.sellPxBtc * inp.spot * 100),
    netCents: 0,
  };
  okx.netCents = okx.sellBidCents - okx.buyAskCents;
  const venues = {} as Record<RefVenue, VenueRef>;
  await Promise.all(
    REF_VENUES.map(async (v) => {
      const reader = readers[v];
      if (!reader) {
        venues[v] = { ok: false, error: "no reader", buy: null, sell: null, netCents: null, vsOkxCents: null, vsOkxBps: null };
        return;
      }
      try {
        const [buy, sell] = await Promise.all([reader(buyLeg), reader(sellLeg)]);
        venues[v] = refOf(buy, sell, okx.netCents, inp.spot);
      } catch (err) {
        venues[v] = { ok: false, error: String(err instanceof Error ? err.message : err), buy: null, sell: null, netCents: null, vsOkxCents: null, vsOkxBps: null };
      }
    }),
  );
  return { okx, venues };
};

// ── the summary (over open records) ──────────────────────────────────────────

export interface VenueRefBook {
  /** open records that carried a read for this venue */
  read: number;
  /** reads where the venue had both sides we need (a bid on the cap, an ask on the floor) */
  priced: number;
  /** of those, how many would have paid the holder MORE than OKX */
  beatOkx: number;
  /** average (venue − OKX) on the collar's net, bps of spot, over priced reads */
  avgVsOkxBps: number | null;
  /** the same, cents per BTC */
  avgVsOkxCents: number | null;
  /** how often the floor leg had an ask / the cap leg a bid, over reads */
  buyAskPct: number | null;
  sellBidPct: number | null;
  /** reads that failed outright (HTTP / parse) */
  errors: number;
}

export type PerpVenueReferenceSummary = Record<RefVenue, VenueRefBook>;

const pct = (n: number, d: number): number | null => (d > 0 ? +((n / d) * 100).toFixed(1) : null);

export const summarizeVenueReference = (refs: Array<PerpVenueReference | null | undefined>): PerpVenueReferenceSummary => {
  const out = {} as PerpVenueReferenceSummary;
  for (const v of REF_VENUES) {
    let read = 0, priced = 0, beat = 0, bpsSum = 0, centsSum = 0, buyAsk = 0, sellBid = 0, errors = 0;
    for (const r of refs) {
      const x = r?.venues?.[v];
      if (!x) continue;
      read += 1;
      if (!x.ok) {
        errors += 1;
        continue;
      }
      if (x.buy?.askCents != null) buyAsk += 1;
      if (x.sell?.bidCents != null) sellBid += 1;
      if (x.netCents != null && x.vsOkxCents != null && x.vsOkxBps != null) {
        priced += 1;
        if (x.vsOkxCents > 0) beat += 1;
        bpsSum += x.vsOkxBps;
        centsSum += x.vsOkxCents;
      }
    }
    out[v] = {
      read,
      priced,
      beatOkx: beat,
      avgVsOkxBps: priced ? +(bpsSum / priced).toFixed(2) : null,
      avgVsOkxCents: priced ? Math.round(centsSum / priced) : null,
      buyAskPct: pct(buyAsk, read - errors),
      sellBidPct: pct(sellBid, read - errors),
      errors,
    };
  }
  return out;
};
