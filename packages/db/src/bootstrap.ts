import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "./client.js";
import { runMigrations } from "./migrate.js";
import { seed } from "./seed.js";

/**
 * Creates the first administrator.
 *
 * Deliberately a command rather than a seeded default account: a well-known
 * admin@cac / password pair sitting in the repository is how systems get
 * compromised on day one. The password is generated here, printed once, and
 * the account is flagged `must_change_password`.
 *
 *   pnpm --filter @cac/db bootstrap -- "Full Name" name@conglomerate4u.com
 */
async function main() {
  const [, , ...args] = process.argv;
  const fullName = args[0];
  const email = args[1]?.trim().toLowerCase();

  if (!fullName || !email) {
    console.error('Usage: bootstrap "Full Name" email@conglomerate4u.com');
    process.exit(1);
  }

  const db = await getDb();
  await runMigrations(db);
  await seed(db);

  const existing = await db.execute<{ id: string }>(sql`
    SELECT id FROM auth."user" WHERE email = ${email}
  `);
  if (existing.rows?.[0]) {
    console.error(`An account already exists for ${email}.`);
    process.exit(1);
  }

  // Imported here so @cac/db does not depend on @cac/core (which depends on it).
  const { hashPassword } = await import("@cac/core");
  const password = randomBytes(12).toString("base64url");
  const passwordHash = await hashPassword(password);

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO auth."user" (email, password_hash, full_name, must_change_password, mfa_enforced)
    VALUES (${email}, ${passwordHash}, ${fullName}, true, true)
    RETURNING id
  `);
  const userId = created.rows![0]!.id;

  await db.execute(sql`
    INSERT INTO auth.user_role (user_id, role_id)
    SELECT ${userId}, id FROM auth.role WHERE key = 'SUPER_ADMIN'
  `);

  await db.execute(sql`
    INSERT INTO audit.event (actor_user_id, actor_label, action, entity_type, entity_id, reason)
    VALUES (${userId}, ${email}, 'USER_CREATED', 'user', ${userId}, 'Bootstrap administrator')
  `);

  console.log("\nAdministrator created.\n");
  console.log(`  Email     ${email}`);
  console.log(`  Password  ${password}`);
  console.log(`  Role      SUPER_ADMIN`);
  console.log("\nThis password is shown once and is not stored anywhere in readable form.");
  console.log("Sign in, then change it and enrol an authenticator app.\n");
  console.log("Note: SUPER_ADMIN administers the platform. It deliberately cannot approve");
  console.log("invoices, post payroll or approve legal documents — that would defeat");
  console.log("maker/checker. Assign business roles separately.\n");
  process.exit(0);
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((error) => {
    console.error("Bootstrap failed:", error);
    process.exit(1);
  });
}
