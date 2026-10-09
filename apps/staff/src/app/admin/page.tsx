import Link from "next/link";
import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import { requireAnyCapability } from "@/lib/auth";
import { memoize } from "@/lib/cache";
import { Shell } from "@/components/Shell";
import {
  Badge,
  DataTable,
  EmptyState,
  LinkButton,
  Panel,
  StatTile,
  Td,
} from "@/components/ui";
import {
  IconAdmin,
  IconCheckCircle,
  IconJournal,
  IconShield,
  IconUsers,
} from "@/components/icons";

/**
 * Platform Administration Hub.
 *
 * Central governance and control for CAC internal systems:
 * - User credential and account lifecycle
 * - Role-based capability enforcement (RBAC)
 * - Platform & company configuration policies
 * - External integrations (LHDN MyInvois, AI drafting models, object storage)
 * - Append-only tamper-evident audit logs
 */
export default async function AdminHubPage() {
  const principal = await requireAnyCapability([
    "admin.user.manage",
    "admin.role.manage",
    "admin.settings.manage",
    "admin.integration.manage",
    "audit.view",
  ]);
  const db = await getDb();

  const { activeUsers, sessions, settings, events } = await memoize("admin.overview", 60, async () => {
    const [usersCount, activeSessions, pendingSettings, recentAudit] = await Promise.all([
      db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM auth."user" WHERE status = 'active'`),
      db.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM auth.session WHERE revoked_at IS NULL AND expires_at > now()`,
      ),
      db.execute<{ key: string; label: string; description: string | null }>(
        sql`SELECT key, label, description FROM org.setting WHERE needs_review ORDER BY category, key LIMIT 6`,
      ),
      principal.capabilities.has("audit.view")
        ? db.execute<{ action: string; entity_type: string; actor_label: string | null; created_at: string }>(
            sql`SELECT action, entity_type, actor_label, created_at FROM audit.event ORDER BY created_at DESC LIMIT 8`,
          )
        : Promise.resolve({ rows: [] as never[] }),
    ]);

    return {
      activeUsers: usersCount.rows?.[0]?.n ?? "0",
      sessions: activeSessions.rows?.[0]?.n ?? "0",
      settings: pendingSettings.rows ?? [],
      events: recentAudit.rows ?? [],
    };
  });

  return (
    <Shell
      principal={principal}
      title="Platform Administration"
      breadcrumbs={[{ label: "Administration" }]}
      currentSuite="admin"
      actions={
        principal.capabilities.has("admin.user.manage") ? (
          <LinkButton href="/admin/users" variant="primary">
            Manage users
          </LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-5">
        {/* Stat Tiles */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Active staff accounts"
            value={activeUsers}
            hint="Authenticated users in system"
          />
          <StatTile
            label="Live sessions"
            value={sessions}
            hint="Active browser logins"
          />
          <StatTile
            label="Settings pending review"
            value={String(settings.length)}
            hint={settings.length > 0 ? "Requires management sign-off" : "All policies confirmed"}
            tone={settings.length > 0 ? "warn" : "ok"}
          />
          <StatTile
            label="Audit logging"
            value="ACTIVE"
            hint="Append-only immutable record"
            tone="ok"
          />
        </div>

        {/* Administration Modules Grid */}
        <Panel
          title="System Governance Modules"
          description="Security, directory, access control, and environment settings."
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Link
              href="/admin/users"
              className="group flex items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3.5 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] hover:-translate-y-0.5 transition shadow-xs"
            >
              <div className="rounded-md bg-[var(--color-navy-3)]/70 p-2 text-[var(--color-gold-2)] border border-[var(--color-gold-2)]/30 group-hover:scale-105 transition">
                <IconUsers size={20} />
              </div>
              <div>
                <p className="text-[13.5px] font-semibold text-[var(--color-ivory)] group-hover:text-[var(--color-gold-2)] transition">
                  Users & Accounts
                </p>
                <p className="text-[11.5px] text-[var(--color-muted)] mt-0.5">
                  Staff credentials, email logins, MFA enforcement & password resets
                </p>
              </div>
            </Link>

            <Link
              href="/admin/roles"
              className="group flex items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3.5 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] hover:-translate-y-0.5 transition shadow-xs"
            >
              <div className="rounded-md bg-[var(--color-navy-3)]/70 p-2 text-[var(--color-gold-2)] border border-[var(--color-gold-2)]/30 group-hover:scale-105 transition">
                <IconShield size={20} />
              </div>
              <div>
                <p className="text-[13.5px] font-semibold text-[var(--color-ivory)] group-hover:text-[var(--color-gold-2)] transition">
                  Roles & Permissions
                </p>
                <p className="text-[11.5px] text-[var(--color-muted)] mt-0.5">
                  135 fine-grained capabilities, separation of duties & role assignments
                </p>
              </div>
            </Link>

            <Link
              href="/admin/settings"
              className="group flex items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3.5 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] hover:-translate-y-0.5 transition shadow-xs"
            >
              <div className="rounded-md bg-[var(--color-navy-3)]/70 p-2 text-[var(--color-gold-2)] border border-[var(--color-gold-2)]/30 group-hover:scale-105 transition">
                <IconAdmin size={20} />
              </div>
              <div>
                <p className="text-[13.5px] font-semibold text-[var(--color-ivory)] group-hover:text-[var(--color-gold-2)] transition">
                  Platform Settings
                </p>
                <p className="text-[11.5px] text-[var(--color-muted)] mt-0.5">
                  Company profile, registration, fiscal defaults & maker-checker thresholds
                </p>
              </div>
            </Link>

            <Link
              href="/admin/integrations"
              className="group flex items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3.5 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] hover:-translate-y-0.5 transition shadow-xs"
            >
              <div className="rounded-md bg-[var(--color-navy-3)]/70 p-2 text-[var(--color-gold-2)] border border-[var(--color-gold-2)]/30 group-hover:scale-105 transition">
                <IconCheckCircle size={20} />
              </div>
              <div>
                <p className="text-[13.5px] font-semibold text-[var(--color-ivory)] group-hover:text-[var(--color-gold-2)] transition">
                  Integrations
                </p>
                <p className="text-[11.5px] text-[var(--color-muted)] mt-0.5">
                  LHDN MyInvois API, AI drafting providers, and external services
                </p>
              </div>
            </Link>

            <Link
              href="/admin/audit"
              className="group flex items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/75 p-3.5 hover:border-[var(--color-gold-2)]/60 hover:bg-[var(--color-surface)] hover:-translate-y-0.5 transition shadow-xs"
            >
              <div className="rounded-md bg-[var(--color-navy-3)]/70 p-2 text-[var(--color-gold-2)] border border-[var(--color-gold-2)]/30 group-hover:scale-105 transition">
                <IconJournal size={20} />
              </div>
              <div>
                <p className="text-[13.5px] font-semibold text-[var(--color-ivory)] group-hover:text-[var(--color-gold-2)] transition">
                  Audit Trail
                </p>
                <p className="text-[11.5px] text-[var(--color-muted)] mt-0.5">
                  Forensic event logs recording every document, posting, and sign-in
                </p>
              </div>
            </Link>
          </div>
        </Panel>

        {/* Operational Section: Settings Needing Decision & Recent Events */}
        <div className="grid gap-5 lg:grid-cols-2">
          <Panel
            title="Awaiting Management Decision"
            description="Configuration keys that require confirmation before locked features activate."
            action={
              <Link href="/admin/settings" className="text-[12px] text-[var(--color-gold-2)] hover:underline">
                View all settings
              </Link>
            }
          >
            {settings.length === 0 ? (
              <EmptyState
                title="All settings confirmed"
                body="Every system policy and configuration item has been reviewed."
              />
            ) : (
              <ul className="space-y-3">
                {settings.map((s) => (
                  <li
                    key={s.key}
                    className="border-b border-[var(--color-line)] pb-3 last:border-0 last:pb-0"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-[13px] font-medium text-[var(--color-body)]">{s.label}</p>
                      <Badge tone="warn">Needs review</Badge>
                    </div>
                    {s.description && (
                      <p className="mt-1 text-[11.5px] text-[var(--color-muted)]">{s.description}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {principal.capabilities.has("audit.view") && (
            <Panel
              title="Recent Security & Audit Events"
              description="Live tamper-evident operational log."
              action={
                <Link href="/admin/audit" className="text-[12px] text-[var(--color-gold-2)] hover:underline">
                  Full audit log
                </Link>
              }
            >
              {events.length === 0 ? (
                <EmptyState title="No recent activity recorded" />
              ) : (
                <DataTable columns={["Action", "Entity", "Actor", "When"]} caption="Audit events">
                  {events.map((e, i) => (
                    <tr key={i}>
                      <Td>
                        <span className="font-mono text-[11px] text-[var(--color-gold-2)]">
                          {e.action}
                        </span>
                      </Td>
                      <Td>{e.entity_type}</Td>
                      <Td>{e.actor_label ?? "System"}</Td>
                      <Td>{new Date(e.created_at).toLocaleTimeString("en-GB")}</Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Panel>
          )}
        </div>
      </div>
    </Shell>
  );
}
