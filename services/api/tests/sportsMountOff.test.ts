/**
 * BTC_CURVE_SPORTS=off: the BTC curve service runs without the sports page. Its own file
 * because the setting is read once, when the service module loads.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("BTC_CURVE_SPORTS=off: no /sports, no sports files, /healthz says it is off, the BTC routes answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sv-mount-off-"));
  Object.assign(process.env, { NODE_ENV: "test", BTC_CURVE_DATA_DIR: dir, BTC_CURVE_TOKEN: "k1", BTC_CURVE_COLLAR: "0", BTC_CURVE_SPORTS: "off" });
  const service = (await import("../scripts/btcCurveReportService")) as { handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>; sports: unknown };
  assert.equal(service.sports, null);
  assert.equal(existsSync(join(dir, "sports")), false);
  const server = createServer((req, res) => void service.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const get = (path: string) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
  try {
    const h = (await (await get("/healthz")).json()) as { ok: boolean; sports: unknown };
    assert.equal(h.ok, true);
    assert.equal(h.sports, "off (BTC_CURVE_SPORTS)");
    assert.equal((await get("/sports?k=k1")).status, 404);
    assert.equal((await get("/sports/api/report?k=k1")).status, 404);
    assert.equal((await get("/api/replays?k=k1")).status, 200);
  } finally {
    server.close();
  }
});
