#!/usr/bin/env tsx
/**
 * Tier-0 shadow TRACK RECORD — prints the aggregate over the stored shadow sessions. Read-only.
 *   npm --silent --workspace services/api run shadow:scorecard | jq .
 * Filter to a clean post-fix cohort with SHADOW_SINCE_MS=<epoch_ms>.
 */

import { loadScorecards, filterSince } from "../src/singleSide/twoSided/creditCollar/shadowStore";
import { aggregateShadowScorecards } from "../src/singleSide/twoSided/creditCollar/shadowAggregate";

const sinceMs = process.env.SHADOW_SINCE_MS != null ? Number(process.env.SHADOW_SINCE_MS) : undefined;
const records = filterSince(loadScorecards(), sinceMs);
const aggregate = aggregateShadowScorecards(records, {
  exposureBandPct: process.env.SHADOW_BREAKER_HALT != null ? Number(process.env.SHADOW_BREAKER_HALT) : 0.15,
  minSessionsForClean: process.env.SHADOW_MIN_SESSIONS_CLEAN != null ? Number(process.env.SHADOW_MIN_SESSIONS_CLEAN) : 10,
  targetServiceFeeBps: process.env.HARNESS_SERVICE_FEE_BPS != null ? Number(process.env.HARNESS_SERVICE_FEE_BPS) : 2
});

process.stdout.write(JSON.stringify({ sinceMs: sinceMs ?? null, aggregate }, null, 2) + "\n");
console.error(`[scorecard] ${aggregate.sessions} session(s) | verdict=${aggregate.verdict}${aggregate.flags.length ? ` | flags: ${aggregate.flags.join("; ")}` : ""}`);
