/**
 * THE PILOT SWITCH CHECK: what must be true before a person outside the company holds a
 * real-money lock, each condition answered one of three ways.
 *
 *   yes                            computed here, from the settings and files this service reads
 *   no                             computed here, with the reason
 *   cannot be checked from here    nothing this service can read decides it; the line says what
 *                                  to confirm by hand
 *
 * Nothing is guessed: a condition this service cannot see is never a yes. The check reads and
 * reports. It changes nothing and gates nothing: a lock is allowed or refused by the rails
 * (liveHedge.ts), the hedge-first sequence (hedgeFirst.ts) and the exposure caps
 * (exposureCaps.ts), whatever this says.
 *
 * `pilotCheck` is pure: the worker hands it the facts (its own settings as read at start, and
 * what the three small readers below found on disk). No key, token or address is ever in the
 * facts or the report; holder keys are counted, never shown.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { EXPOSURE_VENUES, EXPOSURE_VENUE_NAMES, uncappedSettings, venueCapOf, type CapCents, type ExposureCaps } from "./exposureCaps";
import type { HedgeIntent, HedgeVenue } from "./hedgeExecutor";
import { lockMode, type LiveRailsView } from "./hedgeFirst";
import { DEFAULT_LIVE_RAILS, checkRails, liveRailsFromEnv } from "./liveHedge";
import { hedgeExecutorFromEnv } from "./hedgeExecutorFromEnv";
import { HOLDER_ALIAS_RE } from "./lockGate";
import { REAL_ONLY_ENV } from "./realOnlyHolders";

export type PilotAnswer = "yes" | "no" | "cannot be checked from here";
export const CANNOT: PilotAnswer = "cannot be checked from here";

export interface PilotItem {
  n: number;
  id: string;
  /** the condition, as a sentence that is true when the answer is yes */
  condition: string;
  answer: PilotAnswer;
  /** what was read and what it says */
  detail: string;
  /** with "cannot be checked from here": what to confirm by hand */
  confirm?: string;
}

export interface PilotReport {
  /** the route's own word on what it is */
  note: string;
  ready: "yes" | "no";
  /** the one line: "ready for an outside holder: yes" or "... no", with what stands in the way or what is left to confirm */
  overall: string;
  /** the conditions answered no, by number and id */
  no: string[];
  /** what is left to confirm by hand, one line per condition that cannot be checked from here */
  confirmByHand: string[];
  items: PilotItem[];
}

export interface HolderKeyCounts {
  /** `alias:key` pairs listed in EVENT_SHADOW_HOLDER_KEYS */
  listed: number;
  /** pairs that stand: each a distinct alias with a distinct key of 12 characters or more */
  accepted: number;
  /** pairs that do not stand, by why */
  dropped: { badAlias: number; shortKey: number; equalsSharedKey: number; aliasTwice: number; keyTwice: number };
  /** keys (a holder's or the shared one) equal to the operator token */
  equalOperatorToken: number;
  sharedKeySet: boolean;
}

export interface DiskFacts {
  /** where the persistent disk is mounted */
  mount: string;
  /** the ledgers, each by what it is and where it is */
  paths: Array<{ what: string; path: string }>;
  /** the temp directories a ledger must not be under */
  tempDirs: string[];
  /** device ids of the mount and of the root filesystem; null when one could not be read */
  mountDev: number | null;
  rootDev: number | null;
  /** the mount's filesystem type from the mount table; null when the table could not be read or does not list it */
  mountFsType: string | null;
}

export interface PilotFacts {
  /** EVENT_HEDGE_STRATEGY as chosen: book (nothing leaves), rfq (request for quote) or live */
  strategy: string;
  /** venues where the request-for-quote strategy holds a key that can accept a quote; empty in any other strategy */
  rfqVenues: HedgeVenue[];
  /** EVENT_HEDGE_KILL_SWITCH as read at start; in force in every strategy */
  killSwitch: boolean;
  /**
   * Who is real-only (realOnlyHolders.ts): `everyone` when the setting is `*`; else `notRealOnly`
   * lists the holders with a key who are not named, by alias. For a real-only holder a tap where
   * the hedge would not truly be bought is refused instead of written on paper.
   */
  realOnly: { everyone: boolean; notRealOnly: string[]; notes: string[] };
  /** the live rails as this process read them at start; null when the strategy is not live */
  live: (LiveRailsView & { maxContractsPerOrder: number; maxContractsPerDay: number }) | null;
  /** the order rails as the env sets them, live or not (a positive whole number always: anything else is the default) */
  orderRails: { maxContractsPerOrder: number; maxContractsPerDay: number };
  exposureCaps: ExposureCaps;
  holderKeys: HolderKeyCounts;
  /** operator routes answer anyone: no operator token is set and the development switch is on */
  operatorOpen: boolean;
  /** open locks on the shared key's ledger */
  sharedOpenLocks: number;
  /** the lock path's in-play switch and bound, the pre-game cutoff that applies with it off, the scan's switch and the member sale's */
  inPlay: { lock: boolean; hours: number; cutoffMinutes: number; scan: boolean; memberSale: boolean };
  disk: DiskFacts;
  alerts: { telegram: boolean; webhook: boolean };
  /**
   * The user terms in force and the holders with a key who have accepted that version
   * (termsAcceptance.ts): how many have, and the aliases that have not. `version` is null when
   * the terms settings could not be read (the notes say which). The whole fact is null while no
   * terms are in force, which is a no: nothing asks a holder to accept.
   */
  termsOnRecord: { version: string | null; holders: number; missing: string[]; notes: string[] } | null;
  /** file names in docs/, or null when the caller does not read them (the service does not: a documents-only merge does not restart it) */
  docs: string[] | null;
  /** workflow file names in .github/workflows, or null when the caller does not read them */
  workflows: string[] | null;
}

// ---------------------------------------------------------------------------
// the readers (the only parts that touch the machine)
// ---------------------------------------------------------------------------

const underDir = (path: string, dir: string): boolean => {
  const p = resolve(path);
  const d = resolve(dir);
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
};

/** Where the ledgers are, where the disk is mounted, and what the machine says of that mount. */
export function readDiskFacts(mount: string, paths: DiskFacts["paths"], tempDirs: string[]): DiskFacts {
  const dev = (p: string): number | null => {
    try {
      return statSync(p).dev;
    } catch {
      return null;
    }
  };
  let mountFsType: string | null = null;
  try {
    // the last line for a mount point is the one in effect
    for (const line of readFileSync("/proc/mounts", "utf8").split("\n")) {
      const [, at, type] = line.split(" ");
      if (at === resolve(mount) && type) mountFsType = type;
    }
  } catch {
    // no mount table on this machine: said as such
  }
  return { mount, paths, tempDirs, mountDev: dev(mount), rootDev: dev("/"), mountFsType };
}

/** File names in a folder, or null when it is not there. */
export function listDir(dir: string): string[] | null {
  try {
    return existsSync(dir) ? readdirSync(dir).sort() : null;
  } catch {
    return null;
  }
}

/**
 * The holder keys counted, never shown. The same rules as lockGate.holderKeysFromEnv, in the same
 * order, so `accepted` is the number of holders that service will name; this returns numbers only.
 */
export function holderKeyCounts(env: NodeJS.ProcessEnv, operatorToken: string | null): HolderKeyCounts {
  const shared = (env.EVENT_SHADOW_LOCK_KEY ?? "").trim();
  const sharedKey = shared.length >= 12 ? shared : null;
  const dropped = { badAlias: 0, shortKey: 0, equalsSharedKey: 0, aliasTwice: 0, keyTwice: 0 };
  const aliases = new Set<string>();
  const keys = new Set<string>();
  let listed = 0;
  for (const pair of (env.EVENT_SHADOW_HOLDER_KEYS ?? "").split(/[,\s]+/)) {
    if (!pair) continue;
    listed += 1;
    const i = pair.indexOf(":");
    const alias = (i === -1 ? pair : pair.slice(0, i)).trim().toLowerCase();
    const key = i === -1 ? "" : pair.slice(i + 1).trim();
    if (!HOLDER_ALIAS_RE.test(alias)) dropped.badAlias += 1;
    else if (key.length < 12) dropped.shortKey += 1;
    else if (sharedKey && key === sharedKey) dropped.equalsSharedKey += 1;
    else if (aliases.has(alias)) dropped.aliasTwice += 1;
    else if (keys.has(key)) dropped.keyTwice += 1;
    else {
      aliases.add(alias);
      keys.add(key);
    }
  }
  const equalOperatorToken = operatorToken ? [...keys, ...(sharedKey ? [sharedKey] : [])].filter((k) => k === operatorToken).length : 0;
  return { listed, accepted: keys.size, dropped, equalOperatorToken, sharedKeySet: sharedKey !== null };
}

// ---------------------------------------------------------------------------
// the check
// ---------------------------------------------------------------------------

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const capWord = (c: CapCents): string => (c === null ? "no cap" : usd(c));
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const venueNames = (vs: readonly HedgeVenue[]): string => vs.map((v) => EXPOSURE_VENUE_NAMES[v]).join(", ");

/** A real order can leave by request for quote: the one way out that is not the live executor. */
const rfqCanSend = (f: PilotFacts): boolean => f.strategy === "rfq" && f.rfqVenues.length > 0;

/**
 * Is every lock a real-money, hedge-first lock under these settings? `no` with the reason when
 * the settings say some or all are not; `cannot` when the settings allow it and the books decide.
 */
function hedgeFirstInEffect(f: PilotFacts): { answer: "yes"; note?: string } | { answer: "no"; why: string } | { answer: "cannot"; why: string; confirm: string } {
  // every holder with a key is real-only: where an order would not truly leave, their tap is refused, not written on paper
  const allRealOnly = f.realOnly.everyone || (f.holderKeys.accepted > 0 && f.realOnly.notRealOnly.length === 0);
  const paper = allRealOnly ? "a real-only holder's tap is refused, so nobody outside can lock anything" : "every lock is a simulated record and nothing is bought";
  const orMark = allRealOnly ? "" : `, or name each outside holder in ${REAL_ONLY_ENV} so their tap there is refused instead`;
  if (rfqCanSend(f)) {
    return { answer: "no", why: `the hedge strategy is request for quote, with a key that can accept a quote on ${venueNames(f.rfqVenues)}: the lock is written first and the hedge is asked for after it, and a quote it accepts is real money` };
  }
  if (!f.live) return { answer: "no", why: `the hedge strategy is "${f.strategy}", not live: ${paper}` };
  if (f.live.killSwitch) return { answer: "no", why: `the kill switch is on: ${paper}` };
  if (f.live.dryRun) return { answer: "no", why: `sending is off (EVENT_HEDGE_LIVE_SEND is not yes): ${paper}` };
  if (f.live.venues.length === 0) return { answer: "no", why: `no hedge venue has a key to send with: ${paper}` };
  const realOnlyNote = (where: string): string => `Every holder with a key is real-only (${REAL_ONLY_ENV}), so a tap ${where} is refused in plain words and nothing is written.`;
  if (!f.live.anyTicker) {
    const n = f.live.allowlist.length;
    if (allRealOnly) return { answer: "yes", note: `Only ${plural(n, "named game")} ${n === 1 ? "is" : "are"} armed (EVENT_HEDGE_LIVE_TICKERS). ${realOnlyNote("on any other game")}` };
    return { answer: "no", why: `only ${plural(n, "named game")} ${n === 1 ? "is" : "are"} armed (EVENT_HEDGE_LIVE_TICKERS): a lock on any other game is a simulated record with nothing bought, and it reads to its holder like any other lock. Set EVENT_HEDGE_LIVE_TICKERS=* to arm every game${orMark}` };
  }
  const without = EXPOSURE_VENUES.filter((v) => !f.live?.venues.includes(v));
  if (without.length) {
    if (allRealOnly) return { answer: "yes", note: `There is no key to send with on ${venueNames(without)}. ${realOnlyNote(`whose other side prices best on ${without.length === 1 ? "that venue" : "one of those venues"}`)}` };
    return {
      answer: "cannot",
      why: `no key to send with on ${venueNames(without)}. The other side of a lock is bought where it prices best, and a lock whose other side is there is written as a simulated record with nothing bought; it reads to its holder like any other lock. Which venue a lock will use depends on the books at that moment, so it cannot be told from the settings`,
      confirm: `Name each outside holder in ${REAL_ONLY_ENV}, so a lock whose other side prices best on ${venueNames(without)} is refused for them instead of written with nothing bought behind it. Holders with a key and not named there now: ${f.realOnly.notRealOnly.length ? f.realOnly.notRealOnly.join(", ") : "none listed"}. The hedge trail (/api/shadow/hedges) shows each lock's hedge and whether an order was sent.`,
    };
  }
  return { answer: "yes" };
}

/**
 * The kill switch, exercised on a made-up order that goes nowhere: the setting is read as on, the
 * lock path stands down from real money, and the executor's first rail refuses. Each of the three
 * with the switch off does the opposite, so the test is of the switch and nothing else.
 */
export function killSwitchSelfTest(): { ok: boolean; steps: Array<{ step: string; ok: boolean }> } {
  const probe: HedgeIntent = {
    venue: "kalshi",
    instrument: "KXPILOTCHECK-PROBE-X",
    outcome: "No",
    unitsMilli: 1_000,
    book: { bestPriceMilli: 500, avgPriceMilli: 500, worstPriceMilli: 500, costCents: 50 },
    maxCostCents: 50,
  };
  const view: LiveRailsView = { killSwitch: false, dryRun: false, allowlist: [], anyTicker: true, venues: ["kalshi"] };
  const rails = { ...DEFAULT_LIVE_RAILS, dryRun: false, anyTicker: true };
  const on = lockMode({ ...view, killSwitch: true }, probe);
  // the request-for-quote strategy with the switch on, given keys that are made up and never used: no client may be built
  const rfqEnv = { EVENT_HEDGE_STRATEGY: "rfq", KALSHI_API_KEY_ID: "pilot-check-probe", KALSHI_PRIVATE_KEY_PEM: "pilot-check-probe" };
  const rfqOn = hedgeExecutorFromEnv({ ...rfqEnv, EVENT_HEDGE_KILL_SWITCH: "1" });
  const rfqOff = hedgeExecutorFromEnv(rfqEnv);
  const steps = [
    { step: "EVENT_HEDGE_KILL_SWITCH=1 is read as on, and unset as off", ok: liveRailsFromEnv({ EVENT_HEDGE_KILL_SWITCH: "1" }).killSwitch === true && liveRailsFromEnv({}).killSwitch === false },
    { step: "with it on the lock path does not treat a lock as real money; with it off it does", ok: on.real === false && on.why === "kill_switch" && lockMode(view, probe).real === true },
    { step: "with it on the executor refuses the order before any other rail; with it off the same order passes", ok: checkRails(probe, { ...rails, killSwitch: true }, 0, true)?.rail === "kill_switch" && checkRails(probe, rails, 0, true) === null },
    {
      step: "with it on the request-for-quote strategy builds nothing that can ask for a quote or accept one, key or no key; with it off and a key it does",
      ok: rfqOn.killSwitch === true && rfqOn.rfqVenues.length === 0 && rfqOn.executor.strategy === "book" && rfqOff.killSwitch === false && rfqOff.rfqVenues.includes("kalshi") && rfqOff.executor.strategy === "rfq",
    },
  ];
  return { ok: steps.every((s) => s.ok), steps };
}

export const PILOT_NOTE = "This check reads settings and files and reports what it finds. It changes nothing and gates nothing: a lock is allowed or refused by the rails and the caps, whatever this page says.";

export function pilotCheck(f: PilotFacts): PilotReport {
  const items: PilotItem[] = [];
  const add = (id: string, condition: string, answer: PilotAnswer, detail: string, confirm?: string): void => {
    items.push({ n: items.length + 1, id, condition, answer, detail, ...(answer === CANNOT && confirm ? { confirm } : {}) });
  };
  const hf = hedgeFirstInEffect(f);
  const liveLine = `Live, sending, every game armed, kill switch off, a key to send with on ${venueNames(f.live?.venues ?? [])}.`;
  const onePath = "Where the live executor would truly send an order the code has one path, and it is this one (hedgeFirst.ts): the pending line, the order all or none, then the lock only if the whole hedge filled.";

  // 1
  add(
    "hedge_first",
    "A real-money lock buys the hedge first, and the lock is written only behind a whole fill; that is the path every lock takes.",
    hf.answer === "cannot" ? CANNOT : hf.answer,
    hf.answer === "yes" ? `${liveLine} ${onePath}${hf.note ? ` ${hf.note}` : ""}` : hf.answer === "no" ? `Not for every lock: ${hf.why}. ${onePath}` : `${liveLine} ${onePath} But there is ${hf.why}.`,
    hf.answer === "cannot" ? hf.confirm : undefined,
  );

  // 2
  const ks = killSwitchSelfTest();
  const ksState = f.killSwitch
    ? "Its state now: ON. No hedge order and no quote request leaves; a lock is a simulated record, or a refusal for a real-only holder."
    : f.strategy === "book"
      ? `Its state now: off. Nothing leaves under these settings in any case: the hedge strategy is "book".`
      : "Its state now: off.";
  const ksScope = "It stands in front of every hedge order this service can send: the live strategy's buys and closes, the operator's resend, and the request-for-quote strategy. It does not reach a member's own order in their own venue account (the member app), which is the member's order, nor the operator's Kalshi account routes.";
  add(
    "kill_switch",
    "The kill switch stops every hedge order in every strategy, and its state is known.",
    ks.ok ? "yes" : "no",
    ks.ok
      ? `Tested here on a made-up order that is sent nowhere: ${ks.steps.map((s) => s.step).join("; ")}. ${ksScope} ${ksState} It is read once when the service starts: to use it, set EVENT_HEDGE_KILL_SWITCH=1 on the service and let it restart. An order already at the venue is not recalled.`
      : `The test on a made-up order failed: ${ks.steps.filter((s) => !s.ok).map((s) => s.step).join("; ")}. ${ksState}`,
  );

  // 3
  const uncapped = uncappedSettings(f.exposureCaps);
  const venueCaps = EXPOSURE_VENUES.filter((v) => f.exposureCaps.venueOverrides[v] !== undefined).map((v) => `${EXPOSURE_VENUE_NAMES[v]} ${capWord(venueCapOf(f.exposureCaps, v))}`);
  const capsLine = `per order ${plural(f.orderRails.maxContractsPerOrder, "hedge contract")}; per day ${plural(f.orderRails.maxContractsPerDay, "hedge contract")}; per game ${capWord(f.exposureCaps.gameCents)}; per venue ${capWord(f.exposureCaps.venueCents)}${venueCaps.length ? ` (${venueCaps.join(", ")})` : ""}; per holder ${capWord(f.exposureCaps.holderCents)}`;
  const notes = f.exposureCaps.notes.length ? ` Settings that could not be read, so the default applies: ${f.exposureCaps.notes.join("; ")}.` : "";
  add(
    "caps",
    "The per-order, per-day, per-game, per-venue and per-holder caps are each set to a number.",
    uncapped.length || rfqCanSend(f) ? "no" : "yes",
    `${uncapped.length ? `Set to no cap: ${uncapped.join(", ")}. ` : ""}${rfqCanSend(f) ? "The per-order and per-day caps belong to the live strategy and do not apply to a request-for-quote order, which is what can leave under these settings; the per-game, per-venue and per-holder caps do apply to it. " : ""}The caps now: ${capsLine}.${notes}`,
  );

  // 4
  const k = f.holderKeys;
  const droppedTotal = k.dropped.badAlias + k.dropped.shortKey + k.dropped.equalsSharedKey + k.dropped.aliasTwice + k.dropped.keyTwice;
  const droppedWhy = [
    k.dropped.equalsSharedKey ? `${k.dropped.equalsSharedKey} with the shared key as their key` : "",
    k.dropped.keyTwice ? `${k.dropped.keyTwice} with a key another holder already has` : "",
    k.dropped.aliasTwice ? `${k.dropped.aliasTwice} with a name listed twice` : "",
    k.dropped.shortKey ? `${k.dropped.shortKey} with a key under 12 characters` : "",
    k.dropped.badAlias ? `${k.dropped.badAlias} with a name that is not 2 to 24 of a-z 0-9 _ -` : "",
  ].filter(Boolean);
  const keyCounts = `${plural(k.listed, "holder key")} listed, ${k.accepted} in force, ${droppedTotal} not in force${droppedWhy.length ? ` (${droppedWhy.join("; ")})` : ""}; shared key ${k.sharedKeySet ? "set" : "not set"}`;
  const keyNo = [
    f.operatorOpen ? "the operator token is not set and the operator views answer anyone (EVENT_X_DEV_NO_ADMIN)" : "",
    k.accepted === 0 ? "no holder has a key of their own, so every lock would be made with the shared key" : "",
    droppedTotal > 0 ? `${plural(droppedTotal, "listed key")} ${droppedTotal === 1 ? "is" : "are"} not in force, so ${droppedTotal === 1 ? "that person has" : "those people have"} no key of their own` : "",
    k.equalOperatorToken > 0 ? `${plural(k.equalOperatorToken, "lock key")} ${k.equalOperatorToken === 1 ? "is" : "are"} the same as the operator token` : "",
  ].filter(Boolean);
  const sharedConfirm = `The shared key is set (${plural(f.sharedOpenLocks, "open lock")} on its ledger). From here it cannot be told who has it. Confirm it has been given to nobody outside the company, or unset EVENT_SHADOW_LOCK_KEY.`;
  add(
    "holder_keys",
    "Every holder has a key of their own, and nobody outside locks with the shared key.",
    keyNo.length ? "no" : k.sharedKeySet ? CANNOT : "yes",
    keyNo.length ? `${keyNo.join("; ")}. Counts only, no key is shown: ${keyCounts}.` : `Counts only, no key is shown: ${keyCounts}. Every key in force is different from every other.`,
    sharedConfirm,
  );

  // 5
  const inPlayState = f.inPlay.lock ? `On (EVENT_X_IN_PLAY): a game can be locked in until ${plural(f.inPlay.hours, "hour")} after its start.` : `Off (EVENT_X_IN_PLAY=0): a lock closes ${f.inPlay.cutoffMinutes} minutes before the start.`;
  const others = ` The simulated scan ${f.inPlay.scan ? "also opens records on games under way (EVENT_SHADOW_SCAN_IN_PLAY)" : "stays before the start"}. A member's direct lock during a game is ${f.inPlay.memberSale ? "on" : "off"} (MEMBER_APP_IN_PLAY); it is the member's own order and nothing is hedged for it.`;
  const inPlayGates = "Its gates: the hedge is bought first, all or none, so a book that moved between the read and the order fills nothing and locks nothing; the exposure caps apply as they do before the start; the game must be inside the hours above.";
  add(
    "in_play",
    "Locking during a game is either off, or every lock during a game buys its hedge first.",
    !f.inPlay.lock || hf.answer === "yes" ? "yes" : hf.answer === "no" ? "no" : CANNOT,
    !f.inPlay.lock
      ? `${inPlayState}${others}`
      : hf.answer === "yes"
        ? `${inPlayState} ${inPlayGates}${others}`
        : hf.answer === "no"
          ? `${inPlayState} But a lock during a game is not always hedged first: ${hf.why}. Turn it off with EVENT_X_IN_PLAY=0 until condition 1 is a yes.${others}`
          : `${inPlayState} ${inPlayGates} That holds where the order is real; as in condition 1, there is ${hf.why}.${others}`,
    hf.answer === "cannot" ? `As for condition 1, during a game. ${hf.confirm}` : undefined,
  );

  // 6
  const d = f.disk;
  const inTemp = d.paths.filter((p) => d.tempDirs.some((t) => underDir(p.path, t)));
  const offMount = d.paths.filter((p) => !underDir(p.path, d.mount));
  const where = d.paths.map((p) => `${p.what} ${p.path}`).join("; ");
  const volatileFs = d.mountFsType !== null && /^(tmpfs|ramfs|overlay|overlayfs)$/.test(d.mountFsType);
  let diskAnswer: PilotAnswer;
  let diskDetail: string;
  if (inTemp.length) {
    diskAnswer = "no";
    diskDetail = `Under a temp folder, which is lost on every restart: ${inTemp.map((p) => `${p.what} ${p.path}`).join("; ")}. The disk is mounted at ${d.mount}.`;
  } else if (offMount.length) {
    diskAnswer = "no";
    diskDetail = `Not under ${d.mount}, where the disk is mounted: ${offMount.map((p) => `${p.what} ${p.path}`).join("; ")}.`;
  } else if (d.mountDev === null || d.rootDev === null) {
    diskAnswer = CANNOT;
    diskDetail = `Every ledger path is under ${d.mount} and none is under a temp folder, but ${d.mount} could not be read on this machine, so whether a disk is mounted there is not known. Paths: ${where}.`;
  } else if (d.mountDev === d.rootDev || volatileFs) {
    diskAnswer = "no";
    diskDetail = `Every ledger path is under ${d.mount}, but ${d.mountDev === d.rootDev ? `${d.mount} is on the same filesystem as the service's own files` : `${d.mount} is a ${d.mountFsType} filesystem`}: no persistent disk is mounted there, so the ledgers are lost on a redeploy. Paths: ${where}.`;
  } else {
    diskAnswer = "yes";
    diskDetail = `Every ledger path is under ${d.mount}, none is under a temp folder, and ${d.mount} is a filesystem of its own${d.mountFsType ? ` (${d.mountFsType})` : ""}, separate from the service's files. Paths: ${where}.`;
  }
  add("ledger_disk", "The ledgers are on the persistent disk and not under a temp folder.", diskAnswer, diskDetail, `Confirm in the hosting dashboard that a disk is attached to this service at ${d.mount}.`);

  // 7
  const sinks = [f.alerts.telegram ? "Telegram" : "", f.alerts.webhook ? "a webhook" : ""].filter(Boolean);
  add(
    "alerts",
    "Alerts are configured, so a stray hedge or a ledger that cannot be written pages someone.",
    sinks.length ? "yes" : "no",
    sinks.length
      ? `Configured: ${sinks.join(" and ")} (shadowAlerts.ts). This says a sink is set, not that a message arrives; the first page proves that.`
      : "No sink is set: an alert is written to the log and reaches nobody. Set EVENT_SHADOW_ALERT_BOT_TOKEN and EVENT_SHADOW_ALERT_CHAT_ID, or EVENT_SHADOW_ALERT_WEBHOOK_URL.",
  );

  // 8
  const backups = (f.workflows ?? []).filter((n) => /backup/i.test(n));
  add(
    "backup",
    "A copy of the ledgers exists off this machine.",
    CANNOT,
    `The copy is made by a GitHub workflow, not by this service, and this service cannot see its runs. ${f.workflows === null ? "This service does not look at the repository's workflow files." : backups.length ? `Workflow files with backup in the name in this build: ${backups.join(", ")}.` : "No workflow file with backup in its name is in this build."}`,
    "Open the repository's Actions tab and confirm the ledger backup workflow's last run is green and recent, and that the copy it made can be opened.",
  );

  // 9
  add(
    "keys_rotated",
    "Every key or token that was pasted into a chat has been replaced since.",
    CANNOT,
    "This service holds the keys in force and no history of them, so it cannot tell a replaced key from an old one.",
    "Confirm that EVENT_X_ADMIN_TOKEN on both event services, and every lock key and venue key that ever appeared in a message, has been replaced since it appeared. docs/AGENT_HANDOFF.md notes that admin tokens were pasted during deploy work.",
  );

  // 10
  const termsShort = f.termsOnRecord ? k.accepted - f.termsOnRecord.holders : 0;
  add(
    "terms",
    "Each outside holder's acceptance of the user terms is on the record.",
    f.termsOnRecord && f.termsOnRecord.version !== null && termsShort <= 0 ? "yes" : "no",
    !f.termsOnRecord
      ? `No terms are in force on this service: EVENT_SHADOW_TERMS_VERSION and EVENT_SHADOW_TERMS_URL are not set, so nothing asks a holder to accept and no acceptance counts. ${plural(k.accepted, "holder key")} in force.`
      : f.termsOnRecord.version === null
        ? `The terms settings could not be read, so no holder can accept and every named holder is refused: ${f.termsOnRecord.notes.join("; ") || "see the status page"}.`
        : termsShort <= 0
          ? `Version ${f.termsOnRecord.version} is in force and an acceptance of it is on the record for each of the ${plural(k.accepted, "holder")} with a key in force. A holder with none is refused at the quote and at the tap, so one added later cannot lock before accepting.`
          : `Version ${f.termsOnRecord.version} is in force and ${plural(termsShort, "holder")} with a key in force ${termsShort === 1 ? "has" : "have"} no acceptance of it on the record (${f.termsOnRecord.holders} of ${k.accepted} do): ${f.termsOnRecord.missing.join(", ")}. Each is refused at the quote and at the tap until they accept.`,
  );

  // 11
  const runbooks = (f.docs ?? []).filter((n) => /runbook/i.test(n));
  const payout = runbooks.filter((n) => /payout/i.test(n));
  add(
    "payout_runbook",
    "A payout runbook exists: who pays a holder what is owed, how, by when, and how it is recorded.",
    f.docs === null ? CANNOT : payout.length ? "yes" : "no",
    f.docs === null
      ? "This service does not look at the repository's documents, so it cannot say whether a payout runbook is among them."
      : payout.length
        ? `Found in docs/: ${payout.join(", ")}.`
        : `No file in docs/ has both payout and runbook in its name. Runbooks there: ${runbooks.length ? runbooks.join(", ") : "none"}. The /holders page says what is owed and the cash route records a payment; neither says who pays, how or by when.`,
    "Confirm a payout runbook exists and where it is kept: who pays a holder what is owed, how, by when, and how it is recorded.",
  );

  const no = items.filter((i) => i.answer === "no").map((i) => `${i.n} ${i.id}`);
  const byHand = items.filter((i) => i.answer === CANNOT);
  const confirmByHand = byHand.map((i) => `${i.n} ${i.id}: ${i.confirm ?? i.detail}`);
  const ready = no.length === 0 ? "yes" : "no";
  const overall =
    ready === "no"
      ? `ready for an outside holder: no. ${plural(no.length, "condition")} answered no: ${no.join(", ")}.${byHand.length ? ` ${byHand.length} more to confirm by hand: ${byHand.map((i) => `${i.n} ${i.id}`).join(", ")}.` : ""}`
      : byHand.length
        ? `ready for an outside holder: yes, as far as can be checked from here. Left to confirm by hand: ${byHand.map((i) => `${i.n} ${i.id}`).join(", ")}.`
        : "ready for an outside holder: yes. Nothing is left to confirm by hand.";
  return { note: PILOT_NOTE, ready, overall, no, confirmByHand, items };
}
