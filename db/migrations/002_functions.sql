-- =====================================================================
-- Tycoon: core game functions (internal, schema `tycoon`).
-- These are never callable by clients directly; the SECURITY DEFINER
-- wrappers in 003_api.sql authenticate the caller and then call these.
-- =====================================================================

-- Basis-point maths: floor(amount * bp / 10000). The only place the
-- basis-point divisor appears.
CREATE OR REPLACE FUNCTION tycoon.apply_bp(p_amount NUMERIC, p_bp NUMERIC)
RETURNS BIGINT LANGUAGE sql IMMUTABLE AS $$
  SELECT floor(COALESCE(p_amount, 0) * COALESCE(p_bp, 0) / 10000)::BIGINT
$$;

-- Great-circle distance in metres.
CREATE OR REPLACE FUNCTION tycoon.geo_dist_m(lat1 DOUBLE PRECISION, lon1 DOUBLE PRECISION,
                                             lat2 DOUBLE PRECISION, lon2 DOUBLE PRECISION)
RETURNS DOUBLE PRECISION LANGUAGE sql IMMUTABLE AS $$
  SELECT 2 * 6371008.8 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)
  ))
$$;

-- Metres -> degrees of latitude (for cheap bounding-box prefilters).
CREATE OR REPLACE FUNCTION tycoon.metres_to_lat_deg(p_m DOUBLE PRECISION)
RETURNS DOUBLE PRECISION LANGUAGE sql IMMUTABLE AS $$ SELECT p_m / 111320.0 $$;

CREATE OR REPLACE FUNCTION tycoon.world_config(p_world UUID)
RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT r.config FROM tycoon.worlds w JOIN tycoon.rulesets r ON r.id = w.ruleset_id
  WHERE w.id = p_world
$$;

CREATE OR REPLACE FUNCTION tycoon.balance_of(p_world UUID, p_account TEXT)
RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT (COALESCE((SELECT SUM(amount) FROM tycoon.ledger
                    WHERE world_id = p_world AND to_account = p_account), 0)
        - COALESCE((SELECT SUM(amount) FROM tycoon.ledger
                    WHERE world_id = p_world AND from_account = p_account), 0))::BIGINT
$$;

CREATE OR REPLACE FUNCTION tycoon.player_account(p_player UUID)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT 'player:' || p_player::TEXT $$;

-- Outstanding starting loan = loans issued - repayments.
CREATE OR REPLACE FUNCTION tycoon.loan_outstanding(p_world UUID, p_player UUID)
RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT (COALESCE((SELECT SUM(amount) FROM tycoon.ledger
                    WHERE world_id = p_world AND to_account = tycoon.player_account(p_player)
                      AND reason = 'loan'), 0)
        - COALESCE((SELECT SUM(amount) FROM tycoon.ledger
                    WHERE world_id = p_world AND from_account = tycoon.player_account(p_player)
                      AND reason = 'loan_repayment'), 0))::BIGINT
$$;

-- ---------------------------------------------------------------------
-- Whitelisted expression compiler.
-- Turns a ruleset formula such as "land_value + improvement_value" into a
-- SQL fragment over the per-parcel variables relation `v`. Only allowed
-- identifiers, numeric literals, + - * / and parentheses are accepted;
-- anything else raises. Tokens are re-emitted separated by spaces, so no
-- token sequence can form a comment or any other SQL syntax.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tycoon.compile_expr(p_expr TEXT, p_allowed TEXT[])
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  rest TEXT := COALESCE(p_expr, '');
  tok TEXT;
  out TEXT := '';
  expect_operand BOOLEAN := true;
  depth INT := 0;
BEGIN
  IF length(rest) > 500 THEN
    RAISE EXCEPTION 'expr_too_long';
  END IF;
  LOOP
    rest := regexp_replace(rest, '^\s+', '');
    EXIT WHEN rest = '';
    tok := substring(rest FROM '^[A-Za-z_][A-Za-z0-9_]*');
    IF tok IS NOT NULL THEN
      IF NOT expect_operand THEN RAISE EXCEPTION 'expr_syntax: unexpected %', tok; END IF;
      IF NOT (tok = ANY (p_allowed)) THEN
        RAISE EXCEPTION 'expr_identifier_not_allowed: %', tok;
      END IF;
      out := out || ' v.' || tok;
      expect_operand := false;
    ELSE
      tok := substring(rest FROM '^[0-9]+(?:\.[0-9]+)?');
      IF tok IS NOT NULL THEN
        IF NOT expect_operand THEN RAISE EXCEPTION 'expr_syntax: unexpected %', tok; END IF;
        out := out || ' ' || tok || '::numeric';
        expect_operand := false;
      ELSE
        tok := substr(rest, 1, 1);
        IF tok = '(' THEN
          IF NOT expect_operand THEN RAISE EXCEPTION 'expr_syntax: unexpected ('; END IF;
          depth := depth + 1;
          out := out || ' (';
        ELSIF tok = ')' THEN
          IF expect_operand OR depth = 0 THEN RAISE EXCEPTION 'expr_syntax: unexpected )'; END IF;
          depth := depth - 1;
          out := out || ' )';
        ELSIF tok IN ('+', '-') THEN
          out := out || ' ' || tok;      -- binary, or unary when an operand is expected
          expect_operand := true;
        ELSIF tok IN ('*', '/') THEN
          IF expect_operand THEN RAISE EXCEPTION 'expr_syntax: unexpected %', tok; END IF;
          out := out || ' ' || tok;
          expect_operand := true;
        ELSE
          RAISE EXCEPTION 'expr_invalid_character: %', tok;
        END IF;
      END IF;
    END IF;
    rest := substr(rest, length(tok) + 1);
  END LOOP;
  IF expect_operand OR depth <> 0 THEN
    RAISE EXCEPTION 'expr_syntax: incomplete expression';
  END IF;
  RETURN '(' || out || ' )';
END $$;

-- Which identifiers each kind of formula may use.
CREATE OR REPLACE FUNCTION tycoon.vars_land_base() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS
$$ SELECT ARRAY['length_m','class_weight','density_weight','slots_total'] $$;
CREATE OR REPLACE FUNCTION tycoon.vars_tick_tax() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS
$$ SELECT ARRAY['land_value','improvement_value','length_m','class_weight','density_weight',
                'slots_used','slots_total'] $$;
CREATE OR REPLACE FUNCTION tycoon.vars_purchase_tax() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS
$$ SELECT ARRAY['land_value','improvement_value','length_m','class_weight','density_weight',
                'slots_used','slots_total','sale_price'] $$;

-- Per-parcel variables that formulas are evaluated against.
CREATE OR REPLACE FUNCTION tycoon.parcel_vars(p_world UUID, p_cfg JSONB)
RETURNS TABLE (id BIGINT, owner_id UUID, land_value NUMERIC, improvement_value NUMERIC,
               length_m NUMERIC, class_weight NUMERIC, density_weight NUMERIC,
               slots_used NUMERIC, slots_total NUMERIC, sale_price NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT p.id, p.owner_id,
         p.land_value::NUMERIC, p.improvement_value::NUMERIC, p.length_m::NUMERIC,
         (p_cfg -> 'valuation' -> 'class_weights' ->> p.highway_class)::NUMERIC,
         p.density_weight,
         COALESCE(u.used, 0)::NUMERIC, p.slots_total::NUMERIC,
         (p.land_value + p.improvement_value)::NUMERIC
  FROM tycoon.parcels p
  LEFT JOIN LATERAL (SELECT SUM(i.slots_used) AS used FROM tycoon.improvements i
                     WHERE i.parcel_id = p.id) u ON true
  WHERE p.world_id = p_world
$$;

-- Evaluate a formula for a single parcel.
CREATE OR REPLACE FUNCTION tycoon.eval_parcel_expr(p_world UUID, p_cfg JSONB, p_expr TEXT,
                                                   p_allowed TEXT[], p_parcel BIGINT)
RETURNS NUMERIC LANGUAGE plpgsql STABLE AS $$
DECLARE r NUMERIC;
BEGIN
  EXECUTE format('SELECT %s FROM tycoon.parcel_vars($1, $2) v WHERE v.id = $3',
                 tycoon.compile_expr(p_expr, p_allowed))
    INTO r USING p_world, p_cfg, p_parcel;
  RETURN r;
END $$;

-- Tax owed per parcel for one configured tax.
CREATE OR REPLACE FUNCTION tycoon.tax_rows(p_world UUID, p_cfg JSONB, p_tax JSONB, p_allowed TEXT[])
RETURNS TABLE (parcel_id BIGINT, owner_id UUID, base NUMERIC, amount BIGINT)
LANGUAGE plpgsql STABLE AS $$
DECLARE e TEXT := tycoon.compile_expr(p_tax ->> 'base', p_allowed);
BEGIN
  RETURN QUERY EXECUTE format(
    'SELECT v.id, v.owner_id, %1$s, tycoon.apply_bp(GREATEST(%1$s, 0), $3) '
    'FROM tycoon.parcel_vars($1, $2) v', e)
    USING p_world, p_cfg, (p_tax ->> 'rate_bp')::NUMERIC;
END $$;

-- Income owed per parcel.
CREATE OR REPLACE FUNCTION tycoon.income_rows(p_world UUID, p_cfg JSONB)
RETURNS TABLE (parcel_id BIGINT, owner_id UUID, income_land BIGINT, income_improvements BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT p.id, p.owner_id,
         tycoon.apply_bp(p.land_value, (p_cfg -> 'income' ->> 'from_land_bp')::NUMERIC),
         COALESCE((SELECT SUM(tycoon.apply_bp(tycoon.apply_bp(i.cost, bt.yield_bp),
                                              (p_cfg -> 'income' ->> 'from_improvements_bp')::NUMERIC))
                   FROM tycoon.improvements i JOIN tycoon.building_types bt ON bt.id = i.type_id
                   WHERE i.parcel_id = p.id), 0)::BIGINT
  FROM tycoon.parcels p
  WHERE p.world_id = p_world
$$;

-- Vacancy penalty per parcel (charged on land_value when nothing is built).
CREATE OR REPLACE FUNCTION tycoon.vacancy_rows(p_world UUID, p_cfg JSONB)
RETURNS TABLE (parcel_id BIGINT, owner_id UUID, amount BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT v.id, v.owner_id,
         tycoon.apply_bp(v.land_value, COALESCE((p_cfg ->> 'vacancy_penalty_bp')::NUMERIC, 0))
  FROM tycoon.parcel_vars(p_world, p_cfg) v
  WHERE v.slots_used = 0
$$;

-- Density weight for a location: grows with the number of parcels nearby.
CREATE OR REPLACE FUNCTION tycoon.density_for(p_world UUID, p_cfg JSONB, p_lat DOUBLE PRECISION,
                                              p_lon DOUBLE PRECISION, p_exclude BIGINT)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  WITH d AS (SELECT p_cfg -> 'valuation' -> 'density' AS c)
  SELECT LEAST((d.c ->> 'max')::NUMERIC,
               (d.c ->> 'base')::NUMERIC + (d.c ->> 'per_neighbour')::NUMERIC * (
                 SELECT count(*) FROM tycoon.parcels b
                 WHERE b.world_id = p_world
                   AND b.id IS DISTINCT FROM p_exclude
                   AND b.c_lat BETWEEN p_lat - tycoon.metres_to_lat_deg((d.c ->> 'radius_m')::FLOAT8)
                                   AND p_lat + tycoon.metres_to_lat_deg((d.c ->> 'radius_m')::FLOAT8)
                   AND tycoon.geo_dist_m(p_lat, p_lon, b.c_lat, b.c_lon) <= (d.c ->> 'radius_m')::FLOAT8))
  FROM d
$$;

-- Recompute density and land value for every parcel in a world.
CREATE OR REPLACE FUNCTION tycoon.reassess_values(p_world UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE cfg JSONB := tycoon.world_config(p_world);
BEGIN
  UPDATE tycoon.parcels p
     SET density_weight = tycoon.density_for(p_world, cfg, p.c_lat, p.c_lon, p.id)
   WHERE p.world_id = p_world;
  EXECUTE format(
    'UPDATE tycoon.parcels p SET land_value = GREATEST(round(%s), 0)::BIGINT '
    'FROM tycoon.parcel_vars($1, $2) v WHERE v.id = p.id',
    tycoon.compile_expr(cfg -> 'valuation' ->> 'land_base', tycoon.vars_land_base()))
    USING p_world, cfg;
END $$;

-- ---------------------------------------------------------------------
-- The tick. Set-based SQL only; every rate comes from the ruleset.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tycoon.run_tick(p_world UUID)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  cfg JSONB;
  v_tick BIGINT;
  v_n INT;
  v_every INT;
  t JSONB;
BEGIN
  SELECT r.config INTO cfg
    FROM tycoon.worlds w JOIN tycoon.rulesets r ON r.id = w.ruleset_id
   WHERE w.id = p_world
     FOR UPDATE OF w;
  IF cfg IS NULL THEN RAISE EXCEPTION 'world_not_found'; END IF;

  -- 1. Record the tick with a snapshot of the ruleset.
  UPDATE tycoon.worlds SET tick_count = tick_count + 1 WHERE id = p_world
  RETURNING tick_count INTO v_n;
  INSERT INTO tycoon.ticks (world_id, tick_number, ruleset_snapshot)
  VALUES (p_world, v_n, cfg) RETURNING id INTO v_tick;

  -- 2. improvement_value = SUM(improvements.cost)
  UPDATE tycoon.parcels p SET improvement_value = s.total
    FROM (SELECT q.id, COALESCE((SELECT SUM(i.cost) FROM tycoon.improvements i
                                 WHERE i.parcel_id = q.id), 0)::BIGINT AS total
            FROM tycoon.parcels q WHERE q.world_id = p_world) s
   WHERE p.id = s.id AND p.improvement_value <> s.total;

  -- 3. Periodic reassessment.
  v_every := (cfg -> 'valuation' ->> 'reassess_every_ticks')::INT;
  IF v_every > 0 AND v_n % v_every = 0 THEN
    PERFORM tycoon.reassess_values(p_world);
  END IF;

  -- 4. Income: bank -> player, aggregated per player and per source.
  INSERT INTO tycoon.ledger (world_id, tick_id, from_account, to_account, amount, reason)
  SELECT p_world, v_tick, 'bank', tycoon.player_account(x.owner_id), x.amount, x.reason
    FROM (SELECT r.owner_id, 'income:land' AS reason, SUM(r.income_land)::BIGINT AS amount
            FROM tycoon.income_rows(p_world, cfg) r WHERE r.owner_id IS NOT NULL GROUP BY r.owner_id
          UNION ALL
          SELECT r.owner_id, 'income:improvements', SUM(r.income_improvements)::BIGINT
            FROM tycoon.income_rows(p_world, cfg) r WHERE r.owner_id IS NOT NULL GROUP BY r.owner_id) x
   WHERE x.amount > 0;

  -- 5. Taxes: player -> treasury, one INSERT ... SELECT per configured tax.
  FOR t IN SELECT value FROM jsonb_array_elements(COALESCE(cfg -> 'taxes', '[]'::JSONB))
            WHERE COALESCE(value ->> 'on', 'tick') = 'tick' LOOP
    INSERT INTO tycoon.ledger (world_id, tick_id, from_account, to_account, amount, reason)
    SELECT p_world, v_tick, tycoon.player_account(r.owner_id), 'treasury', SUM(r.amount)::BIGINT,
           'tax:' || (t ->> 'id')
      FROM tycoon.tax_rows(p_world, cfg, t, tycoon.vars_tick_tax()) r
     WHERE r.owner_id IS NOT NULL
     GROUP BY r.owner_id
    HAVING SUM(r.amount) > 0;
  END LOOP;

  INSERT INTO tycoon.ledger (world_id, tick_id, from_account, to_account, amount, reason)
  SELECT p_world, v_tick, tycoon.player_account(r.owner_id), 'treasury', SUM(r.amount)::BIGINT,
         'tax:vacancy'
    FROM tycoon.vacancy_rows(p_world, cfg) r
   WHERE r.owner_id IS NOT NULL
   GROUP BY r.owner_id
  HAVING SUM(r.amount) > 0;

  -- 6. Leasehold expiry.
  IF cfg -> 'tenure' ->> 'type' = 'leasehold' THEN
    INSERT INTO tycoon.events (world_id, player_id, kind, parcel_id)
    SELECT world_id, owner_id, 'lease_expired', id FROM tycoon.parcels
     WHERE world_id = p_world AND owner_id IS NOT NULL AND lease_expires_at < now();
    UPDATE tycoon.parcels SET owner_id = NULL, acquired_at = NULL, lease_expires_at = NULL
     WHERE world_id = p_world AND owner_id IS NOT NULL AND lease_expires_at < now();
  END IF;

  RETURN v_tick;
END $$;

-- Dispatcher: runs whichever worlds are due, based on each ruleset's own
-- cadence. Called by pg_cron every minute and lazily by player requests.
CREATE OR REPLACE FUNCTION tycoon.run_due_ticks()
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  w RECORD;
  n INT := 0;
  k INT;
  iv INTERVAL;
  cap INT;
BEGIN
  FOR w IN SELECT wo.id, r.config FROM tycoon.worlds wo
             JOIN tycoon.rulesets r ON r.id = wo.ruleset_id
            WHERE wo.status = 'running' AND wo.next_tick_at <= now()
              FOR UPDATE OF wo SKIP LOCKED LOOP
    iv := (w.config -> 'tick' ->> 'interval')::INTERVAL;
    cap := COALESCE((w.config -> 'tick' ->> 'max_catch_up')::INT, 1);
    k := 0;
    WHILE k < cap AND (SELECT next_tick_at FROM tycoon.worlds WHERE id = w.id) <= now() LOOP
      PERFORM tycoon.run_tick(w.id);
      UPDATE tycoon.worlds SET next_tick_at = next_tick_at + iv WHERE id = w.id;
      k := k + 1;
    END LOOP;
    -- Too far behind: skip ahead rather than replaying days of ticks.
    UPDATE tycoon.worlds SET next_tick_at = now() + iv WHERE id = w.id AND next_tick_at <= now();
    n := n + k;
  END LOOP;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------
-- Player actions. Every one locks the player row first (so one player
-- can't overspend with parallel requests), then the parcel row.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tycoon.lock_player(p_player UUID)
RETURNS tycoon.players LANGUAGE plpgsql AS $$
DECLARE pl tycoon.players;
BEGIN
  SELECT * INTO pl FROM tycoon.players WHERE id = p_player FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;
  RETURN pl;
END $$;

CREATE OR REPLACE FUNCTION tycoon.join_world(p_account UUID, p_world UUID)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE
  v_id UUID;
  v_handle TEXT;
  cfg JSONB := tycoon.world_config(p_world);
BEGIN
  IF cfg IS NULL THEN RAISE EXCEPTION 'world_not_found'; END IF;
  SELECT id INTO v_id FROM tycoon.players WHERE world_id = p_world AND account_id = p_account;
  IF FOUND THEN RETURN v_id; END IF;
  SELECT username INTO v_handle FROM tycoon.accounts WHERE id = p_account;
  INSERT INTO tycoon.players (world_id, account_id, handle)
  VALUES (p_world, p_account, v_handle)
  ON CONFLICT DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM tycoon.players WHERE world_id = p_world AND account_id = p_account;
    RETURN v_id;
  END IF;
  -- Starting capital is a repayable loan recorded in the ledger, not a grant.
  IF (cfg ->> 'starting_loan')::BIGINT > 0 THEN
    INSERT INTO tycoon.ledger (world_id, from_account, to_account, amount, reason)
    VALUES (p_world, 'bank', tycoon.player_account(v_id), (cfg ->> 'starting_loan')::BIGINT, 'loan');
  END IF;
  INSERT INTO tycoon.events (world_id, player_id, kind) VALUES (p_world, v_id, 'joined');
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION tycoon.purchase_parcel(p_player UUID, p_parcel BIGINT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  pl tycoon.players := tycoon.lock_player(p_player);
  p tycoon.parcels;
  cfg JSONB;
  price BIGINT;
  t JSONB;
  taxes JSONB := '[]'::JSONB;
  total_tax BIGINT := 0;
  amt BIGINT;
  acct TEXT := tycoon.player_account(p_player);
BEGIN
  SELECT * INTO p FROM tycoon.parcels WHERE id = p_parcel FOR UPDATE;   -- lock first
  IF NOT FOUND THEN RAISE EXCEPTION 'parcel_not_found'; END IF;
  IF p.world_id <> pl.world_id THEN RAISE EXCEPTION 'wrong_world'; END IF;
  IF p.owner_id IS NOT NULL THEN RAISE EXCEPTION 'parcel_already_owned'; END IF;
  cfg := tycoon.world_config(p.world_id);
  price := p.land_value + p.improvement_value;

  FOR t IN SELECT value FROM jsonb_array_elements(COALESCE(cfg -> 'taxes', '[]'::JSONB))
            WHERE value ->> 'on' = 'purchase' LOOP
    amt := tycoon.apply_bp(GREATEST(tycoon.eval_parcel_expr(p.world_id, cfg, t ->> 'base',
                                    tycoon.vars_purchase_tax(), p.id), 0),
                           (t ->> 'rate_bp')::NUMERIC);
    taxes := taxes || jsonb_build_object('id', t ->> 'id', 'amount', amt);
    total_tax := total_tax + amt;
  END LOOP;

  IF tycoon.balance_of(p.world_id, acct) < price + total_tax THEN
    RAISE EXCEPTION 'insufficient_funds';
  END IF;

  IF price > 0 THEN
    INSERT INTO tycoon.ledger (world_id, from_account, to_account, amount, reason, parcel_id)
    VALUES (p.world_id, acct, 'bank', price, 'purchase', p.id);
  END IF;
  INSERT INTO tycoon.ledger (world_id, from_account, to_account, amount, reason, parcel_id)
  SELECT p.world_id, acct, 'treasury', (x ->> 'amount')::BIGINT, 'tax:' || (x ->> 'id'), p.id
    FROM jsonb_array_elements(taxes) x WHERE (x ->> 'amount')::BIGINT > 0;

  UPDATE tycoon.parcels
     SET owner_id = p_player, acquired_at = now(),
         lease_expires_at = CASE WHEN cfg -> 'tenure' ->> 'type' = 'leasehold'
           THEN now() + ((cfg ->> 'lease_term_ticks')::INT * (cfg -> 'tick' ->> 'interval')::INTERVAL)
           END
   WHERE id = p.id;

  INSERT INTO tycoon.events (world_id, player_id, kind, parcel_id, data)
  VALUES (p.world_id, p_player, 'purchase', p.id, jsonb_build_object('price', price));
  RETURN tycoon.balance_of(p.world_id, acct);
END $$;

-- p_slot: the plot to build on (optional). Without one, the free run of
-- plots closest to the middle of the street is used.
DROP FUNCTION IF EXISTS tycoon.build_improvement(UUID, BIGINT, TEXT);
CREATE OR REPLACE FUNCTION tycoon.build_improvement(p_player UUID, p_parcel BIGINT, p_type TEXT,
                                                    p_slot INT DEFAULT NULL)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  pl tycoon.players := tycoon.lock_player(p_player);
  p tycoon.parcels;
  bt tycoon.building_types;
  v_slot INT;
  acct TEXT := tycoon.player_account(p_player);
BEGIN
  SELECT * INTO p FROM tycoon.parcels WHERE id = p_parcel FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'parcel_not_found'; END IF;
  IF p.world_id <> pl.world_id THEN RAISE EXCEPTION 'wrong_world'; END IF;
  IF p.owner_id IS DISTINCT FROM p_player THEN RAISE EXCEPTION 'not_owner'; END IF;
  SELECT * INTO bt FROM tycoon.building_types WHERE id = p_type;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_building_type'; END IF;

  -- A run of free consecutive plots big enough for this building: the one
  -- requested, or else the one nearest the middle of the street.
  SELECT s INTO v_slot
    FROM generate_series(0, p.slots_total - bt.slots_used) s
   WHERE NOT EXISTS (SELECT 1 FROM tycoon.improvements i
                      WHERE i.parcel_id = p.id
                        AND i.slot_index < s + bt.slots_used
                        AND s < i.slot_index + i.slots_used)
     AND (p_slot IS NULL OR p_slot BETWEEN s AND s + bt.slots_used - 1)
   ORDER BY CASE WHEN p_slot IS NULL THEN abs(2 * s + bt.slots_used - p.slots_total) ELSE abs(s - p_slot) END, s
   LIMIT 1;
  IF v_slot IS NULL THEN
    RAISE EXCEPTION '%', CASE WHEN p_slot IS NULL THEN 'no_free_slots' ELSE 'plot_taken' END;
  END IF;

  IF tycoon.balance_of(p.world_id, acct) < bt.cost THEN
    RAISE EXCEPTION 'insufficient_funds';
  END IF;

  INSERT INTO tycoon.ledger (world_id, from_account, to_account, amount, reason, parcel_id)
  VALUES (p.world_id, acct, 'bank', bt.cost, 'build', p.id);
  INSERT INTO tycoon.improvements (parcel_id, type_id, cost, slots_used, slot_index)
  VALUES (p.id, bt.id, bt.cost, bt.slots_used, v_slot);
  UPDATE tycoon.parcels SET improvement_value = improvement_value + bt.cost WHERE id = p.id;

  INSERT INTO tycoon.events (world_id, player_id, kind, parcel_id, data)
  VALUES (p.world_id, p_player, 'build', p.id, jsonb_build_object('type_id', bt.id));
  RETURN tycoon.balance_of(p.world_id, acct);
END $$;

CREATE OR REPLACE FUNCTION tycoon.demolish_improvement(p_player UUID, p_improvement BIGINT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  pl tycoon.players := tycoon.lock_player(p_player);
  imp tycoon.improvements;
  p tycoon.parcels;
BEGIN
  SELECT * INTO imp FROM tycoon.improvements WHERE id = p_improvement;
  IF NOT FOUND THEN RAISE EXCEPTION 'improvement_not_found'; END IF;
  SELECT * INTO p FROM tycoon.parcels WHERE id = imp.parcel_id FOR UPDATE;
  IF p.world_id <> pl.world_id THEN RAISE EXCEPTION 'wrong_world'; END IF;
  IF p.owner_id IS DISTINCT FROM p_player THEN RAISE EXCEPTION 'not_owner'; END IF;
  DELETE FROM tycoon.improvements WHERE id = imp.id;
  UPDATE tycoon.parcels SET improvement_value = GREATEST(improvement_value - imp.cost, 0) WHERE id = p.id;
  INSERT INTO tycoon.events (world_id, player_id, kind, parcel_id, data)
  VALUES (p.world_id, p_player, 'demolish', p.id, jsonb_build_object('type_id', imp.type_id));
  RETURN tycoon.balance_of(p.world_id, tycoon.player_account(p_player));
END $$;

-- Hand a street back to the bank. No money changes hands: the only ways
-- money ever reaches a player are the starting loan and tick income.
CREATE OR REPLACE FUNCTION tycoon.release_parcel(p_player UUID, p_parcel BIGINT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  pl tycoon.players := tycoon.lock_player(p_player);
  p tycoon.parcels;
BEGIN
  SELECT * INTO p FROM tycoon.parcels WHERE id = p_parcel FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'parcel_not_found'; END IF;
  IF p.world_id <> pl.world_id THEN RAISE EXCEPTION 'wrong_world'; END IF;
  IF p.owner_id IS DISTINCT FROM p_player THEN RAISE EXCEPTION 'not_owner'; END IF;
  UPDATE tycoon.parcels SET owner_id = NULL, acquired_at = NULL, lease_expires_at = NULL
   WHERE id = p.id;
  INSERT INTO tycoon.events (world_id, player_id, kind, parcel_id)
  VALUES (p.world_id, p_player, 'release', p.id);
  RETURN tycoon.balance_of(p.world_id, tycoon.player_account(p_player));
END $$;

CREATE OR REPLACE FUNCTION tycoon.repay_loan(p_player UUID, p_amount BIGINT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  pl tycoon.players := tycoon.lock_player(p_player);
  acct TEXT := tycoon.player_account(p_player);
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'invalid_amount'; END IF;
  IF p_amount > tycoon.loan_outstanding(pl.world_id, p_player) THEN
    RAISE EXCEPTION 'amount_exceeds_loan';
  END IF;
  IF p_amount > tycoon.balance_of(pl.world_id, acct) THEN RAISE EXCEPTION 'insufficient_funds'; END IF;
  INSERT INTO tycoon.ledger (world_id, from_account, to_account, amount, reason)
  VALUES (pl.world_id, acct, 'bank', p_amount, 'loan_repayment');
  RETURN tycoon.balance_of(pl.world_id, acct);
END $$;

-- ---------------------------------------------------------------------
-- Street claiming. The browser reads a street's name and shape from the
-- map tiles and submits it; the server validates it, computes length,
-- slots and land value itself, and creates the parcel. A street is
-- identified by its name plus where it is: the same name within ~150 m of
-- an existing parcel resolves to that parcel, so clicking anywhere along a
-- street always gives the same one.
-- p_lines: [[[lon,lat], ...], ...]
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS tycoon.claim_parcel(UUID, TEXT, TEXT, BIGINT, JSONB);
CREATE OR REPLACE FUNCTION tycoon.claim_parcel(p_world UUID, p_name TEXT, p_suburb TEXT,
                                               p_highway TEXT, p_lines JSONB)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  cfg JSONB := tycoon.world_config(p_world);
  v_id BIGINT;
  v_geom JSONB;
  v_len DOUBLE PRECISION;
  c RECORD;
  v_pad DOUBLE PRECISION;
  v_slots INT;
  v_land NUMERIC;
BEGIN
  IF cfg IS NULL THEN RAISE EXCEPTION 'world_not_found'; END IF;
  p_name := btrim(p_name);
  IF p_name IS NULL OR p_name = '' OR length(p_name) > 200 THEN RAISE EXCEPTION 'invalid_name'; END IF;
  IF p_suburb IS NOT NULL AND length(p_suburb) > 200 THEN p_suburb := left(p_suburb, 200); END IF;
  IF p_highway IS NULL OR NOT ((cfg -> 'valuation' -> 'class_weights') ? p_highway) THEN
    RAISE EXCEPTION 'street_not_claimable';
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0
     OR jsonb_array_length(p_lines) > 500 THEN
    RAISE EXCEPTION 'invalid_geometry';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _claim_pts (line INT, ord INT, lon FLOAT8, lat FLOAT8) ON COMMIT DROP;
  TRUNCATE _claim_pts;
  INSERT INTO _claim_pts
  SELECT l.idx::INT, pt.ord::INT, (pt.v ->> 0)::FLOAT8, (pt.v ->> 1)::FLOAT8
    FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS l(v, idx)
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.v) = 'array' THEN l.v ELSE '[]'::JSONB END)
         WITH ORDINALITY AS pt(v, ord);

  IF (SELECT count(*) FROM _claim_pts) > 20000
     OR EXISTS (SELECT 1 FROM _claim_pts WHERE lon IS NULL OR lat IS NULL
                  OR lon NOT BETWEEN -180 AND 180 OR lat NOT BETWEEN -85 AND 85) THEN
    RAISE EXCEPTION 'invalid_geometry';
  END IF;
  -- Drop parts with fewer than two points.
  DELETE FROM _claim_pts WHERE line IN (SELECT line FROM _claim_pts GROUP BY line HAVING count(*) < 2);

  SELECT SUM(seg) INTO v_len FROM (
    SELECT tycoon.geo_dist_m(lag(lat) OVER w, lag(lon) OVER w, lat, lon) AS seg
      FROM _claim_pts WINDOW w AS (PARTITION BY line ORDER BY ord)) s;
  IF v_len IS NULL OR v_len <= 0 THEN RAISE EXCEPTION 'invalid_geometry'; END IF;
  IF v_len > 50000 THEN RAISE EXCEPTION 'street_too_long'; END IF;

  SELECT avg(lon) AS c_lon, avg(lat) AS c_lat, min(lon) AS min_lon, min(lat) AS min_lat,
         max(lon) AS max_lon, max(lat) AS max_lat
    INTO c FROM _claim_pts;

  -- Serialise claims within a world so one street is never created twice.
  PERFORM pg_advisory_xact_lock(hashtext('tycoon-claim'), hashtext(p_world::TEXT));

  v_pad := tycoon.metres_to_lat_deg(150);
  SELECT q.id INTO v_id FROM tycoon.parcels q
   WHERE q.world_id = p_world
     AND lower(q.name) = lower(p_name)
     AND box(point(q.min_lon, q.min_lat), point(q.max_lon, q.max_lat))
         && box(point(c.min_lon - v_pad / cos(radians(c.c_lat)), c.min_lat - v_pad),
                point(c.max_lon + v_pad / cos(radians(c.c_lat)), c.max_lat + v_pad))
   ORDER BY tycoon.geo_dist_m(q.c_lat, q.c_lon, c.c_lat, c.c_lon)
   LIMIT 1;
  IF FOUND THEN RETURN v_id; END IF;

  SELECT jsonb_agg(line ORDER BY l) INTO v_geom FROM (
    SELECT line AS l, jsonb_agg(jsonb_build_array(lon, lat) ORDER BY ord) AS line
      FROM _claim_pts GROUP BY line) x;

  v_slots := LEAST((cfg -> 'slots' ->> 'max')::INT,
                   GREATEST((cfg -> 'slots' ->> 'min')::INT,
                            floor(v_len / (cfg -> 'slots' ->> 'metres_per_slot')::FLOAT8)::INT));

  INSERT INTO tycoon.parcels (world_id, name, suburb, osm_way_ids, geom, c_lon, c_lat,
                              min_lon, min_lat, max_lon, max_lat, length_m, highway_class,
                              slots_total, density_weight, land_value)
  VALUES (p_world, p_name, NULLIF(btrim(p_suburb), ''), NULL, v_geom, c.c_lon, c.c_lat,
          c.min_lon, c.min_lat, c.max_lon, c.max_lat, v_len, p_highway, v_slots,
          tycoon.density_for(p_world, cfg, c.c_lat, c.c_lon, NULL), 0)
  RETURNING id INTO v_id;

  v_land := tycoon.eval_parcel_expr(p_world, cfg, cfg -> 'valuation' ->> 'land_base',
                                    tycoon.vars_land_base(), v_id);
  UPDATE tycoon.parcels SET land_value = GREATEST(round(v_land), 0)::BIGINT WHERE id = v_id;
  RETURN v_id;
END $$;
