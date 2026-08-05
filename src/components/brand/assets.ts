/**
 * Canonical AIRS Agent brand asset registry.
 *
 * Mirrors public/brand/airs-agent/lovable-brand-map.json. Assets are served as
 * plain static files from `public/`, so nothing here depends on a bundler
 * plugin, CDN pointer or hosting provider — the paths resolve identically in
 * Docker, on a bare Node server, or behind any static host.
 */
export const BRAND_FOLDER = "/brand/airs-agent" as const;

export const BRAND = {
  name: "AIRS Agent",
  tagline: "Awareness • Intelligence • Response • Security",
  /** Transparent master. Never composite it onto a baked background. */
  emblem: `${BRAND_FOLDER}/airs-agent-emblem-transparent.png`,
  horizontal: `${BRAND_FOLDER}/airs-agent-horizontal-transparent.png`,
  emblemSizes: {
    16: `${BRAND_FOLDER}/airs-agent-emblem-16.png`,
    32: `${BRAND_FOLDER}/airs-agent-emblem-32.png`,
    64: `${BRAND_FOLDER}/airs-agent-emblem-64.png`,
    180: `${BRAND_FOLDER}/airs-agent-emblem-180.png`,
    192: `${BRAND_FOLDER}/airs-agent-emblem-192.png`,
    256: `${BRAND_FOLDER}/airs-agent-emblem-256.png`,
    512: `${BRAND_FOLDER}/airs-agent-emblem-512.png`,
    1024: `${BRAND_FOLDER}/airs-agent-emblem-1024.png`,
  },
  /** Backdrop proofs shipped with the package; used by the brand contrast check. */
  tests: {
    emblemOnBlack: `${BRAND_FOLDER}/airs-agent-emblem-black-test.png`,
    emblemOnWhite: `${BRAND_FOLDER}/airs-agent-emblem-white-test.png`,
    horizontalOnBlack: `${BRAND_FOLDER}/airs-agent-horizontal-black-test.png`,
    horizontalOnWhite: `${BRAND_FOLDER}/airs-agent-horizontal-white-test.png`,
  },
  webIcons: {
    ico: "/favicon.ico",
    png16: "/favicon-16x16.png",
    png32: "/favicon-32x32.png",
    appleTouch: "/apple-touch-icon.png",
    android192: "/android-chrome-192x192.png",
    android512: "/android-chrome-512x512.png",
    manifest: "/site.webmanifest",
  },
} as const;

/** Nearest packaged raster at or above the rendered size, to avoid upscaling. */
export function emblemForSize(px: number): string {
  const sizes = [16, 32, 64, 180, 192, 256, 512, 1024] as const;
  const match = sizes.find((s) => s >= px * 2) ?? 1024;
  return BRAND.emblemSizes[match];
}
