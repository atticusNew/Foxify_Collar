import Decimal from "decimal.js";
import type { Pool } from "pg";
import type { DeribitConnector } from "@foxify/connectors";
import type { TreasuryConfig } from "./treasuryConfig";
import type { PilotVenueAdapter } from "./venue";
import {
  ensureTreasurySchema,
  getTreasuryState,
  updateTreasuryState,
  insertTreasuryProtection,
  getActiveTreasuryProtection,
  patchTreasuryProtection
} from "./treasuryDb";
import { computePutRecoveryValue } from "./blackScholes";

type SchedulerDeps = {
  pool: Pool;
  venue: PilotVenueAdapter;
  deribit: DeribitConnector;
  config: TreasuryConfig;
};

let executionLock = false;

const getSpot = async (deribit: DeribitConnector): Promise<number> => {
  const ticker = await deribit.getIndexPrice("btc_usd");
  const price = Number((ticker as any)?.result?.index_price ?? 0);
  if (!Number.isFinite(price) || price <= 0) throw new Error("treasury_spot_unavailable");
  return price;
};

const shouldExecuteToday = (state: { lastCycleDate: string | null; paused: boolean }, config: TreasuryConfig): boolean => {
  if (state.paused) return false;
  const today = new Date().toISOString().slice(0, 10);
  if (state.lastCycleDate === today) return false;
  const now = new Date();
  const targetMinutes = config.executionTimeUtcHour * 60 + config.executionTimeUtcMinute;
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return currentMinutes >= targetMinutes;
};

export const runTreasuryDailyCycle = async (deps: SchedulerDeps): Promise<{
  action: "executed" | "skipped" | "paused" | "already_done" | "error";
  protectionId?: string;
  detail?: string;
}> => {
  if (executionLock) return { action: "skipped", detail: "execution_in_progress" };

  await ensureTreasurySchema(deps.pool);
  const state = await getTreasuryState(deps.pool);

  if (state.paused) return { action: "paused" };
  if (!state.active) return { action: "skipped", detail: "treasury_not_active" };

  const today = new Date().toISOString().slice(0, 10);
  const lastDate = state.lastCycleDate ? String(state.lastCycleDate).slice(0, 10) : null;
  if (lastDate === today) return { action: "already_done" };

  if (!shouldExecuteToday({ ...state, lastCycleDate: lastDate }, deps.config)) return { action: "skipped", detail: "before_execution_time" };

  executionLock = true;

  const notional = new Decimal(deps.config.notionalUsd);
  const floorPct = new Decimal(deps.config.floorPct).div(100);
  const tenorDays = deps.config.tenorDays;
  const premiumBps = new Decimal(deps.config.dailyPremiumBps);
  const premiumUsd = notional.mul(premiumBps).div(10000);

  let spot: number;
  try {
    spot = await getSpot(deps.deribit);
  } catch (err: any) {
    executionLock = false;
    console.error(`[Treasury] Spot price unavailable: ${err?.message}`);
    return { action: "error", detail: err?.message };
  }

  const entryPrice = new Decimal(spot);
  const floorPrice = entryPrice.mul(new Decimal(1).minus(floorPct));
  const triggerPrice = floorPrice.toNumber();
  const quantity = notional.div(entryPrice).toDecimalPlaces(1, Decimal.ROUND_DOWN).toNumber();
  const payoutOnTrigger = notional.mul(floorPct);

  console.log(`[Treasury] Executing daily cycle: date=${today} notional=$${notional} spot=$${spot} floor=$${floorPrice.toFixed(2)} qty=${quantity} premium=$${premiumUsd.toFixed(2)}`);

  let quote;
  try {
    quote = await deps.venue.quote({
      marketId: "BTC-USD",
      instrumentId: `BTC-USD-${tenorDays}D-P`,
      protectedNotional: notional.toNumber(),
      quantity,
      side: "buy",
      protectionType: "long",
      drawdownFloorPct: floorPct.toNumber(),
      triggerPrice,
      requestedTenorDays: tenorDays
    });
  } catch (err: any) {
    executionLock = false;
    console.error(`[Treasury] Quote failed: ${err?.message}`);
    return { action: "error", detail: `quote_failed: ${err?.message}` };
  }

  let execution;
  try {
    execution = await deps.venue.execute(quote);
  } catch (err: any) {
    executionLock = false;
    console.error(`[Treasury] Execution failed: ${err?.message}`);
    return { action: "error", detail: `execution_failed: ${err?.message}` };
  }

  if (execution.status !== "success") {
    executionLock = false;
    console.error(`[Treasury] Execution not successful: ${JSON.stringify(execution.details).slice(0, 300)}`);
    return { action: "error", detail: `execution_status: ${execution.status}` };
  }

  const hedgeCostUsd = new Decimal(execution.premium);
  const spreadUsd = premiumUsd.minus(hedgeCostUsd);
  const strikeMatch = String(quote.instrumentId || "").match(/(\d+)-(P|C)$/);
  const strike = strikeMatch ? Number(strikeMatch[1]) : 0;
  const expiryAt = new Date(Date.now() + tenorDays * 86400000).toISOString();

  const protection = await insertTreasuryProtection(deps.pool, {
    cycleDate: today,
    notionalUsd: notional.toFixed(10),
    floorPct: floorPct.toFixed(6),
    entryPrice: entryPrice.toFixed(10),
    floorPrice: floorPrice.toFixed(10),
    strike: String(strike),
    instrumentId: quote.instrumentId,
    venue: execution.venue,
    tenorDays,
    premiumUsd: premiumUsd.toFixed(10),
    hedgeCostUsd: hedgeCostUsd.toFixed(10),
    spreadUsd: spreadUsd.toFixed(10),
    expiryAt,
    externalOrderId: execution.externalOrderId,
    executionDetails: {
      quoteId: quote.quoteId,
      fillPrice: execution.executionPrice,
      fillQuantity: execution.quantity,
      instrumentId: execution.instrumentId,
      venue: execution.venue,
      executedAt: execution.executedAt,
      payoutOnTrigger: payoutOnTrigger.toFixed(10)
    }
  });

  await updateTreasuryState(deps.pool, {
    last_cycle_date: today,
    last_execution_at: new Date().toISOString(),
    total_premiums_usd: new Decimal(state.totalPremiumsUsd).plus(premiumUsd).toFixed(10),
    total_hedge_costs_usd: new Decimal(state.totalHedgeCostsUsd).plus(hedgeCostUsd).toFixed(10),
    total_cycles: state.totalCycles + 1
  });

  executionLock = false;
  console.log(
    `[Treasury] Cycle complete: protection=${protection.id} instrument=${quote.instrumentId} strike=$${strike} premium=$${premiumUsd.toFixed(2)} hedge=$${hedgeCostUsd.toFixed(2)} spread=$${spreadUsd.toFixed(2)}`
  );

  return { action: "executed", protectionId: protection.id };
};

export const runTreasuryTriggerCheck = async (deps: SchedulerDeps): Promise<{
  checked: boolean;
  triggered: boolean;
  detail?: string;
}> => {
  await ensureTreasurySchema(deps.pool);
  const active = await getActiveTreasuryProtection(deps.pool);
  if (!active) return { checked: false, triggered: false, detail: "no_active_protection" };

  const floorPrice = Number(active.floorPrice || 0);
  if (floorPrice <= 0) return { checked: false, triggered: false, detail: "no_floor_price" };

  let spot: number;
  try {
    spot = await getSpot(deps.deribit);
  } catch {
    return { checked: false, triggered: false, detail: "spot_unavailable" };
  }

  if (spot > floorPrice) return { checked: true, triggered: false };

  const notional = Number(active.notionalUsd || 0);
  const floorPct = Number(active.floorPct || 0.02);
  const payoutUsd = notional * floorPct;

  console.log(`[Treasury] TRIGGERED: spot=$${spot.toFixed(2)} floor=$${floorPrice.toFixed(2)} payout=$${payoutUsd.toFixed(2)}`);

  await patchTreasuryProtection(deps.pool, active.id, {
    status: "triggered",
    triggered: true,
    trigger_price: spot.toFixed(10),
    trigger_at: new Date().toISOString(),
    payout_usd: payoutUsd.toFixed(10)
  });

  const state = await getTreasuryState(deps.pool);
  await updateTreasuryState(deps.pool, {
    total_payouts_usd: new Decimal(state.totalPayoutsUsd).plus(payoutUsd).toFixed(10),
    total_triggers: state.totalTriggers + 1
  });

  return { checked: true, triggered: true, detail: `payout=$${payoutUsd.toFixed(2)}` };
};

export const startTreasuryScheduler = (deps: SchedulerDeps): void => {
  if (!deps.config.enabled) {
    console.log("[Treasury] Scheduler disabled (TREASURY_ENABLED=false)");
    return;
  }

  const cycleInterval = setInterval(async () => {
    try {
      const result = await runTreasuryDailyCycle(deps);
      if (result.action === "executed") {
        console.log(`[Treasury] Daily cycle executed: ${result.protectionId}`);
      }
    } catch (err: any) {
      console.error(`[Treasury] Cycle scheduler error: ${err?.message}`);
    }
  }, deps.config.checkIntervalMs);
  cycleInterval.unref?.();

  const triggerInterval = setInterval(async () => {
    try {
      const result = await runTreasuryTriggerCheck(deps);
      if (result.triggered) {
        console.log(`[Treasury] Trigger detected: ${result.detail}`);
      }
    } catch (err: any) {
      console.error(`[Treasury] Trigger monitor error: ${err?.message}`);
    }
  }, deps.config.triggerMonitorIntervalMs);
  triggerInterval.unref?.();

  console.log(`[Treasury] Scheduler started: cycle=${deps.config.checkIntervalMs}ms trigger=${deps.config.triggerMonitorIntervalMs}ms execution=${deps.config.executionTimeUtcHour}:${String(deps.config.executionTimeUtcMinute).padStart(2, "0")} UTC`);
};
