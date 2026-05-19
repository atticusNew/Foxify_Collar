# Phase 2 — Deribit chain sampler: operator runbook

This runbook covers (a) what the Phase 2 sampler does, (b) the recommended
"Option A" GitHub Actions execution model, and (c) the local "Option B" fallback.

---

## What the sampler does

`services/api/scripts/pilotDeribitChainSampler.ts` answers, empirically:

> "When a pilot user clicks Open + Protect at SL X%, is there a 1-day option at
> the trigger band on Deribit, at what cost, and with what spread? When there
> isn't, what fallback would the algo pick instead?"

Each invocation produces **one snapshot** containing:

- BTC spot from Deribit index price + Coinbase ticker (with delta).
- DVOL.
- Per-tier (2/3/5/10) × per-protection-type (long/short):
  - Trigger price + ±0.5% trigger band.
  - All in-band candidates with bid / ask / mark / IV / depth.
  - The best 1-day in-band candidate (if any).
  - The fallback candidate that the venue selector would pick under the same
    `[12h, 3d]` window logic.
- A put-skew snapshot — the 11 strikes nearest spot at the closest-to-1-day
  expiry, with mark IV and bid/ask in USD. This feeds the put-skew analysis
  used in Phase 1.

**Read-only**, **no secrets needed**, **mainnet public Deribit API only**.

Output schema: `atticus.deribit.chain-sample.v1` (top-level field in each JSON).

---

## Option A — GitHub Actions (recommended)

Workflow file: `.github/workflows/deribit-chain-sampler.yml`

### How it works

- Scheduled trigger: every 6 hours, at minute `:07` (so 24/7 runs are 4 per
  day — chosen because GitHub schedules are best-effort and `00`-minute slots
  experience the most contention; `:07` reduces missed runs).
- Manually triggerable via the "Run workflow" button in GitHub Actions UI
  (also accepts an optional `reason` for the commit message).
- Runs the sampler on `ubuntu-latest`, takes ~5–15 seconds for the actual fetch
  + CI orchestration.
- Snapshots get committed to a dedicated **`chain-samples-data`** branch (not
  `main`, not your dev branch) so they don't clutter PRs or the main history.
  The first run creates the branch as an orphan so its history stays small.

### One-time setup steps for you

1. **Merge this PR.** That's it — once `.github/workflows/deribit-chain-sampler.yml`
   is on the default branch, GitHub auto-registers the schedule.
2. (Optional, recommended) **Trigger the first run manually** to verify
   plumbing:
   - Go to **Actions** tab in GitHub.
   - Left sidebar: "Phase 2 — Deribit chain sampler (1-day-tenor investigation)".
   - "Run workflow" → leave defaults → "Run workflow".
   - Watch the run; on success the workflow logs will print the snapshot
     summary, and a new commit appears on the `chain-samples-data` branch.
3. **Confirm the schedule is active.** Go to **Settings → Actions → General**
   and ensure scheduled workflows are not disabled.

That's the entire Option-A activation. No secrets, no permissions tuning — the
workflow uses the default `GITHUB_TOKEN` (writes to its own data branch only).

### What you'll see during the 7-day window

Every ~6h:
- A new commit on `chain-samples-data` named
  `chain-sampler: snapshot <UTC> (scheduled run)`.
- One new file at `artifacts/chain-samples/<UTC-timestamp>.json`.
- One appended row in `artifacts/chain-samples/index.csv` for spreadsheet use.

### How to disable when the 7-day window completes

Either:
- **Easy** — Actions tab → click the workflow → "Disable workflow" (top-right).
- **Permanent** — delete `.github/workflows/deribit-chain-sampler.yml` in a
  cleanup PR.

The collected snapshots stay forever on the `chain-samples-data` branch
(small text files; storage cost is negligible).

### Notes / caveats

- GitHub free tier gets 2,000 Action minutes/month for private repos and
  unlimited for public. This sampler uses ~1 minute per run × ~4 runs/day ×
  7 days = ~30 minutes total. Well under any cap.
- Scheduled triggers have ~5-15 minute jitter on GitHub. Snapshot timestamps
  are recorded with millisecond precision regardless.
- If GitHub experiences an outage during a scheduled slot, that snapshot is
  simply skipped — gaps are normal and the analysis tolerates them.
- All commits to `chain-samples-data` are by `github-actions[bot]`.

---

## Option B — Local execution (fallback)

If you prefer to run it yourself instead of using GH Actions:

```bash
# One-shot run, writes to artifacts/chain-samples/
cd /path/to/Foxify_Collar
npx tsx services/api/scripts/pilotDeribitChainSampler.ts

# Dry run (prints summary to stdout, writes nothing)
npx tsx services/api/scripts/pilotDeribitChainSampler.ts --no-write

# Custom output dir
npx tsx services/api/scripts/pilotDeribitChainSampler.ts --out-dir /tmp/chain
```

For a recurring schedule on macOS / Linux, set up a cron job:

```cron
# Every 6 hours, at minute :07
7 */6 * * * cd /path/to/Foxify_Collar && /usr/local/bin/npx tsx services/api/scripts/pilotDeribitChainSampler.ts >> /tmp/chain-sampler.log 2>&1
```

Or use `launchd` on macOS / `systemd-timer` on Linux. The script is idempotent
across invocations — each run produces a uniquely-named snapshot file.

---

## Phase 2 deliverable (PR-D)

After 7 days of sampling, a separate PR (`PR-D`) will:

1. Read the snapshots from the `chain-samples-data` branch.
2. Aggregate them into `docs/pilot-reports/deribit_1day_chain_availability.md`,
   covering:
   - 1-day in-band hit rate per SL tier (over the 7-day window).
   - When 1d is missing, fallback expiry distribution (1.5d / 2d / 3d).
   - Spread (bid-ask in bps) distribution per tier.
   - Realized hedge cost per $1k notional vs the V7 premium per $1k.
   - Put-skew curve snapshot (and time-variation across the window).
   - Cross-check: did Coinbase spot ever diverge from Deribit index by enough
     to matter for trigger detection?

That's the empirical input set for Phase 1's bid-ask multipliers.

---

## What if KYC clears mid-7-day-window?

Per stabilization-mode policy: pause Phase 2 (disable the workflow), pivot to
live-flip support. The snapshots collected so far are still useful — Phase 1
and the synthesis can run on whatever sample size we have.
