import { suggestThreatHypotheses, type ThreatHypothesisSuggestion } from "@/lib/authority/jurisdiction";

export type SimSource =
  | "911/CAD" | "RTCC" | "Airspace/C-UAS" | "UAS" | "LMR"
  | "EMS/Fire" | "Maritime/USCG" | "Navy" | "Law Enforcement"
  | "Emergency Management" | "EOD/CBRNE" | "Public Information" | "Exercise Control";
export type SimConfidence = "confirmed" | "reported" | "unverified" | "conflicting";
export type SimPillar = "Awareness" | "Intelligence" | "Response" | "Security";
export type SimProvenance = "scenario_fact" | "controller_inject" | "airs_inference";

export interface SimulationEvent {
  id: string;
  atSeconds: number;
  endSeconds?: number;
  timeLabel: string;
  source: SimSource;
  domains: string[];
  provenance: SimProvenance;
  confidence: SimConfidence;
  headline: string;
  detail: string;
  friction?: string;
}

export interface AuthorityState {
  domain: string;
  owner: string;
  status: "reported" | "established";
  basisEventId: string;
}
export interface SimulationState {
  events: SimulationEvent[];
  airspaceStatus: string;
  airspaceTracks: string[];
  commandStatus: string;
  authorities: AuthorityState[];
  threatHypotheses: ThreatHypothesisSuggestion[];
  hazards: string[];
  unknowns: string[];
  recommendations: string[];
}

export interface AirsAssessment {
  pillar: SimPillar;
  summary: string;
  items: string[];
}

export interface CompiledScenario {
  title: string;
  setup: string;
  sourceText: string;
  events: SimulationEvent[];
}

const cleanMarkdown = (value: string) => value.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const hasWord = (text: string, word: string) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "i").test(text);
const hasAnyWord = (text: string, words: string[]) => words.some((word) => hasWord(text, word));
function parseExerciseTime(label: string) {
  const normalized = label.replace(/\([^)]*\)/g, "").replace(/onward/gi, "").trim();
  const parts = normalized.split(/[–—-]/).map((part) => part.trim()).filter(Boolean);
  const toSeconds = (part: string) => {
    const match = part.match(/^(\d+):(\d{2})$/);
    if (!match) return 0;
    return Number(match[1]) * 3600 + Number(match[2]) * 60;
  };
  return {
    atSeconds: toSeconds(parts[0] ?? "0:00"),
    endSeconds: parts[1] ? toSeconds(parts[1]) : undefined,
  };
}

function extractSection(source: string, heading: string) {
  const start = source.indexOf(heading);
  if (start < 0) return "";
  const after = source.slice(start + heading.length);
  const next = after.search(/\n(?:---|## )/);
  return (next >= 0 ? after.slice(0, next) : after).trim();
}

function headlineFromDetail(detail: string) {
  const sentence = cleanMarkdown(detail).split(/(?<=[.!?])\s+/)[0] ?? detail;
  return sentence.length > 110 ? `${sentence.slice(0, 107)}...` : sentence;
}
function classifySource(detail: string): SimSource {
  if (/WMD|CBRNE|Bomb Disposal|ordnance|explosive residue/i.test(detail)) return "EOD/CBRNE";
  if (/Coast Guard|Captain of the Port|river traffic|waterway|small boats/i.test(detail)) return "Maritime/USCG";
  if (/FAA|TFR|counter-UAS|drone|UAS|airspace|helicopter/i.test(detail)) return "Airspace/C-UAS";
  if (/911|Emergency Communications|dispatch/i.test(detail)) return "911/CAD";
  if (/Fire Department|Albany FD|MCI|ambulance|EMS|patient|hospital|rescue/i.test(detail)) return "EMS/Fire";
  if (/Unified Command|Emergency Management|EOC|DHSES|Governor/i.test(detail)) return "Emergency Management";
  if (/FBI|NCIS|Police|Sheriff|ATF|JTTF|law enforcement/i.test(detail)) return "Law Enforcement";
  if (/Navy|ship|general quarters/i.test(detail)) return "Navy";
  if (/press|Joint Information Center|Public Affairs|media/i.test(detail)) return "Public Information";
  return "RTCC";
}

function classifyDomains(detail: string) {
  const domains: string[] = [];
  if (/drone|UAS|FAA|TFR|airspace|helicopter|counter-UAS/i.test(detail)) domains.push("airspace");
  if (/river|boat|waterway|Coast Guard|pier|kayak/i.test(detail)) domains.push("maritime");
  if (/fire|MCI|ambulance|EMS|patient|hospital|injur|rescue/i.test(detail)) domains.push("life safety");
  if (/FBI|NCIS|Police|Sheriff|ATF|crime scene|investigat/i.test(detail)) domains.push("law enforcement");
  if (/Unified Command|EOC|Emergency Management|mutual-aid/i.test(detail)) domains.push("command");
  if (/CBRNE|WMD|Bomb Disposal|ordnance|hazmat|payload residue/i.test(detail)) domains.push("hazardous materials");
  return domains.length ? [...new Set(domains)] : ["general operations"];
}
function confidenceFor(detail: string): SimConfidence {
  if (/conflict|disagree|contradict/i.test(detail)) return "conflicting";
  if (/unknown|nobody yet knows|not accounted|suspected|possibly|may |if any/i.test(detail)) return "unverified";
  if (/report|caller|visibly|appears|observ/i.test(detail)) return "reported";
  return "confirmed";
}

function parseTimeline(sourceText: string): SimulationEvent[] {
  let timeline = extractSection(sourceText, "## Timeline");
  if (!timeline) {
    const heading = /(?:^|\n)\s*Timeline\s*:?\s*(?:\n|$)/i.exec(sourceText);
    timeline = heading ? sourceText.slice((heading.index ?? 0) + heading[0].length) : sourceText;
    const boundary = timeline.search(/\n\s*(?:Who shows up\b|Why this gets so complicated\b|Exercise objectives\b)/i);
    if (boundary >= 0) timeline = timeline.slice(0, boundary);
  }
  const pattern = /(?:^|\n)\s*(?:[-*•]\s*)?(?:\*\*)?\s*T\+\s*(\d+:\d{2}(?:\s*[–—-]\s*\d+:\d{2})?(?:\s*\([^\n)]*\))?(?:\s+onward)?)(?:\*\*)?\s*[—–-]\s*([\s\S]*?)(?=\n\s*(?:[-*•]\s*)?(?:\*\*)?\s*T\+|$)/gim;
  const events: SimulationEvent[] = [];
  for (const match of timeline.matchAll(pattern)) {
    const timeLabel = cleanMarkdown(match[1] ?? "0:00");
    const detail = cleanMarkdown(match[2] ?? "");
    const parsed = parseExerciseTime(timeLabel);
    const source = classifySource(detail);
    events.push({
      id: `${parsed.atSeconds}-${slug(source)}-${slug(headlineFromDetail(detail))}`,
      ...parsed,
      timeLabel: `T+${timeLabel.replace(/\s*\([^)]*\)/, "")}`,
      source,
      domains: classifyDomains(detail),
      provenance: "scenario_fact",
      confidence: confidenceFor(detail),
      headline: headlineFromDetail(detail),
      detail,
    });
  }
  return events.sort((a, b) => a.atSeconds - b.atSeconds);
}
export function compileScenario(sourceText: string): CompiledScenario {
  const source = sourceText.trim();
  const titleMatch = source.match(/^#\s+(.+)$/m);
  const title = cleanMarkdown(titleMatch?.[1] ?? source.split(/[.!?\n]/)[0] ?? "Untitled emergency exercise").slice(0, 120);
  const setup = extractSection(source, "## Scenario setup");
  const timelineEvents = parseTimeline(source);
  if (timelineEvents.length) return { title, setup, sourceText: source, events: timelineEvents };

  const detail = cleanMarkdown(source);
  const fallback: SimulationEvent = {
    id: `0-${slug(classifySource(detail))}-${slug(headlineFromDetail(detail))}`,
    atSeconds: 0,
    timeLabel: "T+0:00",
    source: classifySource(detail),
    domains: classifyDomains(detail),
    provenance: "scenario_fact",
    confidence: confidenceFor(detail),
    headline: headlineFromDetail(detail),
    detail,
  };
  return { title, setup: "", sourceText: source, events: [fallback] };
}

export function visibleEvents(scenario: CompiledScenario, clockSeconds: number) {
  return scenario.events.filter((row) => row.atSeconds <= clockSeconds);
}

export function nextEventTime(scenario: CompiledScenario, clockSeconds: number) {
  return scenario.events.find((row) => row.atSeconds > clockSeconds)?.atSeconds ?? clockSeconds;
}
const unique = (items: string[]) => [...new Set(items)];

function authorityState(events: readonly SimulationEvent[]): AuthorityState[] {
  const out: AuthorityState[] = [];
  for (const event of events) {
    const text = event.detail;
    if (/multiple small UAS inbound|attached payloads|explosions|hostile|attack/i.test(text)) {
      out.push({ domain: "Hostile threat / criminal enforcement", owner: "Law-enforcement authority with applicable territorial/statutory jurisdiction", status: "reported", basisEventId: event.id });
    }
    if (/Fire Department|fire|rescue|MCI|EMS|ambulance|patient|people in the river/i.test(text)) {
      out.push({ domain: "Fire / rescue / EMS function", owner: "Fire/EMS authority designated by local jurisdiction", status: "reported", basisEventId: event.id });
    }
    if (/Captain of the Port|Coast Guard.*safety\/security zone/i.test(text)) {
      out.push({ domain: "Waterway / marine security", owner: "U.S. Coast Guard Captain of the Port", status: "established", basisEventId: event.id });
    }
    if (/FAA issues.*Temporary Flight Restriction|FAA issues.*TFR/i.test(text)) {
      out.push({ domain: "National airspace restriction", owner: "FAA", status: "established", basisEventId: event.id });
    }
    if (/NCIS.*secure the ship as a crime scene|NCIS agents.*secure the ship/i.test(text)) {
      out.push({ domain: "Navy vessel crime scene", owner: "NCIS / U.S. Navy", status: "established", basisEventId: event.id });
    }
    if (/Unified Command stands up/i.test(text)) {
      out.push({ domain: "Cross-jurisdiction incident coordination", owner: "Unified Command", status: "established", basisEventId: event.id });
    }
  }
  return out.filter((item, index) => out.findIndex((other) => other.domain === item.domain) === index);
}

function deriveAirspaceStatus(events: readonly SimulationEvent[]) {
  const text = events.map((event) => event.detail).join(" ");
  if (/TFR.*ignored|hobbyist drones|livestreamers.*converging|rogue civilian drones/i.test(text)) {
    return "Contested restricted airspace: civilian UAS are mixing with unresolved threat tracks and emergency aviation demand.";
  }
  if (/explosions|impacts/.test(text.toLowerCase()) && /drone|UAS/i.test(text)) {
    return "Hostile UAS attack confirmed; track accounting and secondary-wave risk remain operational priorities.";
  }
  if (/multiple small UAS inbound|dozen-plus quadcopters|carrying attached payloads/i.test(text)) {
    return "Immediate coordinated UAS threat reported from multiple approach vectors; intent and full track identity are not yet resolved.";
  }
  return "No airspace threat has been established from released exercise facts.";
}
function deriveAirspaceTracks(events: readonly SimulationEvent[]) {
  const text = events.map((event) => event.detail).join(" ");
  const tracks: string[] = [];
  if (/multiple small UAS inbound|dozen-plus quadcopters/i.test(text)) tracks.push("Original UAS group: unidentified coordinated aircraft approaching from multiple vectors; visible payload anomalies reported.");
  if (/not every drone is accounted|several scatter/i.test(text)) tracks.push("Original UAS group: incomplete accounting; scattered/downed aircraft remain unresolved.");
  if (/news helicopters.*hold clear|Local news helicopters/i.test(text)) tracks.push("News aviation: known media aircraft instructed to hold clear or coordinate under incident air operations.");
  if (/hobbyist drones|independent livestreamers|rogue civilian drones/i.test(text)) tracks.push("Civilian UAS: known/unknown hobbyist and media-adjacent aircraft entering or approaching restricted incident airspace.");
  if (/medevac helicopter/i.test(text)) tracks.push("Emergency aviation: medevac aircraft requires a protected, deconflicted operating corridor.");
  if (/State Police aviation/i.test(text)) tracks.push("Public safety aviation: State Police aviation requested; authorization/deconfliction must be represented separately from civilian and hostile tracks.");
  return unique(tracks);
}

function deriveCommandStatus(events: readonly SimulationEvent[]) {
  const text = events.map((event) => event.detail).join(" ");
  if (/Unified Command stands up/i.test(text)) {
    return "Unified Command established for coordination; each participating organization retains its own jurisdictional, statutory, and functional authority.";
  }
  if (/establish an initial command post/i.test(text)) {
    return "Initial command post established. Rescue/EMS and hostile-threat/security functions remain distinct; overall cross-jurisdiction authority has not yet been resolved into Unified Command.";
  }
  return "Command structure has not yet been established from released exercise facts.";
}

function deriveHazards(events: readonly SimulationEvent[]) {
  const text = events.map((event) => event.detail).join(" ");
  const hazards: string[] = [];
  if (/multiple small UAS inbound|attached payloads/i.test(text)) hazards.push("Coordinated inbound UAS with visible payload anomalies.");
  if (/explosions|start a fire|structural and material damage/i.test(text)) hazards.push("Fire, blast, and structural damage at the ship/pier complex.");
  if (/people in the river|passengers in the river|search and rescue/i.test(text)) hazards.push("Water rescue and drowning exposure in an active incident area.");
  if (/ordnance floating|partially-functioned ordnance|drone wreckage/i.test(text)) hazards.push("Downed UAS/debris may contain live or partially functioned ordnance.");
  if (/fuel sheen|fuel\/oil spill/i.test(text)) hazards.push("Fuel or oil release affecting the waterway.");
  if (/CBRNE|payloads actually were|WMD Civil Support Team/i.test(text)) hazards.push("Payload composition remains a potential CBRNE responder-safety concern.");
  return unique(hazards);
}

function deriveUnknowns(events: readonly SimulationEvent[]) {
  const text = events.map((event) => event.detail).join(" ");
  const unknowns: string[] = [];
  if (/not every drone is accounted|several scatter/i.test(text)) unknowns.push("Full accounting and disposition of the original UAS group.");
  if (/identity and authorization are not yet established/i.test(text)) unknowns.push("Identity and authorization of detected aircraft tracks.");
  if (/nobody yet knows what the drone payloads actually were/i.test(text)) unknowns.push("Composition and residual hazard of drone payloads/wreckage.");
  if (/second wave/i.test(text)) unknowns.push("Whether later unknown UAS represent civilian activity or a follow-on threat.");
  return unique(unknowns);
}
function deriveRecommendations(events: readonly SimulationEvent[]) {
  const text = events.map((event) => event.detail).join(" ");
  const recommendations: string[] = [];
  if (/multiple small UAS inbound|attached payloads/i.test(text)) {
    recommendations.push("Assign an airspace threat owner immediately; correlate visual, Remote ID, C-UAS, and other available tracks without assuming identity or authorization.");
    recommendations.push("Protect emergency aviation access and avoid adding public safety UAS until launch authority and deconfliction can be established.");
  }
  if (/explosions|people in the river|mass casualties/i.test(text)) {
    recommendations.push("Run rescue/medical life-safety operations and hostile-threat/security operations concurrently. Casualty response does not establish exclusive fire jurisdiction and does not mean the initiating hostile threat has ended.");
  }
  if (/multiple small UAS inbound|attached payloads|explosions|impacts/i.test(text)) {
    recommendations.push("Maintain a secondary/follow-on assault hypothesis until the available intelligence reduces it; protect responder convergence, command/staging activity, and emergency aviation without asserting attacker intent as fact.");
  }
  if (/not every drone is accounted|ordnance floating/i.test(text)) {
    recommendations.push("Maintain unresolved UAS/debris as both a responder hazard and an evidence issue; do not mark the airspace or waterway clear from absence of current detections alone.");
  }
  if (/Temporary Flight Restriction|TFR/i.test(text)) {
    recommendations.push("Publish the active restriction into the common operating picture and classify every detected aircraft against known authorization before operational use of the airspace.");
  }
  if (/rogue civilian drones|medevac helicopter|hobbyist drones/i.test(text)) {
    recommendations.push("Separate authorized emergency aircraft, known civilian/RID-correlated aircraft, unknown tracks, and suspected hostile tracks; preserve a medevac corridor and hand off non-immediate violators for enforcement follow-up.");
  }
  if (/Unified Command stands up/i.test(text)) {
    recommendations.push("Expose the authority matrix to Unified Command so ship, shore, waterway, airspace, investigative, and life-safety decisions stay with the proper owner.");
  }
  return unique(recommendations);
}

export function buildSimulationState(scenario: CompiledScenario, clockSeconds: number): SimulationState {
  const events = visibleEvents(scenario, clockSeconds);
  return {
    events,
    airspaceStatus: deriveAirspaceStatus(events),
    airspaceTracks: deriveAirspaceTracks(events),
    commandStatus: deriveCommandStatus(events),
    authorities: authorityState(events),
    threatHypotheses: suggestThreatHypotheses(events.map((event) => event.detail).join(" ")),
    hazards: deriveHazards(events),
    unknowns: deriveUnknowns(events),
    recommendations: deriveRecommendations(events),
  };
}
export function assessAirs(events: readonly SimulationEvent[], state?: SimulationState): AirsAssessment[] {
  const confirmed = events.filter((row) => row.confidence === "confirmed").length;
  const uncertain = events.length - confirmed;
  const sources = new Set(events.map((row) => row.source));
  const current = state ?? {
    events: [...events],
    airspaceStatus: deriveAirspaceStatus(events),
    airspaceTracks: deriveAirspaceTracks(events),
    commandStatus: deriveCommandStatus(events),
    authorities: authorityState(events),
    threatHypotheses: suggestThreatHypotheses(events.map((event) => event.detail).join(" ")),
    hazards: deriveHazards(events),
    unknowns: deriveUnknowns(events),
    recommendations: deriveRecommendations(events),
  };
  return [
    {
      pillar: "Awareness",
      summary: events.length ? `${events.length} released scenario facts from ${sources.size} source domains.` : "No exercise facts have been released yet.",
      items: [`${confirmed} confirmed; ${uncertain} reported, unverified, or conflicting.`, current.airspaceStatus, current.commandStatus],
    },
    {
      pillar: "Intelligence",
      summary: current.threatHypotheses.length
        ? `${current.threatHypotheses.length} threat hypothes${current.threatHypotheses.length === 1 ? "is" : "es"} open; ${current.unknowns.length} material unknown${current.unknowns.length === 1 ? "" : "s"}.`
        : current.unknowns.length
          ? `${current.unknowns.length} material unknown${current.unknowns.length === 1 ? "" : "s"} remain open.`
          : "No explicit unresolved question has yet been established from released facts.",
      items: [
        ...current.threatHypotheses.map((item) => `HYPOTHESIS · ${item.title} · ${item.confidence} confidence · ${item.rationale}`),
        ...(current.unknowns.length ? current.unknowns : current.threatHypotheses.length ? [] : ["Preserve source, time, provenance, and confidence as new facts arrive."]),
      ],
    },    {
      pillar: "Response",
      summary: current.recommendations.length ? `${current.recommendations.length} current AIRS recommendation${current.recommendations.length === 1 ? "" : "s"}.` : "No response recommendation is justified yet.",
      items: current.recommendations.length ? current.recommendations : ["Wait for released facts rather than manufacture a response condition."],
    },
    {
      pillar: "Security",
      summary: "Simulation facts, controller injects, and AIRS inferences remain explicitly separated from live operational data.",
      items: [
        "Scenario facts are never converted into credentials, connector authorization, or operational records.",
        "Authority is derived only from released exercise facts; platform access does not become agency access.",
      ],
    },
  ];
}

export function injectFriction(scenario: CompiledScenario, clockSeconds: number): CompiledScenario {
  const atSeconds = Math.max(clockSeconds + 60, 60);
  const extra: SimulationEvent = {
    id: `${atSeconds}-exercise-control-conflicting-report`,
    atSeconds,
    timeLabel: "Controller inject",
    source: "Exercise Control",
    domains: ["exercise control"],
    provenance: "controller_inject",
    confidence: "conflicting",
    headline: "Controller inject: conflicting report",
    detail: "Exercise Control introduces a credible report that conflicts with the current operating picture.",
    friction: "Preserve both assertions until an operational source resolves the conflict.",
  };
  return { ...scenario, events: [...scenario.events, extra].sort((a, b) => a.atSeconds - b.atSeconds) };
}

export const SIMULATION_BANNER = "SIMULATION MODE — NO LIVE SYSTEM DATA";