import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Pool } from "pg";
import type { DeribitConnector } from "@foxify/connectors";
import type { TreasuryConfig } from "./treasuryConfig";
import type { PilotVenueAdapter } from "./venue";
import Decimal from "decimal.js";
import {
  ensureTreasurySchema,
  getTreasuryState,
  updateTreasuryState,
  getTreasuryProtectionHistory,
  getActiveTreasuryProtection,
  resetTreasuryData
} from "./treasuryDb";
import { runTreasuryDailyCycle } from "./treasuryScheduler";

const requireTreasuryAuth = (req: FastifyRequest, reply: FastifyReply, config: TreasuryConfig): boolean => {
  const token = String(req.headers["x-admin-token"] || req.headers["x-treasury-token"] || "");
  if (!config.adminToken || token !== config.adminToken) {
    reply.code(401).send({ status: "error", reason: "unauthorized" });
    return false;
  }
  return true;
};

export const registerTreasuryRoutes = async (
  app: FastifyInstance,
  deps: {
    pool: Pool;
    venue: PilotVenueAdapter;
    deribit: DeribitConnector;
    config: TreasuryConfig;
  }
): Promise<void> => {
  await ensureTreasurySchema(deps.pool);

  app.get("/treasury/status", async (req, reply) => {
    if (!requireTreasuryAuth(req, reply, deps.config)) return;
    const state = await getTreasuryState(deps.pool);
    const active = await getActiveTreasuryProtection(deps.pool);

    let currentSpot: number | null = null;
    let distanceToFloor: { usd: number; pct: number } | null = null;
    try {
      const ticker = await deps.deribit.getIndexPrice("btc_usd");
      currentSpot = Number((ticker as any)?.result?.index_price ?? 0);
      if (active && active.floorPrice && currentSpot > 0) {
        const floor = Number(active.floorPrice);
        distanceToFloor = {
          usd: Number((currentSpot - floor).toFixed(2)),
          pct: Number(((currentSpot - floor) / currentSpot * 100).toFixed(2))
        };
      }
    } catch { /* best effort */ }

    return {
      status: "ok",
      client: deps.config.clientName,
      config: {
        notionalUsd: deps.config.notionalUsd,
        floorPct: deps.config.floorPct,
        tenorDays: deps.config.tenorDays,
        dailyPremiumBps: deps.config.dailyPremiumBps,
        executionTime: `${String(deps.config.executionTimeUtcHour).padStart(2, "0")}:${String(deps.config.executionTimeUtcMinute).padStart(2, "0")} UTC`,
        venue: deps.config.venue
      },
      state: {
        active: state.active,
        paused: state.paused,
        pausedAt: state.pausedAt,
        lastCycleDate: state.lastCycleDate,
        lastExecutionAt: state.lastExecutionAt,
        totalCycles: state.totalCycles,
        totalTriggers: state.totalTriggers
      },
      billing: {
        totalPremiumsUsd: state.totalPremiumsUsd,
        totalPayoutsUsd: state.totalPayoutsUsd,
        netCostToClient: new Decimal(state.totalPremiumsUsd).minus(state.totalPayoutsUsd).toFixed(2)
      },
      currentProtection: active ? {
        id: active.id,
        cycleDate: active.cycleDate,
        entryPrice: active.entryPrice,
        floorPrice: active.floorPrice,
        strike: active.strike,
        premiumUsd: active.premiumUsd,
        expiryAt: active.expiryAt,
        triggered: active.triggered,
        payoutUsd: active.payoutUsd,
        status: active.status
      } : null,
      market: {
        currentSpot,
        distanceToFloor
      }
    };
  });

  app.get("/treasury/history", async (req, reply) => {
    if (!requireTreasuryAuth(req, reply, deps.config)) return;
    const query = req.query as { limit?: string };
    const limit = Math.max(1, Math.min(Number(query.limit || 30), 365));
    const history = await getTreasuryProtectionHistory(deps.pool, limit);
    return {
      status: "ok",
      count: history.length,
      protections: history.map((p) => ({
        cycleDate: p.cycleDate,
        entryPrice: p.entryPrice,
        floorPrice: p.floorPrice,
        strike: p.strike,
        premiumUsd: p.premiumUsd,
        triggered: p.triggered,
        payoutUsd: p.payoutUsd,
        status: p.status
      }))
    };
  });

  app.post("/treasury/pause", async (req, reply) => {
    if (!requireTreasuryAuth(req, reply, deps.config)) return;
    await updateTreasuryState(deps.pool, {
      paused: true,
      paused_at: new Date().toISOString()
    });
    console.log("[Treasury] Paused by admin");
    return { status: "ok", action: "paused" };
  });

  app.post("/treasury/resume", async (req, reply) => {
    if (!requireTreasuryAuth(req, reply, deps.config)) return;
    await updateTreasuryState(deps.pool, {
      paused: false,
      resumed_at: new Date().toISOString()
    });
    console.log("[Treasury] Resumed by admin");
    return { status: "ok", action: "resumed" };
  });

  app.post("/treasury/notional", async (req, reply) => {
    if (!requireTreasuryAuth(req, reply, deps.config)) return;
    const body = req.body as { notionalUsd?: number };
    const newNotional = Number(body.notionalUsd);
    if (!Number.isFinite(newNotional) || newNotional < 10000 || newNotional > 10000000) {
      reply.code(400);
      return { status: "error", reason: "invalid_notional", message: "Notional must be between $10k and $10M" };
    }
    await updateTreasuryState(deps.pool, {
      notional_usd: newNotional.toFixed(10)
    });
    console.log(`[Treasury] Notional updated to $${newNotional.toLocaleString()}`);
    return { status: "ok", notionalUsd: newNotional };
  });

  app.post("/treasury/reset", async (req, reply) => {
    if (!requireTreasuryAuth(req, reply, deps.config)) return;
    await resetTreasuryData(deps.pool);
    return { status: "ok", action: "treasury_data_reset" };
  });

  app.post("/treasury/execute-now", async (req, reply) => {
    if (!requireTreasuryAuth(req, reply, deps.config)) return;
    try {
      const result = await runTreasuryDailyCycle({
        pool: deps.pool,
        venue: deps.venue,
        deribit: deps.deribit,
        config: deps.config
      });
      return { status: "ok", ...result };
    } catch (err: any) {
      reply.code(500);
      return { status: "error", reason: String(err?.message || "execution_failed") };
    }
  });

  app.get("/treasury/billing/summary", async (req, reply) => {
    if (!requireTreasuryAuth(req, reply, deps.config)) return;
    const state = await getTreasuryState(deps.pool);
    const history = await getTreasuryProtectionHistory(deps.pool, 365);

    const byMonth: Record<string, {
      cycles: number;
      premiums: number;
      hedgeCosts: number;
      payouts: number;
      triggers: number;
    }> = {};

    for (const p of history) {
      const month = p.cycleDate.slice(0, 7);
      if (!byMonth[month]) byMonth[month] = { cycles: 0, premiums: 0, hedgeCosts: 0, payouts: 0, triggers: 0 };
      byMonth[month].cycles++;
      byMonth[month].premiums += Number(p.premiumUsd || 0);
      byMonth[month].hedgeCosts += Number(p.hedgeCostUsd || 0);
      byMonth[month].payouts += Number(p.payoutUsd || 0);
      if (p.triggered) byMonth[month].triggers++;
    }

    return {
      status: "ok",
      lifetime: {
        totalCycles: state.totalCycles,
        totalTriggers: state.totalTriggers,
        totalPremiums: state.totalPremiumsUsd,
        totalPayouts: state.totalPayoutsUsd,
        netCostToClient: new Decimal(state.totalPremiumsUsd).minus(state.totalPayoutsUsd).toFixed(2)
      },
      monthly: Object.fromEntries(
        Object.entries(byMonth).map(([month, data]) => [month, {
          cycles: data.cycles,
          premiums: data.premiums,
          payouts: data.payouts,
          triggers: data.triggers
        }])
      )
    };
  });
};
