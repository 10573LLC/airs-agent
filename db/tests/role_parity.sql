-- Confirms the seeded role model in the database matches the counts the
-- TypeScript model declares (9 roles, 23 permissions, 52 grants).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/role_parity.sql
SELECT 'roles' AS entity, count(*) AS actual, 9 AS expected FROM airs.roles
UNION ALL SELECT 'permissions', count(*), 23 FROM airs.permissions
UNION ALL SELECT 'role_permissions', count(*), 52 FROM airs.role_permissions;

DO $$
DECLARE r int; p int; g int;
BEGIN
  SELECT count(*) INTO r FROM airs.roles;
  SELECT count(*) INTO p FROM airs.permissions;
  SELECT count(*) INTO g FROM airs.role_permissions;
  IF (r, p, g) IS DISTINCT FROM (9, 23, 52) THEN
    RAISE EXCEPTION 'role model drift: roles=% permissions=% grants=% (expected 9/23/52)', r, p, g;
  END IF;
  RAISE NOTICE 'role model parity: 9 roles, 23 permissions, 52 grants';
END $$;
