import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import * as schema from "./schema/index.js";

/**
 * One database client for every environment.
 *
 * Locally we run PGlite — real PostgreSQL compiled to WASM, persisted to a
 * file. No server to install, no container, no credentials, and crucially the
 * *same SQL dialect* as the hosted database we will move to. Migrations,
 * constraints and queries written now carry over unchanged; only the
 * connection string differs.
 *
 * Set DATABASE_URL to a postgres:// URL and this module switches to a pooled
 * node-postgres connection instead. That switch is deliberately the only code
 * change required to go from local to hosted.
 */

export type Database = ReturnType<typeof drizzlePglite<typeof schema>>;

let instance: Database | undefined;
let pglite: PGlite | undefined;

const LOCAL_DATA_DIR = process.env.PGLITE_DIR ?? ".data/cac";

export async function getDb(): Promise<Database> {
  if (instance) return instance;

  const url = process.env.DATABASE_URL;

  if (url && /^postgres(ql)?:\/\//.test(url)) {
    // Hosted Postgres. Imported lazily so local development never needs the
    // driver installed.
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url, max: 10 });
    instance = drizzle(pool, { schema }) as unknown as Database;
    return instance;
  }

  // PGlite will not create intermediate directories for us.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(LOCAL_DATA_DIR, { recursive: true });

  pglite = new PGlite(LOCAL_DATA_DIR);
  await pglite.waitReady;
  instance = drizzlePglite(pglite, { schema });
  return instance;
}

/** In-memory database for tests — fresh, isolated, no file on disk. */
export async function createTestDb(): Promise<{ db: Database; close: () => Promise<void> }> {
  const mem = new PGlite();
  await mem.waitReady;
  const db = drizzlePglite(mem, { schema });
  return { db, close: () => mem.close() };
}

export async function closeDb(): Promise<void> {
  if (pglite) await pglite.close();
  instance = undefined;
  pglite = undefined;
}

export { schema };
