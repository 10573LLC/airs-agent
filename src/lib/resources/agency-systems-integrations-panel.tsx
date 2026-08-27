import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";

import { SectionCard, StatusPill } from "@/components/brand";
import {
  readAgencySystemProfileFn,
  saveAgencySystemProfileFn,
} from "@/lib/api/resources.functions";
import {
  CATALOG_COMPONENTS,
  ECOSYSTEMS,
  normalizedCapabilitiesForComponents,
  suggestComponentsForEcosystems,
  type EcosystemId,
  type UsageStatus,
} from "./technology-ecosystem-catalog";

type UsageDraft = Record<string, UsageStatus>;

const COMPONENT_BY_ID = new Map(CATALOG_COMPONENTS.map((component) => [component.id, component]));
const ECOSYSTEM_NAME = new Map(ECOSYSTEMS.map((ecosystem) => [ecosystem.id, ecosystem.vendorName]));

const usageLabel: Record<UsageStatus, string> = {
  in_use: "In use",
  planned: "Planned",
};
const chipClass = "rounded-full border border-border px-2 py-1 text-[11px] text-muted-foreground";
const selectClass = "rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground";

function capabilityLabel(value: string) {
  return value.replaceAll("_", " ");
}

export function AgencySystemsIntegrationsPanel({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const readProfile = useServerFn(readAgencySystemProfileFn);
  const saveProfile = useServerFn(saveAgencySystemProfileFn);
  const [ecosystems, setEcosystems] = useState<UsageDraft>({});
  const [components, setComponents] = useState<UsageDraft>({});
  const [message, setMessage] = useState<string | null>(null);

  const profile = useQuery({
    queryKey: ["agency-system-profile"],
    queryFn: () => readProfile({ data: {} }),
  });

  useEffect(() => {
    if (!profile.data?.ok) return;
    setEcosystems(
      Object.fromEntries(profile.data.data.ecosystems.map((row) => [row.ecosystemId, row.usageStatus])),
    );
    setComponents(
      Object.fromEntries(profile.data.data.components.map((row) => [row.componentId, row.usageStatus])),
    );
  }, [profile.data]);
  const selectedEcosystemIds = useMemo(
    () => ECOSYSTEMS.filter((row) => ecosystems[row.id]).map((row) => row.id),
    [ecosystems],
  );
  const confirmedComponentIds = useMemo(
    () => CATALOG_COMPONENTS.filter((row) => components[row.id]).map((row) => row.id),
    [components],
  );
  const suggestions = useMemo(
    () => suggestComponentsForEcosystems(selectedEcosystemIds),
    [selectedEcosystemIds],
  );
  const capabilities = useMemo(
    () => normalizedCapabilitiesForComponents(confirmedComponentIds),
    [confirmedComponentIds],
  );

  const save = useMutation({
    mutationFn: () =>
      saveProfile({
        data: {
          ecosystems: selectedEcosystemIds.map((id) => ({ id, usageStatus: ecosystems[id] ?? "in_use" })),
          components: confirmedComponentIds.map((id) => ({ id, usageStatus: components[id] ?? "in_use" })),
        },
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        setMessage(`Systems profile not saved (${result.code}).`);
        return;
      }
      setMessage("Systems & Integrations profile saved.");
      qc.setQueryData(["agency-system-profile"], result);
    },
  });
  const setEcosystem = (id: EcosystemId, checked: boolean) => {
    if (!canManage) return;
    setEcosystems((current) => {
      const next = { ...current };
      if (checked) next[id] = current[id] ?? "in_use";
      else delete next[id];
      return next;
    });
  };

  const setUsage = (
    setter: React.Dispatch<React.SetStateAction<UsageDraft>>,
    id: string,
    usageStatus: UsageStatus,
  ) => setter((current) => ({ ...current, [id]: usageStatus }));

  const confirmComponent = (id: string) => {
    if (!canManage || !COMPONENT_BY_ID.has(id)) return;
    setComponents((current) => ({ ...current, [id]: current[id] ?? "in_use" }));
  };

  const removeComponent = (id: string) => {
    if (!canManage) return;
    setComponents((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  const current = profile.data?.ok ? profile.data.data : null;

  return (
    <SectionCard
      title="Systems & Integrations"
      description="Declare the technology your agency uses. AIRS suggestions are advisory; confirming a system does not connect it or grant data access."
    >
      <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">Agency declaration only.</span>{" "}
        Suggested systems are not installed systems. Confirmed systems remain available but not connected,
        manual only, unauthorized, uncredentialed, and without AIRS data access until a separate connector
        authorization flow occurs.
      </div>

      {!canManage ? (
        <p className="mt-3 text-xs text-muted-foreground">
          You can view this agency profile. Only users with organization management permission can change it.
        </p>
      ) : null}

      {profile.isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading systems profile…</p>
      ) : profile.data && !profile.data.ok ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Systems profile unavailable ({profile.data.code}).
        </p>
      ) : (
        <div className="mt-5 space-y-7">
          <section>
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Technology Ecosystems</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Select vendor ecosystems your agency currently uses or is planning to use.
                </p>
              </div>
              <span className="text-xs text-muted-foreground">{selectedEcosystemIds.length} selected</span>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {ECOSYSTEMS.map((ecosystem) => {
                const selected = ecosystems[ecosystem.id] !== undefined;
                return (
                  <div
                    key={ecosystem.id}
                    className={`rounded-md border p-3 ${selected ? "border-primary bg-primary/5" : "border-border"}`}
                  >
                    <label className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={!canManage}
                        onChange={(event) => setEcosystem(ecosystem.id, event.target.checked)}
                      />
                      {ecosystem.vendorName}
                    </label>
                    {selected ? (
                      <select
                        className={`mt-2 ${selectClass}`}
                        value={ecosystems[ecosystem.id]}
                        disabled={!canManage}
                        onChange={(event) =>
                          setUsage(setEcosystems, ecosystem.id, event.target.value as UsageStatus)
                        }
                      >
                        <option value="in_use">In use</option>
                        <option value="planned">Planned</option>
                      </select>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
          <section>
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Suggested Related Systems</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Catalog suggestions based on selected ecosystems. Suggestions never become confirmed automatically.
                </p>
              </div>
              <span className="text-xs text-muted-foreground">{suggestions.length} suggestions</span>
            </div>
            {suggestions.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Select a technology ecosystem to see relevant systems and interoperability suggestions.
              </p>
            ) : (
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                {suggestions.map((suggestion) => {
                  const confirmed = components[suggestion.componentId] !== undefined;
                  return (
                    <div key={suggestion.componentId} className="rounded-md border border-border p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-foreground">{suggestion.name}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {ECOSYSTEM_NAME.get(suggestion.ecosystemId)} ·{" "}
                            {suggestion.kind === "related_product" ? "Related system" : "Ecosystem component"}
                          </p>
                        </div>
                        {confirmed ? <StatusPill tone="active">confirmed</StatusPill> : null}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {suggestion.capabilities.slice(0, 4).map((capability) => (
                          <span key={capability} className={chipClass}>{capabilityLabel(capability)}</span>
                        ))}
                      </div>
                      <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                        Advisory only: {suggestion.reason}
                      </p>
                      {!confirmed && canManage ? (
                        <button
                          type="button"
                          className="mt-3 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                          onClick={() => confirmComponent(suggestion.componentId)}
                        >
                          Confirm for agency profile
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Installed Components</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Agency-confirmed systems only. Confirmation records usage; it does not create a connection.
                </p>
              </div>
              <span className="text-xs text-muted-foreground">{confirmedComponentIds.length} confirmed</span>
            </div>
            {confirmedComponentIds.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No systems have been confirmed yet.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {confirmedComponentIds.map((id) => {
                  const component = COMPONENT_BY_ID.get(id);
                  if (!component) return null;
                  return (
                    <div key={id} className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3">
                      <div className="min-w-56 flex-1">
                        <p className="text-sm font-medium text-foreground">{component.name}</p>
                        <p className="text-xs text-muted-foreground">{ECOSYSTEM_NAME.get(component.ecosystemId)}</p>
                      </div>
                      <StatusPill tone="active">agency confirmed</StatusPill>
                      <select
                        className={selectClass}
                        value={components[id]}
                        disabled={!canManage}
                        onChange={(event) =>
                          setUsage(setComponents, id, event.target.value as UsageStatus)
                        }
                      >
                        <option value="in_use">In use</option>
                        <option value="planned">Planned</option>
                      </select>
                      {canManage ? (
                        <button
                          type="button"
                          className="rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                          onClick={() => removeComponent(id)}
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
          <section>
            <h3 className="text-sm font-semibold text-foreground">AIRS Connection Status</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Connection is a separate future action. Every agency-confirmed component shown here starts default-deny.
            </p>
            {confirmedComponentIds.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No confirmed systems to evaluate.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {confirmedComponentIds.map((id) => {
                  const component = COMPONENT_BY_ID.get(id);
                  if (!component) return null;
                  return (
                    <div key={id} className="rounded-md border border-border p-3">
                      <p className="text-sm font-medium text-foreground">{component.name}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <StatusPill tone="caution">available · not connected</StatusPill>
                        <StatusPill tone="neutral">manual only</StatusPill>
                        <StatusPill tone="neutral">unauthorized</StatusPill>
                        <StatusPill tone="neutral">no credentials</StatusPill>
                        <StatusPill tone="neutral">no data access</StatusPill>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground">Normalized AIRS Capabilities</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Capabilities the confirmed systems could provide if separately connected and authorized.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {capabilities.length === 0 ? (
                <span className="text-sm text-muted-foreground">No capabilities until systems are confirmed.</span>
              ) : (
                capabilities.map((capability) => (
                  <span key={capability} className={chipClass}>{capabilityLabel(capability)}</span>
                ))
              )}
            </div>
          </section>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              Profile version {current?.version ?? 0}
              {current?.updatedAt ? ` · last saved ${new Date(current.updatedAt).toLocaleString()}` : " · not saved yet"}
            </p>
            {canManage ? (
              <button
                type="button"
                className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                disabled={save.isPending}
                onClick={() => save.mutate()}
              >
                {save.isPending ? "Saving…" : "Save Systems Profile"}
              </button>
            ) : null}
          </div>
          {message ? <p className="text-sm text-foreground">{message}</p> : null}
        </div>
      )}
    </SectionCard>
  );
}
