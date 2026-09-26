/**
 * Every capability gates something.
 *
 * The end-to-end audit found seven of 127 keys checked nowhere in the application. Each was a line
 * in `docs/RBAC_MATRIX.md` — the document somebody reads to decide who may do what — describing a
 * control that did not exist. That is worse than a missing feature: it is a false statement about
 * the system's security, and it reads exactly like a true one.
 *
 * `hardening.test.ts` already proves every capability is *granted* to a role. This proves the other
 * half: that something *checks* it. The two together mean a capability in the matrix is real at both
 * ends.
 *
 * Run by `pnpm check:capabilities`, beside the route-guard audit.
 *
 * A capability may be listed in `UNCHECKED` with a reason. There should be very few, and each should
 * be uncomfortable to write.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Capabilities that legitimately gate nothing in code, with the reason. */
const UNCHECKED = new Map([]);

const SEARCH = [
  join(root, "apps", "staff", "src"),
  join(root, "packages", "core", "src"),
];

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

const rbac = await readFile(join(root, "packages", "db", "src", "rbac.ts"), "utf8");

// The catalogue, read out of the PERMISSIONS block rather than imported: this script runs without a
// build step, and the shape it depends on is a literal.
const keys = [...rbac.matchAll(/\["([a-z][a-z0-9_.]*\.[a-z][a-z0-9_.]*)",\s*"/g)].map(
  (match) => match[1],
);

if (keys.length < 50) {
  console.error(
    `Only ${keys.length} capabilities were found in rbac.ts. The file's shape has changed and this ` +
      "check is no longer reading it — fix the pattern rather than trusting the result.",
  );
  process.exit(1);
}

let sources = "";
for (const directory of SEARCH) {
  for await (const path of walk(directory)) {
    if (!/\.(ts|tsx)$/.test(path)) continue;
    // A test proving a capability refuses is not the same as a feature checking it.
    if (path.includes(".test.")) continue;
    sources += await readFile(path, "utf8");
  }
}

const orphans = [];
for (const key of new Set(keys)) {
  if (UNCHECKED.has(key)) continue;
  if (!sources.includes(`"${key}"`)) orphans.push(key);
}

if (orphans.length > 0) {
  console.error(`${orphans.length} capabilit${orphans.length === 1 ? "y is" : "ies are"} checked nowhere:\n`);
  for (const key of orphans) console.error(`  ${key}`);
  console.error(
    "\nEach of these is a line in docs/RBAC_MATRIX.md describing a control that does not exist.\n" +
      "Either something should check it, or it should be removed from the catalogue — or, if it is\n" +
      "genuinely not checked in code, add it to UNCHECKED in this script with the reason.",
  );
  process.exit(1);
}

const exempt = [...UNCHECKED.entries()];
if (exempt.length > 0) {
  console.log("Checked nowhere, deliberately:");
  for (const [key, reason] of exempt) console.log(`  ${key} — ${reason}`);
  console.log("");
}

console.log(`All ${new Set(keys).size} capabilities gate something.`);
