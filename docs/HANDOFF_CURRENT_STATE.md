# ATTICUS / EARN & PROTECT — AGENT HANDOFF (Aug 30, 2026)

Read this in full before acting. It is the single source of truth for product, business, outreach, and current status. The founder (operates as Natalie; legal entity Atticus Trade, Inc.) directs all work.

**FIRST-RESPONSE PROTOCOL (mandatory):**
1. Work happens on branch `cursor/hl-toggle-demo-9151` of `github.com/atticusNew/Foxify_Collar` (production deploys from this branch — never leave it, never force-push).
2. Read, in order: this file → `docs/HL_DIRECT_BUILD_HANDOFF.md` (historical build context; its phases are COMPLETE) → `docs/earn-protect-partner-outreach.md` sections 1.5 and 6.5a–6.5e (locked language) → `docs/earn-protect-spec.md` build records if touching the engine.
3. Reply confirming understanding of: the product mechanics, the honesty rules, the number lock, the current status, and the NEXT TASK spec at the bottom of this file.
4. MAKE NO CHANGES — no edits, no sends, no builds, no deploys — until the founder explicitly confirms you are fully informed and approves the task.

## 1. Product (what it is)

Earn & Protect: one-tap protection for Hyperliquid perp positions. A daily knockout collar behind a toggle: hard floor ~5–6% below spot (buy put), capped upside (sell call), net premium paid to the holder as a DAILY CREDIT. Credit vests through the day, pays automatically at cycle close. Cap touch = cycle concludes (holder keeps position, gains to cap, vested credit), protection re-arms. Read-only: no keys, no deposits; positions read from HL public API; payouts only to the holder's address. When the market can't fund an honest credit, the engine refuses. Revenue: published 20% of credits sourced (10% founding, first 50 wallets). Delta-neutral by construction; Atticus is a fee business, never a prop desk (locked rebuttal: "a prop desk takes risk to make money; we charge a fee to remove it").

## 2. Repo / infra essentials

- Production: https://earnandprotect.xyz — Render service `atticus-earn-protect` (+ `-bot` worker, Postgres), deploys from THIS branch. Render auto-deploy is FLAKY: after pushing, verify the deployed commit; usually needs dashboard "Manual Deploy → latest commit".
- Key paths: service = `services/api/scripts/creditCollarDemoService.ts`; app HTML (web + miniapp, retail + institutional skins) = `services/api/scripts/earnProtectWebAppHtml.ts`; domain modules = `services/api/src/singleSide/twoSided/creditCollar/` (demoWrap, capsConfig, epSafety, epVerify, epFunnel, epShowcase, epGeofence, epBranding, settlement/, execution/, store/epStores).
- Tests: `cd services/api && npx tsx --test tests/creditCollar*.test.ts` — 561 passing. Keep green.
- Skins: `EP_SKIN=institutional` for partner demos; retail default. White-label branding: `EP_BRAND_FOR`/`EP_BRAND_LINE` env + per-link `?brand=` override gated by `EP_BRAND_ALLOWLIST` (fail-closed).
- Execution: OKX production-proven (live fills, ladder unwinds, dust abandonment, venue-truth idempotency). FalconX adapter scaffolded. NOT onboarded with Deribit/Bybit — never propose them.
- Shadow facility (separate system) = the audited track record; scorecard refreshes — always use the LATEST numbers, current lock below.

## 3. Hard rules

- NEVER run okx_live or spend real funds without founder's explicit in-session confirmation. Never commit secrets.
- Honesty is the brand: MEASURED vs ESTIMATE labeled; shadow results never "revenue"; no "guaranteed"/"risk-free"; the cap tradeoff volunteered; every public number checkable.
- LIVE-LANGUAGE RULE: never claim what a click can falsify. Software is "in production"; execution is "production-proven on OKX (real fills)"; the hedge book "activates at first close — that's what the raise funds". "Live" only for live pricing/positions/demo.
- Never name Foxify in customer-facing copy (first pilot partner stays unnamed). US persons geofenced. Never leak private threads (incl. an HL co-founder DM thread). No em dashes in founder-facing PDFs/reports. Copy grammar: "address", never "wallet" (for the public-data thing being pasted).

## 4. Number lock (Aug 31 scorecard — use everywhere, refresh from scorecard before big sends)

38 days · 97 settled · $4.85M notional · client all-in +4.9 bps · 82% days positive · 100% oracle-verified/reconciled · zero peak net exposure · 1 of 102 opens refused (not priceable) · capital drag 0.036 bps/day vs ~1.7 bps/day production fee. Pilot: ~$11k credits on $400k notional, 6 weeks, zero take by design. Raise: pre-seed up to $250k, post-money SAFE $4M cap / 20% discount, first close now; $25k = collateral minimum (~$125k book standard margin, $400k+ under PM, ~0.08 measured netting factor, max exposure ~$2.3k). Regime gate may be in HALT during trends — a quiet dashboard IS the discipline exhibit; say so.

## 5. Current status (Aug 30)

- FIREBLOCKS (hottest): one-sheet + client-profile PDFs + demo delivered ahead of the Friday deadline; they replied "will review and get back" (Aug 27). Awaiting. Execution plan of record: OKX + FalconX. Institutional demo skin exists; `institutions.earnandprotect.xyz` deployment status should be verified before any send referencing it.
- OKX: they asked qualifying questions; reply sent (Ventures ask = round + deployment ladder, PM qualification path, $25k minimum flexibility). Awaiting. Number lock applies.
- Raise: v2 assertive outreach live (playbook 6.5e): core/DM/web-form/Pantera-Cosmo/Mantis/Electric-Capital variants; angel triage done (McFedries, Hinrikus, Tisch, Avichal = work; Tan→YC app, Dixon→CSX, Collison one-shot, Naval→AngelList). Kraken market-signal citations locked (playbook 1.5). Receipts thread spec'd (6.5e) — may not be posted yet.
- Traction: strong impressions/views from LinkedIn ("I'll have what she's having" post) but LOW address-paste conversion — the motivation for the NEXT TASK below. Funnel tracking exists (`/api/admin/status`, lookers vs page loads).
- App: Aug 29 design sprint shipped on the retail skin — demonstration toggle in whale/preview (poll-safe), intro trio (Floor/Credit/Cap staccato), empty owner sections hidden pre-connect, hero credit typography, thin-market note (<2 bps/day), staccato copy register, SIMULATED badge scoped out of watch mode. Verify production runs the latest commit.
- Grants/apps: Empire State submitted (do NOT reopen to edit). ARC Angel Fund answers drafted (chat). Katana intake submitted. YC application recommended, may be pending.

## 6. Stale / superseded — do not trust without checking

- `docs/HL_DIRECT_BUILD_HANDOFF.md`: build phases COMPLETE; operating rules still valid; plan content historical.
- Investor deck PDF (July 2026, lives outside repo): known-bad items flagged Aug 29 — "$50M/day committed volume", "$1M bridge / signed commitments" ask, CME logo, 13x capital-efficiency claim, old team/date. Founder is revising; never quote the old deck.
- `docs/earn-protect-unit-economics.md`: superseded by `atticus_unit_economics_v2.pdf` in `docs/reports/submission/`.
- Fireblocks one-sheet/client-profile PDFs: numbers correct AS OF their send date (35d/89/$4.45M); regenerate with current lock before any NEW recipient.
- Any doc mentioning Deribit/Bybit paths or a bare "$25k ask to funds": superseded (see number lock).
- Scorecard stats anywhere: check date; refresh from the live scorecard before sends.

## 7. NEXT TASK (spec'd, NOT approved — do not build until founder confirms)

**Retail app UI/UX rebuild: from demo to live-replica.** Diagnosis: high traffic, near-zero address pastes — the surface reads as a brochure. Goal: the visitor lands INSIDE the operating product, as close as possible to how it looks/functions live or embedded.

Requirements (founder-stated, refine with her before building):
1. Land operating: a public (showcase) address prefilled and loaded on arrival — positions rendered, live pricing ticking. No empty entry gate.
2. Wallet chrome upper-right, dApp-standard "Connect" placement — but opening the address-paste flow (public data, no signing). Swapping to the visitor's own address is the conversion action.
3. Toggles rendered against the BTC perp position cards, exactly as the live product.
4. Flipping the toggle on the prefilled account runs a SIMULATION LANE: full lifecycle visuals (quote → executing → active → vesting) fed by real live pricing, never touching the real wrap path (server guards on showcase wallets stay). One quiet persistent honesty label ("simulation · live pricing").
5. Mobile-first (traffic is X/LinkedIn = phones); design at 390px, expand up.
6. Success metric: address-paste rate per visitor (funnel already instruments this). Baseline before, measure after.
7. All honesty rules and the live-language rule apply to every string.

Constraints: institutional skin untouched; 561 tests stay green; real wrap path and server guards unchanged; commit+push per working session; production deploy only when founder says.
