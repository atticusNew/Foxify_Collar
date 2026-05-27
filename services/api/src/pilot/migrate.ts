import { pilotConfig } from "./config";
import { ensurePilotSchema, getPilotPool } from "./db";
import {
  ensureVolumeCoverSchema,
  seedVolumeCoverCellsIfNeeded
} from "../volumeCover/volumeCoverDb";
import { ensureTwoSidedSchema } from "../singleSide/twoSided/db";
import { ensureDeferredPoolSchema } from "../singleSide/twoSided/deferredPool";
import { ensureGuardrailsSchema } from "../singleSide/twoSided/guardrails";
import { ensureNewbornReviewSchema } from "../singleSide/twoSided/featureFlag";

async function main() {
  if (!pilotConfig.postgresUrl) {
    throw new Error("POSTGRES_URL or DATABASE_URL is required");
  }
  const pool = getPilotPool(pilotConfig.postgresUrl);
  await ensurePilotSchema(pool);
  await ensureVolumeCoverSchema(pool);
  await seedVolumeCoverCellsIfNeeded(pool);
  await ensureTwoSidedSchema(pool);
  await ensureDeferredPoolSchema(pool);
  await ensureGuardrailsSchema(pool);
  await ensureNewbornReviewSchema(pool);
  await pool.end();
  // eslint-disable-next-line no-console
  console.log("Pilot + Volume Cover + Two-Sided schema migration complete.");
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Pilot schema migration failed:", error);
  process.exit(1);
});

