import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "./client.js";
import { runMigrations } from "./migrate.js";
import { seed } from "./seed.js";

/**
 * Break-glass console.
 *
 * The one path that does not go through a capability check, because it cannot:
 * it exists for when nobody can sign in. Its authorisation is possession of the
 * server — filesystem access to the database and the ability to run this command.
 * That is the same trust boundary as a database superuser, and pretending
 * otherwise by wrapping it in an in-app permission would be theatre.
 *
 * Every action here writes an audit row with the actor recorded as `console`, so
 * the trail distinguishes "an administrator did this in the application" from
 * "somebody with server access did this", which are very different events when
 * you are reading the log afterwards.
 *
 *   pnpm --filter @cac/db console reset-password name@conglomerate4u.com
 *   pnpm --filter @cac/db console list-users
 *   pnpm --filter @cac/db console grant name@conglomerate4u.com ACCOUNTANT
 *   pnpm --filter @cac/db console revoke name@conglomerate4u.com ACCOUNTANT
 *
 * `grant` is deliberately here as well as in the application. The application
 * refuses to let an administrator grant a role to themselves — without that,
 * managing roles would silently be the ability to do everything. Setting up the
 * very first accountant therefore needs either a second administrator or this.
 */

const USAGE = `
Usage: console <command> [args]

  list-users                      Accounts, status and roles
  list-roles                      Available role keys
  reset-password <email>           Issue a new one-time password
  grant <email> <ROLE>             Add a role
  revoke <email> <ROLE>            Remove a role
  unlock <email>                   Clear a failed-attempt lockout
`;

async function main() {
  const [, , command, ...args] = process.argv;
  const db = await getDb();
  await runMigrations(db);
  await seed(db);

  switch (command) {
    case "list-users": {
      const rows = await db.execute<{
        email: string;
        full_name: string;
        status: string;
        roles: string | null;
        locked_until: string | null;
      }>(sql`
        SELECT u.email, u.full_name, u.status, u.locked_until,
               string_agg(DISTINCT r.key, ', ' ORDER BY r.key) AS roles
          FROM auth."user" u
          LEFT JOIN auth.user_role ur ON ur.user_id = u.id
          LEFT JOIN auth.role r ON r.id = ur.role_id
         GROUP BY u.id ORDER BY u.full_name
      `);
      for (const row of rows.rows ?? []) {
        const locked = row.locked_until && new Date(row.locked_until) > new Date() ? " [LOCKED]" : "";
        console.log(`${row.email.padEnd(36)} ${row.status.padEnd(10)} ${row.roles ?? "no roles"}${locked}`);
      }
      break;
    }

    case "list-roles": {
      const rows = await db.execute<{ key: string; description: string }>(
        sql`SELECT key, description FROM auth.role ORDER BY key`,
      );
      for (const row of rows.rows ?? []) {
        console.log(`${row.key.padEnd(32)} ${row.description}`);
      }
      break;
    }

    case "reset-password": {
      const email = requireEmail(args[0]);
      const user = await findUser(db, email);

      const { randomBytes } = await import("node:crypto");
      const { hashPassword } = await import("@cac/core");
      const password = randomBytes(15).toString("base64url");

      await db.execute(sql`
        UPDATE auth."user"
           SET password_hash = ${await hashPassword(password)},
               must_change_password = true, failed_attempts = 0, locked_until = NULL
         WHERE id = ${user.id}
      `);
      await db.execute(sql`
        UPDATE auth.session SET revoked_at = now() WHERE user_id = ${user.id} AND revoked_at IS NULL
      `);
      await audit(db, user.id, "PASSWORD_RESET_COMPLETED", {
        email,
        by: "server console",
      });

      console.log(`\n  Email     ${email}`);
      console.log(`  Password  ${password}`);
      console.log(`\nShown once. Every session for this account has been ended, and the`);
      console.log(`password must be changed at the next sign-in.\n`);
      break;
    }

    case "grant":
    case "revoke": {
      const email = requireEmail(args[0]);
      const role = (args[1] ?? "").trim().toUpperCase();
      if (!role) fail("Name the role. `list-roles` shows them.");

      const user = await findUser(db, email);
      const found = await db.execute<{ id: string }>(
        sql`SELECT id FROM auth.role WHERE key = ${role}`,
      );
      if (!found.rows?.[0]) fail(`There is no role called ${role}.`);

      if (command === "grant") {
        await db.execute(sql`
          INSERT INTO auth.user_role (user_id, role_id) VALUES (${user.id}, ${found.rows![0]!.id})
          ON CONFLICT DO NOTHING
        `);
        await audit(db, user.id, "ROLE_ASSIGNED", { email, role, by: "server console" });
        console.log(`${role} granted to ${email}.`);
      } else {
        await db.execute(sql`
          DELETE FROM auth.user_role WHERE user_id = ${user.id} AND role_id = ${found.rows![0]!.id}
        `);
        await audit(db, user.id, "ROLE_REVOKED", { email, role, by: "server console" });
        console.log(`${role} revoked from ${email}.`);
      }
      break;
    }

    case "unlock": {
      const email = requireEmail(args[0]);
      const user = await findUser(db, email);
      await db.execute(sql`
        UPDATE auth."user" SET failed_attempts = 0, locked_until = NULL WHERE id = ${user.id}
      `);
      await audit(db, user.id, "USER_REACTIVATED", { email, by: "server console", unlocked: true });
      console.log(`${email} unlocked.`);
      break;
    }

    default:
      console.log(USAGE);
      await closeDb();
      process.exit(command ? 1 : 0);
  }

  await closeDb();
  process.exit(0);
}

async function findUser(
  db: Awaited<ReturnType<typeof getDb>>,
  email: string,
): Promise<{ id: string }> {
  const found = await db.execute<{ id: string }>(
    sql`SELECT id FROM auth."user" WHERE email = ${email}`,
  );
  if (!found.rows?.[0]) fail(`There is no account for ${email}.`);
  return found.rows![0]!;
}

async function audit(
  db: Awaited<ReturnType<typeof getDb>>,
  userId: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit.event (actor_user_id, actor_label, action, entity_type, entity_id, new_values, reason)
    VALUES (NULL, 'console', ${action}, 'user', ${userId}, ${JSON.stringify(payload)}::jsonb,
            'Performed from the server console, outside the application')
  `);
}

function requireEmail(value: string | undefined): string {
  const email = value?.trim().toLowerCase();
  if (!email) fail("Name the account by email address.");
  return email!;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((error) => {
    console.error("Console command failed:", error);
    process.exit(1);
  });
}
