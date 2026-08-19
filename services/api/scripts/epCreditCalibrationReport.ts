#!/usr/bin/env tsx
/**
 * CREDIT CALIBRATION REPORT (Phase 3 gate) — realized per-lot credit across the wrap store.
 *
 * Run it any time during (and after) the week-one live run:
 *
 *   npx tsx services/api/scripts/epCreditCalibrationReport.ts
 *
 * Reads the same store the service uses (DEMO_STORE_PATH / DATABASE_URL), prints the markdown
 * report, and writes it to logs/ep-credit-calibration.md. The publish gate only counts okx_live
 * wraps and refuses to bless numbers until ≥30 live wraps across ≥18 distinct market hours over
 * ≥7 days (env-tunable). Until it passes, trader-facing copy stays the approved interim framing.
 *
 * Also prints the RFQ netting view of the CURRENT open book (decision 7 planning): net per-strike
 * deltas and which would clear the block minimum (EP_RFQ_BLOCK_MIN_NOTIONAL, default $50k —
 * confirm exact OKX options block minimums with the BD rep).
 */

import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { resolveWritablePath } from "../src/singleSide/twoSided/creditCollar/shadowStore";
import { loadDemoWraps, type DemoWrapRecord } from "../src/singleSide/twoSided/creditCollar/demoWrap";
import { postgresStores } from "../src/singleSide/twoSided/creditCollar/store/epStores";
import { buildCalibrationReport, parsePublishGateFromEnv, renderCalibrationMarkdown } from "../src/singleSide/twoSided/creditCollar/epCalibration";
import { buildNettingPlan, intentsFromWraps } from "../src/singleSide/twoSided/creditCollar/epRfqNetting";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

const main = async (): Promise<void> => {
  let wraps: DemoWrapRecord[];
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    try {
      wraps = await postgresStores(pool).loadWraps();
    } finally {
      await pool.end();
    }
  } else {
    wraps = loadDemoWraps(process.env.DEMO_STORE_PATH ?? "./logs/demo-wraps.json");
  }

  const report = buildCalibrationReport(wraps, parsePublishGateFromEnv(process.env), Date.now());
  const md = renderCalibrationMarkdown(report);
  const outPath = resolveWritablePath(process.env.EP_CALIBRATION_REPORT_PATH ?? "./logs/ep-credit-calibration.md");
  writeFileSync(outPath, md, "utf8");
  console.log(md);
  console.error(`\n[calibration] report written to ${outPath}`);

  // RFQ netting view of the current open book (planning only — entries; unwinds stay on screen).
  const intents = intentsFromWraps(wraps);
  if (intents.length > 0) {
    const spot = wraps.slice().reverse().find((w) => w.quote)?.quote?.spot ?? 0;
    const plan = buildNettingPlan(intents, spot, num(process.env.EP_RFQ_BLOCK_MIN_NOTIONAL, 50_000));
    console.error(`\n[rfq-netting] open book: ${intents.length} wraps → ${plan.legs.length} net legs (${plan.nettedAwayLots} lots netted away entirely)`);
    for (const l of plan.legs) {
      console.error(
        `[rfq-netting]   ${l.netLots > 0 ? "BUY " : "SELL"} ${Math.abs(l.netLots)} lots ${l.optType} $${l.strike} exp ${new Date(l.expiryMs).toISOString().slice(0, 10)}` +
          ` ($${l.notionalUsdc}) → ${l.route === "rfq_block" ? "RFQ BLOCK" : "order book"} (gross before netting: ${l.grossLots})`
      );
    }
  }
};

void main().catch((e) => {
  console.error(`[calibration] FAILED: ${(e as Error).message}`);
  process.exit(1);
});
