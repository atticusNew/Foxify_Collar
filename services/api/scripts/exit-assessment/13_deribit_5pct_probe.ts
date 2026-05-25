/**
 * Same probe but on Deribit, for fallback comparison.
 * READ ONLY (uses authenticated user_trades for context but only public for OB).
 */

const DERIBIT = "https://www.deribit.com/api/v2";
const POSITION_NOTIONAL_USD = 200_000;
const TARGET_PUT_PCT = 0.05;

const fetchJson = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json() as Promise<T>;
};

const main = async () => {
  console.log("# Deribit $200k @ 5% Put Probe (fallback comparison)\n");

  const idx = await fetchJson<any>(`${DERIBIT}/public/get_index_price?index_name=btc_usd`);
  const btcSpot = idx.result.index_price;
  const targetStrike = btcSpot * (1 - TARGET_PUT_PCT);
  const btcNotional = POSITION_NOTIONAL_USD / btcSpot;
  console.log(`BTC index: $${btcSpot.toFixed(2)}`);
  console.log(`Target put strike: $${targetStrike.toFixed(2)}`);
  console.log(`BTC notional needed: ${btcNotional.toFixed(4)} BTC\n`);

  // Get all BTC option instruments
  const ins = await fetchJson<any>(`${DERIBIT}/public/get_instruments?currency=BTC&kind=option&expired=false`);
  const puts = ins.result.filter((i: any) => i.option_type === "put");

  // Group by expiry, find closest strike to target
  const byExpiry: Record<string, any[]> = {};
  for (const p of puts) {
    const exp = new Date(p.expiration_timestamp).toISOString();
    if (!byExpiry[exp]) byExpiry[exp] = [];
    byExpiry[exp].push(p);
  }
  const expiries = Object.keys(byExpiry).sort();

  const candidates: any[] = [];
  for (const exp of expiries) {
    const days = (new Date(exp).getTime() - Date.now()) / 86_400_000;
    if (days < 0.5 || days > 90) continue;
    const strikes = byExpiry[exp];
    let closest: any = null;
    let minD = Infinity;
    for (const s of strikes) {
      const d = Math.abs(Number(s.strike) - targetStrike);
      if (d < minD) { minD = d; closest = s; }
    }
    if (closest) {
      candidates.push({
        expiry: exp,
        days,
        instrument: closest.instrument_name,
        strike: Number(closest.strike),
        distancePct: ((btcSpot - Number(closest.strike)) / btcSpot) * 100
      });
    }
  }

  console.log("Candidates (closest 5% put per expiry):");
  for (const c of candidates) {
    console.log(`  ${c.expiry} (${c.days.toFixed(1)}d) → ${c.instrument} strike=$${c.strike} (${c.distancePct.toFixed(2)}% below spot)`);
  }

  console.log(`\n\nDeribit liquidity & per-day cost:`);
  console.log("=".repeat(120));
  console.log("Expiry".padEnd(28) + " | Days  | Strike    | BestAsk(BTC) | AskSizeBTC | Cost(USD) | PerDay$");
  console.log("-".repeat(120));

  const results: any[] = [];
  for (const c of candidates) {
    try {
      const ob = await fetchJson<any>(`${DERIBIT}/public/get_order_book?instrument_name=${c.instrument}&depth=10`);
      const asks = ob.result.asks ?? [];
      const bestAsk = asks[0] ?? null;
      // Deribit asks: [price, size] where price is in BTC, size is # contracts (usually 1 contract = 1 BTC for puts)
      let remaining = btcNotional;
      let totalBtc = 0;
      let filledBtc = 0;
      let totalDepthBtc = 0;
      for (const [price, size] of asks) {
        const sz = Number(size);
        const px = Number(price);
        totalDepthBtc += sz;
        if (remaining <= 0) continue;
        const take = Math.min(remaining, sz);
        totalBtc += take * px;
        remaining -= take;
        filledBtc += take;
      }
      const totalUsd = totalBtc * btcSpot;
      const perDay = totalUsd / c.days;
      results.push({ ...c, bestAskBtc: bestAsk?.[0], askSizeBtc: bestAsk?.[1], totalBtc, totalUsd, perDay, fillablePct: (filledBtc / btcNotional) * 100 });
      console.log(
        `${c.expiry.padEnd(28)} | ${c.days.toFixed(1).padEnd(5)} | $${c.strike.toFixed(0).padEnd(8)} | ${bestAsk?.[0] ?? "n/a"} BTC | ${(bestAsk?.[1] ?? 0).toFixed(2).padEnd(10)} | $${totalUsd.toFixed(0).padEnd(8)} | $${perDay.toFixed(0)}`
      );
    } catch (e) {
      console.log(`${c.expiry.padEnd(28)} | err: ${(e as Error).message.slice(0,40)}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n\nSorted by per-day cost (cheapest first):`);
  results.sort((a, b) => a.perDay - b.perDay);
  for (const r of results) {
    console.log(`  ${r.days.toFixed(1)}d → $${r.perDay.toFixed(0)}/day | total $${r.totalUsd.toFixed(0)} | ${r.fillablePct.toFixed(0)}% fillable`);
  }
};

main().catch(e => { console.error(e); process.exit(1); });
