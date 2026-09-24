import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import * as schema from "./schema/index.js";
import { DatabaseInUseError, claimDirectory, releaseDirectory } from "./lock.js";

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
 *
 * ## PGlite is single-writer, and that shapes everything below
 *
 * PGlite is an embedded database: the process that opens the data directory owns
 * it, exclusively. Two PGlite instances over one directory is not "slower", it is
 * a second, divergent database — writes land in one and reads come from the
 * other, and the symptom is a record that was definitely saved and definitely is
 * not there.
 *
 * Two consequences:
 *
 *  1. The instance is cached on `globalThis`, not in a module-level variable.
 *     Next.js compiles server components, server actions and route handlers into
 *     separate module layers, so a module-level `let instance` is instantiated
 *     more than once *inside a single process* — which is exactly how a user
 *     created by a server action fails to appear on the page that lists users.
 *     It also survives dev-server hot reloads, which otherwise leak an instance
 *     per edit until the directory locks up.
 *
 *  2. A CLI command cannot run against the same directory while the application
 *     is running. `lock.ts` detects that and says so in a sentence, and — just as
 *     importantly — tells it apart from a previous run that was killed and left
 *     its lock files behind, which it clears up instead of refusing.
 *
 * When this moves to hosted PostgreSQL both constraints disappear: `pg` pools
 * over TCP and any number of processes may connect. That is one of the reasons
 * the move is on the plan rather than optional (docs/OPEN_QUESTIONS.md,
 * Q-INFRA-1).
 */

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
  const url = process.env.DATABASE_URL;

  if (url && /^postgres(ql)?:\/\//.test(url)) {
    // Hosted Postgres. Imported lazily so local development never needs the
    // driver installed.
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url, max: 10 });
    return drizzle(pool, { schema }) as unknown as Database;
  }

  return openLocalDatabase();
}

async function openLocalDatabase(): Promise<Database> {
  // PGlite will not create intermediate directories for us.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(LOCAL_DATA_DIR, { recursive: true });

  // Throws DatabaseInUseError when a live process owns the directory, and clears
  // up after one that died without shutting down. See lock.ts for why that
  // distinction has to be drawn out here rather than by PostgreSQL itself.
  const { recovered } = await claimDirectory(LOCAL_DATA_DIR);
  if (recovered) {
    console.warn(
      "[db] The last session did not shut down cleanly. Cleared the stale lock files in " +
        `${LOCAL_DATA_DIR}; PostgreSQL will replay its write-ahead log on start.`,
    );
  }

  const state = cache();
  try {
    const pglite = new PGlite(LOCAL_DATA_DIR);
    await pglite.waitReady;
    state.pglite = pglite;
    return drizzlePglite(pglite, { schema });
  } catch (error) {
    // The native failure is an abort trap from inside the WASM module, with no
    // indication of the cause.
    throw new Error(
      `Could not open the local database at ${LOCAL_DATA_DIR}.\n\n` +
        "The directory exists but PostgreSQL would not start against it. If this persists the " +
        "directory may be damaged; it holds no production data at this stage of the project, so " +
        "deleting it and re-running the seed is a legitimate repair.\n\n" +
        "Set DATABASE_URL to a postgres:// connection string to use a real server instead.",
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

export async function closeDb(): Promise<void> {
  const state = cache();
  if (state.pglite) {
    await state.pglite.close();
    await releaseDirectory(LOCAL_DATA_DIR);
  }
  state.db = undefined;
  state.pglite = undefined;
  state.opening = undefined;
}

export { DatabaseInUseError };

export { schema };
