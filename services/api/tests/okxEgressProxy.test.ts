import assert from "node:assert/strict";
import test from "node:test";
import { parseProxyPath, tokenMatches, filterHeaders } from "../scripts/okxEgressProxy";

test("parseProxyPath: strips /t/<token> and keeps the exact signed path + query", () => {
  const p = parseProxyPath("/t/abc123/api/v5/trade/order");
  assert.ok(p);
  assert.equal(p!.token, "abc123");
  assert.equal(p!.upstreamPath, "/api/v5/trade/order");

  const q = parseProxyPath("/t/abc123/api/v5/market/books?instId=BTC-USD-260816-59000-P&sz=1");
  assert.ok(q);
  assert.equal(q!.upstreamPath, "/api/v5/market/books?instId=BTC-USD-260816-59000-P&sz=1");
});

test("parseProxyPath: refuses non-/api/v5 targets and unshaped paths", () => {
  assert.equal(parseProxyPath("/api/v5/trade/order"), null);          // no token prefix
  assert.equal(parseProxyPath("/t/abc123/etc/passwd"), null);         // not the OKX API
  assert.equal(parseProxyPath("/t/abc123/api/v6/anything"), null);    // wrong version
  assert.equal(parseProxyPath("/t//api/v5/trade/order"), null);       // empty token
  assert.equal(parseProxyPath("/healthz"), null);
});

test("tokenMatches: timing-safe equality, refuses empty configured token", () => {
  assert.equal(tokenMatches("secret", "secret"), true);
  assert.equal(tokenMatches("secreT", "secret"), false);
  assert.equal(tokenMatches("secre", "secret"), false);
  assert.equal(tokenMatches("", ""), false); // empty token = open relay ⟹ always refuse
});

test("filterHeaders: forwards ONLY the OKX auth/content headers", () => {
  const out = filterHeaders({
    "content-type": "application/json",
    "ok-access-key": "k",
    "ok-access-sign": "s",
    "ok-access-timestamp": "t",
    "ok-access-passphrase": "p",
    "x-simulated-trading": "1",
    cookie: "evil=1",
    host: "proxy.onrender.com",
    "x-forwarded-for": "1.2.3.4",
    authorization: "Bearer nope"
  });
  assert.deepEqual(out, {
    "content-type": "application/json",
    "ok-access-key": "k",
    "ok-access-sign": "s",
    "ok-access-timestamp": "t",
    "ok-access-passphrase": "p",
    "x-simulated-trading": "1"
  });
});
