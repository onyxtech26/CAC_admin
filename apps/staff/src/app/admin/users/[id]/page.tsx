import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import { ROLE_PERMISSIONS } from "@cac/db";
import { resolveCapabilities } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, Panel, Td } from "@/components/ui";
import { RoleToggle } from "../UserForms";

/**
 * One account's roles and the capabilities they add up to.
 *
 * The resolved capability list is shown, not just the role names, because the
 * question that matters is "what can this person actually do?" — and with role
 * bundles plus direct denies, the answer is not obvious from the role names alone.
 */
export default async function UserRolesPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("admin.role.manage");
  const { id } = await params;
  const db = await getDb();

  const found = await db.execute<{ id: string; email: string; full_name: string; status: string }>(
    sql`SELECT id, email, full_name, status FROM auth."user" WHERE id = ${id}`,
  );
  const user = found.rows?.[0];
  if (!user) notFound();

  const [roleRows, held, capabilities] = await Promise.all([
    db.execute<{ key: string; description: string }>(
      sql`SELECT key, description FROM auth.role ORDER BY key`,
    ),
    db.execute<{ key: string }>(sql`
      SELECT r.key FROM auth.user_role ur JOIN auth.role r ON r.id = ur.role_id
       WHERE ur.user_id = ${id}
    `),
    resolveCapabilities(db, id),
  ]);

  const heldRoles = new Set((held.rows ?? []).map((row) => row.key));
  const isSelf = user.id === principal.userId;
  const sortedCapabilities = [...capabilities].sort();

  // Grouped by the part before the first dot, which is the module.
  const byDomain = new Map<string, string[]>();
  for (const capability of sortedCapabilities) {
    const domain = capability.split(".")[0] ?? "other";
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), capability]);
  }

  return (
    <Shell
      principal={principal}
      title={user.full_name}
      breadcrumbs={[
        { label: "Administration" },
        { label: "Users", href: "/admin/users" },
        { label: user.full_name },
      ]}
    >
      <div className="space-y-4">
        {isSelf && (
          <Alert tone="info">
            This is your own account. You cannot grant yourself a role — otherwise the ability to
            manage roles would quietly be the ability to do everything. Another administrator has to
            do it, and the audit trail records who.
          </Alert>
        )}

        <Panel
          title="Roles"
          description="Roles are bundles of capabilities. The code always checks a capability, never a role name."
        >
          <DataTable columns={["Role", "What it is for", "Capabilities", "Held", ""]} caption="Roles">
            {(roleRows.rows ?? []).map((role) => {
              const count = ROLE_PERMISSIONS[role.key as keyof typeof ROLE_PERMISSIONS]?.length ?? 0;
              const isHeld = heldRoles.has(role.key);
              return (
                <tr key={role.key}>
                  <Td>
                    <span className="font-medium">{role.key.replace(/_/g, " ")}</span>
                  </Td>
                  <Td>
                    <span className="text-[12px] text-[var(--color-muted)]">{role.description}</span>
                  </Td>
                  <Td numeric>{new Set(count ? ROLE_PERMISSIONS[role.key as keyof typeof ROLE_PERMISSIONS] : []).size}</Td>
                  <Td>{isHeld ? <Badge tone="ok">held</Badge> : <span className="text-[var(--color-faint)]">—</span>}</Td>
                  <Td>
                    <RoleToggle
                      userId={user.id}
                      role={role.key}
                      held={isHeld}
                      disabled={isSelf && !isHeld}
                      disabledReason="You cannot grant yourself a role."
                    />
                  </Td>
                </tr>
              );
            })}
          </DataTable>
        </Panel>

        <Panel
          title={`${sortedCapabilities.length} effective capabilities`}
          description="The union of every role held, minus any direct denial. This is what the server checks."
        >
          {sortedCapabilities.length === 0 ? (
            <p className="text-[12px] text-[var(--color-muted)]">
              None. This account can sign in and see its own profile, and nothing else.
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[...byDomain.entries()].map(([domain, list]) => (
                <div key={domain}>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-faint)]">
                    {domain} ({list.length})
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {list.map((capability) => (
                      <li key={capability} className="font-mono text-[11px]">
                        {capability}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </Shell>
  );
}
