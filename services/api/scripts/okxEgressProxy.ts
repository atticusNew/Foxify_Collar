/**
 * OKX EGRESS PROXY — a fixed-IP relay for OKX API calls when the caller's IP is not on the API
 * key's whitelist (OKX error 50110) and the whitelist cannot be edited (2FA unavailable).
 *
 * Deployed on Render (same region as the live canary services ⟹ same shared outbound IPs, which
 * are the ones already whitelisted on the key). The demo service on the operator's machine points
 * OKX_REST_BASE at this proxy; every OKX call — signed trade/account calls and public book reads —
 * then egresses from the whitelisted IP. NOTHING about the requests is altered:
 *
 *   client signs  /api/v5/trade/order                        (path OKX verifies — unchanged)
 *   client sends  https://<proxy>/t/<token>/api/v5/trade/order
 *   proxy strips  /t/<token>, forwards to https://www.okx.com/api/v5/trade/order
 *
 * SECURITY MODEL: the proxy holds NO OKX credentials — signing stays on the operator's machine;
 * a request without a valid OK-ACCESS-SIGN is rejected by OKX itself. The URL token only prevents
 * strangers from using the relay (and its IP reputation) at all. Timing-safe compare; secrets are
 * never logged (method + path + status only).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

const UPSTREAM = process.env.OKX_UPSTREAM ?? "https://www.okx.com";
const PORT = Number(process.env.PORT ?? 8899);
const TOKEN = process.env.PROXY_TOKEN ?? "";

/** Request headers forwarded upstream — OKX auth + content negotiation, nothing else. */
const FORWARD_HEADERS = [
  "content-type",
  "ok-access-key",
  "ok-access-sign",
  "ok-access-timestamp",
  "ok-access-passphrase",
  "x-simulated-trading"
] as const;

export const tokenMatches = (candidate: string, token: string): boolean => {
  if (!token || candidate.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
};

/**
 * Parse "/t/<token>/api/v5/..." → { token, upstreamPath } (upstreamPath keeps the query string).
 * Anything not shaped like that — or not targeting /api/v5/ — is refused. Pure.
 */
export const parseProxyPath = (url: string): { token: string; upstreamPath: string } | null => {
  const m = /^\/t\/([^/]+)(\/api\/v5\/.*)$/.exec(url);
  return m ? { token: m[1], upstreamPath: m[2] } : null;
};

export const filterHeaders = (raw: Record<string, string | string[] | undefined>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const h of FORWARD_HEADERS) {
    const v = raw[h];
    if (typeof v === "string") out[h] = v;
  }
  return out;
};

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const send = (res: ServerResponse, status: number, body: string, contentType = "application/json"): void => {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
};

export const startProxy = (port = PORT): ReturnType<typeof createServer> => {
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    if (url === "/healthz") return send(res, 200, JSON.stringify({ ok: true, upstream: UPSTREAM }));

    const parsed = parseProxyPath(url);
    if (!parsed) return send(res, 404, JSON.stringify({ ok: false, error: "not_found" }));
    if (!tokenMatches(parsed.token, TOKEN)) return send(res, 403, JSON.stringify({ ok: false, error: "bad_token" }));

    const body = await readBody(req);
    try {
      const upstream = await fetch(UPSTREAM + parsed.upstreamPath, {
        method: req.method ?? "GET",
        headers: filterHeaders(req.headers),
        body: body.length > 0 ? body : undefined,
        signal: AbortSignal.timeout(Number(process.env.PROXY_TIMEOUT_MS ?? "15000"))
      });
      const text = await upstream.text();
      console.error(`[okx-proxy] ${req.method} ${parsed.upstreamPath.split("?")[0]} → ${upstream.status}`);
      return send(res, upstream.status, text, upstream.headers.get("content-type") ?? "application/json");
    } catch (e) {
      console.error(`[okx-proxy] ${req.method} ${parsed.upstreamPath.split("?")[0]} → upstream error: ${(e as Error).message}`);
      return send(res, 502, JSON.stringify({ ok: false, error: "upstream_error", message: (e as Error).message }));
    }
  });
  server.listen(port, () => {
    console.error(`[okx-proxy] listening on :${port} → ${UPSTREAM} · token ${TOKEN ? "SET" : "MISSING (all requests will 403)"}`);
  });
  return server;
};

// Started directly (not imported by a test) ⟹ run.
if (process.argv[1] && /scripts[/\\]okxEgressProxy\.ts$/.test(process.argv[1])) {
  if (!TOKEN) {
    console.error("[okx-proxy] PROXY_TOKEN is required — refusing to start an open relay");
    process.exit(1);
  }
  startProxy();
}
