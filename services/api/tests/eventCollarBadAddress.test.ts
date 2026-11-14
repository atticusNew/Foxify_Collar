/**
 * AN ADDRESS THAT IS NOT A PATH (`GET //`).
 *
 * Read loosely it threw before any route's guard, and the throw ended the process: one request
 * from anyone took a service down until the host restarted it. The services run in a child
 * process here, so a service that ends is seen ending.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BAD_ADDRESS_MESSAGE, requestUrl } from "../src/eventCollar/requestUrl";

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "op-secret-0123456789";
const dir = mkdtempSync(join(tmpdir(), "bad-address-"));

/** Addresses that are not one path on the service. The first four each ended the process. */
const NOT_A_PATH = ["//", "/\\", "//x:99999/", "//[/report", "///", "//@", "//:80", "//healthz", "/\\healthz", "//evil.example/api/shadow/reset?confirm=reset", "http://evil.example/healthz", "http://[", "*", "healthz"];

const CHILD = `
process.env.NODE_ENV = "test";
const [worker, demo, first] = await Promise.all([import(process.argv[2]), import(process.argv[3]), import(process.argv[4])]);
worker.wireLockEngine({ listGameMarkets: async () => [], quoteOne: async () => ({ ok: false, status: 404, body: { ok: false } }) });
const ports = {};
for (const [name, mod] of [["record", worker], ["demo", demo], ["first", first]]) {
  await new Promise((r) => mod.server.listen(0, "127.0.0.1", () => r()));
  ports[name] = mod.server.address().port;
}
console.log("PORTS " + JSON.stringify(ports));
`;

let child: ChildProcess;
let ports: { record: number; demo: number; first: number };
let childOut = "";

before(async () => {
  const script = join(dir, "services.mts");
  writeFileSync(script, CHILD);
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", EVENT_X_ADMIN_TOKEN: TOKEN, EVENT_SHADOW_SLATES: "acme=Acme Sports:nba" };
  for (const k of Object.keys(env)) if (/^EVENT_HEDGE_|^EVENT_SHADOW_ALERT_|^EVENT_X_NAME_HEDGE_VENUES$|^EVENT_X_DEV_NO_ADMIN$|^EVENT_X_ADMIN_SESSION_HOURS$|^EVENT_X_ADMIN_QUERY_TOKEN$|^EVENT_SHADOW_SLATE_KEY$/.test(k)) delete env[k];
  env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
  env.EVENT_SHADOW_LOCK_LEDGER_PATH = join(dir, "lock-ledger.jsonl");
  env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
  env.EVENT_X_FUNNEL_PATH = join(dir, "funnel.json");
  env.EVENT_X_LEDGER_PATH = join(dir, "demo-ledger.jsonl");
  child = spawn(process.execPath, ["--import", "tsx", script, join(API_DIR, "scripts/eventShadowWorker.ts"), join(API_DIR, "scripts/eventProtectXDemoService.ts"), join(API_DIR, "scripts/eventProtectDemoService.ts")], { cwd: API_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d: Buffer) => (childOut += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (childOut += d.toString()));
  const started = Date.now();
  while (!/PORTS (\{.*\})/.test(childOut)) {
    if (child.exitCode !== null || Date.now() - started > 60_000) throw new Error(`the services did not start: ${childOut.slice(-600)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  ports = JSON.parse(/PORTS (\{.*\})/.exec(childOut)?.[1] as string);
});
after(async () => {
  if (child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
});

/** One request with the address exactly as written: no client tidies it first. */
function raw(port: number, target: string, method = "GET"): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    let got = "";
    const done = () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(got)?.[1]);
      resolve(status ? { status, body: got.slice(got.indexOf("\r\n\r\n") + 4) } : null);
    };
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("connect", () => socket.write(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
    socket.on("data", (d) => (got += d.toString()));
    socket.on("close", done);
    socket.on("error", done);
  });
}

test("reading an address: one path on this service, or nothing; it never throws", () => {
  for (const t of NOT_A_PATH) assert.equal(requestUrl(t, 8911), null, t);
  const paths: Array<[string | undefined, string]> = [
    [undefined, "/"],
    ["", "/"],
    ["/", "/"],
    ["/healthz", "/healthz"],
    ["/slate/acme?as=operator", "/slate/acme"],
    ["/api/shadow/export/files?file=a//b", "/api/shadow/export/files"],
    ["/a//b", "/a//b"],
    ["/%", "/%"],
    ["/x?next=//evil.example", "/x"],
  ];
  for (const [target, pathname] of paths) {
    const u = requestUrl(target, 8911);
    assert.ok(u, String(target));
    assert.equal(u.pathname, pathname);
    assert.equal(u.host, "localhost:8911", "never another host");
  }
  assert.equal(requestUrl("/slate/acme?as=operator", 8911)?.searchParams.get("as"), "operator");

  // 40,000 addresses built from the characters that mean something to a parser
  const pieces = ["/", "/", "\\", ":", "@", "[", "]", "%", "?", "#", ".", "..", " ", "\t", "a", "9", "%2f", "%5c", "http:", "x:99999", "\u0000", "é"];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let refused = 0;
  for (let i = 0; i < 40_000; i += 1) {
    const target = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => pieces[Math.floor(rnd() * pieces.length)]).join("");
    const u = requestUrl(target, 8911);
    if (!u) {
      refused += 1;
      continue;
    }
    assert.equal(u.host, "localhost:8911", JSON.stringify(target));
    assert.ok(u.pathname.startsWith("/") && !u.pathname.startsWith("//"), JSON.stringify(target));
  }
  assert.ok(refused > 1000 && refused < 39_000, `${refused} refused`);
});

for (const service of ["record", "demo", "first"] as const) {
  test(`${service} service: an address that is not a path gets a 400 in plain words, and the service is still there afterwards`, async () => {
    const port = ports[service];
    assert.ok(await raw(port, "/healthz"), "the service answers before");
    for (const target of NOT_A_PATH) {
      for (const method of ["GET", "POST"]) {
        const r = await raw(port, target, method);
        assert.ok(r, `${method} ${target}: an answer came back (the service did not end)\n${childOut.slice(-400)}`);
        assert.equal(r.status, 400, `${method} ${target}`);
        // Node's own reader turns away a target with no slash at all before the service sees it; that 400 has no body
        if (r.body || target.startsWith("/")) assert.deepEqual(JSON.parse(r.body), { ok: false, error: "bad_address", message: BAD_ADDRESS_MESSAGE });
      }
    }
    assert.equal(child.exitCode, null, `the process is still running\n${childOut.slice(-400)}`);
    const again = await raw(port, "/healthz");
    assert.ok(again, "still answering");
  });
}

test("record service: an operator-only route reached with a doubled slash is refused as an address, not opened", async () => {
  for (const target of ["//api/shadow/export/files", "//x/api/shadow/export/files", "/\\x/holders"]) {
    const r = await raw(ports.record, target);
    assert.equal(r?.status, 400, target);
  }
  assert.equal((await raw(ports.record, "/api/shadow/export/files"))?.status, 403, "the plain path is the operator's, as before");
});
