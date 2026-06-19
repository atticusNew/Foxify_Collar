#!/usr/bin/env tsx
/**
 * OKX activate-option — turns ON options trading for the account via API (POST
 * /api/v5/account/activate-option). This is the programmatic equivalent of "click any symbol on the
 * options chain to activate trading" and clears error 51198. Idempotent + safe to re-run.
 *
 * Runs fine from Render with the API key's IP allow-list (it's an authenticated API call from the
 * same IP your other API calls use — NOT a browser action, so no UI/region timeout applies).
 *
 *   OKX_API_KEY=... OKX_API_SECRET=... OKX_API_PASSPHRASE=... \
 *   OKX_EXECUTION_MODE=demo npm --silent --workspace services/api run okx:activate-option
 */

import { OkxExecutionClient, type OkxMode } from "../src/singleSide/twoSided/creditCollar/execution/okxExecutionClient";

const ACCT_LV: Record<string, string> = { "1": "spot/simple", "2": "single-ccy margin", "3": "multi-ccy margin", "4": "portfolio margin" };

const main = async () => {
  const apiKey = process.env.OKX_API_KEY;
  const secret = process.env.OKX_API_SECRET;
  const passphrase = process.env.OKX_API_PASSPHRASE;
  if (!apiKey || !secret || !passphrase) {
    console.error("[okx-activate] missing OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE");
    process.exit(2);
  }
  const mode: OkxMode = (process.env.OKX_EXECUTION_MODE ?? "demo").toLowerCase() === "live" ? "live" : "demo";
  console.error(`[okx-activate] mode=${mode} (demo uses x-simulated-trading; demo + live activate separately)`);

  const client = new OkxExecutionClient({ apiKey, secret, passphrase, mode });

  const auth = await client.authCheck();
  if (!auth.ok) {
    console.error(`[okx-activate] AUTH FAILED: ${auth.message} — run okx:auth-probe to diagnose.`);
    process.exit(8);
  }
  console.error("[okx-activate] auth ok ✓");

  const cfg = await client.getAccountConfig();
  let acctLv = cfg.data?.[0]?.acctLv;
  if (acctLv) console.error(`[okx-activate] account mode: ${acctLv} (${ACCT_LV[acctLv] ?? "?"}), posMode=${cfg.data?.[0]?.posMode ?? "?"}`);

  // Options require acctLv ≥ 3 (single-ccy margin can't trade options at all). Optionally switch.
  const target = process.env.OKX_SET_ACCT_LV as "2" | "3" | "4" | undefined;
  if (target && acctLv !== target) {
    console.error(`[okx-activate] switching account mode ${acctLv} → ${target} (${ACCT_LV[target] ?? "?"})…`);
    const sw = await client.setAccountLevel(target);
    if (sw.ok) {
      acctLv = target;
      console.error(`[okx-activate] account mode now ${target} ✓`);
    } else {
      console.error(`[okx-activate] ⚠️ account-mode switch failed: ${sw.code} ${sw.msg}`);
      if (target === "4") console.error("  Portfolio Margin can require a precheck/min equity; try OKX_SET_ACCT_LV=3 first.");
    }
  }

  if (acctLv === "1" || acctLv === "2") {
    console.error(`[okx-activate] ❌ account mode ${acctLv} (${ACCT_LV[acctLv]}) CANNOT trade options.`);
    console.error("  Switch first:  OKX_SET_ACCT_LV=4 npm --silent --workspace services/api run okx:activate-option");
    console.error("  (4 = Portfolio Margin — needed so the collar's long put offsets the short call.)");
    process.stdout.write(JSON.stringify({ mode, activated: false, reason: "account_mode_unsupported", acctLv }, null, 2) + "\n");
    process.exit(1);
  }

  const res = await client.activateOption();
  const ok = res.ok || res.code === "51199" /* already activated */;
  process.stdout.write(JSON.stringify({ mode, activated: ok, code: res.code, msg: res.msg, ts: res.data?.[0]?.ts ?? null, acctLv }, null, 2) + "\n");

  if (ok) {
    console.error("[okx-activate] ✅ options trading ACTIVE for this account. Re-run okx:dry-run.");
    if (acctLv === "3") {
      console.error("[okx-activate] NOTE: multi-ccy margin (acctLv=3) blocks net-long options in CROSS margin (error 51019).");
      console.error("  A collar BUYS a put (long leg) — to test both legs use Portfolio Margin (OKX_SET_ACCT_LV=4),");
      console.error("  or run the long leg with OKX_TD_MODE=isolated. Short call alone works under cross.");
    }
  } else {
    console.error(`[okx-activate] ❌ activation failed: ${res.code} ${res.msg}`);
    process.exit(1);
  }
};

main().catch((e) => {
  console.error("[okx-activate] fatal:", e);
  process.exit(1);
});
