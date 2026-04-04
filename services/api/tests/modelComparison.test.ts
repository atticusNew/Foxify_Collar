import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import {
  buildLiveDeribitComparisonInputs,
  comparePricingModels,
  comparisonRowsToCsv,
  parseComparisonInputFixture
} from "../src/pilot/modelComparison";

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
  assert.equal(result.rows[0].hybridMethod, "hybrid_strict_discount");
  assert.equal(result.rows[0].strictClientPremiumUsd, "210.5000000000");
  assert.equal(result.rows[0].hybridClientPremiumUsd, "126.3000000000");
  assert.equal(result.summary.nRows, 1);
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
