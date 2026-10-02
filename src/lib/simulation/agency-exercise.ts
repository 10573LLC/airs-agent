import { z } from "zod";
import type { SimOperationalProjection } from "./operational";

const entity = z.object({
  id: z.string(),
  name: z.string().min(1),
  capability: z.string(),
  relationship: z.enum(["Partner", "Associate", "Participant"]),
});
const position = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
const reply = z.object({
  id: z.string(),
  at: z.number(),
  entityId: z.string(),
  decision: z.enum(["accepted", "limited", "declined", "update"]),
  text: z.string().min(1),
  resource: z.string(),
  location: z.string(),
  position: position.optional(),
  status: z.enum(["active", "en_route", "on_scene", "unknown_location"]),
});
export const exerciseSchema = z.object({
  version: z.literal(1),
  requestingAgency: z.string().min(1),
  title: z.string(),
  situation: z.string(),
  objective: z.string(),
  location: z.string(),
  position: position.optional(),
  closed: z.boolean(),
  entities: z.array(entity),
  requests: z.array(
    z.object({
      id: z.string(),
      at: z.number(),
      from: z.string(),
      to: z.string(),
      text: z.string().min(1),
      replies: z.array(reply),
    }),
  ),
});
export type AgencyExercise = z.infer<typeof exerciseSchema>;
export type ExerciseReply = z.infer<typeof reply>;
const services = [
  ["Police", "Patrol, perimeter and investigation", "Partner"],
  ["Fire & Rescue", "Fire suppression and rescue", "Partner"],
  ["EMS", "Triage, treatment and transport", "Partner"],
  ["Emergency Dispatch", "Dispatch and communications", "Partner"],
  ["UAS Unit", "Aerial observation and search", "Partner"],
  ["Emergency Management", "Mutual aid and coordination", "Associate"],
  ["Hospital", "Receiving capacity and patient coordination", "Associate"],
  ["Hazmat Team", "Hazard identification and containment", "Associate"],
  ["Search & Rescue", "Ground search and extraction", "Associate"],
  ["Utilities", "Infrastructure status and isolation", "Participant"],
  ["Public Works", "Roads, barriers and equipment", "Participant"],
  ["Shelter & Relief", "Shelter and family assistance", "Participant"],
] as const;
export function newAgencyExercise(): AgencyExercise {
  return {
    version: 1,
    requestingAgency: "Requesting Agency",
    title: "",
    situation: "",
    objective: "",
    location: "",
    closed: false,
    entities: services.map(([name, capability, relationship], index) => ({
      id: `entity-${index}`,
      name: `Anconison ${name}`,
      capability,
      relationship,
    })),
    requests: [],
  };
}
export function sendExerciseRequest(
  state: AgencyExercise,
  input: { id: string; at: number; from: string; to: string; text: string },
): AgencyExercise {
  if (state.closed || !state.title.trim() || !input.text.trim())
    throw new Error("Start an incident and enter a request before sending.");
  const validActor = (id: string) => id === "requester" || state.entities.some((e) => e.id === id);
  if (!validActor(input.from) || !validActor(input.to) || input.from === input.to)
    throw new Error("Select a different receiving entity.");
  if (state.requests.some((r) => r.id === input.id)) throw new Error("Request already exists.");
  return {
    ...state,
    requests: [...state.requests, { ...input, text: input.text.trim(), replies: [] }],
  };
}
export function replyToExerciseRequest(
  state: AgencyExercise,
  requestId: string,
  input: ExerciseReply,
): AgencyExercise {
  const parsed = reply.parse(input);
  const request = state.requests.find((r) => r.id === requestId);
  if (state.closed || !request || request.to !== parsed.entityId)
    throw new Error("Only the receiving entity can reply to an open exercise request.");
  if (state.requests.some((r) => r.replies.some((p) => p.id === parsed.id)))
    throw new Error("Reply already exists.");
  if (
    parsed.decision === "update" &&
    !request.replies.some((p) => p.decision === "accepted" || p.decision === "limited")
  )
    throw new Error("Accept or limit the request before reporting progress.");
  return {
    ...state,
    requests: state.requests.map((r) =>
      r.id === requestId ? { ...r, replies: [...r.replies, parsed] } : r,
    ),
  };
}
export function exerciseActor(state: AgencyExercise, id: string) {
  return id === "requester"
    ? state.requestingAgency
    : (state.entities.find((e) => e.id === id)?.name ?? "Unknown entity");
}
export function exerciseProjection(state: AgencyExercise): SimOperationalProjection {
  const startedAt = state.requests[0]?.at ?? 0;
  const elapsed = (at: number) => Math.max(0, (at - startedAt) / 1000);
  const rows = state.requests.flatMap((request) =>
    request.replies.map((response) => ({ request, response })),
  );
  const latest = state.requests.map((request) => ({ request, response: request.replies.at(-1) }));
  const resources = latest
    .filter(
      ({ response }) => response && response.decision !== "declined" && response.resource.trim(),
    )
    .map(({ request, response: r }) => ({
      id: request.id,
      name: r!.resource,
      owner: exerciseActor(state, r!.entityId),
      category: "Controller-reported exercise resource",
      status: r!.status,
      sinceSeconds: elapsed(r!.at),
      location:
        r!.location ||
        (r!.position
          ? `${r!.position.latitude}, ${r!.position.longitude}`
          : "Location not reported"),
    }));
  const mapItems: SimOperationalProjection["mapItems"] = [];
  if (state.position)
    mapItems.push({
      id: "incident",
      label: state.title || "Incident",
      tone: "own",
      geometry: { type: "Point", coordinates: [state.position.longitude, state.position.latitude] },
      detail: state.location || "Controller-reported incident location",
    });
  for (const { request, response: r } of latest)
    if (r?.position && r.resource.trim() && r.decision !== "declined")
      mapItems.push({
        id: request.id,
        label: r.resource,
        tone: "partner",
        geometry: { type: "Point", coordinates: [r.position.longitude, r.position.latitude] },
        detail: `${exerciseActor(state, r.entityId)} · ${r.text} · ${new Date(r.at).toLocaleString()} · exercise report`,
      });
  const actions: SimOperationalProjection["actions"] = state.requests
    .flatMap((request) => [
      {
        id: request.id,
        atSeconds: elapsed(request.at),
        actor: exerciseActor(state, request.from),
        action: "Request",
        target: `${exerciseActor(state, request.to)}: ${request.text}`,
        channel: "Incident workspace" as const,
        status: request.replies.length ? ("completed" as const) : ("pending" as const),
      },
      ...request.replies.map((r) => ({
        id: r.id,
        atSeconds: elapsed(r.at),
        actor: exerciseActor(state, r.entityId),
        action: r.decision,
        target: r.text,
        channel: "Incident workspace" as const,
        status: "completed" as const,
      })),
    ])
    .sort((a, b) => a.atSeconds - b.atSeconds);
  const involved = new Set(state.requests.flatMap((r) => [r.from, r.to]));
  const agencies: SimOperationalProjection["agencies"] = state.entities
    .filter((e) => involved.has(e.id))
    .map((e) => ({
      id: e.id,
      name: e.name,
      role: e.capability,
      informationPath: "manual_entry",
      status: latest.some(
        (r) => r.request.to === e.id && r.response && r.response.decision !== "declined",
      )
        ? "active"
        : "requested",
      sinceSeconds: 0,
      coordination: `${e.relationship} · fictional entity; replies entered by exercise controller`,
    }));
  return {
    incidentName: state.title || "Create your exercise incident",
    incidentStatus: state.closed
      ? "Closed exercise"
      : state.title
        ? "Active exercise"
        : "Awaiting incident",
    commandLead: state.requestingAgency,
    priority: state.objective || "Objective not provided",
    agencies,
    resources,
    mapItems,
    actions,
    operationalPicture: {
      situation: state.situation || "Situation not provided.",
      peopleAndAssets: resources.length
        ? resources.map((r) => `${r.name} · ${r.owner} · ${r.status.replaceAll("_", " ")}`)
        : ["No resources committed."],
      locations: [
        state.location || "Incident location not provided.",
        ...resources.map((r) => `${r.name}: ${r.location}`),
      ],
      timing: rows.length
        ? `Latest reply: ${new Date(Math.max(...rows.map((r) => r.response.at))).toLocaleString()}`
        : "No entity has replied.",
      context:
        "You operate the requesting agency. Anconison Agency supplies fictional responding entities. All replies are controlled by you.",
      nextActions: [
        state.objective || "Set the incident objective.",
        `${state.requests.filter((r) => !r.replies.length).length} requests awaiting a reply.`,
      ],
      gaps: [
        ...(!state.position ? ["Incident map position not provided."] : []),
        ...latest
          .filter(
            (r) =>
              r.response?.resource && !r.response.position && r.response.decision !== "declined",
          )
          .map((r) => `${r.response!.resource}: map position unknown.`),
      ],
    },
  };
}
