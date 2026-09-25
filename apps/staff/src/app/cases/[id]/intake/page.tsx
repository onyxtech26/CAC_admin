import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import {
  describeCondition,
  getCase,
  listCaseFacts,
  previewChecklist,
} from "@cac/core";
import { requireAnyCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, EmptyState, Panel, StatTile } from "@/components/ui";
import { FactAnswerForm, RebuildChecklistForm } from "../../CaseForms";
import { CaseTabs } from "../CaseTabs";

/**
 * Intake: the facts of the matter.
 *
 * This screen is the input to the rule engine, and the reason a checklist can be
 * scenario-driven rather than a fixed list. Every question shown is one a rule can
 * read; "not known" is a real answer, and it is the one that keeps a requirement on the
 * checklist with a flag rather than dropping it silently.
 *
 * The panel at the bottom shows what each approved rule currently makes of these
 * facts — before anything is written — so somebody can see the effect of an answer
 * rather than discovering it afterwards.
 */
export default async function IntakePage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireAnyCapability(["case.view", "case.view_all"]);
  const { id } = await params;
  const db = await getDb();

  const record = await getCase(db, principal, id);
  if (!record) notFound();

  const [facts, preview] = await Promise.all([
    listCaseFacts(db, principal, id),
    previewChecklist(db, principal, id),
  ]);

  const canEdit = principal.capabilities.has("case.edit");
  const canRebuild = principal.capabilities.has("case.checklist.manage");
  const closed = record.status === "closed" || record.status === "withdrawn";

  const answered = facts.filter((fact) => fact.answered && fact.value !== null).length;
  const unknown = facts.filter((fact) => fact.status === "unknown").length;
  const unasked = facts.filter((fact) => !fact.answered).length;

  const labels = new Map(facts.map((fact) => [fact.factKey, fact.label]));

  return (
    <Shell
      principal={principal}
      title={`${record.caseNo} — intake`}
      breadcrumbs={[
        { label: "Cases", href: "/cases" },
        { label: record.caseNo, href: `/cases/${id}` },
        { label: "Intake" },
      ]}
    >
      <div className="space-y-4">
        <CaseTabs caseId={id} active="intake" />

        {facts.length === 0 && (
          <Alert tone="warn">
            No intake question has been declared for this kind of matter, so there is nothing to
            record and no rule can decide anything.{" "}
            {principal.capabilities.has("case.rule.view") && (
              <Link href="/cases/rules" className="underline">
                Declare the questions
              </Link>
            )}
          </Alert>
        )}

        {closed && <Alert tone="neutral">This matter is {record.status}; the facts are fixed.</Alert>}

        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile label="Answered" value={String(answered)} />
          <StatTile
            label="Recorded as not known"
            value={String(unknown)}
            hint={unknown > 0 ? "Requirements that need these stay on the checklist, flagged." : undefined}
            tone="warn"
          />
          <StatTile label="Not yet asked" value={String(unasked)} />
        </div>

        <Panel
          title="The facts of this matter"
          description="Each question is one the approved rules can read. What the answers require is decided by those rules, not here."
        >
          {facts.length === 0 ? (
            <EmptyState title="No questions declared" />
          ) : (
            <div className="space-y-4">
              {facts.map((fact) => (
                <div
                  key={fact.factKey}
                  className="grid gap-3 border-b border-[var(--color-line)] pb-4 last:border-0 last:pb-0 sm:grid-cols-[1fr_280px]"
                >
                  <div>
                    <p className="text-[13px] font-medium">{fact.prompt ?? fact.label}</p>
                    <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">
                      <span className="font-mono">{fact.factKey}</span> · {fact.kind}
                      {fact.options.length > 0 && ` · ${fact.options.join(" / ")}`}
                    </p>
                    {fact.helpText && (
                      <p className="mt-1 text-[12px] text-[var(--color-muted)]">{fact.helpText}</p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {fact.status === null && <Badge tone="neutral">not asked</Badge>}
                      {fact.status === "unknown" && <Badge tone="warn">not known</Badge>}
                      {fact.status === "stated" && <Badge tone="info">stated</Badge>}
                      {fact.status === "verified" && <Badge tone="ok">verified</Badge>}
                      {fact.value !== null && (
                        <span className="text-[12px]">
                          {fact.kind === "boolean"
                            ? fact.value === "true"
                              ? "Yes"
                              : "No"
                            : fact.value}
                        </span>
                      )}
                    </div>
                    {fact.sourceNote && (
                      <p className="mt-1 text-[11px] text-[var(--color-muted)]">
                        Source: {fact.sourceNote}
                      </p>
                    )}
                    {fact.verifiedByName && (
                      <p className="mt-1 text-[11px] text-[var(--color-muted)]">
                        Verified by {fact.verifiedByName}
                      </p>
                    )}
                  </div>
                  {canEdit && !closed && (
                    <FactAnswerForm
                      caseId={id}
                      factKey={fact.factKey}
                      kind={fact.kind}
                      options={fact.options}
                      value={fact.value}
                      sourceNote={fact.sourceNote}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="What the rules make of these facts"
          description="Read-only. Nothing here has been written to the checklist yet."
        >
          {preview.length === 0 ? (
            <EmptyState
              title="No approved rule applies to this kind of matter"
              body="A checklist is built from rules that name their authority and are approved by somebody qualified to approve them. None has been entered (Q-LEGAL-1, Q-LEGAL-2)."
            />
          ) : (
            <ul className="space-y-3">
              {preview.map((entry) => (
                <li key={entry.rule.id} className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[13px]">
                      {entry.rule.title}
                      <span className="ml-2 font-mono text-[11px] text-[var(--color-muted)]">
                        {entry.rule.code} v{entry.rule.version}
                      </span>
                    </p>
                    <p className="text-[11px] text-[var(--color-muted)]">
                      Applies when: {describeCondition(entry.rule.appliesWhen, labels)}
                    </p>
                    <p className="text-[11px] text-[var(--color-muted)]">
                      Authority: {entry.rule.sourceRef}
                    </p>
                    {entry.missing.length > 0 && (
                      <p className="text-[11px] text-[var(--color-warn)]">
                        Cannot be decided until:{" "}
                        {entry.missing.map((key) => labels.get(key) ?? key).join(", ")}
                      </p>
                    )}
                  </div>
                  <Badge
                    tone={
                      entry.verdict === "applies"
                        ? "info"
                        : entry.verdict === "undecided"
                          ? "warn"
                          : "neutral"
                    }
                  >
                    {entry.verdict}
                    {entry.alreadyOnList ? " · on the list" : ""}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {canRebuild && !closed && (
          <Panel
            title="Rebuild the checklist"
            description="Adds what now applies, flags what cannot be decided, and marks what has fallen away — with the reason. Nothing already satisfied or waived is touched."
          >
            <RebuildChecklistForm caseId={id} />
          </Panel>
        )}
      </div>
    </Shell>
  );
}
