-- Confirms the seeded role model in the database matches the counts the
-- TypeScript model declares (9 roles, 44 permissions, 114 grants).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/role_parity.sql
SELECT 'roles' AS entity, count(*) AS actual, 9 AS expected FROM airs.roles
UNION ALL SELECT 'permissions', count(*), 44 FROM airs.permissions
UNION ALL SELECT 'role_permissions', count(*), 114 FROM airs.role_permissions;

DO $$
DECLARE r int; p int; g int;
BEGIN
  SELECT count(*) INTO r FROM airs.roles;
  SELECT count(*) INTO p FROM airs.permissions;
  SELECT count(*) INTO g FROM airs.role_permissions;
  IF (r, p, g) IS DISTINCT FROM (9, 44, 114) THEN
    RAISE EXCEPTION 'role model drift: roles=% permissions=% grants=% (expected 9/44/114)', r, p, g;
  END IF;
  RAISE NOTICE 'role model parity: 9 roles, 44 permissions, 114 grants';
END $$;
