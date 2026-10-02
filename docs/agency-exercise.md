# Manual agency exercise

The user operates a separately named requesting agency. **Anconison Agency supplies the fictional responding entities**, not the command agency. The controller explicitly switches into a receiving entity to enter each reply. No automated replies or external messages are generated.

The authenticated Simulation page now opens the agency exercise; the original authored timeline lab remains accessible. The platform console links directly to this workflow. The existing simulation role gate remains enforced. No operational permissions or database memberships were broadened.

Included: editable requesting-agency identity and incident situation/objective/location; twelve fictional emergency-service entities and additional custom entities; directed requests; accept, limit, decline and progress replies; immutable reply history within the exercise; optional committed resources and reported coordinates; shared command/agency/resource/map/decision views; closeout; validated export/import. Map points require explicit coordinates. Each request currently carries one current resource/team representation; send separate requests for independently tracked resources.

Exercise state is saved in session storage, scoped to the signed-in account and browser tab. Reloads retain it; closing the tab may remove it. Export/import provides portable retention. This is a controller-operated simulation, not a persisted multi-user exercise service, a live source integration, or an end-to-end test of the production sharing model. Relationship labels in this directory do not confer real access grants.

Validation: all 25 simulation tests across four files passed, including seven new tests for actor separation, manual-only replies, recipient enforcement, unknown locations, update history, declines, closeout and serialization. TypeScript and the ARM64 production container build passed.
