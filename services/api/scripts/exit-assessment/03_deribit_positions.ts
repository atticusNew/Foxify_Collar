/**
 * Phase A2 — Pull live Deribit account positions + recent trade history.
 *
 * Source of truth for what is actually still open in the account.
 * Cross-references against DB to identify the orphaned hedges.
 *
 * READ ONLY. Uses public Deribit REST API only — no order placement.
 */

const CLIENT_ID = process.env.DERIBIT_CLIENT_ID;
const CLIENT_SECRET = process.env.DERIBIT_CLIENT_SECRET;
const BASE_URL = "https://www.deribit.com/api/v2";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("DERIBIT_CLIENT_ID / DERIBIT_CLIENT_SECRET not set");
  process.exit(1);
}

const log = (label: string, data?: any) => {
  console.log(`\n=== ${label} ===`);
  if (data !== undefined) {
    console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
  }
};

const authenticate = async (): Promise<string> => {
  const res = await fetch(
    `${BASE_URL}/public/auth?grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`
  );
  if (!res.ok) throw new Error(`auth failed: ${res.status} ${await res.text()}`);
  const json = await res.json() as any;
  if (!json.result?.access_token) {
    throw new Error(`auth response missing access_token: ${JSON.stringify(json)}`);
  }
  return json.result.access_token;
};

const callPrivate = async (path: string, params: Record<string, any>, token: string): Promise<any> => {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();
  const url = `${BASE_URL}/private/${path}?${qs}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${text}`);
  return JSON.parse(text);
};

const main = async () => {
  console.log("# Pilot Exit — Deribit Positions");
  console.log(`# Generated: ${new Date().toISOString()}\n`);

  const token = await authenticate();
  console.log("Authenticated successfully.");

  // 1. Account summary (BTC)
  const summary = await callPrivate("get_account_summary", { currency: "BTC", extended: true }, token);
  log("Account summary (BTC)", {
    equity: summary.result.equity,
    balance: summary.result.balance,
    available_funds: summary.result.available_funds,
    total_pl: summary.result.total_pl,
    options_value: summary.result.options_value,
    options_pl: summary.result.options_pl,
    options_delta: summary.result.options_delta,
    options_gamma: summary.result.options_gamma,
    options_theta: summary.result.options_theta,
    options_vega: summary.result.options_vega,
    margin_balance: summary.result.margin_balance,
    initial_margin: summary.result.initial_margin,
    maintenance_margin: summary.result.maintenance_margin
  });

  // 2. Account summary (USDC)
  try {
    const summaryUsdc = await callPrivate("get_account_summary", { currency: "USDC", extended: true }, token);
    log("Account summary (USDC)", {
      equity: summaryUsdc.result.equity,
      balance: summaryUsdc.result.balance,
      available_funds: summaryUsdc.result.available_funds,
      options_value: summaryUsdc.result.options_value,
      options_pl: summaryUsdc.result.options_pl
    });
  } catch (err) {
    console.log("USDC account not enabled:", (err as Error).message);
  }

  // 3. Open option positions (BTC)
  const positions = await callPrivate("get_positions", { currency: "BTC", kind: "option" }, token);
  log(`OPEN BTC OPTION POSITIONS (${positions.result.length} total)`);
  if (positions.result.length === 0) {
    console.log("  (none)");
  } else {
    for (const p of positions.result) {
      console.log("");
      console.log(`  Instrument: ${p.instrument_name}`);
      console.log(`    Direction:        ${p.direction}`);
      console.log(`    Size:             ${p.size} contracts`);
      console.log(`    Average price:    ${p.average_price} BTC`);
      console.log(`    Mark price:       ${p.mark_price} BTC`);
      console.log(`    Index price:      ${p.index_price}`);
      console.log(`    Estimated liq:    ${p.estimated_liquidation_price ?? "n/a"}`);
      console.log(`    Floating P&L:     ${p.floating_profit_loss} BTC`);
      console.log(`    Realized P&L:     ${p.realized_profit_loss} BTC`);
      console.log(`    Initial margin:   ${p.initial_margin} BTC`);
      console.log(`    Maintenance:      ${p.maintenance_margin} BTC`);
      console.log(`    Delta:            ${p.delta}`);
    }
  }

  // 4. Active orders (in case any open orders are sitting)
  const orders = await callPrivate("get_open_orders_by_currency", { currency: "BTC", kind: "option" }, token);
  log(`OPEN ORDERS (${orders.result.length} total)`);
  if (orders.result.length === 0) {
    console.log("  (none)");
  } else {
    for (const o of orders.result) {
      console.log(
        `  ${o.order_id} | ${o.instrument_name} | ${o.direction} ${o.amount} @ ${o.price} | ${o.order_state}`
      );
    }
  }

  // 5. Recent fills (last 30) — to see selling activity
  const trades = await callPrivate("get_user_trades_by_currency", {
    currency: "BTC",
    kind: "option",
    count: 30,
    sorting: "desc"
  }, token);
  log(`RECENT TRADES (last 30)`);
  for (const t of trades.result.trades) {
    console.log(
      `  ${new Date(t.timestamp).toISOString()} | ${t.instrument_name} | ${t.direction} ${t.amount} @ ${t.price} BTC | order=${t.order_id}`
    );
  }
};

main().catch((err) => {
  console.error("\n!!! Failed:", err);
  process.exit(1);
});
