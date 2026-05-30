# Phase 0 — Raw Admin API Snapshot Drop Zone

This folder holds raw JSON snapshots fetched by `pilotLiveAnalysisAdmin.ts`
from the live Render admin API. Snapshots are timestamped and never overwritten,
so the analysis is fully reproducible.

The analysis script writes here automatically. You normally won't put files
here yourself.

---

## File layout

```
raw-pilot-data/
  2026-04-17T08-15-30Z/
    metrics-active.json
    metrics-all.json
    protections-active.json
    protections-all.json
    execution-quality.json
    health.json
    monitor-status.json
    fetch-summary.json
```

Each `<UTC-timestamp>/` folder is one full snapshot — running the script again
creates a new folder.

---

## Privacy / git tracking

JSON files in this folder are **gitignored** (per the repo's existing
`artifacts/` and `*.log` patterns we extend in this PR). They stay local to the
repo for analysis. The `README.md` here is tracked.

If you want a specific snapshot to be archived, rename the folder or copy it
out to `docs/pilot-reports/snapshots-archive/` (which is tracked).

---

## Sensitivity

These snapshots include protection records and admin metrics for the pilot
tenant. They do **not** include user PII (Atticus uses one-way hashing) but
they do include trade-level dollar amounts, instrument IDs, and execution
prices. Treat them as commercially-sensitive but not security-sensitive.
