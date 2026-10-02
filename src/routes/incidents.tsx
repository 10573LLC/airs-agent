import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";

import { AppChrome } from "@/components/brand";

// Layout route for the incident section. Children are /incidents (index) and
// /incidents/$incidentId.
export const Route = createFileRoute("/incidents")({
  component: IncidentsLayout,
});

function IncidentsLayout() {
  const command = useRouterState({select: state => state.matches.some(match => match.routeId === "/incidents/$incidentId/command")});
  if (command) return <Outlet />;
  return (
    <AppChrome>
      {/* Required: nested incident routes render here. */}
      <Outlet />
    </AppChrome>
  );
}
