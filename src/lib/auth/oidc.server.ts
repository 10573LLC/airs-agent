import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, EncryptJWT, jwtDecrypt, jwtVerify } from "jose";
import { oidcConfig, safeReturnPath } from "./oidc-config.server";

const FLOW_SECONDS = 600;
const random = () => randomBytes(32).toString("base64url");
const key = (secret: string) => createHash("sha256").update(secret).digest();
const equal = (a: unknown, b: string): boolean =>
  typeof a === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function startOidc(returnTo: unknown) {
  const config = oidcConfig();
  const state = random();
  const nonce = random();
  const verifier = random();
  // Encrypted, authenticated and short-lived; no OAuth token ever reaches JS.
  const cookie = await new EncryptJWT({
    state,
    nonce,
    verifier,
    returnTo: safeReturnPath(returnTo),
  })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuer(config.origin)
    .setAudience(config.clientId)
    .setIssuedAt()
    .setExpirationTime(`${FLOW_SECONDS}s`)
    .encrypt(key(config.secret));
  const url = new URL("/oauth2/authorize", config.domain);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: "openid email",
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    prompt: "login",
  }).toString();
  return { cookie, location: url.href, maxAge: FLOW_SECONDS };
}

export async function readOidcFlow(cookie: string, state: string) {
  const config = oidcConfig();
  const { payload } = await jwtDecrypt(cookie, key(config.secret), {
    issuer: config.origin,
    audience: config.clientId,
    keyManagementAlgorithms: ["dir"],
    contentEncryptionAlgorithms: ["A256GCM"],
    requiredClaims: ["exp", "iat"],
    maxTokenAge: "10m",
  });
  if (
    !equal(payload.state, state) ||
    typeof payload.nonce !== "string" ||
    typeof payload.verifier !== "string"
  )
    throw new Error("Invalid sign-in transaction");
  return {
    nonce: payload.nonce,
    verifier: payload.verifier,
    returnTo: safeReturnPath(payload.returnTo),
  };
}

export async function verifyCognitoIdToken(
  token: string,
  nonce: string,
  verificationKey?: Parameters<typeof jwtVerify>[1],
) {
  const config = oidcConfig();
  let jwks = jwksCache.get(config.issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${config.issuer}/.well-known/jwks.json`), {
      timeoutDuration: 5000,
    });
    jwksCache.set(config.issuer, jwks);
  }
  const { payload } = await jwtVerify(token, verificationKey ?? jwks, {
    issuer: config.issuer,
    audience: config.clientId,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "iat", "sub", "auth_time"],
    maxTokenAge: "10m",
  });
  if (
    payload.token_use !== "id" ||
    payload.email_verified !== true ||
    !equal(payload.nonce, nonce) ||
    typeof payload.email !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) ||
    payload.email.length > 320 ||
    !payload.sub ||
    typeof payload.auth_time !== "number" ||
    payload.auth_time < Date.now() / 1000 - FLOW_SECONDS ||
    payload.auth_time > Date.now() / 1000 + 30
  ) {
    throw new Error("Invalid Cognito identity");
  }
  return {
    issuer: config.issuer,
    subject: payload.sub,
    email: payload.email.toLowerCase(),
    displayName: typeof payload.name === "string" ? payload.name.slice(0, 120) : payload.email,
    // No refresh token retention: reauthenticate when the ID token expires.
    expiresAt: new Date(Math.min(payload.exp! * 1000, Date.now() + 3600_000)).toISOString(),
  };
}

export async function finishOidc(cookie: string, state: string, code: string) {
  if (!cookie || !state || !code || code.length > 4096)
    throw new Error("Missing sign-in transaction");
  const config = oidcConfig();
  const flow = await readOidcFlow(cookie, state);
  const response = await fetch(`${config.domain}/oauth2/token`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code,
      code_verifier: flow.verifier,
    }),
  });
  if (!response.ok) throw new Error("Cognito token exchange failed");
  const tokens = await response.json();
  if (typeof tokens.id_token !== "string") throw new Error("Missing ID token");
  return {
    identity: await verifyCognitoIdToken(tokens.id_token, flow.nonce),
    returnTo: flow.returnTo,
  };
}
