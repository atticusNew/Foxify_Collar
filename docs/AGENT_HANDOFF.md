# Atticus / Earn & Protect: agent handoff

> **You are a new agent picking up an active, production-adjacent business and codebase.** Read this file in full. Open only the files it points you to. Then stop and reply with the comprehension report described in section 14. **Make no changes of any kind (no edits, commits, sends, deploys) until the founder confirms you understand.**
>
> **Last updated:** 2026-10-06. Supersedes every earlier handoff (`HANDOFF_CURRENT_STATE.md`, `HL_DIRECT_BUILD_HANDOFF.md`, `SINGLE_SIDE_TWO_SIDED_AGENT_HANDOFF.md` are historical; do not read them unless sent there). Anything in `docs/` dated before September 2026 (Foxify pilot, Deribit 1-day product, pilot-reports, phase-* sweeps, `src/pilot/`) is a concluded era. Do not crawl it.

---

## 1. Who you are working for

The founder runs Atticus alone (legal entity Atticus Trade, Inc.; contact `michael@atticustrade.com`). Self-funded to date; no outside capital in the company. He is the product owner, the seller, the regulatory point of contact and the operator. You are his engineering team, structurer, quant and advisor in one.

**His arc, because it is the pitch and it shapes every decision.** He came out of animation and entertainment distribution, where he did well in the old market and watched a new one emerge; the lesson was that the old way was not going to stay. He founded William Ting Capital to bring hedge-fund-style investing to a new generation of digital wealth that traditional funds ignored; the thesis was right and the product was wrong, because that generation had made its money a new way and did not want the old way even when handed to them. The lesson was distribution: bring the product to where people already are. In 2022 he went deep on Bitcoin as a real commodity, saw its younger digital options market being misused, and started building protection. The market taught one more thing: traders will not pay for protection. So the product makes protection pay them. That sentence is the company.

**How he works, and how to work with him.**
- Plain language, real-world terms, no jargon unless he asks for the mechanism. He speaks to podcasts, investors, exchanges and regulators from what you write; if he cannot say it out loud, rewrite it.
- Honesty is the brand and the moat. MEASURED vs ESTIMATE always labelled; shadow results are never "revenue"; never "guaranteed" or "risk-free"; the cap trade-off is volunteered; every public number is checkable by a click.
- Live-language rule: never claim what a click can falsify. Software is "in production"; execution is "production-proven on OKX (real fills)"; the hedge book "activates at first close, that is what the raise funds"; "live" only for live pricing, positions and demos; "shadow" whenever the record is mentioned.
- He decides; you advise with a recommendation and the reason. When he says "no changes until I confirm", that is literal.
- Security: he has been targeted by infostealer malware through fake investor meetings. Never ask for or echo tokens, keys or PATs; never weaken the no-secrets posture; treat unsolicited "investor" files and links as hostile.
- Copy rules: no em dashes in founder-facing PDFs and reports; "address", never "wallet", for the public identifier a user pastes; never name the first pilot partner (Foxify) in customer-facing copy; never leak private threads.
- The pitch study sheet (`docs/PITCH_STUDY_SHEET.md`) is a living document. When a number moves, a venue or regulator acts, or a real conversation surfaces a new question, update it in the same PR, with a dated changelog line.

## 2. What Atticus is

**One line.** Protection that pays. A trader has an open position; one tap puts a hard floor under it and pays them a cash credit for taking it. The derivatives market funds the credit; Atticus hedges every position leg for leg and carries no view on price or outcome.

**Two lanes, one engine.**

| | Perps (`earnandprotect.xyz`) | Event contracts (`event.earnandprotect.xyz` and the event shadow) |
|---|---|---|
| Position protected | BTC perp on Hyperliquid (long or short) | Kalshi / Polymarket position on a game or crypto threshold |
| Floor | long put about 6% below price (OKX listed options) | the opposing side of the same game (cross-venue) or the market's own No |
| Cap | short call about 4% above price; gains above it handed back | a slice of the winning payout above the cap |
| Credit | call minus put minus fees minus the published take; paid at the tap, vests through the cycle | same shape, paid at the tap |
| Tenor | weekly, Friday expiry at least three days out; re-arms | to the event's official settlement |
| Hedge venue | OKX options (FalconX RFQ adapter scaffolded; Deribit and Bullish read as a reference price only, never a hedge venue) | Kalshi, Polymarket, cross-venue matched through a curated resolution whitelist |

**Why a credit exists.** On BTC, skew prices the upside slice richer than the downside floor, and the cap is written closer than the floor. On a binary, selling a slice of the winning payout above the cap funds buying the opposing side below the floor. When the books cannot fund a positive credit, Atticus refuses and says so; refusals are on the record.

**The P&L identity, which is the whole proof.** Both legs are placed at the tap, so on every settled position writer P&L equals the published take, to the cent. The public records print this: perp shadow $548.44 earned = $548.44 booked, gap $0.00 (68 settled, 2026-09-29); event shadow $189.07 = $189.07, gap $0.00 (557 settled, 2026-09-28). The volume-facility record at `facility.atticustrade.com` shows "Atticus option net (hedged) $0" across 127 settled positions, 100% reconciled.

**Doctrine (non-negotiable; it is the product).**
- Refusal-first. No quote when the book cannot fund a credit or settlement parity fails. Zero refusals on the perp book is a fact to be proud of only because the event book shows refusals being counted.
- Receipts. Every credit auditable to a venue fill. Published take, nothing hidden; the credit the user sees is the credit they get.
- Neutrality. Atticus is not a venue and holds no user funds or keys. It sits between the user's position and the hedge books, which is the one thing venues cannot build for each other.
- Append-only ledgers, replay-reconstructed state, integer cents or `Decimal` for money, never float.
- Retail first. The user sees floor, credit, cap and "nothing to manage". Hedge legs, instruments, order ids and rule internals never leave the server (`retailView.ts`, `retailShowcase.ts`); institutions see the same service with `EP_SKIN=institutional`, never a different truth.
- **P&L identity rule (house rule, 2026-09-20).** Any change to who keeps a payoff (a knockout, a release, a take-profit, a handback, a netted balance, a new leg) gets the identity re-derived from scratch for writer, trader and venue at expiry and every early exit, written into the module docstring and its test before it ships. The knockout collar shipped without this and measured negative-EV live; that is the incident the rule comes from.

## 3. The objective

Make one-tap, hedged, paying protection the default feature on every venue where retail holds a position, and run it as a profitable, institutional-grade, flat book.

**Distribution decision (2026-09-20).** The plain collar settles two ways (the cap excess is the floor's premium, due out of the week's gain), and Hyperliquid agent wallets are a one-way rail (Atticus can pay the holder, never be paid). So **the product is exchange-integrated**: it runs on a partner venue's ledger where the cap excess nets from the position's P&L at close, disclosed like funding. Hyperliquid stays the public demo, funnel and shadow record; there the excess is recorded, not collected, and gates the next wrap. Never build a custodial rail, never collect from a trader by message, never run a knockout on Atticus's balance sheet.

**Business model.** B2B2C. The venue embeds the toggle (four JSON endpoints, white-label brand presets, `?brand=` allowlist). Atticus prices, hedges cross-venue and keeps a published share of the credit (25% of the credit on the perp shadow; "about 10%" in older material; the sheet carries the current figure). The venue keeps flow, ledger, relationship and a revenue share. Atticus never earns from the user losing.

**Moat, in the order he says it.** Pricing at the user's size off the live book with honest refusal; the identity audit on every settlement; netting (35% of hedge legs cancel across the perp book, fees and margin fall as it grows); cross-venue matching on the same game; the API-first partner shape; a public append-only record that compounds daily while a competitor starts at zero.

## 4. Company facts

| Item | Status | Where |
|---|---|---|
| Entities | Two. Atticus Trade, Inc. (US) and a Seychelles Ltd company, incorporated through a licensed registered agent with an attorney; certificate of incorporation, certificate of incumbency and the usual corporate documents are on file with the founder. Which entity signs a given venue, lender or depositor agreement is a counsel question, never a design input; ask the founder which one applies before drafting anything that names a party. | founder |
| Funding | Self-funded. Raising a pre-seed of $250k to $400k on a post-money SAFE at a $5M cap (founder, 2026-10-06). Older material saying "$250k to $500k", "$2M seed at $10M cap" or "$4M cap / 20% discount" is superseded; correct it wherever you find it. | `PITCH_STUDY_SHEET.md` §10 |
| Use of funds | hedge margin for the first live cohort, the regulated deployment path for US event venues, two hires (engineer, sales) | same |
| Team | founder plus agents. No employees. | |
| Contact | `michael@atticustrade.com` everywhere (hello@ was not receiving) | PR #203, #202 |
| Pilot history | Foxify: $400k notional, about $11k credits, six weeks, hedged 1:1, zero take by design. Concluded. Never named in customer-facing copy. | historical docs |

## 5. Live surfaces and the branches that feed them

Deploys are on Render and **manual**: after a merge the founder presses "Manual Deploy, latest commit" in the dashboard. A push to a deploy branch is therefore not itself a production change, but treat it as one: whatever is on the tip ships next.

| Surface | What it is | Branch | Render blueprint |
|---|---|---|---|
| `earnandprotect.xyz` | perp retail demo (desktop stage, phone card), `/video`, `/record` and `/prediction` redirects, `/admin/funnel` traffic page | `cursor/hl-toggle-demo-9151` | `render-earn-protect.yaml` (`atticus-earn-protect`, bot worker, Postgres) |
| perp product shadow + track record | hourly retail collar quoted from the OKX book at the demo's exact terms, settled on the HL candle path and OKX prints; runs as a book (flow, early closes, netting, archive-and-reset); public record page; operator report behind `EP_ADMIN_TOKEN` | same | `render-perp-shadow.yaml` (`atticus-earn-protect-shadow`, 1 GB disk) |
| `facility.atticustrade.com` | the older perp volume-facility shadow scorecard (127 settled, 100% reconciled). Still linked as "track record" from `/video`. | `cursor/bullish-fees-hedge-receipt-9151` | `render-integration-shadow.yaml` |
| `event.earnandprotect.xyz` | event embed demo (the front door), `/partner` CTA page, brand presets (ProphetX, Sporttrade), early close at live prices, demo-only undo; `/perps` redirect back to the perp site lands with PR #216 | `cursor/tier2-cross-venue-2bfa` | `render-event-demos.yaml` (`atticus-event-demo-cross-venue`, `atticus-event-demo-btc`, `atticus-pm-clob-egress-proxy`) |
| event shadow + track record | append-only shadow ledger marking simulated positions to official settlements across Kalshi and Polymarket; sports-first record page; CSV and JSON export; alerts | same | same (`atticus-event-shadow`, 1 GB disk) |

**Rules.** Every perp change lands on `cursor/hl-toggle-demo-9151` via a PR based on it. Every event change lands on `cursor/tier2-cross-venue-2bfa` via a PR based on it. `cursor/kalshi-event-demo-2bfa` is historical; never push there. The repo is `github.com/atticusNew/Foxify_Collar` (legacy name). The dozens of other `cursor/*` branches and the open PRs numbered below 160 are the concluded era; ignore them.

## 6. Code map (open only these)

Perp lane, `services/api/`:
- `scripts/creditCollarDemoService.ts`: the HTTP service (quote, preview, wrap, release, close, admin, redirects, funnel).
- `scripts/earnProtectWebAppHtml.ts`: the retail and institutional skins, product switch, desktop stage. `scripts/epVideoPageHtml.ts`: the `/video` page.
- `src/singleSide/twoSided/creditCollar/`: `demoWrap`, `capsConfig` (take, `applyTake`), `capRule`, `floorRule`, `capWatch`, `capRelease`, `lockPolicy`, `creditVesting`, `basisGuard`, `epSafety`, `epVerify`, `epFunnel`, `epOutboundLink` (fail-closed probed cross-links), `epGeofence`, `epBranding`, `retailView`, `execution/` (OKX live runner, `unwindQueue`, venue-truth idempotency), `settlement/`, `store/epStores`, `perpShadow/*` (the book, `venueReference`, operator report), `epMarginMeasure`, `inventoryBalancer`, `epRfqNetting`.
- `scripts/perpShadowWorker.ts`, `scripts/epRehearsal.ts` (`npm --workspace services/api run ep:rehearsal`).
- Tests: `cd services/api && npx tsx --test tests/creditCollar*.test.ts` (675 passing as of the last handoff; run the touched files before every push). The wider `npm test` has pre-existing failures in pilot/IBKR suites that need Postgres or live services; they are not this product.

Event lane, `services/api/`:
- `scripts/eventProtectXDemoService.ts` (Tier 2 board and embed; HTML in `eventProtectXAppHtml.ts`, `eventProtectEmbedHtml.ts`), `scripts/eventProtectDemoService.ts` (Tier 1 crypto), `scripts/eventShadowWorker.ts` (+ `eventShadowHtml.ts`, the record page).
- `src/eventCollar/`: `eventCollarPricer`, `kalshiPublic`, `okxOptionsPublic`, `quoteLedger`, `retailShowcase` (the allow-list for public JSON), `showcasePicker`; `crossVenue/`: `resolutionWhitelist`, `eventMatcher`, `polymarketPublic`, `crossVenuePricer`, `collarSearch`, `kalshiLadder`, `kalshiRfq` and `polymarketRfq` (RFQ mode; no production keys), `hedgeExecutor`, `shadowLedger`, `crossLedger`, `earlyClose`, `minimumCredit`, `openMix`, `shadowAlerts`, `shadowCounterfactuals`, `ledgerArchive`, `eventFunnel`. Builder attribution via `POLYMARKET_BUILDER_CODE`.
- Tests: `tests/eventCollar*.test.ts`.

Docs that are current: `docs/PITCH_STUDY_SHEET.md` (pitch, numbers, objections, market structure, the ask, ProphetX readiness, collateral facility); `docs/REGULATORY_PASSIVITY_MAP.md` (component-by-component discretion inventory for counsel); `docs/VAULT_DESIGN.md` (the vault is a margin pool behind a flat book, not a strategy; phasing from a zero-capital shadow NAV); `docs/EARN_PROTECT_LIVE_RUNBOOK.md` (paper, okx_demo, okx_live, rehearsal); `docs/venue-outreach-tracker.md` and `.csv` (127 venues, reach classes, status; lands with PR #217); `docs/earn-protect-partner-outreach.md` (templates, cadence, investor openers); `docs/RENDER_ENV_REFERENCE.md`; `docs/reports/submission/` (unit economics v2 PDF, White Swan submission).

## 7. What is built, and what stands between the demos and live

**Perp lane.**

| Built and running | Needed for live |
|---|---|
| Pricing at size off the live OKX book, cap rule (target past-cap odds), floor rule, refusal logic | Hedge margin capital: about 10 cents per protected dollar leg for leg, 7 cents netted (OKX simple margin; portfolio margin lower). The raise, or the collateral facility in the sheet §13 ($10k to $50k backs $100k to $500k protected). |
| Execution production-proven on OKX (real fills, ladder unwinds, dust abandonment, venue-truth idempotency); unwind queue for early closes; rehearsal script that drives the holder journey end to end | `okx_live` run only with the founder's explicit in-session confirmation (`EP_REHEARSAL_ALLOW_LIVE`). Run okx_demo until boring first. |
| Retail card, institutional skin, brand presets, geofence (US persons blocked), funnel, cross-links | A partner venue ledger. On Hyperliquid alone the cap excess cannot be collected (one-way rail), so the first live cohort runs where the venue nets it at close. No venue has signed for this yet; ProphetX (events) is the closest. |
| Shadow book since 2026-09-21 with public record and operator report; identity gap $0.00 | FalconX RFQ adapter is scaffolded, not onboarded. OKX fee tier (fees ran twice the take on the shadow) is a negotiation, not code. |
| Alerts and watchdogs (`epSafety`), healthz warm gate | Ops runbook for a funded book: kill switch, capital-drawn dashboard, daily reconciliation against OKX statements (the shadow reconciles; a funded account adds cash timing on sharp up moves, the real residual risk). |

**Event lane.**

| Built and running | Needed for live |
|---|---|
| Dual-route pricer (same-venue No, cross-venue opposing side), resolution whitelist (MLB, NFL, NBA template; college football deferred), event matcher verified both sides, Kalshi ladder, Polymarket CLOB through an egress proxy | DCM participant status as an entity (ProphetX sandbox then production keys; KYC as an LLC). Kalshi and Polymarket US execution credentials with an order signer (RFQ mode exists; production keys do not). |
| Shadow ledger since 2026-09-12: 557 settled, floor paid on 43%, early close at live prices, void handling recorded | Refusal-and-unwind for one-leg fills with a stated time window, live (cross-venue is two fills on two venues; the shadow cannot show the gap because both are simulated). Void and postponement rule per venue pair, written. |
| Embed demo with brand presets, `/partner` CTA, minimum-credit rule server-side, Polymarket builder attribution wired | Counsel on display (does the venue show a "protection" or a partial sale) and on the Atticus posture (section 8). Daily ledger reconciliation against both venues' fills. |
| Capital need at shadow volumes: about $3,500 on Kalshi and $7,500 on Polymarket | Alerting, kill switch, capital dashboard for a funded book. |

None of the live gaps needs new science. All need capital, keys, counsel time and runbooks. The vault (`VAULT_DESIGN.md`) is the capital leg later: phase 0 is a shadow NAV on the record page, costs nothing, and is the artefact every capital conversation asks for.

## 8. Regulatory posture (know it; do not act on it)

- Shadow trading and hedging as principal: no registration. B2B white-label licensing to registered venues: clean. Perps: not a broker, not custodial; protection is written on listed instruments on a regulated derivatives exchange and the user's position never leaves their venue. US persons are geofenced from the perp lane.
- US events: deploy through the venue's CFTC-regulated rails (Kalshi DCM; ProphetX DCM and DCO, approved 2026-06-11; Polymarket US). Atticus does not run a US retail front door. On a DCM the collar is a linear identity (protected payout = (cap minus floor)/100 of the position kept, plus floor and credit in cash), so the user's account sells a fraction of its position into Atticus's hedged bid on the venue's own book and everything clears at the DCO.
- CFTC Staff Letter 26-25 (2026-09-17) gives no-action relief to "passive software providers" (front-ends routing user orders to DCMs/FCMs; may charge fees and revenue share; no signals, no routing discretion). Atticus today is a **principal** (it writes the protection and hedges its own book), so 26-25 may not be the operative frame; `REGULATORY_PASSIVITY_MAP.md` inventories every decision the code makes for counsel. The sentence he says: "the B2B white-label path is clean; the direct-to-consumer path is a counsel question," then stop.
- Vault or collateral facility: a pooled vehicle paying a return is an investment contract regardless of wrapper. Non-US depositors, KYC on entry, one accredited lender on a note before any pool. Same counsel gate.
- Do not redesign around any of this without direction.

## 9. Target clients (who the product is sold to)

Classes, with the one-line pitch per class in `venue-outreach-tracker.md`:
1. **US-regulated event venues (the clean live path):** ProphetX (DCM+DCO, sports, API via marketmaking@; two shadow shapes ready, `?brand=prophetx` exists), Kalshi, Polymarket US, Sporttrade (brand preset exists). Also Hedgestead-style and sportsbook liability hedging as a block product later.
2. **Perp DEXs and HL front-ends (builder-code friendly, non-US):** younger tier first (Pacifica, Bullet, Velocity, Nado, Hibachi, Reya, Avantis, Ethereal), then GRVT, Ostium, Derive (hedge counterparty and distributor at once). HL front-ends: Reflex (`reflex.trade`, co-founder Harsh Hemang Parikh; integration call being scheduled; it is a non-custodial terminal on HL agent wallets, so on HL today it can only surface the record-not-collect lane).
3. **Prediction-market infrastructure and aggregators:** Parity Markets (`tryparity.co`; B2B "prediction markets in a box" for casinos, sportsbooks, neobanks; contacts Marc Hernandez, Jamie Palmer, founder Jacob Goldsmith). Gating question before anything: who is the counterparty on a filled trade; if they are the house, the fit is a regulatory problem, not a product one.
4. **Spot venues, wallets, custodians:** Fireblocks (technical evaluation opened Aug 2026; status to confirm), OKX (Ventures and PM qualification thread, Aug 2026).

Rules: role beats rank; three touches then park; every conversation ends with an ask that costs nothing (a two-week shadow on their book, or one name).

## 10. Target investors and capital

- **Pre-seed (now):** angels and small funds in the crypto-derivatives and prediction-market orbit. Named in the outreach doc: 1kx, Pantera (Cosmo Jiang), Electric Capital, Mantis, Strobe (relationship, their first check is $1M to $3M), angels (McFedries, Hinrikus, Tisch, Garg). Applications: GTMfund (in progress), YC, a16z CSX, Empire State (submitted, do not reopen), ARC Angel, Katana intake.
- **Hedge collateral facility (a lender in place of an angel):** G-20 Group, Keyrock and Flowdesk treasury desks, Bitcoin-native lenders in Robin Obermaier's circle (Liquidium, Zest), Hermetica for how they did it. Rails: Wildcat-shaped segregated market with a named lender. Full treatment in the sheet §13; do not promise 25% on the full facility at the current take share.
- **Vault depositors and distributors (later):** Ground (Stephanie Vaughan, COO; "tokenize the strategy" means wrapping the margin pool as a vault share that platforms like Ground can distribute to fintech balances), vault curators. Only after a published shadow NAV.

## 11. Calendar and live threads (as of 2026-10-06)

- Bankless recording Wednesday 2026-10-07 (questions received; prep lives in chat with the founder, the sheet is the study guide).
- PREDICT conference NYC 2026-10-06 to 07; founder networking.
- Agnese Rozite (51 Alpha, KalshiGirls, Kalshi affiliate) call Friday 2026-10-09.
- Reflex (Harsh) integration call: being scheduled.
- Parity Markets: founder contacting.
- Ground / Stephanie Vaughan: follow-up owed once a shadow NAV exists.
- GTMfund application: being submitted.

Open PRs that matter: #216 (event site Perps link back; merge to tier2 then redeploy `atticus-event-demo-cross-venue` and `atticus-event-shadow`), #217 (venue tracker docs, to hl-toggle), #204 (deck v6 copy, to hl-toggle), #198 (event scan skip; check whether superseded by `c6908c32` already on tier2 before merging). #194 should be closed; #217 replaces it. #215 is merged and deployed on the perp site.

## 12. Numbers to carry (refresh from the live pages before any use)

Perp shadow (since 2026-09-21, as of 2026-09-29): 794 quoted, $29.7M notional, zero refusals, 68 settled, 132 closed early; $31,503 credited to users (10.6 bps of notional), take $7,876; identity gap $0.00; floor 6% out, cap 4.1% out on average, 13 of 68 touched the cap; netting cancels 35% of legs; users' P&L with collar vs without, settled, +$2,183.60.

Event shadow (since 2026-09-12, as of 2026-09-28): 557 settled, 52 open, floor paid on 237 (43%); P&L $189.07 = take $189.07; sports slice 223 settled, 2.89% quoted cost of expected value; 388 hedged on the market's own No, 220 cross-venue.

Volume facility (`facility.atticustrade.com`, as of 2026-09-18): 53 days, 127 settled, 100% reconciled, $0 net option exposure; portfolio-margin netting factor 0.078; capital drag 0.036 bps/day.

Three numbers per product in any room, no more. Offer the record link for the rest.

## 13. Engineering standards and hard rules

- Money is integer cents or `Decimal`. All I/O async; connectors reconnect with backoff. Public endpoints CORS'd; media byte-range-correct.
- `node:test`; new logic ships with tests; run the touched files before pushing. 675 creditCollar tests stay green; eventCollar suites stay green.
- Small single-purpose commits; branch naming `cursor/<description>-<suffix>`; one PR per logical change against the correct deploy branch; the founder merges and deploys by hand.
- Nothing deployed may break. Healthz warm gates and fail-closed links (a cross-link renders only while the sister service answers `/healthz`) are the pattern; keep it.
- Never run `okx_live` or spend real funds without the founder's explicit in-session confirmation. Never commit secrets. Never collect from a trader outside a venue ledger.
- Everything hidden from the retail card is in the operator report and this handoff; dev tools never show more than the card says. That is the transparency standard, not less disclosure.

## 14. Your first reply, then a hard stop

Reply with, in this order, and nothing else:

1. **Summary.** The product in your own words (both lanes, the credit, the identity), the distribution decision and why it exists, the live surfaces and the branch that feeds each, the company's stage (self-funded, pre-seed outreach, shadow records, two demos), and who the founder is in two sentences.
2. **Grades, A to F with one line of reasoning each,** against the objective in section 3: product (does the retail card do the job with nothing to manage), proof (do the records and the identity carry the claim), path to live (how far each lane is from a funded book and what the single biggest blocker is), distribution (is the exchange-integrated shape being sold to the right venues in the right order), capital (is the ask and the collateral facility sized and worded right), regulatory posture (is the principal-vs-front-end question being handled honestly), and code health (from the file map and tests, not a crawl).
3. **Feedback.** What you believe is wrong, stale, or inconsistent in this handoff and in the current sheet, with the evidence.
4. **Suggestions.** A ranked list of at most seven next steps that move the retail protection product toward live, each with the lane, the files it touches, the reason, and what it does not change. Candidates the founder already has in mind: shadow NAV (vault phase 0) on the perp record page; ProphetX sandbox adapter and "their book" shadow; one-leg refusal-and-unwind rule with a stated window; college-football whitelist; Reflex and Parity integration shapes; deck and sheet refresh with October numbers. Form your own view; do not just repeat this list.
5. **Questions** only where the answer changes what you would build, each with your default assumption.

Then wait. The founder will confirm your understanding, correct it, or assign work. Make no changes until he does.
