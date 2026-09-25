# CAC — Backup and Recovery

The promise this document exists to keep is not "there is a backup procedure". It is that **the
restore has been performed**, and that performing it again is a command anybody can run.

Two things do that:

- `packages/core/src/backup.test.ts` backs up a populated database, restores it into a separate
  instance and checks what came back — the rows, the encrypted columns, the database triggers and
  the numbering counters. It runs on every test run.
- `pnpm --filter @cac/db backup verify` performs a real restore of a real archive and reports
  what it found. It has been run; the output is at the end of this document.

A backup nobody has restored is a hope, and the usual way to discover that is the worst one.

---

## 1. What a backup is

`pnpm --filter @cac/db backup`

Two files per backup, in `.backups/` (override with `CAC_BACKUP_DIR`):

| File | What it is |
|---|---|
| `cac-<instant>.tar.gz` | A gzipped tar of the entire PostgreSQL data directory, taken from inside the engine so it is internally consistent. |
| `cac-<instant>.manifest.json` | When it was taken, the last migration applied, how many migrations, the archive's SHA-256, and row counts for fifteen tables worth eyeballing. |

The archive is a **physical** backup. That has one consequence worth stating plainly: it is
restorable by the same PostgreSQL major version and not by a different one. It is chosen anyway,
over a schema-and-data dump, because a physical copy cannot drift from the migrations — a logical
dump restored into a database built by a different migration sequence can succeed and be subtly
wrong.

The manifest exists so a restore can be *verified* rather than merely completed. The checksum is
checked before anything starts: a truncated archive that half-restores is worse than one that
refuses, because half a database is indistinguishable from a whole one until somebody looks for a
row that is not there.

### What is inside it, and what is not

The archive contains everything in the database, which is everything the platform keeps:
the ledger, the payroll, the case files, the audit trail, and the document library including the
stored original bytes of every uploaded file.

It does **not** contain the encryption key. NRIC numbers, bank account numbers and the
identification of people on an estate matter are stored as ciphertext, with the key held in the
secret manager and never in the database (see `docs/SECURITY_MODEL.md`). **A restore without the
key produces a database whose identity fields cannot be read.** The key is therefore part of the
backup regime and not part of the backup file — deliberately, because a backup that carries its
own key is a backup that decrypts itself if it is stolen.

> **Operational consequence.** Losing the key is unrecoverable for those columns even with every
> backup intact. Wherever the key lives, it needs its own custody arrangement, and that
> arrangement needs to be written down somewhere that is not this repository.

---

## 2. Taking a backup

```bash
pnpm --filter @cac/db backup
```

It takes the same lock the application takes on the data directory. A backup read while another
process is writing would archive a half-written page, and the lock is what prevents that — so the
command will refuse while the application is running against the same directory. That is correct
behaviour, not an inconvenience to work around.

**How often.** Unanswered, because it depends on where this runs (Q-INFRA-1). What can be said:
the platform's own recovery point is whatever was last taken, and the audit trail is the part
whose loss is least recoverable — every other record can in principle be reconstructed from
documents, and "who did what, when" cannot.

---

## 3. Verifying a backup — which is the part that matters

```bash
pnpm --filter @cac/db backup verify            # the newest backup
pnpm --filter @cac/db backup verify <path>     # a specific one
```

This performs an actual restore into a **separate, temporary** database, compares it against the
manifest, reports every difference, and then throws the temporary database away. It cannot touch
the live one — which is exactly what makes it safe to run as often as you like, and the reason it
is a routine command rather than an emergency one.

It exits non-zero when anything differs from the manifest, so it belongs in whatever runs on a
schedule.

### The checks the test performs that a naive restore test would not

`backup.test.ts` does not stop at counting rows. Three of its checks exist because a restore can
bring back data and still leave a broken database:

1. **The triggers.** A restore that returns rows but not the guards is a restore into a database
   that will let somebody edit the audit trail or rewrite a case timeline. The test proves both
   refuse, in the restored copy.
2. **The numbering counters.** `org.document_sequence_period` has to come back as it was, or the
   next case opened after a restore reissues a number that already exists. The test opens a case
   in the restored database and checks it does not collide.
3. **The ciphertext.** An encrypted column has to return byte-identical, or the key stops matching
   what is stored and nobody notices until a statutory filing needs the number.

---

## 4. Recovering for real

The commands above deliberately cannot overwrite a live database. Recovery is a deliberate act,
and these are its steps.

1. **Stop the application.** Every instance. PGlite is single-writer; a second process holding the
   directory is what the lock exists to detect, and starting a restore against a directory
   somebody else owns is how two half-databases are made.
2. **Verify the archive you intend to use**, before destroying anything:
   `pnpm --filter @cac/db backup verify <path>`. If it reports discrepancies, look at an earlier
   archive rather than proceeding.
3. **Move the current data directory aside** — do not delete it. `.data/cac` becomes
   `.data/cac.before-restore-<instant>`. Whatever went wrong, the state it went wrong in is
   evidence, and it is also the only copy of anything written since the backup.
4. **Restore in its place.** The archive is the data directory: unpack it to `.data/cac`, or start
   a PGlite instance with `loadDataDir` and let it write there.
5. **Confirm the encryption key** is the one that was in force when the backup was taken. If it is
   not, the identity columns will not decrypt, and that will be discovered at the worst moment
   rather than now.
6. **Run the migrations.** `pnpm --filter @cac/db migrate`. A restore from an older archive may be
   behind; the runner is idempotent and checksummed, and it will refuse if an applied migration
   has since been edited.
7. **Start one instance**, sign in, and check the three things that are cheapest to check and worst
   to get wrong: the audit trail's most recent entries, the document sequence numbers, and one
   encrypted field decrypting (an employee's NRIC through the screen that asks for a reason).
8. **Write down what was lost.** Everything between the backup and the failure is gone. Say so, in
   writing, to whoever needs to know — the alternative is somebody relying on an invoice that no
   longer exists.

---

## 5. If this moves to a hosted PostgreSQL

Q-INFRA-1 is unanswered, so this section is what changes rather than what to do.

- `dumpDataDir` is a PGlite facility. On a hosted server the equivalents are the provider's own
  snapshots (physical, fast, tied to the provider) and `pg_dump` (logical, portable, slower).
  **Take both.** A provider snapshot cannot be restored anywhere else; a `pg_dump` can, and that
  matters on the day the provider is the problem.
- The manifest idea survives unchanged and is worth keeping: `describeDatabase()` in
  `packages/db/src/backup.ts` produces it from any Drizzle handle, including one over a real
  server.
- `backup verify` needs a place to restore into. On a hosted provider that is a scratch database,
  and the command needs a connection string rather than a directory. The verification steps —
  checksum, migration count, row counts, triggers, sequences, ciphertext — are the same.
- Point-in-time recovery becomes available and changes the answer to "how often": with WAL
  archiving the recovery point is minutes rather than the last full backup. That is the single
  biggest improvement a hosted server buys here.

---

## 6. The restore, performed

Taken and verified on the development database, with the schema at migration 0025:

```
$ pnpm --filter @cac/db backup
Backup written: .backups/cac-2026-09-25T11-41-02-041Z.tar.gz
  schema        0025_case_document_guards.sql (26 migrations)
  size          4.80 MB
  sha256        66eb1ee24407463ae18cfaa8ba3c8581ca5e7156ddfe9aa065cebe20b21f7f74
  rows
    auth.role                      13
    auth.permission                130
    org.setting                    39
    org.document_sequence          19
    ...

$ pnpm --filter @cac/db backup verify
Restoring .backups/cac-2026-09-25T11-41-02-041Z.tar.gz into a temporary database…
  schema        0025_case_document_guards.sql (26 migrations)
  rows restored
    auth.role                      13
    auth.permission                130
    org.setting                    39
    org.document_sequence          19
    ...

Everything the manifest recorded came back. The restore is verified.
The temporary database has been discarded. The live one was never touched.
```

The development database holds only seeded reference data, so the row counts above are small. The
test suite exercises the same path against a populated database — an employee with an encrypted
NRIC, a case with parties and a valued asset, an audit trail and live sequence counters — and
checks each of them individually.

---

## 7. What is still open

- **Where this runs, and therefore what the backup target is** — Q-INFRA-1. Until it is answered
  there is no off-site copy, and a backup sitting beside the database it came from protects
  against a mistake but not against a fire.
- **How long backups are kept, and where.** A retention period is a policy decision with a PDPA
  dimension: a backup is personal data, and keeping it forever is its own exposure.
- **Custody of the encryption key**, which is not in the backup and without which part of a
  restore is unreadable.
