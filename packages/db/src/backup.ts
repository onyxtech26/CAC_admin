import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "./schema/index.js";
import type { Database } from "./client.js";

/**
 * Backup and restore.
 *
 * The requirement for this phase is not "write a backup procedure". It is that **the restore
 * is actually performed**, and it is performed on every test run: `backup.test.ts` takes a
 * populated database, backs it up, restores it into a fresh instance and checks that the rows,
 * the triggers, the append-only audit trail and the sequence counters all came back. A backup
 * nobody has restored is a hope, and the usual way to discover that is the worst one.
 *
 * **What a backup is here.** PGlite's `dumpDataDir()` produces a gzipped tar of the whole
 * PostgreSQL data directory — the same thing a filesystem-level backup of a real server would
 * be, taken from inside the engine so it is internally consistent. `new PGlite({ loadDataDir })`
 * starts from one. So a backup is one file, a restore is one file, and neither depends on a
 * schema dump that could drift from the migrations.
 *
 * That choice has a consequence worth stating: the archive is a *physical* backup, so it is
 * restorable by the same PostgreSQL major version and not by a different one. On a hosted
 * Postgres (which is where this goes if Q-INFRA-1 says so) the equivalent is the provider's own
 * snapshot plus `pg_dump` for a logical copy, and `docs/BACKUP_AND_RECOVERY.md` says what
 * changes.
 *
 * **Every backup carries a manifest.** Taken when, by which schema version, how large, and the
 * SHA-256 of the archive. A restore verifies the checksum before it starts: a truncated archive
 * that half-restores is worse than one that refuses.
 */

/**
 * Just enough of PGlite to take a dump.
 *
 * Structural rather than the concrete class, so a caller — a test, the CLI — can hand over an
 * instance without importing the engine itself. Nothing outside this package should need to.
 */
export interface DumpableDatabase {
  dumpDataDir(compression?: "gzip" | "auto" | "none"): Promise<File | Blob>;
}

export interface BackupManifest {
  /** ISO instant the backup was taken. */
  takenAt: string;
  /** The last migration applied to the database that was backed up. */
  schemaVersion: string;
  /** How many migrations had been applied, as a cheap consistency check. */
  migrationCount: number;
  archiveBytes: number;
  sha256: string;
  /** Row counts for the tables worth eyeballing after a restore. */
  rowCounts: Record<string, number>;
  /** What produced it, so a restore can refuse an archive from a different engine. */
  engine: "pglite";
  note: string;
}

const COUNTED_TABLES = [
  "auth.user",
  "auth.role",
  "auth.permission",
  "audit.event",
  "org.setting",
  "org.document_sequence",
  "accounting.journal",
  "accounting.invoice",
  "hr.employee",
  "hr.payslip",
  "estate.case",
  "estate.case_requirement",
  "estate.generated_document",
  "library.document",
  "library.chunk",
] as const;

/**
 * Reads the facts a manifest records.
 *
 * Separate from taking the archive so a restore can compare the same numbers afterwards, which
 * is what turns "the restore ran" into "the restore is verified".
 */
export async function describeDatabase(db: Database): Promise<{
  schemaVersion: string;
  migrationCount: number;
  rowCounts: Record<string, number>;
}> {
  const migrations = await db.execute<{ name: string; n: string }>(sql`
    SELECT max(name) AS name, count(*)::text AS n FROM public.__migration
  `);
  const row = migrations.rows?.[0];

  const rowCounts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    // Each table is counted separately so a schema that is missing one (an older backup) still
    // produces a usable manifest rather than failing the whole read.
    try {
      const count = await db.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM ${sql.raw(table)}`,
      );
      rowCounts[table] = Number(count.rows?.[0]?.n ?? 0);
    } catch {
      rowCounts[table] = -1;
    }
  }

  return {
    schemaVersion: row?.name ?? "none",
    migrationCount: Number(row?.n ?? 0),
    rowCounts,
  };
}

/**
 * Takes a backup of a PGlite database into a directory.
 *
 * Writes two files: the archive and its manifest, named by the instant. Returns both paths and
 * the manifest, so a caller can log exactly what it produced.
 *
 * `pglite` is the raw instance rather than the Drizzle handle, because dumping is an engine
 * operation. `db` is the Drizzle handle over the same instance, used only to read the manifest
 * facts.
 */
export async function backupDatabase(
  pglite: DumpableDatabase,
  db: Database,
  directory: string,
): Promise<{ archivePath: string; manifestPath: string; manifest: BackupManifest }> {
  await mkdir(directory, { recursive: true });

  const described = await describeDatabase(db);
  const dump = await pglite.dumpDataDir("gzip");
  const bytes = new Uint8Array(await dump.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const takenAt = new Date().toISOString();
  const stamp = takenAt.replace(/[:.]/g, "-");
  const archivePath = join(directory, `cac-${stamp}.tar.gz`);
  const manifestPath = join(directory, `cac-${stamp}.manifest.json`);

  const manifest: BackupManifest = {
    takenAt,
    schemaVersion: described.schemaVersion,
    migrationCount: described.migrationCount,
    archiveBytes: bytes.byteLength,
    sha256,
    rowCounts: described.rowCounts,
    engine: "pglite",
    note:
      "A physical backup of the PostgreSQL data directory, taken from inside the engine. " +
      "Restorable by the same PostgreSQL major version. See docs/BACKUP_AND_RECOVERY.md.",
  };

  await writeFile(archivePath, bytes);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return { archivePath, manifestPath, manifest };
}

export class RestoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RestoreError";
  }
}

export interface RestoreResult {
  pglite: PGlite;
  db: Database;
  manifest: BackupManifest | null;
  /** What the restored database actually contains. Compared against the manifest. */
  found: { schemaVersion: string; migrationCount: number; rowCounts: Record<string, number> };
  /** Differences between the manifest and the restored database. Empty is the good case. */
  discrepancies: string[];
  close: () => Promise<void>;
}

/**
 * Restores a backup into a fresh in-memory database and verifies it against the manifest.
 *
 * Deliberately *into a fresh instance*, not over the live one. A restore that overwrites the
 * running database is a restore nobody can rehearse, and rehearsing it is the whole point. What
 * comes back is a working handle the caller can query, compare and then throw away — or, for a
 * real recovery, dump and load into place with the live process stopped.
 *
 * The checksum is verified before anything starts. A truncated archive that half-restores is
 * worse than one that refuses, because the half is indistinguishable from the whole until
 * somebody looks for a row that is not there.
 */
export async function restoreDatabase(archivePath: string): Promise<RestoreResult> {
  const bytes = await readFile(archivePath);

  const manifestPath = join(
    dirname(archivePath),
    `${basename(archivePath).replace(/\.tar\.gz$/, "")}.manifest.json`,
  );
  let manifest: BackupManifest | null = null;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BackupManifest;
  } catch {
    // A restore from an archive with no manifest beside it is allowed and is reported as such:
    // it just cannot be verified against anything.
    manifest = null;
  }

  if (manifest) {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== manifest.sha256) {
      throw new RestoreError(
        `The archive does not match its manifest checksum. Expected ${manifest.sha256}, found ${sha256}. ` +
          "Nothing has been restored: a damaged archive that half-restores is worse than one that refuses.",
      );
    }
    if (manifest.engine !== "pglite") {
      throw new RestoreError(
        `This archive was produced by ${manifest.engine}, not pglite. See docs/BACKUP_AND_RECOVERY.md for restoring a hosted PostgreSQL backup.`,
      );
    }
  }

  let pglite: PGlite;
  try {
    pglite = new PGlite({ loadDataDir: new Blob([bytes]) });
    await pglite.waitReady;
  } catch (error) {
    throw new RestoreError(
      "PostgreSQL would not start against the restored data directory. The archive is either " +
        "damaged or was produced by a different PostgreSQL major version.",
      { cause: error },
    );
  }

  const db = drizzlePglite(pglite, { schema });
  const found = await describeDatabase(db);

  const discrepancies: string[] = [];
  if (manifest) {
    if (found.schemaVersion !== manifest.schemaVersion) {
      discrepancies.push(
        `schema version: manifest says ${manifest.schemaVersion}, restored database has ${found.schemaVersion}`,
      );
    }
    if (found.migrationCount !== manifest.migrationCount) {
      discrepancies.push(
        `migrations applied: manifest says ${manifest.migrationCount}, restored database has ${found.migrationCount}`,
      );
    }
    for (const [table, expected] of Object.entries(manifest.rowCounts)) {
      const actual = found.rowCounts[table];
      if (actual !== expected) {
        discrepancies.push(`${table}: manifest says ${expected} row(s), restored database has ${actual}`);
      }
    }
  }

  return {
    pglite,
    db,
    manifest,
    found,
    discrepancies,
    close: () => pglite.close(),
  };
}

/** The backups in a directory, newest first. For the recovery runbook and the console. */
export async function listBackups(
  directory: string,
): Promise<Array<{ archivePath: string; manifest: BackupManifest | null; bytes: number }>> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }

  const archives = names.filter((name) => name.endsWith(".tar.gz")).sort().reverse();
  const out: Array<{ archivePath: string; manifest: BackupManifest | null; bytes: number }> = [];

  for (const name of archives) {
    const archivePath = join(directory, name);
    const info = await stat(archivePath);
    let manifest: BackupManifest | null = null;
    try {
      manifest = JSON.parse(
        await readFile(join(directory, `${name.replace(/\.tar\.gz$/, "")}.manifest.json`), "utf8"),
      ) as BackupManifest;
    } catch {
      manifest = null;
    }
    out.push({ archivePath, manifest, bytes: info.size });
  }

  return out;
}
