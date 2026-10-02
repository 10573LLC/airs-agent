import type { SimAgency, SimCoordinationAction, SimMapItem, SimResource } from "@/lib/simulation/operational";

export const AIRS_COMPLETENESS_PILLARS = ["Awareness", "Intelligence", "Response", "Security"] as const;

export const ICS_COMPLETENESS_CONCERNS = [
  "incident situation",
  "objectives and priorities",
  "resource accountability",
  "assignments and status",
  "location and geography",
  "hazards and safety",
  "communications and coordination",
  "command and authority",
  "time and change",
] as const;

export interface OperationalPicture {
  situation: string;
  peopleAndAssets: string[];
  locations: string[];
  timing: string;
  context: string;
  nextActions: string[];
  gaps: string[];
}

export interface OperationalCompletenessInput {
  incidentName: string;
  incidentStatus: string;
  commandLead: string;
  priority: string;
  agencies: readonly SimAgency[];
  resources: readonly SimResource[];
  mapItems: readonly SimMapItem[];
  actions: readonly SimCoordinationAction[];
  sourceText?: string;
}

/**
 * AIRS + ICS are the completeness frameworks, not the presentation format.
 *
 * The resulting fields answer the same operational questions as the 5W model:
 * who is involved, what is happening, when it changed, where it is happening,
 * why/context, and what needs to happen next. The UI is free to present that
 * information as a concise operational picture rather than an ICS form.
 */
export function buildOperationalPicture(input: OperationalCompletenessInput): OperationalPicture {
  const sourceText = input.sourceText ?? "";
  const recentAction = [...input.actions].sort((a, b) => b.atSeconds - a.atSeconds)[0];
  const locatedResources = input.resources.filter((item) => !/not reported|unknown|not specified/i.test(item.location));
  const unknownLocationResources = input.resources.filter((item) => /not reported|unknown|not specified/i.test(item.location));
  const peopleMentioned = /\b(victim|patient|missing person|injured person|casualt(?:y|ies)|person in the river|people in the river)\b/i.test(sourceText);
  const mappedPeople = input.mapItems.some((item) => /victim|patient|missing person|casualt|person|people/i.test(`${item.label} ${item.detail}`));
  const pendingActions = input.actions.filter((item) => item.status === "pending" || item.status === "active").slice(-5).reverse();

  const peopleAndAssets = [
    ...input.resources.slice(0, 8).map((item) => `${item.name} — ${item.status.replaceAll("_", " ")}`),
    ...input.agencies.slice(0, 5).map((item) => `${item.name} — ${item.role}`),
  ];
  if (peopleMentioned && !peopleAndAssets.some((item) => /victim|patient|missing person|casualt/i.test(item))) {
    peopleAndAssets.unshift("Victim/person involvement is reported in source information; accountability is incomplete.");
  }

  const locations = [
    ...input.mapItems.slice(0, 8).map((item) => item.label),
    ...locatedResources.slice(0, 6).map((item) => `${item.name}: ${item.location}`),
  ];

  const gaps: string[] = [];
  if (peopleMentioned && !mappedPeople) gaps.push("Victim/person location is not represented in the common operating picture.");
  if (unknownLocationResources.length) gaps.push(`${unknownLocationResources.length} operational resource${unknownLocationResources.length === 1 ? "" : "s"} lack a current usable location.`);
  if (input.mapItems.length === 0) gaps.push("No incident geography is plotted.");
  if (!input.commandLead || /not (yet )?established/i.test(input.commandLead)) gaps.push("Command/coordination lead is not established.");
  if (!recentAction) gaps.push("No current operational action or decision is recorded.");
  if (!input.priority || /awaiting|not established/i.test(input.priority)) gaps.push("Current mission priority is not established.");

  const timing = recentAction
    ? `Latest recorded operational action at T+${Math.floor(recentAction.atSeconds / 3600)}:${Math.floor((recentAction.atSeconds % 3600) / 60).toString().padStart(2, "0")}.`
    : "No operational update time is available.";

  const nextActions = pendingActions.length
    ? pendingActions.map((item) => `${item.action} — ${item.target}`)
    : recentAction
      ? [`Continue or close the current action: ${recentAction.action}.`]
      : ["Establish the next operational objective/action."];

  return {
    situation: `${input.incidentStatus}. Priority: ${input.priority}.`,
    peopleAndAssets: peopleAndAssets.length ? peopleAndAssets : ["No people, units, or operational assets are currently represented."],
    locations: locations.length ? locations : ["Location picture incomplete — no usable incident positions are represented."],
    timing,
    context: `${input.commandLead}. AIRS uses Awareness, Intelligence, Response, and Security with ICS completeness checks to keep the operational picture coherent without presenting an ICS worksheet.`,
    nextActions,
    gaps,
  };
}
