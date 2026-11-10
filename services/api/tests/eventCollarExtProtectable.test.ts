/**
 * EXTENSION, BEFORE THE TRADE: the service says which games can be locked in right now (one
 * window rule, shared with the quote), and keeps the anonymous counts the extension posts.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ExtTelemetryStore, parseExtTelemetry } from "../src/eventCollar/crossVenue/extTelemetry";

// the demo module must not start its server or prewarm a scan when imported below
process.env.NODE_ENV = "test";
process.env.EVENT_X_ADMIN_TOKEN = "t0ken";

test("protect window: seven days out to 45 minutes before kickoff; in progress, too close and far out are named", async () => {
  const { PROTECT_WINDOW_MINUTES, protectWindow } = await import("../scripts/eventProtectXDemoService");
  assert.equal(PROTECT_WINDOW_MINUTES.min, 45);
  const kick = Date.UTC(2026, 9, 25, 20, 20); // Sun Oct 25 2026 4:20pm ET
  const at = (minutesBefore: number) => new Date(kick - minutesBefore * 60_000);
  const start = new Date(kick).toISOString();
  assert.deepEqual(protectWindow(start, at(3 * 60)), { open: true, untilIso: new Date(kick - 45 * 60_000).toISOString() });
  assert.equal(protectWindow(start, at(45)).open, true, "the 45th minute is the last one");
  assert.equal(protectWindow(start, at(44)).why, "too_close");
  assert.equal(protectWindow(start, at(0)).why, "in_progress");
  assert.equal(protectWindow(start, at(-90)).why, "in_progress", "a game under way is not too close, it has started");
  assert.equal(protectWindow(start, at(7 * 24 * 60)).open, true);
  assert.equal(protectWindow(start, at(7 * 24 * 60 + 1)).why, "far_out");
});

test("board window: in play is on unless EVENT_X_IN_PLAY says off; a started game is open for a bounded time", async () => {
  const { IN_PLAY, IN_PLAY_MAX_MS, boardWindowOk } = await import("../scripts/eventProtectXDemoService");
  assert.equal(IN_PLAY, true, "on by default: the board and the lock path share this switch");
  assert.equal(IN_PLAY_MAX_MS, 4 * 3_600_000);
  const kick = Date.UTC(2026, 9, 25, 20, 20);
  const at = (minutesBefore: number) => new Date(kick - minutesBefore * 60_000);
  const start = new Date(kick).toISOString();
  assert.deepEqual(boardWindowOk(start, at(3 * 60)), { open: true, live: false }, "pre-game is the same window, never live");
  assert.deepEqual(boardWindowOk(start, at(-30)), { open: true, live: true }, "the default: a started game is open and live");
  assert.deepEqual(boardWindowOk(start, at(-30), false), { open: false, live: false }, "flag off: a started game is off the board");
  assert.deepEqual(boardWindowOk(start, at(-30), true), { open: true, live: true }, "flag on: a started game is on the board and marked live");
  assert.deepEqual(boardWindowOk(start, at(44), false), { open: false, live: false }, "flag off: the 45 minutes before tip-off are closed, as the record's window says");
  assert.deepEqual(boardWindowOk(start, at(44), true), { open: true, live: false }, "flag on: the board is continuous through tip-off, and not yet live before it");
  assert.deepEqual(boardWindowOk(start, at(-4 * 60 - 1), true), { open: false, live: false }, "and the game ages off the board after the bound");
  assert.deepEqual(boardWindowOk(start, at(7 * 24 * 60 + 1), true), { open: false, live: false });
});

test("telemetry: fixed vocabularies in, totals per venue out, nothing free-form kept", () => {
  const store = new ExtTelemetryStore(3);
  const ok = parseExtTelemetry({ venue: "Novig", page: "board", version: "0.7.0", counts: { markets: 10, protectable: 8, games: 6, marks: 4 }, email: "x@y" }, "2026-10-25T20:00:00.000Z");
  assert.ok(ok.ok);
  assert.deepEqual(Object.keys(ok.row), ["at", "venue", "page", "version", "counts"]);
  assert.equal(ok.row.venue, "novig");
  assert.equal(ok.row.counts.marks, 4);
  assert.equal(ok.row.counts.slip, 0, "an omitted count is zero");
  store.add(ok.row);
  for (const bad of [
    null,
    { venue: "fanduel", page: "board", version: "0.7.0" },
    { venue: "kalshi", page: "checkout", version: "0.7.0" },
    { venue: "kalshi", page: "board", version: "0.7.0-beta" },
    { venue: "kalshi", page: "board", version: "0.7.0", counts: { marks: -1 } },
    { venue: "kalshi", page: "board", version: "0.7.0", counts: { marks: 1.5 } },
    { venue: "kalshi", page: "board", version: "0.7.0", counts: { marks: 1_000_000 } },
    { venue: "kalshi", page: "board", version: "0.7.0", counts: { url: 1 } },
  ]) {
    assert.equal(parseExtTelemetry(bad).ok, false, JSON.stringify(bad));
  }
  for (let i = 0; i < 4; i++) {
    const r = parseExtTelemetry({ venue: "kalshi", page: i === 3 ? "plays" : "game", version: i < 2 ? "0.7.0" : "0.7.1", counts: i === 3 ? { rows: 3, offers: 2, unread: 1 } : { slip: 1, slipMarked: i === 0 ? 1 : 0, marks: i === 0 ? 2 : 0 } }, `2026-10-25T20:0${i}:00.000Z`);
    assert.ok(r.ok);
    store.add(r.row);
  }
  const s = store.summary(2);
  assert.equal(s.rows, 5, "every row is counted");
  assert.equal(s.since, "2026-10-25T20:00:00.000Z");
  assert.equal(Object.keys(s.byVenue).length, 1, "the ring keeps the last three; the novig row has rolled off");
  const k = s.byVenue.kalshi;
  assert.equal(k.loads, 3);
  assert.deepEqual(k.versions, ["0.7.0", "0.7.1"]);
  assert.equal(k.boards, 2);
  assert.equal(k.boardsWithMarks, 0);
  assert.equal(k.slips, 2);
  assert.equal(k.slipsMarked, 0);
  assert.equal(k.plays, 1);
  assert.equal(k.playsUnread, 1);
  assert.equal(k.lastAt, "2026-10-25T20:03:00.000Z");
  assert.equal(s.recent.length, 2);
  assert.equal(s.recent[0].page, "plays", "newest first");
});
