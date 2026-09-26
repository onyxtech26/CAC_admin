import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { MAKER_CHECKER_PAIRS } from "@cac/db";

/**
 * Authorisation.
 *
 * Two independent checks are required for every mutation, and both run on the
 * server:
 *
 *   1. capability — may this person do this kind of thing at all?
 *   2. scope      — may they do it to *this* record?
 *
 * Hiding a button is not a check. Everything here is designed to be called
 * from the server action itself, so bypassing the UI changes nothing.
 */

export class AuthorizationError extends Error {
  readonly code = "FORBIDDEN";
  constructor(
    message: string,
    readonly capability?: string,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class AuthenticationError extends Error {
  readonly code = "UNAUTHENTICATED";
  constructor(message = "Sign in to continue.") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export interface Principal {
  userId: string;
  email: string;
  fullName: string;
  roles: string[];
  capabilities: ReadonlySet<string>;
  employeeId: string | null;
  sessionId: string;
  mfaSatisfied: boolean;
  /**
   * The password was set by an administrator and has to be replaced.
   *
   * Carried on the principal so the route guard can act on it: while it is true
   * somebody other than the account holder knows the password, and letting them
   * carry on working with it is how a handover password becomes a permanent one.
   */
  mustChangePassword: boolean;
  /**
   * The account is required to hold an authenticator and does not.
   *
   * `auth."user".mfa_enforced` was written by the user screen, displayed on /account, and enforced
   * nowhere: whether a second factor was demanded depended only on whether a device happened to be
   * enrolled, so ticking "require an authenticator app" achieved nothing and the account signed in
   * with a password alone. Carried on the principal so the route guard can act on it, exactly as it
   * acts on `mustChangePassword`: /account stays reachable so the authenticator can be enrolled, and
   * nothing else opens until it is.
   */
  mustEnrolMfa: boolean;
}

/**
 * Resolves a user's effective capabilities: the union of their roles' grants,
 * plus direct allows, minus direct denies.
 *
 * Deny wins unconditionally. That makes it possible to remove one capability
 * from one person without unpicking their roles, which is what actually
 * happens when someone changes duties.
 */
export async function resolveCapabilities(db: Executor, userId: string): Promise<Set<string>> {
  const rows = await db.execute<{ key: string; effect: string }>(sql`
    WITH role_grants AS (
      SELECT p.key, 'allow'::text AS effect
      FROM auth.user_role ur
      JOIN auth.role_permission rp ON rp.role_id = ur.role_id
      JOIN auth.permission p       ON p.id = rp.permission_id
      WHERE ur.user_id = ${userId}
    ),
    direct AS (
      SELECT p.key, up.effect
      FROM auth.user_permission up
      JOIN auth.permission p ON p.id = up.permission_id
      WHERE up.user_id = ${userId}
    )
    SELECT key, effect FROM role_grants
    UNION ALL
    SELECT key, effect FROM direct
  `);

  const allowed = new Set<string>();
  const denied = new Set<string>();
  for (const row of rows.rows ?? []) {
    if (row.effect === "deny") denied.add(row.key);
    else allowed.add(row.key);
  }
  for (const key of denied) allowed.delete(key);
  return allowed;
}

export async function resolveRoles(db: Executor, userId: string): Promise<string[]> {
  const rows = await db.execute<{ key: string }>(sql`
    SELECT r.key FROM auth.user_role ur
    JOIN auth.role r ON r.id = ur.role_id
    WHERE ur.user_id = ${userId}
    ORDER BY r.key
  `);
  return (rows.rows ?? []).map((r) => r.key);
}

export function can(principal: Principal, capability: string): boolean {
  return principal.capabilities.has(capability);
}

export function canAny(principal: Principal, capabilities: string[]): boolean {
  return capabilities.some((c) => principal.capabilities.has(c));
}

/** Throws unless the principal holds the capability. */
export function requireCapability(principal: Principal, capability: string): void {
  if (!principal.mfaSatisfied) {
    throw new AuthenticationError("Multi-factor authentication is not complete.");
  }
  if (!principal.capabilities.has(capability)) {
    throw new AuthorizationError(
      `You do not have permission to do this (${capability}).`,
      capability,
    );
  }
}

export function requireAnyCapability(principal: Principal, capabilities: string[]): void {
  if (!principal.mfaSatisfied) {
    throw new AuthenticationError("Multi-factor authentication is not complete.");
  }
  if (!canAny(principal, capabilities)) {
    throw new AuthorizationError(
      `You do not have permission to do this (one of: ${capabilities.join(", ")}).`,
    );
  }
}

/**
 * Maker/checker.
 *
 * Holding both capabilities is legitimate — a small team needs people who can
 * both raise and approve documents. What is never legitimate is the same
 * person doing both *to the same record*, so the check is on the record, not
 * on the role.
 */
export function requireDifferentApprover(params: {
  principal: Principal;
  createdByUserId: string | null;
  action: string;
}): void {
  if (params.createdByUserId && params.createdByUserId === params.principal.userId) {
    throw new AuthorizationError(
      `You cannot ${params.action} something you created yourself. ` +
        `Someone else must review it.`,
    );
  }
}

export function isMakerCheckerPair(createCapability: string, approveCapability: string): boolean {
  return MAKER_CHECKER_PAIRS.some(
    ([maker, checker]) => maker === createCapability && checker === approveCapability,
  );
}

/**
 * Scope for own-record access.
 *
 * `hr.payslip.view_all` sees anyone's; otherwise `hr.payslip.view_own` sees
 * only their own. The caller passes the employee the record belongs to, and
 * changing an id in the URL gets a 403 rather than someone else's salary.
 */
export function requireEmployeeScope(params: {
  principal: Principal;
  targetEmployeeId: string | null;
  viewAllCapability: string;
  viewOwnCapability: string;
}): void {
  const { principal, targetEmployeeId, viewAllCapability, viewOwnCapability } = params;

  if (principal.capabilities.has(viewAllCapability)) return;

  if (!principal.capabilities.has(viewOwnCapability)) {
    throw new AuthorizationError("You do not have permission to view this.", viewOwnCapability);
  }
  if (!principal.employeeId || principal.employeeId !== targetEmployeeId) {
    throw new AuthorizationError("You may only view your own records.");
  }
}
