import { sql } from "drizzle-orm";
import type { Database } from "@cac/db";
import { generateToken, hashToken, verifyPassword } from "./password.js";
import { normaliseRecoveryCode } from "./password.js";
import { resolveCapabilities, resolveRoles, type Principal } from "./authz.js";
import { AUDIT, writeAudit } from "./audit.js";
import { matchTotpStep } from "./totp.js";
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
  /**
   * Failed attempts from one address, within the window below, before that address is refused.
   *
   * The per-account lock does nothing against somebody trying one password against two hundred
   * accounts: each account sees a single failure. `auth.login_attempt` recorded every attempt with
   * its address and nothing ever read the table, so the per-address backoff the security model
   * promises did not exist. Twenty is generous for an office behind one NAT address and far below
   * what a spray needs.
   */
  maxFailedFromOneAddress: number;
  addressWindowMinutes: number;
}

export const DEFAULT_LOGIN_POLICY: LoginPolicy = {
  maxFailedAttempts: 5,
  lockoutMinutes: 15,
  idleMinutes: 30,
  absoluteHours: 12,
  maxFailedFromOneAddress: 20,
  addressWindowMinutes: 15,
};

/**
 * The outcome of the second factor.
 *
 * It returns a token because completing MFA **rotates** it. `completeMfa` used to set
 * `mfa_satisfied_at` on the existing row and nothing else, so a pre-MFA token that had been fixed,
 * copied or observed became a fully satisfied session the moment the legitimate holder typed their
 * code — the session-fixation case the security model says rotation exists to prevent. The session
 * row is the same row, so there is still exactly one thing to revoke and the audit chain is
 * unbroken; only the bearer token changes.
 */
export type MfaResult =
  | { status: "ok"; token: string }
  | { status: "invalid" }
  | { status: "locked"; until: Date }
  | { status: "no_session" };

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

  // Before anything else, including the account lookup: a refused address is refused whoever it
  // claims to be, and the refusal must not itself become a way to ask questions about an account.
  if (ctx.ip) {
    const recent = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM auth.login_attempt
       WHERE ip = ${ctx.ip}::inet AND success = false
         AND created_at > now() - ${`${policy.addressWindowMinutes} minutes`}::interval
    `);
    if (Number(recent.rows?.[0]?.n ?? "0") >= policy.maxFailedFromOneAddress) {
      await recordAttempt(db, normalised, false, "address_throttled", ctx);
      return {
        status: "locked",
        until: new Date(Date.now() + policy.addressWindowMinutes * 60_000),
      };
    }
  }

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

  const passwordOk = await verifyPassword(password, user.password_hash);

  /**
   * The state of the account is disclosed only to somebody who proved they hold its password.
   *
   * These two checks ran *before* the password was verified, so "this account is locked" and "this
   * account is suspended" came back for any junk password — which tells an attacker that the address
   * is a real one, and more. The comment in the sign-in action even claimed the suspended message was
   * safe "because the password was correct"; it had never been checked. The whole point of hashing an
   * unknown account's password is to make every wrong answer look the same, and this undid it two
   * lines later.
   *
   * The password check itself still runs first and always, so the timing does not change either.
   */
  if (passwordOk && user.locked_until && new Date(user.locked_until) > new Date()) {
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

  if (passwordOk && user.status !== "active") {
    await recordAttempt(db, normalised, false, "suspended", ctx);
    return { status: "suspended" };
  }

  if (!passwordOk) {
    const attempts = user.failed_attempts + 1;
    const shouldLock = attempts >= policy.maxFailedAttempts;
    await db.execute(sql`
      UPDATE auth."user"
      SET failed_attempts = ${attempts},
          -- Never clears an existing lock. Writing null on every failed attempt would have meant a
          -- locked account unlocked itself on the next wrong guess.
          locked_until = ${
            shouldLock
              ? new Date(Date.now() + policy.lockoutMinutes * 60_000).toISOString()
              : (user.locked_until ?? null)
          }
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

/**
 * Completes the MFA step for a session that is otherwise authenticated.
 *
 * Three things here are load-bearing and none of them was true before.
 *
 * **The attempt is counted.** The step had no limit at all: somebody holding the password, and so a
 * pre-MFA cookie, could post codes at `/login/mfa` until one worked — three valid TOTP values per
 * thirty-second window and ten live recovery codes, against a twelve-hour session. `MFA_FAILED` was
 * written to the audit trail and nothing read it. Failures now go on the same counter the password
 * step uses and lock the same account, because it is the same account being attacked; the lock also
 * revokes the session being used, so a locked-out attacker cannot sit and wait for it to lift.
 *
 * **The whole thing is one transaction, and the recovery code is locked.** The `used_at IS NULL`
 * select had no `FOR UPDATE` and ran on the pooled handle, so two simultaneous posts of the same
 * code both passed it and both satisfied a session — a single-use code spent twice. Enrolment took
 * the lock; this did not.
 *
 * **The token rotates.** See `MfaResult`.
 */
export async function completeMfa(
  db: Database,
  sessionToken: string,
  code: string,
  ctx: LoginContext = {},
  policy: LoginPolicy = DEFAULT_LOGIN_POLICY,
): Promise<MfaResult> {
  const tokenHash = hashToken(sessionToken);

  return db.transaction(async (tx) => {
    // The user row is locked as well as the session, because the attempt counter lives on it and two
    // codes posted at once must not both read the same count.
    const rows = await tx.execute<{
      id: string;
      user_id: string;
      status: string;
      failed_attempts: number;
      locked_until: string | null;
    }>(sql`
      SELECT s.id, s.user_id, u.status, u.failed_attempts, u.locked_until
        FROM auth.session s
        JOIN auth."user" u ON u.id = s.user_id
       WHERE s.token_hash = ${tokenHash} AND s.revoked_at IS NULL AND s.expires_at > now()
       FOR UPDATE
    `);
    const session = rows.rows?.[0];
    if (!session || session.status !== "active") return { status: "no_session" } as const;

    if (session.locked_until && new Date(session.locked_until) > new Date()) {
      return { status: "locked", until: new Date(session.locked_until) } as const;
    }

    const satisfy = async (how: "authenticator" | "recovery code"): Promise<MfaResult> => {
      const { token, hash } = generateToken();
      await tx.execute(sql`
        UPDATE auth.session
           SET mfa_satisfied_at = now(), token_hash = ${hash}, last_seen_at = now()
         WHERE id = ${session.id}
      `);
      await tx.execute(sql`
        UPDATE auth."user" SET failed_attempts = 0, locked_until = NULL WHERE id = ${session.user_id}
      `);

      // The success paths returned before writing anything, so the trail held every failed second
      // factor and no successful one — which makes the failures hard to read, since there is nothing
      // to compare them against, and leaves no record that a recovery code was spent.
      await writeAudit(tx, {
        action: AUDIT.MFA_SATISFIED,
        entityType: "session",
        entityId: session.id,
        actorUserId: session.user_id,
        newValues: { using: how },
        ...ctx,
      });

      return { status: "ok", token };
    };

    const devices = await tx.execute<{ id: string; secret_enc: string; last_step: string | null }>(sql`
      SELECT id, secret_enc, last_step FROM auth.mfa_device
      WHERE user_id = ${session.user_id} AND confirmed_at IS NOT NULL
    `);

    for (const device of devices.rows ?? []) {
      // The step is recorded, so the same code cannot be used twice. The drift window accepts three
      // steps, which made a code seen over a shoulder good for about ninety seconds.
      const step = matchTotpStep(decryptSecret(device.secret_enc), code, {
        after: device.last_step === null ? null : Number(device.last_step),
      });
      if (step !== null) {
        await tx.execute(sql`
          UPDATE auth.mfa_device SET last_used_at = now(), last_step = ${step} WHERE id = ${device.id}
        `);
        return satisfy("authenticator");
      }
    }

    // Recovery codes are single-use, and this is where that is made true rather than hoped for.
    // Normalised rather than merely upper-cased: the hyphen is there to make ten characters
    // readable, and hashing it meant a code typed without it was refused in the same words as a
    // wrong one, at the moment somebody had already lost their authenticator.
    const codeHash = hashToken(normaliseRecoveryCode(code));
    const recovery = await tx.execute<{ id: string }>(sql`
      SELECT id FROM auth.recovery_code
       WHERE user_id = ${session.user_id} AND code_hash = ${codeHash} AND used_at IS NULL
       FOR UPDATE
    `);
    if (recovery.rows?.[0]) {
      await tx.execute(sql`
        UPDATE auth.recovery_code SET used_at = now() WHERE id = ${recovery.rows[0].id}
      `);
      return satisfy("recovery code");
    }

    const attempts = session.failed_attempts + 1;
    const shouldLock = attempts >= policy.maxFailedAttempts;
    const until = shouldLock ? new Date(Date.now() + policy.lockoutMinutes * 60_000) : null;

    await tx.execute(sql`
      UPDATE auth."user"
         SET failed_attempts = ${attempts}, locked_until = ${until ? until.toISOString() : null}
       WHERE id = ${session.user_id}
    `);

    if (shouldLock) {
      // The half-authenticated session goes too. Leaving it alive would let whoever is guessing wait
      // out the lockout with the same cookie and carry on.
      await tx.execute(sql`UPDATE auth.session SET revoked_at = now() WHERE id = ${session.id}`);
    }

    await writeAudit(tx, {
      action: AUDIT.MFA_FAILED,
      entityType: "session",
      entityId: session.id,
      actorUserId: session.user_id,
      newValues: { failedAttempts: attempts, locked: shouldLock },
      ...ctx,
    });

    return until ? { status: "locked", until } : { status: "invalid" };
  });
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
    mfa_required: boolean;
    mfa_required_since: string | null;
    grace_days: number;
    locked_until: string | null;
  }>(sql`
    SELECT s.id AS session_id, s.user_id, u.email, u.full_name, u.employee_id,
           u.status, s.mfa_satisfied_at, s.last_seen_at, u.must_change_password,
           u.locked_until, u.mfa_required_since,
           COALESCE((
             SELECT (st.value #>> '{}')::int FROM org.setting st
              WHERE st.key = 'security.mfa_enrolment_grace_days'
                AND jsonb_typeof(st.value) = 'number'
           ), 7) AS grace_days,
           -- Required to hold an authenticator and holding none.
           --
           -- Two sources, both of which were decorative before. The mfa_enforced column is set on
           -- the user screen and was read at login and ignored. The security.mfa_required_roles
           -- setting is seeded with the six roles SECURITY_MODEL.md calls mandatory and was read by
           -- nothing at all, so the policy that document states was enforced neither per user nor
           -- per role.
           ((
              u.mfa_enforced
              OR EXISTS (
                SELECT 1
                  FROM auth.user_role ur
                  JOIN auth.role r ON r.id = ur.role_id
                 WHERE ur.user_id = u.id
                   AND r.key IN (
                     SELECT jsonb_array_elements_text(st.value)
                       FROM org.setting st
                      WHERE st.key = 'security.mfa_required_roles'
                        AND jsonb_typeof(st.value) = 'array'
                   )
              )
            ) AND NOT EXISTS (
              SELECT 1 FROM auth.mfa_device d
               WHERE d.user_id = u.id AND d.confirmed_at IS NOT NULL
            )) AS mfa_required
    FROM auth.session s JOIN auth."user" u ON u.id = s.user_id
    WHERE s.token_hash = ${tokenHash} AND s.revoked_at IS NULL AND s.expires_at > now()
  `);

  const row = rows.rows?.[0];
  if (!row || row.status !== "active") return null;

  // Locking an account ends its sessions. Suspension already did; locking did not, so an account
  // locked *because somebody was guessing at it* carried on working in whatever browser was already
  // signed in — including, if the guessing had already succeeded once, the attacker's.
  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    await db.execute(sql`UPDATE auth.session SET revoked_at = now() WHERE id = ${row.session_id}`);
    return null;
  }

  const idleMs = Date.now() - new Date(row.last_seen_at).getTime();
  if (idleMs > policy.idleMinutes * 60_000) {
    await db.execute(sql`UPDATE auth.session SET revoked_at = now() WHERE id = ${row.session_id}`);
    return null;
  }

  await db.execute(sql`UPDATE auth.session SET last_seen_at = now() WHERE id = ${row.session_id}`);

  /**
   * When the authenticator requirement started applying to this account, and when it bites.
   *
   * Stamped here rather than taken from `created_at`, because an account created a year ago has not
   * been under this rule for a year — it has been under it since the day the rule was switched on,
   * which for most of these accounts is the first time this line runs. Cleared when a device is
   * confirmed, so removing one later earns the same warning rather than an immediate shut-out.
   */
  let requiredSince = row.mfa_required_since;
  if (row.mfa_required && !requiredSince) {
    const stamped = await db.execute<{ mfa_required_since: string }>(sql`
      UPDATE auth."user" SET mfa_required_since = now()
       WHERE id = ${row.user_id} AND mfa_required_since IS NULL
      RETURNING mfa_required_since
    `);
    requiredSince = stamped.rows?.[0]?.mfa_required_since ?? new Date().toISOString();
  } else if (!row.mfa_required && requiredSince) {
    await db.execute(sql`
      UPDATE auth."user" SET mfa_required_since = NULL WHERE id = ${row.user_id}
    `);
    requiredSince = null;
  }

  const dueAt =
    row.mfa_required && requiredSince
      ? new Date(new Date(requiredSince).getTime() + row.grace_days * 86_400_000)
      : null;

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
    mfaRequired: row.mfa_required,
    mfaEnrolmentDueAt: dueAt ? dueAt.toISOString() : null,
    // The shut-out, which is the requirement plus the grace having run out.
    mustEnrolMfa: dueAt !== null && dueAt.getTime() <= Date.now(),
  };
}

/**
 * Ends one session.
 *
 * `reason` separates the two things this is used for, which the trail could not tell apart: signing
 * out, and somebody looking at a list of their devices and killing one they do not recognise. The
 * second is a security event — it is the moment a person notices something — and it was recorded as
 * an ordinary logout. `AUDIT.SESSION_REVOKED` was declared for it and never written.
 */
export async function revokeSession(
  db: Database,
  sessionId: string,
  actorUserId?: string,
  reason: "signed out" | "revoked" = "signed out",
): Promise<void> {
  await db.execute(sql`UPDATE auth.session SET revoked_at = now() WHERE id = ${sessionId} AND revoked_at IS NULL`);
  await writeAudit(db, {
    action: reason === "revoked" ? AUDIT.SESSION_REVOKED : AUDIT.LOGOUT,
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

/*
 * `changePassword` used to live here: no callers anywhere, and it set a new hash without revoking
 * the sessions the old password had opened — the rule this module's own header states. Removed
 * rather than fixed, because `changeOwnPassword` in `enrolment.ts` is the one the application uses
 * and it does revoke them. A second, subtly weaker way to do the same thing is how the weaker one
 * eventually gets called.
 */
