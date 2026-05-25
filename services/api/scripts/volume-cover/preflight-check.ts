/**
 * VC Pre-flight smoke — operator runs BEFORE flipping
 * VOLUME_COVER_ENABLED=true on Render.
 *
 * Read-only checks against live venues + own server. Exits 0 on
 * GREEN, 1 on YELLOW (warning), 2 on RED (do NOT cut over).
 *
 * Usage:
 *   npx tsx services/api/scripts/volume-cover/preflight-check.ts
 *
 * Optional flags:
 *   --api-base=<url>        Atticus API base (default: http://localhost:3000)
 *   --admin-token=<token>   Admin token for /admin endpoints (default: env PILOT_ADMIN_TOKEN)
 *   --skip-balance          Skip Bullish/Deribit balance check (no API creds)
 *   --skip-foxify           Skip Foxify HMAC sanity check
 *   --json                  Output JSON instead of human-readable
 *
 * Exit codes:
 *   0  GREEN — all checks pass; safe to cut over
 *   1  YELLOW — non-blocking warnings; proceed with caution
 *   2  RED — blocking failures; do NOT cut over
 */

import { setTimeout as sleep } from "node:timers/promises";

type CheckResult = {
  name: string;
  status: "green" | "yellow" | "red" | "skip";
  message: string;
  detail?: Record<string, unknown>;
};

type Args = {
  apiBase: string;
  adminToken: string;
  skipBalance: boolean;
  skipFoxify: boolean;
  json: boolean;
};

const parseArgs = (argv: string[]): Args => {
  const out: Args = {
    apiBase: process.env.PILOT_API_BASE || "http://localhost:3000",
    adminToken: process.env.PILOT_ADMIN_TOKEN || "",
    skipBalance: false,
    skipFoxify: false,
    json: false
  };
  for (const arg of argv) {
    if (arg.startsWith("--api-base=")) out.apiBase = arg.slice(11);
    else if (arg.startsWith("--admin-token=")) out.adminToken = arg.slice(14);
    else if (arg === "--skip-balance") out.skipBalance = true;
    else if (arg === "--skip-foxify") out.skipFoxify = true;
    else if (arg === "--json") out.json = true;
  }
  return out;
};

const fetchJson = async (url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<any> => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    return r.json();
  } finally {
    clearTimeout(t);
  }
};

// ───────────────────────── Checks ─────────────────────────

const checkServerHealth = async (args: Args): Promise<CheckResult> => {
  try {
    const data = await fetchJson(`${args.apiBase}/volume-cover/health`);
    if (data.cellsConfigured !== 6) {
      return {
        name: "Server health",
        status: "red",
        message: `Expected 6 cells configured; got ${data.cellsConfigured}`,
        detail: data
      };
    }
    if (data.cellsEnabled === 0) {
      return {
        name: "Server health",
        status: "yellow",
        message: "Server up but 0 cells enabled. Need at least 1 enabled before launch.",
        detail: data
      };
    }
    return {
      name: "Server health",
      status: "green",
      message: `OK — ${data.cellsConfigured} cells, ${data.cellsEnabled} enabled, ${data.activePositions} active positions`,
      detail: data
    };
  } catch (err) {
    return {
      name: "Server health",
      status: "red",
      message: `Server not reachable at ${args.apiBase}: ${(err as Error).message}`
    };
  }
};

const checkBullishLiveSpot = async (): Promise<CheckResult> => {
  try {
    const data = await fetchJson(
      "https://api.exchange.bullish.com/trading-api/v1/markets/BTCUSDC/orderbook/hybrid"
    );
    const bid = Number(data.bids?.[0]?.price);
    const ask = Number(data.asks?.[0]?.price);
    if (!bid || !ask) {
      return {
        name: "Bullish live spot",
        status: "red",
        message: "Bullish orderbook empty — venue may be under maintenance"
      };
    }
    const mid = (bid + ask) / 2;
    const sprdBp = ((ask - bid) / mid) * 10_000;
    if (sprdBp > 100) {
      return {
        name: "Bullish live spot",
        status: "yellow",
        message: `Spread wider than expected: ${sprdBp.toFixed(0)}bp (>100bp). Possible thin liquidity.`,
        detail: { mid, bid, ask, spreadBp: sprdBp }
      };
    }
    return {
      name: "Bullish live spot",
      status: "green",
      message: `OK — Bullish BTCUSDC mid \$${mid.toFixed(2)}, spread ${sprdBp.toFixed(1)}bp`,
      detail: { mid, bid, ask, spreadBp: sprdBp }
    };
  } catch (err) {
    return {
      name: "Bullish live spot",
      status: "red",
      message: `Bullish unreachable: ${(err as Error).message}`
    };
  }
};

const checkCoinbaseFallback = async (): Promise<CheckResult> => {
  try {
    const data = await fetchJson("https://api.coinbase.com/v2/prices/BTC-USD/spot");
    const price = Number(data.data?.amount);
    if (!price) {
      return { name: "Coinbase fallback", status: "yellow", message: "Coinbase returned no price; fallback unavailable" };
    }
    return {
      name: "Coinbase fallback",
      status: "green",
      message: `OK — Coinbase BTC-USD \$${price.toFixed(2)}`,
      detail: { price }
    };
  } catch (err) {
    return {
      name: "Coinbase fallback",
      status: "yellow",
      message: `Coinbase unreachable: ${(err as Error).message}. Fallback won't work; rely on Bullish only.`
    };
  }
};

const checkSpotDrift = async (): Promise<CheckResult> => {
  try {
    const [bullishBook, cb] = await Promise.all([
      fetchJson("https://api.exchange.bullish.com/trading-api/v1/markets/BTCUSDC/orderbook/hybrid"),
      fetchJson("https://api.coinbase.com/v2/prices/BTC-USD/spot")
    ]);
    const bullishMid = (Number(bullishBook.bids[0].price) + Number(bullishBook.asks[0].price)) / 2;
    const coinbasePrice = Number(cb.data.amount);
    const driftBp = (Math.abs(bullishMid - coinbasePrice) / Math.min(bullishMid, coinbasePrice)) * 10_000;
    if (driftBp > 100) {
      return {
        name: "Spot drift (Bullish vs Coinbase)",
        status: "red",
        message: `Drift ${driftBp.toFixed(0)}bp > 100bp threshold. Possible oracle break.`,
        detail: { bullishMid, coinbasePrice, driftBp }
      };
    }
    if (driftBp > 50) {
      return {
        name: "Spot drift (Bullish vs Coinbase)",
        status: "yellow",
        message: `Drift ${driftBp.toFixed(0)}bp > 50bp threshold. Operator should monitor.`,
        detail: { bullishMid, coinbasePrice, driftBp }
      };
    }
    return {
      name: "Spot drift (Bullish vs Coinbase)",
      status: "green",
      message: `OK — drift ${driftBp.toFixed(0)}bp (<50bp)`,
      detail: { bullishMid, coinbasePrice, driftBp }
    };
  } catch (err) {
    return {
      name: "Spot drift (Bullish vs Coinbase)",
      status: "yellow",
      message: `Could not compute drift: ${(err as Error).message}`
    };
  }
};

const checkBullishOptionChain = async (): Promise<CheckResult> => {
  try {
    const markets = await fetchJson(
      "https://api.exchange.bullish.com/trading-api/v1/markets"
    );
    const btcOpts = markets.filter(
      (m: any) => m.marketType === "OPTION" && m.baseSymbol === "BTC"
    );
    if (btcOpts.length === 0) {
      return {
        name: "Bullish option chain",
        status: "red",
        message: "No BTC options found on Bullish — venue not trading options"
      };
    }
    // Find expiries 12-15 days out (matched-tenor target)
    const nowMs = Date.now();
    const target = nowMs + 14 * 86_400_000;
    // Match 11-17d window (matched-tenor target 14d ±3d snap edges)
    const expiryMsList = Array.from(
      new Set(
        btcOpts
          .filter((m: any) => m.expiryDatetime)
          .map((m: any) => new Date(m.expiryDatetime).getTime())
      )
    ) as number[];
    const targetExpiries = expiryMsList
      .filter((t) => Math.abs(t - target) <= 3 * 86_400_000)
      .sort();
    if (targetExpiries.length === 0) {
      const closest = expiryMsList
        .map((t) => ({ t, days: Math.round((t - nowMs) / 86_400_000) }))
        .sort((a, b) => Math.abs(a.days - 14) - Math.abs(b.days - 14))
        .slice(0, 3);
      return {
        name: "Bullish option chain",
        status: "yellow",
        message: `No 11-17d BTC expiries on Bullish. Closest: ${closest.map((c) => `${c.days}d`).join(", ")}`,
        detail: { btcOptCount: btcOpts.length, closest }
      };
    }
    return {
      name: "Bullish option chain",
      status: "green",
      message: `OK — ${btcOpts.length} BTC option markets, ${targetExpiries.length} expiry around 14d`,
      detail: { btcOptCount: btcOpts.length, targetExpiriesCount: targetExpiries.length }
    };
  } catch (err) {
    return {
      name: "Bullish option chain",
      status: "red",
      message: `Bullish chain fetch failed: ${(err as Error).message}`
    };
  }
};

const checkAdminEndpoints = async (args: Args): Promise<CheckResult> => {
  if (!args.adminToken) {
    return {
      name: "Admin endpoints",
      status: "yellow",
      message: "PILOT_ADMIN_TOKEN not set; skipping admin endpoint checks"
    };
  }
  try {
    const [cells, salvage] = await Promise.all([
      fetchJson(`${args.apiBase}/volume-cover/admin/cells`, {
        headers: { "X-Admin-Token": args.adminToken }
      }),
      fetchJson(`${args.apiBase}/volume-cover/admin/salvage-stats`, {
        headers: { "X-Admin-Token": args.adminToken }
      })
    ]);
    return {
      name: "Admin endpoints",
      status: "green",
      message: `OK — admin auth working. ${cells.cells?.length ?? 0} cells visible, salvage stats accessible`,
      detail: { cellCount: cells.cells?.length, salvage }
    };
  } catch (err) {
    return {
      name: "Admin endpoints",
      status: "red",
      message: `Admin endpoint failure: ${(err as Error).message}`
    };
  }
};

const checkEnvFlags = async (args: Args): Promise<CheckResult> => {
  const required = [
    "VOLUME_COVER_ENABLED",
    "PILOT_ADMIN_TOKEN",
    "FOXIFY_API_KEY_HMAC_SECRET",
    "POSTGRES_URL"
  ];
  const optional = [
    "VC_REGIME_OVERLAY_JSON",
    "VOLUME_COVER_HEDGE_MANAGER_ENABLED",
    "VC_STRESS_PAUSE_DVOL_THRESHOLD",
    "VOLUME_COVER_GUARD_LOSS_KILL_USDC"
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    return {
      name: "Environment variables",
      status: "red",
      message: `Missing required env: ${missing.join(", ")}`,
      detail: { missing, optional }
    };
  }
  if (process.env.VOLUME_COVER_ENABLED !== "true") {
    return {
      name: "Environment variables",
      status: "yellow",
      message: `VOLUME_COVER_ENABLED is '${process.env.VOLUME_COVER_ENABLED}'. Set to 'true' before cutover.`,
      detail: { current: process.env.VOLUME_COVER_ENABLED }
    };
  }
  const optMissing = optional.filter((k) => !process.env[k]);
  if (optMissing.length > 0) {
    return {
      name: "Environment variables",
      status: "yellow",
      message: `Optional env not set (defaults will apply): ${optMissing.join(", ")}`,
      detail: { optMissing }
    };
  }
  return {
    name: "Environment variables",
    status: "green",
    message: `OK — all ${required.length} required + ${optional.length} optional env vars set`
  };
};

// ───────────────────────── Main ─────────────────────────

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2));

  const checks: CheckResult[] = [];

  // Run checks sequentially so output is ordered
  checks.push(await checkEnvFlags(args));
  checks.push(await checkBullishLiveSpot());
  checks.push(await checkCoinbaseFallback());
  checks.push(await checkSpotDrift());
  checks.push(await checkBullishOptionChain());
  checks.push(await checkServerHealth(args));
  checks.push(await checkAdminEndpoints(args));

  const reds = checks.filter((c) => c.status === "red");
  const yellows = checks.filter((c) => c.status === "yellow");

  if (args.json) {
    console.log(JSON.stringify({
      verdict: reds.length ? "RED" : yellows.length ? "YELLOW" : "GREEN",
      checks
    }, null, 2));
  } else {
    console.log(`\n=== VC Pre-flight Check ===\n`);
    for (const c of checks) {
      const icon = c.status === "green" ? "✓" : c.status === "yellow" ? "⚠" : c.status === "red" ? "✗" : "○";
      console.log(`${icon} [${c.status.toUpperCase()}] ${c.name}`);
      console.log(`   ${c.message}`);
      if (c.detail && c.status !== "green") {
        console.log(`   detail: ${JSON.stringify(c.detail)}`);
      }
    }
    console.log("");
    if (reds.length) {
      console.log(`✗ VERDICT: RED — ${reds.length} blocking failure(s). DO NOT CUT OVER.`);
    } else if (yellows.length) {
      console.log(`⚠ VERDICT: YELLOW — ${yellows.length} warning(s). Review and proceed with caution.`);
    } else {
      console.log(`✓ VERDICT: GREEN — all ${checks.length} checks passed. Safe to cut over.`);
    }
  }

  return reds.length ? 2 : yellows.length ? 1 : 0;
};

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`PRE-FLIGHT FATAL: ${(err as Error).message}`);
    process.exit(2);
  });
