/**
 * G-20 Telegram RFQ tool — the manual-venue dry-run path (production-shaped, paper-booked).
 *
 *   generate            Solve today's collar off live prices + the regime signal (auto strategy:
 *                       CALM ⟹ neutral pair · ELEVATED ⟹ directional single with the trend · HALT ⟹ skip),
 *                       print the EXACT Telegram message to paste to G-20, and save the pending RFQ.
 *   book <rfq> <net>    Book the pending RFQ at G-20's quoted NET credit (USDC per position, positive =
 *                       credited to us). Writes real OpenPosition rows (venue g20_quote) into the shadow's
 *                       open-positions ledger — they settle through the normal 24h pipeline and appear on
 *                       /positions with quoted-vs-model comparison. NO execution anywhere; paper booking.
 *   pass <rfq>          Mark a pending RFQ passed/expired (no booking).
 *   list                Show pending RFQs.
 *
 * Run: npx tsx scripts/creditCollarG20Rfq.ts generate
 *      npx tsx scripts/creditCollarG20Rfq.ts book RFQ-3 82.50
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildLiveShadowInputs, type LiveShadowConfig } from "../src/singleSide/twoSided/creditCollar/shadowRunner";
import { solveAdaptiveCreditCollar, type PerpSide } from "../src/singleSide/twoSided/creditCollar/creditCollarPricer";
import { evaluateRegimeGate } from "../src/singleSide/twoSided/creditCollar/regimeGate";
import { appendPriceObs, loadPriceHistory, computeLiveRegimeSignal, trendDirection } from "../src/singleSide/twoSided/creditCollar/priceHistoryStore";
import { loadOpenPositions, saveOpenPositions, loadSettlements } from "../src/singleSide/twoSided/creditCollar/forwardSettlementStore";
import { resolveWritablePath } from "../src/singleSide/twoSided/creditCollar/shadowStore";
import type { OpenPosition } from "../src/singleSide/twoSided/creditCollar/forwardSettlement";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);
const RFQ_PATH = process.env.G20_RFQ_PATH ?? "./logs/g20-rfqs.jsonl";

type PendingLeg = { side: PerpSide; putStrike: number; callStrike: number; modelCreditUsdc: number; floorPctUsed: number };
type PendingRfq = {
  ref: string;
  createdAtIso: string;
  spotUsd: number;
  qtyBtc: number;
  notionalUsdc: number;
  tenorDays: number;
  expiryIso: string;
  regime: string;
  strategy: string;
  legs: PendingLeg[];
  status: "pending" | "booked" | "passed";
  quotedNetUsdc?: number;
};

const loadRfqs = (): PendingRfq[] => {
  const eff = resolveWritablePath(RFQ_PATH);
  if (!existsSync(eff)) return [];
  return readFileSync(eff, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as PendingRfq);
};
const saveRfqs = (rfqs: PendingRfq[]): void => {
  writeFileSync(resolveWritablePath(RFQ_PATH), rfqs.map((r) => JSON.stringify(r)).join("\n") + (rfqs.length ? "\n" : ""), "utf8");
};

const cfg: LiveShadowConfig = {
  positionNotionalUsdc: num(process.env.SHADOW_POSITION_USDC, 50_000),
  feeUsdc: num(process.env.HARNESS_FEE_USDC, 80),
  serviceFeeBps: 0,
  minServiceFeeUsdc: 0,
  tenorDays: num(process.env.HARNESS_TENOR_DAYS, 1),
  maxFloorPct: num(process.env.HARNESS_MAX_FLOOR_PCT, 0.06),
  nPositions: 2,
  tier0CapUsdc: 2_000_000,
  breaker: { warnBandPct: 100, haltBandPct: 100, resumeBandPct: 100, minGrossNotionalUsd: 0, maxAbsNetNotionalUsd: Number.MAX_SAFE_INTEGER },
  policy: { targetNetBandPct: 0.1, allowDirectionalBias: false, directionalTiltSigned: 0 },
  bullishWeight: 0,
  settlementWindowMin: 30,
  seed: 42,
  strikeGridUsdc: num(process.env.HARNESS_STRIKE_GRID_USDC, 250),
  minCapSigmaMult: num(process.env.HARNESS_MIN_CAP_SIGMA, 1.1),
  maxRetainedNetOfFeesUsdc: num(process.env.HARNESS_MAX_RETAINED_USDC, 2),
  hedgeVenue: (["bullish", "okx", "deribit"].includes(String(process.env.SHADOW_HEDGE_VENUE ?? "okx")) ? ((process.env.SHADOW_HEDGE_VENUE ?? "okx") as "bullish" | "okx" | "deribit") : "okx"),
  adaptiveFloor: { enabled: true, maxFloorCapPct: 0.1, stepPct: 0.005 }
};

const gateCfg = {
  enabled: true,
  lookback: num(process.env.SHADOW_REGIME_LOOKBACK, 40),
  minSamples: num(process.env.SHADOW_REGIME_MIN_SAMPLES, 10),
  elevatedVolPct: num(process.env.SHADOW_REGIME_ELEVATED_VOL, 1.2),
  haltVolPct: num(process.env.SHADOW_REGIME_HALT_VOL, 3.0),
  elevatedOpenMultiplier: 0,
  elevatedFloorPct: num(process.env.SHADOW_REGIME_ELEVATED_FLOOR, 0.06),
  liveLookbackMs: num(process.env.SHADOW_REGIME_LIVE_LOOKBACK_MIN, 360) * 60_000,
  liveMinSamples: num(process.env.SHADOW_REGIME_LIVE_MIN_SAMPLES, 4)
};

const fmtUsd = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 0 });

const generate = async (): Promise<void> => {
  const built = await buildLiveShadowInputs(cfg);
  if (!built.ok) {
    console.error(`cannot build live inputs: ${built.error} — ${built.message}`);
    process.exit(1);
  }
  const { skew, spot, scaffoldConfig } = built.inputs;
  const now = Date.now();
  appendPriceObs({ tsMs: now, priceUsd: spot });

  // Regime + strategy (mirrors the auto mode in the shadow loop).
  const trailing = loadSettlements().slice(-(gateCfg.lookback ?? 40)).map((o) => Math.abs(o.movePct));
  const live = computeLiveRegimeSignal(loadPriceHistory(), now, { lookbackMs: gateCfg.liveLookbackMs, minSamples: gateCfg.liveMinSamples });
  const gate = evaluateRegimeGate(trailing, gateCfg, live?.gaugePct ?? null);
  if (gate.regime === "halt") {
    console.log(`REGIME: HALT (${gate.reason})\nNo RFQ today — the signal says sit out. This is normal.`);
    return;
  }
  const strategy = gate.regime === "calm" ? "neutral_pair" : "directional_trend";
  if (gate.floorPctOverride != null) scaffoldConfig.maxFloorPct = gate.floorPctOverride;

  const sides: PerpSide[] =
    strategy === "neutral_pair" ? ["long", "short"] : [trendDirection(loadPriceHistory(), now, gateCfg.liveLookbackMs) >= 0 ? "long" : "short"];

  const legs: PendingLeg[] = [];
  for (const side of sides) {
    const adaptive = solveAdaptiveCreditCollar(
      { side, spot, notionalUsdc: cfg.positionNotionalUsdc, tenorDays: cfg.tenorDays, targetCreditUsdc: cfg.feeUsdc, maxFloorPct: scaffoldConfig.maxFloorPct, referenceMode: "position" },
      skew,
      // Pass-through, same as the shadow's scaffold: the collar funds credit + fees only (no embedded
      // margin), and the σ-floor FLOATS the credit down on quiet tape instead of failing to price.
      { ...(scaffoldConfig.spreadConfig ?? {}), pricingModel: "pass_through", operationFeeBps: 0, minOperationFeeUsdc: 0 },
      scaffoldConfig.adaptiveFloor
    );
    if (!adaptive.quote.ok) {
      console.error(`side ${side} not priceable: ${adaptive.quote.message}`);
      process.exit(1);
    }
    legs.push({
      side,
      putStrike: adaptive.quote.legs.putStrike,
      callStrike: adaptive.quote.legs.callStrike,
      modelCreditUsdc: adaptive.quote.economics.foxify_credit_usdc,
      floorPctUsed: adaptive.floorUsedPct
    });
  }

  const rfqs = loadRfqs();
  const ref = `RFQ-${rfqs.length + 1}`;
  const qtyBtc = +(cfg.positionNotionalUsdc / spot).toFixed(4);
  // Expiry snaps to the standard 08:00 UTC daily fixing (the grid FalconX/OKX trade and the Deribit
  // reference G-20 settles on) — one settlement clock across every venue. Take the next 08:00 that is
  // at least 12h out (running at the 08:15 window ⟹ ~24h tenor, the pure product shape).
  const next8 = new Date(now);
  next8.setUTCHours(8, 0, 0, 0);
  while (next8.getTime() - now < 12 * 3_600_000) next8.setUTCDate(next8.getUTCDate() + 1);
  const expiryIso = next8.toISOString();
  const pending: PendingRfq = {
    ref,
    createdAtIso: new Date(now).toISOString(),
    spotUsd: spot,
    qtyBtc,
    notionalUsdc: cfg.positionNotionalUsdc,
    tenorDays: cfg.tenorDays,
    expiryIso,
    regime: gate.regime,
    strategy,
    legs,
    status: "pending"
  };
  rfqs.push(pending);
  saveRfqs(rfqs);

  // The exact Telegram message.
  const legLines = legs
    .map((l) => {
      const sellLeg = l.side === "long" ? `SELL ${qtyBtc} BTC CALL, strike ${fmtUsd(l.callStrike)}` : `SELL ${qtyBtc} BTC PUT, strike ${fmtUsd(l.putStrike)}`;
      const buyLeg = l.side === "long" ? `BUY  ${qtyBtc} BTC PUT, strike ${fmtUsd(l.putStrike)}` : `BUY  ${qtyBtc} BTC CALL, strike ${fmtUsd(l.callStrike)}`;
      return `Collar ${l.side.toUpperCase()} (one net price):\n  ${sellLeg}\n  ${buyLeg}`;
    })
    .join("\n");
  console.log(`── paste to G-20 ─────────────────────────────────────────────`);
  console.log(`${ref} — ${new Date(now).toISOString().slice(0, 10)}
BTC ref ~$${fmtUsd(spot)} · expiry ${expiryIso.slice(0, 16)}Z (standard daily 08:00 UTC fixing) · cash-settled USDC
${legLines}
Quote NET both ways per structure pls, validity 60s.
Reply format: ${ref} BID <net> ASK <net> VALID 60`);
  console.log(`──────────────────────────────────────────────────────────────`);
  console.log(`regime ${gate.regime} (${gate.reason})`);
  console.log(`strategy ${strategy} · model net credit: ${legs.map((l) => `${l.side} $${l.modelCreditUsdc.toFixed(2)}`).join(" · ")}`);
  console.log(`\nWhen they reply: npx tsx scripts/creditCollarG20Rfq.ts book ${ref} <their NET bid per structure>`);
};

const book = (ref: string, quotedNet: number): void => {
  const rfqs = loadRfqs();
  const rfq = rfqs.find((r) => r.ref === ref);
  if (!rfq) throw new Error(`${ref} not found — run 'list'`);
  if (rfq.status !== "pending") throw new Error(`${ref} is already ${rfq.status}`);

  const now = Date.now();
  const open = loadOpenPositions();
  for (const leg of rfq.legs) {
    const pos: OpenPosition = {
      ref: `${rfq.ref.toLowerCase()}-${leg.side}`,
      side: leg.side,
      notionalUsdc: rfq.notionalUsdc,
      spotAtEntry: rfq.spotUsd,
      putStrike: leg.putStrike,
      callStrike: leg.callStrike,
      foxifyCreditUsdc: +quotedNet.toFixed(2), // G-20's quoted net IS the funded credit (their fees embedded)
      serviceFeeUsdc: 0,
      floorPctUsed: leg.floorPctUsed,
      openFeeUsdc: 0,
      feesFundedByCollar: true,
      venue: "g20_quote",
      quoteMeta: { rfqRef: rfq.ref, quotedNetUsdc: quotedNet, modelNetUsdc: leg.modelCreditUsdc, quotedAtIso: new Date(now).toISOString() },
      openedAtMs: now,
      expiresAtMs: Date.parse(rfq.expiryIso)
    };
    open.push(pos);
    const edge = quotedNet - leg.modelCreditUsdc;
    console.log(`booked ${pos.ref}: ${leg.side} collar @ quoted net $${quotedNet.toFixed(2)} (model $${leg.modelCreditUsdc.toFixed(2)} ⟹ G-20 ${edge >= 0 ? "+" : ""}$${edge.toFixed(2)} vs model)`);
  }
  saveOpenPositions(open);
  rfq.status = "booked";
  rfq.quotedNetUsdc = quotedNet;
  saveRfqs(rfqs);
  console.log(`\n${rfq.ref} BOOKED (paper) — settles ${rfq.expiryIso.slice(0, 16)}Z through the normal pipeline; see /positions.`);
};

const main = async (): Promise<void> => {
  const [cmd, ref, net] = process.argv.slice(2);
  if (cmd === "generate") return generate();
  if (cmd === "book" && ref && net) return book(ref, Number(net));
  if (cmd === "pass" && ref) {
    const rfqs = loadRfqs();
    const rfq = rfqs.find((r) => r.ref === ref);
    if (!rfq) throw new Error(`${ref} not found`);
    rfq.status = "passed";
    saveRfqs(rfqs);
    console.log(`${ref} marked passed.`);
    return;
  }
  if (cmd === "list") {
    for (const r of loadRfqs()) console.log(`${r.ref} ${r.status} · ${r.createdAtIso.slice(0, 16)} · ${r.strategy} (${r.regime}) · legs ${r.legs.map((l) => l.side).join("+")} · model $${r.legs.map((l) => l.modelCreditUsdc.toFixed(0)).join("/$")}${r.quotedNetUsdc != null ? ` · quoted $${r.quotedNetUsdc}` : ""}`);
    return;
  }
  console.log("usage: generate | book <RFQ-n> <quotedNetUsdc> | pass <RFQ-n> | list");
};

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
