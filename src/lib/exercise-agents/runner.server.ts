import { readResourceOrders, reportResourceOrder } from "@/lib/incidents/resource-orders.server";
import {
  listPendingInvitations,
  partnerParticipationAction,
} from "@/lib/incidents/participation.server";
import { listIncidents } from "@/lib/incidents/incidents.server";
import {
  readAgencyRequests,
  respondToAgencyRequest,
} from "@/lib/incidents/request-responses.server";
import { listResources, shareResource, setResourceStatus } from "@/lib/resources/resources.server";
import {
  assignToIncident,
  listIncidentAssignments,
  endAssignment,
} from "@/lib/resources/assignments.server";
import { withAuthorized } from "@/lib/auth/authorize.server";
import { listPersonnel, setPersonnelAvailability } from "@/lib/resources/personnel.server";
import { readFramework, writeFramework } from "@/lib/operations/framework.server";
import { observationSchema } from "@/lib/operations/framework";
import { aidDecision, type ExerciseAgency } from "./model";
import { planExercise, validatePlan, EXERCISE_GUIDANCE, type ExercisePlan } from "./planner.server";

export async function runAgencyCycle(input: {
  agency: ExerciseAgency;
  orgId: string;
  requesterOrgId: string;
  adminToken: string;
  commandToken: string;
}) {
  const { agency, orgId, requesterOrgId, adminToken, commandToken } = input;
  const meta = { userAgent: `Anconison exercise agent/${agency.key}` };
  const released = await withAuthorized(
    {
      token: commandToken,
      orgId,
      permission: "resource.read",
      action: "exercise.release_check",
      resourceType: "assignment",
      audit: false,
    },
    async (ctx, q) =>
      q.query<{ id: string; resourceId: string | null; personId: string | null }>(
        `SELECT a.id,a.resource_id AS "resourceId",a.person_id AS "personId" FROM airs.incident_assignments a LEFT JOIN airs.incident_rooms r ON r.id=a.incident_id WHERE a.org_id=$1 AND a.status IN ('assigned','deploying','active') AND (r.id IS NULL OR r.status IN ('closing','closed','archived'))`,
        [ctx.orgId],
      ),
  );
  for (const assignment of released) {
    await endAssignment(
      commandToken,
      orgId,
      {
        assignmentId: assignment.id,
        status: "released",
        reason: "Exercise incident closed or agency access ended",
      },
      meta,
    );
    if (assignment.resourceId)
      await setResourceStatus(
        adminToken,
        orgId,
        { resourceId: assignment.resourceId, readinessStatus: "available" },
        meta,
      );
    if (assignment.personId)
      await setPersonnelAvailability(
        adminToken,
        orgId,
        { personId: assignment.personId, availabilityStatus: "available" },
        meta,
      );
  }
  for (const invite of await listPendingInvitations(commandToken, orgId, meta)) {
    if (invite.ownerOrgId !== requesterOrgId || invite.incidentStatus !== "active") continue;
    await partnerParticipationAction(commandToken, orgId, invite.participantId, "accept", meta);
  }
  const rooms = await listIncidents(commandToken, orgId, meta);
  for (const room of rooms.filter((r) => r.orgId === requesterOrgId && r.status === "active")) {
    const command = await readResourceOrders(commandToken, orgId, room.id);
    for (const order of command.orders.filter(
      (o) => o.recipientOrgId === orgId && command.assignments.some((a) => a.id === o.assignmentId),
    )) {
      const age = Date.now() - Date.parse(order.reportedAt ?? order.createdAt);
      const status =
        order.status === "ordered"
          ? "acknowledged"
          : order.status === "acknowledged" && age >= 30000
            ? "en_route"
            : order.status === "en_route" && age >= 30000
              ? "arrived"
              : null;
      if (status)
        await reportResourceOrder(commandToken, orgId, {
          incidentId: room.id,
          orderId: order.id,
          status,
          message: `EXERCISE ONLY — ${agency.name} ${status.replaceAll("_", " ")} for command task: ${order.mission.slice(0, 400)}. Destination set by requesting agency: ${order.destination}. Compressed exercise progression; not a real movement or arrival.`,
        });
    }
    const board = await readAgencyRequests(commandToken, orgId, room.id, meta);
    // Persisted plans survive worker restarts. Follow-up reports stay inside the
    // same active incident and agency permissions, including after commitment.
    const exerciseBoard = await readFramework(commandToken, room.id);
    for (const receipt of exerciseBoard.observations.filter(
      (o) => o.orgId === orgId && o.dataClass === "exercise_plan",
    )) {
      const requestId = receipt.sourceRecordId.split(":")[0];
      const request = board.requests.find((r) => r.id === requestId);
      if (
        !request ||
        ["cancelled", "denied"].includes(request.status) ||
        !board.responses.some(
          (r) => r.requestId === requestId && ["filled", "partially_filled"].includes(r.status),
        )
      )
        continue;
      if (command.orders.some((o) => o.recipientOrgId === orgId)) continue; // Command orders supersede autonomous narrative movement.
      const plan = validatePlan(JSON.parse(receipt.summary), request.quantity);
      for (const [index, update] of plan.updates.entries()) {
        const sourceRecordId = `${requestId}:progress-${index}`;
        if (
          Date.now() < Date.parse(receipt.sourceTimestamp) + update.afterSeconds * 1000 ||
          exerciseBoard.observations.some(
            (o) => o.orgId === orgId && o.sourceRecordId === sourceRecordId,
          )
        )
          continue;
        await writeFramework(commandToken, {
          action: "report",
          value: observationSchema.parse({
            incidentId: room.id,
            originatingEntity: agency.name,
            platform: "Anconison intelligent exercise responder",
            sourceRecordId,
            sourceTimestamp: new Date().toISOString(),
            dataClass: "exercise_update",
            entityType: "responder",
            label: `EXERCISE ${agency.name} update`,
            summary: `SIMULATED — generated exercise update, not an observed event. T+${update.afterSeconds}s (compressed exercise time): ${update.message}`,
            state: "unverified",
            verification: "unverified",
            confidence: null,
            geographicPrecision: "unknown",
            latitude: null,
            longitude: null,
            staleAfterSeconds: 3600,
          }),
        });
      }
    }
    for (const request of board.requests.filter(
      (r) => r.recipientOrgId === orgId && !["cancelled", "filled", "denied"].includes(r.status),
    )) {
      if (board.responses.some((r) => r.requestId === request.id && r.status !== "acknowledged"))
        continue;
      if (!board.responses.some((r) => r.requestId === request.id))
        await respondToAgencyRequest(
          commandToken,
          orgId,
          {
            incidentId: room.id,
            requestId: request.id,
            status: "acknowledged",
            message: `EXERCISE — ${agency.name} received your request. Reviewing ${agency.capability.toLowerCase()} and available units.`,
          },
          meta,
        );
      const resources = await listResources(adminToken, orgId, {}, meta);
      const assignments = await listIncidentAssignments(commandToken, orgId, room.id, meta);
      const personnel = await listPersonnel(adminToken, orgId, meta);
      const prefix = `[${request.id}]`;
      // Assignment IDs and committed resource IDs are recovered from report receipts
      // on retry; one runner is protected by a database advisory lock.
      const framework = await readFramework(commandToken, room.id);
      const prior = framework.observations.filter(
        (o) => o.orgId === orgId && o.sourceRecordId.startsWith(`${request.id}:`),
      );
      const already = new Set(prior.map((o) => o.sourceRecordId.split(":")[1]));
      const candidates = resources.filter(
        (r) => r.readinessStatus === "available" || already.has(r.id),
      );
      let decision = aidDecision(agency, request.resourceKind, request.quantity, candidates.length);
      let plan: ExercisePlan | null = null;
      if (process.env.EXERCISE_INTELLIGENCE === "openai") {
        const receipt = prior.find((o) => o.dataClass === "exercise_plan");
        try {
          plan = receipt
            ? validatePlan(JSON.parse(receipt.summary), decision.count)
            : await planExercise(`${orgId}:${request.id}`, {
                agency,
                incidentName: `${room.name} · Incident location: ${room.geographicDescription || "not set by command"}`,
                description: request.description,
                stagingLocation: request.stagingLocation,
                requestedUnits: request.quantity,
                maxUnits: decision.count,
                observations: framework.observations
                  .filter((o) => o.dataClass !== "exercise_plan")
                  .slice(0, 12)
                  .map((o) => `${o.label}: ${o.summary}`),
              });
        } catch {
          if (
            !board.responses.some(
              (r) =>
                r.requestId === request.id && r.message.includes("Intelligent planning is delayed"),
            )
          )
            await respondToAgencyRequest(
              commandToken,
              orgId,
              {
                incidentId: room.id,
                requestId: request.id,
                status: "acknowledged",
                message:
                  "EXERCISE — Intelligent planning is delayed or unavailable. This request remains unresolved; no model-generated commitment is being claimed.",
              },
              meta,
            );
          continue;
        }
        if (plan && !receipt)
          await writeFramework(commandToken, {
            action: "report",
            value: observationSchema.parse({
              incidentId: room.id,
              originatingEntity: agency.name,
              platform: "Anconison intelligent exercise responder",
              sourceRecordId: `${request.id}:plan`,
              sourceTimestamp: new Date().toISOString(),
              dataClass: "exercise_plan",
              entityType: "responder",
              label: `EXERCISE plan: ${agency.name}`,
              summary: JSON.stringify(plan),
              state: "unverified",
              verification: "unverified",
              confidence: null,
              geographicPrecision: "unknown",
              latitude: null,
              longitude: null,
              staleAfterSeconds: 86400,
            }),
          });
        if (plan)
          decision = {
            count: plan.units,
            status:
              plan.units === 0
                ? "denied"
                : plan.units < request.quantity
                  ? "partially_filled"
                  : "filled",
            reason: plan.response,
          };
      }
      const committed: string[] = [];
      for (const resource of candidates.slice(0, decision.count)) {
        await shareResource(
          commandToken,
          orgId,
          {
            resourceId: resource.id,
            incidentId: room.id,
            classification: "participating_orgs",
            disclosureProfile: "operational",
            expiresAt: room.scheduledExpiresAt ?? new Date(Date.now() + 86400000).toISOString(),
          },
          meta,
        );
        if (
          !assignments.some(
            (a) =>
              a.orgId === orgId &&
              a.resourceId === resource.id &&
              !["released", "completed", "cancelled"].includes(a.status),
          )
        )
          await assignToIncident(
            commandToken,
            orgId,
            {
              incidentId: room.id,
              assignmentType: "resource",
              resourceId: resource.id,
              assignedRole: "other",
              disclosureProfile: "operational",
            },
            meta,
          );
        const crew = personnel.find((p) => p.callsign === resource.callsign);
        if (
          crew &&
          !assignments.some(
            (a) =>
              a.personId === crew.id && !["released", "completed", "cancelled"].includes(a.status),
          )
        ) {
          await assignToIncident(
            commandToken,
            orgId,
            {
              incidentId: room.id,
              assignmentType: "person",
              personId: crew.id,
              assignedRole: "other",
              disclosureProfile: "operational",
            },
            meta,
          );
          await setPersonnelAvailability(
            adminToken,
            orgId,
            { personId: crew.id, availabilityStatus: "assigned" },
            meta,
          );
        }
        if (!already.has(resource.id))
          await writeFramework(commandToken, {
            action: "report",
            value: observationSchema.parse({
              incidentId: room.id,
              originatingEntity: agency.name,
              platform: plan
                ? "Anconison intelligent exercise responder"
                : "Anconison automated exercise responder",
              sourceRecordId: `${request.id}:${resource.id}`,
              sourceTimestamp: new Date().toISOString(),
              dataClass: "resource_status",
              entityType: agency.key === "uas" ? "uas" : "ground_unit",
              label: resource.displayName,
              summary: plan
                ? `SIMULATED ASSUMPTION — ${prefix} Planned staging for ${resource.displayName}: ${plan.staging.label}. This generated exercise point is not a reported unit position, verified address or arrival. ${plan.assumptions.join("; ")}`
                : `EXERCISE ${prefix} ${resource.displayName} committed by ${agency.name}. Requested staging: ${request.stagingLocation || "not provided"}. Current position has not been reported. No real dispatch or movement.`,
              state: plan ? "unverified" : "unknown",
              verification: plan ? "unverified" : "reported",
              confidence: null,
              geographicPrecision: "unknown",
              latitude: null,
              longitude: null,
              staleAfterSeconds: 86400,
            }),
          });
        await setResourceStatus(
          adminToken,
          orgId,
          { resourceId: resource.id, readinessStatus: "assigned" },
          meta,
        );
        committed.push(resource.displayName);
      }
      await respondToAgencyRequest(
        commandToken,
        orgId,
        {
          incidentId: room.id,
          requestId: request.id,
          status: decision.status,
          message: plan
            ? `INTELLIGENT EXERCISE RESPONSE — ${decision.reason}\nCommitted: ${committed.join("; ") || "none"}.\nSimulation assumptions: ${plan.assumptions.join("; ") || "none"}.\nUnresolved needs: ${plan.unmetNeeds.join("; ") || "none identified by this agency"}.\nStaging proposal only: ${plan.staging.label}. Awaiting requesting agency command assignment. Follow-up updates use compressed exercise time. Commitment does not confirm arrival or resolve the incident. Guidance: ${EXERCISE_GUIDANCE.version}.`
            : `EXERCISE — ${decision.reason} ${committed.join("; ")}${committed.length ? ". " : ""}Requested staging: ${request.stagingLocation || "not provided"}. Locations and arrival times are not yet reported. ${agency.capability}. This is an automated exercise response, not a real dispatch.`,
        },
        meta,
      );
    }
  }
}
