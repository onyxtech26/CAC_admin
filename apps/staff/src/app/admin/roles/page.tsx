import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { DataTable, Panel, Td } from "@/components/ui";

type RoleRow = { key: string; description: string | null; permissions: number; users: number };

export default async function RolesPage() {
  const principal = await requireCapability("admin.role.manage");
  const db = await getDb();

  const roles = await db.execute<RoleRow>(sql`
    SELECT r.key, r.description,
           (SELECT count(*) FROM auth.role_permission rp WHERE rp.role_id = r.id)::int AS permissions,
           (SELECT count(*) FROM auth.user_role ur WHERE ur.role_id = r.id)::int AS users
    FROM auth.role r ORDER BY r.key
  `);

  const domains = await db.execute<{ domain: string; n: number }>(sql`
    SELECT domain, count(*)::int AS n FROM auth.permission GROUP BY domain ORDER BY domain
  `);

  return (
    <Shell
      principal={principal}
      title="Roles and permissions"
      breadcrumbs={[{ label: "Administration" }, { label: "Roles" }]}
    >
      <Panel
        title="Roles"
        description="Roles are bundles of capabilities. Application code always checks a capability, never a role name."
      >
        <DataTable columns={["Role", "Purpose", "Capabilities", "Users"]} caption="Roles">
          {(roles.rows ?? []).map((r) => (
            <tr key={r.key}>
              <Td><span className="font-mono text-[12px]">{r.key}</span></Td>
              <Td>{r.description}</Td>
              <Td numeric>{r.permissions}</Td>
              <Td numeric>{r.users}</Td>
            </tr>
          ))}
        </DataTable>
      </Panel>

      <div className="mt-4">
        <Panel
          title="Capability catalogue"
          description="Declared for later phases too, so no module can ship without an authorisation story."
        >
          <DataTable columns={["Domain", "Capabilities"]} caption="Capabilities by domain">
            {(domains.rows ?? []).map((d) => (
              <tr key={d.domain}>
                <Td>{d.domain}</Td>
                <Td numeric>{d.n}</Td>
              </tr>
            ))}
          </DataTable>
        </Panel>
      </div>
    </Shell>
  );
}
