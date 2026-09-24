import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import {
  checkPasswordPolicy,
  generateRecoveryCodes,
  hashPassword,
  verifyPassword,
} from "./password.js";
import { decryptSecret, encryptSecret, hasProductionKey } from "./secrets.js";
import { generateSecret, otpauthUri, verifyTotp } from "./totp.js";
import type { Principal } from "./authz.js";

/**
 * Self-service: your own password, your own authenticator.
 *
 * Everything here acts on the caller's own account and nobody else's, so there is
 * no capability to check — the session *is* the authorisation. What there is
 * instead is proof of presence: changing a password needs the current one, and
 * enrolling a device needs a working code from it. Both exist because a stolen
 * session should not be enough to take an account over permanently.
 */

export interface PasswordChangeInput {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

/**
 * Changes the caller's own password.
 *
 * Requires the current one even though the session is already authenticated. A
 * session left open on an unlocked machine would otherwise be enough to lock the
 * owner out of their own account, and the current password is the cheapest proof
 * that the person at the keyboard is the account holder.
 *
 * Every other session is revoked afterwards. If the reason for the change is that
 * the old password leaked, leaving the sessions it opened alive defeats the point.
 */
export async function changeOwnPassword(
  db: Executor,
  principal: Principal,
  input: PasswordChangeInput,
  options: { minLength?: number; context?: AuditContext } = {},
): Promise<void> {
  const found = await db.execute<{ password_hash: string }>(
    sql`SELECT password_hash FROM auth."user" WHERE id = ${principal.userId} FOR UPDATE`,
  );
  const user = found.rows?.[0];
  if (!user) throw new NotFoundError("That account no longer exists.");

  if (!(await verifyPassword(input.currentPassword, user.password_hash))) {
    throw new ValidationError("That is not your current password.", "currentPassword");
  }
  if (input.newPassword !== input.confirmPassword) {
    throw new ValidationError("The two new passwords do not match.", "confirmPassword");
  }
  if (input.newPassword === input.currentPassword) {
    throw new ValidationError("The new password must be different.", "newPassword");
  }

  const policy = checkPasswordPolicy(input.newPassword, {
    minLength: options.minLength ?? 12,
  });
  if (!policy.ok) {
    throw new ValidationError(policy.problems.join(" "), "newPassword");
  }

  const hash = await hashPassword(input.newPassword);
  await db.execute(sql`
    UPDATE auth."user"
       SET password_hash = ${hash}, must_change_password = false,
           failed_attempts = 0, locked_until = NULL
     WHERE id = ${principal.userId}
  `);

  await db.execute(sql`
    UPDATE auth.session SET revoked_at = now()
     WHERE user_id = ${principal.userId} AND revoked_at IS NULL AND id <> ${principal.sessionId}
  `);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.PASSWORD_CHANGED,
    entityType: "user",
    entityId: principal.userId,
    // The passwords themselves never reach here; the redactor would strip them
    // anyway, but there is nothing to strip.
    newValues: { by: "self", otherSessionsRevoked: true },
  });
}

export interface EnrolmentChallenge {
  deviceId: string;
  /** The shared secret, for typing in by hand where a camera is not available. */
  secret: string;
  /** otpauth:// URI for a QR code. */
  uri: string;
  /** True when the platform key is a development default rather than a real one. */
  usingDevelopmentKey: boolean;
}

/**
 * Starts enrolling an authenticator app.
 *
 * The device row is written immediately but left `confirmed_at IS NULL`, so it
 * cannot satisfy a sign-in until a code from it has been checked. An unconfirmed
 * row that never gets confirmed is harmless and is replaced by the next attempt.
 *
 * The secret is encrypted at rest because TOTP needs it back to verify a code —
 * unlike a password, it cannot be hashed one-way.
 */
export async function beginMfaEnrolment(
  db: Executor,
  principal: Principal,
  options: { label?: string; issuer?: string } = {},
): Promise<EnrolmentChallenge> {
  const confirmed = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM auth.mfa_device
     WHERE user_id = ${principal.userId} AND confirmed_at IS NOT NULL
  `);
  if ((confirmed.rows?.[0]?.count ?? 0) > 0) {
    throw new ConflictError(
      "An authenticator is already enrolled on this account. An administrator has to remove it " +
        "before a new one can be set up, and that removal is recorded.",
    );
  }

  const secret = generateSecret();
  const label = options.label?.trim() || "Authenticator app";

  // Any earlier unconfirmed attempt is abandoned: keeping several half-finished
  // secrets alive widens the window in which one of them could be guessed.
  await db.execute(sql`
    DELETE FROM auth.mfa_device WHERE user_id = ${principal.userId} AND confirmed_at IS NULL
  `);

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO auth.mfa_device (user_id, type, label, secret_enc)
    VALUES (${principal.userId}, 'totp', ${label}, ${encryptSecret(secret)})
    RETURNING id
  `);

  return {
    deviceId: created.rows![0]!.id,
    secret,
    uri: otpauthUri({
      secret,
      accountName: principal.email,
      issuer: options.issuer ?? "CAC Internal Platform",
    }),
    // Surfaced rather than hidden: on a development machine the encryption key is
    // a known default, and an operator should be told that before they treat the
    // stored secret as protected.
    usingDevelopmentKey: !hasProductionKey(),
  };
}

export interface EnrolmentResult {
  /** Shown once. Each one works a single time, in place of a code. */
  recoveryCodes: string[];
}

/**
 * Confirms enrolment with a code from the new device, and issues recovery codes.
 *
 * Confirming with a real code is the whole point: it proves the secret was
 * actually transferred, rather than that a QR code was displayed. Without it,
 * every account would be flagged as protected by a device nobody ever scanned.
 */
export async function confirmMfaEnrolment(
  db: Executor,
  principal: Principal,
  deviceId: string,
  code: string,
  context?: AuditContext,
): Promise<EnrolmentResult> {
  const found = await db.execute<{ secret_enc: string; confirmed_at: string | null }>(sql`
    SELECT secret_enc, confirmed_at FROM auth.mfa_device
     WHERE id = ${deviceId} AND user_id = ${principal.userId}
     FOR UPDATE
  `);
  const device = found.rows?.[0];
  if (!device) throw new NotFoundError("That enrolment has expired. Start again.");
  if (device.confirmed_at) throw new ConflictError("This device is already confirmed.");

  if (!verifyTotp(decryptSecret(device.secret_enc), code)) {
    throw new ValidationError(
      "That code is not right. Check the clock on your phone is accurate, and try the current code.",
      "code",
    );
  }

  const { codes, hashes } = generateRecoveryCodes();

  await db.execute(sql`
    UPDATE auth.mfa_device SET confirmed_at = now(), last_used_at = now() WHERE id = ${deviceId}
  `);
  // Any codes from a previous device are void: they were a way in to an account
  // whose second factor has just changed.
  await db.execute(sql`DELETE FROM auth.recovery_code WHERE user_id = ${principal.userId}`);
  for (const hash of hashes) {
    await db.execute(sql`
      INSERT INTO auth.recovery_code (user_id, code_hash) VALUES (${principal.userId}, ${hash})
    `);
  }

  // The current session has just proved possession of the device, so it counts as
  // having satisfied MFA. Making the user sign in again here would be theatre.
  await db.execute(sql`
    UPDATE auth.session SET mfa_satisfied_at = now() WHERE id = ${principal.sessionId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.MFA_ENROLLED,
    entityType: "user",
    entityId: principal.userId,
    newValues: { deviceId, recoveryCodesIssued: codes.length },
  });

  return { recoveryCodes: codes };
}

export interface MfaStatus {
  enrolled: boolean;
  label: string | null;
  confirmedAt: Date | string | null;
  lastUsedAt: Date | string | null;
  recoveryCodesRemaining: number;
  /** A pending enrolment that was started and not finished. */
  pendingDeviceId: string | null;
  required: boolean;
}

export async function getMfaStatus(db: Executor, principal: Principal): Promise<MfaStatus> {
  const device = await db.execute<{
    id: string;
    label: string;
    confirmed_at: Date | string | null;
    last_used_at: Date | string | null;
  }>(sql`
    SELECT id, label, confirmed_at, last_used_at FROM auth.mfa_device
     WHERE user_id = ${principal.userId}
     ORDER BY confirmed_at NULLS LAST, created_at DESC
  `);
  const rows = device.rows ?? [];
  const active = rows.find((row) => row.confirmed_at !== null);
  const pending = rows.find((row) => row.confirmed_at === null);

  const codes = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM auth.recovery_code
     WHERE user_id = ${principal.userId} AND used_at IS NULL
  `);

  const enforced = await db.execute<{ mfa_enforced: boolean }>(
    sql`SELECT mfa_enforced FROM auth."user" WHERE id = ${principal.userId}`,
  );

  return {
    enrolled: Boolean(active),
    label: active?.label ?? null,
    confirmedAt: active?.confirmed_at ?? null,
    lastUsedAt: active?.last_used_at ?? null,
    recoveryCodesRemaining: codes.rows?.[0]?.count ?? 0,
    pendingDeviceId: pending?.id ?? null,
    required: enforced.rows?.[0]?.mfa_enforced ?? true,
  };
}
