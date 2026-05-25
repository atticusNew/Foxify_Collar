# Atticus / Foxify Pilot — Operations Guide

Operational documentation for the Atticus/Foxify pilot protection platform.

## Platform objectives

- **Atticus** protects Foxify Funded trader deposits by purchasing BTC options that pay out when a drawdown floor is breached.
- **Foxify** provides funded trading accounts to traders who pay a deposit and pass an evaluation.
- If a funded trader’s position hits their drawdown limit, Foxify normally loses the funded capital.
- **Atticus steps in:** for a flat premium ($11/1k per 5-day cycle), Atticus buys put options that pay out the drawdown amount, making Foxify whole.

## Foxify FUNDED tier rules

| Tier     | Deposit | Funding | Max drawdown | Position cap | Premium |
|----------|---------|---------|--------------|--------------|---------|
| Bronze   | $500    | $2,500  | 20%          | $2,500       | $27.50  |
| Silver   | $0      | $5,000  | 15%          | $5,000       | $55.00  |
| Gold     | $0      | $7,500  | 12%          | $7,500       | $82.50  |
| Platinum | $0      | $10,000 | 12%          | $10,000      | $110.00 |

## How we got here

- Built and validated pricing engine with Black-Scholes-derived premiums across historical stress periods.
- Tested 13 positions against real Bullish orderbooks (all spread-positive).
- Two real testnet fills confirmed: $5k Bronze (+$15.33 spread), $50k Gold (+$63.53 spread).
- Premium validated: $11/1k flat is profitable across all tiers and market conditions tested.
- Execution hardened: IOC orders, price guard (5% staleness check), auto-cancel, WebSocket fill confirmation.
- 117/117 tests passing at ship (now 161 test cases, 13 IBKR-deprecated failures expected).

## Pilot scope

- **Single user:** Foxify CEO.
- **Simulated perp position:** Frontend tracks position; no real perp open.
- **Real hedge execution** on Bullish SimNext testnet (real option orders placed).
- **Manual premium/payout settlement** post-pilot (admin dashboard buttons).

## Key levers

1. **Premium rate:** $11 per $1,000 notional. Set in `configs/funded_levels.json` (`fixed_price_usdc`). Change requires updating both `configs/funded_levels.json` and `apps/web/public/funded_levels.json`.

2. **Tenor:** 5-day protection cycles. Set in `funded_levels.json` (`expiry_days`) and `PILOT_TENOR_DEFAULT_DAYS` env var.

3. **Hedge optimization toggles** (all default **OFF** for pilot):
   - Auto-renew tenor extension (buy longer-dated option if auto-renew likely).
   - Roll optimization (sell near-expiry option to capture time value).
   - Batch hedging (group multiple protections into one hedge).
   - Dynamic strike (vol-adjusted strike selection based on regime).

4. **Strike selection:** `trigger_aligned` mode selects the put strike closest to the drawdown trigger price.

5. **Regime thresholds:** Calm/neutral/stress regimes adjust hedge selection bias. Configure via `PILOT_HEDGE_REGIME_*` env vars.

6. **Premium regime overlay:** Watch/stress premium surcharges (disabled for pilot). Enable via `PILOT_PREMIUM_REGIME_ENABLED=true`.

## Monitoring

### What to watch

- **Admin dashboard** at `/admin`: platform health, active protections, execution quality, alerts, treasury.
- **`GET /pilot/monitor/status`:** Returns `healthy` boolean, `consecutiveFailures` count, `fillRate`.
- **`GET /pilot/monitor/alerts`:** Recent alerts with severity (`critical` / `warning` / `info`).
- **`POST /pilot/monitor/treasury-check`:** Live Bullish account balance.

### Key metrics

- **Fill rate:** Should be >90%. Below 80% indicates Bullish connectivity or liquidity issues.
- **Consecutive failures:** >3 indicates systemic issue. >5 triggers alert.
- **Treasury balance:** Below $10k = warning. Below $5k = critical.
- **Average slippage:** <10 bps is good. >25 bps indicates thin books.

### Alert types

- `treasury_warning` / `treasury_critical`: Treasury balance thresholds.
- `fill_failure`: Individual hedge fill failed.
- `consecutive_failures`: Multiple sequential fill failures.
- `negative_spread`: Hedge cost exceeds expected premium (unprofitable).

## Incident procedures

### Fill failure

1. Check `/pilot/monitor/status` for `lastFailureReason`.
2. If **`price_guard_rejected`:** Market moved >5% during execution. Automatic retry on next cycle.
3. If **`order_rejected`:** Check Bullish account balance and API status.
4. If **`ws_timeout`:** WebSocket fill confirmation timed out. Check REST fallback for fill.
5. If persistent: Set `PILOT_ACTIVATION_ENABLED=false` to pause execution while investigating.

### Treasury depletion

1. Check `/pilot/admin/metrics` for `reserveAfterOpenPayoutLiabilityUsdc`.
2. If below critical: Pause new protections via `PILOT_ACTIVATION_ENABLED=false`.
3. Review payout history via admin dashboard.
4. Fund treasury account on Bullish.

### Bullish outage

1. Reference price falls back to Deribit/Coinbase (price feed still works).
2. New hedges will fail (venue unavailable).
3. Existing protections continue monitoring (trigger check uses Bullish, falls back).
4. When Bullish recovers: Queued quotes can be re-requested.

### Emergency stop

- Set `PILOT_ACTIVATION_ENABLED=false` in Render dashboard.
- This prevents any new hedge orders from being placed.
- Existing protections continue monitoring and can still trigger payouts.
- Reference price and quote endpoints still work (display-only, no execution).
