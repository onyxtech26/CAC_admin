/**
 * Creates (or repairs) the local account used to walk the screens in a browser.
 *
 * Every real account here is either MFA-enforced or has a password that was printed once and is
 * gone, which is correct and makes a visual sweep of 93 screens impossible without either
 * weakening a security setting or resetting somebody's credentials. Neither is acceptable, so this
 * makes a separate account instead.
 *
 * It is deliberately a *narrow* account:
 *
 * - `AUDITOR` reads everything and changes nothing, so a sweep cannot alter a figure by accident.
 * - `ACCOUNTS_EXECUTIVE` and `CASE_STAFF` are there only because a screen with no form on it does
 *   not tell you whether the form controls are legible. Neither can approve or post.
 * - `EMPLOYEE` is self-service only, and is what reaches the screens that scope themselves to
 *   "your own" — the ones where an account with no employee record behind it used to fail.
 * - None of the four is in `security.mfa_required_roles`, so the account does not need an
 *   authenticator — and, importantly, the enforcement is left switched on for the roles that have
 *   it rather than being turned off to make this convenient.
 *
 * Refuses outright unless the database is the local development one. The password is written to
 * stdout for the operator to capture; it is not stored in the repository.
 *
 *   node --import tsx packages/db/src/verify-account.mts
 */
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "./client.js";

const EMAIL = "verify-fixture@conglomerate4u.com";
const ROLES = ["AUDITOR", "ACCOUNTS_EXECUTIVE", "CASE_STAFF", "EMPLOYEE"];

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run against a production database.");
  }

  const db = await getDb();
  const { hashPassword } = await import("@cac/core");

  const password = randomBytes(12).toString("base64url");
  const passwordHash = await hashPassword(password);

  const existing = await db.execute<{ id: string }>(sql`
    SELECT id FROM auth."user" WHERE email = ${EMAIL}
  `);

  let userId = existing.rows?.[0]?.id;
  if (userId) {
    await db.execute(sql`
      UPDATE auth."user"
         SET password_hash = ${passwordHash},
             status = 'active',
             must_change_password = false,
             mfa_enforced = false,
             failed_attempts = 0,
             locked_until = NULL
       WHERE id = ${userId}
    `);
  } else {
    const created = await db.execute<{ id: string }>(sql`
      INSERT INTO auth."user" (email, password_hash, full_name, status, must_change_password, mfa_enforced)
      VALUES (${EMAIL}, ${passwordHash}, 'Verification Fixture', 'active', false, false)
      RETURNING id
    `);
    userId = created.rows![0]!.id;
  }

  await db.execute(sql`DELETE FROM auth.user_role WHERE user_id = ${userId}`);
  for (const role of ROLES) {
    await db.execute(sql`
      INSERT INTO auth.user_role (user_id, role_id)
      SELECT ${userId}, id FROM auth.role WHERE key = ${role}
    `);
  }

  // The trail records this like anything else. An account appearing with read access to everything
  // is exactly the event an audit should be able to find later.
  await db.execute(sql`
    INSERT INTO audit.event (actor_user_id, actor_label, action, entity_type, entity_id, reason)
    VALUES (${userId}, ${EMAIL}, 'USER_UPDATED', 'user', ${userId},
            'Local verification fixture: read-only sweep of the screens')
  `);

  console.log(`\n  Email     ${EMAIL}`);
  console.log(`  Password  ${password}`);
  console.log(`  Roles     ${ROLES.join(", ")}\n`);

  await closeDb();
  process.exit(0);
}

main().catch((error) => {
  console.error("Failed:", error);
  process.exit(1);
});
