import assert from "node:assert/strict";
import test from "node:test";

const withEnv = async (
  updates: Record<string, string | undefined>,
  run: () => Promise<void> | void
): Promise<void> => {
  const snapshot = new Map<string, string | undefined>();
  for (const key of Object.keys(updates)) {
    snapshot.set(key, process.env[key]);
    const value = updates[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await run();
  } finally {
    for (const [key, value] of snapshot.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

test("pilot config supports treasury per-quote cap env alias", async () => {
  await withEnv(
    {
      PILOT_VENUE_MODE: "deribit_test",
      PILOT_PREMIUM_PRICING_MODE: "actuarial_strict",
      PILOT_SELECTOR_MODE: "strict_profitability",
      PILOT_TREASURY_SUBSIDY_CAP_PCT: undefined,
      PILOT_TREASURY_PER_QUOTE_SUBSIDY_CAP_PCT: "0.55"
    },
    async () => {
      const modulePath = new URL("../src/pilot/config.ts", import.meta.url).href;
      const configModule = await import(`${modulePath}?treasuryAliasA=${Date.now()}`);
      assert.equal(configModule.pilotConfig.treasuryPerQuoteSubsidyCapPct, 0.55);
    }
  );
});

test("legacy treasury subsidy cap env still works", async () => {
  await withEnv(
    {
      PILOT_VENUE_MODE: "deribit_test",
      PILOT_PREMIUM_PRICING_MODE: "actuarial_strict",
      PILOT_SELECTOR_MODE: "strict_profitability",
      PILOT_TREASURY_SUBSIDY_CAP_PCT: "0.44",
      PILOT_TREASURY_PER_QUOTE_SUBSIDY_CAP_PCT: undefined
    },
    async () => {
      const modulePath = new URL("../src/pilot/config.ts", import.meta.url).href;
      const configModule = await import(`${modulePath}?treasuryAliasB=${Date.now()}`);
      assert.equal(configModule.pilotConfig.treasuryPerQuoteSubsidyCapPct, 0.44);
    }
  );
});
