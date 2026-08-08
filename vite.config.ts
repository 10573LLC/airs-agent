// Portable Vite configuration. No builder-specific package is imported or
// installed. The only builder awareness is a build-target switch below:
// the hosted editor deploys a Cloudflare Worker from `dist/`, while every
// other environment (local, CI, Docker) builds a plain Node server into
// `.output/`. Both paths use stock Vite / TanStack Start / Nitro plugins.
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

// The hosted editor sandbox sets these standard environment variables. They
// are absent on a developer machine, in CI and inside the Docker image, so a
// clone of this repository always takes the portable Node path.
const isEditorSandbox =
  process.env.LOVABLE_SANDBOX === "1" || !!process.env.DEV_SERVER__PROJECT_PATH;

// Deployment target for the Nitro build. Defaults to a plain Node.js server
// (`node .output/server/index.mjs`), which is what the Dockerfile runs.
// `NITRO_PRESET` still wins if it is set explicitly.
const nitroPreset =
  process.env.NITRO_PRESET ?? (isEditorSandbox ? "cloudflare-module" : "node-server");

export default defineConfig(async ({ command }) => {
  const plugins = [
    tailwindcss(),
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackStart({
      // Keep server-only modules out of the client bundle.
      importProtection: {
        behavior: "error",
        client: { files: ["**/server/**"], specifiers: ["server-only"] },
      },
      // Redirect the bundled server entry to src/server.ts (SSR error wrapper).
      server: { entry: "server" },
    }),
    viteReact(),
  ];

  if (command === "build") {
    const { nitro } = await import("nitro/vite");
    plugins.splice(
      3,
      0,
      nitro(
        nitroPreset === "cloudflare-module"
          ? {
              preset: "cloudflare-module",
              // Worker artifact layout expected by the hosted deploy step.
              output: { dir: "dist", serverDir: "dist/server", publicDir: "dist/client" },
              cloudflare: { nodeCompat: true, deployConfig: true },
            }
          : { preset: nitroPreset },
      ),
    );
  }

  return {
    server: { host: "::", port: 8080 },
    resolve: {
      alias: { "@": srcDir },
      dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    },
    // MapLibre spawns its tile-parsing worker with
    // `new Worker(new URL("./maplibre-gl-worker.mjs", import.meta.url))`.
    // Dependency pre-bundling rewrites that URL to a path Vite never emits, so
    // the worker 404s, no tile requests are ever scheduled and the basemap
    // stays blank. Excluding the package keeps the worker URL resolvable.
    optimizeDeps: { exclude: ["maplibre-gl"] },
    plugins,
  };
});
