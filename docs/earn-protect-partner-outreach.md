# Earn & Protect — Partner Outreach Playbook

*Companion to the launch plan. The launch plan owns direct-to-trader channels; this doc owns partner outreach: lenders, wallets/portfolio trackers, and newer exchanges. Everything here is ready to copy-paste. Fill the `{metric}` placeholders from the public dashboard before every send — real numbers are the whole pitch.*

**Rule zero:** no send goes out without the live link. The product is the deck: **earnandprotect.xyz**.

---

## 1. The operating plan

### Cadence (fits around building — ~2–3 hrs/week total)

| Day | Action |
|---|---|
| Monday | One batch of ~10 personalized sends: 3 lenders, 4 wallets/trackers, 3 newer exchanges. Log each in the tracker below. |
| Thursday | Follow-ups due that week (touch 2 at +4 days, touch 3 at +10 days). Nothing else. |
| Friday | Log outcomes. Any audience at 0 replies after 2 full batches → rewrite that audience's email before sending more. Any audience that produced a real conversation → double its share of next Monday's batch. |

### Targeting rules

- **Role, not rank.** First touch goes to: head of product, head of derivatives/structured products, head of risk (lenders), or head of growth. CEO only at companies small enough that the CEO ships product (~<15 people).
- **Three touches, then park.** Initial → +4 days → +10 days with something *new* (a shipped feature, a fresh metric, a receipt screenshot). Never a naked "bumping this." Parked targets get one re-touch per quarter when there's a real milestone.
- **Any reply is a door — even the "wrong" person.** A reply from marketing/promotion/community means the message is interesting but landed outside the buying seat. Answer within a day with the intro ask (template 5.1). An internal forward beats ten cold emails.
- **Personalize the first line only.** One sentence proving you know their product ("saw you shipped X", "your users hold perps on Y"). The rest is the template. Personalizing more than that doesn't raise reply rates enough to justify the time.
- **Metrics format, everywhere:** "Live on Hyperliquid: {N} wallets wrapped, ${notional} protected, {credits paid} in credits paid, 0 client losses below floor." Small real numbers beat big claims.

### What each audience is actually buying

| Audience | Their metric | Our pitch in their language | What we ask for |
|---|---|---|---|
| Lenders / margin desks | Tail losses, liquidation cascades | A floor under collateral value = fewer liquidations, smaller write-downs; the credit offsets borrower interest | 30-min risk-desk call; one wrapped test position |
| Wallets / portfolio trackers | DAU, session frequency, retention | A toggle users flip daily that pays them — engagement that generates revenue instead of costing it | 1 integration conversation; white-label demo in their brand |
| Newer / mid exchanges | Differentiation, listings, volume retention | A protection + yield product no competitor has, live under their brand in weeks, rev-share | Pilot on one market (BTC perps) |

---

## 2. One-pager — LENDERS / MARGIN DESKS

*(Half page. Send as PDF or paste into email body below the signature when they ask for detail.)*

**Earn & Protect — collateral that defends itself**

**The problem you own:** your loan book's tail risk is collateral gapping down faster than liquidations can clear. Every cascade costs you write-downs, socialized losses, or insurance-fund drawdowns.

**What we do:** a hedging engine that wraps a position or collateral balance with a hard price floor and a capped upside, structured so the holder is *paid a credit* rather than paying a premium. Floors are real: hedged leg-for-leg on listed options venues, not pooled, not synthetic. Every wrap has a venue receipt.

**What that means for a lender:**
- Wrapped collateral has a known worst-case value. Margin models can credit the floor; liquidation triggers move down or disappear for the covered notional.
- The daily credit can offset borrower interest — "protection that pays for your loan" is a borrower acquisition story, not just risk hygiene.
- Zero integration to pilot: wraps run against public position/balance data; your risk team can watch a live test position before touching an API.

**Economics:** we price from live listed-options markets and take a spread on the credit. You keep the risk reduction; optional rev-share on borrower-facing deployments.

**Status:** live on Hyperliquid at earnandprotect.xyz — {N} wallets, ${notional} wrapped, credits paid daily, every hedge visible on-venue. Product refuses to quote when markets can't fund the credit (we decline business rather than misprice it).

**Ask:** 30 minutes with your risk desk. We'll wrap a live test position during the call.

---

## 3. One-pager — WALLETS / PORTFOLIO TRACKERS

**Earn & Protect — a toggle your users flip every day**

**The problem you own:** wallets and trackers are where positions are *viewed*, not where money is *made*. Engagement is a cost center; monetization means ads or swap fees.

**What we do:** a one-tap protection + yield toggle for any perp position your app can see. User flips it on: their position gets a hard floor and starts earning a daily credit. Flips it off anytime. We hedge every wrap leg-for-leg on listed options venues and settle credits in USDC.

**What that means for your app:**
- **A daily reason to open your app.** Credits vest through the day; users check them like they check funding rates.
- **Revenue, not a feature cost:** rev-share on the spread we take from every credit. Your engagement generates income.
- **Your brand, our engine.** The entire flow runs white-label — your colors, your name, "powered by Atticus" in the footer. Integration is 4 JSON endpoints (positions → quote → wrap → state). A branded demo takes us ~30 minutes to stand up.

**Status:** live on Hyperliquid at earnandprotect.xyz — {N} wallets, ${notional} wrapped, credits paid daily, honest refusals when markets can't fund the credit. Try it with any HL address in 10 seconds.

**Ask:** one integration conversation. We'll bring a demo already skinned in your brand.

---

## 4. One-pager — NEWER / MID EXCHANGES

**Earn & Protect — the retention product none of your competitors have**

**The problem you own:** traders churn to whoever has the next incentive program. Fee rebates and points are copyable in a week.

**What we do:** an embedded protection + yield product for your perp traders. One tap: their position gets a hard price floor and earns a daily credit, paid whether the market goes up or down. If price runs through the cap, protection ends, they keep the vested credit, and it re-arms automatically. We hedge every wrap leg-for-leg on listed options venues — your exchange carries no new risk book.

**What that means for your exchange:**
- **Positions stay open longer** (protected traders don't panic-close), which is volume and funding retention.
- **A product headline competitors can't copy quickly:** "the only exchange where your position pays you to protect it."
- **Live under your brand in weeks:** 4-endpoint JSON API, white-label UI, we run the hedging engine and the risk. Rev-share on the spread.

**Status:** live direct-to-trader on Hyperliquid at earnandprotect.xyz — {N} wallets, ${notional} wrapped, credits paid daily, every hedge receipted on-venue.

**Ask:** a pilot on your BTC perp market. Working demo in your brand before the first call if you want it.

---

## 5. Email sequences

*All emails: subject ≤6 words, body ≤120 words, one link, one ask. Send from the founder account. `{first-line}` = one sentence proving you know their product.*

### 5.1 The intro-ask reply (send FIRST — to anyone who already replied, e.g. the Arcus responders)

> **Subject:** Re: (their thread)
>
> Thanks for the reply — genuinely helpful.
>
> Quick ask: who owns derivatives / structured products at {company}? We're live on Hyperliquid (earnandprotect.xyz — {N} wallets wrapped, credits paid daily) and I'd rather show the right person a working product than pitch around the building.
>
> If you can forward this or drop me their name, I owe you one.
>
> — Natalie

### 5.2 LENDERS

**Touch 1 (Monday):**

> **Subject:** floor under your collateral
>
> {first-line}
>
> We put a hard price floor under crypto collateral — and the holder gets *paid* for it, daily, instead of paying a premium. Hedged leg-for-leg on listed options venues; every wrap has a venue receipt.
>
> For a lender that means: known worst-case collateral value, fewer liquidations, and a credit that can offset borrower interest.
>
> Live now on Hyperliquid: earnandprotect.xyz — {N} wallets, ${notional} wrapped.
>
> Worth 30 minutes with your risk desk? I'll wrap a live test position on the call.
>
> — Natalie

**Touch 2 (+4 days):**

> **Subject:** re: floor under your collateral
>
> One number since I wrote: {receipts metric — e.g. "we paid {X} credits this week, zero client losses below floor"}.
>
> The part risk desks usually stop me on: when listed markets can't fund the credit, we *refuse to quote* rather than misprice. Happy to show you a refusal live — it's the best proof the engine is honest.
>
> 30 minutes this week or next?

**Touch 3 (+10 days):**

> **Subject:** last one from me
>
> I'll assume the timing's wrong and park this — one thing before I do: {new milestone — shipped feature, calibration report, cohort fill}.
>
> If collateral tail-risk ever makes your quarter worse than it should be, the working product is at earnandprotect.xyz. I'll check back when there's something new worth your time.

### 5.3 WALLETS / PORTFOLIO TRACKERS

**Touch 1 (Monday):**

> **Subject:** a toggle your users flip daily
>
> {first-line}
>
> We built a one-tap toggle for perp positions: flip it on, the position gets a hard price floor and earns a daily credit. Flips off anytime. Users check their vested credit the way they check funding.
>
> It runs white-label — your brand, our hedging engine, rev-share on every credit. Integration is 4 JSON endpoints.
>
> Live on Hyperliquid: earnandprotect.xyz ({N} wallets, ${notional} wrapped). Try it with any HL address, takes 10 seconds.
>
> Open to one integration conversation? I'll bring a demo in your brand.
>
> — Natalie

**Touch 2 (+4 days):**

> **Subject:** re: a toggle your users flip daily
>
> Made you something: {link or screenshot — the app skinned in their colors; it's a 30-min token swap on our side}.
>
> That's your app paying users to keep positions open — and paying you a rev-share for it.
>
> 20 minutes to walk through the 4 endpoints?

**Touch 3 (+10 days):**

> **Subject:** last one from me
>
> Parking this after today — before I do: {new metric or milestone}.
>
> The founding-rate window (10% spread, locked 12 months) applies to partner integrations too, and it closes when the cohort fills. The live product is at earnandprotect.xyz whenever it's worth a look.

### 5.4 NEWER / MID EXCHANGES

**Touch 1 (Monday):**

> **Subject:** retention product your competitors can't copy
>
> {first-line}
>
> We run an embedded protection + yield product for perp traders: one tap puts a hard floor under a position and pays a daily credit. Protected traders don't panic-close — positions stay open, volume stays home.
>
> We hedge everything leg-for-leg on listed venues; your exchange carries no new risk book. White-label, 4-endpoint API, rev-share.
>
> Live direct-to-trader on Hyperliquid: earnandprotect.xyz ({N} wallets, ${notional} wrapped).
>
> Worth a pilot conversation on your BTC market?
>
> — Natalie

**Touch 2 (+4 days):**

> **Subject:** re: retention product
>
> Since I wrote: {receipt — e.g. "a live knockout settled and re-armed itself; here's the venue receipt"}.
>
> The pitch in one line: "the only exchange where your position pays you to protect it." That headline is available to exactly one exchange in your tier — first mover keeps it.
>
> 20 minutes this week?

**Touch 3 (+10 days):**

> **Subject:** last one from me
>
> Parking this — one thing first: {milestone}. We're integrating with {"wallets" / other partner class} in parallel, and exchange-embedded is the version with the strongest economics for the host.
>
> Live product: earnandprotect.xyz. I'll come back when the numbers are bigger.

### 5.5 Variantial re-engage (existing thread — send with the live link)

> **Subject:** Re: (their thread)
>
> Since we last spoke this went from demo to live: earnandprotect.xyz — real wraps on Hyperliquid, hedges receipted on OKX, credits paid daily, {N} wallets in.
>
> Ten seconds with any HL address shows the whole flow. If the timing works now, I'd love 20 minutes; if not, I'll keep sending receipts, not decks.
>
> — Natalie

---

## 6. Trader acquisition — personal-voice drafts (X / Discord / DMs)

*Principle: credentials as origin story, never as authority. The ask is "break it," not "try it." DMs convert; threads build the backdrop. Ten personal DMs a day beats one thread a week.*

### 6.1 Intro thread (post 1–2 days after the launch thread, quote-tweeting it)

> I've been a humanities professor, a hedge fund founder, and the creator of Sonic for Hire (yes, the YouTube series). Weird path. It ends at a toggle on Hyperliquid. Quick story —
>
> The fund taught me something retail never sees up close: institutions don't ride naked exposure. They collar it — floor under the position, cap above, and the structure often *pays them*. Retail can't do this. Too many legs, too much capital, no access.
>
> So I built it into one tap. Toggle on: your HL position gets a hard floor and starts earning a daily credit, priced live off listed option books, hedged leg-for-leg. Toggle off whenever. You never owe anything.
>
> The part I'm proudest of: when the market can't fund your credit, it refuses and tells you why. I tested it with my own money and published everything that broke. Receipts over promises.
>
> First 50 wallets keep the founding rate (10% vs 20%, locked 12 months). The demo is read-only — paste your address, no keys, no deposit, 10 seconds: earnandprotect.xyz. Roast it. I answer every reply.

### 6.2 Trader DM (personalize line 1; 10/day to active HL posters)

*Rules baked into this draft: founder self-ID + naming the structure (credibility with sharp traders); mechanics instead of safety claims ("read-only, no keys" — never "no risk", which is both scam-cadence and factually wrong); volunteer the catch before they hunt for it; concrete offer at the close.*

> Hey {name} — founder of Atticus here. Saw your [specific post/position].
>
> We built Earn & Protect: a toggle for HL positions. Flip it on and your position gets a hard floor and pays you a daily credit — an institutional knockout collar, hedged leg-for-leg on listed options. The catch, so you don't have to hunt for it: there's a cap, and touching it ends the cycle (you keep the gains, the credit, and it re-arms).
>
> It's live and my own money runs through it. Before I push it wider I want sharp traders to roast it. Read-only — paste your address, no keys, nothing to deposit, 10 seconds: earnandprotect.xyz. Find something dumb and I'll fix it, credit you publicly, and hold you a founding slot (10% rate, locked 12 months).

### 6.3 Roast post (fire if the launch thread stalls by day 3–4)

> HL traders: I'll pay you to break my product. It puts a hard floor under your perp position and pays you a daily credit — which sounds fake, so come find the catch. Paper mode is read-only, zero risk. First 10 useful roasts get $25 USDC and a founding slot. earnandprotect.xyz

### 6.4 The incident-story post (any time — strongest trust asset we have)

> My product had a live incident last week, with my own money in it. A deep-OTM put had zero bids and the unwind retried into an alert storm. Here's exactly what happened, the venue receipts, and the three fixes that shipped within hours. This is what "hedged for real" maintenance looks like: [screenshots]

### 6.5 Daily rhythm while cohort < 10 wallets

- 10 personal DMs (6.2) — the actual growth engine.
- 30 min replying usefully in HL traders' threads (options math, hedging takes) — become "the collar person."
- 1 receipts post (per launch plan Phase 2).
- Offer a 5-min walkthrough call to every reply; every call is user research.
- Optional beta bounty: $10–25 USDC for the first 10 wallets that wrap a paper position and send real feedback — payment for QA, not fake traction.

## 6.5b Katana (chain partner — high structural fit, small venue today)

Katana (Polygon Labs + GSR's verticalized DeFi L2) is a different shape of partner: an entire chain whose brand is "productive TVL" — capital that works. That's our pitch in their vocabulary. Why it ranks above the generic exchange tier:

- **Build-on-top is their stated policy.** No grants; discretionary support for projects that compose with core apps and don't compete with them. A protection/yield overlay competes with nothing and touches two primitives at once (Katana Perps positions, Morpho collateral).
- **Builder codes on Katana Perps** — the HL mechanism we already understand. Engine lift = a Katana Perps position reader; hedging stays on listed options; payouts are EVM-trivial.
- **The emissions angle nobody else offers:** vKAT voting is expanding to structured-yield products (2026) — a protection overlay driving productive activity could receive directed KAT emissions, i.e. the chain partially subsidizes user credits.
- **GSR halo:** a Katana conversation is quietly a GSR relationship — relevant to the future RFQ/block-hedging rail.
- **Caveat:** ~$6M/day perp volume, TVL well off its $500M peak. Second venue, not a focus shift. One Monday-batch touch via the dev Telegram + Foundation support process; revisit seriously once the HL cohort has receipts.

**One-line pitch:** "Earn & Protect makes Katana Perps positions productive TVL — one toggle pays the trader a daily credit with a hard floor, hedged off-chain, integrated via builder codes, zero new risk on the chain."

## 6.5c Fireblocks follow-up email (Aug 26 — deliverables cover note)

*Principles: the email is a cover note, not the pitch — he asked for these deliverables and the attachments do the persuading. One ask only. No rev-share numbers in the body (they live in the one-sheet, labeled indicative). Echo his own OKX + FalconX plan back to him so he advocates for it internally. Written to be forwarded: the subject identifies the deal on sight and the body stands alone without meeting context.*

**Subject:** Atticus x Fireblocks: one-sheet, client simulation, live demo (ahead of Friday)

> Hi {name},
>
> Thanks for the time Tuesday. Everything you asked for is below, ahead of the Friday date we discussed.
>
> **One-sheet (attached).** What it is, why it fits custody (read-only; assets never leave your vaults), the audited track record, and indicative partnership economics, open to structure.
>
> **Client-profile simulation (attached).** A composite Fireblocks client: crypto-native fund, $10M BTC treasury in custody, $2M active perp book, run against our measured rates. Daily credits, floor and cap events, and behavior on the August 19 stress day.
>
> **Live demo: {institutions.earnandprotect.xyz}.** Model a $10M holding, see live market terms, and flip the toggle as it would appear in a client interface. The brand slot is a placeholder; say the word and we will skin it Fireblocks for your internal walkthrough.
>
> The execution stack is the one you pointed us to: OKX live and production-proven today, FalconX for block execution as volume nets up. No new venue builds required.
>
> Next step when you are ready: a design-partner pilot. One named client, requirements defined by your team, live inside weeks of a green light. Does Tuesday or Wednesday next week work for a short call with whoever owns that client relationship?
>
> Best,
> Natalie
> Atticus Trade, Inc.

**Pre-send checklist:**

1. The demo URL must resolve and show the institutional skin (`EP_SKIN=institutional` instance deployed) — rule zero applies; a dead link kills the send.
2. Attach the final PDFs from `docs/reports/submission/` (one-sheet + client profile), not the HTML.
3. Confirm the meeting day referenced ("Tuesday") matches the actual second-meeting date.
4. Replace the proposed call days with two concrete options, London-friendly times (contact is London-based).
5. Send morning London time.

## 6.5d OKX follow-up (reply to their "when do we start?" check-in)

*Principles: answer their question with a concrete condition, not "soon". Two specific asks, each answerable yes/no. Lead with the aligned incentive (our flow = their options volume), never with need. Do NOT play the "another exchange could fund us" card while they are leaning in; hold the honest version ("whichever venue's economics work first is where the book scales") for a stall only.*

> Good timing — we're ready on the engine side. Live fills, knockout unwinds, and full reconciliation are all proven on OKX production over the past month; the audit packet is available if useful.
>
> One gate before we scale: collateral sizing. Running the book properly means portfolio margin, and that means capitalizing the account at $25k+ rather than the $10k we originally scoped. We're closing that now.
>
> Two ways OKX could accelerate it, if there's appetite:
>
> 1. An intro to OKX Ventures. A pilot-sized check puts the book live on your options desk within weeks — and every dollar of credit we originate is hedged leg-for-leg as OKX options volume, so the flow lands on your book by construction.
> 2. Desk flexibility: an institutional/PM route or reduced minimum for a new entity with an audited, machine-verified track record.
>
> If either is workable, we'll commit to a start date on that call.

**If they answer "we can't help on capital":** "Understood — we're raising it externally; whichever venue's economics work first is where the book scales, and we'd rather it be OKX since the integration is already proven." (Fallback contact: ventures@okx.com.)

## 6.6 Where the traders are — target list + sourcing loop

The named list (traders, KOLs, communities, trackers, builder apps — with handles, links, value notes, approach, and confidence flags) lives in **`docs/earn-protect-trader-targets.csv`**. Re-verify any handle marked "re-verify" before DMing — accounts move.

**The self-refilling sourcing loop (10 fresh DM targets a day, forever):**
1. Open a whale-alert account (Lookonchain, OnChainLens, Beacon signals TG) — they identify HL wallets AND tag the trader's X handle. Every tagged trader is a warm-context DM ("saw Lookonchain flag your position…").
2. Open a graded tracker (LiquidWhales, HyperStats, HyperTracker) — mine S/A-grade wallets; profiles often link socials.
3. The official leaderboard (app.hyperliquid.xyz/leaderboard) + Hypurrscan wallet nicknames for cross-reference.
4. Kaito's Hyperliquid leaderboard ranks the loudest HL voices — the top 30 is the reply-guy roster.
5. Liquidation posts are the moment: a trader who just got liquidated is the most receptive audience a floor product will ever have. Respectful, never gloating.

## 7. Tracker (one row per target — keep in this file or a sheet, whichever you'll actually update)

| Company | Class | Person / role | T1 sent | T2 (+4d) | T3 (+10d) | Reply? | State (active / parked / call) | Notes |
|---|---|---|---|---|---|---|---|---|
| Arcus | exchange | (route via responders → derivs owner) | — | — | — | yes (non-BD) | active — intro ask 5.1 | CEO cold = dead end; work the replies |
| Variantial | exchange | existing thread | — | — | — | — | active — 5.5 with live link | |
| | | | | | | | | |

**Weekly review questions (Friday, 5 minutes):** Which audience replied? Which email got quoted back at me (that's the line that works — promote it to the subject)? What's Monday's batch? What got parked?
