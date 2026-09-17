# Atticus — Agent Handoff Prompt

> **You are a new agent picking up an active, production-adjacent codebase.** Read this fully, explore only what it points you to, then STOP and confirm comprehension. Do not make any changes until directed.
>
> **Last updated:** 2026-09-17. Everything before September 2026 in `docs/` (Foxify pilot era, Deribit 1-day/biweekly product) is historical context only — that pilot concluded and is NOT the current product surface.

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
| `cursor/hl-toggle-demo-9151` | **Current working branch.** Perp Protect demo service (`services/api/scripts/creditCollarDemoService.ts`), `/video` page (`epVideoPageHtml.ts` + `assets/hl-toggle-demo.mp4`), funnel tracking (`src/singleSide/twoSided/creditCollar/epFunnel.ts`) | earnandprotect.xyz (Render) |
| `cursor/kalshi-event-demo-2bfa` | Event Protect demo v1 (`eventProtectDemoService.ts`, `src/eventCollar/*`: Kalshi/OKX connectors, pricer, showcase picker, quote ledger) | event demo (Render) |
| `cursor/tier2-cross-venue-2bfa` | Cross-venue Tier 2 (`src/eventCollar/crossVenue/*`: resolution whitelist, event matcher, Polymarket connector, cross-venue pricer, shadow ledger, `eventShadowWorker.ts`) | facility.atticustrade.com shadow tape |

**Key live surfaces:** `earnandprotect.xyz` (perp demo, `/video`, `/public`, `/metrics` funnel), `facility.atticustrade.com` (event shadow scorecard). All on Render; `render-*.yaml` files define services. A healthz warm-gate pattern protects against cold-window swaps.

**Numbers you should know (do not restate without checking freshness):** netting factor 0.078 = portfolio-margin IM vs. sum of isolated IMs on a hedged book; fee = ~10% of the trader credit; event demo EV shown in bps with venue-vs-venue route competition.

## 5. Engineering standards

- Money is integer cents or `Decimal` — never float.
- All I/O async; connectors resilient (reconnection, backoff); public endpoints CORS'd and byte-range-correct where media is served.
- Tests with `node:test`; new logic ships with tests; run the touched test files before pushing.
- **Nothing deployed live may break.** Deployed branches auto-deploy on push — treat every push to a deployed branch as a production deploy.
- Small, single-purpose commits. Branch naming `cursor/<description>-<suffix>` per run instructions.
- No secrets in code, chat, or logs.

## 6. Regulatory context (know it, don't act on it)

- Simulation/shadow trading and hedging as principal: no registration required. B2B licensing to registered venues: clean.
- Direct US B2C event product historically assumed to need Introducing Broker (IB) registration. **CFTC Staff Letter 26-25 (2026-09-17)** extends no-action relief to "passive software providers" — front-ends that let users submit orders directly to registered DCMs/FCMs may avoid IB registration, may charge transaction fees and revenue-share, subject to strict passivity (no buy/sell signals, no routing discretion) and conditions. Atticus's router likely exceeds "passive" as-is; counsel review is the gate. Do not redesign anything around this without direction.

## 7. Your first task — and hard stop

1. Read this file. Skim the branch map above; on each branch read only the files listed in §4 plus their tests. Do NOT crawl the whole repo — most of `docs/` and `src/pilot/` is the concluded Foxify/Deribit era. Do not waste tokens on anything not tied to the objectives in §3.
2. Reply with a comprehension confirmation: (a) the product in your own words, both markets; (b) the doctrine and why refusal/receipts/neutrality are load-bearing; (c) the live surfaces and which branch feeds each; (d) the business objective and current phase (fundraising outreach — code is in support of that, stability over novelty).
3. Suggest a short ranked list of best next steps (candidates the founder already has in mind: NBA/college-football whitelist templates before MLB ends; event-demo hardening; vault design; counsel-gated US B2C lane per §6 — but form your own view).
4. **Then WAIT for direction.** The founder is mid-outreach; next steps are planned and will be assigned. Make zero code changes until told.
