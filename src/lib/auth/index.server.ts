// Authentication adapter registry. AUTH_DRIVER selects the implementation;
// application code only ever sees the AuthAdapter contract, so replacing the
// shipped `local` driver with an OIDC driver is a one-case change here.
import { createLocalAuthAdapter } from "./local-adapter.server";
import { createOidcAuthAdapter } from "./oidc-adapter.server";
import { authDriver } from "./oidc-config.server";
import type { AuthAdapter } from "./types";

let adapter: AuthAdapter | undefined;

export function getAuthAdapter(): AuthAdapter {
  if (adapter) return adapter;
  const driver = authDriver();
  switch (driver) {
    case "local":
      adapter = createLocalAuthAdapter();
      return adapter;
    case "oidc":
      adapter = createOidcAuthAdapter();
      return adapter;
    default:
      throw new Error(`Unsupported AUTH_DRIVER: ${driver}`);
  }
}

/** Test seam: drops the cached adapter so a new environment takes effect. */
export function resetAuthAdapter(): void {
  adapter = undefined;
}
