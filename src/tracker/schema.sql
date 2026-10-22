-- AI Trade Tracker schema (self-contained on worker host; also applyable to Neon)

-- gen_random_uuid() is built in on Postgres 13+ (and PGlite).

CREATE TABLE IF NOT EXISTS tracker_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL DEFAULT 'discord-desk',
  source TEXT NOT NULL DEFAULT 'discord_desk', -- discord_desk | manual | ai_page | sim
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  grade TEXT NOT NULL DEFAULT 'B',
  entry NUMERIC(24, 8) NOT NULL,
  original_stop NUMERIC(24, 8) NOT NULL,
  current_stop NUMERIC(24, 8) NOT NULL,
  targets NUMERIC(24, 8)[] NOT NULL,
  -- Pre-TP1 management: when price tags trigger, move stop to stop_lift_to (BE or lock profit)
  stop_lift_trigger NUMERIC(24, 8),
  stop_lift_to NUMERIC(24, 8),
  stop_lift_rationale TEXT,
  stop_lifted BOOLEAN NOT NULL DEFAULT FALSE,
  stop_lift_at TIMESTAMPTZ,
  -- Position model: start 1.0; TP1 closes 0.5; runner 0.5
  remaining_size NUMERIC(8, 4) NOT NULL DEFAULT 1.0,
  tp1_closed_size NUMERIC(8, 4) NOT NULL DEFAULT 0,
  stop_to_be BOOLEAN NOT NULL DEFAULT FALSE,
  -- Entry confirmation: touch | reclaim (default reclaim — hit zone then reclaim confirm level)
  entry_confirm_type TEXT NOT NULL DEFAULT 'reclaim',
  entry_confirm_level NUMERIC(24, 8),
  entry_confirm_rationale TEXT,
  entry_armed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('win', 'loss', 'scratch')),
  realized_r NUMERIC(16, 6) NOT NULL DEFAULT 0,
  confluence_signals TEXT[] NOT NULL DEFAULT '{}',
  reasoning TEXT,
  risk_reward_ratio NUMERIC(12, 4),
  entry_hit_at TIMESTAMPTZ,
  tp1_hit_at TIMESTAMPTZ,
  tp_hit_at TIMESTAMPTZ,
  tp_hit_level INT,
  sl_hit_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  last_price NUMERIC(24, 8),
  last_checked_at TIMESTAMPTZ,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent upgrades for existing DBs
ALTER TABLE tracker_trades ADD COLUMN IF NOT EXISTS stop_lift_trigger NUMERIC(24, 8);
ALTER TABLE tracker_trades ADD COLUMN IF NOT EXISTS stop_lift_to NUMERIC(24, 8);
ALTER TABLE tracker_trades ADD COLUMN IF NOT EXISTS stop_lift_rationale TEXT;
ALTER TABLE tracker_trades ADD COLUMN IF NOT EXISTS stop_lifted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tracker_trades ADD COLUMN IF NOT EXISTS stop_lift_at TIMESTAMPTZ;
ALTER TABLE tracker_trades ADD COLUMN IF NOT EXISTS entry_confirm_type TEXT NOT NULL DEFAULT 'reclaim';
ALTER TABLE tracker_trades ADD COLUMN IF NOT EXISTS entry_confirm_level NUMERIC(24, 8);
ALTER TABLE tracker_trades ADD COLUMN IF NOT EXISTS entry_confirm_rationale TEXT;
ALTER TABLE tracker_trades ADD COLUMN IF NOT EXISTS entry_armed_at TIMESTAMPTZ;

-- Drop legacy status CHECK if present (allows entry_armed / entry_invalid)
DO $$
BEGIN
  ALTER TABLE tracker_trades DROP CONSTRAINT IF EXISTS tracker_trades_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DROP INDEX IF EXISTS idx_tracker_trades_active;
CREATE INDEX IF NOT EXISTS idx_tracker_trades_active
  ON tracker_trades (status)
  WHERE status IN ('pending', 'entry_armed', 'entry_hit', 'tp1_hit');

CREATE INDEX IF NOT EXISTS idx_tracker_trades_closed
  ON tracker_trades (closed_at DESC)
  WHERE closed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tracker_trades_symbol
  ON tracker_trades (symbol, created_at DESC);

CREATE TABLE IF NOT EXISTS tracker_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id UUID NOT NULL REFERENCES tracker_trades(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  price NUMERIC(24, 8),
  size_fraction NUMERIC(8, 4),
  r_delta NUMERIC(16, 6) NOT NULL DEFAULT 0,
  realized_r_after NUMERIC(16, 6),
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tracker_events_trade
  ON tracker_events (trade_id, created_at);

CREATE TABLE IF NOT EXISTS tracker_weekly_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  stats JSONB NOT NULL,
  discord_ok BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Standalone LTF scalp desk analysis runs (app keeps latest + 1 previous per symbol)
CREATE TABLE IF NOT EXISTS paper_account (
  id TEXT PRIMARY KEY,
  starting NUMERIC(16, 4) NOT NULL,
  cash NUMERIC(16, 4) NOT NULL,
  locked_margin NUMERIC(16, 4) NOT NULL DEFAULT 0,
  equity NUMERIC(16, 4) NOT NULL,
  peak NUMERIC(16, 4) NOT NULL,
  risk_pct NUMERIC(8, 6) NOT NULL DEFAULT 0.0075,
  max_leverage NUMERIC(6, 2) NOT NULL DEFAULT 2,
  max_margin_frac NUMERIC(8, 4) NOT NULL DEFAULT 0.20,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS paper_positions (
  trade_id UUID PRIMARY KEY REFERENCES tracker_trades(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL,
  entry NUMERIC(24, 8) NOT NULL,
  stop NUMERIC(24, 8) NOT NULL,
  base_qty NUMERIC(24, 8) NOT NULL,
  remaining_qty NUMERIC(24, 8) NOT NULL,
  notional NUMERIC(16, 4) NOT NULL,
  margin NUMERIC(16, 4) NOT NULL,
  leverage NUMERIC(6, 2) NOT NULL,
  risk_usd NUMERIC(16, 4) NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS paper_fills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id UUID REFERENCES tracker_trades(id) ON DELETE SET NULL,
  event TEXT NOT NULL,
  qty NUMERIC(24, 8) NOT NULL,
  price NUMERIC(24, 8) NOT NULL,
  pnl NUMERIC(16, 4) NOT NULL DEFAULT 0,
  equity_after NUMERIC(16, 4) NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_paper_fills_ts ON paper_fills (created_at DESC);

CREATE TABLE IF NOT EXISTS paper_equity (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  equity NUMERIC(16, 4) NOT NULL,
  cash NUMERIC(16, 4) NOT NULL,
  locked_margin NUMERIC(16, 4) NOT NULL DEFAULT 0,
  open_notional NUMERIC(16, 4) NOT NULL DEFAULT 0,
  xrp_price NUMERIC(24, 8),
  drawdown_pct NUMERIC(10, 6) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_paper_equity_ts ON paper_equity (ts ASC);
