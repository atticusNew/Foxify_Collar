import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import {
  buildLiveDeribitComparisonInputs,
  comparePricingModels,
  comparisonRowsToCsv,
  parseComparisonInputFixture
} from "../src/pilot/modelComparison";
import { compareLiveDeribitByTenor } from "../src/pilot/tenorComparison";

test("comparePricingModels returns strict and hybrid premiums for identical input", () => {
  const result = comparePricingModels([
    {
      scenarioId: "baseline",
      tierName: "Pro (Bronze)",
      protectedNotionalUsd: new Decimal("5000"),
      drawdownFloorPct: new Decimal("0.2"),
      hedgePremiumUsd: new Decimal("48"),
      brokerFeesUsd: new Decimal("0"),
      quoteInstrumentId: "BTC-09APR26-48000-P",
      spotPriceUsd: new Decimal("60000")
    }
  ]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].scenarioId, "baseline");
  assert.equal(result.rows[0].strictMethod, "floor_profitability");
  assert.equal(result.rows[0].hybridMethod.startsWith("hybrid_"), true);
  assert.equal(result.rows[0].strictClientPremiumUsd, "210.5000000000");
  assert.equal(result.rows[0].hybridClientPremiumUsd, "77.0000000000");
  assert.equal(result.rows[0].hybridClaimsFloorHit, result.rows[0].hybridMethod === "hybrid_claims_floor");
  assert.equal(result.rows[0].hybridImpliedSubsidyGapUsd, "116.0000000000");
  assert.equal(result.summary.nRows, 1);
  assert.equal(result.summary.claimsFloorHitCount, result.rows[0].hybridClaimsFloorHit ? 1 : 0);
  assert.equal(result.summary.claimsFloorHitRatePct, result.rows[0].hybridClaimsFloorHit ? "100.0000" : "0.0000");
  assert.equal(result.summary.impliedSubsidyGapMeanUsd, result.rows[0].hybridImpliedSubsidyGapUsd);
  assert.equal(result.summary.impliedSubsidyGapMedianUsd, result.rows[0].hybridImpliedSubsidyGapUsd);
  assert.equal(result.summary.impliedSubsidyGapTotalUsd, result.rows[0].hybridImpliedSubsidyGapUsd);
  assert.equal(result.summary.impliedSubsidyGapPositiveCount, 1);
});

test("parseComparisonInputFixture normalizes scenarios deterministically", () => {
  const rows = parseComparisonInputFixture({
    scenarios: [
      {
        scenarioId: "b",
        tierName: "Pro (Bronze)",
        protectedNotionalUsd: "5000",
        drawdownFloorPct: "0.2",
        hedgePremiumUsd: "50",
        brokerFeesUsd: "0"
      },
      {
        scenarioId: "a",
        tierName: "Pro (Silver)",
        protectedNotionalUsd: "6000",
        drawdownFloorPct: "0.15",
        hedgePremiumUsd: "62",
        brokerFeesUsd: "0.5"
      }
    ]
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].scenarioId, "b");
  assert.equal(rows[1].scenarioId, "a");
  assert.equal(rows[1].tierName, "Pro (Silver)");
  assert.equal(rows[1].brokerFeesUsd.toFixed(10), "0.5000000000");
});

test("comparisonRowsToCsv emits headers and one row per scenario", () => {
  const result = comparePricingModels([
    {
      scenarioId: "row1",
      tierName: "Pro (Bronze)",
      protectedNotionalUsd: new Decimal("5000"),
      drawdownFloorPct: new Decimal("0.2"),
      hedgePremiumUsd: new Decimal("50"),
      brokerFeesUsd: new Decimal("0")
    }
  ]);
  const csv = comparisonRowsToCsv(result.rows);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0].includes("scenarioId"), true);
  assert.equal(lines[0].includes("strictClientPremiumUsd"), true);
  assert.equal(lines[1].includes("row1"), true);
});

test("buildLiveDeribitComparisonInputs uses Deribit spot and orderbook snapshots", async () => {
  const deribitMock = {
    async getIndexPrice() {
      return { result: { index_price: 60000 } };
    },
    async getOrderBook(instrumentId: string) {
      return {
        result: {
          instrument_name: instrumentId,
          asks: [[0.012, 25]],
          best_ask_price: 0.012,
          mark_price: 0.011
        }
      };
    }
  } as any;
  const inputs = await buildLiveDeribitComparisonInputs({
    deribit: deribitMock,
    scenarios: [
      {
        scenarioId: "live_1",
        tierName: "Pro (Bronze)",
        protectedNotionalUsd: 5000,
        tenorDays: 7,
        brokerFeesUsd: 1.25,
        drawdownFloorPct: 0.2
      }
    ]
  });
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].scenarioId, "live_1");
  assert.equal(inputs[0].spotPriceUsd?.toFixed(10), "60000.0000000000");
  assert.equal(inputs[0].brokerFeesUsd.toFixed(10), "1.2500000000");
  assert.equal(inputs[0].hedgePremiumUsd.minus(new Decimal("60")).abs().lessThan(new Decimal("0.00001")), true);
});

test("compareLiveDeribitByTenor returns rows grouped by requested tenor", async () => {
  const deribitMock = {
    async getIndexPrice() {
      return { result: { index_price: 60000 } };
    },
    async listInstruments() {
      return {
        result: [
          { instrument_name: "BTC-17APR26-52000-P" },
          { instrument_name: "BTC-24APR26-51000-P" }
        ]
      };
    },
    async getOrderBook(instrumentId: string) {
      if (instrumentId.includes("17APR26")) {
        return { result: { asks: [[0.012, 12]], mark_price: 0.011 } };
      }
      return { result: { asks: [[0.014, 10]], mark_price: 0.013 } };
    }
  } as any;
  const output = await compareLiveDeribitByTenor({
    deribit: deribitMock,
    env: "testnet",
    tenorsDays: [14, 21],
    notionalsUsd: [5000],
    tiers: ["Pro (Bronze)"],
    asOf: new Date("2026-04-03T00:00:00.000Z")
  });
  assert.equal(output.rows.length, 2);
  assert.equal(output.summaryByTenor.length, 2);
  assert.equal(output.summaryByTenor[0].tenorDaysRequested, 14);
  assert.equal(output.summaryByTenor[1].tenorDaysRequested, 21);
  assert.equal(output.summaryByTenor[0].nRows, 1);
  assert.equal(output.summaryByTenor[1].nRows, 1);
  assert.equal(output.rows.every((row) => row.error === null), true);
  assert.equal(output.rows[0].strictMethod, "floor_profitability");
  assert.equal(output.rows[0].hybridMethod?.startsWith("hybrid_"), true);
});
