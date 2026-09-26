import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@cac/db";
import {
  AuthenticationError,
  AuthorizationError,
  DEFAULT_LOGIN_POLICY,
  requireCapability as assertCapability,
  resolvePrincipal,
  type Principal,
} from "@cac/core";

/**
 * Server-side session plumbing.
 *
 * Everything here is `server-only`, so a stray import into a client component
 * is a build error rather than a session token shipped to the browser.
 */

export const SESSION_COOKIE = "cac_session";

export async function setSessionCookie(token: string, absoluteHours: number): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true, // unreadable from JavaScript, so XSS cannot lift it
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax", // survives top-level navigation from the public site
    path: "/",
    maxAge: absoluteHours * 3600,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function getSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

/** Resolves the caller, or null when not signed in. Never throws. */
export async function getPrincipal(): Promise<Principal | null> {
  const token = await getSessionToken();
  if (!token) return null;
  const db = await getDb();
  return resolvePrincipal(db, token, DEFAULT_LOGIN_POLICY);
}

/**
 * Requires a fully authenticated caller.
 *
 * A session that has not completed MFA is sent to the challenge rather than
 * the login form: the password step already succeeded, and bouncing them back
 * to the start would be both confusing and slower.
 */
export async function requirePrincipal(): Promise<Principal> {
  const principal = await getPrincipal();
  if (!principal) redirect("/login");
  if (!principal.mfaSatisfied) redirect("/login/mfa");
  return principal;
}

/**
 * The gate for every protected page and server action.
 *
 * This runs on the server before any data is read, which is what actually
 * protects the route. Hiding a menu item is presentation, not security.
 */
export async function requireCapability(capability: string): Promise<Principal> {
  const principal = await requirePrincipal();

  // A password an administrator generated is a password somebody else has seen.
  // Nothing else in the platform opens until it has been replaced; /account is
  // reached through requirePrincipal, so it stays available.
  if (principal.mustChangePassword) redirect("/account?change-password=1");

  // And an account required to hold an authenticator does not work until it holds one. The flag was
  // set on the user screen, shown on /account, and enforced nowhere at all — the account signed in
  // with a password alone and reached everything. /account stays reachable so it can be enrolled.
  if (principal.mustEnrolMfa) redirect("/account?enrol-mfa=1");

  try {
    assertCapability(principal, capability);
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof AuthenticationError) {
      redirect(`/denied?capability=${encodeURIComponent(capability)}`);
    }
    throw error;
  }
  return principal;
}

/**
 * The gate for a page reachable by either of two capabilities.
 *
 * Cases need this: `case.view` means the matters somebody is assigned to and
 * `case.view_all` means all of them, and a role may hold one without the other —
 * SUPER_ADMIN holds only `case.view_all`. Gating on one of them alone would send
 * somebody who is entitled to the page to /denied.
 */
export async function requireAnyCapability(capabilities: string[]): Promise<Principal> {
  const principal = await requirePrincipal();
  if (principal.mustChangePassword) redirect("/account?change-password=1");
  if (principal.mustEnrolMfa) redirect("/account?enrol-mfa=1");

  if (!capabilities.some((capability) => principal.capabilities.has(capability))) {
    redirect(`/denied?capability=${encodeURIComponent(capabilities[0])}`);
  }
  return principal;
}

/** Request context for audit rows. */
export async function getRequestContext(): Promise<{
  ip: string | null;
  userAgent: string | null;
  correlationId: string;
}> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  return {
    ip: forwarded?.split(",")[0]?.trim() ?? null,
    userAgent: h.get("user-agent"),
    correlationId: crypto.randomUUID(),
  };
}
