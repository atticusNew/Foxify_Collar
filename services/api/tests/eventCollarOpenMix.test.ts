/**
 * Open mix: crypto strikes roll over hourly and would fill the record; the rule holds
 * them to a share of the trailing window with a small per-day allowance.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_OPEN_MIX, cryptoOpenAllowed, openMixRuleFromEnv } from "../src/eventCollar/crossVenue/openMix";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const at = (hoursAgo: number): string => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const crypto = (hoursAgo: number) => ({ kind: "crypto" as const, at: at(hoursAgo) });
const sports = (hoursAgo: number) => ({ kind: "sports" as const, at: at(hoursAgo) });

test("open mix: an empty window allows crypto; the per-day allowance holds when no games are on", () => {
  assert.equal(cryptoOpenAllowed([], NOW).allowed, true);
  const overnight = [crypto(1), crypto(2), crypto(3)];
  assert.deepEqual(cryptoOpenAllowed(overnight, NOW), { allowed: true, cryptoInWindow: 3, totalInWindow: 3 }, "3 < floor of 4");
  assert.equal(cryptoOpenAllowed([...overnight, crypto(4)], NOW).allowed, false, "4 crypto, 0 games: the allowance is spent and the share is 100%");
});

test("open mix: the share ceiling admits one crypto per game once the allowance is spent", () => {
  const book = [crypto(1), crypto(2), crypto(3), crypto(4), sports(1), sports(2), sports(3), sports(4)];
  // 4 crypto of 8: opening a fifth makes 5 of 9 = 56% > 50%
  assert.equal(cryptoOpenAllowed(book, NOW).allowed, false);
  // one more game and there is room again: 5 of 10 = 50%
  assert.equal(cryptoOpenAllowed([...book, sports(5)], NOW).allowed, true);
});

test("open mix: only the trailing window counts; a crypto-heavy yesterday does not block today", () => {
  const yesterday = Array.from({ length: 40 }, (_, i) => crypto(30 + i));
  const d = cryptoOpenAllowed(yesterday, NOW);
  assert.deepEqual(d, { allowed: true, cryptoInWindow: 0, totalInWindow: 0 });
  // unparseable and future timestamps are ignored rather than counted
  assert.equal(cryptoOpenAllowed([{ kind: "crypto", at: "not a date" }, { kind: "crypto", at: at(-1) }], NOW).cryptoInWindow, 0);
});

test("open mix: a stricter share is honoured; share 0 with floor 0 records no crypto at all", () => {
  const book = [sports(1), sports(2), sports(3), sports(4), sports(5), sports(6), sports(7), sports(8), sports(9)];
  const strict = { ...DEFAULT_OPEN_MIX, cryptoShareMax: 0.1, cryptoFloorPerDay: 0 };
  assert.equal(cryptoOpenAllowed(book, NOW, strict).allowed, true, "1 of 10 is 10%");
  assert.equal(cryptoOpenAllowed([...book, crypto(1)], NOW, strict).allowed, false, "2 of 11 is over");
  assert.equal(cryptoOpenAllowed([], NOW, { ...strict, cryptoShareMax: 0 }).allowed, false);
});

test("open mix: env parsing takes sane values and falls back on the rest", () => {
  assert.deepEqual(openMixRuleFromEnv({}), DEFAULT_OPEN_MIX);
  const r = openMixRuleFromEnv({ EVENT_SHADOW_CRYPTO_SHARE_MAX: "0.35", EVENT_SHADOW_CRYPTO_FLOOR_PER_DAY: "2.6" });
  assert.equal(r.cryptoShareMax, 0.35);
  assert.equal(r.cryptoFloorPerDay, 3);
  const bad = openMixRuleFromEnv({ EVENT_SHADOW_CRYPTO_SHARE_MAX: "1.5", EVENT_SHADOW_CRYPTO_FLOOR_PER_DAY: "-1" });
  assert.deepEqual(bad, DEFAULT_OPEN_MIX);
});
