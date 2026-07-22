#!/usr/bin/env tsx
/**
 * Record the PARTNER's elevated-day directional decision for the live runner.
 *
 * On elevated days the live window waits (until the window closes) for this record:
 *   take  — open the directional single; --side long|short, or omit to use our trend signal
 *   pass  — skip today; the window is consumed and nothing opens
 *
 * Usage:
 *   npx tsx scripts/creditCollarPartnerDecision.ts take --side short
 *   npx tsx scripts/creditCollarPartnerDecision.ts pass
 *   npx tsx scripts/creditCollarPartnerDecision.ts take --day 2026-07-23   # pre-record for a day
 *   npx tsx scripts/creditCollarPartnerDecision.ts show                    # today's latest decision
 *
 * Path: LIVE_PARTNER_DECISION_PATH (default ./logs/live-partner-decisions.jsonl).
 */

import { appendPartnerDecision, latestDecisionForDay, DEFAULT_PARTNER_DECISION_PATH } from "../src/singleSide/twoSided/creditCollar/execution/partnerDecisionStore";

const argv = process.argv.slice(2);
const action = argv[0];
const argAfter = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const dayUtc = argAfter("--day") ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(dayUtc)) {
  console.error(`invalid --day "${dayUtc}" (expect YYYY-MM-DD)`);
  process.exit(1);
}

if (action === "show") {
  const d = latestDecisionForDay(dayUtc);
  console.log(d ? JSON.stringify(d, null, 2) : `no decision recorded for ${dayUtc} (store: ${DEFAULT_PARTNER_DECISION_PATH})`);
  process.exit(0);
}

if (action !== "take" && action !== "pass") {
  console.error(`usage: creditCollarPartnerDecision.ts take [--side long|short] [--day YYYY-MM-DD] | pass [--day YYYY-MM-DD] | show [--day YYYY-MM-DD]`);
  process.exit(1);
}

const sideArg = argAfter("--side");
if (sideArg != null && sideArg !== "long" && sideArg !== "short") {
  console.error(`invalid --side "${sideArg}" (expect long|short)`);
  process.exit(1);
}
if (action === "pass" && sideArg != null) {
  console.error("--side is meaningless with 'pass'");
  process.exit(1);
}

const rec = {
  dayUtc,
  action: action as "take" | "pass",
  side: action === "take" ? ((sideArg as "long" | "short" | undefined) ?? null) : null,
  decidedAtIso: new Date().toISOString(),
  source: "cli"
};
appendPartnerDecision(rec);
console.log(`recorded: ${JSON.stringify(rec)}`);
console.log(
  action === "take"
    ? `→ live window will open the directional single (side: ${rec.side ?? "our trend signal"}) when due on ${dayUtc}.`
    : `→ live window will skip ${dayUtc} (partner passed).`
);
