/**
 * Phase B — Unwind quote analysis.
 *
 * For each of the 3 orphan hedges, pull live order book from Deribit
 * and project realistic sell-side proceeds (best bid, mid, depth).
 *
 * READ ONLY.
 */

const CLIENT_ID = process.env.DERIBIT_CLIENT_ID!;
const CLIENT_SECRET = process.env.DERIBIT_CLIENT_SECRET!;
const BASE_URL = "https://www.deribit.com/api/v2";

const ORPHANS = [
  { instrument: "BTC-22MAY26-78000-P", quantity: 0.2, avgBuyPrice: 0.01675 },
  { instrument: "BTC-22MAY26-83000-C", quantity: 0.1, avgBuyPrice: 0.024 },
  { instrument: "BTC-22MAY26-84000-C", quantity: 0.2, avgBuyPrice: 0.015 }
];

const auth = async () => {
  const r = await fetch(
    `${BASE_URL}/public/auth?grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`
  );
  return (await r.json() as any).result.access_token;
};

const main = async () => {
  console.log("# Phase B — Unwind quote analysis\n");
  const token = await auth();

  // Get current BTC index
  const idx = await fetch(`${BASE_URL}/public/get_index_price?index_name=btc_usd`).then(r => r.json()) as any;
  const btcSpot = idx.result.index_price;
  console.log(`BTC index: $${btcSpot.toFixed(2)}\n`);

  for (const o of ORPHANS) {
    const ob = await fetch(
      `${BASE_URL}/public/get_order_book?instrument_name=${o.instrument}&depth=10`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).then(r => r.json()) as any;

    const r = ob.result;
    const bestBid = r.bids?.[0] ?? [0, 0];
    const bestAsk = r.asks?.[0] ?? [0, 0];
    const mid = (bestBid[0] + bestAsk[0]) / 2;
    const mark = r.mark_price;
    const totalBidDepth5 = (r.bids ?? []).slice(0, 5).reduce((s: number, b: any) => s + b[1], 0);

    console.log(`=== ${o.instrument} ===`);
    console.log(`  Strike: $${o.instrument.match(/(\d+)-(C|P)$/)![1]}, ${o.instrument.endsWith("-P") ? "PUT" : "CALL"}`);
    console.log(`  We hold: ${o.quantity} BTC long @ avg ${o.avgBuyPrice} BTC ($${(o.avgBuyPrice * btcSpot).toFixed(2)} per contract)`);
    console.log(`  Original cost: $${(o.avgBuyPrice * o.quantity * btcSpot).toFixed(2)}`);
    console.log(`  Mark price:    ${mark} BTC`);
    console.log(`  Best BID:      ${bestBid[0]} BTC (size ${bestBid[1]})`);
    console.log(`  Best ASK:      ${bestAsk[0]} BTC (size ${bestAsk[1]})`);
    console.log(`  Mid:           ${mid.toFixed(6)} BTC`);
    console.log(`  Bid depth (top 5): ${totalBidDepth5} BTC available to lift`);
    console.log("");
    console.log(`  IF SOLD AT BEST BID: ${(bestBid[0] * o.quantity).toFixed(6)} BTC = $${(bestBid[0] * o.quantity * btcSpot).toFixed(2)}`);
    console.log(`  IF SOLD AT MID:      ${(mid * o.quantity).toFixed(6)} BTC = $${(mid * o.quantity * btcSpot).toFixed(2)}`);
    console.log(`  IF SOLD AT MARK:     ${(mark * o.quantity).toFixed(6)} BTC = $${(mark * o.quantity * btcSpot).toFixed(2)}`);
    console.log("");
    console.log(`  P&L (vs avg buy at MID):  ${((mid - o.avgBuyPrice) * o.quantity).toFixed(6)} BTC = $${((mid - o.avgBuyPrice) * o.quantity * btcSpot).toFixed(2)}`);
    console.log(`  P&L (vs avg buy at BID):  ${((bestBid[0] - o.avgBuyPrice) * o.quantity).toFixed(6)} BTC = $${((bestBid[0] - o.avgBuyPrice) * o.quantity * btcSpot).toFixed(2)}`);
    console.log("");

    // ITM/OTM analysis
    const strike = parseInt(o.instrument.match(/(\d+)-(C|P)$/)![1]);
    const isPut = o.instrument.endsWith("-P");
    const itm = isPut ? btcSpot < strike : btcSpot > strike;
    const distancePct = isPut
      ? ((strike - btcSpot) / btcSpot) * 100
      : ((btcSpot - strike) / btcSpot) * 100;
    console.log(`  Status: ${itm ? "ITM" : "OTM"} by ${Math.abs(distancePct).toFixed(2)}%`);

    // Days to expiry
    const expiryStr = o.instrument.match(/-(\d+[A-Z]+\d+)-/)![1];
    const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    const day = parseInt(expiryStr.match(/^(\d+)/)![1]);
    const monAbbrev = expiryStr.match(/[A-Z]+/)![0];
    const yr = 2000 + parseInt(expiryStr.slice(-2));
    const expiryDate = new Date(Date.UTC(yr, months.indexOf(monAbbrev), day, 8, 0, 0));
    const daysToExpiry = (expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    console.log(`  Expires: ${expiryDate.toISOString()} (in ${daysToExpiry.toFixed(2)} days)`);
    console.log("");
  }
};

main().catch(console.error);
