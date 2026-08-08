import { createFileRoute } from "@tanstack/react-router";
import { CopMap } from "@/components/map/cop-map";

export const Route = createFileRoute("/mapcheck")({ component: Page });

function Page() {
  return (
    <CopMap
      items={[]}
      styleUrl="https://tiles.openfreemap.org/styles/liberty"
      className="flex h-[460px] w-full flex-col overflow-hidden rounded-lg border border-border"
      picking
    />
  );
}
