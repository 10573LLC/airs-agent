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
import { useEffect, useMemo, useRef } from "react";
import type { Geometry } from "@/lib/map/model";

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
}

const TONE: Record<MapLayerItem["tone"], string> = {
  own: "#38bdf8",
  partner: "#f59e0b",
  area: "#22c55e",
  position: "#e11d48",
  muted: "#94a3b8",
};

export function CopMap({ items, styleUrl, attribution, className, onPickPoint, picking }: CopMapProps) {
  const holder = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<unknown>(null);
  const pickRef = useRef(onPickPoint);
  pickRef.current = onPickPoint;

  const collection = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: items
        .filter((i) => i.geometry)
        .map((i) => ({
          type: "Feature" as const,
          id: i.id,
          properties: { label: i.label, color: TONE[i.tone], detail: i.detail ?? "" },
          geometry: i.geometry as Geometry,
        })),
    }),
    [items],
  );

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
        center: [-73.7562, 42.6526], // Albany, NY — the demo agencies' area
        zoom: 11,
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
      });
      m.on("click", (event) => {
        pickRef.current?.([event.lngLat.lng, event.lngLat.lat]);
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
      <div
        ref={holder}
        className="h-full w-full"
        style={{ cursor: picking ? "crosshair" : undefined }}
        role="application"
        aria-label="Common operating picture map"
      />
      {attribution ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">{attribution}</p>
      ) : null}
    </div>
  );
}

export default CopMap;
