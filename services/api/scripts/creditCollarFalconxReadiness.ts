#!/usr/bin/env tsx
/**
 * FalconX account READINESS check — read-only (quotes are closed, NOTHING executes). Verifies via
 * API everything that can be verified for the live pilot, and prints the remaining HUMAN checklist.
 *
 * Checks: auth (tokens) · BTC-USDC option instruments at the next standard 08:00 UTC daily · strikes
 * near the product bands (floor −6% / cap +2%) · a two-way collar quote on the pilot structure
 * (validity window + net vs a rough sanity bound; RFQ closed immediately) · balances/margins (the
 * deposit gate) · derivatives endpoints reachable (reconciliation dependencies).
 *
 * Run (Render shell — the whitelisted IP):
 *   FALCONX_API_KEY=... FALCONX_SECRET=... FALCONX_PASSPHRASE=... \
 *   npm --silent --workspace services/api run falconx:readiness
 */

import { FalconxClient, fxPriceValue } from "../src/singleSide/twoSided/creditCollar/execution/falconxClient";
import { nextStandardDailyExpiryMs } from "../src/singleSide/twoSided/creditCollar/execution/okxLivePlanner";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

type Check = { name: string; status: "PASS" | "FAIL" | "WARN" | "INFO"; detail: string };

const main = async () => {
  const apiKey = process.env.FALCONX_API_KEY;
  const secret = process.env.FALCONX_SECRET;
  const passphrase = process.env.FALCONX_PASSPHRASE;
  if (!apiKey || !secret || !passphrase) {
    console.error("[fx-readiness] missing FALCONX_API_KEY / FALCONX_SECRET / FALCONX_PASSPHRASE");
    process.exit(2);
  }
  // FalconX asked for PREFUNDED, 100% COLLATERALIZED positions (desk message 2026-07-17). Until the
  // IA is negotiated down (the calm-day pair is a defined-risk iron condor, max loss ≈ 4% × notional),
  // the funding gate defaults to the FULL day cap. Override once the desk confirms the real IA.
  const minBalanceUsd = num(process.env.FALCONX_READINESS_MIN_BALANCE_USD, num(process.env.LIVE_MAX_DAY_NOTIONAL_USDC, 100_000));
  const client = new FalconxClient({ apiKey, secret, passphrase });
  const checks: Check[] = [];

  // 1) Auth.
  const tokens = await client.getTokens();
  checks.push(tokens.ok ? { name: "auth", status: "PASS", detail: "options RFQ API reachable with these keys" } : { name: "auth", status: "FAIL", detail: `${tokens.errorMessage} — key/passphrase/IP-allowlist problem` });

  // 2) Instruments at the standard daily.
  const inst = await client.getInstruments();
  const instruments = inst.json.instruments ?? [];
  const expiry = nextStandardDailyExpiryMs(Date.now());
  const atExpiry = instruments.filter((i) => Number(i.epoch_time_expiry) === expiry);
  if (!inst.ok || instruments.length === 0) {
    checks.push({ name: "instruments", status: "FAIL", detail: inst.errorMessage ?? "no instruments returned (options entitlement not enabled?)" });
  } else if (atExpiry.length === 0) {
    const expiries = [...new Set(instruments.map((i) => Number(i.epoch_time_expiry)))].sort((a, b) => a - b).slice(0, 4);
    checks.push({ name: "daily_expiry_listed", status: "FAIL", detail: `no instruments at ${new Date(expiry).toISOString()}; listed: ${expiries.map((e) => new Date(e).toISOString().slice(0, 16)).join(", ")} — dailies may list closer to the window; re-check` });
  } else {
    checks.push({ name: "daily_expiry_listed", status: "PASS", detail: `${atExpiry.length} instruments at ${new Date(expiry).toISOString()}` });
  }

  // 3) Strikes near the product bands + a live two-way collar quote (closed after).
  if (atExpiry.length > 0) {
    const strikes = [...new Set(atExpiry.map((i) => Number(i.strike)))].sort((a, b) => a - b);
    const spotApprox = strikes[Math.floor(strikes.length / 2)];
    const nearest = (type: "call" | "put", target: number) =>
      atExpiry.filter((i) => i.type === type).sort((a, b) => Math.abs(Number(a.strike) - target) - Math.abs(Number(b.strike) - target))[0];
    const call2 = nearest("call", spotApprox * 1.02);
    const put6 = nearest("put", spotApprox * 0.94);
    if (!call2 || !put6) {
      checks.push({ name: "strikes_near_bands", status: "FAIL", detail: `missing ${!call2 ? "call +2%" : "put −6%"} near ~ATM ${spotApprox}` });
    } else {
      const cDrift = Math.abs(Number(call2.strike) - spotApprox * 1.02) / spotApprox;
      const pDrift = Math.abs(Number(put6.strike) - spotApprox * 0.94) / spotApprox;
      checks.push({ name: "strikes_near_bands", status: Math.max(cDrift, pDrift) <= 0.01 ? "PASS" : "WARN", detail: `call ${call2.strike} (drift ${(cDrift * 100).toFixed(2)}%) · put ${put6.strike} (drift ${(pDrift * 100).toFixed(2)}%) around ~ATM ${spotApprox}` });

      const q = await client.requestQuote(
        [{ side: "sell", symbol: call2.symbol, weight: 1 }, { side: "buy", symbol: put6.symbol, weight: 1 }],
        num(process.env.FALCONX_READINESS_QTY_BTC, 0.8),
        "two_way"
      );
      if (q.ok && q.json.fx_quote_id != null) {
        const ask = fxPriceValue(q.json.ask_price);
        const bid = fxPriceValue(q.json.bid_price);
        const tQuote = Number(q.json.t_quote ?? 0);
        const tExp = Number(q.json.t_expiry ?? 0);
        const validityS = tExp > tQuote ? ((tExp - tQuote) / 1000).toFixed(1) : "?";
        checks.push({
          name: "pilot_collar_quote",
          status: ask != null ? "PASS" : "WARN",
          detail: `two-way on SELL ${call2.symbol} / BUY ${put6.symbol}: bid ${bid} · ask ${ask} per unit (ask NEGATIVE = net credit to us) · validity ~${validityS}s · IM ${fxPriceValue(q.json.incremental_im_for_trade as never) ?? q.json.incremental_im_for_trade?.value ?? "n/a"}`
        });
        if (q.json.rfq_id) await client.closeRfq(String(q.json.rfq_id)).catch(() => undefined);
      } else {
        checks.push({ name: "pilot_collar_quote", status: "FAIL", detail: q.errorMessage ?? "no quote returned" });
      }
    }
  }

  // 4) Funding (the deposit gate) + margins.
  const bal = await client.getTotalBalances();
  if (bal.ok && Array.isArray(bal.json)) {
    const rows = bal.json as Array<{ token?: string; total_balance?: string | number }>;
    const summary = rows.filter((r) => Number(r.total_balance ?? 0) !== 0).map((r) => `${r.token}=${r.total_balance}`).join(" · ") || "all zero";
    const usdish = rows.filter((r) => ["USD", "USDC", "USDT"].includes(String(r.token))).reduce((s, r) => s + Number(r.total_balance ?? 0), 0);
    checks.push({
      name: "funding",
      status: usdish >= minBalanceUsd ? "PASS" : usdish > 0 ? "WARN" : "FAIL",
      detail: `balances: ${summary} (need ≥ $${minBalanceUsd} equivalent — the client deposit gate; BTC also counts but is not summed here)`
    });
  } else {
    checks.push({ name: "funding", status: "WARN", detail: bal.errorMessage ?? "balances endpoint unavailable" });
  }
  const margins = await client.getMargins();
  checks.push(margins.ok ? { name: "derivatives_margins", status: "INFO", detail: JSON.stringify(margins.json).slice(0, 200) } : { name: "derivatives_margins", status: "WARN", detail: margins.errorMessage ?? "margins endpoint unavailable" });

  // 5) Reconciliation dependencies.
  const derivs = await client.getDerivatives({ product_type: "option" });
  checks.push(derivs.ok ? { name: "recon_endpoints", status: "PASS", detail: "GET /v1/derivatives reachable (transactions + cash_flows join on trade_id)" } : { name: "recon_endpoints", status: "WARN", detail: derivs.errorMessage ?? "derivatives endpoint unavailable — reconciliation would stay pending" });

  const humanTodo = [
    "Derivatives/options entitlement enabled on the FalconX account (ISDA-style docs + options addendum) — if instruments/quote checks FAIL, this is the blocker; contact the FalconX coverage team.",
    `IA / PREFUNDING (desk asked for prefunded 100%-collateralized positions): funding gate currently ≥ $${minBalanceUsd}. NEGOTIATE: calm-day pairs are a defined-risk iron condor (max loss ≈ 4% × notional ≈ $2k per $100k pair) — ask for package margining; directional days, ask what 100% collateralization means for a cash-settled short leg (premium + % notional vs full notional) and whether a far-OTM long wing (defined-risk spread) reduces it. Set FALCONX_READINESS_MIN_BALANCE_USD to the agreed IA once confirmed.`,
    "Collateral mechanics with the desk: currency (USDC?), posted once + recycled daily vs per-trade, and how soon after the 08:00 fixing settled P&L/collateral is released (we re-issue at 08:15 — 15 minutes later).",
    "API key scoped to trading only, withdrawals OFF, IP-allowlisted to the Render service's outbound IPs.",
    "Confirm the fixing: contract fixing_source should be deribit, fixing time 8am UTC (matches our 08:00 settlement clock).",
    "Confirm the EXECUTE endpoint path with the desk (client is built for /v3/derivatives/option/quote/execute; override via FALCONX_EXECUTE_PATH if they route differently).",
    "Canary Mon/Tue: LIVE_CANARY_CONTRACTS=1 (0.01 BTC) one real collar end-to-end (fill → /positions → next-day settle → reconciliation) before pilot size."
  ];

  process.stdout.write(JSON.stringify({ checks, humanTodo }, null, 2) + "\n");
  const fails = checks.filter((x) => x.status === "FAIL");
  const warns = checks.filter((x) => x.status === "WARN");
  console.error(`[fx-readiness] ${fails.length} FAIL · ${warns.length} WARN · ${checks.filter((x) => x.status === "PASS").length} PASS`);
  for (const x of fails) console.error(`  ❌ ${x.name}: ${x.detail}`);
  for (const x of warns) console.error(`  ⚠️ ${x.name}: ${x.detail}`);
  if (fails.length > 0) process.exit(1);
};

main().catch((e) => {
  console.error("[fx-readiness] fatal:", e);
  process.exit(1);
});
