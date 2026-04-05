# Production Readiness Audit + Venue Pricing + What's Missing

**Date:** 2026-04-05

---

## 1. Venue Pricing Comparison: Deribit vs Bullish vs FalconX

### Live price comparison (same ~5-day BTC put, today)

| Strike | Deribit (prod) | Bullish (testnet) | Ratio | Notes |
|--------|---------------|------------------|-------|-------|
| $60,000 | $106 ($1.58/1k) | $420 ($6.26/1k) | **4.0x** | Deep OTM, wide testnet spread |
| $64,000 | $429 ($6.40/1k) | $930 ($13.85/1k) | **2.2x** | OTM sweet spot |
| $65,000 | $622 ($9.27/1k) | $910 ($13.56/1k) | **1.5x** | Converges closer to ATM |
| $66,000 | $918 ($13.68/1k) | $1,240 ($18.47/1k) | **1.4x** | |
| $67,000 | $1,318 ($19.63/1k) | $1,830 ($27.26/1k) | **1.4x** | ATM |
| $68,000 | $1,849 ($27.54/1k) | $2,020 ($30.09/1k) | **1.1x** | Near ATM, almost same |
| $70,000 | $3,290 ($49.02/1k) | $3,600 ($53.63/1k) | **1.1x** | ITM, very close |

### Is Deribit cheaper than Bullish?

**Yes, substantially cheaper for OTM puts.** Deribit production pricing is 1.1-4x cheaper depending on strike:
- Deep OTM ($60k): Deribit is **4x cheaper** -- but this is comparing Deribit production vs Bullish testnet
- ATM ($67-68k): only **1.1-1.4x difference** -- narrows significantly
- ITM ($70k): nearly identical pricing

### How accurate is Bullish testnet vs mainnet?

**Bullish testnet (SimNext) has wider spreads** than production will have because:
1. It's a simulated order book with lower liquidity
2. Market makers on testnet quote wider to compensate for fake execution risk
3. No real capital is at stake, so there's less incentive to tighten spreads

**Expect Bullish production pricing to be ~1.3-1.5x what Deribit charges**, not the 2-4x you see on testnet. For OTM puts, that means:
- $64k put: Deribit $6.40/1k -> Bullish prod ~$8-10/1k (vs testnet $13.85/1k)
- $67k ATM: Deribit $19.63/1k -> Bullish prod ~$25-30/1k (vs testnet $27.26/1k)

### What about FalconX?

FalconX is an **OTC derivatives desk**, not an exchange. Key differences:

| Aspect | Deribit | Bullish | FalconX |
|--------|---------|---------|---------|
| Type | CEX order book | CEX order book | OTC RFQ desk |
| Pricing model | Market-driven | Market-driven | Dealer quote |
| Typical spread | Tightest | Medium | Varies by relationship |
| Min trade size | ~0.01 BTC | ~0.001 BTC | Often $50k+ notional |
| Speed | Instant fill | Instant fill | RFQ round-trip ~1-5s |
| Counterparty risk | Exchange | Exchange | Bilateral |
| Historical pricing? | Yes (full API) | No | No (private quotes) |
| Best for | Small-medium hedges | Pilot testing | Large block hedges |

**FalconX pricing**: Typically competitive with or slightly better than Deribit for large sizes ($50k+), but may be **more expensive** for small trades due to dealer spread. They don't publish public pricing.

**The codebase already has a full FalconX adapter** (`FalconxAdapter` in `venue.ts`) with quote + execute. It just needs API credentials (`FALCONX_API_KEY`, `FALCONX_SECRET`, `FALCONX_PASSPHRASE`).

### Venue recommendation for pilot

| Volume | Best venue | Why |
|--------|-----------|-----|
| Pilot ($5-25k positions) | **Bullish** | Already connected, testnet proven, options chain available |
| Scale ($25-100k positions) | **Bullish or Deribit** | Better liquidity at these sizes |
| Large blocks ($100k+) | **FalconX** | OTC pricing competitive at size |

---

## 2. What the Platform IS Missing (Production Gaps)

### Critical (must fix before pilot production)

| # | Gap | Severity | Detail |
|---|-----|----------|--------|
| 1 | **No rate limiting** | HIGH | No HTTP rate limits on any pilot endpoint. A single user could spam quotes and drain treasury. |
| 2 | **No monitoring/alerting** | HIGH | No Sentry, Datadog, Prometheus, or any telemetry. If the venue fails or treasury depletes, nobody gets notified. |
| 3 | **No versioned DB migrations** | MEDIUM | Schema uses `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS` on startup. Works for pilot but fragile for production rollouts. |
| 4 | **Bullish option execution untested** | HIGH | `createSpotLimitOrder` is used for option fills, but there's no test confirming Bullish actually fills option orders via this path. This is an exchange API contract risk. |
| 5 | **No user authentication on trader routes** | MEDIUM | Trader endpoints use a static HMAC tenant scope hash, not per-user auth. Fine for closed pilot, not for production. |
| 6 | **Unused reference price function** | LOW | `resolveReferencePriceForPilot` exists but is never called. The Bullish locked profile may not use the intended pricing anchor. |

### Important (should fix before scaling)

| # | Gap | Detail |
|---|-----|--------|
| 7 | **No FalconX integration test** | Only mock tests. Real HMAC signing and HTTP flow untested. |
| 8 | **Silent catch blocks** | Several `catch {}` blocks silently swallow errors (telemetry, cap release). Fine for degradation but hides bugs. |
| 9 | **FalconX getMark throws** | `FalconxAdapter.getMark` always throws `mark_unavailable`. If mark pricing is needed for live spreads, this blocks. |
| 10 | **Hedge cost model mismatch** | Backtest uses fixed $40/1k. Live uses real order book. The backtest framework should be updated to use BS-derived or historical pricing. |

### Nice to have (post-pilot)

| # | Gap | Detail |
|---|-----|--------|
| 11 | Admin dashboard UI | Admin routes exist but no frontend. Operations are CLI-only. |
| 12 | Multi-tenant support | Single tenant scope per deployment. |
| 13 | Automated reconciliation | Manual reconciliation for fill mismatches. |

---

## 3. What IS Built and Working

| Component | Status | Notes |
|-----------|--------|-------|
| Bullish ECDSA auth | **Working** | Tested on SimNext, JWT login successful |
| Bullish order book reading | **Working** | Hybrid books, market scan, symbol resolution |
| Bullish option chain discovery | **Working** | 237 puts, 236 calls available |
| Premium pricing engine | **Working** | 49/49 tests pass, hybrid/actuarial modes |
| Floor/tier system | **Working** | Bronze 20%, Silver 15%, Gold/Plat 12% |
| 7-day tenor enforcement | **Working** | Clamped and tested |
| Premium regime overlay | **Working** | Stress/watch/normal with dwell |
| Treasury subsidy system | **Working** | Daily cap, per-quote cap, drawdown tracking |
| Quote flow | **Working** | Full chain: price -> premium -> venue quote -> lock |
| Activate flow | **Coded, untested live** | Full chain coded but execution disabled |
| FalconX adapter | **Coded, untested live** | Quote + execute HTTP, needs credentials |
| Deribit adapter | **Working + tested** | Most mature venue adapter |
| IBKR adapter | **Partially working** | 11 test failures (pre-existing) |
| Backtest framework | **Working** | Premium sweep, model comparison, risk pack |
| DB schema | **Working** | Idempotent bootstrap, all tables created |
| Admin endpoints | **Working** | Token-protected, IP allowlist |
| Proof export | **Working** | Token-protected data export |

---

## 4. How Close to Pilot Production?

### Scoring (1-10)

| Area | Score | Notes |
|------|-------|-------|
| Pricing engine | 9/10 | Rock solid, well-tested |
| Bullish connectivity | 8/10 | Auth works, order books work, option execution untested |
| Quote flow | 8/10 | Full chain working, needs live venue integration test |
| Activate/execute flow | 5/10 | Coded but never run live with real fills |
| Risk management | 7/10 | Treasury, caps, regime overlay all work. No rate limiting. |
| Monitoring | 2/10 | DB diagnostics only. No alerting. |
| Security | 5/10 | Admin auth works. No per-user auth. No rate limits. |
| Testing | 7/10 | 49/49 pricing tests. No E2E integration tests. |
| Operations | 4/10 | CLI-only. No runbooks beyond backtest docs. |
| **Overall** | **6/10** | **Pricing solid, infrastructure needs hardening** |

### What to do next (in priority order)

1. **Verify Bullish option execution** -- Enable execution on testnet, place one real put order, confirm fill. This is the single biggest unknown.

2. **Add rate limiting** -- `@fastify/rate-limit` on quote/activate endpoints. 1 hour of work.

3. **Add basic monitoring** -- At minimum: log treasury balance, hedge fills, and failures to a structured log that can feed alerting. 

4. **Run 2-week paper trade** -- Log real Bullish put quotes alongside every user quote. Build confidence in real spreads.

5. **Fix backtest hedge cost model** -- Replace $40/1k with BS-derived pricing. Makes backtests meaningful.

6. **Test the activate flow end-to-end** -- One real activation on testnet with a small position.

---

## 5. Suggested Proof Points Before Go-Live

| # | Proof | How | Status |
|---|-------|-----|--------|
| 1 | Bullish auth works | Smoke test | **DONE** |
| 2 | Bullish order book readable | Live book scan | **DONE** |
| 3 | Option chain available | Market scan | **DONE** |
| 4 | Premium model validated | 49 tests + model comparison | **DONE** |
| 5 | Stress test profitable | BS-derived scenarios | **DONE** |
| 6 | Live spread positive | 10-position validation | **DONE** |
| 7 | Bullish put order fills | Place + cancel 1 testnet order | **NOT DONE** |
| 8 | Full quote->activate flow | 1 testnet end-to-end | **NOT DONE** |
| 9 | 2-week paper trade data | Continuous quote logging | **NOT STARTED** |
| 10 | Rate limiting active | Config + test | **NOT DONE** |
| 11 | Alerting on treasury depletion | Monitor hook | **NOT DONE** |
