# Earn & Protect — JSON API

One API for every client. Our web app (`GET /app`) and Telegram bot consume exactly these routes —
a partner integration (builder-code app, Telegram bot, venue frontend) uses the same ones. Base URL
is the service host (default `http://localhost:8788`). `/demo/api/*` is a permanent alias of
`/api/*` (legacy surfaces).

All trader routes are **account-scoped and read-only against the trader's wallet**: pass
`?account=0x…` (a Hyperliquid address). We only read positions from HL's public API; users never
sign, never deposit. Payouts go only to the position-owner address — this is structural, not
policy.

Rate limits (per IP): 120 reads/min, 12 actions/min. `429 { error: "rate_limited" }` when exceeded.

## Trader routes

### `GET /api/positions?account=0x…`

Every open perp position on the account. `wrappable` marks coins protection currently supports.

```json
{ "ok": true, "positions": [ { "coin": "BTC", "side": "long", "szBase": 0.05,
  "entryPx": 64000, "markPx": 64500, "notionalUsdc": 3225, "wrappable": true } ] }
```

### `GET /api/quote?account=0x…`

Indicative pre-wrap quote (probe only; nothing opens, nothing stored). `creditUsdc` is the
trader's net number (the published take is already out); `grossCreditUsdc` and `takeRatePct` make
the split honest. Post-fill, the wrap's realized credit is the only number that matters
(one-number rule).

```json
{ "ok": true, "indicative": true, "creditUsdc": 0.16, "grossCreditUsdc": 0.2,
  "takeRatePct": 0.2, "founding": false, "floorStrike": 67500, "capStrike": 63250,
  "expiryMs": 1787212800000, "coveredBtc": 0.05, "coverageNote": null }
```

### `POST /api/wrap?account=0x…`

Opens protection (both hedge legs, atomic) and arms auto-renew. Send an `Idempotency-Key` header
(or `?idem=`): a retry with the same key replays the original outcome instead of double-wrapping.
Success returns the full wrap record (`wrap.quote.creditUsdc` = the credit, `wrap.vesting`,
`wrap.stages` timeline, `wrap.economics` = the honest gross/take split). Refusals are honest and
specific:

| error | meaning |
|---|---|
| `no_position` | nothing to protect |
| `below_min_lot` | position under one 0.01 BTC OKX lot |
| `wallet_cap` | per-wallet capacity in use this cycle |
| `waitlisted` | founding cohort (50 wallets) full |
| `strike_concentration` | cap strike too crowded (≤30% of book per strike) |
| `listed_credit_nonpositive` … | the market can't fund a positive credit right now |
| `paused` | kill switch — existing wraps still conclude and pay |
| `refused` | guard rail (cooldown, daily quota, book cap, already active) — see `message` |

Positions above the per-wallet cap wrap **partially** (never refused for size); the coverage note
is in `wrap.hedge.sizeNote`.

### `POST /api/close?account=0x…`

Voluntary early close: keeps the vested credit, claws back the rest, unwinds the hedge, disarms
auto-renew. Returns `{ vested: { vestedUsdc, fullCreditUsdc, fraction } }`.

### `GET /api/state?account=0x…`

The account's full view: wraps (with live `vestingStatus`), payout history (`payouts[]` with
status `accrued → queued → paid → confirmed` and `txHash`), protection toggle state, published
caps (`caps`: book/per-wallet/per-strike formulas, cohort fill, take rates), and aggregate book
stats. `?all=1` (whole book) requires the admin token.

### `GET /api/protection?account=0x…`

`{ ok, on }` — the auto-renew toggle state.

### Launch gates (Phase 3)

- `GET /api/geo` — `{ enabled, allowed, country }` for the caller's IP. When the geofence is armed
  (`EP_GEOFENCE=true`), trading ACTIONS from blocked jurisdictions (default `US,CU,IR,KP,SY`) —
  or from unverifiable locations (fail-closed) — return `451 { error: "geo_blocked" }`. Reads stay
  open. Country resolution: trusted proxy header (`cf-ipcountry` / `x-vercel-ip-country` /
  `EP_GEO_HEADER`) → cached IP lookup.
- `GET /api/tos?account=0x…` — `{ required, version, accepted, acceptedVersion }`. When
  `EP_TOS_REQUIRED=true`, wraps refuse with `tos_required` until the CURRENT `EP_TOS_VERSION` is
  accepted (a version bump forces re-acceptance; renewals stop until re-accepted once).
- `POST /api/tos/accept?account=0x…` — records `{ version, acceptedAtMs, country }` for the wallet.
- `GET /tos` — the terms page (version-stamped; DRAFT pending counsel).

### Public live book

- `GET /api/stats` — read-only aggregates, never per-user data: wraps (total/active/expiries/
  knockouts/early closes), notional (open + lifetime, HEDGED), credits paid, capacity
  (book cap, utilization, founding-cohort fill).
- `GET /public` — the live-book dashboard page rendering `/api/stats`.

## Admin routes (require `EP_ADMIN_TOKEN` via `Authorization: Bearer`, `X-Admin-Token`, or `?token=`)

- `POST /api/admin/pause?paused=true|false&reason=…` — kill switch: pauses new wraps + renewals;
  conclusions, knockouts, and payouts keep running.
- `GET /api/admin/status` — stores backend, pause state, open wraps/notional, wallet count, payout
  backlog/failures, loop heartbeats.
- `POST /api/admin/reset` — clears all stores (dev only; gated by `DEMO_ALLOW_RESET`).
- `GET /demo?token=…` — ops control room (HTML).

## Cycle semantics every client must render honestly

- Credit **pays at each 24h cycle's conclusion** (expiry / knockout / early close) — never upfront.
- Knockout (mark touches the cap, no buffer): cycle ends, trader keeps the perp and all gains to
  the cap plus vested credit; protection re-arms at new spot on the next renewal tick while the
  toggle stays on. No trader ever owes anything.
- Refusals carry a human-readable `message` — show it (or the short mapping used by our clients),
  never a generic "error".
