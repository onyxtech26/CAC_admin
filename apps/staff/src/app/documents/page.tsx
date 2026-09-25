import Link from "next/link";
import { getDb } from "@cac/db";
import {
  MAX_UPLOAD_BYTES,
  embeddingProviderFromEnv,
  formatDate,
  librarySummary,
  listCases,
  listLibraryDocuments,
  scannerFromEnv,
  searchLibrary,
  type ScanStatus,
} from "@cac/core";
import { requireCapability } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { Alert, Badge, DataTable, EmptyState, Panel, StatTile, Td } from "@/components/ui";
import { UploadForm } from "./DocumentForms";

const SCAN_TONE: Record<ScanStatus, "ok" | "warn" | "danger" | "neutral" | "info"> = {
  clean: "ok",
  quarantined: "warn",
  scan_failed: "warn",
  infected: "danger",
  released_unscanned: "info",
};

const SCAN_LABEL: Record<ScanStatus, string> = {
  clean: "scanned clean",
  quarantined: "in quarantine",
  scan_failed: "scan failed",
  infected: "infected",
  released_unscanned: "released unscanned",
};

/**
 * The document library.
 *
 * The search on this page is full-text over the extracted text of the documents the caller
 * may see — permission-filtered in the query, not afterwards. It says so, because it is not
 * semantic search: no embedding model is configured, and a search that implied otherwise
 * would make an empty result look like an answer.
 *
 * Underneath the results is the list of documents that hold text nobody can search, with
 * the reason for each. "Not found" and "never read" are different statements, and a library
 * that conflates them is a library that quietly loses documents.
 */
export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; case?: string }>;
}) {
  const principal = await requireCapability("doc.view");
  const db = await getDb();
  const filters = await searchParams;

  const scanner = scannerFromEnv();
  const embedding = embeddingProviderFromEnv();

  const query = filters.q?.trim() || "";
  const [summary, documents, cases] = await Promise.all([
    librarySummary(db, principal, scanner, embedding),
    listLibraryDocuments(db, principal, {
      scanStatus: (filters.status as ScanStatus | undefined) || undefined,
      caseId: filters.case || undefined,
    }),
    principal.capabilities.has("case.view") || principal.capabilities.has("case.view_all")
      ? listCases(db, principal, { status: "active", limit: 100 })
      : Promise.resolve([]),
  ]);

  const results =
    query.length >= 2
      ? await searchLibrary(db, principal, query, { includeUnscanned: true, limit: 30 }).catch(
          () => null,
        )
      : null;

  const canUpload = principal.capabilities.has("doc.upload");

  return (
    <Shell
      principal={principal}
      title="Document library"
      breadcrumbs={[{ label: "Documents" }]}
    >
      <div className="space-y-4">
        {!scanner.isConfigured() && (
          <Alert tone="warn">
            No malware scanner is configured. Files can be uploaded, checksummed and stored, and
            they stay in quarantine — unreadable and unsearchable — until either a scanner is
            configured (<span className="font-mono">CAC_CLAMAV_HOST</span>) or somebody releases
            one with a reason, which records it as <em>unscanned</em> rather than clean.
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Documents" value={String(summary.total)} />
          <StatTile
            label="Searchable"
            value={String(summary.searchable)}
            hint={`${summary.chunks} indexed passage(s)`}
          />
          <StatTile
            label="In quarantine"
            value={String(summary.quarantined)}
            hint={summary.quarantined > 0 ? "Stored, not read" : undefined}
            tone="warn"
          />
          <StatTile
            label="Need OCR"
            value={String(summary.needsOcr)}
            hint={summary.needsOcr > 0 ? "Scans and images; no engine configured" : undefined}
            tone="warn"
          />
        </div>

        {(summary.infected > 0 || summary.releasedUnscanned > 0) && (
          <Alert tone={summary.infected > 0 ? "danger" : "info"}>
            {summary.infected > 0 &&
              `${summary.infected} file(s) were found to be infected and can never be opened. `}
            {summary.releasedUnscanned > 0 &&
              `${summary.releasedUnscanned} file(s) were released without a scan, each with a recorded reason.`}
          </Alert>
        )}

        {/* ---------------------------------------------------------------- */}
        <Panel
          title="Search the documents"
          description="Full-text over the extracted text, filtered to what you may see."
        >
          <form method="get" className="flex flex-wrap items-end gap-2">
            <div className="grow">
              <label htmlFor="q" className="block text-[11px] text-[var(--color-muted)]">
                Words to look for
              </label>
              <input
                id="q"
                name="q"
                defaultValue={query}
                placeholder="grant of probate, harta pusaka, death certificate"
                className="w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
              />
            </div>
            <button
              type="submit"
              className="rounded-md bg-[var(--color-navy)] px-3 py-2 text-[13px] font-medium text-white"
            >
              Search
            </button>
          </form>

          {results && (
            <div className="mt-4 space-y-4">
              <p className="text-[11px] text-[var(--color-muted)]">{results.semanticNote}</p>

              {results.hits.length === 0 ? (
                <EmptyState
                  title={`Nothing matches “${query}”`}
                  body="In the text that has been read. Anything listed below as unsearchable was never read at all."
                />
              ) : (
                <ol className="space-y-3">
                  {results.hits.map((hit) => (
                    <li
                      key={hit.chunkId}
                      className="rounded-md border border-[var(--color-line)] p-3"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <Link
                          href={`/documents/${hit.documentId}`}
                          className="text-[13px] font-medium text-[var(--color-info)] hover:underline"
                        >
                          {hit.documentTitle}
                        </Link>
                        <span className="font-mono text-[11px] text-[var(--color-muted)]">
                          {hit.documentNo}
                          {hit.caseNo ? ` · ${hit.caseNo}` : ""}
                        </span>
                      </div>
                      <p
                        className="mt-1 text-[13px] leading-relaxed"
                        // The excerpt comes from ts_headline with « » as the markers, so it
                        // is rendered as text: no HTML from a document reaches the page.
                      >
                        {hit.excerpt}
                      </p>
                      <p className="mt-1 text-[11px] text-[var(--color-muted)]">
                        passage {hit.ordinal}
                        {hit.pageFrom !== null &&
                          ` · page ${hit.pageFrom}${
                            hit.pageTo !== null && hit.pageTo !== hit.pageFrom
                              ? `–${hit.pageTo}`
                              : ""
                          }`}
                        {` · characters ${hit.charFrom}–${hit.charTo}`}
                        {` · text read by ${hit.method}`}
                        {hit.confidence !== null &&
                          ` at ${Math.round(hit.confidence * 100)}% confidence`}
                        {hit.scanStatus === "released_unscanned" && " · file released unscanned"}
                      </p>
                    </li>
                  ))}
                </ol>
              )}

              {results.unsearchable.length > 0 && (
                <div className="rounded-md border border-dashed border-[var(--color-line-strong)] p-3">
                  <p className="text-[12px] font-medium">
                    {results.unsearchable.length} document(s) hold text nobody can search
                  </p>
                  <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">
                    Not found and never read are different answers. These are the second.
                  </p>
                  <ul className="mt-2 space-y-1">
                    {results.unsearchable.map((entry) => (
                      <li key={entry.documentNo} className="text-[12px]">
                        <span className="font-mono text-[11px] text-[var(--color-muted)]">
                          {entry.documentNo}
                        </span>{" "}
                        {entry.title} — <span className="text-[var(--color-muted)]">{entry.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Panel>

        {/* ---------------------------------------------------------------- */}
        <Panel title={`Everything held (${documents.length})`}>
          <form method="get" className="mb-3 flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="status" className="block text-[11px] text-[var(--color-muted)]">
                Scan status
              </label>
              <select
                id="status"
                name="status"
                defaultValue={filters.status ?? ""}
                className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 text-[13px]"
              >
                <option value="">Any</option>
                <option value="clean">Scanned clean</option>
                <option value="quarantined">In quarantine</option>
                <option value="released_unscanned">Released unscanned</option>
                <option value="scan_failed">Scan failed</option>
                <option value="infected">Infected</option>
              </select>
            </div>
            <button
              type="submit"
              className="rounded-md border border-[var(--color-line-strong)] px-3 py-1.5 text-[13px]"
            >
              Filter
            </button>
          </form>

          {documents.length === 0 ? (
            <EmptyState
              title="Nothing here yet"
              body={canUpload ? "Upload a file below." : "Nothing has been uploaded that you may see."}
            />
          ) : (
            <DataTable
              columns={["Reference", "Document", "What it is", "Scan", "Text", "Matter", "Added"]}
              caption="Document library"
            >
              {documents.map((document) => (
                <tr key={document.id}>
                  <Td>
                    <Link
                      href={`/documents/${document.id}`}
                      className="font-mono text-[12px] text-[var(--color-info)] hover:underline"
                    >
                      {document.documentNo}
                    </Link>
                  </Td>
                  <Td>
                    {document.title}
                    <span className="block text-[11px] text-[var(--color-muted)]">
                      {document.originalFilename} · {Math.max(1, Math.round(document.byteSize / 1024))} KB
                    </span>
                  </Td>
                  <Td>
                    {document.kind ? (
                      <>
                        {document.kind}
                        <span className="block text-[11px] text-[var(--color-muted)]">
                          set by a person
                        </span>
                      </>
                    ) : document.suggestedKind ? (
                      <>
                        <span className="text-[var(--color-muted)]">
                          possibly {document.suggestedKind}
                        </span>
                        <span className="block text-[11px] text-[var(--color-faint)]">
                          a guess from the filename
                        </span>
                      </>
                    ) : (
                      <span className="text-[var(--color-faint)]">not set</span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={SCAN_TONE[document.scanStatus]}>
                      {SCAN_LABEL[document.scanStatus]}
                    </Badge>
                  </Td>
                  <Td>
                    {document.chunkCount > 0 ? (
                      <>
                        {document.chunkCount} passage(s)
                        <span className="block text-[11px] text-[var(--color-muted)]">
                          by {document.extractionMethod}
                        </span>
                      </>
                    ) : (
                      <span className="text-[var(--color-warn)]">
                        {document.extractionStatus === "needs_ocr"
                          ? "needs OCR"
                          : document.extractionStatus === "unsupported"
                            ? "not readable here"
                            : "not read"}
                      </span>
                    )}
                  </Td>
                  <Td>
                    {document.caseNo ? (
                      <Link
                        href={`/cases/${document.caseId}`}
                        className="font-mono text-[11px] text-[var(--color-info)] hover:underline"
                      >
                        {document.caseNo}
                      </Link>
                    ) : (
                      <span className="text-[var(--color-faint)]">firm-wide</span>
                    )}
                  </Td>
                  <Td>{formatDate(document.createdAt.slice(0, 10))}</Td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>

        {/* ---------------------------------------------------------------- */}
        {canUpload && (
          <Panel title="Upload a document">
            <UploadForm
              cases={cases.map((entry) => ({
                value: entry.id,
                label: `${entry.caseNo} — ${entry.title}`,
              }))}
              scannerConfigured={scanner.isConfigured()}
              maxMegabytes={MAX_UPLOAD_BYTES / 1024 / 1024}
            />
          </Panel>
        )}
      </div>
    </Shell>
  );
}
