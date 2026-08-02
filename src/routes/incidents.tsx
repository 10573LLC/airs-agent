import { createFileRoute, Outlet } from "@tanstack/react-router";

// Layout route for the incident section. Children are /incidents (index) and
// /incidents/$incidentId.
export const Route = createFileRoute("/incidents")({
  component: () => <Outlet />,
});
