#!/usr/bin/env tsx
/**
 * Deribit auth PROBE — READ-ONLY credential diagnostic. Places NO orders, moves NO capital.
 *
 * Runs the same private get_account_summary against BOTH Deribit systems:
 *   - testnet (test.deribit.com)
 *   - live    (www.deribit.com)
 * to pinpoint where the client_id/secret is valid. Deribit testnet is a SEPARATE system from
 * mainnet (separate account + separate API keys), so a 13004 invalid_credentials on testnet usually
 * means the key was created on www.deribit.com (or a mainnet-only account).
 *
 *   DERIBIT_CLIENT_ID=... DERIBIT_CLIENT_SECRET=... \
 *   npm --silent --workspace services/api run deribit:auth-probe
 */

import { DeribitExecutionClient, type DeribitMode } from "../src/singleSide/twoSided/creditCollar/execution/deribitExecutionClient";

const mask = (s: string): string => (s.length <= 6 ? `${s[0] ?? ""}***` : `${s.slice(0, 3)}…${s.slice(-3)}`);

const probe = async (creds: { clientId: string; clientSecret: string }, mode: DeribitMode) => {
  const client = new DeribitExecutionClient({ ...creds, mode });
  const r = await client.authCheck();
  return { mode, ok: r.ok, message: r.message };
};

const main = async () => {
  const clientId = process.env.DERIBIT_CLIENT_ID;
  const clientSecret = process.env.DERIBIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("[deribit-auth-probe] missing DERIBIT_CLIENT_ID / DERIBIT_CLIENT_SECRET");
    process.exit(2);
  }
  const creds = { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
  console.error(`[deribit-auth-probe] client_id=${mask(creds.clientId)} (len ${creds.clientId.length}) secret(len ${creds.clientSecret.length})`);
  if (creds.clientId.length !== clientId.length || creds.clientSecret.length !== clientSecret.length) {
    console.error("[deribit-auth-probe] ⚠️ trimmed whitespace from a value — re-export with single quotes.");
  }

  const testnet = await probe(creds, "testnet");
  const live = await probe(creds, "live");
  console.error(`[deribit-auth-probe] testnet: ${testnet.ok ? "OK ✓" : `FAIL ${testnet.message}`}`);
  console.error(`[deribit-auth-probe] live:    ${live.ok ? "OK ✓" : `FAIL ${live.message}`}`);

  let verdict: string;
  if (testnet.ok) {
    verdict = "TESTNET_OK — valid testnet keys; deribit:dry-run should work in testnet mode.";
  } else if (live.ok) {
    verdict =
      "LIVE_KEY — these are MAINNET keys (www.deribit.com), not testnet. Register separately at " +
      "https://test.deribit.com, create an API key there (with trade scope), and use THOSE for the testnet dry-run.";
  } else {
    verdict =
      "INVALID_BOTH — credentials fail on both systems. Re-copy client_id + client_secret (the secret is " +
      "shown only once at creation), and ensure the key has trade scope. If unsure, create a fresh testnet key.";
  }
  process.stdout.write(JSON.stringify({ testnet, live, verdict }, null, 2) + "\n");
  console.error(`[deribit-auth-probe] VERDICT: ${verdict}`);
  if (!testnet.ok && !live.ok) process.exit(1);
};

main().catch((e) => {
  console.error("[deribit-auth-probe] fatal:", e);
  process.exit(1);
});
