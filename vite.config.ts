// Portable Vite configuration. No builder-specific packages, plugins or
// environment variables are required to build or run this application.
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

// Deployment target for the Nitro build. Defaults to a plain Node.js server
// (`node .output/server/index.mjs`), which is what the Dockerfile runs.
const nitroPreset = process.env.NITRO_PRESET ?? "node-server";

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
    plugins.splice(3, 0, nitro({ preset: nitroPreset }));
  }

  return {
    server: { host: "::", port: 8080 },
    resolve: {
      alias: { "@": srcDir },
      dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    },
    plugins,
  };
});
