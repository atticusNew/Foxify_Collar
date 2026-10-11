/**
 * Settlement evidence: the venue's rule text pinned at open, read again at settlement.
 *
 *   - the hash is of the words, not the whitespace; empty text is never evidence
 *   - Kalshi: both rule parts are pinned; the settle read carries them back
 *   - Polymarket: description and the named source are pinned; the leg's second read compares
 *   - the ledgers carry pin and check; the record page says unchanged or changed, never neither
 *   - nothing here moves a payout
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkRule,
  gammaRuleText,
  gammaRuleUrl,
  kalshiRuleText,
  kalshiRuleUrl,
  normalizeRuleText,
  pinRule,
  ruleDiff,
  ruleEvidenceLine,
  ruleHash,
  ruleStateLabel,
  shortHash,
  summarizeRuleEvidence,
} from "../src/eventCollar/crossVenue/ruleEvidence";
import { getMarketResult, parseKalshiMarket } from "../src/eventCollar/kalshiPublic";
import { appendShadowRecord, loadShadowPositions, settlePayouts, summarizeShadow, type ShadowOpenRecord } from "../src/eventCollar/crossVenue/shadowLedger";
import { DEFAULT_LAST_LEG_CONFIG, legCandidates, replayLastLeg, runLastLegTick, summarizeLegRules, type LastLegRecord } from "../src/eventCollar/crossVenue/lastLeg";
import { legStatusFromGamma, parseComboMarket, type ComboLegMarket } from "../src/eventCollar/crossVenue/polymarketCombos";
import { retailParlays } from "../src/eventCollar/crossVenue/parlayRetail";
import { lockVersusSell, summarizeLastLeg } from "../src/eventCollar/crossVenue/lastLeg";
import { DEFAULT_CROSS_CONFIG, type PmBook } from "../src/eventCollar/crossVenue/types";
import { renderShadowHtml } from "../scripts/eventShadowHtml";

const PRIMARY = "If Washington wins the WAS Commanders vs SF 49ers Pro Football game originally scheduled for Oct 19, 2026, then the market resolves to Yes.";
const SECONDARY = "If the game ends in a tie, the market will resolve to $0.50 for each team. If the game is postponed but begins within 48 hours from its originally scheduled start time, the market remains open.";
const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

test("rule evidence: the hash is of the words; whitespace and line endings are not a change; nothing is never evidence", () => {
  const a = ruleHash("If Washington wins,\r\n  the market   resolves to Yes.");
  const b = ruleHash("If Washington wins,\nthe market resolves to Yes.");
  const c = ruleHash("If Washington wins,\n\n\nthe market resolves to Yes. ");
  assert.ok(a && a.length === 64);
  assert.equal(a, b);
  assert.equal(a, c);
  assert.notEqual(a, ruleHash("If Washington wins, the market resolves to No."), "a word is a change");
  assert.equal(normalizeRuleText("  a\u00a0 b \n\n c  "), "a b\nc");
  assert.equal(ruleHash(""), null);
  assert.equal(ruleHash("   \n "), null);
  assert.equal(ruleHash(null), null);
  assert.equal(shortHash("9f41c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9b7e0"), "9f41c2…b7e0");
  assert.equal(shortHash("abc"), "abc");
});

test("rule evidence: pin carries venue, key, source URL, hash, bytes and an excerpt; null when the venue published no text", () => {
  const at = "2026-10-11T16:00:00.000Z";
  const pin = pinRule({ venue: "kalshi", marketId: "KXNFLGAME-26OCT19WASSF-WAS", ruleText: `${PRIMARY}\n${SECONDARY}`, sourceUrl: kalshiRuleUrl("KXNFLGAME-26OCT19WASSF-WAS", KALSHI_BASE), readAtIso: at });
  assert.ok(pin);
  assert.equal(pin.venue, "kalshi");
  assert.equal(pin.marketId, "KXNFLGAME-26OCT19WASSF-WAS");
  assert.equal(pin.sourceUrl, `${KALSHI_BASE}/markets/KXNFLGAME-26OCT19WASSF-WAS`);
  assert.equal(pin.sha256, ruleHash(`${PRIMARY}\n${SECONDARY}`));
  assert.equal(pin.bytes, Buffer.byteLength(`${PRIMARY}\n${SECONDARY}`, "utf8"));
  assert.equal(pin.readAtIso, at);
  assert.ok(pin.excerpt.startsWith("If Washington wins") && pin.excerpt.endsWith("…") && pin.excerpt.length <= 200);
  assert.equal(pin.text, `${PRIMARY}\n${SECONDARY}`, "the whole text rides on the pin so a later edit can be shown word for word");
  const short = pinRule({ venue: "polymarket", marketId: "nfl-was-sf-2026-10-19", ruleText: "Short rule.", sourceUrl: "u", readAtIso: at });
  assert.equal(short?.excerpt, "Short rule.", "a short rule is its own excerpt");
  assert.equal(pinRule({ venue: "kalshi", marketId: "X", ruleText: "", sourceUrl: "u", readAtIso: at }), null);
  assert.equal(pinRule({ venue: "kalshi", marketId: "X", ruleText: undefined, sourceUrl: "u", readAtIso: at }), null);
});

test("rule evidence: the second read says unchanged, changed, or that it could not compare", () => {
  const at = "2026-10-20T04:00:00.000Z";
  const pin = pinRule({ venue: "kalshi", marketId: "T", ruleText: PRIMARY, sourceUrl: "u", readAtIso: "2026-10-11T00:00:00.000Z" });
  assert.deepEqual(checkRule(pin, `${PRIMARY}  `, at), { readAtIso: at, sha256: pin!.sha256, unchanged: true });
  const changed = checkRule(pin, PRIMARY.replace("Oct 19", "Oct 20"), at);
  assert.equal(changed.unchanged, false);
  assert.notEqual(changed.sha256, pin!.sha256);
  assert.equal(changed.text, PRIMARY.replace("Oct 19", "Oct 20"), "a differing text is kept so the record can show the edit");
  assert.deepEqual(checkRule(pin, "", at), { readAtIso: at, sha256: null, unchanged: null }, "the venue returned no text: nothing to compare, said as null");
  assert.deepEqual(checkRule(null, PRIMARY, at), { readAtIso: at, sha256: ruleHash(PRIMARY), unchanged: null }, "no pin at open: the read is kept, the comparison is null");
  assert.equal(ruleStateLabel(checkRule(pin, PRIMARY, at)), "terms held");
  assert.equal(ruleStateLabel(changed), "venue edited its rules");
  assert.equal(ruleStateLabel(checkRule(pin, "", at)), "terms kept at open");
  assert.equal(ruleStateLabel(undefined), "terms kept at open");
});

test("rule evidence: the diff names the words that moved, not the paragraphs around them", () => {
  const before = "If Dallas wins the game originally scheduled for Oct 19, 2026, then Yes. Ties pay fifty cents.";
  const after = "If Dallas wins the game originally scheduled for Oct 20, 2026, then Yes.";
  assert.deepEqual(ruleDiff(before, after), [
    { kind: "same", text: "If Dallas wins the game originally scheduled for Oct" },
    { kind: "cut", text: "19," },
    { kind: "add", text: "20," },
    { kind: "same", text: "2026, then Yes." },
    { kind: "cut", text: "Ties pay fifty cents." },
  ]);
  assert.deepEqual(ruleDiff("a b c", "a   b\nc"), [{ kind: "same", text: "a b c" }], "whitespace is not an edit");
  assert.deepEqual(ruleDiff("", "new words"), [{ kind: "add", text: "new words" }]);
  assert.deepEqual(ruleDiff("", ""), []);
  const long = Array.from({ length: 1_600 }, (_, i) => `w${i}`).join(" ");
  assert.deepEqual(
    ruleDiff(long, "short").map((p) => p.kind),
    ["cut", "add"],
    "past the word cap the record shows all of the old and all of the new rather than a slow diff",
  );
});

test("rule evidence: Kalshi pins both rule parts and the settle read carries them back; Gamma pins the description and its named source", async () => {
  const m = parseKalshiMarket({ ticker: "KXNFLGAME-26OCT19WASSF-WAS", title: "t", rules_primary: PRIMARY, rules_secondary: SECONDARY });
  assert.equal(m.rulesPrimary, PRIMARY);
  assert.equal(m.rulesSecondary, SECONDARY);
  assert.equal(kalshiRuleText(m), `${PRIMARY}\n${SECONDARY}`);
  assert.equal(kalshiRuleText({ rulesPrimary: "", rulesSecondary: SECONDARY }), SECONDARY, "a market with only the secondary text still has a rule");
  assert.equal(kalshiRuleText({ rulesPrimary: "", rulesSecondary: "" }), "");
  const stub = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const r = await getMarketResult("KXNFLGAME-26OCT19WASSF-WAS", stub({ market: { ticker: "KXNFLGAME-26OCT19WASSF-WAS", status: "finalized", result: "yes", rules_primary: PRIMARY, rules_secondary: SECONDARY } }));
  assert.equal(r.result, "yes");
  assert.equal(r.rulesPrimary, PRIMARY);
  assert.equal(r.rulesSecondary, SECONDARY);
  assert.match(r.sourceUrl, /\/markets\/KXNFLGAME-26OCT19WASSF-WAS$/);
  const old = await getMarketResult("T", stub({ market: { ticker: "T", status: "finalized", result: "no" } }));
  assert.deepEqual([old.rulesPrimary, old.rulesSecondary], ["", ""], "a payload without rule fields reads as no text, never as a crash");

  const g = legStatusFromGamma({ slug: "nfl-was-sf-2026-10-19", conditionId: "C", outcomes: '["WAS","SF"]', outcomePrices: '["0.6","0.4"]', clobTokenIds: '["a","b"]', description: "This market will resolve to WAS if the Commanders win. If postponed beyond Oct 26, resolves 50-50.", resolutionSource: "https://www.nfl.com/" });
  assert.equal(g.description.startsWith("This market will resolve"), true);
  assert.equal(g.resolutionSource, "https://www.nfl.com/");
  assert.equal(gammaRuleText(g), "This market will resolve to WAS if the Commanders win. If postponed beyond Oct 26, resolves 50-50.\nResolution source: https://www.nfl.com/");
  assert.equal(gammaRuleText({ description: "d", resolutionSource: "" }), "d");
  assert.equal(gammaRuleText({}), "");
  assert.equal(gammaRuleUrl("nfl-was-sf-2026-10-19", "https://gamma-api.polymarket.com/"), "https://gamma-api.polymarket.com/markets/slug/nfl-was-sf-2026-10-19");
});

const OPEN: ShadowOpenRecord = {
  type: "open",
  at: "2026-10-11T16:00:00.000Z",
  ticker: "KXNFLGAME-26OCT19WASSF-WAS",
  kind: "sports",
  league: "nfl",
  sideName: "Washington Commanders",
  eventTitle: "Washington Commanders to win",
  eventTimeIso: "2026-10-19T20:25:00.000Z",
  contracts: 150,
  markCents: 60,
  floorCents: 52,
  capCents: 63,
  creditCents: 112,
  evCostBps: 297,
  route: "polymarket",
  feesCents: 0,
  takeCents: 12,
};

test("rule evidence: the shadow ledger carries the pin on the open and the check on the settle; the payout is the same with or without them; the page says which", () => {
  const dir = mkdtempSync(join(tmpdir(), "rule-evidence-"));
  const path = join(dir, "ledger.jsonl");
  const rule = pinRule({ venue: "kalshi", marketId: OPEN.ticker, ruleText: `${PRIMARY}\n${SECONDARY}`, sourceUrl: kalshiRuleUrl(OPEN.ticker, KALSHI_BASE), readAtIso: OPEN.at });
  const changedRule = pinRule({ venue: "kalshi", marketId: "KXNFLGAME-26OCT19DALNYG-DAL", ruleText: "If Dallas wins the game originally scheduled for Oct 19, 2026, then Yes.", sourceUrl: kalshiRuleUrl("KXNFLGAME-26OCT19DALNYG-DAL", KALSHI_BASE), readAtIso: OPEN.at });
  appendShadowRecord(path, { ...OPEN, rule });
  appendShadowRecord(path, { ...OPEN, ticker: "KXNFLGAME-26OCT19DALNYG-DAL", sideName: "Dallas Cowboys", eventTitle: "Dallas Cowboys to win", rule: changedRule });
  appendShadowRecord(path, { ...OPEN, ticker: "KXNFLGAME-OLD-NOPIN", sideName: "Old record", eventTitle: "Old record" }); // a record from before pins existed
  const settleAt = "2026-10-20T04:00:00.000Z";
  appendShadowRecord(path, { type: "settle", at: settleAt, ticker: OPEN.ticker, result: "no", ruleCheck: checkRule(rule, `${PRIMARY}\n${SECONDARY}`, settleAt) });
  appendShadowRecord(path, { type: "settle", at: settleAt, ticker: "KXNFLGAME-26OCT19DALNYG-DAL", result: "yes", ruleCheck: checkRule(changedRule, "If Dallas wins the game originally scheduled for Oct 20, 2026, then Yes.", settleAt) });
  appendShadowRecord(path, { type: "settle", at: settleAt, ticker: "KXNFLGAME-OLD-NOPIN", result: "yes" });
  const positions = loadShadowPositions(path);
  const byTicker = new Map(positions.map((p) => [p.ticker, p]));
  const was = byTicker.get(OPEN.ticker)!;
  assert.equal(was.rule?.sha256, rule!.sha256);
  assert.equal(was.ruleCheck?.unchanged, true);
  assert.deepEqual({ protectedCents: was.protectedCents, nakedCents: was.nakedCents, deltaCents: was.deltaCents }, settlePayouts(OPEN, "no"), "evidence attached, payout identical");
  const dal = byTicker.get("KXNFLGAME-26OCT19DALNYG-DAL")!;
  assert.equal(dal.ruleCheck?.unchanged, false);
  assert.equal(dal.writerCents, OPEN.takeCents, "a changed rule is said, not priced: the writer still keeps exactly the take");
  const old = byTicker.get("KXNFLGAME-OLD-NOPIN")!;
  assert.equal(old.rule, undefined);
  assert.equal(old.ruleCheck, undefined);

  const summary = summarizeRuleEvidence(positions.map((p) => ({ id: p.ticker, rule: p.rule, check: p.ruleCheck })));
  assert.deepEqual(summary, { total: 3, pinned: 2, compared: 2, unchanged: 1, changed: 1, unreadable: 0, changedIds: ["KXNFLGAME-26OCT19DALNYG-DAL"] });
  assert.equal(
    ruleEvidenceLine(summary, "position"),
    "2 of 3 positions carry the venue's rules as they read when they opened; the rest were opened before we kept them. At settlement we read them again: 1 unchanged, 1 reworded by the venue.",
  );
  assert.equal(ruleEvidenceLine({ ...summary, total: 2 }, "position"), "Each position carries the venue's rules as they read when it opened. At settlement we read them again: 1 unchanged, 1 reworded by the venue.");
  assert.equal(ruleEvidenceLine({ ...summary, pinned: 0 }, "position"), "", "nothing pinned: no line, no claim");
  assert.equal(ruleEvidenceLine({ total: 1, pinned: 1, compared: 0, unchanged: 0, changed: 0, unreadable: 1, changedIds: [] }, "leg"), "Each leg carries the venue's rules as they read when it opened. 1 could not be read again.");
  assert.ok(!/sha256|hash/i.test(ruleEvidenceLine(summary, "position")), "the line is for a bettor; the fingerprint stays in the tooltip and the JSON");

  const html = renderShadowHtml({ atIso: settleAt, summary: summarizeShadow(positions), open: [], settled: positions.filter((p) => p.status === "settled") });
  assert.ok(html.includes(`<a class="tag rule" href="${KALSHI_BASE}/markets/${OPEN.ticker}" rel="noopener" title="fingerprint sha256 ${rule!.sha256}, read at open and again at settlement, same words">terms held</a>`), "an unchanged rule is two words that link to the venue's own read; the fingerprint is the tooltip");
  assert.ok(html.includes('<span class="tag rule" title="fingerprint sha256 '), "the edited rule's tag carries its fingerprint the same way");
  assert.ok(html.includes("venue edited its rules</span>"), "an edited rule is said in neutral words on its own line");
  assert.ok(!html.includes("tag changed") && !html.includes("changed before settlement"), "no warning tone on the trader's own row");
  assert.ok(html.includes("<summary>what the venue changed</summary>"), "the edited row opens to the edit");
  assert.ok(html.includes("The venue reworded this market's rules after the position opened. The payout followed the venue's official result, as always."));
  assert.ok(html.includes("<del>19,</del> <ins>20,</ins>"), "the edit is shown word for word: the date moved, nothing else");
  assert.ok(html.includes(`read again 2026-10-20 04:00 UTC, <code>${shortHash(dal.ruleCheck!.sha256!)}</code>`));
  assert.ok(html.includes(`href="${KALSHI_BASE}/markets/KXNFLGAME-26OCT19DALNYG-DAL" rel="noopener">Venue's current text</a>`));
  assert.ok(html.includes("2 of 3 positions carry the venue's rules as they read when they opened"));
  assert.ok(html.includes("<b>How we check rules:</b> when a position opens we keep the venue's own rule text"), "the footer says what the words mean, once");
  assert.equal((html.match(/class="tag rule"/g) ?? []).length, 2, "the old record carries no mark");
  assert.equal((html.match(/<details class="ruledetail">/g) ?? []).length, 1, "only the edited row opens");
  assert.ok(!html.includes("\u2014"), "no em dashes");
  assert.ok(!/resolution/i.test(html), "banned vocabulary stays out of the page");

  const bare = renderShadowHtml({ atIso: settleAt, summary: summarizeShadow([old]), open: [], settled: [old] });
  assert.ok(!bare.includes('class="tag rule"') && !bare.includes("venue's rules as they read") && !bare.includes("How we check rules"), "a record with no pins says nothing about them");

  // a pin written before the text was kept still renders: the excerpt stands in for the diff
  const oldPin = { ...changedRule!, text: undefined };
  const noText = renderShadowHtml({ atIso: settleAt, summary: summarizeShadow([dal]), open: [], settled: [{ ...dal, rule: oldPin, ruleCheck: { ...dal.ruleCheck!, text: undefined } }] });
  assert.ok(noText.includes("venue edited its rules</span>") && noText.includes("At open the rules began: If Dallas wins") && !noText.includes("<del>"));
});

// ── parlay legs ──────────────────────────────────────────────────────────────

const FRI_NOON = Date.UTC(2026, 9, 9, 12, 0, 0);
const SAT_16 = Date.UTC(2026, 9, 10, 16, 0, 0);
const SUN_20 = Date.UTC(2026, 9, 11, 20, 0, 0);

const catalogRow = (slug: string, cond: string, prices: [string, string], volume: number): Record<string, unknown> => ({
  id: "1",
  condition_id: cond,
  position_ids: [`${cond}-yes`, `${cond}-no`],
  pending: false,
  slug,
  title: slug,
  outcomes: ["Away", "Home"],
  outcome_prices: prices,
  volume,
  tags: ["sports", "nfl", "games"],
});
const gammaRow = (slug: string, cond: string, startMs: number, description: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug,
  conditionId: cond,
  question: slug,
  outcomes: '["Away", "Home"]',
  outcomePrices: '["0.7", "0.3"]',
  clobTokenIds: `["${cond}-t0", "${cond}-t1"]`,
  gameStartTime: new Date(startMs).toISOString().replace("T", " ").replace(".000Z", "+00"),
  sportsMarketType: "moneyline",
  closed: false,
  active: true,
  umaResolutionStatus: "",
  description,
  resolutionSource: "https://www.nfl.com/",
  ...over,
});
const noBook = (tokenId: string, askMilli: number): PmBook => ({ tokenId, asks: [{ priceMilli: askMilli, sizeMilli: 100_000_000 }], bids: [{ priceMilli: askMilli - 20, sizeMilli: 100_000_000 }] });

test("rule evidence: a parlay leg pins the Gamma rule when the ticket is built; the second read at resolution rides on the leg record and the retail pick", async () => {
  const RULE_B = "Resolves to the winner of Away at Home on Oct 10. Postponed past Oct 17 resolves 50-50.";
  const RULE_D = "Resolves to the winner of Away at Home on Oct 11.";
  const catalog = [parseComboMarket(catalogRow("nfl-b-2026-10-10", "B", ["0.7", "0.3"], 900)) as ComboLegMarket, parseComboMarket(catalogRow("nfl-d-2026-10-11", "D", ["0.6", "0.4"], 1000)) as ComboLegMarket];
  let gamma: Record<string, Record<string, unknown>> = {
    "nfl-b-2026-10-10": gammaRow("nfl-b-2026-10-10", "B", SAT_16, RULE_B),
    "nfl-d-2026-10-11": gammaRow("nfl-d-2026-10-11", "D", SUN_20, RULE_D, { outcomePrices: '["0.6", "0.4"]' }),
  };
  const cands = legCandidates(
    catalog.map((m) => ({ market: m, status: legStatusFromGamma(gamma[m.slug]) })),
    { ...DEFAULT_LAST_LEG_CONFIG, legCounts: [2], ticketsPerSize: 1 },
    FRI_NOON,
  );
  assert.equal(cands.length, 2);
  assert.equal(cands[0].rule?.venue, "polymarket");
  assert.equal(cands[0].rule?.marketId, "nfl-b-2026-10-10");
  assert.equal(cands[0].rule?.sha256, ruleHash(`${RULE_B}\nResolution source: https://www.nfl.com/`));
  assert.match(cands[0].rule?.sourceUrl ?? "", /\/markets\/slug\/nfl-b-2026-10-10$/);
  assert.equal(cands[0].rule?.readAtIso, new Date(FRI_NOON).toISOString());

  const ledger: string[] = [];
  let now = FRI_NOON;
  const io = {
    nowMs: () => now,
    catalog: async () => ({ markets: catalog, pagesFetched: 1, exhausted: true }),
    legStatus: async (slug: string) => (gamma[slug] ? legStatusFromGamma(gamma[slug]) : null),
    noBook: async (tokenId: string) => noBook(tokenId, 410),
    load: () => replayLastLeg(ledger),
    append: (r: LastLegRecord) => {
      ledger.push(JSON.stringify(r));
    },
  };
  const cfg = { ...DEFAULT_LAST_LEG_CONFIG, legCounts: [2], ticketsPerSize: 1 };
  await runLastLegTick(io, cfg, DEFAULT_CROSS_CONFIG);
  let tickets = io.load();
  assert.equal(tickets.length, 1);
  assert.ok(tickets[0].legs.every((l) => l.rule && l.rule.sha256.length === 64), "every leg on the ticket carries its pin");

  // B resolves under a rule the venue edited (the postponement line dropped); D resolves under the same text.
  now = SUN_20 - 12 * 3_600_000;
  gamma = { ...gamma, "nfl-b-2026-10-10": gammaRow("nfl-b-2026-10-10", "B", SAT_16, "Resolves to the winner of Away at Home on Oct 10.", { closed: true, umaResolutionStatus: "resolved", outcomePrices: '["1", "0"]' }) };
  await runLastLegTick(io, cfg, DEFAULT_CROSS_CONFIG);
  now = SUN_20 + 6 * 3_600_000;
  gamma = { ...gamma, "nfl-d-2026-10-11": gammaRow("nfl-d-2026-10-11", "D", SUN_20, RULE_D, { closed: true, umaResolutionStatus: "resolved", outcomePrices: '["1", "0"]' }) };
  await runLastLegTick(io, cfg, DEFAULT_CROSS_CONFIG);
  tickets = io.load();
  const t = tickets[0];
  assert.equal(t.status, "settled");
  assert.equal(t.legRuleChecks?.B.unchanged, false, "the edited rule is said");
  assert.equal(t.legRuleChecks?.D.unchanged, true);
  const legRecs = ledger.map((l) => JSON.parse(l) as LastLegRecord).filter((r) => r.type === "leg");
  assert.equal(legRecs.length, 2);
  assert.ok(legRecs.every((r) => r.type === "leg" && r.ruleCheck && r.ruleCheck.sha256));
  const s = summarizeLastLeg(tickets);
  assert.equal(s.settled.identityHolds, true, "a changed rule changes nothing about who keeps what");

  const legRules = summarizeLegRules(tickets);
  assert.deepEqual(legRules, { total: 2, pinned: 2, compared: 2, unchanged: 1, changed: 1, unreadable: 0, changedIds: ["nfl-b-2026-10-10"] });
  const payload = retailParlays(tickets, s, lockVersusSell(tickets));
  assert.deepEqual(payload.rules, legRules);
  const picks = payload.tickets[0].picks;
  assert.deepEqual(picks.map((p) => p.rule?.unchanged), [false, true]);
  assert.ok(picks.every((p) => p.rule && p.rule.sha256.length === 64 && p.rule.sourceUrl.includes("/markets/slug/")));
  assert.ok(!("excerpt" in (picks[0].rule ?? {})) && !("bytes" in (picks[0].rule ?? {})), "the retail pick carries the hash and the link, not the text");

  const html = renderShadowHtml({
    atIso: new Date(now).toISOString(),
    summary: summarizeShadow([]),
    open: [],
    settled: [],
    parlays: { lockVsSell: lockVersusSell(tickets), lastLeg: s, stakeCents: cfg.stakeCents, rules: legRules },
  });
  assert.ok(html.includes("Each leg carries the venue's rules as they read when it opened. At settlement we read them again: 1 unchanged, 1 reworded by the venue."));
  assert.ok(html.includes("<b>How we check rules:</b>"), "the footer note appears when the only pins on the page are parlay legs");
  assert.ok(!html.includes("\u2014"));
  assert.equal(t.legRuleChecks?.B.text, "Resolves to the winner of Away at Home on Oct 10.\nResolution source: https://www.nfl.com/", "the edited leg keeps the text it settled under");
  assert.equal(t.legRuleChecks?.D.text, undefined, "an unchanged leg keeps no second copy");

  // a ticket from before pins existed reads the same as before: no rule, no check, no line
  const legacy = replayLastLeg(ledger.map((l) => l.replace(/,"rule":\{[^}]*\}/g, "").replace(/,"ruleCheck":\{[^}]*\}/g, "")));
  assert.ok(legacy[0].legs.every((l) => l.rule === undefined));
  assert.equal(legacy[0].legRuleChecks, undefined);
  assert.deepEqual(summarizeLegRules(legacy), { total: 2, pinned: 0, compared: 0, unchanged: 0, changed: 0, unreadable: 0, changedIds: [] });
  assert.equal(legacy[0].status, "settled");
});
