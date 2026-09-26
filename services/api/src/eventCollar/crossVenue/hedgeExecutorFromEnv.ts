/**
 * Choose the hedge executor from the environment.
 *
 *   EVENT_HEDGE_STRATEGY=book   (default) simulated fill at the walked book
 *   EVENT_HEDGE_STRATEGY=rfq    RFQ first, book fallback — only venues with
 *                               credentials get an RFQ client; the rest fall
 *                               straight to the book
 *   EVENT_HEDGE_RFQ_WAIT_MS / EVENT_HEDGE_RFQ_POLL_MS  maker wait and poll
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
  type HedgeExecutor,
  type HedgeVenue,
  type RfqClient,
} from "./hedgeExecutor";
import { KalshiRfqClient, kalshiRfqCredentialsFromEnv } from "./kalshiRfq";
import {
  PolymarketRfqClient,
  maskBuilderCode,
  polymarketBuilderCodeFromEnv,
  polymarketRfqCredentialsFromEnv,
  type PolymarketOrderSigner,
} from "./polymarketRfq";

export interface HedgeExecutorChoice {
  executor: HedgeExecutor;
  strategy: "book" | "rfq";
  /** venues with an RFQ client that can accept quotes */
  rfqVenues: HedgeVenue[];
  /** why each venue lacks a usable RFQ client, for healthz */
  notes: string[];
  /** Polymarket builder attribution as this deploy will send it (masked), or null when unattributed */
  polymarketBuilderCode: string | null;
}

export function hedgeExecutorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  polymarketSigner: PolymarketOrderSigner | null = null,
): HedgeExecutorChoice {
  const strategy = env.EVENT_HEDGE_STRATEGY?.trim().toLowerCase() === "rfq" ? "rfq" : "book";
  const builder = polymarketBuilderCodeFromEnv(env);
  const polymarketBuilderCode = builder.code ? maskBuilderCode(builder.code) : null;
  if (strategy === "book") {
    const notes = ["book: simulated fill at the walked terms"];
    if (builder.note) notes.push(builder.note);
    return { executor: new BookHedgeExecutor(), strategy, rfqVenues: [], notes, polymarketBuilderCode };
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

  const opts = {
    waitMs: Number(env.EVENT_HEDGE_RFQ_WAIT_MS || DEFAULT_RFQ_OPTIONS.waitMs),
    pollMs: Number(env.EVENT_HEDGE_RFQ_POLL_MS || DEFAULT_RFQ_OPTIONS.pollMs),
  };
  return { executor: new RfqHedgeExecutor(clients, null, opts), strategy, rfqVenues, notes, polymarketBuilderCode };
}
