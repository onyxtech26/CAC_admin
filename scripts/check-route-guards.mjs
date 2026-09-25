#!/usr/bin/env node
/**
 * Every server-rendered route in the staff app is checked for a server-side guard.
 *
 * This is the structural half of "penetration-style permission testing". The runtime half —
 * a holder succeeds, a non-holder is refused — is in the core test suite, capability by
 * capability. What that cannot catch is a *new page* that simply forgets to ask: a screen that
 * renders a family's estate to anybody who guesses the URL, because the author copied a file and
 * deleted the wrong line. Hiding the nav item is presentation, not security, and the nav item is
 * exactly what an author remembers to add.
 *
 * So: walk `apps/staff/src/app`, and for every `page.tsx` and `route.ts` assert that it calls one
 * of the guards. Anything that must legitimately be public is listed below, by hand, with a
 * reason — a short list somebody has to edit deliberately.
 *
 *   node scripts/check-route-guards.mjs
 *
 * Exits non-zero with the offending files named, which is what makes it usable in CI.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const APP_DIR = join("apps", "staff", "src", "app");

/**
 * The guards a page uses. Each one redirects, which is right for something a browser navigated to.
 */
const REDIRECTING_GUARDS = ["requireCapability", "requireAnyCapability", "requirePrincipal"];

/**
 * A route handler serving a file legitimately does it differently, and this is worth stating
 * because at first glance it looks like a missing guard.
 *
 * Redirecting a PDF or CSV download to /login produces an HTML page with a .pdf filename, which is
 * useless to whoever asked and confusing to whatever asked on their behalf. So a handler reads the
 * principal itself and answers 401 or 403 with a sentence. That is a guard; it is just not the page
 * one. Both halves are required: reading the principal without checking a capability only proves
 * somebody is signed in.
 */
const HANDLER_GUARD = ["getPrincipal(", "capabilities.has("];

/**
 * Routes that are reachable without a session, each for a stated reason.
 *
 * Anything added here is a decision, not an oversight, and the reason is part of the entry.
 */
const PUBLIC = new Map([
  [join("login", "page.tsx"), "The sign-in page. Reachable by definition."],
  [join("login", "mfa", "page.tsx"), "The second factor. Guarded by the half-authenticated session it reads, not by a capability."],
  [join("denied", "page.tsx"), "Tells somebody they were refused. Showing it to a stranger reveals nothing."],
  [join("api", "logout", "route.ts"), "Ending a session must work even when the session is already invalid."],
  [join("api", "health", "route.ts"), "An uptime check has no session. Unauthenticated it answers only ok/not ok; the detail needs admin.settings.manage, which it checks itself."],
  ["page.tsx", "The dashboard. Guarded by the layout's requirePrincipal; see the note in the file."],
  ["layout.tsx", "Not a route."],
  ["not-found.tsx", "Not a route."],
  ["error.tsx", "Not a route."],
  ["global-error.tsx", "Not a route."],
]);

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

const failures = [];
const checked = [];
const exempt = [];

for await (const path of walk(APP_DIR)) {
  const name = path.split(sep).pop();
  if (name !== "page.tsx" && name !== "route.ts") continue;

  const key = relative(APP_DIR, path);
  if (PUBLIC.has(key)) {
    exempt.push(`${key} — ${PUBLIC.get(key)}`);
    continue;
  }

  const source = await readFile(path, "utf8");
  const guarded =
    REDIRECTING_GUARDS.some((guard) => source.includes(`${guard}(`)) ||
    HANDLER_GUARD.every((fragment) => source.includes(fragment));
  checked.push(key);
  if (!guarded) failures.push(key);
}

console.log(`Checked ${checked.length} route(s) in ${APP_DIR}.`);
console.log(`${exempt.length} deliberately public:`);
for (const line of exempt) console.log(`  ${line}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} route(s) have no server-side guard:`);
  for (const line of failures) console.error(`  ${line}`);
  console.error(
    "\nEach of these renders to anybody who reaches the URL. A page calls requireCapability or requireAnyCapability; a file-serving route handler reads getPrincipal() and checks capabilities.has() before answering. Otherwise add the file to PUBLIC in this script, with the reason it is public.",
  );
  process.exit(1);
}

console.log("\nEvery route is guarded server-side.");
