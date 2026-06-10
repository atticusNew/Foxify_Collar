# Miner Protect — True Hashprice Floor (scoping)

**Status:** Design / scoping (not built). Builds on the live Miner Protect price-leg revenue floor.
**Goal:** protect a miner's **hashprice** (revenue per TH/s/day), not just BTC price — the complete hedge.

---

## 1. Why this is the big value-add
Hashprice = revenue per unit of hashrate = **f(BTC price, network difficulty, fees)**. A miner loses money two ways:
1. **BTC price falls** — hedged today (vanilla BTC puts, multi-venue). ✅ live.
2. **Difficulty rises** — the network grows, so the miner mines **fewer BTC per TH** even if price is flat. **Not hedgeable with BTC options.** ❌

Difficulty has risen ~relentlessly; it's a structural, one-directional drag on miner revenue. A true hashprice floor covers **both** legs → guarantees revenue-per-TH, which is what a miner actually budgets against. This is the product miners and their lenders most want and can't easily buy.

## 2. Decomposition (what we can/can't source)
| Leg | Risk | Instrument | Status |
|---|---|---|---|
| **Price** | BTC ↓ | BTC put options (OKX/Deribit/Bullish/Bybit) | ✅ live (our moat) |
| **Difficulty / production** | difficulty ↑ → BTC/TH ↓ | hashrate/difficulty derivatives | ❌ needs a venue |
| **Fees** | fee revenue ↓ | (part of hashprice; small) | implicit |

A hashprice floor = **price put + a long position in a hashprice/difficulty instrument** (or a single hashprice put if a counterparty offers one).

## 3. Candidate instruments / partners
- **Luxor** — Hashprice **Index** (settlement reference; adapter already built), **Hashprice volatility** endpoint (for pricing), and OTC **hashprice/hashrate forwards & swaps**. Best single partner (also our pool distribution channel).
- **Bitnomial** — CFTC-regulated **hashrate/difficulty futures** (US, listed). Cleanest *executable* difficulty leg; introduces regulatory scope (futures).
- **Hashrate marketplaces** (Luxor RPC, NiceHash) — buy/sell forward hashrate; a synthetic production hedge.
- **Settlement reference:** Luxor Hashprice Index (USD or BTC per PH/TH per day).

## 4. Structuring approaches (pick per liquidity/regulatory appetite)
1. **Two-leg synthetic floor:** BTC price put (our venues) **+** long hashprice via Bitnomial/Luxor difficulty future. Combine payoffs into a "hashprice ≥ $X/TH/day" floor. Most flexible; we underwrite/route both legs.
2. **Buy a hashprice put OTC** from Luxor (single instrument) and re-wrap it. Simplest UX; depends on Luxor OTC pricing/availability.
3. **Hashprice swap / collar:** fix revenue-per-TH at a level (give up upside) — cheapest, for miners who want certainty (e.g. for loan covenants).

## 5. Pricing
- **Price leg:** existing transparent build-up (Decimal).
- **Difficulty/hashprice leg:** price an option on the Luxor Hashprice Index using **Luxor's published hashprice volatility** (`/hashprice/volatility`) + the index history; or take the market quote from Bitnomial/Luxor and pass through with a load. Model basis explicitly (below).
- Combined premium = price-leg + hashprice-leg + basis/tail load + margin.

## 6. Basis & settlement (the hard part)
- A specific miner's **realized** hashprice differs from the index (pool luck, pool fees, fleet efficiency, curtailment). The floor settles vs the **index**, leaving residual basis the miner bears — disclose it and size conservatively.
- Settlement rails: cash-settle vs index at expiry, or rolling (per the Premia-style custody/settlement models). Tie payout to the same custody account / smart contract used elsewhere.

## 7. Challenges / risks
- **Liquidity:** hashrate-derivative markets are thin → wide spreads, size limits. Start small / indicative.
- **Regulatory:** Bitnomial = CFTC futures → offering to clients likely needs introducing-broker/registration; Luxor OTC = bilateral. Counsel required (as with all execution).
- **Capital & correlation:** underwriting the difficulty leg needs capital + a hedging venue; correlation between price and difficulty must be modeled.
- **Data entitlement:** Luxor Hashprice Index/volatility may require a higher API tier (our current key 403'd on `/hashprice/current`).

## 8. Reuse map
- ✅ Reuse: price-leg sourcing (multi-venue), premium build-up, breakeven/margin engine, Luxor Index adapter, monitoring/roll, widget.
- 🆕 New: hashprice-vol ingestion + hashprice-option pricer, difficulty-leg venue adapter (Bitnomial/Luxor OTC), combined-payoff assembler, basis model, settlement wiring.

## 9. Phased plan
| Phase | Scope | Status |
|---|---|---|
| **1. Price-leg revenue floor + hashprice metrics** | live floors + hashprice/breakeven-hashprice display + margin floor | ✅ done |
| **2. Indicative hashprice floor (no exec)** | ingest Luxor hashprice index history + volatility → price a synthetic hashprice floor; show "hashprice ≥ $X/TH/day for $Y" indicatively | Build (next) |
| **3. Executable difficulty leg** | integrate Bitnomial futures or Luxor OTC; route the combined two-leg floor; basis model | Roadmap (counsel) |
| **4. Revenue swaps/collars + pool white-label** | fixed revenue-per-TH; embed in pools/lenders | Roadmap |

## 10. Open questions / partner asks
1. Luxor: enable Hashprice Index + **volatility** + OTC hashprice forwards on our key/plan.
2. Bitnomial: access + the regulatory structure to offer difficulty futures to clients.
3. Settlement: index cash-settle vs smart-contract; which custody rail.
4. Basis policy: how conservatively to size vs index (pool/efficiency basis).
