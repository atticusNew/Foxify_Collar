/**
 * EVENT EGRESS PROXY — a small relay for PUBLIC market-data APIs that some
 * consumer ISPs block (observed: clob.polymarket.com and www.okx.com time out
 * from the operator's home network while the same endpoints answer elsewhere).
 *
 * The demo services accept base-URL overrides (PM_CLOB_REST_BASE,
 * OKX_REST_BASE); pointing one at this relay routes the affected venue's calls
 * through the relay host's network:
 *
 *   client sends  https://<proxy>/t/<token>/book?token_id=...
 *   proxy strips  /t/<token>, forwards to <UPSTREAM>/book?token_id=...
 *
 * SECURITY MODEL: GET/HEAD only and an explicit path-prefix allowlist — this
 * relay fronts public read-only data and is structurally unable to trade. No
 * request headers are forwarded, no credentials exist anywhere in the path.
 * The URL token (timing-safe compare) only stops strangers from using the
 * relay at all. Secrets are never logged (method + path + status only).
 *
 * Env: UPSTREAM (e.g. https://clob.polymarket.com) · PROXY_TOKEN (required)
 *      ALLOWED_PREFIXES (comma-separated, default "/book") · PORT
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

const UPSTREAM = (process.env.UPSTREAM ?? "").replace(/\/$/, "");
const PORT = Number(process.env.PORT ?? 8898);
const TOKEN = process.env.PROXY_TOKEN ?? "";
const ALLOWED_PREFIXES = (process.env.ALLOWED_PREFIXES ?? "/book")
  .split(",")
  .map((p) => p.trim())
  .filter((p) => p.startsWith("/"));

export const tokenMatches = (candidate: string, token: string): boolean => {
  if (!token || candidate.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
};

/** Parse "/t/<token>/<rest>" → { token, upstreamPath } (query string kept). Pure. */
export const parseRelayPath = (url: string): { token: string; upstreamPath: string } | null => {
  const m = /^\/t\/([^/]+)(\/.+)$/.exec(url);
  return m ? { token: m[1], upstreamPath: m[2] } : null;
};

/** The forwarded path (ignoring the query string) must start with an allowed prefix. Pure. */
export const prefixAllowed = (upstreamPath: string, prefixes: string[]): boolean => {
  const pathOnly = upstreamPath.split("?")[0];
  return prefixes.some((p) => pathOnly === p || pathOnly.startsWith(`${p}/`));
};

const send = (res: ServerResponse, status: number, body: string, contentType = "application/json"): void => {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
};

export const startProxy = (port = PORT): ReturnType<typeof createServer> => {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    if (url === "/healthz") return send(res, 200, JSON.stringify({ ok: true, upstream: UPSTREAM }));
    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(res, 405, JSON.stringify({ ok: false, error: "read_only_relay" }));
    }

    const parsed = parseRelayPath(url);
    if (!parsed) return send(res, 404, JSON.stringify({ ok: false, error: "not_found" }));
    if (!tokenMatches(parsed.token, TOKEN)) return send(res, 403, JSON.stringify({ ok: false, error: "bad_token" }));
    if (!prefixAllowed(parsed.upstreamPath, ALLOWED_PREFIXES)) {
      return send(res, 403, JSON.stringify({ ok: false, error: "path_not_allowed" }));
    }

    try {
      const upstream = await fetch(UPSTREAM + parsed.upstreamPath, {
        method: req.method,
        signal: AbortSignal.timeout(Number(process.env.PROXY_TIMEOUT_MS ?? "15000")),
      });
      const text = await upstream.text();
      console.error(`[event-proxy] ${req.method} ${parsed.upstreamPath.split("?")[0]} → ${upstream.status}`);
      return send(res, upstream.status, text, upstream.headers.get("content-type") ?? "application/json");
    } catch (e) {
      console.error(`[event-proxy] ${req.method} ${parsed.upstreamPath.split("?")[0]} → upstream error: ${(e as Error).message}`);
      return send(res, 502, JSON.stringify({ ok: false, error: "upstream_error", message: (e as Error).message }));
    }
  });
  server.listen(port, () => {
    console.error(
      `[event-proxy] listening on :${port} → ${UPSTREAM || "MISSING UPSTREAM"} · prefixes ${ALLOWED_PREFIXES.join(",")} · token ${TOKEN ? "SET" : "MISSING (all requests will 403)"}`,
    );
  });
  return server;
};

// Started directly (not imported by a test) ⟹ run.
if (process.argv[1] && /scripts[/\\]eventEgressProxy\.ts$/.test(process.argv[1])) {
  if (!TOKEN || !UPSTREAM) {
    console.error("[event-proxy] PROXY_TOKEN and UPSTREAM are required — refusing to start an open or aimless relay");
    process.exit(1);
  }
  startProxy();
}
