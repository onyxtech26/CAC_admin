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

    expect(await completeMfa(db, result.token, totp(secret))).toBe(true);

    const after = await resolvePrincipal(db, result.token);
    expect(after?.mfaSatisfied).toBe(true);
  });

  it("rejects a wrong code and leaves the session half-authenticated", async () => {
    await userWithTotp("mfabad@cac.test");
    const result = await login(db, "mfabad@cac.test", PASSWORD);
    if (result.status !== "mfa_required") throw new Error("expected mfa_required");

    expect(await completeMfa(db, result.token, "000000")).toBe(false);
    expect((await resolvePrincipal(db, result.token))?.mfaSatisfied).toBe(false);
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
    expect(await completeMfa(db, first.token, codes[0]!)).toBe(true);

    // The same code must not work a second time.
    const second = await login(db, "recovery@cac.test", PASSWORD);
    if (second.status !== "mfa_required") throw new Error("expected mfa_required");
    expect(await completeMfa(db, second.token, codes[0]!)).toBe(false);
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
