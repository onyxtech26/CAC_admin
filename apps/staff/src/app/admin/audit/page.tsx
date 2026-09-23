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
