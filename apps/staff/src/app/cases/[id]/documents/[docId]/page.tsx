import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@cac/db";
import { formatDate, getCase, getGeneratedDocument } from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, LinkButton, Panel, Td } from "@/components/ui";
import { DocumentActions } from "../../../DocumentForms";
import { CaseTabs } from "../../CaseTabs";

const STATUS_TONE = {
  draft: "warn",
  approved: "info",
  finalised: "ok",
  cancelled: "neutral",
} as const;

/**
 * One generated document.
 *
 * The page prints the stored rendered text — the same text the Word file and the PDF print,
 * because nothing re-renders the template. Beside it is the provenance: which template version,
 * which authority that template follows, what the matter looked like when the document was
 * produced, who reviewed it, and whether any model was involved.
 */
export default async function GeneratedDocumentPage({
  params,
}: {
  params: Promise<{ id: string; docId: string }>;
}) {
  const principal = await requireCapability("case.document.generate");
  const { id, docId } = await params;
  const db = await getDb();

  const [record, document] = await Promise.all([
    getCase(db, principal, id),
    getGeneratedDocument(db, principal, docId),
  ]);
  if (!record || !document || document.caseId !== id) notFound();

  const snapshot = document.caseSnapshot as {
    takenAt?: string;
    parties?: { total?: number; verified?: number; byRole?: Record<string, number> };
    assets?: { total?: number; valued?: number; unvalued?: number };
    liabilities?: { total?: number; unvalued?: number };
    position?: { assetTotal?: string; liabilityTotal?: string; net?: string; incomplete?: boolean };
    checklist?: { total?: number; undecided?: number; byStatus?: Record<string, number> };
    facts?: Record<string, string>;
  };

  return (
    <Shell
      principal={principal}
      title={document.documentNo}
      breadcrumbs={[
        { label: "Cases", href: "/cases" },
        { label: record.caseNo, href: `/cases/${id}` },
        { label: "Documents", href: `/cases/${id}/documents` },
        { label: document.documentNo },
      ]}
      actions={
        <div className="flex gap-2">
          <LinkButton href={`/cases/${id}/documents/${docId}/docx`}>Word</LinkButton>
          <LinkButton href={`/cases/${id}/documents/${docId}/pdf`} variant="primary">
            PDF
          </LinkButton>
        </div>
      }
    >
      <div className="space-y-4">
        <CaseTabs caseId={id} active="documents" />

        {document.status === "draft" && (
          <Alert tone="warn">
            A draft. Nobody has reviewed it, and both the Word file and the PDF say so on their
            face — a draft application that looked identical to a filed one would be treated as
            one.
          </Alert>
        )}

        {document.status === "approved" && (
          <Alert tone="info">
            Reviewed by {document.reviewedByName} on {formatDate(document.reviewedAt!.slice(0, 10))}
            {document.reviewNote ? `: ${document.reviewNote}` : ""}. Not finalised yet, so the PDF
            still carries a banner.
          </Alert>
        )}

        {document.status === "cancelled" && (
          <Alert tone="danger">Cancelled: {document.cancelReason}</Alert>
        )}

        {document.supersededByNo && (
          <Alert tone="info">
            Replaced by {document.supersededByNo}. This document is unchanged — it is what was
            produced, and it stays that way.
          </Alert>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Panel title={document.title}>
              {/* The stored rendered text, exactly as the Word file and the PDF print it.
                  Nothing re-renders the template here. */}
              <div className="whitespace-pre-wrap text-[13px] leading-relaxed">
                {document.bodyRendered}
              </div>
            </Panel>

            <Panel
              title="What it was filled in with"
              description="Kept with the document, so a figure on it can be traced and so it could be re-rendered identically."
            >
              <DataTable columns={["Field", "Value"]} caption="Values used">
                {document.variables.map((variable) => (
                  <tr key={variable.key}>
                    <Td>
                      {variable.label}
                      <span className="ml-1 font-mono text-[10px] text-[var(--color-faint)]">
                        {variable.key}
                      </span>
                    </Td>
                    <Td>
                      {(() => {
                        const value = document.valuesUsed[variable.key];
                        if (variable.type === "boolean") return value ? "Yes" : "No";
                        return String(value ?? "") || (
                          <span className="text-[var(--color-faint)]">not set</span>
                        );
                      })()}
                    </Td>
                  </tr>
                ))}
              </DataTable>
            </Panel>

            <Panel
              title="What the matter looked like when this was produced"
              description="An estate keeps moving. This is what the document was describing."
            >
              <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
                <Row label="Taken">
                  {snapshot.takenAt ? formatDate(snapshot.takenAt.slice(0, 10)) : "—"}
                </Row>
                <Row label="People on the file">
                  {snapshot.parties?.total ?? 0}
                  {snapshot.parties?.verified !== undefined &&
                    ` (${snapshot.parties.verified} verified)`}
                </Row>
                <Row label="Assets">
                  {snapshot.assets?.total ?? 0}
                  {snapshot.assets?.unvalued ? ` (${snapshot.assets.unvalued} with no figure)` : ""}
                </Row>
                <Row label="Liabilities">
                  {snapshot.liabilities?.total ?? 0}
                  {snapshot.liabilities?.unvalued
                    ? ` (${snapshot.liabilities.unvalued} with no figure)`
                    : ""}
                </Row>
                <Row label="Assets recorded">RM {snapshot.position?.assetTotal ?? "—"}</Row>
                <Row label="Liabilities recorded">RM {snapshot.position?.liabilityTotal ?? "—"}</Row>
                <Row label="Net">RM {snapshot.position?.net ?? "—"}</Row>
                <Row label="Checklist">
                  {snapshot.checklist?.total ?? 0} item(s)
                  {snapshot.checklist?.undecided
                    ? `, ${snapshot.checklist.undecided} waiting on an answer`
                    : ""}
                </Row>
              </dl>
              {snapshot.position?.incomplete && (
                <p className="mt-2 text-[12px] text-[var(--color-warn)]">
                  The totals were incomplete at the time: something in the inventory had no figure.
                </p>
              )}
              {snapshot.facts && Object.keys(snapshot.facts).length > 0 && (
                <p className="mt-2 text-[11px] text-[var(--color-muted)]">
                  Facts of record:{" "}
                  {Object.entries(snapshot.facts)
                    .map(([key, value]) => `${key}=${value}`)
                    .join(", ")}
                </p>
              )}
            </Panel>
          </div>

          <div className="space-y-4">
            <Panel title="Provenance">
              <dl className="space-y-2 text-[13px]">
                <Row label="Status">
                  <Badge tone={STATUS_TONE[document.status]}>{document.status}</Badge>
                </Row>
                <Row label="Matter">
                  <Link
                    href={`/cases/${id}`}
                    className="font-mono text-[12px] text-[var(--color-info)] hover:underline"
                  >
                    {document.caseNo}
                  </Link>
                </Row>
                <Row label="Template">
                  <span className="font-mono text-[12px]">
                    {document.templateCode} v{document.templateVersion}
                  </span>
                </Row>
                <Row label="Follows">{document.sourceRef ?? "—"}</Row>
                <Row label="Produced by">{document.createdByName ?? "—"}</Row>
                <Row label="Produced">{formatDate(document.createdAt.slice(0, 10))}</Row>
                <Row label="Reviewed by">{document.reviewedByName ?? "—"}</Row>
                <Row label="Finalised by">{document.finalisedByName ?? "—"}</Row>
                <Row label="Model">
                  {document.assistantUsed ? (
                    `${document.modelName} ${document.modelVersion}`
                  ) : (
                    <span className="text-[var(--color-muted)]">none was involved</span>
                  )}
                </Row>
                {document.pdfSha256 && (
                  <Row label="PDF checksum">
                    <span className="break-all font-mono text-[10px]">{document.pdfSha256}</span>
                  </Row>
                )}
              </dl>
              {document.pdfDocumentId && (
                <p className="mt-3 border-t border-[var(--color-line)] pt-3 text-[12px]">
                  <Link
                    href={`/documents/${document.pdfDocumentId}`}
                    className="text-[var(--color-info)] hover:underline"
                  >
                    The stored PDF in the library
                  </Link>
                </p>
              )}
              {document.notes && (
                <p className="mt-2 text-[12px] text-[var(--color-muted)]">{document.notes}</p>
              )}
            </Panel>

            <Panel title="What happens next">
              <DocumentActions
                caseId={id}
                documentId={docId}
                status={document.status}
                isAuthor={document.createdBy === principal.userId}
                canApprove={principal.capabilities.has("case.document.approve")}
                canGenerate={principal.capabilities.has("case.document.generate")}
              />
            </Panel>

            {document.status === "finalised" && !document.supersededByNo && (
              <Panel title="If it was wrong">
                <p className="text-[12px] text-[var(--color-muted)]">
                  Produce a corrected document that supersedes this one. Both stay on the record,
                  which is what anybody holding a copy of the first deserves.
                </p>
                <p className="mt-2 text-[12px]">
                  <Link
                    href={`/cases/${id}/documents`}
                    className="text-[var(--color-info)] hover:underline"
                  >
                    Produce the correction
                  </Link>
                </p>
              </Panel>
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-[var(--color-muted)]">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
