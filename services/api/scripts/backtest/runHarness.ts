/**
 * Backtest harness runner — runs all defined scenarios and writes the
 * Markdown comparison report.
 *
 * Usage:
 *   cd services/api
 *   npx tsx scripts/backtest/runHarness.ts
 *
 * Output: docs/foxify-pilot-bundle-c/09_BACKTEST_HARNESS_RESULTS.md
 *
 * This is the WS#9 deliverable for Gate 1 operator review.
 */

import { runScenario } from "./core/engine";
import { writeMarkdownReport } from "./core/scorecardWriter";
import { SCENARIOS } from "./scenarios/scenarios";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(HERE, "../../../../docs/foxify-pilot-bundle-c/09_BACKTEST_HARNESS_RESULTS.md");

const main = (): void => {
  console.log(`[Harness] Running ${SCENARIOS.length} scenarios...`);
  const scorecards = SCENARIOS.map((cfg) => {
    console.log(`[Harness] - ${cfg.name}`);
    return runScenario(cfg);
  });

  const report = writeMarkdownReport(scorecards);
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, report, "utf8");

  console.log(`[Harness] Wrote report: ${OUTPUT_PATH}`);
  console.log("");
  console.log("=== Headline ===");
  for (const s of scorecards) {
    const sign = s.pilotPnLProjected >= 0 ? "+" : "";
    console.log(`  ${s.scenarioName.padEnd(28)} ${sign}$${s.pilotPnLProjected.toFixed(0).padStart(8)} (${s.capUtilizationPct.toFixed(1)}% cap)`);
  }
};

main();
