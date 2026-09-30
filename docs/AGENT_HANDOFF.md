# Atticus — Agent Handoff Prompt

> **You are a new agent picking up an active, production-adjacent codebase.** Read this fully, explore only what it points you to, then STOP and confirm comprehension. Do not make any changes until directed.
>
> **Last updated:** 2026-09-18. Everything before September 2026 in `docs/` (Foxify pilot era, Deribit 1-day/biweekly product) is historical context only — that pilot concluded and is NOT the current product surface.

---

## 1. Who you need to be

Operate as a single agent with these combined competencies. Do not perform work outside them without direction.

- **Senior full-stack TypeScript/Node engineer** — Node HTTP services, no-framework HTML surfaces, React/Vite, PostgreSQL, `node:test`, Render deploys. Production discipline: zero-downtime swaps, health gates, append-only state.
- **Derivatives structurer** — collars, put verticals, digital replication with listed options, portfolio margin and netting, IM/MM mechanics, execution quality, unwind vs. final-terms doctrine.
- **Quant** — EV in bps, spread/liquidity-aware pricing off live order books, refusal-first quoting, calibration against settlement outcomes, integer-cents / `Decimal` arithmetic (NEVER float for money).
- **Market-microstructure literate** — Kalshi/Polymarket CLOBs, Hyperliquid perps, OKX options, cross-venue settlement-parity risk (why approximate event matches are fatal).
- **Regulatory-aware (US derivatives)** — DCM/FCM/IB/AP registration categories, CFTC no-action posture (Staff Letters 26-09 and 26-25 on "passive software providers"), why the B2B white-label path is clean and where B2C lines are.
- **Security-conscious** — founder has been targeted by infostealer malware via fake investor meetings. Never ask for or echo tokens/PATs/keys in chat; never weaken the "no secrets in repo" posture.

## 2. What Atticus is

**One sentence:** Atticus is the neutral defined-outcome ("protection") layer that sits above trading venues — one tap gives any position a hard floor and a credit, hedged at the cheapest venue, with every cost printed on an auditable receipt, and the router refuses any trade where the math doesn't clear.

**Two markets, one engine:**

1. **Perps (live rails):** a credit collar on Hyperliquid positions. Sell the trader's upside cap, buy the downside floor, hand the trader the net credit daily. Live demo is a Chrome extension over real Hyperliquid positions; embedded venue-side it is the same 4-endpoint JSON API → one white-label toggle.
2. **Event contracts (live cross-venue demo):** the same defined-outcome engine pointed at Kalshi + Polymarket. A dual-route router prices the protective leg on both venues, quotes only when both venues verifiably settle on identical terms (curated resolution whitelist: MLB + NFL winner markets; crypto via listed-derivatives Tier 1 path), and an append-only shadow ledger marks simulated positions to official settlements.

**Doctrine (non-negotiable, it IS the product):**
- Refusal-first: no quote when books can't fund a positive credit or resolution parity fails. Refusals are shown, not hidden.
- Receipts: every credit auditable to an exchange fill; compressed, published pricing where structurers hide margin.
- Neutrality: Atticus is not a venue. It is venue-agnostic and quotes across venues — the thing venues cannot build for each other.
- Append-only ledgers, replay-reconstructed state, never mutate in place.
- Glance-layer UI with disclosure-layer honesty (relocate caveats, never delete them).

## 3. Company objective

- **Business model:** B2B white-label licensing to venues (venues embed the toggle; Atticus prices, hedges cross-venue, takes ~10% of the credit) + B2C wedge apps on Hyperliquid/Katana via builder codes (non-US) to prove demand and generate revenue ahead of venue embeds. Roadmap: protection-writing vault as the on-chain capital leg.
- **Why now:** venues are racing from spot to derivatives (DraftKings' $250M Railbird acquisition; Kalshi/Coinbase/Bitnomial Form 1-Ns; SGX perps CFTC filing; Polymarket US via QCEX). All build spot; none can be the neutral protection layer.
- **Funding status:** raising a $2M seed at a $10M cap ($250K first-close tranche in motion). Founder is mid-outreach (1kx and other funds, angels, venue leads). Materials: pitch deck, live demos, 28-second toggle video.
- **Ultimate goal:** make the one-tap collar / defined-outcome layer ubiquitous across exchanges and venues, and profitable — institutional-grade, production-ready, highest possible performance.

## 4. Current status & repo map

**Repo:** `github.com/atticusNew/Foxify_Collar` (name is legacy; the Foxify pilot is over).

| Branch | What lives there | Deployed |
|---|---|---|
| `cursor/hl-toggle-demo-9151` | **Current working branch (docs + perp demo).** Perp Protect demo service (`services/api/scripts/creditCollarDemoService.ts`), `/video` page (`epVideoPageHtml.ts` + `assets/hl-toggle-demo.mp4`), funnel tracking (`src/singleSide/twoSided/creditCollar/epFunnel.ts`), perp product shadow (`scripts/perpShadowWorker.ts` + `src/singleSide/twoSided/creditCollar/perpShadow/*`: the retail collar quoted hourly from the OKX book at the demo's exact terms, settled on the Hyperliquid candle PATH and OKX delivery prints under `EP_CAP_MODE` — `plain` (default: the collar runs to expiry, gains above the cap handed back, a touch is recorded with the release it would have cost, writer flat) or `knockout` (touch ends the cycle; the old rule, replayed from the same append-only ledger) — with cap-distance-ladder / fee-rule / size / other-tenor counterfactuals per quote; weekly is the live tenor, the daily the counterfactual), cap watch (`src/singleSide/twoSided/creditCollar/capWatch.ts`: prices the cap leg live per wrap — the holder's release quote in plain mode, the writer's margin reserve + flag-guarded pre-touch working order in knockout mode), cap release (`capRelease.ts`: `POST /api/release` buys the cap leg back on OKX at the ask for the holder, partial fills booked; `cyclePayable` nets cap excess / release cost / early-close MTM and books a negative total as OWED on the record, which gates new protection until `/api/admin/owed/settle`) | earnandprotect.xyz via `render-earn-protect.yaml` (service `atticus-earn-protect` + bot worker + Postgres); perp shadow via `render-perp-shadow.yaml` (service `atticus-earn-protect-shadow`, 1 GB disk, operator views behind `EP_ADMIN_TOKEN`) |
| `cursor/tier2-cross-venue-2bfa` | **The single event-stack branch.** Tier 1 (`eventProtectDemoService.ts`, `src/eventCollar/*`) AND Tier 2 (`eventProtectXDemoService.ts`, `src/eventCollar/crossVenue/*`: resolution whitelist, event matcher, Polymarket connector, cross-venue + Kalshi-ladder pricers, quote ledgers, shadow ledger, `eventShadowWorker.ts`) | all four event services via `render-event-demos.yaml`: `atticus-event-demo-btc` (Tier 1), `atticus-event-demo-cross-venue` (Tier 2 board), `atticus-event-shadow` (event shadow record, 1 GB disk), `atticus-pm-clob-egress-proxy` |
| `cursor/kalshi-event-demo-2bfa` | Event Protect v1 lineage. Historical only: `render-event-demos.yaml` deploys the Tier 1 demo from the tier2 branch, not from here. **Do not land fixes here.** | nothing |
| `cursor/bullish-fees-hedge-receipt-9151` | Perp volume-facility shadow runner (`src/singleSide/twoSided/creditCollar/shadowRunner.ts` + `shadowDashboard.ts`) | facility.atticustrade.com via `render-integration-shadow.yaml` (service `atticus-product-shadow`); founder to confirm the domain mapping in the Render dashboard |

**Key live surfaces:** `earnandprotect.xyz` (perp demo, `/video`, `/public`, `/metrics` funnel), `facility.atticustrade.com` (**perp** volume-facility shadow scorecard: 53 days / 127 settled / 100% reconciled as of 2026-09-18; the `/video` page's "track record" CTA points here), the event shadow record (`atticus-event-shadow` on Render, `/`, `/api/shadow`, `/api/shadow/export`). All on Render; `render-*.yaml` files define services. A healthz warm-gate pattern protects against cold-window swaps.

**Deploys are manual.** The blueprints say `autoDeploy: true` but the founder deploys by hand from the Render dashboard ("Manual Deploy → latest commit") after merging; auto-deploy has been unreliable. A push to a deployed branch is therefore not itself a production change, but treat it as one anyway: whatever is on the branch tip is what the next manual deploy ships.

**Event-stack rule (decided 2026-09-18):** every event change lands on `cursor/tier2-cross-venue-2bfa` via a PR based on it. Its `eventCollar` tree is a strict superset of the kalshi branch's. Do not push to `cursor/kalshi-event-demo-2bfa`.

**Numbers you should know (do not restate without checking freshness):** netting factor 0.078 = portfolio-margin IM vs. sum of isolated IMs on a hedged book; fee = ~10% of the trader credit; event demo EV shown in bps with venue-vs-venue route competition.

**Open PRs / recent work (2026-09-18):**

| PR | Base | What | Status |
|---|---|---|---|
| #167 | tier2 | Event matcher: verify both sides against canonical club names, next-day slug + ET-date guard, Kalshi `WAS`/`JAC`; **NBA whitelist template**. Live probe showed the Polymarket NFL route paired 0/32 games before, 32/32 after; MLB unchanged 50/50. NBA pairs once Polymarket lists the Oct 20 games. | open, awaiting merge + manual redeploy of `atticus-event-demo-cross-venue` and `atticus-event-shadow` |
| #168 | tier2 | Event shadow worker: `GET /api/shadow/export` (raw JSONL, mirror off-box), operator alerts (`EVENT_SHADOW_ALERT_*`, Telegram/webhook, deduped, off by default), richer `/healthz`. | open, awaiting merge + manual redeploy of `atticus-event-shadow` |
| #169 | hl-toggle | `docs/VAULT_DESIGN.md`: the vault is a margin pool behind a flat book, not an options-writing strategy; waterfall, risk table, three shapes, phasing from a zero-capital shadow NAV. | open |
| #170 | hl-toggle | `docs/REGULATORY_PASSIVITY_MAP.md`: component-by-component discretion inventory for counsel; Atticus is a principal, so Letter 26-25 may not be the operative frame. | open |
| (this PR) | hl-toggle | This branch-map correction (facility = perp shadow, event stack = tier2 only, fourth deployed branch named) and the manual-deploy note. | open |

Known, not yet done: college football whitelist (deliberately deferred: 130+ schools, inconsistent Polymarket slugs, neutral sites); mirroring the event shadow ledger off Render on a schedule (the export endpoint exists, the cron does not).

## 5. Engineering standards

- Money is integer cents or `Decimal` — never float.
- **P&L identity rule (founder, 2026-09-20).** Any time a structure changes WHO KEEPS A PAYOFF (a knockout, a release, a take-profit at the cap, a capped handback, a netted balance, a new leg), the P&L identity is re-derived from scratch — writer, trader, venue, every state at expiry and at every early exit — and written into the module docstring and its test BEFORE anything ships. No inventory, diversification or re-arm argument substitutes for the derivation: an option sold for nothing stays sold for nothing. The knockout collar shipped without this and was measured negative-EV live; that is the incident this rule comes from.
- All I/O async; connectors resilient (reconnection, backoff); public endpoints CORS'd and byte-range-correct where media is served.
- Tests with `node:test`; new logic ships with tests; run the touched test files before pushing.
- **Nothing deployed live may break.** Deployed branches auto-deploy on push — treat every push to a deployed branch as a production deploy.
- Small, single-purpose commits. Branch naming `cursor/<description>-<suffix>` per run instructions.
- No secrets in code, chat, or logs.
- **Pitch study sheet is a living document (founder, 2026-09-29).** `docs/PITCH_STUDY_SHEET.md` holds the elevator pitch, numbers, objections and answers, defensibility, market-structure notes and the ask. Whenever a public-record number moves materially, a venue or regulator does something that changes an answer, a real conversation surfaces a question it does not cover, or an answer proves wrong, update the sheet (with a dated changelog line) in the same PR as the related work, or in its own PR if there is none.

## 6. Regulatory context (know it, don't act on it)

- Simulation/shadow trading and hedging as principal: no registration required. B2B licensing to registered venues: clean.
- Direct US B2C event product historically assumed to need Introducing Broker (IB) registration. **CFTC Staff Letter 26-25 (2026-09-17)** extends no-action relief to "passive software providers" — front-ends that let users submit orders directly to registered DCMs/FCMs may avoid IB registration, may charge transaction fees and revenue-share, subject to strict passivity (no buy/sell signals, no routing discretion) and conditions. Atticus's router likely exceeds "passive" as-is; counsel review is the gate. Do not redesign anything around this without direction.

## 7. Your first task — and hard stop

1. Read this file. Skim the branch map above; on each branch read only the files listed in §4 plus their tests. Do NOT crawl the whole repo — most of `docs/` and `src/pilot/` is the concluded Foxify/Deribit era. Do not waste tokens on anything not tied to the objectives in §3.
2. Reply with a comprehension confirmation: (a) the product in your own words, both markets; (b) the doctrine and why refusal/receipts/neutrality are load-bearing; (c) the live surfaces and which branch feeds each; (d) the business objective and current phase (fundraising outreach — code is in support of that, stability over novelty).
3. Suggest a short ranked list of best next steps (candidates the founder already has in mind: NBA/college-football whitelist templates before MLB ends; event-demo hardening; vault design; counsel-gated US B2C lane per §6 — but form your own view).
4. **Then WAIT for direction.** The founder is mid-outreach; next steps are planned and will be assigned. Make zero code changes until told.
