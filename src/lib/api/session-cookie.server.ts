// Session cookie policy. The cookie carries an opaque random token only; all
// session state (account, active organization, expiry, revocation) lives in
// airs.sessions and is re-read on every request.
import { getCookie, setCookie } from "@tanstack/react-start/server";

export const SESSION_COOKIE = "airs_session";

export function readSessionToken(): string | null {
  return getCookie(SESSION_COOKIE) ?? null;
}

export function writeSessionCookie(token: string, expiresAt: string): void {
  setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(): void {
  setCookie(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}