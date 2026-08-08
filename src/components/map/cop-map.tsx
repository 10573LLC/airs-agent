// Portable MapLibre GL JS renderer.
//
// MapLibre is BSD-licensed and self-hostable; nothing here depends on a hosted
// map service. The basemap style URL is supplied by the operator
// (VITE_MAP_STYLE_URL). When it is absent the component renders an explicit
// configuration notice: it never silently selects a third-party tile provider,
// and it never shows a blank map frame pretending to be a basemap.
//
// The renderer only DRAWS what the server released. It never fetches a
// coordinate, never fills in a missing geometry and never widens precision:
// anything the server withheld simply has no geometry and is not drawn.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bounds, type Geometry } from "@/lib/map/model";
import {
  COP_INTERACTIVE_LAYER_IDS,
  installCopLayers,
  safeQuery,
  type MinimalMap,
} from "./layer-install";

export interface MapLayerItem {
  id: string;
  label: string;
  geometry?: Geometry;
  /** Drives the colour ramp: owner geography vs partner-released geography. */
  tone: "own" | "partner" | "area" | "position" | "muted";
  detail?: string;
}

export interface CopMapProps {
  items: readonly MapLayerItem[];
  /** Operator-supplied style for an internal/offline tile server. */
  styleUrl?: string;
  /** Attribution the operator's tile licence requires. Always displayed. */
  attribution?: string;
  className?: string;
  onPickPoint?: (lngLat: [number, number]) => void;
  picking?: boolean;
  /** The coordinate the forms below the map are currently working with. */
  workingPoint?: [number, number] | null;
}

export const TONE: Record<MapLayerItem["tone"], string> = {
  own: "#38bdf8",
  partner: "#f59e0b",
  area: "#22c55e",
  position: "#e11d48",
  muted: "#94a3b8",
};

/** Legend copy for each overlay tone. Order is the reading order. */
export const TONE_LEGEND: readonly { tone: MapLayerItem["tone"]; label: string }[] = [
  { tone: "own", label: "Agency-owned geography" },
  { tone: "partner", label: "Partner-released geography" },
  { tone: "area", label: "Operating area" },
  { tone: "position", label: "Reported position" },
  { tone: "muted", label: "Other / muted" },
];

/** AIRS default camera: Albany, NY with regional orientation context. */
export const DEFAULT_CENTER: [number, number] = [-73.7562, 42.6526];
export const DEFAULT_ZOOM = 11.2;

const WORKING_POINT_COLOR = "#a855f7";

export function CopMap({
  items,
  styleUrl,
  attribution,
  className,
  onPickPoint,
  picking,
  workingPoint,
}: CopMapProps) {
  const holder = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<unknown>(null);
  const pickRef = useRef(onPickPoint);
  pickRef.current = onPickPoint;
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const [status, setStatus] = useState<string | null>(null);
  const [info, setInfo] = useState<{ label: string; detail: string; layer: string } | null>(null);

  const collection = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: items
        .filter((i) => i.geometry)
        .map((i) => ({
          type: "Feature" as const,
          id: i.id,
          properties: {
            label: i.label,
            color: TONE[i.tone],
            detail: i.detail ?? "",
            layer: TONE_LEGEND.find((t) => t.tone === i.tone)?.label ?? "",
          },
          geometry: i.geometry as Geometry,
        })),
    }),
    [items],
  );

  const workingCollection = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: workingPoint
        ? [
            {
              type: "Feature" as const,
              id: "working-point",
              properties: {},
              geometry: { type: "Point" as const, coordinates: workingPoint },
            },
          ]
        : [],
    }),
    [workingPoint],
  );

  const resetView = useCallback(() => {
    const map = mapRef.current as import("maplibre-gl").Map | null;
    if (!map) return;
    setStatus(null);
    map.easeTo({ center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM, bearing: 0, pitch: 0 });
  }, []);

  // Frames only the geography already drawn — i.e. only what the server
  // released to this reader on the layers they left enabled. Nothing hidden is
  // requested, inferred or included in the bounds.
  const fitVisible = useCallback(() => {
    const map = mapRef.current as import("maplibre-gl").Map | null;
    if (!map) return;
    const box = bounds(items.filter((i) => i.geometry).map((i) => i.geometry));
    if (!box) {
      setStatus("No visible AIRS geography to fit — the camera is unchanged.");
      return;
    }
    setStatus(null);
    map.fitBounds(
      [
        [box[0], box[1]],
        [box[2], box[3]],
      ],
      { padding: 64, maxZoom: 15, duration: 600 },
    );
  }, [items]);

  // MapLibre touches window/document at import time, so it is imported after
  // hydration rather than at module scope.
  useEffect(() => {
    if (!styleUrl) return;
    let disposed = false;
    let map: import("maplibre-gl").Map | null = null;
    (async () => {
      const maplibre = await import("maplibre-gl");
      await import("maplibre-gl/dist/maplibre-gl.css");
      if (disposed || !holder.current) return;
      map = new maplibre.Map({
        container: holder.current,
        style: styleUrl,
        center: DEFAULT_CENTER, // Albany, NY — the demo agencies' area
        // Shows the City of Albany, the surrounding arterial/highway network and
        // neighbouring municipalities, the Hudson River and enough regional
        // context for orientation, without any panning on first load.
        zoom: DEFAULT_ZOOM,
        minZoom: 3,
        attributionControl: { compact: true },
      });
      const m = map;
      m.addControl(new maplibre.NavigationControl({ visualizePitch: false }), "top-right");
      m.addControl(new maplibre.ScaleControl({ unit: "imperial" }), "bottom-left");
      m.on("load", () => {
        if (!map) return;
        map.addSource("cop", { type: "geojson", data: collection as never });
        map.addLayer({
          id: "cop-fill",
          type: "fill",
          source: "cop",
          filter: ["==", ["geometry-type"], "Polygon"],
          paint: { "fill-color": ["get", "color"], "fill-opacity": 0.18 },
        });
        map.addLayer({
          id: "cop-outline",
          type: "line",
          source: "cop",
          filter: ["!=", ["geometry-type"], "Point"],
          paint: { "line-color": ["get", "color"], "line-width": 2 },
        });
        map.addLayer({
          id: "cop-point",
          type: "circle",
          source: "cop",
          filter: ["==", ["geometry-type"], "Point"],
          paint: {
            "circle-radius": 6,
            "circle-color": ["get", "color"],
            "circle-stroke-width": 2,
            "circle-stroke-color": "#0b1220",
          },
        });
        map.addLayer({
          id: "cop-label",
          type: "symbol",
          source: "cop",
          layout: {
            "text-field": ["get", "label"],
            "text-size": 11,
            "text-offset": [0, 1.2],
            "text-anchor": "top",
          },
          paint: { "text-color": "#e2e8f0", "text-halo-color": "#0b1220", "text-halo-width": 1.4 },
        });

        // Transient working point. It exists only in the browser and is never
        // persisted unless a form below the map creates a real record.
        map.addSource("working-point", { type: "geojson", data: workingCollection as never });
        map.addLayer({
          id: "working-point-halo",
          type: "circle",
          source: "working-point",
          paint: {
            "circle-radius": 13,
            "circle-color": WORKING_POINT_COLOR,
            "circle-opacity": 0.2,
          },
        });
        map.addLayer({
          id: "working-point-dot",
          type: "circle",
          source: "working-point",
          paint: {
            "circle-radius": 6,
            "circle-color": WORKING_POINT_COLOR,
            "circle-stroke-width": 2,
            "circle-stroke-color": "#f8fafc",
          },
        });
      });
      const hoverLayers = ["cop-fill", "cop-outline", "cop-point"];
      m.on("mousemove", (event) => {
        const hit = m.queryRenderedFeatures(event.point, { layers: hoverLayers });
        m.getCanvas().style.cursor = hit.length ? "pointer" : pickingRef.current ? "crosshair" : "";
      });
      m.on("click", (event) => {
        const hit = m.queryRenderedFeatures(event.point, { layers: hoverLayers })[0];
        if (hit) {
          const props = (hit.properties ?? {}) as Record<string, string>;
          setInfo({
            label: props.label ?? "",
            detail: props.detail ?? "",
            layer: props.layer ?? "",
          });
        } else {
          setInfo(null);
        }
        pickRef.current?.([event.lngLat.lng, event.lngLat.lat]);
        setStatus(null);
      });
      mapRef.current = m;
    })();
    return () => {
      disposed = true;
      map?.remove();
      mapRef.current = null;
    };
  }, [styleUrl]);

  // Push released geography into the existing source; never re-create the map.
  useEffect(() => {
    const map = mapRef.current as import("maplibre-gl").Map | null;
    if (!map) return;
    const apply = () => {
      const source = map.getSource("cop") as { setData?: (d: unknown) => void } | undefined;
      source?.setData?.(collection);
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [collection]);

  // Keep the transient marker in step with the form's working point.
  useEffect(() => {
    const map = mapRef.current as import("maplibre-gl").Map | null;
    if (!map) return;
    const apply = () => {
      const source = map.getSource("working-point") as
        | { setData?: (d: unknown) => void }
        | undefined;
      source?.setData?.(workingCollection);
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [workingCollection]);

  // No configured provider: say so plainly. The authorized feature, area and
  // position lists elsewhere on the page remain the working alternative.
  if (!styleUrl) {
    const drawn = items.filter((i) => i.geometry).length;
    return (
      <div
        role="status"
        className={`${className ?? ""} flex flex-col items-start justify-center gap-2 bg-muted/30 p-6`}
      >
        <p className="text-sm font-semibold text-foreground">Basemap not configured</p>
        <p className="max-w-prose text-sm text-muted-foreground">
          No map style URL is set, so no basemap is loaded and no third-party tile provider is
          contacted. Set <code>VITE_MAP_STYLE_URL</code> to a MapLibre style served by your own or
          an approved tile service, then reload.
        </p>
        <p className="text-sm text-muted-foreground">
          {drawn} authorized item{drawn === 1 ? "" : "s"} with released geography are listed below;
          the lists remain fully usable without a basemap.
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="relative h-full min-h-0 w-full flex-1">
        <div
          ref={holder}
          className="h-full w-full"
          style={{ cursor: picking ? "crosshair" : undefined }}
          role="application"
          aria-label="Common operating picture map"
        />
        <div className="pointer-events-none absolute inset-x-2 top-2 flex flex-wrap items-start justify-between gap-2">
          <div className="pointer-events-auto flex flex-wrap gap-2">
            <button
              type="button"
              onClick={resetView}
              title="Reset view"
              aria-label="Reset view to the default Albany camera"
              className="rounded-md border border-border bg-background/95 px-2 py-1 text-xs font-medium text-foreground shadow-sm hover:bg-muted"
            >
              Reset view
            </button>
            <button
              type="button"
              onClick={fitVisible}
              title="Fit visible data"
              aria-label="Fit the camera to the currently visible AIRS geography"
              className="rounded-md border border-border bg-background/95 px-2 py-1 text-xs font-medium text-foreground shadow-sm hover:bg-muted"
            >
              Fit visible data
            </button>
          </div>
          <details className="pointer-events-auto max-w-[14rem] rounded-md border border-border bg-background/95 px-2 py-1 text-xs shadow-sm">
            <summary className="cursor-pointer font-medium text-foreground">Legend</summary>
            <ul className="mt-1 space-y-1">
              {TONE_LEGEND.map((entry) => (
                <li key={entry.tone} className="flex items-center gap-2 text-muted-foreground">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: TONE[entry.tone] }}
                  />
                  {entry.label}
                </li>
              ))}
              <li className="flex items-center gap-2 text-muted-foreground">
                <span
                  aria-hidden="true"
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: WORKING_POINT_COLOR }}
                />
                Selected working point
              </li>
            </ul>
          </details>
        </div>
        {info ? (
          <div className="absolute bottom-2 left-2 max-w-[18rem] rounded-md border border-border bg-background/95 p-2 text-xs shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold text-foreground">{info.label}</p>
              <button
                type="button"
                onClick={() => setInfo(null)}
                aria-label="Close feature details"
                title="Close feature details"
                className="rounded border border-border px-1 text-muted-foreground hover:bg-muted"
              >
                ×
              </button>
            </div>
            {info.detail ? <p className="text-muted-foreground">{info.detail}</p> : null}
            {info.layer ? <p className="text-muted-foreground">{info.layer}</p> : null}
          </div>
        ) : null}
      </div>
      {status ? (
        <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
          {status}
        </p>
      ) : null}
      {attribution ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">{attribution}</p>
      ) : null}
    </div>
  );
}

export default CopMap;
