/**
 * /video page + byte-range parsing (epVideoPageHtml).
 *
 * The mp4 route must honor single byte ranges (Safari/iOS refuse to play <video> without 206
 * support) and fall back to the full file on anything malformed — a correct 200 beats a wrong 416.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EP_VIDEO_PAGE_HTML, parseByteRange } from "../scripts/epVideoPageHtml";
import { emptyFunnel, recordPageLoad } from "../src/singleSide/twoSided/creditCollar/epFunnel";

test("parseByteRange: standard forms", () => {
  assert.deepEqual(parseByteRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=500-", 1000), { start: 500, end: 999 });
  assert.deepEqual(parseByteRange("bytes=-200", 1000), { start: 800, end: 999 });
  // End clamps to the file size.
  assert.deepEqual(parseByteRange("bytes=900-5000", 1000), { start: 900, end: 999 });
  // Suffix longer than the file serves the whole file as a range.
  assert.deepEqual(parseByteRange("bytes=-5000", 1000), { start: 0, end: 999 });
});

test("parseByteRange: absent, malformed, or unsatisfiable ⟹ null (serve full file)", () => {
  assert.equal(parseByteRange(undefined, 1000), null);
  assert.equal(parseByteRange("", 1000), null);
  assert.equal(parseByteRange("bytes=-", 1000), null);
  assert.equal(parseByteRange("bytes=abc-def", 1000), null);
  assert.equal(parseByteRange("bytes=0-99,200-299", 1000), null); // multi-range: not honored
  assert.equal(parseByteRange("bytes=1000-", 1000), null); // start beyond EOF
  assert.equal(parseByteRange("bytes=50-20", 1000), null); // inverted
  assert.equal(parseByteRange("bytes=-0", 1000), null); // zero-length suffix
  assert.equal(parseByteRange("bytes=0-99", 0), null); // empty file
});

test("video page: player, ladder copy, live-product links, honesty line", () => {
  assert.ok(EP_VIDEO_PAGE_HTML.includes("/assets/hl-toggle-demo.mp4"), "video src");
  assert.ok(EP_VIDEO_PAGE_HTML.includes("playsinline"), "iOS inline playback");
  assert.ok(EP_VIDEO_PAGE_HTML.includes("hard floor and a daily credit"), "ladder copy");
  assert.ok(EP_VIDEO_PAGE_HTML.includes("Everything else stays exactly the same"), "ladder copy");
  assert.ok(EP_VIDEO_PAGE_HTML.includes('href="/"'), "link into the live app");
  assert.ok(EP_VIDEO_PAGE_HTML.includes("facility.atticustrade.com"), "link to the facility track record");
  assert.ok(EP_VIDEO_PAGE_HTML.includes('target="_blank"'), "facility opens in a new tab (video page stays open)");
  assert.ok(EP_VIDEO_PAGE_HTML.includes("browser extension"), "disclaimer: not venue-embedded");
  assert.ok(EP_VIDEO_PAGE_HTML.includes("credits scale with position size"), "disclaimer: small credit");
});

test("funnel: video page loads count under their own surface", () => {
  const f = emptyFunnel();
  recordPageLoad(f, "video", Date.UTC(2026, 8, 16, 12));
  recordPageLoad(f, "video", Date.UTC(2026, 8, 16, 13));
  recordPageLoad(f, "app", Date.UTC(2026, 8, 16, 14));
  assert.deepEqual(f.pageLoads["2026-09-16"], { video: 2, app: 1 });
});
