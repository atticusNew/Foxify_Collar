import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HedgeRoute, RouteCheck } from "../src/eventCollar/crossVenue/types";
import { forbiddenKeysIn } from "../src/eventCollar/retailShowcase";

process.env.NODE_ENV = "test";
const TMP_DIR = mkdtempSync(join(tmpdir(), "event-venue-view-test-"));
process.env.EVENT_X_FUNNEL_PATH = join(TMP_DIR, "funnel.json");
process.env.EVENT_X_LEDGER_PATH = join(TMP_DIR, "ledger.jsonl");
process.env.EVENT_X_ADMIN_TOKEN = "t0ken";

// the service module reads its env at load, so it is imported after the env above is set
const { venueViewPayload, venueViewRefusalWord, hostRouteOf } = await import("../scripts/eventProtectXDemoService");
type ScanState = import("../scripts/eventProtectXDemoService").ScanState;

test("embed: /api/venue-view is the host's side of the board, retail-safe: venue names and figures, the winner (ties to the host), two-word refusals, the spread and the host's share; no keys, ids or raw detail", () => {
  const route = (route: HedgeRoute, ok: boolean, creditCents: number | null, detail?: string): RouteCheck => ({ route, ok, evCostBps: ok ? 100 : null, creditCents, ...(detail ? { detail } : {}) });
  const row = (ticker: string, side: string, routes: RouteCheck[], quote: Record<string, unknown>) => ({
    evBps: 110,
    res: {
      kind: "sports", league: "nfl", sideName: side, eventTimeIso: "2026-11-01T17:00:00.000Z", market: { ticker }, position: { contracts: 150 },
      routesChecked: routes,
      quote: { ok: true, creditCents: 450, takeCents: 60, hedge: { costCents: 7200, tokenId: "0xsecret" }, pmEventSlug: "nfl-x", ...quote },
    },
  });
  const state = {
    atIso: "2026-10-30T18:00:00.000Z",
    fetchFailures: 0,
    fallback: null,
    rows: [
      // Novig pays most, Kalshi next, ProphetX refused with a raw detail that must not travel
      row("KXNFLGAME-A", "Eagles", [route("kalshi_self", true, 400), route("novig", true, 450), route("prophetx", false, null, "no verified pairing for KXNFLGAME-A in cache 0xdeadbeef"), route("polymarket", true, 900)], {}),
      // no route chosen by the scan: a tie between the host and another venue goes to the host
      row("KXNFLGAME-B", "Bills", [route("polymarket", true, 300), route("prophetx", true, 300)], { creditCents: 300, takeCents: 0, hedge: null }),
      // the scan chose Kalshi on all-in cost though Novig quoted more: the view follows the scan, the edge is negative, the cost is the scan's
      { ...row("KXNFLGAME-D", "Jets", [route("kalshi_self", true, 200), route("novig", true, 260)], { creditCents: 200, takeCents: 30, hedge: { costCents: 5000 } }), res: { ...row("KXNFLGAME-D", "Jets", [route("kalshi_self", true, 200), route("novig", true, 260)], { creditCents: 200, takeCents: 30, hedge: { costCents: 5000 } }).res, route: "kalshi_self" } },
      // a refused quote is not a row
      { evBps: 0, res: { market: { ticker: "KXNFLGAME-C" }, routesChecked: [], quote: { ok: false, code: "x", detail: "y" } } },
    ],
  } as unknown as ScanState;
  const offered = ["kalshi_self", "prophetx", "novig"] as const;
  const p = venueViewPayload(state, "ProphetX", 40, offered);
  assert.deepEqual([p.ok, p.retail, p.sharePct, p.hostVenue, p.at, p.rows.length], [true, true, 40, "ProphetX", "2026-10-30T18:00:00.000Z", 3]);
  const a = p.rows[0];
  assert.deepEqual(
    a.venues,
    [
      { venue: "Novig", creditCents: 450, chosen: true, host: false },
      { venue: "Kalshi", creditCents: 400, chosen: false, host: false },
      { venue: "ProphetX", creditCents: null, chosen: false, host: true, why: "no match" },
    ],
    "best first; the host marked; a refusal is two words; a venue not offered tonight (Polymarket) is not shown even when the scan priced it",
  );
  assert.deepEqual([a.hedgeVenue, a.edgeCents, a.hedgeCostCents, a.spreadCents, a.hostShareCents, a.creditCents, a.contracts, a.evCostBps], ["Novig", 50, 7200, 60, 24, 450, 150, 110], "no route chosen by the scan: the venue paying most wins; the cost follows from the credits (7200 + 450 - 450)");
  const b = p.rows[1];
  assert.equal(b.hedgeVenue, "ProphetX", "a tie goes to the host");
  assert.deepEqual([b.edgeCents, b.hedgeCostCents, b.spreadCents, b.hostShareCents], [null, null, 0, 0], "one venue shown: no edge; no spread, no share; no hedge priced, no cost");
  const d = p.rows[2];
  assert.deepEqual([d.hedgeVenue, d.edgeCents, d.hedgeCostCents, d.venues.map((v) => v.venue + (v.chosen ? "*" : ""))], ["Kalshi", -60, 5000, ["Novig", "Kalshi*"]], "the scan's route wins even when another venue quoted more; the edge says by how much it lost on the quote");
  const everyRoute = venueViewPayload(state, "Your Exchange", 50, ["kalshi_self", "polymarket", "prophetx", "novig"]);
  assert.equal(everyRoute.hostVenue, null, "a host that is not a venue the layer hedges on has no own quote");
  assert.equal(everyRoute.rows[0].hedgeVenue, "Polymarket", "offered, Polymarket is shown and wins row A on the quote");
  assert.equal(everyRoute.rows[0].hedgeCostCents, 7200 + 450 - 900, "its cost follows from the credits");
  assert.equal(everyRoute.rows[1].hedgeVenue, "Polymarket", "without a host the earlier of two equal prices wins");
  assert.deepEqual(forbiddenKeysIn(p), [], "no hedge-mechanics key reaches the page");
  const text = JSON.stringify(p);
  assert.doesNotMatch(text, /0xsecret|0xdeadbeef|pairing|kalshi_self|polymarket|prophetx|pmEventSlug|tokenId|KXNFLGAME-C|Polymarket/, "no ids, raw detail, route keys, refused rows or venues not offered");
  for (const [detail, word] of [
    ["ProphetX's book is read through the aggregator, and no aggregator key is set", "not read"], ["no mapping for this game", "not mapped"], ["book empty on the No side", "no depth"], ["no verified pairing", "no match"], ["venue gate: not tonight", "not open"], ["something else", "not offered"], [undefined, "not offered"],
  ] as const) assert.equal(venueViewRefusalWord(detail), word, String(detail));
  assert.deepEqual([hostRouteOf("Kalshi"), hostRouteOf("prophet x"), hostRouteOf("Wire Markets")], ["kalshi_self", "prophetx", null]);
});
