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
import { assignToIncident, listIncidentAssignments, endAssignment } from "@/lib/resources/assignments.server";
import { withAuthorized } from "@/lib/auth/authorize.server";
import { listPersonnel, setPersonnelAvailability } from "@/lib/resources/personnel.server";
import { readFramework, writeFramework } from "@/lib/operations/framework.server";
import { observationSchema } from "@/lib/operations/framework";
import { aidDecision, type ExerciseAgency } from "./model";

export async function runAgencyCycle(input: {
  agency: ExerciseAgency;
  orgId: string;
  requesterOrgId: string;
  adminToken: string;
  commandToken: string;
}) {
  const { agency, orgId, requesterOrgId, adminToken, commandToken } = input;
  const meta = { userAgent: `Anconison exercise agent/${agency.key}` };
  const released = await withAuthorized({token:commandToken,orgId,permission:"resource.read",action:"exercise.release_check",resourceType:"assignment",audit:false},async(ctx,q)=>q.query<{id:string;resourceId:string|null;personId:string|null}>(`SELECT a.id,a.resource_id AS "resourceId",a.person_id AS "personId" FROM airs.incident_assignments a LEFT JOIN airs.incident_rooms r ON r.id=a.incident_id WHERE a.org_id=$1 AND a.status IN ('assigned','deploying','active') AND (r.id IS NULL OR r.status IN ('closing','closed','archived'))`,[ctx.orgId]));
  for(const assignment of released) {
    await endAssignment(commandToken,orgId,{assignmentId:assignment.id,status:"released",reason:"Exercise incident closed or agency access ended"},meta);
    if(assignment.resourceId)await setResourceStatus(adminToken,orgId,{resourceId:assignment.resourceId,readinessStatus:"available"},meta);
    if(assignment.personId)await setPersonnelAvailability(adminToken,orgId,{personId:assignment.personId,availabilityStatus:"available"},meta);
  }
  for (const invite of await listPendingInvitations(commandToken, orgId, meta)) {
    if (invite.ownerOrgId !== requesterOrgId || invite.incidentStatus !== "active") continue;
    await partnerParticipationAction(commandToken, orgId, invite.participantId, "accept", meta);
  }
  const rooms = await listIncidents(commandToken, orgId, meta);
  for (const room of rooms.filter((r) => r.orgId === requesterOrgId && r.status === "active")) {
    const board = await readAgencyRequests(commandToken, orgId, room.id, meta);
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
      const personnel = await listPersonnel(adminToken,orgId,meta);
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
      const decision = aidDecision(
        agency,
        request.resourceKind,
        request.quantity,
        candidates.length,
      );
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
        const crew=personnel.find(p=>p.callsign===resource.callsign);
        if(crew&&!assignments.some(a=>a.personId===crew.id&&!['released','completed','cancelled'].includes(a.status))) {
          await assignToIncident(commandToken,orgId,{incidentId:room.id,assignmentType:"person",personId:crew.id,assignedRole:"other",disclosureProfile:"operational"},meta);
          await setPersonnelAvailability(adminToken,orgId,{personId:crew.id,availabilityStatus:"assigned"},meta);
        }
        if (!already.has(resource.id))
          await writeFramework(commandToken, {
            action: "report",
            value: observationSchema.parse({
              incidentId: room.id,
              originatingEntity: agency.name,
              platform: "Anconison automated exercise responder",
              sourceRecordId: `${request.id}:${resource.id}`,
              sourceTimestamp: new Date().toISOString(),
              dataClass: "resource_status",
              entityType: agency.key === "uas" ? "uas" : "ground_unit",
              label: resource.displayName,
              summary: `EXERCISE ${prefix} ${resource.displayName} committed by ${agency.name}. Requested staging: ${request.stagingLocation || "not provided"}. Current position has not been reported. No real dispatch or movement.`,
              state: "unknown",
              verification: "reported",
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
          message: `EXERCISE — ${decision.reason} ${committed.join("; ")}${committed.length ? ". " : ""}Requested staging: ${request.stagingLocation || "not provided"}. Locations and arrival times are not yet reported. ${agency.capability}. This is an automated exercise response, not a real dispatch.`,
        },
        meta,
      );
    }
  }
}
