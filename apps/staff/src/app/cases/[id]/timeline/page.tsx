import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import { formatDate, getCase, listCaseEvents, toIsoDate, today } from "@cac/core";
import { requireAnyCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, EmptyState, Panel } from "@/components/ui";
import { MilestoneForm } from "../../CaseForms";
import { CaseTabs } from "../CaseTabs";

/**
 * What happened in the matter.
 *
 * Deliberately not the audit trail. The audit trail answers "who did what in this
 * system"; this answers "what happened in this matter" — the death, the instruction,
 * the filing, the grant. `origin` keeps the two kinds of entry apart: what the platform
 * observed as a side effect of work, and what somebody typed in because it happened in
 * a registry rather than in a browser.
 *
 * Append-only, at the database. A correction is another entry saying so.
 */
export default async function CaseTimelinePage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireAnyCapability(["case.view", "case.view_all"]);
  const { id } = await params;
  const db = await getDb();

  const record = await getCase(db, principal, id);
  if (!record) notFound();

  const events = await listCaseEvents(db, principal, id, 500);
  const canEdit = principal.capabilities.has("case.edit");
  const closed = record.status === "closed" || record.status === "withdrawn";

  return (
    <Shell
      principal={principal}
      title={`${record.caseNo} — history`}
      breadcrumbs={[
        { label: "Cases", href: "/cases" },
        { label: record.caseNo, href: `/cases/${id}` },
        { label: "History" },
      ]}
    >
      <div className="space-y-4">
        <CaseTabs caseId={id} active="timeline" />

        <Alert tone="info">
          Append-only. An entry is never edited or removed — a correction is another entry saying
          so, which is visible, rather than a quiet rewrite of what the file says happened.
        </Alert>

        <Panel title={`${events.length} entr${events.length === 1 ? "y" : "ies"}`}>
          {events.length === 0 ? (
            <EmptyState title="Nothing recorded yet" />
          ) : (
            <ol className="space-y-4">
              {events.map((event) => (
                <li key={event.id} className="border-l-2 border-[var(--color-line)] pl-4">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-[12px] font-medium tabular-nums">
                      {formatDate(event.occurredAt.slice(0, 10))}
                    </span>
                    <Badge tone={event.origin === "recorded" ? "warn" : "neutral"}>
                      {event.origin === "recorded" ? "recorded by hand" : "observed"}
                    </Badge>
                    <span className="text-[11px] text-[var(--color-muted)]">{event.kind}</span>
                  </div>
                  <p className="mt-1 text-[13px]">{event.summary}</p>
                  <p className="text-[11px] text-[var(--color-muted)]">
                    {event.actorLabel ?? "the platform"}
                    {event.origin === "recorded" &&
                      ` · entered ${formatDate(event.recordedAt.slice(0, 10))}`}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Panel>

        {canEdit && !closed && (
          <Panel
            title="Record something that happened"
            description="Outside this platform — at a registry, in a meeting, on the telephone."
          >
            <MilestoneForm caseId={id} today={toIsoDate(today())} />
          </Panel>
        )}
      </div>
    </Shell>
  );
}
