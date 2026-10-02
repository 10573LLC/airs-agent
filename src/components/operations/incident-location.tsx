import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { updateIncidentFn } from "@/lib/api/incidents.functions";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
export function IncidentLocation({
  incidentId,
  version,
  address,
  canEdit,
}: {
  incidentId: string;
  version: number;
  address: string | null;
  canEdit: boolean;
}) {
  const save = useServerFn(updateIncidentFn),
    qc = useQueryClient();
  const [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <>
      <span>Incident location: {address || "Not set"}</span>
      {canEdit && (
        <Sheet modal={false}>
          <SheetTrigger asChild>
            <button className="rounded border px-3 py-1.5 font-semibold">
              Set incident address
            </button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Incident address</SheetTitle>
              <SheetDescription>
                The requesting agency sets the incident location. Map tools place its verified or
                approximate coordinate.
              </SheetDescription>
            </SheetHeader>
            <form
              key={version}
              className="mt-4 space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                setBusy(true);
                try {
                  const r = await save({
                    data: {
                      incidentId,
                      expectedVersion: version,
                      geographicDescription: String(f.get("address")),
                    },
                  });
                  setNotice(r.ok ? "Incident address saved." : `Could not save: ${r.code}`);
                  if (r.ok) await qc.invalidateQueries({ queryKey: ["workspace", "incident"] });
                } catch {
                  setNotice("Address not confirmed saved. Refresh before retrying.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label className="block text-sm">
                Incident address
                <input
                  name="address"
                  required
                  maxLength={500}
                  defaultValue={address ?? ""}
                  className="mt-1 w-full rounded border bg-background p-2"
                />
              </label>
              <button disabled={busy} className="rounded bg-primary p-2 text-primary-foreground">
                Save incident address
              </button>
              <p role="status">{notice}</p>
            </form>
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}
