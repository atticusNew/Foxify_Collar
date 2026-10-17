#!/usr/bin/env tsx
/**
 * PM MARGIN PROBE (Phase 3) — measure the real margin per wrap; recalibrate every cap.
 *
 * Modes:
 *   builder (default) — OKX position-builder what-if: simulate the two collar legs at current
 *                       listed strikes (~6% put / ~1.5% call, EP_PROBE_LOTS lots) as ONE portfolio
 *                       and read the netted-spread IMR. Zero capital risk; also VERIFIES that both
 *                       legs margin as a netted spread under PM (a spread IMR far below the naked
 *                       short-leg IMR is the confirmation).
 *   live              — realized: sum IMR across live option positions ÷ open wrapped notional
 *                       from the wrap store. Ground truth during the week-one run.
 *
 * Requires OKX credentials (trade-key, withdrawals disabled) + OKX_REST_BASE (egress proxy).
 * Appends measurements to logs/ep-margin-probe.jsonl and prints the EP_MARGIN_RATE recommendation.
 *
 *   OKX_API_KEY=… OKX_API_SECRET=… OKX_API_PASSPHRASE=… npx tsx services/api/scripts/epMarginProbe.ts [builder|live]
 */

import { appendFileSync } from "node:fs";
import { OkxExecutionClient } from "../src/singleSide/twoSided/creditCollar/execution/okxExecutionClient";
import { parseLiveGuardsFromEnv } from "../src/singleSide/twoSided/creditCollar/execution/liveGuards";
import { parseOkxChain } from "../src/singleSide/twoSided/creditCollar/execution/okxLivePlanner";
import { resolveWritablePath } from "../src/singleSide/twoSided/creditCollar/shadowStore";
import { parseCapsInputsFromEnv } from "../src/singleSide/twoSided/creditCollar/capsConfig";
import { loadDemoWraps, wrapExposureUsdc, OKX_OPTION_LOT_BTC, demoPlanStrikes, DEMO_FLOOR_PCT, DEMO_CAP_PCT } from "../src/singleSide/twoSided/creditCollar/demoWrap";
import {
  measureMarginRate,
  parsePositionBuilderImrUsd,
  renderMarginRecommendation,
  sumLivePositionsImrUsd
} from "../src/singleSide/twoSided/creditCollar/epMarginMeasure";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

const main = async (): Promise<void> => {
  const mode = (process.argv[2] ?? "builder") as "builder" | "live";
  const { OKX_API_KEY: k, OKX_API_SECRET: s, OKX_API_PASSPHRASE: p } = process.env;
  if (!k || !s || !p) {
    console.error("[margin-probe] OKX credentials missing (OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE)");
    process.exit(1);
  }
  const caps = parseCapsInputsFromEnv(process.env);
  const client = new OkxExecutionClient({ apiKey: k, secret: s, passphrase: p, mode: parseLiveGuardsFromEnv(process.env, "okx").mode });

  let imrUsd: number | null = null;
  let notionalUsd = 0;

  if (mode === "builder") {
    const lots = num(process.env.EP_PROBE_LOTS, 3);
    const [chainRes, idxRes] = await Promise.all([client.getOptionChain("BTC-USD"), client.getIndexPrice("BTC-USD")]);
    const spot = Number(idxRes.data?.[0]?.idxPx);
    if (!chainRes.ok || !Number.isFinite(spot)) {
      console.error("[margin-probe] chain/index fetch failed — check OKX_REST_BASE and credentials");
      process.exit(1);
    }
    const chain = parseOkxChain(chainRes.data ?? []);
    const plan = demoPlanStrikes(spot, "long", DEMO_FLOOR_PCT, DEMO_CAP_PCT);
    // Nearest listed strikes to the plan on the front expiry.
    const front = Math.min(...chain.map((c) => c.expiryMs).filter((e) => e > Date.now()));
    const nearest = (target: number, optType: "put" | "call") =>
      chain
        .filter((c) => c.expiryMs === front && c.optType === optType)
        .sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))[0];
    const put = nearest(plan.putStrike, "put");
    const call = nearest(plan.callStrike, "call");
    if (!put || !call) {
      console.error("[margin-probe] no listed strikes near the plan — book too thin right now");
      process.exit(1);
    }
    console.error(`[margin-probe] simulating ${lots} lots: LONG ${put.instId} + SHORT ${call.instId} (netted spread under PM)`);
    const sim = await client.positionBuilder(
      [
        { instId: put.instId, pos: String(lots), avgPx: "0" },
        { instId: call.instId, pos: String(-lots), avgPx: "0" }
      ],
      false
    );
    imrUsd = parsePositionBuilderImrUsd(sim.data);
    notionalUsd = lots * OKX_OPTION_LOT_BTC * spot;
    if (imrUsd == null) {
      console.error(`[margin-probe] position-builder response not readable — raw: ${JSON.stringify(sim.data)?.slice(0, 400)}`);
      console.error("[margin-probe] (position-builder requires portfolio-margin account level — check acctLv via getAccountConfig)");
      process.exit(1);
    }
  } else {
    const [posRes] = await Promise.all([client.getPositions("OPTION")]);
    imrUsd = sumLivePositionsImrUsd(posRes.data ?? []);
    const records = loadDemoWraps(process.env.DEMO_STORE_PATH ?? "./logs/demo-wraps.json");
    notionalUsd = records
      .filter((r) => r.status === "active" && r.hedge?.mode !== "paper")
      .reduce((sum, r) => sum + wrapExposureUsdc(r), 0);
    if (imrUsd == null || !(notionalUsd > 0)) {
      console.error(`[margin-probe] live mode needs open live wraps (imr=${imrUsd}, wrapped notional=$${notionalUsd})`);
      process.exit(1);
    }
  }

  const m = measureMarginRate(mode, imrUsd, notionalUsd, caps.subAccountCapitalUsdc, caps.headroomPct, Date.now());
  if (!m) {
    console.error("[margin-probe] degenerate measurement — not recording");
    process.exit(1);
  }
  appendFileSync(resolveWritablePath(process.env.EP_MARGIN_PROBE_PATH ?? "./logs/ep-margin-probe.jsonl"), JSON.stringify(m) + "\n", "utf8");
  console.error(renderMarginRecommendation(m, caps.marginPerWrapRate));
};

void main().catch((e) => {
  console.error(`[margin-probe] FAILED: ${(e as Error).message}`);
  process.exit(1);
});
