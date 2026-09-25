import { getDb } from "@cac/db";
import { MATTER_TYPES, formatDate, getSetting, listCaseDocumentTemplates } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, DataTable, EmptyState, Panel, Td } from "@/components/ui";
import { ApproveCaseTemplate, CaseTemplateForm } from "../DocumentForms";

/**
 * Templates for case documents.
 *
 * Versioned, not edited: an approved version's wording is fixed and a change is a new version, so
 * "which form of words produced this application" has an answer that does not move.
 *
 * Two gates before a template can produce anything. Somebody other than its author has to approve
 * it — and for an application, an affidavit or a schedule, an authorised legal reviewer has to
 * have been appointed first. Holding the capability and being the person CAC appointed are
 * different facts, and only the second makes an approval mean anything (Q-LEGAL-1).
 */
export default async function CaseTemplatesPage() {
  const principal = await requireCapability("case.document.generate");
  const db = await getDb();

  const [templates, reviewerConfirmed] = await Promise.all([
    listCaseDocumentTemplates(db),
    getSetting<boolean>(db, "cases.legal_reviewer_confirmed", false),
  ]);

  const canApprove = principal.capabilities.has("case.document.approve");
  const drafts = templates.filter((template) => template.status === "draft");
  const approved = templates.filter((template) => template.status === "approved");
  const retired = templates.filter((template) => template.status === "retired");

  const matterTypeOptions = MATTER_TYPES.map((type) => ({ value: type.value, label: type.label }));

  return (
    <Shell
      principal={principal}
      title="Case document templates"
      breadcrumbs={[{ label: "Cases", href: "/cases" }, { label: "Templates" }]}
    >
      <div className="space-y-4">
        <Alert tone="info">
          A template is versioned, not edited. Once a version is approved its wording is fixed and a
          revision is a new version — so a document can always say which form of words produced it,
          and that answer never changes. A document also keeps its own copy of the wording, so a
          revision cannot reach back into anything already produced.
        </Alert>

        {!reviewerConfirmed && (
          <Alert tone="warn">
            No authorised legal reviewer has been appointed, so applications, affidavits and
            schedules cannot be approved — by anybody, including a director. An administrator
            confirms the appointment in settings once a named, qualified person holds{" "}
            <span className="font-mono">case.document.approve</span> (Q-LEGAL-1). Until then
            templates can be written and circulated as drafts, and a draft produces nothing.
          </Alert>
        )}

        {drafts.length > 0 && (
          <Panel
            title={`${drafts.length} awaiting approval`}
            description="A draft produces nothing, and whoever wrote it cannot approve it."
          >
            <DataTable
              columns={["Code", "Version", "Name", "Kind", "Follows", "Written by", "Variables", ""]}
              caption="Draft templates"
            >
              {drafts.map((template) => (
                <tr key={template.id}>
                  <Td>
                    <span className="font-mono text-[12px]">{template.code}</span>
                  </Td>
                  <Td numeric>v{template.version}</Td>
                  <Td>{template.name}</Td>
                  <Td>{template.kind}</Td>
                  <Td>
                    <span className="text-[11px] text-[var(--color-muted)]">
                      {template.sourceRef ?? "—"}
                    </span>
                  </Td>
                  <Td>
                    <span className="text-[11px] text-[var(--color-muted)]">
                      {template.createdByName ?? "—"}
                    </span>
                  </Td>
                  <Td numeric>{template.variables.length}</Td>
                  <Td>
                    {canApprove && (
                      <ApproveCaseTemplate
                        templateId={template.id}
                        label={`${template.code} v${template.version}`}
                      />
                    )}
                  </Td>
                </tr>
              ))}
            </DataTable>
          </Panel>
        )}

        <Panel title={`In use (${approved.length})`}>
          {approved.length === 0 ? (
            <EmptyState
              title="No template is approved"
              body="Nothing can be produced for any matter until one is. Write one below."
            />
          ) : (
            <DataTable
              columns={[
                "Code",
                "Version",
                "Name",
                "Kind",
                "Matters",
                "Follows",
                "Approved by",
                "Produced",
              ]}
              caption="Approved templates"
            >
              {approved.map((template) => (
                <tr key={template.id}>
                  <Td>
                    <span className="font-mono text-[12px]">{template.code}</span>
                  </Td>
                  <Td numeric>v{template.version}</Td>
                  <Td>{template.name}</Td>
                  <Td>{template.kind}</Td>
                  <Td>
                    <span className="text-[11px]">
                      {template.matterTypes.length === 0
                        ? "any"
                        : template.matterTypes
                            .map(
                              (type) =>
                                MATTER_TYPES.find((entry) => entry.value === type)?.label ?? type,
                            )
                            .join(", ")}
                    </span>
                  </Td>
                  <Td>
                    <span className="text-[11px] text-[var(--color-muted)]">
                      {template.sourceRef ?? "—"}
                    </span>
                  </Td>
                  <Td>
                    <span className="text-[11px] text-[var(--color-muted)]">
                      {template.approvedByName ?? "—"}
                      {template.approvedAt && (
                        <span className="block">
                          {formatDate(template.approvedAt.slice(0, 10))}
                        </span>
                      )}
                    </span>
                  </Td>
                  <Td numeric>{template.documentsGenerated}</Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>

        {retired.length > 0 && (
          <Panel
            title={`Superseded (${retired.length})`}
            description="Kept, because documents produced from these still name them."
          >
            <DataTable columns={["Code", "Version", "Name", "Follows", "Produced"]} caption="Retired templates">
              {retired.map((template) => (
                <tr key={template.id} className="opacity-70">
                  <Td>
                    <span className="font-mono text-[12px]">{template.code}</span>
                  </Td>
                  <Td numeric>v{template.version}</Td>
                  <Td>{template.name}</Td>
                  <Td>
                    <span className="text-[11px] text-[var(--color-muted)]">
                      {template.sourceRef ?? "—"}
                    </span>
                  </Td>
                  <Td numeric>{template.documentsGenerated}</Td>
                </tr>
              ))}
            </DataTable>
          </Panel>
        )}

        <Panel title="Write a template, or a new version of one">
          <CaseTemplateForm matterTypes={matterTypeOptions} />
        </Panel>

        <Panel title="What a template may contain">
          <ul className="space-y-1 text-[12px] text-[var(--color-muted)]">
            <li>
              <span className="font-mono">{"{{key}}"}</span> — a placeholder for a declared
              variable. One that nothing declares is refused when the template is saved.
            </li>
            <li>
              <span className="font-mono">{"{{#if flag}}…{{else}}…{{/if}}"}</span> — a conditional
              clause on a yes/no variable.
            </li>
            <li>
              Nothing else. No loops, no arithmetic, no expressions: a court document is not the
              place for a computed clause nobody reviewed.
            </li>
            <li>
              A required variable left blank is refused at the point of producing the document, not
              printed as a gap.
            </li>
          </ul>
        </Panel>
      </div>
    </Shell>
  );
}
