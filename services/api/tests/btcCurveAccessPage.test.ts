/**
 * The curve service with its key changed: the holder of an old link is told the link has
 * expired and who to write to, on this service's own pages only, and is shown nothing else.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ACCESS_CONTACT, accessAnswer, renderAccessHtml } from "../src/btcCurve/accessPage";

const BASES = ["/", "/api", "/pairs", "/sports"];

test("curve access page: the mark, one sentence and the contact, and nothing about what is behind the link", () => {
  const html = renderAccessHtml("expired");
  assert.match(html, /<h1>Access link expired<\/h1>/);
  assert.ok(html.includes(`<a href="mailto:${ACCESS_CONTACT}">${ACCESS_CONTACT}</a>`));
  assert.match(html, /<svg class="mark" role="img" aria-label="Atticus"/);
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.ok(!/src=|href="http|url\(/.test(html), "the page loads nothing from anywhere");
  const words = html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<svg[\s\S]*?<\/svg>/, "").replace(/<[^>]+>/g, " ");
  for (const told of [/btc/i, /bitcoin/i, /curve/i, /pairs/i, /sports/i, /kalshi/i, /polymarket/i, /lock/i, /prospect/i, /token/i, /[\u2013\u2014]/]) {
    assert.ok(!told.test(words), `the page does not say ${told}`);
  }
  assert.match(renderAccessHtml("required"), /<h1>Access link required<\/h1>/);
});

test("curve access page: only the service's own paths answer it; JSON paths answer in JSON; every other path is left to the plain 404", () => {
  for (const path of ["/", "/pairs", "/pairs/", "/pairs/replay", "/sports", "/sports/lock"]) {
    const a = accessAnswer(path, true, BASES);
    assert.deepEqual([a?.status, a?.type], [401, "text/html"], path);
    assert.match(a!.body, /Access link expired/);
  }
  assert.match(accessAnswer("/", false, BASES)!.body, /Access link required/, "no key at all is not called expired");
  for (const path of ["/api/report", "/api/latest", "/pairs/api/state", "/sports/api/board"]) {
    const a = accessAnswer(path, true, BASES);
    assert.deepEqual([a?.status, a?.type], [401, "application/json"], path);
    const body = JSON.parse(a!.body) as { ok: boolean; error: string; message: string };
    assert.deepEqual([body.ok, body.error], [false, "access_link_expired"]);
    assert.ok(body.message.endsWith(`${ACCESS_CONTACT}.`));
  }
  for (const path of ["/lockin", "/lockin/brief", "/prospect", "/prospect/x", "/pairsx", "/sportsbook", "/anything", "/favicon.ico"]) {
    assert.equal(accessAnswer(path, true, BASES), null, path);
  }
});

function ask(handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>, path: string): Promise<{ status: number; type: string; body: string }> {
  const out = { status: 0, type: "", body: "" };
  const res = {
    headersSent: false,
    writeHead: (status: number, headers: Record<string, string>) => {
      out.status = status;
      out.type = headers["content-type"] ?? "";
    },
    end: (body?: string) => {
      out.body = body ?? "";
    },
  } as unknown as ServerResponse;
  return handle({ url: path, method: "GET", headers: {} } as IncomingMessage, res).then(() => out);
}

test("curve service: an old key gets the access page on its own pages, the new key still opens them, and a page with a key of its own reads like a path that does not exist", async () => {
  const before = { ...process.env };
  const KEY = "the-new-curve-key-0123456789";
  Object.assign(process.env, {
    NODE_ENV: "test",
    BTC_CURVE_DATA_DIR: mkdtempSync(join(tmpdir(), "curve-access-")),
    BTC_CURVE_TOKEN: KEY,
    BTC_CURVE_COLLAR: "0",
    PROSPECT_PAGE_KEY: "a-prospect-key-0123456789",
    LOCK_IN_INTERNAL_KEY: "an-internal-key-0123456789",
  });
  try {
    const { handle } = (await import("../scripts/btcCurveReportService")) as { handle: (req: IncomingMessage, res: ServerResponse) => Promise<void> };

    for (const path of ["/?k=the-old-key", "/pairs?k=the-old-key", "/sports?k=the-old-key", "/sports/replay?k=the-old-key"]) {
      const r = await ask(handle, path);
      assert.equal(r.status, 401, path);
      assert.match(r.type, /text\/html/);
      assert.match(r.body, /Access link expired/);
      assert.ok(r.body.includes(ACCESS_CONTACT));
    }
    assert.match((await ask(handle, "/")).body, /Access link required/);
    const json = await ask(handle, "/pairs/api/state?k=the-old-key");
    assert.equal(json.status, 401);
    assert.match(json.type, /application\/json/);
    assert.equal((JSON.parse(json.body) as { error: string }).error, "access_link_expired");

    // the new key: the service's own answers, not the access page (nothing is collected in a test, so the report is still warming up)
    const open = await ask(handle, `/?k=${KEY}`);
    assert.equal(open.status, 503);
    assert.ok(!open.body.includes("Access link"));
    assert.equal((await ask(handle, `/api/replays?k=${KEY}`)).status, 200);

    // the pages with a key of their own, and a path that is nothing: the same plain 404, with the old key, the curve's key or none
    const plain: string[] = [];
    for (const path of ["/lockin", "/lockin/brief", "/prospect", "/nothing-here"]) {
      for (const q of ["", "?k=the-old-key", `?k=${KEY}`]) {
        const r = await ask(handle, `${path}${q}`);
        plain.push(`${r.status} ${r.body}`);
        assert.ok(!r.body.includes("Atticus"), `${path}${q}`);
      }
    }
    assert.deepEqual([...new Set(plain)], ["404 not found"]);

    // the open health check says nothing new
    const health = await ask(handle, "/healthz");
    assert.equal(health.status, 200);
    assert.ok(!health.body.includes(KEY));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
    Object.assign(process.env, before);
  }
});
