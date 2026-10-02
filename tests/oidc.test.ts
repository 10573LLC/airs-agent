import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { authDriver, oidcConfig, safeReturnPath } from "@/lib/auth/oidc-config.server";
import { finishOidc, readOidcFlow, startOidc, verifyCognitoIdToken } from "@/lib/auth/oidc.server";

const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test";
beforeEach(() => {
  vi.stubEnv("AUTH_DRIVER", "oidc");
  vi.stubEnv("OIDC_ISSUER", issuer);
  vi.stubEnv("OIDC_DOMAIN", "https://test.auth.us-east-1.amazoncognito.com");
  vi.stubEnv("AIRS_PUBLIC_BASE_URL", "https://app.example.test");
  vi.stubEnv("OIDC_CLIENT_ID", "test-client");
  vi.stubEnv("OIDC_CLIENT_SECRET", "test-secret");
  vi.stubEnv("SESSION_SECRET", "test-only-cookie-key-32-characters-long");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Cognito transaction protection", () => {
  it("requires an explicit production authentication driver and valid HTTPS configuration", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_DRIVER", "");
    expect(authDriver).toThrow();
    vi.stubEnv("AUTH_DRIVER", "oidc");
    vi.stubEnv("AIRS_PUBLIC_BASE_URL", "http://example.test");
    expect(oidcConfig).toThrow();
  });
  it.each([
    "//evil.test",
    "https://evil.test",
    "/%2f/evil.test",
    "/\\evil.test",
    "/auth/callback",
    "/x\n",
  ])("rejects redirect %s", (value) => {
    expect(safeReturnPath(value)).toBe("/console");
  });
  it("keeps invite redirects in encrypted state with PKCE and a fresh nonce", async () => {
    const first = await startOidc("/invite/abc-123");
    const second = await startOidc("/console");
    const url = new URL(first.location);
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("state")).not.toBe(
      new URL(second.location).searchParams.get("state"),
    );
    const flow = await readOidcFlow(first.cookie, url.searchParams.get("state")!);
    expect(flow.returnTo).toBe("/invite/abc-123");
    expect(first.cookie).not.toContain(flow.verifier);
    await expect(readOidcFlow(first.cookie, "incorrect")).rejects.toThrow();
    await expect(
      readOidcFlow(
        `${first.cookie.slice(0, 30)}x${first.cookie.slice(31)}`,
        url.searchParams.get("state")!,
      ),
    ).rejects.toThrow();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 601_000);
    await expect(readOidcFlow(first.cookie, url.searchParams.get("state")!)).rejects.toThrow();
  });
  it("never sends an invalid transaction to Cognito", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(finishOidc("bad", "bad", "code")).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("sends the matching verifier and fails closed on provider errors", async () => {
    const flow = await startOidc("/console");
    const state = new URL(flow.location).searchParams.get("state")!;
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("private error details", { status: 400 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(finishOidc(flow.cookie, state, "test-code")).rejects.toThrow(
      "Cognito token exchange failed",
    );
    const body = fetcher.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("code_verifier")).toBe((await readOidcFlow(flow.cookie, state)).verifier);
    expect(body.get("redirect_uri")).toBe("https://app.example.test/auth/callback");
  });
});

describe("Cognito ID token validation", () => {
  const keys = generateKeyPair("RS256");
  async function token(overrides: Record<string, unknown> = {}) {
    return new SignJWT({
      sub: "immutable-subject",
      email: "admin@example.test",
      email_verified: true,
      nonce: "expected-nonce",
      token_use: "id",
      auth_time: Math.floor(Date.now() / 1000),
      ...overrides,
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(issuer)
      .setAudience("test-client")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign((await keys).privateKey);
  }
  it("accepts only a signed verified identity and bounds session lifetime", async () => {
    const identity = await verifyCognitoIdToken(
      await token(),
      "expected-nonce",
      (await keys).publicKey,
    );
    expect(identity.subject).toBe("immutable-subject");
    expect(Date.parse(identity.expiresAt)).toBeLessThanOrEqual(Date.now() + 3600_000);
  });
  it.each([
    { email_verified: false },
    { email_verified: "true" },
    { nonce: "wrong" },
    { token_use: "access" },
    { auth_time: 0 },
    { email: "invalid" },
    { sub: "" },
  ])("rejects invalid claims %j", async (claims) => {
    await expect(
      verifyCognitoIdToken(await token(claims), "expected-nonce", (await keys).publicKey),
    ).rejects.toThrow();
  });
  it("rejects foreign keys, issuer, audience and expiry", async () => {
    const jwt = await token();
    await expect(
      verifyCognitoIdToken(jwt, "expected-nonce", (await generateKeyPair("RS256")).publicKey),
    ).rejects.toThrow();
    vi.stubEnv("OIDC_CLIENT_ID", "other-client");
    await expect(
      verifyCognitoIdToken(jwt, "expected-nonce", (await keys).publicKey),
    ).rejects.toThrow();
    vi.stubEnv("OIDC_CLIENT_ID", "test-client");
    vi.stubEnv("OIDC_ISSUER", `${issuer}other`);
    await expect(
      verifyCognitoIdToken(jwt, "expected-nonce", (await keys).publicKey),
    ).rejects.toThrow();
    vi.stubEnv("OIDC_ISSUER", issuer);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3601_000);
    await expect(
      verifyCognitoIdToken(jwt, "expected-nonce", (await keys).publicKey),
    ).rejects.toThrow();
  });
});
