import { sql } from "drizzle-orm";
import { getDb, closeDb } from "./client.js";

/** Read-only sanity check over a seeded database. Used after `pnpm db:seed`. */
async function main() {
  const db = await getDb();
  const one = async (q: ReturnType<typeof sql>) =>
    ((await db.execute<{ n: string }>(q)).rows?.[0]?.n ?? "0");

  console.log("roles              ", await one(sql`SELECT count(*)::text AS n FROM auth.role`));
  console.log("permissions        ", await one(sql`SELECT count(*)::text AS n FROM auth.permission`));
  console.log("role_permissions   ", await one(sql`SELECT count(*)::text AS n FROM auth.role_permission`));
  console.log("settings           ", await one(sql`SELECT count(*)::text AS n FROM org.setting`));
  console.log("settings to confirm", await one(sql`SELECT count(*)::text AS n FROM org.setting WHERE needs_review`));
  console.log("sequences          ", await one(sql`SELECT count(*)::text AS n FROM org.document_sequence`));

  const perRole = await db.execute<{ key: string; n: string }>(sql`
    SELECT r.key, count(rp.permission_id)::text AS n
    FROM auth.role r LEFT JOIN auth.role_permission rp ON rp.role_id = r.id
    GROUP BY r.key ORDER BY count(rp.permission_id) DESC
  `);
  console.log("\ncapabilities per role:");
  for (const r of perRole.rows ?? []) console.log(`  ${r.key.padEnd(30)} ${r.n}`);

  // The audit table must reject amendment even for the owner.
  await db.execute(sql`
    INSERT INTO audit.event (action, entity_type, actor_label)
    VALUES ('VERIFY', 'system', 'verify script')
  `);
  let blockedUpdate = false;
  let blockedDelete = false;
  try {
    await db.execute(sql`UPDATE audit.event SET action = 'TAMPERED' WHERE action = 'VERIFY'`);
  } catch {
    blockedUpdate = true;
  }
  try {
    await db.execute(sql`DELETE FROM audit.event WHERE action = 'VERIFY'`);
  } catch {
    blockedDelete = true;
  }
  console.log("\nguards:");
  console.log("  audit UPDATE blocked", blockedUpdate ? "yes" : "NO  <-- FAIL");
  console.log("  audit DELETE blocked", blockedDelete ? "yes" : "NO  <-- FAIL");

  let blockedEmail = false;
  try {
    await db.execute(sql`
      INSERT INTO auth."user" (email, password_hash, full_name)
      VALUES ('MixedCase@Example.com', 'x', 'Case Test')
    `);
  } catch {
    blockedEmail = true;
  }
  console.log("  uppercase email rejected", blockedEmail ? "yes" : "NO  <-- FAIL");

  await closeDb();
  const ok = blockedUpdate && blockedDelete && blockedEmail;
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
