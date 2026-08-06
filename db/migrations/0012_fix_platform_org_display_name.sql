-- AIRS Agent - repair the platform organization display name.
--
-- Root cause: migration 0011 seeded the name with a Unicode em dash
-- ("Anconison <em dash> AIRS Agent Platform"). When the migration is applied
-- from a Windows console whose client encoding is cp1252/WIN1252, the multi-byte
-- character is not representable and is stored as replacement characters, so the
-- tenant renders as "Anconison ??? AIRS Agent Platform".
--
-- Fix: store a plain ASCII hyphen. This migration is idempotent, touches exactly
-- one row (slug = 'anconison-platform'), never touches agency tenants, and never
-- changes ids, slugs, org_kind, memberships, roles, invitations or audit history.

BEGIN;

DO $$
DECLARE
  v_count int;
  v_old   text;
BEGIN
  SELECT count(*) INTO v_count FROM airs.organizations WHERE slug = 'anconison-platform';

  IF v_count = 0 THEN
    RAISE NOTICE 'no anconison-platform organization present; nothing to repair';
    RETURN;
  END IF;
  IF v_count > 1 THEN
    RAISE EXCEPTION 'duplicate anconison-platform organizations (% rows) - refusing to repair', v_count;
  END IF;

  SELECT name INTO v_old FROM airs.organizations WHERE slug = 'anconison-platform';

  UPDATE airs.organizations
     SET name = 'Anconison - AIRS Agent Platform',
         updated_at = now()
   WHERE slug = 'anconison-platform'
     AND name IS DISTINCT FROM 'Anconison - AIRS Agent Platform';

  IF FOUND THEN
    INSERT INTO airs.audit_events
      (org_id, actor_user_id, action, resource_type, resource_id, outcome, detail)
    SELECT o.id, NULL, 'platform.display_name_repaired', 'organization', o.id, 'allow',
           jsonb_build_object('previous_name', v_old,
                              'new_name', 'Anconison - AIRS Agent Platform',
                              'source', 'migration 0012')
      FROM airs.organizations o
     WHERE o.slug = 'anconison-platform';
  END IF;
END $$;

COMMIT;
