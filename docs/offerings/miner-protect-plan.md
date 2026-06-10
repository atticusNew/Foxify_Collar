# Miner Protect — Build & Iteration Plan

**Status:** v1 in progress (engine). **Offering type:** standalone API + (later) widget / pool white-label. **Reuses** the Atticus crypto protection core + multi-venue sourcing — the moat that **transfers fully here** (a miner's core risk is BTC price, hedged with crypto options on our existing venues).

> Isolated module: `services/api/src/minerProtect/` (no overlap with perp / etf). A parallel dev/agent works only here.

---

## 1. Why miners, why now
Miners are structurally **long BTC with USD-fixed costs** — a leveraged margin bet on BTC price. Most mid-size/private miners have **no hedging desk** and rely on bespoke OTC. We offer institutional-grade, multi-venue-sourced, non-custodial protection via API, distributed through **pools** (the analog of our perp-exchange channel).

## 2. Risk surface
| Risk | Hedgeable v1? | Notes |
|---|---|---|
| **BTC price downside** (revenue + treasury) | **Yes** | Vanilla BTC puts/collars; multi-venue sourcing applies |
| **Margin / solvency** (price below all-in cost) | **Yes — lead product** | "Breakeven floor": floor BTC price at the miner's $/BTC cost |
| **Treasury** (HODL'd BTC) | Yes | Reuse treasury work |
| **Hashprice / difficulty** | **Partial → roadmap** | Vanilla options hedge the *price* leg, not network share; full hedge needs thin hashrate-derivative markets |
| **Power cost** | No (core) | Energy markets — out of scope |

## 3. The "hashrate is multi-monetizable" lens (expands the customer base)
Hashrate is a cashflow-generating commodity monetized many ways; **each path creates a protection customer**, but all resolve to two factors — **BTC price** (hedged today) and **hashprice/difficulty** (roadmap):

| Monetization channel | Who's exposed | What we protect | Factor |
|---|---|---|---|
| Marketplace premium (sell/rent hashrate) | Buyer (long hashrate) / seller | Delivered value / rental income floor | Hashprice + price |
| Hashrate as cash (forward-sell for capital) | Financier who prepaid | Delivery/value floor | Hashprice + price |
| Betting on activity (hashprice futures) | Long/short hashprice | Hashprice floor/collar | Hashprice |
| Grounding a token/stablecoin (hashrate → token) | Token project / holders | Backing-cashflow reserve | Hashprice + price |

**Implication:** price-only v1 covers the common factor for everyone; **a hashprice floor is the strategic unlock** that opens marketplaces, financiers, and hashrate-token projects.

## 4. v1 product — Breakeven (margin) floor
Input the miner's economics → compute **breakeven BTC price** (price where revenue = all-in cost) → buy a put at/near breakeven so the miner **stays cash-flow positive**. Tiers: breakeven (survive) and breakeven+cushion (protect a margin).

**Economics (engine):**
- `power_kW = hashrate_THs × efficiency_W/TH ÷ 1000`
- `cost_per_day = power_kW × 24 × $/kWh + other_opex_per_day`
- `BTC_per_day = hashrate_THs × btc_per_TH_per_day`  *(network productivity from difficulty / **Luxor Hashprice Index** — pluggable input)*
- `breakeven_price = cost_per_day ÷ BTC_per_day`
- `expected_production_BTC = BTC_per_day × tenor_days` → hedge size
- Put at strike K → **revenue floor = K × hedged_BTC − premium**; flooring exactly at breakeven means **max margin erosion = the premium**; flooring above locks profit.

Price-only and honest: we floor the **BTC-price leg** of revenue, not difficulty.

## 5. Distribution — pools first (B2B2C)
Pools aggregate hashrate and sit at the center of every monetization channel → embed Atticus to offer members **"protected payouts."** Mirrors the perp-exchange model. Targets: **Luxor** (pool + Hashprice Index + marketplace/derivatives — best single partner), Foundry, Antpool, Braiins. Also: **miner lenders/financiers** who require borrowers to hedge (reduces their bad debt).

## 6. Luxor's role
- **v1:** ingest **Luxor Hashprice Index** as the `btc_per_TH_per_day` / hashprice data input (powers breakeven math + miner-language UI) even though we only *hedge* the price leg.
- **Distribution:** Luxor pool as a white-label channel.
- **Roadmap:** Luxor Hashprice Index + our BTC options + (Bitnomial / Luxor derivatives for the difficulty leg) = a real **hashprice floor**.

## 7. Engine reuse vs new
- **Reuse:** premium build-up (`perpProtectPricing`), worst-case/floor math, multi-venue sourcing (`venuePutProbes`/`okxProbe`/`bybitAdapter`), value recommendation, monitoring/roll.
- **New (`minerProtect/`):** miner economics → breakeven, expected-production sizing, breakeven-floor intent, hashprice/Luxor data input, production-strip rolling (later).

## 8. Phased roadmap
| Phase | Scope | Status |
|---|---|---|
| **1. Breakeven-floor engine** | Miner economics → breakeven $/BTC → price floor (puts), expected-production sizing, value recommendation; injected option quotes + Luxor data | **Build (now)** |
| **2. Quote API + multi-venue sourcing** | `/miner-protect/quote`, wire crypto venues, sanity script | Build |
| **3. Production strip + policy/roll + pool white-label** | Monthly/quarterly auto-roll, breakeven monitoring/alerts, pool embed | Build |
| **4. Hashprice floor + financier/marketplace/token customers** | Luxor index + Bitnomial; structured hashprice protection | Roadmap |

## 9. Open items
- v1 = **price-only** (honest); express floor in USD/BTC **and** hashprice terms for generality.
- Engine inputs in **miner language** (hashrate/efficiency/cost/expected production), reusable for the hashprice-floor roadmap.
- Confirm Luxor (or alt) as the index/data + pool partner.
