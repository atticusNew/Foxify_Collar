# Two-Sided Facility — Env Inventory (Phase-A cleanup, 2026-06-02)

Authoritative list of env vars the **v2 two-sided facility** actually reads (grepped from
`services/api/src/singleSide/twoSided/*` + server wiring), so stale Render vars can be pruned.
Render is the source of truth; `render.yaml` is historical (ignore it).

## KEEP — v2 core (the only ones that affect the cooperative-volume facility)

### Auth / infra
| Var | Purpose |
|-----|---------|
| `POSTGRES_URL` | DB (shared). |
| `FOXIFY_API_KEY` | Foxify-token (`X-Foxify-Token`) for `/foxify/v2/*`. |
| `PILOT_ADMIN_TOKEN` | Admin-token (`X-Admin-Token`) for `/admin/foxify/v2/*` — **reused by v2** (keep even after pilot decommission). |
| `RENDER_API_URL`, `RENDER_ADMIN_TOKEN` | Feed source plumbing. |

### Live execution + gates
| Var | Default | Purpose |
|-----|---------|---------|
| `FOXIFY_V2_LIVE_EXECUTION` | false | **THE executor switch** (accepts `true/live/1/yes/on`). Off ⇒ shadow/paper. |
| `SS_TWO_SIDED_LIVE_ENABLED` | false | Live gate (allowlist/caps enforced). |
| `SS_TWO_SIDED_CELL_ALLOWLIST` | — | CSV of cells allowed to fire LIVE. |
| `SS_TWO_SIDED_MAX_PAIRS_PER_DAY` | 2 | Daily live-pair cap. |
| `SS_TWO_SIDED_BOOT_HALT` | true | Halt on boot until cleared. |
| `SS_TWO_SIDED_MAX_CAPITAL_AT_RISK_USDC` | unset | Capital cap. |
| `SS_TWO_SIDED_DVOL_HALT_LIVE` / `_SHADOW` | / 1000 | Regime halt thresholds. |
| `SS_NEWBORN_AUTO_APPROVE_AFTER_N` | 0 (off) | Auto-graduate newborn review after N validated settlements. |

### Venue routing + execution tuning
| Var | Default | Purpose |
|-----|---------|---------|
| `SS_VENUE_PARTNER` | — | Set `bullish` to prefer Bullish within band. |
| `SS_VENUE_PARTNER_MAX_SPREAD_PCT` | 0 | Partner round-trip tolerance (e.g. 0.08–0.13). |
| `SS_BULLISH_IOC_SLIPPAGE_PCT` | 0.05 | Headroom on Bullish BUY IOC limit (crosses moved ask; fills at real ask). |
| `BULLISH_ORDERBOOK_AUTHED` | false | Authed orderbook reads (set true for the registered host). |
| `BULLISH_RATE_LIMIT_BACKOFF_MS` | 60000 | Bullish 429 cool-off. |
| `BULLISH_CHAIN_MAX_ORDERBOOK_FETCHES` | 24 | Cap per chain refresh. |
| `PILOT_BULLISH_*` | — | Bullish client (REST base = `registered.api.exchange.bullish.com`, WS URLs, ECDSA creds, `PILOT_BULLISH_TRADING_ACCOUNT_ID`) — **reused by v2; keep.** |
| `DERIBIT_ENV` (=`live`), `DERIBIT_PAPER`, `DERIBIT_CLIENT_ID/SECRET` | | Deribit client — **keep.** |

### Auto-loops (shadow data + live TP)
| Var | Purpose |
|-----|---------|
| `SHADOW_AUTO_ACTIVATE`, `SHADOW_AUTO_MAX_PER_DAY` (100) | Shadow auto-loop. |
| `SHADOW_AUTO_TP_ENABLED`, `_POLL_MS`, `_THRESHOLD_PCT`, `_MAX_PER_TICK` | Shadow auto-TP (**recommend ENABLE** for realistic shadow data). |
| `SS_LIVE_AUTO_TP_ENABLED`, `_PAIR_IDS`, `_THRESHOLD_PCT`, `_TRAIL_ARM_PCT`, `_TRAIL_GIVEBACK_PCT`, `_POLL_MS` | Live auto-TP watcher. |

### Economics / pricing / calibration (defaults are sane; override only intentionally)
`SS_ATTICUS_SPLIT_PCT`, `SS_ATTICUS_FLOOR_USDC`, `FOXIFY_PERP_FRICTION_USDC`,
`FOXIFY_PERP_FRICTION_BPS`, `FOXIFY_PERP_FUNDING_BPS_PER_DAY`, `SS_PROJECTION_REALIZED_MODE`,
`SS_PROJECTION_MIN_VALIDATED_SETTLEMENTS`, `SS_CALIB_WEIGHTING`, `SS_CALIB_HALFLIFE_DAYS`,
`SYNTHETIC_SIGMA_*`, `SYNTHETIC_MARKUP_*`, `MIN_SIGMA_CALIB_SAMPLES`, `MIN_MARKUP_CALIB_SAMPLES`,
`CALIBRATION_CACHE_TTL_MS`, `SS_STRUCTURE_BY_REGIME`, `SS_MC_BOOTSTRAP_ALL_REGIMES`,
`SS_SWEEP_YIELD_EVERY`, `BS_RISK_FREE_RATE`, `BS_BID_HAIRCUT`, `BS_FALLBACK_HAIRCUT`,
`BS_MAX_TENOR_DRIFT_HOURS`, `NEUTRAL_IV_FALLBACK`, `STALE_QUOTE_WARN_MS`,
`SS_TWO_SIDED_ALLOW_CALM`, `SS_TWO_SIDED_ALLOW_CALM_SHADOW`, `SS_TWO_SIDED_CALM_LOSS_LEADER`,
`SS_TWO_SIDED_CALM_MAX_LOSS_USDC`, `SS_TWO_SIDED_ORDER_AGGREGATION_ENABLED`, `TWO_SIDED_LOG_LEVEL`.

## PRUNE after Phase-B (legacy pilot + volumeCover subsystems being decommissioned)
These are read ONLY by the legacy `src/pilot/*` + `volumeCover` subsystems (not v2). Remove from
Render once those subsystems are unwired:
- Pilot business: `PILOT_PROFILE`, `PILOT_VENUE_MODE`, `PILOT_ENFORCE_WINDOW`, `PILOT_TENOR_DEFAULT_DAYS`,
  `PILOT_STRIKE_SELECTION_MODE`, `PILOT_MAX_PROTECTION_NOTIONAL_USDC`, `PILOT_MAX_DAILY_PROTECTED_NOTIONAL_USDC`,
  `PILOT_STARTING_RESERVE_USDC`, `PILOT_ACTIVATION_ENABLED`, `PILOT_API_ENABLED`, `PILOT_TENANT_SCOPE_ID`,
  `PILOT_TERMS_VERSION`, `PILOT_PROOF_TOKEN`, `PILOT_INTERNAL_TOKEN`, `PILOT_RATE_LIMIT_MAX`,
  `PILOT_RATE_LIMIT_WINDOW_MS`, `PILOT_MONITOR_ENABLED`, `PILOT_BULLISH_FILL_CONFIRM_*`,
  `PILOT_BULLISH_PRICE_STALENESS_MAX_PCT`, `PILOT_BULLISH_ORDER_TIF`.
- Old pilot price feed: `PRICE_*` (PRICE_REFERENCE_URL, FALLBACK_PRICE_URL, PRICE_*_MS, …),
  `LOOP_INTERVAL_MS`, `MTM_INTERVAL_MS`, `USER_HASH_SECRET`.
- volumeCover-specific vars (audit `src/volumeCover/*` for `process.env` before removing).

⚠️ **Do NOT prune** `PILOT_ADMIN_TOKEN` or `PILOT_BULLISH_*` (REST base, WS, ECDSA creds,
`PILOT_BULLISH_TRADING_ACCOUNT_ID`, `PILOT_BULLISH_ENABLED`) — v2 reuses them.

## Recommended actions now (no code)
1. **Set `SHADOW_AUTO_TP_ENABLED=true`** — so shadow pairs take profit like a real Foxify bot
   (otherwise they ride to expiry and bias the realized data toward losses).
2. Confirm `FOXIFY_V2_LIVE_EXECUTION` value renders `executor_mode:"live"` in `/diagnostics`.
3. Keep the PRUNE list above for the Phase-B decommission (don't delete the shared PILOT_BULLISH_*/ADMIN).
