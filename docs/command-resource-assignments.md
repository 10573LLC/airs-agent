# Command-directed resources

The incident's requesting/owning agency is Command and Coordination in the operational COP. Its authorized incident editors issue tasks and destinations for resources committed by participating agencies. Resource ownership, disclosure and position reporting stay with the owning agency.

The COP uses the Simulation Lab's tall map layout. Request history and source details open in side panels. A lower-left **Awaiting assignment** tray contains active resource assignments that have neither a command task nor shared resource-location geometry. The tray is screen furniture, not an inferred staging point. Personnel records are not duplicated as vehicle icons.

Drag a tray resource onto the map to open its assignment with the dropped coordinates filled in. Enter its task and send the command assignment. Alternatively select a tray resource or **Assign / redirect resources**, enter its task and destination, and choose a map point. A drop prepares a draft; it does not dispatch the resource. Coordinates are optional: a text-only destination remains unplotted. An assigned-destination marker is distinct from a reported position; shared resource geolocation takes precedence. Generated Anconison staging proposals do not become map positions. Two genuine resources can share coordinates; destinations are not artificially offset.

Migration 0023 stores immutable orders and append-only owning-agency reports with forced row-level security. Only the incident owner can issue orders. Service checks require incident-edit permission, an active incident and a visible active resource assignment. The receiving agency reports acknowledged, en route, arrived or unable; it cannot replace the destination. Restricted/view-only participants cannot report. The incident lock serializes closeout and order/report writes. Duplicate issue IDs are idempotent; a previous-order ID prevents stale redirection. New orders supersede earlier ones and start awaiting acknowledgment. Superseded, closed-incident and released-resource reports are refused.

Anconison exercise agents use these same services. They acknowledge an order, then report en route and arrived after separate 30-second intervals. This is explicitly labeled compressed exercise progression, not a travel estimate, observed telemetry or guaranteed real-world feasibility. Model-generated narrative updates stop once command orders exist for the agency. Existing historical response text is retained. The requesting agency must provide destinations; no exercise resource is automatically given a command destination on deployment.

Verification covers command-only issuance, owner-only reporting, acknowledgment before arrival, retries, redirection, superseded-order rejection and closeout. Live geolocation integrations remain a separate capability; this change uses location records already released to the COP.

Command can set the incident address from the COP toolbar. New intelligent agency plans receive that address as incident context. Map tools accept known coordinates and an explicit sharing choice, allowing a geocoded incident feature to be labeled with its source and approximate precision.

The requesting incident commander can place a point-of-interest point in their own active incident without general map-administration permission. Other feature types, global features and another agency's incident remain protected by their existing permissions. This boundary has integration coverage.

Dropped resources now render a labeled draft assignment marker immediately while the task form is open. Closing the panel leaves that draft visible; Cancel draft placement removes it, and successful submission replaces it with the persisted assigned destination. A draft is not an observed resource position or a sent order.

The map toolbar has an upper-right Layers control. Each operational category can be hidden independently; Fit visible data honors those choices. The same renderer provides these controls in the COP, map tools and Simulation Lab. Layer choices affect display only, not incident sharing or stored records.

Incident command can correct its own active incident point from Map tools: select a working point, then Move to selected point on the existing point-of-interest feature. The existing feature is version-checked, retains its sharing and precision policy, and records correction provenance. Other agencies, closed incidents and non-point features are refused.
