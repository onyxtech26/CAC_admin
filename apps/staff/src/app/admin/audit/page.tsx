import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, DataTable, EmptyState, Panel, Td } from "@/components/ui";

type EventRow = {
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_label: string | null;
  ip: string | null;
  created_at: string;
};

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const principal = await requireCapability("audit.view");
  const canExport = principal.capabilities.has("audit.export");
  const db = await getDb();

  const { page } = await searchParams;
  const pageNumber = Math.max(1, Number(page ?? "1") || 1);
  const pageSize = 50;
  const offset = (pageNumber - 1) * pageSize;

  const [events, total] = await Promise.all([
    db.execute<EventRow>(sql`
      SELECT action, entity_type, entity_id, actor_label, host(ip) AS ip, created_at
      FROM audit.event ORDER BY created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `),
    db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM audit.event`),
  ]);

  const rows = events.rows ?? [];
  const count = Number(total.rows?.[0]?.n ?? "0");

  return (
    <Shell
      principal={principal}
      title="Audit trail"
      breadcrumbs={[{ label: "Administration" }, { label: "Audit" }]}
    >
      <div className="mb-4">
        <Alert tone="info">
          Audit records are append-only. The database rejects any attempt to amend or delete
          them, including by an administrator.
        </Alert>
      </div>

      {canExport && (
        <div className="mb-4">
          <Panel
            title="Export"
            description="The trail as CSV, for a reviewer or an auditor. Exporting is itself recorded, with the range and the number of rows — an export is the moment the trail leaves the platform."
          >
            <form action="/admin/audit/export" method="get" className="flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor="from" className="block text-[12px] font-medium">
                  From
                </label>
                <input
                  id="from"
                  name="from"
                  type="date"
                  className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
                />
              </div>
              <div>
                <label htmlFor="to" className="block text-[12px] font-medium">
                  To
                </label>
                <input
                  id="to"
                  name="to"
                  type="date"
                  className="mt-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
                />
              </div>
              <button
                type="submit"
                className="btn btn-primary px-3 py-2 text-[13px]"
              >
                Download CSV
              </button>
              <p className="basis-full text-[11px] text-[var(--color-muted)]">
                Leave the dates blank for everything. The old and new values are not included: they
                are redacted already, and a file of every payload is a file of masked personal data.
                The reason is included, which is the part that explains a change.
              </p>
            </form>
          </Panel>
        </div>
      )}

      <Panel title={`${count} event${count === 1 ? "" : "s"}`} description={`Page ${pageNumber}`}>
        {rows.length === 0 ? (
          <EmptyState title="No events recorded yet" />
        ) : (
          <DataTable columns={["When", "Action", "Entity", "Actor", "IP"]} caption="Audit events">
            {rows.map((e, i) => (
              <tr key={i}>
                <Td>{new Date(e.created_at).toLocaleString("en-GB")}</Td>
                <Td><span className="font-mono text-[12px]">{e.action}</span></Td>
                <Td>{e.entity_type}</Td>
                <Td>{e.actor_label ?? "—"}</Td>
                <Td>{e.ip ?? "—"}</Td>
              </tr>
            ))}
          </DataTable>
        )}
      </Panel>
    </Shell>
  );
}
