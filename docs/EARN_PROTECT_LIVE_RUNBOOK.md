# Earn & Protect — Live Runbook (paper → okx_demo → okx_live)

**Audience:** the operator flipping the perp collar from the paper lane to real hedge legs.
**Last updated:** 2026-09-20.
**Companions:** `docs/HANDOFF_CURRENT_STATE.md` (hard rules), `render-earn-protect.yaml` (every flag with its meaning), `services/api/scripts/epRehearsal.ts` (the dress rehearsal this runbook calls for).

Hard rule from the handoff, repeated because it governs this whole document: **never run `okx_live` or spend real funds without the founder's explicit in-session confirmation.** Every step below up to and including the `okx_demo` rehearsal spends nothing. The `okx_live` section is a checklist to be executed only after that confirmation.

The product is one shape: a hard floor a few percent under the position and the cap that pays the most for it, the credit paid to the holder, the writer flat leg for leg on OKX. The lane only changes whether the legs are model quotes off the live book (`paper`), real orders in OKX's demo environment (`okx_demo`), or real orders with real money (`okx_live`). The pricing, the rules and the holder's journey are identical on all three; that is what makes the rehearsal meaningful.

---

## 0. What each lane is

| Lane | `DEMO_EXECUTION` | Legs | Money | Purpose |
|---|---|---|---|---|
| paper | `paper` | listed OKX touch quotes, no venue orders | none | the public demo, the shadow track record, UI work |
| okx demo | `okx_demo` | real orders in OKX's demo environment through the production execution path | none (demo balances) | prove the execution path, the unwind queue and the receipts before money |
| okx live | `okx_live` | real orders, real money | yes | the pilot |

The arming chain is the same as the canary's: nothing trades until `LIVE_ENABLED=true`; `okx_live` additionally needs `OKX_EXECUTION_MODE=live` **and** `OKX_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY`. A lane/mode mismatch is a refusal, not a warning (`mode_mismatch`).

---

## 1. Pre-flight (read-only, no orders)

Run in the Render shell for the service (its egress IP is the one whitelisted at OKX):

```bash
# auth, account level, options permission, key scope (trade yes / withdraw NO), funding, fee tier, strike grid
OKX_API_KEY=… OKX_API_SECRET=… OKX_API_PASSPHRASE=… OKX_PROBE_MODE=demo \
  npm --silent --workspace services/api run okx:readiness
```

Every `FAIL` stops here. `WARN` rows are decisions to record, not blockers.

Confirm the flags that must already be right in `render-earn-protect.yaml` (they are the shipped defaults; verify, do not assume):

| Flag | Value | Why |
|---|---|---|
| `EP_CAP_MODE` | `plain` | the collar runs to expiry; knockout was measured negative-EV and stays off |
| `EP_TENOR` | `weekly` | nearest listed Friday at least 3 days out; the credit is real there |
| `EP_CAP_RULE` / `EP_CAP_EXCEED_PROB` | `target` / `0.20` | most credit among caps with ≤20% market-implied odds of finishing beyond |
| `EP_FLOOR_RULE` | `fixed` (6%) until the shadow's Floor depth card says otherwise | the rule is measured before the default moves |
| `EP_OWED_CARRY_CYCLES` | `3` | a cycle that nets negative is recorded, never collected; the next cycles' payouts pay it down first and a new wrap waits only when the balance exceeds 3 cycles of its credit (`0` = any balance gates, the old rule) |
| `EP_BRAND_SETTINGS` | unset (every brand on the instance's settings) | per-brand dials inside published bands: tenor band 3–14 days, cap odds 10–30%, take waiver; the boot log prints each brand's line and any clamped value |
| `EP_UNWIND_QUEUE` | `1` | early closes settle the holder at MTM at once; our legs are worked passive → IOC with receipts |
| `EP_SKIN` | `retail` | non-admin JSON is redacted server-side; the institutional payload is a separate instance |
| `EP_REQUIRE_ACTION_SIG` | forced on for every non-paper lane | owner-only actions; a wallet signs once |
| `DEMO_ALLOWED_ACCOUNTS` | the tester wallets, never `*` before launch | the guard against acting on strangers' addresses |
| `EP_CAPITAL_USDC`, `EP_MARGIN_RATE`, `EP_HEADROOM_PCT` | the sub-account's real numbers | book cap and per-wallet cap are derived from these — a wrong capital figure is a wrong cap |
| `PAYOUT_MODE` | `simulated` until the payout rail is armed separately | the service refuses `arbitrum` on a paper lane; on live lanes it is its own arming chain (`PAYOUT_LIVE_CONFIRM`, `PAYOUT_HOT_WALLET_KEY`, `ARBITRUM_RPC_URL`, `PAYOUT_USDC_ADDRESS`, `PAYOUT_DAILY_CAP_USDC`) |
| `ALERT_WEBHOOK_URL` or `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALERT_CHAT_ID` | set and tested | a leg that will not fill pages the operator; it is never a refusal to the holder |

---

## 2. okx_demo — the dress rehearsal

### 2.1 Configure

On the service (Render → Environment, then restart):

```
DEMO_EXECUTION=okx_demo
LIVE_ENABLED=true
OKX_EXECUTION_MODE=demo
OKX_API_KEY=…  OKX_API_SECRET=…  OKX_API_PASSPHRASE=…      # DEMO-environment keys
EP_UNWIND_QUEUE=1
EP_UNWIND_PASSIVE_MS=600000      # 10 min passive before IOC; shorten to 120000 for the rehearsal if you want a quick loop
DEMO_ALLOWED_ACCOUNTS=0x<tester wallet with an open HL BTC position>
```

Boot log must read `mode OKX_DEMO`, `cap PLAIN`, `floor rule …`, `cap rule …`, and `action signature REQUIRED (… forced on: lane is not paper)`. If it says `PAPER`, the env did not take.

### 2.2 Run the rehearsal

From a shell that can reach the service (Render shell, or locally against a tunnel):

```bash
EP_BASE=https://<service>.onrender.com EP_ADMIN_TOKEN=<EP_ADMIN_TOKEN> \
EP_ACCOUNT=0x<tester wallet> \
EP_REHEARSAL_SIGNER_KEY=0x<that TEST wallet's key — only needed for its first verification> \
  npm --silent --workspace services/api run ep:rehearsal -- --close --settle-owed --timeout-s 900
```

It drives the same HTTP the app and the bot use, and prints a PASS/FAIL line per step:

1. **lane** — reads `/api/admin/status`: lane, cap mode, unwind queue on/off, open wraps. Refuses to continue on `okx_live` without `EP_REHEARSAL_ALLOW_LIVE=I_UNDERSTAND_REAL_MONEY`.
2. **verify** — the wallet's one-time EIP-191 signature over the canonical message (`/api/verify`). Stored server-side; never asked again for this ToS version.
3. **position** — the real Hyperliquid position through the service's own read.
4. **preview** — the terms for that side, sized to what the tap will cover (the per-wallet cap in whole lots), never a bigger number than the wrap delivers.
5. **settle owed** (with `--settle-owed`) — clears a previous cycle's "settled from gains" balance the way the exchange ledger would; without the flag the wrap reports it honestly (`owed_outstanding`).
6. **wrap** — the tap. Real demo-environment legs through the production path: band-capped IOC legs, unwind on partial, receipts.
7. **hedge_locked** — polls `/api/state` until the legs are booked; prints each leg with its **order id** and premium, and the stage timeline.
8. **close** (with `--close`) — protection off. The holder is settled at the collar's book value at once (`closeValue`, source `okx_book` or `okx_fill`), vested credit collected, unvested clawed back.
9. **unwind** — watches the wrap's unwind job to `done` or `failed`, printing every receipt as it lands: `queued` → `passive_rested` / `passive_repriced` / `passive_filled` / `passive_recalled` → `ioc_closed` / `ioc_incomplete` → `done` (or `recycled`, when a new wrap took the legs at the mid), with the realized value and the **execution edge** (realized − MTM: positive means our exit beat the book the holder was settled at).

Exit code 0 only when every step passed.

### 2.3 What "passed" has to look like

- Every leg in step 7 has a **real order id** and `real: true`. Model legs (`(model)` in the instrument, no order id) mean the lane is not what you think.
- The credit on the wrap equals the preview's credit within the book's movement over the few seconds between them (quoted → filled is labeled on the stage timeline when they differ).
- Step 9 ends `done`. A `failed` job is **our** problem by design — the holder was already settled — and means the operator closes the leg by hand at OKX (`npm --silent --workspace services/api run live:unwind`) and records why.
- `/api/admin/status` → `unwindQueue.summary` shows the job with `executionEdgeUsdc` populated. Over many rehearsals this number is the measured value of passive-first over IOC-first.
- The retail app (`/app`) for that wallet showed the card, the floor and the credit, and **nothing else**: no instrument ids, no order ids, no lane name, no gross/take. Open dev tools on `/api/state?account=…` without the admin token and confirm the JSON carries none of them either (`retailView.ts` is the single serializer; `tests/creditCollarRetailView.test.ts` pins the forbidden list).

### 2.4 Repeat until boring

Run the rehearsal at least once in each of: a quiet hour, the US open, and within an hour of the Friday 08:00 UTC expiry (the book thins). Run it once with `EP_UNWIND_PASSIVE_MS=0` to see the pure IOC path and compare the execution edge. Run one **without** `--close` and let the cycle conclude at expiry on its own: the settlement stage and the payout ledger entry (`/api/state` → `payouts`) must appear without anyone touching anything.

---

## 3. okx_live — only after the founder's in-session confirmation

Do not proceed past this line without that confirmation for **this** session.

### 3.1 Arm

```
DEMO_EXECUTION=okx_live
LIVE_ENABLED=true
OKX_EXECUTION_MODE=live
OKX_LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY
OKX_API_KEY=… OKX_API_SECRET=… OKX_API_PASSPHRASE=…        # LIVE keys: trade yes, withdraw NO, IP-whitelisted
LIVE_CANARY_CONTRACTS=1                                        # first day: one 0.01 BTC lot, hard max 5
LIVE_MAX_POSITION_USDC / LIVE_MAX_DAY_NOTIONAL_USDC            # the pilot caps; the derived per-wallet cap stays under them
DEMO_ALLOWED_ACCOUNTS=<the pilot wallets only>
```

Re-run `okx:readiness` with `OKX_PROBE_MODE=live` first. Every `FAIL` stops here.

### 3.2 Canary, then rehearsal

1. `npm --silent --workspace services/api run live:canary -- --side long` with `LIVE_EXECUTION_VENUE=okx` — one tiny collar through the full path, booked, visible, settling at the next fixing.
2. The rehearsal, with the confirmation phrase, `--close` **omitted** the first time:
   ```bash
   EP_REHEARSAL_ALLOW_LIVE=I_UNDERSTAND_REAL_MONEY EP_BASE=… EP_ADMIN_TOKEN=… EP_ACCOUNT=… \
     npm --silent --workspace services/api run ep:rehearsal -- --timeout-s 900
   ```
   Let that cycle run to expiry. Then one **with** `--close` to exercise the live unwind queue on one lot.

### 3.3 Watch

- `/api/admin/status` every few minutes on day one: `paused`, `openWraps`, `payoutBacklog`, `payoutFailures`, `unwindQueue.open`, `capWatch.wraps` (headroom per live wrap; `reserveAlertBps` pages).
- The perp shadow's operator report (`/report?token=…` on the shadow service) keeps quoting the same shape from the same books all week: if its credits and the live wraps' credits drift apart, stop and find out why before the next wrap.
- The Venue reference card on that report says whether OKX's touch is leaving credit on the table against Deribit and Bullish; it is the number a FalconX RFQ has to beat when that lane is built.

### 3.4 Stop

`POST /api/admin/pause?reason=…` with the admin token pauses new wraps and renewals at once; open wraps conclude and pay normally. `DEMO_ENABLED=false` (restart) is the hard kill. Neither touches the hedge legs already on the book; `live:unwind` does that deliberately, one wrap at a time.

---

## 4. Things this runbook deliberately does not do

- It does not collect a "settled from gains" balance from a holder. On Hyperliquid the rail is one-way (we pay out; we cannot debit), so in the standalone demo that balance gates the next wrap until the operator marks it settled. The product settles it as a ledger entry inside the exchange it is embedded in; that is the distribution decision recorded in the handoff, not a gap to paper over here.
- It does not run FalconX. The client and live runner exist (`falconxClient.ts`, `falconxLiveRunner.ts`); the demo service hedges on OKX. When the FalconX lane is wired into the service, this runbook gets a section for it, and the Venue reference card is where its quotes get judged.
- It does not turn on the Arbitrum payout rail. That is its own arming chain with its own confirmation phrase and daily cap.
