export function authDriver(): "local" | "oidc" {
  const value = process.env.AUTH_DRIVER;
  if (value === "oidc" || value === "local") return value;
  if (!value && process.env.NODE_ENV !== "production") return "local";
  throw new Error("AUTH_DRIVER must explicitly be local or oidc");
}

export function oidcConfig() {
  if (authDriver() !== "oidc") throw new Error("OIDC is not enabled");
  const required = (name: string) => {
    const value = process.env[name];
    if (!value || value.includes("CHANGE_ME") || value.includes("<")) {
      throw new Error(`Missing ${name}`);
    }
    return value;
  };
  const issuer = required("OIDC_ISSUER");
  // This driver deliberately supports Cognito user pools, not arbitrary providers.
  if (!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/.test(issuer)) {
    throw new Error("OIDC_ISSUER must be a Cognito user pool issuer");
  }
  const domain = new URL(required("OIDC_DOMAIN"));
  const origin = new URL(required("AIRS_PUBLIC_BASE_URL"));
  for (const url of [domain, origin]) {
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("OIDC domain and public base URL must be HTTPS origins");
    }
  }
  const secret = required("SESSION_SECRET");
  if (secret.length < 32) throw new Error("SESSION_SECRET must have at least 32 characters");
  return {
    issuer,
    domain: domain.origin,
    origin: origin.origin,
    clientId: required("OIDC_CLIENT_ID"),
    clientSecret: required("OIDC_CLIENT_SECRET"),
    secret,
    redirectUri: `${origin.origin}/auth/callback`,
  };
}

/** A conservative path allowlist also rejects encoded slashes and backslashes. */
export function safeReturnPath(value: unknown): string {
  return typeof value === "string" &&
    /^\/[A-Za-z0-9/_.~$-]*$/.test(value) &&
    !/[\r\n]/.test(value) &&
    !value.startsWith("//") &&
    !value.startsWith("/auth")
    ? value
    : "/console";
}

export function cognitoLogoutUrl(): string {
  const config = oidcConfig();
  const url = new URL("/logout", config.domain);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("logout_uri", `${config.origin}/auth`);
  return url.href;
}
