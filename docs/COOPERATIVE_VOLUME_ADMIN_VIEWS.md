# Cooperative-Volume Admin Views (Foxify + Atticus)

Two role-scoped dashboards over the v2 two-sided facility, served by the existing
web app (`apps/web`, Vite + React). They are read-layers over the v2 API; the
**API token guards are the security boundary** — the UI cannot leak internals
because a Foxify token physically cannot call an admin endpoint.

## Routes

| URL | View | Token | Endpoints used |
|-----|------|-------|----------------|
| `/cover` | **Foxify** dashboard | `X-Foxify-Token` (paste-once, localStorage `ts_foxify_token`) | `/foxify/v2/*` only |
| `/cover/admin` | **Atticus** operator | `X-Admin-Token` (localStorage `ts_admin_token`) | `/admin/foxify/v2/*` |

Tokens are pasted once per browser and stored locally; "sign out" clears them.
The two keys are separate so the roles never share a credential.

## Foxify view (`/cover`) — built for transparency
- **Status strip:** spot, regime + DVOL, signal (GO / stand-down), active count, today's P&L.
- **Available cells:** the protection cells offered to the bot (`/foxify/v2/cells` +
  `should_activate`), with "offered now" tags. Click a cell to filter your positions.
- **My active protections:** per pair — exchange, **actual cost**, strikes, trigger
  window, distance, window-remaining, MTM, P&L, TP recommendation. Manual **Close**.
  (Shadow/Atticus paper pairs are filtered out — Foxify sees only its real pairs.)
- **Pair detail & audit (drill-in):** per-leg ACTUAL fills (exchange, buy/sell px +
  cost), the **exact cooperative split** (tier, Atticus floor; realized Atticus vs
  Foxify share on settled pairs — Atticus only collects on positive uplift), plus the
  outcome explanation and the feed snapshot used at activation/trigger.

What Foxify does NOT see (Atticus-only, by token boundary): calibration, cell-sweep,
breakeven ladder, MC projections, loss-leader economics, shadow-auto internals,
realized-vs-MC, venue/chain probes, deferred pool, and operator controls.

## Atticus view (`/cover/admin`) — full engine, tabbed
- **P&L:** live-pnl (real-money settled pairs), per-cell, shadow loss-leader scorecard.
- **Positions:** admin MTM (incl. shadow), stuck/out-of-band pairs, and controls —
  reconcile-settle (incl. `force` correction), respawn-close, force-trigger (shadow only).
- **Signal / Strategy:** per-regime **cell-allowlist editor** (add/remove cells live),
  structure selector, signal distribution, regime calibration.
- **Research:** on-demand fetch — close-fill calibration, realized-vs-MC, scaling
  projection, cell costs, settled summary, venue routing, latest cell-sweep.
- **Ops:** diagnostics (feed/venue health, live gate), kill switch (halt/resume),
  DVOL backfill.

## Dev / build
```bash
cd apps/web
npm install
VITE_API_BASE=https://<api-host> npm run dev   # local dev
npm run build                                  # production bundle (dist/)
```
`VITE_API_BASE` points the dashboards at the API; defaults to `http://localhost:4100`.
