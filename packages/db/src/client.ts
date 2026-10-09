import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import * as schema from "./schema/index.js";
import type { DumpableDatabase } from "./backup.js";
import { DatabaseInUseError, claimDirectory, releaseDirectory } from "./lock.js";

const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

let isBootstrapped = false;
let bootstrapPromise: Promise<void> | null = null;

async function ensureDatabaseBootstrapped(db: Database): Promise<void> {
  if (isBootstrapped) return;
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    try {
      const { sql } = await import("drizzle-orm");
      const check = await db.execute(sql`
        SELECT 1 FROM auth."user" LIMIT 1
      `).catch(() => null);

      if (check?.rows?.length) {
        isBootstrapped = true;
        return;
      }

      // Concurrency guard: acquire Postgres advisory lock so concurrent serverless
      // functions do not race or block each other
      const lockRes = await db.execute<{ locked: boolean }>(sql`
        SELECT pg_try_advisory_lock(7421839) AS locked
      `).catch(() => null);
      const hasLock = lockRes?.rows?.[0]?.locked !== false;

      if (!hasLock) {
        // Another worker is actively migrating; yield and proceed
        await new Promise((r) => setTimeout(r, 2000));
        return;
      }

      try {
        console.log("[db] Initializing schema and seed data on fresh database...");
        const { runMigrations } = await import("./migrate.js");
        const { seed } = await import("./seed.js");
        await runMigrations(db);
        await seed(db);
        isBootstrapped = true;
        console.log("[db] Database bootstrap complete.");
      } finally {
        await db.execute(sql`SELECT pg_advisory_unlock(7421839)`).catch(() => null);
      }
    } catch (err) {
      console.warn("[db] Bootstrap check notice:", err);
    }
  })();
  return bootstrapPromise;
}

export type Database = ReturnType<typeof drizzlePglite<typeof schema>>;

/**
 * Anything that can run SQL: the pooled client, or a transaction handle from
 * `db.transaction()`.
 *
 * Business logic takes an Executor rather than a Database so a function can be
 * called either standalone or as one step inside a larger transaction. That
 * matters for the audit rule: an audit row must be written in the same
 * transaction as the change it describes, which is only possible if both take
 * the same handle.
 */
export type Executor = Pick<Database, "execute">;

/**
 * The cache lives on globalThis for the reasons in the header comment. The key is
 * namespaced so it cannot collide with anything else in the runtime.
 */
const CACHE = Symbol.for("cac.platform.database");

interface Cache {
  db?: Database;
  pglite?: PGlite;
  /** The in-flight open, so concurrent callers await one instance rather than racing to create several. */
  opening?: Promise<Database>;
}

function cache(): Cache {
  const holder = globalThis as unknown as Record<symbol, Cache>;
  holder[CACHE] ??= {};
  return holder[CACHE]!;
}

/**
 * Resolved against this package, not the current working directory.
 *
 * Otherwise every process gets its own database depending on where it was
 * launched from: the CLI seeds packages/db/.data while the Next.js app,
 * running in apps/staff, silently creates an empty one of its own — and the
 * administrator you just created does not exist.
 */
// Built from dirname rather than `new URL(..., import.meta.url)`: webpack
// statically analyses that form and tries to resolve the target as a module,
// which fails the Next.js build.
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const LOCAL_DATA_DIR = process.env.PGLITE_DIR ?? join(PACKAGE_DIR, "..", ".data", "cac");

export async function getDb(): Promise<Database> {
  const state = cache();
  if (state.db) return state.db;
  // A second caller arriving while the first is still opening waits for it,
  // rather than starting an open of its own against the same directory.
  state.opening ??= open();
  try {
    state.db = await state.opening;
    return state.db;
  } finally {
    state.opening = undefined;
  }
}

async function open(): Promise<Database> {
  const url =
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.STORAGE_URL;

  if (url && /^postgres(ql)?:\/\//.test(url)) {
    // Hosted Postgres (Neon, Supabase, Vercel Postgres, AWS RDS, etc.)
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { Pool } = await import("pg");
    const isLocal = url.includes("localhost") || url.includes("127.0.0.1");
    const pool = new Pool({
      connectionString: url,
      max: isServerless ? 5 : 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: isLocal ? false : { rejectUnauthorized: false },
    });
    const db = drizzle(pool, { schema }) as unknown as Database;
    await ensureDatabaseBootstrapped(db);
    return db;
  }

  return openLocalDatabase();
}

async function openLocalDatabase(): Promise<Database> {
  const targetDir =
    process.env.PGLITE_DIR ??
    (isServerless ? join(tmpdir(), "cac-pglite") : LOCAL_DATA_DIR);

  // PGlite will not create intermediate directories for us.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(targetDir, { recursive: true });

  if (!isServerless) {
    const { recovered } = await claimDirectory(targetDir);
    if (recovered) {
      console.warn(
        "[db] The last session did not shut down cleanly. Cleared the stale lock files in " +
          `${targetDir}; PostgreSQL will replay its write-ahead log on start.`,
      );
    }
  }

  const state = cache();
  try {
    const pglite = new PGlite(targetDir);
    await pglite.waitReady;
    state.pglite = pglite;
    const db = drizzlePglite(pglite, { schema });
    if (isServerless) {
      await ensureDatabaseBootstrapped(db);
    }
    return db;
  } catch (error) {
    if (isServerless) {
      console.error("[db] Serverless embedded database failed to start:", error);
    }
    throw new Error(
      `Could not open database at ${targetDir}.\n\n` +
        "Set DATABASE_URL or POSTGRES_URL to a postgres:// connection string in Vercel to connect a cloud PostgreSQL database.",
      { cause: error },
    );
  }
}

/**
 * In-memory database for tests — fresh, isolated, no file on disk.
 *
 * Not cached: each call is a separate database, which is what lets test files run
 * in parallel without seeing each other's rows.
 */
export async function createTestDb(): Promise<{ db: Database; close: () => Promise<void> }> {
  const mem = new PGlite();
  await mem.waitReady;
  const db = drizzlePglite(mem, { schema });
  return { db, close: () => mem.close() };
}

/**
 * A test database whose engine handle is returned as well.
 *
 * `createTestDb` deliberately hides the engine — a test should talk to Drizzle. The backup tests
 * are the exception: taking a backup is an engine operation, so they need the instance. Returned
 * as `DumpableDatabase` rather than `PGlite` so nothing outside this package has to import the
 * engine to use it.
 */
export async function createRestorableTestDb(): Promise<{
  pglite: DumpableDatabase;
  db: Database;
  close: () => Promise<void>;
}> {
  const mem = new PGlite();
  await mem.waitReady;
  const db = drizzlePglite(mem, { schema });
  return { pglite: mem, db, close: () => mem.close() };
}

export async function closeDb(): Promise<void> {
  const state = cache();
  const targetDir =
    process.env.PGLITE_DIR ??
    (isServerless ? join(tmpdir(), "cac-pglite") : LOCAL_DATA_DIR);
  if (state.pglite) {
    await state.pglite.close();
    if (!isServerless) {
      await releaseDirectory(targetDir);
    }
  }
  state.db = undefined;
  state.pglite = undefined;
  state.opening = undefined;
}

export { DatabaseInUseError };

export { schema };
