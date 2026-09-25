import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import {
  MATTER_TYPES,
  caseDocumentDefaults,
  formatDate,
  getCase,
  getCaseDocumentTemplate,
  listCaseDocumentTemplates,
  listGeneratedDocuments,
} from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, LinkButton, Panel, Td } from "@/components/ui";
import { GenerateDocumentForm } from "../../DocumentForms";
import { CaseTabs } from "../CaseTabs";

const STATUS_TONE = {
  draft: "warn",
  approved: "info",
  finalised: "ok",
  cancelled: "neutral",
} as const;

/**
 * Documents produced for this matter.
 *
 * A document is produced from an approved template, reviewed by somebody other than whoever
 * produced it, and then finalised — at which point the PDF is rendered once, stored where it
 * cannot be altered, and its checksum recorded. Nothing on this screen edits a finalised
 * document, because the only honest correction is a new one that supersedes it.
 */
export default async function CaseDocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ template?: string }>;
}) {
  const principal = await requireCapability("case.document.generate");
  const { id } = await params;
  const { template: chosenTemplate } = await searchParams;
  const db = await getDb();

  const record = await getCase(db, principal, id);
  if (!record) notFound();

  const [documents, templates] = await Promise.all([
    listGeneratedDocuments(db, principal, id),
    listCaseDocumentTemplates(db, { status: "approved", matterType: record.matterType }),
  ]);

  const selected = chosenTemplate ? await getCaseDocumentTemplate(db, chosenTemplate) : null;
  const usable =
    selected && selected.status === "approved"
      ? selected
      : null;

  const defaults = usable
    ? await caseDocumentDefaults(db, principal, id, usable.variables)
    : {};

  const closed = record.status === "closed" || record.status === "withdrawn";
  const supersedable = documents.filter(
    (document) =>
      (document.status === "finalised" || document.status === "approved") &&
      !document.supersededByNo,
  );

  return (
    <Shell
      principal={principal}
      title={`${record.caseNo} — documents`}
      breadcrumbs={[
        { label: "Cases", href: "/cases" },
        { label: record.caseNo, href: `/cases/${id}` },
        { label: "Documents" },
      ]}
      actions={
        principal.capabilities.has("case.document.generate") ? (
          <LinkButton href="/cases/templates">Templates</LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <CaseTabs caseId={id} active="documents" />

        {templates.length === 0 && (
          <Alert tone="warn">
            No approved template applies to a{" "}
            {MATTER_TYPES.find((type) => type.value === record.matterType)?.label.toLowerCase() ??
              record.matterType}{" "}
            matter, so nothing can be produced. A template names the form or precedent its wording
            follows and is approved by somebody other than whoever wrote it —{" "}
            <Link href="/cases/templates" className="underline">
              write one
            </Link>
            .
          </Alert>
        )}

        {closed && (
          <Alert tone="neutral">
            This matter is {record.status}; nothing further can be produced for it until it is
            reopened.
          </Alert>
        )}

        <Panel title={`Produced for this matter (${documents.length})`}>
          {documents.length === 0 ? (
            <EmptyState title="Nothing produced yet" />
          ) : (
            <DataTable
              columns={["Reference", "Document", "From", "Status", "Reviewed by", "Produced"]}
              caption="Documents produced for this matter"
            >
              {documents.map((document) => (
                <tr
                  key={document.id}
                  className={
                    document.status === "cancelled" || document.supersededByNo ? "opacity-70" : ""
                  }
                >
                  <Td>
                    <Link
                      href={`/cases/${id}/documents/${document.id}`}
                      className="font-mono text-[12px] text-[var(--color-info)] hover:underline"
                    >
                      {document.documentNo}
                    </Link>
                  </Td>
                  <Td>
                    {document.title}
                    <span className="block text-[11px] text-[var(--color-muted)]">
                      {document.kind}
                      {document.supersedesNo && ` · replaces ${document.supersedesNo}`}
                      {document.supersededByNo && ` · replaced by ${document.supersededByNo}`}
                    </span>
                  </Td>
                  <Td>
                    <span className="font-mono text-[11px]">
                      {document.templateCode} v{document.templateVersion}
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[document.status]}>{document.status}</Badge>
                  </Td>
                  <Td>
                    <span className="text-[11px]">{document.reviewedByName ?? "—"}</span>
                  </Td>
                  <Td>{formatDate(document.createdAt.slice(0, 10))}</Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>

        {!closed && (
          <Panel
            title="Produce a document"
            description="From an approved template. Values are suggested from what the matter already knows, and every one can be overwritten."
          >
            <GenerateDocumentForm
              caseId={id}
              templates={templates.map((template) => ({
                value: template.id,
                label: `${template.name} (${template.code} v${template.version})`,
              }))}
              variables={
                usable
                  ? usable.variables.map((variable) => ({
                      key: variable.key,
                      label: variable.label,
                      type: variable.type,
                      required: variable.required !== false,
                      hint: variable.hint,
                    }))
                  : []
              }
              defaults={defaults}
              templateId={usable?.id ?? null}
              supersedes={supersedable.map((document) => ({
                value: document.id,
                label: `${document.documentNo} — ${document.title}`,
              }))}
            />
            {usable && (
              <p className="mt-3 text-[11px] text-[var(--color-muted)]">
                {usable.name} · {usable.code} v{usable.version}
                {usable.sourceRef ? ` · follows ${usable.sourceRef}` : ""} ·{" "}
                <Link href={`/cases/${id}/documents`} className="text-[var(--color-info)] hover:underline">
                  choose a different one
                </Link>
              </p>
            )}
          </Panel>
        )}
      </div>
    </Shell>
  );
}
