/**
 * Choose the hedge executor from the environment.
 *
 *   EVENT_HEDGE_STRATEGY=book   (default) simulated fill at the walked book
 *   EVENT_HEDGE_STRATEGY=rfq    RFQ first, book fallback — only venues with
 *                               credentials get an RFQ client; the rest fall
 *                               straight to the book
 *   EVENT_HEDGE_RFQ_WAIT_MS / EVENT_HEDGE_RFQ_POLL_MS  maker wait and poll
 *   EVENT_HEDGE_STRATEGY=live   a real order on Kalshi behind the rails in
 *                               liveHedge.ts (kill switch, allowlist, caps,
 *                               dry run on unless EVENT_HEDGE_LIVE_SEND=yes);
 *                               everything the rails hold is simulated at the
 *                               book, with the reason on the receipt
 *
 * Credentials: KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY_PEM; POLY_API_KEY +
 * POLY_API_SECRET + POLY_API_PASSPHRASE + POLY_ADDRESS. Polymarket acceptance
 * also needs an order signer, which nothing here constructs: without one the
 * Polymarket client is read-only and the executor records that as the reason.
 *
 * Builder attribution: POLYMARKET_BUILDER_CODE (public bytes32) rides on every
 * Polymarket order we place. It is read in both modes so healthz can confirm
 * the deploy carries it before RFQ is ever switched on; in book mode nothing
 * is sent, so it changes nothing there.
 *
 * The shadow runs with the default. An RFQ is a real request to real makers;
 * turning it on is a deploy-time decision, never a code default.
 */

import {
  BookHedgeExecutor,
  DEFAULT_RFQ_OPTIONS,
  RfqHedgeExecutor,
  loadHedgeReceipts,
  type HedgeExecutor,
  type HedgeStrategy,
  type HedgeVenue,
  type RfqClient,
} from "./hedgeExecutor";
import { KalshiOrderClient } from "./kalshiOrders";
import { KalshiRfqClient, kalshiRfqCredentialsFromEnv } from "./kalshiRfq";
import { LiveHedgeExecutor, liveRailsFromEnv, sentUnitsMilliOn, type LiveHedgeRails, type LiveOrderHook } from "./liveHedge";
import {
  PolymarketRfqClient,
  maskBuilderCode,
  polymarketBuilderCodeFromEnv,
  polymarketRfqCredentialsFromEnv,
  type PolymarketOrderSigner,
} from "./polymarketRfq";

/** The live rails as healthz shows them: settings and counts, nothing that signs. */
export interface LiveHedgeView {
  dryRun: boolean;
  killSwitch: boolean;
  /** venues with a live order client (credentials present) */
  venues: HedgeVenue[];
  allowlist: string[];
  maxContractsPerOrder: number;
  maxContractsPerDay: number;
}

export interface HedgeExecutorChoice {
  executor: HedgeExecutor;
  strategy: HedgeStrategy;
  /** venues with an RFQ client that can accept quotes */
  rfqVenues: HedgeVenue[];
  /** why each venue lacks a usable RFQ client, for healthz */
  notes: string[];
  /** Polymarket builder attribution as this deploy will send it (masked), or null when unattributed */
  polymarketBuilderCode: string | null;
  /** the live rails, in live mode only */
  live: LiveHedgeView | null;
  /** the Kalshi order client when credentials exist in live mode, for the operator's pre-flight */
  kalshiOrders: KalshiOrderClient | null;
}

export interface HedgeExecutorEnvOptions {
  /** the receipt trail; the live path counts the day's sent orders from it */
  receiptsPath?: string;
  /** test seam: build the live hooks from credentials without a network client */
  liveHooks?: Partial<Record<HedgeVenue, LiveOrderHook>>;
}

function liveView(rails: LiveHedgeRails, venues: HedgeVenue[]): LiveHedgeView {
  return {
    dryRun: rails.dryRun,
    killSwitch: rails.killSwitch,
    venues,
    allowlist: rails.allowlist,
    maxContractsPerOrder: rails.maxUnitsPerOrderMilli / 1000,
    maxContractsPerDay: rails.maxUnitsPerDayMilli / 1000,
  };
}

export function hedgeExecutorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  polymarketSigner: PolymarketOrderSigner | null = null,
  opts: HedgeExecutorEnvOptions = {},
): HedgeExecutorChoice {
  const raw = env.EVENT_HEDGE_STRATEGY?.trim().toLowerCase();
  const strategy: HedgeStrategy = raw === "rfq" ? "rfq" : raw === "live" ? "live" : "book";
  const builder = polymarketBuilderCodeFromEnv(env);
  const polymarketBuilderCode = builder.code ? maskBuilderCode(builder.code) : null;
  if (strategy === "book") {
    const notes = ["book: simulated fill at the walked terms"];
    if (builder.note) notes.push(builder.note);
    return { executor: new BookHedgeExecutor(), strategy, rfqVenues: [], notes, polymarketBuilderCode, live: null, kalshiOrders: null };
  }
  if (strategy === "live") {
    const rails = liveRailsFromEnv(env);
    const notes: string[] = [];
    const hooks: Partial<Record<HedgeVenue, LiveOrderHook>> = { ...(opts.liveHooks ?? {}) };
    let kalshiOrders: KalshiOrderClient | null = null;
    const kCreds = kalshiRfqCredentialsFromEnv(env);
    if (kCreds && !hooks.kalshi) {
      kalshiOrders = new KalshiOrderClient(kCreds);
      hooks.kalshi = kalshiOrders.hook();
    } else if (!kCreds && !hooks.kalshi) {
      notes.push("kalshi: no KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY_PEM; live orders impossible; every hedge simulated");
    }
    const venues = (Object.keys(hooks) as HedgeVenue[]).filter((v) => hooks[v]);
    notes.push(rails.killSwitch ? "live: KILL SWITCH ON; nothing is sent" : rails.dryRun ? "live: dry run; orders built and held, EVENT_HEDGE_LIVE_SEND=yes to send" : "live: SENDING real orders");
    notes.push(
      rails.allowlist.length === 0
        ? "live: EVENT_HEDGE_LIVE_TICKERS is empty; no ticker may trade"
        : `live: ${rails.allowlist.length} ticker(s) allowlisted; caps ${rails.maxUnitsPerOrderMilli / 1000} per order, ${rails.maxUnitsPerDayMilli / 1000} per day`,
    );
    notes.push("polymarket: no live order client; book only");
    if (builder.note) notes.push(builder.note);
    const receiptsPath = opts.receiptsPath;
    const sentToday = (day: string): number => (receiptsPath ? sentUnitsMilliOn(loadHedgeReceipts(receiptsPath), day) : 0);
    if (!receiptsPath) notes.push("live: no receipts path; the daily cap counts from zero every hedge");
    return {
      executor: new LiveHedgeExecutor(hooks, rails, sentToday),
      strategy,
      rfqVenues: [],
      notes,
      polymarketBuilderCode,
      live: liveView(rails, venues),
      kalshiOrders,
    };
  }
  const clients: Partial<Record<HedgeVenue, RfqClient>> = {};
  const notes: string[] = [];
  const rfqVenues: HedgeVenue[] = [];

  const kCreds = kalshiRfqCredentialsFromEnv(env);
  if (kCreds) {
    clients.kalshi = new KalshiRfqClient(kCreds);
    rfqVenues.push("kalshi");
  } else {
    notes.push("kalshi: no KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY_PEM; book only");
  }

  const pCreds = polymarketRfqCredentialsFromEnv(env);
  if (pCreds) {
    const client = new PolymarketRfqClient(pCreds, polymarketSigner, { builderCode: builder.code });
    clients.polymarket = client;
    if (client.canExecute()) rfqVenues.push("polymarket");
    else notes.push("polymarket: credentials present, no order signer; quotes readable, not acceptable; book only");
    if (builder.note) notes.push(builder.note);
    else if (!builder.code) notes.push("polymarket: no POLYMARKET_BUILDER_CODE; orders unattributed");
  } else {
    notes.push("polymarket: no POLY_API_KEY / POLY_API_SECRET / POLY_API_PASSPHRASE / POLY_ADDRESS; book only");
    if (builder.note) notes.push(builder.note);
  }

  const rfqOpts = {
    waitMs: Number(env.EVENT_HEDGE_RFQ_WAIT_MS || DEFAULT_RFQ_OPTIONS.waitMs),
    pollMs: Number(env.EVENT_HEDGE_RFQ_POLL_MS || DEFAULT_RFQ_OPTIONS.pollMs),
  };
  return {
    executor: new RfqHedgeExecutor(clients, null, rfqOpts),
    strategy,
    rfqVenues,
    notes,
    polymarketBuilderCode,
    live: null,
    kalshiOrders: null,
  };
}
