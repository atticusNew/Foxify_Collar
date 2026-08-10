#!/usr/bin/env tsx
/**
 * OKX account READINESS check — read-only (places NO orders, moves NO capital). Verifies via API
 * everything that can be verified for the live pilot, and prints the remaining HUMAN checklist.
 *
 * Checks: auth · account level (portfolio margin) · options activation/permission · API key scope
 * (trade yes / withdraw NO) · funding (≥ recommended equity, BTC collateral visibility) · options
 * fee tier · next 08:00 UTC daily listed with 0.01-BTC contracts · strike grid + top-of-book around
 * the product strikes (floor −6%, cap +2%).
 *
 * Run (Render shell — the whitelisted IP):
 *   OKX_API_KEY=... OKX_API_SECRET=... OKX_API_PASSPHRASE=... \
 *   npm --silent --workspace services/api run okx:readiness
 */

import { OkxExecutionClient, type OkxMode } from "../src/singleSide/twoSided/creditCollar/execution/okxExecutionClient";
import { parseOkxChain, nextStandardDailyExpiryMs, contractsForNotional } from "../src/singleSide/twoSided/creditCollar/execution/okxLivePlanner";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

type Check = { name: string; status: "PASS" | "FAIL" | "WARN" | "INFO"; detail: string };

const main = async () => {
  const apiKey = process.env.OKX_API_KEY;
  const secret = process.env.OKX_API_SECRET;
  const passphrase = process.env.OKX_API_PASSPHRASE;
  if (!apiKey || !secret || !passphrase) {
    console.error("[okx-readiness] missing OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE");
    process.exit(2);
  }
  const mode: OkxMode = process.env.OKX_PROBE_MODE === "demo" ? "demo" : "live";
  const notional = num(process.env.LIVE_MAX_POSITION_USDC, 50_000);
  const minEquityUsd = num(process.env.OKX_READINESS_MIN_EQUITY_USD, 10_000);
  const client = new OkxExecutionClient({ apiKey, secret, passphrase, mode });
  const checks: Check[] = [];

  // 1) Auth.
  const bal = await client.getBalance();
  checks.push(bal.ok ? { name: "auth", status: "PASS", detail: "private API reachable with these keys" } : { name: "auth", status: "FAIL", detail: `${bal.code}: ${bal.msg} — key/passphrase/IP-whitelist problem` });

  // 2) Account config: level, options permission, key scope.
  const cfg = await client.getAccountConfig();
  const c = cfg.data?.[0] ?? {};
  const acctLv = String(c.acctLv ?? "?");
  checks.push(
    acctLv === "4"
      ? { name: "portfolio_margin", status: "PASS", detail: "acctLv=4 (portfolio margin) — PM netting applies" }
      : acctLv === "3"
        ? { name: "portfolio_margin", status: "WARN", detail: "acctLv=3 (multi-ccy margin): options tradeable but NO PM netting — margin ~13× worse ($7k vs $546/position). Upgrade to PM before pilot size." }
        : { name: "portfolio_margin", status: "FAIL", detail: `acctLv=${acctLv} — cannot trade options. Request portfolio margin (acctLv 4).` }
  );
  const perm = String(c.perm ?? "");
  checks.push(perm.includes("trade") ? { name: "key_trade_scope", status: "PASS", detail: `key permissions: ${perm}` } : { name: "key_trade_scope", status: "FAIL", detail: `key permissions '${perm}' lack trade scope` });
  checks.push(
    perm.includes("withdraw")
      ? { name: "key_withdrawals_off", status: "FAIL", detail: "API key has WITHDRAW permission — recreate it trade-only" }
      : { name: "key_withdrawals_off", status: "PASS", detail: "no withdraw permission on this key" }
  );
  if (c.opAuth != null) {
    checks.push(String(c.opAuth) === "1" ? { name: "options_activated", status: "PASS", detail: "options trading activated (opAuth=1)" } : { name: "options_activated", status: "WARN", detail: `opAuth=${c.opAuth} — run okx:activate-option` });
  }

  // 3) Funding.
  const totalEq = Number(bal.data?.[0]?.totalEq ?? 0);
  checks.push(
    totalEq >= minEquityUsd
      ? { name: "funding", status: "PASS", detail: `total equity ≈ $${totalEq.toFixed(0)} (≥ $${minEquityUsd} recommended)` }
      : { name: "funding", status: totalEq > 0 ? "WARN" : "FAIL", detail: `total equity ≈ $${totalEq.toFixed(0)} < recommended $${minEquityUsd}` }
  );
  const details = (bal.data?.[0]?.details ?? []) as Array<{ ccy?: string; eq?: string; availEq?: string }>;
  const btcRow = details.find((d) => d.ccy === "BTC");
  checks.push({
    name: "collateral_currency",
    status: "INFO",
    detail: btcRow
      ? `BTC balance visible: eq=${btcRow.eq} avail=${btcRow.availEq}. COIN-MARGINED options settle premiums/margin in BTC; on acctLv 3/4 other currencies also collateralize (haircut applies) — verify the margin-currency waterfall on the first canary fill.`
      : `no BTC balance row — options premiums/margin settle in BTC; fund BTC or confirm multi-currency collateral covers OPTION margin (acctLv ${acctLv}).`
  });

  // 4) Fee tier.
  const fee = await client.getTradeFee("OPTION");
  const f = fee.data?.[0];
  checks.push(fee.ok ? { name: "option_fee_tier", status: "INFO", detail: `maker=${f?.maker} taker=${f?.taker} (level ${f?.level ?? "?"})` } : { name: "option_fee_tier", status: "WARN", detail: `${fee.code}: ${fee.msg}` });

  // 5) Instruments: next 08:00 UTC daily, lot size, strikes near the product bands.
  const idx = await client.getIndexPrice("BTC-USD");
  const spot = Number(idx.data?.[0]?.idxPx ?? 0);
  const chainResp = await client.getOptionChain("BTC-USD");
  const chain = parseOkxChain(chainResp.data ?? []);
  const expiry = nextStandardDailyExpiryMs(Date.now());
  const atExpiry = chain.filter((x) => x.expiryMs === expiry && x.state === "live");
  if (atExpiry.length === 0) {
    checks.push({ name: "daily_expiry_listed", status: "FAIL", detail: `no live instruments at ${new Date(expiry).toISOString()} — dailies list ~24h ahead; re-check near the window` });
  } else {
    const ctVal = atExpiry[0].ctValBtc;
    const sizing = spot > 0 ? contractsForNotional(notional, spot, ctVal) : null;
    checks.push({ name: "daily_expiry_listed", status: "PASS", detail: `${atExpiry.length} live instruments at ${new Date(expiry).toISOString()} · ctVal ${ctVal} BTC${sizing ? ` · $${notional} ⟹ ${sizing.contracts} contracts (eff $${sizing.effectiveNotionalUsdc})` : ""}` });
    if (spot > 0) {
      const near = (type: "put" | "call", target: number) =>
        atExpiry.filter((x) => x.optType === type).sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))[0];
      const put6 = near("put", spot * 0.94);
      const call2 = near("call", spot * 1.02);
      for (const [label, inst] of [["floor put −6%", put6], ["cap call +2%", call2]] as const) {
        if (!inst) {
          checks.push({ name: `strike_${label}`, status: "FAIL", detail: "no listed strike near the target" });
          continue;
        }
        const book = await client.getBookTop(inst.instId);
        const top = book.data?.[0];
        const bid = Number(top?.bids?.[0]?.[0] ?? 0);
        const ask = Number(top?.asks?.[0]?.[0] ?? 0);
        const drift = Math.abs(inst.strike - (label.includes("put") ? spot * 0.94 : spot * 1.02)) / spot;
        checks.push({
          name: `strike_${label.replace(/\s/g, "_")}`,
          status: bid > 0 && ask > 0 ? "PASS" : "WARN",
          detail: `${inst.instId} (drift ${(drift * 100).toFixed(2)}% of spot) book ${bid}/${ask} BTC${bid > 0 && ask > 0 ? "" : " — one-sided/empty book, check at the window"}`
        });
      }
    }
  }

  const humanTodo = [
    "PORTFOLIO MARGIN approved (acctLv=4) — CRITICAL PATH; isolated is ~13× worse ($7k vs $546 per position). If check above ≠ PASS, request PM upgrade in OKX account settings NOW.",
    "API key: trade scope only, withdrawals OFF (verified above), IP-whitelisted to the Render service's outbound IPs (Render dashboard → service → Outbound IPs; add all listed).",
    `Funding: ≥ $${minEquityUsd} equivalent on the trading account. Premiums/margin for coin-margined options are BTC-denominated — hold some BTC or confirm multi-currency collateral covers OPTION margin (watch the first canary fill's margin currency).`,
    "Keys live in Render env vars ONLY (OKX_API_KEY/SECRET/PASSPHRASE) — never in code, logs, or chat.",
    "Canary Mon/Tue: LIVE_CANARY_CONTRACTS=1..5 one real collar end-to-end (fill → /positions → next-day settle → reconciliation) before pilot size."
  ];

  process.stdout.write(JSON.stringify({ mode, spotUsd: spot, checks, humanTodo }, null, 2) + "\n");
  const fails = checks.filter((x) => x.status === "FAIL");
  const warns = checks.filter((x) => x.status === "WARN");
  console.error(`[okx-readiness] ${fails.length} FAIL · ${warns.length} WARN · ${checks.filter((x) => x.status === "PASS").length} PASS`);
  for (const x of fails) console.error(`  ❌ ${x.name}: ${x.detail}`);
  for (const x of warns) console.error(`  ⚠️ ${x.name}: ${x.detail}`);
  if (fails.length > 0) process.exit(1);
};

main().catch((e) => {
  console.error("[okx-readiness] fatal:", e);
  process.exit(1);
});
