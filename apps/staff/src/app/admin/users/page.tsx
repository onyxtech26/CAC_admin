import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import { formatDate, listUsers } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, Panel, Td } from "@/components/ui";
import { NewUserForm, UserRowActions } from "./UserForms";

/**
 * Accounts.
 *
 * Accounts are never deleted, only suspended: the audit trail refers to them, and
 * an entry attributed to a user who no longer exists is an entry nobody can
 * account for.
 */
export default async function UsersPage() {
  // The gate. Runs before any data is read, so bypassing the UI achieves nothing.
  const principal = await requireCapability("admin.user.manage");
  const db = await getDb();

  const [users, roles] = await Promise.all([
    listUsers(db),
    db.execute<{ key: string; description: string }>(
      sql`SELECT key, description FROM auth.role ORDER BY key`,
    ),
  ]);

  const canManageRoles = principal.capabilities.has("admin.role.manage");
  const withoutMfa = users.filter((user) => user.mfaDevices === 0 && user.status === "active");

  return (
    <Shell
      principal={principal}
      title="Users"
      breadcrumbs={[{ label: "Administration" }, { label: "Users" }]}
    >
      <div className="space-y-4">
        {withoutMfa.length > 0 && (
          <Alert tone="warn">
            {withoutMfa.length} active{" "}
            {withoutMfa.length === 1 ? "account has" : "accounts have"} no authenticator enrolled.
            Until they do, a password is the only thing standing between an attacker and this
            platform. Each person enrols their own device under My account.
          </Alert>
        )}

        <Panel
          title={`${users.length} account${users.length === 1 ? "" : "s"}`}
          description="Accounts that can sign in. Not every account is a member of staff."
        >
          {users.length === 0 ? (
            <EmptyState title="No accounts yet" body="Create the first one below." />
          ) : (
            <DataTable
              columns={["Name", "Email", "Roles", "MFA", "Sessions", "Status", "Last sign-in", "Actions"]}
              caption="User accounts"
            >
              {users.map((user) => {
                const locked = user.lockedUntil && new Date(user.lockedUntil) > new Date();
                return (
                  <tr key={user.id}>
                    <Td>
                      {user.fullName}
                      {user.id === principal.userId && (
                        <span className="ml-1 text-[11px] text-[var(--color-faint)]">(you)</span>
                      )}
                      {user.mustChangePassword && (
                        <p className="text-[11px] text-[var(--color-warn)]">
                          must change password
                        </p>
                      )}
                    </Td>
                    <Td>
                      <span className="font-mono text-[12px]">{user.email}</span>
                    </Td>
                    <Td>
                      {user.roles.length === 0 ? (
                        <span className="text-[var(--color-faint)]">None</span>
                      ) : (
                        <span className="text-[12px]">
                          {user.roles.map((role) => role.replace(/_/g, " ")).join(", ")}
                        </span>
                      )}
                    </Td>
                    <Td>
                      {user.mfaDevices > 0 ? (
                        <Badge tone="ok">Enrolled</Badge>
                      ) : (
                        <Badge tone="warn">Not set up</Badge>
                      )}
                    </Td>
                    <Td numeric>
                      {user.activeSessions === 0 ? (
                        <span className="text-[var(--color-faint)]">—</span>
                      ) : (
                        user.activeSessions
                      )}
                    </Td>
                    <Td>
                      {locked ? (
                        <Badge tone="danger">Locked</Badge>
                      ) : user.status === "active" ? (
                        <Badge tone="ok">Active</Badge>
                      ) : (
                        <Badge tone="warn">{user.status}</Badge>
                      )}
                    </Td>
                    <Td>
                      {user.lastLoginAt ? (
                        formatDate(String(user.lastLoginAt))
                      ) : (
                        <span className="text-[var(--color-faint)]">Never</span>
                      )}
                    </Td>
                    <Td>
                      <UserRowActions
                        userId={user.id}
                        email={user.email}
                        status={user.status}
                        isSelf={user.id === principal.userId}
                        hasMfa={user.mfaDevices > 0}
                        canManageRoles={canManageRoles}
                      />
                    </Td>
                  </tr>
                );
              })}
            </DataTable>
          )}
        </Panel>

        <Panel
          title="Create an account"
          description="A generated password is shown once. Nobody, including an administrator, sets somebody else's password — knowing a colleague's credentials destroys the attribution the audit trail depends on."
        >
          <NewUserForm roles={roles.rows ?? []} canAssignRoles={canManageRoles} />
        </Panel>
      </div>
    </Shell>
  );
}
