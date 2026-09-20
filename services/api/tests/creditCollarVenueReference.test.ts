import assert from "node:assert/strict";
import test from "node:test";

import {
  bullishLegReader,
  bullishSymbol,
  deribitInstrument,
  deribitLegReader,
  parseBullishBook,
  parseDeribitTicker,
  parseOkxInstId,
  readVenueReference,
  summarizeVenueReference,
  type LegReader,
  type PerpVenueReference,
} from "../src/singleSide/twoSided/creditCollar/perpShadow/venueReference";

// ── instrument names ─────────────────────────────────────────────────────────

test("venue reference: OKX instrument ids parse and translate to Deribit and Bullish names", () => {
  const leg = parseOkxInstId("BTC-USD-260925-110000-C");
  assert.deepEqual(leg, { yymmdd: "260925", strike: 110000, cp: "C" });
  assert.equal(deribitInstrument(leg!), "BTC-25SEP26-110000-C");
  assert.equal(bullishSymbol(leg!), "BTC-USDC-20260925-110000-C");
  // a single-digit day has no leading zero at Deribit
  assert.equal(deribitInstrument(parseOkxInstId("BTC-USD-261002-76000-P")!), "BTC-2OCT26-76000-P");
  assert.equal(bullishSymbol(parseOkxInstId("BTC-USD-261002-76000-P")!), "BTC-USDC-20261002-76000-P");
  // paper-model ids, ETH, junk: null (the reference only reads listed BTC legs)
  assert.equal(parseOkxInstId("BTC-USD-260925-110000-C (model)"), null);
  assert.equal(parseOkxInstId("ETH-USD-260925-4000-C"), null);
  assert.equal(parseOkxInstId(""), null);
});

// ── parsers ──────────────────────────────────────────────────────────────────

test("venue reference: Deribit ticker is BTC × underlying, zero bid is 'no bid', missing underlying is unreadable", () => {
  const t = parseDeribitTicker({ result: { best_bid_price: 0.0, best_ask_price: 0.0001, underlying_price: 80_000, index_price: 79_990 } }, "BTC-25SEP26-110000-C");
  assert.deepEqual(t, { instrument: "BTC-25SEP26-110000-C", bidCents: null, askCents: 800 });
  const both = parseDeribitTicker({ result: { best_bid_price: 0.01, best_ask_price: 0.0125, underlying_price: 80_000 } }, "x");
  assert.equal(both?.bidCents, 80_000);
  assert.equal(both?.askCents, 100_000);
  assert.equal(parseDeribitTicker({ result: { best_bid_price: 0.01, best_ask_price: 0.0125 } }, "x"), null);
  assert.equal(parseDeribitTicker({ error: { code: 1 } }, "x"), null);
});

test("venue reference: Bullish hybrid book is USDC at the top, an empty side is null", () => {
  const b = parseBullishBook({ symbol: "s", bids: [], asks: [{ price: "10.0000", priceLevelQuantity: "0.2" }] }, "s");
  assert.deepEqual(b, { instrument: "s", bidCents: null, askCents: 1000 });
  const both = parseBullishBook({ bids: [{ price: "812.5" }, { price: "800" }], asks: [{ price: "890.25" }] }, "s");
  assert.equal(both?.bidCents, 81_250);
  assert.equal(both?.askCents, 89_025);
  assert.equal(parseBullishBook({ message: "not found" }, "s"), null);
  assert.equal(parseBullishBook(null, "s"), null);
});

// ── the reference ────────────────────────────────────────────────────────────

const fixed =
  (table: Record<string, { bid: number | null; ask: number | null }>): LegReader =>
  async (leg) => {
    const k = `${leg.strike}-${leg.cp}`;
    const t = table[k];
    if (!t) throw new Error(`no fixture for ${k}`);
    return { instrument: k, bidCents: t.bid, askCents: t.ask };
  };

test("venue reference: both legs at both venues, the collar's net compared to OKX leg for leg", async () => {
  // long collar on OKX at spot 80,000: buy the 75k put at 0.0125 BTC ($1,000), sell the 86k call at 0.01 BTC ($800) ⟹ OKX net −$200/BTC
  const ref = await readVenueReference(
    { buyInstId: "BTC-USD-260925-75000-P", sellInstId: "BTC-USD-260925-86000-C", buyPxBtc: 0.0125, sellPxBtc: 0.01, spot: 80_000 },
    {
      // Deribit: tighter — put ask $980, call bid $810 ⟹ net −$170 (+$30 vs OKX)
      deribit: fixed({ "75000-P": { bid: 95_000, ask: 98_000 }, "86000-C": { bid: 81_000, ask: 84_000 } }),
      // Bullish: wider — put ask $1,050, call bid $760 ⟹ net −$290 (−$90 vs OKX)
      bullish: fixed({ "75000-P": { bid: 90_000, ask: 105_000 }, "86000-C": { bid: 76_000, ask: 90_000 } }),
    },
  );
  assert.ok(ref);
  assert.deepEqual(ref!.okx, { buyAskCents: 100_000, sellBidCents: 80_000, netCents: -20_000 });
  const d = ref!.venues.deribit;
  assert.equal(d.ok, true);
  assert.equal(d.netCents, -17_000);
  assert.equal(d.vsOkxCents, 3_000);
  assert.equal(d.vsOkxBps, 3.75, "$30 on $80,000 spot");
  const b = ref!.venues.bullish;
  assert.equal(b.netCents, -29_000);
  assert.equal(b.vsOkxCents, -9_000);
  assert.equal(b.vsOkxBps, -11.25);
});

test("venue reference: a venue missing a side has no net; a venue that fails to read is recorded, never thrown", async () => {
  const ref = await readVenueReference(
    { buyInstId: "BTC-USD-260925-75000-P", sellInstId: "BTC-USD-260925-86000-C", buyPxBtc: 0.0125, sellPxBtc: 0.01, spot: 80_000 },
    {
      deribit: fixed({ "75000-P": { bid: 95_000, ask: 98_000 }, "86000-C": { bid: null, ask: 84_000 } }),
      bullish: async () => {
        throw new Error("Bullish orderbook HTTP 503");
      },
    },
  );
  assert.ok(ref);
  const d = ref!.venues.deribit;
  assert.equal(d.ok, true);
  assert.equal(d.buy?.askCents, 98_000);
  assert.equal(d.sell?.bidCents, null);
  assert.equal(d.netCents, null);
  assert.equal(d.vsOkxBps, null);
  const b = ref!.venues.bullish;
  assert.equal(b.ok, false);
  assert.match(b.error ?? "", /503/);
  assert.equal(b.netCents, null);
});

test("venue reference: unparseable legs or no spot ⟹ null (nothing invented)", async () => {
  assert.equal(await readVenueReference({ buyInstId: "BTC-USD-260925-75000-P (model)", sellInstId: "BTC-USD-260925-86000-C", buyPxBtc: 0.01, sellPxBtc: 0.01, spot: 80_000 }, {}), null);
  assert.equal(await readVenueReference({ buyInstId: "BTC-USD-260925-75000-P", sellInstId: "BTC-USD-260925-86000-C", buyPxBtc: 0.01, sellPxBtc: 0.01, spot: 0 }, {}), null);
});

test("venue reference: the live readers build the right URLs and normalise units", async () => {
  const urls: string[] = [];
  const f = (async (url: string | URL | Request) => {
    const u = String(url);
    urls.push(u);
    if (u.startsWith("https://d.test/")) return new Response(JSON.stringify({ result: { best_bid_price: 0.01, best_ask_price: 0.0125, underlying_price: 80_000 } }), { status: 200 });
    if (u.includes("110000")) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ bids: [{ price: "800" }], asks: [{ price: "1000" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const leg = parseOkxInstId("BTC-USD-260925-86000-C")!;
  const d = await deribitLegReader("https://d.test", f)(leg);
  assert.deepEqual(d, { instrument: "BTC-25SEP26-86000-C", bidCents: 80_000, askCents: 100_000 });
  const b = await bullishLegReader("https://b.test", f)(leg);
  assert.deepEqual(b, { instrument: "BTC-USDC-20260925-86000-C", bidCents: 80_000, askCents: 100_000 });
  const unlisted = await bullishLegReader("https://b.test", f)(parseOkxInstId("BTC-USD-260925-110000-C")!);
  assert.deepEqual(unlisted, { instrument: "BTC-USDC-20260925-110000-C", bidCents: null, askCents: null }, "404 at Bullish = not listed there, not an error");
  assert.ok(urls.some((u) => u === "https://d.test/api/v2/public/ticker?instrument_name=BTC-25SEP26-86000-C"));
  assert.ok(urls.some((u) => u === "https://b.test/trading-api/v1/markets/BTC-USDC-20260925-86000-C/orderbook/hybrid"));
});

// ── the summary ──────────────────────────────────────────────────────────────

const refWith = (deribitVs: number | null, bullishOk: boolean, bullishVs: number | null): PerpVenueReference => ({
  okx: { buyAskCents: 100_000, sellBidCents: 80_000, netCents: -20_000 },
  venues: {
    deribit: {
      ok: true,
      buy: { instrument: "p", bidCents: 1, askCents: 98_000 },
      sell: { instrument: "c", bidCents: deribitVs == null ? null : 78_000 + deribitVs, askCents: 1 },
      netCents: deribitVs == null ? null : -20_000 + deribitVs,
      vsOkxCents: deribitVs,
      vsOkxBps: deribitVs == null ? null : +((deribitVs / 100 / 80_000) * 10000).toFixed(2),
    },
    bullish: bullishOk
      ? {
          ok: true,
          buy: { instrument: "p", bidCents: 1, askCents: 105_000 },
          sell: { instrument: "c", bidCents: bullishVs == null ? null : 1, askCents: 1 },
          netCents: bullishVs == null ? null : -20_000 + bullishVs,
          vsOkxCents: bullishVs,
          vsOkxBps: bullishVs == null ? null : +((bullishVs / 100 / 80_000) * 10000).toFixed(2),
        }
      : { ok: false, error: "HTTP 503", buy: null, sell: null, netCents: null, vsOkxCents: null, vsOkxBps: null },
  },
});

test("venue reference summary: reads, both-sides, beat-OKX count, average gap, side availability, errors — per venue", () => {
  const s = summarizeVenueReference([
    refWith(3_000, true, -9_000), // Deribit +$30, Bullish −$90
    refWith(-1_000, false, null), // Deribit −$10, Bullish failed
    refWith(null, true, null), // Deribit no cap bid, Bullish no cap bid
    null, // a record from before the reference existed
    undefined,
  ]);
  const d = s.deribit;
  assert.equal(d.read, 3);
  assert.equal(d.priced, 2);
  assert.equal(d.beatOkx, 1);
  assert.equal(d.avgVsOkxCents, 1_000, "(+$30 − $10) / 2");
  assert.equal(d.avgVsOkxBps, 1.25);
  assert.equal(d.buyAskPct, 100);
  assert.equal(d.sellBidPct, 66.7);
  assert.equal(d.errors, 0);
  const b = s.bullish;
  assert.equal(b.read, 3);
  assert.equal(b.errors, 1);
  assert.equal(b.priced, 1);
  assert.equal(b.beatOkx, 0);
  assert.equal(b.avgVsOkxCents, -9_000);
  assert.equal(b.buyAskPct, 100, "over the two reads that did not error");
  assert.equal(b.sellBidPct, 50);
});

test("venue reference summary: nothing read ⟹ zeros and nulls, never NaN", () => {
  const s = summarizeVenueReference([null, undefined]);
  assert.deepEqual(s.deribit, { read: 0, priced: 0, beatOkx: 0, avgVsOkxBps: null, avgVsOkxCents: null, buyAskPct: null, sellBidPct: null, errors: 0 });
  assert.deepEqual(s.bullish, s.deribit);
});
