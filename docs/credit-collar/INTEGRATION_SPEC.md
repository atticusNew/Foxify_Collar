# Atticus Venue Integration Spec — Hedged-Position Product

*v0.9 · design-partner draft · live demo of the underlying engine: the public shadow dashboard (`/onesheet`)*

## What integrates with what

Atticus runs the pricing, hedging, and risk lifecycle. The venue (or its bot) exchanges three things with us over an authenticated HTTP API:

1. **Signals (Atticus → venue):** what the day looks like and when positions are live or must close.
2. **Decisions (venue → Atticus):** confirmations and directional calls that belong to the venue/trader, not to us.
3. **Position events (venue → Atticus):** opens/closes on the venue's perp book, so wraps settle correctly.

Transport is poll-first (venue polls our endpoints on its own schedule; webhook push available if preferred). All payloads are JSON. Auth is a per-venue bearer token. Every settlement carries an ECDSA-signed receipt (price, timestamp, outcome) so the history is non-repudiable.

## The product flow (one position, end to end)

1. **Wrap request** — venue submits a position to wrap: `{ ref, side, notionalUsdc, venue, entryPriceUsd }`.
2. **Terms response** — Atticus prices the collar on live options quotes and returns binding terms:

```json
{
  "ref": "cc-...",
  "capStrikeUsd": 64950,
  "floorStrikeUsd": 60175,
  "creditUsdc": 78.40,
  "tenorHours": 24,
  "vesting": "linear over tenor",
  "lockLines": { "ceiling": 64950, "floor": 60175 },
  "expiresAtMs": 1786060000000
}
```

3. **Green light** — once our hedge legs are FILLED at the options venue, the position is live and credit starts vesting:

```json
{ "kind": "green_light", "tsMs": ..., "dayUtc": "2026-08-06",
  "positions": [{ "ref": "cc-...", "side": "long", "notionalUsdc": 50000,
                  "putStrike": 60175, "callStrike": 64950, "creditUsdc": 78.40, "expiresAtMs": ... }] }
```

4. **Life of the position** — the trader keeps their perp. If price touches a lock line, our lock watcher evaluates an early unwind (permitted only when the market cost of closing our hedge fits inside the *unvested* credit — the schedule is never underwater). A permitted unwind emits:

```json
{ "kind": "close_signal", "tsMs": ..., "ref": "cc-...", "side": "long",
  "barrier": "ceiling", "barrierPriceUsd": 64950, "vestedCreditUsdc": 41.20 }
```

The venue closes the perp within the agreed SLA; the trader keeps vested credit.

5. **Expiry settlement** — no touch ⟹ position settles at tenor end: full credit paid, cap gains above the ceiling forfeited (funded by that side's own perp gain), floor protection paid if breached. Settlement receipt is oracle-signed and queryable.

6. **Voluntary close** — if the trader closes the perp early, the venue posts the close event; the wrap concludes with vested credit (mandatory hedge unwind on our side, no charge to the trader).

## Day-level signals (for venues running the paired/principal lane)

One `day_signal` per UTC day states intent by regime — `pair` (calm: matched pair, venue confirms), `directional_proposal` (elevated: venue takes or passes; side is the venue's call, our trend read attached), or `no_open` (halt: sitting out). Decisions post back as:

```json
{ "dayUtc": "2026-08-06", "action": "confirm" | "take" | "pass", "side": "long" | "short" | null }
```

Latest record for a day wins until executed. No decision by window close ⟹ the day is skipped. We never chase and never assume.

## Endpoints (poll transport)

| Method & path | Direction | Purpose |
|---|---|---|
| `GET /v1/signals?sinceMs=` | venue ← Atticus | All signals since cursor (`day_signal`, `green_light`, `close_signal`) |
| `POST /v1/decisions` | venue → Atticus | Day decision (`confirm` / `take` / `pass`) |
| `POST /v1/wraps` | venue → Atticus | Request collar terms for a position |
| `POST /v1/positions/events` | venue → Atticus | Perp opened / closed on the venue |
| `GET /v1/positions/{ref}` | venue ← Atticus | Live status: vesting %, lock-watcher state, terms |
| `GET /v1/settlements/{ref}` | venue ← Atticus | Oracle-signed settlement receipt |
| `GET /v1/health` | venue ← Atticus | Liveness + current regime |

Webhook push (same payloads, venue-supplied HTTPS endpoint + shared secret) available as an alternative to polling — venue's choice at onboarding.

## Risk & guardrails the venue inherits (nothing to build)

- **Regime gate:** trailing + live volatility signal with hysteresis; widens caps in elevated conditions, pauses new opens entirely in halt conditions. Visible live on the public dashboard.
- **Lock watcher:** early unwinds permitted only when hedge buyback cost ≤ unvested credit.
- **Pair atomicity:** in the paired lane, both legs open in one cycle or neither.
- **Collateral ledger + halt rail:** protection issuance halts automatically below the collateral buffer.
- **Full audit trail:** every leg logged, every settlement oracle-signed, leg-by-leg economics on request — the same data that drives the public tape.

## Integration status & what onboarding looks like

The engine, stores, signal/decision flow, pricing, hedge execution (block RFQ + order-book fallback), and risk rails are built and validated — they are what the public shadow has been running around the clock. The HTTP skin over the signal/decision stores is thin and stood up per design partner at pilot start (poll or webhook, venue's call — it's the first onboarding decision). A sandbox pointed at the shadow book is available immediately, so a venue engineer can integrate end to end before any capital moves.

**Onboarding sequence:** transport choice + token issuance → sandbox integration against the shadow (typically the bulk of the work: reading signals, posting one decision, one wrap round-trip) → pilot terms signed → live window opens at pilot size (2 positions/day, $50k max) → scale schedule.

*Contact: [founder] · live tape: facility.atticustrade.com/onesheet*
