# Protection-Writing Vault: Design Memo

**Status:** design only, no code. Written 2026-09-18 for founder review. Nothing here is a commitment to build; the point is to pin down what the vault is for, what it earns, what it risks, and which shape to build first, so the roadmap line "vault as the on-chain capital leg" means one specific thing.

**Read with:** `docs/AGENT_HANDOFF.md` §2-3 (doctrine, business model), `docs/earn-protect-unit-economics.md`, and the live facility scorecard at facility.atticustrade.com for the measured numbers referenced below.

---

## 1. What the vault is (and is not)

Atticus never holds a directional option position. Every wrap is back-to-back: the trader's cap leg is sold on to a venue, the trader's floor leg is bought from a venue, and the credit the trader receives is what the venue book paid minus fees and the published take. The facility scorecard shows this directly: "Atticus option net (hedged) $0" across 127 settled positions.

What the business does need is **margin**. A hedged book still posts initial margin at every venue, and that capital is the binding constraint on how much notional can be protected at once. Today it is Atticus's own balance.

So the vault is **a margin and settlement-float pool that earns fee yield**, not an options-writing strategy. That is the single most important design decision, and it separates this from the DeFi "options vault" category (covered-call and put-selling vaults), which take directional risk and have a poor track record. The vault's depositors are paid for lending balance sheet to a flat book, and their downside is operational, counterparty, and basis risk, not market direction.

The one-sentence version for a term sheet: *the vault posts the margin, Atticus runs the book flat, depositors earn a share of the take plus the netting savings, and every position on the book is visible and reconciles to a venue fill.*

## 2. Why the numbers say a vault is worth building

Measured on the perp facility (53 days, 127 settled, as of 2026-09-18):

| Quantity | Measured | Source |
|---|---|---|
| Isolated IM as a share of notional | ~14% | facility "capital-aware net" panel |
| Portfolio-margin netting factor on the hedged book | 0.078 | facility panel; `epMarginMeasure.ts` |
| Effective IM under PM | ~1.1% of notional (14% × 0.078) | derived |
| Capital drag | 0.036 bps/day | facility panel |
| Peak IM seen | $546 | facility panel |
| Take | ~10% of trader credit, de minimis waived | `capsConfig.ts` (`applyTake`) |

Two consequences:

1. **Capital efficiency is the moat, not the fee.** Under portfolio margin, $1 of vault capital supports roughly $90 of hedged notional before liquidity limits bite. Nobody running isolated positions (the trader themselves, or a venue's own structured desk) gets that ratio. This is why a neutral layer with a pooled margin account can undercut anyone building the same product inside a single venue.
2. **The yield is small per dollar of notional but large per dollar of capital.** At a 10% take on credits that run roughly 1-2 bps/day of notional on the perp book, fee income is on the order of 0.1-0.2 bps/day of notional, which is 10-18 bps/day on the capital actually posted under PM. That is before liquidity caps, venue fees, and the reserve described below, so treat it as an upper bound to be measured, not a projection. The Aug 31 handoff's "$25k collateral unlocks ~$125k book at standard margin, $400k+ under PM" is the same arithmetic at pilot scale.

Everything in this memo should be re-derived from live numbers before it is shown to anyone outside.

## 3. What depositors earn, and from what

Cash flows per wrap, in order:

1. **Gross credit** is sourced from venue books (call bid minus put ask minus venue fees, for a long).
2. **Take** (10%, waived under de minimis, founding wallets at their locked rate) is retained. This is the only revenue line that exists today.
3. **Netting savings** when the book carries offsetting wraps (a long BTC wrap and a short BTC wrap need fewer venue legs than two isolated hedges). `inventoryBalancer.ts` and `epRfqNetting.ts` already model this. Today the savings are passed through as better credits; a vault could retain a published share.
4. **Trader credit** is paid out (vests linearly, `creditVesting.ts`).

Proposed waterfall for the vault:

| Priority | Line | Goes to |
|---|---|---|
| 1 | Venue fees, funding, IM cost | paid first, always |
| 2 | Loss reserve top-up (see §4) | until the reserve is at target |
| 3 | Depositor yield: 100% of netting savings retained + X% of the take | depositors |
| 4 | Remainder of the take | Atticus |

X is the founder's call; the memo's assumption is 50% until the reserve is at target, 30% after. Publish the split on the receipts page the same way the trader's take is published today. The doctrine applies to depositors exactly as it applies to traders: no hidden margin.

## 4. What depositors risk

None of these are directional. All of them are real.

| Risk | Where it comes from | Existing control | Vault-level control |
|---|---|---|---|
| Hedge slippage / partial fill | leg fills worse than the quoted touch | `LIVE_ENFORCE_QUOTE_FLOOR`, unwind-on-partial in `okxLiveRunner` | loss reserve; per-wrap slippage cap |
| Unwind cost on breach | knockout or early close forces a venue unwind | `unwindLiveCollar`, `lockPolicy.ts` (unwind only when buyback ≤ unvested credit) | same, plus a daily unwind budget |
| Basis between HL mark and venue settlement | the perp settles on HL, the option on OKX | `basisGuard.ts`, `referenceOracle.ts` | basis tolerance is a vault parameter, breaches pause new wraps |
| Venue counterparty | funds on OKX / Polymarket / Kalshi | multi-venue routing | per-venue exposure cap as % of NAV; venue whitelist |
| Settlement parity (events) | two venues settle a "matching" event differently | `resolutionWhitelist.ts`, refusal on mismatch | the whitelist is the only allowed pairing set; no override |
| Operational | a stuck loop, a stale price, a bad deploy | `epSafety.ts` watchdogs, healthz warm gate, alerts | pause switch halts new wraps; existing wraps conclude normally (already the behaviour) |
| Concentration | many same-strike wraps knock out together | `assessStrikeConcentration` | unchanged; formula caps scale with NAV instead of a fixed env |

**Loss reserve.** Target 2-3× the worst observed daily unwind cost on the facility (the Aug 19 stress day, −$1,858 on a ~$25k modelled facility, is the current reference point). Funded from the take before depositors are paid. Below target, new wraps are throttled, not stopped.

**What depositors are explicitly not exposed to:** the trader's P&L, the direction of BTC, event outcomes. If the book is ever not flat, that is a bug, and the reconciliation loop should flag it (it does today: "Reconciled 100%, 0 w/ drift").

## 5. Shape: three options, one recommendation

**A. Pooled venue account with on-chain receipts.** Depositors wire USDC to an Atticus-controlled account that funds venue sub-accounts. NAV, positions, and every fill are published on the receipts page and hashed on-chain daily. Fastest to ship; legally a plain pooled investment; depositors trust Atticus custody.

**B. ERC-4626 vault with a permissioned operator.** USDC vault on Hyperliquid EVM (or Katana, both already on the B2C roadmap via builder codes). An operator role moves capital to venue sub-accounts under published limits and posts book state back through an attestation. Standard token accounting, composable, auditable; requires a bridge to centralised venues for the OKX options leg, which is the hard part.

**C. Hyperliquid native vault.** HL's vault primitive gives leader/follower accounting for free, but it only holds HL positions. It cannot post margin at OKX or Polymarket, so it can only back the HL perp leg, not the option hedge. Useful later as a sub-vault, not as the capital leg.

**Recommendation: A now, B as the target, C never as the primary.** A gets real depositor capital and real yield data in the shortest path and proves the flat-book claim with third-party money. B is what "on-chain capital leg" should mean when the pitch says it, and it should be built once A has 60-90 days of published NAV. The two are compatible: B's operator withdraws to exactly the same venue sub-accounts A already uses.

## 6. Parameters the vault owns (proposed)

These should be env-driven at first, like every other cap in the perp service, and move on-chain with option B.

| Parameter | Proposed start | Why |
|---|---|---|
| Max utilisation (IM posted / NAV) | 40% | keeps 60% liquid for unwinds, variation margin, redemptions |
| Per-venue exposure cap | 50% of NAV | no single venue failure takes more than half |
| Per-strike concentration | inherit `perStrikeCapPct` | already formula-driven |
| Basis tolerance | inherit `basisGuard` | pause new wraps above it |
| Redemption | weekly, T+1 after the last daily expiry in the window | positions are 1-day; a week clears the book without forced unwinds |
| Drawdown gate | −3% NAV from high-water mark pauses new wraps | operational fault detector, since the book should not have market drawdowns |
| Minimum reserve | 2× worst observed daily unwind | §4 |

## 7. Regulatory posture (know it, do not act on it)

A pooled vehicle that takes third-party money and pays a return is an investment contract in most jurisdictions regardless of the token wrapper. Non-US depositors only at first, KYC on entry, no US marketing, and the same counsel gate that governs the B2C event lane (`docs/REGULATORY_PASSIVITY_MAP.md`, `AGENT_HANDOFF.md` §6). The vault does not change the analysis of the protection product itself; it changes who is the principal's balance sheet. Counsel decides whether option A is offered as a fund interest or a loan, and that decision sets the waterfall's legal form. Do not redesign around this without direction.

## 8. Phasing

| Phase | What ships | Exit criterion |
|---|---|---|
| 0 (now, no capital) | The facility already publishes "capital-aware net" and IM drag. Add a **shadow NAV**: what a $100k vault would have earned day by day under the §3 waterfall, on the receipts page. | 30 days of published shadow NAV with the reserve line visible |
| 1 | Option A with 3-5 non-US depositors, $100-250k, weekly redemption, daily on-chain hash of the ledger | 60-90 days, zero reconciliation drift, yield within 20% of shadow NAV |
| 2 | Option B contract on HL EVM or Katana, operator limits from §6 encoded, attestation of venue balances | phase-1 depositors migrate; NAV on-chain matches receipts |
| 3 | Permissionless deposits within a hard NAV cap; venue-side embeds draw on the same pool | a venue embed live |

Phase 0 costs nothing and produces the single most useful artefact for the raise: a dated, published answer to "what would the vault have returned", computed with the same integer-cents discipline as the rest of the book. It should be the first thing built if the founder confirms this direction.

## 9. Open questions for the founder

1. Depositor share of the take (X in §3): 50/30, or a flat number?
2. Should netting savings be retained by the vault or continue to pass through to traders? Passing them through is the stronger product story; retaining them is the stronger yield story.
3. Jurisdiction and wrapper for option A (Cayman fund interest, loan note, or SAFT-style).
4. Which chain for option B: Hyperliquid EVM keeps the perp lane native; Katana is on the B2C roadmap; Arbitrum has the deepest USDC and tooling.
5. Is phase 0 (shadow NAV on the facility page) approved as the next build?
