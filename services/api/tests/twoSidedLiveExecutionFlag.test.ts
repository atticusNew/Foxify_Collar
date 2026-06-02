/**
 * Tests — isLiveExecutionEnabled (FOXIFY_V2_LIVE_EXECUTION truthy parse).
 *
 * Regression for the 2026-06-02 incident: FOXIFY_V2_LIVE_EXECUTION="live" was
 * silently treated as shadow (strict ==="true"), so an isShadow=false activate
 * paper-filled with no real venue order. Now common truthy tokens are accepted.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isLiveExecutionEnabled } from "../src/singleSide/twoSided/featureFlag";

const env = (v: string | undefined) => ({ FOXIFY_V2_LIVE_EXECUTION: v } as unknown as NodeJS.ProcessEnv);

test("isLiveExecutionEnabled: accepts true/live/1/yes/on (case-insensitive, trimmed)", () => {
  for (const v of ["true", "live", "LIVE", "1", "yes", "on", " True ", "Live"]) {
    assert.equal(isLiveExecutionEnabled(env(v)), true, `'${v}' should enable live`);
  }
});

test("isLiveExecutionEnabled: shadow for false/unset/garbage (safe default)", () => {
  for (const v of ["false", "", "0", "no", "off", "shadow", "paper", "tru", undefined]) {
    assert.equal(isLiveExecutionEnabled(env(v)), false, `'${v}' should NOT enable live`);
  }
});
