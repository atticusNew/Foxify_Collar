/**
 * /onchain on the event site: the on-chain demo, passed through from the service that makes it.
 *
 * The demo lives on the on-chain venues service (its own Render service, its own lane) at
 * /demo. This site serves it at /onchain so a reader has one address. Two paths only, each to
 * one fixed path on one fixed host:
 *
 *   /onchain                 →  <origin>/demo
 *   /onchain/api/positions   →  <origin>/demo/api/positions
 *
 * Nothing of the request goes on: no query, no header, no body, so no key of this service can
 * reach that one, and nothing but GET and HEAD is answered. The last good copy is kept (the page
 * for a minute, the figures for ten seconds) and is served if the other service is slow or
 * down, so a restart there does not blank this page.
 *
 * ISOLATION: this file imports nothing from src/onchainVenues. The two lanes meet over HTTP.
 *
 * Env:  ONCHAIN_DEMO_ORIGIN   (default https://atticus-onchain-venues.onrender.com) the on-chain
 *                             service's address; "off" takes /onchain away (404)
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export const ONCHAIN_DEMO_ORIGIN_DEFAULT = "https://atticus-onchain-venues.onrender.com";

interface Route {
  upstream: string;
  type: string;
  /** how long a copy is served without asking again */
  freshMs: number;
}

const ROUTES: Record<string, Route> = {
  "/onchain": { upstream: "/demo", type: "text/html; charset=utf-8", freshMs: 60_000 },
  "/onchain/api/positions": { upstream: "/demo/api/positions", type: "application/json; charset=utf-8", freshMs: 10_000 },
};

/** a copy older than this is not served even when the other service is down */
const STALE_MAX_MS = 10 * 60_000;
/** the page is about 20 KB and the figures well under 1 MB; anything larger is not what was asked for */
const BODY_MAX_BYTES = 2_000_000;

/** The address to pass through to: https, or http on this machine; anything else, and "off", is null. */
export function onchainDemoOrigin(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  if (/^(off|0|false|no)$/i.test(v)) return null;
  if (!v) return ONCHAIN_DEMO_ORIGIN_DEFAULT;
  try {
    const u = new URL(v);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    if (u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

export interface OnchainProxyOptions {
  /** null: /onchain is off */
  origin: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export interface OnchainProxy {
  /** True when the path is one of the two and was answered. */
  handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean>;
}

const UNAVAILABLE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="20"><title>On-chain demo</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#9aa3b2;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;text-align:center;padding:24px}b{display:block;color:#f3f5f8;font-size:17px;margin-bottom:6px}</style></head><body><div><b>The on-chain demo is starting.</b>This page tries again in 20 seconds.</div></body></html>`;

export function createOnchainProxy(opts: OnchainProxyOptions): OnchainProxy {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const now = opts.now ?? (() => Date.now());
  const kept = new Map<string, { at: number; body: string }>();
  const inFlight = new Map<string, Promise<string | null>>();

  const read = (route: Route): Promise<string | null> => {
    const running = inFlight.get(route.upstream);
    if (running) return running;
    const run = (async (): Promise<string | null> => {
      try {
        const r = await fetchImpl(`${opts.origin}${route.upstream}`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
        if (!r.ok) return null;
        const body = await r.text();
        if (!body || Buffer.byteLength(body) > BODY_MAX_BYTES) return null;
        kept.set(route.upstream, { at: now(), body });
        return body;
      } catch {
        return null;
      } finally {
        inFlight.delete(route.upstream);
      }
    })();
    inFlight.set(route.upstream, run);
    return run;
  };

  return {
    async handle(req, res, pathname) {
      const route = ROUTES[pathname.replace(/\/+$/, "") || "/"];
      if (!route || !opts.origin) return false;
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD" });
        res.end();
        return true;
      }
      const have = kept.get(route.upstream);
      const fresh = have && now() - have.at < route.freshMs;
      const body = fresh ? have.body : ((await read(route)) ?? (have && now() - have.at < STALE_MAX_MS ? have.body : null));
      const headers = { "cache-control": "no-store", "x-robots-tag": "noindex", "x-content-type-options": "nosniff" };
      if (body === null) {
        const html = route.type.startsWith("text/html");
        res.writeHead(503, { ...headers, "content-type": html ? route.type : "application/json; charset=utf-8", "retry-after": "20" });
        res.end(req.method === "HEAD" ? undefined : html ? UNAVAILABLE_HTML : JSON.stringify({ ok: false, reason: "the on-chain demo is not answering" }));
        return true;
      }
      res.writeHead(200, { ...headers, "content-type": route.type, "content-length": Buffer.byteLength(body) });
      res.end(req.method === "HEAD" ? undefined : body);
      return true;
    },
  };
}
