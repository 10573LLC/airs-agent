-- Command directs committed resources; owning agencies acknowledge and report movement.
CREATE TABLE airs.resource_orders (
 id uuid PRIMARY KEY, sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 incident_id uuid NOT NULL REFERENCES airs.incident_rooms(id) ON DELETE CASCADE,
 assignment_id uuid NOT NULL REFERENCES airs.incident_assignments(id) ON DELETE CASCADE,
 issuer_org_id uuid NOT NULL REFERENCES airs.organizations(id),
 recipient_org_id uuid NOT NULL REFERENCES airs.organizations(id),
 issued_by uuid NOT NULL REFERENCES airs.accounts(id),
 destination text NOT NULL CHECK(length(btrim(destination)) BETWEEN 1 AND 300),
 mission text NOT NULL CHECK(length(btrim(mission)) BETWEEN 1 AND 1500),
 latitude double precision CHECK(latitude BETWEEN -90 AND 90),
 longitude double precision CHECK(longitude BETWEEN -180 AND 180),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((latitude IS NULL)=(longitude IS NULL))
);
CREATE INDEX resource_orders_assignment ON airs.resource_orders(assignment_id,sequence DESC);
CREATE TABLE airs.resource_order_reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL REFERENCES airs.resource_orders(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('acknowledged','en_route','arrived','unable')),
 message text NOT NULL CHECK(length(btrim(message)) BETWEEN 1 AND 1000),
 reported_by uuid NOT NULL REFERENCES airs.accounts(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(order_id,status)
);
ALTER TABLE airs.resource_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE airs.resource_orders FORCE ROW LEVEL SECURITY;
ALTER TABLE airs.resource_order_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE airs.resource_order_reports FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON airs.resource_orders,airs.resource_order_reports TO airs_app;
GRANT USAGE ON SEQUENCE airs.resource_orders_sequence_seq TO airs_app;
CREATE POLICY order_read ON airs.resource_orders FOR SELECT USING(airs.framework_incident_active(incident_id));
CREATE POLICY order_insert ON airs.resource_orders FOR INSERT WITH CHECK(
 issuer_org_id=airs.current_org_id() AND issued_by=airs.current_account_id()
 AND airs.framework_incident_active(incident_id)
 AND EXISTS(SELECT 1 FROM airs.incident_rooms r WHERE r.id=incident_id AND r.org_id=airs.current_org_id())
 AND EXISTS(SELECT 1 FROM airs.incident_assignments a WHERE a.id=assignment_id
   AND a.incident_id=resource_orders.incident_id AND a.org_id=recipient_org_id
   AND a.assignment_type='resource' AND a.status IN ('assigned','deploying','active'))
);
CREATE POLICY order_report_read ON airs.resource_order_reports FOR SELECT USING(
 EXISTS(SELECT 1 FROM airs.resource_orders o WHERE o.id=order_id));
CREATE POLICY order_report_insert ON airs.resource_order_reports FOR INSERT WITH CHECK(
 reported_by=airs.current_account_id() AND EXISTS(
 SELECT 1 FROM airs.resource_orders o JOIN airs.incident_assignments a ON a.id=o.assignment_id
 WHERE o.id=order_id AND o.recipient_org_id=airs.current_org_id()
 AND a.status IN ('assigned','deploying','active') AND airs.framework_incident_active(o.incident_id)
 AND (o.issuer_org_id=airs.current_org_id() OR EXISTS(
 SELECT 1 FROM airs.incident_participants p WHERE p.incident_id=o.incident_id
 AND p.partner_org_id=airs.current_org_id() AND p.invitation_status='accepted'
 AND p.participation_status='active' AND p.access_level IN ('operational','incident_command')
 AND p.revoked_at IS NULL AND p.removed_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>now()))))
);
