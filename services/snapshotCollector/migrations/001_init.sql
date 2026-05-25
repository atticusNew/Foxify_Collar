-- Snapshot Collector — initial schema (v1)
--
-- Read-only against the live Foxify pilot. This DB is for accumulating
-- historical snapshots so we can compute realized salvage/EV per cell,
-- per regime, and surface anomalies (rule 12 firing too often, slippage
-- spikes, phantom legs). It NEVER writes to the live pilot DB.

CREATE TABLE IF NOT EXISTS snapshot_run (
  id              bigserial PRIMARY KEY,
  started_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  source_url      text NOT NULL,
  poll_kind       text NOT NULL CHECK (poll_kind IN ('full', 'fast', 'manual')),
  ok              boolean,
  error_message   text
);

-- Raw JSON snapshots — exact response payloads, untouched.
-- Allows us to re-derive metrics later if computation logic changes.
CREATE TABLE IF NOT EXISTS snapshot_raw (
  id              bigserial PRIMARY KEY,
  run_id          bigint NOT NULL REFERENCES snapshot_run(id) ON DELETE CASCADE,
  endpoint        text NOT NULL,
  http_status     integer,
  payload_jsonb   jsonb NOT NULL,
  collected_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_snapshot_raw_endpoint ON snapshot_raw(endpoint, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshot_raw_run ON snapshot_raw(run_id);

-- Derived: per-position observed at each snapshot.
-- A given positionId appears in many snapshot_position rows over time.
CREATE TABLE IF NOT EXISTS snapshot_position (
  id                          bigserial PRIMARY KEY,
  run_id                      bigint NOT NULL REFERENCES snapshot_run(id) ON DELETE CASCADE,
  position_id                 text NOT NULL,
  cell_id                     text,
  status                      text,
  salvage_state               text,
  trigger_high_btc            numeric,
  trigger_low_btc             numeric,
  payout_usdc                 numeric,
  daily_premium_usdc          numeric,
  hedge_buy_usdc              numeric,
  hedge_sell_usdc             numeric,
  realized_salvage_pct        numeric,  -- hedge_sell / hedge_buy
  total_legs                  integer,
  open_legs                   integer,
  sold_legs                   integer,
  failed_legs                 integer,
  observed_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_snapshot_position_pid ON snapshot_position(position_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshot_position_cell ON snapshot_position(cell_id, status, observed_at DESC);

-- Per-leg snapshot — captures evolving Deribit/Bullish position
CREATE TABLE IF NOT EXISTS snapshot_leg (
  id                  bigserial PRIMARY KEY,
  run_id              bigint NOT NULL REFERENCES snapshot_run(id) ON DELETE CASCADE,
  leg_id              text NOT NULL,
  position_id         text,
  venue               text,
  option_kind         text,
  strike_usdc         numeric,
  expiry_iso          text,
  contracts_btc       numeric,
  status              text,
  buy_fill_price_usdc numeric,
  sell_fill_price_usdc numeric,
  observed_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_snapshot_leg_lid ON snapshot_leg(leg_id, observed_at DESC);

-- Pool ledger snapshot — tracks running balance of atticus_hedge / foxify_trader pools
CREATE TABLE IF NOT EXISTS snapshot_pool_ledger (
  id              bigserial PRIMARY KEY,
  run_id          bigint NOT NULL REFERENCES snapshot_run(id) ON DELETE CASCADE,
  pool_id         text NOT NULL,
  entry_id        text,            -- ledger row id from foxify-pilot
  ts              timestamptz,
  kind            text,            -- 'hedge_buy_out', 'hedge_sell_in', 'premium_in', 'payout_out', 'salvage_event'
  amount_usdc     numeric,
  position_id     text,
  leg_id          text,
  metadata_jsonb  jsonb,
  collected_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_snap_ledger_pool ON snapshot_pool_ledger(pool_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_snap_ledger_position ON snapshot_pool_ledger(position_id);

-- Health snapshot
CREATE TABLE IF NOT EXISTS snapshot_health (
  id                      bigserial PRIMARY KEY,
  run_id                  bigint NOT NULL REFERENCES snapshot_run(id) ON DELETE CASCADE,
  halted                  boolean,
  active_position_count   integer,
  spot_btc_usdc           numeric,
  guard_statuses_jsonb    jsonb,
  observed_at             timestamptz NOT NULL DEFAULT now()
);

-- Hedge-manager rule-firing observations (from /admin/hedge-manager/run dryRun)
CREATE TABLE IF NOT EXISTS snapshot_rule_firing (
  id              bigserial PRIMARY KEY,
  run_id          bigint NOT NULL REFERENCES snapshot_run(id) ON DELETE CASCADE,
  leg_id          text,
  rule            integer,        -- 1..12
  action          text,           -- 'sell','hold','defer','reclassify'
  reason          text,
  observed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_snap_rule_leg ON snapshot_rule_firing(leg_id, observed_at DESC);

-- Daily roll-up (computed, materialized)
CREATE TABLE IF NOT EXISTS daily_metrics (
  date_utc                date PRIMARY KEY,
  cells_observed_jsonb    jsonb,
  closed_positions_count  integer,
  triggered_count         integer,
  no_trigger_count        integer,
  failed_count            integer,
  avg_salvage_pct         numeric,
  median_salvage_pct      numeric,
  total_premium_in_usdc   numeric,
  total_hedge_buy_usdc    numeric,
  total_hedge_sell_usdc   numeric,
  total_payout_out_usdc   numeric,
  net_atticus_pnl_usdc    numeric,
  rule_firing_count_jsonb jsonb,
  computed_at             timestamptz NOT NULL DEFAULT now()
);
