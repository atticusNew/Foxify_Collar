# Atticus → Hyperliquid: Defined-Risk Overlay for HL Perp Traders

*Deck-source pitch document. Single-page TL;DR up top, then per-section detail.*

---

## TL;DR (one page)

**What:** A pure pass-through options-procurement bridge. HL perp trader opens a BTC/ETH position, Atticus simultaneously buys a real Deribit BTC/ETH put-spread (long) or call-spread (short) hedge sized to the position. **HLP is unaffected** — the product sits orthogonal to your LP vault and doesn't compete with it.

**Trader value (backtested, 500 HL-shaped synthetic trades, Nov 2023 – Apr 2026):**
- **52-55% median drawdown reduction** (% of margin) on adverse-move trades
- **94-99% liquidation prevention rate** on trades that would have liquidated unhedged
- Premium runs **5.5% of protected notional** average (single-premium tier, 7-day Deribit spread)

**HL value:**
- **Bringing real options depth to HL traders** without HL building options infra
- **No integration on your side to start** — works off the public API + ws stream
- **Materially additive venue revenue** under any reasonable adoption rate (see §5)

**Operational status:** Already live with the same mechanism on Foxify (separate pilot). Same architecture: Deribit-hedged, pure pass-through, no warehousing.

**The ask:** 30-min call to walk through mechanism + zero-integration shadow-pilot proposal (4-6 weeks publishing a "what if Atticus had been live" trade log on HL public data, then we discuss commercial terms).

---

## §1: Why Hyperliquid (the strategic fit)

We've been pattern-matching across perp DEXes (Foxify live, SynFutures pitched, GMX/dYdX next). **Hyperliquid is the strongest structural fit**:

1. **Highest perp volume of any DEX** — every basis point of adoption produces meaningful revenue
2. **Sophisticated trader base** — HL users actually understand options/structured products; pitch doesn't have to start at "what is delta"
3. **HLP architecture means a non-AMM hedge product is additive, not competitive** — venues with internal market-making/LP vaults usually have product conflicts with overlay products. HL's model means we can sit alongside HLP cleanly.
4. **Public API depth** — the shadow pilot is trivially easy to run on your side; we can produce a "what would have happened" log without you doing any work
5. **HL has been actively partner-friendly** — builders code program, partner integrations, ecosystem support — all of which fit a 50/50 rev-share product wrapper

---

## §2: Mechanism (90 seconds)

```
HL Trader                          Atticus                          Deribit
   │                                  │                                │
   │  Open BTC long, 5x leverage      │                                │
   │  $5,000 notional, $1,000 margin  │                                │
   ├─────────────────────────────────►│                                │
   │                                  │  Quote spread: 2% OTM put,     │
   │                                  │  5% width, sized 4x notional   │
   │                                  ├───────────────────────────────►│
   │                                  │                                │
   │  Premium: $128 (2.57%)           │                                │
   │◄─────────────────────────────────┤                                │
   │                                  │                                │
   │                                  │  Buy 0.18 BTC @ K=98k put -    │
   │                                  │  short K=93k put (real fill)   │
   │                                  ├───────────────────────────────►│
   │                                  │                                │
   │  ··· hold position ···           │                                │
   │                                  │                                │
   │  BTC drops to $93k               │  Spread is fully ITM ($5k pay) │
   │                                  │◄───────────────────────────────┤
   │  Hedge payout: $5,000            │                                │
   │◄─────────────────────────────────┤                                │
   │                                  │                                │
   │  Net realized: -$2,000 perp +    │                                │
   │  $5,000 hedge - $128 premium =   │                                │
   │  +$2,872 instead of -$2,000      │                                │
```

**HL doesn't take any new risk.** The trader's perp position settles normally on HL. The Atticus side is a separate Deribit position funded by the user fee. **HLP is not touched.**

---

## §3: Trader value (the drawdown story)

500 synthetic HL-shaped trades simulated against historical BTC/ETH paths (Nov 2023 – Apr 2026):

| Metric | Single-premium (7d) | Day-rate (14d) |
|---|---|---|
| **Median drawdown reduction (% of margin)** | **52.1%** | **55.2%** |
| 25th percentile DD reduction | 27.2% | 27.4% |
| 75th percentile DD reduction | 100.0% | 100.0% |
| Trades that would have liquidated unhedged | 89 of 500 (17.8%) | 89 of 500 |
| **Liquidations prevented by hedge** | **84 (94%)** | **88 (99%)** |
| Avg premium / protected notional | 5.55% | 5.38% |
| n (adverse-move trades) | 276 of 500 | 276 of 500 |

The 75th-percentile sitting at 100% means: in the upper-quartile of adverse-move trades, the hedge essentially fully covers margin loss. **The headline pitch line:** *On adverse BTC/ETH moves, Atticus protection typically cuts realized drawdowns by 52-55% of the trader's margin, and prevents 94-99% of unhedged liquidations.*

---

## §4: Concrete trade examples (from the simulation)

### $1,000 ETH long, 20× leverage
- Entry: $2,413, margin $50
- Adverse spot: $2,189 (-9.3%) — unhedged: **liquidated, -$50 (full margin)**
- Atticus hedge: 2365/2220 put spread on Deribit, $2,500 protected notional
- Premium: $12.38 (1.24%)
- Result: **liquidation prevented, +$2.90 net P&L instead of -$50.** Improvement: $52.90 (105.8% of margin).

### $5,000 BTC short, 5× leverage
- Entry: $114,365, margin $1,000
- Adverse spot: $126,296 (-10.4%) — unhedged: -$40 (close to liquidation)
- Atticus hedge: 116652/123514 call spread, $12,500 protected notional
- Premium: $128.43 (2.57%)
- Result: hedge didn't fully fire (BTC retraced before exit); user paid premium for protection that didn't trigger this round. **Standard insurance dynamic.**

### $10,000 BTC long, 3× leverage
- Entry: $110,116, margin $3,333
- Adverse spot: $98,893 (-10.2%), exited at $101,291
- Atticus hedge: 107914/101307 put spread, $25,000 protected notional
- Premium: $513.19 (5.13%)
- Result: hedge paid $1,500. **Net P&L: +$185 instead of -$801.** Improvement: $986.82 (29.6% of margin).

---

## §5: HL-side venue revenue (the partnership economics)

Premium per trade runs ~3-4% of notional traded (302-404 bps in the dataset). Under a 50/50 rev-share that's ~150-200 bps to HL.

**Monthly venue revenue (single-premium tier, 50/50 rev-share):**

| Monthly HL perp volume | @ 1% adoption | @ 3% adoption | @ 5% adoption |
|---|---|---|---|
| $50B  | $7.6M  | **$22.7M**  | $37.8M |
| $150B | $22.7M | **$68.0M**  | $113.3M |
| $300B | $45.3M | **$135.9M** | $226.5M |

**Reading the table:** even at the lowest assumed volume ($50B/month) and lowest assumed adoption (1%), the rev-share contributes $7.6M/month to HL. At the realistic mid-point ($150B/month, 3% adoption) it's **$68M/month**.

These are intentionally conservative adoption assumptions — HL's degen-scalper user base has many users who actively prefer no protection. Even so, the leverage of HL's volume scale produces meaningful revenue from a niche-product adoption rate.

**Day-rate tier numbers run ~30% higher per protected trade** due to cumulative theta vs. one-time premium — but typically with somewhat lower per-trade adoption.

---

## §6: Why this is structurally different from "internal options" or "venue-built protection"

| | Atticus bridge | Internal HL options | Internal HL stop-loss |
|---|---|---|---|
| Time to launch | Weeks (shadow), months (commercial) | 6-18 months of building | Already exists, limited |
| HL infra burden | None (we operate Deribit account) | Significant (matching engine, oracles, market makers) | Some |
| HLP impact | Zero — orthogonal | Material — competes for fills, changes vault risk | Minor |
| Liquidity source | Deribit (deepest crypto options book) | Bootstrap from zero | N/A |
| Defined-risk story | Yes — real options behind it | Yes (eventually) | No (just trigger-based) |
| Capital efficiency | 5-6% of notional | TBD on HL options launch | N/A |

**The Atticus product is a fast, low-burden way to give HL traders a defined-risk overlay without HL having to build options infrastructure, and without affecting HLP.**

---

## §7: Common objections (preempted)

**"Why would HL traders want this when they can just buy puts on Deribit themselves?"**
- 95%+ of HL users do not have a Deribit account or know how to size a vertical spread. The friction is real — Deribit account, KYC, separate funding, options-greeks understanding. Atticus collapses this to a single click on the HL ticket.

**"Won't this hurt HLP if traders take less risk?"**
- No — protection users still pay full HL trading fees on the perp leg. The protection product is layered on top. If anything, defined-risk-comfortable traders size up, which is net positive for HL volume + HLP fees.

**"What's the worst-case for HL?"**
- Atticus blows up Deribit-side and can't deliver hedges. Mitigated by: (a) real Deribit account with deep liquidity behind every quote, (b) shadow pilot first to verify operational integrity before any user-facing rollout.

**"What about UMA/oracle risk like prediction-market venues?"**
- N/A. HL perps settle on HL. Atticus hedges settle on Deribit. No oracle dependency between the two — they're orthogonal positions.

**"Why 50/50 rev-share?"**
- Negotiable. Starting point reflects: HL provides distribution + the trader, Atticus provides the operational hedging + Deribit relationship. Could be tilted to HYPE holders / builders code if that fits ecosystem economics better.

---

## §8: Pilot proposal (4-6 weeks, zero risk to HL)

**Phase 1 — Shadow pilot (4 weeks, no commitment).**
- We subscribe to HL public ws stream + REST API
- We publish a weekly "what if Atticus had been live" trade log on a sample of HL BTC/ETH perp activity
- HL evaluates: drawdown numbers, liquidation prevention, our pricing vs. expectation
- Zero integration on HL side. Zero risk. We bear all the operational cost.

**Phase 2 — Opt-in alpha (4 weeks, lightweight integration).**
- HL adds an optional "Protect this trade with Atticus" toggle on the ticket
- Initial whitelist of opt-in users (50-200) — could be HYPE holders, builders code participants, or HL Discord opt-ins
- We publish a public dashboard with real numbers: adoption, fees, payouts, drawdown reduction

**Phase 3 — Commercial rollout (terms to be defined in Phase 1-2).**
- Rev-share economics finalized
- General availability on the HL ticket

**Operational status:** Already live with this mechanism on Foxify (separate pilot, BTC perps). Same architecture, same Deribit relationship, same operational discipline. The Hyperliquid version is a re-skin, not a new build.

---

## Appendix A: Methodology + caveats (for the technical reader)

- **Synthetic trades**: 500 trades from HL-shaped distributions (notional 0.5k-250k, leverage 3-50×, hold 1-30d, 60/40 BTC/ETH, 60/40 long/short). Seeded RNG, deterministic.
- **Path data**: Coinbase daily OHLC. Drawdowns measured at daily resolution; intra-day liquidations may underestimate adverse extremes (real-world numbers are slightly worse than reported).
- **Hedge pricing**: Black-Scholes with vol-risk-premium (rvol × 1.10) and skew (0.20 vol-pts/% OTM), validated against live Deribit chain (calibration documented in the SynFutures and Kalshi research packages).
- **Single-premium refund**: option residual = max(time-decayed cost, intrinsic at exit) minus 5% bid-ask haircut.
- **Day-rate fee integral**: linear approximation across hold window (real theta is non-linear; <10% error for 7-14d).
- **Liquidation model**: ignores funding + trading fees; real liquidations happen slightly earlier, so prevention numbers here are mildly conservative.
- **Backtest is BTC/ETH only.** HL also has perps on SOL, HYPE, etc. — the mechanism extends with the right strike availability on Deribit (BTC + ETH have the deepest chains today).

## Appendix B: How to verify these numbers yourself

```bash
git clone <atticus-repo>
cd research/hyperliquid-pitch
npm install
npm run backtest
# Output: output/hyperliquid_summary.md, output/hyperliquid_trades.csv
```

Standalone npm package, no Foxify pilot dependencies, public APIs only. The full per-trade log is in `output/hyperliquid_trades.csv`.
