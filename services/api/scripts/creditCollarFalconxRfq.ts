/**
 * FalconX daily RFQ tool — the GTM twin of creditCollarG20Rfq.ts, driven by their Options RFQ API
 * instead of Telegram. Same strategy brain (regime gate → CALM pair / ELEVATED directional / HALT skip),
 * same paper booking into the shadow ledger — but the quote comes back from FalconX's desk in seconds.
 *
 *   quote               Solve today's structure(s), map strikes to FalconX's live instrument grid
 *                       (standard 08:00 UTC dailies), request the collar as ONE two-way RFQ, print
 *                       their net vs our model, save the pending record. Read-only; RFQs closed after.
 *   book <ref> <net>    Paper-book at FalconX's quoted net (venue falconx_quote) — settles through the
 *                       normal pipeline, appears on /positions with quoted-vs-model.
 *   pass <ref> · list   Same semantics as the G-20 tool.
 *
 * Env: FALCONX_API_KEY / FALCONX_SECRET / FALCONX_PASSPHRASE (required; put them in Render env)
 *      + the usual HARNESS_*/SHADOW_* pilot settings (defaults match the shadow).
 *
 * NOTE: their quotes are firm ~5s — the printed quote will have expired by the time you read it. For the
 * paper pilot that's fine (we book at the observed level). Live execution later = re-quote + execute
 * within validity via /quote/execute (not wired here; deliberately quote-only).
 */

import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildLiveShadowInputs, type LiveShadowConfig } from "../src/singleSide/twoSided/creditCollar/shadowRunner";
import { solveAdaptiveCreditCollar, type PerpSide } from "../src/singleSide/twoSided/creditCollar/creditCollarPricer";
import { evaluateRegimeGate } from "../src/singleSide/twoSided/creditCollar/regimeGate";
import { loadGateState } from "../src/singleSide/twoSided/creditCollar/regimeGateStore";
import { appendPriceObs, loadPriceHistory, computeLiveRegimeSignal, trendDirection } from "../src/singleSide/twoSided/creditCollar/priceHistoryStore";
import { loadOpenPositions, saveOpenPositions } from "../src/singleSide/twoSided/creditCollar/forwardSettlementStore";
import { loadSettlements } from "../src/singleSide/twoSided/creditCollar/forwardSettlementStore";
import { resolveWritablePath } from "../src/singleSide/twoSided/creditCollar/shadowStore";
import type { OpenPosition } from "../src/singleSide/twoSided/creditCollar/forwardSettlement";

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);
const RFQ_PATH = process.env.FALCONX_RFQ_PATH ?? "./logs/falconx-rfqs.jsonl";
const BASE = process.env.FALCONX_BASE_URL || "https://api.falconx.io";

// ── FalconX signed request ────────────────────────────────────────────────────
const fxRequest = async (path: string, method: "GET" | "POST", body: Record<string, unknown> | null): Promise<any> => {
  const ts = String(Date.now() / 1000);
  const payload = body ? JSON.stringify(body) : "";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "FX-ACCESS-KEY": process.env.FALCONX_API_KEY || "",
      "FX-ACCESS-SIGN": createHmac("sha256", Buffer.from(process.env.FALCONX_SECRET || "", "base64")).update(`${ts}${method}${path}${payload}`).digest("base64"),
      "FX-ACCESS-TIMESTAMP": ts,
      "FX-ACCESS-PASSPHRASE": process.env.FALCONX_PASSPHRASE || ""
    },
    body: body ? payload : undefined
  });
  return res.json();
};

// ── pending-RFQ store (same shape as the G-20 tool, separate file) ───────────
type PendingLeg = { side: PerpSide; putStrike: number; callStrike: number; modelCreditUsdc: number; floorPctUsed: number; fxCallSymbol: string; fxPutSymbol: string; fxQuotedNetUsdc?: number | null };
type PendingRfq = { ref: string; createdAtIso: string; spotUsd: number; qtyBtc: number; notionalUsdc: number; expiryIso: string; regime: string; strategy: string; legs: PendingLeg[]; status: "pending" | "booked" | "passed"; quotedNetUsdc?: number };
const loadRfqs = (): PendingRfq[] => {
  const eff = resolveWritablePath(RFQ_PATH);
  return existsSync(eff) ? readFileSync(eff, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as PendingRfq) : [];
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
  hedgeVenue: "okx",
  adaptiveFloor: { enabled: true, maxFloorCapPct: 0.1, stepPct: 0.005 }
};
const gateCfg = {
  enabled: true,
  lookback: num(process.env.SHADOW_REGIME_LOOKBACK, 40),
  minSamples: num(process.env.SHADOW_REGIME_MIN_SAMPLES, 10),
  elevatedVolPct: num(process.env.SHADOW_REGIME_ELEVATED_VOL, 1.2),
  haltVolPct: num(process.env.SHADOW_REGIME_HALT_VOL, 3.0),
  elevatedOpenMultiplier: 0,
  elevatedFloorPct: num(process.env.SHADOW_REGIME_ELEVATED_FLOOR, 0.1),
  liveLookbackMs: num(process.env.SHADOW_REGIME_LIVE_LOOKBACK_MIN, 360) * 60_000,
  liveMinSamples: num(process.env.SHADOW_REGIME_LIVE_MIN_SAMPLES, 4),
  hysteresisExitRatio: num(process.env.SHADOW_REGIME_HYSTERESIS, 0.85)
};

type FxInstrument = { strike: string; epoch_time_expiry: string; type: "call" | "put"; symbol: string };

const nextDailyExpiry = (nowMs: number): number => {
  const d = new Date(nowMs);
  d.setUTCHours(8, 0, 0, 0);
  while (d.getTime() - nowMs < 12 * 3_600_000) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
};

const quote = async (): Promise<void> => {
  if (!process.env.FALCONX_API_KEY) {
    console.error("Set FALCONX_API_KEY / FALCONX_SECRET / FALCONX_PASSPHRASE (Render env).");
    process.exit(1);
  }
  const built = await buildLiveShadowInputs(cfg);
  if (!built.ok) {
    console.error(`cannot build live inputs: ${built.error} — ${built.message}`);
    process.exit(1);
  }
  const { skew, spot, scaffoldConfig } = built.inputs;
  const now = Date.now();
  appendPriceObs({ tsMs: now, priceUsd: spot });

  // Strategy (same brain as the shadow's auto mode, with persisted-gate hysteresis).
  const trailing = loadSettlements().slice(-(gateCfg.lookback ?? 40)).map((o) => Math.abs(o.movePct));
  const live = computeLiveRegimeSignal(loadPriceHistory(), now, { lookbackMs: gateCfg.liveLookbackMs, minSamples: gateCfg.liveMinSamples });
  const gate = evaluateRegimeGate(trailing, gateCfg, live?.gaugePct ?? null, loadGateState()?.regime ?? null);
  if (gate.regime === "halt") {
    console.log(`REGIME: HALT (${gate.reason}) — no issuance today.`);
    return;
  }
  const strategy = gate.regime === "calm" ? "neutral_pair" : "directional_trend";
  if (gate.floorPctOverride != null) scaffoldConfig.maxFloorPct = gate.floorPctOverride;
  const sides: PerpSide[] = strategy === "neutral_pair" ? ["long", "short"] : [trendDirection(loadPriceHistory(), now, gateCfg.liveLookbackMs) >= 0 ? "long" : "short"];

  // FalconX live grid at the standard daily expiry.
  const inst = await fxRequest("/v3/derivatives/option/instruments", "POST", { token_pair: { base_token: "BTC", quote_token: "USDC" } });
  const instruments: FxInstrument[] = Array.isArray(inst?.instruments) ? inst.instruments : [];
  if (!instruments.length) {
    console.error(`no instruments from FalconX: ${JSON.stringify(inst?.error ?? inst).slice(0, 200)}`);
    process.exit(1);
  }
  const targetExpiry = nextDailyExpiry(now);
  const atExpiry = instruments.filter((i) => Number(i.epoch_time_expiry) === targetExpiry);
  if (!atExpiry.length) {
    console.error(`FalconX lists no instruments at ${new Date(targetExpiry).toISOString()} — expiries: ${[...new Set(instruments.map((i) => i.epoch_time_expiry))].slice(0, 5).join(",")}`);
    process.exit(1);
  }
  const nearest = (type: "call" | "put", target: number) =>
    atExpiry.filter((i) => i.type === type).reduce((b, i) => (Math.abs(Number(i.strike) - target) < Math.abs(Number(b.strike) - target) ? i : b));

  const rfqs = loadRfqs();
  const ref = `FX-${rfqs.length + 1}`;
  const qtyBtc = +(cfg.positionNotionalUsdc / spot).toFixed(4);
  const legs: PendingLeg[] = [];

  console.log(`${ref} · spot ~$${Math.round(spot).toLocaleString()} · expiry ${new Date(targetExpiry).toISOString().slice(0, 16)}Z · regime ${gate.regime} → ${strategy}\n`);

  for (const side of sides) {
    const adaptive = solveAdaptiveCreditCollar(
      { side, spot, notionalUsdc: cfg.positionNotionalUsdc, tenorDays: cfg.tenorDays, targetCreditUsdc: cfg.feeUsdc, maxFloorPct: scaffoldConfig.maxFloorPct, referenceMode: "position" },
      skew,
      { ...(scaffoldConfig.spreadConfig ?? {}), pricingModel: "pass_through", operationFeeBps: 0, minOperationFeeUsdc: 0 },
      scaffoldConfig.adaptiveFloor
    );
    if (!adaptive.quote.ok) {
      console.error(`side ${side} not priceable: ${adaptive.quote.message}`);
      continue;
    }
    const q = adaptive.quote;
    // Map model strikes to FalconX's grid; the funding leg we SELL, the protective leg we BUY.
    const callInst = nearest("call", q.legs.callStrike);
    const putInst = nearest("put", q.legs.putStrike);
    const structure =
      side === "long"
        ? [{ side: "sell", symbol: callInst.symbol, weight: 1 }, { side: "buy", symbol: putInst.symbol, weight: 1 }]
        : [{ side: "sell", symbol: putInst.symbol, weight: 1 }, { side: "buy", symbol: callInst.symbol, weight: 1 }];

    const resp = await fxRequest("/v3/derivatives/option/quote", "POST", {
      token_pair: { base_token: "BTC", quote_token: "USDC" },
      quantity: qtyBtc,
      side: "two_way",
      structure,
      client_order_id: randomUUID()
    });
    const err = resp?.error ? ` · err ${resp.error.code}` : "";
    console.log(`${side.toUpperCase()} collar: SELL ${side === "long" ? callInst.symbol : putInst.symbol} / BUY ${side === "long" ? putInst.symbol : callInst.symbol}`);
    console.log(`  FalconX: bid ${resp?.bid_price ?? resp?.legs?.map((l: any) => `${l.side}:${l.bid_price ?? "-"}`).join(" ") ?? "n/a"} · ask ${resp?.ask_price ?? "n/a"} · mark ${resp?.mark_price ?? "n/a"} · IM ${resp?.incremental_im_for_trade?.value ?? "n/a"}${err}`);
    console.log(`  model net credit: $${q.economics.foxify_credit_usdc.toFixed(2)}\n`);
    if (resp?.rfq_id) await fxRequest("/v3/derivatives/option/quote/close_rfq", "POST", { rfq_id: resp.rfq_id });
    legs.push({ side, putStrike: Number(putInst.strike), callStrike: Number(callInst.strike), modelCreditUsdc: q.economics.foxify_credit_usdc, floorPctUsed: adaptive.floorUsedPct, fxCallSymbol: callInst.symbol, fxPutSymbol: putInst.symbol, fxQuotedNetUsdc: resp?.bid_price != null ? Number(resp.bid_price) : null });
  }
  if (!legs.length) return;

  rfqs.push({ ref, createdAtIso: new Date(now).toISOString(), spotUsd: spot, qtyBtc, notionalUsdc: cfg.positionNotionalUsdc, expiryIso: new Date(targetExpiry).toISOString(), regime: gate.regime, strategy, legs, status: "pending" });
  saveRfqs(rfqs);
  console.log(`Saved ${ref}. Book at their net with: npx tsx scripts/creditCollarFalconxRfq.ts book ${ref} <netUsdcPerStructure>`);
};

const book = (ref: string, quotedNet: number): void => {
  const rfqs = loadRfqs();
  const rfq = rfqs.find((r) => r.ref === ref);
  if (!rfq) throw new Error(`${ref} not found — run 'list'`);
  if (rfq.status !== "pending") throw new Error(`${ref} is already ${rfq.status}`);
  const now = Date.now();
  const open = loadOpenPositions();
  for (const leg of rfq.legs) {
    open.push({
      ref: `${rfq.ref.toLowerCase()}-${leg.side}`,
      side: leg.side,
      notionalUsdc: rfq.notionalUsdc,
      spotAtEntry: rfq.spotUsd,
      putStrike: leg.putStrike,
      callStrike: leg.callStrike,
      foxifyCreditUsdc: +quotedNet.toFixed(2),
      serviceFeeUsdc: 0,
      floorPctUsed: leg.floorPctUsed,
      openFeeUsdc: 0,
      feesFundedByCollar: true,
      venue: "falconx_quote",
      quoteMeta: { rfqRef: rfq.ref, quotedNetUsdc: quotedNet, modelNetUsdc: leg.modelCreditUsdc, quotedAtIso: new Date(now).toISOString() },
      openedAtMs: now,
      expiresAtMs: Date.parse(rfq.expiryIso)
    } as OpenPosition);
    console.log(`booked ${rfq.ref.toLowerCase()}-${leg.side} @ net $${quotedNet.toFixed(2)} (model $${leg.modelCreditUsdc.toFixed(2)} ⟹ FalconX ${(quotedNet - leg.modelCreditUsdc) >= 0 ? "+" : ""}$${(quotedNet - leg.modelCreditUsdc).toFixed(2)} vs model)`);
  }
  saveOpenPositions(open);
  rfq.status = "booked";
  rfq.quotedNetUsdc = quotedNet;
  saveRfqs(rfqs);
  console.log(`${rfq.ref} BOOKED (paper) — settles ${rfq.expiryIso.slice(0, 16)}Z; see /positions.`);
};

const main = async (): Promise<void> => {
  const [cmd, ref, net] = process.argv.slice(2);
  if (cmd === "quote") return quote();
  if (cmd === "book" && ref && net) return book(ref, Number(net));
  if (cmd === "pass" && ref) {
    const rfqs = loadRfqs();
    const rfq = rfqs.find((r) => r.ref === ref);
    if (!rfq) throw new Error(`${ref} not found`);
    rfq.status = "passed";
    saveRfqs(rfqs);
    console.log(`${ref} passed.`);
    return;
  }
  if (cmd === "list") {
    for (const r of loadRfqs()) console.log(`${r.ref} ${r.status} · ${r.createdAtIso.slice(0, 16)} · ${r.strategy} (${r.regime}) · legs ${r.legs.map((l) => l.side).join("+")} · model $${r.legs.map((l) => l.modelCreditUsdc.toFixed(0)).join("/$")}${r.quotedNetUsdc != null ? ` · quoted $${r.quotedNetUsdc}` : ""}`);
    return;
  }
  console.log("usage: quote | book <FX-n> <netUsdc> | pass <FX-n> | list");
};

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
