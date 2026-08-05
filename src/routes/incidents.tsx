import { createFileRoute, Outlet } from "@tanstack/react-router";

import { AppFooter, AppHeader } from "@/components/brand";

// Layout route for the incident section. Children are /incidents (index) and
// /incidents/$incidentId.
export const Route = createFileRoute("/incidents")({
  component: IncidentsLayout,
});

function IncidentsLayout() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader />
      <div className="flex-1">
        {/* Required: nested incident routes render here. */}
        <Outlet />
      </div>
      <AppFooter />
    </div>
  );
}
