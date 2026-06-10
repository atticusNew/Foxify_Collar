/**
 * Bitnomial pricefeed — READ-ONLY WebSocket market data for the LIVE difficulty leg of Miner Protect.
 *
 * Bitnomial lists **HUP** (Luxor Bitcoin Hashrate Futures: USD per PH/s/day, cash-settled on the
 * Luxor Hashprice Index) and **HUPO** (options on the HUP underlying). This gives a production-grade,
 * REGULATED, live source for hashprice — no model. We use the public Book channel:
 *   - HUP  → live hashprice (USD per PH/s/day → ÷1000 = per TH/day): market reference + revenue fix.
 *   - HUPO → live hashprice option books → a true one-sided hashprice FLOOR (put).
 *
 * This module only READS market data (no auth needed). Execution (FCM/clearing) is a later step.
 * The WS client is injectable so the parsing/flow is unit-tested offline; the live probe runs only
 * during Bitnomial hours (8:30am–2:30pm CT, Mon–Fri) — the book is closed otherwise.
 */

export const BITNOMIAL_WS_URL = "wss://bitnomial.com/exchange/ws";
/** Contract size: HUP is quoted per PETAHASH/s/day; miners think per TERAHASH/s/day → ÷ 1000. */
export const PH_PER_TH = 1000;

export type PriceLevel = [number, number]; // [price, quantity]
export type BitnomialBook = {
  symbol: string;
  bids: PriceLevel[];
  asks: PriceLevel[];
  best_bid: number | null;
  best_ask: number | null;
  mid: number | null;
  ts: string | null;
};

/** Parse a Bitnomial `book` snapshot message → normalized top-of-book. Null for non-book messages. */
export const parseBook = (msg: unknown): BitnomialBook | null => {
  const m = msg as { type?: string; symbol?: unknown; asks?: unknown; bids?: unknown; timestamp?: unknown };
  if (!m || m.type !== "book" || typeof m.symbol !== "string") return null;
  const clean = (rows: unknown): PriceLevel[] =>
    (Array.isArray(rows) ? rows : [])
      .map((r) => (Array.isArray(r) ? [Number(r[0]), Number(r[1])] as PriceLevel : null))
      .filter((r): r is PriceLevel => r != null && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] > 0);
  const asks = clean(m.asks);
  const bids = clean(m.bids);
  const best_ask = asks.length ? asks[0][0] : null;
  const best_bid = bids.length ? bids[0][0] : null;
  const mid = best_ask != null && best_bid != null ? (best_ask + best_bid) / 2 : (best_ask ?? best_bid);
  return { symbol: m.symbol, bids, asks, best_bid, best_ask, mid, ts: typeof m.timestamp === "string" ? m.timestamp : null };
};

/** HUP price (USD per PH/s/day) → hashprice in USD per TH/s/day. */
export const hupToUsdPerThDay = (priceUsdPerPhDay: number | null | undefined): number | null =>
  priceUsdPerPhDay != null && priceUsdPerPhDay > 0 ? +(priceUsdPerPhDay / PH_PER_TH).toFixed(6) : null;

/** Minimal WS surface so the client is injectable/testable. */
export interface WsLike {
  on(event: "open" | "message" | "error" | "close", cb: (arg?: unknown) => void): void;
  send(data: string): void;
  close(): void;
}
export type WsFactory = (url: string) => WsLike;

/**
 * Connect, subscribe to the Book channel for the given product codes (e.g. ["HUP"] or ["HUPO"]),
 * collect book snapshots for a short window, and return them keyed by symbol. Read-only; resolves
 * {} on any error / no data (e.g. market closed). `wsFactory` is injected in tests.
 */
export const probeBitnomialBooks = async (
  productCodes: string[],
  opts?: { wsUrl?: string; wsFactory?: WsFactory; collectMs?: number }
): Promise<Record<string, BitnomialBook>> => {
  const url = opts?.wsUrl ?? BITNOMIAL_WS_URL;
  const collectMs = opts?.collectMs ?? 3000;
  let factory = opts?.wsFactory;
  if (!factory) {
    try {
      // @ts-ignore — 'ws' ships no bundled types; runtime is fine (project builds via esbuild/tsx).
      const mod: any = await import("ws");
      const WS = mod.default ?? mod;
      factory = (u: string): WsLike => {
        const w = new WS(u);
        return { on: (e, cb) => w.on(e, cb), send: (d) => w.send(d), close: () => { try { w.close(); } catch { /* noop */ } } };
      };
    } catch {
      return {};
    }
  }
  return new Promise((resolve) => {
    const books: Record<string, BitnomialBook> = {};
    let done = false;
    let ws: WsLike;
    const finish = () => { if (done) return; done = true; try { ws.close(); } catch { /* noop */ } resolve(books); };
    try { ws = factory!(url); } catch { resolve({}); return; }
    const timer = setTimeout(finish, collectMs);
    ws.on("open", () => { try { ws.send(JSON.stringify({ type: "subscribe", channels: [{ name: "book", product_codes: productCodes }] })); } catch { finish(); } });
    ws.on("message", (data?: unknown) => {
      try {
        const text = typeof data === "string" ? data : (data as { toString(): string })?.toString?.() ?? "";
        const b = parseBook(JSON.parse(text));
        if (b) books[b.symbol] = b;
      } catch { /* ignore non-JSON / non-book */ }
    });
    ws.on("error", () => { clearTimeout(timer); finish(); });
    ws.on("close", () => { clearTimeout(timer); if (!done) { done = true; resolve(books); } });
  });
};

/** Live hashprice from Bitnomial HUP (USD per TH/day) — the market reference / fix leg. */
export const bitnomialHashpriceProvider = (opts?: { wsUrl?: string; wsFactory?: WsFactory; collectMs?: number }) => ({
  getHashpriceUsdPerThDay: async (): Promise<{ usd_per_th_day: number; symbol: string } | null> => {
    const books = await probeBitnomialBooks(["HUP"], opts);
    const priced = Object.values(books).filter((b) => b.mid != null);
    if (!priced.length) return null;
    // Prefer the nearest-dated future when the symbol encodes a date; else the first priced (front).
    const front = priced.sort((a, b) => a.symbol.localeCompare(b.symbol))[0];
    const usd = hupToUsdPerThDay(front.mid);
    return usd != null ? { usd_per_th_day: usd, symbol: front.symbol } : null;
  }
});
