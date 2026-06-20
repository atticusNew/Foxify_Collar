/**
 * Collateral-ledger persistence — the Foxify collateral account state carried across shadow cycles
 * (posted / debited / available / halt). Disk-backed with the same writable-fallback as the other
 * stores. Single JSON document (not append-only), replaced each cycle.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolveWritablePath } from "./shadowStore";
import { openLedger, type CollateralLedger, type CollateralConfig } from "./collateralLedger";

export const DEFAULT_COLLATERAL_PATH = process.env.SHADOW_COLLATERAL_PATH ?? "./logs/shadow-collateral.json";

export const loadLedger = (initialPostedUsdc: number, cfg: CollateralConfig = {}, path = DEFAULT_COLLATERAL_PATH): CollateralLedger => {
  const eff = resolveWritablePath(path);
  if (existsSync(eff)) {
    try {
      const l = JSON.parse(readFileSync(eff, "utf8")) as CollateralLedger;
      if (l && Number.isFinite(l.availableUsdc)) return l;
    } catch {
      /* fall through to fresh ledger */
    }
  }
  return openLedger(initialPostedUsdc, cfg);
};

export const saveLedger = (ledger: CollateralLedger, path = DEFAULT_COLLATERAL_PATH): void => {
  const eff = resolveWritablePath(path);
  try {
    writeFileSync(eff, JSON.stringify(ledger), "utf8");
  } catch (e) {
    console.warn(`[collateral-store] save failed (${(e as Error).message})`);
  }
};
