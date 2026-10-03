import { IncidentWorkspace } from "@/components/operations/incident-workspace";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";

import {
  PageHeading,
  PageShell,
  SectionCard,
  StatusPill,
  type StatusTone,
} from "@/components/brand";
import { CopMap, type MapLayerItem } from "@/components/map/cop-map";
import { DENY_MESSAGES } from "@/components/incident-ui";
import { getMe } from "@/lib/api/auth.functions";
import { listObservationsFn } from "@/lib/api/awareness.functions";
import { OBSERVATION_TYPE_LABELS, OBSERVATION_FRESHNESS_LABELS } from "@/lib/awareness/model";
import { listIncidentsFn } from "@/lib/api/incidents.functions";
import { listIncidentAssignmentsFn, listResourcesFn } from "@/lib/api/resources.functions";
import {
  archiveMapFeatureFn,
  moveIncidentPointFn,
  clearResourceLocationFn,
  createMapFeatureFn,
  createOperatingAreaFn,
  listIncidentResourceLocationsFn,
  listMapFeaturesFn,
  listOperatingAreasFn,
  listResourceLocationsFn,
  reportResourceLocationFn,
  setFeaturePrecisionFn,
  setOperatingAreaStatusFn,
} from "@/lib/api/map.functions";
import {
  activeIncidentResourceIds,
  buildIncidentResourceRoster,
  type IncidentResourceLocationState,
} from "@/lib/map/incident-resources";
import {
  FRESHNESS_LABELS,
  MAP_FEATURE_LABELS,
  MAP_FEATURE_TYPES,
  OPERATING_AREA_LABELS,
  PRECISION_LABELS,
  PRECISION_POLICIES,
  type Freshness,
  type MapFeatureType,
  type PrecisionPolicy,
} from "@/lib/map/model";

export const Route = createFileRoute("/map")({
  head: () => ({
    meta: [
      { title: "Common operating picture — AIRS Agent" },
      {
        name: "description",
        content:
          "Shared incident map for public-safety agencies: operating areas, agency map features and manually reported resource positions, released at the precision the owning agency chose.",
      },
      { property: "og:title", content: "Common operating picture — AIRS Agent" },
      {
        property: "og:description",
        content:
          "Geography is owned by one agency, released per incident room, reduced to a chosen precision and ended when the room closes.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  // The renderer needs the browser; the whole route is client-rendered so no
  // map SDK is ever evaluated during SSR.
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({ tools: search.tools === true || search.tools === "true", incident: typeof search.incident === "string" ? search.incident : "" }),
  component: MapRoute,
});

const inputClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground";
const buttonClass =
  "rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50";
const smallButton =
  "rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-muted";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium text-muted-foreground">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}

const FRESHNESS_TONE: Record<Freshness, StatusTone> = {
  fresh: "active",
  recent: "info",
  aging: "caution",
  stale: "critical",
  expired: "critical",
  unknown: "neutral",
};

const AREA_TONE: Record<string, StatusTone> = {
  proposed: "neutral",
  approved: "info",
  active: "active",
  suspended: "caution",
  completed: "neutral",
  cancelled: "critical",
};

const INCIDENT_LOCATION_LABELS: Record<IncidentResourceLocationState, string> = {
  reported: "Position available",
  withheld: "Location withheld",
  not_reported: "Location not reported",
};

const INCIDENT_LOCATION_TONES: Record<IncidentResourceLocationState, StatusTone> = {
  reported: "active",
  withheld: "caution",
  not_reported: "neutral",
};

/** A square ring around a picked point — the portable way to draft an area
 *  without shipping a drawing toolkit. Coordinates stay plain GeoJSON. */
function squareAround([lng, lat]: [number, number], radiusDeg: number) {
  return {
    type: "Polygon" as const,
    coordinates: [
      [
        [lng - radiusDeg, lat - radiusDeg],
        [lng + radiusDeg, lat - radiusDeg],
        [lng + radiusDeg, lat + radiusDeg],
        [lng - radiusDeg, lat + radiusDeg],
        [lng - radiusDeg, lat - radiusDeg],
      ] as [number, number][],
    ],
  };
}

// Operator-supplied basemap only. Application code never selects a tile
// provider: when VITE_MAP_STYLE_URL is absent the map renders the explicit
// "Basemap not configured" state instead of silently contacting a third party.
const mapStyleUrl = (import.meta.env.VITE_MAP_STYLE_URL as string | undefined) || undefined;
const mapAttribution = (import.meta.env.VITE_MAP_ATTRIBUTION as string | undefined) || undefined;

function MapToolsPage() {
  const qc = useQueryClient();
  const me = useServerFn(getMe);
  const incidentsFn = useServerFn(listIncidentsFn);
  const resourcesFn = useServerFn(listResourcesFn);
  const assignmentsFn = useServerFn(listIncidentAssignmentsFn);
  const featuresFn = useServerFn(listMapFeaturesFn);
  const areasFn = useServerFn(listOperatingAreasFn);
  const locationsFn = useServerFn(listResourceLocationsFn);
  const incidentLocationsFn = useServerFn(listIncidentResourceLocationsFn);
  const observationsFn = useServerFn(listObservationsFn);

  const createFeature = useServerFn(createMapFeatureFn);
  const archiveFeature = useServerFn(archiveMapFeatureFn);
  const movePoint = useServerFn(moveIncidentPointFn);
  const setPrecision = useServerFn(setFeaturePrecisionFn);
  const createArea = useServerFn(createOperatingAreaFn);
  const setAreaStatus = useServerFn(setOperatingAreaStatusFn);
  const reportLocation = useServerFn(reportResourceLocationFn);
  const clearLocation = useServerFn(clearResourceLocationFn);

  const [notice, setNotice] = useState<string | null>(null);
  const [picked, setPicked] = useState<[number, number] | null>(null);
  const [incidentId, setIncidentId] = useState<string>(Route.useSearch().incident);
  const [featureType, setFeatureType] = useState<MapFeatureType>("staging_area");
  const [featureName, setFeatureName] = useState("");
  const [featureDescription, setFeatureDescription] = useState("");
  const [featureShared, setFeatureShared] = useState(false);
  const [coordinateText, setCoordinateText] = useState({latitude:"",longitude:""});
  const [featurePrecision, setFeaturePrecision] = useState<PrecisionPolicy>("generalized");
  const [areaName, setAreaName] = useState("");
  const [areaFloor, setAreaFloor] = useState("0");
  const [areaCeiling, setAreaCeiling] = useState("400");
  const [areaPrecision, setAreaPrecision] = useState<PrecisionPolicy>("area_only");
  const [posResource, setPosResource] = useState("");
  const [posKind, setPosKind] = useState<"fixed" | "temporary">("temporary");
  const [posPrecision, setPosPrecision] = useState<PrecisionPolicy>("approximate");
  const [posHours, setPosHours] = useState("4");
  // Presentation-only layer visibility. Hiding a layer never changes what the
  // server released; it only stops drawing what was already authorized.
  const [showAreas, setShowAreas] = useState(true);
  const [showFeatures, setShowFeatures] = useState(true);
  const [showPositions, setShowPositions] = useState(true);
  const [showObservations, setShowObservations] = useState(true);

  const session = useQuery({ queryKey: ["me"], queryFn: () => me() });
  const signedIn = session.data?.ok === true;

  const incidents = useQuery({ refetchInterval: 3000, refetchIntervalInBackground: false,
    queryKey: ["incidents"],
    queryFn: () => incidentsFn({ data: {} }),
    enabled: signedIn,
  });
  const resources = useQuery({
    queryKey: ["resources"],
    queryFn: () => resourcesFn({ data: {} }),
    enabled: signedIn,
  });
  const assignments = useQuery({ refetchInterval: 3000, refetchIntervalInBackground: false,
    queryKey: ["incident-resource-assignments", incidentId],
    queryFn: () => assignmentsFn({ data: { incidentId } }),
    enabled: signedIn && Boolean(incidentId),
  });
  const features = useQuery({ refetchInterval: 3000, refetchIntervalInBackground: false,
    queryKey: ["map-features", incidentId],
    queryFn: () => featuresFn({ data: { incidentId: incidentId || null } }),
    enabled: signedIn,
  });
  const areas = useQuery({ refetchInterval: 3000, refetchIntervalInBackground: false,
    queryKey: ["operating-areas", incidentId],
    queryFn: () => areasFn({ data: { incidentId: incidentId || null } }),
    enabled: signedIn,
  });
  const locations = useQuery({ refetchInterval: 3000, refetchIntervalInBackground: false,
    queryKey: ["resource-locations", incidentId],
    queryFn: () =>
      incidentId
        ? incidentLocationsFn({ data: { incidentId } })
        : locationsFn({ data: { incidentId: null } }),
    enabled: signedIn,
  });

  const observations = useQuery({ refetchInterval: 3000, refetchIntervalInBackground: false,
    queryKey: ["observations", "map", incidentId],
    queryFn: () => observationsFn({ data: { incidentId: incidentId || null } }),
    enabled: signedIn,
  });

  const report = (result: { ok: boolean; code?: string }, success: string) =>
    setNotice(
      result.ok ? success : (DENY_MESSAGES[result.code ?? ""] ?? `Denied (${result.code}).`),
    );
  const refresh = (...keys: string[]) => {
    for (const key of keys) void qc.invalidateQueries({ queryKey: [key] });
  };

  const featureRows = features.data?.ok ? features.data.data : [];
  const areaRows = areas.data?.ok ? areas.data.data : [];
  const locationRows = locations.data?.ok ? locations.data.data : [];
  const assignmentRows = assignments.data?.ok ? assignments.data.data : [];
  const incidentRows = incidents.data?.ok ? incidents.data.data : [];
  const resourceRows = resources.data?.ok ? resources.data.data : [];
  const observationRows = observations.data?.ok ? observations.data.data : [];
  const activeResourceIds = useMemo(() => activeIncidentResourceIds(assignmentRows), [assignmentRows]);
  const displayedLocationRows = useMemo(
    () => incidentId ? locationRows.filter((l) => activeResourceIds.has(l.resourceId)) : locationRows,
    [activeResourceIds, incidentId, locationRows],
  );
  const incidentResourceRoster = useMemo(
    () => incidentId ? buildIncidentResourceRoster(assignmentRows, locationRows) : [],
    [assignmentRows, incidentId, locationRows],
  );

  const layers = useMemo<MapLayerItem[]>(() => {
    const items: MapLayerItem[] = [];
    if (showAreas)
      for (const a of areaRows) {
        items.push({
          id: `area-${a.id}`,
          category: "Operating areas",
          label: a.name,
          geometry: a.geometry,
          tone: "area",
          detail: `${OPERATING_AREA_LABELS[a.status]} · ${a.altitudeFloorFt}–${a.altitudeCeilingFt} ft`,
        });
      }
    if (showFeatures)
      for (const f of featureRows) {
        items.push({
          id: `feature-${f.id}`,
          category: f.featureType === "point_of_interest" ? "Incident locations / points of interest" : MAP_FEATURE_LABELS[f.featureType],
          label: f.name,
          geometry: f.geometry,
          tone: f.relationship === "owner" ? "own" : "partner",
          detail: MAP_FEATURE_LABELS[f.featureType],
        });
      }
    if (showPositions)
      for (const l of displayedLocationRows) {
        items.push({
          id: `loc-${l.id}`,
          category: "Resource positions",
          label: l.resourceName,
          geometry: l.geometry,
          tone: "position",
          detail: FRESHNESS_LABELS[l.freshness],
        });
      }
    // Awareness layer. A manual report is drawn only when the server released
    // geography for it; a withheld or area-only report contributes no point.
    if (showObservations)
      for (const o of observationRows) {
        items.push({
          id: `obs-${o.id}`,
          category: OBSERVATION_TYPE_LABELS[o.observationType],
          label: o.title,
          geometry: o.geometry,
          tone: "muted",
          detail: `${OBSERVATION_TYPE_LABELS[o.observationType]} · ${OBSERVATION_FRESHNESS_LABELS[o.freshness]}`,
        });
      }
    return items;
  }, [
    areaRows,
    featureRows,
    displayedLocationRows,
    observationRows,
    showAreas,
    showFeatures,
    showPositions,
    showObservations,
  ]);

  /** Count of authorized items actually drawn on the enabled layers. */
  const drawn = layers.filter((i) => i.geometry).length;

  const withheld =
    featureRows.filter((f) => !f.geometry).length +
    areaRows.filter((a) => !a.geometry).length +
    displayedLocationRows.filter((l) => !l.geometry).length +
    observationRows.filter((o) => !o.geometry).length;

  const addFeature = useMutation({
    mutationFn: () =>
      createFeature({
        data: {
          incidentId: incidentId || null,
          featureType,
          name: featureName,
          description: featureDescription,
          classification: featureShared ? "participating_orgs" : "originating_org_only",
          geometry: { type: "Point" as const, coordinates: picked as [number, number] },
          precisionPolicy: featurePrecision,
        },
      }),
    onSuccess: (r) => {
      report(r, `Placed ${featureName}.`);
      if (r.ok) {
        setFeatureName("");
        refresh("map-features");
      }
    },
  });

  const addArea = useMutation({
    mutationFn: () =>
      createArea({
        data: {
          incidentId,
          name: areaName,
          area: squareAround(picked as [number, number], 0.01),
          altitudeFloorFt: Number(areaFloor) || 0,
          altitudeCeilingFt: Number(areaCeiling) || 400,
          precisionPolicy: areaPrecision,
        },
      }),
    onSuccess: (r) => {
      report(r, `Proposed ${areaName}.`);
      if (r.ok) {
        setAreaName("");
        refresh("operating-areas");
      }
    },
  });

  const addPosition = useMutation({
    mutationFn: () =>
      reportLocation({
        data: {
          resourceId: posResource,
          locationKind: posKind,
          point: { type: "Point" as const, coordinates: picked as [number, number] },
          incidentId: posKind === "temporary" && incidentId ? incidentId : null,
          precisionPolicy: posPrecision,
          validForHours: posKind === "temporary" ? Number(posHours) || 4 : null,
        },
      }),
    onSuccess: (r) => {
      report(r, "Position recorded.");
      if (r.ok) refresh("resource-locations");
    },
  });

  if (!signedIn) {
    return (
      <PageShell>
        <PageHeading
          eyebrow="Stage 7"
          title="Common operating picture"
          description="Sign in to view the shared incident map."
        />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeading
        eyebrow="Common operating picture"
        title="Map editing tools"
        actions={<a className="text-sm underline" href={`/map?incident=${incidentId}`}>Back to operational workspace</a>}
        description="Every shape belongs to one agency. Partners see only what an active incident room released, reduced to the precision the owner chose. Nothing here tracks anything: positions are entered by hand and age visibly."
      />

      {notice ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">{notice}</p>
      ) : null}

      <SectionCard
        title="Map"
        description={
          withheld > 0
            ? `${withheld} record${withheld === 1 ? "" : "s"} released without geography at your access level.`
            : "Click the map to set the working point used by the forms below."
        }
      >
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label="Incident room">
            <select
              className={inputClass}
              value={incidentId}
              onChange={(e) => setIncidentId(e.target.value)}
            >
              <option value="">All geography I can see</option>
              {incidentRows.map((i: { id: string; name: string }) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </Field>
          <fieldset className="grid w-full min-w-0 grid-cols-1 gap-x-4 gap-y-2 rounded-md border border-border px-3 py-2 sm:grid-cols-2 lg:w-auto lg:grid-cols-4">
            <legend className="px-1 text-xs font-medium text-muted-foreground">
              Operational layers
            </legend>
            {[
              ["Operating areas", showAreas, setShowAreas] as const,
              ["Map features", showFeatures, setShowFeatures] as const,
              ["Reported positions", showPositions, setShowPositions] as const,
              ["Awareness observations", showObservations, setShowObservations] as const,
            ].map(([label, checked, set]) => (
              <label key={label} className="flex items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={checked}
                  onChange={(e) => set(e.target.checked)}
                />
                {label}
              </label>
            ))}
          </fieldset>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] leading-relaxed text-muted-foreground/90">
          <span>
            Scope:{" "}
            {incidentId
              ? (incidentRows.find((i: { id: string; name: string }) => i.id === incidentId)
                  ?.name ?? "Selected incident room")
              : "All geography I can see"}
          </span>
          <span>
            {drawn} authorized item{drawn === 1 ? "" : "s"} drawn
          </span>
          <span>
            {picked
              ? `Working point ${picked[1].toFixed(5)}, ${picked[0].toFixed(5)}`
              : "No working point selected"}
          </span>
          {picked ? (
            <button
              type="button"
              className="rounded-md border border-border/70 px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title="Clear working point"
              aria-label="Clear the selected working point"
              onClick={() => setPicked(null)}
            >
              Clear working point
            </button>
          ) : null}
        </div>
        <CopMap
          items={layers}
          styleUrl={mapStyleUrl}
          attribution={mapAttribution}
          picking
          onPickPoint={setPicked}
          workingPoint={picked}
          className="flex h-[460px] w-full flex-col overflow-hidden rounded-lg border border-border"
        />
      </SectionCard>

      {incidentId ? (
        <SectionCard
          title="Incident resources"
          description="Resources currently committed to this incident. Partner resources appear only while their incident share remains active."
        >
          {assignments.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading incident resources…</p>
          ) : assignments.data && !assignments.data.ok ? (
            <p className="text-sm text-muted-foreground">Incident resources are not available at your access level.</p>
          ) : incidentResourceRoster.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active resources are visible for this incident.</p>
          ) : (
            <ul className="space-y-2">
              {incidentResourceRoster.map((resource) => (
                <li key={resource.assignmentId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                  <div className="text-sm">
                    <span className="font-medium">{resource.label}</span>{" "}
                    <span className="text-muted-foreground">
                      · {resource.ownerOrgName ?? "your agency"} · {resource.status}
                    </span>
                  </div>
                  <StatusPill tone={INCIDENT_LOCATION_TONES[resource.locationState]}>
                    {INCIDENT_LOCATION_LABELS[resource.locationState]}
                  </StatusPill>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard title="Place a map feature" description="Owned by your agency.">
          <div className="space-y-3">
            <details><summary className="cursor-pointer text-sm">Enter a known coordinate</summary>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Field label="Feature latitude"><input type="number" step="any" min="-90" max="90" className={inputClass} value={coordinateText.latitude} onChange={e=>setCoordinateText(v=>({...v,latitude:e.target.value}))}/></Field>
                <Field label="Feature longitude"><input type="number" step="any" min="-180" max="180" className={inputClass} value={coordinateText.longitude} onChange={e=>setCoordinateText(v=>({...v,longitude:e.target.value}))}/></Field>
              </div>
              <button className={smallButton} disabled={!coordinateText.latitude||!coordinateText.longitude||!Number.isFinite(Number(coordinateText.latitude))||!Number.isFinite(Number(coordinateText.longitude))||Math.abs(Number(coordinateText.latitude))>90||Math.abs(Number(coordinateText.longitude))>180} onClick={()=>setPicked([Number(coordinateText.longitude),Number(coordinateText.latitude)])}>Use coordinate</button>
            </details>
            <Field label="Type">
              <select
                className={inputClass}
                value={featureType}
                onChange={(e) => setFeatureType(e.target.value as MapFeatureType)}
              >
                {MAP_FEATURE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {MAP_FEATURE_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name">
              <input
                className={inputClass}
                value={featureName}
                onChange={(e) => setFeatureName(e.target.value)}
              />
            </Field>
            <Field label="Precision released to partners">
              <select
                className={inputClass}
                value={featurePrecision}
                onChange={(e) => setFeaturePrecision(e.target.value as PrecisionPolicy)}
              >
                {PRECISION_POLICIES.map((p) => (
                  <option key={p} value={p}>
                    {PRECISION_LABELS[p]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Feature description / location source"><textarea className={inputClass} value={featureDescription} maxLength={2000} onChange={e=>setFeatureDescription(e.target.value)}/></Field>
            <label className="flex gap-2 text-sm"><input type="checkbox" checked={featureShared} disabled={!incidentId} onChange={e=>setFeatureShared(e.target.checked)}/>Share feature with participating agencies in this incident</label>
            <button
              className={buttonClass}
              disabled={!picked || !featureName || addFeature.isPending}
              onClick={() => addFeature.mutate()}
            >
              Place feature
            </button>
          </div>
        </SectionCard>

        <SectionCard title="Propose an operating area" description="Requires an incident room.">
          <div className="space-y-3">
            <Field label="Name">
              <input
                className={inputClass}
                value={areaName}
                onChange={(e) => setAreaName(e.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Floor (ft AGL)">
                <input
                  className={inputClass}
                  value={areaFloor}
                  onChange={(e) => setAreaFloor(e.target.value)}
                />
              </Field>
              <Field label="Ceiling (ft AGL)">
                <input
                  className={inputClass}
                  value={areaCeiling}
                  onChange={(e) => setAreaCeiling(e.target.value)}
                />
              </Field>
            </div>
            <Field label="Precision released to partners">
              <select
                className={inputClass}
                value={areaPrecision}
                onChange={(e) => setAreaPrecision(e.target.value as PrecisionPolicy)}
              >
                {PRECISION_POLICIES.map((p) => (
                  <option key={p} value={p}>
                    {PRECISION_LABELS[p]}
                  </option>
                ))}
              </select>
            </Field>
            <button
              className={buttonClass}
              disabled={!picked || !areaName || !incidentId || addArea.isPending}
              onClick={() => addArea.mutate()}
            >
              Propose area
            </button>
          </div>
        </SectionCard>

        <SectionCard title="Record a position" description="Manual entry. No tracking, no feed.">
          <div className="space-y-3">
            <Field label="Resource">
              <select
                className={inputClass}
                value={posResource}
                onChange={(e) => setPosResource(e.target.value)}
              >
                <option value="">Select a resource</option>
                {resourceRows.map((r: { id: string; displayName: string }) => (
                  <option key={r.id} value={r.id}>
                    {r.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Kind">
              <select
                className={inputClass}
                value={posKind}
                onChange={(e) => setPosKind(e.target.value as "fixed" | "temporary")}
              >
                <option value="temporary">Temporary (expires)</option>
                <option value="fixed">Fixed site</option>
              </select>
            </Field>
            {posKind === "temporary" ? (
              <Field label="Valid for (hours)">
                <input
                  className={inputClass}
                  value={posHours}
                  onChange={(e) => setPosHours(e.target.value)}
                />
              </Field>
            ) : null}
            <Field label="Precision released to partners">
              <select
                className={inputClass}
                value={posPrecision}
                onChange={(e) => setPosPrecision(e.target.value as PrecisionPolicy)}
              >
                {PRECISION_POLICIES.map((p) => (
                  <option key={p} value={p}>
                    {PRECISION_LABELS[p]}
                  </option>
                ))}
              </select>
            </Field>
            <button
              className={buttonClass}
              disabled={!picked || !posResource || addPosition.isPending}
              onClick={() => addPosition.mutate()}
            >
              Record position
            </button>
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Operating areas" description="Approval and suspension are owner actions.">
        {areaRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No operating areas visible.</p>
        ) : (
          <ul className="space-y-2">
            {areaRows.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
              >
                <div className="text-sm">
                  <span className="font-medium">{a.name}</span>{" "}
                  <span className="text-muted-foreground">
                    {a.altitudeFloorFt}–{a.altitudeCeilingFt} ft ·{" "}
                    {a.relationship === "owner" ? "yours" : (a.ownerOrgName ?? "partner agency")} ·{" "}
                    {PRECISION_LABELS[a.precision]}
                    {a.geometry ? "" : " · geography withheld"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill tone={AREA_TONE[a.status] ?? "neutral"}>
                    {OPERATING_AREA_LABELS[a.status]}
                  </StatusPill>
                  {a.relationship === "owner" && a.status === "proposed" ? (
                    <button
                      className={smallButton}
                      onClick={async () => {
                        report(
                          await setAreaStatus({
                            data: { areaId: a.id, status: "approved", expectedVersion: a.version },
                          }),
                          "Area approved.",
                        );
                        refresh("operating-areas");
                      }}
                    >
                      Approve
                    </button>
                  ) : null}
                  {a.relationship === "owner" && ["approved", "active"].includes(a.status) ? (
                    <button
                      className={smallButton}
                      onClick={async () => {
                        report(
                          await setAreaStatus({
                            data: { areaId: a.id, status: "completed", expectedVersion: a.version },
                          }),
                          "Area completed.",
                        );
                        refresh("operating-areas");
                      }}
                    >
                      Complete
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Map features" description="Yours and any released to you.">
          {featureRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No map features visible.</p>
          ) : (
            <ul className="space-y-2">
              {featureRows.map((f) => (
                <li
                  key={f.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
                >
                  <div>
                    <span className="font-medium">{f.name}</span>{" "}
                    <span className="text-muted-foreground">
                      {MAP_FEATURE_LABELS[f.featureType]} ·{" "}
                      {f.relationship === "owner" ? "yours" : (f.ownerOrgName ?? "partner agency")}{" "}
                      · {PRECISION_LABELS[f.precision]}
                      {f.geometry ? "" : " · geography withheld"}
                    </span>
                  </div>
                  {f.relationship === "owner" ? (
                    <div className="flex items-center gap-2">
                      {f.featureType === "point_of_interest" && incidentId && <button className={smallButton} disabled={!picked} onClick={async () => {
                        if (!picked) return;
                        report(await movePoint({data:{featureId:f.id, expectedVersion:f.version, geometry:{type:"Point",coordinates:picked}, description: featureDescription.trim() || "Incident command corrected this location by selecting a point on the map."}}), "Incident point moved to selected location.");
                        refresh("map-features");
                      }}>Move to selected point</button>}
                      <select
                        className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                        value={f.declaredPrecision ?? "generalized"}
                        onChange={async (e) => {
                          report(
                            await setPrecision({
                              data: {
                                featureId: f.id,
                                precisionPolicy: e.target.value as PrecisionPolicy,
                              },
                            }),
                            "Precision narrowed.",
                          );
                          refresh("map-features");
                        }}
                      >
                        {PRECISION_POLICIES.map((p) => (
                          <option key={p} value={p}>
                            {PRECISION_LABELS[p]}
                          </option>
                        ))}
                      </select>
                      <button
                        className={smallButton}
                        onClick={async () => {
                          report(
                            await archiveFeature({ data: { featureId: f.id } }),
                            "Feature archived.",
                          );
                          refresh("map-features");
                        }}
                      >
                        Archive
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Reported positions"
          description="Freshness is computed by the server clock, not asserted by the browser."
        >
          {locationRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No positions visible.</p>
          ) : (
            <ul className="space-y-2">
              {locationRows.map((l) => (
                <li
                  key={l.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
                >
                  <div>
                    <span className="font-medium">{l.resourceName}</span>{" "}
                    <span className="text-muted-foreground">
                      {l.locationKind === "fixed" ? "fixed site" : "temporary"} ·{" "}
                      {PRECISION_LABELS[l.precision]}
                      {l.geometry ? "" : " · geography withheld"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusPill tone={FRESHNESS_TONE[l.freshness]}>
                      {FRESHNESS_LABELS[l.freshness]}
                    </StatusPill>
                    {l.relationship === "owner" ? (
                      <button
                        className={smallButton}
                        onClick={async () => {
                          report(
                            await clearLocation({ data: { locationId: l.id } }),
                            "Position cleared.",
                          );
                          refresh("resource-locations");
                        }}
                      >
                        Clear
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </PageShell>
  );
}

function MapRoute() {
  const search=Route.useSearch();
  return search.tools ? <MapToolsPage/> : <ProductionMapPage/>;
}
function ProductionMapPage() {
  const search=Route.useSearch();
  const [selected,setSelected]=useState(search.incident);
  const list=useServerFn(listIncidentsFn);
  const incidents=useQuery({queryKey:["incidents"],queryFn:()=>list({data:{}}),refetchInterval:3000,refetchIntervalInBackground:false});
  const rows=incidents.data?.ok?incidents.data.data:[];
  const incidentId=selected || (rows.length===1?rows[0].id:"");
  return <PageShell width="full"><div className="flex flex-col gap-2">
    <div className="flex shrink-0 flex-wrap items-center gap-3"><h1 className="text-lg font-semibold">Common Operating Picture</h1><label className="text-xs">Incident <select className="ml-2 rounded border bg-background px-2 py-1" value={incidentId} onChange={e=>setSelected(e.target.value)}><option value="">Select incident</option>{rows.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label></div>
    {incidents.data?.ok===false?<p role="alert">Select an authorized agency in the organization menu to load its incident workspace.</p>:incidentId?<div className="min-h-0 flex-1"><IncidentWorkspace key={incidentId} incidentId={incidentId}/></div>:<p>{incidents.isPending?"Loading incidents…":"Select an incident to view its command post, agencies, resources, map and decision log."}</p>}
  </div></PageShell>;
}
