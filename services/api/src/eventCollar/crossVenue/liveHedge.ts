/**
 * LIVE HEDGE — a real order on the venue, behind rails.
 *
 * The shadow has filled every hedge at the walked book, on paper. This is the
 * one strategy that sends an order. It is built so that the dangerous thing
 * (money leaving on a real venue) needs several deliberate settings at once,
 * and so that every decision, sent or not, is in the receipt trail.
 *
 * Rails, checked in this order on every hedge:
 *   kill switch   EVENT_HEDGE_KILL_SWITCH=1          nothing is sent, ever
 *   venue         a live client exists for the venue   (only Kalshi today; our own key on the
 *                 venue, or the aggregator's pod with EVENT_HEDGE_LIVE_VIA=aggregator — same
 *                 rails either way, the fill records which path it took)
 *   ticker        EVENT_HEDGE_LIVE_TICKERS=A,B,C      allowlist; empty allows nothing;
 *                 `*` allows any ticker the engine priced (a pilot where holders
 *                 pick their own games); the caps below still bound every order
 *   per order     EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_ORDER   default 25
 *   per day       EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_DAY     default 100, UTC day,
 *                 counted from the receipt trail (every order sent, filled or not)
 *   dry run       EVENT_HEDGE_LIVE_SEND=yes            anything else builds the
 *                 order, records it, and does not send
 *
 * What a refused or held hedge does: falls back to the simulated book fill the
 * shadow has always recorded, with the reason on the receipt. The record keeps
 * its numbers; the trail says which hedges were real.
 *
 * The order itself is a limit buy of the hedge side at or under the walked
 * worst price, immediate-or-cancel: never worse than quoted, never resting.
 * Partial fills are recorded as partial (units filled, cents paid); a zero
 * fill is an error and falls back like any other.
 *
 * Nothing here holds credentials. The venue client is injected.
 */

import {
  BookHedgeExecutor,
  REAL_CLOCK,
  bookWalkPenaltyCents,
  errText,
  receiptId,
  type ExecutorClock,
  type HedgeAttempt,
  type HedgeExecutor,
  type HedgeFill,
  type HedgeIntent,
  type HedgeReceipt,
  type HedgeVenue,
  type HedgeVia,
} from "./hedgeExecutor";

/** What the venue reports back for one live order. */
export interface LiveOrderResult {
  orderId: string;
  /** units filled, milli; may be under the intent on a partial */
  unitsMilli: number;
  /** average all-in price paid per unit, milli dollars */
  avgPriceMilli: number;
  /** all-in cents paid, fees included */
  costCents: number;
  feesCents: number;
  /** the venue's final word on the order (executed, canceled, ...) */
  status: string;
  /** how the order reached the venue; absent means our own key on the venue */
  via?: HedgeVia;
  /** the venue's own id when the order went through an intermediary that issued `orderId` */
  venueOrderId?: string;
}

/** Place the order for an intent. Throws when nothing filled or the venue refused. */
export type LiveOrderHook = (intent: HedgeIntent, clientOrderId: string) => Promise<LiveOrderResult>;

export interface LiveHedgeRails {
  killSwitch: boolean;
  dryRun: boolean;
  /** instruments (Kalshi tickers) allowed to trade; empty allows nothing */
  allowlist: string[];
  /** `*` in the allowlist: any ticker may trade; `allowlist` then holds only the named ones */
  anyTicker: boolean;
  maxUnitsPerOrderMilli: number;
  maxUnitsPerDayMilli: number;
}

export const DEFAULT_LIVE_RAILS: LiveHedgeRails = {
  killSwitch: false,
  dryRun: true,
  allowlist: [],
  anyTicker: false,
  maxUnitsPerOrderMilli: 25_000,
  maxUnitsPerDayMilli: 100_000,
};

/** Is this instrument armed for a live order under these rails? */
export function tickerArmed(rails: Pick<LiveHedgeRails, "allowlist" | "anyTicker">, instrument: string): boolean {
  return rails.anyTicker || rails.allowlist.includes(instrument.toUpperCase());
}

const truthy = (v: string | undefined): boolean => /^(1|true|yes|on)$/i.test((v ?? "").trim());

function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number((v ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function liveRailsFromEnv(env: NodeJS.ProcessEnv = process.env): LiveHedgeRails {
  const listed = (env.EVENT_HEDGE_LIVE_TICKERS ?? "")
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  const anyTicker = listed.includes("*");
  const allowlist = [...new Set(listed.filter((t) => t !== "*"))];
  return {
    killSwitch: truthy(env.EVENT_HEDGE_KILL_SWITCH),
    // the one setting that lets money move is spelled out, not a bare flag
    dryRun: (env.EVENT_HEDGE_LIVE_SEND ?? "").trim().toLowerCase() !== "yes",
    allowlist,
    anyTicker,
    maxUnitsPerOrderMilli: positiveInt(env.EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_ORDER, DEFAULT_LIVE_RAILS.maxUnitsPerOrderMilli / 1000) * 1000,
    maxUnitsPerDayMilli: positiveInt(env.EVENT_HEDGE_LIVE_MAX_CONTRACTS_PER_DAY, DEFAULT_LIVE_RAILS.maxUnitsPerDayMilli / 1000) * 1000,
  };
}

export type LiveRail = "kill_switch" | "venue" | "ticker" | "per_order" | "per_day";
export type RailRefusal = { rail: LiveRail; detail: string };

const units = (milli: number): string => `${milli / 1000}`;

/** The pre-trade checks, pure. `sentTodayMilli` is what the trail says already went out this UTC day. */
export function checkRails(
  intent: HedgeIntent,
  rails: LiveHedgeRails,
  sentTodayMilli: number,
  hasClient: boolean,
): RailRefusal | null {
  if (rails.killSwitch) return { rail: "kill_switch", detail: "kill switch is on; no order leaves" };
  if (!hasClient) return { rail: "venue", detail: `no live client for ${intent.venue}` };
  if (!tickerArmed(rails, intent.instrument)) {
    return { rail: "ticker", detail: `${intent.instrument} is not on the live allowlist (${rails.allowlist.length} tickers)` };
  }
  if (intent.unitsMilli > rails.maxUnitsPerOrderMilli) {
    return {
      rail: "per_order",
      detail: `${units(intent.unitsMilli)} contracts over the per-order cap of ${units(rails.maxUnitsPerOrderMilli)}`,
    };
  }
  if (sentTodayMilli + intent.unitsMilli > rails.maxUnitsPerDayMilli) {
    return {
      rail: "per_day",
      detail: `${units(sentTodayMilli)} sent today plus ${units(intent.unitsMilli)} would pass the daily cap of ${units(rails.maxUnitsPerDayMilli)}`,
    };
  }
  return null;
}

/**
 * Units sent to a venue on one UTC day, from the trail. Every order that was
 * sent counts for its full requested size, filled or not, errored or not: an
 * HTTP error after the venue took the order is still an order.
 */
export function sentUnitsMilliOn(receipts: HedgeReceipt[], dayUtc: string): number {
  let sum = 0;
  for (const r of receipts) {
    if (r.at.slice(0, 10) !== dayUtc) continue;
    if (r.attempts.some((a) => a.strategy === "live" && a.step === "order")) sum += r.intent.unitsMilli;
  }
  return sum;
}

/** The order the live path would send, for the dry-run receipt and the operator's eyes. No credentials, no ids. */
export function describeOrder(intent: HedgeIntent): string {
  const cap = Math.ceil(intent.book.worstPriceMilli / 10);
  return `${intent.venue} buy ${units(intent.unitsMilli)} ${intent.outcome} on ${intent.instrument} at or under ${cap}c, immediate or cancel`;
}

export class LiveHedgeExecutor implements HedgeExecutor {
  readonly strategy = "live" as const;
  private readonly book: BookHedgeExecutor;

  constructor(
    private readonly clients: Partial<Record<HedgeVenue, LiveOrderHook>>,
    private readonly rails: LiveHedgeRails,
    /** what the trail says was sent on a UTC day ("YYYY-MM-DD"); read fresh on every hedge */
    private readonly sentToday: (dayUtc: string) => number,
    private readonly clock: ExecutorClock = REAL_CLOCK,
  ) {
    this.book = new BookHedgeExecutor(null, clock);
  }

  async execute(intent: HedgeIntent, ref: string): Promise<HedgeReceipt> {
    const at = this.clock.now().toISOString();
    const attempts: HedgeAttempt[] = [];
    const base = { id: receiptId(intent, at), at, ref, intent, bookWalkPenaltyCents: bookWalkPenaltyCents(intent) };
    const simulated = async (reason: string): Promise<HedgeReceipt> => {
      const fill = await this.book.fillBook(intent, attempts);
      return { ...base, attempts, fill, outcome: fill ? "filled_book" : "unfilled", fallbackReason: reason };
    };

    const client = this.clients[intent.venue];
    const sentTodayMilli = this.sentToday(at.slice(0, 10));
    const refusal = checkRails(intent, this.rails, sentTodayMilli, Boolean(client));
    if (refusal || !client) {
      const r = refusal ?? { rail: "venue" as const, detail: `no live client for ${intent.venue}` };
      attempts.push({ strategy: "live", step: "rails", ok: false, at, detail: r.detail, rail: r.rail });
      return simulated(`rail ${r.rail}: ${r.detail}`);
    }
    attempts.push({
      strategy: "live",
      step: "rails",
      ok: true,
      at,
      detail: `${intent.instrument} allowlisted; ${units(intent.unitsMilli)} of ${units(this.rails.maxUnitsPerOrderMilli)} per order; ${units(sentTodayMilli)} of ${units(this.rails.maxUnitsPerDayMilli)} sent today`,
    });

    if (this.rails.dryRun) {
      attempts.push({
        strategy: "live",
        step: "dry_run",
        ok: true,
        at: this.clock.now().toISOString(),
        detail: `dry run: ${describeOrder(intent)}; not sent`,
        unitsMilli: intent.unitsMilli,
        costCents: intent.book.costCents,
      });
      return simulated("dry run");
    }

    const clientOrderId = `atticus-${base.id}`;
    try {
      const r = await client(intent, clientOrderId);
      const partial = r.unitsMilli < intent.unitsMilli;
      const via: HedgeVia = r.via ?? "direct";
      attempts.push({
        strategy: "live",
        step: "order",
        ok: true,
        at: this.clock.now().toISOString(),
        detail: `order ${r.orderId}${r.venueOrderId ? ` (venue ${r.venueOrderId})` : ""} ${r.status}${via === "aggregator" ? " via aggregator" : ""}: ${units(r.unitsMilli)} of ${units(intent.unitsMilli)} filled at ${r.avgPriceMilli} milli, ${r.costCents}c all in${partial ? " (partial)" : ""}`,
        orderId: r.orderId,
        unitsMilli: r.unitsMilli,
        costCents: r.costCents,
      });
      // the book the holder was quoted against, pro rata to what filled; cents kept can be negative on a partial
      const bookForFilled = Math.round((intent.book.costCents * r.unitsMilli) / intent.unitsMilli);
      const fill: HedgeFill = {
        strategy: "live",
        venue: intent.venue,
        instrument: intent.instrument,
        unitsMilli: r.unitsMilli,
        avgPriceMilli: r.avgPriceMilli,
        costCents: r.costCents,
        vsBookCents: bookForFilled - r.costCents,
        simulated: false,
        ids: { orderId: r.orderId, ...(r.venueOrderId ? { venueOrderId: r.venueOrderId } : {}) },
        via,
      };
      return { ...base, attempts, fill, outcome: "filled_live", fallbackReason: null };
    } catch (err) {
      attempts.push({
        strategy: "live",
        step: "order",
        ok: false,
        at: this.clock.now().toISOString(),
        detail: errText(err),
        unitsMilli: intent.unitsMilli,
      });
      return simulated(`order failed: ${errText(err)}`);
    }
  }
}
