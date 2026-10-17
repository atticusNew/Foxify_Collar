# Earn & Protect — Competitive & Unit-Economics Brief

*Internal / meeting prep. Updated 2026-08-15. Numbers are sourced where stated, labeled ILLUSTRATIVE where projected.*

---

## 1. What we do, in one story

Maya holds a 0.03 BTC long (~$1,900) on a perp venue. She flips one toggle: **Earn & Protect**.

Behind the toggle, the engine (all real, verified live 2026-08-15):

1. Reads her actual position from the venue.
2. Buys her a **floor**: a listed BTC put ~6% below spot. If BTC crashes 20% overnight, her loss stops at ~6%.
3. Sells a **cap**: a listed BTC call ~1.5% above spot. She gives up gains beyond that point until expiry.
4. The call sells for more than the put costs. The difference — after real exchange fees — is **paid to her as a credit** that vests until expiry (the daily 08:00 UTC listed fixing).
5. If the market can't fund a positive credit, the wrap **refuses and says why**. It never fakes a number, never rounds her size up, never charges her.

She keeps custody. She moves no funds. She can close early anytime and keep the vested part. Result: she is *paid to become safer*.

**Live proof (worst case, deliberately):** Saturday 03:52 UTC, 1-lot ($630) position, weekend book: floor $59,000 / cap $63,400, credit **$0.04** after $0.02 fees — real OKX legs, both filled. Small because of size and weekend books (Section 5), honest to the cent.

---

## 2. How the others generate yield

| Product | How it works | Their number (sourced) | What the user really carries |
|---|---|---|---|
| **Bitflow HODLMM** (LP fees) | Deposit sBTC/tokens into concentrated-liquidity pools; earn swap fees | "3–5% APY in sBTC" (their launch post) | Impermanent loss: LPs are short convexity — one big BTC move erases months of fees |
| **Velar PerpDEX LP** (house vault) | LPs deposit sBTC/USDh and take the other side of trader PnL + fees | Varies with trader losses | You are the casino's bankroll; trending markets and sharp flow bleed the vault |
| **StackingDAO** (staking) | Liquid stacking of STX; building stBTC (BTC staking LST) | Stacking yield + incentives (~$20M TVL) | Emissions-dependent; lockup/liquidity risk on the LST |
| **sBTC rewards** | Hold sBTC, earn BTC rewards | "up to 5% APY" — funded by ecosystem incentives | Subsidy, not market yield; ends when the budget does |
| **Zest** (lending) | Deposit sBTC, earn borrower interest | ~1.5% APY in BTC ($70–76M TVL) | Small; borrowers carry liquidation risk (1,500+ liquidations processed) |
| **Hermetica** (basis) | BTC backed + short perp = synthetic dollar; harvest funding | 6–8% APY (marketed to 25% in bulls) | Funding flips negative in bears; CEX/custody counterparty risk |
| **Covered-call vaults / CEX "dual investment"** | Sell calls on holdings for premium | 5–30% APY headline | Downside fully open — one drawdown eats a year of premium |
| **Points / emissions** | Farm expected airdrops | "∞ APY" until TGE | Not yield; deferred marketing |

**The pattern:** every product above pays the user to *absorb a risk* (convexity, trader PnL, lockups, credit, funding, naked downside). That is what their yield is: risk compensation.

---

## 3. Head-to-head

**Where they are strong (say this out loud in meetings — it builds trust):**

- Headline APYs are bigger than our per-wrap credit. Real products, real fees, real TVL.
- LP/staking yield suits **parked** capital that isn't trading anyway.
- Hermetica's basis yield is genuinely clever and institutionally packaged (custody attestations).
- They have distribution and community we don't yet have.

**Where we stand out (unique, not incremental):**

1. **Only product where the yield event makes the user safer.** Everyone else: paid to take risk. Us: paid to remove it.
2. **The floor is free — better than free.** Anywhere else in finance, a 6% floor costs put premium. With us the user *receives* money along with the floor. The honest comparison isn't APY-vs-APY, it's "get paid for protection" vs "pay for protection."
3. **Market-priced, auditable, refuse-when-unfundable.** Every cent traces to a listed exchange fill; reconciliation against the venue's own settlement prints. No subsidy, no emissions, no synthetic APY.
4. **No custody, no migration, no lockup.** Attaches to the position the trader already holds; early close keeps vested credit.
5. **For the venue: our yield feeds their core metric.** LP/staking products pull capital *out* of trading. Protected traders stay in positions longer, survive drawdowns, and keep trading. Yield that increases volume vs yield that parks it.
6. **The market need is documented.** On Hyperliquid, ~73.8% of retail loses money; **27.2% lose >85% of their capital within 30 days**; the median trader is net-negative (Envy Protocol study, 10k wallets). Catastrophic drawdown is the #1 churn event on every perp venue. We are the direct countermeasure — and the venue keeps the customer.

**Honest segment note:** median retail perp hold on HL is ~83 minutes. A daily collar is not for scalpers. Our natural users are swing holders, leveraged "stack and hold" positions, and spot/LST holders — a large minority of retail wallets and the majority of *resting* notional. Early close (keep vested) partially serves shorter holds. Do not pitch this as a scalper product.

---

## 4. Their numbers vs our numbers

| | Typical yield | Floor under the position? | Source of yield |
|---|---|---|---|
| Bitflow LP | 3–5% APY | No — IL makes drawdowns worse | Swap fees |
| sBTC rewards | ~5% APY | No | Incentive budget |
| Zest lending | ~1.5% APY | No (borrowers: liquidation) | Borrow interest |
| Hermetica | 6–8% (to 25%) | N/A (dollar product) | Perp funding |
| Covered-call vaults | 5–30% headline | **No — downside fully open** | Sold upside |
| **Earn & Protect, today (1-lot CLOB, weekend)** | ~2% annualized equivalent + **6% hard floor** | **Yes** | Sold upside minus bought floor, listed market |
| **Earn & Protect, at block economics (projected, Section 5)** | **5–16 bps/day** (≈ 12–45% annualized *if renewed daily*) + 6% hard floor | **Yes** | Same, executed at block size |

*Never lead with the annualized number — lead with "credit + floor vs premium cost for the same floor." The annualization assumes daily renewal and weekday books; say so whenever it's shown.*

---

## 5. Unit economics per position — the honest chain

**Why tonight's wrap paid $0.04.** One OKX option tick = 0.0001 BTC ≈ **$0.063 on a 1-lot ($630) position** — the atom of the trade. Weekend book: put cost 1 tick, call bid 2 ticks, gross $0.063, fees $0.02 → **$0.04**. Three separate penalties, all size-dependent: tick quantization, full bid/ask crossing (≈ half of mid value at 1 lot), fee floors (~30% of gross at 1 lot).

**The same structure at each execution tier (per $630 lot, per daily wrap):**

| Tier | Fill quality | Net credit per lot | bps/day |
|---|---|---|---|
| 1-lot CLOB, weekend (live-verified tonight) | touch, quantized | $0.04–0.10 | 0.6–1.6 |
| 1-lot CLOB, weekday | touch, tighter books | $0.10–0.25 | 1.6–4 |
| **RFQ block ≥$50k (pooled)** | near mid, no leg race | $0.30–1.00 | **5–16** |
| Reference: marketplace pilot tape | $80 credit / $50k position, weekday | $1.00/lot equiv | 16 |

**The aggregation math (user's question: does $630 × many traders fix it?). Yes — this is the entire model:**

ILLUSTRATIVE scenario — mid-size venue, labeled assumptions:

- 20,000 active traders (HL has ~230k; mid-size perp DEXs 5–50k) · 5% attach rate = 1,000 wrapped positions/day · average wrapped position **$2,000** (HL "Fish" retail cohort holds $250–$10k equity) ⟹ **$2M/day wrapped notional**.
- Book nets internally first: at a 60/40 long/short split, ~80% of gross offsets; **residual ≈ $400k/day** hedged as RFQ blocks near mid.
- **Traders** collectively receive ~8 bps/day average = **~$1,600/day in credits** — paid by the options market, not by the venue and not by us.
- **Venue** pays Atticus a platform fee (see below); gains retention on its highest-churn segment.
- **Atticus revenue, two lines:**
  - Platform fee 7.5 bps on wrapped notional (venue-billed): **~$1,500/day ≈ $45k/month** per venue at this adoption.
  - Netting margin: spread never paid to the street on the ~80% internally offset ≈ **~$1,000–1,500/day gross** (size- and balance-dependent).
- **Capital:** portfolio margin on the residual (~10% IM on $400k) ≈ **~$40k working capital** — revenue-to-capital ratio is the quiet headline.

Same math at the user's literal example — 10,000 traders × $630: $6.3M/day wrapped, ~$5k/day trader credits at 8 bps, ~$4.7k/day platform fee (~$140k/mo), residual ~$1.3M/day, IM ~$130k. **A $630 position inside that book earns ~13–25× tonight's credit.** That is "every client inherits block economics."

**Per-position unit economics summary (production, per daily wrap):** trader receives 5–16 bps of notional as credit + a 6% floor · venue pays 5–10 bps platform fee on wrapped notional · Atticus nets fee + netting margin, deploys ~10% of *residual* notional as margin capital · marginal cost per additional wrap ≈ zero (software + shared blocks).

---

## 6. Talking points (deploy in this order)

1. "Everyone on your yield page pays users to take risk. We pay them to remove it."
2. "A floor costs money everywhere else in finance. Ours pays you."
3. "27% of retail perp traders lose 85%+ of their capital in a month, then they leave. We're the retention product for exactly that moment — and the credit comes from the options market, not your treasury."
4. "Your LP yield parks capital. Our yield keeps it trading."
5. "Every cent auditable to an exchange fill. We refuse honestly when the market can't fund a credit — you saw exchanges melt down over fake yield; this is the opposite architecture."
6. Objection "the credit is small": show tonight's $0.04 *and* the block-economics chain (Section 5). Small honest numbers that scale beat big fake numbers that don't.

*Sources: Bitflow/Velar/Zest/Hermetica/Stacks public materials & Q1–Q2 2026 ecosystem reports; Hyperliquid cohort & PnL studies (Coinmarketman, 0xarchive, Envy Protocol); Atticus live execution logs 2026-08-15. Projections labeled ILLUSTRATIVE use stated assumptions only.*
