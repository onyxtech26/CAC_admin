import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type Database } from "@cac/db";
import { runMigrations } from "@cac/db/migrate";
import { seed } from "@cac/db/seed";
import {
  DEFAULT_LOGIN_POLICY,
  completeMfa,
  login,
  resolvePrincipal,
  revokeAllSessions,
  revokeSession,
} from "./session.js";
import { hashPassword, hashToken, generateRecoveryCodes } from "./password.js";
import { encryptSecret } from "./secrets.js";
import { generateSecret, totp } from "./totp.js";

let db: Database;
let close: () => Promise<void>;

const PASSWORD = "correct-horse-battery-staple";

async function makeUser(email: string, opts: { roles?: string[] } = {}): Promise<string> {
  const hash = await hashPassword(PASSWORD);
  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO auth."user" (email, password_hash, full_name)
    VALUES (${email}, ${hash}, ${email}) RETURNING id
  `);
  const id = created.rows![0]!.id;
  for (const role of opts.roles ?? []) {
    await db.execute(sql`
      INSERT INTO auth.user_role (user_id, role_id)
      SELECT ${id}, id FROM auth.role WHERE key = ${role}
    `);
  }
  return id;
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  await runMigrations(db);
  await seed(db);
}, 60_000);

afterAll(async () => {
  await close();
});

describe("login", () => {
  it("issues a session for correct credentials", async () => {
    await makeUser("ok@cac.test");
    const result = await login(db, "ok@cac.test", PASSWORD);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.token).toBeTruthy();
    expect(result.mfaRequired).toBe(false);
  });

  it("normalises the email so case and padding do not matter", async () => {
    await makeUser("case@cac.test");
    const result = await login(db, "  CASE@CAC.TEST  ", PASSWORD);
    expect(result.status).toBe("ok");
  });

  it("rejects a wrong password", async () => {
    await makeUser("wrong@cac.test");
    expect((await login(db, "wrong@cac.test", "not-the-password")).status).toBe("invalid");
  });

  it("gives an unknown account the same answer as a wrong password", async () => {
    // Anything else turns the login form into a staff-directory oracle.
    const unknown = await login(db, "nobody@cac.test", PASSWORD);
    await makeUser("known@cac.test");
    const known = await login(db, "known@cac.test", "not-the-password");
    expect(unknown.status).toBe("invalid");
    expect(known.status).toBe("invalid");
  });

  it("never stores the raw session token", async () => {
    await makeUser("hashed@cac.test");
    const result = await login(db, "hashed@cac.test", PASSWORD);
    if (result.status !== "ok") throw new Error("expected ok");

    const stored = await db.execute<{ token_hash: string }>(sql`
      SELECT token_hash FROM auth.session WHERE id = ${result.sessionId}
    `);
    const tokenHash = stored.rows![0]!.token_hash;
    expect(tokenHash).not.toBe(result.token);
    expect(tokenHash).toBe(hashToken(result.token));

    // The raw token must not appear anywhere in the row.
    const raw = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM auth.session
      WHERE id = ${result.sessionId} AND token_hash = ${result.token}
    `);
    expect(raw.rows![0]!.n).toBe("0");
  });

  it("locks the account after the configured number of failures", async () => {
    const policy = { ...DEFAULT_LOGIN_POLICY, maxFailedAttempts: 3, lockoutMinutes: 15 };
    await makeUser("lockme@cac.test");

    for (let i = 0; i < 3; i++) {
      expect((await login(db, "lockme@cac.test", "nope", policy)).status).toBe("invalid");
    }

    // Even the right password is refused while locked.
    const locked = await login(db, "lockme@cac.test", PASSWORD, policy);
    expect(locked.status).toBe("locked");
  });

  it("clears the failure count after a success", async () => {
    await makeUser("reset@cac.test");
    await login(db, "reset@cac.test", "nope");
    await login(db, "reset@cac.test", PASSWORD);
    const row = await db.execute<{ failed_attempts: number }>(sql`
      SELECT failed_attempts FROM auth."user" WHERE email = 'reset@cac.test'
    `);
    expect(Number(row.rows![0]!.failed_attempts)).toBe(0);
  });

  it("refuses a suspended account", async () => {
    await makeUser("suspended@cac.test");
    await db.execute(sql`UPDATE auth."user" SET status = 'suspended' WHERE email = 'suspended@cac.test'`);
    expect((await login(db, "suspended@cac.test", PASSWORD)).status).toBe("suspended");
  });

  it("records every attempt, successful or not", async () => {
    await makeUser("audited@cac.test");
    await login(db, "audited@cac.test", "nope");
    await login(db, "audited@cac.test", PASSWORD);

    const attempts = await db.execute<{ success: boolean; reason: string }>(sql`
      SELECT success, reason FROM auth.login_attempt
      WHERE email = 'audited@cac.test' ORDER BY created_at
    `);
    const rows = attempts.rows ?? [];
    expect(rows.length).toBe(2);
    expect(rows[0]!.success).toBe(false);
    expect(rows[0]!.reason).toBe("bad_credentials");
    expect(rows[1]!.success).toBe(true);
  });
});

describe("multi-factor authentication", () => {
  async function userWithTotp(email: string): Promise<{ userId: string; secret: string }> {
    const userId = await makeUser(email);
    const secret = generateSecret();
    await db.execute(sql`
      INSERT INTO auth.mfa_device (user_id, secret_enc, confirmed_at)
      VALUES (${userId}, ${encryptSecret(secret)}, now())
    `);
    return { userId, secret };
  }

  it("holds the session half-authenticated until a code is supplied", async () => {
    const { secret } = await userWithTotp("mfa@cac.test");

    const result = await login(db, "mfa@cac.test", PASSWORD);
    expect(result.status).toBe("mfa_required");
    if (result.status !== "mfa_required") return;

    // The session exists but must not be usable yet.
    const before = await resolvePrincipal(db, result.token);
    expect(before?.mfaSatisfied).toBe(false);

    const completed = await completeMfa(db, result.token, totp(secret));
    expect(completed.status).toBe("ok");
    if (completed.status !== "ok") return;

    // The token rotates. The old one is the one that may have been fixed or observed while the
    // session was half-authenticated, and it must not become a satisfied session.
    expect(completed.token).not.toBe(result.token);
    expect(await resolvePrincipal(db, result.token)).toBeNull();

    const after = await resolvePrincipal(db, completed.token);
    expect(after?.mfaSatisfied).toBe(true);
    // The same session row, so there is still exactly one thing to revoke.
    expect(after?.sessionId).toBe(result.sessionId);
  });

  it("rejects a wrong code and leaves the session half-authenticated", async () => {
    await userWithTotp("mfabad@cac.test");
    const result = await login(db, "mfabad@cac.test", PASSWORD);
    if (result.status !== "mfa_required") throw new Error("expected mfa_required");

    expect((await completeMfa(db, result.token, "000000")).status).toBe("invalid");
    expect((await resolvePrincipal(db, result.token))?.mfaSatisfied).toBe(false);
  });

  it("locks the account after too many wrong codes, and takes the session with it", async () => {
    await userWithTotp("mfalock@cac.test");
    const result = await login(db, "mfalock@cac.test", PASSWORD);
    if (result.status !== "mfa_required") throw new Error("expected mfa_required");

    // Five is `DEFAULT_LOGIN_POLICY.maxFailedAttempts`, the same counter and the same lock the
    // password step uses — it is the same account being attacked. Before this, the second factor had
    // no limit at all: three valid TOTP values per thirty-second window and ten recovery codes could
    // be guessed at leisure by somebody who already had the password.
    for (let attempt = 1; attempt < DEFAULT_LOGIN_POLICY.maxFailedAttempts; attempt += 1) {
      expect((await completeMfa(db, result.token, "000000")).status).toBe("invalid");
    }

    const last = await completeMfa(db, result.token, "000000");
    expect(last.status).toBe("locked");

    // The half-authenticated session is revoked too, so the lockout cannot simply be waited out with
    // the same cookie.
    expect(await resolvePrincipal(db, result.token)).toBeNull();
    expect((await login(db, "mfalock@cac.test", PASSWORD)).status).toBe("locked");
  });

  it("accepts a recovery code once and only once", async () => {
    const userId = await makeUser("recovery@cac.test");
    const secret = generateSecret();
    await db.execute(sql`
      INSERT INTO auth.mfa_device (user_id, secret_enc, confirmed_at)
      VALUES (${userId}, ${encryptSecret(secret)}, now())
    `);
    const { codes, hashes } = generateRecoveryCodes(2);
    for (const hash of hashes) {
      await db.execute(sql`
        INSERT INTO auth.recovery_code (user_id, code_hash) VALUES (${userId}, ${hash})
      `);
    }

    const first = await login(db, "recovery@cac.test", PASSWORD);
    if (first.status !== "mfa_required") throw new Error("expected mfa_required");
    expect((await completeMfa(db, first.token, codes[0]!)).status).toBe("ok");

    // The same code must not work a second time.
    const second = await login(db, "recovery@cac.test", PASSWORD);
    if (second.status !== "mfa_required") throw new Error("expected mfa_required");
    expect((await completeMfa(db, second.token, codes[0]!)).status).toBe("invalid");
  });

  it("will not accept the same authenticator code twice", async () => {
    const { secret } = await userWithTotp("replay@cac.test");

    const first = await login(db, "replay@cac.test", PASSWORD);
    if (first.status !== "mfa_required") throw new Error("expected mfa_required");
    const code = totp(secret);
    expect((await completeMfa(db, first.token, code)).status).toBe("ok");

    // The drift window accepts the step either side of now, so a code seen over a shoulder or lifted
    // from a phishing page used to keep working for about ninety seconds. The step it matched is
    // recorded, and a step at or below it is refused.
    const second = await login(db, "replay@cac.test", PASSWORD);
    if (second.status !== "mfa_required") throw new Error("expected mfa_required");
    expect((await completeMfa(db, second.token, code)).status).toBe("invalid");
  });

  it("accepts a recovery code typed without its hyphen", async () => {
    const userId = await makeUser("hyphen@cac.test");
    await db.execute(sql`
      INSERT INTO auth.mfa_device (user_id, secret_enc, confirmed_at)
      VALUES (${userId}, ${encryptSecret(generateSecret())}, now())
    `);
    const { codes, hashes } = generateRecoveryCodes(1);
    await db.execute(sql`
      INSERT INTO auth.recovery_code (user_id, code_hash) VALUES (${userId}, ${hashes[0]!})
    `);

    const result = await login(db, "hyphen@cac.test", PASSWORD);
    if (result.status !== "mfa_required") throw new Error("expected mfa_required");

    // The hyphen makes ten characters readable and is not part of the code. Hashing it meant
    // somebody who typed the ten characters was refused in the same words as a wrong code, at the
    // moment they had already lost their authenticator.
    const withoutHyphen = codes[0]!.replace("-", "");
    expect((await completeMfa(db, result.token, withoutHyphen)).status).toBe("ok");
  });

  it("records a second factor that succeeded, not only ones that failed", async () => {
    const { secret } = await userWithTotp("mfa-audited@cac.test");
    const result = await login(db, "mfa-audited@cac.test", PASSWORD);
    if (result.status !== "mfa_required") throw new Error("expected mfa_required");
    await completeMfa(db, result.token, totp(secret));

    const events = await db.execute<{ new_values: { using?: string } | null }>(sql`
      SELECT new_values FROM audit.event
       WHERE action = 'MFA_SATISFIED' ORDER BY created_at DESC LIMIT 1
    `);
    expect(events.rows?.[0]?.new_values?.using).toBe("authenticator");
  });

  it("spends a recovery code once even when two requests arrive together", async () => {
    const userId = await makeUser("recovery-race@cac.test");
    const secret = generateSecret();
    await db.execute(sql`
      INSERT INTO auth.mfa_device (user_id, secret_enc, confirmed_at)
      VALUES (${userId}, ${encryptSecret(secret)}, now())
    `);
    const { codes, hashes } = generateRecoveryCodes(1);
    await db.execute(sql`
      INSERT INTO auth.recovery_code (user_id, code_hash) VALUES (${userId}, ${hashes[0]!})
    `);

    const one = await login(db, "recovery-race@cac.test", PASSWORD);
    const two = await login(db, "recovery-race@cac.test", PASSWORD);
    if (one.status !== "mfa_required" || two.status !== "mfa_required") {
      throw new Error("expected mfa_required");
    }

    // Both posts of the same single-use code, at once.
    //
    // What this proves, honestly: that one of the two is refused. It does not prove the row lock,
    // because PGlite holds a single connection and serialises the two transactions — the race the
    // lock exists for cannot be reproduced here at all. The lock is in the code and reviewable; this
    // test covers the logic around it. Against a real PostgreSQL the same test would exercise both.
    const results = await Promise.all([
      completeMfa(db, one.token, codes[0]!),
      completeMfa(db, two.token, codes[0]!),
    ]);

    expect(results.filter((row) => row.status === "ok")).toHaveLength(1);

    const spent = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM auth.recovery_code
       WHERE user_id = ${userId} AND used_at IS NOT NULL
    `);
    expect(Number(spent.rows![0]!.n)).toBe(1);
  });

  it("requires an authenticator when the account says so, and lets nothing else through", async () => {
    // `mfa_enforced` was written by the user screen, shown on /account, and enforced nowhere: with no
    // device enrolled the account signed straight in and reached everything it had a capability for.
    const userId = await makeUser("enforced@cac.test", { roles: ["ACCOUNTANT"] });
    await db.execute(sql`UPDATE auth."user" SET mfa_enforced = true WHERE id = ${userId}`);

    const result = await login(db, "enforced@cac.test", PASSWORD);
    // There is no device, so there is no code to ask for; the session is usable only to enrol one.
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const principal = await resolvePrincipal(db, result.token);
    expect(principal?.mustEnrolMfa).toBe(true);

    // Enrolling clears it, and nothing else does.
    await db.execute(sql`
      INSERT INTO auth.mfa_device (user_id, secret_enc, confirmed_at)
      VALUES (${userId}, ${encryptSecret(generateSecret())}, now())
    `);
    expect((await resolvePrincipal(db, result.token))?.mustEnrolMfa).toBe(false);
  });

  it("requires one for a role the settings say must have it, flag or no flag", async () => {
    // `security.mfa_required_roles` is seeded with the six roles SECURITY_MODEL.md calls mandatory and
    // was read by nothing at all. Unticking the per-user flag for a director must not be a way around
    // the firm's own policy.
    const userId = await makeUser("rolemfa@cac.test", { roles: ["DIRECTOR"] });
    await db.execute(sql`UPDATE auth."user" SET mfa_enforced = false WHERE id = ${userId}`);

    const result = await login(db, "rolemfa@cac.test", PASSWORD);
    if (result.status !== "ok") throw new Error("expected ok");
    expect((await resolvePrincipal(db, result.token))?.mustEnrolMfa).toBe(true);

    // Somebody whose role is not on the list, and whose flag is off, is not asked.
    const other = await makeUser("noroleneeded@cac.test", { roles: ["EMPLOYEE"] });
    await db.execute(sql`UPDATE auth."user" SET mfa_enforced = false WHERE id = ${other}`);
    const second = await login(db, "noroleneeded@cac.test", PASSWORD);
    if (second.status !== "ok") throw new Error("expected ok");
    expect((await resolvePrincipal(db, second.token))?.mustEnrolMfa).toBe(false);
  });
});

describe("what the sign-in page gives away, and what it counts", () => {
  it("does not tell a stranger that an account is suspended or locked", async () => {
    const userId = await makeUser("quiet@cac.test");
    await db.execute(sql`UPDATE auth."user" SET status = 'suspended' WHERE id = ${userId}`);

    // The state of an account is disclosed only to somebody who proved they hold its password. These
    // checks used to run before the password was verified, so any junk password confirmed that the
    // address was real and told you what had happened to it.
    expect((await login(db, "quiet@cac.test", "not-the-password")).status).toBe("invalid");
    expect((await login(db, "quiet@cac.test", PASSWORD)).status).toBe("suspended");

    await db.execute(sql`UPDATE auth."user" SET status = 'active' WHERE id = ${userId}`);
  });

  it("ends the live sessions of an account that gets locked", async () => {
    const userId = await makeUser("lockedout@cac.test");
    const result = await login(db, "lockedout@cac.test", PASSWORD);
    if (result.status !== "ok") throw new Error("expected ok");
    expect(await resolvePrincipal(db, result.token)).not.toBeNull();

    // Suspension revoked sessions; locking did not. So an account locked *because somebody was
    // guessing at it* carried on working in whatever browser was already signed in.
    await db.execute(sql`
      UPDATE auth."user" SET locked_until = now() + interval '15 minutes' WHERE id = ${userId}
    `);
    expect(await resolvePrincipal(db, result.token)).toBeNull();
  });

  it("refuses an address that has been guessing, whoever it claims to be", async () => {
    const ctx = { ip: "203.0.113.7" };
    const policy = { ...DEFAULT_LOGIN_POLICY, maxFailedFromOneAddress: 4 };

    // A different account each time: the per-account lock sees one failure each and does nothing,
    // which is exactly how a password spray works. `auth.login_attempt` recorded every one of these
    // and nothing ever read the table.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await login(db, `spray${attempt}@cac.test`, "guess", policy, ctx);
    }

    const blocked = await login(db, "someoneelse@cac.test", "guess", policy, ctx);
    expect(blocked.status).toBe("locked");

    // Another address is unaffected.
    const elsewhere = await login(db, "someoneelse@cac.test", "guess", policy, { ip: "203.0.113.8" });
    expect(elsewhere.status).toBe("invalid");
  });
});

describe("session lifecycle", () => {
  it("resolves a principal with capabilities from its roles", async () => {
    await makeUser("principal@cac.test", { roles: ["ACCOUNTANT"] });
    const result = await login(db, "principal@cac.test", PASSWORD);
    if (result.status !== "ok") throw new Error("expected ok");

    const principal = await resolvePrincipal(db, result.token);
    expect(principal).not.toBeNull();
    expect(principal!.email).toBe("principal@cac.test");
    expect(principal!.roles).toContain("ACCOUNTANT");
    expect(principal!.capabilities.has("accounting.journal.post")).toBe(true);
  });

  it("returns null for a revoked session", async () => {
    await makeUser("revoked@cac.test");
    const result = await login(db, "revoked@cac.test", PASSWORD);
    if (result.status !== "ok") throw new Error("expected ok");

    await revokeSession(db, result.sessionId);
    expect(await resolvePrincipal(db, result.token)).toBeNull();
  });

  it("returns null for a made-up token", async () => {
    expect(await resolvePrincipal(db, "not-a-real-token")).toBeNull();
  });

  it("expires an idle session", async () => {
    await makeUser("idle@cac.test");
    const result = await login(db, "idle@cac.test", PASSWORD);
    if (result.status !== "ok") throw new Error("expected ok");

    // Backdate last_seen_at beyond the idle window.
    await db.execute(sql`
      UPDATE auth.session SET last_seen_at = now() - interval '45 minutes'
      WHERE id = ${result.sessionId}
    `);

    expect(await resolvePrincipal(db, result.token, { ...DEFAULT_LOGIN_POLICY, idleMinutes: 30 })).toBeNull();

    // And the session is revoked, not merely ignored.
    const row = await db.execute<{ revoked_at: string | null }>(sql`
      SELECT revoked_at FROM auth.session WHERE id = ${result.sessionId}
    `);
    expect(row.rows![0]!.revoked_at).not.toBeNull();
  });

  it("logs out everywhere but can keep the current session", async () => {
    await makeUser("many@cac.test");
    const a = await login(db, "many@cac.test", PASSWORD);
    const b = await login(db, "many@cac.test", PASSWORD);
    const c = await login(db, "many@cac.test", PASSWORD);
    if (a.status !== "ok" || b.status !== "ok" || c.status !== "ok") throw new Error("expected ok");

    const revoked = await revokeAllSessions(db, (await resolvePrincipal(db, c.token))!.userId, c.sessionId);
    expect(revoked).toBe(2);

    expect(await resolvePrincipal(db, a.token)).toBeNull();
    expect(await resolvePrincipal(db, b.token)).toBeNull();
    expect(await resolvePrincipal(db, c.token)).not.toBeNull();
  });

  it("cannot reinstate a revoked session, even with direct SQL", async () => {
    await makeUser("noundo@cac.test");
    const result = await login(db, "noundo@cac.test", PASSWORD);
    if (result.status !== "ok") throw new Error("expected ok");
    await revokeSession(db, result.sessionId);

    await expect(
      db.execute(sql`UPDATE auth.session SET revoked_at = NULL WHERE id = ${result.sessionId}`),
    ).rejects.toThrow(/cannot be reinstated/i);
  });
});

describe("audit trail", () => {
  it("records logins and failures", async () => {
    await makeUser("trail@cac.test");
    await login(db, "trail@cac.test", "nope");
    await login(db, "trail@cac.test", PASSWORD);

    const events = await db.execute<{ action: string }>(sql`
      SELECT e.action FROM audit.event e
      JOIN auth."user" u ON u.id = e.actor_user_id
      WHERE u.email = 'trail@cac.test' ORDER BY e.created_at
    `);
    const actions = (events.rows ?? []).map((r) => r.action);
    expect(actions).toContain("LOGIN_FAILED");
    expect(actions).toContain("LOGIN");
  });

  it("never records the submitted password", async () => {
    await makeUser("nopw@cac.test");
    await login(db, "nopw@cac.test", "super-secret-password-value");

    const hits = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM audit.event
      WHERE old_values::text LIKE '%super-secret-password-value%'
         OR new_values::text LIKE '%super-secret-password-value%'
    `);
    expect(hits.rows![0]!.n).toBe("0");

    const attempts = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM auth.login_attempt
      WHERE reason LIKE '%super-secret%'
    `);
    expect(attempts.rows![0]!.n).toBe("0");
  });
});
