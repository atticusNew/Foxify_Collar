#!/usr/bin/env node
/**
 * Cross-platform test runner that doesn't depend on shell glob expansion.
 *
 * The `tests/**\/*.test.ts` glob in npm scripts works on bash with
 * `globstar` enabled (zsh / fish / Windows / fresh bash all may NOT
 * have it), causing `npm test` to fail with "Could not find ..." on
 * many developer machines.
 *
 * This wrapper enumerates test files via Node's fs API (zero deps,
 * works everywhere) and forwards them to `tsx --test`.
 *
 * Filter via env: TEST_FILTER=substring (e.g. TEST_FILTER=Bullish)
 *   tests whose path includes the substring will run, others skipped.
 *
 * Skip pattern via env: TEST_SKIP=substring (e.g. TEST_SKIP=Live)
 *   tests whose path includes the substring will be excluded.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = dirname(here);
const testsDir = join(apiRoot, "tests");

const filter = process.env.TEST_FILTER || "";
const skip = process.env.TEST_SKIP || "";

const collectTestFiles = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      // Skip fixtures and similar non-test directories
      if (entry === "fixtures" || entry === "node_modules") continue;
      out.push(...collectTestFiles(full));
    } else if (entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
};

const allFiles = collectTestFiles(testsDir).map((p) => relative(apiRoot, p));
const selected = allFiles.filter((p) => {
  if (filter && !p.includes(filter)) return false;
  if (skip && p.includes(skip)) return false;
  return true;
});

if (selected.length === 0) {
  console.error(`[run-tests] No test files matched (filter=${filter || "(none)"}, skip=${skip || "(none)"})`);
  process.exit(1);
}

console.log(`[run-tests] Running ${selected.length} test file(s)${filter ? ` (filter=${filter})` : ""}${skip ? ` (skip=${skip})` : ""}`);

const child = spawn("npx", ["tsx", "--test", ...selected], {
  cwd: apiRoot,
  stdio: "inherit",
  env: process.env
});

child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error(`[run-tests] failed to spawn: ${err.message}`);
  process.exit(1);
});
