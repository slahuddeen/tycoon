-- =====================================================================
-- Tycoon: public API.
-- Every function here takes one JSON argument `p` and returns JSON, so the
-- browser can call them identically over Supabase's REST endpoint
-- (POST /rest/v1/rpc/tycoon_xxx {"p": {...}}) or against an in-browser
-- PGlite database (SELECT public.tycoon_xxx($1)).
-- All are SECURITY DEFINER: they authenticate the caller from a session
-- token and then call the internal functions in schema `tycoon`.
-- =====================================================================

-- Best-effort client IP from the HTTP headers PostgREST exposes.
CREATE OR REPLACE FUNCTION tycoon.request_ip()
RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE h JSON;
BEGIN
  h := NULLIF(current_setting('request.headers', true), '')::JSON;
  IF h IS NULL THEN RETURN NULL; END IF;
  RETURN COALESCE(NULLIF(btrim(split_part(h ->> 'x-forwarded-for', ',', 1)), ''),
                  h ->> 'cf-connecting-ip', h ->> 'x-real-ip');
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION tycoon.new_session(p_account UUID, p_ip TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_token TEXT := encode(extensions.gen_random_bytes(24), 'hex');
BEGIN
  INSERT INTO tycoon.sessions (token, account_id, ip) VALUES (v_token, p_account, p_ip);
  RETURN jsonb_build_object('token', v_token, 'account',
    (SELECT jsonb_build_object('id', a.id, 'username', a.username) FROM tycoon.accounts a
      WHERE a.id = p_account));
END $$;

CREATE OR REPLACE FUNCTION tycoon.auth_account(p JSONB)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v UUID;
BEGIN
  UPDATE tycoon.sessions SET last_seen_at = now()
   WHERE token = p ->> 'token' AND last_seen_at > now() - INTERVAL '30 days'
  RETURNING account_id INTO v;
  IF v IS NULL THEN RAISE EXCEPTION 'not_logged_in'; END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION tycoon.auth_player(p JSONB)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v UUID; a UUID := tycoon.auth_account(p);
BEGIN
  UPDATE tycoon.players SET last_seen_at = now()
   WHERE account_id = a AND world_id = (p ->> 'world_id')::UUID
  RETURNING id INTO v;
  IF v IS NULL THEN RAISE EXCEPTION 'not_joined'; END IF;
  RETURN v;
END $$;

-- Everything the side panel needs about one street, including what it
-- would earn and pay per tick under this world's ruleset.
CREATE OR REPLACE FUNCTION tycoon.parcel_json(p_id BIGINT, p_detail BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  p tycoon.parcels;
  cfg JSONB;
  j JSONB;
  inc RECORD;
  t JSONB;
  taxes JSONB := '[]'::JSONB;
  ptaxes JSONB := '[]'::JSONB;
  amt BIGINT;
  base NUMERIC;
  vac BIGINT;
BEGIN
  SELECT * INTO p FROM tycoon.parcels WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  j := jsonb_build_object(
    'id', p.id, 'name', p.name, 'suburb', p.suburb, 'highway_class', p.highway_class,
    'length_m', round(p.length_m::NUMERIC, 1), 'slots_total', p.slots_total,
    'slots_used', COALESCE((SELECT SUM(slots_used) FROM tycoon.improvements WHERE parcel_id = p.id), 0),
    'land_value', p.land_value, 'improvement_value', p.improvement_value,
    'price', p.land_value + p.improvement_value,
    'owner_id', p.owner_id,
    'owner_handle', (SELECT handle FROM tycoon.players WHERE id = p.owner_id),
    'acquired_at', p.acquired_at, 'lease_expires_at', p.lease_expires_at,
    'c_lon', p.c_lon, 'c_lat', p.c_lat, 'geom', p.geom,
    'improvements', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', i.id, 'type_id', i.type_id, 'slot_index', i.slot_index,
        'slots_used', i.slots_used, 'cost', i.cost, 'built_at', i.built_at) ORDER BY i.slot_index)
      FROM tycoon.improvements i WHERE i.parcel_id = p.id), '[]'::JSONB));
  IF NOT p_detail THEN RETURN j; END IF;

  cfg := tycoon.world_config(p.world_id);
  SELECT * INTO inc FROM tycoon.income_rows(p.world_id, cfg) r WHERE r.parcel_id = p.id;
  FOR t IN SELECT value FROM jsonb_array_elements(COALESCE(cfg -> 'taxes', '[]'::JSONB)) LOOP
    IF t ->> 'on' = 'purchase' THEN
      base := tycoon.eval_parcel_expr(p.world_id, cfg, t ->> 'base', tycoon.vars_purchase_tax(), p.id);
      amt := tycoon.apply_bp(GREATEST(base, 0), (t ->> 'rate_bp')::NUMERIC);
      ptaxes := ptaxes || jsonb_build_object('id', t ->> 'id', 'base_expr', t ->> 'base',
                  'base', round(base), 'rate_bp', (t ->> 'rate_bp')::INT, 'amount', amt);
    ELSE
      SELECT r.base, r.amount INTO base, amt
        FROM tycoon.tax_rows(p.world_id, cfg, t, tycoon.vars_tick_tax()) r WHERE r.parcel_id = p.id;
      taxes := taxes || jsonb_build_object('id', t ->> 'id', 'base_expr', t ->> 'base',
                 'base', round(base), 'rate_bp', (t ->> 'rate_bp')::INT, 'amount', amt);
    END IF;
  END LOOP;
  SELECT r.amount INTO vac FROM tycoon.vacancy_rows(p.world_id, cfg) r WHERE r.parcel_id = p.id;
  IF COALESCE(vac, 0) > 0 THEN
    taxes := taxes || jsonb_build_object('id', 'vacancy', 'base_expr', 'land_value (when nothing is built)',
               'base', p.land_value, 'rate_bp', (cfg ->> 'vacancy_penalty_bp')::INT, 'amount', vac);
  END IF;
  RETURN j || jsonb_build_object(
    'per_tick', jsonb_build_object(
      'income_land', inc.income_land,
      'income_improvements', inc.income_improvements,
      'taxes', taxes,
      'net', inc.income_land + inc.income_improvements
             - COALESCE((SELECT SUM((x ->> 'amount')::BIGINT) FROM jsonb_array_elements(taxes) x), 0)),
    'purchase', jsonb_build_object(
      'price', p.land_value + p.improvement_value,
      'taxes', ptaxes,
      'total', p.land_value + p.improvement_value
               + COALESCE((SELECT SUM((x ->> 'amount')::BIGINT) FROM jsonb_array_elements(ptaxes) x), 0)));
END $$;

CREATE OR REPLACE FUNCTION tycoon.player_summary(p_player UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  pl tycoon.players;
  acct TEXT := tycoon.player_account(p_player);
  bal BIGINT;
  loan BIGINT;
  agg RECORD;
  lt RECORD;
  cfg JSONB;
  w tycoon.worlds;
BEGIN
  SELECT * INTO pl FROM tycoon.players WHERE id = p_player;
  SELECT * INTO w FROM tycoon.worlds WHERE id = pl.world_id;
  cfg := tycoon.world_config(pl.world_id);
  bal := tycoon.balance_of(pl.world_id, acct);
  loan := tycoon.loan_outstanding(pl.world_id, p_player);
  SELECT count(*) AS n, COALESCE(SUM(land_value), 0) AS land, COALESCE(SUM(improvement_value), 0) AS impr
    INTO agg FROM tycoon.parcels WHERE world_id = pl.world_id AND owner_id = p_player;
  SELECT id, tick_number, ran_at INTO lt FROM tycoon.ticks
   WHERE world_id = pl.world_id ORDER BY id DESC LIMIT 1;
  RETURN jsonb_build_object(
    'player', jsonb_build_object('id', pl.id, 'handle', pl.handle, 'world_id', pl.world_id),
    'world', jsonb_build_object('id', w.id, 'name', w.name, 'ruleset_id', w.ruleset_id,
                                'tick_count', w.tick_count, 'next_tick_at', w.next_tick_at,
                                'tick_interval', cfg -> 'tick' ->> 'interval'),
    'currency', cfg -> 'currency',
    'balance', bal,
    'loan_outstanding', loan,
    'parcel_count', agg.n,
    'land_value', agg.land,
    'improvement_value', agg.impr,
    'net_worth', bal + agg.land + agg.impr - loan,
    'last_tick', CASE WHEN lt.id IS NULL THEN NULL ELSE jsonb_build_object(
      'tick_number', lt.tick_number, 'ran_at', lt.ran_at,
      'income', COALESCE((SELECT jsonb_agg(jsonb_build_object('reason', reason, 'amount', amt))
                            FROM (SELECT reason, SUM(amount) AS amt FROM tycoon.ledger
                                   WHERE tick_id = lt.id AND to_account = acct GROUP BY reason) x), '[]'::JSONB),
      'taxes', COALESCE((SELECT jsonb_agg(jsonb_build_object('reason', reason, 'amount', amt,
                                 'base_expr', (SELECT t ->> 'base' FROM jsonb_array_elements(cfg -> 'taxes') t
                                                WHERE 'tax:' || (t ->> 'id') = x.reason)))
                           FROM (SELECT reason, SUM(amount) AS amt FROM tycoon.ledger
                                  WHERE tick_id = lt.id AND from_account = acct GROUP BY reason) x), '[]'::JSONB))
    END);
END $$;

-- ------------------------------- auth --------------------------------

CREATE OR REPLACE FUNCTION public.tycoon_register(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
DECLARE
  v_user TEXT := btrim(p ->> 'username');
  v_pw TEXT := p ->> 'password';
  v_ip TEXT := tycoon.request_ip();
  v_id UUID;
BEGIN
  IF v_user IS NULL OR v_user !~ '^[A-Za-z0-9_.-]{3,20}$' THEN RAISE EXCEPTION 'invalid_username'; END IF;
  IF v_pw IS NULL OR length(v_pw) < 4 OR length(v_pw) > 200 THEN RAISE EXCEPTION 'invalid_password'; END IF;
  IF v_ip IS NOT NULL AND (SELECT count(*) FROM tycoon.accounts
                            WHERE created_ip = v_ip AND created_at > now() - INTERVAL '1 hour') >= 10 THEN
    RAISE EXCEPTION 'too_many_accounts';
  END IF;
  IF EXISTS (SELECT 1 FROM tycoon.accounts WHERE lower(username) = lower(v_user)) THEN
    RAISE EXCEPTION 'username_taken';
  END IF;
  INSERT INTO tycoon.accounts (username, password_hash, created_ip, last_ip, last_login_at)
  VALUES (v_user, extensions.crypt(v_pw, extensions.gen_salt('bf', 8)), v_ip, v_ip, now())
  RETURNING id INTO v_id;
  RETURN tycoon.new_session(v_id, v_ip);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'username_taken';
END $$;

CREATE OR REPLACE FUNCTION public.tycoon_login(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
DECLARE
  a tycoon.accounts;
  v_ip TEXT := tycoon.request_ip();
BEGIN
  SELECT * INTO a FROM tycoon.accounts WHERE lower(username) = lower(btrim(p ->> 'username'));
  IF NOT FOUND OR a.password_hash <> extensions.crypt(COALESCE(p ->> 'password', ''), a.password_hash) THEN
    RAISE EXCEPTION 'invalid_login';
  END IF;
  UPDATE tycoon.accounts SET last_ip = COALESCE(v_ip, last_ip), last_login_at = now() WHERE id = a.id;
  RETURN tycoon.new_session(a.id, v_ip);
END $$;

CREATE OR REPLACE FUNCTION public.tycoon_session(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
DECLARE a UUID := tycoon.auth_account(p);
BEGIN
  RETURN jsonb_build_object('token', p ->> 'token', 'account',
    (SELECT jsonb_build_object('id', id, 'username', username) FROM tycoon.accounts WHERE id = a));
END $$;

CREATE OR REPLACE FUNCTION public.tycoon_logout(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
BEGIN
  DELETE FROM tycoon.sessions WHERE token = p ->> 'token';
  RETURN jsonb_build_object('ok', true);
END $$;

-- ------------------------------ worlds -------------------------------

CREATE OR REPLACE FUNCTION public.tycoon_worlds(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
BEGIN
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', w.id, 'slug', w.slug, 'name', w.name, 'status', w.status,
      'ruleset_id', r.id, 'ruleset_name', r.name, 'ruleset_description', r.description,
      'tick_interval', r.config -> 'tick' ->> 'interval', 'next_tick_at', w.next_tick_at,
      'tick_count', w.tick_count,
      'player_count', (SELECT count(*) FROM tycoon.players pl WHERE pl.world_id = w.id),
      'owned_count', (SELECT count(*) FROM tycoon.parcels pa WHERE pa.world_id = w.id AND pa.owner_id IS NOT NULL))
      ORDER BY w.slug)
    FROM tycoon.worlds w JOIN tycoon.rulesets r ON r.id = w.ruleset_id), '[]'::JSONB);
END $$;

CREATE OR REPLACE FUNCTION public.tycoon_ruleset(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
BEGIN
  RETURN (SELECT jsonb_build_object('id', r.id, 'name', r.name, 'description', r.description,
                                    'config', r.config)
            FROM tycoon.worlds w JOIN tycoon.rulesets r ON r.id = w.ruleset_id
           WHERE w.id = (p ->> 'world_id')::UUID);
END $$;

CREATE OR REPLACE FUNCTION public.tycoon_building_types(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
BEGIN
  RETURN COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.sort_order, b.cost)
                     FROM tycoon.building_types b), '[]'::JSONB);
END $$;

CREATE OR REPLACE FUNCTION public.tycoon_join(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
DECLARE v UUID;
BEGIN
  v := tycoon.join_world(tycoon.auth_account(p), (p ->> 'world_id')::UUID);
  RETURN tycoon.player_summary(v);
END $$;

-- Player status. Also runs any ticks that are due, so the game advances
-- even on a database without pg_cron.
CREATE OR REPLACE FUNCTION public.tycoon_me(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
DECLARE v UUID;
BEGIN
  PERFORM tycoon.run_due_ticks();
  v := tycoon.auth_player(p);
  RETURN tycoon.player_summary(v);
END $$;

-- ------------------------------ parcels ------------------------------

CREATE OR REPLACE FUNCTION public.tycoon_parcels_bbox(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
DECLARE
  v_world UUID := (p ->> 'world_id')::UUID;
  v_limit INT := LEAST(COALESCE((p ->> 'limit')::INT, 600), 1500);
BEGIN
  RETURN COALESCE((SELECT jsonb_agg(tycoon.parcel_json(x.id, false)) FROM (
      SELECT pa.id FROM tycoon.parcels pa
       WHERE pa.world_id = v_world
         AND box(point(pa.min_lon, pa.min_lat), point(pa.max_lon, pa.max_lat))
             && box(point((p ->> 'west')::FLOAT8, (p ->> 'south')::FLOAT8),
                    point((p ->> 'east')::FLOAT8, (p ->> 'north')::FLOAT8))
       ORDER BY (pa.owner_id IS NULL), pa.length_m DESC
       LIMIT v_limit) x), '[]'::JSONB);
END $$;

-- Lightweight dots for every owned street, for the zoomed-out world view.
CREATE OR REPLACE FUNCTION public.tycoon_owned_points(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
BEGIN
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_array(pa.id, round(pa.c_lon::NUMERIC, 5),
                                                      round(pa.c_lat::NUMERIC, 5), pa.owner_id))
                     FROM (SELECT * FROM tycoon.parcels
                            WHERE world_id = (p ->> 'world_id')::UUID AND owner_id IS NOT NULL
                            ORDER BY land_value + improvement_value DESC LIMIT 5000) pa), '[]'::JSONB);
END $$;

CREATE OR REPLACE FUNCTION public.tycoon_parcel(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
DECLARE v_id BIGINT := (p ->> 'parcel_id')::BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tycoon.parcels WHERE id = v_id AND world_id = (p ->> 'world_id')::UUID) THEN
    RAISE EXCEPTION 'parcel_not_found';
  END IF;
  RETURN tycoon.parcel_json(v_id, true);
END $$;

CREATE OR REPLACE FUNCTION public.tycoon_search(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
DECLARE q TEXT := '%' || replace(replace(replace(btrim(COALESCE(p ->> 'q', '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
BEGIN
  IF length(btrim(COALESCE(p ->> 'q', ''))) < 2 THEN RETURN '[]'::JSONB; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', x.id, 'name', x.name, 'suburb', x.suburb, 'c_lon', x.c_lon, 'c_lat', x.c_lat,
      'owner_handle', (SELECT handle FROM tycoon.players WHERE id = x.owner_id),
      'price', x.land_value + x.improvement_value)) FROM (
      SELECT * FROM tycoon.parcels
       WHERE world_id = (p ->> 'world_id')::UUID
         AND (name || ' ' || COALESCE(suburb, '')) ILIKE q
       ORDER BY (owner_id IS NULL), length_m DESC LIMIT 20) x), '[]'::JSONB);
END $$;

CREATE OR REPLACE FUNCTION public.tycoon_claim(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
DECLARE v_id BIGINT;
BEGIN
  PERFORM tycoon.auth_account(p);
  v_id := tycoon.claim_parcel((p ->> 'world_id')::UUID, p ->> 'name', p ->> 'suburb',
                              p ->> 'highway', p -> 'lines');
  RETURN tycoon.parcel_json(v_id, true);
END $$;

-- ------------------------------ actions ------------------------------
-- Every mutating call returns the new balance so the client never
-- computes money itself.

CREATE OR REPLACE FUNCTION public.tycoon_buy(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
DECLARE v_pl UUID := tycoon.auth_player(p); v_bal BIGINT;
BEGIN
  v_bal := tycoon.purchase_parcel(v_pl, (p ->> 'parcel_id')::BIGINT);
  RETURN jsonb_build_object('balance', v_bal, 'parcel', tycoon.parcel_json((p ->> 'parcel_id')::BIGINT, true));
END $$;

CREATE OR REPLACE FUNCTION public.tycoon_build(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
DECLARE v_pl UUID := tycoon.auth_player(p); v_bal BIGINT;
BEGIN
  v_bal := tycoon.build_improvement(v_pl, (p ->> 'parcel_id')::BIGINT, p ->> 'type_id', (p ->> 'slot')::INT);
  RETURN jsonb_build_object('balance', v_bal, 'parcel', tycoon.parcel_json((p ->> 'parcel_id')::BIGINT, true));
END $$;

CREATE OR REPLACE FUNCTION public.tycoon_demolish(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
DECLARE v_pl UUID := tycoon.auth_player(p); v_bal BIGINT; v_parcel BIGINT;
BEGIN
  SELECT parcel_id INTO v_parcel FROM tycoon.improvements WHERE id = (p ->> 'improvement_id')::BIGINT;
  v_bal := tycoon.demolish_improvement(v_pl, (p ->> 'improvement_id')::BIGINT);
  RETURN jsonb_build_object('balance', v_bal, 'parcel', tycoon.parcel_json(v_parcel, true));
END $$;

CREATE OR REPLACE FUNCTION public.tycoon_release(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
DECLARE v_pl UUID := tycoon.auth_player(p); v_bal BIGINT;
BEGIN
  v_bal := tycoon.release_parcel(v_pl, (p ->> 'parcel_id')::BIGINT);
  RETURN jsonb_build_object('balance', v_bal, 'parcel', tycoon.parcel_json((p ->> 'parcel_id')::BIGINT, true));
END $$;

CREATE OR REPLACE FUNCTION public.tycoon_repay(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
DECLARE v_pl UUID := tycoon.auth_player(p); v_bal BIGINT;
BEGIN
  v_bal := tycoon.repay_loan(v_pl, (p ->> 'amount')::BIGINT);
  RETURN jsonb_build_object('balance', v_bal);
END $$;

-- ---------------------------- read models ----------------------------

CREATE OR REPLACE FUNCTION public.tycoon_ledger(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
DECLARE
  v_pl UUID := tycoon.auth_player(p);
  acct TEXT := tycoon.player_account(v_pl);
  v_world UUID := (p ->> 'world_id')::UUID;
BEGIN
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', l.id, 'created_at', l.created_at, 'reason', l.reason,
      'amount', CASE WHEN l.to_account = acct THEN l.amount ELSE -l.amount END,
      'counterparty', CASE WHEN l.to_account = acct THEN l.from_account ELSE l.to_account END,
      'tick_number', (SELECT tick_number FROM tycoon.ticks WHERE id = l.tick_id),
      'parcel_id', l.parcel_id,
      'parcel_name', (SELECT name FROM tycoon.parcels WHERE id = l.parcel_id)) ORDER BY l.id DESC)
    FROM (SELECT * FROM tycoon.ledger
           WHERE world_id = v_world AND (to_account = acct OR from_account = acct)
           ORDER BY id DESC LIMIT LEAST(COALESCE((p ->> 'limit')::INT, 50), 200)) l), '[]'::JSONB);
END $$;

CREATE OR REPLACE FUNCTION public.tycoon_my_parcels(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
DECLARE v_pl UUID := tycoon.auth_player(p);
BEGIN
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', pa.id, 'name', pa.name, 'suburb', pa.suburb, 'c_lon', pa.c_lon, 'c_lat', pa.c_lat,
      'land_value', pa.land_value, 'improvement_value', pa.improvement_value,
      'slots_total', pa.slots_total,
      'slots_used', COALESCE((SELECT SUM(slots_used) FROM tycoon.improvements WHERE parcel_id = pa.id), 0))
      ORDER BY pa.land_value + pa.improvement_value DESC)
    FROM tycoon.parcels pa WHERE pa.owner_id = v_pl), '[]'::JSONB);
END $$;

CREATE OR REPLACE FUNCTION public.tycoon_leaderboard(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
DECLARE v_world UUID := (p ->> 'world_id')::UUID;
BEGIN
  RETURN COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.net_worth DESC) FROM (
    SELECT pl.id AS player_id, pl.handle,
           COALESCE(b.balance, 0) AS balance,
           COALESCE(a.n, 0) AS parcel_count,
           COALESCE(a.land, 0) AS land_value,
           COALESCE(a.impr, 0) AS improvement_value,
           COALESCE(lo.loan, 0) AS loan_outstanding,
           COALESCE(b.balance, 0) + COALESCE(a.land, 0) + COALESCE(a.impr, 0) - COALESCE(lo.loan, 0) AS net_worth
      FROM tycoon.players pl
      LEFT JOIN tycoon.balances b ON b.world_id = v_world AND b.account = tycoon.player_account(pl.id)
      LEFT JOIN (SELECT owner_id, count(*) AS n, SUM(land_value) AS land, SUM(improvement_value) AS impr
                   FROM tycoon.parcels WHERE world_id = v_world AND owner_id IS NOT NULL
                  GROUP BY owner_id) a ON a.owner_id = pl.id
      LEFT JOIN (SELECT acct, SUM(delta) AS loan FROM (
                   SELECT to_account AS acct, amount AS delta FROM tycoon.ledger
                    WHERE world_id = v_world AND reason = 'loan'
                   UNION ALL
                   SELECT from_account, -amount FROM tycoon.ledger
                    WHERE world_id = v_world AND reason = 'loan_repayment') l GROUP BY acct) lo
             ON lo.acct = tycoon.player_account(pl.id)
     WHERE pl.world_id = v_world
     ORDER BY net_worth DESC
     LIMIT 20) x), '[]'::JSONB);
END $$;

CREATE OR REPLACE FUNCTION public.tycoon_events(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = tycoon, extensions, public AS $$
BEGIN
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', e.id, 'kind', e.kind, 'created_at', e.created_at, 'data', e.data,
      'handle', pl.handle, 'player_id', e.player_id,
      'parcel_id', e.parcel_id, 'parcel_name', pa.name, 'suburb', pa.suburb,
      'c_lon', pa.c_lon, 'c_lat', pa.c_lat) ORDER BY e.id DESC)
    FROM (SELECT * FROM tycoon.events WHERE world_id = (p ->> 'world_id')::UUID
           ORDER BY id DESC LIMIT LEAST(COALESCE((p ->> 'limit')::INT, 30), 100)) e
    LEFT JOIN tycoon.players pl ON pl.id = e.player_id
    LEFT JOIN tycoon.parcels pa ON pa.id = e.parcel_id), '[]'::JSONB);
END $$;
