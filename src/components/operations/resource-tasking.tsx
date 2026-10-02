import { useState, type ReactNode } from "react";
import { Truck } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { issueResourceOrderFn, reportResourceOrderFn } from "@/lib/api/resource-orders.functions";
import type { readResourceOrders } from "@/lib/incidents/resource-orders.server";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
export type CommandMapControls = {
  tray?: ReactNode;
  picking?: boolean;
  onPickPoint?: (point: [number, number]) => void;
};
type Board = Awaited<ReturnType<typeof readResourceOrders>>;
const field = "w-full rounded border bg-background p-2 text-sm";
export function ResourceTasking({
  incidentId,
  board,
  locatedAssignmentIds,
  children,
}: {
  incidentId: string;
  board: Board | null;
  locatedAssignmentIds: string[];
  children: (controls: CommandMapControls) => ReactNode;
}) {
  const [open, setOpen] = useState(false),
    [selected, setSelected] = useState(""),
    [destination, setDestination] = useState(""),
    [mission, setMission] = useState(""),
    [point, setPoint] = useState<[number, number] | null>(null),
    [picking, setPicking] = useState(false),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [previousOrderId, setPreviousOrderId] = useState<string | null>(null),
    [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const issue = useServerFn(issueResourceOrderFn),
    report = useServerFn(reportResourceOrderFn),
    qc = useQueryClient();
  const awaiting =
    board?.assignments.filter(
      (a) =>
        !locatedAssignmentIds.includes(a.id) && !board.orders.some((o) => o.assignmentId === a.id),
    ) ?? [];
  const current = board?.orders.find((o) => o.assignmentId === selected);
  const choose = (id: string) => {
    setPreviousOrderId(board?.orders.find((o) => o.assignmentId === id)?.id ?? null);
    setSelected(id);
    setDestination("");
    setMission("");
    setPoint(null);
    setRequestId(crypto.randomUUID());
    setOpen(true);
  };
  const refresh = () => qc.invalidateQueries({ queryKey: ["resource-orders", incidentId] });
  return (
    <>
      {children({
        picking,
        onPickPoint: (p) => {
          if (!picking) return;
          setPoint(p);
          setPicking(false);
          setOpen(true);
        },
        tray: (
          <div className="max-w-xs rounded border bg-background/95 p-3 shadow-lg">
            <p className="text-xs font-bold">Awaiting assignment · {awaiting.length}</p>
            <p className="text-[11px] text-muted-foreground">
              No shared position; icons below are not map locations.
            </p>
            <div className="mt-2 flex max-h-32 flex-wrap gap-2 overflow-y-auto">
              {awaiting.map((a) => (
                <button
                  key={a.id}
                  title={`${a.ownerOrgName ?? "Your agency"} · ${a.label ?? "Resource"}`}
                  className="flex items-center gap-1 rounded border p-2 text-xs"
                  onClick={() => choose(a.id)}
                >
                  <Truck size={18} />
                  {a.label ?? "Resource"}
                </button>
              ))}
            </div>
            <button
              className="mt-2 rounded bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground"
              onClick={() => setOpen(true)}
            >
              Assign / redirect resources
            </button>
            {picking && (
              <p role="status" className="mt-2 text-xs font-semibold">
                Click the map to choose the assigned destination.
                <button className="ml-2 underline" onClick={() => setPicking(false)}>
                  Cancel
                </button>
              </p>
            )}
          </div>
        ),
      })}
      <Sheet modal={false} open={open} onOpenChange={setOpen}>
        <SheetContent className="flex w-full flex-col sm:w-[42rem] sm:max-w-[min(42rem,90vw)]">
          <SheetHeader>
            <SheetTitle>Resource assignments</SheetTitle>
            <SheetDescription>
              The requesting agency directs destinations and tasks. Each owning agency acknowledges
              and reports progress.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto space-y-4">
            {notice && <p role="status">{notice}</p>}
            {!board ? (
              <p>Assignments unavailable.</p>
            ) : (
              <>
                {board.canDirect && (
                  <form
                    className="space-y-3"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setBusy(true);
                      try {
                        const r = await issue({
                          data: {
                            id: requestId,
                            incidentId,
                            assignmentId: selected,
                            previousOrderId,
                            destination,
                            mission,
                            latitude: point?.[1] ?? null,
                            longitude: point?.[0] ?? null,
                          },
                        });
                        setNotice(
                          r.ok
                            ? "Command assignment sent. Awaiting the owning agency’s acknowledgment."
                            : `Assignment not sent: ${r.code}. Refresh and review the current order.`,
                        );
                        if (r.ok) {
                          setPreviousOrderId(r.data.id);
                          setRequestId(crypto.randomUUID());
                          await refresh();
                        }
                      } catch {
                        setNotice("Could not send; retry safely.");
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <label className="block text-sm">
                      Resource
                      <select
                        required
                        className={field}
                        value={selected}
                        onChange={(e) => choose(e.target.value)}
                      >
                        <option value="">Select a committed resource</option>
                        {board.assignments.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.ownerOrgName ?? "Your agency"} · {a.label ?? "Resource"}
                          </option>
                        ))}
                      </select>
                    </label>
                    {current && (
                      <p className="text-xs">
                        Current order: {current.destination} · {current.mission} ·{" "}
                        {current.status.replaceAll("_", " ")}. Sending replaces this order and
                        requires a new acknowledgment.
                      </p>
                    )}
                    <label className="block text-sm">
                      Task / job
                      <textarea
                        required
                        maxLength={1500}
                        className={field}
                        value={mission}
                        onChange={(e) => setMission(e.target.value)}
                      />
                    </label>
                    <label className="block text-sm">
                      Assigned destination
                      <input
                        required
                        maxLength={300}
                        className={field}
                        value={destination}
                        onChange={(e) => setDestination(e.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="rounded border p-2 text-sm"
                      onClick={() => {
                        setOpen(false);
                        setPicking(true);
                      }}
                    >
                      Choose destination on map
                    </button>
                    <p className="text-xs">
                      {point
                        ? `${point[1].toFixed(5)}, ${point[0].toFixed(5)} · assigned destination, not current position`
                        : "No point selected. A text-only destination will remain unplotted."}
                    </p>
                    <button
                      disabled={busy || !selected}
                      className="rounded bg-primary p-2 font-semibold text-primary-foreground disabled:opacity-40"
                    >
                      {busy ? "Sending…" : "Send command assignment"}
                    </button>
                  </form>
                )}
                {board.assignments.map((a) => {
                  const o = board.orders.find((o) => o.assignmentId === a.id);
                  return (
                    <article key={a.id} className="rounded border p-3 text-sm">
                      <h3 className="font-semibold">
                        {a.label ?? "Resource"} · {a.ownerOrgName ?? "Your agency"}
                      </h3>
                      {o ? (
                        <>
                          <p>{o.mission}</p>
                          <p>Assigned destination: {o.destination}</p>
                          <strong>{o.status.replaceAll("_", " ")}</strong>
                          <p>{o.message ?? "Awaiting owning agency acknowledgment."}</p>
                          {board.canReport &&
                            a.orgId === board.orgId &&
                            !["arrived", "unable"].includes(o.status) && (
                              <div className="flex gap-2">
                                {(o.status === "ordered"
                                  ? ["acknowledged", "unable"]
                                  : o.status === "acknowledged"
                                    ? ["en_route", "unable"]
                                    : ["arrived", "unable"]
                                ).map((status) => (
                                  <button
                                    className="rounded border p-2"
                                    key={status}
                                    onClick={async () => {
                                      const r = await report({
                                        data: {
                                          incidentId,
                                          orderId: o.id,
                                          status,
                                          message: `Agency reports ${status.replaceAll("_", " ")} for ${o.destination}.`,
                                        },
                                      });
                                      setNotice(
                                        r.ok ? "Status reported." : `Could not report: ${r.code}`,
                                      );
                                      await refresh();
                                    }}
                                  >
                                    {status.replaceAll("_", " ")}
                                  </button>
                                ))}
                              </div>
                            )}
                        </>
                      ) : (
                        <p>
                          No command task assigned.
                          {locatedAssignmentIds.includes(a.id)
                            ? " Shared location remains on map."
                            : " No shared position."}
                        </p>
                      )}
                    </article>
                  );
                })}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
