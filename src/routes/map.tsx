import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";

import { PageHeading, PageShell, SectionCard, StatusPill, type StatusTone } from "@/components/brand";
import { CopMap, type MapLayerItem } from "@/components/map/cop-map";
import { DENY_MESSAGES } from "@/components/incident-ui";
import { getMe } from "@/lib/api/auth.functions";
import { listObservationsFn } from "@/lib/api/awareness.functions";
import { OBSERVATION_TYPE_LABELS, OBSERVATION_FRESHNESS_LABELS } from "@/lib/awareness/model";
import { listIncidentsFn } from "@/lib/api/incidents.functions";
import { listResourcesFn } from "@/lib/api/resources.functions";
import {
  archiveMapFeatureFn,
  clearResourceLocationFn,
  createMapFeatureFn,
  createOperatingAreaFn,
  listMapFeaturesFn,
  listOperatingAreasFn,
  listResourceLocationsFn,
  reportResourceLocationFn,
  setFeaturePrecisionFn,
  setOperatingAreaStatusFn,
} from "@/lib/api/map.functions";
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
  component: MapPage,
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

// Operator-supplied basemap. Absent by design in environments with no approved
// tile service: the renderer then explains itself instead of loading one.
const mapStyleUrl = (import.meta.env.VITE_MAP_STYLE_URL as string | undefined) || undefined;
const mapAttribution =
  (import.meta.env.VITE_MAP_ATTRIBUTION as string | undefined) ||
  (mapStyleUrl ? "Basemap © the configured tile provider · Rendered with MapLibre GL JS" : undefined);

function MapPage() {
  const qc = useQueryClient();
  const me = useServerFn(getMe);
  const incidentsFn = useServerFn(listIncidentsFn);
  const resourcesFn = useServerFn(listResourcesFn);
  const featuresFn = useServerFn(listMapFeaturesFn);
  const areasFn = useServerFn(listOperatingAreasFn);
  const locationsFn = useServerFn(listResourceLocationsFn);
  const observationsFn = useServerFn(listObservationsFn);

  const createFeature = useServerFn(createMapFeatureFn);
  const archiveFeature = useServerFn(archiveMapFeatureFn);
  const setPrecision = useServerFn(setFeaturePrecisionFn);
  const createArea = useServerFn(createOperatingAreaFn);
  const setAreaStatus = useServerFn(setOperatingAreaStatusFn);
  const reportLocation = useServerFn(reportResourceLocationFn);
  const clearLocation = useServerFn(clearResourceLocationFn);

  const [notice, setNotice] = useState<string | null>(null);
  const [picked, setPicked] = useState<[number, number] | null>(null);
  const [incidentId, setIncidentId] = useState<string>("");
  const [featureType, setFeatureType] = useState<MapFeatureType>("staging_area");
  const [featureName, setFeatureName] = useState("");
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

  const incidents = useQuery({
    queryKey: ["incidents"],
    queryFn: () => incidentsFn({ data: {} }),
    enabled: signedIn,
  });
  const resources = useQuery({
    queryKey: ["resources"],
    queryFn: () => resourcesFn({ data: {} }),
    enabled: signedIn,
  });
  const features = useQuery({
    queryKey: ["map-features", incidentId],
    queryFn: () => featuresFn({ data: { incidentId: incidentId || null } }),
    enabled: signedIn,
  });
  const areas = useQuery({
    queryKey: ["operating-areas", incidentId],
    queryFn: () => areasFn({ data: { incidentId: incidentId || null } }),
    enabled: signedIn,
  });
  const locations = useQuery({
    queryKey: ["resource-locations", incidentId],
    queryFn: () => locationsFn({ data: { incidentId: incidentId || null } }),
    enabled: signedIn,
  });

  const observations = useQuery({
    queryKey: ["observations", "map", incidentId],
    queryFn: () => observationsFn({ data: { incidentId: incidentId || null } }),
    enabled: signedIn,
  });

  const report = (result: { ok: boolean; code?: string }, success: string) =>
    setNotice(result.ok ? success : (DENY_MESSAGES[result.code ?? ""] ?? `Denied (${result.code}).`));
  const refresh = (...keys: string[]) => {
    for (const key of keys) void qc.invalidateQueries({ queryKey: [key] });
  };

  const featureRows = features.data?.ok ? features.data.data : [];
  const areaRows = areas.data?.ok ? areas.data.data : [];
  const locationRows = locations.data?.ok ? locations.data.data : [];
  const incidentRows = incidents.data?.ok ? incidents.data.data : [];
  const resourceRows = resources.data?.ok ? resources.data.data : [];
  const observationRows = observations.data?.ok ? observations.data.data : [];

  const layers = useMemo<MapLayerItem[]>(() => {
    const items: MapLayerItem[] = [];
    if (showAreas)
    for (const a of areaRows) {
      items.push({
        id: `area-${a.id}`,
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
        label: f.name,
        geometry: f.geometry,
        tone: f.relationship === "owner" ? "own" : "partner",
        detail: MAP_FEATURE_LABELS[f.featureType],
      });
    }
    if (showPositions)
    for (const l of locationRows) {
      items.push({
        id: `loc-${l.id}`,
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
        label: o.title,
        geometry: o.geometry,
        tone: "muted",
        detail: `${OBSERVATION_TYPE_LABELS[o.observationType]} · ${OBSERVATION_FRESHNESS_LABELS[o.freshness]}`,
      });
    }
    return items;
  }, [areaRows, featureRows, locationRows, observationRows, showAreas, showFeatures, showPositions, showObservations]);

  const withheld =
    featureRows.filter((f) => !f.geometry).length +
    areaRows.filter((a) => !a.geometry).length +
    locationRows.filter((l) => !l.geometry).length +
    observationRows.filter((o) => !o.geometry).length;

  const addFeature = useMutation({
    mutationFn: () =>
      createFeature({
        data: {
          incidentId: incidentId || null,
          featureType,
          name: featureName,
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
        title="Incident map and operating areas"
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
          <fieldset className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2">
            <legend className="px-1 text-xs font-medium text-muted-foreground">Layers</legend>
            {(
              [
                ["Operating areas", showAreas, setShowAreas] as const,
                ["Map features", showFeatures, setShowFeatures] as const,
                ["Reported positions", showPositions, setShowPositions] as const,
                ["Awareness observations", showObservations, setShowObservations] as const,
              ]
            ).map(([label, checked, set]) => (
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
          <p className="text-xs text-muted-foreground">
            {picked
              ? `Working point ${picked[1].toFixed(5)}, ${picked[0].toFixed(5)}`
              : "No working point selected"}
          </p>
        </div>
        <CopMap
          items={layers}
          styleUrl={mapStyleUrl}
          attribution={mapAttribution}
          picking
          onPickPoint={setPicked}
          className="h-[420px] w-full overflow-hidden rounded-lg border border-border"
        />
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard title="Place a map feature" description="Owned by your agency.">
          <div className="space-y-3">
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
                      {f.relationship === "owner" ? "yours" : (f.ownerOrgName ?? "partner agency")} ·{" "}
                      {PRECISION_LABELS[f.precision]}
                      {f.geometry ? "" : " · geography withheld"}
                    </span>
                  </div>
                  {f.relationship === "owner" ? (
                    <div className="flex items-center gap-2">
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
