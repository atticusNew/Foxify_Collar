# Phase 0 — Raw Render Log Drop Zone

This folder is where you (the operator) paste raw log lines exported from Render
so the Phase 0 analysis script can pick up the **hold-decision** dimension that
isn't visible from the database alone (cooling holds, gap-extended holds,
sub-threshold holds, no-bid retries, NEGATIVE_MARGIN events).

Outcomes (sells, triggers, expiries) are visible from the live admin API and
do not require log paste-ins. The logs are supplementary.

---

## File-naming convention

One file per UTC date per log prefix:

```
2026-04-17-hedgemanager.log
2026-04-17-optionselection.log
2026-04-17-triggermonitor.log
2026-04-17-autorenew.log
```

Or one combined file per UTC date if that's easier for you:

```
2026-04-17-all.log
```

The analysis script recognises both layouts.

---

## How to grab the lines from Render

1. Open the Render dashboard → Services → your API service
   (e.g. `foxify-pilot-new`) → **Logs** tab.
2. Set the time range to **last 24 hours** (or whatever range is convenient —
   re-pasting overlap is fine; the script de-duplicates by line content).
3. In the search filter at the top of the Logs pane, type one of the prefixes
   below in turn and download / copy:
   - `[HedgeManager]`
   - `[OptionSelection]`
   - `[TriggerMonitor]`
   - `[AutoRenew]`
4. If your Render plan has a **Download** button, click it; rename the file
   to the convention above and drop it into this folder.
5. If Download is not available, **select-all in the visible logs pane → copy →
   paste** into a new text file with the right name.

If you'd rather paste everything into one file per day, that's fine — name it
`YYYY-MM-DD-all.log` and the analysis script will grep prefixes on its side.

---

## Cadence

Once a day is plenty. If a day is uneventful (no triggers, no TPs), feel free
to skip — the absence of TP activity is itself useful and the script can infer
it from DB state.

---

## What you do NOT need to do

- Do **not** redact anything. The logs reference protection IDs (UUIDs),
  strikes, and dollar amounts only — no user identifiers, no secrets, no PII.
- Do **not** filter, dedupe, or reorder. Raw paste is best.
- Do **not** worry about overlap between consecutive days; the script handles
  duplicate lines.

---

## What gets ingested

| Log line shape | What the script extracts |
|---|---|
| `[HedgeManager] Selling (<reason>): <id> ...` | TP-sell decisions (cross-checked vs DB `metadata.sellResult`) |
| `[HedgeManager] Sell result: status=...` | Fill outcome (sold / no_bid / failed) |
| `[HedgeManager] cooling_period: ...` | Cooling holds (count + duration histogram) |
| `[HedgeManager] gap_extended_cooling: ...` | Gap-extended holds |
| `[HedgeManager] Hold: <id> ...` | All other holds (sub-threshold) |
| `[HedgeManager] Cycle complete: ...` | Cycle summary stats |
| `[OptionSelection] WINNER: ...` | Selected instrument + margin% (incl. ⚠ NEGATIVE_MARGIN) |
| `[OptionSelection] candidate: ...` | Per-candidate scoring trace |
| `[OptionSelection] OVER_PREMIUM` | Cost-cap penalty events |
| `[TriggerMonitor] TRIGGERED: ...` | Confirms DB triggers (cross-check) |
| `[TriggerMonitor] Cycle: ...` | Cycle counts and price errors |
| `[AutoRenew] Renewed X → Y ...` | Renewal events |
| `[AutoRenew] FAILED ...` | Renewal failures |

---

## Privacy / git tracking

The `.gitignore` is intentionally configured so this folder's `.log` files are
**ignored by git** — they live locally in the repo for the analysis to read,
but never get committed or pushed. Only this `README.md` is tracked.

If you want me to commit specific log files for archival (e.g. for a single
post-mortem), copy them outside this folder or rename them to `.txt` — those
are not gitignored and will be picked up by `git add`.
