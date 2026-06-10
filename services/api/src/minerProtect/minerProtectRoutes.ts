/**
 * Miner Protect — HTTP route (isolated). Registered from the Foxify v2 plugin so it shares the live
 * feed + Bullish client, but all logic lives in this module (no mixing with perp/etf).
 *
 *   POST /admin/foxify/v2/miner-protect/quote
 *   Body: { hashrate_ths, efficiency_w_per_th, power_cost_usd_per_kwh, other_opex_usd_per_day?,
 *           btc_per_th_per_day?, tenor_days?, mark_price? }
 *   → miner economics (power/cost/day, BTC/day, breakeven $/BTC, expected production) + protective
 *     breakeven floors sourced cheapest across OKX/Deribit/Bullish/Bybit, with a recommended tier.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { BullishProbeClientLike } from "../singleSide/twoSided/venuePutProbes";
import type { MinerInputs } from "./minerProtectQuote";

type FeedLike = { getCurrentFeed: () => { canonicalPrice: number | null } | null | undefined };

export type MinerProtectRouteDeps = {
  feedService: FeedLike;
  bullishProbeClient?: BullishProbeClientLike | null;
  /** Reuse the host's demo/admin auth preHandler. */
  preHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<boolean> | unknown;
  /** Optional Luxor API key; when set, the live Hashprice Index provider is used. */
  luxorApiKey?: string;
};

type Body = {
  hashrate_ths?: number; efficiency_w_per_th?: number; power_cost_usd_per_kwh?: number;
  other_opex_usd_per_day?: number; btc_per_th_per_day?: number; tenor_days?: number; mark_price?: number;
};

export function registerMinerProtectRoutes(app: FastifyInstance, deps: MinerProtectRouteDeps): void {
  app.post<{ Body: Body }>(
    "/admin/foxify/v2/miner-protect/quote",
    { preHandler: deps.preHandler as never },
    async (req, reply) => {
      const { assembleMinerQuote, sourceFloorPut } = await import("./minerProtectSourcing");
      const { makeMinerPricer } = await import("./minerProtectQuote");
      const { luxorHashpriceProvider } = await import("./luxorHashpriceAdapter");
      const { difficultyHashpriceProvider } = await import("./networkHashprice");

      const b = (req.body ?? {}) as Body;
      const spot = b.mark_price != null && Number(b.mark_price) > 0 ? Number(b.mark_price) : deps.feedService.getCurrentFeed()?.canonicalPrice;
      if (!spot || spot <= 0) { reply.code(503).send({ error: "feed_unavailable" }); return; }

      const hashrateThs = Number(b.hashrate_ths ?? 0);
      const efficiencyWPerTh = Number(b.efficiency_w_per_th ?? 0);
      const powerCostUsdPerKwh = Number(b.power_cost_usd_per_kwh ?? 0);
      const otherOpexUsdPerDay = Number(b.other_opex_usd_per_day ?? 0);
      const tenorDays = Number(b.tenor_days ?? 30);
      if (!(hashrateThs > 0) || !(efficiencyWPerTh > 0) || !(powerCostUsdPerKwh > 0) || !(tenorDays > 0)) {
        reply.code(400).send({ error: "invalid_request", message: "hashrate_ths>0, efficiency_w_per_th>0, power_cost_usd_per_kwh>0, tenor_days>0" });
        return;
      }
      // Network productivity (BTC/TH/day): request override → Luxor Hashprice Index (if entitled) →
      // free on-chain difficulty fallback (always available). Source surfaced for transparency.
      let btcPerThPerDay: number | null = null;
      let hashpriceSource = "none";
      if (b.btc_per_th_per_day != null && Number(b.btc_per_th_per_day) > 0) {
        btcPerThPerDay = Number(b.btc_per_th_per_day); hashpriceSource = "request";
      } else {
        if (deps.luxorApiKey) {
          btcPerThPerDay = await luxorHashpriceProvider(deps.luxorApiKey).getBtcPerThPerDay();
          if (btcPerThPerDay) hashpriceSource = "luxor";
        }
        if (!btcPerThPerDay) {
          btcPerThPerDay = await difficultyHashpriceProvider().getBtcPerThPerDay();
          if (btcPerThPerDay) hashpriceSource = "network_difficulty";
        }
      }
      if (!btcPerThPerDay || btcPerThPerDay <= 0) {
        reply.code(503).send({ error: "hashprice_unavailable", message: "Could not source BTC/TH/day (network difficulty + Luxor both unavailable). Pass btc_per_th_per_day to override." });
        return;
      }

      const inputs: MinerInputs = { hashrateThs, efficiencyWPerTh, powerCostUsdPerKwh, otherOpexUsdPerDay, btcPerThPerDay, btcPrice: spot, tenorDays };
      const sizeBtc = hashrateThs * btcPerThPerDay * tenorDays; // expected production
      const quote = await assembleMinerQuote(inputs, {
        sourcePut: (strike) => sourceFloorPut(strike, { spot, tenorDays, bullishProbeClient: deps.bullishProbeClient, sizeBtc }),
        pricer: makeMinerPricer()
      });

      reply.send({
        as_of: new Date().toISOString(),
        hashprice_source: hashpriceSource,
        btc_per_th_per_day: btcPerThPerDay,
        ...quote,
        note: "Miner Protect quote (price-only v1): breakeven floor on expected BTC production, sourced cheapest across OKX/Deribit/Bullish/Bybit. Floors the BTC-price leg of revenue, not network difficulty (hashprice floor = roadmap). No execution yet."
      });
    }
  );
}
