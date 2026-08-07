import { createFileRoute, Outlet } from "@tanstack/react-router";

import { AppChrome } from "@/components/brand";

// Layout route for the awareness section. Children are /awareness (index) and
// /awareness/$observationId.
export const Route = createFileRoute("/awareness")({
  component: AwarenessLayout,
});

function AwarenessLayout() {
  return (
    <AppChrome>
      {/* Required: nested awareness routes render here. */}
      <Outlet />
    </AppChrome>
  );
}
