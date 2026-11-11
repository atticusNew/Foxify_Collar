/**
 * THE OPERATOR'S SIGN-IN: the operator token out of addresses.
 *
 * The operator views were opened with the token in the address (`/report?token=...`). An
 * address is kept: in the browser's history, in bookmarks, in a proxy's log, in a screenshot,
 * and it was carried on every link the page drew. This file replaces that with a sign-in.
 *
 *   GET  /operator            the sign-in page: one field, the token, sent in the body of a POST
 *   POST /operator            a right token sets the session cookie and goes on to `next`
 *   POST /operator/sign-out   clears it
 *
 * THE COOKIE. HttpOnly (no script reads it), Secure off localhost, SameSite=Lax, Path=/. Its
 * value is `v1.<expiry>.<mac>`: the expiry in milliseconds and an HMAC of it under a key
 * derived from the operator token. Nothing is stored on the service, so a restart signs nobody
 * out; replacing the token signs everybody out at once, which is what replacing it is for.
 * The token itself is never in the cookie and cannot be worked back from it.
 *
 * WHERE THE COOKIE COUNTS. On the operator's own routes, always. On a route the public also
 * reads (the status page, the scoreboard, a slate, the demo's quotes), only when the address
 * asks with `as=operator`. A signed-in operator who opens the public record, or shows the demo
 * to a prospect, therefore sees exactly what the public sees: being signed in never changes a
 * public page by itself.
 *
 * WHAT THE COOKIE CANNOT DO FROM ANOTHER SITE. A request that can change something (anything
 * that is not a GET or HEAD, and any address carrying `confirm`, which is how the service's few
 * writing GETs are spelled) is the operator's by cookie only when the browser says it came from
 * this service's own pages (Sec-Fetch-Site: same-origin, or an Origin that is this host). A
 * link or a form on another site cannot use the session to write, and neither can an address
 * typed into the address bar or followed from a message (the browser reports those as coming
 * from nowhere, and a link in an email is exactly the case to refuse). The signed-in page has a
 * box that opens an address from the page itself, which is how the operator runs one of the
 * writing GETs from a browser. A token in a header is not subject to any of this: it is not sent
 * by a browser on its own.
 *
 * AN OLD LINK STILL WORKS, ONCE. A page opened with `?token=` in a browser signs the browser in
 * and is sent on to the same address without the token, so the token does not stay in the
 * address bar and no link on the page carries it. Scripts keep working: a token in the
 * `x-admin-token` or `Authorization: Bearer` header, or in the query of a JSON route, is read
 * as before. EVENT_X_ADMIN_QUERY_TOKEN=off stops the query form everywhere, pages included,
 * once nothing of the operator's uses it.
 *
 * EVENT_X_ADMIN_SESSION_HOURS is how long a sign-in lasts: 12 by default, 1 to 720.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

export const OPERATOR_COOKIE = "atticus_op";
export const OPERATOR_SIGN_IN_PATH = "/operator";
export const OPERATOR_SIGN_OUT_PATH = "/operator/sign-out";
export const SESSION_HOURS_ENV = "EVENT_X_ADMIN_SESSION_HOURS";
export const QUERY_TOKEN_ENV = "EVENT_X_ADMIN_QUERY_TOKEN";
const DEFAULT_SESSION_HOURS = 12;

/** The operator settings both event services read (eventFunnel.parseAdminAuthFromEnv). */
export interface OperatorAuth {
  enabled: boolean;
  token: string | null;
}

export interface OperatorSessionConfig {
  ttlMs: number;
  /** whether a token in the query string is read at all */
  queryToken: boolean;
  notes: string[];
}

export function operatorSessionConfigFromEnv(env: Record<string, string | undefined> = process.env): OperatorSessionConfig {
  const notes: string[] = [];
  let hours = DEFAULT_SESSION_HOURS;
  const rawHours = (env[SESSION_HOURS_ENV] ?? "").trim();
  if (rawHours) {
    const n = Number(rawHours);
    if (Number.isFinite(n) && n >= 1 && n <= 720) hours = n;
    else notes.push(`${SESSION_HOURS_ENV} has to be a number of hours from 1 to 720; using ${DEFAULT_SESSION_HOURS}`);
  }
  const rawQuery = (env[QUERY_TOKEN_ENV] ?? "").trim().toLowerCase();
  let queryToken = true;
  if (rawQuery === "off" || rawQuery === "0" || rawQuery === "no" || rawQuery === "false") queryToken = false;
  else if (rawQuery && !(rawQuery === "on" || rawQuery === "1" || rawQuery === "yes" || rawQuery === "true")) {
    // not guessed at: the safe side is the one that keeps the token out of addresses
    queryToken = false;
    notes.push(`${QUERY_TOKEN_ENV} is read as on or off; this value is neither, so it is read as off`);
  }
  return { ttlMs: Math.round(hours * 3_600_000), queryToken, notes };
}

/** Equal or not, in time that does not depend on where the two differ or on their lengths. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

const macKey = (token: string): Buffer => createHash("sha256").update(`atticus-operator-session-v1:${token}`, "utf8").digest();
const macOf = (token: string, body: string): string => createHmac("sha256", macKey(token)).update(body, "utf8").digest("base64url");

export function mintOperatorCookie(token: string, nowMs: number, ttlMs: number): string {
  const body = `v1.${Math.floor(nowMs + ttlMs)}`;
  return `${body}.${macOf(token, body)}`;
}

export function operatorCookieValid(token: string | null, value: string | null, nowMs: number): boolean {
  if (!token || !value) return false;
  const m = /^(v1\.(\d{10,16}))\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return false;
  if (!safeEqual(macOf(token, m[1]), m[3])) return false;
  return Number(m[2]) > nowMs;
}

export function cookieFromHeader(header: string | string[] | undefined, name: string): string | null {
  const raw = Array.isArray(header) ? header.join(";") : (header ?? "");
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

const hostOf = (headers: IncomingHttpHeaders): string => String(headers.host ?? "").trim().toLowerCase();
const isLocalHost = (host: string): boolean => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);

/** Did the browser say this request came from this service's own pages? Absent both signals, no. */
export function sameOriginRequest(headers: IncomingHttpHeaders): boolean {
  const site = String(headers["sec-fetch-site"] ?? "").trim().toLowerCase();
  if (site) return site === "same-origin";
  const origin = String(headers.origin ?? "").trim();
  if (!origin) return false;
  try {
    return new URL(origin).host.toLowerCase() === hostOf(headers) && hostOf(headers) !== "";
  } catch {
    return false;
  }
}

/** A request that can change something: not a read by its method, or one of the writing GETs, which all carry `confirm`. */
export function canChangeState(method: string, url: URL): boolean {
  const m = method.toUpperCase();
  return !(m === "GET" || m === "HEAD") || url.searchParams.has("confirm");
}

export interface OperatorCheck {
  operator: boolean;
  via: "header" | "query" | "cookie" | "open" | null;
  /** a sound session cookie was sent and did not count, and why */
  cookieIgnored?: "not_asked" | "cross_site";
}

export function operatorCheck(args: { auth: OperatorAuth; cfg: OperatorSessionConfig; headers: IncomingHttpHeaders; method: string; url: URL; operatorOnlyPath: boolean; nowMs: number }): OperatorCheck {
  const { auth, cfg, headers, url } = args;
  if (!auth.enabled) return { operator: false, via: null };
  if (auth.token === null) return { operator: true, via: "open" };
  const bearer = String(headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  const headerToken = String(headers["x-admin-token"] ?? "").trim();
  if ((bearer && safeEqual(bearer, auth.token)) || (headerToken && safeEqual(headerToken, auth.token))) return { operator: true, via: "header" };
  const queryToken = url.searchParams.get("token") ?? "";
  if (cfg.queryToken && queryToken && safeEqual(queryToken, auth.token)) return { operator: true, via: "query" };
  if (!operatorCookieValid(auth.token, cookieFromHeader(headers.cookie, OPERATOR_COOKIE), args.nowMs)) return { operator: false, via: null };
  if (!args.operatorOnlyPath && url.searchParams.get("as") !== "operator") return { operator: false, via: null, cookieIgnored: "not_asked" };
  if (canChangeState(args.method, url) && !sameOriginRequest(headers)) return { operator: false, via: null, cookieIgnored: "cross_site" };
  return { operator: true, via: "cookie" };
}

export function operatorCookieHeader(value: string, maxAgeS: number, headers: IncomingHttpHeaders): string {
  const secure = isLocalHost(hostOf(headers)) && String(headers["x-forwarded-proto"] ?? "").toLowerCase() !== "https" ? "" : "; Secure";
  return `${OPERATOR_COOKIE}=${value}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeS))}; HttpOnly; SameSite=Lax${secure}`;
}

/** Does the caller want a page (a browser), rather than JSON or a file (a script)? */
export function wantsHtml(headers: IncomingHttpHeaders): boolean {
  return /\btext\/html\b/i.test(String(headers.accept ?? ""));
}

/** A path on this service and nowhere else: `next` after sign-in is never another site. */
export function safeNext(next: string | null | undefined): string {
  const n = (next ?? "").trim();
  if (!n.startsWith("/") || n.startsWith("//") || n.includes("\\") || /[\r\n]/.test(n) || n.length > 600) return OPERATOR_SIGN_IN_PATH;
  try {
    const u = new URL(n, "https://self.invalid");
    if (u.host !== "self.invalid") return OPERATOR_SIGN_IN_PATH;
    u.searchParams.delete("token");
    return `${u.pathname}${u.search}`;
  } catch {
    return OPERATOR_SIGN_IN_PATH;
  }
}

/** The same address without the token; a route the public also reads keeps the operator's view by asking for it. */
export function addressWithoutToken(url: URL, operatorOnlyPath: boolean): string {
  const u = new URL(url.toString());
  u.searchParams.delete("token");
  if (!operatorOnlyPath) u.searchParams.set("as", "operator");
  return `${u.pathname}${u.search}`;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface SignInPageInput {
  /** the service's name as the operator knows it */
  service: string;
  state: "form" | "signed_in" | "disabled" | "open";
  /** the last attempt was refused, or there were too many */
  problem?: "bad_token" | "too_many" | null;
  next: string;
  /** the operator views to offer once signed in */
  links: ReadonlyArray<{ href: string; label: string }>;
  hours: number;
}

export function renderOperatorSignInHtml(input: SignInPageInput): string {
  const problem =
    input.problem === "bad_token"
      ? `<p class="bad" role="alert">That token was not accepted. Nothing was signed in.</p>`
      : input.problem === "too_many"
        ? `<p class="bad" role="alert">Too many attempts. Wait a minute and try again.</p>`
        : "";
  const links = input.links.map((l) => `<li><a href="${esc(l.href)}">${esc(l.label)}</a></li>`).join("");
  const body =
    input.state === "disabled"
      ? `<p>Operator views are off on this service: no operator token is set (EVENT_X_ADMIN_TOKEN).</p>`
      : input.state === "open"
        ? `<p>This service runs with operator views open and no token (a development setting). There is nothing to sign in to.</p><ul>${links}</ul>`
        : input.state === "signed_in"
          ? `<p>Signed in on this browser. The sign-in lasts ${input.hours} hour${input.hours === 1 ? "" : "s"} and ends when the operator token is replaced.</p>
<ul>${links}</ul>
<form id="go" class="go" autocomplete="off">
<label for="addr">Open an operator address on this service</label>
<input id="addr" name="addr" type="text" spellcheck="false" placeholder="/api/shadow/holders" required />
<button type="submit" class="quiet">Open</button>
</form>
<p class="fine">An address that changes something (one with <code>confirm=</code>) is the operator's only when it is opened from this page or from a page of this service. Typed into the address bar, or followed from a message, it is refused: that is what stops a link someone sends you from acting as you.</p>
<form method="post" action="${OPERATOR_SIGN_OUT_PATH}"><button type="submit" class="quiet">Sign out</button></form>
<script>
document.getElementById('go').addEventListener('submit',function(e){
  e.preventDefault();
  var v=document.getElementById('addr').value.trim();
  if(v.charAt(0)!=='/'||v.charAt(1)==='/'||v.indexOf('\\\\')>=0)return;
  location.assign(v);
});
</script>`
          : `${problem}<form method="post" action="${OPERATOR_SIGN_IN_PATH}" autocomplete="off">
<input type="hidden" name="next" value="${esc(input.next)}" />
<label for="token">Operator token</label>
<input id="token" name="token" type="password" autocomplete="current-password" autofocus required />
<button type="submit">Sign in</button>
</form>
<p class="fine">The token is sent in the body of this form, never in an address. Signing in sets a cookie on this browser for ${input.hours} hour${input.hours === 1 ? "" : "s"}; no script can read it. Scripts send the token in the <code>x-admin-token</code> header instead.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<meta name="referrer" content="no-referrer" />
<link rel="icon" href="data:," />
<title>Operator sign-in · ${esc(input.service)}</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#0b0d10;color:#e7e9ee;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:420px;margin:12vh auto 0;padding:0 20px}
h1{font-size:19px;margin:0 0 4px;font-weight:650}
.svc{color:#8b93a1;font-size:13px;margin:0 0 22px}
label{display:block;font-size:13px;color:#aab1bd;margin:0 0 6px}
input[type=password],input[type=text]{width:100%;box-sizing:border-box;height:42px;padding:0 12px;border-radius:8px;border:1px solid #2a303a;background:#12161c;color:inherit;font:inherit}
input[type=password]:focus,input[type=text]:focus{outline:2px solid #c9a24a;outline-offset:1px}
form.go{margin:22px 0 0;padding-top:18px;border-top:1px solid #1f242c}
button{margin-top:14px;height:42px;padding:0 18px;border-radius:8px;border:0;background:#c9a24a;color:#14110a;font:inherit;font-weight:650;cursor:pointer}
button.quiet{background:#1b2028;color:#e7e9ee;border:1px solid #2a303a}
.bad{color:#ffb4b4;border:1px solid rgba(255,107,107,.5);border-radius:8px;padding:9px 12px;margin:0 0 16px}
.fine{color:#8b93a1;font-size:12.5px;margin-top:18px}
ul{padding-left:18px}li{margin:4px 0}a{color:#e2c275}
code{font-size:12px;background:#12161c;padding:1px 5px;border-radius:4px}
</style>
</head>
<body>
<main>
<h1>Operator sign-in</h1>
<p class="svc">${esc(input.service)}</p>
${body}
</main>
</body>
</html>`;
}

async function readFormBody(req: IncomingMessage, maxBytes = 4096): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += b.length;
    if (size > maxBytes) return new URLSearchParams();
    chunks.push(b);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export interface SignInDeps {
  auth: OperatorAuth;
  cfg: OperatorSessionConfig;
  service: string;
  links: ReadonlyArray<{ href: string; label: string }>;
  /** false when this caller has made too many attempts lately */
  allowAttempt: (key: string, nowMs: number) => boolean;
  /** which paths are the operator's alone (the cookie counts there without `as=operator`) */
  operatorOnlyPath: (pathname: string) => boolean;
  nowMs?: () => number;
}

const PAGE_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer", "x-frame-options": "DENY" };

/**
 * The sign-in routes, and the old link's one redirect. Returns true when the request was
 * answered here. Call it before the service's own routing.
 */
export async function handleOperatorSignIn(req: IncomingMessage, res: ServerResponse, url: URL, deps: SignInDeps): Promise<boolean> {
  const now = (deps.nowMs ?? Date.now)();
  const method = (req.method ?? "GET").toUpperCase();
  const hours = Math.round((deps.cfg.ttlMs / 3_600_000) * 10) / 10;
  const page = (status: number, input: Omit<SignInPageInput, "service" | "links" | "hours">, extra: Record<string, string> = {}): true => {
    res.writeHead(status, { ...PAGE_HEADERS, ...extra });
    res.end(method === "HEAD" ? undefined : renderOperatorSignInHtml({ service: deps.service, links: deps.links, hours, ...input }));
    return true;
  };
  const go = (location: string, extra: Record<string, string> = {}): true => {
    res.writeHead(303, { location, "cache-control": "no-store", "referrer-policy": "no-referrer", ...extra });
    res.end();
    return true;
  };

  if (url.pathname === OPERATOR_SIGN_OUT_PATH) {
    if (method !== "POST") return go(OPERATOR_SIGN_IN_PATH);
    return go(OPERATOR_SIGN_IN_PATH, { "set-cookie": operatorCookieHeader("", 0, req.headers) });
  }

  if (url.pathname === OPERATOR_SIGN_IN_PATH) {
    if (!deps.auth.enabled) return page(404, { state: "disabled", next: OPERATOR_SIGN_IN_PATH });
    if (deps.auth.token === null) return page(200, { state: "open", next: OPERATOR_SIGN_IN_PATH });
    const signedIn = operatorCookieValid(deps.auth.token, cookieFromHeader(req.headers.cookie, OPERATOR_COOKIE), now);
    if (method === "GET" || method === "HEAD") {
      const problem = url.searchParams.get("problem");
      return page(200, { state: signedIn ? "signed_in" : "form", problem: problem === "bad_token" || problem === "too_many" ? problem : null, next: safeNext(url.searchParams.get("next")) });
    }
    if (method !== "POST") {
      res.writeHead(405, { allow: "GET, POST", "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
      return true;
    }
    const who = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
    const form = await readFormBody(req);
    const next = safeNext(form.get("next"));
    const back = (problem: "bad_token" | "too_many"): true => go(`${OPERATOR_SIGN_IN_PATH}?problem=${problem}${next !== OPERATOR_SIGN_IN_PATH ? `&next=${encodeURIComponent(next)}` : ""}`);
    if (!deps.allowAttempt(who, now)) return back("too_many");
    const sent = (form.get("token") ?? "").trim();
    if (!sent || !safeEqual(sent, deps.auth.token)) return back("bad_token");
    return go(next, { "set-cookie": operatorCookieHeader(mintOperatorCookie(deps.auth.token, now, deps.cfg.ttlMs), deps.cfg.ttlMs / 1000, req.headers) });
  }

  // AN OLD LINK: a page opened in a browser with a right token in its address signs the browser in
  // and goes on to the same address without it. JSON routes and scripts are left as they were.
  if (method === "GET" && deps.auth.token !== null && deps.cfg.queryToken && wantsHtml(req.headers) && isPagePath(url.pathname)) {
    const sent = url.searchParams.get("token") ?? "";
    if (sent && safeEqual(sent, deps.auth.token)) {
      return go(addressWithoutToken(url, deps.operatorOnlyPath(url.pathname)), { "set-cookie": operatorCookieHeader(mintOperatorCookie(deps.auth.token, now, deps.cfg.ttlMs), deps.cfg.ttlMs / 1000, req.headers) });
    }
  }
  return false;
}

/** A page a person opens, as against a JSON route, a file or the host's health check. */
export function isPagePath(pathname: string): boolean {
  return !pathname.startsWith("/api/") && pathname !== "/healthz" && !/\.(csv|json|jsonl|txt|png|svg|ico|js|css|webmanifest)$/i.test(pathname);
}

/** Where a browser that asked for an operator page without a session is sent: the sign-in, then back. */
export function signInLocation(url: URL): string {
  return `${OPERATOR_SIGN_IN_PATH}?next=${encodeURIComponent(safeNext(`${url.pathname}${url.search}`))}`;
}
