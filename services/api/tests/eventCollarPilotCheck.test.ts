/**
 * The pilot switch check (crossVenue/pilotCheck.ts), as a pure function of the facts the worker
 * hands it: each condition answers yes, no, or cannot be checked from here; a condition nothing
 * here can see is never a yes; the overall line is yes only when nothing is a no; holder keys are
 * counted and never shown.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_EXPOSURE_CAPS, type ExposureCaps } from "../src/eventCollar/crossVenue/exposureCaps";
import { holderKeysFromEnv } from "../src/eventCollar/crossVenue/lockGate";
import { CANNOT, PILOT_NOTE, holderKeyCounts, killSwitchSelfTest, listDir, pilotCheck, readDiskFacts, type PilotFacts, type PilotItem, type PilotReport } from "../src/eventCollar/crossVenue/pilotCheck";

const CAPS: ExposureCaps = { ...DEFAULT_EXPOSURE_CAPS, venueOverrides: {}, notes: [] };
const LEDGERS = [
  { what: "the lock ledgers", path: "/var/data/event-shadow/lock-ledger.jsonl" },
  { what: "the hedge receipts", path: "/var/data/event-shadow/hedge-receipts.jsonl" },
];

/** Every condition this service can compute, computed as met; what is left is what it cannot see. */
function facts(over: Partial<PilotFacts> = {}): PilotFacts {
  return {
    strategy: "live",
    rfqVenues: [],
    killSwitch: false,
    realOnly: { everyone: false, notRealOnly: ["ann", "bob"], notes: [] },
    live: { killSwitch: false, dryRun: false, allowlist: [], anyTicker: true, venues: ["kalshi", "polymarket", "prophetx", "novig"], maxContractsPerOrder: 25, maxContractsPerDay: 100 },
    orderRails: { maxContractsPerOrder: 25, maxContractsPerDay: 100 },
    exposureCaps: CAPS,
    holderKeys: { listed: 2, accepted: 2, dropped: { badAlias: 0, shortKey: 0, equalsSharedKey: 0, aliasTwice: 0, keyTwice: 0 }, equalOperatorToken: 0, sharedKeySet: false },
    operatorOpen: false,
    sharedOpenLocks: 0,
    inPlay: { lock: true, hours: 4, cutoffMinutes: 45, scan: false, memberSale: true },
    disk: { mount: "/var/data", paths: LEDGERS, tempDirs: ["/tmp"], mountDev: 2049, rootDev: 2048, mountFsType: "ext4" },
    alerts: { telegram: true, webhook: false },
    termsOnRecord: { version: "2026-11-20", holders: 2, missing: [], notes: [] },
    docs: ["AGENT_HANDOFF.md", "EVENT_PAYOUT_RUNBOOK.md", "INCIDENT_RUNBOOK.md"],
    workflows: ["ci.yml", "event-ledger-backup.yml"],
    ...over,
  };
}
const live = (over: Partial<NonNullable<PilotFacts["live"]>>): Pick<PilotFacts, "live"> => ({ live: { ...facts().live!, ...over } });
const item = (r: PilotReport, id: string): PilotItem => {
  const found = r.items.find((i) => i.id === id);
  assert.ok(found, id);
  return found;
};
const answers = (r: PilotReport): Record<string, string> => Object.fromEntries(r.items.map((i) => [i.id, i.answer]));

test("pilot check: the eleven conditions in order, each with one of three answers; what cannot be seen from here is never a yes", () => {
  const r = pilotCheck(facts());
  assert.deepEqual(
    r.items.map((i) => [i.n, i.id]),
    [
      [1, "hedge_first"],
      [2, "kill_switch"],
      [3, "caps"],
      [4, "holder_keys"],
      [5, "in_play"],
      [6, "ledger_disk"],
      [7, "alerts"],
      [8, "backup"],
      [9, "keys_rotated"],
      [10, "terms"],
      [11, "payout_runbook"],
    ],
  );
  assert.deepEqual(answers(r), {
    hedge_first: "yes",
    kill_switch: "yes",
    caps: "yes",
    holder_keys: "yes",
    in_play: "yes",
    ledger_disk: "yes",
    alerts: "yes",
    backup: CANNOT,
    keys_rotated: CANNOT,
    terms: "yes",
    payout_runbook: "yes",
  });
  // the two this service has no way to see say what to confirm, and are there whatever the settings
  assert.match(item(r, "backup").confirm ?? "", /Actions tab/);
  assert.match(item(r, "backup").detail, /event-ledger-backup\.yml/);
  assert.match(item(r, "keys_rotated").confirm ?? "", /replaced since it appeared/);
  assert.equal(item(r, "hedge_first").confirm, undefined, "a yes or a no carries nothing to confirm");
  // with nothing a no: yes, and only as far as can be checked, with what is left
  assert.equal(r.ready, "yes");
  assert.equal(r.overall, "ready for an outside holder: yes, as far as can be checked from here. Left to confirm by hand: 8 backup, 9 keys_rotated.");
  assert.deepEqual(r.no, []);
  assert.equal(r.confirmByHand.length, 2);
  assert.equal(r.note, PILOT_NOTE);
  assert.match(r.note, /changes nothing and gates nothing/);
});

test("pilot check: one no is enough for a no overall, and the line names which", () => {
  const r = pilotCheck(facts({ termsOnRecord: null, docs: ["INCIDENT_RUNBOOK.md", "SHADOW_BOT_RUNBOOK.md"] }));
  assert.equal(r.ready, "no");
  assert.deepEqual(r.no, ["10 terms", "11 payout_runbook"]);
  assert.equal(r.overall, "ready for an outside holder: no. 2 conditions answered no: 10 terms, 11 payout_runbook. 2 more to confirm by hand: 8 backup, 9 keys_rotated.");
  assert.match(item(r, "terms").detail, /^No terms are in force on this service: EVENT_SHADOW_TERMS_VERSION and EVENT_SHADOW_TERMS_URL are not set, so nothing asks a holder to accept and no acceptance counts\. 2 holder keys in force\.$/);
  // every holder with a key has accepted the version in force
  const all = item(pilotCheck(facts()), "terms");
  assert.equal(all.answer, "yes");
  assert.match(all.detail, /^Version 2026-11-20 is in force and an acceptance of it is on the record for each of the 2 holders with a key in force\./);
  assert.match(item(r, "payout_runbook").detail, /Runbooks there: INCIDENT_RUNBOOK\.md, SHADOW_BOT_RUNBOOK\.md/);
  // some holders on the record, not all
  const some = item(pilotCheck(facts({ termsOnRecord: { version: "2026-11-20", holders: 1, missing: ["bo"], notes: [] } })), "terms");
  assert.equal(some.answer, "no");
  assert.match(some.detail, /Version 2026-11-20 is in force and 1 holder with a key in force has no acceptance of it on the record \(1 of 2 do\): bo\. Each is refused at the quote and at the tap until they accept\./);
  // settings that could not be read: a no, even when the count would pass, and the note says which setting
  const unread = item(pilotCheck(facts({ termsOnRecord: { version: null, holders: 0, missing: ["ann", "bo"], notes: ["EVENT_SHADOW_TERMS_URL has to be an https address with no login in it; no holder can accept until it is corrected"] } })), "terms");
  assert.equal(unread.answer, "no");
  assert.match(unread.detail, /^The terms settings could not be read, so no holder can accept and every named holder is refused: EVENT_SHADOW_TERMS_URL has to be an https address/);
  const unreadNoHolders = item(pilotCheck(facts({ holderKeys: { ...facts().holderKeys, accepted: 0 }, termsOnRecord: { version: null, holders: 0, missing: [], notes: ["x"] } })), "terms");
  assert.equal(unreadNoHolders.answer, "no", "with no holder to be short, unreadable terms are still a no");
  // the docs folder not on the machine is not a no and not a yes
  const nodocs = item(pilotCheck(facts({ docs: null })), "payout_runbook");
  assert.equal(nodocs.answer, CANNOT);
  assert.match(nodocs.confirm ?? "", /payout runbook/);
});

test("pilot check, hedge first: yes only when every lock is a real-money lock; a simulated lock under any setting is a no with the reason", () => {
  const no = (over: Partial<PilotFacts>, why: RegExp): void => {
    const r = pilotCheck(facts(over));
    assert.equal(item(r, "hedge_first").answer, "no", JSON.stringify(over));
    assert.match(item(r, "hedge_first").detail, why);
    assert.equal(r.ready, "no");
    // in play is on in these facts: a lock during a game that is not hedged first is a no as well
    assert.equal(item(r, "in_play").answer, "no");
    assert.equal(item(pilotCheck(facts({ ...over, inPlay: { ...facts().inPlay, lock: false } })), "in_play").answer, "yes", "in play off: nothing to hedge first during a game");
  };
  no({ strategy: "book", live: null }, /the hedge strategy is "book", not live: every lock is a simulated record/);
  no(live({ killSwitch: true }), /the kill switch is on/);
  no(live({ dryRun: true }), /sending is off \(EVENT_HEDGE_LIVE_SEND is not yes\)/);
  no(live({ venues: [] }), /no hedge venue has a key to send with/);
  no(live({ anyTicker: false, allowlist: ["KXNBAGAME-26OCT14LALBOS-BOS"] }), /only 1 named game is armed .*Set EVENT_HEDGE_LIVE_TICKERS=\* to arm every game/);
  no(live({ anyTicker: false, allowlist: [] }), /only 0 named games are armed/);

  // a venue with no key: the books decide whether a lock lands there, so it is neither yes nor no
  const part = pilotCheck(facts(live({ venues: ["kalshi", "novig"] })));
  assert.equal(item(part, "hedge_first").answer, CANNOT);
  assert.match(item(part, "hedge_first").detail, /a key to send with on Kalshi, Novig\..* But there is no key to send with on Polymarket, ProphetX\./);
  assert.match(item(part, "hedge_first").confirm ?? "", /refused for them instead of written with nothing bought behind it\. Holders with a key and not named there now: ann, bob\./);
  assert.equal(item(part, "in_play").answer, CANNOT);
  assert.equal(part.ready, "yes", "nothing is a no; it is on the list to confirm");
  assert.match(part.overall, /Left to confirm by hand: 1 hedge_first, 5 in_play, 8 backup, 9 keys_rotated\.$/);
});

test("pilot check, request for quote: a real quote can be accepted with the lock already written, outside the kill switch and the order caps; three conditions say no", () => {
  const r = pilotCheck(facts({ strategy: "rfq", live: null, rfqVenues: ["kalshi"] }));
  assert.equal(item(r, "hedge_first").answer, "no");
  assert.match(item(r, "hedge_first").detail, /request for quote, with a key that can accept a quote on Kalshi: the lock is written first/);
  // the switch stands in front of request for quote as well: off here, and it would stop this strategy
  assert.equal(item(r, "kill_switch").answer, "yes");
  assert.match(item(r, "kill_switch").detail, /in front of every hedge order this service can send: the live strategy's buys and sales, the operator's resend, and the request-for-quote strategy/);
  assert.match(item(r, "kill_switch").detail, /Its state now: off\./);
  assert.equal(item(r, "caps").answer, "no");
  assert.match(item(r, "caps").detail, /per-order and per-day caps belong to the live strategy and do not apply .* the per-game, per-venue and per-holder caps do apply/);
  // with no key that can accept, nothing can leave: simulated like the book strategy, and the switch is not the problem
  const paper = pilotCheck(facts({ strategy: "rfq", live: null, rfqVenues: [] }));
  assert.match(item(paper, "hedge_first").detail, /the hedge strategy is "rfq", not live: every lock is a simulated record/);
  assert.equal(item(paper, "kill_switch").answer, "yes");
  assert.equal(item(paper, "caps").answer, "yes");
  // the switch on under request for quote: no venue can accept (hedgeExecutorFromEnv builds no client), and the state is said
  const stopped = pilotCheck(facts({ strategy: "rfq", live: null, rfqVenues: [], killSwitch: true }));
  assert.equal(item(stopped, "kill_switch").answer, "yes");
  assert.match(item(stopped, "kill_switch").detail, /Its state now: ON\. No hedge order and no quote request leaves/);
  assert.equal(item(stopped, "hedge_first").answer, "no");
});

test("pilot check, real-only holders: with every holder named, a lock that would be written with nothing bought is refused instead, and the two cases that turned on it are a yes", () => {
  const named = { realOnly: { everyone: false, notRealOnly: [], notes: [] } };
  const everyone = { realOnly: { everyone: true, notRealOnly: [], notes: [] } };
  for (const ro of [named, everyone]) {
    // a venue with no key: was "cannot be checked", because the books decide; now the tap there is refused
    const part = pilotCheck(facts({ ...live({ venues: ["kalshi", "novig"] }), ...ro }));
    assert.equal(item(part, "hedge_first").answer, "yes");
    assert.match(item(part, "hedge_first").detail, /There is no key to send with on Polymarket, ProphetX\. Every holder with a key is real-only \(EVENT_SHADOW_REAL_ONLY_HOLDERS\), so a tap whose other side prices best on one of those venues is refused in plain words and nothing is written\./);
    assert.equal(item(part, "in_play").answer, "yes");
    // only named games armed: was a no; now a tap on any other game is refused
    const armed = pilotCheck(facts({ ...live({ anyTicker: false, allowlist: ["KXNBAGAME-26OCT14LALBOS-BOS"] }), ...ro }));
    assert.equal(item(armed, "hedge_first").answer, "yes");
    assert.match(item(armed, "hedge_first").detail, /Only 1 named game is armed \(EVENT_HEDGE_LIVE_TICKERS\)\. Every holder with a key is real-only .* a tap on any other game is refused/);
    // settings under which nothing real can be bought at all stay a no: nobody outside could lock anything
    for (const over of [{ strategy: "book", live: null }, live({ killSwitch: true }), live({ dryRun: true }), live({ venues: [] })] as Array<Partial<PilotFacts>>) {
      const r = pilotCheck(facts({ ...over, ...ro }));
      assert.equal(item(r, "hedge_first").answer, "no", JSON.stringify(over));
      assert.match(item(r, "hedge_first").detail, /a real-only holder's tap is refused, so nobody outside can lock anything/);
    }
  }
  // one holder left out: the two cases are what they were, and the line names who is not real-only
  const one = { realOnly: { everyone: false, notRealOnly: ["bob"], notes: [] } };
  const part = pilotCheck(facts({ ...live({ venues: ["kalshi", "novig"] }), ...one }));
  assert.equal(item(part, "hedge_first").answer, CANNOT);
  assert.match(item(part, "hedge_first").confirm ?? "", /Name each outside holder in EVENT_SHADOW_REAL_ONLY_HOLDERS, so a lock whose other side prices best on Polymarket, ProphetX is refused for them instead of written with nothing bought behind it\. Holders with a key and not named there now: bob\./);
  const armed = pilotCheck(facts({ ...live({ anyTicker: false, allowlist: [] }), ...one }));
  assert.equal(item(armed, "hedge_first").answer, "no");
  assert.match(item(armed, "hedge_first").detail, /or name each outside holder in EVENT_SHADOW_REAL_ONLY_HOLDERS so their tap there is refused instead/);
  // no holder has a key at all: "every holder" is nobody, and that is not a yes
  const nobody = pilotCheck(facts({ ...live({ venues: ["kalshi"] }), holderKeys: { ...facts().holderKeys, listed: 0, accepted: 0 }, realOnly: { everyone: false, notRealOnly: [], notes: [] } }));
  assert.equal(item(nobody, "hedge_first").answer, CANNOT);
});

test("pilot check, kill switch: exercised on a made-up order that goes nowhere, and its state said", () => {
  const t = killSwitchSelfTest();
  assert.equal(t.ok, true);
  assert.equal(t.steps.length, 4);
  assert.match(t.steps[3].step, /request-for-quote strategy builds nothing that can ask for a quote or accept one/);
  assert.ok(t.steps.every((s) => s.ok));
  const off = item(pilotCheck(facts()), "kill_switch");
  assert.equal(off.answer, "yes");
  assert.match(off.detail, /Its state now: off\./);
  assert.match(off.detail, /read once when the service starts/);
  const on = item(pilotCheck(facts({ ...live({ killSwitch: true }), killSwitch: true })), "kill_switch");
  assert.equal(on.answer, "yes", "on is the switch working, not a fault");
  assert.match(on.detail, /Its state now: ON\. No hedge order and no quote request leaves/);
  assert.match(on.detail, /It does not reach a member's own sale in their own venue account/);
});

test("pilot check, caps: every one a number is a yes and the numbers are shown; any set to no cap is a no naming it", () => {
  const ok = item(pilotCheck(facts({ exposureCaps: { ...CAPS, venueOverrides: { novig: 2_500 } } })), "caps");
  assert.equal(ok.answer, "yes");
  assert.equal(ok.detail, "The caps now: per order 25 hedge contracts; per day 100 hedge contracts; per game $50.00; per venue $100.00 (Novig $25.00); per holder $50.00.");
  for (const [caps, named] of [
    [{ ...CAPS, gameCents: null }, /Set to no cap: EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_GAME\./],
    [{ ...CAPS, venueCents: null }, /Set to no cap: EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_VENUE\./],
    [{ ...CAPS, holderCents: null }, /Set to no cap: EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_HOLDER\./],
  ] as Array<[ExposureCaps, RegExp]>) {
    const r = pilotCheck(facts({ exposureCaps: caps }));
    assert.equal(item(r, "caps").answer, "no");
    assert.match(item(r, "caps").detail, named);
    assert.equal(r.ready, "no");
  }
  // zero is a number: nothing may be open, which is a cap
  assert.equal(item(pilotCheck(facts({ exposureCaps: { ...CAPS, gameCents: 0 } })), "caps").answer, "yes");
  // a setting that could not be read is said, with the default that applies
  const noted = item(pilotCheck(facts({ exposureCaps: { ...CAPS, notes: ["EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_GAME is neither a whole number of cents nor the word none; 5000 cents applies"] } })), "caps");
  assert.equal(noted.answer, "yes");
  assert.match(noted.detail, /could not be read, so the default applies: EVENT_HEDGE_LIVE_MAX_OPEN_CENTS_PER_GAME/);
});

test("pilot check, holder keys: counted from the same rules the lock gate uses, and never shown", () => {
  const SHARED = "shared-key-0123456789";
  const TOKEN = "operator-token-abcdef";
  const env = {
    EVENT_SHADOW_LOCK_KEY: SHARED,
    EVENT_SHADOW_HOLDER_KEYS: ["ann:ann-key-0123456789", "bo:bo-key-0123456789ab", `cy:${SHARED}`, "ann:another-key-012345", "dee:ann-key-0123456789", "ed:short", "bad!name:whatever-key-0123", `fay:${TOKEN}`].join(","),
  };
  const counts = holderKeyCounts(env, TOKEN);
  assert.deepEqual(counts, { listed: 8, accepted: 3, dropped: { badAlias: 1, shortKey: 1, equalsSharedKey: 1, aliasTwice: 1, keyTwice: 1 }, equalOperatorToken: 1, sharedKeySet: true });
  assert.equal(counts.accepted, holderKeysFromEnv(env).holders.length, "the same holders the lock gate will name");
  assert.deepEqual(holderKeyCounts({}, null), { listed: 0, accepted: 0, dropped: { badAlias: 0, shortKey: 0, equalsSharedKey: 0, aliasTwice: 0, keyTwice: 0 }, equalOperatorToken: 0, sharedKeySet: false });
  assert.equal(holderKeyCounts({ EVENT_SHADOW_LOCK_KEY: "short" }, null).sharedKeySet, false, "a shared key under 12 characters is not in force");

  const r = pilotCheck(facts({ holderKeys: counts, sharedOpenLocks: 3 }));
  const k = item(r, "holder_keys");
  assert.equal(k.answer, "no");
  assert.match(k.detail, /5 listed keys are not in force/);
  assert.match(k.detail, /1 lock key is the same as the operator token/);
  assert.match(k.detail, /Counts only, no key is shown: 8 holder keys listed, 3 in force, 5 not in force \(1 with the shared key as their key; 1 with a key another holder already has; 1 with a name listed twice; 1 with a key under 12 characters; 1 with a name that is not 2 to 24 of a-z 0-9 _ -\); shared key set\./);
  const all = JSON.stringify(r);
  for (const secret of [SHARED, TOKEN, "ann-key-0123456789", "bo-key-0123456789ab", "another-key-012345"]) assert.ok(!all.includes(secret), "no key or token in the report");

  const yes = facts().holderKeys;
  // every holder with a key of their own, the shared key still set: who holds it cannot be seen from here
  const shared = item(pilotCheck(facts({ holderKeys: { ...yes, sharedKeySet: true }, sharedOpenLocks: 3 })), "holder_keys");
  assert.equal(shared.answer, CANNOT);
  assert.match(shared.confirm ?? "", /The shared key is set \(3 open locks on its ledger\).*given to nobody outside the company, or unset EVENT_SHADOW_LOCK_KEY/);
  // nobody has a key of their own
  const none = item(pilotCheck(facts({ holderKeys: { ...yes, listed: 0, accepted: 0, sharedKeySet: true } })), "holder_keys");
  assert.equal(none.answer, "no");
  assert.match(none.detail, /no holder has a key of their own, so every lock would be made with the shared key/);
  // the operator views open to anyone: the operator acts as the shared holder, so anyone can lock
  const open = item(pilotCheck(facts({ operatorOpen: true })), "holder_keys");
  assert.equal(open.answer, "no");
  assert.match(open.detail, /the operator token is not set and the operator views answer anyone/);
});

test("pilot check, in play: its state and its gates, and the scan's and the member sale's switches beside it", () => {
  const on = item(pilotCheck(facts()), "in_play");
  assert.equal(on.answer, "yes");
  assert.match(on.detail, /^On \(EVENT_X_IN_PLAY\): a game can be locked in until 4 hours after its start\. Its gates: the hedge is bought first, all or none/);
  assert.match(on.detail, /The simulated scan stays before the start\./);
  assert.match(on.detail, /A member selling their own position during a game is on \(MEMBER_APP_IN_PLAY\)/);
  const off = item(pilotCheck(facts({ inPlay: { lock: false, hours: 4, cutoffMinutes: 45, scan: true, memberSale: false } })), "in_play");
  assert.equal(off.answer, "yes");
  assert.match(off.detail, /^Off \(EVENT_X_IN_PLAY=0\): a lock closes 45 minutes before the start\. The simulated scan also opens records on games under way/);
});

test("pilot check, ledger disk: on the mounted disk and a filesystem of its own is a yes; a temp folder, off the mount, or no disk there is a no; a mount that cannot be read is neither", () => {
  const disk = (over: Partial<PilotFacts["disk"]>): PilotItem => item(pilotCheck(facts({ disk: { ...facts().disk, ...over } })), "ledger_disk");
  const yes = disk({});
  assert.equal(yes.answer, "yes");
  assert.match(yes.detail, /Every ledger path is under \/var\/data, none is under a temp folder, and \/var\/data is a filesystem of its own \(ext4\)/);

  const temp = disk({ paths: [{ what: "the lock ledgers", path: "/tmp/event-demo/lock-ledger.jsonl" }, LEDGERS[1]] });
  assert.equal(temp.answer, "no");
  assert.match(temp.detail, /Under a temp folder, which is lost on every restart: the lock ledgers \/tmp\/event-demo\/lock-ledger\.jsonl\./);
  // a temp folder under the mount is still a temp folder; a path that only starts like the mount is not under it
  assert.equal(disk({ tempDirs: ["/var/data/event-shadow"] }).answer, "no");
  const beside = disk({ paths: [{ what: "the lock ledgers", path: "/var/database/lock-ledger.jsonl" }] });
  assert.equal(beside.answer, "no");
  assert.match(beside.detail, /Not under \/var\/data, where the disk is mounted: the lock ledgers \/var\/database\/lock-ledger\.jsonl\./);

  const same = disk({ mountDev: 2048 });
  assert.equal(same.answer, "no");
  assert.match(same.detail, /\/var\/data is on the same filesystem as the service's own files: no persistent disk is mounted there/);
  const ram = disk({ mountFsType: "tmpfs" });
  assert.equal(ram.answer, "no");
  assert.match(ram.detail, /\/var\/data is a tmpfs filesystem/);

  const unread = disk({ mountDev: null });
  assert.equal(unread.answer, CANNOT);
  assert.match(unread.confirm ?? "", /a disk is attached to this service at \/var\/data/);
});

test("pilot check, alerts: a sink set is a yes that says what it does not prove; none is a no naming the settings", () => {
  const yes = item(pilotCheck(facts({ alerts: { telegram: true, webhook: true } })), "alerts");
  assert.equal(yes.answer, "yes");
  assert.match(yes.detail, /Configured: Telegram and a webhook .* not that a message arrives/);
  const no = item(pilotCheck(facts({ alerts: { telegram: false, webhook: false } })), "alerts");
  assert.equal(no.answer, "no");
  assert.match(no.detail, /EVENT_SHADOW_ALERT_BOT_TOKEN and EVENT_SHADOW_ALERT_CHAT_ID, or EVENT_SHADOW_ALERT_WEBHOOK_URL/);
});

test("pilot check, the readers: the machine's own word on a folder and a mount, and null where there is none", () => {
  assert.equal(listDir("/no/such/folder/anywhere"), null);
  assert.ok(Array.isArray(listDir("/")));
  const d = readDiskFacts("/no/such/mount", LEDGERS, ["/tmp"]);
  assert.equal(d.mountDev, null);
  assert.equal(d.mountFsType, null);
  assert.equal(typeof d.rootDev, "number");
  const root = readDiskFacts("/", LEDGERS, ["/tmp"]);
  assert.equal(root.mountDev, root.rootDev);
});

test("pilot check, wording: plain words in every answer under every setting; no dash, and none of the words a reader must not be shown", () => {
  const variants: Array<Partial<PilotFacts>> = [
    {},
    { strategy: "book", live: null },
    { strategy: "rfq", live: null, rfqVenues: ["kalshi", "polymarket"] },
    live({ killSwitch: true }),
    live({ dryRun: true }),
    live({ venues: ["kalshi"] }),
    live({ anyTicker: false, allowlist: ["A", "B"] }),
    { ...live({ anyTicker: false, allowlist: ["A", "B"] }), realOnly: { everyone: true, notRealOnly: [], notes: [] } },
    { ...live({ venues: ["kalshi"] }), realOnly: { everyone: false, notRealOnly: [], notes: [] } },
    { ...live({ killSwitch: true }), killSwitch: true, realOnly: { everyone: true, notRealOnly: [], notes: [] } },
    { strategy: "rfq", live: null, rfqVenues: [], killSwitch: true },
    { exposureCaps: { gameCents: null, venueCents: null, venueOverrides: { kalshi: 100 }, holderCents: null, notes: ["x could not be read"] } },
    { holderKeys: { listed: 5, accepted: 0, dropped: { badAlias: 1, shortKey: 1, equalsSharedKey: 1, aliasTwice: 1, keyTwice: 1 }, equalOperatorToken: 2, sharedKeySet: true }, operatorOpen: true },
    { holderKeys: { ...facts().holderKeys, sharedKeySet: true } },
    { inPlay: { lock: false, hours: 1, cutoffMinutes: 45, scan: true, memberSale: false } },
    { disk: { ...facts().disk, mountDev: null } },
    { disk: { ...facts().disk, mountFsType: "overlay" } },
    { disk: { ...facts().disk, paths: [{ what: "the lock ledgers", path: "/tmp/x.jsonl" }] } },
    { alerts: { telegram: false, webhook: false } },
    { termsOnRecord: null, docs: null, workflows: null },
    { termsOnRecord: { version: "v1", holders: 0, missing: ["ann", "bo"], notes: [] }, docs: [], workflows: [] },
    { termsOnRecord: { version: null, holders: 0, missing: ["ann", "bo"], notes: ["x could not be read"] } },
  ];
  for (const v of variants) {
    const r = pilotCheck(facts(v));
    const text = [r.note, r.overall, ...r.no, ...r.confirmByHand, ...r.items.flatMap((i) => [i.condition, i.detail, i.confirm ?? ""])].join("\n");
    assert.ok(!/[\u2013\u2014]/.test(text), `a dash in: ${JSON.stringify(v)}`);
    assert.ok(!/\bprotect|wallet|guarantee/i.test(text.replace(/MEMBER_APP_IN_PLAY|Earn & Protect/g, "")), `a word that must not be shown: ${JSON.stringify(v)}`);
    for (const i of r.items) {
      assert.ok(["yes", "no", CANNOT].includes(i.answer));
      assert.equal(i.confirm !== undefined, i.answer === CANNOT, `${i.id}: what to confirm is there exactly when it cannot be checked`);
      assert.ok(i.detail.length > 0);
    }
    assert.equal(r.ready, r.items.some((i) => i.answer === "no") ? "no" : "yes");
    assert.ok(r.overall.startsWith(`ready for an outside holder: ${r.ready}`));
  }
  // nothing left to confirm is a plain yes; no configuration of today's service reaches it, and the line is still exact
  const base = pilotCheck(facts());
  assert.equal(base.items.filter((i) => i.answer === CANNOT).length, 2);
});
