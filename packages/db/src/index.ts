/**
 * Public surface of @cac/db.
 *
 * Deliberately excludes the migration runner and seed. Those are CLI
 * concerns — the running application has no business applying migrations,
 * and importing them here dragged a dynamic `new URL("../migrations/")` into
 * the Next.js bundle, which webpack cannot statically resolve.
 *
 * Import them from "@cac/db/migrate" and "@cac/db/seed" in scripts and tests.
 */
export * from "./client.js";
export * from "./rbac.js";
export * as schema from "./schema/index.js";
