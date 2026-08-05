-- Optional in-database scheduler.
--
-- If the target PostgreSQL deployment provides the pg_cron extension, the
-- expiration sweep can run without any external process. This is a deployment
-- choice, not a dependency: the standalone runner
-- (`node scripts/expire-incidents.mjs`) and the authenticated HTTP endpoint
-- provide the same behaviour on clusters without pg_cron.
--
-- Apply as a superuser in the database that hosts pg_cron:
--   psql "$DATABASE_URL" -f db/scheduler/pg_cron.sql

CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'airs-expire-incident-state',
  '* * * * *',
  $$SELECT airs.expire_incident_state() WHERE pg_try_advisory_xact_lock(8421701)$$
);

-- To remove:
--   SELECT cron.unschedule('airs-expire-incident-state');
