# Degraded-Settlement Policy — Foxify Net-Credit Collar (DRAFT)

> **Status: DRAFT — required deliverable, NOT code. Must be reviewed and COUNTER-SIGNED by Foxify
> before any live capital.** This document defines, in advance, exactly which price settles open
> positions when the reference-price oracle is impaired. It is far better agreed before an incident
> than negotiated after one. It pairs with the oracle implementation
> (`services/api/src/singleSide/twoSided/creditCollar/referenceOracle.ts`), whose ECDSA-signed,
> independently-recomputable snapshots make every clause below auditable.

## 1. Purpose & scope

The collar settles European-style at a daily expiry on a **median-TWAP reference** computed from
multiple sources (Bullish + Deribit + ≥2 CEXs). This policy specifies the deterministic behavior when
that feed is degraded or unavailable, so that **neither party has discretion at settlement** and any
outcome can be independently verified from signed snapshots.

## 2. Oracle health states (from `aggregateOracle`)

| State | Condition (usable sources after freshness + MAD filtering) | Marks/stops | New activations |
|---|---|---|---|
| `healthy` | ≥ 3 | served | allowed |
| `degraded` | exactly 2 | served (flagged) | **frozen** |
| `halt` | < 2 | **not served** | **frozen** |

- **Freshness:** samples older than `freshnessMaxMs` (default 5s) are dropped.
- **Outliers:** MAD rejection removes manipulated/erroneous prints before the median.
- **Fail-closed:** below the hard minimum of 3 sources, no new protection is opened.

## 3. Settlement-price waterfall (the load-bearing clauses — TO BE CONFIRMED BY FOXIFY)

At a position's scheduled daily expiry, the settlement price is determined by the **first applicable**
rule below. Each branch references signed snapshots so Foxify can recompute independently.

1. **Normal:** the settlement window (15–30 min, struck at Bullish's daily option-expiry time) has
   ≥ 3 healthy sources for ≥ `[MIN_WINDOW_COVERAGE — e.g. 80%]` of the window →
   **settle at the median-TWAP** over the window. *(Default; expected case.)*

2. **Brief impairment within the window:** coverage between `[LOW]` and `[MIN_WINDOW_COVERAGE]` →
   **settle at the TWAP of the healthy sub-intervals only** (degraded ticks excluded), provided at
   least `[MIN_HEALTHY_MINUTES — e.g. 5 min]` of healthy data exist.

3. **Insufficient window data:** healthy data below `[MIN_HEALTHY_MINUTES]` →
   **settle at the last `healthy` signed streaming-median snapshot strictly before expiry**, provided
   it is no older than `[MAX_STALE_SETTLE — e.g. 10 min]`.

4. **Extended-window fallback:** if (3) is unavailable, **extend the window** forward by
   `[EXTENSION — e.g. up to 60 min]` and settle at the first qualifying TWAP under rule (1)/(2).

5. **Halt-and-manual (last resort):** if no qualifying price exists within the extension →
   **freeze settlement** and resolve by the pre-agreed manual procedure in §5. No automatic settlement
   on an untrusted price.

> **OPEN — Foxify to choose the parameters in brackets and confirm the ordering.** The default
> recommendation is: `MIN_WINDOW_COVERAGE = 80%`, `MIN_HEALTHY_MINUTES = 5`, `MAX_STALE_SETTLE = 10 min`,
> `EXTENSION = 60 min`, then halt-and-manual.

## 4. Stops / triggers during impairment

- Stops fire on the **streaming median** with **tick-persistence** (anti-wick; `confirmTrigger`).
- If the oracle is `degraded`/`halt`, **no new stop is auto-confirmed**; existing positions are
  carried to the European expiry and settled per §3. The **deep put remains the gap-through backstop**
  — Foxify is made whole at the eventual TWAP settlement, not at the stop instant. The reserve carries
  this intraday timing gap (sized off the imbalanced ±12% both-wing jump).

## 5. Halt-and-manual procedure (§3 rule 5)

- On halt-to-manual, Atticus publishes the **full signed sample set** for the affected window.
- The settlement price is agreed by `[Foxify ops + Atticus ops within N hours]`, defaulting to the
  **last healthy signed TWAP** if no agreement, with a dispute window of `[D days]`.
- All inputs are the ECDSA-signed snapshots; either party can recompute via `recomputeAndVerify`.

## 6. Audit & dispute

- Every settlement cites the snapshot(s) used, each ECDSA-signed by Atticus and verifiable by Foxify
  with the public key (no shared secret → non-repudiation).
- Foxify can recompute any settlement from the persisted samples and confirm both the price and the
  signature. A settlement that does not reproduce is void and falls to §5.

## 7. Sign-off

| Party | Name | Signature | Date |
|---|---|---|---|
| Atticus | | | |
| Foxify | | | |

*This policy must be signed before live capital. Until signed, the collar runs in shadow only.*
