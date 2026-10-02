import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  readAgencyRequestsFn,
  sendAgencyAidRequestFn,
  respondAgencyRequestFn,
} from "@/lib/api/aid.functions";
const field = "w-full rounded border border-input bg-background p-2 text-sm";
const button =
  "rounded bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-40";
export function AidRequests({ incidentId }: { incidentId: string }) {
  const read = useServerFn(readAgencyRequestsFn),
    send = useServerFn(sendAgencyAidRequestFn),
    respond = useServerFn(respondAgencyRequestFn);
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["agency-aid", incidentId],
    queryFn: () => read({ data: { incidentId } }),
    refetchInterval: 3000,
  });
  const [recipients, setRecipients] = useState<string[]>([]),
    [description, setDescription] = useState(""),
    [location, setLocation] = useState(""),
    [quantity, setQuantity] = useState(1),
    [kind, setKind] = useState("other"),
    [priority, setPriority] = useState("high"),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [batch, setBatch] = useState(() => crypto.randomUUID());
  const data = query.data?.ok ? query.data.data : null;
  async function refresh() {
    await qc.invalidateQueries({ queryKey: ["agency-aid", incidentId] });
    await qc.invalidateQueries({ queryKey: ["incident-ics"] });
  }
  return (
    <section className="my-5 rounded-lg border border-primary/30 bg-card p-4">
      <h2 className="text-lg font-semibold">Request aid</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Send a request to multiple agencies. Each receiving agency supplies its own response,
        resources and operational reports.
      </p>
      {notice && (
        <p role="status" className="mt-3 rounded bg-muted p-2 text-sm">
          {notice}
        </p>
      )}
      {!data && (
        <p className="mt-2 text-sm">
          {query.data && !query.data.ok
            ? `Requests unavailable: ${query.data.code}`
            : "Loading agency requests…"}
        </p>
      )}
      {data?.canRequest && (
        <form
          className="mt-4 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const result = await send({
                data: {
                  incidentId,
                  batchId: batch,
                  recipients,
                  description,
                  resourceKind: kind,
                  quantity,
                  priority,
                  stagingLocation: location,
                },
              });
              if (result.ok) {
                const failed = result.data.filter((r) => !r.ok);
                setNotice(
                  failed.length
                    ? `${result.data.length - failed.length} requests sent; ${failed.length} failed. Retry keeps the same request IDs.`
                    : "Requests sent. Receiving agencies can now accept and respond. Anconison exercise agents respond automatically.",
                );
                if (!failed.length) {
                  setBatch(crypto.randomUUID());
                  setDescription("");
                  setRecipients([]);
                }
                await refresh();
              } else setNotice(`Unable to send: ${result.code}`);
            } catch {
              setNotice("Request could not be sent. Retry safely.");
            } finally {
              setBusy(false);
            }
          }}
        >
          {!data.active && <p className="text-sm">Activate this incident before requesting aid.</p>}
          <fieldset disabled={busy || !data.active}>
            <legend className="mb-2 text-sm font-semibold">Receiving agencies</legend>
            <div className="grid gap-2 md:grid-cols-3">
              {data.directory.map((e) => (
                <label
                  key={e.id}
                  className="flex items-start gap-2 rounded border border-border p-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={recipients.includes(e.id)}
                    onChange={(event) =>
                      setRecipients((current) =>
                        event.target.checked
                          ? [...current, e.id]
                          : current.filter((id) => id !== e.id),
                      )
                    }
                  />
                  <span>
                    {e.name}
                    <small className="block text-muted-foreground">{e.entity_type}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block text-sm">
            Assistance needed
            <textarea
              required
              className={field}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1500}
            />
          </label>
          <div className="grid gap-3 md:grid-cols-4">
            <label className="text-sm">
              Capability
              <select className={field} value={kind} onChange={(e) => setKind(e.target.value)}>
                {[
                  "other",
                  "law_enforcement",
                  "fire_ems",
                  "medical",
                  "uas",
                  "aviation",
                  "counter_uas",
                  "communications",
                  "public_works",
                  "logistics",
                  "specialty_team",
                  "personnel",
                ].map((v) => (
                  <option key={v} value={v}>
                    {v === "other" ? "Agency-appropriate aid" : v.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Units per agency
              <input
                className={field}
                type="number"
                min={1}
                max={100}
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
              />
            </label>
            <label className="text-sm">
              Priority
              <select
                className={field}
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                <option value="immediate">Immediate</option>
                <option value="high">High</option>
                <option value="routine">Routine</option>
              </select>
            </label>
            <label className="text-sm">
              Location / staging
              <input
                className={field}
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                maxLength={300}
              />
            </label>
          </div>
          <button
            className={button}
            disabled={busy || !data.active || !recipients.length || !description.trim()}
          >
            {busy ? "Sending…" : `Request aid from ${recipients.length} agencies`}
          </button>
        </form>
      )}
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {data?.requests.map((r) => {
          const replies = data.responses.filter((p) => p.requestId === r.id);
          const latest = replies.at(-1);
          return (
            <article key={r.id} className="rounded border border-border p-3 text-sm">
              <h3 className="font-semibold">
                {r.requestedFrom} ·{" "}
                {["cancelled", "filled", "denied"].includes(r.status)
                  ? r.status
                  : (latest?.status ?? "Awaiting agency response")}
              </h3>
              <p>
                {r.quantity} × {r.description}
              </p>
              <p className="text-xs text-muted-foreground">
                Staging: {r.stagingLocation || "Not provided"}
              </p>
              {replies.map((p) => (
                <div key={p.id} className="mt-2 border-l-2 border-primary pl-3">
                  <strong>
                    {p.orgName} · {p.status.replaceAll("_", " ")}
                  </strong>
                  <p>{p.message}</p>
                  <time className="text-xs text-muted-foreground">
                    {new Date(p.createdAt).toLocaleString()}
                  </time>
                </div>
              ))}
              {data.canRespond &&
                data.orgId === r.recipientOrgId &&
                data.active &&
                !["cancelled", "filled", "denied"].includes(r.status) && (
                  <form
                    className="mt-3 space-y-2"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      const result = await respond({
                        data: {
                          requestId: r.id,
                          incidentId,
                          status: String(f.get("status")),
                          message: String(f.get("message")),
                        },
                      });
                      setNotice(
                        result.ok
                          ? "Agency response recorded."
                          : `Unable to respond: ${result.code}`,
                      );
                      await refresh();
                    }}
                  >
                    <label>
                      Response
                      <select name="status" className={field}>
                        <option value="acknowledged">Acknowledge</option>
                        <option value="partially_filled">Partially filled</option>
                        <option value="filled">Filled</option>
                        <option value="denied">Unable to assist</option>
                      </select>
                    </label>
                    <label>
                      Agency reply
                      <textarea required name="message" className={field} maxLength={2000} />
                    </label>
                    <button className={button}>Submit agency response</button>
                  </form>
                )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
