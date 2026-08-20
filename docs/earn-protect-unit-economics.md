# Earn & Protect — Unit Economics & Money Flow

*For capital-partner discussion. Paper + live-canary measurements as of Aug 2026; all live-scale
credit numbers await the week-one calibration gate (below) before anything is published to traders.*

## The product in one paragraph

A Hyperliquid trader taps one toggle. Our engine wraps their perp position in a credit collar on
listed BTC options (OKX): buy a put ~6% below the price (a hard floor), sell a call ~1.5–3% above
(a cap). The sold leg brings in more than the bought leg costs, so the trader **receives** a net
credit — they are paid to be protected. Every wrap is credit-positive after venue fees or it is
refused with the reason stated. Protection runs a daily cycle and auto-renews while the toggle is
on. If price touches the cap, the cycle ends: the trader keeps their position, every gain to the
cap, and the credit unlocked to that moment; protection re-arms at the new price. No trader ever
owes anything. Credits are paid at each cycle's conclusion — never upfront.

## Money flow, end to end

```
TRADER                          ATTICUS ENGINE                      OKX (institutional sub-acct)
──────                          ──────────────                      ────────────────────────────
1. connects wallet (READ-ONLY;  reads position via HL public API
   no keys, no deposits)
2. taps Earn & Protect     →    prices collar off the LIVE          
                                options book; refuses if the
                                market can't fund a credit
                           →    places BOTH legs atomically:   →    SELL call (collects premium)
                                fill worse than quote ⟹ unwind      BUY put   (pays premium)
                                                                    net premium = GROSS CREDIT
3. credit unlocks linearly      monitors mark price 24/7:
   through the cycle            cap touch ⟹ close both legs,
                                settle vested credit, re-arm
4. cycle concludes         →    payout ledger accrues trader's
   (expiry / cap touch /        NET credit (gross − our take)
   early close)            →    USDC sent to the POSITION'S
                                OWN wallet (structurally the
                                only possible payee)
```

The trader's funds are never touched. The investor's capital is never on our servers — it sits in
the OKX sub-account as options margin, with **read-only API access for the capital partner**.

## What the $10,000 does

The capital is **margin collateral, not spend**. Under OKX portfolio margin, the two legs of each
wrap margin as a netted spread — measured at ~10–15% of wrapped notional (we re-measure with
OKX's own margin simulator before launch; every cap below re-derives from that one number).

| Lever | Formula | At $10k |
|---|---|---|
| Usable margin | 60% of capital (40% held back for renewals + knockout unwinds) | $6,000 |
| Working book | usable ÷ 12% margin per wrapped $ | **~$50,000** |
| Per-wallet cap | book ÷ 25 target concurrent wallets | ~$2,000 |
| Concentration | ≤30% of book short any single strike | — |

The book **recycles daily** — each cycle's margin frees at conclusion and redeploys. $10k of
static collateral supports ~$50k of continuously renewed protection. Raising capital raises every
cap linearly by changing one input.

## Unit economics per wrap (measured, not projected)

Live-canary fills to date (smallest possible size, least favorable tier):

- 1-lot wrap (0.01 BTC ≈ $650–700 notional): **$0.04–$0.49 gross credit per cycle** depending on
  hour, strike distance, and book depth. Real fills, auditable to OKX order IDs.
- Theory says 10–30 bps of notional per cycle at institutional pricing; live retail-scale fills
  run well below theory. **We do not publish trader-facing credit expectations until the
  week-one calibration gate**: ≥30 live wraps across ≥18 distinct market hours over ≥7 days,
  measured by hour / strike distance / execution lane. The measurement tooling is built and the
  gate is enforced in the reporting itself.

**Our revenue** = 20% of gross credit sourced (10% for the first 50 founding wallets, locked 12
months; cuts under $0.05/cycle waived). At a full $50k book turning daily at 10–20 bps gross,
that is **$10–20/day gross credit, $2–4/day to Atticus** — deliberately small. This raise is a
traction play: prove live demand, measure real margin + credit economics, and let the working
book price the real raise. Revenue scales linearly with capital from a proven base.

**Cost lines:** OKX taker fees are already inside every credit calculation (a wrap that can't
clear fees is refused). Payout gas: USDC on Arbitrum ≈ $0.005–0.03 per payout, batched at scale;
Hyperliquid-native (feeless) payouts are on the roadmap. Infra: two small Render services + a
managed Postgres (~$25/mo).

## What protects the capital

- OKX API keys are **trade-only; withdrawals disabled at the key level.** A full server
  compromise cannot move collateral off-venue.
- Capital partner gets **read-only OKX API access** — position-level verification any time,
  independent of us.
- Pair atomicity: both legs fill or the pair unwinds. Fills worse than quote unwind (enforced in
  code, proven live). Knockout unwinds close the short leg first — no naked short exposure.
- 40% margin headroom is never allocated; margin-utilization auto-pause halts new wraps before
  the buffer is touched; a kill switch stops new exposure while conclusions and payouts continue.
- Book / per-wallet / per-strike caps bound worst-case concentration; the payout hot wallet is
  separate, small, and per-day-capped — its float is the maximum blast radius.
- Every wrap, fill, knockout, and payout is persisted and reconciled against OKX's own records
  on boot; a public dashboard shows the live book (aggregates only).

## Status

Engine, quoting, atomic execution, knockout cycle, payout ledger, caps, and both trader clients
(web app + Telegram bot/Mini App, Hyperliquid-native branding) are built and tested — 529
automated tests, plus end-to-end live-market paper cycles and real-money canary fills on OKX.
Next: fund the sub-account, measure real portfolio margin per wrap (recalibrates the book cap),
run the week-one live calibration, then open the 50-wallet founding cohort.
