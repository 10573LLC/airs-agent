-- Demonstration tenants. Fully separated: no shared rows other than reference data.
BEGIN;

INSERT INTO airs.organizations (id, slug, name, agency_type) VALUES
  ('11111111-1111-4111-8111-111111111111','albany-pd','Albany Police Department','law_enforcement'),
  ('22222222-2222-4222-8222-222222222222','albany-county','Albany County','county')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO airs.retention_policies (org_id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222')
ON CONFLICT (org_id) DO NOTHING;

COMMIT;