import { getDatabase } from "./adapters/index.server";
import { authDriver, oidcConfig } from "./auth/oidc-config.server";

export async function checkReadiness(): Promise<void> {
  if (authDriver() === "oidc") oidcConfig();
  await getDatabase().withContext({}, async (q) => {
    const roles = await q.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    if (
      !roles[0] ||
      roles[0].rolsuper ||
      roles[0].rolbypassrls ||
      roles[0].rolname !== "airs_app"
    ) {
      throw new Error("Runtime must use the unprivileged airs_app role");
    }
    // These zero-row queries verify the deployed schema and runtime grants,
    // including the latest migration, without reading agency records.
    await q.query("SELECT id, external_issuer, external_subject FROM airs.accounts LIMIT 0");
    await q.query("SELECT token_hash FROM airs.sessions LIMIT 0");
    await q.query("SELECT information_path FROM airs.incident_coordination_partners LIMIT 0");
  });
}
