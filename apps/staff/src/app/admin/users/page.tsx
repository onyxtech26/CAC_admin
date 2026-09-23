import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Badge, DataTable, EmptyState, Panel, Td } from "@/components/ui";

type Row = {
  id: string;
  email: string;
  full_name: string;
  status: string;
  last_login_at: string | null;
  locked_until: string | null;
  roles: string | null;
  mfa_devices: number;
};

export default async function UsersPage() {
  // The gate. Runs before any data is read, so bypassing the UI achieves
  // nothing.
  const principal = await requireCapability("admin.user.manage");
  const db = await getDb();

  const users = await db.execute<Row>(sql`
    SELECT u.id, u.email, u.full_name, u.status, u.last_login_at, u.locked_until,
           string_agg(DISTINCT r.key, ', ' ORDER BY r.key) AS roles,
           (SELECT count(*) FROM auth.mfa_device d
             WHERE d.user_id = u.id AND d.confirmed_at IS NOT NULL)::int AS mfa_devices
    FROM auth."user" u
    LEFT JOIN auth.user_role ur ON ur.user_id = u.id
    LEFT JOIN auth.role r       ON r.id = ur.role_id
    GROUP BY u.id
    ORDER BY u.full_name
  `);

  const rows = users.rows ?? [];

  return (
    <Shell
      principal={principal}
      title="Users"
      breadcrumbs={[{ label: "Administration" }, { label: "Users" }]}
    >
      <Panel
        title={`${rows.length} account${rows.length === 1 ? "" : "s"}`}
        description="Accounts that can sign in. Not every account is a member of staff."
      >
        {rows.length === 0 ? (
          <EmptyState title="No accounts yet" body="Seed an administrator to get started." />
        ) : (
          <DataTable
            columns={["Name", "Email", "Roles", "MFA", "Status", "Last sign-in"]}
            caption="User accounts"
          >
            {rows.map((u) => {
              const locked = u.locked_until && new Date(u.locked_until) > new Date();
              return (
                <tr key={u.id}>
                  <Td>{u.full_name}</Td>
                  <Td>
                    <span className="font-mono text-[12px]">{u.email}</span>
                  </Td>
                  <Td>{u.roles ?? <span className="text-[var(--color-faint)]">None</span>}</Td>
                  <Td>
                    {u.mfa_devices > 0 ? (
                      <Badge tone="ok">Enrolled</Badge>
                    ) : (
                      <Badge tone="warn">Not set up</Badge>
                    )}
                  </Td>
                  <Td>
                    {locked ? (
                      <Badge tone="danger">Locked</Badge>
                    ) : u.status === "active" ? (
                      <Badge tone="ok">Active</Badge>
                    ) : (
                      <Badge tone="warn">{u.status}</Badge>
                    )}
                  </Td>
                  <Td>
                    {u.last_login_at
                      ? new Date(u.last_login_at).toLocaleString("en-GB")
                      : <span className="text-[var(--color-faint)]">Never</span>}
                  </Td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </Panel>
    </Shell>
  );
}
