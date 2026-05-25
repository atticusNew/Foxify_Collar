# Bullish Live Option Pricing — Real Data for Single-Side Pilot Relaunch

**Generated:** 2026-05-16
**Spot reference:** BTCUSDC mid = **$78,187** (live Bullish, 0bp top-of-book spread)
**Source:** `https://api.exchange.bullish.com/trading-api/v1/markets/<symbol>/orderbook/hybrid` (public endpoint)

## Headline findings

1. **BTC implied vol is currently ~33% on 3-day, ~43% on 6-day.** Earlier analysis assumed 65% — actual prices are HALF my prior BS-theoretical estimates for short tenors.
2. **3-day expiry liquidity is poor for OTM strikes.** Spreads of 7-26% on 3-day puts/calls at 1-5% OTM. **Unusable for 7% trigger cells (5% OTM strikes).**
3. **6-day expiry has dramatically better liquidity** — spreads 3-5% across the OTM range, depth 5-10 BTC at top of book.
4. **Tenor decision should be cell-conditional:**
   - 50k/2%, 50k/5%, 200k/5%: **3-day OK** (3% OTM puts at $76k have decent liquidity)
   - 50k/7%, 200k/7%: **6-day required** (5% OTM puts at $74k illiquid at 3-day)

## Live order book data

### 3-day expiry (2026-05-19 08:00Z) — PUTS

| Strike | OTM% | Bid | Mid | Ask | Spread | Top-of-book depth |
|---|---|---|---|---|---|---|
| $77,500 | 0.88% | $620 | $655 | $690 | **1069bp (10.7%)** | 0.6 BTC |
| $76,000 | 2.80% | $300 | $310 | $320 | **645bp (6.4%)** | 5.0 / 1.0 BTC |
| $74,000 | 5.36% | $100 | $115 | $130 | **2609bp (26.1%)** | 2.2 / 2.0 BTC |

### 3-day expiry — CALLS

| Strike | OTM% | Bid | Mid | Ask | Spread | Depth |
|---|---|---|---|---|---|---|
| $79,000 | 1.04% | $530 | $550 | $570 | 727bp | 0.8 / 0.8 BTC |
| $80,500 | 2.96% | $150 | $170 | $190 | 2353bp | 2.0 / 2.0 BTC |
| $82,000 | 4.88% | $30 | $50 | $70 | **8000bp (80%)** | 23.6 / 23.4 BTC |

The 3-day 5% OTM call has 80% spread — completely unusable for hedging.

### 6-day expiry (2026-05-22) — PUTS

| Strike | OTM% | Bid | Mid | Ask | Spread | Depth |
|---|---|---|---|---|---|---|
| $77,500 | 0.88% | $1,180 | $1,200 | $1,220 | 333bp | 9.9 / 0.6 BTC |
| $76,000 | 2.80% | $740 | $755 | $770 | 397bp | 5.9 / 5.0 BTC |
| $74,000 | 5.36% | $390 | $400 | $410 | 500bp | 1.6 / 5.0 BTC |

6-day expiry: spreads 3-5%, top-of-book depth 5-10 BTC. Tradeable for all our cells.

### 13-day expiry (2026-05-29) — PUTS

| Strike | OTM% | Bid | Mid | Ask | Spread | Depth |
|---|---|---|---|---|---|---|
| $77,500 | 0.88% | $1,880 | $1,905 | $1,930 | 262bp | 0.6 / 0.6 BTC |
| $76,000 | 2.80% | $1,370 | $1,390 | $1,410 | 288bp | 0.7 / 5.3 BTC |
| $74,000 | 5.36% | $890 | $910 | $930 | 440bp | 1.0 / 5.0 BTC |

13-day spreads similar to 6-day. Even tighter on near-the-money strikes.

## Implied vol term structure

Solving BS-implied IV from Bullish mid:

| Strike | 3-day | 6-day | 13-day |
|---|---|---|---|
| 1% OTM | ~33% | ~43% | ~50% |
| 3% OTM | ~30% | ~43% | ~50% |
| 5% OTM | ~28% | ~41% | ~48% |

Term structure is upward-sloping (longer = higher IV). Short-dated IV particularly cheap right now (~30%) while medium-term holds at typical-calm 45-50%. **Useful for IV-aware pricing — the price scaling formula should be calibrated by tenor.**

## Realistic hedge cost per cover (single-side SHORT cover, PUT hedge)

Using Bullish ASK prices (since we're buying), with conservative 5-10% slippage above ask for fills exceeding top-of-book depth:

### 3-day expiry

| Cell | Strike | Hedge BTC | Mid | Realistic fill | **Total cost** |
|---|---|---|---|---|---|
| 50k/2%/$1k | $77.5k | 1.28 BTC | $655 | ~$700 | **$896** |
| 50k/5%/$2.5k | $76.0k | 1.56 BTC | $310 | ~$330 | **$515** |
| 200k/5%/$10k | $76.0k | 6.25 BTC | $310 | ~$340¹ | **$2,125** |
| 50k/7%/$3.5k | $74.0k | 2.19 BTC | $115 | ~$135 | **$296**² |
| 200k/7%/$14k | $74.0k | 8.75 BTC | $115 | ~$140 | **$1,225**² |

¹ Top-of-book ask depth 1.0 BTC; sweeping 6.25 BTC at depth-weighted price ≈ $340-360
² **3-day 5% OTM is too illiquid (26% spread). Use 6-day instead.**

### 6-day expiry (recommended for 7% cells)

| Cell | Strike | Hedge BTC | Mid | Realistic fill | **Total cost** |
|---|---|---|---|---|---|
| 50k/7%/$3.5k | $74.0k | 2.19 BTC | $400 | ~$420 | **$920** |
| 200k/7%/$14k | $74.0k | 8.75 BTC | $400 | ~$430 | **$3,763** |

## Updated thin-margin pricing recommendation

Real Bullish hedge cost + 17% selection-bias-adjusted trigger rate + 2.5-day average hold:

### Per-cover breakeven analysis (calm regime, BTC IV at current ~33% short-dated)

| Cell | Tenor | Hedge cost | E[payout] | E[salvage] | Total cost | **Breakeven prem** |
|---|---|---|---|---|---|---|
| 50k/2%/$1k | 3-day | $896 | $170 | $400 | $666 | **$666** |
| 50k/5%/$2.5k | 3-day | $515 | $50 | $260 | $305 | **$305** |
| 50k/7%/$3.5k | 6-day | $920 | $35 | $290 | $665 | **$665** |
| **200k/5%/$10k** | **3-day** | **$2,125** | **$200** | **$1,055** | **$1,270** | **$1,270** |
| 200k/7%/$14k | 6-day | $3,763 | $140 | $1,180 | $2,723 | **$2,723** |

Daily premium at thin-margin (15% above breakeven, 2.5-day hold):

| Cell | Tenor | Daily $/cover | $/$1k notional/day |
|---|---|---|---|
| 50k/2%/$1k | 3-day | **$306** | $6.12 |
| 50k/5%/$2.5k | 3-day | **$140** | $2.80 |
| 50k/7%/$3.5k | 6-day | **$305** | $6.10 |
| **200k/5%/$10k** | **3-day** | **$584** | **$2.92** |
| 200k/7%/$14k | 6-day | **$1,253** | $6.27 |

### Recommended launch pricing (rounded for clarity)

| Cell | Tenor | **Calm $/day** | Moderate (1.4×) | Elevated (2.0×) | Stress |
|---|---|---|---|---|---|
| 50k/2%/$1k | 3-day | **$310** | $435 | $620 | pause |
| 50k/5%/$2.5k | 3-day | **$140** | $195 | $280 | pause |
| 50k/7%/$3.5k | 6-day | **$310** | $435 | $620 | pause |
| **200k/5%/$10k** | **3-day** | **$600** | $840 | $1,200 | pause |
| 200k/7%/$14k | 6-day | **$1,250** | $1,750 | $2,500 | pause |

## Comparison to my prior estimates

| Cell | My prior estimate | Real Bullish-derived | Change |
|---|---|---|---|
| 50k/2%/$1k | $310 | $310 | same |
| 50k/5%/$2.5k | $650 | $140 | **−78%** (cheaper) |
| 200k/5%/$10k | $2,500 | **$600** | **−76%** (cheaper) |
| 200k/7%/$14k | $1,950 | $1,250 | −36% (cheaper) |

The user's intuition that **$2k/day is unacceptable** is now backed by data — the right number for 200k/5% is ~$600/day calm, not $2,000.

## CRITICAL: this is anchored to current low-vol environment

BTC IV is currently ~33% on 3-day. That's unusually low. If IV reverts to historical mean of 50-65%, hedge costs DOUBLE. Therefore:

1. **IV-aware dynamic pricing is essential** (already approved). Quote-time formula:
   ```
   daily_premium = base_price × (current_short_dated_iv / 33%)^0.7
   ```
   At today's 33% IV: $600/day for 200k/5% (calm)
   At 50% IV: $600 × (50/33)^0.7 = $600 × 1.34 = $804/day
   At 65% IV: $600 × (65/33)^0.7 = $600 × 1.61 = $964/day
   At 80% IV: $600 × (80/33)^0.7 = $600 × 1.85 = $1,108/day

2. **Regime overlays remain on top of IV-scaling** — combination handles both vol-spike (IV) and trigger-frequency-spike (regime) independently.

3. **Stress regime auto-pause** is the safety valve when both kick in.

## Liquidity / capacity assessment

For CEO's 200k/5%/$10k cover:
- Need 6.25 BTC of $76k strike puts at 3-day
- Top-of-book ask depth: 1.04 BTC
- Need to sweep ~6 levels deep to fill — likely results in fill 1-2% above top-of-book ask
- **Atticus capacity: 2-3 covers per day comfortably** at current Bullish liquidity. Beyond that, slippage gets ugly.

For multiple concurrent covers, would need to source liquidity from Deribit also (multi-venue routing per existing VC code).

## Tenor recommendation by cell (locked)

| Cell | Tenor | Reason |
|---|---|---|
| 50k/2%/$1k | **3-day** | 1% OTM 3-day put ($77.5k): 11% spread acceptable for $1k payout |
| 50k/5%/$2.5k | **3-day** | 3% OTM 3-day put ($76k): 6.4% spread, good depth |
| 200k/5%/$10k | **3-day** | Same strike as 50k/5%; need to sweep depth but tradeable |
| 50k/7%/$3.5k | **6-day** | 5% OTM 3-day put ($74k) has 26% spread — unusable |
| 200k/7%/$14k | **6-day** | Same as above; 6-day has 5% spread + 5 BTC depth |

## Next steps

1. **Sanity check IV/pricing assumptions with operator before locking** — particularly the 17% selection-bias-adjusted trigger rate and the IV-skew assumptions.
2. **Backtest these prices against historical 487-day window** — but with REAL Bullish price-to-BS ratios as the modulator.
3. **Talk to CEO with this report** — much friendlier numbers than my $2k/day prior estimate. CEO should be comfortable with $600/day on 200k/5% (calm) given the actual venue costs.
4. **Implement IV-aware pricing module** before relaunch — required for stability across vol regimes.
5. **Multi-venue (Bullish + Deribit) routing** for CEO's larger covers — single-venue depth doesn't support 2+ concurrent 200k/5%.

---

*Generated by direct Bullish public REST API queries on 2026-05-16. Spot $78,187 reference. All prices live as of generation timestamp.*
