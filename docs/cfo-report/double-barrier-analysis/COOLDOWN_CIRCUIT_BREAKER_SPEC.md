# Cooldown Circuit Breaker — Spec

> **Status:** spec only; production code not yet written.
> Owner: Atticus risk engineering.
> Companion docs: `MEMO_V2.md §6` (motivation), `FOXIFY_SURPRISES_BRIEF.md §3 Layer 4` (counterparty visibility).

---

## 1. Intent

Cooldown is a **payment-capacity protection mechanism** for the volume facility. It is *not* an always-on product feature, *not* a P&L-management tool, and *not* a contract-modification mechanism. It exists exclusively to ensure Atticus never reaches a state in which a triggered payout obligation cannot be met.

Cooldown does **not** apply to the retail pilot. Retail's existing circuit breakers (drawdown caps, auto-renew freeze, per-tier concentration cap) are separate and continue unmodified.

---

## 2. State machine

```
     ┌──────────────┐  any of T1..T4 fires  ┌──────────────┐
     │   NORMAL     │ ───────────────────► │  COOLDOWN     │
     │              │                       │  (4h initial) │
     │  - pairs open│                       │  - pairs cont.│
     │  - triggers  │  cooldown_clear()     │  - anchor lock│
     │    pay       │ ◄────────────────── │  - no new opens│
     │  - new opens │                       │  - alert desk │
     │    accepted  │                       │               │
     └──────────────┘                       └──────────────┘
                                                  │
                                                  │ desk manual ack required
                                                  │ to clear before T_cooldown elapses
                                                  ▼
                                             cooldown_clear()
```

States are **NORMAL** and **COOLDOWN**. Transitions are described below.

---

## 3. Trigger conditions (T1..T4) — any fires the breaker

### T1 — Payout-velocity threshold

```
condition:
   sum(payouts_to_foxify in last 4h)  /  atticus_operating_capital_excluding_foxify_prefund
   ≥  0.25
```

This catches concentrated payout bursts. At 1,000 pairs and $1.76M operating capital, T1 fires when payouts in 4h exceed $440k — i.e., 440 simultaneous-or-bursty triggers in 4h. Empirically this has not happened in the 4-year tape but it's a mechanically reasonable line.

### T2 — Trigger-density threshold

```
condition:
   distinct_triggers_in_last_4h  ≥  4 × N_open_pairs
```

Catches sustained barrier-graze chop. Empirically the highest 4h trigger density observed in moderate regime was ~2× pair count; T2 fires at 2× that rate.

### T3 — Hedge-book MTM drift

```
condition:
   hedge_book_mtm  <  E[hedge_book_mtm] - 1.5σ
   where the expectation and σ are 30-day rolling
```

Catches realized vol significantly exceeding implied vol — the long-vol carry inverting. This is the empirical "VRP went negative" detector.

### T4 — DVOL spike

```
condition:
   dvol_now  >  100  AND
   dvol_now / dvol_30min_ago  >  1.5
```

Catches sudden regime shifts (e.g., BTC drops 8% in 5 minutes; DVOL rockets from 65 to 110). This is the regime-change detector that fires before payout-velocity has had time to accumulate.

---

## 4. While in COOLDOWN

| Behavior | Spec |
|---|---|
| Existing triggered pairs continue to pay | Yes. Foxify is contractually due these payouts and Atticus already owns the hedges that fund them. |
| Anchor reset on triggers | **PAUSED.** A pair that hits its barrier still pays $1k, but the next ±2% boundary is measured from the **original anchor**, not the new spot. This eliminates intra-day chop pile-ups: a single 4-hour chop session that would normally produce 4-5 triggers produces 1 in cooldown. |
| New pair openings | **REJECTED.** New activation requests from Foxify return a structured 503 with `cooldown_active: true, expected_clear_ts: ...`. |
| Hedge-book unwinds | **CONTINUE.** The desk can still sell triggered hedge legs and re-buy at the new spot, because the hedge book is operationally separate from the pair-life logic. |
| DVOL band repricing | **CONTINUE.** Tier transitions still happen; the only frozen variable is the per-pair anchor. |

---

## 5. Clearing cooldown

Cooldown clears when **all** of:

1. T_cooldown has elapsed (default 4 hours; configurable per-incident by the desk)
2. **Desk manual ack** confirming review of the triggering condition
3. None of T1..T4 are currently true at the moment of clear

If T_cooldown elapses but a trigger condition is still firing, cooldown extends by another T_cooldown window. The desk cannot clear cooldown while a trigger is live.

---

## 6. Foxify-visible signaling

When cooldown fires, the operational dashboard mentioned in `FOXIFY_SURPRISES_BRIEF.md §4` updates:

```json
{
  "cooldown_active": true,
  "fired_at": "2026-05-10T14:23:11Z",
  "expected_clear_at": "2026-05-10T18:23:11Z",
  "trigger_reason": "T1_payout_velocity",
  "payout_velocity_4h_ratio": 0.31,
  "open_pairs_unchanged": true,
  "new_opens_paused": true
}
```

Foxify's automated systems can use this to suspend new pair-open API calls until cooldown lifts.

---

## 7. Quantified effect on stress P&L

Per `MEMO_V2.md §6.4`, a 4-hour anchor-freeze cooldown that fires at T2 (trigger density) reduces additional stress-week triggers by approximately 50%, which trims the worst-band p05 pair-life P&L from −$20,894 to roughly **−$11,000 to −$13,000** per pair-life.

**This is the analytic estimate.** A rigorous Monte-Carlo with cooldown logic plumbed into `historical_replay.py` would produce a precise number; that's a follow-up task.

---

## 8. What cooldown does NOT do (explicit non-claims)

- It does not breach any contract with Foxify.
- It does not modify the trigger-payout amount on any open pair.
- It does not modify the daily premium charged on any open pair.
- It does not unilaterally close any open pair on Foxify's side.
- It does not affect the retail pilot's positions or risk controls.
- It does not pre-empt or replace any of Atticus's existing per-platform circuit breakers (max-loss-24h, auto-renew freeze, per-tier concentration cap).

---

## 9. Implementation notes (engineering)

The cooldown machine is naturally a layer on top of the existing trigger monitor in `services/api`. Approximate plumbing:

1. New service `services/api/src/volFacility/cooldownMonitor.ts` polls T1..T4 every 30 seconds.
2. State is held in Postgres (single-row table `vol_facility_cooldown_state`).
3. The `volFacility/openPair` API checks state before accepting new opens.
4. The trigger-monitor's anchor-reset path checks state before re-anchoring.
5. The Foxify-facing dashboard is read-only against the same row.

Estimated implementation effort: ~3 days for the production code + tests + integration with existing trigger monitor.

The simulator extension (to quantify cooldown's effect on the empirical p05) is ~1 day on top of `historical_replay.py`.

---

*End of spec. Open for desk + engineering review.*
