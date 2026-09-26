import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createRestorableTestDb, type Database } from "@cac/db";
import { runMigrations } from "@cac/db/migrate";
import { seed } from "@cac/db/seed";
import {
  backupDatabase,
  describeDatabase,
  listBackups,
  restoreDatabase,
  RestoreError,
  type DumpableDatabase,
} from "@cac/db/backup";
import { hashPassword } from "./password.js";
import { resolveCapabilities, type Principal } from "./authz.js";
import { createEmployee } from "./people.js";
import { openCase } from "./cases.js";
import { recordAsset, recordParty } from "./case-file.js";

/**
 * Phase 13: the backup, and the restore actually being performed.
 *
 * The plan's words are that `docs/BACKUP_AND_RECOVERY.md` is written here "and the restore is
 * actually performed, not just documented". This file is how that promise is kept on every test
 * run rather than once, by hand, on a Thursday: a populated database is backed up, restored into
 * a separate instance, and then checked — the rows, the encrypted columns, the append-only audit
 * trail, the triggers and the numbering counters.
 *
 * The last two matter most and are the ones a naive restore test would miss. A restore that
 * brings back rows but not the triggers is a restore into a database that will happily let
 * somebody edit an issued letter. A restore that brings back rows but resets a sequence will
 * reissue a case number that already exists.
 */

let pglite: DumpableDatabase;
let db: Database;
let closeEngine: () => Promise<void>;
let directory: string;

let manager: Principal;
let caseId: string;
let employeeId: string;

async function makePrincipal(email: string, roles: string[], employee: string | null = null) {
  const hash = await hashPassword("correct-horse-battery-staple");
  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO auth."user" (email, password_hash, full_name, employee_id)
    VALUES (${email}, ${hash}, ${email}, ${employee}) RETURNING id
  `);
  const userId = created.rows![0]!.id;
  for (const role of roles) {
    await db.execute(sql`
      INSERT INTO auth.user_role (user_id, role_id)
      SELECT ${userId}, id FROM auth.role WHERE key = ${role}
    `);
  }
  return {
    userId,
    email,
    fullName: email,
    roles,
    capabilities: await resolveCapabilities(db, userId),
    employeeId: employee,
    sessionId: "00000000-0000-0000-0000-000000000000",
    mfaSatisfied: true,
    mustChangePassword: false,
    mustEnrolMfa: false,
  } satisfies Principal;
}

beforeAll(async () => {
  // The engine handle as well as the Drizzle one, because a backup is an engine operation.
  const created = await createRestorableTestDb();
  pglite = created.pglite;
  db = created.db;
  closeEngine = created.close;

  await runMigrations(db);
  await seed(db);

  directory = await mkdtemp(join(tmpdir(), "cac-backup-test-"));

  const hrAdmin = await makePrincipal("bk-hr@cac.test", ["HR_ADMIN"]);
  employeeId = (
    await createEmployee(db, hrAdmin, {
      fullName: "Aishah binti Rahman",
      joinedOn: "2026-02-02",
      basicSalary: "4500.00",
      // Encrypted at rest; the restore has to bring the ciphertext back intact or the
      // decryption key stops matching what is stored.
      nric: "880412145678",
    })
  ).id;

  manager = await makePrincipal("bk-manager@cac.test", ["CASE_MANAGER"], employeeId);

  caseId = (
    await openCase(db, manager, {
      matterType: "probate",
      title: "Estate of Tan Ah Kow",
      deceasedName: "Tan Ah Kow",
      deceasedId: "450612085432",
      dateOfDeath: "2026-04-11",
      openedOn: "2026-05-04",
      leadEmployeeId: employeeId,
    })
  ).id;

  await recordParty(db, manager, {
    caseId,
    role: "beneficiary",
    fullName: "Tan Mei Ling",
    identification: "920318086644",
    shareNote: "One third of the residue",
    shareSource: "Clause 4 of the will dated 3 March 2019",
  });
  await recordAsset(db, manager, {
    caseId,
    category: "land",
    description: "Double-storey terrace, Taman Ipoh Jaya",
    valuationAmount: "480000.00",
    valuationBasis: "Market comparison",
    valuationDate: "2026-05-20",
    valuationSource: "CAC valuation report 2026/041-V1",
  });
}, 180_000);

afterAll(async () => {
  await closeEngine();
  await rm(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
describe("taking a backup", () => {
  it("writes an archive and a manifest that describes what was in it", async () => {
    const { archivePath, manifestPath, manifest } = await backupDatabase(pglite, db, directory);

    expect(archivePath).toMatch(/\.tar\.gz$/);
    expect(manifest.archiveBytes).toBeGreaterThan(1000);
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.schemaVersion).toMatch(/^\d{4}_/);
    expect(manifest.migrationCount).toBeGreaterThan(20);
    expect(manifest.rowCounts["estate.case"]).toBe(1);
    expect(manifest.rowCounts["hr.employee"]).toBe(1);
    expect(manifest.rowCounts["audit.event"]).toBeGreaterThan(0);

    // The manifest on disk says the same thing.
    const written = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(written.sha256).toBe(manifest.sha256);
  }, 120_000);

  it("lists what has been taken, newest first", async () => {
    const backups = await listBackups(directory);
    expect(backups.length).toBeGreaterThan(0);
    expect(backups[0].manifest?.engine).toBe("pglite");
    expect(backups[0].bytes).toBe(backups[0].manifest!.archiveBytes);
  });

  it("returns nothing rather than throwing for a directory that does not exist", async () => {
    expect(await listBackups(join(directory, "nowhere"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("performing the restore", () => {
  it("refuses an archive that does not match its checksum", async () => {
    const { archivePath } = await backupDatabase(pglite, db, directory);
    const bytes = await readFile(archivePath);
    // Damage it, as a truncated transfer would.
    await writeFile(archivePath, bytes.subarray(0, bytes.length - 2048));

    await expect(restoreDatabase(archivePath)).rejects.toBeInstanceOf(RestoreError);
    await expect(restoreDatabase(archivePath)).rejects.toThrow(/Nothing has been restored/);
  }, 120_000);

  it("brings back the rows, and says so against the manifest", async () => {
    const { archivePath, manifest } = await backupDatabase(pglite, db, directory);
    const restored = await restoreDatabase(archivePath);

    try {
      // The check that matters: nothing differs from what was recorded at backup time.
      expect(restored.discrepancies).toEqual([]);
      expect(restored.found.schemaVersion).toBe(manifest.schemaVersion);
      expect(restored.found.rowCounts["estate.case"]).toBe(1);

      const cases = await restored.db.execute<{ case_no: string; deceased_name: string }>(
        sql`SELECT case_no, deceased_name FROM estate.case`,
      );
      expect(cases.rows![0].deceased_name).toBe("Tan Ah Kow");
      expect(cases.rows![0].case_no).toMatch(/^CASE/);
    } finally {
      await restored.close();
    }
  }, 180_000);

  it("brings back the encrypted columns as ciphertext, not as plain text", async () => {
    const { archivePath } = await backupDatabase(pglite, db, directory);
    const restored = await restoreDatabase(archivePath);

    try {
      const row = await restored.db.execute<{ nric_enc: string; nric_last4: string }>(
        sql`SELECT nric_enc, nric_last4 FROM hr.employee WHERE id = ${employeeId}`,
      );
      const stored = row.rows![0];
      // Intact and still encrypted: a restore that mangled the ciphertext would decrypt to
      // nothing, and nobody would notice until a statutory filing needed the number.
      expect(stored.nric_enc).not.toContain("880412145678");
      expect(stored.nric_enc.length).toBeGreaterThan(20);
      expect(stored.nric_last4).toBe("5678");
    } finally {
      await restored.close();
    }
  }, 180_000);

  it("brings back the triggers, not only the rows", async () => {
    const { archivePath } = await backupDatabase(pglite, db, directory);
    const restored = await restoreDatabase(archivePath);

    try {
      // A restore into a database whose guards are missing is a restore into a database that
      // will let somebody edit the audit trail. This is the check a naive restore test omits.
      await restored.db.execute(sql`
        INSERT INTO audit.event (action, entity_type, actor_label)
        VALUES ('RESTORE_PROBE', 'system', 'the restore test')
      `);
      await expect(
        restored.db.execute(
          sql`UPDATE audit.event SET action = 'TAMPERED' WHERE action = 'RESTORE_PROBE'`,
        ),
      ).rejects.toThrow();
      await expect(
        restored.db.execute(sql`DELETE FROM audit.event WHERE action = 'RESTORE_PROBE'`),
      ).rejects.toThrow();

      // And the estate guards, from a much later migration.
      const events = await restored.db.execute<{ id: string }>(
        sql`SELECT id FROM estate.case_event LIMIT 1`,
      );
      await expect(
        restored.db.execute(
          sql`UPDATE estate.case_event SET summary = 'rewritten' WHERE id = ${events.rows![0].id}`,
        ),
      ).rejects.toThrow(/append-only/);
    } finally {
      await restored.close();
    }
  }, 180_000);

  it("brings back the numbering counters, so nothing is reissued", async () => {
    const { archivePath } = await backupDatabase(pglite, db, directory);
    const restored = await restoreDatabase(archivePath);

    try {
      const before = await db.execute<{ key: string; period_key: string; next_value: string }>(
        sql`SELECT key, period_key, next_value::text FROM org.document_sequence_period ORDER BY key, period_key`,
      );
      const after = await restored.db.execute<{
        key: string;
        period_key: string;
        next_value: string;
      }>(
        sql`SELECT key, period_key, next_value::text FROM org.document_sequence_period ORDER BY key, period_key`,
      );
      expect(after.rows).toEqual(before.rows);

      // Numbering continues rather than restarting: the next case in the restored database does
      // not collide with one already issued.
      const existing = await restored.db.execute<{ case_no: string }>(
        sql`SELECT case_no FROM estate.case`,
      );
      const { openCase: openInRestored } = await import("./cases.js");
      const restoredManager = {
        ...manager,
        capabilities: await resolveCapabilities(restored.db, manager.userId),
      };
      const next = await openInRestored(restored.db, restoredManager, {
        matterType: "probate",
        title: "A matter opened after the restore",
        deceasedName: "Somebody else",
        openedOn: "2026-06-01",
        leadEmployeeId: employeeId,
      });
      expect(next.caseNo).not.toBe(existing.rows![0].case_no);
    } finally {
      await restored.close();
    }
  }, 180_000);

  it("restores without a manifest, and says it could not be verified", async () => {
    const { archivePath, manifestPath } = await backupDatabase(pglite, db, directory);
    await rm(manifestPath);

    const restored = await restoreDatabase(archivePath);
    try {
      expect(restored.manifest).toBeNull();
      expect(restored.discrepancies).toEqual([]);
      // Still a working database; just nothing to compare it against.
      expect(restored.found.rowCounts["estate.case"]).toBe(1);
    } finally {
      await restored.close();
    }
  }, 180_000);

  it("does not touch the database it was taken from", async () => {
    const before = await describeDatabase(db);
    const { archivePath } = await backupDatabase(pglite, db, directory);
    const restored = await restoreDatabase(archivePath);
    try {
      await restored.db.execute(sql`DELETE FROM estate.case_asset`);
      const after = await describeDatabase(db);
      // A restore into a separate instance is what makes rehearsing it safe.
      expect(after.rowCounts["estate.case"]).toBe(before.rowCounts["estate.case"]);
    } finally {
      await restored.close();
    }
  }, 180_000);
});
