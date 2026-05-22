# Volume Cover — Spread Hedge Design (Track 2)

**Status:** scaffolding (2026-05-22)
**Scope:** initial cell = `50k_2pct_1k` only; test cell = `1k_2pct_20`
**Branch:** `vc-sandbox-spreads` (off `vc-sandbox`)

## 1. Why we're moving off TIGHT strangles

The current live hedge is a TIGHT strangle (long put + long call, both inside
trigger). Probe of all 6 production cells at low IV (2026-05-22) showed:

| Cell | Strangle SA P&L per pair |
|---|---|
| 50k_2pct_1k | **+$50** (marginal) |
| 30k_2pct_600 | ~breakeven |
| 50k_5pct_2_5k | **−$570** |
| 50k_10pct_5k | **−$1,100** |
| 200k_5pct_10k | **−$1,400** |
| 200k_10pct_20k | **−$1,900** |
| 200k_15pct_30k | **−$2,400** |

The strangle pays for unbounded upside that we don't need (our liability is
capped at `payoutUsdc`). A vertical spread caps upside to match payout, so we
sell off the excess premium we'd otherwise overpay for.

Bullish probe v2 (same date) confirms the [DB] TIGHT-spread on 50k_2pct_1k
costs **$310 vs $1,300** for the current strangle — a 76% reduction, with
capacity for 5-10 concurrent pairs on current Bullish liquidity.

## 2. Design [DB] — TIGHT-spread (selected)

Each "pair" = 4 option legs:

```
                    spot ($S)
   ┌─ trigger_low ──────────┼──────────── trigger_high ─┐
   │                        │                            │
   ▼                        │                            ▼
short put ◄── long put ◄── spot ── long call ──► short call
  ($K1)         ($K2)               ($K3)         ($K4)

K2 = closest strike inside trigger on put side       (long, debit)
K1 = K2 − spreadWidthUsdc (past trigger boundary)   (short, credit)
K3 = closest strike inside trigger on call side      (long, debit)
K4 = K3 + spreadWidthUsdc (past trigger boundary)   (short, credit)

Net structure per pair: bear put spread (K2-K1) + bull call spread (K3-K4)
Max payout side: (K2 − K1) per BTC contract on the put side at trigger
                 (K4 − K3) per BTC contract on the call side at trigger
Capital efficiency: payout matches contracts × (K2-K1) at trigger, NOT
                    contracts × K2 like a naked long.
```

### Why [DB] (TIGHT-spread) over [DA] (trigger-aligned spread)

The probe ran both. [DA] places long legs AT the trigger boundary (zero
intrinsic at trigger); [DB] places long legs INSIDE trigger (real intrinsic
already at trigger). At the instant of trigger:

| Property | [DA] trigger-aligned | [DB] TIGHT-spread |
|---|---|---|
| Cost | lowest (~95% savings) | low (~75% savings) |
| Salvage if trigger fires near boundary | $0 intrinsic | $200-400 intrinsic per BTC |
| Salvage if trigger fires deep | full spread width | full spread width |
| Robustness to slow drift past trigger | poor — can be ≤0 even at trigger | strong — already ITM |
| EV at low trigger rates | slightly higher | slightly lower |

The Atticus pilot data so far suggests Foxify positions trigger near the
boundary more often than deep, and the salvage-recovery story is more
important than absolute cost. [DB] wins on robustness; [DA] wins on
absolute EV at low trigger rates only.

We can re-evaluate after 10+ real triggers if data flips that ranking.

## 3. Cell-level parameters

Add a new field `spreadWidthUsdc` to `CellDefinition` (matrix.ts):

| Cell | hedgePct | triggerPct | spreadWidthUsdc | Width / payout |
|---|---|---|---|---|
| 50k_2pct_1k | 1% | 2% | $2,000 | 2× payout |
| 50k_5pct_2_5k | 3% | 5% | $4,000 | 1.6× payout |
| 50k_10pct_5k | 5% | 10% | $8,000 | 1.6× payout |
| 200k_5pct_10k | 3% | 5% | $4,000 | 0.4× payout — needs review |
| 200k_10pct_20k | 5% | 10% | $8,000 | 0.4× payout — needs review |
| 200k_15pct_30k | 7% | 15% | $12,000 | 0.4× payout — needs review |
| 1k_2pct_20 | 1% | 2% | $2,000 | (test cell — same shape) |

Width policy for 2% cells: `spreadWidthUsdc = spot × triggerPct`. Past-trigger
buffer = (spread width − hedge offset from spot) = ~$1,000 at spot $75k.

Width policy for wider cells (≥5%): width is just past trigger boundary
plus a buffer. Sizing-to-payout becomes harder as spread width grows; we
may need to add a separate `spreadContractsPolicy` field. Deferred.

## 4. Hedge sizing for [DB]

For a put-side debit spread (long $K2 + short $K1, $K2 > $K1):

```
max_payoff_at_expiry_per_BTC = K2 − K1                  (when spot ≤ K1)
max_payoff_at_trigger_per_BTC ≈ K2 − spot_at_trigger   (intrinsic only)
                              = K2 − triggerLow         (at trigger)
                              ≈ hedgePct × spot         (TIGHT design)
```

Sizing for full payout coverage at trigger:
```
contracts_BTC = payoutUsdc / max_payoff_at_trigger_per_BTC
              = payoutUsdc / (K2 − triggerLow)
```

For 50k_2pct_1k at spot $76k: max_payoff_at_trigger ≈ $760/BTC, payout = $1,000
→ contracts ≈ 1.32 BTC. Round to 1.3 BTC.

But Bullish $1k strike grid: K2=$75k, triggerLow=$74,440 → max_payoff = $560.
→ contracts ≈ 1.79 BTC. Higher than the strangle baseline (0.65 BTC) because
   the spread relies on intrinsic-only at trigger (no extrinsic value left).

Round to 1.8 BTC. At Bullish probe spread debit $620/BTC:
   `1.8 × $620 = $1,116` total hedge cost.

That's MORE than the Deribit strangle baseline ($1,300 with sizing). Wait —
this contradicts the v2 probe summary that said $310. The probe summary
used 0.5 BTC contracts (a naive width-only sizing). Proper sizing for
intrinsic-at-trigger payout coverage gives 1.8 BTC.

**This sizing question is the most important Track 2 decision.** Three options:

1. **Intrinsic-only sizing (1.8 BTC):** Full coverage at trigger from intrinsic
   alone. Cost ~$1,116. Still 14% cheaper than current strangle ($1,300).
2. **Extrinsic-credit sizing (1.3 BTC):** Assume short-leg extrinsic is also
   collected at trigger (we close the spread, not let it expire). Cost ~$806.
   Reliant on bid-side liquidity at close.
3. **Hybrid (1.5 BTC):** 1.5× the intrinsic-payoff floor; absorbs some
   short-leg extrinsic credit but doesn't fully count on it.

We'll model all three in the spreadHedge.ts sizing helper and pick via env
flag for initial shadow runs.

## 5. Venue routing

Per user direction 2026-05-22: **Bullish primary, Deribit fallback**.

```
resolveSpreadVenue(cellId, spreadDesign) returns:
  primary: "bullish"  // cheaper, better cap-matching
  fallback: "deribit" // proven execution, deeper liquidity

Routing logic:
  1. Try Bullish first
  2. If Bullish returns RATE_LIMIT_EXCEEDED / MAX_SESSION / strike not listed
     → log + emit metric + fall back to Deribit
  3. If Deribit also fails → record activation_failed with venue_unavailable

Per-cell override via env:
  VC_SPREAD_VENUE_50k_2pct_1k=bullish      (primary)
  VC_SPREAD_VENUE_FALLBACK_50k_2pct_1k=deribit
```

The fallback IS NOT atomic — once we start placing legs on a venue we MUST
complete all 4 legs on that venue. The venue selection happens BEFORE the
first leg.

## 6. TP curve adaptation for spreads

The current TP curve (12 rules in `volumeCoverHedgeManager.ts`) operates on
individual retained legs. With spreads, a "leg" is really a spread group:

```
spread_group_id (new column on volume_cover_hedge_legs):
  - All 4 legs of one spread share the same group_id
  - TP rules operate on the GROUP, not individual legs
  - Closing a spread = closing both legs (long + short) of the same side
```

TP rule adaptations (initial proposal — to be refined):

- Rule 1 (time decay): triggers if any leg has < 4h to expiry → close ENTIRE
  spread group (all 4 legs) at market
- Rule 5/6/10/11 (discretionary): act on the NET value of the spread group
  (long mid - short mid), not individual leg values
- Rule 7 (loser leg grace exit post-trigger): for spreads, the "loser" is the
  opposite-side spread group (e.g., put-spread after upside trigger). Close
  both legs of that group.
- Rule 12 (hard floor): based on net spread group value, not individual leg

Slippage floor (Layer 1/2 routing, just added in PR #138) needs analogous
treatment for spreads: use net BS theoretical value of the group as the
floor for limit IOC orders. Deribit-only initially; add Bullish via the
slippage-venues allowlist after Phase E3 validation.

## 7. Database schema changes

```sql
ALTER TABLE volume_cover_hedge_legs
  ADD COLUMN spread_group_id TEXT;  -- nullable; null for strangle legs

CREATE INDEX idx_vchl_spread_group_id
  ON volume_cover_hedge_legs (spread_group_id)
  WHERE spread_group_id IS NOT NULL;
```

Migration is additive + backward-compatible. Existing strangle legs have
`spread_group_id = NULL`; new spread legs share a generated `spread_group_id`.

## 8. Feature flagging

```
VOLUME_COVER_HEDGE_STRATEGY=strangle      (default — current behavior)
VOLUME_COVER_HEDGE_STRATEGY=spread        (new)
VOLUME_COVER_HEDGE_STRATEGY=auto          (per-cell allowlist, see below)

VC_SPREAD_CELL_ALLOWLIST=50k_2pct_1k     (only this cell uses spread design)
VC_SPREAD_CELL_ALLOWLIST=50k_2pct_1k,1k_2pct_20
```

`auto` mode + cell allowlist lets us run spread only on `50k_2pct_1k` while
keeping strangle behavior on all other cells. This is the path to live
cutover (one cell at a time).

## 9. Sequenced execution (transactional rollback)

A spread is 4 legs; failure modes:
1. Leg 1 fills, leg 2 rejected → naked short leg 1, immediate risk
2. Legs 1+2 fill, leg 3 rejected → unhedged put side, still risk
3. Legs 1+2+3 fill, leg 4 rejected → partial spread

Mitigation: sequence the legs such that an early failure is always recoverable:

```
Order:  long put → short put → long call → short call

If leg 1 (long put) rejects:        abort, no state to undo
If leg 2 (short put) rejects:       sell back leg 1 (long put @ bid)
If leg 3 (long call) rejects:       sell back leg 1 (long put), buy-to-close leg 2 (short put)
If leg 4 (short call) rejects:      sell back leg 3 (long call), unwind put spread also
```

Each rollback is a Layer 2 limit IOC at the worst-acceptable price; failure
to roll back triggers a hard halt + paging the operator. All rollback actions
recorded as `hedge_execution_rollback` pair-events for audit.

Atomicity is best-effort; on extreme venue outage we may end up with a
mis-built spread and need manual cleanup.

## 10. Test plan

```
Unit tests (Track 2 PR #1):
  - matrix.ts: spreadWidthUsdc field present + > 0 for all cells
  - spreadHedge.ts: K1<K2<K3<K4 for any spot/trigger, widths correct
  - sizing: contracts × max_payoff_at_trigger >= payoutUsdc
  - venue routing: Bullish primary returned when available, Deribit on fallback

Shadow integration tests (Track 2 PR #2):
  - 50k_2pct_1k spread open/close cycle (mock fills) — 10 iterations
  - 1k_2pct_20 spread with REAL Bullish fills — 5 iterations
  - Force-trigger event: TP curve fires on spread group, not individual legs
  - Rollback: simulated leg-2 reject → leg-1 sell-back, no orphan position

Bullish-execution validation (Phase E1-E3):
  Phase E1: bash bullish_e2e_microtest.sh — single leg buy/sell
  Phase E2: same script with short-to-open variant — margin path
  Phase E3: 4-leg spread version of microtest — full round-trip
  → these are runnable NOW with existing test-buy/test-sell endpoints

Live cutover criteria (after Track 2 PR #2 lands + Phase E3 passes):
  - 5+ shadow round-trips clean (no phantom legs, no orphan margin)
  - 1+ real-fill trigger event with TP curve unwind
  - Bullish account funded ≥ $2k for ≥ 4 concurrent pairs of capital
  - Bullish session-count stable < 5 over 24h on shadow
```

## 11. Bullish blockers + Deribit fallback

If at any point during Track 2 we discover a Bullish blocker we can't
resolve quickly:

1. **Strike grid too coarse** for our hedge target → fall back to Deribit (more
   strikes, $500 grid vs $1k)
2. **Insufficient depth** to support concurrent pairs at scale → reduce
   concurrent pair limit OR fall back to Deribit
3. **Margin rejection** on short legs (PILOT_BULLISH_ALLOW_MARGIN issues) →
   fall back to Deribit until resolved
4. **Persistent rate limiting** even with the singleton fix → fall back to
   Deribit until Bullish support unblocks
5. **Fee structure adverse** vs Deribit on round-trip → keep Deribit

The venue-routing layer makes #1-#5 a config flip, not a code change. We
ship Bullish-first; Deribit is one env var away.

## 12. Sequencing summary

```
Done (2026-05-22):
  PR #138         archive + slippage-floor on Deribit  (live merge ready)
  vc-sandbox      Bullish-singleton fix + microtest    (shadow deployed)

In progress (Track 2 PR #1 — this branch):
  spread builder scaffold: matrix.ts, spreadHedge.ts skeleton
  venue routing helper
  feature flag plumbing

Next (Track 2 PR #2):
  TP curve adapter for spread groups
  DB schema: spread_group_id
  Sequenced execution + rollback path

Next (Track 2 PR #3):
  Bullish-as-primary integration + Deribit-fallback wiring
  Shadow integration tests
  Operational dashboard updates

Live cutover gate:
  50k_2pct_1k spread on shadow with real fills, 5+ clean iterations,
  Bullish account funded, dashboard rollout playbook.
```
