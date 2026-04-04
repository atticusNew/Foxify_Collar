import Decimal from "decimal.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BullishTradingClient } from "../src/pilot/bullish";
import { resolvePremiumPricing } from "../src/pilot/pricingPolicy";
import { normalizeTierName, resolveDrawdownFloorPct } from "../src/pilot/floor";
import { pilotConfig } from "../src/pilot/config";

type CompareInput = {
  protectedNotionalUsd: number;
  tierName: string;
  protectionType: "long" | "short";
  tenorDays: number;
  symbolHint?: string;
  outJsonPath: string | null;
  outCsvPath: string | null;
};

const parseArgs = (argv: string[]): CompareInput => {
  const out: CompareInput = {
    protectedNotionalUsd: Number(process.env.BULLISH_COMPARE_NOTIONAL || "5000"),
    tierName: process.env.BULLISH_COMPARE_TIER || "Pro (Bronze)",
    protectionType: (process.env.BULLISH_COMPARE_PROTECTION_TYPE || "long").toLowerCase() === "short" ? "short" : "long",
    tenorDays: Math.max(1, Number(process.env.BULLISH_COMPARE_TENOR_DAYS || "7") || 7),
    symbolHint: process.env.BULLISH_COMPARE_SYMBOL || "BTCUSDC",
    outJsonPath: process.env.BULLISH_COMPARE_OUT_JSON || null,
    outCsvPath: process.env.BULLISH_COMPARE_OUT_CSV || null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--notional" && argv[i + 1]) {
      out.protectedNotionalUsd = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--tier" && argv[i + 1]) {
      out.tierName = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--protection-type" && argv[i + 1]) {
      out.protectionType = String(argv[i + 1]).toLowerCase() === "short" ? "short" : "long";
      i += 1;
      continue;
    }
    if (token === "--tenor-days" && argv[i + 1]) {
      out.tenorDays = Math.max(1, Number(argv[i + 1]) || 7);
      i += 1;
      continue;
    }
    if (token === "--symbol" && argv[i + 1]) {
      out.symbolHint = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--out-json" && argv[i + 1]) {
      out.outJsonPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--out-csv" && argv[i + 1]) {
      out.outCsvPath = argv[i + 1];
      i += 1;
      continue;
    }
  }
  if (!Number.isFinite(out.protectedNotionalUsd) || out.protectedNotionalUsd <= 0) {
    throw new Error("invalid_notional");
  }
  return out;
};

const escapeCsv = (raw: string): string => {
  if (!raw.includes(",") && !raw.includes("\"") && !raw.includes("\n")) return raw;
  return `"${raw.replace(/"/g, "\"\"")}"`;
};

const rowsToCsv = (rows: Array<Record<string, string | number | boolean>>): string => {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((key) => escapeCsv(String(row[key] ?? ""))).join(","));
  }
  return `${lines.join("\n")}\n`;
};

const ensureParentDir = async (targetPath: string): Promise<void> => {
  await mkdir(path.dirname(targetPath), { recursive: true });
};

const toFinitePositive = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const parseBullishOptionSymbol = (
  symbol: string
): { expiryMs: number; strike: number; optionType: "CALL" | "PUT" } | null => {
  const match = String(symbol || "")
    .trim()
    .toUpperCase()
    .match(/^BTC-USDC-(\d{8})-(\d+(?:\.\d+)*)-(C|P)$/);
  if (!match) return null;
  const strike = Number(match[2]);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  const expiryRaw = match[1];
  const year = Number(expiryRaw.slice(0, 4));
  const month = Number(expiryRaw.slice(4, 6));
  const day = Number(expiryRaw.slice(6, 8));
  const expiryMs = Date.UTC(year, month - 1, day, 8, 0, 0, 0);
  if (!Number.isFinite(expiryMs)) return null;
  return {
    expiryMs,
    strike,
    optionType: match[3] === "C" ? "CALL" : "PUT"
  };
};

const resolveReferenceSpot = async (client: BullishTradingClient, symbol: string): Promise<number> => {
  const orderbook = await client.getHybridOrderBook(symbol);
  const ask = toFinitePositive(orderbook.asks[0]?.price);
  const bid = toFinitePositive(orderbook.bids[0]?.price);
  if (ask && bid) return (ask + bid) / 2;
  if (ask) return ask;
  if (bid) return bid;
  throw new Error("bullish_reference_spot_unavailable");
};

const selectOptionSymbol = async (params: {
  client: BullishTradingClient;
  triggerPrice: number;
  tenorDays: number;
  protectionType: "long" | "short";
}): Promise<{ symbol: string; strike: number; expiryMs: number }> => {
  const requestedOptionType = params.protectionType === "short" ? "CALL" : "PUT";
  const targetExpiryMs = Date.now() + params.tenorDays * 86400000;
  const markets = await params.client.getMarkets({ forceRefresh: true });
  const candidates = markets
    .map((market) => {
      if (String(market.marketType || "").toUpperCase() !== "OPTION") return null;
      const parsed = parseBullishOptionSymbol(String(market.symbol || ""));
      if (!parsed || parsed.optionType !== requestedOptionType) return null;
      if (parsed.expiryMs <= Date.now()) return null;
      if (market.createOrderEnabled === false) return null;
      return {
        symbol: String(market.symbol || ""),
        strike: parsed.strike,
        expiryMs: parsed.expiryMs,
        tenorDriftDays: Math.abs(parsed.expiryMs - targetExpiryMs) / 86400000,
        strikeDistancePct: Math.abs(parsed.strike - params.triggerPrice) / params.triggerPrice
      };
    })
    .filter(
      (entry): entry is { symbol: string; strike: number; expiryMs: number; tenorDriftDays: number; strikeDistancePct: number } =>
        Boolean(entry)
    )
    .sort((a, b) => {
      if (a.tenorDriftDays !== b.tenorDriftDays) return a.tenorDriftDays - b.tenorDriftDays;
      if (a.strikeDistancePct !== b.strikeDistancePct) return a.strikeDistancePct - b.strikeDistancePct;
      return a.expiryMs - b.expiryMs;
    });
  for (const candidate of candidates.slice(0, 25)) {
    const book = await params.client.getHybridOrderBook(candidate.symbol);
    const askPx = toFinitePositive(book.asks[0]?.price);
    const askQty = toFinitePositive(book.asks[0]?.quantity);
    if (askPx && askQty) {
      return {
        symbol: candidate.symbol,
        strike: candidate.strike,
        expiryMs: candidate.expiryMs
      };
    }
  }
  throw new Error("bullish_option_selection_failed");
};

const main = async () => {
  const input = parseArgs(process.argv.slice(2));
  const tierName = normalizeTierName(input.tierName);
  const drawdownFloorPct = resolveDrawdownFloorPct({
    tierName
  });
  const client = new BullishTradingClient(pilotConfig.bullish);
  const spotSymbol = input.symbolHint || "BTCUSDC";
  const spot = await resolveReferenceSpot(client, spotSymbol);
  const triggerPrice = input.protectionType === "short" ? spot * (1 + drawdownFloorPct.toNumber()) : spot * (1 - drawdownFloorPct.toNumber());
  const quantity = Number(new Decimal(input.protectedNotionalUsd).div(spot).toDecimalPlaces(8).toString());
  const selected = await selectOptionSymbol({
    client,
    triggerPrice,
    tenorDays: input.tenorDays,
    protectionType: input.protectionType
  });
  const optionBook = await client.getHybridOrderBook(selected.symbol);
  const bestAskPrice = new Decimal(toFinitePositive(optionBook.asks[0]?.price) || 0);
  const hedgePremium = bestAskPrice.mul(quantity);
  if (hedgePremium.lte(0)) {
    throw new Error("bullish_option_best_ask_missing");
  }
  const strict = resolvePremiumPricing({
    pricingMode: "actuarial_strict",
    tierName,
    protectedNotional: new Decimal(input.protectedNotionalUsd),
    drawdownFloorPct,
    hedgePremium
  });
  const hybrid = resolvePremiumPricing({
    pricingMode: "hybrid_otm_treasury",
    tierName,
    protectedNotional: new Decimal(input.protectedNotionalUsd),
    drawdownFloorPct,
    hedgePremium
  });
  const out = {
    status: "ok",
    profile: pilotConfig.profile,
    input: {
      protectedNotionalUsd: input.protectedNotionalUsd,
      tierName,
      protectionType: input.protectionType,
      tenorDays: input.tenorDays,
      drawdownFloorPct: drawdownFloorPct.toFixed(6),
      referenceSpot: spot.toFixed(6),
      triggerPrice: triggerPrice.toFixed(6),
      quantity: quantity.toFixed(8)
    },
    selectedOption: {
      symbol: selected.symbol,
      strike: selected.strike,
      expiryIso: new Date(selected.expiryMs).toISOString(),
      bestAskPrice: bestAskPrice.toFixed(10),
      bestAskQuantity: String(optionBook.asks[0]?.quantity || "")
    },
    pricing: {
      hedgePremiumUsd: hedgePremium.toFixed(10),
      actuarialStrictClientPremiumUsd: strict.clientPremiumUsd.toFixed(10),
      hybridLockedClientPremiumUsd: hybrid.clientPremiumUsd.toFixed(10),
      strictMethod: strict.method,
      hybridMethod: hybrid.method,
      hybridStrictMultiplier: hybrid.hybridStrictMultiplier.toFixed(6),
      deltaHybridMinusStrictUsd: hybrid.clientPremiumUsd.minus(strict.clientPremiumUsd).toFixed(10),
      deltaHybridMinusStrictPct: strict.clientPremiumUsd.gt(0)
        ? hybrid.clientPremiumUsd.minus(strict.clientPremiumUsd).div(strict.clientPremiumUsd).mul(100).toFixed(6)
        : "0"
    }
  } as const;

  if (input.outJsonPath) {
    await ensureParentDir(input.outJsonPath);
    await writeFile(input.outJsonPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  }
  if (input.outCsvPath) {
    await ensureParentDir(input.outCsvPath);
    const csvRows = [
      {
        profile: out.profile,
        tierName: out.input.tierName,
        protectionType: out.input.protectionType,
        tenorDays: out.input.tenorDays,
        protectedNotionalUsd: out.input.protectedNotionalUsd,
        drawdownFloorPct: out.input.drawdownFloorPct,
        referenceSpot: out.input.referenceSpot,
        triggerPrice: out.input.triggerPrice,
        quantity: out.input.quantity,
        selectedSymbol: out.selectedOption.symbol,
        selectedStrike: out.selectedOption.strike,
        selectedExpiryIso: out.selectedOption.expiryIso,
        bestAskPrice: out.selectedOption.bestAskPrice,
        bestAskQuantity: out.selectedOption.bestAskQuantity,
        hedgePremiumUsd: out.pricing.hedgePremiumUsd,
        actuarialStrictClientPremiumUsd: out.pricing.actuarialStrictClientPremiumUsd,
        hybridLockedClientPremiumUsd: out.pricing.hybridLockedClientPremiumUsd,
        hybridStrictMultiplier: out.pricing.hybridStrictMultiplier,
        deltaHybridMinusStrictUsd: out.pricing.deltaHybridMinusStrictUsd,
        deltaHybridMinusStrictPct: out.pricing.deltaHybridMinusStrictPct
      }
    ] satisfies Array<Record<string, string | number | boolean>>;
    await writeFile(input.outCsvPath, rowsToCsv(csvRows), "utf8");
  }

  console.log(JSON.stringify({ ...out, files: { outJson: input.outJsonPath, outCsv: input.outCsvPath } }, null, 2));
};

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        status: "error",
        reason: "bullish_pricing_compare_failed",
        message: String((error as Error)?.message || error)
      },
      null,
      2
    )
  );
  process.exit(1);
});
