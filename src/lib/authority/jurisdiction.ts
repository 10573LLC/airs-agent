export type AuthorityType =
  | "jurisdictional" | "regulatory" | "functional" | "command"
  | "investigative" | "protective" | "delegated" | "supporting";
export type AuthorityBasis = "baseline" | "incident_confirmed" | "claimed" | "delegated" | "unresolved";
export type AuthorityConfidence = "confirmed" | "probable" | "reported" | "unresolved";

export interface AuthoritySuggestion {
  key: string;
  domain: string;
  authorityHolder: string;
  authorityType: AuthorityType;
  geographicScope: string;
  functionalScope: string;
  basisType: AuthorityBasis;
  basisReference: string;
  sourceReference: string;
  limitations: string;
  confidence: AuthorityConfidence;
  reason: string;
}

export type ThreatHypothesisType =
  | "secondary_assault" | "follow_on_uas" | "responder_targeting"
  | "coordinated_attack" | "explosive_hazard" | "cbrne" | "other";
export interface ThreatHypothesisSuggestion {
  key: string;
  hypothesisType: ThreatHypothesisType;
  title: string;
  confidence: "unknown" | "low" | "medium" | "high";
  rationale: string;
  indicators: string[];
  protectiveImplications: string;
  sourceBasis: string;
}

export const LIFE_SAFETY_AUTHORITY_NOTE =
  "Life safety is an incident objective, not a jurisdiction. Rescue, fire suppression, EMS, hostile-threat control, airspace, maritime, and investigative authorities may remain with different organizations at the same time.";
export const AUTHORITY_BASELINES = {
  national_airspace: {
    domain: "National airspace",
    authorityHolder: "Federal Aviation Administration",
    authorityType: "regulatory" as const,
    geographicScope: "National Airspace System / incident airspace",
    functionalScope: "Airspace regulation, restrictions, and aviation safety",
    basisReference: "49 U.S.C. § 40103; applicable 14 CFR and FAA orders",
    sourceReference: "FAA JO 7210.3EE / FAA TFR guidance",
    limitations: "Does not confer ground incident command or local criminal-enforcement authority.",
  },
  maritime: {
    domain: "Navigable waterway / marine safety and security",
    authorityHolder: "U.S. Coast Guard / applicable Captain of the Port",
    authorityType: "regulatory" as const,
    geographicScope: "Applicable navigable waterway and COTP zone",
    functionalScope: "Marine safety, security zones, navigation, and Coast Guard missions",
    basisReference: "Applicable federal maritime law and Coast Guard regulations",
    sourceReference: "U.S. Coast Guard Captain of the Port authorities",
    limitations: "Does not by itself transfer municipal land-command or other agencies' statutory authority.",
  },
  unified_command: {
    domain: "Cross-jurisdiction incident coordination",
    authorityHolder: "Incident Command / Unified Command",
    authorityType: "command" as const,
    geographicScope: "Incident command structure",
    functionalScope: "Joint priorities, objectives, coordination, and integrated operations",
    basisReference: "FEMA NIMS / ICS Unified Command doctrine",
    sourceReference: "FEMA National Incident Management System",
    limitations: "Unified Command coordinates authorities; it does not erase individual agency authority, responsibility, or accountability.",
  },
} as const;

const has = (text: string, re: RegExp) => re.test(text);
const addUnique = <T extends { key: string }>(rows: T[], row: T) => {
  if (!rows.some((item) => item.key === row.key)) rows.push(row);
};
export function suggestAuthorities(input: string): AuthoritySuggestion[] {
  const text = input.trim();
  const rows: AuthoritySuggestion[] = [];
  if (has(text, /\b(UAS|drone|aircraft|airspace|TFR|helicopter|aviation)\b/i)) {
    const b = AUTHORITY_BASELINES.national_airspace;
    addUnique(rows, { key: "national-airspace", ...b, basisType: "baseline", confidence: "confirmed",
      reason: "The incident includes aircraft or airspace activity; FAA regulatory authority should be represented separately from incident command." });
  }
  if (has(text, /\b(Hudson|river|waterway|port|harbor|ship|vessel|marine)\b/i)) {
    const b = AUTHORITY_BASELINES.maritime;
    addUnique(rows, { key: "maritime", ...b, basisType: "baseline", confidence: "probable",
      reason: "The incident includes a navigable-waterway or maritime component; the applicable Coast Guard/COTP role should be confirmed." });
  }
  if (has(text, /\b(fire|rescue|MCI|mass casualty|EMS|patient|ambulance|people in the river)\b/i)) {
    addUnique(rows, {
      key: "fire-rescue", domain: "Fire / rescue / emergency medical operations",
      authorityHolder: "Fire/EMS authority designated by the local jurisdiction", authorityType: "functional",
      geographicScope: "Incident rescue, suppression, triage, and medical operations",
      functionalScope: "Fire suppression, rescue, EMS, triage, and patient movement", basisType: "unresolved",
      basisReference: "Local law, policy, mutual-aid plan, and incident command assignment", sourceReference: "Agency/local ICS plan",
      limitations: "This is a functional rescue/medical authority. It does not make 'life safety' exclusively a fire jurisdiction or terminate a concurrent hostile-threat mission.",
      confidence: "unresolved", reason: "Casualties/rescue demand create a fire/EMS function, but the responsible agency and scope must be confirmed locally.",
    });
  }
  if (has(text, /\b(hostile|attack|assault|explosion|explosive|payload|weapon|crime|perimeter|security)\b/i)) {
    addUnique(rows, {
      key: "law-enforcement-threat", domain: "Hostile threat / criminal enforcement",
      authorityHolder: "Law-enforcement agency with applicable territorial/statutory jurisdiction", authorityType: "jurisdictional",
      geographicScope: "Applicable territorial jurisdiction and affected incident areas",
      functionalScope: "Threat interdiction, scene security, criminal enforcement, and protective operations", basisType: "unresolved",
      basisReference: "Applicable federal, state, local, tribal, or territorial law and mutual-aid authority", sourceReference: "Incident-specific jurisdiction confirmation required",
      limitations: "Does not displace fire/EMS rescue authority, FAA airspace regulation, maritime authority, or another agency's independent statutory mission.",
      confidence: "unresolved", reason: "A continuing hostile/criminal threat requires a law-enforcement authority lane separate from rescue operations.",
    });
  }
  if (has(text, /\b(Navy|naval|military|warship|USS|military vessel)\b/i)) {
    addUnique(rows, {
      key: "military-asset", domain: "Military asset / force protection",
      authorityHolder: "Owning military command and applicable military/federal investigative authority", authorityType: "protective",
      geographicScope: "Military vessel, installation, personnel, and designated protected areas",
      functionalScope: "Force protection, military property/operations, and military investigative responsibilities", basisType: "unresolved",
      basisReference: "Applicable military/federal authority and incident-specific command direction", sourceReference: "Owning military organization / investigative agency",
      limitations: "Military organizational authority does not automatically establish civil jurisdiction over unrelated shore operations.",
      confidence: "unresolved", reason: "A military asset is involved; force-protection and investigative authorities should be confirmed rather than inferred from local command structure.",
    });
  }
  if (has(text, /\b(FBI|JTTF|terrorism|terrorist|federal investigation|NCIS|ATF)\b/i)) {
    addUnique(rows, {
      key: "federal-investigation", domain: "Federal investigative responsibility",
      authorityHolder: "Appropriate federal investigative agency confirmed for the incident", authorityType: "investigative",
      geographicScope: "Federal investigative scope established for the incident",
      functionalScope: "Federal criminal, terrorism, military, explosives, or other applicable investigative mission", basisType: "incident_confirmed",
      basisReference: "Incident-specific federal involvement / statutory mission", sourceReference: "Confirm agency lead and scope in Unified Command or liaison channel",
      limitations: "Federal investigative responsibility can coexist with state/local offenses and does not automatically become overall incident command.",
      confidence: "reported", reason: "The incident text identifies or implicates a federal investigative function; the exact lead and scope should be recorded.",
    });
  }
  if (rows.length > 1 || has(text, /\bUnified Command\b/i)) {
    const b = AUTHORITY_BASELINES.unified_command;
    addUnique(rows, { key: "unified-command", ...b, basisType: "baseline", confidence: has(text, /\bUnified Command\b/i) ? "reported" : "probable",
      reason: "Multiple legal/geographic/functional authorities are present; Unified Command may be appropriate, but each agency retains its own authority." });
  }
  if (has(text, /\b(counter[- ]?UAS|C-UAS|mitigat(?:e|ion)|intercept(?:ion)?|disable|take down)\b/i)) {
    addUnique(rows, {
      key: "cuas-mitigation", domain: "Counter-UAS detection / mitigation authority",
      authorityHolder: "Entity with current applicable statutory authority and incident authorization", authorityType: "delegated",
      geographicScope: "Only the protected facility/asset/event/area authorized for the mission",
      functionalScope: "C-UAS detection and/or mitigation as separately authorized", basisType: "unresolved",
      basisReference: "Current federal C-UAS law, regulation, program authorization, and agency policy", sourceReference: "DOJ OLP UAS/C-UAS guidance and current 2026 regulation",
      limitations: "Detection, identification, tracking, and mitigation are legally distinct. AIRS must not infer mitigation authority from possession of equipment or general law-enforcement status.",
      confidence: "unresolved", reason: "C-UAS activity is contemplated; current legal/program authority must be confirmed before AIRS represents mitigation as authorized.",
    });
  }
  return rows;
}

export function suggestThreatHypotheses(input: string): ThreatHypothesisSuggestion[] {
  const text = input.trim();
  const rows: ThreatHypothesisSuggestion[] = [];
  const coordinated = /(swarm|multiple small UAS|dozen-plus|coordinated|multiple approach|two directions)/i.test(text);
  const weaponized = /(payload|explosion|explosive|impact|attack|hostile)/i.test(text);
  if (coordinated && weaponized) {
    addUnique(rows, {
      key: "coordinated-attack", hypothesisType: "coordinated_attack", title: "Coordinated hostile action",
      confidence: has(text, /\bexplosion|impact|attack confirmed\b/i) ? "high" : "medium",
      rationale: "Multiple aircraft, coordinated approach behavior, and payload/attack indicators are inconsistent with treating the event as an ordinary isolated UAS violation.",
      indicators: ["multiple aircraft", "coordinated approach behavior", "payload/attack indicators"],
      protectiveImplications: "Keep a dedicated hostile-threat function active while rescue and consequence management expand.",
      sourceBasis: "Incident facts / observations; operator confirmation required",
    });
  }
  if (coordinated && weaponized) {
    addUnique(rows, {
      key: "secondary-assault", hypothesisType: "secondary_assault", title: "Potential secondary / follow-on assault",
      confidence: "medium",
      rationale: "A coordinated attack can be intended to create effects beyond the first strike. Responder convergence and command/staging activity should not be assumed safe merely because the initial impacts have ended.",
      indicators: ["coordinated initiating attack", "weaponized/payload indicators", "large responder convergence likely"],
      protectiveImplications: "Maintain threat monitoring, protect responder/command locations, reassess approach and staging security, and avoid declaring the hostile-threat phase over solely because rescue operations are underway.",
      sourceBasis: "Analytic hypothesis derived from incident indicators; not a factual assertion of attacker intent",
    });
    addUnique(rows, {
      key: "responder-targeting", hypothesisType: "responder_targeting", title: "Responder convergence may be part of the threat model",
      confidence: "low",
      rationale: "The incident may draw predictable concentrations of responders and emergency assets. There is not yet evidence that responders are specifically targeted, so this remains a protective hypothesis.",
      indicators: ["high-profile initiating attack", "expected multiagency convergence"],
      protectiveImplications: "Treat command posts, staging, rescue corridors, and concentrated assets as locations requiring continuing security assessment without disrupting necessary life-safety operations.",
      sourceBasis: "Protective-analysis hypothesis; requires corroboration before elevation",
    });
  }
  if (has(text, /\b(not every drone is accounted|unaccounted|scatter|second wave|additional UAS|unknown tracks)\b/i)) {
    addUnique(rows, {
      key: "follow-on-uas", hypothesisType: "follow_on_uas", title: "Unresolved / follow-on UAS threat",
      confidence: "medium", rationale: "Original aircraft are not fully accounted for or later unknown tracks remain unresolved.",
      indicators: ["incomplete aircraft accounting", "unknown or later tracks"],
      protectiveImplications: "Continue track accounting and classify later aircraft without assuming every new detection is hostile or benign.",
      sourceBasis: "Incident airspace facts / sensor or visual observations",
    });
  }
  if (has(text, /\b(unknown payload|payloads actually were|CBRNE|chemical|biological|radiological)\b/i)) {
    addUnique(rows, {
      key: "cbrne", hypothesisType: "cbrne", title: "Payload composition may create CBRNE consequences",
      confidence: has(text, /\bCBRNE confirmed|chemical agent confirmed|radiological confirmed\b/i) ? "high" : "low",
      rationale: "Payload composition is unresolved; unknown material should remain a responder-safety hypothesis rather than being assumed benign.",
      indicators: ["unknown payload composition"], protectiveImplications: "Use appropriate hazard assessment and specialty consultation before reducing protective posture.",
      sourceBasis: "Incident payload/wreckage uncertainty",
    });
  }
  return rows;
}
