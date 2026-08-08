import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync("Dockerfile", "utf8");
const compose = readFileSync("docker-compose.yml", "utf8");

const SECRETS = [
  "POSTGRES_PASSWORD",
  "APP_DB_PASSWORD",
  "MAINTENANCE_DB_PASSWORD",
  "SESSION_SECRET",
  "DATABASE_URL",
];

describe("docker build-time map configuration", () => {
  it("declares only the two map build args", () => {
    const args = [...dockerfile.matchAll(/^ARG\s+([A-Z0-9_]+)/gm)].map((m) => m[1]);
    expect(args.sort()).toEqual(["VITE_MAP_ATTRIBUTION", "VITE_MAP_STYLE_URL"]);
  });

  it("exposes the map args as ENV before the build step", () => {
    const envIndex = dockerfile.indexOf("ENV VITE_MAP_STYLE_URL");
    const buildIndex = dockerfile.indexOf("RUN npm run build");
    expect(envIndex).toBeGreaterThan(-1);
    expect(dockerfile).toContain("VITE_MAP_ATTRIBUTION=$VITE_MAP_ATTRIBUTION");
    expect(envIndex).toBeLessThan(buildIndex);
  });

  it("never copies .env into the image", () => {
    expect(dockerfile).not.toMatch(/COPY[^\n]*\.env/);
    expect(readFileSync(".dockerignore", "utf8")).toMatch(/^\.env$/m);
  });

  it("passes the map args from compose without any secret", () => {
    expect(compose).toContain("VITE_MAP_STYLE_URL: ${VITE_MAP_STYLE_URL:-}");
    expect(compose).toContain("VITE_MAP_ATTRIBUTION: ${VITE_MAP_ATTRIBUTION:-}");
    const argsBlock = compose.slice(compose.indexOf("args:"), compose.indexOf("depends_on:"));
    for (const secret of SECRETS) expect(argsBlock).not.toContain(secret);
    for (const secret of SECRETS) expect(dockerfile).not.toContain(secret);
  });
});
