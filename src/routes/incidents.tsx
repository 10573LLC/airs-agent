import { createFileRoute, Outlet } from "@tanstack/react-router";

import { AppChrome } from "@/components/brand";

// Layout route for the incident section. Children are /incidents (index) and
// /incidents/$incidentId.
export const Route = createFileRoute("/incidents")({
  component: IncidentsLayout,
});

function IncidentsLayout() {
  return (
    <AppChrome>
      {/* Required: nested incident routes render here. */}
      <Outlet />
    </AppChrome>
  );
}
