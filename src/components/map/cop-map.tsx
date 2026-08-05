// Portable MapLibre GL JS renderer.
//
// MapLibre is BSD-licensed and self-hostable; nothing here depends on a hosted
// map service. The basemap style URL is a prop with a plain raster fallback, so
// an operator can point it at an internal tile server and the component keeps
// working offline-by-configuration.
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
  /** Override for an internal/offline tile server. */
  styleUrl?: string;
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

/** Raster fallback style: no API key, no vendor SDK, swappable for local tiles. */
function fallbackStyle(): Record<string, unknown> {
  return {
    version: 8,
    sources: {
      base: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors",
      },
    },
    layers: [{ id: "base", type: "raster", source: "base" }],
  };
}

export function CopMap({ items, styleUrl, className, onPickPoint, picking }: CopMapProps) {
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
    let disposed = false;
    let map: import("maplibre-gl").Map | null = null;
    (async () => {
      const maplibre = (await import("maplibre-gl")).default;
      await import("maplibre-gl/dist/maplibre-gl.css");
      if (disposed || !holder.current) return;
      map = new maplibre.Map({
        container: holder.current,
        style: (styleUrl ?? fallbackStyle()) as never,
        center: [-73.7562, 42.6526], // Albany, NY — the demo agencies' area
        zoom: 11,
        attributionControl: { compact: true },
      });
      map.addControl(new maplibre.NavigationControl({ visualizePitch: false }), "top-right");
      map.addControl(new maplibre.ScaleControl({ unit: "imperial" }), "bottom-left");
      map.on("load", () => {
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
      map.on("click", (event) => {
        pickRef.current?.([event.lngLat.lng, event.lngLat.lat]);
      });
      mapRef.current = map;
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

  return (
    <div
      ref={holder}
      className={className}
      style={{ cursor: picking ? "crosshair" : undefined }}
      role="application"
      aria-label="Common operating picture map"
    />
  );
}

export default CopMap;
