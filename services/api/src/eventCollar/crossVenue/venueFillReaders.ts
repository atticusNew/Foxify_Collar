/**
 * VENUE FILL READERS: the reads behind the daily check (realizedRecon.ts). Each one asks a venue
 * for its own record of our fills on one UTC day and hands back orders in our ledger's units.
 *
 * Every call here is a signed GET. Nothing is placed, cancelled or moved. A reader exists only
 * when its key is in the service env; with no key the venue's answer is "no key for <venue>",
 * which the check reports as could not be checked, never as agreeing.
 *
 *   Kalshi     KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY_PEM: GET /portfolio/fills for the day, every
 *              page, every subaccount the key can see (EVENT_RECON_KALSHI_SUBACCOUNTS narrows it).
 *              This is the venue's own list, so it also shows what we never recorded, and it
 *              covers the orders the aggregator's pod sent into a subaccount of our account. The
 *              key needs read access to the portfolio and must not be locked to another subaccount.
 *              Without that key and with the aggregator's: each Kalshi order our ledger names is
 *              read back from the aggregator (GET /v1/kalshi/orders/{id}); orders sent with our
 *              own key then cannot be read.
 *   ProphetX   AGGREGATOR_TRADE_KEY_ID + AGGREGATOR_TRADE_PRIVATE_KEY_HEX: the fills of each
 *              order our ledger names (GET /v1/prophetx/orders/{id}/fills). No day list is known
 *              on that surface, so a fill we never recorded would not show.
 *   Novig      NOVIG_TRADE_KEY_ID + NOVIG_TRADE_PRIVATE_KEY_PEM on VENUE_API_HOST: GET
 *              /v3/portfolio/fills for the day, every page, the trading key's own subaccount.
 *   Polymarket no order client and no reader.
 *
 * One read per venue per run, pages and order reads bounded, the whole venue read under one
 * deadline. A failure is reported and not tried again inside the run.
 */

import { AggregatorApiError } from "./aggregatorMarkets";
import { AggregatorOrderClient, aggregatorTradeConfigFromEnv, type AggregatorKalshiOrder } from "./aggregatorOrders";
import { errText, type HedgeVenue } from "./hedgeExecutor";
import { KalshiOrderClient, type KalshiFill, type KalshiFillsQuery, type KalshiRawOrder } from "./kalshiOrders";
import { kalshiRfqCredentialsFromEnv } from "./kalshiRfq";
import { NovigOrderClient, novigClientId, novigTradeConfigFromEnv, type NovigFill } from "./novigOrders";
import { ProphetXOrderClient, type ProphetXFee, type ProphetXFill } from "./prophetxOrders";
import type { NotCountedLine, RealFill } from "./realizedBook";
import {
  aggregatorKalshiOrderFill,
  capCentsOfLimit,
  kalshiOrdersFromFills,
  novigOrdersFromFills,
  prophetxOrderFill,
  type VenueDayRead,
  type VenueOrderFill,
} from "./realizedRecon";
import { VenueApiError, signerFromPem } from "./venuePositions";

export interface KalshiFillsSource {
  fillsPage(q: KalshiFillsQuery): Promise<{ fills: KalshiFill[]; cursor: string | null }>;
  orderRead(orderId: string): Promise<KalshiRawOrder | null>;
}
export interface AggregatorOrderSource {
  order(orderId: string): Promise<AggregatorKalshiOrder>;
  rest: { syncClock(): Promise<void> };
}
export interface ProphetXFillsSource {
  fills(orderId: string): Promise<ProphetXFill[]>;
  readonly feeBps: number;
  /** the fee on the game a line's Kalshi ticker names */
  feeFor(ticker: string | undefined): ProphetXFee;
  rest: { syncClock(): Promise<void> };
}
export interface NovigFillsSource {
  fillsBetween(afterMs: number, beforeMs: number): Promise<NovigFill[]>;
}

export interface VenueFillReaders {
  kalshi?: KalshiFillsSource;
  /** Kalshi subaccounts to list; absent or empty lists every one the key can see */
  kalshiSubaccounts?: number[];
  aggregator?: AggregatorOrderSource;
  prophetx?: ProphetXFillsSource;
  novig?: NovigFillsSource;
}

export interface ReadOptions {
  /** how far past the day's end a list reads, so an order sent in the last seconds is found; ms */
  graceMs?: number;
  /** the deadline for one venue's whole read; ms */
  timeoutMs?: number;
  /** most pages one list may run to */
  maxPages?: number;
  /** most orders the venue shows and our ledger does not that are read back for their client order id */
  maxStrangerReads?: number;
}

const DEFAULTS: Required<ReadOptions> = { graceMs: 10 * 60_000, timeoutMs: 60_000, maxPages: 50, maxStrangerReads: 20 };

/** What the env holds, in words; no key material. */
export interface VenueFillReadersView {
  kalshi: string;
  prophetx: string;
  novig: string;
  polymarket: string;
}

export function venueFillReadersFromEnv(env: NodeJS.ProcessEnv = process.env): { readers: VenueFillReaders; view: VenueFillReadersView } {
  const readers: VenueFillReaders = {};
  const view: VenueFillReadersView = { kalshi: "no key for kalshi", prophetx: "no key for prophetx", novig: "no key for novig", polymarket: "no reader for polymarket" };

  const subs = (env.EVENT_RECON_KALSHI_SUBACCOUNTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d{1,2}$/.test(s))
    .map(Number)
    .filter((n) => n >= 0 && n <= 63);
  if (subs.length > 0) readers.kalshiSubaccounts = [...new Set(subs)];

  const kCreds = kalshiRfqCredentialsFromEnv(env);
  if (kCreds) {
    readers.kalshi = new KalshiOrderClient(kCreds);
    view.kalshi = `the venue's own list of the day's fills, ${readers.kalshiSubaccounts ? `subaccount ${readers.kalshiSubaccounts.join(", ")}` : "every subaccount the key can see"} (KALSHI_API_KEY_ID)`;
  }
  const tCfg = aggregatorTradeConfigFromEnv(env);
  if (tCfg) {
    try {
      const aggregator = new AggregatorOrderClient(tCfg);
      readers.aggregator = aggregator;
      readers.prophetx = new ProphetXOrderClient(tCfg, { rest: aggregator.rest });
      view.prophetx = "the aggregator's fills of each order our ledger names; no day list (AGGREGATOR_TRADE_KEY_ID)";
      if (!kCreds) view.kalshi = "the aggregator's read of each order our ledger names; no day list, and orders sent with our own key cannot be read (AGGREGATOR_TRADE_KEY_ID)";
    } catch (err) {
      view.prophetx = `the aggregator's trade key is unusable (${errText(err)})`;
    }
  }
  const nCfg = novigTradeConfigFromEnv(env);
  if (nCfg) {
    try {
      readers.novig = new NovigOrderClient({ host: nCfg.host, signer: signerFromPem(nCfg.keyId, nCfg.pem) });
      view.novig = "the venue's own list of the day's fills in the trading key's subaccount (NOVIG_TRADE_KEY_ID)";
    } catch (err) {
      view.novig = `the trading key is unusable (${errText(err)})`;
    }
  }
  return { readers, view };
}

const notFound = (err: unknown): boolean =>
  (err instanceof AggregatorApiError && err.status === 404) || (err instanceof VenueApiError && err.status === 404) || (err instanceof Error && /\bHTTP 404\b/.test(err.message));

/** An error in a few words, with nothing a venue echoed back beyond its first line. */
const why = (err: unknown): string => errText(err).split("\n")[0].slice(0, 200);

function dayWindow(day: string): { startMs: number; endMs: number } {
  const startMs = Date.parse(`${day}T00:00:00.000Z`);
  return { startMs, endMs: startMs + 86_400_000 };
}

async function readKalshi(day: string, today: RealFill[], readers: VenueFillReaders, o: Required<ReadOptions>, knownIds: Set<string>): Promise<VenueDayRead> {
  const unread: VenueDayRead["unread"] = [];
  if (readers.kalshi) {
    const { startMs, endMs } = dayWindow(day);
    const fills: KalshiFill[] = [];
    const subs: Array<number | undefined> = readers.kalshiSubaccounts?.length ? readers.kalshiSubaccounts : [undefined];
    for (const subaccount of subs) {
      let cursor: string | null = null;
      let page = 0;
      for (;;) {
        if (page >= o.maxPages) throw new Error(`the day's list did not end within ${o.maxPages} pages`);
        const r = await readers.kalshi.fillsPage({ minTs: Math.floor(startMs / 1000) - 1, maxTs: Math.ceil((endMs + o.graceMs) / 1000), ...(subaccount !== undefined ? { subaccount } : {}), ...(cursor ? { cursor } : {}) });
        fills.push(...r.fills);
        page += 1;
        if (!r.cursor) break;
        cursor = r.cursor;
      }
    }
    // one fill may come back on two pages when the list moves under the cursor; a fill is counted once
    const seen = new Set<string>();
    const once = fills.filter((f) => {
      if (!f.fill_id) return true;
      if (seen.has(f.fill_id)) return false;
      seen.add(f.fill_id);
      return true;
    });
    const orders = kalshiOrdersFromFills(once);
    const byId = new Map(orders.map((x) => [x.ids[0], x]));

    // a line sent through the aggregator that did not keep the venue's order id: the aggregator's read names it
    if (readers.aggregator) {
      const nameless = today.filter((f) => f.via === "aggregator" && f.orderId && (!f.venueOrderId || !byId.has(f.venueOrderId)));
      if (nameless.length > 0) await readers.aggregator.rest.syncClock();
      for (const f of nameless) {
        try {
          const order = await readers.aggregator.order(f.orderId as string);
          const row = order.venueOrderId ? byId.get(order.venueOrderId) : undefined;
          if (row) {
            row.ids.push(order.orderId);
            row.clientOrderId = row.clientOrderId ?? order.clientOrderId ?? null;
          }
        } catch {
          // the list stands on its own; the line is then reported as not at the venue under its own id
        }
      }
    }
    // what the venue shows and no line of ours names: its client order id says whether we sent it
    let strangerReads = 0;
    for (const row of orders) {
      if (strangerReads >= o.maxStrangerReads) break;
      if (row.ids.some((id) => knownIds.has(id))) continue;
      strangerReads += 1;
      try {
        const order = await readers.kalshi.orderRead(row.ids[0]);
        if (order?.client_order_id) row.clientOrderId = order.client_order_id;
      } catch {
        // the hint is lost, the order is still listed
      }
    }
    return {
      venue: "kalshi",
      status: "read",
      reason: null,
      scope: "whole_day",
      how: `the venue's own list of fills for the day, ${readers.kalshiSubaccounts?.length ? `subaccount ${readers.kalshiSubaccounts.join(", ")}` : "every subaccount the key can see"}: ${once.length} fills in ${orders.length} orders`,
      orders,
      unread,
    };
  }
  if (readers.aggregator) {
    const orders: VenueOrderFill[] = [];
    if (today.some((f) => f.via === "aggregator")) await readers.aggregator.rest.syncClock();
    for (const f of today) {
      if (f.via !== "aggregator" || !f.orderId) {
        unread.push({ receiptId: f.receiptId, reason: "no key for kalshi: the order was sent with our own key and only the aggregator's key is set" });
        continue;
      }
      try {
        orders.push(aggregatorKalshiOrderFill(await readers.aggregator.order(f.orderId), capCentsOfLimit(f.limitMilli)));
      } catch (err) {
        if (!notFound(err)) unread.push({ receiptId: f.receiptId, reason: why(err) });
      }
    }
    return {
      venue: "kalshi",
      status: "read",
      reason: null,
      scope: "ledger_orders_only",
      how: `the aggregator's read of each order our ledger names: ${orders.length} of ${today.length} read`,
      orders,
      unread,
    };
  }
  return { venue: "kalshi", status: "no_key", reason: "no key for kalshi", scope: "ledger_orders_only", how: "not read", orders: [], unread };
}

async function readProphetX(today: RealFill[], readers: VenueFillReaders): Promise<VenueDayRead> {
  const unread: VenueDayRead["unread"] = [];
  if (!readers.prophetx) return { venue: "prophetx", status: "no_key", reason: "no key for prophetx", scope: "ledger_orders_only", how: "not read", orders: [], unread };
  const orders: VenueOrderFill[] = [];
  if (today.length > 0) await readers.prophetx.rest.syncClock();
  for (const f of today) {
    if (!f.orderId) {
      unread.push({ receiptId: f.receiptId, reason: "our line carries no order id to read back" });
      continue;
    }
    try {
      const fills = await readers.prophetx.fills(f.orderId);
      orders.push(prophetxOrderFill(f.orderId, fills, { sell: f.action === "sell", wantedUnitsMilli: f.wantedUnitsMilli, fee: readers.prophetx.feeFor(f.ticker), venueOrderId: f.venueOrderId, instrument: f.orderInstrument }));
    } catch (err) {
      if (!notFound(err)) unread.push({ receiptId: f.receiptId, reason: why(err) });
    }
  }
  return {
    venue: "prophetx",
    status: "read",
    reason: null,
    scope: "ledger_orders_only",
    how: `the aggregator's fills of each order our ledger names: ${orders.length} of ${today.length} read, each costed at its game's fee (${readers.prophetx.feeBps / 100}% of net gains at settlement; on a maker/taker league the fee at the trade)`,
    orders,
    unread,
  };
}

async function readNovig(day: string, ours: RealFill[], readers: VenueFillReaders, o: Required<ReadOptions>): Promise<VenueDayRead> {
  if (!readers.novig) return { venue: "novig", status: "no_key", reason: "no key for novig", scope: "ledger_orders_only", how: "not read", orders: [], unread: [] };
  const { startMs, endMs } = dayWindow(day);
  const fills = await readers.novig.fillsBetween(startMs - 1, endMs + o.graceMs);
  const byOrder = new Map<string, RealFill>();
  const byClient = new Map<string, RealFill>();
  for (const f of ours) {
    if (f.orderId) byOrder.set(f.orderId, f);
    byClient.set(novigClientId(f.clientOrderId), f);
  }
  const orders = novigOrdersFromFills(fills, (orderId, clientId) => {
    const f = byOrder.get(orderId) ?? (clientId ? byClient.get(clientId) : undefined);
    return f ? { sell: f.action === "sell", wantedUnitsMilli: f.wantedUnitsMilli } : null;
  });
  return {
    venue: "novig",
    status: "read",
    reason: null,
    scope: "whole_day",
    how: `the venue's own list of fills for the day in the trading key's subaccount: ${fills.length} fills in ${orders.length} orders`,
    orders,
    unread: [],
  };
}

/** A read held to a deadline: a venue that never answers is a failed read, not a run that never ends. */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(ms / 1000)}s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read the venues for one UTC day. A venue is read when it can list its own day (a key is set),
 * or when our ledger has a real fill or an uncounted line there that day. Never throws: a venue
 * that cannot be read comes back as failed with the reason.
 */
export async function readVenueFills(day: string, fills: RealFill[], notCounted: NotCountedLine[], readers: VenueFillReaders, opts: ReadOptions = {}): Promise<VenueDayRead[]> {
  const o = { ...DEFAULTS, ...opts };
  const active = new Set<HedgeVenue>();
  for (const f of fills) if (f.day === day) active.add(f.venue);
  for (const n of notCounted) if (n.day === day) active.add(n.venue);
  const out: VenueDayRead[] = [];
  const attempt = async (venue: HedgeVenue, scope: VenueDayRead["scope"], run: () => Promise<VenueDayRead>): Promise<void> => {
    try {
      out.push(await withDeadline(run(), o.timeoutMs));
    } catch (err) {
      out.push({ venue, status: "failed", reason: `the read failed: ${why(err)}`, scope, how: "not read", orders: [], unread: [] });
    }
  };
  const of = (venue: HedgeVenue): RealFill[] => fills.filter((f) => f.venue === venue);
  const todayOf = (venue: HedgeVenue): RealFill[] => of(venue).filter((f) => f.day === day);

  if (readers.kalshi || active.has("kalshi")) {
    const knownIds = new Set(of("kalshi").flatMap((f) => [f.orderId, f.venueOrderId].filter((x): x is string => x !== null)));
    await attempt("kalshi", readers.kalshi ? "whole_day" : "ledger_orders_only", () => readKalshi(day, todayOf("kalshi"), readers, o, knownIds));
  }
  if (active.has("prophetx")) await attempt("prophetx", "ledger_orders_only", () => readProphetX(todayOf("prophetx"), readers));
  if (readers.novig || active.has("novig")) await attempt("novig", readers.novig ? "whole_day" : "ledger_orders_only", () => readNovig(day, of("novig"), readers, o));
  if (active.has("polymarket")) out.push({ venue: "polymarket", status: "no_reader", reason: "no reader for polymarket", scope: "ledger_orders_only", how: "not read", orders: [], unread: [] });
  return out;
}
