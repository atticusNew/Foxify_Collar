# Earn & Protect — Hyperliquid Direct Build (Agent Handoff)

## Read this first — how you must operate

1. Read this document fully. Do not begin by re-exploring the repo; the file map in section 4 is accurate and current. Read only the files listed there when you need them.
2. Before making ANY change, reply to the user with: (a) a short acknowledgment proving you understand the product and the approved decisions in section 3, and (b) a concrete plan for Phase 1 (branch name, files you will create/modify, tests you will add). **Wait for the user's confirmation before doing anything.**
3. Work one phase at a time. At the end of each phase, stop, show evidence (tests passing, demo output), and wait for approval before the next phase.
4. Never commit secrets. Never run anything in `okx_live` mode without the user explicitly confirming in that session. All prior OKX credentials that appeared in past chats are considered burned; the user will supply fresh ones out-of-band (they must rotate keys before launch).
5. Be token-efficient: the engine, quoting, execution, caps, and renewal logic are DONE and TESTED. Do not rewrite or "improve" them. Your job is the delta in section 5.

## 1. What the product is

**Earn & Protect**: a trader holding a perp position on Hyperliquid taps one toggle. Our engine wraps the position in a credit collar using listed BTC options on OKX: buy a put ~6% OTM on the loss side (the floor), sell a call ~1.5% OTM on the profit side (the cap; mirrored for shorts). The sold leg brings in more than the bought leg costs, so the trader RECEIVES a net credit — they are paid to be protected. Every wrap is credit-positive after OKX fees or it is refused with an honest reason. Protection runs 24h and auto-renews while the toggle is on.

This has been executed end-to-end with real money: real Hyperliquid position read, real OKX options fills, credit realized. The proof exists as a demo (Chrome extension overlaying the HL UI + a local service). 

**This build turns the demo into a direct-to-trader product on Hyperliquid** — no venue partnership required. Traders connect a wallet address (READ-ONLY: we only read positions from HL's public API; users never sign, never deposit), toggle protection, and receive USDC credits to their own wallet. We self-fund hedges from our OKX institutional sub-account.

Business context: distribution is dual-track. Track 1 is our own thin web app (canonical surface, demo asset, direct channel). Track 2 (later, not in your scope beyond keeping the API clean and documented) is integrations with Hyperliquid ecosystem frontends (builder-code apps like Dexari/Lootbase/Insilico, Telegram bots like PVP.trade) that bring their own users via rev-share.

## 2. Economics (context for correctness decisions)

- Gross credit sourced: ~10–30 bps of wrapped notional per 24h wrap (volatility-dependent; live fills to date are at the low end due to 1-lot minimums in thin strikes).
- Atticus take: **25% of gross credit** (spread between executable credit and quoted credit). Trader gets the rest.
- Capital: user has an OKX institutional account, onboarded; $10k deposit unlocks portfolio margin (PM) and RFQ. Under PM each wrap consumes ~10–15% of notional as margin → $10k supports a ~$70–100k book, recycling daily.
- Investor (Albert) gets read-only API access to the OKX sub-account. Investor capital never touches our servers or wallets.

## 3. Approved product decisions (do not re-litigate)

1. **Design B — knockout collar.** If mark price touches the cap, protection ends for that cycle: close/settle both OKX legs immediately, mark the wrap `knocked_out`, re-arm at new spot on the next renewal tick (if toggle still on). Trader keeps their perp and all gains to the cap. No trader ever owes us money. Trigger is **mark-price touch of the cap, no buffer**.
2. **Credit is paid at each 24h cycle's conclusion** (expiry, knockout, or early close pro-rata via the existing vesting logic) — NOT upfront. This kills the abuse vector (wrap → collect → instantly close perp). Marketing copy: "credit paid daily."
3. **Spread take: 25% of gross credit**, published honestly ("we keep X% of the credit we source").
4. **Soft-launch caps: 50 wallets (waitlist beyond), $2,500 per-wrap notional cap, $75,000 total book cap** for the first $10k of capital. Plus: auto-pause new wraps above ~60% margin utilization of the OKX sub-account so renewals and breach unwinds always have headroom.
5. Payouts go ONLY to the wallet address that owns the HL position (verified against the position read). The system must be structurally unable to pay a third party.

## 4. What already exists (file map — trust this, don't re-derive)

Branch: everything lives on `cursor/hl-toggle-demo-9151` (pushed). **Branch off it** — it is ahead of main with all demo work.

| Path | Role | Status |
|---|---|---|
| `services/api/src/singleSide/twoSided/creditCollar/demoWrap.ts` | Core wrap domain: `DemoGuardsConfig` (per-wrap cap, wraps/day, cooldown, book notional cap, max active wraps), `DemoWrapRecord` state machine, `assessDemoWrap` guardrails (per-account), `demoPlanStrikes` (side-aware, long+short), `paperLegsFromQuote`, vesting, `concludeAtExpiry`, `renewalDecision`, protection prefs (toggle-as-state). Persistence: JSON files (`DEMO_STORE_PATH`, `DEMO_PROTECTION_STORE_PATH`). | Done, tested |
| `services/api/src/singleSide/twoSided/creditCollar/execution/okxListedTouchQuote.ts` | Listed-lot quoting: `widestExecutableWing` (widest OTM strike with positive executable net credit), role-based bands (funding wing ≥0.5% OTM guard; protective deep), `protectiveTouchUsdc`/`fundingTouchUsdc` exact touch anchors for execution bands, honest refusals (`listed_credit_nonpositive`, `listed_book_empty`, etc.). | Done, tested |
| `services/api/src/singleSide/twoSided/creditCollar/execution/okxLiveRunner.ts` | Live OKX execution adapter: pair atomicity (both legs or unwind), `LIVE_ENFORCE_QUOTE_FLOOR` (fill worse than quote → unwind), touch-anchored slippage bands. | Done, tested |
| `services/api/scripts/creditCollarDemoService.ts` | Demo HTTP service: routes `/demo/api/wrap`, `/demo/api/close`, `/demo/api/state`, `/demo/api/protection`; multi-account book (Stage A), auto-renewal loop (Stage A.5), control-room HTML. Reads HL positions via public HL info API. **No auth, single process, JSON-file state.** | Works; not production |
| `services/api/scripts/okxEgressProxy.ts` + `render-okx-egress-proxy.yaml` | Credential-less OKX relay deployed on Render (Singapore) to satisfy OKX IP whitelist. Service sets `OKX_REST_BASE` to the proxy URL. | Deployed, working |
| `demo/hl-protect-extension/` | Chrome extension overlay on HL UI (the demo/video asset). Keep as-is; not the product surface. | Done |
| `services/api/tests/creditCollarDemoWrap.test.ts`, `creditCollarOkxListedTouchQuote.test.ts`, `creditCollarOkxLiveRunner.test.ts`, `okxEgressProxy.test.ts` | Unit tests for all of the above, including shorts, multi-client, renewal, quote-floor unwind. | Green |
| `docs/earn-protect-spec.md` | Product spec / live record. Update it as you ship. | Current |

Run the demo service: `DEMO_ENABLED=true npx tsx services/api/scripts/creditCollarDemoService.ts` (paper mode by default; `DEMO_EXECUTION=okx_demo|okx_live` for OKX lanes; live additionally requires `LIVE_ENABLED=true OKX_EXECUTION_MODE=live OKX_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY` + OKX creds + `OKX_REST_BASE=<egress proxy URL>`). Tests: `npx tsx --test services/api/tests/<file>` (or the repo's usual test invocation — check `services/api/package.json`).

## 5. What you are building (the delta)

### Phase 1 — Design B knockout + payout rail (engine-side; no capital needed; build & test in paper mode)

- **Knockout monitor**: extend the existing renewal loop in `creditCollarDemoService.ts` / `demoWrap.ts` with a mark-price watcher per active wrap. On cap touch: close/settle both OKX legs (reuse the unwind path in `okxLiveRunner.ts`), set state `knocked_out`, record realized leg P&L, re-arm at new spot on next renewal tick if the protection pref is on. Side-aware (cap is above for longs, below for shorts).
- **Cycle settlement + credit ledger**: at each cycle conclusion (expiry / knockout / early close), compute the trader's payable credit (vested amount; floor payout from the put leg if expired through the floor) and append to a persistent payout ledger with statuses (`accrued → queued → paid → confirmed`, plus `failed/retry`).
- **USDC payout rail**: pay ledger entries to the position-owner's address. Chain: Arbitrum USDC (simplest; HL accounts are EVM addresses). Implement as a small isolated module with a hot-wallet key, per-day outflow cap, and idempotent sends (never double-pay a ledger entry). In paper mode, payouts are simulated entries.
- Gate: unit tests for knockout (touch → legs closed → re-arm), settlement math (long+short), ledger idempotency; a paper-mode wrap demonstrably knocks out and "pays."

### Phase 2 — Production hardening + trader web app

- **Persistence**: move wrap records, protection prefs, payout ledger from JSON files to Postgres (Render Postgres is fine). Migration script for the existing JSON state. On boot, reconcile open wraps against live OKX positions.
- **Auth & safety**: admin auth on the control room; rate limiting; idempotent wrap requests (client-supplied idempotency key); structured logs; alerting on: renewal loop stalled, margin utilization > threshold, payout failures, OKX connectivity loss, any unwind event.
- **Caps**: add global user cap (waitlist beyond 50 wallets) and margin-utilization auto-pause to `DemoGuardsConfig`/`assessDemoWrap`. All caps env-configurable. A single kill switch env/endpoint pauses all new wraps and renewals while leaving conclusions/payouts running.
- **Trader web app** (thin; this is a positions page and a toggle, not a platform): connect/paste wallet address (read-only, no signing) → list HL perp positions → Earn & Protect toggle per position → live wrap card (reuse the state machine + stage feed the extension renders) → history with payout tx links. Quote display follows the existing one-number rule (post-fill, show realized credit only). Honest refusal copy (reuse the human-chip mapping in `demo/hl-protect-extension/content.js`). Brand: Atticus, yellow accent — match `site/index.html`.
- **Partner-ready API**: the web app must consume the same JSON API a partner would (wrap/close/state/protection/quote endpoints + auth). Write a short `docs/earn-protect-api.md` as you go. No partner-specific work beyond cleanliness.
- Gate: 10 whitelisted wallets running concurrent auto-renewing wraps for a week without manual intervention (user will coordinate the live portion).

### Phase 3 — Launch support (user-driven; you support)

- Geofence (block US + sanctioned IPs) and a ToS acceptance step. (User handles legal counsel; you implement the gates.)
- Public live-book dashboard (read-only aggregate stats: wraps, notional, credits paid — no per-user data).
- OKX PM/RFQ: verify both legs margin as a netted spread under PM; add an RFQ path for wraps above a size threshold (crossover sized empirically). This needs the funded account, so it lands here.

### Security requirements (apply throughout)

- OKX trading key: trade-only permission, withdrawals DISABLED. Payout hot wallet is separate and small; top-ups manual or via withdrawal-whitelisted transfer. A full server compromise must at most drain the hot-wallet float.
- Secrets only via environment; nothing in the repo or logs. Payout address is always and only the verified HL position owner.

## 6. Investor context (do not build; background only)

The user is raising ~$10k from an investor (Albert) to fund OKX margin. Framing: at $10k this is a traction play (~$70–100k book, revenue is small), proving live demand that prices the real raise and converts venue conversations to inbound. A separate investor one-pager exists in the conversation history; the user handles it.

## 7. Working agreements

- Branch off `cursor/hl-toggle-demo-9151` (suggested: `hl-direct-phase1-knockout`, then `hl-direct-phase2-app`). Small, logical commits. Push at the end of each work session.
- Every behavior change gets a unit test next to the existing test files. Keep the existing suites green.
- Do not modify the pricer core (`okxListedTouchQuote.ts` selection logic, `okxLiveRunner.ts` execution invariants) except to add hooks — these are proven live and their behavior is load-bearing.
- Customer-facing copy: never name Foxify; tone is honest and specific (real refusal reasons, one-number credit rule, "credit paid daily").
- When in doubt about a product decision not covered in section 3, ask the user — do not guess and build.
