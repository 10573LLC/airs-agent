import { useEffect, useMemo, useState } from "react";
import { SectionCard } from "@/components/brand";
import { OperationalWorkspace } from "./operational-workspace";
import {
  exerciseActor,
  exerciseProjection,
  exerciseSchema,
  newAgencyExercise,
  replyToExerciseRequest,
  sendExerciseRequest,
  type AgencyExercise,
  type ExerciseReply,
} from "@/lib/simulation/agency-exercise";

const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
const button =
  "rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-40";
const secondary =
  "rounded-md border border-border px-3 py-2 text-sm font-semibold disabled:opacity-40";
function coordinates(lat: string, lng: string) {
  if (!lat.trim() && !lng.trim()) return undefined;
  if (
    !lat.trim() ||
    !lng.trim() ||
    !Number.isFinite(Number(lat)) ||
    !Number.isFinite(Number(lng)) ||
    Math.abs(Number(lat)) > 90 ||
    Math.abs(Number(lng)) > 180
  )
    throw new Error(
      "Enter both valid latitude and longitude, or leave both blank for unknown location.",
    );
  return { latitude: Number(lat), longitude: Number(lng) };
}

export function AgencyExerciseWorkspace({ accountId }: { accountId: string }) {
  const storageKey = `airs-agency-exercise-v1:${accountId}`;
  const [state, setState] = useState<AgencyExercise>(newAgencyExercise);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState("");
  const [actor, setActor] = useState("requester");
  const [recipient, setRecipient] = useState("entity-0");
  const [request, setRequest] = useState("");
  const [selected, setSelected] = useState("");
  const [decision, setDecision] = useState<ExerciseReply["decision"]>("accepted");
  const [replyText, setReplyText] = useState("");
  const [resource, setResource] = useState("");
  const [resourceStatus, setResourceStatus] = useState<ExerciseReply["status"]>("unknown_location");
  const [resourceLocation, setResourceLocation] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [newName, setNewName] = useState("");
  const [capability, setCapability] = useState("");
  const [relationship, setRelationship] =
    useState<AgencyExercise["entities"][number]["relationship"]>("Associate");
  const [editing, setEditing] = useState(true);
  const [restart, setRestart] = useState(false);
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) {
        const parsed = exerciseSchema.parse(JSON.parse(saved));
        setState(parsed);
        setEditing(!parsed.title);
      }
    } catch {
      setNotice(
        "The saved exercise could not be restored. Start a new exercise or import an exported copy.",
      );
    }
    setLoaded(true);
  }, [storageKey]);
  useEffect(() => {
    if (!loaded) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      setNotice("Browser storage is unavailable. Export the exercise to keep your work.");
    }
  }, [state, loaded, storageKey]);
  const projection = useMemo(() => exerciseProjection(state), [state]);
  const inbox = state.requests.filter((r) => r.to === actor);
  const selectedRequest = inbox.find((r) => r.id === selected);
  const actors = [{ id: "requester", name: state.requestingAgency }, ...state.entities];
  function safely(action: () => void) {
    try {
      action();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to save the exercise change.");
    }
  }
  function changeActor(id: string) {
    setActor(id);
    setSelected("");
    setReplyText("");
    setResource("");
    setLat("");
    setLng("");
    setResourceLocation("");
    setRecipient(id === "requester" ? "entity-0" : "requester");
  }
  function chooseRequest(id: string) {
    setSelected(id);
    setReplyText("");
    const previous = state.requests.find((r) => r.id === id)?.replies.at(-1);
    setResource(previous?.resource ?? "");
    setResourceLocation(previous?.location ?? "");
    setResourceStatus(previous?.status ?? "unknown_location");
    setLat(previous?.position ? String(previous.position.latitude) : "");
    setLng(previous?.position ? String(previous.position.longitude) : "");
    setDecision(previous && previous.decision !== "declined" ? "update" : "accepted");
  }
  if (!loaded) return <p>Loading agency exercise…</p>;
  return (
    <div className="space-y-5">
      <div className="rounded-md border border-warning/40 bg-warning/10 p-4">
        <h1 className="text-xl font-semibold">Agency exercise</h1>
        <p className="mt-2 text-sm">
          You operate the requesting agency. Anconison Agency provides the fictional responding
          entities. You control every reply.
        </p>
        <p className="mt-1 text-xs">
          Exercise only · Saved in this browser tab · Export to retain or transfer the exercise · No
          messages are sent to real agencies.
        </p>
      </div>
      {notice && (
        <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">
          {notice}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button className={secondary} onClick={() => setEditing((v) => !v)}>
          {editing ? "Hide incident setup" : "Incident setup"}
        </button>
        <button
          className={secondary}
          onClick={() => {
            const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = "airs-agency-exercise.json";
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          Export exercise
        </button>
        <label className={secondary}>
          Import exercise
          <input
            aria-label="Import exercise"
            className="ml-2 max-w-48 text-xs"
            type="file"
            accept="application/json,.json"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 2_000_000) {
                setNotice("Exercise file is too large (maximum 2 MB).");
                return;
              }
              const text = await file.text();
              safely(() => {
                const parsed = exerciseSchema.parse(JSON.parse(text));
                if (state.requests.length)
                  throw new Error(
                    "Export your current exercise and start a new exercise before importing another.",
                  );
                setState(parsed);
                setEditing(!parsed.title);
                changeActor("requester");
                setNotice("Exercise imported.");
              });
            }}
          />
        </label>
        <button
          className={secondary}
          disabled={!state.title || state.closed}
          onClick={() => {
            setState((s) => ({ ...s, closed: true }));
            setNotice(
              "Exercise closed. Requests, replies and the final picture remain available for review and export.",
            );
          }}
        >
          Close exercise
        </button>
        <button className={secondary} onClick={() => setRestart(true)}>
          New exercise
        </button>
        {restart && (
          <div className="w-full rounded-md border border-border p-3 text-sm">
            Starting a new exercise replaces this tab’s saved exercise. Export first to retain it.{" "}
            <button
              className={secondary}
              onClick={() => {
                setState(newAgencyExercise());
                changeActor("requester");
                setEditing(true);
                setRestart(false);
                setNotice("");
              }}
            >
              Start new exercise
            </button>{" "}
            <button className={secondary} onClick={() => setRestart(false)}>
              Cancel
            </button>
          </div>
        )}
      </div>
      {editing && (
        <SectionCard
          title="Requesting agency and incident"
          description="Name your agency, describe the situation, and establish the objective. Locations remain unknown until you report them."
        >
          <form
            className="grid gap-3 md:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              safely(() => {
                const data = new FormData(e.currentTarget);
                const value = (key: string) => String(data.get(key) ?? "").trim();
                const name = value("agency");
                const title = value("title");
                if (!name || !title)
                  throw new Error("Enter your requesting agency name and incident title.");
                const position = coordinates(value("latitude"), value("longitude"));
                setState((s) => ({
                  ...s,
                  requestingAgency: name,
                  title,
                  situation: value("situation"),
                  objective: value("objective"),
                  location: value("location"),
                  position,
                }));
                setEditing(false);
                setNotice("Incident ready. Select a responding entity and send your request.");
              });
            }}
          >
            <label>
              Your requesting agency
              <input
                className={input}
                name="agency"
                defaultValue={state.requestingAgency}
                required
                disabled={state.closed}
              />
            </label>
            <label>
              Incident title
              <input
                className={input}
                name="title"
                defaultValue={state.title}
                required
                disabled={state.closed}
              />
            </label>
            <label>
              Current situation
              <textarea
                className={input}
                name="situation"
                defaultValue={state.situation}
                disabled={state.closed}
              />
            </label>
            <label>
              Immediate objective
              <textarea
                className={input}
                name="objective"
                defaultValue={state.objective}
                disabled={state.closed}
              />
            </label>
            <label>
              Incident location
              <input
                className={input}
                name="location"
                defaultValue={state.location}
                disabled={state.closed}
              />
            </label>
            <div className="flex gap-2">
              <label>
                Latitude
                <input
                  className={input}
                  name="latitude"
                  defaultValue={state.position?.latitude}
                  disabled={state.closed}
                />
              </label>
              <label>
                Longitude
                <input
                  className={input}
                  name="longitude"
                  defaultValue={state.position?.longitude}
                  disabled={state.closed}
                />
              </label>
            </div>
            <button disabled={state.closed} className={button}>
              Save incident
            </button>
          </form>
        </SectionCard>
      )}
      <SectionCard
        title="Your active role"
        description="Switch to a requested Anconison entity to enter its reply, then return to your requesting agency. Nothing replies automatically."
      >
        <label className="block text-sm font-semibold">
          Acting as
          <select
            className={`${input} mt-2`}
            value={actor}
            onChange={(e) => changeActor(e.target.value)}
          >
            {actors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id === "requester" ? "REQUESTING AGENCY — " : "ANCONISON RESPONDER — "}
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <p className="mt-2 text-sm">
          {actor === "requester"
            ? "You are making requests and reviewing the shared incident picture."
            : `You are controlling replies from ${exerciseActor(state, actor)}. ${inbox.filter((r) => !r.replies.length).length} requests await a reply.`}
        </p>
      </SectionCard>
      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard title={`Send a request as ${exerciseActor(state, actor)}`}>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              safely(() => {
                const next = sendExerciseRequest(state, {
                  id: crypto.randomUUID(),
                  at: Date.now(),
                  from: actor,
                  to: recipient,
                  text: request,
                });
                setState(next);
                setRequest("");
                setNotice(
                  `Request sent within the exercise to ${exerciseActor(state, recipient)}. Switch to that entity to reply.`,
                );
              });
            }}
          >
            <label className="block">
              To
              <select
                className={input}
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              >
                {actors
                  .filter((a) => a.id !== actor)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="block">
              Request
              <textarea
                className={input}
                value={request}
                onChange={(e) => setRequest(e.target.value)}
                placeholder="Describe the requested support, information, staging location, and urgency."
                required
              />
            </label>
            <button className={button} disabled={!state.title || state.closed}>
              Send exercise request
            </button>
          </form>
        </SectionCard>
        <SectionCard
          title={`Inbox — ${exerciseActor(state, actor)}`}
          description="Only the selected receiving entity can reply. Acceptance does not invent a resource or its location."
        >
          {!inbox.length ? (
            <p className="text-sm">No requests received by this entity.</p>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                safely(() => {
                  setState(
                    replyToExerciseRequest(state, selected, {
                      id: crypto.randomUUID(),
                      at: Date.now(),
                      entityId: actor,
                      decision,
                      text: replyText.trim(),
                      resource: decision === "declined" ? "" : resource.trim(),
                      status: resourceStatus,
                      location: resourceLocation.trim(),
                      position: decision === "declined" ? undefined : coordinates(lat, lng),
                    }),
                  );
                  setReplyText("");
                  setNotice(
                    `Reply recorded from ${exerciseActor(state, actor)}. The shared picture has been updated.`,
                  );
                });
              }}
            >
              <label className="block">
                Request
                <select
                  className={input}
                  value={selected}
                  onChange={(e) => chooseRequest(e.target.value)}
                >
                  <option value="">Choose a request</option>
                  {inbox.map((r) => (
                    <option key={r.id} value={r.id}>
                      {exerciseActor(state, r.from)}: {r.text.slice(0, 100)} —{" "}
                      {r.replies.at(-1)?.decision ?? "awaiting reply"}
                    </option>
                  ))}
                </select>
              </label>
              {selectedRequest && (
                <p className="rounded-md bg-muted p-3 text-sm">{selectedRequest.text}</p>
              )}
              <label className="block">
                Response
                <select
                  className={input}
                  value={decision}
                  onChange={(e) => setDecision(e.target.value as ExerciseReply["decision"])}
                >
                  <option value="accepted">Accept</option>
                  <option value="limited">Accept with limits</option>
                  <option value="declined">Decline</option>
                  <option value="update">Progress update</option>
                </select>
              </label>
              <label className="block">
                Reply
                <textarea
                  required
                  className={input}
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                />
              </label>
              {decision !== "declined" && (
                <>
                  <label className="block">
                    Committed resource or team (optional)
                    <input
                      className={input}
                      value={resource}
                      onChange={(e) => setResource(e.target.value)}
                    />
                  </label>
                  <label className="block">
                    Resource status
                    <select
                      className={input}
                      value={resourceStatus}
                      onChange={(e) => setResourceStatus(e.target.value as ExerciseReply["status"])}
                    >
                      <option value="unknown_location">Location unknown</option>
                      <option value="active">Assigned</option>
                      <option value="en_route">En route</option>
                      <option value="on_scene">On scene</option>
                    </select>
                  </label>
                  <label className="block">
                    Reported location
                    <input
                      className={input}
                      value={resourceLocation}
                      onChange={(e) => setResourceLocation(e.target.value)}
                    />
                  </label>
                  <div className="flex gap-2">
                    <label>
                      Latitude
                      <input
                        className={input}
                        value={lat}
                        onChange={(e) => setLat(e.target.value)}
                      />
                    </label>
                    <label>
                      Longitude
                      <input
                        className={input}
                        value={lng}
                        onChange={(e) => setLng(e.target.value)}
                      />
                    </label>
                  </div>
                </>
              )}
              <button className={button} disabled={!selected || state.closed}>
                Record entity reply
              </button>
            </form>
          )}
        </SectionCard>
      </div>
      <SectionCard
        title="Requests and replies"
        description="Shared exercise history, with each request and every reply attributed to its entity."
      >
        {!state.requests.length && <p className="text-sm">No requests yet.</p>}
        <div className="space-y-3">
          {state.requests.map((r) => (
            <article key={r.id} className="rounded-md border border-border p-3 text-sm">
              <p className="font-semibold">
                {exerciseActor(state, r.from)} → {exerciseActor(state, r.to)}
              </p>
              <p>{r.text}</p>
              <p className="text-xs text-muted-foreground">
                {new Date(r.at).toLocaleString()} · {r.replies.at(-1)?.decision ?? "Awaiting reply"}
              </p>
              {r.replies.map((p) => (
                <div key={p.id} className="mt-2 border-l-2 border-primary pl-3">
                  <strong>
                    {exerciseActor(state, p.entityId)} · {p.decision}
                  </strong>
                  <p>{p.text}</p>
                  <p className="text-xs">
                    {p.resource && `${p.resource} · ${p.status.replaceAll("_", " ")} · `}
                    {new Date(p.at).toLocaleString()}
                  </p>
                </div>
              ))}
              <button
                className={`${secondary} mt-2`}
                disabled={state.closed}
                onClick={() => {
                  changeActor(r.to);
                  chooseRequest(r.id);
                }}
              >
                Reply as {exerciseActor(state, r.to)}
              </button>
            </article>
          ))}
        </div>
      </SectionCard>
      <OperationalWorkspace projection={projection} />
      <SectionCard
        title="Anconison Agency — fictional entity directory"
        description="These are exercise entities. Partner, Associate and Participant describe the intended exercise relationship; they do not grant real system access."
      >
        <div className="grid gap-2 md:grid-cols-3">
          {state.entities.map((e) => (
            <div key={e.id} className="rounded-md border border-border p-3 text-sm">
              <strong>{e.name}</strong>
              <p>{e.capability}</p>
              <p className="text-xs text-muted-foreground">{e.relationship} · Fictional</p>
            </div>
          ))}
        </div>
        <form
          className="mt-4 grid gap-3 md:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newName.trim() || state.closed) return;
            setState((s) => ({
              ...s,
              entities: [
                ...s.entities,
                {
                  id: crypto.randomUUID(),
                  name: newName.trim(),
                  capability: capability.trim(),
                  relationship,
                },
              ],
            }));
            setNewName("");
            setCapability("");
          }}
        >
          <label>
            Fictional entity name
            <input
              required
              className={input}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </label>
          <label>
            Capabilities
            <input
              className={input}
              value={capability}
              onChange={(e) => setCapability(e.target.value)}
            />
          </label>
          <label>
            Relationship
            <select
              className={input}
              value={relationship}
              onChange={(e) => setRelationship(e.target.value as typeof relationship)}
            >
              <option>Partner</option>
              <option>Associate</option>
              <option>Participant</option>
            </select>
          </label>
          <button className={button} disabled={state.closed}>
            Add fictional entity
          </button>
        </form>
      </SectionCard>
    </div>
  );
}
