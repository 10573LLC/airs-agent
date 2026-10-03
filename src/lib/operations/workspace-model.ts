import type { OperationalPicture } from "@/lib/operational/completeness";
import type { Geometry } from "@/lib/map/model";

// Presentation contract only. Production callers supply server-authorized records;
// simulation callers supply their explicitly labeled synthetic projection.
export interface WorkspaceProjection {
  operationalPicture?: OperationalPicture;
  incidentName: string;
  incidentStatus: string;
  commandLead: string;
  priority: string;
  agencies: {
    id: string;
    name: string;
    role: string;
    informationPath: string;
    status: string;
    sinceSeconds: number;
    coordination: string;
  }[];
  resources: {
    id: string;
    name: string;
    owner: string;
    category: string;
    status: string;
    sinceSeconds: number;
    location: string;
  }[];
  mapItems: {
    assignmentId?: string;
    category?: string;
    id: string;
    label: string;
    geometry?: Geometry;
    tone: "own" | "partner" | "area" | "position" | "muted";
    detail: string;
  }[];
  actions: {
    id: string;
    atSeconds: number;
    occurredAt?: string;
    actor: string;
    action: string;
    target: string;
    channel: string;
    status: string;
  }[];
}
