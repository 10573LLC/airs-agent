const ACTIVE_INCIDENT_RESOURCE_STATUSES = new Set(["proposed", "assigned", "deploying", "active"]);

export interface IncidentResourceAssignmentLike {
  id: string;
  assignmentType: string;
  resourceId: string | null;
  label: string | null;
  status: string;
  ownerOrgName?: string | null;
}

export interface IncidentResourceLocationLike {
  resourceId: string;
  geometry?: unknown;
  freshness?: string;
}

export type IncidentResourceLocationState = "reported" | "withheld" | "not_reported";

export interface IncidentResourceRosterItem {
  assignmentId: string;
  resourceId: string;
  label: string;
  status: string;
  ownerOrgName: string | null;
  locationState: IncidentResourceLocationState;
  freshness: string | null;
}
export function activeIncidentResourceIds(assignments: IncidentResourceAssignmentLike[]): Set<string> {
  return new Set(
    assignments
      .filter((a) =>
        a.assignmentType === "resource" &&
        a.resourceId !== null &&
        ACTIVE_INCIDENT_RESOURCE_STATUSES.has(a.status),
      )
      .map((a) => a.resourceId as string),
  );
}

export function buildIncidentResourceRoster(
  assignments: IncidentResourceAssignmentLike[],
  locations: IncidentResourceLocationLike[],
): IncidentResourceRosterItem[] {
  const current = assignments.filter((a) =>
    a.assignmentType === "resource" &&
    a.resourceId !== null &&
    ACTIVE_INCIDENT_RESOURCE_STATUSES.has(a.status),
  );

  return current.map((assignment) => {
    const matches = locations.filter((location) => location.resourceId === assignment.resourceId);
    const visible = matches.find((location) => location.geometry !== undefined);
    const locationState: IncidentResourceLocationState = visible
      ? "reported"
      : matches.length > 0
        ? "withheld"
        : "not_reported";

    return {
      assignmentId: assignment.id,
      resourceId: assignment.resourceId as string,
      label: assignment.label ?? "Shared resource",
      status: assignment.status,
      ownerOrgName: assignment.ownerOrgName ?? null,
      locationState,
      freshness: visible?.freshness ?? null,
    };
  });
}
