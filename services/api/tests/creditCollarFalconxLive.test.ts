import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FalconxClient, signFalconx, fxPriceValue, type FxFetcher } from "../src/singleSide/twoSided/creditCollar/execution/falconxClient";
import {
  parseFalconxSymbol,
  planFalconxCollar,
  quotedNetCreditUsdc,
  quoteWithinBand
} from "../src/singleSide/twoSided/creditCollar/execution/falconxLivePlanner";
import {
  executeFalconxCollar,
  unwindFalconxCollar,
  reconcileFalconxSettlements,
  buildFalconxLiveExecutionHook
} from "../src/singleSide/twoSided/creditCollar/execution/falconxLiveRunner";
import { parseLiveGuardsFromEnv, executionArmed } from "../src/singleSide/twoSided/creditCollar/execution/liveGuards";
import { loadLiveExecutions, loadWindowState } from "../src/singleSide/twoSided/creditCollar/execution/liveExecutionStore";
import type { SettlementOutcome } from "../src/singleSide/twoSided/creditCollar/forwardSettlement";
import type { RegimeGateDecision } from "../src/singleSide/twoSided/creditCollar/regimeGate";
import type { SolveSide } from "../src/singleSide/twoSided/creditCollar/execution/liveWindowRunner";

// ── Fixtures ──────────────────────────────────────────────────────────────────
const NOW = Date.UTC(2026, 6, 22, 8, 20, 0); // inside the 08:15–10:00 window
const EXPIRY = Date.UTC(2026, 6, 23, 8, 0, 0); // next 08:00 UTC daily ≥12h out
const SPOT = 100_000;

const sym = (strike: number, t: "C" | "P") => `BTC-USDC-23JUL26-${strike}.0-${t}`;
const instruments = [94_000, 98_000].map((k) => ({ strike: `${k}`, epoch_time_expiry: String(EXPIRY), type: "put" as const, symbol: sym(k, "P") }))
  .concat([102_000, 106_000].map((k) => ({ strike: `${k}`, epoch_time_expiry: String(EXPIRY), type: "call" as const, symbol: sym(k, "C") })));

/**
 * Scripted FalconX venue via the real client's injected fetcher. Behaviors per endpoint:
 *  quotes: a queue of { ask, bid, failExecute?, noQuote? } consumed per /quote call.
 */
type QuoteBehavior = { ask?: number; bid?: number; noQuote?: boolean; failExecute?: string };
const makeVenue = (quotes: QuoteBehavior[], extras: { transactions?: Record<string, unknown[]>; cashFlows?: unknown[]; positions?: unknown[] } = {}) => {
  const calls: Array<{ path: string; body: any }> = [];
  let quoteSeq = 0;
  const behaviors = new Map<string, QuoteBehavior>();
  const fetcher: FxFetcher = async (url, init) => {
    const path = url.replace("https://api.falconx.io", "").split("?")[0];
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, body });
    const reply = (json: unknown, status = 200) => ({ status, text: async () => JSON.stringify(json) });

    if (path === "/v3/derivatives/option/tokens") return reply({ token_pairs: [{ base_token: "BTC", quote_token: "USDC" }] });
    if (path === "/v3/derivatives/option/instruments") return reply({ instruments });
    if (path === "/v3/derivatives/option/quote") {
      const b = quotes[quoteSeq] ?? { noQuote: true };
      quoteSeq += 1;
      if (b.noQuote) return reply({ error: { code: "NO_LIQUIDITY", message: "no quote available" } }, 400);
      const id = `q${quoteSeq}`;
      behaviors.set(id, b);
      return reply({
        status: "success",
        rfq_id: `r${quoteSeq}`,
        fx_quote_id: id,
        ask_price: { value: String(b.ask ?? 0) },
        bid_price: { value: String(b.bid ?? 0) },
        t_quote: String(NOW),
        t_expiry: String(NOW + 5000),
        legs: (body?.structure ?? []).map((l: { side: string; symbol: string }) => ({ side: l.side, symbol: l.symbol, ask_price: { value: "120" }, bid_price: { value: "60" } }))
      });
    }
    if (path === "/v3/derivatives/option/quote/execute") {
      const b = behaviors.get(String(body?.fx_quote_id));
      if (b?.failExecute) return reply({ error: { code: b.failExecute, message: "not executed" } }, 400);
      return reply({ status: "success", fx_quote_id: body?.fx_quote_id, trade_id: `OPT-trade-${body?.fx_quote_id}` });
    }
    if (path === "/v3/derivatives/option/quote/close_rfq") return reply({ status: "closed" });
    if (path.startsWith("/v1/derivatives/option/positions")) return reply(extras.positions ?? []);
    if (path.startsWith("/v1/derivatives/cash_flows")) return reply(extras.cashFlows ?? []);
    if (/^\/v1\/derivatives\/[^/]+\/transactions$/.test(path)) {
      const tradeId = path.split("/")[3];
      return reply(extras.transactions?.[tradeId] ?? []);
    }
    if (path.startsWith("/v1/derivatives")) return reply([]);
    if (path.startsWith("/v1/balances")) return reply([{ token: "USD", total_balance: "6000" }]);
    return reply({ error: { code: "NOT_FOUND", message: path } }, 404);
  };
  const client = new FalconxClient({ apiKey: "k", secret: Buffer.from("secret").toString("base64"), passphrase: "p" }, fetcher);
  return { client, calls };
};

const basePlanInput = {
  side: "long" as const,
  spot: SPOT,
  notionalUsdc: 50_000,
  putStrike: 94_000,
  callStrike: 102_000,
  protectiveMidUsdc: 60,
  fundingMidUsdc: 145,
  modelContractsBtc: 0.5,
  nowMs: NOW
};

// ── Client basics ─────────────────────────────────────────────────────────────

test("falconx: signature = HMAC-SHA256(base64-decoded secret) over ts+METHOD+path+body", () => {
  const sig = signFalconx("1700000000", "POST", "/v3/derivatives/option/quote", "{}", Buffer.from("secret").toString("base64"));
  assert.equal(sig, signFalconx("1700000000", "post", "/v3/derivatives/option/quote", "{}", Buffer.from("secret").toString("base64")));
  assert.notEqual(sig, signFalconx("1700000001", "POST", "/v3/derivatives/option/quote", "{}", Buffer.from("secret").toString("base64")));
});

test("falconx: fxPriceValue handles {value}, string, number, null", () => {
  assert.equal(fxPriceValue({ value: "-98.5" }), -98.5);
  assert.equal(fxPriceValue("-98.5"), -98.5);
  assert.equal(fxPriceValue(3), 3);
  assert.equal(fxPriceValue(null), null);
  assert.equal(fxPriceValue({ value: "nope" }), null);
});

// ── Planner (pure) ────────────────────────────────────────────────────────────

test("falconx planner: parses symbols (expiry 08:00 UTC)", () => {
  const p = parseFalconxSymbol("BTC-USDC-23JUL26-94000.0-P");
  assert.ok(p);
  assert.equal(p!.strike, 94_000);
  assert.equal(p!.optType, "put");
  assert.equal(p!.expiryMs, EXPIRY);
  assert.equal(parseFalconxSymbol("BTC-USDC-23XXX26-94000.0-P"), null);
  assert.equal(parseFalconxSymbol("ETH-USDC-23JUL26-3000.0-C"), null);
});

test("falconx planner: long side sells the call / buys the put as ONE structure, qty in plain BTC", () => {
  const r = planFalconxCollar(instruments, basePlanInput);
  assert.ok(r.ok);
  const p = r.ok ? r.plan : null!;
  assert.equal(p.qtyBtc, 0.5);
  assert.equal(p.effectiveNotionalUsdc, 50_000);
  assert.deepEqual(p.structure, [
    { side: "sell", symbol: sym(102_000, "C"), weight: 1 },
    { side: "buy", symbol: sym(94_000, "P"), weight: 1 }
  ]);
  assert.equal(p.modelMidNetUsdc, 85); // (145 − 60) × 0.5/0.5
  assert.equal(p.expiryMs, EXPIRY);
});

test("falconx planner: short side mirrors (sell put / buy call)", () => {
  const r = planFalconxCollar(instruments, { ...basePlanInput, side: "short", putStrike: 98_000, callStrike: 106_000 });
  assert.ok(r.ok);
  const p = r.ok ? r.plan : null!;
  assert.deepEqual(p.structure, [
    { side: "sell", symbol: sym(98_000, "P"), weight: 1 },
    { side: "buy", symbol: sym(106_000, "C"), weight: 1 }
  ]);
});

test("falconx planner: fail-closed on missing expiry / excessive drift / canary qty override", () => {
  assert.equal((planFalconxCollar([], basePlanInput) as { error: string }).error, "expiry_not_listed");
  const sparse = instruments.filter((i) => i.type === "put" || Number(i.strike) >= 106_000);
  assert.equal((planFalconxCollar(sparse, basePlanInput) as { error: string }).error, "strike_drift_too_large");
  const canary = planFalconxCollar(instruments, { ...basePlanInput, qtyBtcOverride: 0.01 });
  assert.ok(canary.ok);
  assert.equal(canary.ok ? canary.plan.qtyBtc : 0, 0.01);
  assert.equal(canary.ok ? canary.plan.effectiveNotionalUsdc : 0, 1_000);
  assert.equal(canary.ok ? canary.plan.modelMidNetUsdc : 0, 1.7); // scales with qty
});

test("falconx planner: quoted net + structure-level band", () => {
  assert.equal(quotedNetCreditUsdc(-160, 0.5), 80); // ask −160/unit × 0.5 BTC ⟹ +$80 credit
  assert.equal(quotedNetCreditUsdc(null, 0.5), null);
  // model mid 85, band 25% ⟹ allowed shortfall 21.25
  assert.ok(quoteWithinBand(70, 85, 0.25).ok);        // shortfall 15
  assert.ok(!quoteWithinBand(60, 85, 0.25).ok);       // shortfall 25
  assert.ok(quoteWithinBand(100, 85, 0.25).ok);       // better than mid always ok
  assert.ok(quoteWithinBand(-2, 1, 0.25, 5).ok);      // tiny mids use the absolute floor
});

// ── Guards: FalconX has no demo ───────────────────────────────────────────────

test("falconx guards: always real money — arming requires FALCONX_LIVE_CONFIRM", () => {
  const noConfirm = parseLiveGuardsFromEnv({ LIVE_ENABLED: "true" }, "falconx");
  assert.equal(noConfirm.mode, "live");
  const armed1 = executionArmed(noConfirm);
  assert.equal(armed1.armed, false);
  assert.ok(armed1.reason.includes("FALCONX_LIVE_CONFIRM"));
  const confirmed = parseLiveGuardsFromEnv({ LIVE_ENABLED: "true", FALCONX_LIVE_CONFIRM: "I_UNDERSTAND_REAL_MONEY" }, "falconx");
  assert.ok(executionArmed(confirmed).armed);
});

// ── Executor ──────────────────────────────────────────────────────────────────

const mkPlan = () => {
  const r = planFalconxCollar(instruments, basePlanInput);
  assert.ok(r.ok);
  return r.ok ? r.plan : null!;
};

test("falconx executor: quote → band check → execute; books real net credit + trade ids", async () => {
  const { client, calls } = makeVenue([{ ask: -160, bid: -180 }]); // net credit $80 vs model mid $85 — inside band
  const r = await executeFalconxCollar(client, mkPlan(), { bandPct: 0.25 });
  assert.equal(r.outcome, "filled");
  assert.equal(r.netCreditUsdc, 80);
  assert.deepEqual(r.tradeIds, ["OPT-trade-q1"]);
  assert.equal(r.protectivePremiumUsdc, 60); // BUY leg at its ask 120 × 0.5
  assert.equal(r.fundingPremiumUsdc, 30);    // SELL leg at its bid 60 × 0.5
  // Executed within validity: quote then execute, no close.
  assert.ok(calls.some((c) => c.path.endsWith("/quote/execute") && c.body.fx_quote_id === "q1" && c.body.side === "buy"));
});

test("falconx executor: quote outside the band ⟹ close RFQ, re-quote once, then abort (day skipped)", async () => {
  const { client, calls } = makeVenue([{ ask: -100 }, { ask: -110 }]); // credits $50/$55 vs mid $85, allowed 21.25 ⟹ both outside
  const r = await executeFalconxCollar(client, mkPlan(), { bandPct: 0.25 });
  assert.equal(r.outcome, "aborted_band");
  assert.equal(r.netCreditUsdc, null);
  assert.equal(calls.filter((c) => c.path.endsWith("/close_rfq")).length, 2); // nothing left dangling
  assert.equal(calls.filter((c) => c.path.endsWith("/quote/execute")).length, 0); // never executed
});

test("falconx executor: execute failure (quote expired) re-quotes once, then aborts SAFELY", async () => {
  const { client } = makeVenue([{ ask: -160, failExecute: "QUOTE_EXPIRED" }, { ask: -160, failExecute: "NO_VALID_EXECUTABLE_QUOTE" }]);
  const r = await executeFalconxCollar(client, mkPlan(), { bandPct: 0.25 });
  assert.equal(r.outcome, "aborted_execute_failed");
  assert.equal(r.safe, true); // an RFQ structure can never leave a naked leg
  assert.equal(r.errors.length, 2);
});

test("falconx executor: no quote at all ⟹ aborted_no_quote", async () => {
  const { client } = makeVenue([{ noQuote: true }, { noQuote: true }]);
  const r = await executeFalconxCollar(client, mkPlan(), { bandPct: 0.25 });
  assert.equal(r.outcome, "aborted_no_quote");
});

// ── Unwind ────────────────────────────────────────────────────────────────────

const livePos = () => ({
  ref: "cc-live-1-long",
  side: "long" as const,
  notionalUsdc: 50_000,
  spotAtEntry: SPOT,
  putStrike: 94_000,
  callStrike: 102_000,
  foxifyCreditUsdc: 80,
  serviceFeeUsdc: 0,
  floorPctUsed: 0.06,
  openedAtMs: NOW,
  expiresAtMs: EXPIRY,
  venue: "falconx_live",
  liveMeta: {
    putInstId: sym(94_000, "P"),
    callInstId: sym(102_000, "C"),
    contracts: 0.5,
    ctValBtc: 1,
    mode: "live" as const,
    protectiveFillPxBtc: 0,
    fundingFillPxBtc: 0,
    venueFeeUsdc: 0,
    fxQuoteId: "q1",
    fxTradeIds: ["OPT-trade-q1"]
  }
});

test("falconx unwind: REVERSE structure as one trade (buy back call, sell put)", async () => {
  const { client, calls } = makeVenue([{ ask: 90 }]); // unwinding costs $45 for 0.5 BTC
  const r = await unwindFalconxCollar(client, livePos());
  assert.ok(r.complete);
  assert.equal(r.unwindValueUsdc, -45);
  const quoteCall = calls.find((c) => c.path.endsWith("/option/quote"));
  assert.deepEqual(quoteCall?.body.structure, [
    { side: "buy", symbol: sym(102_000, "C"), weight: 1 },
    { side: "sell", symbol: sym(94_000, "P"), weight: 1 }
  ]);
});

test("falconx unwind: execute failure ⟹ rides to expiry, fully hedged, nothing half-closed", async () => {
  const { client } = makeVenue([{ ask: 90, failExecute: "QUOTE_EXPIRED" }]);
  const r = await unwindFalconxCollar(client, livePos());
  assert.equal(r.complete, false);
  assert.equal(r.unwindValueUsdc, null);
  assert.ok(r.notes.some((n) => n.includes("rides to expiry")));
});

// ── Reconciliation ────────────────────────────────────────────────────────────

const settledOutcome = (over: Partial<SettlementOutcome> = {}): SettlementOutcome =>
  ({
    ref: "cc-live-1-long",
    side: "long",
    notionalUsdc: 50_000,
    spotAtEntry: SPOT,
    settlePriceUsd: 93_000,
    movePct: -0.07,
    putIntrinsicUsd: 500,
    callIntrinsicUsd: 0,
    payoutToFoxifyUsdc: 500,
    foxifyCreditUsdc: 80,
    netToFoxifyUsdc: 580,
    serviceFeeUsdc: 0,
    floorBreached: true,
    capBreached: false,
    oracleVerified: true,
    openedAtMs: NOW,
    settledAtMs: EXPIRY,
    heldMs: EXPIRY - NOW,
    hedgeReceiptUsdc: 500,
    atticusOptionNetUsdc: 0,
    shortLegMarginUsdc: 0,
    capitalCostUsdc: 0,
    optionFeesUsdc: 0,
    atticusNetAfterCapitalUsdc: 0,
    atticusNetAfterFeesAndCapitalUsdc: 0,
    venue: "falconx_live",
    liveMeta: livePos().liveMeta,
    ...over
  }) as SettlementOutcome;

test("falconx recon: venue cash matches expected payoff at THEIR fixing ⟹ matched (basis informational)", async () => {
  // FalconX fixes at 93,050 ⟹ expected hedge cash = (94k − 93.05k) × 0.5 = $475. Their cash flow is
  // signed from THEIR side: they pay us 475 ⟹ amount −475.
  const { client } = makeVenue([], {
    transactions: { "OPT-trade-q1": [{ transaction_type: "exercised", settlement_price: 93_050 }] },
    cashFlows: [{ amount: -475, currency: "USD", payment_type: "Settlement", trade_id: "OPT-trade-q1" }]
  });
  const recs = await reconcileFalconxSettlements(client, [settledOutcome()], { toleranceUsdc: 5, nowMs: 1 });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].status, "matched");
  assert.equal(recs[0].venueSettlePriceUsd, 93_050);
  assert.equal(recs[0].priceDiffUsd, -50);
  assert.equal(recs[0].venueCashFlowUsdc, 475);
});

test("falconx recon: venue cash off beyond tolerance ⟹ mismatch", async () => {
  const { client } = makeVenue([], {
    transactions: { "OPT-trade-q1": [{ transaction_type: "exercised", settlement_price: 93_050 }] },
    cashFlows: [{ amount: -400, currency: "USD", payment_type: "Settlement", trade_id: "OPT-trade-q1" }]
  });
  const recs = await reconcileFalconxSettlements(client, [settledOutcome()], { toleranceUsdc: 5, nowMs: 1 });
  assert.equal(recs[0].status, "mismatch");
});

test("falconx recon: settlement transactions not yet published ⟹ pending (retry, no halt)", async () => {
  const { client } = makeVenue([], { transactions: { "OPT-trade-q1": [{ transaction_type: "opened" }] } });
  const recs = await reconcileFalconxSettlements(client, [settledOutcome()], { toleranceUsdc: 5, nowMs: 1 });
  assert.equal(recs[0].status, "pending_venue_data");
});

test("falconx recon: expired OTM with no cash flows ⟹ legitimate $0, matched", async () => {
  const { client } = makeVenue([], {
    transactions: { "OPT-trade-q1": [{ transaction_type: "expired", settlement_price: 100_480 }] }
  });
  const recs = await reconcileFalconxSettlements(client, [settledOutcome({ settlePriceUsd: 100_500, payoutToFoxifyUsdc: 0, floorBreached: false })], { toleranceUsdc: 5, nowMs: 1 });
  assert.equal(recs[0].status, "matched");
  assert.equal(recs[0].venueCashFlowUsdc, 0);
});

test("falconx recon: missing trade ids ⟹ mismatch (cannot verify)", async () => {
  const { client } = makeVenue([]);
  const s = settledOutcome();
  s.liveMeta = { ...s.liveMeta!, fxTradeIds: [] };
  const recs = await reconcileFalconxSettlements(client, [s], { toleranceUsdc: 5, nowMs: 1 });
  assert.equal(recs[0].status, "mismatch");
});

// ── Full window through the shared runner ─────────────────────────────────────

const gate = (regime: RegimeGateDecision["regime"]): RegimeGateDecision => ({
  regime,
  realizedMovePct: 0.8,
  trailingMovePct: 0.8,
  liveMovePct: null,
  signalSource: "trailing",
  samples: 20,
  openMultiplier: 1,
  floorPctOverride: null,
  reason: "test"
});

const solveOk: SolveSide = (side) => ({
  ok: true,
  solved: {
    ref: `cc-live-${NOW}-${side}`,
    side,
    notionalUsdc: 50_000,
    putStrike: side === "long" ? 94_000 : 98_000,
    callStrike: side === "long" ? 102_000 : 106_000,
    foxifyCreditUsdc: 78,
    serviceFeeUsdc: 0,
    floorPctUsed: 0.06,
    protectiveLegMidUsdc: 60,
    fundingLegMidUsdc: 145
  }
});

const freshPaths = () => {
  const dir = mkdtempSync(join(tmpdir(), "fx-runner-"));
  return { executions: join(dir, "exec.jsonl"), windowState: join(dir, "window.json"), alerts: join(dir, "alerts.jsonl"), recon: join(dir, "recon.jsonl"), settlements: join(dir, "settle.jsonl"), partnerSignals: join(dir, "signals.jsonl") };
};
// LIVE_DIRECTIONAL_DECISION=auto pins the legacy trend-auto behavior these scenarios exercise;
// the pilot default ("partner") is covered in creditCollarPartnerDecisionGate.test.ts.
const armedEnv = { LIVE_ENABLED: "true", FALCONX_LIVE_CONFIRM: "I_UNDERSTAND_REAL_MONEY", LIVE_DIRECTIONAL_DECISION: "auto" };
const ctx = (regime: "calm" | "elevated" | "halt") => ({ nowMs: NOW, spot: SPOT, regime: gate(regime), trendBias: "long" as const, solveSide: solveOk });

test("falconx runner: calm day executes the PAIR as two atomic structures, booked falconx_live", async () => {
  const paths = freshPaths();
  const { client } = makeVenue([{ ask: -160 }, { ask: -150 }]);
  const hook = buildFalconxLiveExecutionHook(armedEnv, { client, guards: parseLiveGuardsFromEnv(armedEnv, "falconx"), paths });
  const r = await hook.executeWindow(ctx("calm"));
  assert.equal(r.newOpens.length, 2);
  const long = r.newOpens.find((p) => p.side === "long")!;
  assert.equal(long.venue, "falconx_live");
  assert.equal(long.foxifyCreditUsdc, 80);      // REAL quoted net, not the model number
  assert.equal(long.quoteMeta?.modelNetUsdc, 78);
  assert.equal(long.expiresAtMs, EXPIRY);
  assert.equal(long.openFeeUsdc, 0);            // all-in RFQ pricing
  assert.ok(long.liveMeta?.fxTradeIds?.length);
  assert.equal(loadWindowState(paths.windowState).lastOutcome, "filled");
  assert.equal(loadLiveExecutions(paths.executions).filter((e) => e.outcome === "filled").length, 2);
});

test("falconx runner: second structure outside the band ⟹ first collar unwound (pair atomicity), day skipped", async () => {
  const paths = freshPaths();
  // Quote 1 (long): good. Quote 2+3 (short, retry): outside band. Quote 4: the reverse-structure unwind of collar 1.
  const { client, calls } = makeVenue([{ ask: -160 }, { ask: -20 }, { ask: -25 }, { ask: 100 }]);
  const hook = buildFalconxLiveExecutionHook(armedEnv, { client, guards: parseLiveGuardsFromEnv(armedEnv, "falconx"), paths });
  const r = await hook.executeWindow(ctx("calm"));
  assert.equal(r.newOpens.length, 0); // NOTHING stands
  const execs = loadLiveExecutions(paths.executions);
  assert.ok(execs.some((e) => e.outcome === "aborted_band"));
  assert.ok(execs.some((e) => e.outcome === "pair_sibling_unwound"));
  // The unwind quoted the REVERSE of the long collar (buy call back, sell put).
  const unwindQuote = calls.filter((c) => c.path.endsWith("/option/quote")).at(-1);
  assert.equal(unwindQuote?.body.structure[0].side, "buy");
  assert.ok(String(unwindQuote?.body.structure[0].symbol).endsWith("-C"));
});

test("falconx runner: kill-switch off ⟹ nothing quoted", async () => {
  const paths = freshPaths();
  const { client, calls } = makeVenue([{ ask: -160 }]);
  const hook = buildFalconxLiveExecutionHook({}, { client, guards: parseLiveGuardsFromEnv({}, "falconx"), paths });
  const r = await hook.executeWindow(ctx("elevated"));
  assert.equal(r.newOpens.length, 0);
  assert.equal(calls.filter((c) => c.path.endsWith("/option/quote")).length, 0);
  assert.ok(r.summary.includes("kill-switch"));
});

test("falconx runner: canary forces 0.01-BTC qty through the same full path", async () => {
  const paths = freshPaths();
  const { client, calls } = makeVenue([{ ask: -160 }]);
  const env = { ...armedEnv, LIVE_CANARY_CONTRACTS: "1" };
  const hook = buildFalconxLiveExecutionHook(env, { client, guards: parseLiveGuardsFromEnv(env, "falconx"), paths });
  const r = await hook.executeWindow(ctx("elevated"));
  assert.equal(r.newOpens.length, 1);
  assert.equal(r.newOpens[0].liveMeta?.contracts, 0.01);
  assert.equal(r.newOpens[0].notionalUsdc, 1_000);
  const quoteCall = calls.find((c) => c.path.endsWith("/option/quote"));
  assert.equal(quoteCall?.body.quantity, 0.01);
});
