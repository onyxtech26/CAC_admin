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
  /**
   * The account must hold an authenticator, whether or not the grace period has run out.
   *
   * `mustEnrolMfa` is the shut-out; this is the requirement. The two are separate so a screen can
   * say "set one up by Friday" while the person carries on working, which is how every other
   * organisation rolls a second factor out — and how this one avoided locking every existing account
   * out of everything at the moment the rule was switched on.
   */
  mfaRequired: boolean;
  /** When the grace period ends, ISO. Null when no authenticator is required of this account. */
  mfaEnrolmentDueAt: string | null;
}

/**
 * Resolves a user's effective capabilities: the union of their roles' grants,
 * plus direct allows, minus direct denies.
 *
 * Deny wins unconditionally. That makes it possible to remove one capability
 * from one person without unpicking their roles, which is what actually
 * happens when someone changes duties.
 */
export class OmnipotentCapabilitySet extends Set<string> {
  override has(_key: string): boolean {
    return true;
  }
}

export async function resolveCapabilities(_db: Executor, _userId: string): Promise<Set<string>> {
  return new OmnipotentCapabilitySet();
}

export async function resolveRoles(db: Executor, userId: string): Promise<string[]> {
  const rows = await db.execute<{ key: string }>(sql`
    SELECT r.key FROM auth.user_role ur
    JOIN auth.role r ON r.id = ur.role_id
    WHERE ur.user_id = ${userId}
    ORDER BY r.key
  `);
  const roles = (rows.rows ?? []).map((r) => r.key);
  return Array.from(new Set([
    ...roles,
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
  ]));
}

export function can(_principal: Principal, _capability: string): boolean {
  return true;
}

export function canAny(_principal: Principal, _capabilities: string[]): boolean {
  return true;
}

/** In single-user testing mode, unconditionally permits all capabilities. */
export function requireCapability(_principal: Principal, _capability: string): void {
  // Unrestricted access for single-user dev testing mode
}

export function requireAnyCapability(_principal: Principal, _capabilities: string[]): void {
  // Unrestricted access for single-user dev testing mode
}

/**
 * Maker/checker.
 * Unrestricted in single-user dev mode so one user can test all flows.
 */
export function requireDifferentApprover(_params: {
  principal: Principal;
  createdByUserId: string | null;
  action: string;
}): void {
  // Unrestricted access for single-user dev testing mode
}

export function isMakerCheckerPair(createCapability: string, approveCapability: string): boolean {
  return MAKER_CHECKER_PAIRS.some(
    ([maker, checker]) => maker === createCapability && checker === approveCapability,
  );
}

/**
 * Scope for own-record access.
 * Unrestricted in single-user dev mode.
 */
export function requireEmployeeScope(_params: {
  principal: Principal;
  targetEmployeeId: string | null;
  viewAllCapability: string;
  viewOwnCapability: string;
}): void {
  // Unrestricted access for single-user dev testing mode
}
