export const EXERCISE_AGENCIES = [
  {
    key: "police",
    name: "Anconison Police",
    capability: "Patrol, perimeter and law-enforcement support",
    kinds: ["law_enforcement", "personnel"],
    category: "ground_vehicle",
    unit: "Patrol team",
  },
  {
    key: "fire",
    name: "Anconison Fire & Rescue",
    capability: "Fire suppression, rescue and extrication",
    kinds: ["fire_ems", "specialty_team"],
    category: "ground_vehicle",
    unit: "Engine and rescue crew",
  },
  {
    key: "ems",
    name: "Anconison EMS",
    capability: "Triage, treatment and patient transport",
    kinds: ["medical", "fire_ems"],
    category: "ground_vehicle",
    unit: "Ambulance and crew",
  },
  {
    key: "dispatch",
    name: "Anconison Emergency Dispatch",
    capability: "Emergency communications and dispatch coordination",
    kinds: ["communications", "personnel"],
    category: "other",
    unit: "Dispatch coordination team",
  },
  {
    key: "uas",
    name: "Anconison UAS Unit",
    capability: "Aerial observation and search; no autonomous flight",
    kinds: ["uas", "aviation"],
    category: "aircraft",
    unit: "UAS observation team",
  },
  {
    key: "em",
    name: "Anconison Emergency Management",
    capability: "Mutual aid, planning and emergency coordination",
    kinds: ["logistics", "personnel"],
    category: "other",
    unit: "Emergency coordination team",
  },
  {
    key: "hospital",
    name: "Anconison Hospital",
    capability: "Receiving-hospital and medical coordination",
    kinds: ["medical"],
    category: "other",
    unit: "Hospital receiving team",
  },
  {
    key: "hazmat",
    name: "Anconison Hazmat",
    capability: "Hazardous-materials assessment and containment",
    kinds: ["specialty_team"],
    category: "ground_vehicle",
    unit: "Hazmat response team",
  },
  {
    key: "sar",
    name: "Anconison Search & Rescue",
    capability: "Ground search and technical rescue",
    kinds: ["specialty_team", "personnel"],
    category: "ground_vehicle",
    unit: "Search and rescue team",
  },
  {
    key: "utilities",
    name: "Anconison Utilities",
    capability: "Infrastructure assessment and utility coordination",
    kinds: ["public_works"],
    category: "ground_vehicle",
    unit: "Utility response crew",
  },
  {
    key: "works",
    name: "Anconison Public Works",
    capability: "Roads, barriers and public-works equipment",
    kinds: ["public_works", "logistics"],
    category: "ground_vehicle",
    unit: "Public works crew",
  },
  {
    key: "relief",
    name: "Anconison Shelter & Relief",
    capability: "Shelter, reunification and relief coordination",
    kinds: ["logistics", "personnel"],
    category: "other",
    unit: "Shelter support team",
  },
] as const;
export type ExerciseAgency = (typeof EXERCISE_AGENCIES)[number];
export function aidDecision(
  agency: ExerciseAgency,
  kind: string,
  quantity: number,
  available: number,
) {
  if (kind !== "other" && !(agency.kinds as readonly string[]).includes(kind))
    return {
      count: 0,
      status: "denied" as const,
      reason: `Requested capability is outside our exercise profile: ${agency.capability}.`,
    };
  const count = Math.min(quantity, Math.max(0, available));
  return {
    count,
    status:
      count === 0
        ? ("denied" as const)
        : count < quantity
          ? ("partially_filled" as const)
          : ("filled" as const),
    reason:
      count === 0
        ? "No exercise units are currently available."
        : `${count} of ${quantity} requested units committed.`,
  };
}
