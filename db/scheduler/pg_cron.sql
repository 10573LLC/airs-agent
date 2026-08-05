-- Optional in-database scheduler.
--
-- If the target PostgreSQL deployment provides the pg_cron extension, the
-- expiration sweep can run without any external process. This is a deployment
-- choice, not a dependency: the standalone runner
-- (`node scripts/expire-incident-state.mjs`) and the authenticated HTTP endpoint
-- provide the same behaviour on clusters without pg_cron.
--
-- Apply as a superuser in the database that hosts pg_cron:
--   psql "$DATABASE_URL" -f db/scheduler/pg_cron.sql

CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'airs-expire-incident-state',
  '* * * * *',
  -- Same entry point the runner uses: it takes the advisory lock, calls the
  -- Stage 5 sweep and records the maintenance audit event.
  $$SELECT airs.run_incident_expiration(gen_random_uuid())$$
);

-- pg_cron jobs run as the scheduling user. Schedule this as airs_maintenance
-- (or grant that role to the scheduling user) so the run carries no more
-- privilege than an external scheduler would:
--   UPDATE cron.job SET username = 'airs_maintenance'
--    WHERE jobname = 'airs-expire-incident-state';

-- To remove:
--   SELECT cron.unschedule('airs-expire-incident-state');
