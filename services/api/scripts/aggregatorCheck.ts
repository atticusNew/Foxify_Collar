/**
 * AGGREGATOR CHECK: prove the partner's data key works end to end, from your machine, in one run.
 *
 *   AGGREGATOR_KEY_ID=<key id> AGGREGATOR_PRIVATE_KEY_HEX=<64 hex> npx tsx scripts/aggregatorCheck.ts [--ticker KX...] [--league NFL] [--no-stream]
 *
 * Steps, each printed as it passes:
 *   1. GET /v1/whoami      the identity behind the key; expects capabilities ["data"] and says so
 *                          loudly if the key can trade (tell the partner, that is more than asked for)
 *   2. GET /v1/time        the server clock; the offset is applied to every signature after
 *   3. discovery           sports → the league's competition → its scheduled events → one event's
 *                          markets, with each outcome's ids per venue
 *   4. GET /v1/markets     the lookup by Kalshi ticker (--ticker, or the first winner ticker found):
 *                          the same outcome on every venue that lists it
 *   5. stream              one BOOK snapshot per listing of that outcome, best bid/ask in cents and
 *                          the book's age; the Kalshi book also shown from the No side, which is
 *                          the side our hedge buys
 *
 * Reads only; nothing is written anywhere, the key is never printed. Exit 0 when every step passes.
 * Optional AGGREGATOR_API_HOST and AGGREGATOR_STREAM_URL override the defaults.
 */

import {
  AggregatorApiError,
  AggregatorClient,
  aggregatorConfigFromEnv,
  alignedByTicker,
  bestOf,
  kalshiNoView,
  readSnapshots,
  signerFromSecret,
  streamFor,
  type Listing,
  type Market,
  type MarketStream,
} from "../src/eventCollar/crossVenue/aggregatorMarkets";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string): boolean => args.includes(name);

const cents = (c: number | null) => (c === null ? "—" : `${c}c`);
const shares = (n: number) => Math.round(n).toLocaleString("en-US");
const idOf = (l: Listing): string =>
  l.venue === "KALSHI" ? `${(l as { ticker: string }).ticker} ${(l as { side: string }).side}` : l.venue === "POLYMARKET" ? `token …${String((l as { tokenId: string }).tokenId).slice(-8)}` : l.venue === "PROPHETX" ? `strike ${(l as { strikeId: string }).strikeId}` : JSON.stringify(l);
/** the full-game winner market: a moneyline that is not a half, quarter, period or prop (an event lists 1,000+ markets; this is the one every venue carries) */
const PARTIAL = /\b(1H|2H|1Q|2Q|3Q|4Q|OT|first|second|third|fourth|half|quarter|period|inning|set)\b/i;
const winnerLike = (m: Market) =>
  !PARTIAL.test(m.title) && !m.line && (/\b(moneyline|money line|match winner|to win|match result)\b/i.test(m.title) || (m.outcomes.length === 2 && !m.title.includes(":") && !/\?/.test(m.title)));
/** winner markets first, the one listed on the most venues ahead of the rest */
const venuesOf = (m: Market) => new Set(m.outcomes.flatMap((o) => o.listings.map((l) => l.venue))).size;
const byCoverage = (markets: Market[]) => [...markets].sort((a, b) => venuesOf(b) - venuesOf(a));
const firstTicker = (markets: Market[]): string | null => {
  for (const m of byCoverage(markets.filter(winnerLike)).concat(byCoverage(markets))) {
    for (const o of m.outcomes) {
      const k = o.listings.find((l) => l.venue === "KALSHI" && (l as { side?: string }).side === "YES") as { ticker?: string } | undefined;
      if (k?.ticker) return k.ticker;
    }
  }
  return null;
};

async function main(): Promise<void> {
  const cfg = aggregatorConfigFromEnv();
  if (!cfg) {
    console.error("set AGGREGATOR_KEY_ID and AGGREGATOR_PRIVATE_KEY_HEX (the 64-hex Ed25519 seed) in the environment of this shell only");
    process.exit(2);
  }
  const signer = signerFromSecret(cfg.keyId, cfg.secret);
  const client = new AggregatorClient({ host: cfg.host, signer });
  console.log(`host ${cfg.host}  key …${cfg.keyId.slice(-6)}  public key ${signer.publicKeyHex}`);

  // 1. identity
  const who = await client.whoami();
  console.log(`1 whoami      scope ${who.scope} · capabilities [${who.capabilities.join(", ")}] · pod …${String(who.podId).slice(-6)}`);
  if (who.capabilities.includes("trade")) {
    console.log("  NOTE: this key can TRADE. More than was asked for: tell the partner and ask for a data key before using it from a server.");
  }

  // 2. clock
  const serverTime = await client.time();
  const offset = client.clockOffsetSec;
  console.log(`2 time        server ${new Date(serverTime * 1000).toISOString()} · our clock is ${offset === 0 ? "in step" : `${Math.abs(offset)}s ${offset > 0 ? "behind" : "ahead"}`}`);
  if (Math.abs(offset) > 20) console.log("  NOTE: the window is ±30s; a drift this size will fail signatures intermittently. Sync the clock.");

  // 3. discovery
  const league = (opt("--league") || "NFL").toUpperCase();
  const sports = await client.listSports();
  console.log(`3 sports      ${sports.length}: ${sports.map((s) => s.name).join(", ")}`);
  const competitions = await client.listCompetitions();
  const comp = competitions.find((c) => c.name.toUpperCase() === league) ?? competitions.find((c) => c.name.toUpperCase().includes(league));
  if (!comp) {
    console.log(`  competitions (${competitions.length}): ${competitions.map((c) => c.name).join(", ")}`);
    throw new Error(`no competition named ${league}`);
  }
  console.log(`  competition ${comp.name} (${comp.id})`);
  const events = await client.listEvents(comp.id);
  const scheduled = events.filter((e) => (e.status ?? "SCHEDULED") === "SCHEDULED").sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
  console.log(`  events      ${events.length} (${scheduled.length} scheduled)`);
  for (const e of scheduled.slice(0, 6)) console.log(`              ${e.startTime ?? "?"}  ${e.name}  ${e.id}`);
  if (!events.length) throw new Error(`${comp.name} lists no events right now`);
  // the nearest scheduled event that carries markets (a far-out game may list none yet)
  let event = scheduled[0] ?? events[0];
  let markets: Market[] = [];
  for (const e of (scheduled.length ? scheduled : events).slice(0, 6)) {
    const ms = await client.listEventMarkets(e.id);
    if (ms.length) {
      event = e;
      markets = ms;
      break;
    }
    console.log(`              (${e.name}: no markets yet)`);
  }
  const byVenue = new Map<string, number>();
  for (const m of markets) for (const o of m.outcomes) for (const l of o.listings) byVenue.set(l.venue, (byVenue.get(l.venue) ?? 0) + 1);
  console.log(`  markets     ${markets.length} on "${event.name}" · listings per venue: ${[...byVenue].map(([v, n]) => `${v} ${n}`).join(", ") || "none"}`);
  const winners = byCoverage(markets.filter(winnerLike));
  console.log(`  winner markets ${winners.length}${winners.length ? "" : " (none matched; showing the first three listed)"}`);
  for (const m of (winners.length ? winners : markets).slice(0, 3)) {
    console.log(`              ${m.title}${m.line && !m.title.includes(m.line) ? ` (${m.line})` : ""}`);
    for (const o of m.outcomes) console.log(`                ${o.name}: ${o.listings.map((l) => `${l.venue}${l.executable === false ? "(off)" : ""} ${idOf(l)}`).join(" · ") || "no listings"}`);
  }

  // 4. lookup by our ticker
  const ticker = opt("--ticker") || firstTicker(markets);
  if (!ticker) throw new Error("no Kalshi ticker to look up; pass --ticker");
  const found = await client.lookupMarket({ ticker });
  const aligned = alignedByTicker(found, ticker);
  if (!aligned) {
    console.log(`4 lookup      ${ticker} → ${found.length} market(s), none carries its YES side`);
    throw new Error("lookup did not align the ticker");
  }
  console.log(`4 lookup      ${ticker} → "${aligned.title}" · outcome "${aligned.outcome}" on ${aligned.listings.length} venue(s)`);
  for (const l of aligned.listings) console.log(`              ${l.venue}${l.executable === false ? " (not executable today)" : ""}: ${idOf(l)}`);
  if (!aligned.listings.some((l) => l.venue === "PROPHETX")) console.log("              PROPHETX: no listing → not mapped yet (the partner has not confirmed the mapping; check again later)");

  // 5. one snapshot per listing
  if (flag("--no-stream")) {
    console.log("5 stream      skipped (--no-stream)");
    return;
  }
  const streams = aligned.listings.map(streamFor).filter((s): s is MarketStream => s !== null);
  const snaps = await readSnapshots(signer, streams, { streamUrl: cfg.streamUrl, timeoutMs: 10_000 });
  console.log(`5 stream      ${snaps.filter((s) => s.book).length}/${streams.length} snapshot(s)`);
  for (const s of snaps) {
    const name = s.market.venue === "KALSHI" ? s.market.ticker : s.market.venue === "POLYMARKET" ? `token …${s.market.tokenId.slice(-8)}` : s.market.venue === "PROPHETX" ? `strike ${s.market.strikeId}` : `${s.market.marketId}`;
    if (!s.book) {
      // the partner's reading of its own codes: MARKET_NOT_YET_OPEN is their ~2-day window, UNAVAILABLE is transient (one retry already made)
      const state = s.error.code === "MARKET_NOT_YET_OPEN" ? " · mapped, streams ~2d out" : s.error.code === "UNAVAILABLE" ? " · transient, try again shortly" : "";
      console.log(`              ${s.market.venue} ${name}: ${s.error.code}${s.error.message ? ` · ${s.error.message}` : ""}${state}`);
      continue;
    }
    if (s.book.bids.length === 0 && s.book.asks.length === 0) {
      console.log(`              ${s.market.venue} ${name}: mapped, no book yet (empty snapshot; the venue has not opened this line)${s.book.status ? ` · ${s.book.status}` : ""}`);
      continue;
    }
    const b = bestOf(s.book);
    const ageSec = s.book.venueTimestamp ? Math.max(0, Math.round((s.book.serverTimestamp - s.book.venueTimestamp) / 1000)) : null;
    console.log(`              ${s.market.venue} ${name}: bid ${cents(b.bidCents)} x ${shares(b.bidSize)} · ask ${cents(b.askCents)} x ${shares(b.askSize)} · ${s.book.bids.length}/${s.book.asks.length} levels${s.book.status ? ` · ${s.book.status}` : ""}${ageSec !== null ? ` · book age ${ageSec}s` : ""}`);
    if (s.market.venue === "KALSHI") {
      const no = bestOf(kalshiNoView(s.book));
      console.log(`                No side (what our hedge buys): bid ${cents(no.bidCents)} x ${shares(no.bidSize)} · ask ${cents(no.askCents)} x ${shares(no.askSize)}`);
    }
  }
  if (!snaps.some((s) => s.book)) throw new Error("no venue streamed a snapshot; books open closer to game time, try a nearer event or --ticker");
}

main().catch((err: unknown) => {
  if (err instanceof AggregatorApiError) {
    console.error(`failed: ${err.status} ${err.code} · ${err.message}${err.retryAfterSec ? ` · retry after ${err.retryAfterSec}s` : ""}`);
    if (err.status === 401) console.error("  401 covers a bad signature, a stale clock and a revoked key alike. whoami first; if that fails too, check the key id and that the hex is the 32-byte seed.");
    if (err.status === 403) console.error("  403: the key's capability does not cover this path (a data key cannot call /v1/{venue}/...).");
  } else {
    console.error(`failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
});
