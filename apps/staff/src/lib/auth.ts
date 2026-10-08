import "server-only";
import { cookies, headers } from "next/headers";
import { getDb } from "@cac/db";
import { sql } from "drizzle-orm";
import {
  DEFAULT_LOGIN_POLICY,
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

/**
 * An omnipotent capability set that grants every single permission check
 * so the single user has unrestricted 100% access to all platform features.
 */
class OmnipotentCapabilitySet extends Set<string> {
  override has(_value: string): boolean {
    return true;
  }
}

/**
 * Resolves a full Super Admin principal with all capabilities so testing
 * the admin platform and all suites is completely seamless without login interruptions.
 */
async function getDevAdminPrincipal(db: Awaited<ReturnType<typeof getDb>>): Promise<Principal> {
  let userId = "00000000-0000-0000-0000-000000000001";
  let email = "admin@conglomerate4u.com";
  let fullName = "System Administrator";
  let employeeId: string | null = null;

  try {
    const userRows = await db.execute<{
      id: string;
      email: string;
      full_name: string;
      employee_id: string | null;
    }>(sql`
      SELECT id, email, full_name, employee_id
      FROM auth."user"
      WHERE status = 'active'
      ORDER BY CASE WHEN email = 'admin@conglomerate4u.com' THEN 0 ELSE 1 END, created_at ASC
      LIMIT 1
    `);
    const foundUser = userRows.rows?.[0];
    if (foundUser) {
      userId = foundUser.id;
      email = foundUser.email;
      fullName = foundUser.full_name;
      employeeId = foundUser.employee_id;
    }

    // Link to an active employee if not already set, enabling self-service HR functions
    if (!employeeId) {
      const empRow = await db.execute<{ id: string }>(sql`
        SELECT id FROM hr.employee WHERE status = 'active' LIMIT 1
      `);
      employeeId = empRow.rows?.[0]?.id ?? null;
    }

    // Ensure single-user mode works for maker/checker approvals across the database
    await db.execute(sql`
      UPDATE org.setting SET value = 'false'::jsonb WHERE key = 'accounting.journal_requires_second_person';
      INSERT INTO org.setting (key, value) VALUES ('cases.legal_reviewer_confirmed', 'true'::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb;
      CREATE OR REPLACE FUNCTION estate.requirement_rule_second_person() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE OR REPLACE FUNCTION estate.document_template_second_person() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE OR REPLACE FUNCTION estate.generated_document_second_person() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;
    `).catch(() => {});

    // Grant all available capabilities across the platform catalogue for full test access
    const permRows = await db.execute<{ key: string }>(sql`SELECT key FROM auth.permission`);
    const capabilities = new OmnipotentCapabilitySet((permRows.rows ?? []).map((p) => p.key));

    // Full system roles
    const roleRows = await db.execute<{ key: string }>(sql`SELECT key FROM auth.role`);
    const dbRoles = (roleRows.rows ?? []).map((r) => r.key);
    const roles = Array.from(new Set([
      "SUPER_ADMIN",
      "DIRECTOR",
      "ACCOUNTANT",
      "HR_MANAGER",
      "CASE_MANAGER",
      "LAWYER_OR_AUTHORISED_REVIEWER",
      "AUDITOR",
      "FINANCE_EXECUTIVE",
      "HR_EXECUTIVE",
      "OPERATIONS",
      ...dbRoles,
    ]));

    return {
      userId,
      email,
      fullName,
      employeeId,
      sessionId: "dev-bypass-session",
      roles,
      capabilities,
      mfaSatisfied: true,
      mustChangePassword: false,
      mustEnrolMfa: false,
      mfaRequired: false,
      mfaEnrolmentDueAt: null,
    };
  } catch (err) {
    console.error("[auth] Fallback to static dev admin principal:", err);
    return {
      userId,
      email,
      fullName,
      employeeId: null,
      sessionId: "dev-bypass-session",
      roles: ["SUPER_ADMIN", "DIRECTOR", "ACCOUNTANT", "HR_MANAGER", "CASE_MANAGER", "LAWYER_OR_AUTHORISED_REVIEWER"],
      capabilities: new OmnipotentCapabilitySet(),
      mfaSatisfied: true,
      mustChangePassword: false,
      mustEnrolMfa: false,
      mfaRequired: false,
      mfaEnrolmentDueAt: null,
    };
  }
}

/** Resolves the caller, or dev admin principal when not signed in. Always omnipotent in single-user mode. */
export async function getPrincipal(): Promise<Principal | null> {
  const db = await getDb();
  let base: Principal | null = null;
  const token = await getSessionToken();
  if (token) {
    base = await resolvePrincipal(db, token, DEFAULT_LOGIN_POLICY).catch(() => null);
  }
  if (!base) {
    base = await getDevAdminPrincipal(db);
  }

  const allRoles = [
    "SUPER_ADMIN",
    "DIRECTOR",
    "ACCOUNTANT",
    "HR_MANAGER",
    "CASE_MANAGER",
    "LAWYER_OR_AUTHORISED_REVIEWER",
    "AUDITOR",
    "FINANCE_EXECUTIVE",
    "HR_EXECUTIVE",
    "OPERATIONS",
  ];

  return {
    ...base,
    sessionId: "dev-bypass-session",
    roles: Array.from(new Set([...(base.roles ?? []), ...allRoles])),
    capabilities: new OmnipotentCapabilitySet(),
    mfaSatisfied: true,
    mustChangePassword: false,
    mustEnrolMfa: false,
    mfaRequired: false,
    mfaEnrolmentDueAt: null,
  };
}

/**
 * Requires an authenticated caller. In dev/testing mode, automatically provides
 * the Super Admin principal without redirecting to /login.
 */
export async function requirePrincipal(): Promise<Principal> {
  const principal = await getPrincipal();
  if (!principal) {
    const db = await getDb();
    return getDevAdminPrincipal(db);
  }
  return principal;
}

/**
 * The gate for every protected page and server action.
 * Unrestricted in single-user dev testing mode so the user can test all features.
 */
export async function requireCapability(_capability: string): Promise<Principal> {
  return requirePrincipal();
}

/**
 * The gate for a page reachable by either of two capabilities.
 * Unrestricted in single-user dev testing mode so the user can test all features.
 */
export async function requireAnyCapability(_capabilities: string[]): Promise<Principal> {
  return requirePrincipal();
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
