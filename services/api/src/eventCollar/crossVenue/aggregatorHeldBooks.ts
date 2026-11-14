/**
 * HELD BOOKS: one connection to the aggregator's stream, kept open, with a set of markets held
 * on it so the record sees a book the moment it opens rather than at the next scheduled read.
 *
 * Why: a venue that opens its books late is "mapped, no book yet" for most of a game's life
 * (aggregatorBooks.ts, the four states). The one-shot read (readSnapshots) sees that state at
 * open and again at the pre-lock re-read; whatever happened between is lost. The partner's
 * recommendation is to hold the subscription instead: the first SNAPSHOT with levels is the
 * venue opening the line, and that is the moment a late hedge would first have had a book.
 *
 * The protocol, as honoured here:
 *   - WELCOME, then one SUBSCRIBE for every held market; SUBSCRIBED keys each by subscriptionId.
 *   - SNAPSHOT replaces the book; DELTA mutates it (size 0 removes the level); a DELTA whose seq
 *     is not last + 1 drops the book and waits for the SNAPSHOT the contract guarantees.
 *   - STATUS RESYNCING drops the book (a SNAPSHOT follows); CLOSED ends the hold (settled);
 *     UNSUPPORTED stops it; UNAVAILABLE is retried on the slow cadence.
 *   - ERROR on a subscription tears it down: MARKET_NOT_YET_OPEN is resubscribed on the slow
 *     cadence (their window: books stream from about two days out), UNAVAILABLE and
 *     SERVICE_DEGRADED with backoff, anything else is final for that hold.
 *   - GOODBYE then close: reconnect (at once on TTL and SHUTDOWN, with backoff otherwise), and
 *     never on AUTH_REVOKED or KICKED. A TTL reconnect is scheduled ahead of the deadline. On
 *     every reconnect each held market is subscribed again and its SNAPSHOT rebuilds the book.
 *   - Nothing is sent before WELCOME; holds made before it are batched into that first frame.
 *
 * What a hold reports: its phase, the book, and the first moment levels appeared while held
 * (`onOpen`, once per hold). A book with levels on its very first SNAPSHOT opened before the
 * hold began; the event says so (`caught: "at_hold"`), because for the record the question is
 * how early the venue listed, not merely that it did.
 *
 * Nothing here names the partner or a venue. The signer is the data key's; it reads books only.
 */

import { DEFAULT_STREAM_URL, signedStreamUrl, streamKey, type AggregatorSigner, type Level, type MarketStream, type WsFactory, type WsLike } from "./aggregatorMarkets";

export type HeldPhase =
  /** subscribed or queued to be; no book in hand (never had one, or dropped for a resync/reconnect) */
  | "pending"
  /** a snapshot in hand with no level on either side: mapped, the venue has not opened the line */
  | "empty"
  /** levels on at least one side */
  | "open"
  /** the feed does not carry the book yet (their window); asked again on the slow cadence */
  | "not_yet_open"
  /** the feed could not stream it right now; asked again with backoff */
  | "unavailable"
  /** the market settled; nothing more will come */
  | "closed"
  /** a refusal that will not change (unknown market, unsupported, not authorised) */
  | "stopped";

export interface HeldBook {
  key: string;
  market: MarketStream;
  sinceIso: string;
  phase: HeldPhase;
  book: { bids: Level[]; asks: Level[] } | null;
  seq: number | null;
  venueTimestamp: number;
  lastFrameAtMs: number | null;
  snapshots: number;
  /** the first moment levels were seen while held; null until then */
  openedAtIso: string | null;
  /** levels were on the very first snapshot: the venue opened the line before the hold began */
  openBeforeHold: boolean;
  /** the last stream code or state that deferred or ended this hold */
  lastCode: string | null;
  retries: number;
  nextRetryAtMs: number | null;
}

export interface HeldBookOpen {
  key: string;
  market: MarketStream;
  book: { bids: Level[]; asks: Level[] };
  atIso: string;
  sinceIso: string;
  /** "live": the open was seen happen; "at_hold": the first snapshot already had levels */
  caught: "live" | "at_hold";
}

export interface HeldBooksOptions {
  streamUrl?: string;
  wsFactory?: WsFactory;
  nowMs?: () => number;
  /** once per hold, the first time its book has levels */
  onOpen?: (ev: HeldBookOpen) => void;
  onLog?: (line: string) => void;
  /** UNAVAILABLE / SERVICE_DEGRADED: first retry after this, doubling to the cap */
  unavailableRetryMs?: number;
  unavailableRetryCapMs?: number;
  /** MARKET_NOT_YET_OPEN and a STATUS of UNAVAILABLE: asked again at this interval */
  notYetOpenRetryMs?: number;
  /** reconnect backoff: first wait, doubling to the cap; TTL and SHUTDOWN reconnect at once */
  reconnectBaseMs?: number;
  reconnectCapMs?: number;
  /** reconnect this long before the connection's TTL so no frame is lost to it */
  ttlMarginMs?: number;
  /** holds past this are refused (the per-connection subscription cap) */
  maxHeld?: number;
}

export interface HeldBooksStatus {
  connected: boolean;
  connectionId: string | null;
  connects: number;
  held: number;
  byPhase: Record<HeldPhase, number>;
  /** holds whose book has shown levels, ever */
  opens: number;
  frames: number;
  lastFrameAt: string | null;
  lastError: string | null;
  lastGoodbye: string | null;
  /** set when the stream told us to stop for good (key revoked, kicked) */
  stopped: string | null;
  overCap: number;
}

export interface HeldBooks {
  hold(key: string, market: MarketStream): "held" | "already" | "over_cap" | "stopped";
  release(key: string): void;
  get(key: string): HeldBook | undefined;
  list(): HeldBook[];
  status(): HeldBooksStatus;
  /** close the connection and forget every hold; for shutdown and tests */
  close(): void;
}

const PHASES: HeldPhase[] = ["pending", "empty", "open", "not_yet_open", "unavailable", "closed", "stopped"];
const TERMINAL = new Set<HeldPhase>(["closed", "stopped"]);
/** stream codes a resubscribe can cure, by the partner's own table */
const RETRY_WITH_BACKOFF = new Set(["UNAVAILABLE", "SERVICE_DEGRADED"]);

const defaultWsFactory: WsFactory = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (u: string) => WsLike }).WebSocket;
  if (!Ctor) throw new Error("aggregator stream: no WebSocket implementation");
  return new Ctor(url);
};

/** Apply one DELTA's changes in place: set the level to the size, size 0 removes it; both sides re-sorted best first. */
export function applyDelta(book: { bids: Level[]; asks: Level[] }, changes: unknown): void {
  if (!Array.isArray(changes)) return;
  for (const raw of changes) {
    const c = raw as { side?: unknown; price?: unknown; size?: unknown };
    const price = Number(c.price);
    const size = Number(c.size);
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    const side = c.side === "BID" ? book.bids : c.side === "ASK" ? book.asks : null;
    if (!side) continue;
    const i = side.findIndex((l) => l.price === price);
    if (size <= 0) {
      if (i >= 0) side.splice(i, 1);
    } else if (i >= 0) side[i] = { price, size };
    else side.push({ price, size });
  }
  book.bids.sort((a, b) => b.price - a.price);
  book.asks.sort((a, b) => a.price - b.price);
}

const levels = (v: unknown): Level[] =>
  Array.isArray(v)
    ? v
        .map((l) => ({ price: Number((l as Level).price), size: Number((l as Level).size) }))
        .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0)
    : [];

export function heldBooks(signer: AggregatorSigner, opts: HeldBooksOptions = {}): HeldBooks {
  const nowMs = opts.nowMs ?? (() => Date.now());
  const streamUrl = opts.streamUrl ?? DEFAULT_STREAM_URL;
  const wsFactory = opts.wsFactory ?? defaultWsFactory;
  const unavailableRetryMs = opts.unavailableRetryMs ?? 60_000;
  const unavailableRetryCapMs = opts.unavailableRetryCapMs ?? 15 * 60_000;
  const notYetOpenRetryMs = opts.notYetOpenRetryMs ?? 30 * 60_000;
  const reconnectBaseMs = opts.reconnectBaseMs ?? 1_000;
  const reconnectCapMs = opts.reconnectCapMs ?? 60_000;
  const ttlMarginMs = opts.ttlMarginMs ?? 60_000;
  const maxHeld = opts.maxHeld ?? 200;
  const log = opts.onLog ?? (() => undefined);

  const held = new Map<string, HeldBook>();
  const keyByStream = new Map<string, string>();
  const keyBySub = new Map<string, string>();
  const subByKey = new Map<string, string>();
  const toSend = new Set<string>();
  const status: HeldBooksStatus = {
    connected: false,
    connectionId: null,
    connects: 0,
    held: 0,
    byPhase: Object.fromEntries(PHASES.map((p) => [p, 0])) as Record<HeldPhase, number>,
    opens: 0,
    frames: 0,
    lastFrameAt: null,
    lastError: null,
    lastGoodbye: null,
    stopped: null,
    overCap: 0,
  };

  let ws: WsLike | null = null;
  let welcomed = false;
  let connecting = false;
  let closedByUs = false;
  let reconnectAtOnce = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let ttlTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  let lastBatch: string[] = [];

  const iso = () => new Date(nowMs()).toISOString();
  const clear = (t: ReturnType<typeof setTimeout> | null) => {
    if (t) clearTimeout(t);
    return null;
  };

  // -------------------------------------------------------------------------
  // sending
  // -------------------------------------------------------------------------

  const send = (frame: Record<string, unknown>): boolean => {
    if (!ws || !welcomed) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      status.lastError = `send: ${String(err instanceof Error ? err.message : err)}`;
      return false;
    }
  };

  /** Batch every key queued in the same tick into one SUBSCRIBE; nothing goes before WELCOME. */
  const flushSubscribe = () => {
    sendTimer = null;
    if (!welcomed || toSend.size === 0) return;
    const keys = [...toSend].filter((k) => {
      const h = held.get(k);
      return h && !TERMINAL.has(h.phase) && !subByKey.has(k);
    });
    toSend.clear();
    if (!keys.length) return;
    lastBatch = keys;
    send({ type: "SUBSCRIBE", markets: keys.map((k) => held.get(k)!.market), channels: ["BOOK"], requestId: `held:${nowMs()}` });
  };
  const queueSubscribe = (keys: Iterable<string>) => {
    for (const k of keys) toSend.add(k);
    if (welcomed && !sendTimer) sendTimer = setTimeout(flushSubscribe, 20);
  };

  // -------------------------------------------------------------------------
  // retry cadence: one timer for the earliest due hold, firing for every hold due by then
  // -------------------------------------------------------------------------

  const armRetry = () => {
    retryTimer = clear(retryTimer);
    let earliest: number | null = null;
    for (const h of held.values()) if (h.nextRetryAtMs !== null && (earliest === null || h.nextRetryAtMs < earliest)) earliest = h.nextRetryAtMs;
    if (earliest === null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      const now = nowMs();
      const due: string[] = [];
      for (const h of held.values()) {
        if (h.nextRetryAtMs !== null && h.nextRetryAtMs <= now) {
          h.nextRetryAtMs = null;
          h.phase = "pending";
          due.push(h.key);
        }
      }
      if (due.length) {
        queueSubscribe(due);
        if (!ws && !connecting) connect();
      }
      armRetry();
    }, Math.max(0, earliest - nowMs()));
  };
  const deferHold = (h: HeldBook, phase: "not_yet_open" | "unavailable", code: string, delayMs: number) => {
    h.phase = phase;
    h.lastCode = code;
    h.book = null;
    h.seq = null;
    h.nextRetryAtMs = nowMs() + delayMs;
    armRetry();
  };
  const endHold = (h: HeldBook, phase: "closed" | "stopped", code: string) => {
    h.phase = phase;
    h.lastCode = code;
    h.book = null;
    h.seq = null;
    h.nextRetryAtMs = null;
  };
  const dropSub = (key: string) => {
    const sub = subByKey.get(key);
    if (sub !== undefined) {
      subByKey.delete(key);
      keyBySub.delete(sub);
    }
  };

  // -------------------------------------------------------------------------
  // the book
  // -------------------------------------------------------------------------

  const noteLevels = (h: HeldBook, firstSnapshot: boolean) => {
    const book = h.book!;
    const has = book.bids.length > 0 || book.asks.length > 0;
    h.phase = has ? "open" : "empty";
    if (!has || h.openedAtIso !== null) return;
    h.openedAtIso = iso();
    h.openBeforeHold = firstSnapshot;
    status.opens += 1;
    log(`held book ${h.key}: open${firstSnapshot ? " (already, at the first snapshot)" : ""} · ${book.bids.length}/${book.asks.length} levels`);
    try {
      opts.onOpen?.({ key: h.key, market: h.market, book: { bids: [...book.bids], asks: [...book.asks] }, atIso: h.openedAtIso, sinceIso: h.sinceIso, caught: firstSnapshot ? "at_hold" : "live" });
    } catch (err) {
      status.lastError = `onOpen: ${String(err instanceof Error ? err.message : err)}`;
    }
  };

  const onFrame = (f: Record<string, unknown>) => {
    status.frames += 1;
    status.lastFrameAt = iso();
    const type = f.type;
    const subId = typeof f.subscriptionId === "string" ? f.subscriptionId : null;

    if (type === "WELCOME") {
      welcomed = true;
      connecting = false;
      reconnectAttempts = 0;
      status.connected = true;
      status.connects += 1;
      status.connectionId = typeof f.connectionId === "string" ? f.connectionId : null;
      const ttlSec = Number((f.limits as { connectionTtlSeconds?: unknown } | undefined)?.connectionTtlSeconds);
      ttlTimer = clear(ttlTimer);
      if (Number.isFinite(ttlSec) && ttlSec > 0) {
        ttlTimer = setTimeout(() => {
          ttlTimer = null;
          reconnectAtOnce = true;
          log("held books: reconnecting ahead of the connection's TTL");
          closeSocket();
        }, Math.max(1_000, ttlSec * 1000 - ttlMarginMs));
      }
      // every hold that is not final goes on this connection; the ones in a retry wait keep their timer
      for (const h of held.values()) if (!TERMINAL.has(h.phase) && h.nextRetryAtMs === null) toSend.add(h.key);
      flushSubscribe();
      return;
    }
    if (type === "SUBSCRIBED") {
      const m = f.market as MarketStream | undefined;
      const key = m ? keyByStream.get(streamKey(m)) : undefined;
      if (!subId) return;
      const h = key ? held.get(key) : undefined;
      if (!key || !h || TERMINAL.has(h.phase)) {
        // released (or ended) before the ack arrived: do not leave it counting against the cap
        send({ type: "UNSUBSCRIBE", subscriptionIds: [subId], requestId: `stray:${nowMs()}` });
        return;
      }
      subByKey.set(key, subId);
      keyBySub.set(subId, key);
      return;
    }
    if (type === "SNAPSHOT") {
      const key = subId ? keyBySub.get(subId) : undefined;
      const h = key ? held.get(key) : undefined;
      if (!h) return;
      h.book = { bids: levels(f.bids), asks: levels(f.asks) };
      h.seq = Number(f.seq ?? 0);
      h.venueTimestamp = Number(f.venueTimestamp ?? 0);
      h.lastFrameAtMs = nowMs();
      h.snapshots += 1;
      h.lastCode = null;
      noteLevels(h, h.snapshots === 1);
      return;
    }
    if (type === "DELTA") {
      const key = subId ? keyBySub.get(subId) : undefined;
      const h = key ? held.get(key) : undefined;
      if (!h) return;
      h.lastFrameAtMs = nowMs();
      const seq = Number(f.seq ?? 0);
      if (!h.book || h.seq === null || seq !== h.seq + 1) {
        // a gap: the contract says a SNAPSHOT follows; until then there is no book
        h.book = null;
        h.seq = null;
        h.phase = "pending";
        return;
      }
      applyDelta(h.book, f.changes);
      h.seq = seq;
      h.venueTimestamp = Number(f.venueTimestamp ?? h.venueTimestamp);
      noteLevels(h, false);
      return;
    }
    if (type === "STATUS") {
      const key = subId ? keyBySub.get(subId) : undefined;
      const h = key ? held.get(key) : undefined;
      if (!h || !key) return;
      const state = String(f.state ?? "");
      if (state === "RESYNCING") {
        h.book = null;
        h.seq = null;
        h.phase = "pending";
        h.lastCode = "RESYNCING";
      } else if (state === "CLOSED") {
        dropSub(key);
        endHold(h, "closed", "CLOSED");
      } else if (state === "UNSUPPORTED") {
        dropSub(key);
        endHold(h, "stopped", "UNSUPPORTED");
      } else if (state === "UNAVAILABLE") {
        dropSub(key);
        deferHold(h, "unavailable", "STATUS_UNAVAILABLE", notYetOpenRetryMs);
      }
      return;
    }
    if (type === "ERROR") {
      const code = String(f.code ?? "ERROR");
      const m = f.market as MarketStream | undefined;
      const key = (subId ? keyBySub.get(subId) : undefined) ?? (m ? keyByStream.get(streamKey(m)) : undefined);
      if (!key) {
        // connection-level: about a frame we sent
        status.lastError = `${code}${f.message ? ` ${String(f.message)}` : ""}`;
        if (code === "QUOTA_EXCEEDED" && lastBatch.length) {
          const batch = lastBatch;
          lastBatch = [];
          setTimeout(() => queueSubscribe(batch), 1_500);
        }
        return;
      }
      dropSub(key);
      const h = held.get(key);
      if (!h || TERMINAL.has(h.phase)) return;
      if (code === "MARKET_NOT_YET_OPEN") deferHold(h, "not_yet_open", code, notYetOpenRetryMs);
      else if (RETRY_WITH_BACKOFF.has(code)) {
        h.retries += 1;
        deferHold(h, "unavailable", code, Math.min(unavailableRetryCapMs, unavailableRetryMs * 2 ** (h.retries - 1)));
      } else endHold(h, "stopped", code);
      return;
    }
    if (type === "GOODBYE") {
      const reason = String(f.reason ?? "");
      status.lastGoodbye = reason;
      if (reason === "AUTH_REVOKED" || reason === "KICKED") {
        status.stopped = reason;
        log(`held books: stream said ${reason}; not reconnecting`);
      } else if (reason === "TTL" || reason === "SHUTDOWN") reconnectAtOnce = true;
      return;
    }
  };

  // -------------------------------------------------------------------------
  // the connection
  // -------------------------------------------------------------------------

  const closeSocket = () => {
    const s = ws;
    if (!s) return;
    try {
      s.close(1000, "done");
    } catch {
      /* already closed */
    }
  };

  const onClosed = (why: string) => {
    ws = null;
    welcomed = false;
    connecting = false;
    status.connected = false;
    ttlTimer = clear(ttlTimer);
    sendTimer = clear(sendTimer);
    toSend.clear();
    subByKey.clear();
    keyBySub.clear();
    // every book on this connection is gone with it; the snapshot after the resubscribe rebuilds it
    for (const h of held.values()) {
      if (TERMINAL.has(h.phase) || h.nextRetryAtMs !== null) continue;
      h.book = null;
      h.seq = null;
      h.phase = "pending";
    }
    if (closedByUs || status.stopped) return;
    // nothing to put on a new connection (no holds, or every hold waiting on its retry timer):
    // the next hold or the next retry connects again
    if (![...held.values()].some((h) => !TERMINAL.has(h.phase) && h.nextRetryAtMs === null)) return;
    const atOnce = reconnectAtOnce;
    reconnectAtOnce = false;
    const delay = atOnce ? Math.floor(Math.random() * 500) : Math.min(reconnectCapMs, reconnectBaseMs * 2 ** reconnectAttempts) + Math.floor(Math.random() * 250);
    if (!atOnce) reconnectAttempts += 1;
    log(`held books: connection closed (${why}); reconnecting in ${delay}ms`);
    reconnectTimer = clear(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (ws || connecting || closedByUs || status.stopped) return;
    connecting = true;
    let s: WsLike;
    try {
      s = wsFactory(signedStreamUrl(signer, streamUrl, Math.floor(nowMs() / 1000)));
    } catch (err) {
      status.lastError = `connect: ${String(err instanceof Error ? err.message : err)}`;
      connecting = false;
      onClosed("could not open");
      return;
    }
    ws = s;
    s.addEventListener("error", (ev) => {
      status.lastError = String((ev as { message?: string }).message ?? "connection error");
    });
    s.addEventListener("close", (ev) => {
      if (ws !== s) return;
      onClosed(`${ev.code ?? "?"} ${ev.reason ?? ""}`.trim());
    });
    s.addEventListener("message", (ev) => {
      if (ws !== s) return;
      let f: Record<string, unknown>;
      try {
        f = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8")) as Record<string, unknown>;
      } catch {
        return;
      }
      onFrame(f);
    });
  };

  // -------------------------------------------------------------------------
  // the surface
  // -------------------------------------------------------------------------

  const hold: HeldBooks["hold"] = (key, market) => {
    if (status.stopped) return "stopped";
    if (held.has(key)) return "already";
    if (held.size >= maxHeld) {
      status.overCap += 1;
      return "over_cap";
    }
    held.set(key, { key, market, sinceIso: iso(), phase: "pending", book: null, seq: null, venueTimestamp: 0, lastFrameAtMs: null, snapshots: 0, openedAtIso: null, openBeforeHold: false, lastCode: null, retries: 0, nextRetryAtMs: null });
    keyByStream.set(streamKey(market), key);
    queueSubscribe([key]);
    if (!ws) connect();
    return "held";
  };

  const release: HeldBooks["release"] = (key) => {
    const h = held.get(key);
    if (!h) return;
    const sub = subByKey.get(key);
    if (sub !== undefined) send({ type: "UNSUBSCRIBE", subscriptionIds: [sub], requestId: `release:${nowMs()}` });
    dropSub(key);
    held.delete(key);
    keyByStream.delete(streamKey(h.market));
    toSend.delete(key);
    if (h.nextRetryAtMs !== null) armRetry();
  };

  const snapshotStatus = (): HeldBooksStatus => {
    const byPhase = Object.fromEntries(PHASES.map((p) => [p, 0])) as Record<HeldPhase, number>;
    for (const h of held.values()) byPhase[h.phase] += 1;
    return { ...status, held: held.size, byPhase };
  };

  const close: HeldBooks["close"] = () => {
    closedByUs = true;
    reconnectTimer = clear(reconnectTimer);
    retryTimer = clear(retryTimer);
    ttlTimer = clear(ttlTimer);
    sendTimer = clear(sendTimer);
    held.clear();
    keyByStream.clear();
    closeSocket();
    ws = null;
    welcomed = false;
    status.connected = false;
  };

  return {
    hold,
    release,
    get: (key) => {
      const h = held.get(key);
      return h ? { ...h, book: h.book ? { bids: [...h.book.bids], asks: [...h.book.asks] } : null } : undefined;
    },
    list: () => [...held.values()].map((h) => ({ ...h, book: h.book ? { bids: [...h.book.bids], asks: [...h.book.asks] } : null })),
    status: snapshotStatus,
    close,
  };
}
