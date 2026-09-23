import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, type Database } from "./client.js";

// fileURLToPath handles Windows drive letters and percent-encoding; slicing
// URL.pathname by hand does not.
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

const BREAKPOINT = "--> statement-breakpoint";
const LINE_SPLIT = /\r?\n/;

/**
 * Applies SQL migrations in filename order, once each.
 *
 * Deliberately hand-rolled rather than using drizzle-kit's migrator: we apply
 * hand-written guard migrations (triggers, CHECK constraints) alongside
 * generated ones, and a single ordered directory keeps the applied order
 * obvious to anyone reading the repository.
 *
 * Applied migrations are checksummed. Editing one after it has run is an error
 * rather than a silent no-op — the only safe correction is a new migration.
 */
export async function runMigrations(db?: Database): Promise<string[]> {
  const database = db ?? (await getDb());

  await database.execute(sql`
    CREATE TABLE IF NOT EXISTS public.__migration (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      checksum    text NOT NULL
    )
  `);

  if (!existsSync(MIGRATIONS_DIR)) return [];

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

  const applied = new Map<string, string>();
  const existing = await database.execute<{ name: string; checksum: string }>(
    sql`SELECT name, checksum FROM public.__migration`,
  );
  for (const row of existing.rows ?? []) applied.set(row.name, row.checksum);

  const run: string[] = [];

  for (const file of files) {
    const body = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const checksum = createHash("sha256").update(body).digest("hex");
    const previous = applied.get(file);

    if (previous !== undefined) {
      if (previous !== checksum) {
        throw new Error(
          `Migration ${file} has changed since it was applied. ` +
            `Migrations are immutable - add a new one instead of editing this.`,
        );
      }
      continue;
    }

    // PGlite executes one statement per call, so split on the breakpoint
    // drizzle-kit emits.
    const chunks = body.includes(BREAKPOINT) ? body.split(BREAKPOINT) : [body];

    for (const chunk of chunks) {
      if (!hasExecutableSql(chunk)) continue;
      await database.execute(sql.raw(chunk.trim()));
    }

    await database.execute(
      sql`INSERT INTO public.__migration (name, checksum) VALUES (${file}, ${checksum})`,
    );
    run.push(file);
  }

  return run;
}

/**
 * True when a chunk contains anything other than blank lines and whole-line
 * comments.
 *
 * Testing `chunk.trim().startsWith("--")` is the obvious approach and is
 * wrong: a chunk usually opens with a comment block explaining the statement
 * that follows, so that test skips real DDL. That bug silently left the
 * schema uncreated and the failure surfaced much later as
 * "schema auth does not exist".
 */
function hasExecutableSql(chunk: string): boolean {
  return chunk.split(LINE_SPLIT).some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("--");
  });
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  runMigrations()
    .then((applied) => {
      if (applied.length === 0) console.log("Database is up to date.");
      else console.log(`Applied ${applied.length} migration(s):`, applied.join(", "));
      process.exit(0);
    })
    .catch((error) => {
      console.error("Migration failed:", error);
      process.exit(1);
    });
}
