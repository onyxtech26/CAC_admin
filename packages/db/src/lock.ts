import { readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Ownership of the local database directory.
 *
 * PGlite is an embedded PostgreSQL: whichever process opens the data directory
 * owns it exclusively. PostgreSQL itself enforces that with `postmaster.pid`, and
 * refuses to start while one is present.
 *
 * On a real server that is exactly right. In the WASM build it has a sharp edge:
 * PostgreSQL normally reads the pid out of that file and checks whether the
 * process is still alive, but inside WASM there is no process table to check
 * against, so *any* leftover file blocks startup. Stop the dev server with
 * Ctrl-C, or let it crash, and the next start fails with an abort trap from deep
 * inside the WASM module — the database is bricked until somebody works out which
 * file to delete.
 *
 * So we keep our own marker alongside it, recording the OS process id that opened
 * the directory. Before opening we can then tell the two cases apart:
 *
 *   - the recorded process is still running  -> genuinely in use, refuse clearly;
 *   - the recorded process is gone           -> it died without cleaning up, so
 *                                               clear the stale files and carry on.
 *
 * That is the same reasoning PostgreSQL applies on a normal host, done in the one
 * place that still has access to a process table.
 *
 * None of this applies to hosted PostgreSQL, where any number of clients connect
 * over TCP, or to the in-memory databases used by tests.
 */

/**
 * Kept *beside* the data directory, never inside it.
 *
 * `initdb` refuses to initialise a directory that is not empty, so a marker file
 * within it stops a first run dead — with an exit(1) from initdb that says
 * nothing about why.
 */
const ownerPathFor = (directory: string) => `${directory}.owner.json`;

/** Files PostgreSQL leaves behind that stop a subsequent start. */
const STALE_ARTEFACTS = ["postmaster.pid", ".s.PGSQL.5432.lock", ".s.PGSQL.5432.lock.out"];

interface Owner {
  pid: number;
  startedAt: string;
  /** For the error message: which command was holding it. */
  command: string;
}

export class DatabaseInUseError extends Error {
  constructor(
    readonly directory: string,
    readonly owner: Owner,
  ) {
    super(
      `The local database at ${directory} is already open by another process ` +
        `(pid ${owner.pid}, started ${owner.startedAt}${owner.command ? `, ${owner.command}` : ""}).\n\n` +
        "PGlite is an embedded database: only one process may own its data directory. Stop that " +
        "process and try again — typically the dev server, if you are running a command, or a " +
        "command, if you are starting the dev server.\n\n" +
        "Set DATABASE_URL to a postgres:// connection string to use a real server instead, which " +
        "has no such limit.",
    );
    this.name = "DatabaseInUseError";
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission and existence check without delivering
    // anything. EPERM means the process exists but belongs to someone else, which
    // still counts as alive.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Claims the directory, clearing up after a previous owner that crashed.
 *
 * Returns true when files were cleared, so the caller can say so — a silent
 * recovery would hide the fact that the last shutdown was unclean, and an unclean
 * PostgreSQL shutdown is worth knowing about even when WAL replay handles it.
 */
export async function claimDirectory(directory: string): Promise<{ recovered: boolean }> {
  const ownerPath = ownerPathFor(directory);

  if (existsSync(ownerPath)) {
    let owner: Owner | null = null;
    try {
      owner = JSON.parse(await readFile(ownerPath, "utf8")) as Owner;
    } catch {
      // An unreadable marker is treated as stale: it cannot identify a live owner,
      // and refusing to start over a corrupt one-line JSON file would be worse
      // than the risk it guards against.
      owner = null;
    }

    if (owner && owner.pid !== process.pid && isAlive(owner.pid)) {
      throw new DatabaseInUseError(directory, owner);
    }
  }

  // Either nobody owns it, we already do, or the last owner is gone.
  const recovered = await clearStaleArtefacts(directory);
  await writeOwner(ownerPath);

  // Best effort: a clean exit releases the claim so the next start does not have
  // to reason about it at all.
  registerRelease(ownerPath);

  return { recovered };
}

async function clearStaleArtefacts(directory: string): Promise<boolean> {
  let cleared = false;
  for (const name of STALE_ARTEFACTS) {
    const path = join(directory, name);
    if (existsSync(path)) {
      await rm(path, { force: true });
      cleared = true;
    }
  }
  return cleared;
}

async function writeOwner(ownerPath: string): Promise<void> {
  const owner: Owner = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    command: process.argv.slice(1, 3).join(" "),
  };
  await writeFile(ownerPath, JSON.stringify(owner), "utf8");
}

let releaseRegistered = false;

function registerRelease(ownerPath: string): void {
  if (releaseRegistered) return;
  releaseRegistered = true;

  const release = () => {
    try {
      // Synchronous: an exit handler has no time for a promise to settle, and
      // `require` is not available in an ES module, so rmSync is imported above.
      rmSync(ownerPath, { force: true });
    } catch {
      // Nothing useful to do while the process is on its way out. A leftover
      // marker is handled by the liveness check on the next start, which is
      // precisely why that check exists.
    }
  };

  process.once("exit", release);
  // Ctrl-C and a supervisor's TERM both need the default behaviour afterwards, so
  // the handler re-raises rather than swallowing the signal.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      release();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

/** Gives up the claim explicitly, for a clean `closeDb()`. */
export async function releaseDirectory(directory: string): Promise<void> {
  await rm(ownerPathFor(directory), { force: true });
}
