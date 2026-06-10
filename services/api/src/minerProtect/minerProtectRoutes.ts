/**
 * Miner Protect — HTTP routes (isolated). Registered from the Foxify v2 plugin so they share the live
 * feed + Bullish client, but all logic lives in this module (no mixing with perp/etf).
 *
 *   POST /admin/foxify/v2/miner-protect/quote    — single-tenor breakeven-floor quote
 *   POST /admin/foxify/v2/miner-protect/strip    — multi-tenor production strip (30/60/90d default)
 *   POST /admin/foxify/v2/miner-protect/monitor  — evaluate an active hedge (hold/roll/take-profit)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { BullishProbeClientLike } from "../singleSide/twoSided/venuePutProbes";
import type { MinerInputs } from "./minerProtectQuote";

type FeedLike = { getCurrentFeed: () => { canonicalPrice: number | null } | null | undefined };

export type MinerProtectRouteDeps = {
  feedService: FeedLike;
  bullishProbeClient?: BullishProbeClientLike | null;
  preHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<boolean> | unknown;
  luxorApiKey?: string;
};

type Body = {
  hashrate_ths?: number; efficiency_w_per_th?: number; power_cost_usd_per_kwh?: number;
  other_opex_usd_per_day?: number; btc_per_th_per_day?: number; tenor_days?: number; tenors?: number[]; mark_price?: number;
  // monitor
  strike?: number; expiry_iso?: string; premium_usd?: number; hedged_btc?: number; breakeven_price?: number;
};

/** Resolve BTC/TH/day: request override → Luxor (if key) → free on-chain difficulty fallback. */
const resolveHashprice = async (b: Body, luxorApiKey?: string): Promise<{ value: number | null; source: string }> => {
  if (b.btc_per_th_per_day != null && Number(b.btc_per_th_per_day) > 0) return { value: Number(b.btc_per_th_per_day), source: "request" };
  const { luxorHashpriceProvider } = await import("./luxorHashpriceAdapter");
  const { difficultyHashpriceProvider } = await import("./networkHashprice");
  if (luxorApiKey) {
    const v = await luxorHashpriceProvider(luxorApiKey).getBtcPerThPerDay();
    if (v) return { value: v, source: "luxor" };
  }
  const v = await difficultyHashpriceProvider().getBtcPerThPerDay();
  return { value: v, source: v ? "network_difficulty" : "none" };
};

const parseMinerInputs = (b: Body, spot: number, btcPerThPerDay: number, tenorDays: number): MinerInputs => ({
  hashrateThs: Number(b.hashrate_ths ?? 0),
  efficiencyWPerTh: Number(b.efficiency_w_per_th ?? 0),
  powerCostUsdPerKwh: Number(b.power_cost_usd_per_kwh ?? 0),
  otherOpexUsdPerDay: Number(b.other_opex_usd_per_day ?? 0),
  btcPerThPerDay,
  btcPrice: spot,
  tenorDays
});

const validMiner = (b: Body): boolean =>
  Number(b.hashrate_ths) > 0 && Number(b.efficiency_w_per_th) > 0 && Number(b.power_cost_usd_per_kwh) > 0;

export function registerMinerProtectRoutes(app: FastifyInstance, deps: MinerProtectRouteDeps): void {
  const spotOf = (b: Body): number | null => {
    const s = b.mark_price != null && Number(b.mark_price) > 0 ? Number(b.mark_price) : deps.feedService.getCurrentFeed()?.canonicalPrice;
    return s && s > 0 ? s : null;
  };

  app.post<{ Body: Body }>("/admin/foxify/v2/miner-protect/quote", { preHandler: deps.preHandler as never }, async (req, reply) => {
    const { assembleMinerQuote, sourceFloorPut } = await import("./minerProtectSourcing");
    const { makeMinerPricer } = await import("./minerProtectQuote");
    const b = (req.body ?? {}) as Body;
    const spot = spotOf(b);
    if (!spot) { reply.code(503).send({ error: "feed_unavailable" }); return; }
    if (!validMiner(b)) { reply.code(400).send({ error: "invalid_request", message: "hashrate_ths>0, efficiency_w_per_th>0, power_cost_usd_per_kwh>0" }); return; }
    const tenorDays = Number(b.tenor_days ?? 30);
    const hp = await resolveHashprice(b, deps.luxorApiKey);
    if (!hp.value) { reply.code(503).send({ error: "hashprice_unavailable", message: "Could not source BTC/TH/day; pass btc_per_th_per_day to override." }); return; }
    const inputs = parseMinerInputs(b, spot, hp.value, tenorDays);
    const sizeBtc = inputs.hashrateThs * hp.value * tenorDays;
    const quote = await assembleMinerQuote(inputs, {
      sourcePut: (strike) => sourceFloorPut(strike, { spot, tenorDays, bullishProbeClient: deps.bullishProbeClient, sizeBtc }),
      pricer: makeMinerPricer()
    });
    reply.send({ as_of: new Date().toISOString(), hashprice_source: hp.source, btc_per_th_per_day: hp.value, ...quote });
  });

  app.post<{ Body: Body }>("/admin/foxify/v2/miner-protect/strip", { preHandler: deps.preHandler as never }, async (req, reply) => {
    const { buildProductionStrip, DEFAULT_STRIP_TENORS } = await import("./minerProtectStrip");
    const { sourceFloorPut } = await import("./minerProtectSourcing");
    const { makeMinerPricer } = await import("./minerProtectQuote");
    const b = (req.body ?? {}) as Body;
    const spot = spotOf(b);
    if (!spot) { reply.code(503).send({ error: "feed_unavailable" }); return; }
    if (!validMiner(b)) { reply.code(400).send({ error: "invalid_request", message: "hashrate_ths>0, efficiency_w_per_th>0, power_cost_usd_per_kwh>0" }); return; }
    const hp = await resolveHashprice(b, deps.luxorApiKey);
    if (!hp.value) { reply.code(503).send({ error: "hashprice_unavailable", message: "Could not source BTC/TH/day; pass btc_per_th_per_day to override." }); return; }
    const tenors = Array.isArray(b.tenors) && b.tenors.length ? b.tenors.filter((t) => Number(t) > 0).map(Number) : DEFAULT_STRIP_TENORS;
    const inputs = parseMinerInputs(b, spot, hp.value, tenors[0]);
    const strip = await buildProductionStrip(inputs, {
      tenors,
      sourcePut: (strike, tenorDays) => sourceFloorPut(strike, { spot, tenorDays, bullishProbeClient: deps.bullishProbeClient, sizeBtc: inputs.hashrateThs * hp.value! * tenorDays }),
      pricer: makeMinerPricer()
    });
    reply.send({ as_of: new Date().toISOString(), hashprice_source: hp.source, btc_per_th_per_day: hp.value, ...strip });
  });

  app.post<{ Body: Body }>("/admin/foxify/v2/miner-protect/monitor", { preHandler: deps.preHandler as never }, async (req, reply) => {
    const { evaluateHedge } = await import("./minerProtectStrip");
    const b = (req.body ?? {}) as Body;
    const spot = spotOf(b);
    if (!spot) { reply.code(503).send({ error: "feed_unavailable" }); return; }
    if (!(Number(b.strike) > 0) || !b.expiry_iso || !(Number(b.hedged_btc) > 0)) {
      reply.code(400).send({ error: "invalid_request", message: "strike>0, expiry_iso, hedged_btc>0 required" });
      return;
    }
    const status = evaluateHedge(
      { strike: Number(b.strike), expiry_iso: String(b.expiry_iso), premium_usd: Number(b.premium_usd ?? 0), hedged_btc: Number(b.hedged_btc) },
      { spot, breakeven_price: b.breakeven_price != null ? Number(b.breakeven_price) : undefined }
    );
    reply.send({ as_of: new Date().toISOString(), spot, ...status });
  });
}
