// Resource colors: FEMA ICS 219 / NWCG resource status cards.
// Feature colors: USFA Field Operations Guide, ICS Map Display Symbology.
// These are screen color equivalents; the standards specify named colors.
export const ICS_RESOURCE_COLORS = {
  crew: {label:"Crew / team · green",color:"#15803d"},
  engine: {label:"Engine · rose",color:"#e88fa5"},
  helicopter: {label:"Helicopter · blue",color:"#2563eb"},
  personnel: {label:"Personnel · white",color:"#ffffff"},
  fixed_wing: {label:"Fixed-wing aircraft · orange",color:"#f97316"},
  equipment: {label:"Equipment · yellow",color:"#facc15"},
  task_force: {label:"Miscellaneous / task force · tan",color:"#d2b48c"},
  generic: {label:"Generic / unclassified · light purple",color:"#c4b5fd"},
} as const;
export type IcsResourceType = keyof typeof ICS_RESOURCE_COLORS;
/** Classify only explicit resource words, never the agency name or status. */
export function resourceColor(label: string | null | undefined): string {
  const value = (label ?? "").toLowerCase();
  let type: IcsResourceType = "generic";
  if (/\btask force\b/.test(value)) type="task_force";
  else if (/\bengine\b/.test(value)) type="engine";
  else if (/\bhelicopter\b|\brotorcraft\b/.test(value)) type="helicopter";
  else if (/\bfixed[ -]wing\b|\bairplane\b/.test(value)) type="fixed_wing";
  else if (/\bambulance\b|\bvehicle\b|\btruck\b|\bequipment\b|\bgenerator\b/.test(value)) type="equipment";
  else if (/\bcrew\b|\bteam\b/.test(value)) type="crew";
  else if (/\bpersonnel\b|\bperson\b/.test(value)) type="personnel";
  return ICS_RESOURCE_COLORS[type].color;
}
export function featureColor(category = ""): string {
  const value=category.toLowerCase().replaceAll("_"," ");
  if (/hazard|uncontrolled fire|hot spot|spot fire|fire origin/.test(value)) return "#dc2626";
  if (/staging|command post|landing zone|helispot|helibase|incident base|first aid|water source/.test(value)) return "#2563eb";
  if (/fire spread prediction/.test(value)) return "#f97316";
  return "#111827";
}
