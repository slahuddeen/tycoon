-- =====================================================================
-- Tycoon: access control.
-- Clients get EXECUTE on the public.tycoon_* API functions and nothing
-- else. The `tycoon` schema (tables + internal functions) is unreachable
-- for the Supabase `anon`/`authenticated` roles, and RLS is enabled on
-- every table with no policies, so even a misplaced grant can't expose a
-- row or allow a direct write.
-- =====================================================================

ALTER TABLE tycoon.rulesets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tycoon.worlds         ENABLE ROW LEVEL SECURITY;
ALTER TABLE tycoon.accounts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tycoon.sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tycoon.players        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tycoon.parcels        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tycoon.building_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE tycoon.improvements   ENABLE ROW LEVEL SECURITY;
ALTER TABLE tycoon.ticks          ENABLE ROW LEVEL SECURITY;
ALTER TABLE tycoon.ledger         ENABLE ROW LEVEL SECURITY;
ALTER TABLE tycoon.events         ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON SCHEMA tycoon FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA tycoon FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA tycoon FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA tycoon FROM PUBLIC;

DO $$
DECLARE
  r TEXT;
  f RECORD;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA tycoon FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA tycoon FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA tycoon FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA tycoon FROM %I', r);
      FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname LIKE 'tycoon\_%' LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f.sig, r);
      END LOOP;
    END IF;
  END LOOP;
END $$;
