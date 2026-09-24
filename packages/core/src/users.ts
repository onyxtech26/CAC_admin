import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { checkPasswordPolicy, hashPassword } from "./password.js";

/**
 * User administration.
 *
 * Creating accounts, assigning roles and taking access away. Three rules here
 * are worth more than the rest of the file.
 *
 * **Nobody sets someone else's password.** A new account gets a generated
 * password, shown once to the administrator to hand over, and flagged
 * `must_change_password`. An administrator who chooses a colleague's password
 * knows their credentials, which quietly destroys attribution in the audit trail.
 *
 * **No self-escalation.** An administrator cannot grant a role to themselves.
 * Without that rule, `admin.role.manage` is every capability in the system: hold
 * it, grant yourself ACCOUNTANT, and post journals alone. Another administrator
 * has to grant business roles, and the audit trail records who.
 *
 * **The last administrator cannot be locked out.** Removing the final account
 * that can administer users would leave the platform unadministrable, so it is
 * refused.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Capabilities that, if nobody held them, would make the platform unmanageable. */
const KEYSTONE_CAPABILITY = "admin.user.manage";

export interface NewUserInput {
  email: string;
  fullName: string;
  /** Roles to grant on creation. Subject to the no-self-escalation rule. */
  roles?: string[];
  /** Off only for accounts that genuinely cannot hold a device. Default on. */
  mfaEnforced?: boolean;
}

/**
 * Creates an account and returns its one-time password.
 *
 * The password is returned, never stored in readable form and never emailed from
 * here — this platform has no outbound mail path yet, and inventing one that
 * silently fails would be worse than handing the password over in person.
 */
export async function createUser(
  db: Executor,
  principal: Principal,
  input: NewUserInput,
  context?: AuditContext,
): Promise<{ userId: string; password: string }> {
  requireCapability(principal, "admin.user.manage");

  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim();

  if (!EMAIL.test(email)) throw new ValidationError("Enter a valid email address.", "email");
  if (fullName.length < 2) throw new ValidationError("Enter the person's full name.", "fullName");

  const existing = await db.execute<{ id: string }>(
    sql`SELECT id FROM auth."user" WHERE email = ${email}`,
  );
  if (existing.rows?.[0]) {
    throw new ConflictError(`An account already exists for ${email}.`);
  }

  const password = generatePassword();
  const passwordHash = await hashPassword(password);

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO auth."user" (email, password_hash, full_name, must_change_password, mfa_enforced)
    VALUES (${email}, ${passwordHash}, ${fullName}, true, ${input.mfaEnforced ?? true})
    RETURNING id
  `);
  const userId = created.rows![0]!.id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.USER_CREATED,
    entityType: "user",
    entityId: userId,
    newValues: { email, fullName, mfaEnforced: input.mfaEnforced ?? true },
  });

  for (const role of input.roles ?? []) {
    await assignRole(db, principal, userId, role, context);
  }

  return { userId, password };
}

/**
 * A password that is strong, typeable and read aloud once.
 *
 * Four groups of five characters from an unambiguous alphabet: no 0/O or 1/l/I,
 * because this gets written on a sticky note and typed back. ~100 bits of
 * entropy, which is far past the point where the policy check matters, but it is
 * run anyway so the generator can never drift below the policy it enforces on
 * everyone else.
 */
function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const bytes = randomBytes(20);
    let password = "";
    for (let index = 0; index < 20; index += 1) {
      password += alphabet[bytes[index]! % alphabet.length];
      if (index % 5 === 4 && index !== 19) password += "-";
    }
    if (checkPasswordPolicy(password, { minLength: 12 }).ok) return password;
  }
  throw new Error("Could not generate a password that satisfies the policy.");
}

export async function assignRole(
  db: Executor,
  principal: Principal,
  userId: string,
  roleKey: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "admin.role.manage");

  if (userId === principal.userId) {
    throw new ConflictError(
      "You cannot give yourself a role. Another administrator has to do it — otherwise the " +
        "ability to manage roles would quietly be the ability to do everything.",
    );
  }

  const role = await db.execute<{ id: string }>(
    sql`SELECT id FROM auth.role WHERE key = ${roleKey}`,
  );
  const found = role.rows?.[0];
  if (!found) throw new ValidationError(`There is no role called "${roleKey}".`, "role");

  const user = await db.execute<{ email: string }>(
    sql`SELECT email FROM auth."user" WHERE id = ${userId}`,
  );
  if (!user.rows?.[0]) throw new NotFoundError("That account no longer exists.");

  const inserted = await db.execute<{ user_id: string }>(sql`
    INSERT INTO auth.user_role (user_id, role_id) VALUES (${userId}, ${found.id})
    ON CONFLICT DO NOTHING
    RETURNING user_id
  `);
  // Already held: not an error, and not worth an audit row either. RETURNING is
  // how that is detected — ON CONFLICT DO NOTHING returns no row when it skips.
  if (!inserted.rows?.[0]) return;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.ROLE_ASSIGNED,
    entityType: "user",
    entityId: userId,
    newValues: { email: user.rows[0].email, role: roleKey },
  });
}

export async function revokeRole(
  db: Executor,
  principal: Principal,
  userId: string,
  roleKey: string,
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<void> {
  requireCapability(principal, "admin.role.manage");

  const user = await db.execute<{ email: string }>(
    sql`SELECT email FROM auth."user" WHERE id = ${userId}`,
  );
  if (!user.rows?.[0]) throw new NotFoundError("That account no longer exists.");

  await assertKeystoneSurvives(db, userId, roleKey);

  const removed = await db.execute<{ user_id: string }>(sql`
    DELETE FROM auth.user_role
     WHERE user_id = ${userId}
       AND role_id = (SELECT id FROM auth.role WHERE key = ${roleKey})
    RETURNING user_id
  `);
  if (!removed.rows?.[0]) return;

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.ROLE_REVOKED,
    entityType: "user",
    entityId: userId,
    oldValues: { email: user.rows[0].email, role: roleKey },
    reason: options.reason ?? null,
  });
}

/**
 * Suspends or reactivates an account.
 *
 * Suspending also revokes every live session, so it takes effect now rather than
 * whenever the person next signs in. Accounts are never deleted: the audit trail
 * refers to them, and an entry attributed to a missing user is an entry nobody
 * can account for.
 */
export async function setUserStatus(
  db: Executor,
  principal: Principal,
  userId: string,
  status: "active" | "suspended",
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<void> {
  requireCapability(principal, "admin.user.manage");

  if (userId === principal.userId && status === "suspended") {
    throw new ConflictError("You cannot suspend your own account.");
  }

  const found = await db.execute<{ email: string; status: string }>(
    sql`SELECT email, status FROM auth."user" WHERE id = ${userId} FOR UPDATE`,
  );
  const user = found.rows?.[0];
  if (!user) throw new NotFoundError("That account no longer exists.");
  if (user.status === status) return;

  if (status === "suspended") {
    await assertKeystoneSurvives(db, userId, null);
  }

  await db.execute(sql`
    UPDATE auth."user"
       SET status = ${status},
           -- Reactivating also clears any lockout: an administrator putting an
           -- account back is not expecting it still to be frozen from failed
           -- sign-ins weeks ago.
           failed_attempts = ${status === "active" ? 0 : sql`failed_attempts`},
           locked_until = ${status === "active" ? null : sql`locked_until`}
     WHERE id = ${userId}
  `);

  if (status === "suspended") {
    await db.execute(sql`
      UPDATE auth.session SET revoked_at = now()
       WHERE user_id = ${userId} AND revoked_at IS NULL
    `);
  }

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: status === "suspended" ? AUDIT.USER_SUSPENDED : AUDIT.USER_REACTIVATED,
    entityType: "user",
    entityId: userId,
    oldValues: { email: user.email, status: user.status },
    newValues: { email: user.email, status },
    reason: options.reason ?? null,
  });
}

/**
 * Issues a new one-time password and ends every session.
 *
 * Used when someone is locked out or a credential may have leaked. The
 * administrator hands the password over and the account must change it on the
 * next sign-in.
 */
export async function resetPassword(
  db: Executor,
  principal: Principal,
  userId: string,
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<{ password: string }> {
  requireCapability(principal, "admin.user.manage");

  const found = await db.execute<{ email: string }>(
    sql`SELECT email FROM auth."user" WHERE id = ${userId} FOR UPDATE`,
  );
  const user = found.rows?.[0];
  if (!user) throw new NotFoundError("That account no longer exists.");

  const password = generatePassword();
  const passwordHash = await hashPassword(password);

  await db.execute(sql`
    UPDATE auth."user"
       SET password_hash = ${passwordHash}, must_change_password = true,
           failed_attempts = 0, locked_until = NULL
     WHERE id = ${userId}
  `);
  await db.execute(sql`
    UPDATE auth.session SET revoked_at = now() WHERE user_id = ${userId} AND revoked_at IS NULL
  `);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.PASSWORD_RESET_COMPLETED,
    entityType: "user",
    entityId: userId,
    newValues: { email: user.email, by: "administrator" },
    reason: options.reason ?? null,
  });

  return { password };
}

/**
 * Removes a lost authenticator so the person can enrol a new one.
 *
 * A reason is mandatory. Clearing someone's second factor is the single most
 * useful thing an attacker who reaches an admin account can do, so it is the one
 * action here that always demands an explanation on the record.
 */
export async function resetMfa(
  db: Executor,
  principal: Principal,
  userId: string,
  options: { reason: string; context?: AuditContext },
): Promise<void> {
  requireCapability(principal, "admin.user.manage");

  if (!options.reason?.trim()) {
    throw new ValidationError(
      "Removing someone's authenticator needs a reason. It is recorded against your name.",
      "reason",
    );
  }

  const found = await db.execute<{ email: string }>(
    sql`SELECT email FROM auth."user" WHERE id = ${userId}`,
  );
  const user = found.rows?.[0];
  if (!user) throw new NotFoundError("That account no longer exists.");

  await db.execute(sql`DELETE FROM auth.mfa_device WHERE user_id = ${userId}`);
  await db.execute(sql`DELETE FROM auth.recovery_code WHERE user_id = ${userId}`);
  await db.execute(sql`
    UPDATE auth.session SET revoked_at = now() WHERE user_id = ${userId} AND revoked_at IS NULL
  `);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.MFA_RESET,
    entityType: "user",
    entityId: userId,
    oldValues: { email: user.email },
    reason: options.reason,
  });
}

/**
 * Refuses a change that would leave nobody able to administer users.
 *
 * `roleKey` is the role about to be removed, or null when the whole account is
 * being suspended. Counts the *other* accounts that would still hold the
 * keystone capability; if none would, the change is refused.
 */
async function assertKeystoneSurvives(
  db: Executor,
  userId: string,
  roleKey: string | null,
): Promise<void> {
  const keystoneVia = (extra = sql`true`) => sql`
    SELECT EXISTS (
      SELECT 1 FROM auth.user_role ur
      JOIN auth.role_permission rp ON rp.role_id = ur.role_id
      JOIN auth.permission p       ON p.id = rp.permission_id
      WHERE ur.user_id = ${userId} AND p.key = ${KEYSTONE_CAPABILITY} AND ${extra}
    ) AS holds
  `;

  // Would they still administer users afterwards? A suspension removes
  // everything; revoking one role leaves any others they hold.
  if (roleKey !== null) {
    const after = await db.execute<{ holds: boolean }>(
      keystoneVia(sql`ur.role_id <> (SELECT id FROM auth.role WHERE key = ${roleKey})`),
    );
    if (after.rows?.[0]?.holds) return;
  }

  // Did they have it in the first place? If not, this change cannot lock anyone
  // out and there is nothing to protect.
  const before = await db.execute<{ holds: boolean }>(keystoneVia());
  if (!before.rows?.[0]?.holds) return;

  const others = await db.execute<{ count: number }>(sql`
    SELECT count(DISTINCT u.id)::int AS count
      FROM auth."user" u
      JOIN auth.user_role ur      ON ur.user_id = u.id
      JOIN auth.role_permission rp ON rp.role_id = ur.role_id
      JOIN auth.permission p       ON p.id = rp.permission_id
     WHERE p.key = ${KEYSTONE_CAPABILITY}
       AND u.status = 'active'
       AND u.id <> ${userId}
  `);

  if ((others.rows?.[0]?.count ?? 0) === 0) {
    throw new ConflictError(
      "This is the only account that can administer users. Give someone else that access first, " +
        "or the platform becomes unmanageable.",
    );
  }
}

export interface UserSummary {
  id: string;
  email: string;
  fullName: string;
  status: string;
  roles: string[];
  mfaDevices: number;
  lastLoginAt: Date | string | null;
  lockedUntil: Date | string | null;
  mustChangePassword: boolean;
  activeSessions: number;
}

export async function listUsers(db: Executor): Promise<UserSummary[]> {
  const result = await db.execute<{
    id: string;
    email: string;
    full_name: string;
    status: string;
    roles: string | null;
    mfa_devices: number;
    last_login_at: Date | string | null;
    locked_until: Date | string | null;
    must_change_password: boolean;
    active_sessions: number;
  }>(sql`
    SELECT u.id, u.email, u.full_name, u.status, u.last_login_at, u.locked_until,
           u.must_change_password,
           string_agg(DISTINCT r.key, ',' ORDER BY r.key) AS roles,
           (SELECT count(*) FROM auth.mfa_device d
             WHERE d.user_id = u.id AND d.confirmed_at IS NOT NULL)::int AS mfa_devices,
           (SELECT count(*) FROM auth.session s
             WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now())::int
             AS active_sessions
      FROM auth."user" u
      LEFT JOIN auth.user_role ur ON ur.user_id = u.id
      LEFT JOIN auth.role r ON r.id = ur.role_id
     GROUP BY u.id
     ORDER BY u.full_name
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    status: row.status,
    roles: row.roles ? row.roles.split(",") : [],
    mfaDevices: row.mfa_devices,
    lastLoginAt: row.last_login_at,
    lockedUntil: row.locked_until,
    mustChangePassword: row.must_change_password,
    activeSessions: row.active_sessions,
  }));
}
