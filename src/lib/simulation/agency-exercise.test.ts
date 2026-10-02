import { describe, expect, it } from "vitest";
import {
  exerciseActor,
  exerciseProjection,
  exerciseSchema,
  newAgencyExercise,
  replyToExerciseRequest,
  sendExerciseRequest,
  type ExerciseReply,
} from "./agency-exercise";

function requested() {
  return sendExerciseRequest(
    {
      ...newAgencyExercise(),
      requestingAgency: "User Command Agency",
      title: "Critical incident",
      situation: "Reported building collapse",
      objective: "Locate and rescue missing people",
    },
    { id: "request-1", at: 1000, from: "requester", to: "entity-1", text: "Send a rescue team" },
  );
}
function response(patch: Partial<ExerciseReply> = {}): ExerciseReply {
  return {
    id: "reply-1",
    at: 2000,
    entityId: "entity-1",
    decision: "accepted",
    text: "One rescue team assigned",
    resource: "Rescue 1",
    location: "",
    status: "en_route",
    ...patch,
  };
}
describe("manual Anconison responder exercise", () => {
  it("keeps the user's requesting agency separate from the Anconison responders", () => {
    const state = requested();
    expect(exerciseActor(state, "requester")).toBe("User Command Agency");
    expect(state.entities).toHaveLength(12);
    expect(state.entities.every((e) => e.name.startsWith("Anconison "))).toBe(true);
    expect(state.requests[0].replies).toEqual([]);
    expect(exerciseProjection(state).resources).toEqual([]);
    expect(exerciseProjection(state).commandLead).toBe("User Command Agency");
  });
  it("rejects replies from other entities and premature progress updates", () => {
    expect(() =>
      replyToExerciseRequest(requested(), "request-1", response({ entityId: "entity-2" })),
    ).toThrow("receiving entity");
    expect(() =>
      replyToExerciseRequest(requested(), "request-1", response({ decision: "update" })),
    ).toThrow("Accept or limit");
  });
  it("projects accepted resources without inventing coordinates", () => {
    const state = replyToExerciseRequest(requested(), "request-1", response());
    const projection = exerciseProjection(state);
    expect(projection.resources[0]).toMatchObject({
      name: "Rescue 1",
      owner: "Anconison Fire & Rescue",
      location: "Location not reported",
      status: "en_route",
    });
    expect(projection.mapItems).toEqual([]);
    expect(projection.operationalPicture?.gaps).toContain("Rescue 1: map position unknown.");
  });
  it("preserves each reply while updating a resource's current position", () => {
    const first = replyToExerciseRequest(requested(), "request-1", response());
    const updated = replyToExerciseRequest(
      first,
      "request-1",
      response({
        id: "reply-2",
        at: 3000,
        decision: "update",
        text: "Arrived at north entrance",
        status: "on_scene",
        position: { latitude: 42.6, longitude: -73.7 },
      }),
    );
    const projection = exerciseProjection(updated);
    expect(updated.requests[0].replies).toHaveLength(2);
    expect(projection.resources).toHaveLength(1);
    expect(projection.mapItems[0].geometry).toEqual({ type: "Point", coordinates: [-73.7, 42.6] });
    expect(projection.actions).toHaveLength(3);
  });
  it("does not treat a decline as a committed resource", () => {
    const state = replyToExerciseRequest(
      requested(),
      "request-1",
      response({ decision: "declined", text: "No team available" }),
    );
    expect(exerciseProjection(state).resources).toEqual([]);
    expect(state.requests[0].replies[0].text).toBe("No team available");
  });
  it("rejects invalid coordinates, duplicate requests, and closed-exercise writes", () => {
    expect(() =>
      replyToExerciseRequest(
        requested(),
        "request-1",
        response({ position: { latitude: 91, longitude: 0 } }),
      ),
    ).toThrow();
    expect(() => sendExerciseRequest(requested(), requested().requests[0])).toThrow(
      "already exists",
    );
    const closed = { ...requested(), closed: true };
    expect(() => replyToExerciseRequest(closed, "request-1", response())).toThrow();
    expect(() =>
      sendExerciseRequest(closed, {
        id: "new",
        at: 2000,
        from: "requester",
        to: "entity-2",
        text: "Help",
      }),
    ).toThrow();
    expect(exerciseProjection(closed).incidentStatus).toBe("Closed exercise");
  });
  it("round trips an exercise without losing entity attribution or history", () => {
    const state = replyToExerciseRequest(
      requested(),
      "request-1",
      response({ decision: "limited", text: "One team only; no heavy rescue equipment" }),
    );
    expect(exerciseSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(() => exerciseSchema.parse({ version: 3 })).toThrow();
  });
});
