import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import { requirePrincipal } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Badge, DataTable, Panel, Td } from "@/components/ui";

type SessionRow = {
  id: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
};

export default async function AccountPage() {
  const principal = await requirePrincipal();
  const db = await getDb();

  const sessions = await db.execute<SessionRow>(sql`
    SELECT id, host(ip) AS ip, user_agent, created_at, last_seen_at
    FROM auth.session
    WHERE user_id = ${principal.userId} AND revoked_at IS NULL AND expires_at > now()
    ORDER BY last_seen_at DESC
  `);

  const capabilities = [...principal.capabilities].sort();

  return (
    <Shell principal={principal} title="My account" breadcrumbs={[{ label: "My account" }]}>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Profile">
          <dl className="space-y-2 text-[13px]">
            <div className="flex justify-between gap-4">
              <dt className="text-[var(--color-muted)]">Name</dt>
              <dd>{principal.fullName}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-[var(--color-muted)]">Email</dt>
              <dd className="font-mono text-[12px]">{principal.email}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-[var(--color-muted)]">Roles</dt>
              <dd>{principal.roles.join(", ") || "None"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-[var(--color-muted)]">Two-step verification</dt>
              <dd>{principal.mfaSatisfied ? <Badge tone="ok">Verified</Badge> : <Badge tone="warn">Not verified</Badge>}</dd>
            </div>
          </dl>
        </Panel>

        <Panel
          title="Active sessions"
          description="Devices currently signed in as you."
        >
          <DataTable columns={["Started", "Last seen", "IP"]} caption="Active sessions">
            {(sessions.rows ?? []).map((s) => (
              <tr key={s.id}>
                <Td>{new Date(s.created_at).toLocaleString("en-GB")}</Td>
                <Td>{new Date(s.last_seen_at).toLocaleString("en-GB")}</Td>
                <Td>{s.ip ?? "—"}</Td>
              </tr>
            ))}
          </DataTable>
        </Panel>
      </div>

      <div className="mt-4">
        <Panel
          title={`Your capabilities (${capabilities.length})`}
          description="Each is checked on the server for every action. Hiding a menu item is not the control."
        >
          <ul className="grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2 lg:grid-cols-3">
            {capabilities.map((c) => (
              <li key={c} className="font-mono text-[11px] text-[var(--color-muted)]">{c}</li>
            ))}
          </ul>
        </Panel>
      </div>
    </Shell>
  );
}
