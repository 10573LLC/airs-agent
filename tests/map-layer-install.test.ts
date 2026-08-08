import { describe, expect, it } from "vitest";
import {
  COP_INTERACTIVE_LAYER_IDS,
  existingLayers,
  installCopLayers,
  safeQuery,
  type MinimalMap,
} from "../src/components/map/layer-install";

function fakeMap() {
  const layers = new Map<string, unknown>();
  const sources = new Map<string, unknown>();
  const queries: string[][] = [];
  const map: MinimalMap & { layers: typeof layers; sources: typeof sources; queries: string[][] } = {
    layers,
    sources,
    queries,
    getLayer: (id) => layers.get(id),
    getSource: (id) => sources.get(id),
    addSource: (id, spec) => {
      if (sources.has(id)) throw new Error(`duplicate source ${id}`);
      sources.set(id, spec);
    },
    addLayer: (spec) => {
      if (layers.has(spec.id)) throw new Error(`duplicate layer ${spec.id}`);
      layers.set(spec.id, spec);
    },
    queryRenderedFeatures: (_point, options) => {
      queries.push(options.layers);
      for (const id of options.layers) {
        if (!layers.has(id)) {
          throw new Error(
            `The layer '${id}' does not exist in the map's style and cannot be queried for features.`,
          );
        }
      }
      return [{ properties: { label: "hit" } }];
    },
  };
  return map;
}

describe("COP layer installation", () => {
  it("adds the overlay source and layers once, even if style events repeat", () => {
    const map = fakeMap();
    installCopLayers(map, { type: "FeatureCollection", features: [] }, null, "#a855f7");
    expect(() =>
      installCopLayers(map, { type: "FeatureCollection", features: [] }, null, "#a855f7"),
    ).not.toThrow();
    expect([...map.sources.keys()].sort()).toEqual(["cop", "working-point"]);
    expect([...map.layers.keys()].sort()).toEqual([
      "cop-fill",
      "cop-label",
      "cop-outline",
      "cop-point",
      "working-point-dot",
      "working-point-halo",
    ]);
  });
});

describe("safe layer querying", () => {
  it("mousemove before COP layers exist does not throw and reports no hit", () => {
    const map = fakeMap();
    expect(safeQuery(map, { x: 1, y: 1 }, COP_INTERACTIVE_LAYER_IDS)).toEqual([]);
    expect(map.queries).toEqual([]);
  });

  it("click before COP layers exist does not throw", () => {
    const map = fakeMap();
    expect(() => safeQuery(map, { x: 2, y: 2 }, COP_INTERACTIVE_LAYER_IDS)[0]).not.toThrow();
  });

  it("passes only existing layer IDs to queryRenderedFeatures", () => {
    const map = fakeMap();
    map.addLayer({ id: "cop-point", type: "circle" });
    const hit = safeQuery(map, { x: 3, y: 3 }, COP_INTERACTIVE_LAYER_IDS);
    expect(map.queries).toEqual([["cop-point"]]);
    expect(hit).toHaveLength(1);
  });

  it("queries every overlay layer once installed", () => {
    const map = fakeMap();
    installCopLayers(map, { type: "FeatureCollection", features: [] }, null, "#a855f7");
    safeQuery(map, { x: 4, y: 4 }, COP_INTERACTIVE_LAYER_IDS);
    expect(map.queries).toEqual([["cop-fill", "cop-outline", "cop-point"]]);
  });

  it("existingLayers tolerates a map that throws on getLayer", () => {
    const throwing = {
      getLayer: () => {
        throw new Error("style not loaded");
      },
    };
    expect(existingLayers(throwing, COP_INTERACTIVE_LAYER_IDS)).toEqual([]);
  });
});
