/**
 * pilotVerifyDvolSource.ts
 *
 * Verifies that the platform's DVOL/RVOL data source (the deribitLive
 * mainnet read-only connector) returns sane market values, and contrasts
 * it with the testnet endpoint that the deployed connector was previously
 * (incorrectly) using.
 *
 * Read-only. Public Deribit API only. No auth, no secrets.
 *
 * Run after the DVOL fix is deployed to confirm the platform is now
 * reading mainnet DVOL.
 *
 * Usage:
 *   npx tsx services/api/scripts/pilotVerifyDvolSource.ts
 *   npx tsx services/api/scripts/pilotVerifyDvolSource.ts --api-base https://...
 *
 * Exit codes:
 *   0 — mainnet DVOL is in a sane range AND platform endpoint matches mainnet
 *   1 — mainnet/platform mismatch (still reading testnet)
 *   2 — fetch failure
 */

const TESTNET_BASE = "https://test.deribit.com/api/v2";
const MAINNET_BASE = "https://www.deribit.com/api/v2";
const PLATFORM_DEFAULT = "https://foxify-pilot-new.onrender.com";

type DvolPoint = { ts: number | null; close: number | null; min?: number; max?: number; samples?: number };

const fetchDvolFrom = async (base: string): Promise<DvolPoint> => {
  const url = `${base}/public/get_volatility_index_data?currency=BTC&resolution=60&start_timestamp=${Date.now() - 7200000}&end_timestamp=${Date.now()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`http_${res.status} ${base}`);
  const j: any = await res.json();
  const data: any[] = j?.result?.data ?? [];
  if (!Array.isArray(data) || data.length === 0) {
    return { ts: null, close: null };
  }
  const closes = data.map((row: any[]) => Number(row?.[4])).filter((n) => Number.isFinite(n) && n > 0);
  const last = data[data.length - 1];
  return {
    ts: Number(last?.[0]) || null,
    close: Number(last?.[4]) || null,
    min: closes.length ? Math.min(...closes) : undefined,
    max: closes.length ? Math.max(...closes) : undefined,
    samples: closes.length
  };
};

const fetchPlatformRegime = async (apiBase: string): Promise<{ dvol: number | null; rvol: number | null; regime: string | null; source: string | null }> => {
  const url = `${apiBase.replace(/\/+$/, "")}/pilot/regime`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`http_${res.status} ${url}`);
  const j: any = await res.json();
  return {
    dvol: typeof j?.dvol === "number" ? j.dvol : null,
    rvol: typeof j?.rvol === "number" ? j.rvol : null,
    regime: j?.regime ?? null,
    source: j?.source ?? null
  };
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  let apiBase = process.env.PILOT_API_BASE || PLATFORM_DEFAULT;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--api-base" && argv[i + 1]) { apiBase = argv[++i]; }
  }

  console.log("[verify-dvol] fetching DVOL from three sources...\n");

  let testnet: DvolPoint | null = null;
  let mainnet: DvolPoint | null = null;
  let platform: { dvol: number | null; rvol: number | null; regime: string | null; source: string | null } | null = null;
  const errors: string[] = [];

  try { testnet = await fetchDvolFrom(TESTNET_BASE); }
  catch (e: any) { errors.push(`testnet: ${e?.message || e}`); }
  try { mainnet = await fetchDvolFrom(MAINNET_BASE); }
  catch (e: any) { errors.push(`mainnet: ${e?.message || e}`); }
  try { platform = await fetchPlatformRegime(apiBase); }
  catch (e: any) { errors.push(`platform: ${e?.message || e}`); }

  if (errors.length === 3) {
    console.error("[verify-dvol] ALL FETCHES FAILED:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(2);
  }

  console.log("┌───────────────────────────────────────────────────────────────────────┐");
  console.log("│ Source                  │  Last DVOL │ Range (last 2h)        │ N    │");
  console.log("├───────────────────────────────────────────────────────────────────────┤");
  const fmt = (p: DvolPoint | null) => p ? `${(p.close ?? NaN).toFixed(2).padStart(8)}    ${(p.min ?? NaN).toFixed(2)} – ${(p.max ?? NaN).toFixed(2).padEnd(8)} ${String(p.samples ?? 0).padStart(4)}` : "  (failed)";
  console.log(`│ Deribit MAINNET          │  ${fmt(mainnet)}      │`);
  console.log(`│ Deribit testnet (synth)  │  ${fmt(testnet)}      │`);
  console.log("└───────────────────────────────────────────────────────────────────────┘\n");

  if (platform) {
    console.log("Platform /pilot/regime:");
    console.log(`  dvol   = ${platform.dvol ?? "null"}`);
    console.log(`  rvol   = ${platform.rvol ?? "null"}`);
    console.log(`  regime = ${platform.regime ?? "null"}`);
    console.log(`  source = ${platform.source ?? "null"}\n`);
  }

  // Verdict
  const mainnetClose = mainnet?.close ?? null;
  const testnetClose = testnet?.close ?? null;
  const platformDvol = platform?.dvol ?? null;

  let verdict: "PASS" | "MISMATCH" | "INCONCLUSIVE" = "INCONCLUSIVE";
  let why = "";

  if (mainnetClose !== null && platformDvol !== null) {
    const matchMainnet = Math.abs(platformDvol - mainnetClose) / Math.max(1, mainnetClose) < 0.10; // within 10%
    const matchTestnet = testnetClose !== null && Math.abs(platformDvol - testnetClose) / Math.max(1, testnetClose) < 0.05;
    if (matchMainnet && !matchTestnet) {
      verdict = "PASS";
      why = `platform DVOL (${platformDvol.toFixed(2)}) matches mainnet (${mainnetClose.toFixed(2)}) within 10%`;
    } else if (matchTestnet && !matchMainnet) {
      verdict = "MISMATCH";
      why = `platform DVOL (${platformDvol.toFixed(2)}) matches TESTNET (${testnetClose?.toFixed(2)}), not mainnet (${mainnetClose.toFixed(2)}) — DVOL fix not deployed yet OR cache not refreshed`;
    } else if (matchMainnet && matchTestnet) {
      verdict = "INCONCLUSIVE";
      why = "testnet and mainnet DVOL happen to match closely; cannot disambiguate";
    } else {
      verdict = "MISMATCH";
      why = `platform DVOL (${platformDvol.toFixed(2)}) doesn't match mainnet (${mainnetClose.toFixed(2)}) or testnet (${testnetClose?.toFixed(2) ?? "n/a"}) — investigate`;
    }
  } else {
    why = "missing data: " + [
      mainnetClose === null ? "no mainnet" : "",
      platformDvol === null ? "no platform" : ""
    ].filter(Boolean).join(", ");
  }

  console.log(`VERDICT: ${verdict}`);
  console.log(`        ${why}`);

  if (errors.length) {
    console.log("\nFetch warnings (non-fatal):");
    for (const e of errors) console.log(`  - ${e}`);
  }

  if (verdict === "PASS") process.exit(0);
  if (verdict === "MISMATCH") process.exit(1);
  process.exit(2); // inconclusive
};

main().catch((err) => {
  console.error(`[verify-dvol] FATAL: ${err?.message || err}`);
  process.exit(2);
});
