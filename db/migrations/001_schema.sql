-- =====================================================================
-- Tycoon: schema
-- Everything lives in the `tycoon` schema, which is NOT exposed over the
-- Supabase REST API. Clients can only reach the game through the
-- `public.tycoon_*` functions defined in 003_api.sql.
-- This file is idempotent: running it again is safe.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS tycoon;

-- Economic rulesets. All rates, tax bases, valuation formulas and cadence
-- live in `config`. A new economic model is an INSERT, not a code change.
CREATE TABLE IF NOT EXISTS tycoon.rulesets (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  config       JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS tycoon.worlds (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  ruleset_id   TEXT NOT NULL REFERENCES tycoon.rulesets(id),
  status       TEXT NOT NULL DEFAULT 'running'
               CHECK (status IN ('open','running','ended')),
  started_at   TIMESTAMPTZ DEFAULT now(),
  ends_at      TIMESTAMPTZ,
  tick_count   INT NOT NULL DEFAULT 0,
  next_tick_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Login accounts: plain username + password (bcrypt via pgcrypto).
-- IP addresses are recorded from the request headers when available.
CREATE TABLE IF NOT EXISTS tycoon.accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_ip    TEXT,
  last_ip       TEXT,
  last_login_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_key
  ON tycoon.accounts (lower(username));

CREATE TABLE IF NOT EXISTS tycoon.sessions (
  token        TEXT PRIMARY KEY,
  account_id   UUID NOT NULL REFERENCES tycoon.accounts(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip           TEXT
);

-- A player is an account's presence in one world.
CREATE TABLE IF NOT EXISTS tycoon.players (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id     UUID NOT NULL REFERENCES tycoon.worlds(id),
  account_id   UUID NOT NULL REFERENCES tycoon.accounts(id),
  handle       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (world_id, account_id),
  UNIQUE (world_id, handle)
);

-- A parcel is one real street: all same-named, connected OSM ways merged.
-- Geometry is stored as JSON line parts ([[[lon,lat],...], ...]) so the
-- schema has no PostGIS dependency and runs on any Postgres (incl. PGlite).
CREATE TABLE IF NOT EXISTS tycoon.parcels (
  id                 BIGSERIAL PRIMARY KEY,
  world_id           UUID NOT NULL REFERENCES tycoon.worlds(id),
  name               TEXT NOT NULL,
  suburb             TEXT,
  osm_way_ids        BIGINT[] NOT NULL,
  geom               JSONB NOT NULL,
  c_lon              DOUBLE PRECISION NOT NULL,
  c_lat              DOUBLE PRECISION NOT NULL,
  min_lon            DOUBLE PRECISION NOT NULL,
  min_lat            DOUBLE PRECISION NOT NULL,
  max_lon            DOUBLE PRECISION NOT NULL,
  max_lat            DOUBLE PRECISION NOT NULL,
  length_m           DOUBLE PRECISION NOT NULL CHECK (length_m > 0),
  highway_class      TEXT NOT NULL,
  slots_total        INT NOT NULL CHECK (slots_total >= 1),
  density_weight     NUMERIC NOT NULL,
  land_value         BIGINT NOT NULL CHECK (land_value >= 0),  -- assessed, mutable by tick
  improvement_value  BIGINT NOT NULL DEFAULT 0,                -- derived from improvements
  owner_id           UUID REFERENCES tycoon.players(id),
  acquired_at        TIMESTAMPTZ,
  lease_expires_at   TIMESTAMPTZ,                              -- NULL under freehold
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS parcels_ways_idx  ON tycoon.parcels USING GIN (osm_way_ids);
CREATE INDEX IF NOT EXISTS parcels_box_idx   ON tycoon.parcels
  USING GIST (box(point(min_lon, min_lat), point(max_lon, max_lat)));
CREATE INDEX IF NOT EXISTS parcels_owner_idx ON tycoon.parcels (world_id, owner_id);
CREATE INDEX IF NOT EXISTS parcels_lat_idx   ON tycoon.parcels (world_id, c_lat);
CREATE INDEX IF NOT EXISTS parcels_name_idx  ON tycoon.parcels (world_id, lower(name));

CREATE TABLE IF NOT EXISTS tycoon.building_types (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  cost         BIGINT NOT NULL CHECK (cost > 0),
  slots_used   INT NOT NULL CHECK (slots_used >= 1),
  -- Multiplier (basis points, 10000 = 1x) applied to the ruleset's
  -- income.from_improvements_bp for buildings of this type.
  yield_bp     INT NOT NULL CHECK (yield_bp >= 0),
  sort_order   INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tycoon.improvements (
  id           BIGSERIAL PRIMARY KEY,
  parcel_id    BIGINT NOT NULL REFERENCES tycoon.parcels(id),
  type_id      TEXT NOT NULL REFERENCES tycoon.building_types(id),
  cost         BIGINT NOT NULL,   -- snapshot at build time
  slots_used   INT NOT NULL,      -- snapshot at build time
  slot_index   INT NOT NULL,      -- first slot occupied along the street
  built_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS improvements_parcel_idx ON tycoon.improvements (parcel_id);

CREATE TABLE IF NOT EXISTS tycoon.ticks (
  id               BIGSERIAL PRIMARY KEY,
  world_id         UUID NOT NULL REFERENCES tycoon.worlds(id),
  tick_number      INT NOT NULL,
  ran_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  ruleset_snapshot JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS ticks_world_idx ON tycoon.ticks (world_id, id DESC);

-- Append only. No UPDATE, no DELETE, ever (enforced by trigger below).
-- Balances are always derived from this table.
CREATE TABLE IF NOT EXISTS tycoon.ledger (
  id            BIGSERIAL PRIMARY KEY,
  world_id      UUID NOT NULL REFERENCES tycoon.worlds(id),
  tick_id       BIGINT REFERENCES tycoon.ticks(id),
  from_account  TEXT NOT NULL,   -- 'bank' | 'treasury' | 'player:<uuid>'
  to_account    TEXT NOT NULL,
  amount        BIGINT NOT NULL CHECK (amount > 0),
  reason        TEXT NOT NULL,   -- 'purchase'|'build'|'income:*'|'tax:*'|'loan'|...
  parcel_id     BIGINT REFERENCES tycoon.parcels(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_account <> to_account)
);
CREATE INDEX IF NOT EXISTS ledger_from_idx ON tycoon.ledger (world_id, from_account);
CREATE INDEX IF NOT EXISTS ledger_to_idx   ON tycoon.ledger (world_id, to_account);
CREATE INDEX IF NOT EXISTS ledger_tick_idx ON tycoon.ledger (tick_id);

CREATE OR REPLACE FUNCTION tycoon.ledger_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_is_append_only';
END $$;

DROP TRIGGER IF EXISTS ledger_no_update ON tycoon.ledger;
CREATE TRIGGER ledger_no_update BEFORE UPDATE OR DELETE ON tycoon.ledger
  FOR EACH ROW EXECUTE FUNCTION tycoon.ledger_append_only();
DROP TRIGGER IF EXISTS ledger_no_truncate ON tycoon.ledger;
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON tycoon.ledger
  FOR EACH STATEMENT EXECUTE FUNCTION tycoon.ledger_append_only();

CREATE OR REPLACE VIEW tycoon.balances AS
SELECT world_id, account, SUM(delta)::BIGINT AS balance FROM (
  SELECT world_id, to_account   AS account,  amount AS delta FROM tycoon.ledger
  UNION ALL
  SELECT world_id, from_account AS account, -amount AS delta FROM tycoon.ledger
) t GROUP BY world_id, account;

-- Public activity feed ("alice bought Oxford Street").
CREATE TABLE IF NOT EXISTS tycoon.events (
  id          BIGSERIAL PRIMARY KEY,
  world_id    UUID NOT NULL REFERENCES tycoon.worlds(id),
  player_id   UUID REFERENCES tycoon.players(id),
  kind        TEXT NOT NULL,
  parcel_id   BIGINT REFERENCES tycoon.parcels(id),
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_world_idx ON tycoon.events (world_id, id DESC);
