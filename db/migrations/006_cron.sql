-- =====================================================================
-- Tycoon: tick scheduling.
-- pg_cron calls the dispatcher every minute; the dispatcher decides which
-- worlds are due from each ruleset's own `tick.interval`, so no cadence is
-- hardcoded here. Where pg_cron isn't available (local Postgres, PGlite)
-- ticks still run: tycoon_me() calls the dispatcher on player activity.
-- =====================================================================
DO $outer$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'pg_cron not available (%); ticks will run on player activity instead', SQLERRM;
    RETURN;
  END;
  EXECUTE $$SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'tycoon-ticks'$$;
  EXECUTE $$SELECT cron.schedule('tycoon-ticks', '* * * * *', 'SELECT tycoon.run_due_ticks()')$$;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'could not schedule pg_cron job (%); ticks will run on player activity instead', SQLERRM;
END $outer$;
