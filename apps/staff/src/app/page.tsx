import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import { requirePrincipal } from "@/lib/auth";
import { NAVIGATION } from "@/lib/nav";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, Panel, StatTile, Td } from "@/components/ui";

/**
 * The dashboard.
 *
 * Widgets are role-aware: a widget is rendered only when the caller holds the capability its data
 * belongs to. Rather than invent figures for modules that do not exist yet, this shows what is
 * genuinely known today — the platform's own security and configuration state — and says plainly
 * what is coming.
 *
 * "What is live" is **derived from the navigation**, not written out here. It was written out here,
 * and it went stale exactly the way a hand-maintained list of what exists always does: it went on
 * telling anyone who signed in that invoicing, payroll and case management were unbuilt for the
 * whole of the time they were being built. A dashboard that is wrong about the product is worse
 * than a dashboard with nothing on it, and it is wrong quietly.
 *
 * The navigation already records what is not built, because each unbuilt entry carries the phase
 * it is due in and renders disabled. Reading the status off the same source means the two cannot
 * disagree: ship a module, delete its `phase`, and both the menu and this panel say so.
 */
export default async function DashboardPage() {
  const principal = await requirePrincipal();
  const db = await getDb();

  // One row per navigation section, live unless something inside it is still to come. Not
  // filtered by role: this is a statement about the platform, and a clerk who cannot open payroll
  // should still be told it exists.
  const moduleStatus = NAVIGATION.filter((section) => section.heading !== "Account").map(
    (section) => {
      const pending = section.items
        .map((item) => item.phase)
        .filter((phase): phase is number => typeof phase === "number");
      return {
        heading: section.heading,
        phase: pending.length > 0 ? Math.min(...pending) : null,
      };
    },
  );

  const [settingsToConfirm, recentEvents, activeSessions] = await Promise.all([
    db.execute<{ key: string; label: string; description: string | null }>(sql`
      SELECT key, label, description FROM org.setting
      WHERE needs_review ORDER BY category, key
    `),
    principal.capabilities.has("audit.view")
      ? db.execute<{ action: string; entity_type: string; actor_label: string | null; created_at: string }>(sql`
          SELECT action, entity_type, actor_label, created_at
          FROM audit.event ORDER BY created_at DESC LIMIT 8
        `)
      : Promise.resolve({ rows: [] as never[] }),
    db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM auth.session
      WHERE user_id = ${principal.userId} AND revoked_at IS NULL AND expires_at > now()
    `),
  ]);

  const pending = settingsToConfirm.rows ?? [];

  return (
    <Shell principal={principal} title={`Good day, ${principal.fullName.split(" ")[0]}`}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Your roles" value={String(principal.roles.length)} hint={principal.roles.join(", ") || "None assigned"} />
        <StatTile label="Your capabilities" value={String(principal.capabilities.size)} hint="Server-enforced on every action" />
        <StatTile label="Your active sessions" value={activeSessions.rows?.[0]?.n ?? "1"} hint="Manage them under My account" />
        <StatTile
          label="Settings to confirm"
          value={String(pending.length)}
          hint={pending.length ? "Blocking some modules" : "All confirmed"}
          tone={pending.length ? "warn" : "neutral"}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel
          title="Awaiting a decision from CAC"
          description="Values the platform will not guess. Modules that depend on them stay disabled."
        >
          {pending.length === 0 ? (
            <EmptyState title="Nothing outstanding" body="Every configurable value has been confirmed." />
          ) : (
            <ul className="space-y-3">
              {pending.slice(0, 6).map((s) => (
                <li key={s.key} className="border-b border-[var(--color-line)] pb-3 last:border-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-[13px] font-medium">{s.label}</p>
                    <Badge tone="warn">Unconfirmed</Badge>
                  </div>
                  {s.description && (
                    <p className="mt-1 text-[12px] text-[var(--color-muted)]">{s.description}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel title="Platform status" description="What is live today.">
            <ul className="space-y-2 text-[13px]">
              {moduleStatus.map((module) => (
                <li key={module.heading} className="flex items-center justify-between gap-3">
                  <span>{module.heading}</span>
                  {module.phase === null ? (
                    <Badge tone="ok">Live</Badge>
                  ) : (
                    <Badge>Phase {module.phase}</Badge>
                  )}
                </li>
              ))}
            </ul>
          </Panel>

          {principal.capabilities.has("audit.view") && (
            <Panel title="Recent activity" description="Most recent audited events.">
              {(recentEvents.rows ?? []).length === 0 ? (
                <EmptyState title="No activity yet" />
              ) : (
                <DataTable columns={["Action", "Entity", "Actor", "When"]} caption="Recent audit events">
                  {(recentEvents.rows ?? []).map((e, i) => (
                    <tr key={i}>
                      <Td>{e.action}</Td>
                      <Td>{e.entity_type}</Td>
                      <Td>{e.actor_label ?? "—"}</Td>
                      <Td>{new Date(e.created_at).toLocaleString("en-GB")}</Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Panel>
          )}
        </div>
      </div>

      {principal.capabilities.size === 0 && (
        <div className="mt-4">
          <Alert tone="warn">
            No roles have been assigned to your account, so there is nothing for you to do here
            yet. An administrator needs to assign your role.
          </Alert>
        </div>
      )}
    </Shell>
  );
}
