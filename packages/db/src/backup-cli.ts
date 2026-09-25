import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import * as schema from "./schema/index.js";
import { claimDirectory, releaseDirectory } from "./lock.js";
import { backupDatabase, listBackups, restoreDatabase } from "./backup.js";

/**
 * The backup and restore command.
 *
 *   pnpm --filter @cac/db backup            take a backup of the local database
 *   pnpm --filter @cac/db backup list       what has been taken
 *   pnpm --filter @cac/db backup verify     restore the newest backup and check it
 *   pnpm --filter @cac/db backup verify <path>
 *
 * `verify` is the one that matters and is why this exists as a command rather than only as a
 * test: it performs an actual restore of an actual archive and reports what came back. A backup
 * nobody has restored is a hope.
 *
 * The restore goes into a *separate, temporary* database and then throws it away. Nothing here
 * can overwrite the live one — recovering for real is a deliberate, documented act with the
 * application stopped, and `docs/BACKUP_AND_RECOVERY.md` sets it out step by step.
 */

const DATA_DIR = process.env.CAC_DATA_DIR ?? ".data/cac";
const BACKUP_DIR = process.env.CAC_BACKUP_DIR ?? ".backups";

async function withLocalDatabase<T>(
  fn: (pglite: PGlite, db: ReturnType<typeof drizzlePglite<typeof schema>>) => Promise<T>,
): Promise<T> {
  // The same lock the application takes: a backup read while another process is writing the
  // directory would produce an archive of a half-written page.
  const { recovered } = await claimDirectory(DATA_DIR);
  if (recovered) {
    console.warn("[backup] The previous session did not shut down cleanly; the lock was stale.");
  }
  const pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  try {
    return await fn(pglite, drizzlePglite(pglite, { schema }));
  } finally {
    await pglite.close();
    await releaseDirectory(DATA_DIR);
  }
}

async function take(): Promise<void> {
  const result = await withLocalDatabase((pglite, db) => backupDatabase(pglite, db, BACKUP_DIR));

  console.log(`Backup written: ${result.archivePath}`);
  console.log(`  schema        ${result.manifest.schemaVersion} (${result.manifest.migrationCount} migrations)`);
  console.log(`  size          ${(result.manifest.archiveBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  sha256        ${result.manifest.sha256}`);
  console.log("  rows");
  for (const [table, count] of Object.entries(result.manifest.rowCounts)) {
    console.log(`    ${table.padEnd(30)} ${count}`);
  }
  console.log(
    "\nA backup nobody has restored is a hope. Run `pnpm --filter @cac/db backup verify` now.",
  );
}

async function list(): Promise<void> {
  const backups = await listBackups(BACKUP_DIR);
  if (backups.length === 0) {
    console.log(`No backups in ${BACKUP_DIR}.`);
    return;
  }
  for (const backup of backups) {
    const when = backup.manifest?.takenAt ?? "unknown";
    const size = (backup.bytes / 1024 / 1024).toFixed(2);
    console.log(`${when}  ${size.padStart(8)} MB  ${backup.archivePath}`);
  }
}

async function verify(path?: string): Promise<void> {
  let archivePath = path;
  if (!archivePath) {
    const backups = await listBackups(BACKUP_DIR);
    if (backups.length === 0) {
      console.error(`No backups in ${BACKUP_DIR}. Take one first.`);
      process.exitCode = 1;
      return;
    }
    archivePath = backups[0].archivePath;
  }

  console.log(`Restoring ${archivePath} into a temporary database…`);
  const restored = await restoreDatabase(archivePath);

  try {
    console.log(`  schema        ${restored.found.schemaVersion} (${restored.found.migrationCount} migrations)`);
    console.log("  rows restored");
    for (const [table, count] of Object.entries(restored.found.rowCounts)) {
      console.log(`    ${table.padEnd(30)} ${count}`);
    }

    if (!restored.manifest) {
      console.warn(
        "\nNo manifest beside the archive, so nothing could be compared. The database started and was readable.",
      );
      return;
    }

    if (restored.discrepancies.length === 0) {
      console.log("\nEverything the manifest recorded came back. The restore is verified.");
    } else {
      console.error("\nThe restored database does not match the manifest:");
      for (const line of restored.discrepancies) console.error(`  - ${line}`);
      process.exitCode = 1;
    }
  } finally {
    await restored.close();
    console.log("The temporary database has been discarded. The live one was never touched.");
  }
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);

  switch (command ?? "take") {
    case "take":
      await take();
      break;
    case "list":
      await list();
      break;
    case "verify":
      await verify(argument);
      break;
    default:
      console.error(`Unknown command "${command}". Use take, list or verify.`);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  if (error instanceof Error && error.cause) console.error(error.cause);
  process.exitCode = 1;
});
