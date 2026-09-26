import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import { AUDIT, writeAudit } from "@cac/core";
import { getRequestContext, requireCapability } from "@/lib/auth";

/**
 * The audit trail as CSV.
 *
 * `audit.export` was granted to three roles and checked nowhere: there was no export control and no
 * route, so the capability was a line in the matrix that described nothing. This is the thing it
 * names.
 *
 * Two decisions worth stating.
 *
 * **The export is itself audited**, with the range and the number of rows. An export is the moment
 * the trail leaves the platform, which is exactly the event the trail should hold — and
 * `EXPORT_SENSITIVE` exists for it.
 *
 * **The old and new values are not included.** They are already redacted at write time, but a CSV of
 * every payload is a file of masked personal data and business figures, and the answer to "why was
 * this changed" is the reason column, which is included. Somebody who needs a payload can read the
 * row in the platform, where the access is itself recorded.
 */
export async function GET(request: Request) {
  const principal = await requireCapability("audit.export");
  const db = await getDb();

  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  if ((from && !ISO.test(from)) || (to && !ISO.test(to))) {
    return new Response("Dates are written as YYYY-MM-DD.", { status: 400 });
  }

  const rows = await db.execute<{
    created_at: string;
    action: string;
    entity_type: string;
    entity_id: string | null;
    actor_label: string | null;
    ip: string | null;
    reason: string | null;
    correlation_id: string | null;
  }>(sql`
    SELECT created_at, action, entity_type, entity_id, actor_label, host(ip) AS ip,
           reason, correlation_id
      FROM audit.event
     WHERE (${from ?? null}::date IS NULL OR created_at >= ${from ?? null}::date)
       AND (${to ?? null}::date IS NULL OR created_at < (${to ?? null}::date + 1))
     ORDER BY created_at
  `);

  const events = rows.rows ?? [];

  const header = [
    "when",
    "action",
    "entity type",
    "entity id",
    "actor",
    "ip",
    "reason",
    "correlation id",
  ];

  const body = events.map((event) => [
    new Date(event.created_at).toISOString(),
    event.action,
    event.entity_type,
    event.entity_id ?? "",
    event.actor_label ?? "",
    event.ip ?? "",
    event.reason ?? "",
    event.correlation_id ?? "",
  ]);

  const csv = [header, ...body].map((line) => line.map(csvCell).join(",")).join("\r\n");

  const context = await getRequestContext();
  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.EXPORT_SENSITIVE,
    entityType: "audit",
    entityId: null,
    newValues: { from: from ?? null, to: to ?? null, rows: events.length },
  });

  const name = `cac-audit-${from ?? "start"}-to-${to ?? "now"}.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * One CSV cell.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with an apostrophe. Excel treats such a cell as a
 * formula, and an audit trail holds text somebody else typed — a reason field beginning with `=`
 * would execute in the reviewer's spreadsheet. The apostrophe is the conventional defence and
 * survives a round trip through Excel as a literal.
 */
function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}
