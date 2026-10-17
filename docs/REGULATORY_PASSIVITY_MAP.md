# Routing Discretion Map: Atticus Components vs. the "Passive Software Provider" Posture

**Status:** internal working document for counsel, 2026-09-18. This is an engineering inventory, not legal advice and not a redesign proposal. It answers one question counsel will ask: *for each thing the code decides, who is it deciding for, and does that decision look like a buy/sell signal or routing discretion?* Nothing here should be built or changed until counsel has reviewed it. See `docs/AGENT_HANDOFF.md` §6.

**Context (as summarised in the handoff; counsel to verify against the letter text):** CFTC Staff Letter 26-25 (2026-09-17) extends no-action relief to "passive software providers", front-ends that let users submit orders directly to registered DCMs/FCMs, which may charge transaction fees and take revenue share, subject to strict passivity: no buy/sell signals, no routing discretion, plus conditions. Letter 26-09 is the earlier posture on the same theme.

---

## 1. The threshold point: Atticus is a principal today, not a front-end

In every live lane, the user never routes an order through Atticus to a venue. Atticus **is the counterparty**: it writes the protection (floor + cap for a credit) and then hedges *its own* resulting position at whatever venue is cheapest. The trader's only order is the one they already placed at their own venue before Atticus was involved.

That matters because the passive-provider frame assumes the user's order goes to a DCM/FCM and the software merely conveys it. Atticus's current architecture does not fit that frame at all; it fits the frame of a principal writing a derivative and hedging. So the honest map has two columns:

- **Lane P (principal, what exists):** the passivity letter is probably not the operative relief. The question is whether writing protection to a US retail person on an event contract or perp is itself a regulated activity (swap dealer thresholds, retail commodity transaction rules, state law). That analysis is counsel's and is outside this document.
- **Lane F (front-end, hypothetical):** a variant where the *user* places the hedge legs at a DCM themselves, Atticus shows the math and charges a fee. This is the variant the letter could apply to, and it is where the component-by-component discretion inventory below is decisive.

The rest of this document inventories the code so both lanes can be assessed from facts rather than from the pitch.

## 2. Component inventory

Legend for the "passivity concern" column, applied as if Lane F were built: **none** (pure information or pure execution of the user's instruction), **terms** (Atticus chooses the economic terms of the structure), **routing** (Atticus chooses which venue or instrument), **signal** (the output could be read as a recommendation to buy or sell).

### 2.1 Event contracts (Kalshi / Polymarket), `services/api/src/eventCollar/**` and `scripts/eventProtect*.ts`

| Component | File | What it decides | For whom | Concern |
|---|---|---|---|---|
| Quotable-band gates | `eventCollarPricer.ts`, `crossVenuePricer.ts` (`markLowerBoundCents`, `minMinutesToResolution`, `minMinutesToStart`) | whether protection is offered at all on this market right now | Atticus | none (declining to offer a product is not a signal about the underlying) |
| Floor/cap grid search | `quoteWrap`, `quoteCrossWrap` (`floorOffsetsCents`, `capOffsetsCents`, selection rule "highest floor at or above entry, then largest credit") | the exact floor, cap, and credit shown to the user | user's structure | **terms**. Atticus, not the user, picks the strikes. In Lane F this is the single most exposed decision: the user would be handed a specific pair of legs to place. Mitigation candidates: user-selectable floor/cap with Atticus showing the credit for each; or present the whole grid, not one row. |
| Hedge sizing (round up, min-order clamp) | both pricers | how many verticals / NO shares fund the floor | Atticus's hedge | none in Lane P (own hedge). **routing/terms** in Lane F if the user is told to place that size. |
| Dual-route selection | `eventProtectXDemoService.ts` scan (`RouteCheck`, `HedgeRoute` = `polymarket` \| `kalshi_self`) | which venue hedges the floor: Polymarket opposing-outcome token vs. Kalshi's own NO side | Atticus's hedge | none in Lane P. **routing** in Lane F if the user is directed to a venue. Note: the `kalshi_self` route is single-venue (user buys NO on the same DCM they already trade on), which is the only route that could plausibly be "no routing discretion". Cross-venue is out for Lane F by construction. |
| EV cost display | `evCostBps` | the true expected-value cost of the protection at the market's own odds | user information | **signal-adjacent**. It is a fact about the structure, but "protection beats naked here" (negative bps) could be read as encouragement to protect. Copy discipline: state it as cost, never as advice. Already the practice on the drawer. |
| Resolution whitelist / matcher | `resolutionWhitelist.ts`, `eventMatcher.ts` | which venue pairs are ever allowed to hedge each other | Atticus | none. Risk control on Atticus's own hedge. |
| Showcase / board selection | `showcasePicker.ts`, board ranking in the X demo (volume, spread, time to event) | which live market the visitor lands on | marketing surface | **signal-adjacent**. Curation of which market to show is editorial, not a recommendation to buy the underlying, but it should stay on liquidity/time criteria (as it is) and never on "we think this outcome is mispriced". Document the criteria on the page. |
| Refusals | all pricers (`credit_nonpositive`, `pm_book_too_thin`, `resolution_mismatch`, ...) | declining to quote, with the reason shown | Atticus | none. Shown refusals are the doctrine and cut the other way regulatorily: nothing is hidden. |
| Quote / cross ledgers | `quoteLedger.ts`, `crossLedger.ts` | append-only record of every quote and refusal | audit | none. Helpful: reproducible pricing history. |
| Shadow ledger and record page | `shadowLedger.ts`, `eventShadowWorker.ts`, `eventShadowHtml.ts` | simulated positions marked to official results; public scorecard | marketing / track record | not a passivity question but a **performance-advertising** one: simulated results shown publicly. Current copy ("What is real / What is simulated", "Demonstration, not an offer") is the right instinct; counsel should bless the exact wording. |

### 2.2 Perps (Hyperliquid), `scripts/creditCollarDemoService.ts` and `src/singleSide/twoSided/creditCollar/**`

This lane is non-US by design (geofence, `epGeofence.ts`, currently `EP_GEOFENCE=false` pending counsel's list) and hedges at OKX, which is not a US DCM. The passivity letter does not reach it. The inventory is still useful because the same components would be reused in any US venue embed.

| Component | File | What it decides | Concern if reused in a US embed |
|---|---|---|---|
| Strike plan (floor % / cap %) | `demoPlanStrikes`, `DEMO_FLOOR_PCT`, `DEMO_CAP_PCT`, `regimeGate.ts` (cap widens in elevated regimes) | the structure's terms, regime-dependent | **terms** (same as 2.1 grid search) |
| Venue for the hedge | fixed OKX listed touch (`okxListedTouchQuote.ts`) | where the hedge trades | none today (single venue, Atticus's own hedge) |
| Auto-renew | `renewalDecision`, `DEMO_AUTO_RENEW` | re-wraps at expiry while the toggle is on; skip-days on unfundable books | **discretion over timing**: Atticus decides *when* the next structure is written, on a stagger. In Lane P this is the product ("protection is a state"). In any front-end variant it would be an automated order, which is the opposite of passive. |
| Partial-wrap sizing, caps, cohort, concentration | `capsConfig.ts`, `assessDemoWrap` | how much of the position is protected and whether a wallet may wrap | **terms**, risk-driven |
| Take rate | `applyTake`, `takeRateFor` | fee, published | none (fees and rev-share are expressly permitted in the letter as summarised) |
| Knockout / early close / unwind | `knockoutWrap`, `lockPolicy.ts`, `unwindLiveCollar` | when Atticus's own hedge is unwound | none (own book) |
| Showcase wallets | `epShowcase.ts` | which public wallets are displayed in watch mode | marketing; watch-only, action-guarded |
| Funnel | `epFunnel.ts` | counts lookers and page loads, no IPs | none |

### 2.3 Summary counts

Across both lanes there are **two** components that choose economic terms for the user (the floor/cap search and the perp strike plan), **one** that chooses a venue (the dual-route event scan), **one** that chooses timing (auto-renew), and **two** display surfaces that need copy discipline rather than code changes (EV cost, showcase curation). Everything else is either Atticus's own risk control or pure record-keeping.

## 3. What a Lane F ("passive front-end") variant would have to give up

Listed so counsel can say which of these actually matter; none of this is proposed for build.

1. **Term selection.** The user picks floor and cap from a displayed grid; Atticus shows the credit for every cell and never pre-selects. Loses the "one tap" simplicity, which is the product.
2. **Cross-venue hedging.** Only `kalshi_self` (user buys NO on the DCM they already use). Loses the neutrality story and the route competition that produces the best credits.
3. **Auto-renew.** User re-confirms each period. Loses "protection is a state".
4. **Principal role.** Atticus never holds the other side; the user's own two legs are the whole structure. Loses the credit as a *payment from Atticus* (it becomes the user's own net premium) and loses the flat-book capital story in `docs/VAULT_DESIGN.md`.

The honest read: Lane F is a different, weaker product that happens to fit the letter. It might be a useful **US on-ramp** (show the math, let the user do it on Kalshi, charge a fee) while Lane P stays non-US and B2B. Whether that is worth a second product surface is a business decision after counsel's read, not an engineering one.

## 4. What does not change regardless

- B2B white-label to a registered venue: the venue is the regulated party, Atticus is a vendor. Every component above is fine in that posture. This is the primary business model and this document does not alter it.
- Simulation and shadow trading: no registration question; only advertising copy discipline.
- Hedging as principal at non-US venues for non-US users: current lane P posture.

## 5. Questions for counsel

1. Does Letter 26-25's relief have any application to a principal model (Lane P), or is it strictly a front-end relief?
2. If Lane F were built with `kalshi_self` only and user-selected terms from a full grid, does displaying the *credit* for each cell constitute a signal?
3. Is a curated "market of the moment" (showcase) a recommendation if the selection criteria are published and are purely liquidity/time-based?
4. Is a public simulated track record (the shadow record page) subject to performance-advertising rules for a non-registrant, and what disclaimer language is required?
5. For the perp lane, does the geofence list need to be live before any US-reachable marketing (the `/video` page is public), or is the action-level block sufficient?
