import assert from "node:assert/strict";
import test from "node:test";
import { parseBrandAllowlist, resolveBrandFor } from "../src/singleSide/twoSided/creditCollar/epBranding";

test("branding: allowlist parses comma-separated names, trimming blanks", () => {
  assert.deepEqual(parseBrandAllowlist("PRIMEVAULT, Copper , BitGo"), ["PRIMEVAULT", "Copper", "BitGo"]);
  assert.deepEqual(parseBrandAllowlist(" , ,"), []);
  assert.deepEqual(parseBrandAllowlist(undefined), []);
  assert.deepEqual(parseBrandAllowlist(""), []);
});

test("branding: query override resolves case-insensitively to the CONFIGURED casing", () => {
  const allow = parseBrandAllowlist("PRIMEVAULT,Copper");
  assert.equal(resolveBrandFor("HYPERLIQUID", "primevault", allow), "PRIMEVAULT");
  assert.equal(resolveBrandFor("HYPERLIQUID", "PrimeVault", allow), "PRIMEVAULT");
  assert.equal(resolveBrandFor("HYPERLIQUID", "COPPER", allow), "Copper");
});

test("branding: unapproved names fail closed to the env default — nobody screenshots an arbitrary brand", () => {
  const allow = parseBrandAllowlist("PRIMEVAULT");
  assert.equal(resolveBrandFor("HYPERLIQUID", "FIREBLOCKS", allow), "HYPERLIQUID"); // not allowlisted
  assert.equal(resolveBrandFor("HYPERLIQUID", "<script>", allow), "HYPERLIQUID");
  assert.equal(resolveBrandFor("HYPERLIQUID", null, allow), "HYPERLIQUID");
  assert.equal(resolveBrandFor("HYPERLIQUID", "  ", allow), "HYPERLIQUID");
  assert.equal(resolveBrandFor("HYPERLIQUID", "primevault", []), "HYPERLIQUID"); // empty allowlist = no overrides
});
