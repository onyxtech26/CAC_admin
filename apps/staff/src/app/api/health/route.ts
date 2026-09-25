import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import {
  assistantFromEnv,
  embeddingProviderFromEnv,
  ocrFromEnv,
  scannerFromEnv,
} from "@cac/core";
import { getPrincipal } from "@/lib/auth";

/**
 * Whether the platform is working, and — to an administrator — what it is missing.
 *
 * Two answers from one route, deliberately.
 *
 * **Unauthenticated** it says only whether the database answered: `{"ok":true}` or `{"ok":false}`
 * with a 503. That is what a load balancer or an uptime check needs, and it is all a stranger
 * should learn. A health endpoint that volunteers the schema version, the migration count and the
 * list of integrations is a reconnaissance endpoint.
 *
 * **To somebody holding `admin.settings.manage`** it adds the detail worth having at three in the
 * morning: which migration the database is on, whether the counts look sane, and — the part that
 * matters most for this platform — which of the four configured-elsewhere dependencies are
 * actually present. Each of those is absent by design and refuses rather than pretending, so a
 * deployment that silently lost its scanner configuration would otherwise look identical to one
 * that never had it.
 *
 * No secret, no connection string and no key reaches either answer. What is reported about an
 * integration is its name and whether it is configured — never how.
 */
export async function GET() {
  const principal = await getPrincipal();
  const detailed = Boolean(principal?.capabilities.has("admin.settings.manage"));

  try {
    const db = await getDb();

    // The cheapest query that proves the connection and the schema are both there.
    const migrations = await db.execute<{ name: string; n: string }>(sql`
      SELECT max(name) AS name, count(*)::text AS n FROM public.__migration
    `);
    const row = migrations.rows?.[0];

    if (!detailed) {
      return NextResponse.json(
        { ok: true },
        { headers: { "cache-control": "no-store" } },
      );
    }

    const scanner = scannerFromEnv();
    const ocr = ocrFromEnv();
    const embedding = embeddingProviderFromEnv();
    const assistant = assistantFromEnv();

    const counts = await db.execute<{
      users: string;
      roles: string;
      settings_unset: string;
      quarantined: string;
      rules_approved: string;
    }>(sql`
      SELECT
        (SELECT count(*) FROM auth."user" WHERE status = 'active')::text AS users,
        (SELECT count(*) FROM auth.role)::text AS roles,
        (SELECT count(*) FROM org.setting WHERE needs_review AND value IS NULL)::text AS settings_unset,
        (SELECT count(*) FROM library.document WHERE scan_status = 'quarantined')::text AS quarantined,
        (SELECT count(*) FROM estate.requirement_rule WHERE status = 'approved')::text AS rules_approved
    `);
    const count = counts.rows?.[0];

    return NextResponse.json(
      {
        ok: true,
        database: {
          reachable: true,
          schemaVersion: row?.name ?? "none",
          migrationsApplied: Number(row?.n ?? 0),
        },
        counts: {
          activeUsers: Number(count?.users ?? 0),
          roles: Number(count?.roles ?? 0),
          settingsStillUnset: Number(count?.settings_unset ?? 0),
          documentsInQuarantine: Number(count?.quarantined ?? 0),
          approvedCaseRules: Number(count?.rules_approved ?? 0),
        },
        // Each of these refuses rather than pretending when it is absent. Reporting them here
        // is how a deployment that lost its configuration is told apart from one that never
        // had any.
        dependencies: {
          malwareScanner: { name: scanner.name, configured: scanner.isConfigured() },
          ocr: { name: ocr.name, configured: ocr.isConfigured() },
          embeddings: { name: embedding.name, configured: embedding.isConfigured() },
          caseAssistant: { name: assistant.name, configured: assistant.isConfigured() },
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    // The detail goes to the log, never to the response: a stack trace on a health endpoint is
    // an information leak, and the caller can act on "not ok" either way.
    console.error("[health] the database did not answer:", error);
    return NextResponse.json(
      { ok: false },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
