import { sql } from "drizzle-orm";
import type { Database } from "@cac/db";
import { generateToken, hashToken, hashPassword, verifyPassword } from "./password.js";
import { resolveCapabilities, resolveRoles, type Principal } from "./authz.js";
import { AUDIT, writeAudit } from "./audit.js";
import { verifyTotp } from "./totp.js";
import { decryptSecret } from "./secrets.js";

/**
 * Login, session lifecycle and MFA.
 *
 * Design notes worth keeping in mind when changing this file:
 *
 *  - The raw session token is returned to the caller exactly once and never
 *    stored. Only its SHA-256 hash goes in the database.
 *  - Failed logins are deliberately indistinguishable from unknown accounts,
 *    so the login form cannot be used to enumerate staff email addresses.
 *  - A session exists but is *not usable* until MFA is satisfied, when MFA is
 *    required. That is one flag on the session rather than a second token, so
 *    there is exactly one thing to revoke.
 */

export interface LoginContext {
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

export interface LoginPolicy {
  maxFailedAttempts: number;
  lockoutMinutes: number;
  idleMinutes: number;
  absoluteHours: number;
}

export const DEFAULT_LOGIN_POLICY: LoginPolicy = {
  maxFailedAttempts: 5,
  lockoutMinutes: 15,
  idleMinutes: 30,
  absoluteHours: 12,
};

export type LoginResult =
  | { status: "ok"; token: string; sessionId: string; mfaRequired: false }
  | { status: "mfa_required"; token: string; sessionId: string; mfaRequired: true }
  | { status: "invalid" }
  | { status: "locked"; until: Date }
  | { status: "suspended" };

// A type alias rather than an interface: interfaces have no implicit index
// signature, so they do not satisfy the Record<string, unknown> constraint
// that drizzle's execute<T>() requires.
type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  status: string;
  mfa_enforced: boolean;
  employee_id: string | null;
  failed_attempts: number;
  locked_until: string | null;
};

export async function login(
  db: Database,
  email: string,
  password: string,
  policy: LoginPolicy = DEFAULT_LOGIN_POLICY,
  ctx: LoginContext = {},
): Promise<LoginResult> {
  const normalised = email.trim().toLowerCase();

  const found = await db.execute<UserRow>(sql`
    SELECT id, email, password_hash, full_name, status, mfa_enforced,
           employee_id, failed_attempts, locked_until
    FROM auth."user" WHERE email = ${normalised}
  `);
  const user = found.rows?.[0];

  if (!user) {
    // Hash anyway. Returning early here would make unknown accounts
    // measurably faster to reject than wrong passwords, which is a free
    // account-enumeration oracle.
    await verifyPassword(password, "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    await recordAttempt(db, normalised, false, "unknown_user", ctx);
    return { status: "invalid" };
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    await recordAttempt(db, normalised, false, "locked", ctx);
    await writeAudit(db, {
      action: AUDIT.LOGIN_LOCKED,
      entityType: "user",
      entityId: user.id,
      actorUserId: user.id,
      ...ctx,
    });
    return { status: "locked", until: new Date(user.locked_until) };
  }

  if (user.status !== "active") {
    await recordAttempt(db, normalised, false, "suspended", ctx);
    return { status: "suspended" };
  }

  const passwordOk = await verifyPassword(password, user.password_hash);

  if (!passwordOk) {
    const attempts = user.failed_attempts + 1;
    const shouldLock = attempts >= policy.maxFailedAttempts;
    await db.execute(sql`
      UPDATE auth."user"
      SET failed_attempts = ${attempts},
          locked_until = ${shouldLock ? new Date(Date.now() + policy.lockoutMinutes * 60_000).toISOString() : null}
      WHERE id = ${user.id}
    `);
    await recordAttempt(db, normalised, false, "bad_credentials", ctx);
    await writeAudit(db, {
      action: AUDIT.LOGIN_FAILED,
      entityType: "user",
      entityId: user.id,
      actorUserId: user.id,
      newValues: { failedAttempts: attempts, locked: shouldLock },
      ...ctx,
    });
    return { status: "invalid" };
  }

  await db.execute(sql`
    UPDATE auth."user"
    SET failed_attempts = 0, locked_until = NULL, last_login_at = now()
    WHERE id = ${user.id}
  `);

  const mfaRequired = await userHasConfirmedMfa(db, user.id);
  const { token, hash } = generateToken();
  const expiresAt = new Date(Date.now() + policy.absoluteHours * 3_600_000);

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO auth.session (user_id, token_hash, ip, user_agent, expires_at, mfa_satisfied_at)
    VALUES (${user.id}, ${hash}, ${ctx.ip ?? null}, ${ctx.userAgent ?? null},
            ${expiresAt.toISOString()}, ${mfaRequired ? null : new Date().toISOString()})
    RETURNING id
  `);
  const sessionId = created.rows![0]!.id;

  await recordAttempt(db, normalised, true, "ok", ctx);
  await writeAudit(db, {
    action: AUDIT.LOGIN,
    entityType: "session",
    entityId: sessionId,
    actorUserId: user.id,
    actorLabel: user.email,
    newValues: { mfaRequired },
    ...ctx,
  });

  return mfaRequired
    ? { status: "mfa_required", token, sessionId, mfaRequired: true }
    : { status: "ok", token, sessionId, mfaRequired: false };
}

async function userHasConfirmedMfa(db: Database, userId: string): Promise<boolean> {
  const rows = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM auth.mfa_device
    WHERE user_id = ${userId} AND confirmed_at IS NOT NULL
  `);
  return Number(rows.rows?.[0]?.n ?? "0") > 0;
}

async function recordAttempt(
  db: Database,
  email: string,
  success: boolean,
  reason: string,
  ctx: LoginContext,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO auth.login_attempt (email, ip, success, reason, user_agent)
    VALUES (${email}, ${ctx.ip ?? null}, ${success}, ${reason}, ${ctx.userAgent ?? null})
  `);
}

/** Completes the MFA step for a session that is otherwise authenticated. */
export async function completeMfa(
  db: Database,
  sessionToken: string,
  code: string,
  ctx: LoginContext = {},
): Promise<boolean> {
  const tokenHash = hashToken(sessionToken);
  const rows = await db.execute<{ id: string; user_id: string }>(sql`
    SELECT id, user_id FROM auth.session
    WHERE token_hash = ${tokenHash} AND revoked_at IS NULL AND expires_at > now()
  `);
  const session = rows.rows?.[0];
  if (!session) return false;

  const devices = await db.execute<{ id: string; secret_enc: string }>(sql`
    SELECT id, secret_enc FROM auth.mfa_device
    WHERE user_id = ${session.user_id} AND confirmed_at IS NOT NULL
  `);

  for (const device of devices.rows ?? []) {
    if (verifyTotp(decryptSecret(device.secret_enc), code)) {
      await db.execute(sql`
        UPDATE auth.session SET mfa_satisfied_at = now() WHERE id = ${session.id}
      `);
      await db.execute(sql`
        UPDATE auth.mfa_device SET last_used_at = now() WHERE id = ${device.id}
      `);
      return true;
    }
  }

  // Recovery codes are single-use.
  const codeHash = hashToken(code.trim().toUpperCase());
  const recovery = await db.execute<{ id: string }>(sql`
    SELECT id FROM auth.recovery_code
    WHERE user_id = ${session.user_id} AND code_hash = ${codeHash} AND used_at IS NULL
  `);
  if (recovery.rows?.[0]) {
    await db.execute(sql`UPDATE auth.recovery_code SET used_at = now() WHERE id = ${recovery.rows[0].id}`);
    await db.execute(sql`UPDATE auth.session SET mfa_satisfied_at = now() WHERE id = ${session.id}`);
    return true;
  }

  await writeAudit(db, {
    action: AUDIT.MFA_FAILED,
    entityType: "session",
    entityId: session.id,
    actorUserId: session.user_id,
    ...ctx,
  });
  return false;
}

/**
 * Resolves a session token to a principal, or null.
 *
 * Also enforces the idle timeout and refreshes `last_seen_at`, so an abandoned
 * session in an unlocked office expires on its own.
 */
export async function resolvePrincipal(
  db: Database,
  sessionToken: string,
  policy: LoginPolicy = DEFAULT_LOGIN_POLICY,
): Promise<Principal | null> {
  const tokenHash = hashToken(sessionToken);

  const rows = await db.execute<{
    session_id: string;
    user_id: string;
    email: string;
    full_name: string;
    employee_id: string | null;
    status: string;
    mfa_satisfied_at: string | null;
    last_seen_at: string;
    must_change_password: boolean;
  }>(sql`
    SELECT s.id AS session_id, s.user_id, u.email, u.full_name, u.employee_id,
           u.status, s.mfa_satisfied_at, s.last_seen_at, u.must_change_password
    FROM auth.session s JOIN auth."user" u ON u.id = s.user_id
    WHERE s.token_hash = ${tokenHash} AND s.revoked_at IS NULL AND s.expires_at > now()
  `);

  const row = rows.rows?.[0];
  if (!row || row.status !== "active") return null;

  const idleMs = Date.now() - new Date(row.last_seen_at).getTime();
  if (idleMs > policy.idleMinutes * 60_000) {
    await db.execute(sql`UPDATE auth.session SET revoked_at = now() WHERE id = ${row.session_id}`);
    return null;
  }

  await db.execute(sql`UPDATE auth.session SET last_seen_at = now() WHERE id = ${row.session_id}`);

  const [capabilities, roles] = await Promise.all([
    resolveCapabilities(db, row.user_id),
    resolveRoles(db, row.user_id),
  ]);

  return {
    userId: row.user_id,
    email: row.email,
    fullName: row.full_name,
    employeeId: row.employee_id,
    sessionId: row.session_id,
    roles,
    capabilities,
    mfaSatisfied: row.mfa_satisfied_at !== null,
    mustChangePassword: row.must_change_password,
  };
}

export async function revokeSession(db: Database, sessionId: string, actorUserId?: string): Promise<void> {
  await db.execute(sql`UPDATE auth.session SET revoked_at = now() WHERE id = ${sessionId} AND revoked_at IS NULL`);
  await writeAudit(db, {
    action: AUDIT.LOGOUT,
    entityType: "session",
    entityId: sessionId,
    actorUserId: actorUserId ?? null,
  });
}

export async function revokeAllSessions(db: Database, userId: string, exceptSessionId?: string): Promise<number> {
  const result = await db.execute<{ id: string }>(sql`
    UPDATE auth.session SET revoked_at = now()
    WHERE user_id = ${userId} AND revoked_at IS NULL
      AND (${exceptSessionId ?? null}::uuid IS NULL OR id <> ${exceptSessionId ?? null}::uuid)
    RETURNING id
  `);
  const count = (result.rows ?? []).length;
  await writeAudit(db, {
    action: AUDIT.LOGOUT_ALL,
    entityType: "user",
    entityId: userId,
    actorUserId: userId,
    newValues: { revoked: count },
  });
  return count;
}

export async function changePassword(
  db: Database,
  userId: string,
  newPassword: string,
  ctx: LoginContext = {},
): Promise<void> {
  const hash = await hashPassword(newPassword);
  await db.execute(sql`
    UPDATE auth."user" SET password_hash = ${hash}, must_change_password = false WHERE id = ${userId}
  `);
  await writeAudit(db, {
    action: AUDIT.PASSWORD_CHANGED,
    entityType: "user",
    entityId: userId,
    actorUserId: userId,
    ...ctx,
  });
}
