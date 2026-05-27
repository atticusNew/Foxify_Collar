# Single-Side Empirical Chain Validation

**Generated:** 2026-05-26T01:06:34.466Z
**BTC spot:** $76,619.495
**DVOL:** 35.2
**σ used for BS:** 35.2% annualized
**Bullish source:** `https://foxify-pilot-new.onrender.com/volume-cover/admin/bullish-option-chain` + `/bullish-orderbook` (Render-routed, mainnet=true)
**Deribit source:** `https://www.deribit.com/api/v2/public/...` (public, no auth)

> Live chain read against the Phase 0 cell matrix.
> Bullish goes through the existing live admin endpoints (read-only,
> admin-token-gated, zero new code on the live API).
> Deribit goes through the public API directly.
> Re-run `tsx scripts/backtest/singleSide/empiricalChainValidator.ts` to refresh.

## 1. Strike + tenor availability per cell

Per cell × venue × leg: target strike, nearest listed strike, tenor offset.
LONG-cover = Atticus buys PUT below spot; SHORT-cover = Atticus buys CALL above spot.

### ss_50k_2pct_1k (target tenor 3d, contracts 1.40 BTC)

| Venue | Leg | Target strike | Actual strike | Strike Δ% | Tenor (d) | Symbol |
|---|---|---:|---:|---:|---:|---|
| bullish | long_cover_put | $75853 | $76000 | 0.19% | 3.29 | BTC-USDC-20260529-76000-P |
| bullish | short_cover_call | $77386 | $77000 | -0.50% | 3.29 | BTC-USDC-20260529-77000-C |
| deribit | long_cover_put | $75853 | $76000 | 0.19% | 3.29 | BTC-29MAY26-76000-P |
| deribit | short_cover_call | $77386 | $77500 | 0.15% | 3.29 | BTC-29MAY26-77500-C |

### ss_50k_5pct_2_5k (target tenor 3d, contracts 1.70 BTC)

| Venue | Leg | Target strike | Actual strike | Strike Δ% | Tenor (d) | Symbol |
|---|---|---:|---:|---:|---:|---|
| bullish | long_cover_put | $74321 | $74000 | -0.43% | 3.29 | BTC-USDC-20260529-74000-P |
| bullish | short_cover_call | $78918 | $79000 | 0.10% | 3.29 | BTC-USDC-20260529-79000-C |
| deribit | long_cover_put | $74321 | $74000 | -0.43% | 3.29 | BTC-29MAY26-74000-P |
| deribit | short_cover_call | $78918 | $79000 | 0.10% | 3.29 | BTC-29MAY26-79000-C |

### ss_50k_7pct_3_5k (target tenor 6d, contracts 2.30 BTC)

| Venue | Leg | Target strike | Actual strike | Strike Δ% | Tenor (d) | Symbol |
|---|---|---:|---:|---:|---:|---|
| bullish | long_cover_put | $72789 | $73000 | 0.29% | 3.29 | BTC-USDC-20260529-73000-P |
| bullish | short_cover_call | $80450 | $80000 | -0.56% | 3.29 | BTC-USDC-20260529-80000-C |
| deribit | long_cover_put | $72789 | $73000 | 0.29% | 3.29 | BTC-29MAY26-73000-P |
| deribit | short_cover_call | $80450 | $80000 | -0.56% | 3.29 | BTC-29MAY26-80000-C |

### ss_200k_5pct_10k (target tenor 3d, contracts 6.60 BTC)

| Venue | Leg | Target strike | Actual strike | Strike Δ% | Tenor (d) | Symbol |
|---|---|---:|---:|---:|---:|---|
| bullish | long_cover_put | $74321 | $74000 | -0.43% | 3.29 | BTC-USDC-20260529-74000-P |
| bullish | short_cover_call | $78918 | $79000 | 0.10% | 3.29 | BTC-USDC-20260529-79000-C |
| deribit | long_cover_put | $74321 | $74000 | -0.43% | 3.29 | BTC-29MAY26-74000-P |
| deribit | short_cover_call | $78918 | $79000 | 0.10% | 3.29 | BTC-29MAY26-79000-C |

### ss_200k_7pct_14k (target tenor 6d, contracts 9.20 BTC)

| Venue | Leg | Target strike | Actual strike | Strike Δ% | Tenor (d) | Symbol |
|---|---|---:|---:|---:|---:|---|
| bullish | long_cover_put | $72789 | $73000 | 0.29% | 3.29 | BTC-USDC-20260529-73000-P |
| bullish | short_cover_call | $80450 | $80000 | -0.56% | 3.29 | BTC-USDC-20260529-80000-C |
| deribit | long_cover_put | $72789 | $73000 | 0.29% | 3.29 | BTC-29MAY26-73000-P |
| deribit | short_cover_call | $80450 | $80000 | -0.56% | 3.29 | BTC-29MAY26-80000-C |

## 2. Bid/ask + depth + BS-vs-actual

### ss_50k_2pct_1k

| Venue | Leg | Bid | Ask | Spread | Top ask BTC | Depth ≤2% | BS modeled | Ask/BS |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| bullish | long_cover_put | $620.00 | $650.00 | 4.7% | 16.74 BTC | 16.74 BTC | $725.03 | 0.90 |
| bullish | short_cover_call | $730.00 | $780.00 | 6.6% | 17.37 BTC | 22.32 BTC | $858.75 | 0.91 |
| deribit | long_cover_put | $651.68 | $690.01 | 5.7% | 52.00 BTC | 52.00 BTC | $725.03 | 0.95 |
| deribit | short_cover_call | $536.67 | $575.00 | 6.9% | 48.40 BTC | 48.40 BTC | $658.06 | 0.87 |

### ss_50k_5pct_2_5k

| Venue | Leg | Bid | Ask | Spread | Top ask BTC | Depth ≤2% | BS modeled | Ask/BS |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| bullish | long_cover_put | $190.00 | $220.00 | 14.6% | 24.08 BTC | 24.08 BTC | $189.35 | 1.16 |
| bullish | short_cover_call | $170.00 | $200.00 | 16.2% | 30.19 BTC | 30.19 BTC | $259.52 | 0.77 |
| deribit | long_cover_put | $214.67 | $237.67 | 10.2% | 32.80 BTC | 32.80 BTC | $189.35 | 1.26 |
| deribit | short_cover_call | $176.34 | $207.01 | 16.0% | 17.20 BTC | 17.20 BTC | $259.52 | 0.80 |

### ss_50k_7pct_3_5k

| Venue | Leg | Bid | Ask | Spread | Top ask BTC | Depth ≤2% | BS modeled | Ask/BS |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| bullish | long_cover_put | $110.00 | $130.00 | 16.7% | 25.28 BTC | 25.28 BTC | $80.19 | 1.62 |
| bullish | short_cover_call | $80.00 | $100.00 | 22.2% | 26.79 BTC | 26.79 BTC | $124.36 | 0.80 |
| deribit | long_cover_put | $122.67 | $138.00 | 11.8% | 0.20 BTC | 0.20 BTC | $80.19 | 1.72 |
| deribit | short_cover_call | $92.00 | $107.34 | 15.4% | 7.90 BTC | 7.90 BTC | $124.35 | 0.86 |

⚠️ **Warnings:**
- long_cover_put on BTC-USDC-20260529-73000-P: actual ask is 1.62× BS — calibration gap
- short_cover_call on BTC-USDC-20260529-80000-C: strike off by -0.56%
- long_cover_put on BTC-29MAY26-73000-P: actual ask is 1.72× BS — calibration gap
- long_cover_put on BTC-29MAY26-73000-P: depth-within-2% (0.20 BTC) < contracts (2.3000000000000003 BTC)
- short_cover_call on BTC-29MAY26-80000-C: strike off by -0.56%

### ss_200k_5pct_10k

| Venue | Leg | Bid | Ask | Spread | Top ask BTC | Depth ≤2% | BS modeled | Ask/BS |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| bullish | long_cover_put | $200.00 | $220.00 | 9.5% | 24.08 BTC | 24.08 BTC | $189.34 | 1.16 |
| bullish | short_cover_call | $170.00 | $200.00 | 16.2% | 30.19 BTC | 30.19 BTC | $259.51 | 0.77 |
| deribit | long_cover_put | $214.64 | $237.64 | 10.2% | 32.80 BTC | 32.80 BTC | $189.34 | 1.26 |
| deribit | short_cover_call | $176.31 | $199.31 | 12.2% | 3.50 BTC | 3.50 BTC | $259.51 | 0.77 |

⚠️ **Warnings:**
- short_cover_call on BTC-29MAY26-79000-C: depth-within-2% (3.50 BTC) < contracts (6.6000000000000005 BTC)

### ss_200k_7pct_14k

| Venue | Leg | Bid | Ask | Spread | Top ask BTC | Depth ≤2% | BS modeled | Ask/BS |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| bullish | long_cover_put | $110.00 | $130.00 | 16.7% | 25.28 BTC | 25.28 BTC | $80.18 | 1.62 |
| bullish | short_cover_call | $80.00 | $100.00 | 22.2% | 26.79 BTC | 26.79 BTC | $124.35 | 0.80 |
| deribit | long_cover_put | $122.65 | $137.98 | 11.8% | 0.20 BTC | 0.20 BTC | $80.18 | 1.72 |
| deribit | short_cover_call | $91.99 | $107.32 | 15.4% | 7.90 BTC | 7.90 BTC | $124.35 | 0.86 |

⚠️ **Warnings:**
- long_cover_put on BTC-USDC-20260529-73000-P: actual ask is 1.62× BS — calibration gap
- short_cover_call on BTC-USDC-20260529-80000-C: strike off by -0.56%
- long_cover_put on BTC-29MAY26-73000-P: actual ask is 1.72× BS — calibration gap
- long_cover_put on BTC-29MAY26-73000-P: depth-within-2% (0.20 BTC) < contracts (9.200000000000001 BTC)
- short_cover_call on BTC-29MAY26-80000-C: strike off by -0.56%
- short_cover_call on BTC-29MAY26-80000-C: depth-within-2% (7.90 BTC) < contracts (9.200000000000001 BTC)

## 2.5 Tenor availability — explicit longer-expiry probe (≥5d)

For target-tenor ≥5d cells, probes the closest available expiry that is
strictly ≥5 days from now, on both venues. Answers: "is the 6d tenor we
designed against actually listable today, or is the matrix only feasible
with weekday-dependent shorter tenor?"

| Cell | Venue | Leg | Symbol | Tenor (d) | Bid | Ask | Depth ≤2% above ask |
|---|---|---|---|---:|---:|---:|---:|
| ss_50k_7pct_3_5k | bullish | long_cover_put | BTC-USDC-20260605-73000-P | 10.29 | $460.00 | $490.00 | 2.43 BTC |
| ss_50k_7pct_3_5k | bullish | short_cover_call | BTC-USDC-20260605-80000-C | 10.29 | $410.00 | $440.00 | 2.50 BTC |
| ss_50k_7pct_3_5k | deribit | long_cover_put | BTC-5JUN26-73000-P | 10.29 | $459.98 | $536.64 | 197.10 BTC |
| ss_50k_7pct_3_5k | deribit | short_cover_call | BTC-5JUN26-80000-C | 10.29 | $421.64 | $459.98 | 22.90 BTC |
| ss_200k_7pct_14k | bullish | long_cover_put | BTC-USDC-20260605-73000-P | 10.29 | $460.00 | $490.00 | 2.43 BTC |
| ss_200k_7pct_14k | bullish | short_cover_call | BTC-USDC-20260605-80000-C | 10.29 | $410.00 | $440.00 | 2.51 BTC |
| ss_200k_7pct_14k | deribit | long_cover_put | BTC-5JUN26-73000-P | 10.29 | $459.98 | $536.65 | 197.10 BTC |
| ss_200k_7pct_14k | deribit | short_cover_call | BTC-5JUN26-80000-C | 10.29 | $421.65 | $459.98 | 30.90 BTC |

## 3. Effective hedge cost per cover

Cost = avg(long-leg ask, short-leg ask) × contracts. Direction is
50/50 random (Foxify chooses), so per-cover hedge cost is the symmetric average.
Compares to BS-modeled cost used in the daily backtest (`coreEngine.ts` with 7% uplift).

| Cell | Contracts | Primary | Primary cost | Fallback | Fallback cost | BS-modeled | Empirical/BS |
|---|---:|---|---:|---|---:|---:|---:|
| ss_50k_2pct_1k | 1.40 | bullish | $1,001 | deribit | $886 | $959 | 1.04 |
| ss_50k_5pct_2_5k | 1.70 | bullish | $357 | deribit | $378 | $416 | 0.86 |
| ss_50k_7pct_3_5k | 2.30 | deribit | $282 | bullish | $265 | $577 | 0.49 |
| ss_200k_5pct_10k | 6.60 | bullish | $1,386 | deribit | $1,442 | $1,614 | 0.86 |
| ss_200k_7pct_14k | 9.20 | deribit | $1,128 | bullish | $1,058 | $2,310 | 0.49 |

## 4. Capital ladder (1 → 25 concurrent positions)

Capital deployed = ACTUAL ask × contracts × position-count. LONG options only,
no margin needed. `Headroom` flags one-direction concurrent BTC outstanding
vs Bullish observed depth-within-2%-of-mid (single-direction fire-storm).

### ss_50k_2pct_1k

Per-position capital: **$1,001** | Per-position contracts: **1.40 BTC**
Bullish depth-within-2%: long=16.74 BTC, short=22.32 BTC

| # positions | Total capital | Total BTC | Bullish headroom |
|---:|---:|---:|---|
| 1 | $1,001 | 1.4 BTC | ✅ OK |
| 2 | $2,002 | 2.8 BTC | ✅ OK |
| 3 | $3,003 | 4.2 BTC | ✅ OK |
| 5 | $5,005 | 7.0 BTC | ✅ OK |
| 10 | $10,010 | 14.0 BTC | ✅ OK |
| 15 | $15,015 | 21.0 BTC | ⚠️ TIGHT |
| 20 | $20,020 | 28.0 BTC | ⚠️ TIGHT |
| 25 | $25,025 | 35.0 BTC | ❌ EXCEEDS depth |

### ss_50k_5pct_2_5k

Per-position capital: **$357** | Per-position contracts: **1.70 BTC**
Bullish depth-within-2%: long=24.08 BTC, short=30.19 BTC

| # positions | Total capital | Total BTC | Bullish headroom |
|---:|---:|---:|---|
| 1 | $357 | 1.7 BTC | ✅ OK |
| 2 | $714 | 3.4 BTC | ✅ OK |
| 3 | $1,071 | 5.1 BTC | ✅ OK |
| 5 | $1,785 | 8.5 BTC | ✅ OK |
| 10 | $3,570 | 17.0 BTC | ✅ OK |
| 15 | $5,355 | 25.5 BTC | ⚠️ TIGHT |
| 20 | $7,140 | 34.0 BTC | ⚠️ TIGHT |
| 25 | $8,925 | 42.5 BTC | ⚠️ TIGHT |

### ss_50k_7pct_3_5k

Per-position capital: **$282** | Per-position contracts: **2.30 BTC**
Bullish depth-within-2%: long=25.28 BTC, short=26.79 BTC

| # positions | Total capital | Total BTC | Bullish headroom |
|---:|---:|---:|---|
| 1 | $282 | 2.3 BTC | ✅ OK |
| 2 | $564 | 4.6 BTC | ✅ OK |
| 3 | $846 | 6.9 BTC | ✅ OK |
| 5 | $1,411 | 11.5 BTC | ✅ OK |
| 10 | $2,821 | 23.0 BTC | ✅ OK |
| 15 | $4,232 | 34.5 BTC | ⚠️ TIGHT |
| 20 | $5,643 | 46.0 BTC | ⚠️ TIGHT |
| 25 | $7,054 | 57.5 BTC | ❌ EXCEEDS depth |

### ss_200k_5pct_10k

Per-position capital: **$1,386** | Per-position contracts: **6.60 BTC**
Bullish depth-within-2%: long=24.08 BTC, short=30.19 BTC

| # positions | Total capital | Total BTC | Bullish headroom |
|---:|---:|---:|---|
| 1 | $1,386 | 6.6 BTC | ✅ OK |
| 2 | $2,772 | 13.2 BTC | ✅ OK |
| 3 | $4,158 | 19.8 BTC | ✅ OK |
| 5 | $6,930 | 33.0 BTC | ⚠️ TIGHT |
| 10 | $13,860 | 66.0 BTC | ❌ EXCEEDS depth |
| 15 | $20,790 | 99.0 BTC | ❌ EXCEEDS depth |
| 20 | $27,720 | 132.0 BTC | ❌ EXCEEDS depth |
| 25 | $34,650 | 165.0 BTC | ❌ EXCEEDS depth |

### ss_200k_7pct_14k

Per-position capital: **$1,128** | Per-position contracts: **9.20 BTC**
Bullish depth-within-2%: long=25.28 BTC, short=26.79 BTC

| # positions | Total capital | Total BTC | Bullish headroom |
|---:|---:|---:|---|
| 1 | $1,128 | 9.2 BTC | ✅ OK |
| 2 | $2,257 | 18.4 BTC | ✅ OK |
| 3 | $3,385 | 27.6 BTC | ⚠️ TIGHT |
| 5 | $5,642 | 46.0 BTC | ⚠️ TIGHT |
| 10 | $11,284 | 92.0 BTC | ❌ EXCEEDS depth |
| 15 | $16,926 | 138.0 BTC | ❌ EXCEEDS depth |
| 20 | $22,568 | 184.0 BTC | ❌ EXCEEDS depth |
| 25 | $28,210 | 230.0 BTC | ❌ EXCEEDS depth |

## 5. Phase 0 go/no-go per cell

| Cell | Strike avail (B/D) | Quote avail (B/D) | Empirical/BS | Depth at 25 pos | Verdict |
|---|:-:|:-:|---:|:-:|:-:|
| ss_50k_2pct_1k | ✅/✅ | ✅/✅ | +4% | ❌ | ⚠️ REVIEW |
| ss_50k_5pct_2_5k | ✅/✅ | ✅/✅ | -14% | ⚠️ | ✅ GO |
| ss_50k_7pct_3_5k | ✅/✅ | ✅/✅ | -51% | ❌ | ⚠️ REVIEW |
| ss_200k_5pct_10k | ✅/✅ | ✅/✅ | -14% | ❌ | ⚠️ REVIEW |
| ss_200k_7pct_14k | ✅/✅ | ✅/✅ | -51% | ❌ | ⚠️ REVIEW |

---

*Generated by services/api/scripts/backtest/singleSide/empiricalChainValidator.ts*
*This is a SNAPSHOT — markets move. Re-run before any cutover decision.*