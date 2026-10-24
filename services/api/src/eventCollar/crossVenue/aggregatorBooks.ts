/**
 * AGGREGATOR BOOKS: the partner's cross-venue feed as the FIRST source of the books a quote is
 * priced from, with the direct venue APIs behind it.
 *
 * The quote today reads two books per pair straight from the venues: the opposing outcome's asks
 * on the second venue (the cross-venue hedge) and the market's own No side (the self hedge). The
 * aggregator carries both, plus the same outcome on the venues this service has no direct read
 * for, aligned by one lookup on our ticker. With a data key in the env, one read here returns:
 *
 *   - pmNoBook   the opposing outcome's book on the second venue, in the shape the pricer walks;
 *   - noAsks     the No side of our own market, derived from the YES-priced book the aggregator
 *                streams (price flips, sides swap, sizes carry);
 *   - references the opposing outcome on every other venue the aggregator lists, each as a
 *                reference book (priced like a route, filled on none).
 *
 * The caller uses what came back and reads the venue directly for anything missing, so a
 * partner outage degrades to today's path rather than to a refusal. Fail closed everywhere: the
 * mapping has to agree with ours before its book is trusted (a token that differs from the pair's
 * is a note, never a quote), a snapshot older than the staleness bound is dropped, and nothing in
 * this module throws to the caller.
 *
 * Secrets: AGGREGATOR_KEY_ID and AGGREGATOR_PRIVATE_KEY_HEX, service env only (aggregatorMarkets.ts).
 * The partner is never named in anything published: "the aggregator" in notes and status.
 */

import {
  AggregatorApiError,
  AggregatorClient,
  aggregatorConfigFromEnv,
  alignedByTicker,
  kalshiNoView,
  readSnapshots,
  signerFromSecret,
  streamFor,
  type AggregatorSigner,
  type BookSnapshot,
  type Level,
  type Listing,
  type Market,
  type MarketStream,
  type StreamResult,
  type WsFactory,
} from "./aggregatorMarkets";
import type { NoAskLevel } from "./kalshiLadder";
import type { MatchedPair, PmBook, PmBookLevel } from "./types";
import type { ReferenceBook } from "./venueBooks";

/** Where a book the quote was priced from came from. */
export type BookOrigin = "aggregator" | "direct";
export interface BookOrigins {
  polymarket?: BookOrigin;
  kalshi?: BookOrigin;
}

export interface AggregatorBooks {
  pmNoBook?: PmBook;
  noAsks?: NoAskLevel[];
  references: ReferenceBook[];
  /** why a book is absent, one line per venue; never thrown */
  notes: string[];
  readAtIso: string;
}

export interface AggregatorBookSource {
  read(pair: MatchedPair, now: Date): Promise<AggregatorBooks>;
  status(): AggregatorBookStatus;
}

export interface AggregatorBookStatus {
  configured: true;
  host: string;
  /** the key id's last six characters: enough to tell two keys apart, not enough to use */
  keyIdTail: string;
  /** the public key the secret derives, hex: compare with what the partner registered when a 401 appears */
  publicKeyHex: string;
  lastReadAt: string | null;
  lastError: string | null;
  reads: number;
  /** reads where at least one priced book came back */
  readsWithBooks: number;
  /** the pair's second-venue token disagreed with the aggregator's mapping; the direct read was used */
  mappingMismatches: number;
}

/** A snapshot older than this is not a price a quote can stand on. */
export const MAX_SNAPSHOT_AGE_MS = 90_000;
/** The lookup is a mapping, not a price: it holds for this long per ticker. */
const LOOKUP_TTL_MS = 15 * 60_000;
/** Spacing between REST calls, under the partner's 10 rps. */
const REST_SPACING_MS = 125;

// ---------------------------------------------------------------------------
// book arithmetic: stream levels to the shapes the pricers walk
// ---------------------------------------------------------------------------

/** Stream levels (price in [0,1], size in shares) as the pricer's milli units, best ask first. */
export function pmBookFromSnapshot(tokenId: string, book: Pick<BookSnapshot, "bids" | "asks">): PmBook {
  const level = (l: Level): PmBookLevel | null => {
    const priceMilli = Math.round(l.price * 1000);
    const sizeMilli = Math.floor(l.size * 1000);
    return priceMilli > 0 && priceMilli < 1000 && sizeMilli > 0 ? { priceMilli, sizeMilli } : null;
  };
  const asks = book.asks.map(level).filter((l): l is PmBookLevel => l !== null).sort((a, b) => a.priceMilli - b.priceMilli);
  const bids = book.bids.map(level).filter((l): l is PmBookLevel => l !== null).sort((a, b) => b.priceMilli - a.priceMilli);
  // the venue's published minimum order (5 shares) and tick (1 cent) when the stream does not say
  return { tokenId, asks, bids, minOrderSizeShares: 5, tickMilli: 10 };
}

/**
 * The No side of a Kalshi market from its YES-priced book: each YES bid is a No ask at 100 minus
 * the bid, with the bid's size; cheapest first. Sizes truncate down, against the depth we trust.
 */
export function noAsksFromSnapshot(book: Pick<BookSnapshot, "bids" | "asks">): NoAskLevel[] {
  return kalshiNoView(book)
    .asks.map((l) => ({ priceCents: Math.round(l.price * 100), qtyMilli: Math.floor(l.size * 1000) }))
    .filter((l) => l.priceCents > 0 && l.priceCents < 100 && l.qtyMilli > 0)
    .sort((a, b) => a.priceCents - b.priceCents);
}

/** Is this snapshot fresh enough to price from? Unstamped snapshots are taken at the read time. */
export function snapshotFresh(book: BookSnapshot, nowMs: number, maxAgeMs = MAX_SNAPSHOT_AGE_MS): boolean {
  const ts = book.venueTimestamp || book.serverTimestamp;
  if (!ts) return true;
  const tsMs = ts < 1e12 ? ts * 1000 : ts; // seconds or milliseconds, as the venue stamps it
  return nowMs - tsMs <= maxAgeMs;
}

// ---------------------------------------------------------------------------
// alignment: our ticker to the opposing outcome on every venue
// ---------------------------------------------------------------------------

export interface AlignedPair {
  marketId: string;
  title: string;
  /** our side (the ticker's YES) on every venue */
  ours: Listing[];
  /** the other side of the same two-outcome market on every venue: the hedge instrument */
  opposing: Listing[];
}

/**
 * The market whose outcome carries our ticker's YES listing, and the one other outcome of that
 * market. A market with more than two outcomes is not a game winner and is skipped.
 */
export function alignPair(markets: Market[], ticker: string): AlignedPair | null {
  const aligned = alignedByTicker(markets, ticker);
  if (!aligned) return null;
  const market = markets.find((m) => m.id === aligned.marketId);
  if (!market || market.outcomes.length !== 2) return null;
  const other = market.outcomes.find((o) => o.name !== aligned.outcome);
  if (!other) return null;
  return { marketId: market.id, title: market.title, ours: aligned.listings, opposing: other.listings };
}

const listingOf = <V extends Listing["venue"]>(listings: Listing[], venue: V): Extract<Listing, { venue: V }> | undefined =>
  listings.find((l): l is Extract<Listing, { venue: V }> => l.venue === venue);

// ---------------------------------------------------------------------------
// the source
// ---------------------------------------------------------------------------

export interface AggregatorSourceOptions {
  fetchImpl?: typeof fetch;
  wsFactory?: WsFactory;
  streamUrl?: string;
  /** one stream read is given this long before pending markets come back unavailable */
  streamTimeoutMs?: number;
  nowMs?: () => number;
  maxSnapshotAgeMs?: number;
}

export function aggregatorBookSource(signer: AggregatorSigner, host: string, opts: AggregatorSourceOptions = {}): AggregatorBookSource {
  const nowMs = opts.nowMs ?? (() => Date.now());
  const client = new AggregatorClient({ host, signer, fetchImpl: opts.fetchImpl, nowSec: () => Math.floor(nowMs() / 1000) });
  const lookups = new Map<string, { at: number; aligned: AlignedPair | null }>();
  const status: AggregatorBookStatus = {
    configured: true,
    host,
    keyIdTail: signer.keyId.slice(-6),
    publicKeyHex: signer.publicKeyHex,
    lastReadAt: null,
    lastError: null,
    reads: 0,
    readsWithBooks: 0,
    mappingMismatches: 0,
  };
  let clockSynced = false;
  let chain: Promise<unknown> = Promise.resolve();
  /** one REST call at a time, spaced: the partner's limit is shared by every pair the scan prices */
  const spaced = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.then(
      () => new Promise((r) => setTimeout(r, REST_SPACING_MS)),
      () => new Promise((r) => setTimeout(r, REST_SPACING_MS)),
    );
    return next;
  };

  const align = async (ticker: string): Promise<AlignedPair | null> => {
    const cached = lookups.get(ticker);
    if (cached && nowMs() - cached.at < LOOKUP_TTL_MS) return cached.aligned;
    if (!clockSynced) {
      await spaced(() => client.time());
      clockSynced = true;
    }
    const markets = await spaced(() => client.lookupMarket({ ticker }));
    const aligned = alignPair(markets, ticker);
    lookups.set(ticker, { at: nowMs(), aligned });
    return aligned;
  };

  const read = async (pair: MatchedPair, now: Date): Promise<AggregatorBooks> => {
    const out: AggregatorBooks = { references: [], notes: [], readAtIso: now.toISOString() };
    status.reads += 1;
    status.lastReadAt = out.readAtIso;
    let aligned: AlignedPair | null;
    try {
      aligned = await align(pair.kalshi.ticker);
    } catch (err) {
      status.lastError = describe(err);
      out.notes.push(`aggregator lookup: ${status.lastError}`);
      return out;
    }
    if (!aligned) {
      out.notes.push("aggregator lookup: ticker not mapped");
      return out;
    }

    // The books to stream: our own market (YES-priced, for the No side), the opposing outcome on
    // the second venue, and the opposing outcome everywhere else as references.
    const ourKalshi = listingOf(aligned.ours, "KALSHI");
    const oppPm = listingOf(aligned.opposing, "POLYMARKET");
    const pairToken = pair.pm.tokenIds[pair.pmNoOutcomeIndex];
    let pmStream: MarketStream | null = null;
    if (oppPm) {
      if (oppPm.tokenId === pairToken) pmStream = { venue: "POLYMARKET", tokenId: oppPm.tokenId };
      else {
        status.mappingMismatches += 1;
        out.notes.push(`aggregator: second-venue token for the opposing outcome differs from the pair's (…${oppPm.tokenId.slice(-6)} vs …${pairToken.slice(-6)}); direct read used`);
      }
    } else out.notes.push("aggregator: opposing outcome not listed on the second venue");
    const kalshiStream: MarketStream | null = ourKalshi ? { venue: "KALSHI", ticker: ourKalshi.ticker } : null;
    if (!kalshiStream) out.notes.push("aggregator: our market's own book not in the mapping");
    const refStreams: { listing: Listing; stream: MarketStream }[] = [];
    for (const l of aligned.opposing) {
      if (l.venue === "POLYMARKET" || l.venue === "KALSHI") continue;
      const s = streamFor(l);
      if (s) refStreams.push({ listing: l, stream: s });
    }
    const streams = [kalshiStream, pmStream, ...refStreams.map((r) => r.stream)].filter((s): s is MarketStream => s !== null);
    if (streams.length === 0) return out;

    let results: StreamResult[];
    try {
      results = await readSnapshots(signer, streams, {
        streamUrl: opts.streamUrl,
        wsFactory: opts.wsFactory,
        timeoutMs: opts.streamTimeoutMs ?? 6_000,
        nowSec: () => Math.floor(nowMs() / 1000),
      });
    } catch (err) {
      status.lastError = describe(err);
      out.notes.push(`aggregator stream: ${status.lastError}`);
      return out;
    }
    const maxAge = opts.maxSnapshotAgeMs ?? MAX_SNAPSHOT_AGE_MS;
    const fresh = (r: StreamResult, what: string): BookSnapshot | null => {
      if (!r.book) {
        out.notes.push(`aggregator ${what}: ${r.error.code}${r.error.message ? ` ${r.error.message}` : ""}`);
        return null;
      }
      if (!snapshotFresh(r.book, nowMs(), maxAge)) {
        out.notes.push(`aggregator ${what}: snapshot stale`);
        return null;
      }
      return r.book;
    };
    let i = 0;
    if (kalshiStream) {
      const b = fresh(results[i++], "own market");
      if (b) {
        const asks = noAsksFromSnapshot(b);
        if (asks.length) out.noAsks = asks;
        else out.notes.push("aggregator own market: no bids to buy No against");
      }
    }
    if (pmStream) {
      const b = fresh(results[i++], "second venue");
      if (b) out.pmNoBook = pmBookFromSnapshot(pmStream.tokenId, b);
    }
    for (const r of refStreams) {
      const res = results[i++];
      const id: ReferenceBook["id"] = r.listing.venue === "PROPHETX" ? "aggregated_mm" : "aggregated_other";
      if (!res.book) out.references.push({ id, book: null, reason: `stream_${res.error.code.toLowerCase()}` });
      else if (!snapshotFresh(res.book, nowMs(), maxAge)) out.references.push({ id, book: null, reason: "stale" });
      else out.references.push({ id, book: pmBookFromSnapshot(`${r.listing.venue}:${aligned.marketId}`, res.book) });
    }
    if (out.pmNoBook || out.noAsks) status.readsWithBooks += 1;
    status.lastError = null;
    return out;
  };

  return { read, status: () => ({ ...status }) };
}

const describe = (err: unknown): string => {
  if (err instanceof AggregatorApiError) return `${err.status} ${err.code}`;
  return String(err instanceof Error ? err.message : err).slice(0, 120);
};

/** The source when both halves of the key are set; null and a note otherwise. Nothing set, nothing read. */
export function aggregatorBookSourceFromEnv(env: NodeJS.ProcessEnv = process.env, opts: AggregatorSourceOptions = {}): { source: AggregatorBookSource | null; notes: string[] } {
  const cfg = aggregatorConfigFromEnv(env);
  if (!cfg) {
    const partial = Boolean(env.AGGREGATOR_KEY_ID?.trim() || env.AGGREGATOR_PRIVATE_KEY_HEX?.trim());
    return { source: null, notes: partial ? ["aggregator: key id and private key must both be set; off"] : [] };
  }
  try {
    const signer = signerFromSecret(cfg.keyId, cfg.secret);
    return { source: aggregatorBookSource(signer, cfg.host, { streamUrl: cfg.streamUrl, ...opts }), notes: [] };
  } catch (err) {
    return { source: null, notes: [`aggregator: key unusable (${describe(err)})`] };
  }
}
