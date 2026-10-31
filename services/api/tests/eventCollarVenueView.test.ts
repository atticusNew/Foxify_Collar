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
      row("KXNFLGAME-A", "Eagles", [route("kalshi_self", true, 400), route("novig", true, 450), route("prophetx", false, null, "no verified pairing for KXNFLGAME-A in cache 0xdeadbeef")], {}),
      // a tie between the host and another venue goes to the host
      row("KXNFLGAME-B", "Bills", [route("polymarket", true, 300), route("prophetx", true, 300)], { creditCents: 300, takeCents: 0, hedge: null }),
      // a refused quote is not a row
      { evBps: 0, res: { market: { ticker: "KXNFLGAME-C" }, routesChecked: [], quote: { ok: false, code: "x", detail: "y" } } },
    ],
  } as unknown as ScanState;
  const p = venueViewPayload(state, "ProphetX", 40);
  assert.deepEqual([p.ok, p.retail, p.sharePct, p.hostVenue, p.at, p.rows.length], [true, true, 40, "ProphetX", "2026-10-30T18:00:00.000Z", 2]);
  const a = p.rows[0];
  assert.deepEqual(
    a.venues,
    [
      { venue: "Novig", creditCents: 450, chosen: true, host: false },
      { venue: "Kalshi", creditCents: 400, chosen: false, host: false },
      { venue: "ProphetX", creditCents: null, chosen: false, host: true, why: "no match" },
    ],
    "best first; the host marked; a refusal is two words",
  );
  assert.deepEqual([a.hedgeVenue, a.edgeCents, a.hedgeCostCents, a.spreadCents, a.hostShareCents, a.creditCents, a.contracts, a.evCostBps], ["Novig", 50, 7200, 60, 24, 450, 150, 110]);
  const b = p.rows[1];
  assert.equal(b.hedgeVenue, "ProphetX", "a tie goes to the host");
  assert.deepEqual([b.edgeCents, b.hedgeCostCents, b.spreadCents, b.hostShareCents], [0, null, 0, 0], "no spread, no share; no hedge priced, no cost");
  assert.equal(venueViewPayload(state, "Your Exchange", 50).hostVenue, null, "a host that is not a venue the layer hedges on has no own quote");
  assert.equal(venueViewPayload(state, "Your Exchange", 50).rows[1].hedgeVenue, "Polymarket", "without a host the earlier of two equal prices wins");
  assert.deepEqual(forbiddenKeysIn(p), [], "no hedge-mechanics key reaches the page");
  const text = JSON.stringify(p);
  assert.doesNotMatch(text, /0xsecret|0xdeadbeef|pairing|kalshi_self|polymarket|prophetx|pmEventSlug|tokenId|KXNFLGAME-C/, "no ids, raw detail, route keys or refused rows");
  for (const [detail, word] of [
    ["no mapping for this game", "not mapped"], ["book empty on the No side", "no depth"], ["no verified pairing", "no match"], ["venue gate: not tonight", "not open"], ["something else", "not offered"], [undefined, "not offered"],
  ] as const) assert.equal(venueViewRefusalWord(detail), word, String(detail));
  assert.deepEqual([hostRouteOf("Kalshi"), hostRouteOf("prophet x"), hostRouteOf("Wire Markets")], ["kalshi_self", "prophetx", null]);
});
