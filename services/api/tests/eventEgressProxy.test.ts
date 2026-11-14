import assert from "node:assert/strict";
import test from "node:test";
import { parseRelayPath, prefixAllowed, tokenMatches } from "../scripts/eventEgressProxy";

test("parseRelayPath: strips /t/<token> and keeps the exact path + query", () => {
  const p = parseRelayPath("/t/abc123/book?token_id=42");
  assert.ok(p);
  assert.equal(p!.token, "abc123");
  assert.equal(p!.upstreamPath, "/book?token_id=42");

  assert.equal(parseRelayPath("/book?token_id=42"), null); // no token prefix
  assert.equal(parseRelayPath("/t//book"), null); // empty token
  assert.equal(parseRelayPath("/t/abc123"), null); // nothing to forward
  assert.equal(parseRelayPath("/healthz"), null);
});

test("prefixAllowed: exact prefix or subpath only, query string ignored", () => {
  assert.equal(prefixAllowed("/book?token_id=42", ["/book"]), true);
  assert.equal(prefixAllowed("/book/extra", ["/book"]), true);
  assert.equal(prefixAllowed("/books?x=1", ["/book"]), false); // no prefix-string bleed
  assert.equal(prefixAllowed("/etc/passwd", ["/book"]), false);
  assert.equal(prefixAllowed("/book", []), false);
});

test("tokenMatches: timing-safe equality, refuses empty configured token", () => {
  assert.equal(tokenMatches("secret", "secret"), true);
  assert.equal(tokenMatches("secreT", "secret"), false);
  assert.equal(tokenMatches("secre", "secret"), false);
  assert.equal(tokenMatches("", ""), false); // empty token = open relay ⟹ always refuse
});
