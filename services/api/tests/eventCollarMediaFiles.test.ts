import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { MEDIA_FILES, parseRange, serveMedia } from "../src/eventCollar/crossVenue/mediaFiles";

test("media: parseRange reads one byte range, suffix and open-ended forms, and flags the unsatisfiable", () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.equal(parseRange("items=0-1", 100), null, "only bytes");
  assert.equal(parseRange("bytes=0-1,5-6", 100), null, "one range at a time");
  assert.equal(parseRange("bytes=-", 100), null);
  assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 }, "open end runs to the last byte");
  assert.deepEqual(parseRange("bytes=0-500", 100), { start: 0, end: 99 }, "an end past the file is clipped");
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 }, "suffix: the last 10 bytes");
  assert.deepEqual(parseRange("bytes=-500", 100), { start: 0, end: 99 }, "a suffix longer than the file is the whole file");
  assert.deepEqual(parseRange("bytes=100-", 100), { start: -1, end: -1 }, "start at the size is past the end");
  assert.deepEqual(parseRange("bytes=20-10", 100), { start: -1, end: -1 }, "end before start");
});

test("media: the route serves only the listed files, with ranges, HEAD and the right statuses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "event-media-test-"));
  const bytes = Buffer.from("0123456789abcdefghij"); // 20 bytes
  writeFileSync(join(dir, "lockin-live.mp4"), bytes);
  // the poster is listed but not on disk: 404, never a crash
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://x");
    if (serveMedia(req, res, url.pathname, dir)) return;
    res.writeHead(418);
    res.end("not media");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const whole = await fetch(`${base}/media/lockin-live.mp4`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("content-type"), MEDIA_FILES["lockin-live.mp4"]);
    assert.equal(whole.headers.get("accept-ranges"), "bytes");
    assert.equal(whole.headers.get("content-length"), "20");
    assert.match(whole.headers.get("cache-control") || "", /max-age/);
    assert.equal(await whole.text(), "0123456789abcdefghij");

    const part = await fetch(`${base}/media/lockin-live.mp4`, { headers: { range: "bytes=5-9" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 5-9/20");
    assert.equal(part.headers.get("content-length"), "5");
    assert.equal(await part.text(), "56789");

    const tail = await fetch(`${base}/media/lockin-live.mp4`, { headers: { range: "bytes=15-" } });
    assert.equal(tail.status, 206);
    assert.equal(await tail.text(), "fghij");

    const bad = await fetch(`${base}/media/lockin-live.mp4`, { headers: { range: "bytes=20-" } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get("content-range"), "bytes */20");

    const head = await fetch(`${base}/media/lockin-live.mp4`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "20");
    assert.equal(await head.text(), "");

    const poster = await fetch(`${base}/media/lockin-live.jpg`);
    assert.equal(poster.status, 404, "listed but missing on disk");

    // a dotted path sent raw (fetch would resolve it before sending): the name is not on the list
    const other = await new Promise<number>((resolve, reject) => {
      const rq = request({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, path: "/media/..%2Fpackage.json", method: "GET" }, (rs) => {
        rs.resume();
        resolve(rs.statusCode || 0);
      });
      rq.on("error", reject);
      rq.end();
    });
    assert.equal(other, 404, "nothing outside the list");
    const unlisted = await fetch(`${base}/media/secret.mp4`);
    assert.equal(unlisted.status, 404);

    const post = await fetch(`${base}/media/lockin-live.mp4`, { method: "POST" });
    assert.equal(post.status, 405);

    const notMedia = await fetch(`${base}/medias/x`);
    assert.equal(notMedia.status, 418, "a path that is not /media/ is left to the caller");
  } finally {
    server.close();
  }
});
