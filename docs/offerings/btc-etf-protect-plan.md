# BTC ETF Protect — Build & Iteration Plan

**Status:** Design / proposal (no production code yet). **Offering type:** standalone API + embeddable widget, **B2B2C / white-label** (not direct-to-retail). **Reuses** the Atticus protection core (Perp Protect engine).

> Atticus is the **picks-and-shovels protection layer**: detection → pricing/structuring → order generation → execution routing → monitoring/roll. **Non-custodial, non-discretionary.** Partners (RIAs, brokers, fintechs, ETF platforms) embed the widget or call the API headless; **custody, the client relationship, and suitability stay with the partner/broker.**

---

## 1. Executive summary

- Protect spot **Bitcoin-ETF** holdings (IBIT-first) with listed options hedges (protective put / put spread / collar), delivered as a **broker-agnostic API + white-label widget** — same shape as Perp Protect.
- **Execution is real, not advisory.** We route orders through **execution-broker adapters**: **IBKR** (deep, advisor master→sub-accounts) and **SnapTrade** (breadth across partner brokers). Same adapter pattern we use for crypto venues.
- **Moat is different from Perp Protect.** Listed ETF options are OPRA/NBBO-consolidated through one broker — our crypto multi-venue "cheapest-across-venues" edge does **not** transfer. The ETF moat is the **engine + UX + monitoring/roll policy automation + white-label distribution**, plus an optional **crypto-sourced cross-hedge** (advanced).
- **Posture:** technology + execution-routing infrastructure; partner owns advice/suitability. Keep Atticus **non-discretionary** (partner/end-user pre-authorizes policy or confirms tickets) to stay infra-side. **Legal counsel required before launch.**
- **GTM:** B2B2C into entities that already hold BTC-ETF exposure and lack downside tooling — RIAs/wealth platforms, options brokers, ETF issuers, family offices/treasuries.

## 2. Reuse map (Perp Protect core → ETF Protect)

| Capability | Source file | ETF Protect |
|---|---|---|
| Quote engine, entry-aware worst case, single/spread | `singleSide/twoSided/perpProtectQuote.ts` | **Reuse** (add collar) |
| Transparent premium build-up (Decimal) | `perpProtectPricing.ts` | **Reuse** (retune loads for equities; data fees) |
| Strike laddering / protection intents | `perpProtectStructure.ts` | **Adapt** (floors 80/85/90/95%; equity strike grid) |
| Cross-source leg selection (tenor/liquidity/depth) | `perpProtectLegSelect.ts` | **Adapt** (single NBBO book; less cross-venue value) |
| Venue adapters (OKX/Deribit/Bullish/Bybit) | `venuePutProbes.ts`, `bybitAdapter.ts` | **New** execution/data adapters (IBKR, SnapTrade, OPRA vendor) |
| Quote/spot routes, auth, quote store | `routes.ts`, `perpProtectQuoteStore.ts` | **Reuse** (new `/etf-protect/*` surface) |
| Recommendation (value-based) | `pickRecommendedOption` | **Reuse** (Conservative/Balanced/Low-cost) |
| Widget shell, demo/admin gating, spot poll | `apps/web/src/twoSided/PerpProtectWidget.tsx` | **Reuse** (new ETF widget; broker-connect step) |
| Sanity/diagnostics script | `scripts/perpProtectSanity.ts` | **Reuse** pattern |

**Net-new:** brokerage connection + holdings read, OPRA/ETF options data, equity options mechanics (contracts/American/assignment), execution adapters, monitoring/roll policy engine, compliance scaffolding.

## 3. Architecture

Broker-agnostic Protection API with swappable **execution-broker adapters** (mirrors the crypto venue-adapter design).

```mermaid
flowchart TD
  P[Partner app / advisor portal] -->|embed widget or headless API| API[Atticus ETF-Protect API]
  API --> CONN[Connection layer: IBKR / SnapTrade]
  CONN --> POS[Read holdings → detect BTC-ETF exposure]
  POS --> ENG[Protection engine (reused core): floors, put/spread/collar, premium build-up, recommendation]
  ENG --> MD[Options data: OPRA vendor (Polygon/Tradier/dxFeed) + IV/greeks]
  ENG --> Q[Quote + persisted priced legs]
  Q -->|partner/end-user authorizes| EXEC[Execution adapter → IBKR / SnapTrade]
  EXEC --> BRK[(Partner-controlled broker / custody)]
  EXEC --> MON[Monitor: price, hedge value, DTE, floor, roll/TP triggers]
  MON -->|webhook/alert| P
```

Atticus never holds assets; orders are generated and routed to the **partner-controlled** broker/custody.

## 4. Asset scope (IBIT-first)

- **Phase 1: IBIT only** — deepest listed BTC-ETF options book → best hedge pricing/liquidity, cleanest demo.
- **Phase 2:** FBTC, BITB, ARKB (where listed options are liquid).
- **Thinly-/non-optioned BTC ETFs** (e.g., some of HODL/BTCW/EZBC/BRRR): hedge via **IBIT options** (high correlation, small basis) or **crypto cross-hedge** (§9). Always disclose basis when the hedge instrument ≠ the held ETF.
- Contract sizing: equity options = **100 shares/contract**. IBIT ≈ $60 → ~$6k notional/contract; round protection to whole contracts and surface the residual unhedged remainder.

## 5. Hedge engine adaptation

- **Structures:** protective put (reuse single capped), put spread (reuse spread), **collar = new** (buy put / sell call; short call → assignment + approval/margin).
- **Floor tiers → advisor language:** Conservative 90–95% · Balanced 85% · Low-cost 80% (or 80% floor + upside cap via collar). Maps onto existing `pickRecommendedOption` value logic.
- **Tenors:** 30 / 60 / 90d standardized expiries (weeklies/monthlies); rolling auto-renew via the policy engine.
- **Settlement:** American-style (early-exercise/assignment) vs the crypto European model — engine already supports a settlement-style seam; extend it.
- **Pricing:** reuse the transparent build-up; retune loads for equities and **fold in options-data licensing cost**; premiums quoted per-contract and aggregate.

## 6. Execution & settlement (real execution, non-discretionary)

Two adapters behind one API:
- **IBKR adapter (anchor):** Client Portal Web API / FIX. Use IBKR's **advisor master → client sub-accounts** for white-label: partner = master, end-clients = sub-accounts, Atticus routes per sub-account. Requires options trading permissions on accounts (and higher approval/margin for short legs in collars/spreads).
- **SnapTrade adapter (breadth):** connect + trade across many partner brokers when accounts aren't at IBKR. Read holdings + place options orders where supported.

**Model:**
- **Non-custodial:** assets/custody remain at the partner-controlled broker.
- **Non-discretionary:** partner (or end-user) either **pre-authorizes a policy** (e.g., maintain 90% floor, auto-roll within bounds) or **confirms each order ticket**. Atticus generates the exact instruction (e.g., *Buy 4 IBIT 90d $54 puts, limit X*) and routes it.
- **Order lifecycle:** `quote` → persist priced legs (`quote_id`, TTL) → `activate` (route via adapter) → fills/confirmations → monitor.

## 7. White-label / B2B2C integration models

| Model | Who executes | Fit |
|---|---|---|
| **Headless API** | Partner calls `/etf-protect/*`, renders own UI | Brokers/fintechs with their own front-end |
| **Embedded widget** | Atticus widget in partner app (themed) | RIAs/platforms wanting turnkey UX |
| **IBKR master/sub** | Atticus routes via partner's IBKR advisor master | Advisors already on IBKR |
| **BYOB via SnapTrade** | Atticus routes via partner's existing broker | Mixed-broker partners |
| **Policy engine (managed rules)** | Atticus runs partner-set protection policy | Recurring-revenue, portfolio-level |

Auth/tenancy: per-partner API keys + scoped tokens (reuse the admin/demo token model); per-end-account authorization records for routing.

## 8. Market data

- **OPRA-licensed** options data (chains, NBBO bid/ask, IV, greeks, expiries/strikes) via a vendor — **Polygon**, **Tradier**, or **dxFeed**; note OPRA licensing cost/latency (delayed vs real-time tiers).
- **Tradier** is attractive (data **and** execution in one) as a possible secondary execution adapter later.
- Underlying ETF last/mark for the live header (reuse the `/spot`-style lightweight poll).

## 9. Crypto cross-hedge (advanced / roadmap)

When ETF options are illiquid/expensive, hedge BTC-ETF exposure using our **existing crypto multi-venue BTC options** (Deribit et al.) — the one place our crypto moat returns. Caveats: ETF↔BTC **basis/tracking error**, separate collateral/settlement rail, and **materially different regulatory treatment** (securities exposure hedged with crypto derivatives). Treat as bespoke/advanced; gate behind counsel.

## 10. Compliance & risk (must-address; not legal advice)

- **Posture:** technology + execution-routing infrastructure; **partner owns advice/suitability and the client relationship.** Avoid Atticus making personalized recommendations or exercising discretion → stay non-discretionary.
- **Options approval & margin:** end-accounts need options permissions; short legs (collar/spread) need higher approval + margin.
- **Tax disclosures:** hedging held positions can implicate **straddle / constructive-sale / wash-sale** rules — surface a disclosure; defer specifics to the partner/user's advisor.
- **Data/PII & permissions:** brokerage-connection consent, read scopes, order authorization, data retention.
- **Order-flow considerations:** even infra providers touching order routing may have regulatory obligations depending on structure — **engage securities counsel before launch.** Mark all of this as assumptions to validate.

## 11. Go-to-market (high-value, current unmet need)

Prioritized: **RIAs / wealth platforms** with BTC-ETF books (own suitability) → **options brokers** (IBKR/tastytrade) wanting a protection feature → **ETF issuers** (a "protected" wrapper/marketing) → **family offices / treasuries** (ties to the Premia treasury theme). **Wedge:** alert-only ("your IBIT is down X; protection would cost Y") → policy-based managed protection → full embedded execution.

## 12. Phased roadmap

| Phase | Scope | Key deps | Status |
|---|---|---|---|
| **1. Quote/analysis** | Connect (IBKR/SnapTrade, read-only) → detect BTC-ETF → quote floors (IBIT) via OPRA data → reuse engine + widget | data vendor, connection layer | Build |
| **2. Execution** | `activate` via **IBKR adapter** (confirm-ticket), persisted legs | IBKR API, options approvals | Build |
| **3. Monitor/roll + policy** | Monitoring, roll/TP triggers, alerts, partner-set policy engine | webhooks | Build |
| **4. Breadth + cross-hedge** | SnapTrade adapter, more ETFs, crypto cross-hedge, issuer/advisor distribution | counsel, partnerships | Roadmap |

## 13. Open decisions (recommendations)

1. **Primary execution adapter:** **IBKR first** (you have it; advisor sub-accounts fit B2B2C), SnapTrade for breadth. ✅ recommended.
2. **Data vendor:** start **Polygon or Tradier** (cost/latency) ; evaluate dxFeed for production. Decide on real-time vs delayed for quoting.
3. **Discretion model:** **non-discretionary** (policy pre-auth or ticket confirm) to stay infra-side. ✅
4. **First asset:** **IBIT only.** ✅
5. **Compliance structure:** confirm "tech/routing provider" framing with counsel; define what the partner attests to (suitability/approval).

## 14. Suggested additions (beyond the brief)

- **Portfolio-level / batch protection** across an advisor's book (aggregate BTC-ETF exposure → efficient block hedge) — advisor-friendly, better fills.
- **Protection-as-a-policy** (set-and-maintain floors with auto-roll) — recurring revenue; reuses the monitoring core.
- **Pre-trade "what-if"** and **cost-over-time** views (30/60/90d ladder) baked into the widget.
- **Alert-only tier** as the zero-friction wedge to land partners before execution integration.
- Reuse the **sanity-script pattern** for an ops tool: connection health, data freshness, fill quality, roll due-dates.
