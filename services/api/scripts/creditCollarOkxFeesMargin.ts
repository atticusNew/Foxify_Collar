#!/usr/bin/env tsx
/**
 * OKX fees + margin PROBE — READ-ONLY (places NO orders, moves NO capital).
 *
 * Pulls your ACTUAL options fee tier (GET /account/trade-fee) and runs a 50k 24h asymmetric collar
 * through OKX's Portfolio-Margin Position Builder (POST /account/position-builder — a simulator that
 * can never place/cancel an order), for BOTH:
 *   - the UNMATCHED single collar  (long put −4%, short call +2%)  → conservative, one-sided margin
 *   - the MATCHED long+short book  (+ long call +4%, short put −2%) → the netted "minimal margin"
 *     (a long ±4% strangle vs a short ±2% strangle = defined-risk; this is where PM relief shows).
 *
 * Usage (Render shell):
 *   OKX_API_KEY=... OKX_API_SECRET=... OKX_API_PASSPHRASE=... \
 *   [OKX_PROBE_MODE=live] [OKX_PROBE_NOTIONAL_USDC=50000] [OKX_PROBE_TENOR_HOURS=24] \
 *   npm --silent --workspace services/api run okx:fees-margin
 *
 * Defaults to LIVE to read your real PM tier (mirrors okx:auth-probe's read-only live check). It is
 * read-only: the only POST is the margin simulator. Set OKX_PROBE_MODE=demo if your keys are demo keys.
 */

import { OkxExecutionClient, type OkxMode } from "../src/singleSide/twoSided/creditCollar/execution/okxExecutionClient";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

type ChainItem = { instId: string; optType: "C" | "P"; stk: number; expTime: number; ctVal: number };

const main = async () => {
  const apiKey = process.env.OKX_API_KEY;
  const secret = process.env.OKX_API_SECRET;
  const passphrase = process.env.OKX_API_PASSPHRASE;
  if (!apiKey || !secret || !passphrase) {
    console.error("[okx-fm] missing OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE");
    process.exit(2);
  }
  const mode: OkxMode = process.env.OKX_PROBE_MODE === "demo" ? "demo" : "live";
  const notional = num(process.env.OKX_PROBE_NOTIONAL_USDC, 50_000);
  const floorPct = num(process.env.OKX_PROBE_FLOOR_PCT, 0.04);
  const capPct = num(process.env.OKX_PROBE_CAP_PCT, 0.02);
  const tenorHours = num(process.env.OKX_PROBE_TENOR_HOURS, 24);

  const client = new OkxExecutionClient({ apiKey, secret, passphrase, mode });
  const out: Record<string, unknown> = { mode, notionalUsdc: notional, floorPct, capPct, tenorHours };

  // 1) Account config — acctLv 4 = portfolio margin (needed for the long legs to offset the short legs).
  const cfg = await client.getAccountConfig();
  const acctLv = cfg.data?.[0]?.acctLv ?? "?";
  out.accountConfig = { ok: cfg.ok, code: cfg.code, msg: cfg.msg, acctLv };

  // 2) Your real options fee tier.
  const fee = await client.getTradeFee("OPTION");
  out.tradeFee = { ok: fee.ok, code: fee.code, msg: fee.msg, data: fee.data?.[0] };

  // 3) Spot (index) to anchor the strikes.
  const idx = await client.getIndexPrice("BTC-USD");
  const spot = Number(idx.data?.[0]?.idxPx ?? 0);
  out.spotUsd = spot;
  if (!(spot > 0)) {
    out.error = "no_index_price";
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return;
  }

  // 4) Option chain → expiry nearest now+tenorHours, then nearest strikes to each target.
  const chainResp = await client.getOptionChain("BTC-USD");
  const now = Date.now();
  const chain: ChainItem[] = (chainResp.data ?? [])
    .filter((c) => c.instId && c.stk && c.expTime && (c.optType === "C" || c.optType === "P"))
    .map((c) => ({ instId: c.instId as string, optType: c.optType as "C" | "P", stk: Number(c.stk), expTime: Number(c.expTime), ctVal: Number(c.ctVal ?? 1) }))
    .filter((c) => c.expTime > now + 3_600_000 && Number.isFinite(c.stk) && c.stk > 0);
  if (chain.length === 0) {
    out.error = `no_option_instruments (chain code ${chainResp.code} ${chainResp.msg})`;
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return;
  }
  const targetExpMs = now + tenorHours * 3_600_000;
  const exp = [...new Set(chain.map((c) => c.expTime))].sort((a, b) => Math.abs(a - targetExpMs) - Math.abs(b - targetExpMs))[0];
  const atExp = chain.filter((c) => c.expTime === exp);
  const ctVal = atExp[0]?.ctVal || 1;
  out.chosenExpiry = { expiryIso: new Date(exp).toISOString(), hoursOut: +((exp - now) / 3.6e6).toFixed(1), ctVal, strikesAvailable: atExp.length };

  const pick = (type: "C" | "P", target: number): ChainItem | null =>
    atExp.filter((x) => x.optType === type).sort((a, b) => Math.abs(a.stk - target) - Math.abs(b.stk - target))[0] ?? null;

  const put4 = pick("P", spot * (1 - floorPct)); // long  — long-client protective floor
  const call2 = pick("C", spot * (1 + capPct)); // short — long-client funding cap
  const call4 = pick("C", spot * (1 + floorPct)); // long  — short-client protective ceiling
  const put2 = pick("P", spot * (1 - capPct)); // short — short-client funding floor
  out.legs = { put4, call2, call4, put2 };
  if (!put4 || !call2 || !call4 || !put2) {
    out.error = "could_not_resolve_all_strikes";
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return;
  }

  const targetBtc = notional / spot;

  // Mark price per leg = the simulated entry (avgPx) Position Builder requires. Mark first, then book mid.
  const avgPxOf = async (instId: string): Promise<string> => {
    const mk = await client.getMarkPrice(instId);
    const m = Number(mk.data?.[0]?.markPx ?? 0);
    if (m > 0) return String(m);
    const bk = await client.getBookTop(instId);
    const bid = Number(bk.data?.[0]?.bids?.[0]?.[0] ?? 0);
    const ask = Number(bk.data?.[0]?.asks?.[0]?.[0] ?? 0);
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;
    return String(mid > 0 ? mid : 0.0001); // nonzero so OKX accepts it; entry barely affects scenario margin
  };
  const [pxPut4, pxCall2, pxCall4, pxPut2] = await Promise.all([
    avgPxOf(put4.instId), avgPxOf(call2.instId), avgPxOf(call4.instId), avgPxOf(put2.instId)
  ]);
  out.markPx = { put4: pxPut4, call2: pxCall2, call4: pxCall4, put2: pxPut2 };

  const pb = async (label: string, simPos: Array<{ instId: string; pos: string; avgPx: string }>) => {
    const r = await client.positionBuilder(simPos);
    return { label, ok: r.ok, code: r.code, msg: r.msg, simPos, result: (r.data?.[0] ?? {}) as Record<string, unknown> };
  };
  const portfoliosOf = (res: Record<string, unknown>): Array<{ instId?: string; notionalUsd?: string }> =>
    ((res.riskUnitData as Array<{ portfolios?: Array<{ instId?: string; notionalUsd?: string }> }> | undefined)?.[0]?.portfolios) ?? [];

  // Calibrate the REAL contract size from the simulator's own notionalUsd (OKX's ctVal/ctMult units are
  // unreliable for these instruments). 1-contract probe → per-contract notional → right contract count.
  const calib = await pb("calibration (1 put contract)", [{ instId: put4.instId, pos: "1", avgPx: pxPut4 }]);
  const perContractNotional = Number(portfoliosOf(calib.result).find((p) => p.instId === put4.instId)?.notionalUsd ?? 0);
  const perContractBtc = perContractNotional > 0 && put4.stk > 0 ? perContractNotional / put4.stk : 0.01;
  const contracts = Math.max(1, Math.round(targetBtc / perContractBtc));
  out.contractsPerLeg = {
    targetBtc: +targetBtc.toFixed(4),
    reportedCtVal: ctVal,
    perContractBtc: +perContractBtc.toFixed(5),
    contracts,
    note: "contracts sized from the simulator's notionalUsd, not the (unreliable) ctVal field"
  };

  // 5) Position Builder — unmatched single collar vs matched long+short book, at the calibrated size.
  const single = [
    { instId: put4.instId, pos: String(contracts), avgPx: pxPut4 },   // long put −4%
    { instId: call2.instId, pos: String(-contracts), avgPx: pxCall2 } // short call +2%
  ];
  const pair = [
    ...single,
    { instId: call4.instId, pos: String(contracts), avgPx: pxCall4 }, // long call +4%
    { instId: put2.instId, pos: String(-contracts), avgPx: pxPut2 }   // short put −2%
  ];

  const unmatched = await pb("unmatched: long put −4% + short call +2%", single);
  const matched = await pb("matched: + long call +4% + short put −2% (defined-risk)", pair);
  out.positionBuilder = { unmatched_single_collar: unmatched, matched_long_short_book: matched };

  // Readable summary: IM as $ and %-of-notional, plus the PM netting factor (matched-per-position ÷ unmatched).
  const numOf = (res: Record<string, unknown>, k: string) => Number((res[k] as string | undefined) ?? 0);
  const posNotional = contracts * perContractNotional; // one collar's protected notional (≈ target)
  const uImr = numOf(unmatched.result, "totalImr");
  const mImr = numOf(matched.result, "totalImr");
  out.imSummary = {
    perPositionNotionalUsd: +posNotional.toFixed(0),
    unmatched: { imrUsd: +uImr.toFixed(2), mmrUsd: +numOf(unmatched.result, "totalMmr").toFixed(2), imrPctOfNotional: posNotional > 0 ? +((uImr / posNotional) * 100).toFixed(2) : null },
    matchedPair: { totalImrUsd: +mImr.toFixed(2), imrPerPositionUsd: +(mImr / 2).toFixed(2), imrPctOfNotionalPerPosition: posNotional > 0 ? +(((mImr / 2) / posNotional) * 100).toFixed(2) : null },
    pmNettingFactor: uImr > 0 ? +((mImr / 2) / uImr).toFixed(3) : null
  };

  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  const f = fee.data?.[0];
  console.error(`[okx-fm] acctLv=${acctLv} (4 = portfolio margin) · option fee maker=${f?.maker} taker=${f?.taker} · spot=${spot}`);
  console.error("[okx-fm] read positionBuilder.*.result for the margin fields (imr/mmr/…). acctLv must be 4 for true PM netting.");
  if (!cfg.ok || !fee.ok) console.error(`[okx-fm] ⚠️ a private call failed (config ${cfg.code}/${cfg.msg}, fee ${fee.code}/${fee.msg}) — check creds/mode (try OKX_PROBE_MODE=demo).`);
};

main().catch((e) => {
  console.error("[okx-fm] fatal:", e);
  process.exit(1);
});
