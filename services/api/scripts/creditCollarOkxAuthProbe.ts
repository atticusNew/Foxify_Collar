#!/usr/bin/env tsx
/**
 * OKX auth PROBE — READ-ONLY credential diagnostic. Places NO orders, moves NO capital.
 *
 * Runs the same GET /api/v5/account/balance against BOTH OKX keystores:
 *   - demo (x-simulated-trading: 1)
 *   - live (no simulated header)
 * so we can tell exactly where the key/passphrase pair is valid. This isolates the very common
 * `50105 OK-ACCESS-PASSPHRASE incorrect` cause: a LIVE key used with the demo header (OKX looks up
 * the key in the demo keystore, can't find it, and reports the passphrase as incorrect).
 *
 *   OKX_API_KEY=... OKX_API_SECRET=... OKX_API_PASSPHRASE=... \
 *   npm --silent --workspace services/api run okx:auth-probe
 *
 * NOTE: the live check is a read-only GET; it does NOT require OKX_LIVE_CONFIRM because it can never
 * place or cancel an order.
 */

import { OkxExecutionClient, type OkxMode } from "../src/singleSide/twoSided/creditCollar/execution/okxExecutionClient";

const mask = (s: string): string => (s.length <= 8 ? `${s[0] ?? ""}***` : `${s.slice(0, 4)}…${s.slice(-4)}`);

const probe = async (creds: { apiKey: string; secret: string; passphrase: string }, mode: OkxMode) => {
  const client = new OkxExecutionClient({ ...creds, mode });
  try {
    const r = await client.getBalance();
    return { mode, ok: r.ok, code: r.code, msg: r.msg };
  } catch (e) {
    return { mode, ok: false, code: "ERR", msg: e instanceof Error ? e.message : String(e) };
  }
};

const main = async () => {
  const apiKey = process.env.OKX_API_KEY;
  const secret = process.env.OKX_API_SECRET;
  const passphrase = process.env.OKX_API_PASSPHRASE;
  if (!apiKey || !secret || !passphrase) {
    console.error("[okx-auth-probe] missing OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE");
    process.exit(2);
  }
  const creds = { apiKey: apiKey.trim(), secret: secret.trim(), passphrase: passphrase.trim() };

  // Surface invisible whitespace / quoting problems without printing secrets.
  console.error(
    `[okx-auth-probe] key=${mask(creds.apiKey)} (len ${creds.apiKey.length}) ` +
      `secret(len ${creds.secret.length}) passphrase(len ${creds.passphrase.length})`
  );
  if (creds.apiKey.length !== apiKey.length || creds.secret.length !== secret.length || creds.passphrase.length !== passphrase.length) {
    console.error("[okx-auth-probe] ⚠️ trimmed leading/trailing whitespace from one or more values — re-export with single quotes.");
  }

  const demo = await probe(creds, "demo");
  const live = await probe(creds, "live");
  console.error(`[okx-auth-probe] demo: ${demo.ok ? "OK ✓" : `FAIL ${demo.code}: ${demo.msg}`}`);
  console.error(`[okx-auth-probe] live: ${live.ok ? "OK ✓" : `FAIL ${live.code}: ${live.msg}`}`);

  let verdict: string;
  if (demo.ok) {
    verdict = "DEMO_OK — credentials are valid demo keys; okx:dry-run should work in demo mode.";
  } else if (live.ok) {
    verdict =
      "LIVE_KEY — these are LIVE (production) keys, NOT demo keys. Create a key inside OKX 'Demo Trading' " +
      "(toggle to Demo Trading first, then Personal Center → API → Create V5 API Key) and use THAT for the demo dry-run.";
  } else if (demo.code === "50105" && live.code === "50105") {
    verdict = "PASSPHRASE_WRONG — passphrase does not match this API key in either keystore. Recreate the key and set a fresh passphrase.";
  } else if (demo.code === "50111" || live.code === "50111") {
    verdict = "BAD_API_KEY — OK-ACCESS-KEY is invalid (50111). Re-copy the API key.";
  } else {
    verdict = `UNKNOWN — demo=${demo.code} live=${live.code}. See messages above.`;
  }

  process.stdout.write(JSON.stringify({ demo, live, verdict }, null, 2) + "\n");
  console.error(`[okx-auth-probe] VERDICT: ${verdict}`);
  if (!demo.ok && !live.ok) process.exit(1);
};

main().catch((e) => {
  console.error("[okx-auth-probe] fatal:", e);
  process.exit(1);
});
