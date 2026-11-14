/**
 * THE OPERATOR'S SIGN-IN: the token out of addresses, on both event services.
 *
 * Held here, against the two services as they run:
 *   - the cookie is the operator's on the operator's own paths, and on a path the public also
 *     reads only when the address asks for it (as=operator);
 *   - a request that can change something is not the operator's by cookie unless the browser
 *     says it came from this service's own page;
 *   - a page opened with the token in its address is sent on without it, and no page the
 *     services draw carries the token on a link;
 *   - a script's header token and a JSON route's query token read as they always did;
 *   - replacing the token ends every sign-in; a sign-in ends on its hour.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addressWithoutToken,
  canChangeState,
  cookieFromHeader,
  isPagePath,
  mintOperatorCookie,
  OPERATOR_COOKIE,
  operatorCheck,
  operatorCookieHeader,
  operatorCookieValid,
  operatorSessionConfigFromEnv,
  renderOperatorSignInHtml,
  safeEqual,
  safeNext,
  sameOriginRequest,
} from "../src/eventCollar/crossVenue/operatorSession";
import type { GameMarketRow, OneQuoteResult } from "../scripts/eventProtectXDemoService";

const TOKEN = "op-secret-0123456789";
const HOUR = 3_600_000;

const dir = mkdtempSync(join(tmpdir(), "operator-session-"));
process.env.NODE_ENV = "test";
process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = join(dir, "lock-ledger.jsonl");
process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
process.env.EVENT_X_FUNNEL_PATH = join(dir, "funnel.json");
process.env.EVENT_X_LEDGER_PATH = join(dir, "demo-ledger.jsonl");
process.env.EVENT_X_ADMIN_TOKEN = TOKEN;
process.env.EVENT_SHADOW_SLATES = "acme=Acme Sports:nba";
for (const k of Object.keys(process.env)) if (/^EVENT_HEDGE_|^EVENT_SHADOW_ALERT_|^EVENT_X_NAME_HEDGE_VENUES$|^EVENT_X_DEV_NO_ADMIN$|^EVENT_X_ADMIN_SESSION_HOURS$|^EVENT_X_ADMIN_QUERY_TOKEN$|^EVENT_SHADOW_SLATE_KEY$/.test(k)) delete process.env[k];

let worker: typeof import("../scripts/eventShadowWorker");
let demo: typeof import("../scripts/eventProtectXDemoService");
let base = "";
let demoBase = "";

before(async () => {
  worker = await import("../scripts/eventShadowWorker");
  worker.wireLockEngine({
    listGameMarkets: async (): Promise<GameMarketRow[]> => [],
    quoteOne: async (): Promise<OneQuoteResult> => ({ ok: false, status: 404, body: { ok: false } }) as unknown as OneQuoteResult,
  });
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  demo = await import("../scripts/eventProtectXDemoService");
  await new Promise<void>((r) => demo.server.listen(0, "127.0.0.1", () => r()));
  demoBase = `http://127.0.0.1:${(demo.server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => worker.server.close(() => r()));
  await new Promise<void>((r) => demo.server.close(() => r()));
});

const BROWSER = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
/** One request as a browser would send it, never following a redirect. */
const get = (url: string, headers: Record<string, string> = {}): Promise<Response> => fetch(url, { redirect: "manual", headers });
const cookiePair = (res: Response): string => (res.headers.get("set-cookie") ?? "").split(";")[0];
/** Sign in the way the page does: the token in the body of a form. */
async function signIn(at: string, token = TOKEN, extra: Record<string, string> = {}, next?: string): Promise<Response> {
  return fetch(`${at}/operator`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...extra },
    body: new URLSearchParams({ token, ...(next ? { next } : {}) }).toString(),
  });
}

test("the settings: twelve hours and the query token read by default; a value that cannot be read falls to the safe side and says so", () => {
  assert.deepEqual(operatorSessionConfigFromEnv({}), { ttlMs: 12 * HOUR, queryToken: true, notes: [] });
  assert.equal(operatorSessionConfigFromEnv({ EVENT_X_ADMIN_SESSION_HOURS: "2" }).ttlMs, 2 * HOUR);
  assert.equal(operatorSessionConfigFromEnv({ EVENT_X_ADMIN_SESSION_HOURS: "0.5" }).ttlMs, 12 * HOUR, "under an hour is not a session length");
  assert.equal(operatorSessionConfigFromEnv({ EVENT_X_ADMIN_SESSION_HOURS: "0.5" }).notes.length, 1);
  assert.equal(operatorSessionConfigFromEnv({ EVENT_X_ADMIN_SESSION_HOURS: "9000" }).ttlMs, 12 * HOUR);
  assert.equal(operatorSessionConfigFromEnv({ EVENT_X_ADMIN_SESSION_HOURS: "soon" }).ttlMs, 12 * HOUR);
  for (const off of ["off", "OFF", "0", "no", "false"]) assert.equal(operatorSessionConfigFromEnv({ EVENT_X_ADMIN_QUERY_TOKEN: off }).queryToken, false, off);
  for (const on of ["on", "1", "yes", "true"]) assert.equal(operatorSessionConfigFromEnv({ EVENT_X_ADMIN_QUERY_TOKEN: on }).queryToken, true, on);
  const unread = operatorSessionConfigFromEnv({ EVENT_X_ADMIN_QUERY_TOKEN: "maybe" });
  assert.equal(unread.queryToken, false, "not guessed at: the side that keeps the token out of addresses");
  assert.equal(unread.notes.length, 1);
});

test("the cookie: sound until its hour and not after; another token, a changed expiry and a malformed value are not it; the token is not in it", () => {
  const t0 = Date.UTC(2026, 10, 11, 4, 0, 0);
  const c = mintOperatorCookie(TOKEN, t0, 12 * HOUR);
  assert.match(c, /^v1\.\d{13}\.[A-Za-z0-9_-]{43}$/);
  assert.ok(!c.includes(TOKEN));
  assert.equal(operatorCookieValid(TOKEN, c, t0), true);
  assert.equal(operatorCookieValid(TOKEN, c, t0 + 12 * HOUR - 1), true, "the last millisecond of the twelfth hour");
  assert.equal(operatorCookieValid(TOKEN, c, t0 + 12 * HOUR), false, "ended on its hour");
  assert.equal(operatorCookieValid("the-token-after-it-was-replaced", c, t0), false, "replacing the token ends every sign-in");
  const [v, exp, mac] = c.split(".");
  assert.equal(operatorCookieValid(TOKEN, `${v}.${Number(exp) + 1}.${mac}`, t0), false, "an expiry moved by one millisecond");
  assert.equal(operatorCookieValid(TOKEN, `${v}.${exp}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`, t0), false);
  for (const bad of ["", "v1", `v2.${exp}.${mac}`, `${v}.${exp}`, `${v}.${exp}.`, `${v}.abc.${mac}`, TOKEN]) assert.equal(operatorCookieValid(TOKEN, bad, t0), false, bad);
  assert.equal(operatorCookieValid(null, c, t0), false);
  assert.equal(operatorCookieValid(TOKEN, null, t0), false);
  // two sign-ins at different moments are two cookies; the same moment is the same one (nothing random is kept)
  assert.notEqual(mintOperatorCookie(TOKEN, t0 + 1, 12 * HOUR), c);
  assert.equal(mintOperatorCookie(TOKEN, t0, 12 * HOUR), c);

  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(cookieFromHeader(`a=1; ${OPERATOR_COOKIE}=${c}; b=2`, OPERATOR_COOKIE), c);
  assert.equal(cookieFromHeader("a=1; b=2", OPERATOR_COOKIE), null);
  assert.equal(cookieFromHeader(undefined, OPERATOR_COOKIE), null);

  // HttpOnly and SameSite always; Secure everywhere but a plain localhost
  const onHost = operatorCookieHeader(c, 43_200, { host: "atticus-event-shadow.onrender.com" });
  assert.ok(/; HttpOnly/.test(onHost) && /; SameSite=Lax/.test(onHost) && /; Secure/.test(onHost) && /; Path=\//.test(onHost) && /Max-Age=43200/.test(onHost), onHost);
  assert.ok(!/Secure/.test(operatorCookieHeader(c, 43_200, { host: "127.0.0.1:8911" })));
  assert.ok(/Secure/.test(operatorCookieHeader(c, 43_200, { host: "localhost:8911", "x-forwarded-proto": "https" })));
  assert.ok(/Secure/.test(operatorCookieHeader(c, 43_200, {})), "no host named: Secure");
});

test("who is the operator: the header and the query as before; the cookie on the operator's own paths, and on a shared path only when asked", () => {
  const now = Date.UTC(2026, 10, 11, 4, 0, 0);
  const auth = { enabled: true, token: TOKEN };
  const cfg = operatorSessionConfigFromEnv({});
  const cookie = `${OPERATOR_COOKIE}=${mintOperatorCookie(TOKEN, now, cfg.ttlMs)}`;
  const check = (path: string, headers: Record<string, string>, o: { only?: boolean; method?: string; cfg?: typeof cfg; auth?: typeof auth | { enabled: boolean; token: null } } = {}) =>
    operatorCheck({ auth: o.auth ?? auth, cfg: o.cfg ?? cfg, headers, method: o.method ?? "GET", url: new URL(path, "http://svc.test"), operatorOnlyPath: o.only ?? false, nowMs: now });

  assert.deepEqual(check("/report", {}, { only: true }), { operator: false, via: null });
  assert.deepEqual(check("/report", { "x-admin-token": TOKEN }, { only: true }), { operator: true, via: "header" });
  assert.deepEqual(check("/report", { authorization: `Bearer ${TOKEN}` }, { only: true }), { operator: true, via: "header" });
  assert.deepEqual(check("/report", { "x-admin-token": "wrong" }, { only: true }), { operator: false, via: null });
  assert.deepEqual(check(`/report?token=${TOKEN}`, {}, { only: true }), { operator: true, via: "query" });
  assert.deepEqual(check("/report?token=wrong", {}, { only: true }), { operator: false, via: null });
  // the query form switched off: the same token in the address is nothing; the header still is
  const off = operatorSessionConfigFromEnv({ EVENT_X_ADMIN_QUERY_TOKEN: "off" });
  assert.deepEqual(check(`/report?token=${TOKEN}`, {}, { only: true, cfg: off }), { operator: false, via: null });
  assert.deepEqual(check(`/report?token=${TOKEN}`, { "x-admin-token": TOKEN }, { only: true, cfg: off }), { operator: true, via: "header" });

  // the cookie
  assert.deepEqual(check("/report", { cookie }, { only: true }), { operator: true, via: "cookie" });
  assert.deepEqual(check("/healthz", { cookie }), { operator: false, via: null, cookieIgnored: "not_asked" }, "signed in, on a public path: the public view");
  assert.deepEqual(check("/healthz?as=operator", { cookie }), { operator: true, via: "cookie" });
  assert.deepEqual(check("/healthz?as=someone", { cookie }), { operator: false, via: null, cookieIgnored: "not_asked" });
  assert.deepEqual(check("/healthz?as=operator", {}), { operator: false, via: null }, "asking without a session is nothing");
  assert.deepEqual(check("/report", { cookie: `${OPERATOR_COOKIE}=${mintOperatorCookie("another-token", now, cfg.ttlMs)}` }, { only: true }), { operator: false, via: null });
  assert.deepEqual(check("/report", { cookie: `${OPERATOR_COOKIE}=${mintOperatorCookie(TOKEN, now - 13 * HOUR, cfg.ttlMs)}` }, { only: true }), { operator: false, via: null }, "a sign-in thirteen hours old");

  // a request that can change something: the cookie only from this service's own page
  const write = { only: true, method: "POST" };
  assert.deepEqual(check("/api/shadow/cash", { cookie }, write), { operator: false, via: null, cookieIgnored: "cross_site" }, "the browser said nothing about where it came from");
  assert.deepEqual(check("/api/shadow/cash", { cookie, "sec-fetch-site": "cross-site" }, write), { operator: false, via: null, cookieIgnored: "cross_site" });
  assert.deepEqual(check("/api/shadow/cash", { cookie, "sec-fetch-site": "same-site" }, write), { operator: false, via: null, cookieIgnored: "cross_site" }, "a sister subdomain is not this service");
  assert.deepEqual(check("/api/shadow/cash", { cookie, "sec-fetch-site": "none" }, write), { operator: false, via: null, cookieIgnored: "cross_site" });
  assert.deepEqual(check("/api/shadow/cash", { cookie, "sec-fetch-site": "same-origin" }, write), { operator: true, via: "cookie" });
  assert.deepEqual(check("/api/shadow/cash", { cookie, host: "svc.test", origin: "https://svc.test" }, write), { operator: true, via: "cookie" });
  assert.deepEqual(check("/api/shadow/cash", { cookie, host: "svc.test", origin: "https://evil.test" }, write), { operator: false, via: null, cookieIgnored: "cross_site" });
  assert.deepEqual(check("/api/shadow/cash", { cookie, host: "svc.test", origin: "https://svc.test", "sec-fetch-site": "cross-site" }, write), { operator: false, via: null, cookieIgnored: "cross_site" }, "what the browser says about the site wins over a matching Origin");
  // the writing GETs are spelled with `confirm`: a link in a message cannot use the session
  assert.deepEqual(check("/api/shadow/reset?confirm=reset", { cookie, "sec-fetch-site": "none" }, { only: true }), { operator: false, via: null, cookieIgnored: "cross_site" });
  assert.deepEqual(check("/api/shadow/reset?confirm=reset", { cookie, "sec-fetch-site": "cross-site" }, { only: true }), { operator: false, via: null, cookieIgnored: "cross_site" });
  assert.deepEqual(check("/api/shadow/reset?confirm=reset", { cookie, "sec-fetch-site": "same-origin" }, { only: true }), { operator: true, via: "cookie" });
  // a header token is not a thing a browser sends by itself: it writes from anywhere, as before
  assert.deepEqual(check("/api/shadow/cash", { "x-admin-token": TOKEN, "sec-fetch-site": "cross-site" }, write), { operator: true, via: "header" });

  // operator views off, and the development setting with no token
  assert.deepEqual(check("/report", { cookie, "x-admin-token": TOKEN }, { only: true, auth: { enabled: false, token: null } }), { operator: false, via: null });
  assert.deepEqual(check("/report", {}, { only: true, auth: { enabled: true, token: null } }), { operator: true, via: "open" });

  assert.equal(canChangeState("GET", new URL("http://x/report")), false);
  assert.equal(canChangeState("HEAD", new URL("http://x/report")), false);
  assert.equal(canChangeState("GET", new URL("http://x/a?confirm=yes")), true);
  assert.equal(canChangeState("POST", new URL("http://x/a")), true);
  assert.equal(canChangeState("delete", new URL("http://x/a")), true);
  assert.equal(sameOriginRequest({}), false);
  assert.equal(sameOriginRequest({ origin: "null", host: "svc.test" }), false);
});

test("where a sign-in goes next is on this service, and an address is handed on without its token", () => {
  assert.equal(safeNext("/report"), "/report");
  assert.equal(safeNext("/slate/acme?as=operator"), "/slate/acme?as=operator");
  assert.equal(safeNext(`/report?token=${TOKEN}&x=1`), "/report?x=1", "the token never rides along");
  for (const out of ["https://evil.test/", "//evil.test/x", "/\\evil.test", "report", "", null, undefined, "/a\r\nset-cookie: x=1", `/${"a".repeat(700)}`]) assert.equal(safeNext(out), "/operator", String(out));

  assert.equal(addressWithoutToken(new URL(`http://x/report?token=${TOKEN}`), true), "/report");
  assert.equal(addressWithoutToken(new URL(`http://x/venues?days=30&token=${TOKEN}`), true), "/venues?days=30");
  assert.equal(addressWithoutToken(new URL(`http://x/scoreboard?token=${TOKEN}&weeks=26`), false), "/scoreboard?weeks=26&as=operator", "a shared page keeps the operator's view by asking for it");

  assert.equal(isPagePath("/report"), true);
  assert.equal(isPagePath("/slate/acme"), true);
  assert.equal(isPagePath("/api/shadow/report"), false);
  assert.equal(isPagePath("/slate/acme.csv"), false);
  assert.equal(isPagePath("/healthz"), false, "the host's check is never redirected");

  const form = renderOperatorSignInHtml({ service: "Svc", state: "form", next: '/report?x="><script>', links: [], hours: 12 });
  assert.ok(form.includes('method="post"') && form.includes('type="password"') && form.includes('name="token"'));
  assert.ok(!form.includes("<script>"), "what came in on the address is escaped");
  assert.ok(!form.includes("\u2014") && !form.includes("\u2013"));
});

test("where a sign-in goes next: a page to look at, never an address that changes something, an API route, a file, or another site", () => {
  for (const ok of ["/report", "/holders", "/capital", "/venues", "/slate/acme?as=operator", "/scoreboard?as=operator", "/partners/console"]) assert.equal(safeNext(ok), ok);
  assert.equal(safeNext(`/report?token=${TOKEN}&x=1`), "/report?x=1", "the token never rides along");
  const writing = ["/api/shadow/reset?confirm=reset", "/api/admin/reset?confirm=reset", "/report?confirm=yes", "/holders?x=1&confirm", "/anything?CONFIRM=1&confirm=1"];
  const notPages = ["/api/shadow/export/files", "/api/shadow", "/healthz?as=operator", "/api/shadow/positions.csv", "/ledger.jsonl", "/x.json"];
  const elsewhere = ["/.//evil.example/x", "/..//evil.example", "/a/..//evil.example/", "//evil.example/x", "/\\evil.example", "https://evil.example/", "/%2e//evil.example"];
  for (const bad of [...writing, ...notPages, ...elsewhere, "report", "", null, undefined, "/a\r\nset-cookie: x=1", `/${"a".repeat(700)}`]) {
    const out = safeNext(bad);
    assert.ok(out === "/operator" || (!out.startsWith("//") && !/confirm/i.test(out) && !out.startsWith("/api/")), `${String(bad)} -> ${out}`);
    if (writing.includes(bad as string) || notPages.includes(bad as string) || (bad as string) === "/.//evil.example/x" || (bad as string) === "/..//evil.example" || (bad as string) === "/a/..//evil.example/") assert.equal(out, "/operator", String(bad));
  }
});

for (const service of ["record", "demo"] as const) {
  test(`${service} service: a sign-in link whose next is a writing address, an API route or another site lands on the sign-in page, signed in, and runs nothing`, async () => {
    const at = service === "record" ? base : demoBase;
    let caller = 0;
    const go = (next: string) => signIn(at, TOKEN, { "x-forwarded-for": `198.51.100.${(caller += 1)}` }, next);
    const reset = service === "record" ? "/api/shadow/reset?confirm=reset" : "/api/admin/reset?confirm=reset";
    for (const next of [reset, "/api/shadow/export/files", "/.//evil.example/x", "//evil.example/x"]) {
      const res = await go(next);
      assert.equal(res.status, 303, next);
      assert.equal(res.headers.get("location"), "/operator", `${next} is not where the browser is sent`);
      assert.match(res.headers.get("set-cookie") ?? "", new RegExp(`^${OPERATOR_COOKIE}=`), "the operator is signed in all the same");
    }
    // the link itself: the page it opens carries the sign-in path in its form, not the address in the link
    const page = await (await fetch(`${at}/operator?next=${encodeURIComponent(reset)}`)).text();
    assert.doesNotMatch(page, /confirm/, "the writing address is not on the page");
    assert.match(page, /name="next" value="\/operator"/);
    // a wrong token goes back to the form without it either
    const wrong = await signIn(at, "not-it", { "x-forwarded-for": "198.51.100.200" }, reset);
    assert.equal(wrong.headers.get("location"), "/operator?problem=bad_token");
    // a page to look at still works
    const fine = await go(service === "record" ? "/holders" : "/funnel");
    assert.equal(fine.headers.get("location"), service === "record" ? "/holders" : "/funnel");
  });
}

test("record service: an operator page in a browser goes to the sign-in and back; a script gets the 403 it always got", async () => {
  const browser = await get(`${base}/report`, BROWSER);
  assert.equal(browser.status, 303);
  assert.equal(browser.headers.get("location"), "/operator?next=%2Freport");
  const script = await get(`${base}/report`);
  assert.equal(script.status, 403);
  assert.deepEqual(await script.json(), { ok: false, error: "bad admin token" });
  // a JSON route is a script's whoever asks for it
  assert.equal((await get(`${base}/api/shadow/report`, BROWSER)).status, 403);

  const page = await get(`${base}/operator?next=%2Freport`, BROWSER);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  const html = await page.text();
  assert.ok(html.includes('<input type="hidden" name="next" value="/report" />'));
  assert.ok(html.includes('type="password"'));
  assert.ok(!html.includes(TOKEN));
});

test("record service: a right token at the sign-in sets the cookie and goes on; a wrong one sets nothing; the eighth miss in a minute is the last one heard", async () => {
  const bad = await signIn(base, "not-the-token", { "x-forwarded-for": "203.0.113.50" }, "/report");
  assert.equal(bad.status, 303);
  assert.equal(bad.headers.get("location"), "/operator?problem=bad_token&next=%2Freport");
  assert.equal(bad.headers.get("set-cookie"), null);
  assert.ok((await (await get(`${base}${bad.headers.get("location")}`, BROWSER)).text()).includes("That token was not accepted. Nothing was signed in."));
  const empty = await signIn(base, "", { "x-forwarded-for": "203.0.113.50" });
  assert.equal(empty.headers.get("location"), "/operator?problem=bad_token");

  const ok = await signIn(base, TOKEN, { "x-forwarded-for": "203.0.113.51" }, "/report");
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/report");
  const set = ok.headers.get("set-cookie") ?? "";
  assert.match(set, /^atticus_op=v1\.\d{13}\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=43200; HttpOnly; SameSite=Lax$/, "on a plain localhost the cookie is not marked Secure; everywhere else it is");
  assert.ok(!set.includes(TOKEN));
  // a `next` that leaves the service is not followed
  const away = await signIn(base, TOKEN, { "x-forwarded-for": "203.0.113.52" }, "https://evil.test/collect");
  assert.equal(away.headers.get("location"), "/operator");

  // the cookie opens the operator's page, and the page carries no token on any link
  const report = await get(`${base}/report`, { ...BROWSER, cookie: cookiePair(ok) });
  assert.equal(report.status, 200);
  const reportHtml = await report.text();
  assert.ok(!reportHtml.includes("token="), "no link on the page carries a token");
  assert.ok(reportHtml.includes('href="/api/shadow/positions.csv?scope=full&amp;as=operator"'));
  assert.ok(reportHtml.includes('href="/venues"'));

  // signed in: the sign-in page says so and offers the views
  const signed = await (await get(`${base}/operator`, { ...BROWSER, cookie: cookiePair(ok) })).text();
  assert.ok(signed.includes("Signed in on this browser.") && signed.includes('href="/pilot-check"') && signed.includes('action="/operator/sign-out"'));
  // the box that opens an address from this page (how a writing GET is run from a browser); it goes nowhere off the service
  const goScript = /<script>\n(document\.getElementById\('go'\)[\s\S]*?)<\/script>/.exec(signed)?.[1] ?? "";
  const went: string[] = [];
  const runGo = (value: string): void => {
    let submit: (e: { preventDefault: () => void }) => void = () => undefined;
    const doc = { getElementById: (id: string) => (id === "go" ? { addEventListener: (_: string, fn: typeof submit) => (submit = fn) } : { value }) };
    new Function("document", "location", goScript)(doc, { assign: (v: string) => went.push(v) });
    submit({ preventDefault: () => undefined });
  };
  for (const v of ["/api/shadow/kalshi/account", " /api/shadow/reset?confirm=reset ", "https://evil.test/", "//evil.test/x", "/\\evil.test", "report"]) runGo(v);
  assert.deepEqual(went, ["/api/shadow/kalshi/account", "/api/shadow/reset?confirm=reset"]);

  // the limiter: eight attempts a minute from one caller, right or wrong
  let limited = 0;
  for (let i = 0; i < 10; i++) {
    const r = await signIn(base, i === 9 ? TOKEN : `guess-${i}`, { "x-forwarded-for": "203.0.113.99" });
    if ((r.headers.get("location") ?? "").includes("problem=too_many")) {
      limited += 1;
      assert.equal(r.headers.get("set-cookie"), null, "even the right token is not heard once the caller is over");
    }
  }
  assert.equal(limited, 2);
  assert.ok((await (await get(`${base}/operator?problem=too_many`, BROWSER)).text()).includes("Too many attempts. Wait a minute and try again."));
});

test("record service: signed in, the public pages stay public until the address asks; the operator's view is asked for with as=operator", async () => {
  const cookie = cookiePair(await signIn(base, TOKEN, { "x-forwarded-for": "203.0.113.60" }));
  type Health = { operator?: boolean; ledger?: unknown; operatorSignIn?: { page: string; hours: number; tokenInAddress: string } };
  const pub = (await (await get(`${base}/healthz`, { cookie })).json()) as Health;
  assert.equal(pub.ledger, undefined, "signed in, and still the public status");
  const op = (await (await get(`${base}/healthz?as=operator`, { cookie })).json()) as Health;
  assert.ok(op.ledger, "asked for: the operator's status");
  assert.deepEqual(op.operatorSignIn, { page: "/operator", hours: 12, tokenInAddress: "read, and a page opened that way is sent on without it" });
  assert.equal(((await (await get(`${base}/healthz?as=operator`)).json()) as Health).ledger, undefined, "asking without a session is the public status");

  // the scoreboard: lettered for the public and for a signed-in operator who did not ask; named when asked
  const lettered = await (await get(`${base}/scoreboard`, { ...BROWSER, cookie })).text();
  assert.ok(lettered.includes("The venues are lettered, not named."));
  const named = await get(`${base}/scoreboard?as=operator`, { ...BROWSER, cookie });
  assert.equal(named.headers.get("cache-control"), "private, no-store");
  const namedHtml = await named.text();
  assert.ok(namedHtml.includes("Venues named: this is the operator's view"));
  assert.ok(namedHtml.includes('href="/api/shadow/scoreboard?as=operator"') && namedHtml.includes('href="/api/shadow/scoreboard.csv?as=operator"'), "its links ask for the same view");
  assert.ok(namedHtml.includes('href="/scoreboard?weeks=26&amp;as=operator"'));
  assert.ok(!lettered.includes("as=operator"));

  // a prospect's slate: a 404 to everyone without the key, the operator's when asked
  assert.equal((await get(`${base}/slate/acme`, { ...BROWSER, cookie })).status, 404);
  const slate = await get(`${base}/slate/acme?as=operator`, { ...BROWSER, cookie });
  assert.equal(slate.status, 200);
  const slateHtml = await slate.text();
  assert.ok(slateHtml.includes('href="/slate/acme.csv?as=operator"'));
  assert.ok(!slateHtml.includes("token="));
  assert.equal((await get(`${base}/slate/acme.csv?as=operator`, { cookie })).status, 200);
});

test("record service: every operator page opens on the cookie and none of them draws a token on a link", async () => {
  const cookie = cookiePair(await signIn(base, TOKEN, { "x-forwarded-for": "203.0.113.61" }));
  for (const path of ["/report", "/holders", "/pilot-check", "/capital", "/venues"]) {
    const res = await get(`${base}${path}`, { ...BROWSER, cookie });
    assert.equal(res.status, 200, path);
    const html = await res.text();
    assert.ok(!/[?&]token=/.test(html), `${path} carries no token on a link`);
    if (path !== "/report" && path !== "/capital") assert.ok(html.includes('href="/healthz?as=operator"'), `${path} links the operator's status`);
  }
  // and the JSON behind them, for a browser tab
  for (const path of ["/api/shadow/report", "/api/shadow/holders", "/api/shadow/pilot-check", "/api/shadow/capital", "/api/shadow/lock/pending"]) assert.equal((await get(`${base}${path}`, { cookie })).status, 200, path);
});

test("record service: the cookie does not write from another site; from this service's own page it does; a header token writes as before", async () => {
  const cookie = cookiePair(await signIn(base, TOKEN, { "x-forwarded-for": "203.0.113.62" }));
  const clear = (headers: Record<string, string>) => fetch(`${base}/api/shadow/lock/pending/clear?id=nothing&note=looked+at+it+on+the+venue`, { method: "POST", headers });
  for (const site of [undefined, "cross-site", "same-site", "none"]) {
    const res = await clear({ cookie, ...(site ? { "sec-fetch-site": site } : {}) });
    assert.equal(res.status, 403, String(site));
    const body = (await res.json()) as { error: string; message?: string };
    assert.equal(body.error, "bad admin token");
    assert.ok(body.message?.startsWith("The sign-in on this browser does not cover an address that changes something when that address is typed, opened from a link elsewhere, or sent from another site. Open it from the box on /operator"), "said, so it is not mistaken for a signed-out browser");
  }
  // from the service's own page the request reaches the route (which has nothing by that id to clear)
  assert.notEqual((await clear({ cookie, "sec-fetch-site": "same-origin" })).status, 403);
  assert.notEqual((await clear({ "x-admin-token": TOKEN, "sec-fetch-site": "cross-site" })).status, 403);

  // the writing GET: a link in a message cannot reset the record on a signed-in browser
  const before = (await (await get(`${base}/healthz?as=operator`, { cookie })).json()) as { positions: number };
  for (const site of ["none", "cross-site"]) assert.equal((await get(`${base}/api/shadow/reset?confirm=reset`, { cookie, "sec-fetch-site": site })).status, 403, site);
  assert.equal((await get(`${base}/api/shadow/reset?confirm=reset`, { ...BROWSER, cookie, "sec-fetch-site": "cross-site" })).status, 403, "refused, and not sent to the sign-in page as if signed out");
  const after = (await (await get(`${base}/healthz?as=operator`, { cookie })).json()) as { positions: number };
  assert.equal(after.positions, before.positions);
});

test("record service: an old link with the token in its address signs the browser in once and is sent on without it; scripts are left alone", async () => {
  const old = await get(`${base}/venues?days=30&token=${TOKEN}`, BROWSER);
  assert.equal(old.status, 303);
  assert.equal(old.headers.get("location"), "/venues?days=30", "the same page, without the token");
  assert.equal(old.headers.get("referrer-policy"), "no-referrer");
  const cookie = cookiePair(old);
  assert.match(cookie, /^atticus_op=v1\./);
  assert.equal((await get(`${base}/venues?days=30`, { ...BROWSER, cookie })).status, 200);

  // a shared page keeps the operator's view by asking for it
  const shared = await get(`${base}/scoreboard?token=${TOKEN}`, BROWSER);
  assert.equal(shared.headers.get("location"), "/scoreboard?as=operator");
  // a wrong token signs nothing in: the operator page answers as a wrong token always did
  const wrong = await get(`${base}/venues?token=wrong`, BROWSER);
  assert.equal(wrong.status, 403);
  assert.equal(wrong.headers.get("set-cookie"), null);
  // a public page with a wrong token is the public page
  assert.equal((await get(`${base}/scoreboard?token=wrong`, BROWSER)).status, 200);

  // scripts: curl with the token in the query of a page or a JSON route reads as it did, with no redirect and no cookie
  const curlPage = await get(`${base}/venues?token=${TOKEN}`);
  assert.equal(curlPage.status, 200);
  assert.equal(curlPage.headers.get("set-cookie"), null);
  const curlJson = await get(`${base}/api/shadow/report?token=${TOKEN}`, BROWSER);
  assert.equal(curlJson.status, 200, "a JSON route is never redirected, whoever asks");
  assert.equal(curlJson.headers.get("set-cookie"), null);
  assert.equal((await get(`${base}/healthz?token=${TOKEN}`, BROWSER)).status, 200, "the host's check is never redirected");
});

test("record service: signing out clears the cookie; a sign-out link is not a sign-out", async () => {
  const cookie = cookiePair(await signIn(base, TOKEN, { "x-forwarded-for": "203.0.113.63" }));
  const viaGet = await get(`${base}/operator/sign-out`, { ...BROWSER, cookie });
  assert.equal(viaGet.status, 303);
  assert.equal(viaGet.headers.get("set-cookie"), null, "a GET clears nothing");
  // another site's form posting here signs nobody out
  const elsewhere: Array<Record<string, string>> = [{ cookie }, { cookie, origin: "https://elsewhere.example" }, { cookie, "sec-fetch-site": "cross-site", origin: base }];
  for (const headers of elsewhere) {
    const crossSite = await fetch(`${base}/operator/sign-out`, { method: "POST", redirect: "manual", headers });
    assert.deepEqual([crossSite.status, crossSite.headers.get("set-cookie")], [303, null], JSON.stringify(headers));
  }
  const out = await fetch(`${base}/operator/sign-out`, { method: "POST", redirect: "manual", headers: { cookie, origin: base } });
  assert.equal(out.status, 303);
  assert.equal(out.headers.get("location"), "/operator");
  assert.match(out.headers.get("set-cookie") ?? "", /^atticus_op=; Path=\/; Max-Age=0; HttpOnly; SameSite=Lax$/);
});

test("demo service: the funnel and the partner console open on the sign-in; a signed-in operator showing the demo sees what a visitor sees", async () => {
  // not signed in: the browser goes to the sign-in, a script gets the 403
  const browser = await get(`${demoBase}/admin/funnel`, BROWSER);
  assert.equal(browser.status, 303);
  assert.equal(browser.headers.get("location"), "/operator?next=%2Fadmin%2Ffunnel");
  assert.equal((await get(`${demoBase}/admin/funnel`)).status, 403);
  assert.equal((await get(`${demoBase}/api/admin/funnel`, BROWSER)).status, 403);

  const ok = await signIn(demoBase, TOKEN, { "x-forwarded-for": "203.0.113.70" }, "/admin/funnel");
  assert.equal(ok.headers.get("location"), "/admin/funnel");
  const cookie = cookiePair(ok);
  assert.equal((await signIn(demoBase, "wrong", { "x-forwarded-for": "203.0.113.71" })).headers.get("set-cookie"), null);

  const funnel = await get(`${demoBase}/admin/funnel`, { ...BROWSER, cookie });
  assert.equal(funnel.status, 200);
  const funnelHtml = await funnel.text();
  assert.ok(funnelHtml.includes('href="/api/admin/funnel"') && !/[?&]token=/.test(funnelHtml));
  assert.ok(funnelHtml.includes("no link on this page carries the token"));
  assert.equal((await get(`${demoBase}/api/admin/funnel`, { cookie })).status, 200);

  // the partner page is the visitor's until the operator asks for the console
  const visitor = await (await get(`${demoBase}/partner`, BROWSER)).text();
  const signedInNotAsking = await (await get(`${demoBase}/partner`, { ...BROWSER, cookie })).text();
  const strip = (s: string): string => s.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "");
  assert.equal(strip(signedInNotAsking), strip(visitor), "signed in and not asking: the visitor's page");
  const consoleHtml = await (await get(`${demoBase}/partner?as=operator`, { ...BROWSER, cookie })).text();
  assert.notEqual(strip(consoleHtml), strip(visitor), "asked for: the console");
  assert.equal(strip(await (await get(`${demoBase}/partner?as=operator`, BROWSER)).text()), strip(visitor), "asking without a session is the visitor's page");

  // the track record: the operator's fields only when asked
  type Receipts = { takeKeptCents?: number; routeSplit?: unknown };
  assert.equal(((await (await get(`${demoBase}/api/receipts`, { cookie })).json()) as Receipts).takeKeptCents, undefined);
  assert.notEqual(((await (await get(`${demoBase}/api/receipts?as=operator`, { cookie })).json()) as Receipts).takeKeptCents, undefined);
  assert.equal(((await (await get(`${demoBase}/api/receipts?as=operator`)).json()) as Receipts).takeKeptCents, undefined);

  // the funnel's reset is a POST: the cookie does it from the page, not from another site
  const reset = (headers: Record<string, string>) => fetch(`${demoBase}/api/admin/funnel/reset`, { method: "POST", headers });
  const cross = await reset({ cookie, "sec-fetch-site": "cross-site" });
  assert.equal(cross.status, 403);
  assert.ok(((await cross.json()) as { message: string }).message.startsWith("The sign-in on this browser does not cover an address that changes something when that address is typed, opened from a link elsewhere, or sent from another site. Open it from the box on /operator"));
  assert.equal((await reset({ cookie })).status, 403, "the browser said nothing about where it came from");
  assert.equal((await reset({ cookie, "sec-fetch-site": "same-origin" })).status, 200);
  assert.equal((await reset({ "x-admin-token": TOKEN })).status, 200);

  // an old link is sent on without its token
  const old = await get(`${demoBase}/admin/funnel?token=${TOKEN}`, BROWSER);
  assert.equal(old.status, 303);
  assert.equal(old.headers.get("location"), "/admin/funnel");
  assert.equal((await get(`${demoBase}/partner?token=${TOKEN}`, BROWSER)).headers.get("location"), "/partner?as=operator");
  // a visitor's page with a wrong token in its address is the visitor's page, with no cookie
  const stray = await get(`${demoBase}/partner?token=wrong`, BROWSER);
  assert.equal(stray.status, 200);
  assert.equal(stray.headers.get("set-cookie"), null);
});
