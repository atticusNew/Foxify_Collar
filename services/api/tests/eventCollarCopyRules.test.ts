/**
 * THE COPY RULES GUARD for the event surfaces: the founder pastes text from these pages into
 * messages to venues and investors, so the wording rules are checked on what is served and on
 * what is shipped, not on a reading of the source.
 *
 * Rule 1  no em dash (U+2014) and no en dash (U+2013), in any spelling (the character, a JS or
 *         CSS escape, an HTML entity)
 * Rule 2  no "guarantee", "guaranteed", "risk-free" or a promise of that kind
 * Rule 3  the bettor's verb is "Lock in": no "protect", "protected", "protection" in text a
 *         person reads. The brand "Earn & Protect" stays, as do code identifiers (route paths,
 *         JSON fields, CSS classes, env names), which the guard tells apart by their shape
 * Rule 4  "address", never "wallet"
 * Rule 7  when the money reaches the bettor is said one way: a collar's credit is "credited at
 *         lock in" and its floor or cap is paid "at settlement"; a direct lock's cash "lands in
 *         your balance when the lock fills". The retired ways of saying it ("cash now", "paid
 *         now", "paid at the tap", "paid at open", "up front", "paid today", "at the lock",
 *         "balance now") are refused. The older BTC demo is outside this rule.
 * Rule 8  outcome words only: nothing a person reads says how a direct lock is done. No "sell",
 *         "sold", "sale" or "seller", in any form. A direct lock "takes cash out of the
 *         position", its contracts are "locked", the cash lands "when the lock fills", a hedged
 *         lock "gives up part of the upside", and leaving a whole ticket is "cash out". Our own
 *         hedge is "closed". Three places are read differently, each for a stated reason:
 *           the service's and the engine's own source (eventShadowWorker.ts, src/eventCollar)
 *             and the operator's pages: a sale word is refused only in a sentence that speaks
 *             of the holder (you, your, member, holder, user, bettor, position, own). What is
 *             left there is the operator's alerts and the order rails, where the thing sold is
 *             our own hedge and the venue's order is named as the venue names it;
 *           the WagerWire listing files: "seller" is that venue's word for who lists a ticket;
 *           the extension's README: developer notes, not shipped, which keep the plain
 *             description of the mechanics.
 *
 * COVERED BY RENDERING (the HTML a browser receives, from the services' own handlers and the
 * exported render functions): its text, the attributes a person sees or hears (title,
 * aria-label, placeholder, alt, label, value, content), the content strings in its CSS, and
 * every string in its inline scripts, since those become the page once the script runs.
 * COVERED BY SCANNING THE SOURCE (every string and template literal, comments left out): the
 * same files again, for the branches one render does not reach, and the files that have no
 * page of their own (the services' JSON messages, the engine's reasons and labels, the CLIs).
 * THE EXTENSION: the files pack.mjs ships (scripts, CSS, options page, manifest, PRIVACY.md)
 * and the README that carries the store text.
 *
 * A hit names the file and line (or the page), the rule and the text. To fix one: rewrite the
 * sentence. Only when the text is not copy at all (a venue's own field name, a string matched
 * against a venue's page) does it belong in ALLOWED below, with the reason.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import ts from "typescript";

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = join(API_DIR, "..", "..");
const EXT_DIR = join(REPO_DIR, "demo", "event-lockin-extension");

type Rule = 1 | 2 | 3 | 4 | 7 | 8;
const RULES: readonly Rule[] = [1, 2, 3, 4, 7, 8];
const RULE_NAMES: Record<Rule, string> = {
  1: "rule 1, no em or en dash",
  2: "rule 2, no guarantee or risk-free promise",
  3: 'rule 3, "Lock in", never "protect"',
  4: 'rule 4, "address", never "wallet"',
  7: 'rule 7, cash timing said one way ("credited at lock in", "when the lock fills")',
  8: "rule 8, outcome words only: no sell, sold or sale",
};

interface Hit {
  file: string;
  rule: Rule;
  text: string;
}

// ---------- the rules ----------

const DASH = /[\u2014\u2013]/g;
/** the same two characters spelled so that a browser turns them back into dashes */
const DASH_SPELLED = /\\u201[34]|\\u\{201[34]\}|&(?:mdash|ndash);|&#0*821[12];|&#x0*201[34];/gi;
const CSS_DASH = /\\0{0,2}201[34]\b/g;
const PROMISE =
  /\bguarant(?:ee|eed|ees|eeing|y|or|ors)\b|\brisk[\s-]?free\b|\briskless\b|\b(?:no|zero)[\s-]risk\b|\bcan(?:not|'t|\u2019t| not) lose\b|\bnever loses?\b|\bsure thing\b|\bfree money\b/gi;
const PROTECT = /\b(?:un)?protect(?:s|ed|ing|ion|ions|or|ors|ive|able)?\b/gi;
const WALLET = /\bwallets?\b/gi;
/** a sale in any form: sell, sells, selling, seller, sold, unsold, resell, sale, sales */
const SALE = /\b(?:re|un)?(?:sell(?:s|ing|er|ers)?|sold|sales?)\b/gi;
/** who a sentence is about, where only the holder's own sale is refused */
const HOLDER = /\b(?:you|yours?|members?|holders?|users?|bettors?|traders?|positions?|own)\b/i;
type SaleMode = "strict" | "holder" | "off";
/** How rule 8 reads a file or a page (the reasons are in the header). What is served to anyone but the operator is strict. */
function saleMode(file: string): SaleMode {
  if (/^(?:shadow GET|demo GET|render |btc demo |page$)/.test(file)) return /\(operator/.test(file) ? "holder" : "strict";
  if (/wagerwireListing|\/listingQuote\.ts/.test(file) || /README\.md/.test(file)) return "off";
  if (/eventShadowWorker\.ts|src\/eventCollar\//.test(file)) return "holder";
  return "strict";
}
/** the sentence a match sits in: back to the last full stop, semicolon, question or exclamation mark, and on to the next */
function sentenceAround(text: string, at: number, len: number): string {
  let from = at;
  let to = at + len;
  while (from > 0 && !/[.;!?]/.test(text[from - 1])) from--;
  while (to < text.length && !/[.;!?]/.test(text[to])) to++;
  return text.slice(from, to);
}
/** the retired ways of saying when the bettor's cash arrives: a cash word, then one of the old moments close after it */
const CASH_WHEN =
  /\b(?:paid|pays|cash|credit(?:ed|s)?)\b[^.;:\u00b7<>]{0,24}?(?:(?<!\bright )\bnow\b|\btoday\b(?!['\u2019]s)|\bat the tap\b|\bat open\b|\bup ?front\b|\bat the lock\b)|\bbalance now\b|\byours today\b|\btake\s+\$?[\d,.]+\s+now\b/gi;
/** the older BTC demo is held to rules 1 to 4 only */
const CASH_RULE_EXEMPT = /eventProtectDemoService\.ts|eventProtectAppHtml\.ts|^btc demo /;
/** the product brand, which keeps its name; blanked before rule 3 is read */
const BRAND = /Earn\s*(?:&|&amp;|and)\s*Protect\b/g;

/**
 * Text that is not copy. Each entry is one file and one exact string with the reason it stays.
 * Keep it short: a sentence a person reads never belongs here.
 */
const ALLOWED: ReadonlyArray<{ file: string; rule: Rule; text: string; why: string }> = [];

const snippet = (text: string, at: number, len: number): string => {
  const from = Math.max(0, at - 50);
  const to = Math.min(text.length, at + len + 50);
  return (from > 0 ? "..." : "") + text.slice(from, to).replace(/\s+/g, " ").trim() + (to < text.length ? "..." : "");
};

/**
 * A word that sits inside a code identifier rather than a sentence: a route path, a JSON field,
 * an env name, a CSS class, a selector, a camel-cased name, a call. Told by the token around it.
 */
function insideIdentifier(text: string, at: number, len: number): boolean {
  const tokenChar = /[A-Za-z0-9_\-./:#[\]{}()=?&%@$;*+~|\\]/;
  let from = at;
  let to = at + len;
  while (from > 0 && tokenChar.test(text[from - 1])) from--;
  while (to < text.length && tokenChar.test(text[to])) to++;
  // a full stop, comma, colon or bracket that ends a sentence is not part of the token
  const token = text.slice(from, to).replace(/^[(\[{]+/, "").replace(/[.,:;!?)\]}]+$/, "");
  if (/[_/=\\$@|[\]{}()#~*+%]/.test(token)) return true;
  if (/[A-Za-z0-9]\.[A-Za-z]/.test(token)) return true;
  if (/^\.[a-z]/.test(token)) return true;
  if (/[a-z][A-Z]/.test(token)) return true;
  if (/[A-Za-z0-9]:[A-Za-z0-9]/.test(token)) return true;
  // a hyphenated lower-case name (a CSS class, a header, a data attribute, a slug)
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(token) && !/^(?:un|non|self|pre|re|over|under|well|third|party|fully|not|now|is|are|be|you|your)-/.test(token) && !/-(?:free|only|style|like|first)$/.test(token)) return true;
  return false;
}

interface CheckOptions {
  /** the text is one string literal of a program: a lone lower-case word is a key or a state, not copy */
  literal: boolean;
  /**
   * the literal is exactly one lower-case word, nothing beside it. Rule 8 lets only that through:
   * "sold" alone is a state, but "sold " or "</b> sold" is a piece of a sentence put together in code
   */
  bare?: boolean;
  /** where a match at this offset is, when the text spans lines (markdown); the file label otherwise */
  locate?: (at: number) => string;
}

function checkText(file: string, text: string, opts: CheckOptions, hits: Hit[]): void {
  if (!text || !/[A-Za-z\u2013\u2014&\\]/.test(text)) return;
  const push = (rule: Rule, at: number, len: number): void => {
    if (ALLOWED.some((a) => a.rule === rule && file.startsWith(a.file) && text.includes(a.text))) return;
    hits.push({ file: opts.locate ? opts.locate(at) : file, rule, text: snippet(text, at, len) });
  };
  for (const m of text.matchAll(DASH)) push(1, m.index, m[0].length);
  for (const m of text.matchAll(DASH_SPELLED)) push(1, m.index, m[0].length);
  for (const m of text.matchAll(PROMISE)) push(2, m.index, m[0].length);
  if (!CASH_RULE_EXEMPT.test(file)) for (const m of text.matchAll(CASH_WHEN)) push(7, m.index, m[0].length);
  const lone = opts.literal && /^[a-z][a-z0-9]*$/.test(text.trim());
  const sale = lone && opts.bare !== false ? "off" : saleMode(file);
  if (sale !== "off")
    for (const m of text.matchAll(SALE)) {
      if (insideIdentifier(text, m.index, m[0].length)) continue;
      if (sale === "holder" && !HOLDER.test(sentenceAround(text, m.index, m[0].length))) continue;
      push(8, m.index, m[0].length);
    }
  if (lone) return;
  const unbranded = text.replace(BRAND, (b) => " ".repeat(b.length));
  for (const m of unbranded.matchAll(PROTECT)) if (!insideIdentifier(unbranded, m.index, m[0].length)) push(3, m.index, m[0].length);
  for (const m of text.matchAll(WALLET)) if (!insideIdentifier(text, m.index, m[0].length)) push(4, m.index, m[0].length);
}

// ---------- reading HTML, CSS, scripts and markdown ----------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "\u00b7", hellip: "\u2026", mdash: "\u2014", ndash: "\u2013", times: "\u00d7", rarr: "\u2192", larr: "\u2190", cent: "\u00a2" };
const decodeEntities = (s: string): string =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);

const HUMAN_ATTRS = /\b(?:title|aria-label|placeholder|alt|label|value|content)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

function checkCss(file: string, css: string, hits: Hit[]): void {
  for (const m of css.matchAll(/content\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi)) {
    const value = m[1];
    if (DASH.test(value) || CSS_DASH.test(value)) hits.push({ file, rule: 1, text: `CSS ${m[0]}` });
    DASH.lastIndex = 0;
    CSS_DASH.lastIndex = 0;
  }
}

/** HTML, whole or a fragment: its scripts are read as programs, its styles as CSS, the rest as what a person sees. */
function checkHtml(file: string, html: string, opts: CheckOptions, hits: Hit[], depth: number): void {
  let rest = html.replace(/<!--[\s\S]*?-->/g, " ");
  rest = rest.replace(/<script\b[^>]*>([\s\S]*?)(?:<\/script>|$)/gi, (_m, body: string) => {
    for (const unit of literalUnits(body, ts.ScriptKind.JS)) checkUnit(`${file} (script line ${unit.line})`, unit.text, hits, depth + 1);
    return " ";
  });
  rest = rest.replace(/<style\b[^>]*>([\s\S]*?)(?:<\/style>|$)/gi, (_m, body: string) => {
    checkCss(file, body, hits);
    return " ";
  });
  for (const m of rest.matchAll(HUMAN_ATTRS)) checkText(file, decodeEntities(m[1] ?? m[2] ?? ""), { literal: true }, hits);
  const text = decodeEntities(rest.replace(/<\/?[a-zA-Z!][^>]*(?:>|$)/g, " "));
  checkText(file, text, opts, hits);
}

interface Unit {
  text: string;
  line: number;
}

/** what a `${...}` hole is read as when a template's pieces are put back together */
const HOLE = "0";

/** Every string and template literal of a program, comments and types left out. */
function literalUnits(code: string, kind: ts.ScriptKind): Unit[] {
  const sf = ts.createSourceFile(kind === ts.ScriptKind.JS ? "unit.js" : "unit.ts", code, ts.ScriptTarget.Latest, true, kind);
  const out: Unit[] = [];
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isTypeNode(n)) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const raw = ts.isNoSubstitutionTemplateLiteral(n) && ts.isTaggedTemplateExpression(n.parent);
      out.push({ text: raw ? (n.rawText ?? n.text) : n.text, line: lineOf(n) });
      return;
    }
    if (ts.isTemplateExpression(n)) {
      const raw = ts.isTaggedTemplateExpression(n.parent);
      const piece = (l: ts.TemplateHead | ts.TemplateMiddle | ts.TemplateTail): string => (raw ? (l.rawText ?? l.text) : l.text);
      out.push({ text: piece(n.head) + n.templateSpans.map((s) => HOLE + piece(s.literal)).join(""), line: lineOf(n) });
      for (const s of n.templateSpans) visit(s.expression);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function parsesAsScript(text: string): boolean {
  if (text.length < 80 || /^\s*</.test(text)) return false;
  if (!/\bfunction\b|=>|\bvar \w|\bconst \w|\breturn\b/.test(text) || !/[;{}]/.test(text)) return false;
  const sf = ts.createSourceFile("unit.js", text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  return (sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length === 0;
}

const looksLikeCss = (text: string): boolean => !/<[a-zA-Z]/.test(text) && (text.match(/[^{}]+\{[^{}]*:[^{}]*\}/g) ?? []).length >= 2;

/** One literal: a page, a script kept in a string, a stylesheet, or words. */
function checkUnit(file: string, text: string, hits: Hit[], depth = 0): void {
  if (depth > 4) return;
  if (parsesAsScript(text)) {
    for (const unit of literalUnits(text, ts.ScriptKind.JS)) checkUnit(`${file} (script line ${unit.line})`, unit.text, hits, depth + 1);
    return;
  }
  if (looksLikeCss(text)) {
    checkCss(file, text, hits);
    return;
  }
  checkHtml(file, text, { literal: true, bare: /^[a-z][a-z0-9]*$/.test(text) }, hits, depth);
}

function checkSource(file: string, code: string, kind: ts.ScriptKind, hits: Hit[]): void {
  for (const unit of literalUnits(code, kind)) checkUnit(`${file}:${unit.line}`, unit.text, hits);
}

/** Markdown: code blocks, code spans and link targets are identifiers; the rest is prose. Offsets are kept so a hit names its line. */
function checkMarkdown(file: string, md: string, hits: Hit[]): void {
  const blank = (s: string): string => s.replace(/[^\n]/g, " ");
  const prose = md
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/`[^`\n]*(?:\n[^`\n]*)?`/g, blank)
    .replace(/\]\([^)\n]*\)/g, blank)
    .replace(/https?:\/\/\S+/g, blank);
  // one text, so a phrase or the brand broken across two lines is still read whole
  const lineOf = (at: number): string => `${file}:${prose.slice(0, at).split("\n").length}`;
  checkText(file, prose.replace(/\n/g, " "), { literal: false, locate: lineOf }, hits);
}

function report(hits: readonly Hit[]): string {
  if (hits.length === 0) return "";
  const counts = RULES.map((r) => `rule ${r}: ${hits.filter((h) => h.rule === r).length}`).join(", ");
  const lines = hits.map((h) => `  ${h.file}\n      ${RULE_NAMES[h.rule]}: ${JSON.stringify(h.text).replace(/\u2014/g, "\\u2014").replace(/\u2013/g, "\\u2013")}`);
  return `${hits.length} wording hits (${counts})\n${lines.join("\n")}\n`;
}

// ---------- the surfaces ----------

const SCRIPTS = "services/api/scripts";
/** Every source file of the event lane that holds text a person reads, by page family. */
const SOURCE_SURFACES: Record<string, string[]> = {
  "shadow record (public record, slates, parlay record, operator views, scoreboard)": [
    `${SCRIPTS}/eventShadowHtml.ts`,
    `${SCRIPTS}/eventShadowWorker.ts`,
    `${SCRIPTS}/eventScoreboardHtml.ts`,
    `${SCRIPTS}/eventShadowSlateQuotes.ts`,
  ],
  "demo service (embed, board, funnel, receipts, partner pages, business card, listing mock)": [
    `${SCRIPTS}/eventProtectXDemoService.ts`,
    `${SCRIPTS}/eventProtectXAppHtml.ts`,
    `${SCRIPTS}/eventProtectEmbedHtml.ts`,
    `${SCRIPTS}/eventProtectLogo.ts`,
    `${SCRIPTS}/wagerwireListingMockHtml.ts`,
    `${SCRIPTS}/wagerwireListingsQuote.ts`,
  ],
  "member app (the STX member page)": [`${SCRIPTS}/memberAppHtml.ts`, `${SCRIPTS}/memberAppAssets.ts`],
  "engine (reasons and labels in src/eventCollar)": tsFilesUnder("services/api/src/eventCollar"),
  "older BTC event demo": [`${SCRIPTS}/eventProtectDemoService.ts`, `${SCRIPTS}/eventProtectAppHtml.ts`],
};

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(join(REPO_DIR, d), { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith(".ts")) out.push(join(d, e.name));
    }
  };
  walk(dir);
  return out.sort();
}

for (const [surface, files] of Object.entries(SOURCE_SURFACES)) {
  test(`copy rules, source: ${surface}`, () => {
    const hits: Hit[] = [];
    for (const f of files) checkSource(f, readFileSync(join(REPO_DIR, f), "utf8"), ts.ScriptKind.TS, hits);
    assert.equal(hits.length, 0, report(hits));
  });
}

test("copy rules, shipped: the browser extension (scripts, CSS, options page, manifest, PRIVACY.md, README)", () => {
  const hits: Hit[] = [];
  const dir = relative(REPO_DIR, EXT_DIR);
  const read = (name: string): string => readFileSync(join(EXT_DIR, name), "utf8");
  for (const js of ["content.js", "background.js", "options.js"]) checkSource(`${dir}/${js}`, read(js), ts.ScriptKind.JS, hits);
  checkCss(`${dir}/content.css`, read("content.css"), hits);
  checkHtml(`${dir}/options.html`, read("options.html"), { literal: false }, hits, 0);
  const manifest = JSON.parse(read("manifest.json")) as { name: string; description: string; short_name?: string; action?: { default_title?: string } };
  for (const words of [manifest.name, manifest.description, manifest.short_name, manifest.action?.default_title]) if (words) checkText(`${dir}/manifest.json`, words, { literal: false }, hits);
  checkMarkdown(`${dir}/PRIVACY.md`, read("PRIVACY.md"), hits);
  checkMarkdown(`${dir}/README.md`, read("README.md"), hits);
  assert.equal(hits.length, 0, report(hits));
});

// ---------- what is served ----------

test("copy rules, served: every page of the shadow record service, the demo service, the member app and the older BTC demo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "copy-rules-"));
  process.env.NODE_ENV = "test";
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = join(dir, "lock-ledger.jsonl");
  process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
  process.env.EVENT_HEDGE_RECEIPTS_PATH = join(dir, "hedge-receipts.jsonl");
  process.env.EVENT_SHADOW_SLATES = "wiremarkets=Wire Markets:nfl,nba";
  process.env.EVENT_SHADOW_SLATE_KEY = "share-key-1";
  process.env.EVENT_X_FUNNEL_PATH = join(dir, "funnel.json");
  process.env.EVENT_X_LEDGER_PATH = join(dir, "x-ledger.jsonl");
  process.env.MEMBER_APP_HOST = "https://venue.invalid";
  process.env.MEMBER_APP_CLIENT_ID = "client-1";
  process.env.MEMBER_APP_CLIENT_SECRET = "client-secret-1";
  process.env.MEMBER_APP_TOKENS_PATH = join(dir, "member-tokens.json");
  process.env.MEMBER_APP_TOKEN_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  const { appendShadowRecord } = await import("../src/eventCollar/crossVenue/shadowLedger");
  const lastLeg = await import("../src/eventCollar/crossVenue/lastLeg");
  const { slateLinkKey } = await import("../src/eventCollar/crossVenue/venueSlate");
  const open = {
    type: "open" as const,
    at: "2026-09-12T16:00:00.000Z",
    ticker: "KXNFLGAME-TEST-KC",
    kind: "sports" as const,
    league: "nfl",
    sideName: "Kansas City Chiefs",
    eventTitle: "Kansas City wins",
    eventTimeIso: "2026-09-21T00:20:00.000Z",
    contracts: 150,
    markCents: 60,
    floorCents: 52,
    capCents: 63,
    creditCents: 112,
    evCostBps: 297,
    route: "polymarket" as const,
    feesCents: 0,
    takeCents: 12,
  };
  const ledger = process.env.EVENT_SHADOW_LEDGER_PATH;
  appendShadowRecord(ledger, open);
  appendShadowRecord(ledger, { type: "settle", at: "2026-09-21T04:00:00.000Z", ticker: open.ticker, result: "no" });
  appendShadowRecord(ledger, { ...open, at: "2026-09-12T16:20:00.000Z", ticker: "KXNFLGAME-TEST-LAC", sideName: "Los Angeles Chargers", markCents: 40, floorCents: 32, capCents: 43, creditCents: 430, takeCents: 110, eventTimeIso: "2099-01-01T00:00:00.000Z" });
  const legs = [
    { conditionId: "A", slug: "nfl-a", title: "A game", league: "nfl", side: 0 as const, outcome: "Away", priceMilli: 700, yesTokenId: "A-t0", noTokenId: "A-t1", gameStartIso: "2026-10-10T13:00:00.000Z" },
    { conditionId: "D", slug: "nfl-d", title: "D game", league: "nfl", side: 0 as const, outcome: "Away", priceMilli: 600, yesTokenId: "D-t0", noTokenId: "D-t1", gameStartIso: "2026-10-11T20:00:00.000Z" },
  ];
  const price = lastLeg.comboPriceMilli(legs.map((l) => l.priceMilli));
  lastLeg.appendLastLegRecord(process.env.EVENT_LASTLEG_LEDGER_PATH, { type: "ticket", at: "2026-10-09T12:00:00.000Z", ticketId: "ll_pub", stakeCents: 2_000, legs, comboPriceMilli: price, sharesMilli: lastLeg.sharesFor(2_000, price) });
  lastLeg.appendLastLegRecord(process.env.EVENT_LASTLEG_LEDGER_PATH, { type: "leg", at: "2026-10-10T16:00:00.000Z", ticketId: "ll_pub", conditionId: "A", valueMilli: 1000 });

  const shadow = await import("../scripts/eventShadowWorker");
  const demo = await import("../scripts/eventProtectXDemoService");
  const btc = await import("../scripts/eventProtectDemoService");
  const listen = async (server: import("node:http").Server): Promise<string> => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const bases = { shadow: await listen(shadow.server), demo: await listen(demo.server), btc: await listen(btc.server) };
  const t = "token=op-secret";
  const pages: Array<[label: string, url: string]> = [
    ["shadow GET / (public record, eventShadowHtml.ts)", `${bases.shadow}/`],
    ["shadow GET /report (operator, eventShadowHtml.ts)", `${bases.shadow}/report?${t}`],
    ["shadow GET /venues (operator, eventShadowHtml.ts)", `${bases.shadow}/venues?${t}`],
    ["shadow GET /holders (operator, eventShadowHtml.ts)", `${bases.shadow}/holders?${t}`],
    ["shadow GET /pilot-check (operator, eventShadowHtml.ts)", `${bases.shadow}/pilot-check?${t}`],
    ["shadow GET /capital (operator, eventShadowHtml.ts)", `${bases.shadow}/capital?${t}`],
    ["shadow GET /scoreboard (eventScoreboardHtml.ts)", `${bases.shadow}/scoreboard?${t}`],
    ["shadow GET /slate/wiremarkets (eventShadowHtml.ts)", `${bases.shadow}/slate/wiremarkets?k=${slateLinkKey("share-key-1", "wiremarkets")}`],
    ["shadow GET /app (member page, memberAppHtml.ts)", `${bases.shadow}/app`],
    ["shadow GET /app/privacy (memberAppHtml.ts)", `${bases.shadow}/app/privacy`],
    ["shadow GET /api/shadow/member/callback (eventShadowWorker.ts)", `${bases.shadow}/api/shadow/member/callback?code=x&state=not-ours`],
    ["demo GET / (embed, eventProtectEmbedHtml.ts)", `${bases.demo}/`],
    ["demo GET /?brand=ProphetX&from=card (embed, eventProtectEmbedHtml.ts)", `${bases.demo}/?brand=ProphetX&from=card`],
    ["demo GET /board (eventProtectXAppHtml.ts)", `${bases.demo}/board`],
    ["demo GET /receipts (eventProtectXAppHtml.ts)", `${bases.demo}/receipts`],
    ["demo GET /partner (visitor, eventProtectEmbedHtml.ts)", `${bases.demo}/partner`],
    ["demo GET /partner (operator, eventProtectEmbedHtml.ts)", `${bases.demo}/partner?${t}`],
    ["demo GET /admin/funnel (operator, eventProtectXAppHtml.ts)", `${bases.demo}/admin/funnel?${t}`],
    ["btc demo GET / (eventProtectAppHtml.ts)", `${bases.btc}/`],
  ];
  const hits: Hit[] = [];
  const served: string[] = [];
  try {
    for (const [label, url] of pages) {
      const res = await fetch(url);
      const body = await res.text();
      assert.match(res.headers.get("content-type") ?? "", /text\/html/, `${label} answered ${res.status} ${res.headers.get("content-type")}: ${body.slice(0, 200)}`);
      assert.ok(body.length > 400, `${label} is a page`);
      served.push(label);
      checkHtml(label, body, { literal: false }, hits, 0);
    }
  } finally {
    for (const s of [shadow.server, demo.server, btc.server]) await new Promise<void>((r) => s.close(() => r()));
  }

  // The same render functions with the inputs the services' defaults do not reach.
  const embed = await import("../scripts/eventProtectEmbedHtml");
  const member = await import("../scripts/memberAppHtml");
  const rendered: Array<[label: string, html: string]> = [
    ["render renderEventEmbedHtml, venues named (eventProtectEmbedHtml.ts)", embed.renderEventEmbedHtml({ brand: "DraftKings", nameVenues: true, trackRecordUrl: "https://shadow.example", recordIsSlate: true })],
    ["render renderEventEmbedHtml, light skin, sports only, no video (eventProtectEmbedHtml.ts)", embed.renderEventEmbedHtml({ brand: "Kalshi", skin: "light", sportsOnly: true, liveVideo: null })],
    ["render memberAppHtml, not configured (memberAppHtml.ts)", member.memberAppHtml({ venueName: "STX", configured: false, recordUrl: "https://shadow.example" })],
    ["render memberAppHtml, with the venue link (memberAppHtml.ts)", member.memberAppHtml({ venueName: "STX", configured: true, recordUrl: "https://shadow.example", venueUrl: "https://venue.example" })],
    ["render memberPrivacyHtml, with a contact (memberAppHtml.ts)", member.memberPrivacyHtml({ venueName: "STX", recordUrl: "https://shadow.example", appUrl: "/app", contact: "privacy@example.com" })],
  ];
  for (const [label, html] of rendered) {
    served.push(label);
    checkHtml(label, html, { literal: false }, hits, 0);
  }
  assert.ok(served.length === pages.length + rendered.length);
  assert.equal(hits.length, 0, report(hits));
});

// ---------- the guard itself ----------

test("copy rules: the guard sees each rule in each place it can hide, and leaves the brand and code identifiers alone", () => {
  const rulesOf = (run: (hits: Hit[]) => void): Rule[] => {
    const hits: Hit[] = [];
    run(hits);
    return hits.map((h) => h.rule).sort();
  };
  const page = (body: string): Rule[] => rulesOf((h) => checkHtml("page", body, { literal: false }, h, 0));
  const source = (code: string): Rule[] => rulesOf((h) => checkSource("file.ts", code, ts.ScriptKind.TS, h));

  // rule 1, in every spelling a browser turns into a dash
  assert.deepEqual(page("<p>Floor \u2014 paid at settlement</p>"), [1]);
  assert.deepEqual(page("<p>5\u201310 minutes</p>"), [1]);
  assert.deepEqual(page("<p>Floor &mdash; paid</p><p>5&ndash;10</p><p>a &#8212; b</p><p>a &#x2013; b</p>"), [1, 1, 1, 1]);
  assert.deepEqual(page('<button title="Lock in \u2014 now">Lock in</button>'), [1]);
  assert.deepEqual(page('<style>.x::before{content:"\u2014"}</style><style>.y::after{content:"\\2014"}</style>'), [1, 1]);
  assert.deepEqual(page('<script>var empty = "\\u2014"; el.textContent = "none";</script>'), [1]);
  assert.deepEqual(source('const cell = "\u2014";'), [1]);
  assert.deepEqual(source("const js = String.raw`function draw(el) { el.textContent = '\\u2014'; return el; } function again(el) { return draw(el); }`;"), [1]);
  assert.deepEqual(source("// a comment with \u2014 in it is not copy\nconst ok = 'fine';"), []);

  // rule 2
  assert.deepEqual(page("<p>A guaranteed floor</p>"), [2]);
  assert.deepEqual(page("<p>We guarantee it. Risk-free. Risk free. No risk. You cannot lose.</p>"), [2, 2, 2, 2, 2]);
  assert.deepEqual(page("<p>The least you end with is $14.71.</p>"), []);

  // rule 3: the verb and the noun, wherever a person reads them; never the brand, never an identifier
  assert.deepEqual(page("<button>Protect</button>"), [3]);
  assert.deepEqual(page("<p>Protect your bet. Protection by Atticus. Your position is protected. An unprotected pick.</p>"), [3, 3, 3, 3]);
  assert.deepEqual(page('<input placeholder="Protect this">'), [3]);
  assert.deepEqual(page('<a aria-label="Protect now" class="x">Lock in</a>'), [3]);
  assert.deepEqual(page("<script>function label(p){ return p.protectable ? 'Protected' : 'Lock in'; }</script>"), [3]);
  assert.deepEqual(page("<p>Atticus Earn &amp; Protect: Lock in</p><h1>Earn & Protect</h1>"), []);
  assert.deepEqual(page('<div class="ael-protected" id="protect-btn" data-protect="1"><a href="/api/protect?x=1">Lock in</a></div>'), []);
  assert.deepEqual(page("<p>The field <code>markets[].protectable</code>, the route /api/shadow/protect, the env EVENT_X_PROTECT_WINDOW, the class .ael-protected, the function protectWindow().</p>"), []);
  assert.deepEqual(page("<p>See earnandprotect.xyz</p>"), []);
  assert.deepEqual(source('const state: "protected" | "open" = "protected"; const key = "notProtectable"; fetch("/api/protect"); el.classList.add("ael-protected");'), []);
  assert.deepEqual(source('const label = "Protected"; const line = "protect your bet";'), [3, 3]);
  assert.deepEqual(source("const html = `<div class=\"protect ${cls}\">${n} games the service can protect</div>`;"), [3]);

  // rule 4
  assert.deepEqual(page("<p>Connect your wallet. Two wallets.</p>"), [4, 4]);
  assert.deepEqual(page("<p>Paste your address.</p>"), []);
  assert.deepEqual(source('const field = "wallet"; const q = "proxyWallet"; const u = "/api/wallets/0x1"; const e = "EVENT_SHADOW_EXCLUDED_WALLETS";'), []);
  assert.deepEqual(source('const msg = "no wallet connected";'), [4]);

  // rule 7: the retired ways of saying when the cash arrives, and the two that stand
  assert.deepEqual(page("<p>Cash now +$1.66</p><p>$1.66 paid now</p><p>a credit paid at the tap</p><p>paid $3 up front</p><p>$2 paid at open</p><p>the $2 paid to you at the lock</p><p>In your STX balance now</p><p>you get paid today</p><p>yours today</p><p>Lock in $40 · take $3 now</p>"), [7, 7, 7, 7, 7, 7, 7, 7, 7, 7]);
  assert.deepEqual(page("<p>$1.66 credited at lock in. The floor is paid at settlement.</p><p>The cash lands in your STX balance when the lock fills; each contract you keep pays $1 if it wins.</p>"), []);
  assert.deepEqual(page("<p>No credit can be funded right now. The upside you gave up is worth more now. Locked at today's price. Take fills now at the best price.</p>"), []);

  // rule 8: no sale in any form on what a holder or a visitor reads
  assert.deepEqual(page("<p>A lock sells part of your position.</p><p>Sold 40 of 100.</p><p>Your own sale into the book.</p><p>Selling into the bid.</p><p>40 unsold. The seller keeps 60.</p>"), [8, 8, 8, 8, 8, 8]);
  assert.deepEqual(page('<button aria-label="Sell 40%">Lock in</button><script>var verb = done ? "Sold" : "Sell";</script>'), [8, 8, 8]);
  assert.deepEqual(page("<p>A lock takes cash out of a position you hold. Locked 40 of 100 at 62 cents, 60 still riding. Cash out ends the whole ticket. The hedge was closed.</p>"), []);
  assert.deepEqual(page('<span class="chip sold" data-sale="1">40 locked</span><p>The field memberSale.soldContracts and the route /api/shadow/member/sale.</p>'), []);
  assert.deepEqual(rulesOf((h) => checkSource("services/api/scripts/memberAppHtml.ts", 'const a = "nothing was sold"; const b = p.lock.memberSale.soldContracts; const c = "sold";', ts.ScriptKind.TS, h)), [8]);
  // a sentence put together in code: the word with a space or a tag beside it is copy, the word alone is a state
  assert.deepEqual(rulesOf((h) => checkSource("demo/event-lockin-extension/content.js", 'const a = n + " sold"; const b = "<b>" + n + "</b> sold"; const c = "sold " + when;', ts.ScriptKind.JS, h)), [8, 8, 8]);
  assert.deepEqual(rulesOf((h) => checkSource("demo/event-lockin-extension/content.js", 'const state = "sold"; if (o.side === "sell") el.dataset.state = state;', ts.ScriptKind.JS, h)), []);
  // the service's own source and the operator's pages: only a sentence about the holder
  const worker = (code: string): Rule[] => rulesOf((h) => checkSource("services/api/scripts/eventShadowWorker.ts", code, ts.ScriptKind.TS, h));
  assert.deepEqual(worker('const alert = "Sell the hedge by hand, then clear the flag."; const note = "sold on Kalshi, order 12";'), []);
  assert.deepEqual(worker('const msg = "The contracts you sold stay sold."; const why = "no hedge on a member sale"; const two = "The hedge is closed. Your sale stands.";'), [8, 8, 8, 8]);
  assert.deepEqual(rulesOf((h) => checkHtml("shadow GET /capital (operator, eventShadowHtml.ts)", "<p>The hedge is sold by hand.</p><p>The holder sells in their own account.</p>", { literal: false }, h, 0)), [8]);
  assert.deepEqual(rulesOf((h) => checkHtml("shadow GET / (public record, eventShadowHtml.ts)", "<p>The hedge is sold by hand.</p>", { literal: false }, h, 0)), [8]);
  // the venue's own word for a lister, and the developer notes
  assert.deepEqual(rulesOf((h) => checkSource("services/api/scripts/wagerwireListingMockHtml.ts", 'const a = "Nothing for the seller to manage afterwards.";', ts.ScriptKind.TS, h)), []);
  assert.deepEqual(rulesOf((h) => checkMarkdown("demo/event-lockin-extension/README.md", "The lock is the holder's own partial sale.", h)), []);
  assert.deepEqual(rulesOf((h) => checkMarkdown("demo/event-lockin-extension/PRIVACY.md", "One sell order for part of a position.", h)), [8]);
  assert.deepEqual(rulesOf((h) => checkHtml("btc demo GET /", "<p>Cash now +$1.66</p>", { literal: false }, h, 0)), []);

  // markdown: code spans and blocks are identifiers, prose is copy
  const md = (text: string): Rule[] => rulesOf((h) => checkMarkdown("README.md", text, h));
  assert.deepEqual(md("The pill shows on each game the service can protect."), [3]);
  assert.deepEqual(md("`markets[].protectable` is true from seven days out.\n\n```\nprotect --now\n```\n"), []);
  assert.deepEqual(md("A range 7:00\u20137:30pm, a guarantee, a wallet."), [1, 2, 4]);
  assert.deepEqual(md("# Atticus Earn & Protect: Lock in"), []);

  // a hit names the file, the rule and the text
  const hits: Hit[] = [];
  checkSource("services/api/scripts/x.ts", 'const a = 1;\nconst b = "Protect your bet";', ts.ScriptKind.TS, hits);
  assert.deepEqual(hits, [{ file: "services/api/scripts/x.ts:2", rule: 3, text: "Protect your bet" }]);
  assert.match(report(hits), /services\/api\/scripts\/x\.ts:2\n\s+rule 3, "Lock in", never "protect": "Protect your bet"/);
});
