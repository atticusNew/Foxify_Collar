/**
 * The slate as a holder on one venue would be quoted tonight: every protectable game, priced at
 * one stake, with where the other side would go. For picking a game to demo on ("a $10 ProphetX
 * pick that hedges on ProphetX") without opening each card.
 *
 *   EVENT_SHADOW_LOCK_KEY=… npx tsx scripts/eventShadowSlateQuotes.ts [--venue prophetx] [--stake 10]
 *       [--hedge prophetx] [--league nba] [--url https://atticus-event-shadow.onrender.com]
 *
 *   --venue   the venue the pick is held on (prophetx | kalshi | novig); the service routes and
 *             words the terms against its rules. Default prophetx.
 *   --stake   dollars on the pick; the size is stake / mark, as the venue would fill it. Default 10.
 *   --hedge   list only games whose other side goes to this venue; omit for the whole slate.
 *   --league  nba | nfl | …; omit for every league.
 *
 * Read-only: GET /api/shadow/markets and GET /api/shadow/quote with the lock key (the same reads
 * the extension makes); nothing is locked. The key is sent as a header and never printed.
 */

const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const URL_BASE = arg("url", process.env.EVENT_SHADOW_URL ?? "https://atticus-event-shadow.onrender.com").replace(/\/+$/, "");
const VENUE = arg("venue", "prophetx").toLowerCase();
const STAKE = Number(arg("stake", "10"));
const HEDGE = arg("hedge", "").toLowerCase() || null;
const LEAGUE = arg("league", "").toLowerCase() || null;
const KEY = process.env.EVENT_SHADOW_LOCK_KEY ?? "";

if (!KEY) {
  console.error("EVENT_SHADOW_LOCK_KEY is not set (the lock key from the extension's Options). Nothing is printed without it.");
  process.exit(2);
}
if (!(STAKE > 0)) {
  console.error("--stake must be dollars above zero");
  process.exit(2);
}

interface MarketRow {
  ticker: string;
  league: string;
  sideName: string;
  title: string;
  markCents?: number;
  startIso?: string | null;
  eventTimeIso?: string | null;
  protectable: boolean;
  protectableUntilIso: string | null;
  notProtectable?: string;
}
interface RouteView {
  route?: string;
  hedgeVenue?: string;
  hedgeVenueName?: string;
  ok: boolean;
  allInBps: number | null;
  creditCents: number | null;
  terms: { floorCents: number; capCents: number } | null;
  refusal?: string;
  gate?: string;
}
interface QuoteAnswer {
  ok: boolean;
  code?: string;
  message?: string;
  markCents?: number;
  quote?: { ok: boolean; tier?: string; floorCents: number; capCents: number; creditCents: number; tiers?: Record<string, { floorCents: number; capCents: number; creditCents: number }> };
  routing?: { hedgeVenueName: string | null; reason?: string; comparison: string | null; routes: RouteView[] } | null;
}

const get = async <T>(path: string): Promise<T> => {
  const r = await fetch(URL_BASE + path, { headers: { "x-lock-key": KEY } });
  if (r.status === 403) throw new Error("the service refused the lock key (403)");
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return (await r.json()) as T;
};

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const et = (iso: string | null): string => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) : "n/a");

/** The shape heading the quote, in the holder's dollars: what the pick pays, the cap, the floor, the cash now. */
export function shapeLine(contracts: number, q: NonNullable<QuoteAnswer["quote"]>): { tier: string; pays: number; win: number; lose: number; cash: number } {
  const t = (q.tier && q.tiers && q.tiers[q.tier]) || q;
  return {
    tier: q.tier ?? "balanced",
    pays: Math.round(contracts * 100),
    win: Math.round(contracts * t.capCents),
    lose: Math.round(contracts * t.floorCents),
    cash: t.creditCents,
  };
}

async function main(): Promise<void> {
  const list = await get<{ ok: boolean; markets: MarketRow[] }>("/api/shadow/markets" + (LEAGUE ? `?league=${encodeURIComponent(LEAGUE)}` : ""));
  const startOf = (m: MarketRow): string | null => m.startIso ?? m.eventTimeIso ?? null;
  const open = list.markets.filter((m) => m.protectable && (!LEAGUE || m.league === LEAGUE)).sort((a, b) => String(startOf(a)).localeCompare(String(startOf(b))) || a.ticker.localeCompare(b.ticker));
  console.log(`${open.length} market(s) that can be locked in on ${URL_BASE}, quoted as a ${VENUE} holder at $${STAKE.toFixed(2)}${HEDGE ? `, other side on ${HEDGE} only` : ""}\n`);
  const rows: string[] = [];
  for (const m of open) {
    const quoteAt = (contracts: number) => get<QuoteAnswer>(`/api/shadow/quote?ticker=${encodeURIComponent(m.ticker)}&contracts=${contracts}&venue=${encodeURIComponent(VENUE)}`);
    // the size the stake buys at the mark, to the hundredth, as the venue would fill it; a list
    // without the mark reads it off a first quote at even money, then prices at the right size
    const sizeAt = (markCents: number) => Math.round((STAKE * 100 * 100) / markCents) / 100;
    let mark = m.markCents ?? null;
    let a: QuoteAnswer;
    try {
      if (mark === null) {
        const probe = await quoteAt(sizeAt(50));
        mark = typeof probe.markCents === "number" ? probe.markCents : 50;
      }
      a = await quoteAt(sizeAt(mark));
    } catch (e) {
      rows.push(`${et(startOf(m))}  ${m.sideName.padEnd(24)} ${mark ?? "?"}c  quote failed: ${(e as Error).message}`);
      continue;
    }
    const contracts = sizeAt(mark);
    const hedge = a.routing?.hedgeVenueName ?? null;
    if (HEDGE && (hedge ?? "").toLowerCase() !== HEDGE) continue;
    const head = `${et(startOf(m))}  ${m.sideName.padEnd(24)} ${String(mark).padStart(2)}c  ${String(contracts).padStart(6)} contracts`;
    if (!a.ok || !a.quote || !a.quote.ok) {
      rows.push(`${head}  refused: ${a.code ?? "unavailable"}${a.message ? ` (${a.message})` : ""}`);
      continue;
    }
    const s = shapeLine(contracts, a.quote);
    const routes = (a.routing?.routes ?? []).map((r) => `${r.hedgeVenueName ?? r.hedgeVenue ?? r.route ?? "?"} ${r.ok ? [typeof r.creditCents === "number" ? usd(r.creditCents) : null, typeof r.allInBps === "number" ? `${r.allInBps} bps all in` : null].filter(Boolean).join(" · ") || "priced" : r.gate ?? r.refusal ?? "refused"}${r.ok && r.gate ? ` (${r.gate})` : ""}`).join(" · ");
    rows.push(`${head}\n    pays ${usd(s.pays)} · ${s.tier}: win ${usd(s.win)}, lose ${usd(s.lose)}, ${usd(s.cash)} credited at lock in · other side on ${hedge ?? "no route"}\n    routes: ${routes}${a.routing?.reason ? `\n    why: ${a.routing.reason}` : ""}`);
  }
  console.log(rows.length ? rows.join("\n\n") : "no game matched");
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
