import Link from "next/link";
import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import {
  formatAmount,
  formatDate,
  ledgerTotals,
  listCases,
  listJournals,
  listLeaveRequests,
} from "@cac/core";
import { requirePrincipal } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import {
  Alert,
  Badge,
  DataTable,
  EmptyState,
  Panel,
  StatTile,
  Td,
} from "@/components/ui";
import { WorkflowNavigator } from "@/components/WorkflowNavigator";
import {
  IconAccounting,
  IconAdmin,
  IconArrowRight,
  IconClock,
  IconHRMS,
  IconJournal,
  IconLegalAI,
} from "@/components/icons";

/**
 * CAC Executive Platform Command Center.
 *
 * Designed as a high-productivity command hub modeled on AutoCount Accounting & AutoCount HRMS:
 * - One-click Suite Launch deck (Accounting, HRMS, Legal AI, Administration)
 * - Cross-suite live operational KPI cockpit
 * - Interactive AutoCount Process Flow Navigator
 * - Maker-checker draft approvals and management decision center
 */
export default async function DashboardPage() {
  const principal = await requirePrincipal();
  const db = await getDb();

  // Parallel fetch with capability checks and safety fallbacks
  const [
    totals,
    draftJournals,
    activeStaffRes,
    pendingLeaves,
    activeCases,
    newEnquiries,
    pendingSettings,
    recentEvents,
  ] = await Promise.all([
    principal.capabilities.has("accounting.journal.view")
      ? ledgerTotals(db).catch(() => null)
      : Promise.resolve(null),
    principal.capabilities.has("accounting.journal.view")
      ? listJournals(db, { status: "draft", limit: 5 }).catch(() => [])
      : Promise.resolve([]),
    principal.capabilities.has("hr.employee.view")
      ? db
          .execute<{ n: string }>(
            sql`SELECT count(*)::text AS n FROM hr.employee WHERE status = 'active'`,
          )
          .catch(() => ({ rows: [{ n: "0" }] }))
      : Promise.resolve({ rows: [{ n: "0" }] }),
    principal.capabilities.has("hr.leave.view")
      ? listLeaveRequests(db, { status: "submitted", limit: 5 }).catch(() => [])
      : Promise.resolve([]),
    principal.capabilities.has("case.view") || principal.capabilities.has("case.view_all")
      ? listCases(db, principal, { status: "active", limit: 50 }).catch(() => [])
      : Promise.resolve([]),
    principal.capabilities.has("crm.enquiry.view")
      ? db
          .execute<{ n: string }>(
            sql`SELECT count(*)::text AS n FROM org.enquiry WHERE status = 'new'`,
          )
          .catch(() => ({ rows: [{ n: "0" }] }))
      : Promise.resolve({ rows: [{ n: "0" }] }),
    db
      .execute<{ key: string; label: string; description: string | null }>(
        sql`SELECT key, label, description FROM org.setting WHERE needs_review ORDER BY category, key LIMIT 5`,
      )
      .catch(() => ({ rows: [] })),
    principal.capabilities.has("audit.view")
      ? db
          .execute<{ action: string; entity_type: string; actor_label: string | null; created_at: string }>(
            sql`SELECT action, entity_type, actor_label, created_at FROM audit.event ORDER BY created_at DESC LIMIT 6`,
          )
          .catch(() => ({ rows: [] }))
      : Promise.resolve({ rows: [] }),
  ]);

  const activeStaffCount = Number(activeStaffRes.rows?.[0]?.n ?? "0");
  const pending = pendingSettings.rows ?? [];
  const events = recentEvents.rows ?? [];
  const openEnquiryCount = Number(newEnquiries.rows?.[0]?.n ?? "0");
  const isLedgerBalanced = totals ? totals.outOfBalance === 0n : true;
  const firstName = principal.fullName.split(" ")[0];

  return (
    <Shell
      principal={principal}
      title={`Welcome, ${firstName}`}
      currentSuite="all"
      actions={
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-[var(--color-muted)] font-mono">
            {new Date().toLocaleDateString("en-GB", {
              weekday: "short",
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </span>
        </div>
      }
    >
      <div className="space-y-6">
        {/* Out of Balance Warning */}
        {totals && !isLedgerBalanced && (
          <Alert tone="danger">
            <strong>Ledger Alert:</strong> The general ledger does not balance by{" "}
            {formatAmount(totals.outOfBalance, { currency: "RM" })}. Review postings in the{" "}
            <Link href="/accounting/reports/trial-balance" className="underline font-semibold">
              Trial Balance
            </Link>
            .
          </Alert>
        )}

        {/* Core Suite Cards: AutoCount Platform Architecture */}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {/* Suite 1: AutoCount Accounting */}
          <div className="group relative flex flex-col justify-between plate plate-interactive rounded-xl p-5 transition-all duration-200 hover:-translate-y-0.5 bg-white border border-slate-200 shadow-xs">
            <div>
              <div className="flex items-center justify-between mb-3.5">
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-amber-50 text-amber-700 border border-amber-200 shadow-2xs">
                  <IconAccounting size={22} />
                </span>
                <Badge tone="ok">AutoCount A/R & A/P</Badge>
              </div>

              <h2 className="font-display text-[16px] font-semibold text-slate-900 group-hover:text-amber-700 transition">
                Accounting & Ledger
              </h2>
              <p className="mt-1 text-[12.5px] leading-relaxed text-slate-500">
                Quotations, Invoices, Official Receipts, Supplier Bills, Payment Vouchers, General
                Ledger & e-Invoice.
              </p>
            </div>

            <div className="mt-4 border-t border-slate-100 pt-3">
              <div className="flex items-center justify-between">
                <Link
                  href="/accounting"
                  className="flex items-center gap-1.5 text-[12.5px] font-semibold text-amber-700 hover:underline"
                >
                  <span>Open Accounting</span>
                  <IconArrowRight size={13} />
                </Link>
                <div className="flex items-center gap-1 text-[11px] text-slate-400">
                  <Link href="/accounting/invoices" className="hover:text-slate-800 transition-colors">
                    Invoices
                  </Link>
                  <span>·</span>
                  <Link href="/accounting/journals" className="hover:text-slate-800 transition-colors">
                    G/L
                  </Link>
                </div>
              </div>
            </div>
          </div>

          {/* Suite 2: AutoCount HRMS */}
          <div className="group relative flex flex-col justify-between plate plate-interactive rounded-xl p-5 transition-all duration-200 hover:-translate-y-0.5 bg-white border border-slate-200 shadow-xs">
            <div>
              <div className="flex items-center justify-between mb-3.5">
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-blue-50 text-blue-700 border border-blue-200 shadow-2xs">
                  <IconHRMS size={22} />
                </span>
                <Badge tone="info">AutoCount HRMS</Badge>
              </div>

              <h2 className="font-display text-[16px] font-semibold text-slate-900 group-hover:text-blue-700 transition">
                HRMS & Payroll
              </h2>
              <p className="mt-1 text-[12.5px] leading-relaxed text-slate-500">
                Employee Master, Attendance Clocking, Leave Approvals, Monthly Payroll, KWSP,
                PERKESO & Payslips.
              </p>
            </div>

            <div className="mt-4 border-t border-slate-100 pt-3">
              <div className="flex items-center justify-between">
                <Link
                  href="/hr"
                  className="flex items-center gap-1.5 text-[12.5px] font-semibold text-blue-700 hover:underline"
                >
                  <span>Open HRMS Hub</span>
                  <IconArrowRight size={13} />
                </Link>
                <div className="flex items-center gap-1 text-[11px] text-slate-400">
                  <Link href="/hr/employees" className="hover:text-slate-800 transition-colors">
                    Staff
                  </Link>
                  <span>·</span>
                  <Link href="/hr/payroll" className="hover:text-slate-800 transition-colors">
                    Payroll
                  </Link>
                </div>
              </div>
            </div>
          </div>

          {/* Suite 3: Legal AI & Forensics */}
          <div className="group relative flex flex-col justify-between plate plate-interactive rounded-xl p-5 transition-all duration-200 hover:-translate-y-0.5 bg-white border border-slate-200 shadow-xs">
            <div>
              <div className="flex items-center justify-between mb-3.5">
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-purple-50 text-purple-700 border border-purple-200 shadow-2xs">
                  <IconLegalAI size={22} />
                </span>
                <Badge tone="warn">AI Forensics</Badge>
              </div>

              <h2 className="font-display text-[16px] font-semibold text-slate-900 group-hover:text-purple-700 transition">
                Legal AI & Forensics
              </h2>
              <p className="mt-1 text-[12.5px] leading-relaxed text-slate-500">
                Property Forensics, Malaysian Probate Matters, Statutory Rule Engine, and AI
                Contradiction Agent.
              </p>
            </div>

            <div className="mt-4 border-t border-slate-100 pt-3">
              <div className="flex items-center justify-between">
                <Link
                  href="/cases"
                  className="flex items-center gap-1.5 text-[12.5px] font-semibold text-purple-700 hover:underline"
                >
                  <span>Open Legal AI</span>
                  <IconArrowRight size={13} />
                </Link>
                <div className="flex items-center gap-1 text-[11px] text-slate-400">
                  <Link href="/cases" className="hover:text-slate-800 transition-colors">
                    Matters
                  </Link>
                  <span>·</span>
                  <Link href="/cases/rules" className="hover:text-slate-800 transition-colors">
                    Rules
                  </Link>
                </div>
              </div>
            </div>
          </div>

          {/* Suite 4: System Administration */}
          <div className="group relative flex flex-col justify-between plate plate-interactive rounded-xl p-5 transition-all duration-200 hover:-translate-y-0.5 bg-white border border-slate-200 shadow-xs">
            <div>
              <div className="flex items-center justify-between mb-3.5">
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-slate-100 text-slate-700 border border-slate-200 shadow-2xs">
                  <IconAdmin size={22} />
                </span>
                <Badge tone="neutral">Governance</Badge>
              </div>

              <h2 className="font-display text-[16px] font-semibold text-slate-900 group-hover:text-slate-700 transition">
                Platform Admin
              </h2>
              <p className="mt-1 text-[12.5px] leading-relaxed text-slate-500">
                User Accounts, 135 RBAC Roles, Platform Settings, LHDN Integrations & Immutable
                Audit Logs.
              </p>
            </div>

            <div className="mt-4 border-t border-slate-100 pt-3">
              <div className="flex items-center justify-between">
                <Link
                  href="/admin"
                  className="flex items-center gap-1.5 text-[12.5px] font-semibold text-slate-700 hover:underline"
                >
                  <span>Open Admin Hub</span>
                  <IconArrowRight size={13} />
                </Link>
                <div className="flex items-center gap-1 text-[11px] text-slate-400">
                  <Link href="/admin/users" className="hover:text-slate-800 transition-colors">
                    Users
                  </Link>
                  <span>·</span>
                  <Link href="/admin/audit" className="hover:text-slate-800 transition-colors">
                    Audit
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Live Cross-Suite Performance Cockpit */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Accounting health"
            value={totals ? (isLedgerBalanced ? "BALANCED" : "OUT OF BALANCE") : "ACTIVE"}
            hint={
              totals
                ? `${totals.postedJournals} posted · ${totals.draftJournals} draft(s)`
                : "Ledger live"
            }
            tone={totals && !isLedgerBalanced ? "danger" : "ok"}
          />
          <StatTile
            label="Workforce status"
            value={String(activeStaffCount)}
            hint={
              pendingLeaves.length > 0
                ? `${pendingLeaves.length} leave approval(s) waiting`
                : "Active team members"
            }
            tone={pendingLeaves.length > 0 ? "warn" : "neutral"}
          />
          <StatTile
            label="Active estate matters"
            value={String(activeCases.length)}
            hint={
              activeCases.length > 0
                ? `${activeCases.reduce((acc, c) => acc + c.outstandingRequirements, 0)} checklist requirements`
                : "Estate files live"
            }
          />
          <StatTile
            label="Inbound client enquiries"
            value={String(openEnquiryCount)}
            hint={openEnquiryCount > 0 ? "New website enquiries waiting" : "All enquiries attended"}
            tone={openEnquiryCount > 0 ? "warn" : "ok"}
          />
        </div>

        {/* AutoCount Process Flow Navigator */}
        <WorkflowNavigator defaultTab="sales" />

        {/* Operational Attention & Activity */}
        <div className="grid gap-5 lg:grid-cols-2">
          {/* Action Center: Drafts & Pending Actions */}
          <Panel
            title="Operational Attention Required"
            description="High-priority transactions waiting for review, approval, or sign-off."
          >
            <div className="space-y-3">
              {draftJournals.length > 0 && (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/70 p-3 hover:border-[var(--color-gold-2)]/50 transition">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[12.5px] font-semibold text-[var(--color-ivory)] flex items-center gap-1.5">
                      <IconJournal size={15} className="text-[var(--color-gold-2)]" />
                      <span>{draftJournals.length} Draft Journal(s) Awaiting Checker</span>
                    </span>
                    <Link
                      href="/accounting/journals?status=draft"
                      className="text-[11px] text-[var(--color-gold-2)] hover:underline"
                    >
                      View all
                    </Link>
                  </div>
                  <ul className="space-y-1 text-[12px]">
                    {draftJournals.slice(0, 3).map((j) => (
                      <li key={j.id} className="flex items-center justify-between text-[var(--color-muted)]">
                        <span>{j.memo ?? "Journal entry"}</span>
                        <span className="font-mono text-[var(--color-gold-2)] font-medium">
                          {formatAmount(j.total)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {pendingLeaves.length > 0 && (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/70 p-3 hover:border-[var(--color-gold-2)]/50 transition">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[12.5px] font-semibold text-[var(--color-ivory)] flex items-center gap-1.5">
                      <IconClock size={15} className="text-[var(--color-info)]" />
                      <span>{pendingLeaves.length} Staff Leave Request(s)</span>
                    </span>
                    <Link
                      href="/hr/leave"
                      className="text-[11px] text-[var(--color-gold-2)] hover:underline"
                    >
                      Review
                    </Link>
                  </div>
                  <ul className="space-y-1 text-[12px]">
                    {pendingLeaves.slice(0, 3).map((l) => (
                      <li key={l.id} className="flex items-center justify-between text-[var(--color-muted)]">
                        <span>{l.employeeName} ({l.leaveTypeName})</span>
                        <span>{formatDate(l.startsOn)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {openEnquiryCount > 0 && (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/70 p-3 hover:border-[var(--color-gold-2)]/50 transition">
                  <div className="flex items-center justify-between">
                    <span className="text-[12.5px] font-semibold text-[var(--color-ivory)]">
                      {openEnquiryCount} Inbound Website Leads
                    </span>
                    <Link
                      href="/enquiries"
                      className="btn btn-primary px-2.5 py-1 text-[11px]"
                    >
                      Respond
                    </Link>
                  </div>
                </div>
              )}

              {draftJournals.length === 0 && pendingLeaves.length === 0 && openEnquiryCount === 0 && (
                <EmptyState
                  title="All queues clear"
                  body="No draft postings, pending leave applications, or unanswered enquiries at this time."
                />
              )}
            </div>
          </Panel>

          {/* Governance & Decisions */}
          <div className="space-y-5">
            <Panel
              title="Awaiting Management Decision"
              description="Platform policy items requiring confirmation from CAC directors."
            >
              {pending.length === 0 ? (
                <EmptyState
                  title="Every policy confirmed"
                  body="All platform configurations and operational constants are approved."
                />
              ) : (
                <ul className="space-y-2.5">
                  {pending.slice(0, 4).map((s) => (
                    <li
                      key={s.key}
                      className="flex items-start justify-between gap-3 border-b border-[var(--color-line)] pb-2 last:border-0 last:pb-0"
                    >
                      <div>
                        <p className="text-[12.5px] font-medium text-[var(--color-body)]">{s.label}</p>
                        {s.description && (
                          <p className="text-[11px] text-[var(--color-muted)]">{s.description}</p>
                        )}
                      </div>
                      <Badge tone="warn">Unconfirmed</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            {principal.capabilities.has("audit.view") && events.length > 0 && (
              <Panel
                title="Recent Platform Activity"
                description="Live forensic activity feed."
                action={
                  <Link
                    href="/admin/audit"
                    className="text-[12px] text-[var(--color-gold-2)] hover:underline"
                  >
                    All audit logs
                  </Link>
                }
              >
                <DataTable columns={["Action", "Entity", "User", "Time"]} caption="Audit events">
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
              </Panel>
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}
