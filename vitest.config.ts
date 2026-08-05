// Test-runner configuration, deliberately separate from the application's
// vite.config.ts so the suites never load the Nitro/build plugin chain.
//
// `fileParallelism: false` is a correctness requirement, not a performance
// choice: the database-backed suites share two demo organizations, and the
// per-run fixture cleanup in tests/support/fixtures.ts restores shared rows
// (such as a trusted-agency approval) when a suite finishes. Running suite
// files concurrently would let one suite's cleanup remove a shared row another
// suite is still relying on.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": srcDir } },
  test: {
    environment: "node",
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
