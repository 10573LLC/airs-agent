import { z } from 'zod';

// Agency declarations, never connector credentials or proof of live connectivity.
export const friendProfileSchema = z.object({
  equipment: z.string().max(4000).default(''),
  communications: z.string().max(4000).default(''),
  aircraft: z.string().max(4000).default(''),
  detection: z.string().max(4000).default(''),
  video: z.string().max(4000).default(''),
  bodyCameras: z.string().max(4000).default(''),
  locationSharing: z.string().max(4000).default(''),
  standingPermissions: z.string().max(4000).default(''),
  coordinationContact: z.string().max(1000).default(''),
}).strict();
export type FriendProfile = z.infer<typeof friendProfileSchema>;
export const friendProfileFields: {key: keyof FriendProfile; label: string; hint: string}[] = [
  {key:'equipment',label:'Equipment and models',hint:'Agency-confirmed models, quantities, capabilities and limitations.'},
  {key:'communications',label:'Radio interoperability',hint:'Radio models, systems, agreed channels/talkgroups, compatibility, authorization and fallback. Never enter encryption keys.'},
  {key:'aircraft',label:'UAVs and crewed aircraft',hint:'Aircraft models, flight-management platform, payloads and operational limitations.'},
  {key:'detection',label:'Aircraft detection',hint:'Detection source, coverage, sharing method and whether an AIRS connection has actually been tested.'},
  {key:'video',label:'Video sharing',hint:'Platform, shared-link capability, access requirements and approval process. Do not store live bearer links or credentials.'},
  {key:'bodyCameras',label:'Body cameras',hint:'Models, platform, streaming capability and restrictions.'},
  {key:'locationSharing',label:'Responder and asset locations',hint:'Supported source, accuracy, refresh rate and sharing restrictions; distinguish manual reports from telemetry.'},
  {key:'standingPermissions',label:'Standing sharing arrangements',hint:'What this friend may request or receive, who approves activation and incident-specific conditions. This record does not activate feeds.'},
  {key:'coordinationContact',label:'Coordination contact',hint:'Approved operational contact or duty desk.'},
];
