# Locked product framework — 2026-10-02

Source: user-approved AIRS Agent Status conversation, final numbered framework.

Locked.

The corrections to **#3, #4, and #5** also force changes downstream, especially around Partner/Associate permissions, connector behavior, and incident activation. Here is the revised numeric framework from the beginning.

## 1. Clean installation — locked

AIRS starts **operationally empty but structurally ready**.

It natively contains:

- platform administration, security, audit, retention, and expiration
- AIRS normalization and sharing logic
- the **Entity Directory**
- a reusable **connector/tunnel/web-adapter catalog**
- the ability to build and retain new integrations
- public reference information that is not agency owned

It contains no live agency operational data, active incidents, Partner relationships, Associate relationships, responder rosters, aircraft inventories, cameras, or fake production data.

The directory allows even an agency that has never used AIRS to be discovered, contacted, invited, and involved.

---

## 2. What AIRS owns — locked

AIRS owns the **platform mechanics**, not the source agencies' operational data.

AIRS may own:

- entity profiles
- relationships
- sharing policies
- connector definitions
- authorization records
- audit records
- incident access state
- normalization/correlation state
- temporary operational representations

Source entities retain ownership of:

- CAD data
- RMS data
- camera/video data
- drone telemetry
- C-UAS detections
- LPR information
- GIS data
- responder AVL
- evidence
- source-system records

AIRS represents authorized information; it does not become the source system of record.

---

# 3. Entity onboarding — locked

Onboarding happens **inside AIRS Agent** as an adaptive guided process.

An entity initially provides:

- formal name
- entity type
- service/jurisdiction area
- AIRS administrators
- operational contact
- 24-hour contact where applicable
- technical contact
- identity/SSO details if used

Then AIRS asks what systems/capabilities the entity uses.

Example:

> We use Motorola CAD.  
> **May AIRS ingest authorized operational information from it?**

> We use Fusus.  
> **May AIRS ingest authorized operational information from it?**

> We use DroneSense.  
> **May AIRS ingest authorized operational information from it?**

> We use ArcGIS.  
> **May AIRS ingest authorized operational information from it?**

> We use Dedrone.  
> **May AIRS ingest authorized operational information from it?**

> We operate Skydio DFR.  
> **May AIRS ingest authorized operational information from it?**

Answers populate the entity profile and trigger platform-specific follow-up questions.

Important:

**Authorization is given to AIRS to ingest information. It is not authorization for another agency to enter or browse the source system.**

---

# 4. Source systems and integration paths — locked

Each entity maintains a **Source Systems profile**.

For every source, AIRS records:

- platform/vendor
- system type
- who controls it
- available information classes
- connection method
- technical contact
- health/status
- limitations
- source-specific sharing restrictions
- fallback methods

AIRS supports multiple acquisition methods:

### 4.1 Native API/stream connector
Preferred where available.

### 4.2 Secure tunnel/edge connector
For on-premise or otherwise restricted environments.

### 4.3 Authorized web-source adapter
AIRS uses an authorized web session to ingest permitted operational information where no practical API exists.

### 4.4 Alternate structured transport
Webhook, email parser, XML/JSON, SFTP, exports, message bus, etc.

### 4.5 Human reporting
Radio, phone, dispatch, liaison, email, or manual entry.

**All paths converge into AIRS normalization and ultimately the AIRS COP.**

---

# 5. Source access vs AIRS representation — locked

This distinction is fundamental.

No external entity directly receives another entity's platform data/interface through AIRS as the normal operating model.

Instead:

```text
Source System
      ↓
     AIRS
      ↓
Normalize / interpret / correlate
      ↓
Operational entity / observation
      ↓
     AIRS COP
      ↓
Authorized participants
```

The outside participant sees the **AIRS representation**, not the source application.

AIRS becomes the single shared operational picture.

### Supplemental source access

Sometimes specialized users need more detail than AIRS should reproduce.

Example:

APD's UAS unit or GIT may receive the temporary **Altamont Fair Dedrone observation account** to inspect deeper RF or vendor-specific detail.

That supplemental source access:

- does not replace the AIRS COP
- does not alter the collaboration relationship
- is entity/event scoped
- may be used by rotating personnel
- expires at incident/event close

The governing rule is:

> **The AIRS COP is the shared operational picture. Direct source access is supplemental for specialized functions.**

---

# 6. Entity source readiness

Before any relationship exists, an entity may configure as many or as few systems as it wants.

Each source can have states such as:

- identified
- AIRS ingestion authorized
- connector available
- connector configured
- connection verified
- fallback method available
- temporarily unavailable
- AIRS access not authorized

An entity can have ten configured sources while sharing none of them with anyone.

This becomes its **technical readiness posture**.

---

# 7. Partner relationship

A **Partner** is a standing relationship between entities.

It establishes a preauthorized **sharing envelope**.

Example:

Agency A has agreed that, during qualifying requests, Agency B may receive AIRS representations derived from:

- CAD incident summary
- selected unit AVL
- DroneSense aircraft telemetry
- selected Dedrone detections
- approved GIS layers

It does **not** mean Agency B can browse Agency A's source systems.

It means AIRS may activate those predefined information classes during an authorized incident/request.

Partner relationships may be:

- directional
- reciprocal
- source specific
- data-class specific
- incident-type specific
- automatically activated or approval-required depending on policy

---

# 8. Associate relationship

An **Associate** has no standing sharing relationship.

During an incident, it can be invited from the Entity Directory.

The Associate chooses what to share for that incident.

Example:

> Share CAD resource locations  
> Share UAS telemetry  
> Do not share cameras

That authorization is temporary and ends with the incident.

The Associate does not need to become a permanent Partner.

---

# 9. Participant relationship

A **Participant** contributes operationally without providing direct source-system ingestion.

It can still be represented in AIRS through:

- dispatch
- command post
- radio
- phone
- liaison
- email
- manual entry

This ensures AIRS remains useful even when an entity has:

- no supported technology
- no connector
- no AIRS account
- no desire to technically integrate

---

# 10. Request / incident creation

A requesting entity opens an AIRS incident/request.

At creation, AIRS establishes:

- incident type
- location/geographic area
- requesting entity
- initial objective/problem
- initial operational time
- initial known participants
- immediate hazards/constraints if known

AIRS then checks:

- existing Partner relationships
- eligible preauthorized information sources
- potential Associates in the directory
- technical availability
- known fallback access paths

This is where the prebuilt relationships become operational.

---

# 11. Relationship activation

For each Partner, AIRS determines:

- what standing permissions apply
- whether the incident type qualifies
- which sources/data classes may activate
- whether explicit confirmation is required
- whether any source is unavailable
- whether a fallback method should be used

For an Associate:

- invitation is sent
- participation is accepted/declined
- specific source classes are selected
- temporary authorization is created

For a Participant:

- an information path is established

---

# 12. Ingestion

Once authorized, AIRS begins pulling only the information allowed for that incident.

Examples:

**CAD**
- call location
- selected resource positions
- unit status

**DroneSense**
- aircraft location
- altitude
- mission status

**Dedrone**
- UAS track
- operator/vehicle position where available
- detection time
- heading
- source classification

**Fusus**
- selected camera/sensor operational information

**ArcGIS**
- relevant incident layers

The raw source platform remains private.

---

# 13. Normalization and provenance

Every incoming piece of information becomes an AIRS observation with provenance.

At minimum AIRS should know:

- originating entity
- source platform
- source record/identifier where available
- source timestamp
- received timestamp
- freshness
- confidence/verification state
- geographic precision
- sharing scope
- incident scope

AIRS should never silently turn an observation into fact without preserving where it came from.

---

# 14. Correlation into operational entities

Multiple observations may refer to the same thing.

Example:

- Dedrone detects UAS
- Remote ID reports UAS
- DroneSense operator visually reports UAS
- officer radios UAS location

AIRS should preserve all four observations but correlate them into one operational entity when justified.

Possible entity types:

- person/victim
- responder
- vehicle
- ground unit
- UAS
- crewed aircraft
- sensor
- vessel
- command post
- hazard
- critical infrastructure
- point of interest

Correlation must never destroy the underlying source observations.

---

# 15. AIRS + ICS operational completeness

The AIRS and ICS frameworks govern the underlying reasoning.

They do **not** dictate how the UI looks.

AIRS continuously asks:

### Awareness
What is happening and where?

### Intelligence
What does it mean, how reliable is it, and how does it relate?

### Response
What is being done, by whom, with what assets?

### Security
What threats, restrictions, authorities, or sensitivities affect the operation?

ICS principles ensure completeness around:

- objectives
- resources
- assignments
- accountability
- location
- hazards
- communications
- command
- time/change

Together they answer:

**Who?  
What?  
When?  
Where?  
Why/context?  
What now?**

Those are internal completeness checks, not form headings.

---

# 16. Common Operating Picture

The AIRS COP is the primary operational view.

A user opening an active incident should rapidly understand:

- what is happening
- where it is happening
- victim/person locations where known
- responder locations where known
- aircraft locations
- hazards
- operational areas
- current objective
- active assignments
- information gaps
- unresolved/conflicting information
- latest meaningful changes
- what happens next

If authorized information exists but is not represented in the COP, the integration is incomplete.

---

# 17. Missing, stale, and conflicting information

AIRS must explicitly distinguish:

- known
- unknown
- not provided
- not authorized
- stale
- conflicting
- unverified
- source unavailable

Blank cannot mean all of those things.

AIRS should surface important operational gaps such as:

> Victim reported but location not represented.

> EMS resource en route but current position unknown.

> UAS track stale for 42 seconds.

> Two sources disagree on vehicle location.

---

# 18. Specialized supplemental access

Some personnel may need access to original source applications.

Examples:

- UAS team
- GIT
- intelligence analyst
- C-UAS specialist

Temporary source credentials can be issued at the **entity/event level**.

Personnel can rotate without disrupting the relationship.

AIRS tracks:

- entity authorized
- source platform
- access profile
- operational period
- provisioning status
- revocation status

Named-user logging can exist where supported, but authorization belongs to the entity.

---

# 19. Continuous incident operation

During the incident:

- streams continue
- entities move
- information ages
- new participants join
- permissions may change
- conflicts appear
- source systems may fail
- fallback methods may activate
- operational objectives change

AIRS updates the COP rather than forcing users to reconstruct the event from multiple applications.

---

# 20. Incident closeout

When the incident/event ends:

- incident sharing ends
- Associate permissions expire
- activated Partner access closes
- temporary source accounts are revoked
- web sessions/tunnels terminate where incident-scoped
- temporary cached operational data expires according to policy
- source data stays with the source entity
- designated evidence is preserved under appropriate policy
- necessary audit history remains

AIRS should be able to prove:

- who participated
- what was authorized
- which source classes were activated
- when access began
- when access ended
- whether temporary credentials were revoked

without becoming a permanent warehouse of everyone else's operational data.

---

## The overarching AIRS model

At this point, I think the core can be stated very simply:

> **AIRS connects entities, not users; accesses information, not platforms; normalizes operational data, not ownership; and gives authorized participants one incident-centric common operating picture regardless of where the information originated.**

That is the framework I would now use to evaluate every existing AIRS Agent screen, table, workflow, permission, and piece of code.
