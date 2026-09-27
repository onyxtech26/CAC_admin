import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import {
  embeddingProviderFromEnv,
  formatDate,
  getLibraryDocument,
  listIngestionEvents,
  scannerFromEnv,
} from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, LinkButton, Panel, Td } from "@/components/ui";
import {
  ArchiveForm,
  ClassifyForm,
  DestroyForm,
  PipelineButton,
  ReleaseForm,
} from "../DocumentForms";

const STAGE_TONE = {
  ok: "ok",
  blocked: "warn",
  failed: "danger",
  skipped: "neutral",
} as const;

/**
 * One document, and what has happened to it.
 *
 * The ingestion log is the heart of this page. When somebody asks why a file is not
 * searchable, the answer is a list of stages with outcomes and reasons, in order — not a
 * spinner and not a shrug. The provenance panel beside it says what is actually known: the
 * checksum, who scanned it and when, how its text was obtained and with what confidence.
 */
export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireCapability("doc.view");
  const { id } = await params;
  const db = await getDb();

  const document = await getLibraryDocument(db, principal, id);
  if (!document) notFound();

  const [events, chunks] = await Promise.all([
    listIngestionEvents(db, principal, id),
    db.execute<Record<string, unknown>>(sql`
      SELECT ordinal, page_from, page_to, char_from, char_to, token_estimate, method,
             confidence, left(text, 240) AS preview, embedding_model
        FROM library.chunk WHERE document_id = ${id} ORDER BY ordinal
    `),
  ]);

  const scanner = scannerFromEnv();
  const embedding = embeddingProviderFromEnv();

  const canUpload = principal.capabilities.has("doc.upload");
  const canArchive = principal.capabilities.has("doc.archive");
  const canDelete = principal.capabilities.has("doc.delete");
  const canDownload = principal.capabilities.has("doc.download");

  return (
    <Shell
      principal={principal}
      title={document.documentNo}
      breadcrumbs={[
        { label: "Documents", href: "/documents" },
        { label: document.documentNo },
      ]}
      actions={
        canDownload && document.readable ? (
          <LinkButton href={`/documents/${id}/file`} variant="primary">
            Download the original
          </LinkButton>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {document.scanStatus === "infected" && (
          <Alert tone="danger">
            This file was found to be infected — {document.scanDetail}. The verdict is final: it
            cannot be downloaded, read or released, by anybody.
          </Alert>
        )}

        {document.scanStatus === "quarantined" && (
          <Alert tone="warn">
            In quarantine. The file is stored and checksummed, and nothing has read it.{" "}
            {scanner.isConfigured()
              ? "Run the scan below."
              : "No scanner is configured, so the only way past is a deliberate release with a reason — which records it as unscanned, never as clean."}
          </Alert>
        )}

        {document.scanStatus === "scan_failed" && (
          <Alert tone="warn">
            The scanner could not give a verdict — {document.scanDetail}. That is not the same as
            clean, so the file stays closed.
          </Alert>
        )}

        {document.scanStatus === "released_unscanned" && (
          <Alert tone="info">
            Released without a scan by {document.releasedByName} on{" "}
            {formatDate(document.releasedAt!.slice(0, 10))}: {document.releaseReason}
          </Alert>
        )}

        {document.archivedAt && (
          <Alert tone="neutral">
            Archived on {formatDate(document.archivedAt.slice(0, 10))}. The original is kept; it no
            longer appears in search.
          </Alert>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Panel
              title="What happened to this file"
              description="In order, with the reason for anything that stopped."
            >
              {events.length === 0 ? (
                <EmptyState title="Nothing recorded" />
              ) : (
                <ol className="space-y-3">
                  {events.map((event) => (
                    <li key={event.id} className="border-l-2 border-[var(--color-line)] pl-3">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-[12px] font-medium">{event.stage}</span>
                        <Badge tone={STAGE_TONE[event.outcome]}>{event.outcome}</Badge>
                        <span className="text-[11px] text-[var(--color-muted)]">
                          {new Date(event.occurredAt).toLocaleString("en-GB", {
                            timeZone: "Asia/Kuala_Lumpur",
                          })}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[12px] text-[var(--color-body)]">{event.detail}</p>
                      <p className="text-[11px] text-[var(--color-faint)]">{event.actorLabel}</p>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>

            {chunks.rows && chunks.rows.length > 0 && (
              <Panel
                title={`Indexed passages (${chunks.rows.length})`}
                description="What search actually matches against. Each one carries where it came from."
              >
                <DataTable
                  columns={["#", "Page", "Characters", "How the text was obtained", "Passage"]}
                  caption="Indexed passages"
                >
                  {chunks.rows.map((chunk) => (
                    <tr key={String(chunk.ordinal)}>
                      <Td numeric>{String(chunk.ordinal)}</Td>
                      <Td>
                        {chunk.page_from === null
                          ? "—"
                          : chunk.page_to !== null && chunk.page_to !== chunk.page_from
                            ? `${chunk.page_from}–${chunk.page_to}`
                            : String(chunk.page_from)}
                      </Td>
                      <Td numeric>
                        {String(chunk.char_from)}–{String(chunk.char_to)}
                      </Td>
                      <Td>
                        {String(chunk.method)}
                        {chunk.confidence !== null && (
                          <span className="block text-[11px] text-[var(--color-muted)]">
                            {Math.round(Number(chunk.confidence) * 100)}% confidence
                          </span>
                        )}
                        {Boolean(chunk.embedding_model) && (
                          <span className="block text-[11px] text-[var(--color-muted)]">
                            embedded with {String(chunk.embedding_model)}
                          </span>
                        )}
                      </Td>
                      <Td>
                        <span className="text-[11px] text-[var(--color-muted)]">
                          {String(chunk.preview)}
                          {String(chunk.preview).length >= 240 ? "…" : ""}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </DataTable>
              </Panel>
            )}

            {canUpload && !document.archivedAt && (
              <Panel title="What this document is">
                <ClassifyForm
                  documentId={id}
                  defaults={{
                    title: document.title,
                    kind: document.kind ?? document.suggestedKind ?? "",
                    confidentiality: document.confidentiality,
                    notes: document.notes ?? "",
                  }}
                />
              </Panel>
            )}
          </div>

          <div className="space-y-4">
            <Panel title="What is known about it">
              <dl className="space-y-2 text-[13px]">
                <Row label="Arrived as">
                  <span className="break-all">{document.originalFilename}</span>
                </Row>
                <Row label="Type">{document.mediaType}</Row>
                <Row label="Size">{document.byteSize.toLocaleString("en-GB")} bytes</Row>
                <Row label="SHA-256">
                  <span className="break-all font-mono text-[10px]">{document.sha256}</span>
                </Row>
                <Row label="Scan">
                  {document.scanner ? (
                    <>
                      {document.scanner}
                      {document.scannerVersion ? ` ${document.scannerVersion}` : ""}
                      <span className="block text-[11px] text-[var(--color-muted)]">
                        {formatDate(document.scannedAt!.slice(0, 10))}
                      </span>
                    </>
                  ) : (
                    <span className="text-[var(--color-warn)]">nothing has scanned it</span>
                  )}
                </Row>
                <Row label="Text">
                  {document.extractionStatus === "extracted" ? (
                    <>
                      by {document.extractionMethod}
                      {document.extractionConfidence !== null &&
                        ` at ${Math.round(document.extractionConfidence * 100)}%`}
                      <span className="block text-[11px] text-[var(--color-muted)]">
                        {document.textChars?.toLocaleString("en-GB")} characters over{" "}
                        {document.pageCount} page(s)
                      </span>
                    </>
                  ) : (
                    <span className="text-[var(--color-warn)]">{document.extractionStatus}</span>
                  )}
                </Row>
                <Row label="Semantic index">
                  {document.embeddingStatus === "embedded" ? (
                    <>{document.embeddingModel}</>
                  ) : (
                    <span className="text-[var(--color-muted)]">
                      {document.embeddingStatus === "not_configured"
                        ? "no model configured"
                        : document.embeddingStatus.replace("_", " ")}
                    </span>
                  )}
                </Row>
                <Row label="Matter">
                  {document.caseNo ? (
                    <Link
                      href={`/cases/${document.caseId}`}
                      className="font-mono text-[12px] text-[var(--color-link)] hover:underline"
                    >
                      {document.caseNo}
                    </Link>
                  ) : (
                    "firm-wide"
                  )}
                </Row>
                <Row label="Confidentiality">{document.confidentiality}</Row>
                <Row label="Added by">{document.createdByName ?? "—"}</Row>
              </dl>
              {document.extractionDetail && (
                <p className="mt-3 border-t border-[var(--color-line)] pt-3 text-[12px] text-[var(--color-muted)]">
                  {document.extractionDetail}
                </p>
              )}
            </Panel>

            {canUpload && !document.archivedAt && document.scanStatus !== "infected" && (
              <Panel title="Run the pipeline again">
                <div className="space-y-3">
                  {(document.scanStatus === "quarantined" || document.scanStatus === "scan_failed") && (
                    <PipelineButton
                      documentId={id}
                      stage="scan"
                      label={scanner.isConfigured() ? "Scan it" : "Try to scan it"}
                    />
                  )}
                  {document.extractable && (
                    <PipelineButton documentId={id} stage="extract" label="Read and index it" />
                  )}
                  {document.chunkCount > 0 && (
                    <PipelineButton
                      documentId={id}
                      stage="embed"
                      label={embedding.isConfigured() ? "Embed it" : "Try to embed it"}
                    />
                  )}
                </div>
              </Panel>
            )}

            {canArchive &&
              !document.archivedAt &&
              (document.scanStatus === "quarantined" || document.scanStatus === "scan_failed") && (
                <Panel title="Release it without a scan">
                  <ReleaseForm documentId={id} />
                </Panel>
              )}

            {canArchive && !document.archivedAt && (
              <Panel title="Archive it">
                <ArchiveForm documentId={id} />
              </Panel>
            )}

            {canDelete && (
              <Panel title="Destroy the original">
                <DestroyForm documentId={id} />
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
