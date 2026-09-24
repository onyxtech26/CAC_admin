import { getDb } from "@cac/db";
import { listTemplates } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, Panel, Td } from "@/components/ui";
import { ApproveTemplate, TemplateForm } from "../LetterForms";

/**
 * Letter templates.
 *
 * Versions rather than edits: an approved version's wording is fixed, and a change is a
 * new version. So "which wording was this person sent" always has an answer, and the
 * answer does not move.
 */
export default async function TemplatesPage() {
  const principal = await requireCapability("hr.letter.generate");
  const db = await getDb();

  const templates = await listTemplates(db);
  const canApprove = principal.capabilities.has("hr.letter.approve");
  const drafts = templates.filter((row) => row.status === "draft");

  return (
    <Shell
      principal={principal}
      title="Letter templates"
      breadcrumbs={[
        { label: "Human resources" },
        { label: "Letters", href: "/hr/letters" },
        { label: "Templates" },
      ]}
    >
      <div className="space-y-4">
        <Alert tone="info">
          A template is versioned, not edited. Once a version is approved its wording is fixed, and a
          revision is a new version — so a letter can always say which form of words produced it, and
          that answer never changes.
        </Alert>

        {drafts.length > 0 && (
          <Panel
            title={`${drafts.length} awaiting approval`}
            description="A draft cannot be used to write to anybody, and whoever wrote it cannot approve it."
          >
            <DataTable
              columns={["Code", "Version", "Name", "Kind", "Written by", "Variables", ""]}
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
                      {template.createdByName ?? "—"}
                    </span>
                  </Td>
                  <Td numeric>{template.variables.length}</Td>
                  <Td>
                    {canApprove && (
                      <ApproveTemplate
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

        <Panel title={`Every version (${templates.length})`}>
          {templates.length === 0 ? (
            <EmptyState
              title="No templates yet"
              body="Write one below. Until a template is approved, no letter can be generated from it."
            />
          ) : (
            <DataTable
              columns={[
                "Code",
                "Version",
                "Name",
                "Kind",
                "Status",
                "Approved by",
                "Letters written",
                "Source",
              ]}
              caption="Letter templates"
            >
              {templates.map((template) => (
                <tr key={template.id} className={template.status === "retired" ? "opacity-60" : ""}>
                  <Td>
                    <span className="font-mono text-[12px]">{template.code}</span>
                  </Td>
                  <Td numeric>v{template.version}</Td>
                  <Td>{template.name}</Td>
                  <Td>{template.kind}</Td>
                  <Td>
                    <Badge
                      tone={
                        template.status === "approved"
                          ? "ok"
                          : template.status === "draft"
                            ? "warn"
                            : "neutral"
                      }
                    >
                      {template.status}
                    </Badge>
                  </Td>
                  <Td>
                    <span className="text-[11px] text-[var(--color-muted)]">
                      {template.approvedByName ?? "—"}
                    </span>
                  </Td>
                  <Td numeric>{template.lettersGenerated}</Td>
                  <Td>
                    <span className="text-[11px] text-[var(--color-muted)]">
                      {template.sourceRef ?? "—"}
                    </span>
                  </Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>

        <Panel title="Write a template, or a new version of one">
          <TemplateForm />
        </Panel>
      </div>
    </Shell>
  );
}
