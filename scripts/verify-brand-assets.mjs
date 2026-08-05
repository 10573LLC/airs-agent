#!/usr/bin/env node
/**
 * Brand asset integrity check.
 *
 * Fails the build/CI if a required brand file is missing, if a master that must
 * be transparent lost its alpha channel, or if the manifest references an icon
 * that is not on disk. Pure Node — no image library, it reads the PNG header.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const brandDir = path.join(root, "public", "brand", "airs-agent");

const REQUIRED_TRANSPARENT = [
  "airs-agent-emblem-transparent.png",
  "airs-agent-horizontal-transparent.png",
  "airs-agent-emblem-16.png",
  "airs-agent-emblem-32.png",
  "airs-agent-emblem-64.png",
  "airs-agent-emblem-180.png",
  "airs-agent-emblem-192.png",
  "airs-agent-emblem-256.png",
  "airs-agent-emblem-512.png",
  "airs-agent-emblem-1024.png",
];

const REQUIRED_PUBLIC = [
  "favicon.ico",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "apple-touch-icon.png",
  "android-chrome-192x192.png",
  "android-chrome-512x512.png",
  "site.webmanifest",
];

const failures = [];

/** PNG IHDR colour type: 4 (grey+alpha) or 6 (RGBA) means an alpha channel. */
async function hasAlpha(file) {
  const buf = await readFile(file);
  const isPng = buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!isPng) return null;
  return buf[25] === 4 || buf[25] === 6;
}

for (const name of REQUIRED_TRANSPARENT) {
  const file = path.join(brandDir, name);
  try {
    await stat(file);
  } catch {
    failures.push(`missing brand master: public/brand/airs-agent/${name}`);
    continue;
  }
  const alpha = await hasAlpha(file);
  if (alpha === false) failures.push(`${name} has no alpha channel (must stay transparent)`);
}

for (const name of REQUIRED_PUBLIC) {
  try {
    await stat(path.join(root, "public", name));
  } catch {
    failures.push(`missing web icon: public/${name}`);
  }
}

const manifest = JSON.parse(await readFile(path.join(root, "public", "site.webmanifest"), "utf8"));
for (const icon of manifest.icons ?? []) {
  try {
    await stat(path.join(root, "public", icon.src.replace(/^\//, "")));
  } catch {
    failures.push(`site.webmanifest references a missing icon: ${icon.src}`);
  }
}

if (failures.length) {
  console.error("Brand asset verification FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(
  `Brand asset verification OK — ${REQUIRED_TRANSPARENT.length} transparent masters, ` +
    `${REQUIRED_PUBLIC.length} web icons, ${(manifest.icons ?? []).length} manifest icons.`,
);
