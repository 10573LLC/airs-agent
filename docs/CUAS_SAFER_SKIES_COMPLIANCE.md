# AIRS Agent — C-UAS / SAFER SKIES Compliance Domain

Status: implementation contract for `0018_cuas_safer_skies_compliance.sql`.

## Legal-source rule

AIRS records operator-entered compliance facts and workflow state. It does not make autonomous legal conclusions. The July 2026 DOJ/DHS Q&A, public fact sheet, decision brief, and interagency Authorized Technologies List supplied for this implementation are plain-language/operational source materials. The controlling text remains 6 & 28 CFR Part 124 and current federal portal forms/lists.

## Agency gate

`cuas_agency_profiles` records whether an agency is not participating, Detection & Warning, Mitigation, correctional mitigation, or suspended. It also records the Agency Approving Official, counsel reviewer, policy adoption, annual attestation, federal portal reference, and mutual-aid posture.

AIRS must never imply that a mutual-aid request transfers statutory authority. Each assisting agency retains its own authority, certification, equipment, policy, and command responsibilities.

## Personnel gate

`cuas_personnel_certifications` records the operator's tier and status. Mitigation workflows must require an active mitigation-capable certification before a mitigation command is recorded. Detection-only personnel must not be presented as mitigation-authorized.

## Equipment gate

`cuas_equipment_authorizations` distinguishes:

- ATL-1 RF detection with command-and-control signal interception
- ATL-2 RF protocol manipulation
- ATL-3 RF disruption
- non-intercept categories such as camera, radar, acoustic, passive RF energy detection, and Remote ID

The record separately tracks ASL status, FAA spectrum status, and operational suspension. AIRS must not present ATL/ASL inclusion as federal endorsement, recommendation, or performance certification.

## Operations workflow

`cuas_operations` records the OPLAN/advance-notification workflow, approving official, counsel certification, federal coordination state, protected interest, operational window, and major-event lead-agency coordination.

Operational types include planned, standing fixed site, major event, emergency exception, and training/validation. Emergency exception is a marked exception state, not a shortcut around normal paperwork; follow-up coordination/reporting remains due.

## Credible-threat and mitigation record

`cuas_mitigation_actions` requires an operator-entered credible-threat basis and proportionality basis. It also records that First Amendment-protected activity was excluded from the threat basis, the certified operator, equipment, action, ATC notification, timing, and known effects.

AIRS must not generate a credible-threat determination on behalf of the operator. Decision support may organize reported facts; the accountable human operator retains the determination and discretion.

Each mitigation action automatically queues a `mitigation_post_operation` compliance report due 48 hours after the action starts.

## Reporting

`cuas_compliance_reports` supports:

- OPLAN / advance notification
- mitigation post-operation report
- consolidated detection report
- semiannual operational summary
- quarterly minimization review
- annual agency attestation
- certification roster
- authorized equipment report
- system suspension acknowledgment

Report records are workflow artifacts. AIRS should support export/transcription to the current federal portal form rather than claiming to submit to a federal system unless a supported, authorized integration exists.

## Privacy and records

`cuas_intercepted_record_controls` records protective purpose, capture time, deletion deadline, retention exception, anonymization, and deletion completion. Intercepted-communications records default to a 180-day deletion target. Any retention exception requires a documented basis.

Capability-revealing OPLANs, system locations, coverage patterns, and tactics must remain access controlled and auditable. Information-sharing/disclosure logic must continue to use AIRS's existing tenant/RLS and disclosure controls.

## Compliance dashboard behavior

The UI should surface, without inventing legal conclusions:

- accreditation/participation state
- annual attestation due/overdue
- active/suspended operator certifications
- equipment ATL/ASL/FAA/suspension state
- OPLAN and coordination readiness
- major-event lead-agency coordination acknowledgment
- mitigation reports due within 48 hours
- quarterly minimization reviews
- 180-day intercepted-record deletion queue
- system/category suspension acknowledgments

Hard blocking is appropriate only where the stored facts make the requirement deterministic (for example, no active mitigation certification selected, equipment explicitly suspended, or a required approval field absent). Ambiguous legal questions should be escalated to agency counsel/approving official rather than decided by AIRS.
