/**
 * /onchain on the event site: two fixed paths passed through to the on-chain service's demo,
 * nothing of the request sent on, the last good copy kept for when that service is down.
 *
 * Nothing here reaches the network: the other service is stood in for.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ONCHAIN_DEMO_ORIGIN_DEFAULT, createOnchainProxy, onchainDemoOrigin } from "../scripts/eventProtectXOnchainProxy";

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Answer {
  handled: boolean;
  status: number;
  headers: Record<string, string | number>;
  body: string | undefined;
}

async function ask(proxy: ReturnType<typeof createOnchainProxy>, path: string, method = "GET"): Promise<Answer> {
  const out: Answer = { handled: false, status: 0, headers: {}, body: undefined };
  const res = {
    writeHead: (status: number, headers: Record<string, string | number>) => {
      out.status = status;
      out.headers = headers;
    },
    end: (body?: string) => {
      out.body = body;
    },
  } as unknown as ServerResponse;
  out.handled = await proxy.handle({ method } as IncomingMessage, res, path);
  return out;
}

function standIn(): { fetchImpl: typeof fetch; calls: { url: string; init: RequestInit | undefined }[]; state: { up: boolean; n: number } } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const state = { up: true, n: 0 };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    state.n += 1;
    if (!state.up) throw new Error("connect ECONNREFUSED");
    const path = new URL(String(input)).pathname;
    if (path === "/demo") return new Response(`<html>demo page ${state.n}</html>`, { status: 200 });
    if (path === "/demo/api/positions") return new Response(JSON.stringify({ at: "t", n: state.n }), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls, state };
}

test("event /onchain: the page and its figures come from the on-chain service's demo, and nothing else is passed through", async () => {
  const { fetchImpl, calls } = standIn();
  const proxy = createOnchainProxy({ origin: "https://onchain.example", fetchImpl });

  const page = await ask(proxy, "/onchain");
  assert.equal(page.status, 200);
  assert.match(String(page.headers["content-type"]), /text\/html/);
  assert.equal(page.body, "<html>demo page 1</html>");
  assert.equal(calls[0].url, "https://onchain.example/demo");
  assert.equal((await ask(proxy, "/onchain/")).status, 200);

  const figures = await ask(proxy, "/onchain/api/positions");
  assert.match(String(figures.headers["content-type"]), /application\/json/);
  assert.equal(JSON.parse(figures.body!).at, "t");
  assert.equal(calls.at(-1)!.url, "https://onchain.example/demo/api/positions");

  // only GET goes out, with no header and no body of the caller's, and a redirect is not followed
  for (const c of calls) {
    assert.equal(c.init?.method, "GET");
    assert.equal(c.init?.redirect, "error");
    assert.equal(c.init?.headers, undefined);
    assert.equal(c.init?.body, undefined);
  }
  // the keyed pages of the other service cannot be reached through here, whatever is asked
  for (const path of ["/onchain/api/board", "/onchain/api/diagnostics", "/onchain/healthz", "/onchain/..", "/onchain/demo", "/onchainx", "/demo", "/"]) {
    assert.equal((await ask(proxy, path)).handled, false, path);
  }
  assert.ok(calls.every((c) => /\/demo(\/api\/positions)?$/.test(c.url)));

  const post = await ask(proxy, "/onchain/api/positions", "POST");
  assert.equal(post.status, 405);
  const head = await ask(proxy, "/onchain", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body, undefined);
});

test("event /onchain: a copy is kept, asked for again when it ages, and served when the other service is down", async () => {
  const { fetchImpl, calls, state } = standIn();
  let clock = 1_000_000;
  const proxy = createOnchainProxy({ origin: "https://onchain.example", fetchImpl, now: () => clock });

  assert.equal((await ask(proxy, "/onchain/api/positions")).body, JSON.stringify({ at: "t", n: 1 }));
  clock += 9_000;
  assert.equal((await ask(proxy, "/onchain/api/positions")).body, JSON.stringify({ at: "t", n: 1 }), "inside ten seconds the kept copy answers");
  assert.equal(calls.length, 1);
  clock += 2_000;
  assert.equal((await ask(proxy, "/onchain/api/positions")).body, JSON.stringify({ at: "t", n: 2 }));

  state.up = false;
  clock += 60_000;
  const stale = await ask(proxy, "/onchain/api/positions");
  assert.equal(stale.status, 200);
  assert.equal(stale.body, JSON.stringify({ at: "t", n: 2 }), "the last good copy, while the other service is down");
  clock += 11 * 60_000;
  const gone = await ask(proxy, "/onchain/api/positions");
  assert.equal(gone.status, 503);
  assert.equal(JSON.parse(gone.body!).ok, false);

  // never read at all: the page says it is starting and tries again by itself
  const cold = createOnchainProxy({ origin: "https://onchain.example", fetchImpl, now: () => clock });
  const page = await ask(cold, "/onchain");
  assert.equal(page.status, 503);
  assert.match(page.body!, /The on-chain demo is starting/);
  assert.match(page.body!, /http-equiv="refresh"/);
  state.up = true;
  assert.equal((await ask(cold, "/onchain")).status, 200);

  // two readers at once make one request
  const both = createOnchainProxy({ origin: "https://onchain.example", fetchImpl, now: () => clock });
  const before = calls.length;
  await Promise.all([ask(both, "/onchain"), ask(both, "/onchain")]);
  assert.equal(calls.length, before + 1);
});

test("event /onchain: the address it goes to is the on-chain service unless said otherwise, and only an https address is taken", async () => {
  assert.equal(onchainDemoOrigin(undefined), ONCHAIN_DEMO_ORIGIN_DEFAULT);
  assert.equal(onchainDemoOrigin(""), ONCHAIN_DEMO_ORIGIN_DEFAULT);
  assert.equal(onchainDemoOrigin("https://other.example/some/path?x=1"), "https://other.example");
  assert.equal(onchainDemoOrigin("http://localhost:8880"), "http://localhost:8880");
  assert.equal(onchainDemoOrigin("http://other.example"), null, "not in the clear");
  assert.equal(onchainDemoOrigin("https://user:pass@other.example"), null);
  assert.equal(onchainDemoOrigin("file:///etc/passwd"), null);
  assert.equal(onchainDemoOrigin("not an address"), null);
  assert.equal(onchainDemoOrigin("off"), null);

  const off = createOnchainProxy({ origin: null, fetchImpl: standIn().fetchImpl });
  assert.equal((await ask(off, "/onchain")).handled, false);
  assert.equal((await ask(off, "/onchain/api/positions")).handled, false);
});

test("event /onchain: the two lanes meet over HTTP only, and the route is wired into the event site", () => {
  const proxy = readFileSync(resolve(API_DIR, "scripts/eventProtectXOnchainProxy.ts"), "utf8");
  assert.ok(!/from\s+["'][^"']*onchainVenues/.test(proxy), "the event lane imports nothing from the on-chain lane");
  assert.ok(!/from\s+["']\.\.\/src\//.test(proxy), "and the proxy reads nothing of the event engine either");
  const site = readFileSync(resolve(API_DIR, "scripts/eventProtectXDemoService.ts"), "utf8");
  assert.match(site, /ONCHAIN_DEMO\.handle\(req, res, url\.pathname\)/);
  assert.ok(!/from\s+["'][^"']*onchainVenues/.test(site));
});
