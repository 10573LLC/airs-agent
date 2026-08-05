import { createFileRoute, Outlet } from "@tanstack/react-router";

import { AppFooter, AppHeader } from "@/components/brand";

// Layout route for the awareness section. Children are /awareness (index) and
// /awareness/$observationId.
export const Route = createFileRoute("/awareness")({
  component: AwarenessLayout,
});

function AwarenessLayout() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader />
      <div className="flex-1">
        {/* Required: nested awareness routes render here. */}
        <Outlet />
      </div>
      <AppFooter />
    </div>
  );
}
