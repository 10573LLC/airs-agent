// Style-timing-safe helpers for the Common Operating Picture renderer.
//
// These are deliberately free of React and MapLibre imports: they operate on the
// minimal structural interface below so they can be unit-tested without a DOM.
// They never invent geography — they only install/query layers for data the
// server already released.

export interface MinimalMap {
  getLayer(id: string): unknown;
  getSource(id: string): unknown;
  addSource(id: string, spec: unknown): void;
  addLayer(spec: { id: string } & Record<string, unknown>): void;
  queryRenderedFeatures(
    point: unknown,
    options: { layers: string[] },
  ): Array<{ properties?: Record<string, unknown> | null }>;
}

/** Layer IDs drawn from the released AIRS overlay source. */
export const COP_LAYER_IDS = ["cop-fill", "cop-outline", "cop-point", "cop-label"] as const;
/** Overlay layers that are hover/click interactive (labels are not queried). */
export const COP_INTERACTIVE_LAYER_IDS = ["cop-fill", "cop-outline", "cop-point"] as const;
export const WORKING_POINT_LAYER_IDS = ["working-point-halo", "working-point-dot"] as const;

/** Keeps only the layer IDs that currently exist in the map's style. */
export function existingLayers(map: Pick<MinimalMap, "getLayer">, ids: readonly string[]): string[] {
  return ids.filter((id) => {
    try {
      return Boolean(map.getLayer(id));
    } catch {
      return false;
    }
  });
}

/**
 * queryRenderedFeatures, but never with a layer ID the style does not have.
 * Returns [] when no overlay layer exists yet, instead of throwing.
 */
export function safeQuery(
  map: Pick<MinimalMap, "getLayer" | "queryRenderedFeatures">,
  point: unknown,
  ids: readonly string[],
): Array<{ properties?: Record<string, unknown> | null }> {
  const layers = existingLayers(map, ids);
  if (layers.length === 0) return [];
  return map.queryRenderedFeatures(point, { layers });
}

function ensureSource(map: MinimalMap, id: string, spec: unknown) {
  if (map.getSource(id)) return;
  map.addSource(id, spec);
}

function ensureLayer(map: MinimalMap, spec: { id: string } & Record<string, unknown>) {
  if (map.getLayer(spec.id)) return;
  map.addLayer(spec);
}

/**
 * Installs the AIRS overlay source and layers. Idempotent: safe to call on every
 * `load`/`styledata` event without duplicating sources or layers.
 */
export function installCopLayers(map: MinimalMap, data: unknown, workingData: unknown, workingColor: string) {
  ensureSource(map, "cop", { type: "geojson", data });
  ensureLayer(map, {
    id: "cop-fill",
    type: "fill",
    source: "cop",
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "fill-color": ["get", "color"], "fill-opacity": 0.18 },
  });
  ensureLayer(map, {
    id: "cop-outline",
    type: "line",
    source: "cop",
    filter: ["!=", ["geometry-type"], "Point"],
    paint: { "line-color": ["get", "color"], "line-width": 2 },
  });
  ensureLayer(map, {
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
  ensureLayer(map, {
    id: "cop-label",
    type: "symbol",
    source: "cop",
    layout: {
      "text-field": ["get", "label"],
      "text-size": 14,
      "text-offset": [0, 1.25],
      "text-anchor": "top",
    },
    paint: { "text-color": "#111827", "text-halo-color": "#ffffff", "text-halo-width": 2.2, "text-halo-blur": 0.4 },
  });

  ensureSource(map, "working-point", { type: "geojson", data: workingData });
  ensureLayer(map, {
    id: "working-point-halo",
    type: "circle",
    source: "working-point",
    paint: { "circle-radius": 13, "circle-color": workingColor, "circle-opacity": 0.2 },
  });
  ensureLayer(map, {
    id: "working-point-dot",
    type: "circle",
    source: "working-point",
    paint: {
      "circle-radius": 6,
      "circle-color": workingColor,
      "circle-stroke-width": 2,
      "circle-stroke-color": "#f8fafc",
    },
  });
}
