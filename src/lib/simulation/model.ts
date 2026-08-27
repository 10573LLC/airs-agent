export type SimSource = "911/CAD" | "RTCC" | "UAS" | "C-UAS" | "LMR" | "EMS/Fire" | "Weather";
export type SimConfidence = "confirmed" | "probable" | "unverified" | "conflicting";
export type SimPillar = "Awareness" | "Intelligence" | "Response" | "Security";

export interface SimulationEvent {
  id: string;
  atSeconds: number;
  source: SimSource;
  confidence: SimConfidence;
  headline: string;
  detail: string;
  friction?: string;
}

export interface AirsAssessment {
  pillar: SimPillar;
  summary: string;
  items: string[];
}

export interface CompiledScenario {
  title: string;
  sourceText: string;
  events: SimulationEvent[];
}

const event = (atSeconds: number, source: SimSource, confidence: SimConfidence, headline: string, detail: string, friction?: string): SimulationEvent => ({
  id: `${atSeconds}-${source}-${headline}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  atSeconds, source, confidence, headline, detail, friction,
});
const hasAny = (text: string, words: string[]) => words.some((word) => text.includes(word));

export function compileScenario(sourceText: string): CompiledScenario {
  const normalized = sourceText.trim().toLowerCase();
  const title = sourceText.trim().split(/[.!?\n]/)[0]?.slice(0, 90) || "Untitled emergency exercise";
  const events: SimulationEvent[] = [
    event(0, "911/CAD", "unverified", "Initial incident created", sourceText.trim() || "Exercise controller supplied an incident."),
    event(25, "911/CAD", "probable", "Dispatch classification updated", "ECC maps the local call type to a common incident category and assigns an initial priority."),
    event(55, "LMR", "confirmed", "First responder status received", "A responding unit acknowledges and provides an en route status; exact on-scene conditions remain unknown."),
    event(85, "RTCC", "probable", "Remote information search begins", "RTCC checks available cameras, calls, maps, and agency data sources for corroborating information.", "Relevant cameras or records may be unavailable or stale."),
  ];

  if (hasAny(normalized, ["drone", "uas", "aircraft", "helicopter", "airspace"])) {
    events.push(event(70, "C-UAS", "unverified", "Airspace activity detected", "A synthetic airspace sensor reports activity near the incident; identity and authorization are not yet established.", "Sensor confidence may change as tracks correlate."));
    events.push(event(115, "UAS", "confirmed", "Public safety UAS option evaluated", "AIRS evaluates aircraft readiness, launch authority, pilot availability, weather, and deconfliction before recommending a launch."));
  }
  if (hasAny(normalized, ["fire", "collapse", "explosion", "hazmat", "propane", "smoke"])) {
    events.push(event(65, "EMS/Fire", "probable", "Fire/EMS resource demand increasing", "Additional rescue, medical, fire suppression, staging, and command requirements are anticipated."));
  }
  if (hasAny(normalized, ["injury", "injured", "patient", "medical", "ambulance", "ems", "crash"])) {
    events.push(event(95, "EMS/Fire", "conflicting", "Patient count uncertain", "Field reports and caller information disagree on the number or acuity of patients.", "Do not collapse conflicting reports into a single confirmed count."));
  }
  if (hasAny(normalized, ["weather", "wind", "storm", "rain", "snow", "lightning"])) {
    events.push(event(105, "Weather", "probable", "Weather constraint changes", "Synthetic weather conditions may affect aviation, staging, access, or responder safety."));
  }
  events.push(event(140, "911/CAD", "confirmed", "Secondary demand emerges", "A separate priority event competes for finite public safety resources.", "Resource recommendations must account for system-wide coverage, not only the primary incident."));
  return { title, sourceText: sourceText.trim(), events: events.sort((a, b) => a.atSeconds - b.atSeconds) };
}
export function visibleEvents(scenario: CompiledScenario, clockSeconds: number) {
  return scenario.events.filter((row) => row.atSeconds <= clockSeconds);
}

export function assessAirs(events: readonly SimulationEvent[]): AirsAssessment[] {
  const latest = events.at(-1);
  const confirmed = events.filter((row) => row.confidence === "confirmed").length;
  const uncertain = events.filter((row) => row.confidence !== "confirmed").length;
  const sources = new Set(events.map((row) => row.source));
  const gaps = [
    sources.has("911/CAD") ? null : "No dispatch/ECC incident state received.",
    sources.has("RTCC") ? null : "No RTCC corroboration yet.",
    sources.has("C-UAS") || sources.has("UAS") ? null : "Airspace status has not been assessed.",
  ].filter((value): value is string => Boolean(value));

  return [
    {
      pillar: "Awareness",
      summary: latest ? `${events.length} synthetic updates received from ${sources.size} source types.` : "No exercise data received yet.",
      items: [
        `${confirmed} confirmed update${confirmed === 1 ? "" : "s"}; ${uncertain} requiring corroboration.`,
        ...gaps,
      ],
    },
    {
      pillar: "Intelligence",
      summary: uncertain > 0 ? "The operating picture contains unresolved or conflicting information." : "Current synthetic reports are internally consistent.",
      items: [
        "Keep source, timestamp, and confidence attached to every assertion.",
        "Treat absence of data as an information gap, not proof that a condition is absent.",
      ],
    },    {
      pillar: "Response",
      summary: latest ? `Reassess decisions after: ${latest.headline}.` : "Await a minimum operating picture before committing scarce resources.",
      items: [
        "Confirm life-safety priorities, incident command, staging, and resource ownership before tasking.",
        "Preserve agency authority boundaries; recommend or request actions AIRS cannot itself authorize.",
      ],
    },
    {
      pillar: "Security",
      summary: "Simulation data remains isolated from operational records and external systems.",
      items: [
        "No simulated source is treated as credentialed, connected, or authorized for live data access.",
        "Flag conflicts, stale information, source loss, and potential responder/airspace hazards instead of silently reconciling them.",
      ],
    },
  ];
}

export function injectFriction(scenario: CompiledScenario, clockSeconds: number): CompiledScenario {
  const at = Math.max(clockSeconds + 15, 30);
  const extra = event(
    at,
    "RTCC",
    "conflicting",
    "New report conflicts with current picture",
    "A credible synthetic source provides information that conflicts with an earlier report. AIRS must preserve both assertions until resolved.",
    "Exercise inject: do not overwrite the earlier report.",
  );
  return { ...scenario, events: [...scenario.events, extra].sort((a, b) => a.atSeconds - b.atSeconds) };
}

export const SIMULATION_BANNER = "SIMULATION MODE — NO LIVE SYSTEM DATA";